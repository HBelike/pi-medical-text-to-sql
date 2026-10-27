import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseDataset } from "../src/evaluation/datasets.ts";
import { compareResults, resultArtifactContentHash, scoreCase } from "../src/evaluation/scoring.ts";

// 以最后一行异值验证完整产物评分，不能靠前 200 行预览取得正确答案。
function fixture() {
	const question = {
		id: "large",
		source_id: "facts",
		question: "列出全部控制序号",
		as_of: "2026-10-15T12:00:00+08:00",
	};
	const rows = Array.from({ length: 301 }, (_, index) => [index]);
	const sample = parseDataset({
		questionsJsonl: JSON.stringify(question),
		goldJsonl: JSON.stringify({
			...question,
			category: "synthetic_fact_query",
			family_id: "all-rows",
			split: "dev",
			expected_action: "answer",
			expected_rows: rows.map(([n]) => ({ n })),
		}),
	}).cases[0];
	const result = {
		columns: ["n"],
		rows,
		row_count: 301,
		total: 301,
		complete: true,
		truncated: false,
		preview_rows: rows.slice(0, 200),
		preview_row_count: 200,
		preview_truncated: true,
		hash_algorithm: "medical-query-result/v1",
		result_content_hash: "",
	};
	result.result_content_hash = resultArtifactContentHash(result);
	const resultHash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
	const publication = { id: "pub-large", status: "published", result, result_hash: resultHash };
	return { sample, result, resultHash, publication };
}

test("完整 301 行产物参与结果评分，预览之外的错值不能通过", async () => {
	const { sample, result, publication } = fixture();
	assert.equal((await scoreCase(sample, { status: "completed", result: { publication } })).status, "pass");
	const corrupted = structuredClone(result);
	corrupted.rows[300][0] = 999;
	assert.equal((await scoreCase(sample, { status: "completed", result: corrupted })).status, "fail");
	corrupted.result_content_hash = resultArtifactContentHash(corrupted);
	assert.equal((await scoreCase(sample, { status: "completed", result: corrupted })).status, "fail");
});

test("只有公共预览时标记证据不足，加载匹配指纹的冻结完整产物后可评分", async () => {
	const { sample, result, publication, resultHash } = fixture();
	const preview = { ...result, rows: result.preview_rows, preview: true };
	const observed = { status: "completed", publication: { ...publication, result: preview } };
	const unavailable = await scoreCase(sample, observed);
	assert.equal(unavailable.status, "unknown");
	assert.equal(unavailable.evaluation_status, "evidence_unavailable");
	assert.equal(
		(await scoreCase(sample, observed, { artifacts: { full_results: { [resultHash]: result } } })).status,
		"pass",
	);
	const corrupted = { ...result, rows: [[999]] };
	assert.equal(
		(await scoreCase(sample, observed, { artifacts: { full_results: { [resultHash]: corrupted } } })).evaluation_status,
		"evaluator_error",
	);
});

test("评分器不接受路径和 URL 代替完整产物，不从预览推算总量", async () => {
	const { sample, publication, result } = fixture();
	const observed = {
		status: "completed",
		publication: {
			...publication,
			result: {
				...result,
				rows: result.preview_rows,
				preview: true,
				path: "/not-a-trusted-artifact",
				url: "https://invalid.example/result",
			},
		},
	};
	assert.equal(
		(await scoreCase(sample, observed, { artifacts: { path: "/not-a-trusted-artifact" } })).evaluation_status,
		"evidence_unavailable",
	);
	assert.equal(
		(
			await scoreCase(sample, {
				status: "completed",
				result: { ...result, complete: false, truncated: true, total: null },
			})
		).status,
		"fail",
	);
});

test("内容身份约束数字、类型、Unicode和完整性，空集仍可核验", () => {
	const result = { columns: ["值"], rows: [[-0], ["中文🙂"], [null]], complete: true, truncated: false };
	assert.equal(
		resultArtifactContentHash(result),
		resultArtifactContentHash({ ...result, rows: [[0], ["中文🙂"], [null]] }),
	);
	assert.notEqual(
		resultArtifactContentHash(result),
		resultArtifactContentHash({ ...result, rows: [["0"], ["中文🙂"], [null]] }),
	);
	assert.notEqual(
		resultArtifactContentHash(result),
		resultArtifactContentHash({ ...result, complete: false, truncated: true }),
	);
	assert.throws(() => resultArtifactContentHash({ ...result, rows: [[Number.MAX_SAFE_INTEGER + 1]] }), /cell/);
	assert.equal(resultArtifactContentHash({ ...result, rows: [] }).length, 64);
});

test("默认完整行预算内的 5000 行精确多重集保持重复计数", () => {
	const rows = Array.from({ length: 5000 }, (_, index) => [Math.floor(index / 2)]);
	const gold = { expected_rows: rows.map(([n]) => ({ n })) };
	const result = { columns: ["n"], rows: [...rows].reverse(), row_count: 5000, complete: true, truncated: false };
	assert.equal(compareResults({ status: "completed", result }, gold).passed, true);
	result.rows[4999] = [9999];
	assert.equal(compareResults({ status: "completed", result }, gold).passed, false);
});
