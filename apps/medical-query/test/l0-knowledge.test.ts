import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { APP_ROOT, type AppConfig } from "../src/config.ts";
import { DomainService } from "../src/domain.ts";
import { L0_PROFILE, L0Knowledge, type L0Linking, type L0Selection, validateL0Linking } from "../src/l0-knowledge.ts";
import { type JsonRecord, type ModelGateway, object } from "../src/model.ts";
import { createPipeline, l0RuleDependencies, validateL0Dependencies } from "../src/pipeline.ts";
import { QueryRuntime, type QueryTask } from "../src/runtime.ts";

const emptyLinking = {
	metric_ids: [],
	tables: [],
	fields: [],
	relations: [],
	candidate_relations: [],
	time_fields: [],
	code_filters: [],
	unresolved_rule_ids: [],
};
const firstLinking = {
	metric_ids: ["met.gk-01"],
	tables: ["outpatient_visits", "inpatient_stays"],
	fields: [
		"outpatient_visits.institution_id",
		"inpatient_stays.institution_id",
		"inpatient_stays.discharge_disposition_code",
		"outpatient_visits.visit_id",
		"outpatient_visits.care_setting_code",
		"outpatient_visits.registered_at",
		"inpatient_stays.stay_id",
		"inpatient_stays.discharged_at",
		"inpatient_stays.home_bed_flag",
	],
	relations: [],
	candidate_relations: [],
	time_fields: ["outpatient_visits.registered_at", "inpatient_stays.discharged_at"],
	code_filters: [
		{ field: "inpatient_stays.discharged_at", op: "is_not_null", value: null },
		{ field: "outpatient_visits.care_setting_code", op: "eq", value: "OUTPATIENT" },
		{ field: "inpatient_stays.home_bed_flag", op: "eq", value: 0 },
	],
	unresolved_rule_ids: ["gap.gk-01.definition", "gap.gk-01.hospital", "gap.gk-01.synthetic", "gap.gk-01.engine"],
};

// 测试只建临时空结构；模型为可观察替身，不读取凭据、不调用外部模型、不改当前源注册表。
async function setup(t: TestContext) {
	const dataDir = await mkdtemp(resolve(tmpdir(), "pi-l0-"));
	const knowledgePath = resolve(dataDir, "knowledge");
	await cp(resolve(APP_ROOT, "fixtures/l0"), knowledgePath, { recursive: true });
	const sqlite = new DatabaseSync(resolve(dataDir, "l0.sqlite"));
	try {
		sqlite.exec(await readFile(resolve(knowledgePath, "mock_schema.sql"), "utf8"));
	} finally {
		sqlite.close();
	}
	await writeFile(
		resolve(dataDir, "sources.json"),
		JSON.stringify([
			{
				id: "l0_mock",
				name: "合成L0",
				path: "l0.sqlite",
				dictionary_path: "knowledge/mock_semantics.json",
				knowledge_path: "knowledge",
			},
		]),
	);
	const config: AppConfig = {
		apiKey: "",
		baseUrl: "http://127.0.0.1:1",
		decisionModel: "deepseek-test",
		answerModel: "deepseek-test",
		maxActiveRuns: 1,
		llmMaxConcurrency: 1,
		evalMaxActiveRuns: 1,
		maxPending: 10,
		queueWaitTimeoutMs: 5000,
		llmTimeoutMs: 5000,
		runTimeoutMs: 10000,
		port: 8787,
		python: "python3",
		dataDir,
	};
	const domain = new DomainService(config);
	const source = await domain.source("l0_mock");
	const knowledge = await L0Knowledge.load(knowledgePath);
	const catalog = (await domain.call(source, "catalog", new AbortController().signal)).catalog;
	let runtime: QueryRuntime | undefined;
	t.after(async () => {
		await runtime?.close();
		await rm(dataDir, { recursive: true, force: true });
	});
	const requests: { role: string; prompt: string; input: JsonRecord; max_output_tokens: number }[] = [];
	const actions: string[] = [];
	const original = domain.call.bind(domain);
	domain.call = async (...args) => {
		actions.push(args[1]);
		return original(...args);
	};
	return {
		dataDir,
		knowledgePath,
		domain,
		source,
		knowledge,
		catalog,
		requests,
		actions,
		start: async (response: (input: JsonRecord, index: number) => JsonRecord | Promise<JsonRecord>) => {
			const model: Pick<ModelGateway, "json"> = {
				json: async (role, prompt, input, _signal, receipts, _priority, onStart, maxOutputTokens = 4096) => {
					requests.push({ role, prompt, input: object(input), max_output_tokens: maxOutputTokens });
					receipts.push({
						id: randomUUID(),
						started_at: Date.now(),
						system_prompt: prompt,
						user_prompt: JSON.stringify(input),
						role,
						model: "test-only",
						queue_ms: 0,
						duration_ms: 1,
						input_tokens: null,
						output_tokens: null,
						max_output_tokens: maxOutputTokens,
						cost: null,
						status: "completed",
					});
					await onStart?.();
					return response(object(input), requests.length - 1);
				},
			};
			runtime = await QueryRuntime.open({
				storagePath: resolve(dataDir, "runtime.sqlite"),
				handler: createPipeline(domain, model, () => runtime!),
			});
			return runtime;
		},
	};
}

async function submit(
	runtime: QueryRuntime,
	question = "GK-01 门诊人次数与出院人次数比",
	conversation = "same",
	retrievalContext: {
		retrieval_strategy?: string;
		retrieval_max_context_chars?: number;
		retrieval_top_k?: number;
	} = {},
) {
	let task: QueryTask = await runtime.enqueue({
		conversationId: conversation,
		requestId: randomUUID(),
		question,
		context: { source_id: "l0_mock", mode: "eval", ...retrievalContext },
	});
	const deadline = Date.now() + 10000;
	while (["queued", "running"].includes(task.status) && Date.now() < deadline) {
		await delay(10);
		task = (await runtime.get(task.id))!;
	}
	assert.ok(!["queued", "running"].includes(task.status), "任务应完成");
	return task;
}

test("精简识别目录与按需知识投影保留规则来源、阻断和类型", async (t) => {
	const env = await setup(t);
	assert.equal(env.knowledge.index().length, 47);
	assert.deepEqual(Object.keys(env.knowledge.index()[0]).sort(), [
		"aliases",
		"definition",
		"metric_id",
		"name",
		"original_code",
	]);
	assert.deepEqual(env.knowledge.identify({ metric_ids: ["met.gk-01"] }), ["met.gk-01"]);
	assert.deepEqual(env.knowledge.identify({ metric_ids: [] }), []);
	assert.throws(() => env.knowledge.identify({ metric_ids: ["met.unknown"] }), /未知/);
	assert.throws(
		() => env.knowledge.identify({ metric_ids: ["met.gk-01", "met.gk-04", "met.gk-03", "met.gk-05"] }),
		/三项/,
	);
	const selected = env.knowledge.select(["met.gk-01"], env.catalog);
	assert.deepEqual(validateL0Linking({ linking: firstLinking }, selected), firstLinking);
	assert.equal(selected.metricStatuses[0].status, "blocked_engine_and_hospital_mapping");
	assert.ok(selected.metricStatuses[0].missing.includes("gap.gk-01.definition"));
	assert.equal((selected.input.metrics as unknown[]).length, 1);
	assert.equal(JSON.stringify(selected.input).includes('"metric_id":"met.qc-icu-11"'), false);
	assert.ok(JSON.stringify(selected.input).length < JSON.stringify(env.knowledge.semantics).length / 2);
	assert.throws(
		() =>
			validateL0Linking(
				{
					linking: {
						...firstLinking,
						code_filters: [{ field: "inpatient_stays.home_bed_flag", op: "eq", value: "0" }],
					},
				},
				selected,
			),
		/错误类型/,
	);
});

test("字段、时间、规则及关系引用严格校验，候选关系不能升格", async (t) => {
	const env = await setup(t);
	const selected = env.knowledge.select(["met.gk-01"], env.catalog);
	assert.throws(
		() =>
			validateL0Linking(
				{
					linking: {
						...firstLinking,
						code_filters: [{ field: "inpatient_stays.home_bed_flag", op: "eq", value: null }],
					},
				},
				selected,
			),
		/未登记值/,
	);
	assert.throws(
		() =>
			validateL0Linking(
				{ linking: { ...firstLinking, fields: [...firstLinking.fields, "inpatient_stays.fake"] } },
				selected,
			),
		/未知字段/,
	);
	assert.throws(
		() => validateL0Linking({ linking: { ...firstLinking, relations: ["fk:fake:0"] } }, selected),
		/不可执行/,
	);
	assert.throws(
		() => validateL0Linking({ linking: { ...firstLinking, time_fields: ["inpatient_stays.stay_id"] } }, selected),
		/时间字段/,
	);
	assert.throws(
		() => validateL0Linking({ linking: { ...firstLinking, unresolved_rule_ids: ["gap.fake"] } }, selected),
		/规则缺口/,
	);
	const surgery = env.knowledge.select(["met.gk-04"], env.catalog);
	assert.equal(surgery.candidateRelations.length, 1);
	const relationBindings = surgery.input.relation_bindings as JsonRecord[];
	assert.equal(relationBindings.find((relation) => relation.status === "candidate")!.runtime_id, null);
	assert.ok(relationBindings.find((relation) => relation.status === "active")!.runtime_id);
	const candidateId = String(surgery.candidateRelations[0].id);
	const linking = {
		...emptyLinking,
		metric_ids: ["met.gk-04"],
		tables: surgery.tables.map((table) => String(table.name)),
		candidate_relations: [candidateId],
	};
	assert.doesNotThrow(() => validateL0Linking({ linking }, surgery));
	// 模型必须提取ID字符串；即使输入中的关系对象合法，也不能把对象或列对透传为输出。
	assert.doesNotThrow(() =>
		validateL0Linking({ linking: { ...linking, relations: [String(surgery.relations[0].id)] } }, surgery),
	);
	assert.throws(
		() => validateL0Linking({ linking: { ...linking, relations: [surgery.relations[0]] } }, surgery),
		/匹配运行关系必须为非空字符串数组/,
	);
	assert.throws(
		() => validateL0Linking({ linking: { ...linking, candidate_relations: [surgery.candidateRelations[0]] } }, surgery),
		/候选关系必须为非空字符串数组/,
	);
	assert.throws(
		() =>
			validateL0Linking(
				{
					linking: {
						...firstLinking,
						code_filters: [{ field: "inpatient_stays.home_bed_flag", op: "eq", value: 0, description: "不能复制释义" }],
					},
				},
				selected,
			),
		/代码过滤字段无效/,
	);
	assert.throws(
		() => validateL0Linking({ linking: { ...linking, relations: [candidateId], candidate_relations: [] } }, surgery),
		/不可执行/,
	);
	// 不完整列对不能与复合外键匹配，即使左右表名相同。
	const changed = structuredClone(object(env.catalog));
	const relations = changed.relations as JsonRecord[];
	const matched = relations.find(
		(relation) => relation.id === relationBindings.find((binding) => binding.status === "active")!.runtime_id,
	)!;
	matched.pairs = (matched.pairs as unknown[]).slice(0, 1);
	assert.equal(env.knowledge.select(["met.gk-04"], changed).relations.length, 0);
});

// 真实 Python 目录同时包含物理外键和核验别名；跨模块投影必须保留旧 fk 引用，不能误报歧义。
test("物理外键与已核验别名归一为稳定的L0运行关系", async (t) => {
	const env = await setup(t);
	const catalog = structuredClone(object(env.catalog));
	const relations = catalog.relations as JsonRecord[];
	const logicalId = "rel.inpatient_procedures__inpatient_stays__institution_id_stay_id";
	const alias = relations.find((relation) => relation.id === logicalId)!;
	assert.ok(alias, "应从生产 Python 目录取得已核验别名");
	assert.equal(alias.declared_origin, "synthetic_sql_fk");
	const physical = relations.find((relation) => relation.id === alias.physical_relation_id)!;
	assert.ok(String(physical.id).startsWith("fk:"));
	// 列对顺序不同的另一个已核验别名仍只指向同一物理关系。
	relations.push({ ...alias, id: "verified-second-alias", pairs: [...(alias.pairs as JsonRecord[])].reverse() });
	const selected = env.knowledge.select(["met.gk-04"], catalog);
	const binding = (selected.input.relation_bindings as JsonRecord[]).find((item) => item.logical_id === logicalId)!;
	assert.equal(binding.runtime_id, physical.id);
	assert.deepEqual(
		selected.relations.map((relation) => relation.id),
		[physical.id],
	);
	assert.equal(
		selected.relations.some((relation) => Object.hasOwn(relation, "physical_relation_id")),
		false,
	);
	assert.equal(selected.metricStatuses[0].status, "blocked_engine_and_hospital_mapping");
	assert.equal(selected.candidateRelations.length, 1);
	const linking = dependencyLinking(selected, []);
	assert.doesNotThrow(() => validateL0Linking({ linking }, selected));
	assert.throws(() => validateL0Linking({ linking: { ...linking, relations: [logicalId] } }, selected), /不可执行/);
});

// 别名不是第二份权威目录：物理关系不可用时必须保留空映射，不允许用别名恢复执行资格。
test("物理外键缺失不完整停用或候选时别名不能补位", async (t) => {
	const env = await setup(t);
	const logicalId = "rel.inpatient_procedures__inpatient_stays__institution_id_stay_id";
	const original = object(env.catalog).relations as JsonRecord[];
	const alias = original.find((relation) => relation.id === logicalId)!;
	const physicalId = alias.physical_relation_id;
	for (const mutation of [
		"missing",
		"incomplete",
		"tenant",
		"duplicate-pair",
		"inactive",
		"candidate",
		"inferred",
		"chain",
	]) {
		const catalog = structuredClone(object(env.catalog));
		const relations = catalog.relations as JsonRecord[];
		const physical = relations.find((relation) => relation.id === physicalId)!;
		const pairs = physical.pairs as JsonRecord[];
		if (mutation === "missing") catalog.relations = relations.filter((relation) => relation.id !== physicalId);
		if (mutation === "incomplete") physical.pairs = pairs.slice(1);
		if (mutation === "tenant")
			physical.pairs = pairs.map((pair) =>
				pair.left === "institution_id" ? { ...pair, left: "other_institution_id" } : pair,
			);
		if (mutation === "duplicate-pair") physical.pairs = [pairs[0], pairs[0]];
		if (mutation === "inactive" || mutation === "candidate") physical.status = mutation;
		if (mutation === "inferred") physical.origin = "model_inferred";
		if (mutation === "chain") physical.physical_relation_id = logicalId;
		const selected = env.knowledge.select(["met.gk-04"], catalog);
		assert.equal(selected.relations.length, 0, mutation);
		const binding = (selected.input.relation_bindings as JsonRecord[]).find((item) => item.logical_id === logicalId)!;
		assert.equal(binding.runtime_id, null, mutation);
	}
});

test("真正不同的物理外键仍歧义且重复运行ID不能覆盖", async (t) => {
	const env = await setup(t);
	const selected = env.knowledge.select(["met.gk-04"], env.catalog);
	const physical = selected.relations[0];
	const ambiguous = structuredClone(object(env.catalog));
	(ambiguous.relations as JsonRecord[]).push({ ...physical, id: `${physical.id}-other-physical-key` });
	assert.throws(() => env.knowledge.select(["met.gk-04"], ambiguous), /对应多个运行关系/);
	const duplicate = structuredClone(object(env.catalog));
	(duplicate.relations as JsonRecord[]).push({ ...physical });
	assert.throws(() => env.knowledge.select(["met.gk-04"], duplicate), /运行关系编号不能重复/);
});

test("全47项按需投影均可加载，原有45加2阻断完整保留", async (t) => {
	const env = await setup(t);
	const counts: Record<string, number> = {};
	for (const metric of env.knowledge.index()) {
		const selected = env.knowledge.select([String(metric.metric_id)], env.catalog);
		assert.equal(selected.metricStatuses.length, 1);
		const status = selected.metricStatuses[0].status;
		counts[status] = (counts[status] || 0) + 1;
		assert.ok(selected.metricStatuses[0].missing.length > 0);
		for (const candidate of selected.candidateRelations)
			assert.equal(
				selected.relations.some((relation) => relation.id === candidate.id),
				false,
			);
	}
	assert.deepEqual(counts, { blocked_engine_and_hospital_mapping: 45, blocked_rule_source: 2 });
});

test("显式合成枚举补充保持来源和整型，不从字段名称或未绑定参数推断值", async (t) => {
	const env = await setup(t);
	const selected = env.knowledge.select(["met.gk-17"], env.catalog);
	const field = "drug_ddd_standards.is_antibacterial";
	const code = selected.codes.find((entry) => entry.physical_field === field && entry.value === 1)!;
	assert.equal(code.provenance, "synthetic_test_design");
	assert.equal(code.convention_id, "extra_code_values");
	const linking = {
		...emptyLinking,
		metric_ids: ["met.gk-17"],
		tables: ["drug_ddd_standards"],
		fields: [field],
		code_filters: [{ field, op: "eq", value: 1 }],
	};
	assert.doesNotThrow(() => validateL0Linking({ linking }, selected));
	assert.throws(
		() => validateL0Linking({ linking: { ...linking, code_filters: [{ field, op: "eq", value: "1" }] } }, selected),
		/错误类型/,
	);
	const balance = env.knowledge.select(["met.gk-36"], env.catalog);
	assert.equal(
		balance.codes.some((entry) => entry.value === "official_asset_account_classes" || entry.value === null),
		false,
	);
});

test("知识所有组成文件及可选约定纳入指纹，源路径相对数据目录", async (t) => {
	const env = await setup(t);
	assert.equal(env.source.knowledge_path, env.knowledgePath);
	const files = [
		"manifest.json",
		"metrics.json",
		"logical_requirements.json",
		"mock_semantics.json",
		"binding_gaps.json",
	];
	for (const name of files) {
		const before = await env.domain.fingerprint(env.source);
		const path = resolve(env.knowledgePath, name);
		await writeFile(path, `${await readFile(path, "utf8")}\n`);
		assert.notEqual(await env.domain.fingerprint(env.source), before, name);
	}
	await rm(resolve(env.knowledgePath, "mock_conventions.json"), { force: true });
	const without = await env.domain.fingerprint(env.source);
	await L0Knowledge.load(env.knowledgePath);
	await writeFile(
		resolve(env.knowledgePath, "mock_conventions.json"),
		JSON.stringify({ version: "test", metric_rules: [] }),
	);
	assert.notEqual(await env.domain.fingerprint(env.source), without);
	await assert.rejects(env.domain.call(env.source, "execute", new AbortController().signal, {}), /不执行SQL/);
});

test("两次decision经Durable保存证据，强制blocked且trace不进入后续prior", async (t) => {
	const env = await setup(t);
	const runtime = await env.start((input) =>
		input.metric_catalog
			? { metric_ids: ["met.gk-01"] }
			: { linking: firstLinking, status: "completed", dsl: { from: "patients" }, answer: "999" },
	);
	const task = await submit(runtime);
	assert.equal(task.status, "blocked");
	const payload = object(task.result);
	const evidence = object(payload.evidence);
	assert.equal(evidence.profile, L0_PROFILE);
	assert.equal(evidence.match_status, "matched");
	assert.deepEqual(evidence.linking, firstLinking);
	assert.equal((evidence.metric_statuses as JsonRecord[])[0].status, "blocked_engine_and_hospital_mapping");
	assert.equal(payload.result, undefined);
	assert.equal(evidence.sql, undefined);
	assert.equal(JSON.stringify(payload.answer).includes("999"), false);
	assert.deepEqual(env.actions, ["catalog"]);
	assert.deepEqual(
		env.requests.map((request) => request.role),
		["decision", "decision"],
	);
	assert.equal((payload.model_calls as unknown[]).length, 2);
	// 只提升字段匹配阶段；识别阶段仍为原预算，证据保留每次实际额度。
	assert.deepEqual(
		env.requests.map((request) => request.max_output_tokens),
		[4096, 8192],
	);
	assert.deepEqual(
		(payload.model_calls as JsonRecord[]).map((call) => call.max_output_tokens),
		[4096, 8192],
	);
	assert.deepEqual(
		(payload.stages as JsonRecord[]).map((stage) => stage.kind),
		["catalog", "decision", "decision", "answer"],
	);
	assert.ok((payload.stages as JsonRecord[]).every((stage) => stage.status === "completed"));
	await submit(runtime, "沿用上一项看字段");
	const prior = env.requests[2].input.prior;
	assert.equal((prior as unknown[]).length, 1);
	for (const forbidden of ["model_calls", "system_prompt", "user_prompt", '"stages"'])
		assert.equal(JSON.stringify(prior).includes(forbidden), false);
});

// 普通问数的新默认只选择物理表；L0必须继续先识别指标，再按权威规则展开依赖并保留阻断状态。
test("progressive默认配置不改变L0两次指标决策及规则依赖路径", async (t) => {
	const env = await setup(t);
	const runtime = await env.start((input) =>
		input.metric_catalog ? { metric_ids: ["met.gk-01"] } : { linking: firstLinking },
	);
	const task = await submit(runtime, "GK-01 门诊人次数与出院人次数比", "progressive-default", {
		retrieval_strategy: "progressive",
		retrieval_top_k: 5,
	});
	assert.equal(task.status, "blocked");
	assert.deepEqual(
		env.requests.map((request) => request.role),
		["decision", "decision"],
	);
	assert.ok(Array.isArray(env.requests[0].input.metric_catalog));
	for (const request of env.requests) {
		assert.equal(Object.hasOwn(request.input, "table_index"), false);
		assert.equal(Object.hasOwn(request.input, "schema_discovery"), false);
	}
	const payload = object(task.result);
	const receipt = (payload.retrievals as JsonRecord[])[0];
	assert.equal(receipt.strategy, "lexical");
	assert.equal(object(receipt.policy).candidate_limit, 12);
	assert.equal((payload.model_calls as unknown[]).length, 2);
	assert.deepEqual(object(payload.evidence).linking, firstLinking);
	assert.equal(payload.result, undefined);
	assert.equal(object(payload.evidence).sql, undefined);
	assert.deepEqual(env.actions, ["catalog"]);
});

test("无匹配保留空结果，错误字段和错误关系失败且不执行SQL", async (t) => {
	const env = await setup(t);
	const runtime = await env.start((input, index) => {
		if (index < 2) return input.metric_catalog ? { metric_ids: [] } : { linking: emptyLinking };
		if (input.metric_catalog) return { metric_ids: ["met.gk-01"] };
		return {
			linking:
				index === 3
					? { ...firstLinking, fields: ["outpatient_visits.not_real"] }
					: { ...firstLinking, relations: ["fk:unknown:0"] },
		};
	});
	const unmatched = await submit(runtime, "讨论目录之外的天气", "unknown");
	assert.equal(unmatched.status, "blocked");
	assert.equal(object(object(unmatched.result).evidence).match_status, "no_match");
	assert.deepEqual(object(object(unmatched.result).evidence).linking, emptyLinking);
	assert.equal((await submit(runtime, "GK-01", "bad-field")).status, "failed");
	const invalid = await submit(runtime, "GK-01", "bad-relation");
	assert.equal(invalid.status, "failed");
	assert.equal((object(invalid.progress).stages as JsonRecord[]).at(-1)!.status, "failed");
	assert.equal(env.actions.includes("execute"), false);
});

test("运行期间知识版本改变拒绝发布旧匹配结果，46/47状态不能解除", async (t) => {
	const env = await setup(t);
	const selected = env.knowledge.select(["met.sh-ps-m0645", "met.sh-ps-s012"], env.catalog);
	assert.ok(selected.metricStatuses.every((metric) => metric.status === "blocked_rule_source"));
	const runtime = await env.start(async (input) => {
		if (input.metric_catalog) return { metric_ids: ["met.gk-01"] };
		const file = resolve(env.knowledgePath, "metrics.json");
		await writeFile(file, `${await readFile(file, "utf8")}\n`);
		return { linking: firstLinking };
	});
	const task = await submit(runtime);
	assert.equal(task.status, "failed");
	assert.match(task.error!.message, /版本已变化/);
	assert.equal(task.result, undefined);
});

// 生产依赖检查独立于gold：缺字段/复合关系/作用域条件必须失败，未绑定参数始终不能造值。
test("规则依赖完整性验证保留GK23分子作用域与GK36未绑定参数", async (t) => {
	const env = await setup(t);
	const selection = env.knowledge.select(["met.gk-23"], env.catalog);
	const rules = l0RuleDependencies(selection);
	const checked = rules.find((rule) => rule.field === "appointment_events.checked_in_at")!;
	assert.equal(checked.scope, "numerator");
	assert.match(String(checked.path), /^numerator\.conditions\.all\[/);
	assert.equal(rules.find((rule) => rule.value === "NO_SHOW")!.op, "ne");
	const input = selection.input;
	const linking = {
		metric_ids: selection.metricIds,
		tables: selection.tables.map((table) => String(table.name)),
		fields: (input.field_bindings as { physical_field: string }[]).map((field) => field.physical_field),
		relations: selection.relations.map((relation) => String(relation.id)),
		candidate_relations: [],
		time_fields: selection.timeFields,
		code_filters: rules
			.filter((rule) => rule.value !== "NO_SHOW")
			.map((rule) => ({ field: String(rule.field), op: String(rule.op), value: rule.value })),
		unresolved_rule_ids: selection.gaps.map((gap) => String(gap.issue_id)),
	};
	assert.deepEqual(validateL0Dependencies(validateL0Linking({ linking }, selection), selection), linking);
	assert.throws(
		() => validateL0Dependencies({ ...linking, fields: linking.fields.slice(1) }, selection),
		/必要结构化依赖/,
	);
	assert.throws(() => validateL0Dependencies({ ...linking, relations: [] }, selection), /必要结构化依赖/);
	assert.throws(
		() =>
			validateL0Dependencies(
				{
					...linking,
					code_filters: linking.code_filters.filter((filter) => filter.field !== "appointment_events.checked_in_at"),
				},
				selection,
			),
		/numerator.conditions/,
	);
	assert.deepEqual(l0RuleDependencies(env.knowledge.select(["met.gk-36"], env.catalog)), []);
});

test("缺依赖定向修复保留首次候选，最终仍blocked且无SQL", async (t) => {
	const env = await setup(t);
	const missing = {
		...firstLinking,
		fields: firstLinking.fields.filter((field) => field !== "inpatient_stays.institution_id"),
	};
	const runtime = await env.start((_input, index) =>
		index === 0 ? { metric_ids: ["met.gk-01"] } : { linking: index === 1 ? missing : firstLinking },
	);
	const task = await submit(runtime, "GK01门诊出院比", "dependencies");
	assert.equal(task.status, "blocked");
	const result = task.result as {
		diagnostics: { code: string }[];
		repairs: { before_artifact_hash: string; after_artifact_hash: string }[];
		stages: { status: string; data?: { candidate?: unknown } }[];
	};
	assert.equal(env.requests.length, 3);
	assert.equal(env.actions.filter((action) => action === "execute").length, 0);
	assert.equal(result.diagnostics[0].code, "missing_rule_dependencies");
	assert.notEqual(result.repairs[0].before_artifact_hash, result.repairs[0].after_artifact_hash);
	assert.deepEqual(result.stages.find((stage) => stage.status === "failed")!.data!.candidate, { linking: missing });
	assert.match(JSON.stringify(env.requests[2].input.correction), /inpatient_stays.institution_id/);
});

// 模型替身重放真实GK25失败的等价写法；使用公开规则，不依赖私有gold或外部模型。
test("GK25完整OR集合无需修复即保留原规则路径并终止于blocked", async (t) => {
	const env = await setup(t);
	const selected = env.knowledge.select(["met.gk-25"], env.catalog);
	const filters = [
		{ field: "inpatient_census_days.bed_kind_code", op: "ne", value: "HOME" },
		{ field: "inpatient_census_days.count_basis_code", op: "in", value: ["SAME_DAY_EXIT", "MIDNIGHT"] },
		{ field: "clinician_year_roster.clinical_work_flag", op: "eq", value: 1 },
		{ field: "clinician_year_roster.standard_training_flag", op: "eq", value: 0 },
		{ field: "clinician_year_roster.primary_registration_here_flag", op: "eq", value: 1 },
	];
	const linking = dependencyLinking(selected, filters);
	assert.deepEqual(validateL0Dependencies(validateL0Linking({ linking }, selected), selected), linking);
	const runtime = await env.start((input) => (input.metric_catalog ? { metric_ids: ["met.gk-25"] } : { linking }));
	const task = await submit(runtime, "GK25每名执业医师日均住院工作负担的床日计数边界", "gk25-or");
	assert.equal(task.status, "blocked");
	assert.equal(env.requests.length, 2, "等价集合不能消耗修复调用");
	assert.deepEqual(env.actions, ["catalog"]);
	const result = object(task.result);
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.repairs, []);
	const evidence = object(result.evidence);
	assert.equal(evidence.dependency_validator_version, "l0-dependencies/v2");
	assert.deepEqual(
		(evidence.rule_dependencies as JsonRecord[])
			.filter((rule) => rule.field === "inpatient_census_days.count_basis_code")
			.map((rule) => [rule.path, rule.value]),
		[
			["numerator.conditions.all[1].any[0]", "MIDNIGHT"],
			["numerator.conditions.all[1].any[1]", "SAME_DAY_EXIT"],
		],
	);
	assert.equal((evidence.metric_statuses as JsonRecord[])[0].status, "blocked_engine_and_hospital_mapping");
});

// 预算是任务的实际执行配置；超限不得发出模型调用，失败收据要与成功收据一样持久保留。
test("指标检索透传冻结topK和预算，超限保留失败收据且不调用模型", async (t) => {
	const env = await setup(t);
	const runtime = await env.start((input) =>
		input.metric_catalog ? { metric_ids: ["met.gk-01"] } : { linking: firstLinking },
	);
	const success = await submit(runtime, "GK-01", "retrieval-ok", {
		retrieval_top_k: 1,
		retrieval_max_context_chars: 30000,
	});
	assert.equal(success.status, "blocked");
	assert.equal((env.requests[0].input.metric_catalog as unknown[]).length, 1);
	const receipt = (object(success.result).retrievals as JsonRecord[])[0];
	assert.equal(receipt.strategy, "lexical");
	assert.equal(object(receipt.character_budget).maximum, 30000);
	assert.equal(object(receipt.policy).candidate_limit, 1);
	const failed = await submit(runtime, "GK-01", "retrieval-failed", {
		retrieval_top_k: 1,
		retrieval_max_context_chars: 1,
	});
	assert.equal(failed.status, "failed");
	assert.equal(env.requests.length, 2, "超限任务不得调用或修复模型");
	const failure = (object(failed.progress).retrievals as JsonRecord[])[0];
	assert.equal(failure.status, "failed");
	assert.equal(failure.error_code, "retrieval_context_budget_exceeded");
	assert.equal(object(failure.character_budget).maximum, 1);
	assert.ok(Number(object(failure.character_budget).actual) > 1);
	assert.deepEqual(failure.admitted_ids, ["met.gk-01"]);
});

// 以下小型规则树专门验证布尔作用域；结构齐备，因此失败必须来自条件而非缺表或缺字段。
function dependencyLinking(selection: L0Selection, code_filters: L0Linking["code_filters"]): L0Linking {
	return {
		metric_ids: selection.metricIds,
		tables: selection.tables.map((table) => String(table.name)),
		fields: (selection.input.field_bindings as JsonRecord[]).map((binding) => String(binding.physical_field)),
		relations: selection.relations.map((relation) => String(relation.id)),
		candidate_relations: selection.candidateRelations.map((relation) => String(relation.id)),
		time_fields: selection.timeFields,
		code_filters,
		unresolved_rule_ids: selection.gaps.map((gap) => String(gap.issue_id)),
	};
}
function dependencySelection(metrics: JsonRecord[]): L0Selection {
	return {
		input: {
			metrics,
			field_bindings: ["code", "other"].map((field) => ({
				logical_field_id: `fld.t.${field}`,
				physical_field: `t.${field}`,
			})),
		},
		metricIds: metrics.map((metric) => String(metric.metric_id)),
		metricStatuses: [],
		tables: [{ name: "t" }],
		relations: [],
		candidateRelations: [],
		timeFields: [],
		codes: [],
		gaps: [],
	};
}
function condition(value: unknown, operator = "eq", field = "code"): JsonRecord {
	return { field_id: `fld.t.${field}`, operator, value };
}
function ruleSelection(numerator: unknown, denominator?: unknown): L0Selection {
	return dependencySelection([
		{ metric_id: "test.metric", numerator: { conditions: numerator }, denominator: { conditions: denominator } },
	]);
}

test("同字段完整嵌套OR可合并，集合顺序和重复不改变有类型语义", () => {
	const selected = ruleSelection({ any: [condition("A"), { any: [condition("B"), condition(["C", "D"], "in")] }] });
	const linking = dependencyLinking(selected, [{ field: "t.code", op: "in", value: ["D", "B", "A", "C", "A"] }]);
	assert.deepEqual(validateL0Dependencies(linking, selected), linking);
	const unordered = ruleSelection(condition(["A", "B"], "not_in"));
	assert.doesNotThrow(() =>
		validateL0Dependencies(
			dependencyLinking(unordered, [{ field: "t.code", op: "not_in", value: ["B", "A"] }]),
			unordered,
		),
	);
});

for (const [label, values] of [
	["子集", ["A"]],
	["超集", ["A", "B", "C"]],
	["类型变化", ["A", 1]],
] as const) {
	test(`OR合并拒绝${label}，不因出现部分正确代码就放行`, () => {
		const selected = ruleSelection({ any: [condition("A"), condition("B")] });
		assert.throws(
			() =>
				validateL0Dependencies(
					dependencyLinking(selected, [{ field: "t.code", op: "in", value: [...values] }]),
					selected,
				),
			/scoped_conditions/,
		);
	});
}

const invalidMerges: { name: string; selection: L0Selection; filters: L0Linking["code_filters"] }[] = [
	{
		name: "合取兄弟",
		selection: ruleSelection({ all: [condition("A"), condition("B")] }),
		filters: [{ field: "t.code", op: "in", value: ["A", "B"] }],
	},
	{
		name: "分子分母",
		selection: ruleSelection(condition("A"), condition("B")),
		filters: [{ field: "t.code", op: "in", value: ["A", "B"] }],
	},
	{
		name: "不同指标",
		selection: dependencySelection([
			{ metric_id: "metric.a", numerator: { conditions: condition("A") } },
			{ metric_id: "metric.b", numerator: { conditions: condition("B") } },
		]),
		filters: [{ field: "t.code", op: "in", value: ["A", "B"] }],
	},
	{
		name: "混合合取分支",
		selection: ruleSelection({ any: [condition("A"), { all: [condition("B"), condition("X", "eq", "other")] }] }),
		filters: [
			{ field: "t.code", op: "in", value: ["A", "B"] },
			{ field: "t.other", op: "eq", value: "X" },
		],
	},
	{
		name: "混合字段",
		selection: ruleSelection({ any: [condition("A"), condition("B"), condition("X", "eq", "other")] }),
		filters: [
			{ field: "t.code", op: "in", value: ["A", "B"] },
			{ field: "t.other", op: "eq", value: "X" },
		],
	},
	{
		name: "未绑定参数分支",
		selection: ruleSelection({
			any: [
				condition("A"),
				condition("B"),
				{ field_id: "fld.t.code", operator: "in", value: null, parameter: "unbound" },
			],
		}),
		filters: [{ field: "t.code", op: "in", value: ["A", "B"] }],
	},
	{
		name: "否定OR",
		selection: ruleSelection({ not: { any: [condition("A"), condition("B")] } }),
		filters: [{ field: "t.code", op: "in", value: ["A", "B"] }],
	},
];
for (const { name, selection, filters } of invalidMerges) {
	test(`条件集合不得跨${name}合并`, () => {
		assert.throws(() => validateL0Dependencies(dependencyLinking(selection, filters), selection), /scoped_conditions/);
	});
}

test("同合取上下文的肯定条件可以证明冗余排除条件", () => {
	const selected = ruleSelection({ all: [condition("SUCCESS"), { not: condition("NO_SHOW") }] });
	assert.doesNotThrow(() =>
		validateL0Dependencies(dependencyLinking(selected, [{ field: "t.code", op: "eq", value: "SUCCESS" }]), selected),
	);
});

const invalidWitnesses = [
	{ name: "分子分母", selection: ruleSelection(condition("SUCCESS"), { not: condition("NO_SHOW") }) },
	{ name: "OR兄弟", selection: ruleSelection({ any: [condition("SUCCESS"), { not: condition("NO_SHOW") }] }) },
	{
		name: "否定合取产生的OR",
		selection: ruleSelection({ not: { all: [{ not: condition("SUCCESS") }, condition("NO_SHOW")] } }),
	},
	{
		name: "不同指标",
		selection: dependencySelection([
			{ metric_id: "metric.a", numerator: { conditions: condition("SUCCESS") } },
			{ metric_id: "metric.b", numerator: { conditions: { not: condition("NO_SHOW") } } },
		]),
	},
	{ name: "无权威肯定条件", selection: ruleSelection({ not: condition("NO_SHOW") }) },
];
for (const { name, selection } of invalidWitnesses) {
	test(`排除条件不能借用${name}中的肯定值`, () => {
		assert.throws(
			() =>
				validateL0Dependencies(
					dependencyLinking(selection, [{ field: "t.code", op: "eq", value: "SUCCESS" }]),
					selection,
				),
			/scoped_conditions/,
		);
	});
}
