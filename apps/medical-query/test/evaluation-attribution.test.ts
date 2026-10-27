import assert from "node:assert/strict";
import { test } from "node:test";
import { observedPerformance, observedRetrievalCoverage, stageAttribution } from "../src/evaluation/attribution.ts";
import type { JsonValue, QueryTask } from "../src/runtime.ts";

// 最小持久观察只提供采集到的字段；不能从最终答案倒填未观察的首次结果。
function turn(result: JsonValue): QueryTask {
	return {
		id: "turn",
		turnId: "turn",
		conversationId: "chat",
		requestId: "req",
		question: "count",
		context: { slot_id: "slot" },
		status: "completed",
		runId: "run",
		replies: [],
		createdAt: 10,
		updatedAt: 210,
		endedAt: 210,
		queuedAt: 10,
		queueDeadlineAt: 1000,
		clarificationRevision: 0,
		result,
	};
}
test("阶段机会包含正常候选，多次修复沿原机会归因且不扩分母", () => {
	const actual = stageAttribution([
		turn({
			stages: [
				{ id: "d0", run_id: "run", kind: "decision", label: "plan", status: "completed" },
				{ id: "e0", run_id: "run", kind: "execution", label: "execute", status: "failed" },
				{ id: "d1", run_id: "run", kind: "decision", label: "plan", status: "completed" },
				{ id: "e1", run_id: "run", kind: "execution", label: "execute", status: "completed" },
				{ id: "a0", run_id: "run", kind: "answer", label: "answer", status: "failed" },
				{ id: "a1", run_id: "run", kind: "answer", label: "answer", status: "failed" },
				{ id: "a2", run_id: "run", kind: "answer", label: "answer", status: "completed" },
			],
			repairs: [
				{
					attempt_id: "e0",
					after_stage_id: "d1",
					diagnostic_id: "diag0",
					revalidated: true,
					protected_constraints_preserved: true,
				},
				{
					attempt_id: "a0",
					after_stage_id: "a1",
					diagnostic_id: "diag1",
					revalidated: false,
					protected_constraints_preserved: null,
				},
				{
					attempt_id: "a1",
					after_stage_id: "a2",
					diagnostic_id: "diag2",
					revalidated: true,
					protected_constraints_preserved: true,
				},
			],
		}),
	]);
	assert.equal(actual.opportunities.length, 3);
	assert.deepEqual(actual.groups["decision:plan"], { N: 1, F: 0, C: 1, W: 0, T: 0, R: 0, U: 0, H: 0, V: 0 });
	assert.equal(actual.groups["execution:execute"].R, 1);
	assert.equal(actual.groups["answer:answer"].T, 1);
	assert.equal(actual.groups["answer:answer"].R, 1);
	assert.deepEqual(actual.opportunities[2].evidence_refs, ["a0", "diag1", "a1", "diag2", "a2"]);
});
test("局部未知与未证实约束保持不算修复成功，不跨追问合并机会", () => {
	const actual = stageAttribution([
		turn({
			stages: [
				{ id: "s0", run_id: "run", kind: "decision", label: "plan", status: "interrupted" },
				{ id: "s1", run_id: "run", kind: "decision", label: "plan", status: "completed" },
				{ id: "s2", run_id: "next", kind: "decision", label: "plan", status: "failed" },
				{ id: "s3", run_id: "next", kind: "decision", label: "plan", status: "completed" },
			],
			repairs: [
				{ attempt_id: "s0", after_stage_id: "s1", revalidated: true, protected_constraints_preserved: true },
				{ attempt_id: "s2", after_stage_id: "s3", revalidated: true, protected_constraints_preserved: null },
			],
		}),
	]);
	assert.equal(actual.groups["decision:plan"].N, 2);
	assert.equal(actual.groups["decision:plan"].W, 1);
	assert.equal(actual.groups["decision:plan"].V, 1);
	assert.equal(actual.groups["decision:plan"].R, 0);
});
test("用量未知保持未知，费用不虚记零，小样本P95说明为最大值", () => {
	const measured = observedPerformance([
		turn({
			usage: [
				{ input_tokens: 10, output_tokens: 5, cost: null, queue_ms: 3, duration_ms: 7 },
				{ input_tokens: null, output_tokens: null, cost: null, queue_ms: 2, duration_ms: 9 },
			],
		}),
	]);
	assert.equal(measured.cost, null);
	assert.deepEqual(measured.input_tokens, { known_total: 10, unknown_calls: 1 });
	assert.equal(measured.model_duration_ms.known_total, 16);
	assert.equal(measured.end_to_end.p95_ms, 200);
	assert.equal(measured.end_to_end.p95_is_sample_max, true);
	assert.equal(measured.gating, false);
});

// 合成收据只模拟归档格式；搜索提示与失败读取即使列出必需表，也不能冒充已披露。
test("渐进披露首末完整集合可诊断恢复，搜索提示和失败读取不贡献召回", () => {
	const observed = turn({
		retrievals: [
			{ schema_version: "schema-disclosure/v1", run_id: "run", action: "index", admitted_ids: [] },
			{
				schema_version: "schema-disclosure/v1",
				run_id: "run",
				action: "read",
				admitted_ids: ["patients"],
				character_budget: { actual: 100 },
			},
			{ schema_version: "schema-disclosure/v1", run_id: "run", action: "search", admitted_ids: ["visits"] },
			{
				schema_version: "schema-disclosure/v1",
				run_id: "run",
				action: "read",
				status: "failed",
				error_code: "schema_context_budget_exceeded",
				admitted_ids: ["patients", "visits"],
				character_budget: { actual: 999 },
			},
			{
				schema_version: "schema-disclosure/v1",
				run_id: "run",
				action: "read",
				admitted_ids: ["patients", "visits"],
				character_budget: { actual: 200 },
			},
		],
	});
	const before = structuredClone(observed);
	const actual = observedRetrievalCoverage([
		{ turn: observed, slot_id: "slot", required_tables: ["patients", "visits"] },
	]);
	assert.equal(actual.items[0].first.complete, false);
	assert.deepEqual(actual.items[0].first.missing_tables, ["visits"]);
	assert.equal(actual.items[0].final.complete, true);
	assert.deepEqual(actual.items[0].final.missing_tables, []);
	assert.equal(actual.items[0].successful_reads, 2);
	assert.equal(actual.items[0].failed_reads, 1);
	assert.deepEqual(actual.items[0].read_characters, { known_total: 300, unknown_reads: 0 });
	assert.equal(actual.aggregate.recovered, 1);
	assert.equal(actual.gating, false);
	assert.deepEqual(observed, before);
});

test("缺gold、缺读取收据及只有搜索提示均为未知，不伪造召回失败", () => {
	const receipt = {
		schema_version: "schema-disclosure/v1",
		run_id: "run",
		action: "read",
		admitted_ids: ["patients"],
	};
	const actual = observedRetrievalCoverage([
		{ turn: turn({ retrievals: [receipt] }), slot_id: "no-gold" },
		{ turn: turn({}), slot_id: "no-read", required_tables: ["patients"] },
		{
			turn: turn({ retrievals: [{ ...receipt, action: "search" }] }),
			slot_id: "hint-only",
			required_tables: ["patients"],
		},
	]);
	assert.equal(actual.aggregate.known, 0);
	assert.equal(actual.aggregate.unknown, 3);
	assert.ok(actual.items.every((item) => item.first.complete === null && item.final.missing_tables === null));
	assert.equal(actual.items[0].read_characters.unknown_reads, 1);
});

test("失败读取不算成功披露，即使包含全部必需表也保留未知", () => {
	const actual = observedRetrievalCoverage([
		{
			turn: turn({
				retrievals: [
					{
						schema_version: "schema-disclosure/v1",
						run_id: "run",
						action: "read",
						status: "failed",
						admitted_ids: ["patients"],
					},
				],
			}),
			slot_id: "failed",
			required_tables: ["patients"],
		},
	]);
	assert.equal(actual.items[0].successful_reads, 0);
	assert.equal(actual.items[0].failed_reads, 1);
	assert.equal(actual.items[0].final.complete, null);
	assert.equal(actual.aggregate.unknown, 1);
});

test("只使用最新run的成功披露，不拼接旧run或无法归属的收据", () => {
	const read = { schema_version: "schema-disclosure/v1", action: "read" };
	const actual = observedRetrievalCoverage([
		{
			turn: turn({
				retrievals: [
					{ ...read, run_id: "old", admitted_ids: ["patients", "visits"] },
					{ ...read, admitted_ids: ["patients", "visits"] },
					{ ...read, run_id: "run", admitted_ids: ["patients"] },
				],
			}),
			slot_id: "latest",
			required_tables: ["patients", "visits"],
		},
	]);
	assert.equal(actual.items[0].run_id, "run");
	assert.equal(actual.items[0].successful_reads, 1);
	assert.equal(actual.items[0].first.complete, false);
	assert.equal(actual.items[0].final.complete, false);
	assert.deepEqual(actual.items[0].final.missing_tables, ["visits"]);
	assert.equal(actual.aggregate.recovered, 0);
});

test("词法目录收据保留首末覆盖，L0投影单列且不混入事实召回分母", () => {
	const catalog = { schema_version: "retrieval-receipt/v1", strategy: "lexical", run_id: "run" };
	const actual = observedRetrievalCoverage([
		{
			turn: turn({
				retrievals: [
					{ ...catalog, admitted_ids: ["patients"] },
					{ ...catalog, admitted_ids: ["patients", "visits"] },
				],
			}),
			slot_id: "baseline",
			required_tables: ["patients", "visits"],
		},
		{
			turn: turn({
				retrievals: [
					{ ...catalog, admitted_ids: ["metric.a"] },
					{ schema_version: "knowledge-projection/v1", run_id: "run", tables: ["patients"] },
				],
			}),
			slot_id: "l0",
			required_tables: ["patients"],
		},
	]);
	assert.equal(actual.items[0].strategy, "lexical");
	assert.equal(actual.items[0].first.complete, false);
	assert.equal(actual.items[0].final.complete, true);
	assert.equal(actual.items[1].track, "l0_schema_linking");
	assert.equal(actual.items[1].final.complete, null);
	assert.equal(actual.aggregate.applicable, 1);
	assert.equal(actual.aggregate.not_applicable, 1);
	assert.equal(actual.aggregate.known, 1);
});

test("缺run_id的旧归档仅在单运行段可归属时回退，多轮归档保持未知", () => {
	const receipt = { schema_version: "retrieval-receipt/v1", strategy: "full_catalog", admitted_ids: ["patients"] };
	const actual = observedRetrievalCoverage([
		{
			turn: turn({ retrievals: [receipt], stages: [{ run_id: "run" }] }),
			slot_id: "legacy-single",
			required_tables: ["patients"],
		},
		{
			turn: turn({ retrievals: [receipt], stages: [{ run_id: "old" }, { run_id: "run" }] }),
			slot_id: "legacy-multi",
			required_tables: ["patients"],
		},
	]);
	assert.equal(actual.items[0].final.complete, true);
	assert.equal(actual.items[1].final.complete, null);
	assert.equal(actual.aggregate.unknown, 1);
});

// 首次成功读取若缺失元信息，后一次完整收据不能反填成首次已完整覆盖。
test("残缺的首次读取收据保持未知，不用最终收据倒填首次召回", () => {
	const actual = observedRetrievalCoverage([
		{
			turn: turn({
				retrievals: [
					{ schema_version: "schema-disclosure/v1", run_id: "run", action: "read" },
					{ schema_version: "schema-disclosure/v1", run_id: "run", action: "read", admitted_ids: ["patients"] },
				],
			}),
			slot_id: "partial-receipt",
			required_tables: ["patients"],
		},
	]);
	assert.equal(actual.items[0].first.complete, null);
	assert.equal(actual.items[0].final.complete, true);
	assert.equal(actual.aggregate.unknown, 1);
	assert.equal(actual.aggregate.recovered, 0);
});
