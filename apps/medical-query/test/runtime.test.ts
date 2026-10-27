import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { QueryRuntime, type QueryTask, RuntimeError, type RuntimeOptions } from "../src/runtime.ts";

// 以测试文件定位仓库，确保从应用目录启动时子进程仍能解析注册器和源码。
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const registerPath = fileURLToPath(new URL("../../../scripts/issues/register.mjs", import.meta.url));

/** 使用真实 SQLite + Durable Harness，只替换领域 handler，验证状态与调度而不调用真实模型。 */
async function fixture(t: TestContext, options: Omit<RuntimeOptions, "storagePath">): Promise<QueryRuntime> {
	const directory = await mkdtemp(join(tmpdir(), "medical-runtime-"));
	const errors: unknown[] = [];
	const runtime = await QueryRuntime.open({
		...options,
		storagePath: join(directory, "runtime.sqlite"),
		onError: (error) => errors.push(error),
	});
	t.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
		assert.deepEqual(errors, [], "后台调度不得静默失败");
	});
	return runtime;
}

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeoutMs = 4000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (matches(value)) return value;
		if (Date.now() > deadline) assert.fail(`等待状态超时：${JSON.stringify(value)}`);
		await sleep(5);
	}
}
const status = (runtime: QueryRuntime, id: string, wanted: QueryTask["status"]) =>
	until(
		() => runtime.get(id),
		(task) => task?.status === wanted,
	) as Promise<QueryTask>;
const hasCode =
	(code: string) =>
	(error: unknown): boolean =>
		error instanceof RuntimeError && error.code === code;
const request = (conversationId: string, requestId = conversationId, question = requestId) => ({
	conversationId,
	requestId,
	question,
});

// 诊断计数不得复用会克隆全部任务正文的公开列表，历史体积增大时仍只返回四个计数。
test("运行统计不调用完整任务列表", async (t) => {
	const gate = Promise.withResolvers<void>();
	t.after(() => gate.resolve());
	const runtime = await fixture(t, {
		maxActiveRuns: 1,
		handler: async () => {
			await gate.promise;
			return { status: "completed", result: { answer: "ok" } };
		},
	});
	const originalList = runtime.list.bind(runtime);
	runtime.list = async () => {
		throw new Error("运行统计不应调用完整任务列表");
	};
	try {
		await runtime.enqueue(request("stats-first", "stats-first", "运行统计一"));
		await runtime.enqueue(request("stats-second", "stats-second", "运行统计二"));
		const stats = await until(
			() => runtime.stats(),
			(value) => value.active === 1 && value.pending === 1,
		);
		assert.deepEqual(stats, { active: 1, pending: 1, peakActive: 1, evalActive: 0 });
		await runtime.prepareOperation({
			id: "status-index",
			role: "decision",
			model: "fake",
			scope: { mode: "eval" },
			requestHash: "hash",
			input: { private_prompt: "large-private-prompt" },
		});
		const operation = await runtime.getOperation("status-index");
		assert.equal(operation.input.private_prompt, "large-private-prompt");
		await assert.rejects(runtime.getOperation("constructor"), hasCode("not_found"));
		const originalOperations = runtime.listOperations.bind(runtime);
		runtime.listOperations = async () => {
			throw new Error("状态摘要不应调用完整操作列表");
		};
		try {
			const summary = await runtime.operationStatusSummary();
			assert.deepEqual(summary.operation_counts, { prepared: 1 });
			assert.equal(summary.unknown_total, 0);
			assert.deepEqual(summary.operations, []);
			assert.equal(JSON.stringify(summary).includes("large-private-prompt"), false);
			const page = await runtime.pageOperations(1, 1, "prepared");
			assert.equal(page.total, 1);
			assert.equal(page.items[0].id, "status-index");
			assert.equal(JSON.stringify(page).includes("large-private-prompt"), false);
		} finally {
			runtime.listOperations = originalOperations;
		}
	} finally {
		runtime.list = originalList;
		gate.resolve();
	}
});

for (const limit of [5, 10]) {
	test(`真实 Durable task 的跨会话峰值不超过 ${limit}`, async (t) => {
		const gate = Promise.withResolvers<void>();
		t.after(() => gate.resolve());
		let active = 0;
		let peak = 0;
		const runtime = await fixture(t, {
			maxActiveRuns: limit,
			handler: async () => {
				active++;
				peak = Math.max(peak, active);
				await gate.promise;
				active--;
				return { status: "completed", result: { answer: "ok" } };
			},
		});
		const tasks: QueryTask[] = [];
		for (let n = 0; n < limit + 3; n++) tasks.push(await runtime.enqueue(request(`c${n}`)));
		await until(
			() => runtime.stats(),
			(value) => value.active === limit,
		);
		assert.equal(peak, limit);
		assert.equal((await runtime.stats()).pending, 3);
		gate.resolve();
		for (const task of tasks) await status(runtime, task.id, "completed");
		assert.equal((await runtime.stats()).peakActive, limit);
	});
}

test("同会话顺序，追问释放名额但普通问题不能越过待答任务", async (t) => {
	const started: string[] = [];
	const runtime = await fixture(t, {
		maxActiveRuns: 2,
		handler: async (task) => {
			started.push(task.question);
			if (task.question === "ask" && task.replies.length === 0)
				return {
					status: "waiting_for_user",
					clarification: { question: "按人数还是人次？", options: ["人数", "人次"] },
				};
			return { status: "completed", result: { replies: task.replies } };
		},
	});
	const first = await runtime.enqueue(request("same", "first", "ask"));
	const waiting = await status(runtime, first.id, "waiting_for_user");
	assert.equal((await runtime.stats()).active, 0);
	const later = await runtime.enqueue(request("same", "later", "later"));
	const independent = await runtime.enqueue(request("other", "other", "independent"));
	await status(runtime, independent.id, "completed");
	assert.equal((await runtime.get(later.id))!.status, "queued");
	assert.deepEqual(started, ["ask", "independent"]);
	await runtime.reply({
		turnId: first.id,
		submissionId: "answer1",
		clarificationId: waiting.clarification!.id,
		revision: waiting.clarification!.revision,
		answer: "人数",
	});
	await status(runtime, later.id, "completed");
	assert.deepEqual(started, ["ask", "independent", "ask", "later"]);
});

test("队列名额与回答原子接受，重复请求/回答不增占位，内容与版本冲突被拒绝", async (t) => {
	const usage = [{ role: "decision", input_tokens: 18, output_tokens: 5, status: "completed" }];
	const runtime = await fixture(t, {
		maxActiveRuns: 1,
		maxPending: 1,
		handler: async (task, signal, progress) => {
			if (task.question === "ask" && task.replies.length === 0) {
				await progress({ phase: "校验查询计划", linking: { tables: ["visits"] }, usage });
				return { status: "waiting_for_user", clarification: { question: "需要什么粒度？" } };
			}
			await sleep(10_000, undefined, { signal });
			return { status: "completed", result: null };
		},
	});
	const first = await runtime.enqueue(request("question", "ask", "ask"));
	const waiting = await status(runtime, first.id, "waiting_for_user");
	const blocking = await runtime.enqueue(request("blocking"));
	await status(runtime, blocking.id, "running");
	const queued = await runtime.enqueue(request("pending"));
	assert.equal((await runtime.enqueue(request("pending"))).id, queued.id);
	await assert.rejects(runtime.enqueue(request("pending", "pending", "different")), hasCode("request_conflict"));
	const reply = {
		turnId: first.id,
		submissionId: "reply",
		clarificationId: waiting.clarification!.id,
		revision: waiting.clarification!.revision,
		answer: "人数",
	};
	await assert.rejects(runtime.reply(reply), hasCode("queue_full"));
	assert.equal((await runtime.get(first.id))!.replies.length, 0);
	assert.equal((await runtime.get(first.id))!.status, "waiting_for_user");
	await runtime.cancel(queued.id);
	const accepted = await runtime.reply(reply);
	assert.equal(accepted.status, "queued");
	assert.deepEqual(accepted.progress, { usage }, "续问只继承累计模型用量，旧阶段与结果快照应清除");
	assert.equal((await runtime.reply(reply)).runId, accepted.runId);
	assert.equal((await runtime.stats()).pending, 1);
	await assert.rejects(runtime.reply({ ...reply, answer: "人次" }), hasCode("submission_conflict"));
	await assert.rejects(
		runtime.reply({ ...reply, submissionId: "other", revision: reply.revision + 1 }),
		hasCode("stale_clarification"),
	);
	await runtime.cancel(first.id);
	await runtime.cancel(blocking.id);
});

test("并发首次提交也不能把同一会话绑定到两个源", async (t) => {
	const runtime = await fixture(t, { handler: async () => ({ status: "completed", result: null }) });
	const outcomes = await Promise.allSettled([
		runtime.enqueue({ ...request("same", "a"), context: { source_id: "a" } }),
		runtime.enqueue({ ...request("same", "b"), context: { source_id: "b" } }),
	]);
	assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
	const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
	assert.ok(hasCode("source_conflict")(rejected.reason));
});

test("在线优先且评测子额度不扩大总额度", async (t) => {
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const started: string[] = [];
	const runtime = await fixture(t, {
		maxActiveRuns: 1,
		evalMaxActiveRuns: 1,
		handler: async (task) => {
			started.push(task.question);
			if (task.question === "block") await release.promise;
			return { status: "completed", result: null };
		},
	});
	const blocker = await runtime.enqueue(request("block"));
	await status(runtime, blocker.id, "running");
	const evaluation = await runtime.enqueue({ ...request("evaluation"), context: { mode: "eval" } });
	const online = await runtime.enqueue(request("online"));
	release.resolve();
	await status(runtime, evaluation.id, "completed");
	await status(runtime, online.id, "completed");
	assert.deepEqual(started, ["block", "online", "evaluation"]);
	assert.equal((await runtime.stats()).peakActive, 1);
});

test("取消信号已发送但 handler 未退出时不释放名额", async (t) => {
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	let firstSignal: AbortSignal | undefined;
	const started: string[] = [];
	const runtime = await fixture(t, {
		maxActiveRuns: 1,
		handler: async (task, signal) => {
			started.push(task.question);
			if (task.question === "first") {
				firstSignal = signal;
				await release.promise;
			}
			return { status: "completed", result: null };
		},
	});
	const first = await runtime.enqueue(request("first"));
	await until(async () => firstSignal, Boolean);
	const second = await runtime.enqueue(request("second"));
	const cancelled = runtime.cancel(first.id);
	await until(async () => firstSignal!.aborted, Boolean);
	assert.equal((await runtime.stats()).active, 1);
	assert.deepEqual(started, ["first"]);
	release.resolve();
	assert.equal((await cancelled).status, "cancelled");
	await status(runtime, second.id, "completed");
	assert.deepEqual(started, ["first", "second"]);
});

test("评测达到子额度时在线会话仍可使用剩余总额度", async (t) => {
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const started: string[] = [];
	const runtime = await fixture(t, {
		maxActiveRuns: 3,
		evalMaxActiveRuns: 1,
		handler: async (task) => {
			started.push(task.question);
			await release.promise;
			return { status: "completed", result: null };
		},
	});
	const evaluations: QueryTask[] = [];
	for (let index = 0; index < 3; index++)
		evaluations.push(await runtime.enqueue({ ...request(`eval${index}`), context: { mode: "eval" } }));
	const online = await runtime.enqueue(request("online"));
	await until(
		() => runtime.stats(),
		(value) => value.active === 2,
	);
	await until(
		async () => started.length,
		(value) => value === 2,
	);
	assert.equal((await runtime.stats()).evalActive, 1);
	assert.deepEqual(started, ["eval0", "online"]);
	release.resolve();
	for (const task of [...evaluations, online]) await status(runtime, task.id, "completed");
	assert.equal((await runtime.stats()).peakActive, 2);
});

test("排队超时不执行 handler；运行超时触发真实取消并释放容量", async (t) => {
	const started: string[] = [];
	const runtime = await fixture(t, {
		maxActiveRuns: 1,
		queueWaitTimeoutMs: 35,
		runTimeoutMs: 120,
		handler: async (task, signal) => {
			started.push(task.question);
			await sleep(10_000, undefined, { signal });
			return { status: "completed", result: null };
		},
	});
	const first = await runtime.enqueue(request("first"));
	await status(runtime, first.id, "running");
	const queued = await runtime.enqueue(request("queued"));
	assert.equal((await status(runtime, queued.id, "failed")).error!.code, "queue_timeout");
	assert.equal((await status(runtime, first.id, "failed")).error!.code, "run_timeout");
	assert.deepEqual(started, ["first"]);
	assert.equal((await runtime.stats()).active, 0);
});

test("部分交付失败保留已提交的数据及诊断", async (t) => {
	const runtime = await fixture(t, {
		handler: async (_task, _signal, progress) => {
			await progress({ phase: "answer", data_result: { rows: [[1]], complete: true } });
			return { status: "failed", error: "答案失败", result: { answer_status: "failed", rows: [[1]] } };
		},
	});
	const task = await runtime.enqueue(request("data"));
	const failed = await status(runtime, task.id, "failed");
	assert.equal(failed.error!.message, "答案失败");
	assert.deepEqual(failed.result, { answer_status: "failed", rows: [[1]] });
	assert.deepEqual(failed.progress, { phase: "answer", data_result: { rows: [[1]], complete: true } });
});

test("真实进程崩溃后恢复待答与排队任务，已发出运行标记中断而不重放", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "medical-crash-"));
	const storagePath = join(directory, "runtime.sqlite");
	// 子进程被强制结束，覆盖正常 close 无法模拟的已提交外部工作窗口。
	const script = `
		import { QueryRuntime } from './apps/medical-query/src/runtime.ts';
		const keepAlive = setInterval(() => {}, 10000);
		const runtime = await QueryRuntime.open({storagePath: ${JSON.stringify(storagePath)}, maxActiveRuns: 1,
			handler: async (task, signal, progress) => {
				if (task.question === 'ask') return {status:'waiting_for_user', clarification:{question:'条件？'}};
				await progress({model_calls:[{id:'live-call',status:'running',system_prompt:'实际测试提示词',user_prompt:'{}',duration_ms:0}],
					stages:[{id:'live-stage',kind:'decision',status:'running',started_at:Date.now()}]});
				return await new Promise(() => {});
			}});
		const wait = async (id, wanted) => { while ((await runtime.get(id)).status !== wanted) await new Promise(r=>setTimeout(r,5)); };
		const ask = await runtime.enqueue({conversationId:'waiting',requestId:'ask',question:'ask'});
		await wait(ask.id,'waiting_for_user');
		const answered = await runtime.enqueue({conversationId:'answered',requestId:'answered',question:'ask'});
		await wait(answered.id,'waiting_for_user');
		const active = await runtime.enqueue({conversationId:'work',requestId:'active',question:'active'});
		await wait(active.id,'running');
		while (!(await runtime.get(active.id)).progress) await new Promise(r=>setTimeout(r,5));
		const queued = await runtime.enqueue({conversationId:'work',requestId:'queued',question:'queued'});
		const clarification = (await runtime.get(answered.id)).clarification;
		await runtime.reply({turnId:answered.id,submissionId:'accepted',clarificationId:clarification.id,revision:clarification.revision,answer:'人数'});
		console.log(JSON.stringify({ask:ask.id,active:active.id,queued:queued.id,answered:answered.id}));
	`;
	const child = spawn(
		process.execPath,
		["--import", registerPath, "--conditions=source", "--input-type=module", "-e", script],
		{ cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await rm(directory, { recursive: true, force: true });
	});
	const timeoutController = new AbortController();
	const ready = await Promise.race([
		new Promise<string>((resolve, reject) => {
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += chunk.toString();
				if (output.includes("\n")) resolve(output.trim());
			});
			child.once("exit", (code) => {
				if (!output) reject(new Error(`child exit ${code}: ${stderr}`));
			});
		}),
		sleep(10_000, undefined, { signal: timeoutController.signal }).then(() => {
			throw new Error(`child startup timeout: ${stderr}`);
		}),
	]).finally(() => timeoutController.abort());
	const ids = JSON.parse(ready) as { ask: string; active: string; queued: string; answered: string };
	// 现有 owner 在另一个进程中；同进程集合无法提供这项保护。
	await assert.rejects(
		QueryRuntime.open({ storagePath, handler: async () => ({ status: "completed", result: null }) }),
		(error: unknown) =>
			typeof error === "object" && error !== null && "code" in error && error.code === "storage_in_use",
	);
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	const calls: string[] = [];
	const runtime = await QueryRuntime.open({
		storagePath,
		maxActiveRuns: 1,
		handler: async (task) => {
			calls.push(task.question);
			return { status: "completed", result: null };
		},
	});
	try {
		await status(runtime, ids.queued, "completed");
		const answered = await status(runtime, ids.answered, "completed");
		assert.equal(answered.replies.length, 1, "已接受的追问回答连同排队意图一起恢复");
		assert.equal(answered.replies[0].answer, "人数");
		assert.equal((await runtime.get(ids.active))!.status, "interrupted");
		// 崩溃只改变已有记录的状态，保留原文；实际终点未知，不编造跨停机时段的耗时。
		const interrupted = (await runtime.get(ids.active))!.progress as {
			model_calls: Record<string, unknown>[];
			stages: Record<string, unknown>[];
		};
		assert.equal(interrupted.model_calls[0].status, "interrupted");
		assert.equal(interrupted.model_calls[0].system_prompt, "实际测试提示词");
		assert.equal(interrupted.model_calls[0].duration_ms, undefined);
		assert.equal(interrupted.stages[0].status, "interrupted");
		assert.equal(interrupted.stages[0].duration_ms, undefined);
		const waiting = (await runtime.get(ids.ask))!;
		assert.equal(waiting.status, "waiting_for_user");
		assert.deepEqual(calls, ["ask", "queued"]);
		await runtime.reply({
			turnId: waiting.id,
			submissionId: "after-restart",
			clarificationId: waiting.clarification!.id,
			revision: waiting.clarification!.revision,
			answer: "已补充",
		});
		await status(runtime, waiting.id, "completed");
		assert.deepEqual(calls, ["ask", "queued", "ask"]);
	} finally {
		await runtime.close();
	}
	await assert.rejects(access(`${storagePath}.owner`), { code: "ENOENT" });
});

test("非法并发配置在打开存储前拒绝", async () => {
	await assert.rejects(
		QueryRuntime.open({
			storagePath: ":memory:",
			maxActiveRuns: 11,
			handler: async () => ({ status: "completed", result: null }),
		}),
		hasCode("invalid_config"),
	);
	await assert.rejects(
		QueryRuntime.open({
			storagePath: ":memory:",
			maxActiveRuns: 2,
			evalMaxActiveRuns: 3,
			handler: async () => ({ status: "completed", result: null }),
		}),
		hasCode("invalid_config"),
	);
});
