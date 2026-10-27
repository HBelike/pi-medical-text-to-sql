import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Application } from "../src/application.ts";
import { APP_ROOT, type AppConfig } from "../src/config.ts";
import { type QualityReport, REQUIRED_SEVERE_CHECKS } from "../src/evaluation/comparison.ts";
import { evaluationHttp } from "../src/evaluation/http.ts";
import type { ScoreSet } from "../src/evaluation/scoring.ts";
import type { Experiment, Variant } from "../src/evaluation/service.ts";
import { EvaluationStore } from "../src/evaluation/store.ts";
import { object } from "../src/model.ts";

// 全链路使用本机 SSE 及合成 SQLite；回归关注控制/裁定，不把替身回答当真实模型成绩。
async function setup(
	context: TestContext,
	clarify = false,
	qualityPolicy?: Record<string, unknown>,
	strictComparison = false,
	scripted = false,
) {
	const dataDir = await mkdtemp(resolve(tmpdir(), "pi-evaluation-review-"));
	execFileSync("python3", [resolve(APP_ROOT, "python/build_fixtures.py"), "--output-dir", dataDir]);
	const requests: string[] = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push(body);
		const isAnswer = body.includes("可引用的结果") || body.includes("facts");
		const messages = object(JSON.parse(body)).messages as { role: string; content: string }[];
		const user =
			scripted && !isAnswer ? object(JSON.parse(messages.filter((item) => item.role === "user").at(-1)!.content)) : {};
		const hasReply = Array.isArray(user.replies) && user.replies.length > 0;
		const output =
			clarify || (scripted && !isAnswer && !hasReply)
				? { action: "clarify", question: "需要统计哪个年龄范围？", options: ["65岁及以上"], slots: ["年龄范围"] }
				: isAnswer
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
		const base = { id: "local-review", object: "chat.completion.chunk", created: 1, model: "deepseek-test" };
		response.write(
			`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(output) }, finish_reason: null }] })}\n\n`,
		);
		response.end(
			`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const config: AppConfig = {
		apiKey: "local-only",
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		decisionModel: "deepseek-test",
		answerModel: "deepseek-test",
		maxActiveRuns: 5,
		llmMaxConcurrency: 5,
		evalMaxActiveRuns: 5,
		maxPending: 50,
		queueWaitTimeoutMs: 10000,
		llmTimeoutMs: 10000,
		runTimeoutMs: 20000,
		port: address.port,
		python: "python3",
		dataDir,
		installationLockPath: resolve(dataDir, "owner"),
		coordinatorStoragePath: resolve(dataDir, "runtime.sqlite"),
		// 控制、裁定及发布回归使用固定两阶段替身，选表策略变化由独立用例验证。
		retrievalStrategy: "lexical",
	};
	const app = await Application.open(config);
	context.after(async () => {
		await app.close();
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		await rm(dataDir, { recursive: true, force: true });
	});
	const question = {
		id: "review-q1",
		source_id: "hospital-a",
		question: scripted ? "患者有多少人？" : "65岁及以上患者有多少人？",
		as_of: "2026-10-15T12:00:00+08:00",
	};
	const gold = clarify
		? {
				...question,
				family_id: "age",
				split: "dev",
				category: "clarification",
				expected_action: "clarify",
				required_clarifications: ["年龄范围"],
			}
		: {
				...question,
				family_id: "age",
				split: "dev",
				category: "synthetic_fact_query",
				expected_action: "answer",
				expected_rows: [{ n: 3 }],
				check_profile: "task_complete",
				semantic_contract: {
					assertions: [{ id: "source", path: "turn.evidence.source_id", op: "equals", expected: "hospital-a" }],
				},
				answer_contract: {
					assertions: [{ id: "summary", path: "turn.answer", op: "includes", expected: "本次查询返回 1 行" }],
				},
				process_contract: { assertions: [{ id: "no-write", path: "turn.evidence.write_attempt", op: "absent" }] },
			};
	const dataset = await app.evaluation.importDataset({
		idempotency_key: "dataset",
		questions_jsonl: JSON.stringify(question),
		gold_jsonl: JSON.stringify(gold),
	});
	const variants = app.evaluation.store.all<Variant>("variant");
	const variant = variants.find((item) => item.data.repair_limit === 0)!;
	// 三组通过真实创建入口冻结，仅明确允许修复策略和次数不同，不伪造实际模型 revision。
	const comparisonProtocol = strictComparison
		? {
				arms: variants.map((item) => ({
					variant_id: item.id,
					kind: { off: "repair_off", targeted: "repair_on", ordinary_retry: "ordinary_retry" }[item.data.repair_policy],
				})),
				allowed_differences: [
					{ path: "repair_policy", values: ["off", "targeted", "ordinary_retry"] },
					{ path: "repair_limit", values: [0, 1] },
				],
			}
		: undefined;
	const experiment = await app.evaluation.createExperiment({
		idempotency_key: "experiment",
		name: "只读审查回归",
		dataset_id: dataset.id,
		variant_ids: strictComparison ? variants.map((item) => item.id) : [variant.id],
		quality_policy: qualityPolicy,
		comparison_protocol: comparisonProtocol,
		...(scripted ? { reply_scripts: { [question.id]: ["65岁及以上"] } } : {}),
	});
	return { app, requests, experiment, dataset };
}

async function complete(app: Application, id: string) {
	const deadline = Date.now() + 20000;
	for (;;) {
		const value = app.evaluation.experiment(id);
		if (value.latest_score_set_id) return value;
		assert.ok(
			Date.now() < deadline,
			`实验未完成评分：${value.status} ${JSON.stringify(value.progress)}；槽位 ${JSON.stringify(app.evaluation.store.slots(id, -1, 10))}；评分 ${JSON.stringify(app.evaluation.store.all("score_job"))}`,
		);
		await delay(30);
	}
}

test("单轮澄清保存观察并结束实验，不替用户答复或把等待永久计入未完成", async (context) => {
	const env = await setup(context, true);
	const experiment = await complete(env.app, env.experiment.id);
	assert.equal(experiment.status, "completed");
	const slot = env.app.evaluation.store.slots(experiment.id, -1, 10)[0];
	assert.equal(slot.status, "waiting_for_user");
	assert.ok(slot.artifact_id);
	assert.equal(env.requests.length, 1);
	const task = await env.app.runtime.get(slot.turn_id!);
	assert.equal(task!.replies.length, 0);
	const report = env.app.evaluation.store.get<{ report: { planned: number; scored: number } }>(
		"score_set",
		experiment.latest_score_set_id!,
	)!.data.report;
	assert.deepEqual([report.planned, report.scored], [1, 1]);
	await assert.rejects(env.app.evaluation.reply(slot.id, { idempotency_key: "late-answer", answer: "65岁及以上" }));
});

test("裁定拒绝过期修订与评分档位/轨道/拆分变更，旧 gold 与观察保持不变", async (context) => {
	const env = await setup(context);
	const completed = await complete(env.app, env.experiment.id);
	const slot = env.app.evaluation.store.slots(completed.id, -1, 10)[0];
	assert.ok(slot.artifact_id);
	const before = env.app.evaluation.dataset(env.dataset.id),
		callsBefore = env.requests.length;
	const command = {
		experiment_id: completed.id,
		slot_id: slot.id,
		actor: "test-reviewer",
		reason: "验证不能事后降档",
		expected_revision: completed.revision,
	};
	await assert.rejects(
		env.app.evaluation.adjudicate({
			...command,
			idempotency_key: "stale",
			expected_revision: completed.revision - 1,
			revised_gold: { expected_rows: [{ n: 4 }] },
		}),
		{ code: "revision_conflict" },
	);
	for (const [key, value] of Object.entries({
		check_profile: "result_only",
		category: "another_track",
		family_id: "different-family",
		split: "holdout",
	})) {
		await assert.rejects(
			env.app.evaluation.adjudicate({ ...command, idempotency_key: `change-${key}`, revised_gold: { [key]: value } }),
		);
	}
	assert.equal(env.app.evaluation.dataset(env.dataset.id).hash, before.hash);
	const current = env.app.evaluation.store.get<Experiment>("experiment", completed.id)!.data;
	assert.equal(current.scoring_dataset_id, undefined);
	assert.equal(env.app.evaluation.store.slot(slot.id)!.artifact_id, slot.artifact_id);
	assert.equal(env.requests.length, callsBefore);
});

test("发布与激活 API 绑定质量决定，报告替身只验证门禁契约不代表业务验收", async (context) => {
	const policy = {
		id: "frozen-contract-policy",
		thresholds: [{ track: "synthetic_fact_query", minimum_pass_rate: 1, minimum_cases: 1, profile: "task_complete" }],
		severe_checks: REQUIRED_SEVERE_CHECKS.map((check_id) => ({ check_id, minimum_samples: 1 })),
	};
	const env = await setup(context, false, policy);
	const experiment = await complete(env.app, env.experiment.id);
	const variantId = experiment.variant_ids[0];
	const actual = env.app.evaluation.store.get<
		ScoreSet & {
			experiment_id: string;
			report: QualityReport;
			variant_reports: Record<string, QualityReport>;
			observation_ids: string[];
		}
	>("score_set", experiment.latest_score_set_id!)!.data;
	assert.equal(actual.scores[0].profile, "task_complete");
	assert.equal(actual.scores[0].status, "pass", JSON.stringify(actual.scores[0].checks));
	const base = { experiment_id: experiment.id, variant_id: variantId, expected_revision: experiment.revision };
	const call = (path: string, body: Record<string, unknown>) =>
		evaluationHttp("POST", new URL(`http://localhost/api/eval/${path}`), body, env.app);
	const insufficient = object(
		(await call("release-decisions", { ...base, score_set_id: actual.id, idempotency_key: "insufficient" }))!.value,
	);
	assert.equal(insufficient.status, "evidence_insufficient", "单应答样本没有正式阻断覆盖，必须拒绝自动放行");
	await assert.rejects(
		call("activations", {
			release_decision_id: insufficient.id,
			idempotency_key: "deny-activation",
			actor: "tester",
			reason: "不能激活缺证据决定",
		}),
		{ code: "release_denied" },
	);
	// 只为 API 政策状态机补入手写覆盖回执，不将它记录为真实指标/模型成绩。
	const approvedReport: QualityReport = {
		...actual.variant_reports[variantId],
		checks: {
			...actual.variant_reports[variantId].checks,
			blocked_boundary: { applicable: 1, passed: 1, failed: 0, unevaluated: 0, severity: "critical" },
		},
		cost: 1000000,
		duration_ms: 1000000,
	};
	const approved = {
		...actual,
		id: "contract-fixture-approved",
		report: approvedReport,
		variant_reports: { [variantId]: approvedReport },
	};
	env.app.evaluation.store.immutable("score_set", approved.id, approved);
	const allowed = object(
		(await call("release-decisions", { ...base, score_set_id: approved.id, idempotency_key: "allow" }))!.value,
	);
	assert.equal(allowed.status, "allow");
	const activation = object(
		(await call("activations", {
			release_decision_id: allowed.id,
			idempotency_key: "activate",
			actor: "tester",
			reason: "验证精确方案激活",
		}))!.value,
	);
	assert.equal(activation.variant_id, variantId);
	assert.equal(env.app.evaluation.activeVariant()?.id, variantId);
	// 同一实际激活入口的记录必须进入导出闭包；报告替身仅检验可追踪关系，仍不充当质量验收。
	const activationExport = await env.app.evaluation.exportExperiment(experiment.id);
	assert.ok(activationExport.release_decisions.some((record) => record.id === allowed.id));
	assert.ok(activationExport.activations.some((record) => record.id === activation.id));
	assert.equal(activationExport.active_activation_id, activation.id);
	assert.ok(activationExport.score_sets.some((record) => record.id === approved.id));

	assert.equal(
		object(
			(await call("activations", {
				release_decision_id: allowed.id,
				idempotency_key: "activate",
				actor: "tester",
				reason: "验证精确方案激活",
			}))!.value,
		).id,
		activation.id,
	);
	const deniedReport: QualityReport = {
		...approvedReport,
		checks: {
			...approvedReport.checks,
			unlisted_critical: { applicable: 1, passed: 0, failed: 1, unevaluated: 0, severity: "critical" },
		},
	};
	const deniedScore = {
		...actual,
		id: "contract-fixture-denied",
		report: deniedReport,
		variant_reports: { [variantId]: deniedReport },
	};
	env.app.evaluation.store.immutable("score_set", deniedScore.id, deniedScore);
	assert.equal(
		object(
			(await call("release-decisions", { ...base, score_set_id: deniedScore.id, idempotency_key: "deny-critical" }))!
				.value,
		).status,
		"deny",
	);
});

test("原始 publication 归档往返保留字段顺序和既有结果字节指纹", async (context) => {
	const directory = await mkdtemp(resolve(tmpdir(), "pi-publication-roundtrip-"));
	const store = new EvaluationStore(directory, 0);
	context.after(async () => {
		store.close();
		await rm(directory, { recursive: true, force: true });
	});
	// 故意使用非字母序字段，避免只用已排序样本漏掉重新序列化造成的证据变更。
	const result = {
		rows: [[7]],
		sql: "SELECT 7 AS n",
		columns: ["n"],
		parameters: [],
		complete: true,
		truncated: false,
		row_count: 1,
		total: 1,
	};
	const publication = {
		result,
		result_hash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
		status: "published",
	};
	const id = store.artifact({ publication }, "observation", "experiment:roundtrip");
	const restored = store.readArtifact<{ publication: typeof publication }>(id);
	assert.equal(JSON.stringify(restored.publication.result), JSON.stringify(result));
	assert.equal(
		createHash("sha256").update(JSON.stringify(restored.publication.result)).digest("hex"),
		restored.publication.result_hash,
	);
});

test("冻结发布后模型端点改变，旧决定激活被拒绝且不发新请求", async (context) => {
	const env = await setup(context, true);
	const experiment = await complete(env.app, env.experiment.id);
	const score = env.app.evaluation.store.get<{ scoring_execution_hash: string }>(
		"score_set",
		experiment.latest_score_set_id!,
	)!.data;
	// 此回执只隔离验证激活身份守卫；不宣称一条澄清样本足够支持真实质量放行。
	const decision = {
		id: "contract-fixture-runtime-binding",
		status: "allow",
		experiment_id: experiment.id,
		variant_id: experiment.variant_ids[0],
		score_set_id: experiment.latest_score_set_id,
		execution_hash: experiment.execution_hash,
		scoring_execution_hash: score.scoring_execution_hash,
	};
	env.app.evaluation.store.immutable("release_decision", decision.id, decision);
	const requestsBefore = env.requests.length;
	const originalEndpoint = env.app.config.baseUrl;
	// 只改本地配置对象模拟重启后端点漂移，不向这个地址发请求。
	env.app.config.baseUrl = `${originalEndpoint}/different-provider`;
	try {
		await assert.rejects(
			evaluationHttp(
				"POST",
				new URL("http://localhost/api/eval/activations"),
				{
					release_decision_id: decision.id,
					idempotency_key: "changed-runtime-activation",
					actor: "tester",
					reason: "禁止旧端点评分决定激活新端点",
				},
				env.app,
			),
			{ code: "runtime_configuration_changed" },
		);
		assert.equal(env.app.evaluation.store.all("activation").length, 0);
		assert.equal(env.app.evaluation.activeVariant(), undefined);
		assert.equal(env.requests.length, requestsBefore);
	} finally {
		env.app.config.baseUrl = originalEndpoint;
	}
});

test("严格三组比较拒绝裁定后已失效的旧评分，不创建比较记录", async (context) => {
	const env = await setup(context, true, undefined, true);
	const experiment = await complete(env.app, env.experiment.id);
	assert.equal(experiment.comparison_protocol?.arms.length, 3);
	assert.equal(env.app.evaluation.store.slots(experiment.id, -1, 10).length, 3);
	const requestsBefore = env.requests.length;
	// 模拟裁定已提交、重评尚未完成的窗口，旧观察及分数保留但不再具有对比资格。
	env.app.evaluation.store.put("applicability", experiment.latest_score_set_id!, {
		status: "regrade_required",
		adjudication_id: "contract-fixture-adjudication",
	});
	await assert.rejects(
		evaluationHttp(
			"POST",
			new URL("http://localhost/api/eval/comparisons"),
			{ experiment_id: experiment.id, idempotency_key: "invalidated-strict-comparison" },
			env.app,
		),
		{ code: "evidence_invalidated" },
	);
	assert.equal(env.app.evaluation.store.all("comparison").length, 0);
	assert.equal(env.requests.length, requestsBefore);
	assert.ok(env.app.evaluation.store.get("score_set", experiment.latest_score_set_id!));
});

test("评分运行中裁定新 gold，旧结果保留并自动接续当前 gold 重评", async (context) => {
	const env = await setup(context);
	const initial = await complete(env.app, env.experiment.id);
	const service = env.app.evaluation;
	const slot = service.store.slots(initial.id, -1, 10)[0];
	const originalScore = service.store.get<ScoreSet>("score_set", initial.latest_score_set_id!)!.data;
	const callsBefore = env.requests.length;
	let enterCatalog!: () => void;
	let releaseCatalog!: () => void;
	const entered = new Promise<void>((done) => {
		enterCatalog = done;
	});
	const released = new Promise<void>((done) => {
		releaseCatalog = done;
	});
	const originalCall = env.app.domain.call.bind(env.app.domain);
	let intercepted = false;
	// 固定在评分已冻结旧 gold、尚未读取目录的断点，不依赖 CPU 速度制造竞态。
	context.mock.method(env.app.domain, "call", async (...args: Parameters<typeof originalCall>) => {
		if (args[1] === "catalog" && !intercepted) {
			intercepted = true;
			enterCatalog();
			await released;
		}
		return originalCall(...args);
	});
	let adjudication: { new_dataset_id: string };
	const oldJob = await service.grade(initial.id, {
		idempotency_key: "manual-before-adjudication",
		expected_revision: initial.revision,
	});
	try {
		await Promise.race([entered, delay(5000).then(() => assert.fail("评分未到达预定断点"))]);
		adjudication = await service.adjudicate({
			experiment_id: initial.id,
			slot_id: slot.id,
			idempotency_key: "adjudication-during-grading",
			expected_revision: service.experiment(initial.id).revision,
			actor: "test-reviewer",
			reason: "仅验证旧评分在途时的新口径调度，不认定这是正确业务答案",
			revised_gold: { expected_rows: [{ n: 4 }] },
		});
		assert.equal(service.experiment(initial.id).scoring_dataset_id, adjudication.new_dataset_id);
		assert.equal(service.store.get<{ status: string }>("score_job", oldJob.id)!.data.status, "running");
	} finally {
		releaseCatalog();
	}
	const targetHash = service.dataset(adjudication!.new_dataset_id).hash;
	const deadline = Date.now() + 12000;
	let currentScore: ScoreSet | undefined;
	for (;;) {
		const current = service.experiment(initial.id);
		currentScore = current.latest_score_set_id
			? service.store.get<ScoreSet>("score_set", current.latest_score_set_id)?.data
			: undefined;
		if (currentScore?.gold_hash === targetHash && !service.store.get("applicability", currentScore.id)) break;
		assert.ok(
			Date.now() < deadline,
			`新 gold 未自动重评：${JSON.stringify({ targetHash, latest: currentScore?.gold_hash, jobs: service.store.all("score_job") })}`,
		);
		await delay(40);
	}
	assert.equal(currentScore.scores[0].status, "fail", "重评应按新 gold 判定，不能沿用旧 pass");
	assert.deepEqual(service.store.get<ScoreSet>("score_set", originalScore.id)!.data, originalScore);
	assert.equal(service.store.slot(slot.id)!.artifact_id, slot.artifact_id);
	const completedOldJob = service.store.get<{ status: string; score_set_id: string }>("score_job", oldJob.id)!.data;
	assert.equal(completedOldJob.status, "completed");
	assert.equal(
		service.store.get<{ status: string }>("applicability", completedOldJob.score_set_id)!.data.status,
		"regrade_required",
	);
	assert.equal(env.requests.length, callsBefore, "裁定及新旧重评不得重新调用问数模型");
});

test("Pi 已接受回复但控制回执未提交时，同键重试使用原追问身份且不重复派发", async (context) => {
	const env = await setup(context, true);
	const service = env.app.evaluation;
	const tick = service.tick.bind(service);
	// 人工推进控制端轮询，把第一次回复固定在单轮观察封存之前；业务 Pi 与模型仍真实运行。
	context.mock.method(service, "tick", async () => {});
	await tick();
	const slot = service.store.slots(env.experiment.id, -1, 10)[0];
	assert.ok(slot.turn_id);
	const waitForClarification = async (revision: number) => {
		const deadline = Date.now() + 10000;
		for (;;) {
			const task = await env.app.runtime.get(slot.turn_id!);
			if (task?.status === "waiting_for_user" && task.clarification?.revision === revision) return task;
			assert.ok(Date.now() < deadline, `追问 ${revision} 未就绪：${task?.status}`);
			await delay(20);
		}
	};
	const first = await waitForClarification(1);
	const input = { idempotency_key: "reply-before-receipt", answer: "65岁及以上", revision: 1 };
	const commandKey = `reply:${slot.id}:${input.idempotency_key}`;
	const finishCommand = service.store.finishCommand.bind(service.store);
	let failReceipt = true;
	context.mock.method(service.store, "finishCommand", (...args: Parameters<typeof finishCommand>) => {
		// 此时 Pi 的回复账本已提交，故障只阻断控制账本回执，模拟两账本之间的进程崩溃窗口。
		if (args[0] === commandKey && failReceipt) {
			failReceipt = false;
			throw new Error("reply-receipt-commit-failed");
		}
		return finishCommand(...args);
	});
	await assert.rejects(service.reply(slot.id, input), /reply-receipt-commit-failed/);
	assert.equal(service.store.command(commandKey, input), undefined);
	const second = await waitForClarification(2);
	assert.equal(second.replies.length, 1);
	assert.equal(second.replies[0].clarificationId, first.clarification!.id);
	assert.notEqual(second.clarification!.id, first.clarification!.id);
	assert.equal(second.replies[0].revision, 1);
	await tick();
	assert.equal(service.experiment(env.experiment.id).status, "completed");
	const requestsBefore = env.requests.length;
	const recovered = await service.reply(slot.id, input);
	assert.equal(recovered.id, slot.turn_id);
	assert.equal(service.store.command<{ id: string }>(commandKey, input)?.id, slot.turn_id);
	assert.equal((await env.app.runtime.get(slot.turn_id!))!.replies.length, 1);
	assert.equal(env.requests.length, requestsBefore, "恢复控制回执不能重复进入模型链路");
	assert.deepEqual(await service.reply(slot.id, input), JSON.parse(JSON.stringify(recovered)));
	await assert.rejects(service.reply(slot.id, { ...input, answer: "18岁及以上" }), { code: "idempotency_conflict" });
});

test("控制 HTTP 已接受实验但响应断开，同键网络重试只创建一个实验和业务请求", async (context) => {
	const env = await setup(context, true);
	await complete(env.app, env.experiment.id);
	const requestsBefore = env.requests.length;
	const service = env.app.evaluation;
	const input = {
		idempotency_key: "network-response-lost",
		name: "接收后断线",
		dataset_id: env.dataset.id,
		variant_ids: env.experiment.variant_ids,
	};
	let acceptedId: string | undefined;
	let incoming = 0;
	const server = createServer(async (request, response) => {
		try {
			let content = "";
			for await (const chunk of request) content += chunk;
			const result = await evaluationHttp(
				"POST",
				new URL("http://localhost/api/eval/experiments"),
				JSON.parse(content),
				env.app,
			);
			assert.ok(result);
			incoming++;
			if (incoming === 1) {
				// 故障发生在持久命令已完成之后、任何 HTTP 响应字节发出之前。
				acceptedId = String(object(result.value).id);
				response.destroy();
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(result.value));
		} catch (error) {
			response.writeHead(500, { "Content-Type": "text/plain" });
			response.end(String(error));
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	context.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	});
	const send = () =>
		fetch(`http://127.0.0.1:${address.port}/api/eval/experiments`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
	await assert.rejects(send(), /fetch failed/);
	assert.ok(acceptedId);
	assert.equal(service.store.command<{ id: string }>(`experiment:${input.idempotency_key}`, input)?.id, acceptedId);
	const response = await send();
	assert.equal(response.status, 200);
	const recovered = object(await response.json());
	assert.equal(recovered.id, acceptedId);
	assert.equal(service.store.all("experiment").length, 2, "只包含 setup 实验和这次断线实验");
	assert.equal(service.store.slots(acceptedId, -1, 10).length, 1);
	await complete(env.app, acceptedId);
	const task = await env.app.runtime.get(service.store.slots(acceptedId, -1, 10)[0].turn_id!);
	assert.ok(task);
	assert.equal((await env.app.runtime.list(task.conversationId)).length, 1);
	assert.equal(service.store.allEvents(acceptedId).filter((event) => event.type === "dispatched").length, 1);
	assert.equal(env.requests.length, requestsBefore + 1);
});

test("导出分别标记正文损坏、意外缺失与手动删除，不混淆证据失效原因", async (context) => {
	const env = await setup(context, true);
	const experiment = await complete(env.app, env.experiment.id);
	const service = env.app.evaluation;
	const slot = service.store.slots(experiment.id, -1, 10)[0];
	assert.ok(slot.artifact_id);
	const id = slot.artifact_id;
	const path = resolve(service.store.root, "artifacts", `${id}.json`);
	const original = await readFile(path);
	const callsBefore = env.requests.length;
	// 直接改变本机测试文件，验证导出使用实际 hash / 文件 / tombstone，而不是统一吞成已删除。
	await writeFile(path, JSON.stringify({ corrupt: true }));
	let exported = await service.exportExperiment(experiment.id);
	assert.deepEqual(
		exported.artifacts.map((artifact) => [artifact.id, object(artifact).completeness]),
		[[id, "artifact_corrupt"]],
	);
	assert.equal(service.store.artifacts().find((artifact) => artifact.id === id)!.deleted_at, null);
	await rm(path);
	exported = await service.exportExperiment(experiment.id);
	assert.deepEqual(
		exported.artifacts.map((artifact) => [artifact.id, object(artifact).completeness]),
		[[id, "artifact_missing"]],
	);
	assert.equal(service.store.artifacts().find((artifact) => artifact.id === id)!.deleted_at, null);
	await writeFile(path, original);
	await service.deleteArtifact(id, {
		idempotency_key: "delete-export-observation",
		owners: service.store.deletionImpact(id),
		actor: "test-reviewer",
		reason: "验证有意删除与意外缺失的区别",
	});
	exported = await service.exportExperiment(experiment.id);
	assert.deepEqual(
		exported.artifacts.map((artifact) => [artifact.id, object(artifact).completeness]),
		[[id, "artifact_deleted"]],
	);
	assert.ok(service.store.artifacts().find((artifact) => artifact.id === id)!.deleted_at);
	assert.equal(exported.evidence_status, "incomplete");
	assert.ok(exported.deletion_events.some((event) => event.entity_id === id));
	// 私有 gold 也是重评必需证据，不允许观察完整就声称整包完整。
	const registration = service.store.get<{ artifact_id: string }>("dataset", env.dataset.id)!;
	const goldId = registration.data.artifact_id;
	const goldPath = resolve(service.store.root, "artifacts", `${goldId}.json`);
	const goldBytes = await readFile(goldPath);
	await writeFile(goldPath, "{}");
	exported = await service.exportExperiment(experiment.id);
	assert.equal(exported.artifact_manifest.find((entry) => entry.id === goldId)!.completeness, "artifact_corrupt");
	await rm(goldPath);
	exported = await service.exportExperiment(experiment.id);
	assert.equal(exported.dependency_artifacts.find((entry) => entry.id === goldId)!.completeness, "artifact_missing");
	await writeFile(goldPath, goldBytes);
	await service.deleteArtifact(goldId, {
		idempotency_key: "delete-export-gold",
		owners: service.store.deletionImpact(goldId),
		actor: "test-reviewer",
		reason: "验证删除标准答案后仍保留原版本关联",
	});
	exported = await service.exportExperiment(experiment.id);
	assert.equal(exported.artifact_manifest.find((entry) => entry.id === goldId)!.completeness, "artifact_deleted");
	assert.equal(exported.datasets[0].artifact_id, goldId);
	assert.equal(exported.evidence_status, "incomplete");
	// 注册行损坏是独立记录缺口，不能因为正文已经 tombstone 就吞掉缺失身份。
	service.store.db.prepare("DELETE FROM objects WHERE kind='dataset' AND id=?").run(env.dataset.id);
	exported = await service.exportExperiment(experiment.id);
	assert.ok(
		exported.record_manifest.some(
			(entry) => entry.kind === "dataset" && entry.id === env.dataset.id && entry.status === "record_missing",
		),
	);

	assert.equal(env.requests.length, callsBefore);
});

test("冻结多轮脚本实际完成澄清、回复、查询与评分，错题脚本和错追问版本被拒绝", async (context) => {
	const env = await setup(context, false, undefined, false, true);
	const experiment = await complete(env.app, env.experiment.id);
	const service = env.app.evaluation;
	assert.deepEqual(experiment.reply_scripts, { "review-q1": ["65岁及以上"] });
	const slot = service.store.slots(experiment.id, -1, 10)[0];
	assert.equal(slot.status, "completed");
	const task = (await env.app.runtime.get(slot.turn_id!))!;
	assert.equal(task.replies.length, 1);
	assert.equal(task.replies[0].answer, "65岁及以上");
	assert.equal(task.replies[0].submissionId, `${slot.request_id}-reply-0`);
	assert.equal(task.replies[0].revision, 1);
	assert.equal(env.requests.length, 3, "两次决策加一次答案，脚本回复不应额外重跑");
	const score = service.store.get<ScoreSet>("score_set", experiment.latest_score_set_id!)!.data;
	assert.equal(score.scores[0].profile, "task_complete");
	assert.equal(score.scores[0].status, "pass", JSON.stringify(score.scores[0].checks));
	assert.ok(score.scores[0].checks.some((check) => check.check_id === "publication" && check.status === "pass"));
	const messages = env.requests.map((raw) => object(JSON.parse(raw)).messages as { role: string; content: string }[]);
	const first = object(JSON.parse(messages[0].filter((item) => item.role === "user").at(-1)!.content));
	const second = object(JSON.parse(messages[1].filter((item) => item.role === "user").at(-1)!.content));
	assert.deepEqual(first.replies, []);
	assert.equal(object((second.replies as unknown[])[0]).answer, "65岁及以上");
	assert.ok(env.requests.every((raw) => !raw.includes("expected_rows") && !raw.includes("semantic_contract")));
	const callsBefore = env.requests.length;
	// 已选题目与脚本绑定在创建时验证；不能把另一个 case 的回答悄悄套到当前问题。
	await assert.rejects(
		service.createExperiment({
			idempotency_key: "misaligned-script",
			name: "错误题目脚本",
			dataset_id: env.dataset.id,
			variant_ids: experiment.variant_ids,
			reply_scripts: { "other-case": ["65岁及以上"] },
		}),
		{ code: "invalid_script" },
	);
	// Pi 的回复幂等身份包含原追问版本；已经接受的脚本键不能被第二个追问身份复用。
	await assert.rejects(
		env.app.runtime.reply({
			turnId: task.id,
			submissionId: task.replies[0].submissionId,
			clarificationId: "different-clarification",
			revision: 2,
			answer: "65岁及以上",
		}),
		{ code: "submission_conflict" },
	);
	assert.equal(service.store.all("experiment").length, 1);
	assert.equal((await env.app.runtime.get(task.id))!.replies.length, 1);
	assert.equal(env.requests.length, callsBefore);
});

test("导出保留原始与裁定 gold、评分父链和跨实验引用，排除无关私有证据", async (context) => {
	const env = await setup(context, true, undefined, true);
	const service = env.app.evaluation;
	const first = await complete(env.app, env.experiment.id);
	const originalScoreId = first.latest_score_set_id!;
	const strictComparison = await service.compare({
		experiment_id: first.id,
		idempotency_key: "export-strict-comparison",
	});
	const second = await service.createExperiment({
		idempotency_key: "export-related-experiment",
		name: "共享 gold 的对照实验",
		dataset_id: env.dataset.id,
		variant_ids: first.variant_ids,
	});
	const completedSecond = await complete(env.app, second.id);
	const exploratoryComparison = await service.compare({
		baseline_experiment_id: first.id,
		candidate_experiment_id: second.id,
		idempotency_key: "export-cross-comparison",
	});
	const foreignSlots = service.store.slots(second.id, -1, 10);
	const reviewed = foreignSlots[0];
	const callsAtAdjudication = env.requests.length;
	// 从另一实验发起实际裁定，只取明确引用的外部观察，不传播另一实验全部正文。
	const adjudication = await service.adjudicate({
		idempotency_key: "export-adjudicate",
		experiment_id: second.id,
		slot_id: reviewed.id,
		expected_revision: service.experiment(second.id).revision,
		actor: "fixture-reviewer",
		reason: "测试审核新增时间范围，保留旧 score 与 old gold",
		revised_gold: { required_clarifications: ["年龄范围", "时间范围"] },
	});
	const deadline = Date.now() + 15000;
	while (
		service.experiment(first.id).latest_score_set_id === originalScoreId ||
		service.experiment(second.id).latest_score_set_id === completedSecond.latest_score_set_id
	) {
		assert.ok(Date.now() < deadline, "裁定后的重评必须落新版本");
		await delay(30);
	}
	for (const [experimentId, priorScoreId] of [
		[first.id, originalScoreId],
		[second.id, completedSecond.latest_score_set_id!],
	]) {
		const newScore = service.store.get<ScoreSet>(
			"score_set",
			service.experiment(experimentId).latest_score_set_id!,
		)!.data;
		const priorScore = service.store.get<ScoreSet>("score_set", priorScoreId)!.data;
		assert.equal(newScore.parent_score_set_id, priorScoreId);
		assert.equal(newScore.gold_hash, service.dataset(adjudication.new_dataset_id).hash);
		assert.equal(newScore.observation_hash, priorScore.observation_hash);
	}
	assert.equal(env.requests.length, callsAtAdjudication, "同一裁定影响两实验三方案时全部只重评已有观察");
	const current = service.experiment(first.id);
	const release = await service.release({
		idempotency_key: "export-release",
		experiment_id: first.id,
		score_set_id: current.latest_score_set_id,
		variant_id: first.variant_ids[0],
		expected_revision: current.revision,
	});
	assert.equal(release.status, "evidence_insufficient");
	// 无关数据集及管理记录放在同一账本，确认导出不是全库倾倒。
	const sentinel = "unrelated-private-sentinel";
	const unrelated = await service.importDataset({
		idempotency_key: "export-unrelated-dataset",
		name: sentinel,
		questions_jsonl: JSON.stringify({
			id: sentinel,
			source_id: "hospital-a",
			question: sentinel,
			as_of: "2026-10-21T00:00:00Z",
		}),
		gold_jsonl: JSON.stringify({
			id: sentinel,
			source_id: "hospital-a",
			expected_action: "clarify",
			required_clarifications: ["无关私有口径"],
			family_id: sentinel,
			split: "dev",
			category: "clarification",
		}),
	});
	service.store.immutable("adjudication", sentinel, { experiment_id: sentinel, actor: sentinel });
	service.store.immutable("comparison", sentinel, { baseline_experiment_id: sentinel });
	service.store.immutable("release_decision", sentinel, { experiment_id: sentinel });
	service.store.immutable("activation", sentinel, { release_decision_id: sentinel });
	// 故意注入跨实验父引用，仅测试导出边界：有这条记录不等于本包已含其完整成绩和观察。
	const foreignParentScore = completedSecond.latest_score_set_id!;
	const scopedScore = service.store.get<ScoreSet & { experiment_id: string; observation_ids: string[] }>(
		"score_set",
		current.latest_score_set_id!,
	)!.data;
	service.store.immutable("score_set", "export-parent-reference-fixture", {
		...scopedScore,
		id: "export-parent-reference-fixture",
		parent_score_set_id: foreignParentScore,
	});
	const callsBefore = env.requests.length;
	const exported = await service.exportExperiment(first.id);
	assert.equal(exported.schema_version, "evaluation-export/v1");
	assert.equal(exported.bundle_contract, "evaluation-evidence-bundle/v2");
	assert.equal(exported.evidence_status, "complete_for_scoped_regrading");
	assert.deepEqual(
		new Set(exported.datasets.map((dataset) => dataset.id)),
		new Set([env.dataset.id, adjudication.new_dataset_id]),
	);
	for (const dataset of exported.datasets) {
		const content = object(exported.dependency_artifacts.find((entry) => entry.id === dataset.artifact_id)!.content);
		assert.equal(content.id, dataset.id);
		assert.equal(content.hash, dataset.summary.hash);
	}
	const originalGold = object(
		exported.dependency_artifacts.find(
			(entry) => entry.id === exported.datasets.find((dataset) => dataset.id === env.dataset.id)!.artifact_id,
		)!.content,
	);
	const revisedGold = object(
		exported.dependency_artifacts.find(
			(entry) =>
				entry.id === exported.datasets.find((dataset) => dataset.id === adjudication.new_dataset_id)!.artifact_id,
		)!.content,
	);
	assert.deepEqual(object(object((originalGold.cases as unknown[])[0]).gold).required_clarifications, ["年龄范围"]);
	assert.deepEqual(object(object((revisedGold.cases as unknown[])[0]).gold).required_clarifications, [
		"年龄范围",
		"时间范围",
	]);
	assert.ok(exported.score_sets.some((score) => score.id === originalScoreId));
	assert.ok(exported.score_sets.some((score) => score.parent_score_set_id === originalScoreId));
	assert.deepEqual(
		exported.adjudications.map((record) => record.id),
		[adjudication.id],
	);
	assert.deepEqual(
		new Set(exported.comparisons.map((record) => record.id)),
		new Set([strictComparison.id, exploratoryComparison.id]),
	);
	assert.deepEqual(
		exported.release_decisions.map((record) => record.id),
		[release.id],
	);
	assert.ok(exported.applicability.some((record) => record.score_set_id === originalScoreId));
	assert.ok(exported.dependency_artifacts.some((entry) => entry.id === reviewed.artifact_id));
	assert.ok(
		foreignSlots.slice(1).every((slot) => !exported.artifact_manifest.some((entry) => entry.id === slot.artifact_id)),
	);
	assert.ok(
		exported.record_manifest.some(
			(entry) => entry.kind === "experiment" && entry.id === second.id && entry.status === "external_reference",
		),
	);
	assert.ok(
		exported.record_manifest.some(
			(entry) => entry.kind === "score_set" && entry.id === foreignParentScore && entry.status === "external_reference",
		),
	);
	assert.ok(!exported.score_sets.some((score) => score.id === foreignParentScore));
	assert.equal(exported.execution_replay.source_snapshots_embedded, false);
	assert.ok(!JSON.stringify(exported).includes(sentinel));
	assert.ok(!exported.datasets.some((dataset) => dataset.id === unrelated.id));
	assert.equal(env.requests.length, callsBefore, "导出不重跑模型或重评");
});
