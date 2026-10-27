import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { APP_ROOT, type AppConfig } from "./config.ts";
import { readL0KnowledgeFiles } from "./l0-knowledge.ts";
import { type JsonRecord, object } from "./model.ts";
import { ResourcePool, type ResourceScope } from "./resources.ts";

export type Source = { id: string; name: string; path: string; dictionary_path?: string; knowledge_path?: string };
export type QueryResult = {
	columns: string[];
	rows: unknown[][];
	complete: boolean;
	truncated: boolean;
	row_count: number;
	total: number | null;
	sql: string;
	parameters: unknown[];
	preview_rows?: unknown[][];
	preview_row_count?: number;
	preview_truncated?: boolean;
	result_content_hash?: string;
	hash_algorithm?: string;
	truncation_reason?: string | null;
	result_bytes?: number;
};

/** 与Python逐单元格编码对齐，浮点采用大端IEEE754，避免两种JSON实现的数字格式差异。 */
export function resultContentHash(result: Pick<QueryResult, "columns" | "rows" | "complete" | "truncated">): string {
	const hash = createHash("sha256").update("medical-query-result/v1\n");
	const cell = (value: unknown) => {
		if (value === null) hash.update("N;");
		else if (typeof value === "boolean") hash.update(value ? "B1;" : "B0;");
		else if (
			typeof value === "number" &&
			Number.isFinite(value) &&
			(!Number.isInteger(value) || Number.isSafeInteger(value))
		) {
			const bytes = Buffer.alloc(8);
			bytes.writeDoubleBE(value === 0 ? 0 : value);
			hash.update(`D${bytes.toString("hex")};`);
		} else if (typeof value === "string") hash.update(`S${Buffer.byteLength(value, "utf8")}:${value};`);
		else throw new DomainFailure("invalid_result_cell", "结果包含无法无损表达的单元格");
	};
	hash.update(`C${result.columns.length};`);
	for (const column of result.columns) cell(column);
	hash.update(`R${result.rows.length};`);
	for (const row of result.rows) {
		hash.update("[");
		for (const value of row) cell(value);
		hash.update("]");
	}
	hash.update(`C${result.complete ? 1 : 0}T${result.truncated ? 1 : 0};`);
	return hash.digest("hex");
}
// 稳定领域错误把可修复的计划错误与版本、进程和资源故障分开，禁止用通用重写掩盖基础设施故障。
export class DomainFailure extends Error {
	readonly code: string;
	readonly repairable: boolean;
	readonly details?: JsonRecord;
	constructor(code: string, message: string, repairable = false, details?: JsonRecord) {
		super(message);
		this.name = "DomainFailure";
		this.code = code;
		this.repairable = repairable;
		this.details = details;
	}
}
export class DomainService {
	readonly pool: ResourcePool;
	private readonly config: AppConfig;
	constructor(config: AppConfig) {
		this.config = config;
		this.pool = new ResourcePool(config.sqlConcurrency ?? 2, config.queueWaitTimeoutMs);
	}
	async sources(): Promise<Source[]> {
		const entries: unknown = JSON.parse(await readFile(resolve(this.config.dataDir, "sources.json"), "utf8"));
		if (!Array.isArray(entries)) throw new Error("数据源清单必须为数组");
		return entries.map((item) => {
			const entry = object(item);
			if (typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.path !== "string")
				throw new Error("数据源配置不完整");
			return {
				id: entry.id,
				name: entry.name,
				path: resolve(this.config.dataDir, entry.path),
				...(typeof entry.dictionary_path === "string"
					? { dictionary_path: resolve(this.config.dataDir, entry.dictionary_path) }
					: {}),
				// 知识路径与已有数据库路径同样相对数据目录解析，明确选择只匹配的L0分支。
				...(typeof entry.knowledge_path === "string"
					? { knowledge_path: resolve(this.config.dataDir, entry.knowledge_path) }
					: {}),
			};
		});
	}
	async source(id: string): Promise<Source> {
		const source = (await this.sources()).find((item) => item.id === id);
		if (!source) throw new Error("数据源不存在");
		return source;
	}
	async fingerprint(source: Source): Promise<string> {
		const hash = createHash("sha256").update(await readFile(source.path));
		if (source.dictionary_path) hash.update(await readFile(source.dictionary_path));
		if (source.knowledge_path) {
			// 五份来源JSON和可选合成约定共同构成版本，文件缺省也写入明确标记。
			for (const file of await readL0KnowledgeFiles(source.knowledge_path))
				hash.update(JSON.stringify([file.name, file.content]));
		}
		return hash.digest("hex");
	}
	async call(
		source: Source,
		action: "catalog" | "execute",
		signal: AbortSignal,
		dsl?: unknown,
		scope: ResourceScope = {},
	): Promise<JsonRecord> {
		// 领域入口再次封住L0执行能力，不能由模型声明、其它调用者或未来分支误触发SQL。
		if (source.knowledge_path && action === "execute") throw new Error("L0当前只允许Schema Linking，不执行SQL");
		return this.pool.run(
			() =>
				new Promise((accept, reject) => {
					signal.throwIfAborted();
					// 子进程隔离游标和取消；不用shell，不把模型SQL作为命令执行。
					const child = spawn(this.config.python, [resolve(APP_ROOT, "python/domain.py")], {
						stdio: ["pipe", "pipe", "pipe"],
					});
					let output = "";
					let overflow = false;
					let timedOut = false;
					const abort = () => child.kill("SIGKILL");
					signal.addEventListener("abort", abort, { once: true });
					const timer = setTimeout(() => {
						timedOut = true;
						abort();
					}, 15000);
					child.stdout.setEncoding("utf8");
					child.stdout.on("data", (chunk) => {
						output += chunk;
						if (Buffer.byteLength(output, "utf8") > 8_000_000) {
							overflow = true;
							abort();
						}
					});
					child.stderr.resume();
					child.stdin.on("error", () => {
						/* 退出事件负责统一报告，避免EPIPE导致进程崩溃。 */
					});
					child.on("error", () => {
						clearTimeout(timer);
						signal.removeEventListener("abort", abort);
						reject(new Error("无法启动 SQLite 领域服务"));
					});
					child.on("close", (code) => {
						clearTimeout(timer);
						signal.removeEventListener("abort", abort);
						if (signal.aborted) {
							reject(new Error("查询已停止"));
							return;
						}
						if (overflow || timedOut) {
							reject(new Error(overflow ? "结果超出当前传输预算" : "数据库查询超时"));
							return;
						}
						try {
							const parsed = object(JSON.parse(output));
							if (parsed.ok !== true || code !== 0) {
								const detail = object(parsed.error);
								const message = String(detail.message || "领域校验失败");
								const errorCode = String(detail.code || "domain_validation");
								throw new DomainFailure(
									errorCode,
									message,
									[
										"INVALID_DSL",
										"INVALID_REQUEST",
										"UNKNOWN_TABLE",
										"UNKNOWN_FIELD",
										"UNKNOWN_RELATION",
										"INVALID_JOIN",
										"INVALID_GROUP",
										"INVALID_VALUE",
										"INVALID_ORDER",
										"UNSUPPORTED_AGGREGATE",
										"UNSUPPORTED_OPERATOR",
									].includes(errorCode),
								);
							}
							accept(parsed);
						} catch (error) {
							reject(error instanceof SyntaxError ? new Error("领域服务返回格式错误") : error);
						}
					});
					child.stdin.end(
						JSON.stringify({
							action,
							path: source.path,
							dictionary_path: source.dictionary_path,
							dsl,
							max_rows: this.config.resultMaxRows ?? 5000,
							max_result_bytes: 6_000_000,
							preview_rows: 200,
							timeout_ms: 10000,
						}),
					);
				}),
			signal,
			scope,
		);
	}
}
