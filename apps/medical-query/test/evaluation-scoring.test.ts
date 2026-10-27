import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type ComparisonProtocol,
	checkComparability,
	compareArms,
	deriveFirstTaskOutcome,
	evaluateQualityGate,
	type PlannedSlot,
	passK,
	type QualityPolicy,
	type QualityReport,
	REQUIRED_SEVERE_CHECKS,
	type ScoredObservation,
	summarizeRepairs,
	summarizeStageRepairs,
	validateQualityPolicy,
} from "../src/evaluation/comparison.ts";
import {
	contentHash,
	type EvaluationCase,
	loadBenchmarkDataset,
	parseDataset,
	publicDataset,
} from "../src/evaluation/datasets.ts";
import {
	aggregateScores,
	type CaseScore,
	canonicalRelation,
	compareResults,
	createAdjudication,
	createScoreSet,
	type EvaluationTurn,
	type ScorerDefinition,
	ScorerRegistry,
	scoreCase,
} from "../src/evaluation/scoring.ts";

// 手写最小反例独立于产品输出，覆盖分母、复合关系和数值发布的错误通过路径。
const question = { id: "q1", source_id: "facts", question: "甲机构有几次就诊", as_of: "2026-10-15T12:00:00+08:00" };
const baseGold = {
	...question,
	family_id: "visits",
	split: "dev",
	category: "synthetic_fact_query",
	expected_action: "answer",
	expected_rows: [{ n: 7 }],
};
function dataset(overrides: Record<string, unknown> = {}) {
	return parseDataset({
		questionsJsonl: JSON.stringify(question),
		goldJsonl: JSON.stringify({ ...baseGold, ...overrides }),
	});
}
function turn(rows: unknown[] = [[7]]): EvaluationTurn {
	return {
		status: "completed",
		result: { columns: ["n"], rows, complete: true, truncated: false, row_count: rows.length },
	};
}
function sample(overrides: Record<string, unknown> = {}): EvaluationCase {
	return dataset(overrides).cases[0];
}
function syntheticScore(status: "pass" | "fail" = "pass", overrides: Partial<CaseScore> = {}): CaseScore {
	return {
		case_id: "q1",
		track: "synthetic_fact_query",
		family: "visits",
		profile: "result_only",
		expected_action: "answer",
		status,
		evaluation_status: "valid",
		checks: [],
		input_hash: "a".repeat(64),
		scorer_hash: "b".repeat(64),
		coverage_gaps: [],
		...overrides,
	};
}
const goodCheck: ReturnType<ScorerDefinition["score"]> = {
	status: "pass",
	evaluation_status: "valid",
	reason_code: "test",
	evidence_refs: ["turn.status"],
};
function definition(id: string, extra: Partial<ScorerDefinition> = {}): ScorerDefinition {
	return { id, version: "1", dependencies: [], required_evidence: [], budget_ms: 50, score: () => goodCheck, ...extra };
}

test("数据集身份稳定，公共投影不含 gold，完整任务不能由旧结果 gold 冒充", () => {
	const first = dataset(),
		second = dataset();
	assert.equal(first.hash, second.hash);
	assert.deepEqual(Object.keys(publicDataset(first).cases[0]).sort(), ["as_of", "id", "question", "source_id"]);
	assert.equal(JSON.stringify(publicDataset(first)).includes("expected_rows"), false);
	assert.equal(first.cases[0].profile, "result_only");
	assert.equal(Object.isFrozen(first.cases[0].gold), true);
	assert.throws(() => dataset({ check_profile: "task_complete" }), /invalid_gold/);
	assert.throws(
		() =>
			parseDataset({ questionsJsonl: JSON.stringify({ ...question, gold: {} }), goldJsonl: JSON.stringify(baseGold) }),
		/公共问题/,
	);
});

test("family 改写不得跨开发保留集，重复 ID 与来源错配在导入时拒绝", () => {
	const q2 = { ...question, id: "q2" };
	assert.throws(
		() =>
			parseDataset({
				questionsJsonl: [question, q2].map((item) => JSON.stringify(item)).join("\n"),
				goldJsonl: [baseGold, { ...baseGold, id: "q2", split: "holdout" }]
					.map((item) => JSON.stringify(item))
					.join("\n"),
			}),
		/跨拆分/,
	);
	assert.throws(
		() =>
			parseDataset({
				questionsJsonl: `${JSON.stringify(question)}\n${JSON.stringify(question)}`,
				goldJsonl: JSON.stringify(baseGold),
			}),
		/重复问题/,
	);
	assert.throws(() => dataset({ source_id: "other" }), /来源不一致/);
});

test("现有冻结包按 136 题完整导入，并保留正式阻断与合成轨道", async (context) => {
	const path = fileURLToPath(new URL("../.local/l0-benchmark-v1", import.meta.url));
	try {
		await access(path);
	} catch {
		context.skip("本环境没有离线生成的冻结包");
		return;
	}
	const loaded = await loadBenchmarkDataset(path);
	assert.equal(loaded.cases.length, 136);
	assert.equal(loaded.coverage.tracks.official_metric_linking, 47);
	assert.equal(loaded.coverage.tracks.official_metric_boundary, 47);
	assert.equal(loaded.coverage.tracks.synthetic_fact_query, 30);
	assert.equal(loaded.coverage.tracks.synthetic_calculation, 10);
	assert.equal(loaded.cases.filter((item) => item.expected_action === "answer").length, 40);
	assert.equal(loaded.coverage.profiles.task_complete ?? 0, 0);
	assert.ok(loaded.logical_relations.length > 0);
});

test("typed 多重集保留重复、NULL、类型、空集与截断边界", () => {
	assert.equal(compareResults(turn([[7], [7]]), { expected_rows: [{ n: 7 }, { n: 7 }] }).passed, true);
	assert.equal(compareResults(turn([[7], [8]]), { expected_rows: [{ n: 7 }, { n: 7 }] }).passed, false);
	assert.equal(compareResults(turn([["7"]]), baseGold).passed, false);
	assert.equal(compareResults(turn([[0]]), { expected_rows: [{ n: null }] }).passed, false);
	assert.equal(compareResults(turn([]), { expected_rows: [] }).passed, true);
	assert.equal(
		compareResults({ status: "completed", result: { rows: [{ n: 7 }], complete: true, truncated: true } }, baseGold)
			.passed,
		false,
	);
	assert.equal(
		compareResults({ status: "completed", result: { rows: [{ n: 7 }], complete: true, row_count: 2 } }, baseGold)
			.passed,
		false,
	);
});

test("显式别名和数值容差可等价，不放松整数与行顺序", () => {
	const gold = {
		expected_rows: [{ n: 1.1 }, { n: 1.2 }],
		result_contract: {
			aliases: { n: ["count"] },
			column_settings: { n: { type: "decimal", absolute_tolerance: 0.11 } },
		},
	};
	assert.equal(
		compareResults({ status: "completed", result: { rows: [{ count: 1.2 }, { count: 1.0 }], complete: true } }, gold)
			.passed,
		true,
	);
	assert.equal(compareResults(turn([[7.000001]]), { ...baseGold, comparison: { numeric_tolerance: 1 } }).passed, false);
	assert.equal(
		compareResults(turn([[2], [1]]), { expected_rows: [{ n: 1 }, { n: 2 }], comparison: { row_order: "ordered" } })
			.passed,
		false,
	);
});

const relation = {
	id: "logical",
	left_table: "visits",
	right_table: "patients",
	pairs: [
		{ left: "org", right: "org" },
		{ left: "patient", right: "id" },
	],
};
function blockedSample(): EvaluationCase {
	return sample({
		category: "official_metric_linking",
		expected_action: "blocked",
		required_metric_ids: ["m1"],
		required_tables: ["visits", "patients"],
		required_fields: ["visits.org", "patients.org"],
		required_time_fields: [],
		required_gap_ids: ["official-rule-unbound"],
		required_logical_relations: ["logical"],
		candidate_relation_ids: [],
		expected_execution_statuses: [{ metric_id: "m1", status: "blocked" }],
	});
}
function blockedTurn(): EvaluationTurn {
	return {
		status: "blocked",
		evidence: {
			match_status: "matched",
			linking: {
				metric_ids: ["m1"],
				tables: ["visits", "patients"],
				fields: ["visits.org", "patients.org"],
				time_fields: [],
				relations: ["fk0"],
				candidate_relations: [],
				unresolved_rule_ids: ["official-rule-unbound"],
			},
			metric_statuses: [{ metric_id: "m1", status: "blocked" }],
		},
	};
}
const linkingOptions = { logicalRelations: [relation], catalog: { relations: [{ ...relation, id: "fk0" }] } };

test("正式阻断必须正确匹配规则，全部拒答不增加合成通过率", async () => {
	const formal = blockedSample(),
		factual = sample();
	const right = await scoreCase(formal, blockedTurn(), linkingOptions),
		wrong = await scoreCase(factual, { status: "blocked" });
	assert.equal(right.status, "pass");
	assert.equal(wrong.status, "fail");
	const report = aggregateScores([{ ...formal, id: "official" }, factual], [{ ...right, case_id: "official" }, wrong]);
	assert.equal(report.tracks.official_metric_linking.value, 1);
	assert.equal(report.tracks.synthetic_fact_query.value, 0);
	assert.equal((await scoreCase(formal, { status: "blocked" }, linkingOptions)).status, "fail");
});

test("关系比较接受反向完整列对，漏机构键或未知关系不能通过", async () => {
	const reversed = {
		left_table: "patients",
		right_table: "visits",
		pairs: [
			{ left: "id", right: "patient" },
			{ left: "org", right: "org" },
		],
	};
	assert.equal(canonicalRelation(relation), canonicalRelation(reversed));
	const incomplete = {
		logicalRelations: [relation],
		catalog: { relations: [{ ...relation, id: "fk0", pairs: [relation.pairs[1]] }] },
	};
	assert.equal((await scoreCase(blockedSample(), blockedTurn(), incomplete)).status, "fail");
	assert.equal((await scoreCase(blockedSample(), blockedTurn())).evaluation_status, "evidence_unavailable");
	const mutated = blockedTurn();
	(mutated.evidence as { linking: { relations: string[] } }).linking.relations.push("unknown");
	assert.equal((await scoreCase(blockedSample(), mutated, linkingOptions)).status, "fail");
});

test("阻断过程中实际执行 SQL 是严重违规，即便匹配正确", async () => {
	const observed = { ...blockedTurn(), stages: [{ kind: "execution" }] };
	const score = await scoreCase(blockedSample(), observed, linkingOptions);
	assert.equal(score.status, "fail");
	assert.equal(score.checks.find((item) => item.check_id === "blocked_boundary")?.severity, "critical");
});

function completeSample(): EvaluationCase {
	return sample({
		check_profile: "task_complete",
		semantic_contract: { assertions: [{ id: "org", path: "turn.evidence.org", op: "equals", expected: "H001" }] },
		answer_contract: { assertions: [{ id: "answer", path: "turn.answer", op: "equals", expected: "共有7次。" }] },
		process_contract: { assertions: [{ id: "no-write", path: "turn.evidence.write_attempt", op: "absent" }] },
	});
}
function publishedTurn(): EvaluationTurn {
	const result = {
		columns: ["n"],
		rows: [[7]],
		complete: true,
		truncated: false,
		row_count: 1,
		total: 1,
		sql: "SELECT count(*) AS n FROM visits",
		parameters: [],
	};
	const publication = {
		id: "pub1",
		version: 1,
		status: "published",
		result,
		evidence: { source_id: "facts", source_version: "snapshot1", sql: result.sql, parameters: [] },
		source_version: "snapshot1",
		result_hash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
		validation: {
			status: "passed",
			checks: ["source_version", "compiler", "read_only", "complete_result", "row_shape"],
		},
		answer: "共有7次。",
		answer_status: "completed",
	};
	return {
		status: "completed",
		result: { publication, evidence: { org: "H001" }, answer: "共有7次。", answer_status: "completed" },
	};
}

test("完整任务只接受已绑定发布结果，候选进度、错源与改写答案均不能过门", async () => {
	assert.equal(
		(await scoreCase(completeSample(), publishedTurn(), { artifacts: { expected_source_version: "snapshot1" } }))
			.status,
		"pass",
	);
	assert.equal(
		(await scoreCase(completeSample(), publishedTurn(), { artifacts: { expected_source_version: "other" } })).status,
		"fail",
	);
	assert.equal(
		(await scoreCase(completeSample(), { status: "completed", progress: { data_result: turn().result } })).status,
		"fail",
	);
	const changed = publishedTurn();
	(changed.result as Record<string, unknown>).answer = "共有8次。";
	assert.equal(
		(await scoreCase(completeSample(), changed)).checks.find((item) => item.check_id === "publication")?.status,
		"fail",
	);
	await assert.rejects(scoreCase(completeSample(), publishedTurn(), { profile: "result_only" }), /不得事后/);
});

test("检查器循环、异常、超时和缺依赖是评分器错误，不能伪装产品失败", async () => {
	const input = { sample: sample(), turn: turn() };
	const cyclic = new ScorerRegistry()
		.register(definition("a", { dependencies: ["b"] }))
		.register(definition("b", { dependencies: ["a"] }));
	assert.equal((await cyclic.run(input, ["a"]))[0].evaluation_status, "evaluator_error");
	const broken = new ScorerRegistry()
		.register(
			definition("throw", {
				score: () => {
					throw new Error("broken");
				},
			}),
		)
		.register(definition("timeout", { budget_ms: 5, score: async () => new Promise(() => {}) }));
	assert.equal(
		(await broken.run(input, ["throw", "timeout"])).every((item) => item.evaluation_status === "evaluator_error"),
		true,
	);
	const missing = new ScorerRegistry().register(definition("field", { required_evidence: ["turn.evidence.org"] }));
	assert.equal((await missing.run(input, ["field"]))[0].status, "fail");
});

test("检查器不能变造后续证据，不适用必需检查不算通过", async () => {
	const registry = new ScorerRegistry()
		.register(
			definition("action", {
				score: (input) => {
					input.turn.status = "changed";
					return goodCheck;
				},
			}),
		)
		.register(definition("result"));
	const observed = turn();
	assert.equal((await scoreCase(sample(), observed, { registry })).evaluation_status, "evaluator_error");
	assert.equal(observed.status, "completed");
	const inapplicable = new ScorerRegistry()
		.register(definition("action", { applicable: () => false }))
		.register(definition("result"));
	assert.equal((await scoreCase(sample(), turn(), { registry: inapplicable })).status, "unknown");
});

test("已计划分母包含失败与未评分，重复槽、错身份与混裁判令报告无效", async () => {
	const passed = await scoreCase(sample(), turn());
	assert.equal(
		aggregateScores([sample(), { ...sample(), id: "q2" }], [passed]).tracks.synthetic_fact_query.denominator,
		2,
	);
	assert.equal(aggregateScores([sample(), { ...sample(), id: "q2" }], [passed]).status, "incomplete");
	assert.equal(aggregateScores([sample()], [passed, passed]).status, "invalid");
	assert.equal(aggregateScores([sample(), sample()], [passed]).status, "invalid");
	assert.equal(aggregateScores([sample()], [{ ...passed, family: "wrong" }]).status, "invalid");
	assert.equal(
		aggregateScores(
			[
				{ ...sample(), slot_id: "a" },
				{ ...sample(), slot_id: "b" },
			],
			[
				{ ...passed, slot_id: "a" },
				{ ...passed, slot_id: "b" },
			],
		).status,
		"valid",
	);
	assert.equal(aggregateScores([], []).status, "invalid");
});

test("首次计划局部通过不能推出整题通过，充分必要条件失败可归入 F", () => {
	const first = deriveFirstTaskOutcome({
		profile: "task_complete",
		firstScore: syntheticScore(),
		interruptedByRepair: true,
	});
	assert.equal(first.status, "unknown");
	const proof = deriveFirstTaskOutcome({
		profile: "result_only",
		necessaryFailures: [
			{
				check_id: "institution",
				artifact_hash: "c".repeat(64),
				predicate: "已混算机构且后续不能恢复",
				validator_version: "1",
				evidence_refs: ["candidate1"],
				normal_followup_cannot_resolve: true,
				status: "fail",
			},
		],
	});
	assert.equal(proof.basis, "necessary_condition_failure");
	const summary = summarizeRepairs([
		{ slot_id: "a", score: syntheticScore(), first: proof, repair_triggered: true },
		{ slot_id: "b", score: syntheticScore(), first, repair_triggered: true },
	]);
	assert.deepEqual([summary.F, summary.F_proven, summary.W, summary.R, summary.V], [1, 1, 1, 1, 1]);
	assert.equal(summary.N, summary.F + summary.C + summary.W);
	assert.equal(summary.triggered, summary.T + summary.U + summary.V);
	assert.equal(summary.causal_claim, false);
});

test("误改率以所有首次正确机会为分母，阶段修复必须保留受保护条件", () => {
	const first = deriveFirstTaskOutcome({ profile: "result_only", firstScore: syntheticScore() });
	const summary = summarizeRepairs([
		{ slot_id: "a", score: syntheticScore("fail"), first, repair_triggered: true },
		{ slot_id: "b", score: syntheticScore(), first },
	]);
	assert.equal(summary.harmful_repair.value, 0.5);
	assert.equal(summary.harm_after_false_trigger.value, 1);
	const stages = summarizeStageRepairs([
		{ stage: "linking", before: "fail", after: "pass", triggered: true, protected_constraints_preserved: false },
	]);
	assert.equal(stages.linking.R, 0);
	assert.throws(
		() =>
			summarizeRepairs([
				{ slot_id: "a", score: syntheticScore() },
				{ slot_id: "a", score: syntheticScore() },
			]),
		/duplicate/,
	);
});

function comparisonFixture(): {
	protocol: ComparisonProtocol;
	slots: PlannedSlot[];
	observations: ScoredObservation[];
} {
	const arms = [
		{ variant_id: "off", kind: "repair_off" },
		{ variant_id: "on", kind: "repair_on" },
		{ variant_id: "retry", kind: "ordinary_retry" },
	] as const;
	const protocol: ComparisonProtocol = {
		arms: [...arms],
		bundles: Object.fromEntries(
			arms.map((arm) => [arm.variant_id, { model: "frozen", budget: 3, policy: arm.kind, data: "v1" }]),
		),
		allowed_differences: [{ path: "policy", values: arms.map((arm) => arm.kind) }],
		required_verified_paths: ["model", "data"],
		equal_budget_paths: ["budget"],
		bootstrap_repetitions: 20,
	};
	const slots = arms.map((arm) => ({
		slot_id: arm.variant_id,
		case_id: "q1",
		family: "visits",
		variant_id: arm.variant_id,
		repeat_index: 0,
		snapshot_id: "s1",
	}));
	const observations = slots.map((slot) => ({
		slot_id: slot.slot_id,
		score: syntheticScore(slot.variant_id === "off" ? "fail" : "pass", { slot_id: slot.slot_id }),
	}));
	return { protocol, slots, observations };
}

test("三组严格配对只放行冻结差异，少题、错模型、缓存与额度混杂均不可比", () => {
	const fixture = comparisonFixture();
	assert.equal(compareArms(fixture.slots, fixture.observations, fixture.protocol).status, "valid");
	assert.equal(compareArms(fixture.slots, fixture.observations.slice(1), fixture.protocol).comparable, false);
	assert.equal(
		compareArms(
			fixture.slots,
			[{ ...fixture.observations[0], origin: "cached_answer" }, ...fixture.observations.slice(1)],
			fixture.protocol,
		).comparable,
		false,
	);
	fixture.protocol.bundles.on.budget = 4;
	fixture.protocol.allowed_differences.push({ path: "budget", values: [3, 4] });
	assert.ok(
		compareArms(fixture.slots, fixture.observations, fixture.protocol).errors.some((error) => error.includes("budget")),
	);
	assert.equal(
		checkComparability({ a: { model: "unknown" }, b: { model: "unknown" } }, [], ["model"]).comparable,
		false,
	);
	assert.equal(checkComparability({ a: { model: "a" }, b: { model: "b" } }, []).comparable, false);
});

test("pass^k 统计同题多次全部成功概率，重复不足保持未知", () => {
	assert.equal(passK([true, true, false], 2), 1 / 3);
	assert.equal(passK([true], 2), null);
	assert.equal(passK([false, true], 2), 0);
	assert.throws(() => passK([true], 0), /invalid/);
});

function releaseFixture(): { policy: QualityPolicy; report: QualityReport } {
	return {
		policy: {
			id: "policy-v1",
			thresholds: [
				{ track: "facts", minimum_pass_rate: 0.8, minimum_cases: 10, minimum_families: 2, profile: "task_complete" },
			],
			severe_checks: REQUIRED_SEVERE_CHECKS.map((check_id) => ({ check_id, minimum_samples: 1 })),
		},
		report: {
			status: "valid",
			tracks: { facts: { numerator: 9, denominator: 10, value: 0.9, families: 2, profiles: { task_complete: 10 } } },
			checks: Object.fromEntries(
				REQUIRED_SEVERE_CHECKS.map((id) => [
					id,
					{ applicable: 1, passed: 1, failed: 0, unevaluated: 0, severity: "critical" },
				]),
			),
			cost: 999,
			duration_ms: 999999,
		},
	};
}

test("质量门校验政策结构，成本仅提示，关键样本不足不可发布", () => {
	const { policy, report } = releaseFixture();
	assert.equal(evaluateQualityGate(report, policy).status, "allow");
	assert.equal(evaluateQualityGate(report, {}).status, "evidence_insufficient");
	assert.equal(evaluateQualityGate(report, null).status, "evidence_insufficient");
	assert.equal(evaluateQualityGate(report, policy).performance_hints.gating, false);
	assert.equal(
		validateQualityPolicy({ ...policy, thresholds: [{ ...policy.thresholds[0], minimum_pass_rate: 2 }] }).valid,
		false,
	);
	report.checks!.process.applicable = 0;
	assert.equal(evaluateQualityGate(report, policy).status, "evidence_insufficient");
});

test("政策漏列严重违规不能放行，未知评分和不完整报告不能发正式质量结论", () => {
	const { policy, report } = releaseFixture();
	report.checks!.custom_safety = { applicable: 1, passed: 0, failed: 1, unevaluated: 0, severity: "critical" };
	assert.equal(evaluateQualityGate(report, policy).status, "deny");
	assert.equal(evaluateQualityGate(report, {}).status, "deny");
	delete report.checks!.custom_safety;
	assert.equal(evaluateQualityGate({ ...report, status: "incomplete" }, policy).status, "evidence_insufficient");
	assert.equal(evaluateQualityGate(report, { ...policy, severe_checks: [] }).status, "evidence_insufficient");
});

test("冻结不退化政策要求可比基线并逐轨道检查，不能仅看绝对达标", () => {
	const { policy, report } = releaseFixture();
	policy.baseline_non_regression = {
		baseline_score_set_id: "baseline1",
		tracks: [{ track: "facts", maximum_regression: 0 }],
	};
	assert.equal(evaluateQualityGate(report, policy).status, "evidence_insufficient");
	const baseline = { ...report, score_set_id: "baseline1", comparable: true };
	assert.equal(evaluateQualityGate(report, policy, baseline).status, "allow");
	assert.equal(evaluateQualityGate(report, policy, { ...baseline, comparable: false }).status, "evidence_insufficient");
	assert.equal(
		evaluateQualityGate(report, policy, {
			...baseline,
			tracks: { facts: { ...report.tracks.facts, numerator: 10, value: 1 } },
		}).status,
		"deny",
	);
});

test("重评产生不可变新 score set，人工裁定需要证据且影响全部关联变体", () => {
	const old = createScoreSet({ dataset_hash: "d", observation_hash: "o", gold_hash: "g", scores: [syntheticScore()] });
	const updated = createScoreSet({
		dataset_hash: "d",
		observation_hash: "o",
		gold_hash: "g2",
		parent_score_set_id: old.id,
		scores: [syntheticScore("fail")],
	});
	assert.notEqual(old.id, updated.id);
	assert.equal(old.scores[0].status, "pass");
	assert.equal(Object.isFrozen(old.scores), true);
	const decision = {
		score_set_id: old.id,
		check_ids: ["result"],
		case_ids: ["q1"],
		reviewer: "reviewer",
		reason: "修订标准答案",
		evidence_refs: ["independent-oracle"],
		revised_gold_hash: contentHash({ n: 8 }),
		affected_variant_ids: ["off", "on", "retry"],
		created_at: "2026-10-19T12:00:00Z",
	};
	assert.equal(createAdjudication(decision).requires_rescore_all_affected, true);
	assert.throws(() => createAdjudication({ ...decision, evidence_refs: [] }), /invalid_adjudication/);
});
