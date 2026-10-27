import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Application } from "../src/application.ts";
import { APP_ROOT, type AppConfig } from "../src/config.ts";
import { evaluationHttp } from "../src/evaluation/http.ts";
import type { Variant } from "../src/evaluation/service.ts";
import { freezeSource, runtimeConfiguration } from "../src/evaluation/snapshots.ts";
import { object } from "../src/model.ts";
import { QueryRuntime } from "../src/runtime.ts";

// 使用真实本地 HTTP/SSE、Pi 持久任务、Python SQLite 和独立评分进程，测试不访问付费模型。
async function setup(t: TestContext) {
	const dataDir = await mkdtemp(resolve(tmpdir(), "pi-evaluation-service-"));
	execFileSync("python3", [resolve(APP_ROOT, "python/build_fixtures.py"), "--output-dir", dataDir]);
	const db = new DatabaseSync(resolve(dataDir, "hospital-a.sqlite"), { readOnly: true });
	const expected = Number(db.prepare("SELECT count(DISTINCT patient_id) AS n FROM patients WHERE age>=65").get()!.n);
	db.close();
	const requests: string[] = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push(body);
		const output =
			body.includes("可引用的结果") || body.includes("facts")
				? { facts: [{ row: 0, column: "n" }] }
				: {
						action: "query",
						linking: { tables: ["patients"], fields: ["patients.patient_id", "patients.age"] },
						dsl: {
							from: "patients",
							select: [{ field: "patients.patient_id", aggregate: "count_distinct", as: "n" }],
							where: [{ field: "patients.age", op: "gte", value: 65 }],
						},
					};
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const base = { id: "local-eval", object: "chat.completion.chunk", created: 1, model: "deepseek-test" };
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
		apiKey: "local-test",
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		decisionModel: "deepseek-test",
		answerModel: "deepseek-test",
		maxActiveRuns: 5,
		llmMaxConcurrency: 5,
		evalMaxActiveRuns: 5,
		maxPending: 100,
		queueWaitTimeoutMs: 30000,
		llmTimeoutMs: 10000,
		runTimeoutMs: 30000,
		port: address.port,
		python: "python3",
		dataDir,
		installationLockPath: resolve(dataDir, "owner"),
		coordinatorStoragePath: resolve(dataDir, "runtime.sqlite"),
		// 现有端到端替身只覆盖计划与事实引用；渐进策略冻结由独立测试检查。
		retrievalStrategy: "lexical",
	};
	let app = await Application.open(config);
	t.after(async () => {
		await app.close();
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		await rm(dataDir, { recursive: true, force: true });
	});
	const questions = ["q1", "q2"].map((id) => ({
		id,
		source_id: "hospital-a",
		question: "65岁及以上患者有多少人？",
		as_of: "2026-10-15T12:00:00+08:00",
	}));
	const gold = questions.map((question) => ({
		...question,
		family_id: question.id,
		split: "dev",
		category: "synthetic_fact_query",
		expected_action: "answer",
		expected_rows: [{ n: expected }],
	}));
	const dataset = await app.evaluation.importDataset({
		idempotency_key: "dataset",
		questions_jsonl: questions.map((q) => JSON.stringify(q)).join("\n"),
		gold_jsonl: gold.map((q) => JSON.stringify(q)).join("\n"),
	});
	return {
		get app() {
			return app;
		},
		dataset,
		requests,
		config,
		reopen: async () => {
			await app.close();
			app = await Application.open(config);
		},
	};
}
async function until<T>(read: () => Promise<T> | T, ready: (value: T) => boolean, timeout = 30000): Promise<T> {
	const end = Date.now() + timeout;
	for (;;) {
		const value = await read();
		if (ready(value)) return value;
		assert.ok(Date.now() < end, `等待超时 ${JSON.stringify(value)}`);
		await delay(40);
	}
}

// 方案只冻结公开运行配置；切换默认后旧 variant 仍保持原来的策略与预算。
test("渐进检索可登记并冻结，旧策略对照保留独立默认候选预算", async (t) => {
	const env = await setup(t),
		service = env.app.evaluation;
	delete env.config.retrievalStrategy;
	delete env.config.retrievalTopK;
	const progressive = await service.createVariant({ name: "渐进默认", idempotency_key: "progressive-default" });
	assert.equal(progressive.retrieval_strategy, "progressive");
	assert.equal(progressive.retrieval_top_k, 5);
	assert.equal(runtimeConfiguration(env.config).retrieval_strategy, "progressive");
	assert.equal(runtimeConfiguration(env.config).retrieval_top_k, 5);
	for (const strategy of ["lexical", "full_catalog"] as const) {
		const control = await service.createVariant({
			name: strategy,
			idempotency_key: strategy,
			retrieval_strategy: strategy,
		});
		assert.equal(control.retrieval_strategy, strategy);
		assert.equal(control.retrieval_top_k, 12);
	}
	const explicit = await service.createVariant({
		name: "显式预算",
		idempotency_key: "progressive-explicit",
		retrieval_strategy: "progressive",
		retrieval_top_k: 3,
	});
	assert.equal(explicit.retrieval_top_k, 3);
	env.config.retrievalStrategy = "full_catalog";
	env.config.retrievalTopK = 20;
	assert.equal(service.store.get<Variant>("variant", progressive.id)!.data.retrieval_top_k, 5);
	assert.equal(service.store.get<Variant>("variant", explicit.id)!.data.retrieval_strategy, "progressive");
	assert.equal(env.requests.length, 0);
});

test("冻结实验去重、完整槽位与独立评分，公共模型输入不带gold，API共用记录", async (t) => {
	const env = await setup(t),
		service = env.app.evaluation;
	const variants = service.store.all<Variant>("variant").map((row) => row.id);
	const input = {
		idempotency_key: "run",
		name: "两题三方案",
		dataset_id: env.dataset.id,
		variant_ids: variants,
		repeats: 1,
		concurrency: 5,
	};
	const experiment = await service.createExperiment(input);
	assert.equal((await service.createExperiment(input)).id, experiment.id);
	await assert.rejects(service.createExperiment({ ...input, name: "冲突" }), { code: "idempotency_conflict" });
	assert.equal(service.slots(experiment.id).total, 6);
	const completed = await until(
		() => service.experiment(experiment.id),
		(value) => !!value.latest_score_set_id,
	);
	const report = object(
		service.store.get<Record<string, unknown>>("score_set", completed.latest_score_set_id!)!.data.report,
	);
	assert.equal(report.planned, 6);
	assert.equal(report.scored, 6);
	assert.equal(report.status, "valid");
	assert.equal(
		env.requests.some((body) => body.includes("expected_rows") || body.includes("family_id")),
		false,
	);
	const response = await evaluationHttp(
		"GET",
		new URL(`http://localhost/api/eval/experiments/${experiment.id}/score-sets`),
		{},
		env.app,
	);
	assert.equal(object(response?.value).total, 1);
	const exported = await service.exportExperiment(experiment.id);
	assert.equal(exported.slots.length, 6);
	assert.ok(exported.artifacts.every((artifact) => "content" in artifact));
	const scoreId = completed.latest_score_set_id;
	await env.reopen();
	assert.equal(env.app.evaluation.experiment(experiment.id).latest_score_set_id, scoreId);
	assert.equal((await env.app.evaluation.createExperiment(input)).id, experiment.id);
});

// 新评测只从真实评分和观察汇总，先筛全集再分页，逐题 gold 只在详情中出现。
test("新版评测摘要、逐题筛选和详情沿用冻结评分与观察", async (t) => {
	const env = await setup(t),
		service = env.app.evaluation;
	const variantId = service.store.all<Variant>("variant")[0].id;
	const run = await service.createExperiment({
		idempotency_key: "new-ui-summary",
		name: "评测列表筛选",
		dataset_id: env.dataset.id,
		variant_ids: [variantId],
		concurrency: 1,
	});
	assert.deepEqual(run.verdicts, { pass: 0, fail: 0, unknown: 0, unscored: 2 });
	assert.equal(run.accuracy.judged, null);
	assert.equal(run.accuracy.all, null);
	const before = service.questions(run.id, 1, 1, "unscored", "65岁");
	assert.equal(before.total, 2);
	assert.equal(before.items.length, 1);
	assert.equal(before.items[0].duration_ms, null);
	const filtered = service.listExperiments(1, 1, "评测列表", env.dataset.id, "deepseek-test");
	assert.equal(filtered.total, 1);
	assert.equal(filtered.running_total, 1);
	assert.equal(service.listExperiments(1, 1, "评测列表", env.dataset.id, "other-model").total, 0);
	const completed = await until(
		() => service.experiment(run.id),
		(value) => !!value.latest_score_set_id,
	);
	const scoreSet = service.store.get<{ scores: { status: string; evaluation_status: string }[] }>(
		"score_set",
		completed.latest_score_set_id!,
	)!.data;
	const pass = scoreSet.scores.filter((score) => score.evaluation_status === "valid" && score.status === "pass").length;
	const fail = scoreSet.scores.filter((score) => score.evaluation_status === "valid" && score.status === "fail").length;
	assert.equal(completed.verdicts.pass, pass);
	assert.equal(completed.verdicts.fail, fail);
	assert.equal(completed.verdicts.unknown + completed.verdicts.unscored, 2 - pass - fail);
	assert.equal(completed.accuracy.judged, pass + fail ? pass / (pass + fail) : null);
	assert.equal(completed.accuracy.all, pass / 2);
	const page = service.questions(run.id, 2, 1, "all", "q");
	assert.equal(page.total, 2);
	assert.equal(page.items.length, 1);
	assert.equal(page.items[0].case_id, "q2");
	const detail = await service.slot(page.items[0].id);
	assert.equal(detail.gold?.id, "q2");
	assert.equal(detail.observation_status, "available");
	const overview = service.overview(run.id);
	assert.equal(overview.total, 2);
	assert.equal(overview.evidence.observations, 2);
	assert.equal(overview.evidence.missing_artifacts, 0);
	assert.equal(overview.duration_ms.count, 2);
	assert.ok(overview.stage_durations.length > 0);
	assert.ok(overview.stage_durations.every((stage) => stage.count + stage.missing > 0));
	// 产物不可读时保留题次和 gold，但耗时与过程证据明确转为缺失。
	service.store.updateSlot({ ...service.store.slot(page.items[0].id)!, artifact_id: "missing-observation" });
	const missing = service.questions(run.id, 2, 1, "all", "q").items[0];
	assert.equal(missing.duration_ms, null);
	const missingDetail = await service.slot(missing.id);
	assert.equal(missingDetail.observation_status, "unreadable");
	assert.equal(missingDetail.gold?.id, "q2");
	const partial = service.overview(run.id);
	assert.equal(partial.evidence.unreadable_artifacts, 1);
	assert.equal(partial.duration_ms.missing, 1);
	// 跨越存储层一万条单次上限时，逐题筛选仍能找到最后一题且总数按全集计算。
	const originalSlots = service.store.slots.bind(service.store);
	const template = service.store.slot(page.items[0].id)!;
	const manySlots = Array.from({ length: 10001 }, (_, ordinal) => ({
		...template,
		id: `many-${ordinal}`,
		ordinal,
		case_id: ordinal === 10000 ? "q2" : "q1",
		artifact_id: undefined,
	}));
	service.store.slots = (_experiment, after = -1, limit = 100) =>
		manySlots.filter((slot) => slot.ordinal > after).slice(0, limit);
	try {
		const beyond = service.questions(run.id, 1, 1, "unscored", "q2");
		assert.equal(beyond.total, 1);
		assert.equal(beyond.items[0].id, "many-10000");
	} finally {
		service.store.slots = originalSlots;
	}
});

test("暂停意图跨重启不派发，取消持久屏障，续跑只派生原失败槽", async (t) => {
	const env = await setup(t);
	let service = env.app.evaluation;
	const variants = service.store.all<Variant>("variant").map((row) => row.id);
	const run = await service.createExperiment({
		idempotency_key: "pause",
		name: "暂停恢复",
		dataset_id: env.dataset.id,
		variant_ids: variants,
		repeats: 2,
	});
	await service.control(run.id, { command: "pause", idempotency_key: "pause-1", expected_revision: run.revision });
	await env.reopen();
	service = env.app.evaluation;
	await delay(500);
	assert.equal(env.requests.length, 0);
	let current = service.experiment(run.id);
	await service.control(run.id, {
		command: "cancel",
		idempotency_key: "cancel-1",
		expected_revision: current.revision,
	});
	current = await until(
		() => service.experiment(run.id),
		(value) => value.status === "cancelled",
	);
	const originalSlots = service.store.slots(run.id, -1, 10000);
	// 模拟已成功的不可重跑槽，用于验证恢复选择不会扩大成 case×variant 笛卡尔积。
	service.store.updateSlot({ ...originalSlots[0], status: "completed" });
	const child = await service.control(run.id, {
		command: "fork_retry",
		idempotency_key: "retry-1",
		expected_revision: service.experiment(run.id).revision,
	});
	const retrySlots = service.store.slots(child.id, -1, 10000);
	assert.equal(retrySlots.length, originalSlots.length - 1);
	assert.ok(retrySlots.every((slot) => slot.origin_slot_id && slot.origin_slot_id !== originalSlots[0].id));
	assert.equal(
		(
			await service.control(run.id, {
				command: "fork_retry",
				idempotency_key: "retry-1",
				expected_revision: current.revision,
			})
		).id,
		child.id,
	);
});

// 复现两个账本之间的断点：控制端已保存继续与幂等回执，Pi 的旧暂停仍未解除。
for (const recovery of ["同键重试", "重启恢复"] as const) {
	test(`继续意图提交后解除暂停失败，${recovery}完成原执行且旧暂停重试不回退状态`, async (t) => {
		const env = await setup(t);
		let service = env.app.evaluation;
		const run = await service.createExperiment({
			idempotency_key: "resume-window",
			name: "继续恢复断点",
			dataset_id: env.dataset.id,
			variant_ids: [service.store.all<Variant>("variant")[0].id],
		});
		const pause = { command: "pause", idempotency_key: "pause-window", expected_revision: run.revision };
		await service.control(run.id, pause);
		const resume = {
			command: "resume",
			idempotency_key: "resume-window",
			expected_revision: service.experiment(run.id).revision,
		};
		const applyPause = env.app.runtime.setExperimentPaused.bind(env.app.runtime);
		env.app.runtime.setExperimentPaused = async (id, paused) => {
			if (id === run.id && !paused) throw new Error("unpause-commit-unavailable");
			await applyPause(id, paused);
		};
		await assert.rejects(service.control(run.id, resume), /unpause-commit-unavailable/);
		assert.equal(service.experiment(run.id).status, "running");
		await service.tick();
		const queued = (await env.app.runtime.list()).filter((task) => task.context.experiment_id === run.id);
		assert.ok(queued.length > 0);
		assert.ok(queued.every((task) => task.status === "queued"));
		assert.equal(env.requests.length, 0);
		env.app.runtime.setExperimentPaused = applyPause;
		if (recovery === "重启恢复") {
			await env.reopen();
			service = env.app.evaluation;
		} else await service.control(run.id, resume);
		// 晚到的旧暂停请求只取原命令回执，运行控制必须服从当前继续意图。
		await service.control(run.id, pause);
		// completed 先于独立评分进程退出；使用本文件统一的有界观察窗口，不能把 5 秒当恢复 SLA。
		const completed = await until(
			() => {
				const failed = service.store
					.all<{ experiment_id: string; status: string; error?: string }>("score_job")
					.filter((job) => job.data.experiment_id === run.id && job.data.status === "failed");
				assert.deepEqual(failed, [], "评分失败必须立即暴露，不能由更长观察窗口掩盖");
				return service.experiment(run.id);
			},
			(value) => !!value.latest_score_set_id,
		);
		assert.equal(completed.status, "completed");
		assert.equal(completed.progress.completed, 2);
		assert.equal(completed.progress.scored, 2);
		const report = object(
			service.store.get<Record<string, unknown>>("score_set", completed.latest_score_set_id!)!.data.report,
		);
		assert.equal(report.planned, 2);
		assert.equal(report.scored, 2);
		assert.equal(report.status, "valid");
		assert.equal(env.requests.length, 4);
		assert.equal((await env.app.runtime.list()).filter((task) => task.context.experiment_id === run.id).length, 2);
		for (const task of queued) assert.equal((await env.app.runtime.get(task.id))!.status, "completed");
	});
}

test("重复解除暂停不延长队列期限，只有真实恢复转换重设期限", async (t) => {
	const dataDir = await mkdtemp(resolve(tmpdir(), "pi-resume-deadline-"));
	const runtime = await QueryRuntime.open({
		storagePath: resolve(dataDir, "runtime.sqlite"),
		installationLockPath: resolve(dataDir, "owner"),
		queueWaitTimeoutMs: 10000,
		handler: async () => ({ status: "waiting_for_user", clarification: { question: "保持同会话后续请求排队" } }),
	});
	t.after(async () => {
		await runtime.close();
		await rm(dataDir, { recursive: true, force: true });
	});
	const first = await runtime.enqueue({ conversationId: "serial", requestId: "first", question: "首轮" });
	await until(
		() => runtime.get(first.id),
		(task) => task?.status === "waiting_for_user",
	);
	const queued = await runtime.enqueue({
		conversationId: "serial",
		requestId: "queued",
		question: "后续排队",
		context: { mode: "eval", experiment_id: "deadline" },
	});
	await delay(20);
	await runtime.setExperimentPaused("deadline", false);
	assert.equal((await runtime.get(queued.id))!.queueDeadlineAt, queued.queueDeadlineAt);
	await runtime.setExperimentPaused("deadline", true);
	await delay(20);
	await runtime.setExperimentPaused("deadline", false);
	const resumedDeadline = (await runtime.get(queued.id))!.queueDeadlineAt;
	assert.ok(resumedDeadline > queued.queueDeadlineAt);
	await delay(20);
	await runtime.setExperimentPaused("deadline", false);
	assert.equal((await runtime.get(queued.id))!.queueDeadlineAt, resumedDeadline);
});

test("错误政策启动前拒绝，共享数据产物不能在活动实验删除", async (t) => {
	const env = await setup(t),
		service = env.app.evaluation;
	const variant = service.store.all<Variant>("variant")[0].id;
	const input = {
		idempotency_key: "bad-policy",
		name: "政策校验",
		dataset_id: env.dataset.id,
		variant_ids: [variant],
		quality_policy: {},
	};
	await assert.rejects(service.createExperiment(input), { code: "invalid_quality_policy" });
	assert.equal(env.requests.length, 0);
	const run = await service.createExperiment({ ...input, idempotency_key: "good-input", quality_policy: null });
	await service.control(run.id, { command: "pause", idempotency_key: "pause", expected_revision: run.revision });
	const registration = service.store.get<{ artifact_id: string }>("dataset", env.dataset.id)!.data;
	await assert.rejects(
		service.deleteArtifact(registration.artifact_id, {
			idempotency_key: "delete",
			owners: service.store.deletionImpact(registration.artifact_id),
			actor: "test",
			reason: "test",
		}),
		{ code: "artifact_in_use" },
	);
});

test("SQLite冻结包含未checkpoint的WAL且与后续写入隔离", async (t) => {
	const root = await mkdtemp(resolve(tmpdir(), "pi-snapshot-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = resolve(root, "live.sqlite"),
		db = new DatabaseSync(path);
	db.exec(
		"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE facts(n INTEGER); INSERT INTO facts VALUES(7)",
	);
	const snapshot = await freezeSource({ id: "facts", name: "facts", path }, root);
	db.exec("INSERT INTO facts VALUES(9)");
	db.close();
	const frozen = new DatabaseSync(snapshot.source.path, { readOnly: true });
	assert.deepEqual(
		frozen
			.prepare("SELECT n FROM facts")
			.all()
			.map((row) => row.n),
		[7],
	);
	frozen.close();
});
