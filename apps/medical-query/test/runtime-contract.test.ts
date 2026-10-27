import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../src/config.ts";
import { ModelGateway } from "../src/model.ts";
import { QueryRuntime, type QueryTask } from "../src/runtime.ts";

// 以测试文件定位仓库，确保从应用目录启动时子进程仍能解析注册器和源码。
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const registerPath = fileURLToPath(new URL("../../../scripts/issues/register.mjs", import.meta.url));

async function wait(runtime: QueryRuntime, id: string, status: QueryTask["status"]): Promise<QueryTask> {
	for (let count = 0; count < 500; count++) {
		const task = (await runtime.get(id))!;
		if (task.status === status) return task;
		await delay(5);
	}
	throw new Error(`等待${status}超时`);
}

// 安装锁不从实验dataDir派生，第二个数据库也不能获得另一份全局额度。
test("安装级owner阻止不同数据库同时启动", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-contract-"));
	const first = await QueryRuntime.open({
		storagePath: join(dir, "a.sqlite"),
		installationLockPath: join(dir, "installation"),
		handler: async () => ({ status: "completed", result: null }),
	});
	t.after(async () => {
		await first.close();
		await rm(dir, { recursive: true, force: true });
	});
	await assert.rejects(
		QueryRuntime.open({
			storagePath: join(dir, "b.sqlite"),
			installationLockPath: join(dir, "installation"),
			handler: async () => ({ status: "completed", result: null }),
		}),
		/使用/,
	);
});

// 模拟已获得发送权后的本地退出：重启不重放，人工释放只改变预留而不伪造远端成功。
test("外部调用恢复为unknown，幂等处置保留历史且不自动重放", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-operation-contract-"));
	const storagePath = join(dir, "runtime.sqlite");
	let runtime: QueryRuntime;
	runtime = await QueryRuntime.open({
		storagePath,
		handler: async (task, signal) => {
			await runtime.prepareOperation({
				id: "sent",
				turnId: task.id,
				runId: task.runId,
				role: "decision",
				model: "fake",
				scope: { mode: "eval" },
				requestHash: "hash",
				input: { question: task.question },
			});
			await runtime.dispatchOperation("sent");
			await delay(10000, undefined, { signal });
			return { status: "completed", result: null };
		},
	});
	t.after(async () => {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	});
	const original = await runtime.enqueue({ conversationId: "one", requestId: "one", question: "测试" });
	for (let count = 0; count < 500 && (await runtime.listOperations())[0]?.status !== "dispatching"; count++)
		await delay(5);
	await runtime.close();
	let replayed = 0;
	runtime = await QueryRuntime.open({
		storagePath,
		handler: async () => {
			replayed++;
			return { status: "completed", result: null };
		},
	});
	assert.equal((await runtime.get(original.id))!.status, "reconciliation_required");
	assert.equal((await runtime.listOperations())[0].status, "unknown");
	assert.equal((await runtime.get(original.id))!.budget!.modelCalls, 1);
	assert.equal(replayed, 0);
	await assert.rejects(runtime.dispatchOperation("sent"), /禁止重放/);
	await assert.rejects(
		runtime.reconcileOperation("sent", {
			request_id: "bad",
			action: "verified_complete",
			actor: "test",
			reason: "无证据",
		}),
		/依据/,
	);
	const command = {
		request_id: "release",
		action: "manual_release" as const,
		actor: "test",
		reason: "明确承担未知远端风险",
	};
	const released = await runtime.reconcileOperation("sent", command);
	assert.equal(released.status, "unknown");
	assert.equal(released.reservationReleased, true);
	assert.equal((await runtime.reconcileOperation("sent", command)).dispositions.length, 1);
	await assert.rejects(runtime.reconcileOperation("sent", { ...command, reason: "不同理由" }), /冲突/);
	assert.equal(replayed, 0);
});

// 追问只开启新run，不能通过换runId获得第二份累计修复预算。
test("累计修复预算跨追问保留，取消后禁止新预算消费", async (t) => {
	let runtime: QueryRuntime;
	runtime = await QueryRuntime.open({
		storagePath: ":memory:",
		handler: async (task) => {
			await runtime.consumeBudget(task.id, task.runId, "repairs");
			return { status: "waiting_for_user", clarification: { question: "补充条件？" } };
		},
	});
	t.after(() => runtime.close());
	const task = await runtime.enqueue({
		conversationId: "budget",
		requestId: "one",
		question: "测试",
		context: { repair_limit: 1 },
	});
	const waiting = await wait(runtime, task.id, "waiting_for_user");
	await runtime.reply({
		turnId: task.id,
		submissionId: "reply",
		clarificationId: waiting.clarification!.id,
		revision: waiting.clarification!.revision,
		answer: "补充",
	});
	const failed = await wait(runtime, task.id, "failed");
	assert.equal(failed.error!.code, "budget_exhausted");
	assert.equal(failed.budget!.repairs, 1);
	await assert.rejects(runtime.consumeBudget(task.id, failed.runId, "sqlExecutions"), /已停止/);
});

test("实验暂停保持queued且不超时，恢复明确重新排队", async (t) => {
	let calls = 0;
	const runtime = await QueryRuntime.open({
		storagePath: ":memory:",
		queueWaitTimeoutMs: 20,
		handler: async () => {
			calls++;
			return { status: "completed", result: null };
		},
	});
	t.after(() => runtime.close());
	await runtime.setExperimentPaused("paused", true);
	const task = await runtime.enqueue({
		conversationId: "pause",
		requestId: "one",
		question: "测试",
		context: { mode: "eval", experiment_id: "paused" },
	});
	await delay(50);
	assert.equal((await runtime.get(task.id))!.status, "queued");
	assert.equal(calls, 0);
	await runtime.setExperimentPaused("paused", false);
	await wait(runtime, task.id, "completed");
	assert.equal(calls, 1);
});

// 取消持久屏障封住排队、追问与独立评分发送，重启和解除暂停均不能绕过。
test("实验取消原子拦截晚到工作，重启后仍有效", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-cancel-barrier-"));
	const storagePath = join(dir, "runtime.sqlite");
	let runtime = await QueryRuntime.open({
		storagePath,
		handler: async () => ({ status: "waiting_for_user", clarification: { question: "条件？" } }),
	});
	t.after(async () => {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	});
	const input = {
		conversationId: "cancel",
		requestId: "one",
		question: "测试",
		context: { mode: "eval", experiment_id: "cancelled" },
	};
	const task = await runtime.enqueue(input);
	const waiting = await wait(runtime, task.id, "waiting_for_user");
	await runtime.prepareOperation({
		id: "judge",
		role: "judge",
		model: "fake",
		scope: { experiment_id: "cancelled", budget_id: "judge", call_limit: 1 },
		requestHash: "hash",
		input: {},
	});
	await runtime.cancelExperiment("cancelled");
	assert.equal((await runtime.get(task.id))!.status, "cancelled");
	await assert.rejects(runtime.dispatchOperation("judge"), /已取消/);
	await assert.rejects(
		runtime.reply({
			turnId: task.id,
			submissionId: "late",
			clarificationId: waiting.clarification!.id,
			revision: waiting.clarification!.revision,
			answer: "迟到回答",
		}),
		/已取消/,
	);
	await assert.rejects(runtime.enqueue({ ...input, requestId: "late" }), /已取消/);
	assert.equal((await runtime.enqueue(input)).id, task.id, "重复提交只取回原事实");
	await runtime.close();
	runtime = await QueryRuntime.open({ storagePath, handler: async () => ({ status: "completed", result: null }) });
	await assert.rejects(runtime.setExperimentPaused("cancelled", false), /已取消/);
	await assert.rejects(runtime.enqueue({ ...input, requestId: "restart" }), /已取消/);
	await assert.rejects(
		runtime.prepareOperation({
			id: "late-judge",
			role: "judge",
			model: "fake",
			scope: { experiment_id: "cancelled" },
			requestHash: "late",
			input: {},
		}),
		/已取消/,
	);
});

// handler忽略AbortSignal的迟到结果仍只能留下观察证据，不能穿过取消后的发布门。
test("取消提交后不能新增或替换已发布数值", async (t) => {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const runtime = await QueryRuntime.open({
		storagePath: ":memory:",
		handler: async (_task, _signal, progress) => {
			await progress({ publication: { status: "published", id: "original", result: { rows: [[1]] } } });
			reached.resolve();
			await release.promise;
			await progress({
				publication: { status: "published", id: "late", result: { rows: [[2]] } },
				late_observation: true,
			});
			return { status: "completed", result: { publication: { id: "late" } } };
		},
	});
	t.after(() => runtime.close());
	const task = await runtime.enqueue({ conversationId: "publish", requestId: "one", question: "测试" });
	await reached.promise;
	const cancelling = runtime.cancel(task.id);
	while (!(await runtime.get(task.id))!.cancelRequested) await delay(1);
	release.resolve();
	const cancelled = await cancelling;
	assert.equal(cancelled.status, "cancelled");
	assert.equal((cancelled.progress as { publication: { id: string } }).publication.id, "original");
	assert.equal(cancelled.result, undefined);
});

// 真进程+真HTTP故障注入，证明不同dataDir不能扩容，SIGKILL不会把已发送请求自动重播。
test("多进程owner与真实远端未知调用在强杀后保留额度", { timeout: 15000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-network-"));
	let requests = 0;
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) {
			/* 消费请求体；测试端点从不转发外网。 */
		}
		requests++;
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.flushHeaders();
		if (requests === 1) return;
		const chunk = {
			id: "local",
			object: "chat.completion.chunk",
			created: 1,
			model: "deepseek-test",
			choices: [{ index: 0, delta: { content: '{"ok":true}' }, finish_reason: "stop" }],
		};
		response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const config: AppConfig = {
		apiKey: "local-test",
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		decisionModel: "deepseek-test",
		answerModel: "deepseek-test",
		maxActiveRuns: 1,
		llmMaxConcurrency: 1,
		evalMaxActiveRuns: 1,
		maxPending: 10,
		queueWaitTimeoutMs: 80,
		llmTimeoutMs: 10000,
		runTimeoutMs: 12000,
		port: address.port,
		python: "unused",
		dataDir: dir,
	};
	const storagePath = join(dir, "coordinator.sqlite"),
		installationLockPath = join(dir, "installation");
	const script = `import {QueryRuntime} from './apps/medical-query/src/runtime.ts';
 import {ModelGateway} from './apps/medical-query/src/model.ts';
 const gateway=new ModelGateway(${JSON.stringify(config)});
 const runtime=await QueryRuntime.open({storagePath:${JSON.stringify(storagePath)},installationLockPath:${JSON.stringify(installationLockPath)},onReady:r=>gateway.attachRuntime(r),handler:async(task,signal)=>{
 const value=await gateway.json('decision','测试',{},signal,[],1,undefined,4096,{turn_id:task.id,run_id:task.runId});return {status:'completed',result:value};}});
 const task=await runtime.enqueue({conversationId:'one',requestId:'one',question:'测试'});
 while((await runtime.listOperations())[0]?.status!=='in_flight') await new Promise(r=>setTimeout(r,5));
 console.log(JSON.stringify({turnId:task.id}));`;
	const child = spawn(
		process.execPath,
		["--import", registerPath, "--conditions=source", "--input-type=module", "-e", script],
		{ cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
	);
	let runtime: QueryRuntime | undefined,
		stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await runtime?.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	});
	const ready = await new Promise<string>((resolve, reject) => {
		let data = "";
		child.stdout.on("data", (chunk) => {
			data += chunk.toString();
			if (data.includes("\n")) resolve(data.trim());
		});
		child.on("exit", (code) => {
			if (!data) reject(new Error(`child ${code}: ${stderr}`));
		});
	});
	const { turnId } = JSON.parse(ready);
	await assert.rejects(
		QueryRuntime.open({
			storagePath: join(dir, "different.sqlite"),
			installationLockPath,
			handler: async () => ({ status: "completed", result: null }),
		}),
		/使用/,
	);
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	const gateway = new ModelGateway(config);
	runtime = await QueryRuntime.open({
		storagePath,
		installationLockPath,
		onReady: (r) => gateway.attachRuntime(r),
		handler: async () => {
			throw new Error("不得重放");
		},
	});
	assert.equal((await runtime.get(turnId))!.status, "reconciliation_required");
	assert.equal(gateway.pool.stats().active, 1);
	await assert.rejects(
		gateway.json("judge", "测试", {}, new AbortController().signal, [], 0, undefined, 4096, {
			mode: "eval",
			budget_id: "judge",
			call_limit: 1,
		}),
		/排队超时/,
	);
	assert.equal(requests, 1);
	const operation = (await runtime.listOperations())[0];
	await runtime.reconcileOperation(operation.id, {
		request_id: "release",
		action: "manual_release",
		actor: "test",
		reason: "明确保留远端未知",
	});
	const result = await gateway.json("judge", "测试", {}, new AbortController().signal, [], 0, undefined, 4096, {
		mode: "eval",
		budget_id: "judge",
		call_limit: 1,
	});
	assert.deepEqual(result, { ok: true });
	assert.equal(requests, 2);
	assert.equal((await runtime.listOperations())[0].status, "unknown");
	assert.equal((await runtime.listOperations())[0].reservationReleased, true);
});
