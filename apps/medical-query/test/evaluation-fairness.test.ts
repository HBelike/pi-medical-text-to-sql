import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Application } from "../src/application.ts";
import { APP_ROOT, type AppConfig } from "../src/config.ts";
import type { Variant } from "../src/evaluation/service.ts";
import { RuntimeError } from "../src/runtime.ts";

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean, timeout = 15000): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await read();
		if (ready(value)) return value;
		assert.ok(Date.now() < deadline, `等待服务状态超时：${JSON.stringify(value)}`);
		await delay(25);
	}
}

// 评测统一入口与裸 runtime 抢占队列不是同一契约：满队列应保留 planned，再由服务轮转派发。
for (const capacity of [5, 10]) {
	test(
		`真实评测服务 ${capacity} 额度下三实验背压保留计划，在线波次期间各实验推进`,
		{ timeout: 45000 },
		async (context) => {
			const dataDir = await mkdtemp(resolve(tmpdir(), "pi-evaluation-fairness-"));
			execFileSync("python3", [resolve(APP_ROOT, "python/build_fixtures.py"), "--output-dir", dataDir]);
			const gate = Promise.withResolvers<void>();
			let active = 0,
				peak = 0,
				requests = 0;
			const server = createServer(async (request, response) => {
				for await (const _chunk of request) {
					/* 本机请求仅作并发工作，不转发提供商。 */
				}
				requests++;
				active++;
				peak = Math.max(peak, active);
				try {
					await gate.promise;
					await delay(180);
					const output = {
						action: "clarify",
						question: "需要统计哪个年龄范围？",
						options: ["65岁及以上"],
						slots: ["年龄范围"],
					};
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(
						`data: ${JSON.stringify({
							id: "fairness-local",
							object: "chat.completion.chunk",
							created: 1,
							model: "deepseek-test",
							choices: [{ index: 0, delta: { content: JSON.stringify(output) }, finish_reason: "stop" }],
							usage: { prompt_tokens: 10, completion_tokens: 10 },
						})}\n\ndata: [DONE]\n\n`,
					);
				} finally {
					active--;
				}
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			assert.ok(address && typeof address !== "string");
			let app: Application | undefined;
			context.after(async () => {
				gate.resolve();
				await app?.close();
				server.closeAllConnections();
				await new Promise<void>((done) => server.close(() => done()));
				await rm(dataDir, { recursive: true, force: true });
			});
			const config: AppConfig = {
				apiKey: "local-only-fairness",
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				decisionModel: "deepseek-test",
				answerModel: "deepseek-test",
				maxActiveRuns: capacity,
				llmMaxConcurrency: capacity,
				evalMaxActiveRuns: capacity,
				maxPending: 4,
				onlineQueueReserve: 1,
				queueWaitTimeoutMs: 20000,
				llmTimeoutMs: 25000,
				runTimeoutMs: 30000,
				port: address.port,
				python: "python3",
				dataDir,
				installationLockPath: resolve(dataDir, "owner"),
				coordinatorStoragePath: resolve(dataDir, "runtime.sqlite"),
			};
			app = await Application.open(config);
			const application = app,
				service = app.evaluation;
			const question = {
				id: "fairness-q",
				source_id: "hospital-a",
				question: "患者有多少人？",
				as_of: "2026-10-21T00:00:00Z",
			};
			const dataset = await service.importDataset({
				idempotency_key: "fairness-data",
				questions_jsonl: JSON.stringify(question),
				gold_jsonl: JSON.stringify({
					...question,
					category: "clarification",
					family_id: "patient-age",
					split: "dev",
					expected_action: "clarify",
					required_clarifications: ["年龄范围"],
				}),
			});
			const firstVariant = service.store
				.all<Variant>("variant")
				.find((record) => record.data.repair_policy === "off")!.id;
			const secondVariant = await service.createVariant({
				idempotency_key: "fairness-second-variant",
				name: "公平测试第二方案",
				repair_limit: 0,
			});
			const backpressure = new Map<string, number>(),
				dispatched: { experiment: string; variant: string; turn: string }[] = [];
			const query = app.query.bind(app);
			// 只包装真实入口记录结果，不伪造 queue_full，也不替换服务的 tick、派发器或评分器。
			app.query = async (input) => {
				const experiment = input.execution_context?.experiment_id;
				try {
					const task = await query(input);
					if (typeof experiment === "string")
						dispatched.push({ experiment, variant: String(input.execution_context?.variant_id), turn: task.id });
					return task;
				} catch (error) {
					if (typeof experiment === "string" && error instanceof RuntimeError && error.code === "queue_full")
						backpressure.set(experiment, (backpressure.get(experiment) ?? 0) + 1);
					throw error;
				}
			};
			const online = (id: string) =>
				application.query({
					conversation_id: id,
					request_id: id,
					source_id: question.source_id,
					question: question.question,
					as_of: question.as_of,
				});
			// 先占满真实模型活动额度，再填满业务等待队列，避免“可能没饱和”的宽松断言。
			for (let index = 0; index < capacity; index++) {
				await online(`held-${index}`);
				await until(
					() => requests,
					(value) => value === index + 1,
				);
			}
			for (let index = 0; index < 4; index++) await online(`queued-${index}`);
			const experiments: Awaited<ReturnType<typeof service.createExperiment>>[] = [];
			for (let index = 0; index < 3; index++)
				experiments.push(
					await service.createExperiment({
						idempotency_key: `experiment-${index}`,
						name: `公平实验 ${index}`,
						dataset_id: dataset.id,
						variant_ids: [firstVariant, secondVariant.id],
						repeats: 3,
						concurrency: capacity,
					}),
				);
			await until(
				() => [...backpressure.keys()],
				(ids) => experiments.every((experiment) => ids.includes(experiment.id)),
			);
			for (const experiment of experiments) {
				const slots = service.store.slots(experiment.id, -1, 100);
				assert.equal(slots.length, 6);
				assert.ok(slots.every((slot) => slot.status === "planned" && !slot.turn_id && !slot.error));
				assert.equal(service.experiment(experiment.id).status, "running");
			}
			assert.equal(dispatched.length, 0);
			assert.equal(peak, capacity);
			gate.resolve();
			let accepted = 0,
				rejected = 0;
			const duringWaves = new Set<string>();
			let waveCount = 0;
			// 有限到达并非无限负载 SLA；每次被拒在线请求明确计数，评测槽仍由服务保留和轮转。
			// 允许控制端完成多轮真实指纹/快照检查；用有限 60 波上界验证进展，不引入 1 秒准入 SLA。
			for (let wave = 0; wave < 60 && (wave < 12 || duringWaves.size < 3); wave++) {
				waveCount++;
				for (let arrival = 0; arrival < 2; arrival++) {
					try {
						await online(`wave-${wave}-${arrival}`);
						accepted++;
					} catch (error) {
						assert.ok(error instanceof RuntimeError && error.code === "queue_full");
						rejected++;
					}
				}
				for (const experiment of experiments)
					if (dispatched.some((entry) => entry.experiment === experiment.id)) duringWaves.add(experiment.id);
				await delay(150);
			}
			assert.equal(accepted + rejected, waveCount * 2);
			assert.ok(accepted > 0);
			assert.equal(duringWaves.size, 3, "在线到达尚未停止时三个实验都得到派发机会");
			await until(
				() => experiments.map((experiment) => service.experiment(experiment.id)),
				(values) => values.every((value) => !!value.latest_score_set_id),
			);
			for (const experiment of experiments) {
				const state = service.experiment(experiment.id),
					slots = service.store.slots(experiment.id, -1, 100);
				assert.equal(state.status, "completed");
				assert.equal(state.progress.scored, 6);
				assert.ok(slots.every((slot) => slot.status === "waiting_for_user" && !slot.error && slot.scored));
				assert.equal(new Set(slots.map((slot) => slot.turn_id)).size, 6);
				const actual = dispatched.filter((entry) => entry.experiment === experiment.id);
				assert.equal(actual.length, 6, "背压重试不重复派发已接受槽位");
				assert.equal(actual.filter((entry) => entry.variant === firstVariant).length, 3);
				assert.equal(actual.filter((entry) => entry.variant === secondVariant.id).length, 3);
				assert.ok(service.store.allEvents(experiment.id).every((event) => event.type !== "dispatch_failed"));
			}
			assert.ok(peak <= capacity);
			assert.equal((await app.runtime.list()).filter((task) => task.context.mode === "eval").length, 18);
			context.diagnostic(
				JSON.stringify({
					capacity,
					planned_slots: 18,
					online_waves: waveCount,
					queue_full_by_experiment: [...backpressure.values()],
					experiments_dispatched_during_online_waves: duringWaves.size,
					online_wave_accepted: accepted,
					online_wave_rejected: rejected,
					provider_peak: peak,
					experiment_states: experiments.map((experiment) => service.experiment(experiment.id).status),
				}),
			);
		},
	);
}
