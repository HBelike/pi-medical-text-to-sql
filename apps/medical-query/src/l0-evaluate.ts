import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { APP_ROOT, readConfig } from "./config.ts";
import { DomainService } from "./domain.ts";
import { createHttpClient, parseArgs, sameSourceVersions } from "./evaluate.ts";
import { runEvaluationCli } from "./evaluation/cli.ts";
import { L0Knowledge } from "./l0-knowledge.ts";
import { object } from "./model.ts";

export type Relation = { left_table: string; right_table: string; pairs: { left: string; right: string }[] };
type CodeFilter = { field: string; op: string; value: unknown };
type MetricStatus = { metric_id: string; status: string };
export type LinkingCase = {
	id: string;
	question: string;
	expected: {
		metric_ids: string[];
		tables: string[];
		fields: string[];
		time_fields: string[];
		relations: Relation[];
		candidate_relations: string[];
		code_filters: CodeFilter[];
		execution_statuses: MetricStatus[];
		relation_alternatives?: Relation[][];
	};
	allowed_extra_tables?: string[];
	allowed_extra_fields?: string[];
	allowed_extra_time_fields?: string[];
	allowed_extra_relations?: Relation[];
	allowed_extra_code_filters?: CodeFilter[];
	notes?: string;
};
type Suite = { version: string; source_id: string; as_of: string; cases: LinkingCase[] };
type View = { status: string; evidence?: unknown; result?: unknown; error?: string };
type Check = { passed: boolean; missing: string[]; unexpected: string[]; malformed: boolean };
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// 复合关系按完整限定列对归一化，允许同一关系反向描述及列对换序，不接受丢失机构键。
export function relationKey(value: unknown): string {
	const item = object(value);
	if (typeof item.left_table !== "string" || typeof item.right_table !== "string" || !Array.isArray(item.pairs))
		throw new Error("关系缺少完整表名或列对");
	const pairs = item.pairs.map((entry) => {
		const pair = object(entry);
		if (typeof pair.left !== "string" || typeof pair.right !== "string") throw new Error("关系列对无效");
		return [`${item.left_table}.${pair.left}`, `${item.right_table}.${pair.right}`].sort().join("=");
	});
	if (!pairs.length || new Set(pairs).size !== pairs.length) throw new Error("关系为空或重复");
	return pairs.sort().join("&");
}

function codeKey(value: unknown): string {
	const item = object(value);
	if (typeof item.field !== "string" || typeof item.op !== "string" || !("value" in item))
		throw new Error("代码条件缺少字段、运算或值");
	if (!["eq", "ne", "in", "not_in", "is_null", "is_not_null"].includes(item.op))
		throw new Error("invalid_gold：代码操作符无效");
	if (["is_null", "is_not_null"].includes(item.op)) {
		if (item.value !== null) throw new Error("invalid_gold：空值条件必须使用 null");
	} else {
		const values = ["in", "not_in"].includes(item.op) ? item.value : [item.value];
		if (
			!Array.isArray(values) ||
			!values.length ||
			values.some((entry) => !["string", "number", "boolean"].includes(typeof entry))
		)
			throw new Error("invalid_gold：代码条件必须使用有类型的标量值");
	}
	// IN 的顺序不影响集合含义，但数值、字符串和 NULL 的类型仍需一致。
	const normalized =
		["in", "not_in"].includes(item.op) && Array.isArray(item.value)
			? item.value.map((entry) => JSON.stringify(entry)).sort()
			: item.value;
	return JSON.stringify([item.field, item.op, normalized]);
}

function compareSet(actual: unknown, required: readonly string[], allowed: readonly string[] = []): Check {
	const malformed =
		!Array.isArray(actual) || actual.some((item) => typeof item !== "string") || new Set(actual).size !== actual.length;
	const values = new Set(list(actual).filter((item): item is string => typeof item === "string"));
	const permitted = new Set([...required, ...allowed]);
	const missing = required.filter((item) => !values.has(item));
	const unexpected = [...values].filter((item) => !permitted.has(item));
	return { passed: !malformed && !missing.length && !unexpected.length, missing, unexpected, malformed };
}

// Gold 属于离线评分器，先核对结构与引用；缺失或无效答案不得当成模型失败/成功计入质量分母。
export function loadLinkingSuite(
	raw: string,
	catalog: unknown,
	metricIds: string[],
	candidateIds: string[],
	codes: { field: string; value: unknown }[] = [],
): Suite {
	const suite = object(JSON.parse(raw));
	if (
		typeof suite.version !== "string" ||
		typeof suite.source_id !== "string" ||
		typeof suite.as_of !== "string" ||
		!Number.isFinite(Date.parse(suite.as_of)) ||
		!Array.isArray(suite.cases) ||
		!suite.cases.length
	)
		throw new Error("invalid_gold：题集元数据无效");
	const metadata = object(catalog);
	const tables = new Set(list(metadata.tables).map((item) => String(object(item).name)));
	const fields = new Set(
		list(metadata.tables).flatMap((item) => {
			const table = object(item);
			return list(table.columns).map((column) => `${table.name}.${object(column).name}`);
		}),
	);
	const relations = new Set(list(metadata.relations).map(relationKey));
	const ids = new Set<string>();
	const stringArray = (value: unknown): value is string[] =>
		Array.isArray(value) && value.every((item) => typeof item === "string") && new Set(value).size === value.length;
	for (const entry of suite.cases) {
		const sample = object(entry),
			expected = object(sample.expected);
		if (
			typeof sample.id !== "string" ||
			!sample.id ||
			ids.has(sample.id) ||
			typeof sample.question !== "string" ||
			!sample.question.trim()
		)
			throw new Error("invalid_gold：问题或用例 ID 无效");
		ids.add(sample.id);
		for (const key of ["metric_ids", "tables", "fields", "time_fields", "candidate_relations"])
			if (!stringArray(expected[key])) throw new Error(`invalid_gold：${sample.id}.${key} 必须是无重复字符串数组`);
		for (const [key, available] of [
			["metric_ids", new Set(metricIds)],
			["tables", tables],
			["fields", fields],
			["time_fields", fields],
			["candidate_relations", new Set(candidateIds)],
		] as const)
			if ((expected[key] as string[]).some((value) => !available.has(value)))
				throw new Error(`invalid_gold：${sample.id}.${key} 引用不存在`);
		for (const [key, available] of [
			["allowed_extra_tables", tables],
			["allowed_extra_fields", fields],
			["allowed_extra_time_fields", fields],
		] as const)
			if (
				sample[key] !== undefined &&
				(!stringArray(sample[key]) || (sample[key] as string[]).some((value) => !available.has(value)))
			)
				throw new Error(`invalid_gold：${sample.id}.${key} 无效`);
		if (
			!Array.isArray(expected.relations) ||
			!Array.isArray(expected.code_filters) ||
			!Array.isArray(expected.execution_statuses)
		)
			throw new Error(`invalid_gold：${sample.id} 缺少关系、条件或能力状态`);
		for (const key of ["allowed_extra_relations", "allowed_extra_code_filters"])
			if (sample[key] !== undefined && !Array.isArray(sample[key]))
				throw new Error(`invalid_gold：${sample.id}.${key} 必须是数组`);
		// 无匹配题必须确实没有指标依赖，避免错误的空指标答案掩盖伪造结构。
		if (
			!(expected.metric_ids as string[]).length &&
			["tables", "fields", "time_fields", "relations", "candidate_relations", "code_filters"].some(
				(key) => list(expected[key]).length,
			)
		)
			throw new Error(`invalid_gold：${sample.id} 无匹配题不能带结构答案`);
		const paths = expected.relation_alternatives === undefined ? [] : expected.relation_alternatives;
		if (!Array.isArray(paths) || !paths.every(Array.isArray)) throw new Error("invalid_gold：等价路径必须逐组声明");
		for (const relation of [...expected.relations, ...paths.flat(), ...list(sample.allowed_extra_relations)])
			if (!relations.has(relationKey(relation))) throw new Error(`invalid_gold：${sample.id} 关系不在可执行目录`);
		for (const filter of [...expected.code_filters, ...list(sample.allowed_extra_code_filters)]) {
			codeKey(filter);
			const condition = object(filter);
			if (!fields.has(String(condition.field))) throw new Error(`invalid_gold：${sample.id} 条件字段不存在`);
			// 先验证标准答案的类型化枚举，错误答案不应花费模型调用后被归因于模型。
			if (!["is_null", "is_not_null"].includes(String(condition.op))) {
				const values = ["in", "not_in"].includes(String(condition.op)) ? list(condition.value) : [condition.value];
				if (
					values.some(
						(value) =>
							!codes.some(
								(code) => code.field === condition.field && JSON.stringify(code.value) === JSON.stringify(value),
							),
					)
				)
					throw new Error(`invalid_gold：${sample.id} 代码值未登记或类型不一致`);
			}
		}
		const statusIds = expected.execution_statuses.map((value) => String(object(value).metric_id));
		if (
			!compareSet(statusIds, expected.metric_ids as string[]).passed ||
			expected.execution_statuses.some(
				(value) =>
					!["blocked_engine_and_hospital_mapping", "blocked_rule_source"].includes(String(object(value).status)),
			)
		)
			throw new Error(`invalid_gold：${sample.id} 能力状态与指标不一致`);
	}
	return suite as unknown as Suite;
}

// 匹配单独决定 passed；统一 blocked 只是运行边界，不能靠全部拒答得到匹配通过率。
export function scoreLinking(view: View, sample: LinkingCase, catalog: unknown) {
	const evidence = object(view.evidence ?? {}),
		linking = object(evidence.linking ?? {});
	const expected = sample.expected;
	const checks: Record<string, Check> = {};
	for (const [key, allowed] of [
		["metric_ids", []],
		["tables", sample.allowed_extra_tables],
		["fields", sample.allowed_extra_fields],
		["time_fields", sample.allowed_extra_time_fields],
		["candidate_relations", []],
	] as const)
		checks[key] = compareSet(linking[key], expected[key], allowed);
	const catalogRelations = new Map(list(object(catalog).relations).map((item) => [object(item).id, relationKey(item)]));
	const declaredRelations = list(linking.relations).map((id) => catalogRelations.get(id) || `unknown:${String(id)}`);
	const paths = [expected.relations, ...(expected.relation_alternatives || [])];
	const relationChecks = paths.map((path) =>
		compareSet(declaredRelations, path.map(relationKey), (sample.allowed_extra_relations || []).map(relationKey)),
	);
	checks.relations = relationChecks.find((check) => check.passed) || relationChecks[0];
	if (!Array.isArray(linking.relations)) checks.relations = { ...checks.relations, passed: false, malformed: true };
	try {
		checks.code_filters = compareSet(
			list(linking.code_filters).map(codeKey),
			expected.code_filters.map(codeKey),
			(sample.allowed_extra_code_filters || []).map(codeKey),
		);
		if (!Array.isArray(linking.code_filters))
			checks.code_filters = { ...checks.code_filters, passed: false, malformed: true };
	} catch {
		checks.code_filters = {
			passed: false,
			missing: expected.code_filters.map(codeKey),
			unexpected: [],
			malformed: true,
		};
	}
	const actualStatuses = list(evidence.metric_statuses).map(
		(item) => `${object(item).metric_id}:${object(item).status}`,
	);
	checks.execution_statuses = compareSet(
		actualStatuses,
		expected.execution_statuses.map((item) => `${item.metric_id}:${item.status}`),
	);
	if (!Array.isArray(evidence.metric_statuses))
		checks.execution_statuses = { ...checks.execution_statuses, passed: false, malformed: true };
	const boundaryMatch =
		view.status === "blocked" &&
		view.result === undefined &&
		evidence.sql === undefined &&
		evidence.profile === "l0_schema_linking" &&
		evidence.match_status === (expected.metric_ids.length ? "matched" : "no_match");
	return {
		passed: boundaryMatch && Object.values(checks).every((check) => check.passed),
		boundary_match: boundaryMatch,
		checks,
	};
}

export function parseLinkingArgs(args: string[]) {
	const options = parseArgs(["--concurrency", "5", ...args]);
	if (options.standalone) throw new Error("L0 匹配评测复用运行中的 HTTP 服务，不创建第二套模型额度");
	return options;
}

// 失败请求也留在总分母；缺少 checks 代表未完成匹配，不能让汇总本身再次抛错。
export function linkingQuality(items: Record<string, unknown>[]) {
	const ratio = (numerator: number) => ({ numerator, denominator: items.length, value: numerator / items.length });
	const names = [
		"metric_ids",
		"tables",
		"fields",
		"time_fields",
		"relations",
		"candidate_relations",
		"code_filters",
		"execution_statuses",
	];
	return {
		all_requirements: ratio(items.filter((item) => item.passed === true).length),
		...Object.fromEntries(
			names.map((name) => [
				name,
				ratio(items.filter((item) => object(object(item.checks ?? {})[name] ?? {}).passed === true).length),
			]),
		),
	};
}

export async function evaluateLinking(options: ReturnType<typeof parseLinkingArgs>) {
	const config = readConfig(),
		domain = new DomainService(config);
	const raw = await readFile(resolve(APP_ROOT, "fixtures/l0-linking-cases.json"), "utf8");
	const suiteHeader = object(JSON.parse(raw));
	const source = await domain.source(String(suiteHeader.source_id));
	if (!source.knowledge_path) throw new Error("L0 数据源未登记知识目录，请先落库和注册");
	const catalog = (await domain.call(source, "catalog", AbortSignal.timeout(15000))).catalog;
	const knowledge = await L0Knowledge.load(source.knowledge_path);
	const semantics = knowledge.semantics;
	const codes = list(semantics.code_mappings).map((value) => ({
		field: String(object(value).physical_field),
		value: object(value).value,
	}));
	for (const entry of list(knowledge.conventions?.global_rules)) {
		const rule = object(entry);
		if (!rule.field_values) continue;
		if (rule.provenance !== "synthetic_test_design") throw new Error("invalid_gold：附加枚举缺少合成来源");
		for (const [field, values] of Object.entries(object(rule.field_values)))
			for (const value of list(values)) codes.push({ field, value });
	}
	const suite = loadLinkingSuite(
		raw,
		catalog,
		knowledge.metrics.map((item) => String(item.metric_id)),
		list(semantics.relations)
			.filter((item) => object(item).origin === "synthetic_candidate")
			.map((item) => String(object(item).id)),
		codes,
	);
	const samples = options.limit === 0 ? suite.cases : suite.cases.slice(0, options.limit);
	const version = await domain.fingerprint(source);
	const client = createHttpClient(`http://127.0.0.1:${config.port}`);
	const initial = await client.status();
	if (!sameSourceVersions([{ id: source.id, fingerprint: version }], initial.source_versions))
		throw new Error("服务与评测快照不一致，未提交题目");
	if (
		typeof initial.pipeline_signature !== "string" ||
		typeof initial.queue_wait_timeout_ms !== "number" ||
		typeof initial.run_timeout_ms !== "number"
	)
		throw new Error("服务缺少版本或超时配置，请重启服务");
	const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
	const output = options.output || resolve(config.dataDir, "evaluations", `l0-linking-${runId}.json`);
	await mkdir(dirname(output), { recursive: true });
	const metadata = {
		run_id: runId,
		kind: "schema_linking_on_synthetic_sqlite",
		dataset_version: suite.version,
		dataset_hash: createHash("sha256").update(raw).digest("hex"),
		source_id: source.id,
		source_version: version,
		pipeline_signature: initial.pipeline_signature,
		as_of: suite.as_of,
		selected_ids: samples.map((item) => item.id),
		configuration: { requested_concurrency: options.concurrency, limits: initial.limits, model: initial.model },
		note: "仅测合成医院上的指标与结构匹配；不评价指标数值，也不代表真实医院准确率。gold 与产品输入隔离。",
	};
	await writeFile(output, `${JSON.stringify({ ...metadata, status: "running" }, null, 2)}\n`, { flag: "wx" });
	const items: Record<string, unknown>[] = new Array(samples.length);
	const started = Date.now();
	try {
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(options.concurrency, samples.length) }, async () => {
				while (next < samples.length) {
					const index = next++,
						sample = samples[index],
						start = Date.now();
					let turn: Awaited<ReturnType<typeof client.query>> | undefined;
					try {
						// 只提交用户问题和固定正常上下文，绝不把 expected、允许路径或评分规则发送给产品。
						turn = await client.query({
							conversation_id: `l0-${runId}-${sample.id}`,
							source_id: source.id,
							question: sample.question,
							request_id: randomUUID(),
							mode: "eval",
							as_of: suite.as_of,
						});
						const deadline = start + Number(initial.queue_wait_timeout_ms) + Number(initial.run_timeout_ms) + 10_000;
						while (["queued", "running"].includes(turn.status)) {
							if (Date.now() > deadline) {
								await client.cancel(turn.id);
								throw new Error("评测等待超时，已请求取消");
							}
							await delay(250);
							turn = await client.get(turn.id);
						}
						items[index] = {
							id: sample.id,
							question: sample.question,
							...scoreLinking(turn, sample, catalog),
							duration_ms: Date.now() - start,
							turn_id: turn.id,
							status: turn.status,
							evidence: turn.evidence,
							usage: turn.usage,
							error: turn.error,
						};
					} catch (error) {
						items[index] = {
							id: sample.id,
							question: sample.question,
							passed: false,
							status: "failed",
							duration_ms: Date.now() - start,
							turn_id: turn?.id,
							error: error instanceof Error ? error.message : "评测失败",
						};
					}
				}
			}),
		);
		const final = await client.status();
		const stable =
			(await domain.fingerprint(source)) === version &&
			final.pipeline_signature === initial.pipeline_signature &&
			sameSourceVersions([{ id: source.id, fingerprint: version }], final.source_versions);
		const passed = items.filter((item) => item.passed === true).length;
		const report = {
			...metadata,
			status: stable ? "completed" : "invalid_snapshot",
			sources_unchanged: stable,
			quality: stable ? linkingQuality(items) : null,
			total_ms: Date.now() - started,
			cost: null,
			cost_note: "价格未确认；实际调用用量保留在逐题记录中。",
			items,
		};
		await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
		console.log(
			JSON.stringify({ output, cases: samples.length, passed, snapshot_valid: stable, total_ms: report.total_ms }),
		);
		return output;
	} catch (error) {
		await writeFile(
			output,
			`${JSON.stringify({ ...metadata, status: "failed", items: items.filter(Boolean), error: error instanceof Error ? error.message : "评测失败" }, null, 2)}\n`,
		);
		throw error;
	}
}

// 历史评分函数继续可导入；直接运行也转交统一实验 API，避免产生工作台不可追踪的评测。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		console.log(JSON.stringify(await runEvaluationCli(process.argv.slice(2)), null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "L0 匹配评测失败");
		process.exitCode = 1;
	}
}
