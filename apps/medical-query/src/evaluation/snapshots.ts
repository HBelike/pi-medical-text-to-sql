import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { APP_ROOT, type AppConfig, defaultRetrievalTopK } from "../config.ts";
import type { Source } from "../domain.ts";
import { readL0KnowledgeFiles } from "../l0-knowledge.ts";
import { RuntimeError } from "../runtime.ts";
import { fingerprint } from "./store.ts";

export type SourceSnapshot = { id: string; source: Source; source_version: string; created_at: number };

// 只登记非敏感运行条件；轮换密钥不会泄露或改变凭据身份，改变端点/预算则需要新实验。
export function runtimeConfiguration(config: AppConfig) {
	return {
		endpoint: config.baseUrl,
		resource_scope_id: config.resourceScopeId ?? "primary-account",
		llm_concurrency: config.llmMaxConcurrency,
		active_runs: config.maxActiveRuns,
		evaluation_active_runs: config.evalMaxActiveRuns,
		pending: config.maxPending,
		online_reserve: config.onlineQueueReserve ?? 0,
		sql_concurrency: config.sqlConcurrency ?? 2,
		result_max_rows: config.resultMaxRows ?? 5000,
		retrieval_strategy: config.retrievalStrategy ?? "progressive",
		retrieval_max_context_chars: config.retrievalMaxContextChars ?? 256000,
		retrieval_top_k: config.retrievalTopK ?? defaultRetrievalTopK(config.retrievalStrategy ?? "progressive"),
		request_timeout: config.llmTimeoutMs,
		run_timeout: config.runTimeoutMs,
		queue_timeout: config.queueWaitTimeoutMs,
		rpm: config.accountRpm ?? null,
		tpm: config.accountTpm ?? null,
	};
}

/** SQLite backup 从一致读视图取样，包含 WAL；冻结副本不会修改原合成库。 */
export async function freezeSource(source: Source, root: string): Promise<SourceSnapshot> {
	const directory = resolve(root, "snapshots", randomUUID());
	await mkdir(directory, { recursive: true });
	const path = resolve(directory, "source.sqlite");
	const input = new DatabaseSync(source.path, { readOnly: true });
	try {
		await backup(input, path);
	} finally {
		input.close();
	}
	const check = new DatabaseSync(path, { readOnly: true });
	try {
		if (
			check.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" ||
			check.prepare("PRAGMA foreign_key_check").all().length
		)
			throw new RuntimeError("snapshot_invalid", "业务快照完整性或外键校验失败", 422);
	} finally {
		check.close();
	}
	const frozen: Source = { id: source.id, name: source.name, path };
	const hash = createHash("sha256").update(await readFile(path));
	if (source.dictionary_path) {
		const dictionary = await readFile(source.dictionary_path);
		frozen.dictionary_path = resolve(directory, "semantic.json");
		await writeFile(frozen.dictionary_path, dictionary, { mode: 0o400 });
		hash.update(dictionary);
	}
	if (source.knowledge_path) {
		frozen.knowledge_path = resolve(directory, "knowledge");
		await mkdir(frozen.knowledge_path);
		const files = await readL0KnowledgeFiles(source.knowledge_path);
		for (const file of files) {
			hash.update(JSON.stringify([file.name, file.content]));
			if (file.content !== null)
				await writeFile(resolve(frozen.knowledge_path, file.name), file.content, { mode: 0o400 });
		}
	}
	await chmod(path, 0o400);
	const source_version = hash.digest("hex");
	return {
		id: fingerprint({ source_id: source.id, source_version }),
		source: frozen,
		source_version,
		created_at: Date.now(),
	};
}

/** 包含未提交的应用与 Pi 源码；模型密钥、业务 gold、运行目录不进入执行包。 */
export async function executionFingerprint(): Promise<string> {
	const root = resolve(APP_ROOT, "../..");
	const entries: [string, string][] = [];
	async function visit(relative: string): Promise<void> {
		for (const entry of (await readdir(resolve(root, relative), { withFileTypes: true })).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const name = `${relative}/${entry.name}`;
			if (entry.isDirectory()) await visit(name);
			else if (/\.(ts|py|json)$/.test(name))
				entries.push([
					name,
					createHash("sha256")
						.update(await readFile(resolve(root, name)))
						.digest("hex"),
				]);
		}
	}
	for (const directory of [
		"apps/medical-query/src",
		"apps/medical-query/python",
		"packages/durable/src",
		"packages/ai/src",
	])
		await visit(directory);
	entries.push([
		"package-lock.json",
		createHash("sha256")
			.update(await readFile(resolve(root, "package-lock.json")))
			.digest("hex"),
	]);
	return fingerprint(entries);
}
