import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, defineDocFamily, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ResourcePool, type ResourceScope } from "../src/resources.ts";
import { type JsonObject, type OperationRecord, QueryRuntime, type QueryTask, RuntimeError } from "../src/runtime.ts";

type Arrival = {
	id: string;
	group: string;
	submitted_ms: number;
	started_ms?: number;
	completed_ms?: number;
	rejected?: string;
};
const workloads: Record<string, unknown>[] = [];
const histories: Record<string, unknown>[] = [];
const round = (value: number) => Math.round(value * 1000) / 1000;
function distribution(values: number[]) {
	const sorted = values.slice().sort((a, b) => a - b);
	return {
		count: sorted.length,
		median_ms: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
		p95_ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0),
		max_ms: round(sorted.at(-1) ?? 0),
	};
}
async function until(check: () => boolean, label: string, timeout = 30000) {
	const deadline = performance.now() + timeout;
	while (!check()) {
		assert.ok(performance.now() < deadline, label);
		await delay(5);
	}
}

// 连续有限波次在真实Durable准入和共享资源池上竞争；模型工作仅是本机定时异步操作。
for (const cap of [5, 10])
	test(`A06/A07 ${cap}并发持续到达、三实验饱和及在线保留队列`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-runtime-load-"));
		const pool = new ResourcePool(cap, 30000, { maxPending: cap * 4, onlineReserve: cap });
		const origin = performance.now();
		const arrivals = new Map<string, Arrival>();
		const done = new Set<string>();
		const starts: string[] = [],
			modelStarts: string[] = [],
			errors: unknown[] = [];
		const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
		let active = 0,
			peak = 0,
			modelActive = 0,
			modelPeak = 0,
			peakPending = 0;
		const runtime = await QueryRuntime.open({
			storagePath: join(directory, "runtime.sqlite"),
			installationLockPath: join(directory, "owner"),
			maxActiveRuns: cap,
			evalMaxActiveRuns: cap,
			maxPending: cap * 4,
			onlineQueueReserve: cap,
			queueWaitTimeoutMs: 30000,
			runTimeoutMs: 30000,
			onError: (error) => errors.push(error),
			onChange: (task) => {
				if (task.status === "completed") done.add(task.requestId);
			},
			handler: async (task, signal) => {
				const entry = arrivals.get(task.requestId)!;
				entry.started_ms = performance.now() - origin;
				starts.push(task.requestId);
				active++;
				peak = Math.max(peak, active);
				try {
					await pool.run(
						async () => {
							modelActive++;
							modelPeak = Math.max(modelPeak, modelActive);
							modelStarts.push(task.requestId);
							try {
								const gate = gates.get(String(task.context.phase));
								if (gate) await gate.promise;
								else await delay(30, undefined, { signal });
							} finally {
								modelActive--;
							}
						},
						signal,
						task.context as ResourceScope,
					);
					entry.completed_ms = performance.now() - origin;
					return { status: "completed", result: { synthetic: true } };
				} finally {
					active--;
				}
			},
		});
		const submit = async (id: string, group: string, phase = "waves") => {
			const entry: Arrival = { id, group, submitted_ms: performance.now() - origin };
			arrivals.set(id, entry);
			const context: JsonObject = {
				mode: group === "online" ? "online" : "eval",
				experiment_id: group,
				variant_id: "local",
				phase,
			};
			try {
				await runtime.enqueue({ conversationId: id, requestId: id, question: "合成本机负载", context });
				return true;
			} catch (error) {
				assert.ok(error instanceof RuntimeError && error.code === "queue_full");
				entry.rejected = error.code;
				return false;
			}
		};
		try {
			const borrowed: Record<string, number> = {};
			for (const group of ["eval-only", "online"]) {
				const phase = `borrow-${group}`,
					gate = Promise.withResolvers<void>();
				gates.set(phase, gate);
				for (let index = 0; index < cap; index++) assert.equal(await submit(`${phase}-${index}`, group, phase), true);
				await until(() => modelActive === cap, "空闲份额应允许单类任务使用全部额度");
				borrowed[group] = modelActive;
				gate.resolve();
				await until(
					() => [...arrivals.values()].filter((entry) => !entry.rejected).every((entry) => done.has(entry.id)),
					"借用阶段应结束",
				);
			}
			const saturated = Promise.withResolvers<void>();
			gates.set("saturated", saturated);
			for (let index = 0; index < cap; index++)
				await submit(`saturated-${index}`, `experiment-${index % 3}`, "saturated");
			await until(() => modelActive === cap, "前置工作应填满活动额度");
			for (let index = 0; index < cap * 3; index++)
				assert.equal(await submit(`eval-queued-${index}`, `experiment-${index % 3}`), true);
			assert.equal(await submit("eval-overflow", "experiment-0"), false);
			for (let index = 0; index < cap; index++) assert.equal(await submit(`online-reserved-${index}`, "online"), true);
			assert.equal(await submit("online-overflow", "online"), false);
			assert.equal((await runtime.stats()).pending, cap * 4);
			peakPending = cap * 4;
			const waveStart = performance.now() - origin;
			saturated.resolve();
			const waves: { wave: number; at_ms: number; pending: number; eval_pending: number }[] = [];
			for (let wave = 0; wave < 12; wave++) {
				await delay(20);
				for (let index = 0; index < Math.ceil(cap / 2); index++) await submit(`online-${wave}-${index}`, "online");
				for (let experiment = 0; experiment < 3; experiment++)
					await submit(`eval-${wave}-${experiment}`, `experiment-${experiment}`);
				const stats = await runtime.stats();
				peakPending = Math.max(peakPending, stats.pending);
				const evalPending = [...arrivals.values()].filter(
					(entry) => entry.group !== "online" && !entry.rejected && entry.started_ms === undefined,
				).length;
				waves.push({
					wave,
					at_ms: round(performance.now() - origin),
					pending: stats.pending,
					eval_pending: evalPending,
				});
			}
			assert.ok(
				waves.every((wave) => wave.eval_pending > 0),
				"每波快照应仍有评测等待，不能以空闲期代替饱和竞争",
			);
			const waveEnd = performance.now() - origin;
			await until(
				() => [...arrivals.values()].filter((entry) => !entry.rejected).every((entry) => done.has(entry.id)),
				"有限负载应在运行超时前完成",
			);
			assert.deepEqual(errors, []);
			assert.equal(peak, cap);
			assert.equal(modelPeak, cap);
			assert.ok(peakPending <= cap * 4);
			assert.equal((await runtime.stats()).pending, 0);
			const groups: Record<string, unknown> = {};
			for (const group of ["online", "experiment-0", "experiment-1", "experiment-2"]) {
				const entries = [...arrivals.values()].filter(
					(entry) => entry.group === group && !entry.id.startsWith("borrow-"),
				);
				const accepted = entries.filter((entry) => !entry.rejected);
				const progress = accepted.filter(
					(entry) => entry.started_ms! >= waveStart && entry.started_ms! <= waveEnd,
				).length;
				assert.ok(progress > 0, `${group}必须在在线波次仍到达时获得运行机会`);
				assert.ok(accepted.every((entry) => entry.completed_ms !== undefined));
				const waits = accepted.map((entry) => entry.started_ms! - entry.submitted_ms);
				assert.ok(Math.max(...waits) < 30000, "本次有限样本不能出现排队超时");
				groups[group] = {
					accepted: accepted.length,
					rejected: entries.length - accepted.length,
					started_during_arrivals: progress,
					waiting: distribution(waits),
				};
			}
			workloads.push({
				cap,
				runtime_peak: peak,
				resource_peak: modelPeak,
				queue_capacity: cap * 4,
				online_queue_reserve: cap,
				peak_pending: peakPending,
				borrow_peak: borrowed,
				wave_count: 12,
				wave_window_ms: round(waveEnd - waveStart),
				groups,
				waves,
				starts,
				model_starts: modelStarts,
				arrivals: [...arrivals.values()].map((entry) =>
					Object.fromEntries(
						Object.entries(entry).map(([key, value]) => [key, typeof value === "number" ? round(value) : value]),
					),
				),
			});
		} finally {
			for (const gate of gates.values()) gate.resolve();
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

// 上游原生文档API批量导入已完成的合成历史，随后只测生产读接口；不伪称实际执行过这些历史任务。
const LoadIndex = defineDoc<{
	turnIds: string[];
	turns: Record<string, number>;
	conversations: Record<string, number>;
	requests: Record<string, string>;
}>({
	kind: "medical-query.runtime-index",
	version: 1,
	scope: "session",
	initial: () => ({ turnIds: [], turns: {}, conversations: {}, requests: {} }),
});
const LoadTurn = defineDocFamily<{ task: QueryTask | null }, null>({
	kind: "medical-query.query-turn",
	version: 1,
	scope: "conversation",
	family: true,
	history: "latest",
	fork: "initial",
	initial: () => ({ task: null }),
});
const LoadOperations = defineDoc<{
	operations: Record<string, OperationRecord>;
	pausedExperiments: string[];
	cancelledExperiments: string[];
}>({
	kind: "medical-query.external-operations",
	version: 1,
	scope: "session",
	initial: () => ({ operations: {}, pausedExperiments: [], cancelledExperiments: [] }),
});
async function timed(operation: () => Promise<unknown>, repeats = 10) {
	const values: number[] = [];
	for (let index = 0; index < repeats; index++) {
		const before = performance.now();
		await operation();
		values.push(performance.now() - before);
	}
	return distribution(values);
}
for (const count of [100, 1000])
	test(`历史${count}条时真实stats与操作账本过滤的读取开销`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-runtime-history-")),
			path = join(directory, "runtime.sqlite");
		let runtime: QueryRuntime | undefined;
		try {
			const storage = await openNodeSqliteStorage(path);
			const harness = await Harness.open(
				storage,
				{ models: createModels(), registry: createRegistry() },
				BACKGROUND_CONTEXT,
			);
			try {
				await harness.commit(async (tx) => {
					const index = await tx.doc(LoadIndex),
						ledger = await tx.doc(LoadOperations);
					const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
					for (let n = 0; n < count; n++) {
						const id = `history-${n}`,
							now = 1_792_080_000_000;
						(await tx.doc(LoadTurn, conversation.id, id, null)).task = {
							id,
							turnId: id,
							conversationId: `conversation-${n}`,
							requestId: id,
							question: "合成历史读取",
							context: { mode: "eval" },
							status: "completed",
							runId: `run-${n}`,
							replies: [],
							createdAt: now,
							updatedAt: now,
							queuedAt: now,
							queueDeadlineAt: now + 30000,
							clarificationRevision: 0,
							result: { text: "x".repeat(4096) },
						};
						index.turnIds.push(id);
						index.turns[id] = conversation.id;
						ledger.operations[id] = {
							id,
							turnId: id,
							runId: `run-${n}`,
							role: "decision",
							model: "local-synthetic",
							scope: { mode: "eval" },
							requestHash: id,
							input: { text: "x".repeat(4096) },
							createdAt: now,
							updatedAt: now,
							status: "succeeded",
							epoch: "synthetic",
							reservationReleased: true,
							dispositions: [],
						};
					}
				}, BACKGROUND_CONTEXT);
			} finally {
				await harness.close(BACKGROUND_CONTEXT);
			}
			const start = performance.now();
			runtime = await QueryRuntime.open({
				storagePath: path,
				installationLockPath: join(directory, "owner"),
				handler: async () => {
					throw new Error("已完成历史不得执行");
				},
			});
			const reopenMs = performance.now() - start;
			await runtime.stats();
			const all = await runtime.listOperations();
			assert.equal(all.length, count);
			const payloadBytes = Buffer.byteLength(JSON.stringify(all));
			const original = runtime.list.bind(runtime);
			let calls = 0,
				documents = 0;
			runtime.list = async (...args) => {
				const tasks = await original(...args);
				calls++;
				documents += tasks.length;
				return tasks;
			};
			const stats = await timed(() => runtime!.stats());
			assert.equal(calls, 10);
			assert.equal(documents, count * 10);
			const filtered = await timed(async () => {
				assert.equal((await runtime!.listOperations(`history-${count - 1}`)).length, 1);
			});
			const complete = await timed(async () => {
				assert.equal((await runtime!.listOperations()).length, count);
			});
			histories.push({
				count,
				synthetic_payload_bytes_per_turn: 4096,
				synthetic_payload_bytes_per_operation: 4096,
				operation_result_json_bytes: payloadBytes,
				reopen_ms: round(reopenMs),
				stats,
				stats_list_calls: calls,
				stats_returned_full_documents: documents,
				list_operations_one_turn: filtered,
				list_operations_all: complete,
				rss_bytes: process.memoryUsage().rss,
			});
		} finally {
			await runtime?.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

// 常规回归不写文档；显式报告模式保存一次有限负载的观测，避免累加或夸大验收成绩。
test("保存A06/A07及历史扫描的有限负载证据", async () => {
	assert.equal(workloads.length, 2);
	assert.equal(histories.length, 2);
	if (process.env.PI_RUNTIME_LOAD_REPORT !== "1") return;
	const environment = {
		recorded_at: new Date().toISOString(),
		node: process.version,
		platform: process.platform,
		cpu: cpus()[0]?.model,
		memory_bytes: totalmem(),
	};
	const evidence = { environment, workloads, histories };
	await writeFile(
		new URL("../../../docs/runtime-load-evidence.json", import.meta.url),
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	const workloadRows = workloads
		.flatMap((record) =>
			Object.entries(
				record.groups as Record<
					string,
					{
						accepted: number;
						rejected: number;
						started_during_arrivals: number;
						waiting: ReturnType<typeof distribution>;
					}
				>,
			).map(
				([group, value]) =>
					`| ${record.cap} | ${group} | ${value.accepted}/${value.rejected} | ${value.started_during_arrivals} | ${value.waiting.p95_ms} | ${value.waiting.max_ms} |`,
			),
		)
		.join("\n");
	const historyRows = histories
		.map(
			(record) =>
				`| ${record.count} | ${record.reopen_ms} | ${(record.stats as ReturnType<typeof distribution>).p95_ms} | ${(record.list_operations_one_turn as ReturnType<typeof distribution>).p95_ms} | ${(record.list_operations_all as ReturnType<typeof distribution>).p95_ms} | ${record.stats_returned_full_documents} |`,
		)
		.join("\n");
	await writeFile(
		new URL("../../../docs/runtime-load-report.md", import.meta.url),
		`# 持续到达与历史读取实测\n\n- 日期：${environment.recorded_at}；${environment.cpu} / ${environment.node}。全部使用临时SQLite、真实Pi Durable和生产ResourcePool；模型工作为30毫秒本机异步替身，没有提供商请求、生产数据库或在线端口访问。\n- 5/10分别执行12波在线及三个评测实验到达；每波间隔至少20毫秒，实际间隔包含准入与状态读取耗时。每组先验证仅在线、仅评测均可借用全部5/10额度，再阻塞活动工作并填满评测队列，验证评测拒绝后在线仍能占用预留队列，最终全队列满后在线也明确拒绝。\n- 活动任务与内层资源实际峰值分别为5/10；队列上限20/40，在线预留5/10。表内拒绝数是预期背压，未从提交分母删除；有限样本各实验在在线波次尚未停止时均有进展。完整启动顺序、每次到达/启动/完成及波次快照见[原始证据](runtime-load-evidence.json)。\n\n| 并发 | 请求组 | 接受/拒绝 | 到达期间已启动 | 等待P95 ms | 观察到的最大等待 ms |\n|---|---|---:|---:|---:|---:|\n${workloadRows}\n\n- 等待从调用enqueue前计至实际handler启动，包含本地准入耗时；这里只证明本次有限负载完成且无30秒排队超时，不是永久无饥饿、无限到达或远端服务SLA。未配置低于总额度的eval子上限；固定子上限仍会限制借用。\n- 历史测试通过Pi原生文档API批量写入100/1000条已完成合成任务及同量已完成操作，每项正文4KiB；随后重新打开真实QueryRuntime测量读取。导入历史不是执行过100/1000次问数，不计为模型调用或业务完成。\n\n| 历史数 | 重开 ms | stats P95 ms | 按turn过滤操作 P95 ms | 全操作 P95 ms | stats十次返回完整任务数 |\n|---:|---:|---:|---:|---:|---:|\n${historyRows}\n\n- stats调用list，list经documents遍历全部turnIds、读取每个业务文档并JSON复制，再按状态计数；测量中包装list只计数，不增加正文序列化。listOperations先取整个单文档账本的Object.values，再按turn过滤并复制；过滤返回1条也不是索引定位。源依据：runtime.ts的stats/list/documents/listOperations，server.ts的/api/status直接等待runtime.stats。\n- 此处测的是状态接口中runtime组件与操作读取，未测完整HTTP、真实大提示词分布或1万条Durable历史；不能用此前EvaluationStore索引分页结果替代。重开、样本RSS与每次操作在同机同进程观测，受缓存、GC和同期负载影响。源码冻结期间只记录线性扫描边界，未优化生产实现。\n- 复现：应用目录设置PI_RUNTIME_LOAD_REPORT=1，执行node --import ../../scripts/issues/register.mjs --conditions=source --test test/runtime-load.test.ts；普通模式不覆盖报告。报告与JSON是本测试模块的变更及验证记录。\n`,
	);
	await appendFile(
		new URL("../../../docs/runtime-load-report.md", import.meta.url),
		"\n- 额外边界：每波快照断言仍有评测任务等待；固定实验提交顺序下，入口先到先得会造成接受/拒绝数量差异。此测试验证已准入工作的有限进展，不证明各实验公平准入，后续如需公平入队必须单独设计与验收。\n- 精确源码依据：`apps/medical-query/src/runtime.ts:454`（操作账本全量取值后过滤）、`:623`（list）、`:703`（stats）、`:744`（逐历史文档读取）、`:752`（队列预留）；`src/server.ts:76`在状态响应中等待stats。当前仅新增本测试与两份报告，冻结源码未改。\n",
	);
});
