import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Application } from "../src/application.ts";
import { APP_ROOT, type AppConfig, readConfig } from "../src/config.ts";

// 配置先验校验，不通过非法策略或预算启动模型调用。
test("检索默认渐进披露且预算随策略确定，非法预算与策略拒绝", () => {
	const defaults = readConfig({
		PI_RETRIEVAL_STRATEGY: undefined,
		PI_RETRIEVAL_MAX_CONTEXT_CHARS: undefined,
		PI_RETRIEVAL_TOP_K: undefined,
	});
	assert.equal(defaults.retrievalStrategy, "progressive");
	assert.equal(defaults.retrievalMaxContextChars, 256000);
	assert.equal(defaults.retrievalTopK, 5);
	for (const strategy of ["lexical", "full_catalog"])
		assert.equal(readConfig({ PI_RETRIEVAL_STRATEGY: strategy, PI_RETRIEVAL_TOP_K: undefined }).retrievalTopK, 12);
	assert.equal(readConfig({ PI_RETRIEVAL_STRATEGY: "full_catalog", PI_RETRIEVAL_TOP_K: "20" }).retrievalTopK, 20);
	assert.throws(() => readConfig({ PI_RETRIEVAL_STRATEGY: "vector" }), /PI_RETRIEVAL_STRATEGY/);
	assert.throws(() => readConfig({ PI_RETRIEVAL_TOP_K: "0" }), /PI_RETRIEVAL_TOP_K/);
	assert.throws(() => readConfig({ PI_RETRIEVAL_MAX_CONTEXT_CHARS: "999" }), /PI_RETRIEVAL_MAX_CONTEXT_CHARS/);
});

// 模型仅用本地替身，检验用户重试不依赖已完成任务的源文件继续存在。
test("已接受请求先去重，源文件缺失不破坏回执且不同请求内容仍冲突", async () => {
	const dataDir = await mkdtemp(resolve(tmpdir(), "pi-query-application-"));
	execFileSync("python3", [resolve(APP_ROOT, "python/build_fixtures.py"), "--output-dir", dataDir]);
	// 每个测试拥有独立协调器安装，不能触碰本机服务的锁与未知调用账本。
	const app = await Application.open({
		...readConfig(),
		// 重试回执测试保留原规划替身，不把渐进选表阶段混入本测试。
		retrievalStrategy: "lexical",
		dataDir,
		installationLockPath: resolve(dataDir, "coordinator"),
		coordinatorStoragePath: resolve(dataDir, "runtime.sqlite"),
	});
	app.models.json = async () => ({ action: "blocked", reason: "测试替身不调用付费模型" });
	try {
		const input = { conversation_id: "retry", request_id: "request", source_id: "hospital-a", question: "测试问题" };
		const original = await app.query(input);
		const deadline = Date.now() + 5000;
		while (["queued", "running"].includes((await app.runtime.get(original.id))!.status) && Date.now() < deadline)
			await delay(10);
		assert.equal((await app.runtime.get(original.id))!.status, "blocked");
		await rm(resolve(dataDir, "hospital-a.sqlite"));
		const retry = await app.query(input);
		assert.equal(retry.id, original.id);
		assert.equal(retry.status, "blocked");
		assert.equal((await app.runtime.list("retry")).length, 1);
		await assert.rejects(app.query({ ...input, question: "改变的问题" }), { code: "request_conflict" });
		await assert.rejects(app.query({ ...input, source_id: "hospital-b" }), { code: "request_conflict" });
		await assert.rejects(app.query({ ...input, mode: "eval" }), { code: "request_conflict" });
	} finally {
		await app.close();
		await rm(dataDir, { recursive: true, force: true });
	}
});

// 新会话采用渐进默认；已有会话冻结的旧策略缺省预算仍按原策略补齐。
test("在线检索配置按会话冻结，旧词法方案不被渐进默认覆盖", async (t) => {
	const dataDir = await mkdtemp(resolve(tmpdir(), "pi-query-retrieval-binding-"));
	execFileSync("python3", [resolve(APP_ROOT, "python/build_fixtures.py"), "--output-dir", dataDir]);
	const config: AppConfig = {
		...readConfig(),
		dataDir,
		installationLockPath: resolve(dataDir, "coordinator"),
		coordinatorStoragePath: resolve(dataDir, "runtime.sqlite"),
	};
	delete config.retrievalStrategy;
	delete config.retrievalTopK;
	const app = await Application.open(config);
	app.models.json = async () => ({ action: "blocked", reason: "本地替身" });
	t.after(async () => {
		await app.close();
		await rm(dataDir, { recursive: true, force: true });
	});
	const current = await app.query({
		conversation_id: "new-default",
		request_id: "new-default",
		source_id: "hospital-a",
		question: "测试新默认",
	});
	assert.equal(current.context.retrieval_strategy, "progressive");
	assert.equal(current.context.retrieval_top_k, 5);
	await app.runtime.setExperimentPaused("hold-old", true);
	await app.runtime.enqueue({
		conversationId: "old-frozen",
		requestId: "old-seed",
		question: "原有会话",
		context: {
			experiment_id: "hold-old",
			source_id: "hospital-a",
			online_variant: { retrieval_strategy: "lexical", model_call_limit: 8, repair_limit: 1 },
		},
	});
	const inherited = await app.query({
		conversation_id: "old-frozen",
		request_id: "old-followup",
		source_id: "hospital-a",
		question: "继续原有会话",
	});
	assert.equal(inherited.context.retrieval_strategy, "lexical");
	assert.equal(inherited.context.retrieval_top_k, 12);
});

// 显式配置必须同时约束业务队列和模型队列，不能仅在模型池中生效。
for (const onlineQueueReserve of [0, 4]) {
	test(`应用透传非默认在线保留量 ${onlineQueueReserve}，评测不能挤占预留位置`, async (t) => {
		const dataDir = await mkdtemp(resolve(tmpdir(), "pi-query-reserve-"));
		execFileSync("python3", [resolve(APP_ROOT, "python/build_fixtures.py"), "--output-dir", dataDir]);
		const config: AppConfig = {
			apiKey: "",
			baseUrl: "http://127.0.0.1:1/v1",
			decisionModel: "deepseek-test",
			answerModel: "deepseek-test",
			maxActiveRuns: 1,
			llmMaxConcurrency: 1,
			evalMaxActiveRuns: 1,
			maxPending: 5,
			onlineQueueReserve,
			queueWaitTimeoutMs: 10000,
			llmTimeoutMs: 1000,
			runTimeoutMs: 10000,
			port: 8787,
			python: "python3",
			dataDir,
			installationLockPath: resolve(dataDir, "owner"),
			coordinatorStoragePath: resolve(dataDir, "runtime.sqlite"),
		};
		const app = await Application.open(config);
		t.after(async () => {
			await app.close();
			await rm(dataDir, { recursive: true, force: true });
		});
		// 所有任务固定暂停，测试只观察真实准入，不发起任何模型调用。
		await app.runtime.setExperimentPaused("reserved", true);
		const submit = (id: string, mode: "eval" | "online") =>
			app.query({
				conversation_id: id,
				request_id: id,
				source_id: "hospital-a",
				question: "队列准入检查",
				mode,
				execution_context: { experiment_id: "reserved" },
			});
		for (let index = 0; index < 5 - onlineQueueReserve; index++) await submit(`eval-${index}`, "eval");
		await assert.rejects(submit("eval-overflow", "eval"), { code: "queue_full" });
		for (let index = 0; index < onlineQueueReserve; index++) await submit(`online-${index}`, "online");
		await assert.rejects(submit("online-overflow", "online"), { code: "queue_full" });
		assert.equal((await app.runtime.stats()).pending, 5);
		assert.equal((await app.runtime.listOperations()).length, 0);
	});
}
