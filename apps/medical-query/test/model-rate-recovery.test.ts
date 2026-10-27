import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { AppConfig } from "../src/config.ts";
import { ModelGateway, type ModelReceipt } from "../src/model.ts";
import { QueryRuntime } from "../src/runtime.ts";

// 本机 HTTP/SSE 经真实 Pi AI 与 Durable 账本；只改变提供方回执，不读取任何企业凭据。
async function fixture(context: TestContext, overrides: Partial<AppConfig> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-rate-recovery-"));
	const provider = {
		requests: 0,
		status: 200,
		retryAfter: "2",
		usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } as Record<string, number>,
	};
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) {
			/* 消费本机请求，计数以真正到达服务端为准。 */
		}
		provider.requests++;
		if (provider.status !== 200) {
			response.writeHead(provider.status, { "content-type": "application/json", "retry-after": provider.retryAfter });
			response.end(JSON.stringify({ error: { message: "local test rejection" } }));
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(
			`data: ${JSON.stringify({ id: "local-rate", object: "chat.completion.chunk", created: 1, model: "deepseek-test", choices: [{ index: 0, delta: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: provider.usage })}\n\ndata: [DONE]\n\n`,
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const config: AppConfig = {
		apiKey: "local-rate-fixture",
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		decisionModel: "deepseek-test",
		answerModel: "deepseek-test",
		maxActiveRuns: 2,
		llmMaxConcurrency: 2,
		evalMaxActiveRuns: 1,
		maxPending: 10,
		queueWaitTimeoutMs: 100,
		llmTimeoutMs: 3000,
		runTimeoutMs: 5000,
		port: address.port,
		python: "unused",
		dataDir: directory,
		...overrides,
	};
	let gateway = new ModelGateway(config);
	let runtime = await QueryRuntime.open({
		storagePath: join(directory, "runtime.sqlite"),
		onReady: (current) => gateway.attachRuntime(current),
		handler: async () => ({ status: "completed", result: {} }),
	});
	context.after(async () => {
		await runtime.close();
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		await rm(directory, { recursive: true, force: true });
	});
	return {
		provider,
		get gateway() {
			return gateway;
		},
		get runtime() {
			return runtime;
		},
		async restart() {
			await runtime.close();
			gateway = new ModelGateway(config);
			runtime = await QueryRuntime.open({
				storagePath: join(directory, "runtime.sqlite"),
				onReady: (current) => gateway.attachRuntime(current),
				handler: async () => {
					throw new Error("不得自动重发");
				},
			});
		},
		call(receipts: ModelReceipt[] = [], onStart?: () => Promise<void>) {
			return gateway.json("decision", "测试", {}, new AbortController().signal, receipts, 1, onStart, 4096, {
				budget_id: "rate-fixture",
				call_limit: 32,
			});
		},
	};
}

test("TPM 用实际回执结算并跨重启保留，缺失用量不会释放估算", async (context) => {
	const current = await fixture(context, { accountTpm: 5000 });
	const receipts: ModelReceipt[] = [];
	await current.call(receipts);
	await current.call();
	assert.equal(receipts[0].input_tokens, 10);
	assert.equal(receipts[0].output_tokens, 3);
	await current.restart();
	await current.call();
	assert.equal(current.provider.requests, 3, "若未结算实际用量，第二次请求就会被 TPM 挡住");
	current.provider.usage = {};
	await current.call();
	await assert.rejects(current.call(), /资源排队超时/);
	await current.restart();
	await assert.rejects(current.call(), /资源排队超时/);
	assert.equal(current.provider.requests, 4, "缺失用量保留预约，不能当成零使用量");
});

for (const format of ["seconds", "http-date"] as const) {
	test(`429 ${format} 冷却跨重启且不自动再发`, async (context) => {
		const current = await fixture(context);
		current.provider.status = 429;
		current.provider.retryAfter = format === "seconds" ? "90" : new Date(Date.now() + 90000).toUTCString();
		const receipts: ModelReceipt[] = [];
		await assert.rejects(current.call(receipts), { code: "model_rate_limited" });
		assert.ok(receipts[0].retry_after_until! > Date.now() + 80000, "不得把冷却静默压到60秒");
		assert.equal(current.gateway.pool.stats().active, 0);
		await current.restart();
		current.provider.status = 200;
		await assert.rejects(current.call(), /资源排队超时/);
		assert.equal(current.provider.requests, 1);
	});
}

for (const usage of [
	{ prompt_tokens: 10 },
	{ completion_tokens: 3 },
	{ prompt_tokens: -1, completion_tokens: 3 },
	{ prompt_tokens: 10, completion_tokens: 3, total_tokens: 999 },
]) {
	test(`部分或矛盾用量不因 Pi 默认零而释放 TPM：${JSON.stringify(usage)}`, async (context) => {
		const current = await fixture(context, { accountTpm: 5000 });
		current.provider.usage = usage as Record<string, number>;
		const receipts: ModelReceipt[] = [];
		await current.call(receipts);
		assert.equal(receipts[0].input_tokens, null);
		assert.equal(receipts[0].output_tokens, null);
		await current.restart();
		await assert.rejects(current.call(), /资源排队超时/);
		assert.equal(current.provider.requests, 1);
	});
}

test("明确的原始零用量与缺失字段不同，允许结算且恢复不补造预约", async (context) => {
	const current = await fixture(context, { accountTpm: 5000 });
	current.provider.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
	const receipts: ModelReceipt[] = [];
	await current.call(receipts);
	assert.equal(receipts[0].input_tokens, 0);
	assert.equal(receipts[0].output_tokens, 0);
	await current.restart();
	await current.call();
	assert.equal(current.provider.requests, 2);
});

test("RPM 恢复按实际发送时间，准备与派发时间过旧不提前放行", async (context) => {
	const current = await fixture(context, { accountRpm: 1 });
	const dispatch = current.runtime.dispatchOperation.bind(current.runtime);
	const realNow = Date.now;
	context.mock.method(current.runtime, "dispatchOperation", async (id: string) => {
		// 仅在持久派发提交期间移动时钟，随后真正网络发送回到当前时间。
		const clock = context.mock.method(Date, "now", () => realNow() - 120000);
		try {
			await dispatch(id);
		} finally {
			clock.mock.restore();
		}
	});
	await current.call();
	const operation = (await current.runtime.listOperations())[0];
	assert.ok(Number(operation.receipt?.sent_at) - operation.dispatchedAt! > 110000);
	await current.restart();
	await assert.rejects(current.call(), /资源排队超时/);
	assert.equal(current.provider.requests, 1);
});

test("尚未发送的预约跨分钟不能被 RPM 窗口清走，确定未发送失败则释放", async (context) => {
	const current = await fixture(context, { accountRpm: 1 });
	await assert.rejects(
		current.call([], async () => {
			throw new Error("本地准备失败");
		}),
	);
	assert.equal(current.provider.requests, 0);
	let release!: () => void;
	let arrived!: () => void;
	const ready = new Promise<void>((done) => {
		arrived = done;
	});
	const hold = new Promise<void>((done) => {
		release = done;
	});
	const first = current.call([], async () => {
		arrived();
		await hold;
	});
	await ready;
	const future = Date.now() + 61000;
	const clock = context.mock.method(Date, "now", () => future);
	try {
		await assert.rejects(current.call(), /资源排队超时/);
		assert.equal(current.provider.requests, 0);
	} finally {
		release();
	}
	await first;
	clock.mock.restore();
	assert.equal(current.provider.requests, 1);
	assert.equal((await current.runtime.listOperations()).filter((item) => item.status === "not_sent").length, 1);
});

for (const status of [408, 502]) {
	test(`网关 ${status} 未证明上游终态，恢复后仍未知占位`, async (context) => {
		const current = await fixture(context);
		current.provider.status = status;
		const receipts: ModelReceipt[] = [];
		await assert.rejects(current.call(receipts), { code: "external_call_unknown" });
		assert.equal(receipts[0].operation_status, "unknown");
		assert.equal(current.gateway.pool.stats().active, 1);
		await current.restart();
		assert.equal(current.gateway.pool.stats().active, 1);
		assert.equal((await current.runtime.listOperations())[0].status, "unknown");
		assert.equal(current.provider.requests, 1);
	});
}
