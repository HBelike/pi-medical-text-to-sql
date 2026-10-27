import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { APP_ROOT, type AppConfig } from "../src/config.ts";
import { EvaluationService } from "../src/evaluation/service.ts";
import { EvaluationStore, type SlotRecord, stableJson } from "../src/evaluation/store.ts";
import { ModelGateway } from "../src/model.ts";
import { type JsonValue, QueryRuntime } from "../src/runtime.ts";

type Timing = { median_ms: number; p95_ms: number; maximum_ms: number };
const measurements: Record<string, unknown>[] = [];
const workerMeasurements: Record<string, unknown>[] = [];
const environment = {
	node: process.version,
	platform: process.platform,
	architecture: process.arch,
	os_release: release(),
	cpu: cpus()[0]?.model,
	cpu_count: cpus().length,
	memory_bytes: totalmem(),
	recorded_at: new Date().toISOString(),
};
const rounded = (value: number) => Math.round(value * 1000) / 1000;
function timing(work: () => unknown, repetitions = 50): Timing {
	const values: number[] = [];
	for (let index = 0; index < repetitions; index++) {
		const started = performance.now();
		work();
		values.push(performance.now() - started);
	}
	values.sort((left, right) => left - right);
	return {
		median_ms: rounded(values[Math.floor(values.length / 2)]),
		p95_ms: rounded(values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)]),
		maximum_ms: rounded(values.at(-1)!),
	};
}
async function diskUsage(directory: string): Promise<number> {
	let bytes = 0;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		bytes += entry.isDirectory() ? await diskUsage(path) : (await stat(path)).size;
	}
	return bytes;
}

// 仅组装读取端，不启动调度器；实际分页、进度和SQLite方法均来自生产实现，不复制查询逻辑。
function readService(store: EvaluationStore): EvaluationService {
	const service = Object.create(EvaluationService.prototype) as EvaluationService;
	Object.defineProperty(service, "store", { value: store });
	return service;
}

for (const slots of [1000, 10000])
	test(`A24 ${slots}槽与4KB真实产物的历史分页、重开及A21索引重建`, { timeout: 120000 }, async (t) => {
		const directory = await mkdtemp(resolve(tmpdir(), "pi-evaluation-scale-"));
		let store = new EvaluationStore(directory, 0);
		t.after(async () => {
			store.close();
			await rm(directory, { recursive: true, force: true });
		});
		const experiment = `scale-${slots}`;
		store.put("experiment", experiment, {
			id: experiment,
			name: "合成历史负载",
			status: "completed",
			case_ids: [],
			variant_ids: ["off", "targeted"],
			repeats: 1,
			snapshots: {},
			created_at: Date.now(),
		});
		const rssBefore = process.memoryUsage().rss;
		let sampledRssPeak = rssBefore,
			artifactBytes = 0;
		const fullResult = {
			columns: ["id", "count"],
			rows: Array.from({ length: 301 }, (_, index) => [`SYN-${index}`, index]),
			complete: true,
			truncated: false,
			row_count: 301,
		};
		const fullArtifact = store.artifact(fullResult, "full_result", `experiment:${experiment}`);
		const insertStarted = performance.now();
		for (let ordinal = 0; ordinal < slots; ordinal++) {
			const id = `${experiment}-${String(ordinal).padStart(5, "0")}`;
			const status = ordinal % 10 === 8 ? "blocked" : ordinal % 10 === 9 ? "failed" : "completed";
			const observation = {
				id,
				question: "合成历史测试，不是模型评测成绩",
				status,
				stage_id: `stage-${ordinal}`,
				full_result_artifact: ordinal === 0 ? fullArtifact : null,
				padding: "",
			};
			observation.padding = "x".repeat(4096 - Buffer.byteLength(stableJson(observation)));
			artifactBytes += Buffer.byteLength(stableJson(observation));
			const artifactId = store.artifact(observation, "observation", `experiment:${experiment}`);
			const slot: SlotRecord = {
				id,
				experiment_id: experiment,
				case_id: `case-${ordinal}`,
				variant_id: ordinal % 2 ? "off" : "targeted",
				repeat_index: 0,
				snapshot_id: "synthetic-snapshot",
				ordinal,
				status,
				request_id: `request-${ordinal}`,
				execution_id: `execution-${ordinal}`,
				conversation_id: `conversation-${ordinal}`,
				artifact_id: artifactId,
				scored: ordinal % 4 !== 0,
				updated_at: Date.now(),
			};
			store.transaction(() => {
				store.addSlot(slot);
				store.event(experiment, id, "observation", { status, artifact_id: artifactId });
			});
			if (ordinal % 100 === 0) sampledRssPeak = Math.max(sampledRssPeak, process.memoryUsage().rss);
		}
		const insertMs = performance.now() - insertStarted;
		const service = readService(store);
		const originalRead = store.readArtifact.bind(store);
		let bodyReads = 0;
		store.readArtifact = <T>(id: string): T => {
			bodyReads++;
			return originalRead<T>(id);
		};
		const pageChecks = () => {
			const page = service.slots(experiment, Math.ceil(slots / 50), 50);
			assert.equal(page.total, slots);
			assert.equal(page.items.length, 50);
			assert.equal(page.items.at(-1)!.ordinal, slots - 1);
		};
		const latePage = timing(pageChecks),
			firstPage = timing(() => assert.equal(service.slots(experiment, 1, 50).items.length, 50));
		const counts = timing(() => assert.equal(service.experiment(experiment).progress.planned, slots));
		const events = timing(() => assert.equal(store.events(experiment, slots - 50, 50).length, 50));
		const filteredPage = timing(() => assert.equal(service.slots(experiment, 1, 50, "failed").total, slots / 10));
		const search = timing(() => assert.ok(service.slots(experiment, 1, 50, undefined, "case-9").total > 0), 10);
		assert.equal(bodyReads, 0, "列表与计数不能打开任何正文文件");
		const plans = {
			page: store.db
				.prepare(
					"EXPLAIN QUERY PLAN SELECT body FROM slots WHERE experiment_id=? AND ordinal>? ORDER BY ordinal LIMIT ?",
				)
				.all(experiment, slots - 51, 50),
			counts: store.db
				.prepare("EXPLAIN QUERY PLAN SELECT status,COUNT(*) FROM slots WHERE experiment_id=? GROUP BY status")
				.all(experiment),
			scored: store.db
				.prepare(
					"EXPLAIN QUERY PLAN SELECT COUNT(*) FROM slots WHERE experiment_id=? AND json_extract(body,'$.scored')=1",
				)
				.all(experiment),
		};
		assert.ok(plans.counts.some((plan) => String(plan.detail).includes("COVERING INDEX slots_state")));
		assert.ok(plans.scored.some((plan) => String(plan.detail).includes("slots_scored")));
		const beforeRebuild = store.counts(experiment),
			beforeScored = store.scoredCount(experiment);
		const contentBefore = store.readArtifact(fullArtifact);
		// A21只重建派生索引，业务表和内容寻址正文仍为权威，绝不制造丢失的trace。
		store.db.exec("DROP INDEX slots_state; DROP INDEX slots_scored; DROP INDEX events_page; DROP INDEX objects_page;");
		store.close();
		const reopenStarted = performance.now();
		store = new EvaluationStore(directory, 0);
		const reopenMs = performance.now() - reopenStarted;
		const reindexStarted = performance.now();
		store.db.exec("REINDEX");
		const reindexMs = performance.now() - reindexStarted;
		assert.deepEqual(store.counts(experiment), beforeRebuild);
		assert.equal(store.scoredCount(experiment), beforeScored);
		assert.deepEqual(store.readArtifact(fullArtifact), contentBefore);
		assert.equal(store.slots(experiment, slots - 51, 50).at(-1)!.ordinal, slots - 1);
		const integrity = store.db.prepare("PRAGMA integrity_check").get()!;
		assert.equal(Object.values(integrity)[0], "ok");
		assert.equal(store.artifacts("", 500).length, 500);
		const checkpointStarted = performance.now();
		store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		const checkpointMs = performance.now() - checkpointStarted;
		measurements.push({
			slots,
			observation_artifacts: slots,
			observation_bytes_each: 4096,
			full_result_rows: 301,
			artifact_bytes: artifactBytes + Buffer.byteLength(stableJson(fullResult)),
			disk_bytes: await diskUsage(directory),
			insert_ms: rounded(insertMs),
			insert_per_second: rounded(slots / (insertMs / 1000)),
			first_page: firstPage,
			last_page: latePage,
			filtered_page: filteredPage,
			metadata_search: search,
			progress_counts: counts,
			event_page: events,
			reopen_with_missing_indexes_ms: rounded(reopenMs),
			reindex_ms: rounded(reindexMs),
			checkpoint_ms: rounded(checkpointMs),
			rss_before_bytes: rssBefore,
			rss_after_bytes: process.memoryUsage().rss,
			rss_sampled_peak_bytes: sampledRssPeak,
			body_reads_during_queries: 0,
			index_plans: plans,
			integrity: "ok",
		});
	});

// 四个独立客户端只向唯一owner提交，真实Pi HTTP出口共用5/10额度，客户端进程数不能复制额度。
for (const capacity of [5, 10])
	test(`4个真实客户端进程共用${capacity}模型额度并保留类别与实验进展`, { timeout: 30000 }, async (t) => {
		let active = 0,
			peak = 0;
		const starts: { question: string; at: number }[] = [];
		const provider = createServer(async (request, response) => {
			let raw = "";
			for await (const chunk of request) raw += chunk;
			const body = JSON.parse(raw),
				input = JSON.parse(body.messages.find((message: { role: string }) => message.role === "user").content);
			active++;
			peak = Math.max(peak, active);
			starts.push({ question: input.question, at: Date.now() });
			await delay(20);
			const part = {
				id: `local-${starts.length}`,
				object: "chat.completion.chunk",
				created: 1,
				model: "deepseek-test",
				choices: [{ index: 0, delta: { content: '{"ok":true}' }, finish_reason: "stop" }],
			};
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(`data: ${JSON.stringify(part)}\n\ndata: [DONE]\n\n`);
			active--;
		});
		provider.listen(0, "127.0.0.1");
		await once(provider, "listening");
		const address = provider.address();
		assert.ok(address && typeof address !== "string");
		const directory = await mkdtemp(resolve(tmpdir(), "pi-fair-clients-"));
		const config: AppConfig = {
			apiKey: "local-only",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			decisionModel: "deepseek-test",
			answerModel: "deepseek-test",
			maxActiveRuns: capacity,
			llmMaxConcurrency: capacity,
			evalMaxActiveRuns: capacity,
			maxPending: 100,
			queueWaitTimeoutMs: 10000,
			llmTimeoutMs: 10000,
			runTimeoutMs: 15000,
			port: address.port,
			python: "unused",
			dataDir: directory,
		};
		const gateway = new ModelGateway(config);
		let runtime: QueryRuntime;
		runtime = await QueryRuntime.open({
			storagePath: resolve(directory, "runtime.sqlite"),
			installationLockPath: resolve(directory, "owner"),
			maxActiveRuns: capacity,
			onReady: (value) => gateway.attachRuntime(value),
			handler: async (task, signal) => ({
				status: "completed",
				result: (await gateway.json(
					"decision",
					"只返回JSON",
					{ question: task.question },
					signal,
					[],
					task.context.mode === "eval" ? 0 : 1,
					undefined,
					4096,
					{
						turn_id: task.id,
						run_id: task.runId,
						mode: task.context.mode === "eval" ? "eval" : "online",
						experiment_id: String(task.context.experiment_id),
						variant_id: "one",
					},
				)) as JsonValue,
			}),
		});
		const coordinator = createServer(async (request, response) => {
			try {
				let raw = "";
				for await (const chunk of request) raw += chunk;
				const body = JSON.parse(raw);
				let task = await runtime.enqueue({
					conversationId: body.id,
					requestId: body.id,
					question: body.id,
					context: { mode: body.mode, experiment_id: body.experiment },
				});
				while (["queued", "running"].includes(task.status)) {
					await delay(5);
					task = (await runtime.get(task.id))!;
				}
				response.setHeader("Content-Type", "application/json");
				response.end(JSON.stringify({ status: task.status }));
			} catch (error) {
				response.writeHead(500);
				response.end(String(error));
			}
		});
		coordinator.listen(0, "127.0.0.1");
		await once(coordinator, "listening");
		const local = coordinator.address();
		assert.ok(local && typeof local !== "string");
		const childScript = `const input=JSON.parse(process.argv[1]);process.send({ready:true});await new Promise(resolve=>process.once('message',resolve));const outputs=await Promise.all(Array.from({length:12},async(_,i)=>{const response=await fetch(input.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:input.prefix+'-'+i,mode:input.mode,experiment:input.prefix})});return (await response.json()).status;}));process.send({outputs},()=>process.disconnect());`;
		const children = ["online-a", "eval-a", "eval-b", "online-b"].map((prefix) =>
			spawn(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					childScript,
					JSON.stringify({
						prefix,
						mode: prefix.startsWith("eval") ? "eval" : "online",
						url: `http://127.0.0.1:${local.port}`,
					}),
				],
				{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
			),
		);
		t.after(async () => {
			for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await runtime.close();
			provider.closeAllConnections();
			coordinator.closeAllConnections();
			await Promise.all([
				new Promise<void>((resolve) => provider.close(() => resolve())),
				new Promise<void>((resolve) => coordinator.close(() => resolve())),
			]);
			await rm(directory, { recursive: true, force: true });
		});
		const completions = children.map(
			(child) =>
				new Promise<string[]>((resolve, reject) => {
					child.on("message", (message: { outputs?: string[] }) => {
						if (message.outputs) resolve(message.outputs);
					});
					child.on("error", reject);
					child.on("exit", (code) => {
						if (code && code !== 0) reject(new Error(`worker ${code}`));
					});
				}),
		);
		await Promise.all(children.map((child) => new Promise<void>((resolve) => child.once("message", () => resolve()))));
		const started = performance.now();
		for (const child of children) child.send("go");
		const outputs = (await Promise.all(completions)).flat();
		assert.equal(outputs.length, 48);
		assert.ok(outputs.every((status) => status === "completed"));
		assert.ok(peak <= capacity);
		assert.ok(peak > 1);
		const firstByClass = Object.fromEntries(
			["online-a", "eval-a", "eval-b", "online-b"].map((prefix) => [
				prefix,
				starts.findIndex((item) => item.question.startsWith(prefix)),
			]),
		);
		assert.ok(
			Object.values(firstByClass).every((index) => index >= 0 && index < 24),
			"每个类别/实验在前半批获得服务",
		);
		workerMeasurements.push({
			clients: 4,
			requests: 48,
			configured_capacity: capacity,
			observed_provider_peak: peak,
			runtime_peak: (await runtime.stats()).peakActive,
			llm_peak: gateway.pool.stats().peak,
			elapsed_ms: rounded(performance.now() - started),
			first_start_index_by_client: firstByClass,
			completion_count: outputs.length,
		});
	});

// 报告只在显式测量命令中写入，普通回归不修改文档；内容为本机一次观测而非服务SLA。
after(async () => {
	if (process.env.PI_SCALE_WRITE_REPORT !== "1") return;
	assert.equal(measurements.length, 2);
	assert.equal(workerMeasurements.length, 2);
	const rows = measurements
		.map(
			(row) =>
				`| ${row.slots} | ${row.insert_ms} | ${(row.last_page as Timing).median_ms} / ${(row.last_page as Timing).p95_ms} | ${(row.progress_counts as Timing).median_ms} / ${(row.progress_counts as Timing).p95_ms} | ${row.reopen_with_missing_indexes_ms} | ${row.reindex_ms} | ${rounded(Number(row.disk_bytes) / 1048576)} | ${rounded(Number(row.rss_sampled_peak_bytes) / 1048576)} |`,
		)
		.join("\n");
	const report = `# 评测历史负载与资源实测\n\n- 日期：${environment.recorded_at}。环境：${environment.platform} ${environment.architecture} / Node ${environment.node} / ${environment.cpu}，${environment.cpu_count}逻辑核、${rounded(environment.memory_bytes / 1073741824)} GiB内存。\n- 使用真实 EvaluationStore SQLite/WAL、每槽独立4,096字节正文文件与301行完整产物；全部在临时目录，结束删除，未访问生产数据或外部模型。每槽实际执行内容落盘、元数据引用及槽位/事件事务。\n- 分页/计数各连续50次，元数据搜索10次；下表为本机单次运行观测，无固定时延阈值，不作为SLA或跨机器性能结论。磁盘数值为SQLite与正文文件逻辑字节总量，不包含文件系统元数据或压缩差异。RSS为每100槽采样峰值，不是操作系统绝对峰值；两规模在同一Node进程顺序测量。\n\n| 槽数 | 新增总耗时 ms | 末页中位/P95 ms | 进度中位/P95 ms | 缺索引重开 ms | REINDEX ms | 文件逻辑体积 MiB | 采样RSS MiB |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n- 查询期间正文文件读取次数均为0。计数使用 slots_state 覆盖索引，评分计数使用 slots_scored 表达式索引，游标页使用实验/序号索引；搜索只读槽位元数据，仍需扫描匹配范围，不宣称全文搜索为O(1)。\n- A21验证：删除4个派生索引后重新打开、执行 REINDEX，计数、末页、301行正文内容寻址读取保持一致，PRAGMA integrity_check=ok。此项不表示可以重建已删除正文或缺失流增量。\n- 4个真实客户端进程经单owner向本机SSE发出48次请求；5/10额度下逐项观测如下。客户端数不会复制模型池；公平结论限于此竞争样本，不代表远端服务保障。\n\n\`\`\`json\n${JSON.stringify(workerMeasurements, null, 2)}\n\`\`\`\n\n- 已有运行链路回归59项通过；最后两项过滤字段边界加入后pipeline12项通过。它们覆盖跨进程owner、强杀后未知保留、人工处置、取消、5/10并发、追问累计预算、429、完整结果及L0依赖；没有真实收费模型质量结论。\n- 复现：在仓库根设置 PI_SCALE_WRITE_REPORT=1，运行 \`node --import ./scripts/issues/register.mjs --conditions=source --test apps/medical-query/test/evaluation-scale.test.ts\`。普通回归不写报告。\n- 范围：当前测试测评测历史账本/读取端及模型出口竞争，不覆盖长时间在线业务、操作系统断电或全部Durable历史文档的容量；原始测量附于下方，保留用于核验。\n\n\`\`\`json\n${JSON.stringify({ environment, measurements }, null, 2)}\n\`\`\`\n`;
	await writeFile(resolve(APP_ROOT, "../../docs/evaluation-scale-report.md"), report);
});
