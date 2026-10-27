import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { APP_ROOT, type AppConfig } from "../src/config.ts";
import { DomainService } from "../src/domain.ts";
import { L0Knowledge, type L0Linking, validateL0Linking } from "../src/l0-knowledge.ts";
import { type JsonRecord, object } from "../src/model.ts";

const execute = promisify(execFile);

// 使用真实生成器与现有领域入口；配置显式构造，不读取本地凭据，也不实例化模型网关。
test("L0 百表包兼容原生数据源、知识投影和只读事实查询", { timeout: 60000 }, async (t) => {
	// Python resolve() 会解析 macOS 的 /var 链接，测试也使用真实路径避免误判配置不兼容。
	const dataDir = await realpath(await mkdtemp(resolve(tmpdir(), "pi-l0-benchmark-")));
	t.after(() => rm(dataDir, { recursive: true, force: true }));
	const packageDir = resolve(dataDir, "package");
	await execute("python3", [
		resolve(APP_ROOT, "python/build_l0_benchmark.py"),
		"--output-dir",
		packageDir,
		"--patients-per-institution",
		"8",
	]);
	// 片段直接复制到临时注册表，能发现数组外层和绝对路径不兼容；不接触运行中注册表。
	await copyFile(resolve(packageDir, "sources.fragment.json"), resolve(dataDir, "sources.json"));
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
	const sources = await domain.sources();
	const linkingSource = await domain.source("l0_benchmark");
	const factsSource = await domain.source("l0_benchmark_facts");
	const signal = new AbortController().signal;
	assert.equal(sources.length, 2);
	assert.equal(linkingSource.knowledge_path, resolve(packageDir, "knowledge"));
	assert.equal(factsSource.knowledge_path, undefined);
	assert.equal(linkingSource.path, factsSource.path);
	assert.equal(linkingSource.dictionary_path, resolve(packageDir, "semantic.json"));
	const catalog = object((await domain.call(linkingSource, "catalog", signal)).catalog);
	const knowledge = await L0Knowledge.load(linkingSource.knowledge_path);

	await t.test("106 张表经现有目录入口读取，模型语义排除答案及测试角色", async () => {
		assert.equal((catalog.tables as JsonRecord[]).length, 106);
		assert.equal(new Set((catalog.tables as JsonRecord[]).map((table) => table.name)).size, 106);
		const semantics = object(catalog.semantics);
		const tables = object(semantics.tables);
		assert.equal(Object.keys(tables).length, 106);
		for (const metadata of Object.values(tables)) {
			assert.equal(object(metadata).role, undefined);
			assert.equal(object(metadata).related_metric_ids, undefined);
			assert.equal(object(metadata).expected_rows, undefined);
		}
		for (const name of [
			"manifest.json",
			"metrics.json",
			"logical_requirements.json",
			"mock_semantics.json",
			"binding_gaps.json",
			"mock_schema.sql",
		]) {
			assert.deepEqual(
				await readFile(resolve(packageDir, "knowledge", name)),
				await readFile(resolve(APP_ROOT, "fixtures/l0", name)),
				name,
			);
		}
	});

	await t.test("全 47 项可按需投影，45 加 2 阻断与候选关系保持", () => {
		assert.equal(knowledge.index().length, 47);
		const counts: Record<string, number> = {};
		for (const metric of knowledge.index()) {
			const selected = knowledge.select([String(metric.metric_id)], catalog);
			assert.equal(selected.metricStatuses.length, 1);
			const status = selected.metricStatuses[0];
			counts[status.status] = (counts[status.status] || 0) + 1;
			assert.ok(status.missing.length > 0);
			// 校验的是现有知识引用兼容，不把引用集合当作独立正确性金标准。
			const linking: L0Linking = {
				metric_ids: selected.metricIds,
				tables: selected.tables.map((table) => String(table.name)),
				fields: selected.tables.flatMap((table) =>
					(table.columns as JsonRecord[]).map((column) => `${table.name}.${column.name}`),
				),
				relations: selected.relations.map((relation) => String(relation.id)),
				candidate_relations: selected.candidateRelations.map((relation) => String(relation.id)),
				time_fields: selected.timeFields,
				code_filters: [],
				unresolved_rule_ids: selected.gaps.map((gap) => String(gap.issue_id)),
			};
			assert.deepEqual(validateL0Linking({ linking }, selected), linking);
			for (const candidate of selected.candidateRelations)
				assert.equal(
					selected.relations.some((relation) => relation.id === candidate.id),
					false,
				);
			const conventions = object(selected.input.mock_conventions);
			for (const key of ["known_limits", "row_count", "table_count", "test_rules", "control_changes"])
				assert.equal(conventions[key], undefined);
		}
		assert.deepEqual(counts, { blocked_engine_and_hospital_mapping: 45, blocked_rule_source: 2 });
	});

	await t.test("新合成代码和非后缀抗菌药标志进入严格校验，整数类型不丢失", () => {
		const cases = [
			{ metric: "met.gk-17", field: "medication_administrations.drug_code", value: "SYN_DRUG_A" },
			{ metric: "met.gk-17", field: "drug_ddd_standards.ddd_version", value: "SYN_DDD_2026" },
			{ metric: "met.gk-14", field: "drg_group_reference.grouper_version", value: "SYN_DRG_2026" },
			{ metric: "met.gk-17", field: "drug_ddd_standards.is_antibacterial", value: 0 },
			{ metric: "met.gk-17", field: "drug_ddd_standards.is_antibacterial", value: 1 },
		];
		for (const { metric, field, value } of cases) {
			const selected = knowledge.select([metric], catalog);
			const code = selected.codes.find((entry) => entry.physical_field === field && entry.value === value);
			assert.ok(code, `${field}=${value} 应作为有类型的代码被投影`);
			assert.equal(code.provenance, "synthetic_test_design");
			assert.equal(code.convention_id, "extra_code_values");
			const linking: L0Linking = {
				metric_ids: [metric],
				tables: [field.split(".")[0]],
				fields: [field],
				relations: [],
				candidate_relations: [],
				time_fields: [],
				code_filters: [{ field, op: "eq", value }],
				unresolved_rule_ids: [],
			};
			assert.deepEqual(validateL0Linking({ linking }, selected), linking);
			if (typeof value === "number") {
				assert.throws(
					() =>
						validateL0Linking(
							{ linking: { ...linking, code_filters: [{ field, op: "eq", value: String(value) }] } },
							selected,
						),
					/错误类型/,
				);
			}
		}
	});

	await t.test("事实源可执行现有 COUNT，指标匹配源仍拒绝 SQL 且文件未变", async () => {
		const dsl = { from: "institutions", select: [{ field: "*", aggregate: "count", as: "institution_count" }] };
		const fingerprint = await domain.fingerprint(factsSource);
		const result = await domain.call(factsSource, "execute", signal, dsl);
		assert.deepEqual(result.columns, ["institution_count"]);
		assert.deepEqual(result.rows, [[3]]);
		assert.equal(result.complete, true);
		assert.equal(await domain.fingerprint(factsSource), fingerprint);
		await assert.rejects(domain.call(linkingSource, "execute", signal, dsl), /只允许Schema Linking，不执行SQL/);
	});
});
