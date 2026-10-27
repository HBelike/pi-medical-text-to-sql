import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpClient, parseArgs, sameSourceVersions, typedRowsEqual } from "../src/evaluate.ts";

// 只调用评测器纯函数，不读取配置或标准答案，也不启动模型请求。
test("评测默认限制为串行三题", () => {
	assert.deepEqual(parseArgs([]), { concurrency: 1, limit: 3, help: false, standalone: false });
});

test("显式并发十和零题限制选择全部用例", () => {
	assert.deepEqual(parseArgs(["--concurrency", "10", "--limit", "0"]), {
		concurrency: 10,
		limit: 0,
		help: false,
		standalone: false,
	});
});

test("基线模式必须显式选择", () => {
	assert.equal(parseArgs(["--standalone"]).standalone, true);
});

// 注入本地响应替身，验证复用服务协议及 eval 标记，不连接真实模型或服务。
test("共享服务适配器保留评测上下文并使用查询、轮询、取消和状态接口", async () => {
	const requests: { path: string; method?: string; body?: unknown }[] = [];
	const client = createHttpClient("http://127.0.0.1:8787", async (input, init) => {
		const path = new URL(String(input)).pathname;
		requests.push({
			path,
			method: init?.method,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		return new Response(
			JSON.stringify(path === "/api/status" ? { limits: { llm: 5 } } : { id: "turn1", status: "queued" }),
		);
	});
	const input = {
		conversation_id: "isolated-case",
		source_id: "hospital-a",
		question: "测试",
		request_id: "request1",
		mode: "eval" as const,
		as_of: "2026-10-15",
	};
	await client.query(input);
	await client.get("turn1");
	await client.cancel("turn1");
	await client.status();
	assert.deepEqual(
		requests.map((item) => [item.path, item.method]),
		[
			["/api/query", "POST"],
			["/api/turns/turn1", "GET"],
			["/api/turns/turn1/cancel", "POST"],
			["/api/status", "GET"],
		],
	);
	assert.deepEqual(requests[0].body, input);
});

test("服务必须覆盖本轮来源且内容指纹一致，缺失或重复身份不能通过", () => {
	const expected = [{ id: "hospital-a", fingerprint: "frozen" }];
	assert.equal(sameSourceVersions(expected, [...expected, { id: "other", fingerprint: "unused" }]), true);
	assert.equal(sameSourceVersions(expected, [{ id: "hospital-a", fingerprint: "changed" }]), false);
	assert.equal(sameSourceVersions(expected, undefined), false);
	assert.equal(sameSourceVersions(expected, []), false);
	assert.equal(sameSourceVersions(expected, [...expected, ...expected]), false);
});

test("评测拒绝非约定并发", () => {
	assert.throws(() => parseArgs(["--concurrency", "2"]), /并发/);
});

test("评测拒绝负题数", () => {
	assert.throws(() => parseArgs(["--limit", "-1"]), /非负/);
});

test("评测拒绝缺少参数值", () => {
	assert.throws(() => parseArgs(["--limit"]), /缺少/);
});

test("评测拒绝未知参数", () => {
	assert.throws(() => parseArgs(["--unexpected"]), /未知/);
});

// SQL 等价结果允许行序不同，但不能抹平类型、重复行、NULL 或列角色差异。
test("结果比较允许行顺序不同", () => {
	assert.equal(
		typedRowsEqual(
			[
				["甲", 1],
				["乙", null],
			],
			[
				["乙", null],
				["甲", 1],
			],
		),
		true,
	);
});

test("结果比较区分数字和字符串", () => {
	assert.equal(typedRowsEqual([[1]], [["1"]]), false);
});

test("结果比较区分 NULL 和文字 null", () => {
	assert.equal(typedRowsEqual([[null]], [["null"]]), false);
});

test("结果比较保留重复行数量", () => {
	assert.equal(typedRowsEqual([[1], [1]], [[1]]), false);
});

test("结果比较保持列位置", () => {
	assert.equal(typedRowsEqual([[1, 2]], [[2, 1]]), false);
});

test("合法空结果可与空标准答案匹配", () => {
	assert.equal(typedRowsEqual([], []), true);
});

test("缺失结果不能冒充合法空结果", () => {
	assert.equal(typedRowsEqual(undefined, []), false);
});
