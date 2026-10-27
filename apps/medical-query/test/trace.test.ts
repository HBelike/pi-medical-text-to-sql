import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Application, publicTurn } from "../src/application.ts";
import { APP_ROOT, type AppConfig } from "../src/config.ts";
import type { ModelReceipt } from "../src/model.ts";
import type { StageRecord } from "../src/pipeline.ts";
import type { QueryTask } from "../src/runtime.ts";

const query = {
	action: "query",
	linking: { tables: ["patients"], fields: ["patients.patient_id"] },
	conditions: ["年龄至少65岁"],
	dsl: {
		from: "patients",
		select: [{ field: "patients.patient_id", aggregate: "count_distinct", as: "count" }],
		where: [{ field: "patients.age", op: "gte", value: 65 }],
	},
};
const answer = { facts: [{ row: 0, column: "count" }] };

// 实际 HTTP SSE → Pi AI → 领域 SQLite → Durable → 公共响应，始终只连接本机测试端点。
async function setup(t: TestContext, outputs: (object | "hang" | "rate-limit")[]) {
	const dataDir = await mkdtemp(resolve(tmpdir(), "pi-trace-"));
	execFileSync("python3", [resolve(APP_ROOT, "python/build_fixtures.py"), "--output-dir", dataDir]);
	const requests: { messages: { role: string; content: string }[] }[] = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push(JSON.parse(body));
		const output = outputs.shift();
		if (!output) {
			response.writeHead(500);
			response.end("unexpected test request");
			return;
		}
		if (output === "rate-limit") {
			response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
			response.end(JSON.stringify({ error: { message: "本机受控速率限制" } }));
			return;
		}
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.flushHeaders();
		if (output === "hang") return;
		const base = { id: "test", object: "chat.completion.chunk", created: 1, model: "deepseek-test" };
		response.write(
			`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(output) }, finish_reason: null }] })}\n\n`,
		);
		response.write(
			`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const config: AppConfig = {
		apiKey: "trace-test-only-key",
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		decisionModel: "deepseek-test",
		answerModel: "deepseek-test",
		maxActiveRuns: 1,
		llmMaxConcurrency: 1,
		evalMaxActiveRuns: 1,
		maxPending: 5,
		queueWaitTimeoutMs: 3000,
		llmTimeoutMs: 3000,
		runTimeoutMs: 5000,
		port: address.port,
		python: "python3",
		dataDir,
		// 此组回归固定原决策/答案阶段，渐进选表另有专门测试，避免改变记录契约。
		retrievalStrategy: "lexical",
	};
	let app = await Application.open(config);
	t.after(async () => {
		await app.close();
		server.closeAllConnections();
		await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
		await rm(dataDir, { recursive: true, force: true });
	});
	return {
		get app() {
			return app;
		},
		requests,
		config,
		reopen: async () => {
			await app.close();
			app = await Application.open(config);
		},
	};
}

async function waitFor(app: Application, id: string, condition: (task: QueryTask) => boolean): Promise<QueryTask> {
	const deadline = Date.now() + 5000;
	for (;;) {
		const task = (await app.runtime.get(id))!;
		if (condition(task)) return task;
		assert.ok(Date.now() < deadline, `等待记录超时：${task.status}`);
		await delay(10);
	}
}
const settled = (app: Application, id: string) =>
	waitFor(app, id, (task) => !["running", "queued"].includes(task.status));
const trace = (task: QueryTask) => {
	const view = publicTurn(task);
	return { view, calls: view.model_calls as ModelReceipt[], stages: view.stages as StageRecord[] };
};

test("实际提示词与阶段跨追问、刷新和后续问题持久化，历史输入不带观察记录", async (t) => {
	const env = await setup(t, [
		{ action: "clarify", question: "需要统计哪个年龄范围？", options: ["65岁及以上"] },
		query,
		answer,
		query,
		answer,
	]);
	const input = {
		conversation_id: "conversation",
		source_id: "hospital-a",
		request_id: "first",
		question: "统计患者人数",
	};
	const first = await settled(env.app, (await env.app.query(input)).id);
	assert.equal(first.status, "waiting_for_user");
	const waiting = trace(first);
	assert.deepEqual(
		waiting.stages.map((stage) => stage.kind),
		["catalog", "decision"],
	);
	assert.equal(waiting.calls.length, 1);
	const reply = await env.app.runtime.reply({
		turnId: first.id,
		submissionId: "reply",
		clarificationId: first.clarification!.id,
		revision: first.clarification!.revision,
		answer: "65岁及以上",
	});
	const completed = await settled(env.app, reply.id);
	assert.equal(completed.status, "completed");
	const recorded = trace(completed);
	assert.deepEqual(
		recorded.stages.map((stage) => stage.kind),
		["catalog", "decision", "catalog", "decision", "execution", "answer"],
	);
	assert.ok(recorded.stages.every((stage) => stage.status === "completed" && typeof stage.duration_ms === "number"));
	assert.equal(new Set(recorded.stages.map((stage) => stage.id)).size, 6);
	assert.equal(new Set(recorded.stages.map((stage) => stage.run_id)).size, 2);
	assert.equal(recorded.calls.length, 3);
	assert.equal(recorded.calls[0].id, waiting.calls[0].id);
	assert.ok(recorded.calls.every((call) => call.status === "completed"));
	assert.equal(recorded.stages.filter((stage) => stage.model_call_id).length, 3);
	for (const [index, call] of recorded.calls.entries()) {
		assert.equal(
			call.system_prompt,
			env.requests[index].messages.find((message) => message.role === "system")!.content,
		);
		assert.equal(call.user_prompt, env.requests[index].messages.find((message) => message.role === "user")!.content);
	}
	assert.equal(JSON.stringify(recorded.view).includes(env.config.apiKey), false);
	assert.equal(JSON.stringify(recorded.view.evidence).includes("system_prompt"), false);
	assert.equal(JSON.stringify(recorded.view.usage).includes("system_prompt"), false);
	await env.reopen();
	const restored = trace((await env.app.runtime.get(completed.id))!);
	assert.deepEqual(restored.calls, recorded.calls);
	assert.deepEqual(restored.stages, recorded.stages);
	assert.equal(env.requests.length, 3, "重启不补发模型请求");
	await settled(env.app, (await env.app.query({ ...input, request_id: "next", question: "再按相同条件统计" })).id);
	const nextInput = JSON.parse(env.requests[3].messages.find((message) => message.role === "user")!.content);
	assert.equal(nextInput.prior.length, 1);
	assert.equal(JSON.stringify(nextInput.prior).includes("model_calls"), false);
	assert.equal(JSON.stringify(nextInput.prior).includes("system_prompt"), false);
	assert.equal(JSON.stringify(nextInput.prior).includes('"stages"'), false);
	// 旧记录缺少采集字段时必须保持空，不根据业务证据反向生成假卡片。
	const legacy = publicTurn({ ...completed, progress: undefined, result: { evidence: { sql: "SELECT 1" } } });
	assert.deepEqual(legacy.model_calls, []);
	assert.deepEqual(legacy.stages, []);
});

test("定向修复追加真实阶段，失败执行保留计划，空结果不制造回答模型调用", async (t) => {
	const invalid = { ...query, dsl: { from: "patients", select: [{ field: "patients.missing" }] } };
	const empty = {
		...query,
		dsl: {
			from: "patients",
			select: [{ field: "patients.name" }],
			where: [{ field: "patients.age", op: "gt", value: 150 }],
		},
	};
	const env = await setup(t, [invalid, empty]);
	const task = await settled(
		env.app,
		(
			await env.app.query({
				conversation_id: "repair",
				source_id: "hospital-a",
				request_id: "one",
				question: "超过150岁患者",
			})
		).id,
	);
	const recorded = trace(task);
	assert.equal(task.status, "completed");
	assert.deepEqual(
		recorded.stages.map((stage) => stage.kind),
		["catalog", "decision", "execution", "decision", "execution", "answer"],
	);
	assert.equal(recorded.stages[2].status, "failed");
	assert.deepEqual(recorded.stages[2].data, { dsl: invalid.dsl });
	assert.ok(recorded.stages[2].error);
	assert.equal(recorded.stages[4].status, "completed");
	assert.equal(recorded.calls.length, 2);
	assert.equal(recorded.stages[5].model_call_id, undefined);
	assert.equal((recorded.stages[5].data as { method: string }).method, "empty_result_summary");
});

test("答案校验失败保留已完成阶段和数据，模型成功与业务失败分别标识", async (t) => {
	// 答案仅获得一次修复，第二次仍非法就终止；不能为“成功”重复执行查询。
	const env = await setup(t, [
		query,
		{ facts: [{ row: 999, column: "count" }] },
		{ facts: [{ row: 999, column: "count" }] },
	]);
	const task = await settled(
		env.app,
		(
			await env.app.query({
				conversation_id: "failed",
				source_id: "hospital-a",
				request_id: "one",
				question: "65岁以上人数",
			})
		).id,
	);
	const recorded = trace(task);
	assert.equal(task.status, "failed");
	assert.deepEqual(
		recorded.stages.map((stage) => stage.status),
		["completed", "completed", "completed", "failed", "failed"],
	);
	assert.equal(recorded.calls[1].status, "completed");
	assert.deepEqual((recorded.view.result as { rows: unknown[] }).rows, [[3]]);
	assert.equal((recorded.stages[3].data as { answer_status: string }).answer_status, "failed");
});

test("取消模型流后持久化实际调用终态与已完成查询，不提前释放名额", async (t) => {
	const env = await setup(t, [query, "hang"]);
	const submitted = await env.app.query({
		conversation_id: "cancel",
		source_id: "hospital-a",
		request_id: "one",
		question: "65岁以上人数",
	});
	await waitFor(
		env.app,
		submitted.id,
		(task) => trace(task).calls.length === 2 && trace(task).calls[1].status === "running",
	);
	assert.equal(env.app.models.pool.stats().active, 1);
	const cancelled = await env.app.runtime.cancel(submitted.id);
	const recorded = trace(cancelled);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(recorded.calls[1].status, "unknown");
	assert.equal(recorded.stages.at(-1)!.status, "cancelled");
	assert.deepEqual((recorded.view.result as { rows: unknown[] }).rows, [[3]]);
	assert.equal(env.app.models.pool.stats().active, 1, "本地退出不证明远端结束，未知预留继续计数");
	assert.equal((await env.app.runtime.stats()).active, 0);
	await env.reopen();
	assert.deepEqual(trace((await env.app.runtime.get(cancelled.id))!).calls, recorded.calls);
	assert.equal(env.app.models.pool.stats().active, 1, "重启恢复未知预留");
	const unknown = (await env.app.runtime.listOperations(cancelled.id)).find(
		(operation) => operation.status === "unknown",
	)!;
	const disposition = await env.app.runtime.reconcileOperation(unknown.id, {
		request_id: "manual-release",
		action: "manual_release",
		actor: "local-test",
		reason: "测试明确承担远端状态不可核实的风险",
	});
	assert.equal(disposition.status, "unknown");
	assert.equal(disposition.reservationReleased, true);
	assert.equal(env.app.models.pool.stats().active, 0);
});

// 供应商明确429允许一次有界暂态重试，仍计入累计调用数，但不冒充质量修复。
test("明确429最多重试一次且所有模型角色共用turn调用预算", async (t) => {
	const env = await setup(t, ["rate-limit", query, answer]);
	const task = await settled(
		env.app,
		(
			await env.app.query({
				conversation_id: "rate",
				source_id: "hospital-a",
				request_id: "one",
				question: "65岁及以上人数",
			})
		).id,
	);
	assert.equal(task.status, "completed");
	assert.equal(env.requests.length, 3);
	assert.equal(task.budget!.modelCalls, 3);
	assert.equal(task.budget!.repairs, 0);
	const operations = await env.app.runtime.listOperations(task.id);
	assert.equal(operations[0].status, "failed");
	assert.equal(operations[0].receipt!.http_status, 429);
	assert.equal(operations.filter((operation) => operation.status === "succeeded").length, 2);
});
