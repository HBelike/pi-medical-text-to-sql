import assert from "node:assert/strict";
import test from "node:test";
import type { Application } from "../src/application.ts";
import { evaluationHttp } from "../src/evaluation/http.ts";

// 只验证控制接口契约，替身没有模型或任务执行能力，避免路由回归测试产生外部请求。
function application() {
	const calls: unknown[][] = [];
	const app = {
		config: { decisionModel: "decision-model", answerModel: "answer-model" },
		evaluation: {
			listExperiments: (...args: unknown[]) => {
				calls.push(["experiments", ...args]);
				return { items: [], total: 0, running_total: 0, page: args[0], page_size: args[1] };
			},
			overview: (...args: unknown[]) => {
				calls.push(["overview", ...args]);
				return { experiment_id: args[0] };
			},
			questions: (...args: unknown[]) => {
				calls.push(["questions", ...args]);
				return { items: [], total: 0, page: args[1], page_size: args[2] };
			},
			list: (...args: unknown[]) => {
				calls.push(args);
				return { items: [], total: 0, page: args[1], page_size: args[2] };
			},
			slots: (...args: unknown[]) => {
				calls.push(args);
				return { items: [], total: 0 };
			},
			store: {
				get: () => {
					throw new Error("unexpected_detail_fallback");
				},
			},
		},
	} as unknown as Application;
	return { app, calls };
}

// 新评测表单读取模型默认值时不扫描历史任务，避免大账本造成内存峰值。
test("评测配置只返回当前模型名称", async () => {
	const { app, calls } = application();
	const config = await evaluationHttp("GET", new URL("http://localhost/api/eval/config"), {}, app);
	assert.deepEqual(config?.value, { model: "decision-model", answer_model: "answer-model" });
	assert.deepEqual(calls, []);
});

test("实验评分、评分任务和激活过滤在分页前传给服务", async () => {
	const { app, calls } = application();
	await evaluationHttp(
		"GET",
		new URL("http://localhost/api/eval/experiments/e1/score-sets?page=2&page_size=10"),
		{},
		app,
	);
	await evaluationHttp("GET", new URL("http://localhost/api/eval/experiments/e1/score-jobs"), {}, app);
	await evaluationHttp("GET", new URL("http://localhost/api/eval/activations?release_decision_id=r1"), {}, app);
	assert.deepEqual(calls, [
		["score_set", 2, 10, { field: "experiment_id", value: "e1" }],
		["score_job", 1, 25, { field: "experiment_id", value: "e1" }],
		["activation", 1, 25, { field: "release_decision_id", value: "r1" }],
	]);
});

test("未知子路由不会返回已有对象，非法分页不进入查询", async () => {
	const { app, calls } = application();
	for (const path of [
		"datasets/existing/unknown",
		"slots/existing/unknown",
		"experiments/existing/score-sets/extra",
		"datasets/escaped%2Fid",
		"__proto__",
		"constructor/existing",
	]) {
		await assert.rejects(evaluationHttp("GET", new URL(`http://localhost/api/eval/${path}`), {}, app), /接口不存在/);
	}
	for (const page of ["0", "-1", "1.5", "NaN", ""])
		await assert.rejects(
			evaluationHttp("GET", new URL(`http://localhost/api/eval/datasets?page=${page}`), {}, app),
			/合法整数/,
		);
	assert.equal(calls.length, 0);
	assert.equal(await evaluationHttp("GET", new URL("http://localhost/api/other"), {}, app), undefined);
});

test("逐题筛选原样交给服务端，页大小受统一上限控制", async () => {
	const { app, calls } = application();
	await evaluationHttp(
		"GET",
		new URL("http://localhost/api/eval/experiments/e1/slots?page_size=1000&status=failed&q=metric-1"),
		{},
		app,
	);
	assert.deepEqual(calls, [["e1", 1, 100, "failed", "metric-1"]]);
});

// 新评测筛选必须由服务端对全集处理，路由只负责参数与统一分页上限。
test("新评测列表、汇总和逐题查询进入各自的只读入口", async () => {
	const { app, calls } = application();
	const experiments = await evaluationHttp(
		"GET",
		new URL("http://localhost/api/eval/experiments?page=2&page_size=200&q=名称&dataset_id=d1&model=deepseek"),
		{},
		app,
	);
	const overview = await evaluationHttp("GET", new URL("http://localhost/api/eval/experiments/e1/overview"), {}, app);
	const questions = await evaluationHttp(
		"GET",
		new URL("http://localhost/api/eval/experiments/e1/questions?page=3&page_size=12&verdict=fail&q=病例"),
		{},
		app,
	);
	assert.equal((experiments?.value as { running_total: number }).running_total, 0);
	assert.equal((overview?.value as { experiment_id: string }).experiment_id, "e1");
	assert.equal((questions?.value as { page: number }).page, 3);
	assert.deepEqual(calls, [
		["experiments", 2, 100, "名称", "d1", "deepseek"],
		["overview", "e1"],
		["questions", "e1", 3, 12, "fail", "病例"],
	]);
});

// 旧版调用账本展开应按 id 取回完整证据，不能退化为全量列表内查找。
test("单条调用详情按 ID 返回完整记录", async () => {
	const calls: string[] = [];
	const app = {
		runtime: {
			getOperation: async (id: string) => {
				calls.push(id);
				return { id, status: "unknown", input: { prompt: "完整提示词" }, receipt: { token: 12 } };
			},
			listOperations: async () => {
				throw new Error("详情不能扫描操作全集");
			},
		},
	} as unknown as Application;
	const detail = await evaluationHttp("GET", new URL("http://localhost/api/eval/operations/call-1"), {}, app);
	assert.deepEqual(calls, ["call-1"]);
	assert.deepEqual(detail?.value, {
		id: "call-1",
		status: "unknown",
		input: { prompt: "完整提示词" },
		receipt: { token: 12 },
	});
});

// 百表提示词较大，状态轮询与全局列表不能随历史增长重复传输完整模型正文。
test("状态与全局调用列表只传索引，分页后按单轮读取正文", async () => {
	const operations = Array.from({ length: 120 }, (_, index) => ({
		id: String(index),
		status: index < 110 ? "unknown" : "succeeded",
		scope: { experiment_id: "e" },
		input: { system_prompt: "large-private-prompt" },
		receipt: { output: "large-output" },
	}));
	let listCalls = 0;
	const app = {
		evaluation: { store: { capacity: () => ({}) } },
		runtime: {
			stats: async () => ({}),
			operationStatusSummary: async () => ({
				operation_counts: { unknown: 110, succeeded: 10 },
				operations: operations
					.slice(0, 100)
					.map(({ id, status, scope }) => ({ id, status, experiment_id: scope.experiment_id })),
				unknown_total: 110,
			}),
			pageOperations: async (page: number, pageSize: number, wanted?: string) => {
				const filtered = operations.filter((entry) => !wanted || entry.status === wanted);
				return {
					items: filtered.slice((page - 1) * pageSize, page * pageSize).map(({ id, status }) => ({ id, status })),
					total: filtered.length,
					page,
					page_size: pageSize,
				};
			},
			listOperations: async (turn?: string) => {
				listCalls++;
				if (!turn) throw new Error("全局操作分页不应克隆完整正文");
				return operations.slice(0, 1);
			},
		},
		models: { pool: { stats: () => ({}) } },
	} as unknown as Application;
	const status = (await evaluationHttp("GET", new URL("http://localhost/api/eval/status"), {}, app))!.value as {
		operations: unknown[];
		unknown_total: number;
		operation_counts: Record<string, number>;
	};
	assert.equal(status.unknown_total, 110);
	assert.equal(status.operations.length, 100);
	assert.deepEqual(status.operation_counts, { unknown: 110, succeeded: 10 });
	assert.equal(JSON.stringify(status).includes("large-private-prompt"), false);
	assert.equal(listCalls, 0, "状态页不应读取完整调用列表");
	const page = (await evaluationHttp(
		"GET",
		new URL("http://localhost/api/eval/operations?page=2&page_size=10&status=unknown"),
		{},
		app,
	))!.value as { items: { id: string }[]; total: number };
	assert.equal(page.total, 110);
	assert.equal(page.items.length, 10);
	assert.equal(page.items[0].id, "10");
	assert.equal(JSON.stringify(page).includes("large-private-prompt"), false);
	assert.equal(listCalls, 0, "全局分页不应读取完整调用列表");
	const detail = await evaluationHttp("GET", new URL("http://localhost/api/eval/operations?turn_id=one"), {}, app);
	assert.equal(JSON.stringify(detail).includes("large-private-prompt"), true);
});
