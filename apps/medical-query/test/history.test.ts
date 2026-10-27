import assert from "node:assert/strict";
import { test } from "node:test";
import { historyItem, historyPage, parseHistoryQuery } from "../src/history.ts";
import { type JsonObject, type QueryTask, RuntimeError } from "../src/runtime.ts";

// 离线构造已持久化任务，不打开真实业务库、不读取模型配置，也不触发任何模型调用。
function task(id: string, overrides: Partial<QueryTask> = {}): QueryTask {
	return {
		id,
		turnId: id,
		conversationId: `conversation-${id}`,
		requestId: `request-${id}`,
		question: `原始问题 ${id}`,
		context: { source_id: "hospital-a" },
		status: "completed",
		runId: "run-current",
		replies: [],
		createdAt: Date.parse("2026-10-16T00:00:00Z"),
		updatedAt: Date.parse("2026-10-16T00:01:00Z"),
		queuedAt: Date.parse("2026-10-16T00:00:00Z"),
		queueDeadlineAt: Date.parse("2026-10-16T00:05:00Z"),
		clarificationRevision: 0,
		...overrides,
	};
}

// 成功SQL与同段目录一起作为查询表证据；候选含未执行表，用于验证两类含义不会混淆。
function executionPayload(): JsonObject {
	return {
		answer: "本次查询返回 1 行。\n第 1 行 count：3",
		evidence: { linking: { tables: ["patients", "unused_candidate"] } },
		stages: [
			{
				kind: "catalog",
				status: "completed",
				run_id: "run-current",
				data: {
					catalog: { relations: [{ id: "visits_patient", left_table: "visits", right_table: "patients" }] },
				},
			},
			{
				kind: "execution",
				status: "completed",
				run_id: "run-current",
				data: {
					dsl: { from: "visits", joins: [{ relation: "visits_patient", type: "inner" }] },
					result: { sql: "SELECT COUNT(*) FROM visits JOIN patients ON visits.patient_id=patients.patient_id" },
				},
			},
		],
	};
}

test("执行成功仅返回实际DSL表，候选表不冒充已查询表", () => {
	const original = task("executed", { result: executionPayload() });
	const snapshot = structuredClone(original);
	const item = historyItem(original);
	assert.deepEqual(item.tables, ["visits", "patients"]);
	assert.equal(item.table_kind, "queried");
	assert.equal(item.answer, "本次查询返回 1 行。\n第 1 行 count：3");
	assert.deepEqual(original, snapshot);
});

test("执行失败及计划尚未执行时只能展示候选表", () => {
	for (const status of ["failed", "running"]) {
		const item = historyItem(
			task(`not-executed-${status}`, {
				status: "failed",
				progress: {
					linking: { tables: ["patients", "patients", "unused_candidate"] },
					stages: [{ kind: "execution", status, data: { dsl: { from: "visits" } } }],
				},
			}),
		);
		assert.equal(item.table_kind, "matched");
		assert.deepEqual(item.tables, ["patients", "unused_candidate"]);
	}
});

test("目录关系不足不能把不完整的JOIN表集合标成已查询", () => {
	const payload = executionPayload();
	payload.stages = (payload.stages as JsonObject[]).filter((stage) => stage.kind !== "catalog");
	const item = historyItem(task("missing-relation", { result: payload }));
	assert.equal(item.table_kind, "matched");
	assert.deepEqual(item.tables, ["patients", "unused_candidate"]);
});

test("追问不同运行段的目录关系不会串入已执行表", () => {
	const payload = executionPayload();
	(payload.stages as JsonObject[]).push({
		kind: "catalog",
		status: "completed",
		run_id: "another-run",
		data: { catalog: { relations: [{ id: "visits_patient", left_table: "wrong_left", right_table: "wrong_right" }] } },
	});
	assert.deepEqual(historyItem(task("isolated-run", { result: payload })).tables, ["visits", "patients"]);
});

test("旧记录有真实结果及单表DSL时保留执行事实，无证据时不猜表", () => {
	const item = historyItem(
		task("old-executed", {
			result: { result: { sql: "SELECT COUNT(*) FROM patients" }, evidence: { dsl: { from: "patients" } } },
		}),
	);
	assert.equal(item.table_kind, "queried");
	assert.deepEqual(item.tables, ["patients"]);
	assert.equal(historyItem(task("no-evidence")).table_kind, "none");
	assert.deepEqual(historyItem(task("no-evidence")).tables, []);
});

test("答案阶段失败仍保留真实执行表，错误与答案分字段", () => {
	const item = historyItem(
		task("answer-failed", {
			status: "failed",
			progress: executionPayload(),
			error: { code: "answer_failed", message: "数据已取得，结果说明生成失败" },
		}),
	);
	assert.equal(item.table_kind, "queried");
	assert.equal(item.answer, null);
	assert.equal(item.error, "数据已取得，结果说明生成失败");
	assert.equal(item.status_label, "失败");
});

test("L0匹配终态保留未计算含义，不将模拟绑定当查询表", () => {
	const item = historyItem(
		task("l0", {
			status: "blocked",
			result: {
				answer: "已记录匹配边界，未执行SQL。",
				evidence: { profile: "l0_schema_linking", match_status: "matched", linking: { tables: ["mock_visits"] } },
			},
		}),
	);
	assert.equal(item.table_kind, "matched");
	assert.deepEqual(item.tables, ["mock_visits"]);
	assert.equal(item.status_label, "匹配完成 · 尚不可计算");
	assert.equal(item.answer, "已记录匹配边界，未执行SQL。");
	const unmatched = historyItem(
		task("l0-no-match", {
			status: "blocked",
			result: { evidence: { profile: "l0_schema_linking", match_status: "no_match", linking: { tables: [] } } },
		}),
	);
	assert.equal(unmatched.status_label, "未找到匹配指标");
	assert.equal(unmatched.table_kind, "none");
});

test("L0已完成匹配但后续失败时从真实阶段保留候选表", () => {
	const item = historyItem(
		task("l0-partial", {
			status: "failed",
			progress: {
				stages: [{ kind: "decision", status: "completed", data: { metric_ids: ["M0001"], tables: ["mock_visits"] } }],
			},
		}),
	);
	assert.equal(item.table_kind, "matched");
	assert.deepEqual(item.tables, ["mock_visits"]);
});

test("每次调用保留真实环节和状态，旧usage不重复也不伪造模型", () => {
	const item = historyItem(
		task("models", {
			result: {
				model_calls: [
					{ id: "identify", model: "actual-model", status: "completed", system_prompt: "私有提示词" },
					{ id: "link", model: "actual-model", status: "failed", output_text: "原始输出" },
				],
				usage: [
					{ model: "legacy-model" },
					{ id: "identify", model: "actual-model" },
					{ id: "link", model: "actual-model" },
				],
				stages: [
					{ model_call_id: "identify", label: "识别医疗指标" },
					{ model_call_id: "link", label: "匹配字段、关系与规则缺口" },
				],
			},
		}),
	);
	assert.deepEqual(item.models, [
		{ id: null, stage: "历史调用（环节未记录）", model: "legacy-model", status: "unrecorded" },
		{ id: "identify", stage: "识别医疗指标", model: "actual-model", status: "completed" },
		{ id: "link", stage: "匹配字段、关系与规则缺口", model: "actual-model", status: "failed" },
	]);
	assert.equal(JSON.stringify(item).includes("私有提示词"), false);
	assert.equal(JSON.stringify(item).includes("原始输出"), false);
	assert.deepEqual(historyItem(task("before-model", { status: "failed" })).models, []);
});

test("当前澄清与最终业务答案分开，恢复后不显示过期追问", () => {
	const clarification = { id: "clarify", revision: 1, question: "按哪个月份统计？" };
	const waiting = historyItem(task("waiting", { status: "waiting_for_user", clarification }));
	assert.equal(waiting.clarification, clarification.question);
	assert.equal(waiting.answer, null);
	const complete = historyItem(task("replied", { clarification, result: { answer: "完整答案\n".repeat(1000) } }));
	assert.equal(complete.clarification, null);
	assert.equal(complete.answer, "完整答案\n".repeat(1000));
});

// 跨会话集合包含在线与评测任务；组合筛选与facet必须基于真实历史，不依赖当前模型配置。
const histories = [
	task("a", {
		question: "统计 ABC%_ 的人数",
		context: { source_id: "hospital-a", mode: "online" },
		result: { model_calls: [{ id: "call-a", model: "model-a", status: "completed" }] },
	}),
	task("b", {
		question: "统计 abcXY 的人数",
		status: "failed",
		createdAt: Date.parse("2026-10-17T00:00:00Z"),
		context: { source_id: "hospital-b", mode: "eval" },
		progress: { usage: [{ model: "model-b" }] },
		error: { code: "failed", message: "受控失败" },
	}),
	task("c", {
		question: "统计 abc%_ 的次数",
		status: "blocked",
		createdAt: Date.parse("2026-10-18T00:00:00Z"),
		context: { source_id: "hospital-a" },
		result: { model_calls: [{ id: "call-c", model: "model-a", status: "completed" }] },
	}),
];

test("跨会话历史保留评测记录，问题搜索大小写无关且%_按字面匹配", () => {
	const all = historyPage(histories, new URLSearchParams());
	assert.equal(all.total, 3);
	assert.deepEqual(
		all.items.map((item) => item.id),
		["c", "b", "a"],
	);
	assert.equal(all.items[1].mode, "eval");
	assert.deepEqual(
		historyPage(histories, new URLSearchParams({ q: "abc%_" })).items.map((item) => item.id),
		["c", "a"],
	);
	assert.equal(historyPage(histories, new URLSearchParams({ q: "ABC" })).total, 3);
});

test("模型精确匹配，状态来源和时间按交集筛选，时间下限包含边界", () => {
	const page = historyPage(
		histories,
		new URLSearchParams({
			model: "model-a",
			status: "completed",
			source_id: "hospital-a",
			since: "2026-10-16T08:00:00+08:00",
		}),
	);
	assert.deepEqual(
		page.items.map((item) => item.id),
		["a"],
	);
	assert.equal(historyPage(histories, new URLSearchParams({ model: "MODEL-A" })).total, 0);
	assert.equal(historyPage(histories, new URLSearchParams({ model: "model" })).total, 0);
	assert.equal(historyPage(histories, new URLSearchParams({ since: "2026-10-16T00:00:00.001Z" })).total, 2);
});

test("facet保持全量历史可选值，不受当前页或筛选结果缩减", () => {
	const page = historyPage(histories, new URLSearchParams({ status: "completed", page_size: "1" }));
	assert.deepEqual(page.facets.models, ["model-a", "model-b"]);
	assert.deepEqual(page.facets.sources, ["hospital-a", "hospital-b"]);
	// 外部调用未知必须可独立筛选，不能被混入普通失败或从facet遗漏。
	assert.equal(page.facets.statuses.length, 9);
	assert.equal(
		page.facets.statuses.find((status) => status.value === "reconciliation_required")?.label,
		"调用结果未知 · 需要对账",
	);
	assert.equal(page.facets.statuses.find((status) => status.value === "blocked")?.label, "无法执行 / 尚不可计算");
});

test("分页稳定按创建时间和ID降序，越界页回到末页且空集为第一页", () => {
	const input = [task("a"), task("c"), task("b")];
	const snapshot = structuredClone(input);
	const page = historyPage(input, new URLSearchParams({ page: "999", page_size: "2" }));
	assert.equal(page.total, 3);
	assert.equal(page.page, 2);
	assert.equal(page.page_size, 2);
	assert.deepEqual(
		page.items.map((item) => item.id),
		["a"],
	);
	assert.deepEqual(
		historyPage(input, new URLSearchParams({ page_size: "2" })).items.map((item) => item.id),
		["c", "b"],
	);
	assert.deepEqual(input, snapshot);
	const empty = historyPage([], new URLSearchParams({ page: String(Number.MAX_SAFE_INTEGER) }));
	assert.equal(empty.page, 1);
	assert.equal(empty.total, 0);
	assert.equal(empty.page_size, 10);
	assert.deepEqual(empty.items, []);
	assert.equal(parseHistoryQuery(new URLSearchParams({ page_size: "100" })).pageSize, 100);
});

test("非法重复筛选参数、状态和分页均返回明确400错误", () => {
	const invalid = [
		new URLSearchParams({ unknown: "value" }),
		new URLSearchParams("q=a&q=b"),
		new URLSearchParams({ status: "success" }),
		new URLSearchParams({ status: "constructor" }),
		...["0", "-1", "1.5", "1e2", "", " 1", "01", String(Number.MAX_SAFE_INTEGER + 1)].map(
			(page) => new URLSearchParams({ page }),
		),
		new URLSearchParams({ page_size: "101" }),
		new URLSearchParams({ q: "a".repeat(4001) }),
		new URLSearchParams({ model: "a".repeat(257) }),
		new URLSearchParams({ source_id: "a".repeat(129) }),
	];
	for (const params of invalid) {
		assert.throws(
			() => parseHistoryQuery(params),
			(error) => error instanceof RuntimeError && error.statusCode === 400,
		);
	}
});

test("时间必须为有效带时区ISO值，拒绝日历滚动和不合法时间", () => {
	for (const since of [
		"2026-10-16",
		"2026-10-16T00:00:00",
		"2026-02-30T00:00:00Z",
		"2026-13-01T00:00:00Z",
		"2026-10-16T24:00:00Z",
		"2026-10-16T00:60:00Z",
		"2026-10-16T00:00:60Z",
		"2026-10-16T00:00:00+25:00",
		"invalid",
	]) {
		assert.throws(
			() => parseHistoryQuery(new URLSearchParams({ since })),
			(error) => error instanceof RuntimeError && error.statusCode === 400,
		);
	}
	assert.equal(
		parseHistoryQuery(new URLSearchParams({ since: "2024-02-29T00:00:00Z" })).since,
		Date.parse("2024-02-29T00:00:00Z"),
	);
});
