import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type TestContext, test } from "node:test";
import type { AppConfig } from "../src/config.ts";
import { DomainService, resultContentHash } from "../src/domain.ts";
import type { EvaluationCase } from "../src/evaluation/datasets.ts";
import { createDefaultScorers, type EvaluationTurn, type EvidenceAssertion } from "../src/evaluation/scoring.ts";
import { freezeSource, type SourceSnapshot } from "../src/evaluation/snapshots.ts";
import { EvaluationStore } from "../src/evaluation/store.ts";
import type { JsonRecord } from "../src/model.ts";

type Patient = { org: string; patient: string; label: string };
type Visit = { org: string; visit: string; patient: string; time: string; cents: number; currency: string };
type Diagnosis = { org: string; diagnosis: string; visit: string; code: string };
type Facts = { patients: Patient[]; visits: Visit[]; diagnoses: Diagnosis[] };
type FrozenFacts = { snapshot: SourceSnapshot; facts: Facts; before: Buffer };
type Plan = { from: string; select: JsonRecord[]; where: JsonRecord[]; joins?: JsonRecord[] };
const start = "2026-09-01T00:00:00Z";
const end = "2026-10-01T00:00:00Z";

// Gold 只由手写事实对象的集合/整数运算得到；不用参考 SQL、产品编译器或模型反向生成答案。
function eligible(facts: Facts): Visit[] {
	return facts.visits.filter(
		(visit) =>
			visit.org === "H1" && Date.parse(visit.time) >= Date.parse(start) && Date.parse(visit.time) < Date.parse(end),
	);
}

async function setup(context: TestContext, perturb: (facts: Facts) => void) {
	const directory = await mkdtemp(resolve(tmpdir(), "pi-counterfactual-"));
	const store = new EvaluationStore(resolve(directory, "ledger"), 0);
	context.after(async () => {
		store.close();
		await rm(directory, { recursive: true, force: true });
	});
	const config: AppConfig = {
		apiKey: "not-used-no-model",
		baseUrl: "http://127.0.0.1:1",
		decisionModel: "unused",
		answerModel: "unused",
		maxActiveRuns: 5,
		llmMaxConcurrency: 5,
		evalMaxActiveRuns: 5,
		maxPending: 50,
		queueWaitTimeoutMs: 10000,
		llmTimeoutMs: 10000,
		runTimeoutMs: 20000,
		port: 0,
		python: "python3",
		dataDir: directory,
	};
	const domain = new DomainService(config);
	const baseline: Facts = {
		patients: [
			{ org: "H1", patient: "P1", label: "甲" },
			{ org: "H1", patient: "P2", label: "乙" },
		],
		visits: [
			{ org: "H1", visit: "V1", patient: "P1", time: "2026-09-10T12:00:00Z", cents: 123, currency: "CNY" },
			{ org: "H1", visit: "V2", patient: "P2", time: "2026-09-20T12:00:00Z", cents: 237, currency: "CNY" },
		],
		diagnoses: [
			{ org: "H1", diagnosis: "D1", visit: "V1", code: "E11" },
			{ org: "H1", diagnosis: "D2", visit: "V2", code: "E11" },
		],
	};
	const changed = structuredClone(baseline);
	perturb(changed);
	const frozen: FrozenFacts[] = [];
	for (const [index, facts] of [baseline, changed].entries()) {
		const path = resolve(directory, `working-${index}.sqlite`);
		const db = new DatabaseSync(path);
		try {
			db.exec(`PRAGMA foreign_keys=ON;
				CREATE TABLE patients(org_id TEXT,patient_id TEXT,label TEXT,PRIMARY KEY(org_id,patient_id));
				CREATE TABLE visits(org_id TEXT,visit_id TEXT,patient_id TEXT,discharged_at TEXT,cost_cents INTEGER,cost_yuan REAL,currency TEXT,
					PRIMARY KEY(org_id,visit_id),FOREIGN KEY(org_id,patient_id) REFERENCES patients(org_id,patient_id));
				CREATE TABLE diagnoses(org_id TEXT,diagnosis_id TEXT,visit_id TEXT,code TEXT,PRIMARY KEY(org_id,diagnosis_id),
					FOREIGN KEY(org_id,visit_id) REFERENCES visits(org_id,visit_id));`);
			for (const row of facts.patients)
				db.prepare("INSERT INTO patients VALUES(?,?,?)").run(row.org, row.patient, row.label);
			for (const row of facts.visits)
				db.prepare("INSERT INTO visits VALUES(?,?,?,?,?,?,?)").run(
					row.org,
					row.visit,
					row.patient,
					row.time,
					row.cents,
					row.cents / 100,
					row.currency,
				);
			for (const row of facts.diagnoses)
				db.prepare("INSERT INTO diagnoses VALUES(?,?,?,?)").run(row.org, row.diagnosis, row.visit, row.code);
		} finally {
			db.close();
		}
		const snapshot = await freezeSource({ id: "counterfactual", name: "手写事实反例", path }, directory);
		frozen.push({ snapshot, facts, before: await readFile(snapshot.source.path) });
	}
	assert.notEqual(frozen[0].snapshot.source_version, frozen[1].snapshot.source_version);
	return {
		frozen,
		domain,
		async checks(
			fixture: FrozenFacts,
			plan: Plan,
			result: JsonRecord,
			expected: number,
			assertions: EvidenceAssertion[],
		) {
			// 观察保存真实编译 SQL、实际绑定参数及源快照；检查器只读取归档，不重新执行候选来造 gold。
			const turn: EvaluationTurn = {
				status: "completed",
				result,
				evidence: { snapshot_id: fixture.snapshot.id, source_version: fixture.snapshot.source_version, dsl: plan },
			};
			const id = store.artifact(turn, "counterfactual_observation", `snapshot:${fixture.snapshot.id}`);
			const archived = store.readArtifact<EvaluationTurn>(id);
			const sample: EvaluationCase = {
				id: "known-counterfactual",
				source_id: "counterfactual",
				question: "按已冻结合成约定统计，不代表正式医院指标验收",
				as_of: end,
				track: "synthetic_counterfactual",
				family: "known-fault",
				split: "dev",
				expected_action: "answer",
				profile: "result_only",
				coverage_gaps: [],
				gold: { expected_rows: [{ n: expected }], semantic_contract: { assertions } },
			};
			const checks = await createDefaultScorers().run({ sample, turn: archived }, ["result", "semantic"]);
			assert.ok(checks.every((check) => check.evaluation_status === "valid"));
			assert.deepEqual(await readFile(fixture.snapshot.source.path), fixture.before, "反例执行不能修改冻结业务库");
			return Object.fromEntries(checks.map((check) => [check.check_id, check.status]));
		},
	};
}

function countPlan(): Plan {
	return {
		from: "visits",
		select: [{ field: "visits.visit_id", aggregate: "count", as: "n" }],
		where: [
			{ field: "visits.org_id", op: "eq", value: "H1" },
			{ field: "visits.discharged_at", op: "gte", value: start },
			{ field: "visits.discharged_at", op: "lt", value: end },
		],
	};
}

test("冻结 SQL 机构复合键在基线巧合时仍被检查，跨机构重号快照揭示数值污染", async (context) => {
	const env = await setup(context, (facts) => {
		facts.patients.push({ org: "H2", patient: "P1", label: "他院甲" }, { org: "H2", patient: "P2", label: "他院乙" });
	});
	const plan = countPlan();
	plan.joins = [{ relation: "fk:visits:0", type: "inner" }];
	const orgPair = '"visits"."org_id" = "patients"."org_id"';
	const assertions: EvidenceAssertion[] = [
		{ id: "complete-org-join", path: "turn.result.sql", op: "includes", expected: orgPair },
		{ id: "org-parameter", path: "turn.result.parameters.0", op: "equals", expected: "H1" },
	];
	for (const [index, fixture] of env.frozen.entries()) {
		const result = await env.domain.call(fixture.snapshot.source, "execute", new AbortController().signal, plan);
		const expected = eligible(fixture.facts).length;
		assert.deepEqual(await env.checks(fixture, plan, result, expected, assertions), {
			result: "pass",
			semantic: "pass",
		});
		assert.ok(String(result.sql).includes(orgPair), "生产编译器必须生成复合外键的全部列对");
		// 在生产编译后的 SQL 产物注入已知漏键故障，只在测试的只读连接执行；产品不开放原始 SQL 入口。
		const sql = String(result.sql).replace(`${orgPair} AND `, "");
		assert.notEqual(sql, result.sql);
		const db = new DatabaseSync(fixture.snapshot.source.path, { readOnly: true });
		let rows: unknown[][];
		try {
			rows = db
				.prepare(sql)
				.all(...(result.parameters as SQLInputValue[]))
				.map((row) => Object.values(row));
		} finally {
			db.close();
		}
		const mutant = {
			...result,
			sql,
			rows,
			preview_rows: rows,
			result_content_hash: resultContentHash({
				columns: result.columns as string[],
				rows,
				complete: true,
				truncated: false,
			}),
		};
		const checks = await env.checks(fixture, plan, mutant, expected, assertions);
		assert.equal(checks.semantic, "fail");
		assert.equal(checks.result, index === 0 ? "pass" : "fail", "基线同值不能替代机构关系校验");
	}
});

test("多诊断扩张快照检出 JOIN 放大，患者集合 oracle 不把就诊或诊断数当人数", async (context) => {
	const env = await setup(context, (facts) => {
		facts.diagnoses.push(
			{ org: "H1", diagnosis: "D3", visit: "V1", code: "E11" },
			{ org: "H1", diagnosis: "D4", visit: "V1", code: "E11" },
		);
	});
	const plan = countPlan();
	plan.joins = [{ relation: "fk:diagnoses:0", type: "inner" }];
	plan.where.push({ field: "diagnoses.code", op: "eq", value: "E11" });
	plan.select = [{ field: "visits.patient_id", aggregate: "count_distinct", as: "n" }];
	const assertions: EvidenceAssertion[] = [
		{ id: "patient-grain", path: "turn.result.sql", op: "includes", expected: 'COUNT(DISTINCT "visits"."patient_id")' },
	];
	for (const [index, fixture] of env.frozen.entries()) {
		const qualifying = eligible(fixture.facts).filter((visit) =>
			fixture.facts.diagnoses.some(
				(diagnosis) => diagnosis.org === visit.org && diagnosis.visit === visit.visit && diagnosis.code === "E11",
			),
		);
		const expected = new Set(qualifying.map((visit) => `${visit.org}:${visit.patient}`)).size;
		const correct = await env.domain.call(fixture.snapshot.source, "execute", new AbortController().signal, plan);
		assert.deepEqual(await env.checks(fixture, plan, correct, expected, assertions), {
			result: "pass",
			semantic: "pass",
		});
		const wrongPlan = structuredClone(plan);
		wrongPlan.select[0].aggregate = "count";
		const wrong = await env.domain.call(fixture.snapshot.source, "execute", new AbortController().signal, wrongPlan);
		const checks = await env.checks(fixture, wrongPlan, wrong, expected, assertions);
		assert.equal(checks.semantic, "fail");
		assert.equal(checks.result, index === 0 ? "pass" : "fail");
	}
});

test("日期端点快照独立核验左闭右开，实际 SQL 操作符与绑定参数共同评分", async (context) => {
	const env = await setup(context, (facts) => {
		for (const [index, time] of ["2026-08-31T23:59:59Z", start, "2026-09-30T23:59:59Z", end].entries())
			facts.visits.push({ org: "H1", visit: `edge-${index}`, patient: "P1", time, cents: 0, currency: "CNY" });
	});
	const plan = countPlan();
	const assertions: EvidenceAssertion[] = [
		{ id: "start-inclusive", path: "turn.result.sql", op: "includes", expected: '"visits"."discharged_at" >= ?' },
		{ id: "end-exclusive", path: "turn.result.sql", op: "includes", expected: '"visits"."discharged_at" < ?' },
		{ id: "actual-parameters", path: "turn.result.parameters", op: "equals", expected: ["H1", start, end, 5001] },
	];
	for (const [index, fixture] of env.frozen.entries()) {
		const expected = eligible(fixture.facts).length;
		const correct = await env.domain.call(fixture.snapshot.source, "execute", new AbortController().signal, plan);
		assert.deepEqual(await env.checks(fixture, plan, correct, expected, assertions), {
			result: "pass",
			semantic: "pass",
		});
		for (const [condition, operator] of [
			[1, "gt"],
			[2, "lte"],
		] as const) {
			const wrongPlan = structuredClone(plan);
			wrongPlan.where[condition].op = operator;
			const wrong = await env.domain.call(fixture.snapshot.source, "execute", new AbortController().signal, wrongPlan);
			const checks = await env.checks(fixture, wrongPlan, wrong, expected, assertions);
			assert.equal(checks.semantic, "fail");
			assert.equal(checks.result, index === 0 ? "pass" : "fail");
		}
	}
});

test("金额单位和币种反例以整数分 oracle 核验，退款与其他币种不能被错误混算", async (context) => {
	const env = await setup(context, (facts) => {
		facts.visits.push(
			{ org: "H1", visit: "refund", patient: "P1", time: "2026-09-25T12:00:00Z", cents: -100, currency: "CNY" },
			{ org: "H1", visit: "other-currency", patient: "P2", time: "2026-09-25T12:00:00Z", cents: 5000, currency: "JPY" },
		);
	});
	const plan = countPlan();
	plan.select = [{ field: "visits.cost_cents", aggregate: "sum", as: "n" }];
	plan.where.push({ field: "visits.currency", op: "eq", value: "CNY" });
	const assertions: EvidenceAssertion[] = [
		{ id: "integer-cent-unit", path: "turn.result.sql", op: "includes", expected: 'SUM("visits"."cost_cents")' },
		{ id: "currency-filter", path: "turn.result.sql", op: "includes", expected: '"visits"."currency" = ?' },
		{ id: "currency-parameter", path: "turn.result.parameters.3", op: "equals", expected: "CNY" },
	];
	for (const [index, fixture] of env.frozen.entries()) {
		const expected = eligible(fixture.facts)
			.filter((visit) => visit.currency === "CNY")
			.reduce((total, visit) => total + visit.cents, 0);
		const correct = await env.domain.call(fixture.snapshot.source, "execute", new AbortController().signal, plan);
		assert.deepEqual(await env.checks(fixture, plan, correct, expected, assertions), {
			result: "pass",
			semantic: "pass",
		});
		const wrongUnit = structuredClone(plan);
		wrongUnit.select[0].field = "visits.cost_yuan";
		const wrong = await env.domain.call(fixture.snapshot.source, "execute", new AbortController().signal, wrongUnit);
		assert.deepEqual(await env.checks(fixture, wrongUnit, wrong, expected, assertions), {
			result: "fail",
			semantic: "fail",
		});
		const mixedCurrency = structuredClone(plan);
		mixedCurrency.where.pop();
		const mixed = await env.domain.call(
			fixture.snapshot.source,
			"execute",
			new AbortController().signal,
			mixedCurrency,
		);
		const checks = await env.checks(fixture, mixedCurrency, mixed, expected, assertions);
		assert.equal(checks.semantic, "fail");
		assert.equal(checks.result, index === 0 ? "pass" : "fail");
	}
});
