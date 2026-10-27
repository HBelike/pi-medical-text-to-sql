import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type LinkingCase,
	linkingQuality,
	loadLinkingSuite,
	parseLinkingArgs,
	relationKey,
	scoreLinking,
} from "../src/l0-evaluate.ts";

// 使用手写小目录验证评分边界，不读取产品输出来生成标准答案，也不调用模型。
const relation = {
	left_table: "visits",
	right_table: "patients",
	pairs: [
		{ left: "org", right: "org" },
		{ left: "patient", right: "id" },
	],
};
const catalog = {
	tables: [
		{ name: "visits", columns: ["org", "patient", "status", "time", "extra"].map((name) => ({ name })) },
		{ name: "patients", columns: ["org", "id"].map((name) => ({ name })) },
	],
	relations: [{ id: "fk:visits:0", ...relation }],
};
const sample: LinkingCase = {
	id: "independent",
	question: "按机构识别就诊指标",
	expected: {
		metric_ids: ["met.sample"],
		tables: ["visits", "patients"],
		fields: ["visits.org", "visits.patient", "visits.status", "visits.time", "patients.org", "patients.id"],
		time_fields: ["visits.time"],
		relations: [relation],
		candidate_relations: [],
		code_filters: [{ field: "visits.status", op: "eq", value: 1 }],
		execution_statuses: [{ metric_id: "met.sample", status: "blocked_engine_and_hospital_mapping" }],
	},
};
const view = () => ({
	status: "blocked",
	evidence: {
		profile: "l0_schema_linking",
		match_status: "matched",
		linking: { ...structuredClone(sample.expected), relations: ["fk:visits:0"] },
		metric_statuses: structuredClone(sample.expected.execution_statuses),
	},
});
const suite = (cases: LinkingCase[] = [sample]) =>
	JSON.stringify({ version: "v1", source_id: "l0_mock", as_of: "2026-10-15", cases });

test("完整匹配与计算阻断必须同时满足", () => {
	assert.equal(scoreLinking(view(), sample, catalog).passed, true);
	assert.equal(scoreLinking({ ...view(), status: "completed" }, sample, catalog).passed, false);
	assert.equal(scoreLinking({ ...view(), result: { rows: [[123]] } }, sample, catalog).passed, false);
});

test("统一拒答不能冒充指标匹配通过", () => {
	const actual = view();
	actual.evidence.linking.metric_ids = [];
	assert.equal(scoreLinking(actual, sample, catalog).passed, false);
});

test("字段遗漏与多余字段分别记录，仅显式允许的附加字段可通过", () => {
	const actual = view();
	actual.evidence.linking.fields.push("visits.extra");
	assert.deepEqual(scoreLinking(actual, sample, catalog).checks.fields.unexpected, ["visits.extra"]);
	assert.equal(scoreLinking(actual, { ...sample, allowed_extra_fields: ["visits.extra"] }, catalog).passed, true);
	actual.evidence.linking.fields = [];
	assert.equal(scoreLinking(actual, sample, catalog).checks.fields.missing.length, 6);
});

test("代码过滤保留数字和字符串的差异", () => {
	const actual = view();
	const changed = { ...actual.evidence.linking, code_filters: [{ field: "visits.status", op: "eq", value: "1" }] };
	assert.equal(
		scoreLinking({ ...actual, evidence: { ...actual.evidence, linking: changed } }, sample, catalog).checks.code_filters
			.passed,
		false,
	);
});

test("复合关系允许反向和换序，遗漏机构键不能通过", () => {
	const reversed = {
		left_table: "patients",
		right_table: "visits",
		pairs: [
			{ left: "id", right: "patient" },
			{ left: "org", right: "org" },
		],
	};
	assert.equal(relationKey(reversed), relationKey(relation));
	const aliasCatalog = { ...catalog, relations: [{ id: "fk:visits:0", ...reversed }] };
	assert.equal(scoreLinking(view(), sample, aliasCatalog).passed, true);
	const incomplete = { ...catalog, relations: [{ id: "fk:visits:0", ...relation, pairs: [relation.pairs[1]] }] };
	assert.equal(scoreLinking(view(), sample, incomplete).checks.relations.passed, false);
});

test("未知运行关系和重复字段不能通过", () => {
	const actual = view();
	actual.evidence.linking.relations = ["rel.unknown"];
	assert.equal(scoreLinking(actual, sample, catalog).checks.relations.passed, false);
	actual.evidence.linking.fields.push("visits.org");
	assert.equal(scoreLinking(actual, sample, catalog).checks.fields.malformed, true);
});

test("无匹配题要求真正空的结构和 no_match 状态", () => {
	const empty: LinkingCase = {
		id: "no-match",
		question: "无此指标",
		expected: {
			metric_ids: [],
			tables: [],
			fields: [],
			time_fields: [],
			relations: [],
			candidate_relations: [],
			code_filters: [],
			execution_statuses: [],
		},
	};
	const actual = {
		status: "blocked",
		evidence: { profile: "l0_schema_linking", match_status: "no_match", linking: empty.expected, metric_statuses: [] },
	};
	assert.equal(scoreLinking(actual, empty, catalog).passed, true);
	assert.equal(
		scoreLinking({ ...actual, evidence: { ...actual.evidence, match_status: "matched" } }, empty, catalog).passed,
		false,
	);
});

test("无效标准答案在调用模型前拒绝，不能算作模型失败或通过", () => {
	assert.equal(
		loadLinkingSuite(suite(), catalog, ["met.sample"], [], [{ field: "visits.status", value: 1 }]).cases.length,
		1,
	);
	assert.throws(() => loadLinkingSuite(suite([sample, sample]), catalog, ["met.sample"], []), /invalid_gold/);
	const bad = structuredClone(sample);
	bad.expected.fields.push("visits.missing");
	assert.throws(() => loadLinkingSuite(suite([bad]), catalog, ["met.sample"], []), /引用不存在/);
	assert.throws(() => loadLinkingSuite(suite(), catalog, [], []), /引用不存在/);
});

test("并发默认五且只能复用服务池", () => {
	assert.equal(parseLinkingArgs([]).concurrency, 5);
	assert.equal(parseLinkingArgs(["--concurrency", "10", "--limit", "0"]).limit, 0);
	assert.throws(() => parseLinkingArgs(["--standalone"]), /不创建第二套/);
	assert.throws(() => parseLinkingArgs(["--concurrency", "11"]), /并发/);
});

// 真实网关 length/timeout 等失败没有 evidence，必须保留失败且让整批报告正常完成。
test("请求失败与缺少记录不会破坏评分汇总", () => {
	const failed = scoreLinking({ status: "failed", error: "模型输出截断" }, sample, catalog);
	assert.equal(failed.passed, false);
	const quality = linkingQuality([scoreLinking(view(), sample, catalog), failed, { passed: false, error: "连接失败" }]);
	assert.deepEqual(quality.all_requirements, { numerator: 1, denominator: 3, value: 1 / 3 });
});

test("无效gold代码在请求前拒绝：操作符、未知值、类型和空值", () => {
	for (const filter of [
		{ field: "visits.status", op: "contains", value: 1 },
		{ field: "visits.status", op: "eq", value: 9 },
		{ field: "visits.status", op: "eq", value: "1" },
		{ field: "visits.time", op: "eq", value: null },
	]) {
		const invalid = { ...sample, expected: { ...sample.expected, code_filters: [filter] } };
		assert.throws(
			() => loadLinkingSuite(suite([invalid]), catalog, ["met.sample"], [], [{ field: "visits.status", value: 1 }]),
			/invalid_gold/,
		);
	}
});
