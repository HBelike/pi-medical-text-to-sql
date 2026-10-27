import assert from "node:assert/strict";
import { test } from "node:test";
import { contentHash, parseDataset } from "../src/evaluation/datasets.ts";
import {
	compareResults,
	createAdjudication,
	createScoreSet,
	type EvaluationTurn,
	resultArtifactContentHash,
	scoreCase,
} from "../src/evaluation/scoring.ts";

// 独立手写契约和数值，不从真实实验观察反向添加别名；旧协议与新协议在同一观察上分别留痕。
const question = { id: "q-v2", source_id: "facts", question: "有几次就诊？", as_of: "2026-10-21T00:00:00Z" };
function dataset(gold: Record<string, unknown>) {
	return parseDataset({
		questionsJsonl: JSON.stringify(question),
		goldJsonl: JSON.stringify({
			...question,
			family_id: "count-visits",
			split: "dev",
			category: "synthetic_fact_query",
			expected_action: "answer",
			...gold,
		}),
	});
}
function single(rows: Record<string, unknown>[] = [{ visits: 7 }], ordered = false) {
	return {
		expected_rows: rows,
		comparison: {
			contract_version: "comparison/v2",
			column_names: "single_value",
			row_order: ordered ? "ordered" : "unordered_multiset",
			numeric_tolerance: 0,
			null_is_zero: false,
		},
		result_contract: { columns: ["visits"], column_settings: { visits: { type: "integer" } } },
	};
}
function observed(
	rows: unknown[] = [[7]],
	columns: unknown = ["observed_count"],
	extra: Record<string, unknown> = {},
): EvaluationTurn {
	return {
		status: "completed",
		result: { columns, rows, row_count: rows.length, complete: true, truncated: false, ...extra },
	};
}
function clarificationContract() {
	const vocabulary = {
		id: "unit-test-business-concepts/v1",
		version: "clarification-vocabulary/v1",
		review_status: "approved",
		reviewer: "test-fixture-author",
		reason: "手写业务概念用于契约回归；不代表正式医院词表审核",
		source_refs: ["fixture:declared-business-concepts"],
		concepts: [
			{ id: "metric", definition: "明确希望统计的业务指标", aliases: ["统计指标", "统计对象或指标"] },
			{ id: "department", definition: "明确科室限定条件", aliases: ["科室", "科室名称"] },
			{ id: "time_window", definition: "明确统计起止范围", aliases: ["统计区间", "统计周期"] },
			{ id: "population", definition: "明确目标人群", aliases: ["目标人群"] },
		],
	};
	return {
		version: "clarification/v2",
		vocabulary_id: vocabulary.id,
		vocabulary_hash: contentHash(vocabulary),
		vocabulary,
		required_concepts: ["metric", "department", "time_window"],
		permitted_extra_concepts: [] as string[],
		matching: "reviewed_exact_aliases",
		normalization: "nfkc_trim",
	};
}
function clarify(slots: unknown, extra: Partial<EvaluationTurn> = {}): EvaluationTurn {
	return { status: "waiting_for_user", clarification: { question: "请明确指标、科室及统计区间。", slots }, ...extra };
}

test("v2 显式启用；旧 exact 与旧别名保持原结果，未知版本/模式/冲突导入前拒绝", async () => {
	const legacy = { expected_rows: [{ visits: 7 }], comparison: { column_names: "exact" } };
	assert.equal(compareResults(observed(), legacy).passed, false);
	assert.equal(compareResults(observed([[7]], ["visits"]), legacy).passed, true);
	assert.equal(
		compareResults(observed(), { ...legacy, result_contract: { aliases: { visits: ["observed_count"] } } }).passed,
		true,
	);
	const good = single();
	for (const comparison of [
		{ ...good.comparison, contract_version: "comparison/v99" },
		{ ...good.comparison, column_names: "guess_columns" },
		{ ...good.comparison, null_is_zero: true },
		{ ...good.comparison, row_order: "set" },
		{ ...good.comparison, numeric_tolerance: -1 },
		{ ...good.comparison, numeric_tolerence: 1 },
		{ column_names: "single_value" },
	])
		assert.throws(() => dataset({ ...good, comparison }), /invalid_gold/);
	for (const override of [
		{ expected_rows: [{ wrong_role: 7 }] },
		{ expected_rows: [{ visits: 7 }, { wrong_role: 8 }] },
		{ expected_columns: ["conflict"] },
		{ expected_rows: [{ visits: "7" }] },
		{ result_contract: { columns: ["visits"], aliases: { visits: ["n"] } } },
		{ result_contract: { columns: ["visits"], column_settings: { visits: { type: "inferred" } } } },
	])
		assert.throws(() => dataset({ ...good, ...override }), /invalid_gold/);
	const bypass = {
		...dataset(good).cases[0],
		gold: { ...good, comparison: { ...good.comparison, column_names: "unknown" } },
	};
	const scored = await scoreCase(bypass, observed());
	assert.equal(scored.status, "unknown");
	assert.equal(scored.evaluation_status, "invalid_gold");
});

test("single_value 只放宽唯一列名；类型、重复数量、顺序、NULL、完整性和产物 hash 均守界", () => {
	const gold = single(),
		input = observed();
	const before = JSON.stringify(input);
	const comparison = compareResults(input, gold);
	assert.equal(comparison.passed, true);
	assert.deepEqual(comparison.details?.role_bindings, { visits: "observed_count" });
	assert.equal(JSON.stringify(input), before);
	for (const wrong of [
		observed([[8]]),
		observed([["7"]]),
		observed([[null]]),
		observed([[7.001]]),
		observed([[7, 7]], ["n", "second"]),
		observed([[7]], ["n"], { complete: false }),
		observed([[7]], ["n"], { truncated: true }),
		observed([[7]], ["n"], { row_count: 2 }),
		observed([{ wrong: 7 }], ["n"]),
		observed([[Number.NaN]]),
		observed([[{}]]),
	])
		assert.equal(compareResults(wrong, gold).passed, false);
	assert.equal(compareResults(observed([[7], [7]]), single([{ visits: 7 }, { visits: 7 }])).passed, true);
	assert.equal(compareResults(observed([[7], [8]]), single([{ visits: 7 }, { visits: 7 }])).passed, false);
	assert.equal(compareResults(observed([[8], [7]]), single([{ visits: 7 }, { visits: 8 }])).passed, true);
	assert.equal(compareResults(observed([[8], [7]]), single([{ visits: 7 }, { visits: 8 }], true)).passed, false);
	assert.equal(compareResults(observed([[null]]), single([{ visits: null }])).passed, true);
	assert.equal(compareResults(observed([[0]]), single([{ visits: null }])).passed, false);
	const result = { ...(input.result as Record<string, unknown>), hash_algorithm: "medical-query-result/v1" };
	const hash = resultArtifactContentHash(result);
	assert.equal(
		compareResults({ status: "completed", result: { ...result, result_content_hash: hash } }, gold).passed,
		true,
	);
	assert.equal(
		compareResults({ status: "completed", result: { ...result, result_content_hash: "a".repeat(64) } }, gold).passed,
		false,
	);
	const decimal = {
		...gold,
		expected_rows: [{ visits: 1.25 }],
		result_contract: {
			columns: ["visits"],
			column_settings: { visits: { type: "decimal", absolute_tolerance: 0.01 } },
		},
	};
	assert.equal(compareResults(observed([[1.255]]), decimal).passed, true);
	assert.equal(compareResults(observed([[1.3]]), decimal).passed, false);
});

test("空结果必须保留双侧角色证据；无 gold 是 invalid，缺实际列是 unknown，多列是真失败", async () => {
	const gold = single([]),
		sample = dataset(gold).cases[0];
	assert.equal((await scoreCase(sample, observed([]))).status, "pass");
	assert.throws(() => dataset({ ...gold, result_contract: {} }), /invalid_gold/);
	assert.throws(() => dataset({ ...gold, result_contract: { columns: [] } }), /invalid_gold/);
	const missing = await scoreCase(sample, { status: "completed", result: { rows: [], row_count: 0, complete: true } });
	assert.equal(missing.status, "unknown");
	assert.equal(missing.evaluation_status, "evidence_unavailable");
	const extra = await scoreCase(sample, observed([], ["a", "b"]));
	assert.equal(extra.status, "fail");
	assert.equal(extra.evaluation_status, "valid");
});

test("多列角色只按预登记别名双射，重复列、别名冲突、值交换不能按位置放行", () => {
	const gold = {
		...single(),
		expected_rows: [{ numerator: 3, denominator: 10 }],
		comparison: { ...single().comparison, column_names: "declared_aliases" },
		result_contract: { columns: ["numerator", "denominator"], aliases: { numerator: ["n"], denominator: ["d"] } },
	};
	dataset(gold);
	assert.equal(compareResults(observed([[10, 3]], ["d", "n"]), gold).passed, true);
	assert.equal(compareResults(observed([[3, 10]], ["d", "n"]), gold).passed, false);
	assert.equal(compareResults(observed([[3, 10]], ["n", "n"]), gold).passed, false);
	assert.equal(compareResults(observed([[3, 10]], ["n", "numerator"]), gold).passed, false);
	assert.equal(compareResults(observed([[3, 10]], ["other", "d"]), gold).passed, false);
	for (const aliases of [
		{ numerator: ["d"], denominator: ["d"] },
		{ numerator: ["denominator"] },
		{ numerator: ["n", "n"] },
	])
		assert.throws(() => dataset({ ...gold, result_contract: { ...gold.result_contract, aliases } }), /invalid_gold/);
	const exact = {
		...gold,
		comparison: { ...gold.comparison, column_names: "exact" },
		result_contract: { columns: gold.result_contract.columns },
	};
	assert.equal(compareResults(observed([[3, 10]], ["n", "d"]), exact).passed, false);
	assert.equal(compareResults(observed([[3, 10]], ["numerator", "denominator"]), exact).passed, true);
});

test("审核概念词表支持固定同义词与 ID，未审核/hash错/歧义/未知/缺项/多问都不放行", async () => {
	const contract = clarificationContract();
	const gold = { expected_action: "clarify", clarification_contract: contract };
	const sample = dataset(gold).cases[0];
	const pass = await scoreCase(sample, clarify([" 统计指标 ", "科室名称", "time_window"]));
	assert.equal(pass.status, "pass");
	assert.equal(
		pass.checks.find((item) => item.check_id === "clarification")?.details?.question_semantics,
		"not_evaluated",
	);
	for (const modified of [
		{ ...contract, vocabulary_hash: "a".repeat(64) },
		{ ...contract, version: "clarification/v99" },
		{ ...contract, vocabulary_id: "other" },
		{ ...contract, matching: "fuzzy" },
		{ ...contract, required_concepts: ["unknown"] },
		{ ...contract, permitted_extra_concepts: ["metric"] },
	])
		assert.throws(() => dataset({ ...gold, clarification_contract: modified }), /invalid_gold/);
	for (const vocabulary of [
		{ ...contract.vocabulary, review_status: "pending" },
		{ ...contract.vocabulary, reviewer: "" },
		{ ...contract.vocabulary, source_refs: [] },
		{
			...contract.vocabulary,
			concepts: [...contract.vocabulary.concepts, { id: "ambiguous", definition: "冲突", aliases: [" 科室 "] }],
		},
		{
			...contract.vocabulary,
			concepts: [
				...contract.vocabulary.concepts,
				{ id: "fullwidth", definition: "NFKC 后冲突", aliases: ["ｍｅｔｒｉｃ"] },
			],
		},
	])
		assert.throws(
			() =>
				dataset({
					...gold,
					clarification_contract: { ...contract, vocabulary, vocabulary_hash: contentHash(vocabulary) },
				}),
			/invalid_gold/,
		);
	assert.throws(() => dataset({ ...gold, required_clarifications: ["统计指标"] }), /invalid_gold/);
	assert.equal((await scoreCase(sample, clarify(["统计指标", "科室", "范围"]))).status, "unknown");
	assert.equal(
		(await scoreCase(sample, clarify(["统计指标", "科室", "未登记的统计周期"]))).evaluation_status,
		"evidence_unavailable",
	);
	assert.equal((await scoreCase(sample, clarify(["统计指标", "科室"]))).status, "fail");
	assert.equal((await scoreCase(sample, clarify(["统计指标", "科室", "统计周期", "目标人群"]))).status, "fail");
	assert.equal((await scoreCase(sample, clarify(["统计指标", "metric", "科室", "统计周期"]))).status, "fail");
	assert.equal(
		(await scoreCase(sample, clarify(["metric", "department", "time_window"], { result: { rows: [[7]] } }))).status,
		"fail",
	);
	const allowed = dataset({
		...gold,
		clarification_contract: { ...contract, permitted_extra_concepts: ["population"] },
	}).cases[0];
	assert.equal(
		(await scoreCase(allowed, clarify(["metric", "department", "time_window", "population"]))).status,
		"pass",
	);
	const legacy = dataset({ expected_action: "clarify", required_clarifications: ["统计指标", "科室", "统计周期"] })
		.cases[0];
	assert.equal((await scoreCase(legacy, clarify(["metric", "department", "time_window"]))).status, "fail");
	assert.equal((await scoreCase(legacy, clarify(["统计指标", "科室", "统计周期"]))).status, "pass");
});

test("修订契约产生新 dataset/gold/score set，旧观察与原失败成绩完整保留并关联裁定范围", async () => {
	const old = dataset({ expected_rows: [{ visits: 7 }], comparison: { column_names: "exact" } }),
		updated = dataset(single());
	const input = observed(),
		frozenObservation = JSON.stringify(input),
		observationHash = contentHash(input);
	const originalScore = await scoreCase(old.cases[0], input),
		newScore = await scoreCase(updated.cases[0], input);
	assert.equal(originalScore.status, "fail");
	assert.equal(newScore.status, "pass");
	assert.notEqual(old.hash, updated.hash);
	assert.notEqual(originalScore.input_hash, newScore.input_hash);
	assert.equal(newScore.checks.find((check) => check.check_id === "result")?.scorer_version, "2.0.0");
	const original = createScoreSet({
		dataset_hash: old.hash,
		observation_hash: observationHash,
		gold_hash: contentHash(old.cases[0].gold),
		scores: [originalScore],
	});
	const next = createScoreSet({
		dataset_hash: updated.hash,
		observation_hash: observationHash,
		gold_hash: contentHash(updated.cases[0].gold),
		parent_score_set_id: original.id,
		scores: [newScore],
	});
	const review = createAdjudication({
		score_set_id: original.id,
		check_ids: ["result"],
		case_ids: [question.id],
		reviewer: "test-fixture-author",
		reason: "题目只要求单一计数，预登记单角色按类型比值；不修改数值和其他语义规则",
		evidence_refs: ["fixture:question-output-role-contract"],
		revised_gold_hash: next.gold_hash,
		affected_variant_ids: ["off", "on", "ordinary"],
		created_at: question.as_of,
	});
	assert.equal(next.parent_score_set_id, original.id);
	assert.notEqual(next.id, original.id);
	assert.equal(original.scores[0].status, "fail");
	assert.equal(Object.isFrozen(original.scores[0]), true);
	assert.equal(next.observation_hash, original.observation_hash);
	assert.equal(JSON.stringify(input), frozenObservation);
	assert.equal(review.requires_rescore_all_affected, true);
});
