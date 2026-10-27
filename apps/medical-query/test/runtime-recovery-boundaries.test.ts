import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../src/config.ts";
import { ModelGateway } from "../src/model.ts";
import { QueryRuntime } from "../src/runtime.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const registerPath = fileURLToPath(new URL("../../../scripts/issues/register.mjs", import.meta.url));

// 四个真实进程断点分别证明发送意图、已获发送权、收到正文和持久回执不能混为一种状态。
for (const boundary of ["prepared", "dispatching", "receipt_received", "receipt_committed"] as const) {
	test(`模型恢复断点 ${boundary}：强杀后不重发，预留与已知证据一致`, { timeout: 15000 }, async (context) => {
		const directory = await mkdtemp(join(tmpdir(), "pi-recovery-boundary-"));
		let requests = 0;
		const server = createServer(async (request, response) => {
			for await (const _chunk of request) {
				/* 只消费本机测试请求，禁止转发真实网关。 */
			}
			requests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			const output = {
				id: "boundary-local",
				object: "chat.completion.chunk",
				created: 1,
				model: "deepseek-test",
				choices: [{ index: 0, delta: { content: '{"ok":true}' }, finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
			};
			response.end(`data: ${JSON.stringify(output)}\n\ndata: [DONE]\n\n`);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const config: AppConfig = {
			apiKey: "local-boundary-fixture",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			decisionModel: "deepseek-test",
			answerModel: "deepseek-test",
			maxActiveRuns: 1,
			llmMaxConcurrency: 1,
			evalMaxActiveRuns: 1,
			maxPending: 10,
			queueWaitTimeoutMs: 1000,
			llmTimeoutMs: 10000,
			runTimeoutMs: 12000,
			port: address.port,
			python: "unused",
			dataDir: directory,
		};
		const storagePath = join(directory, "runtime.sqlite");
		const scriptPath = join(directory, "boundary.mjs");
		// 子进程在生产方法提交的精确边界停住；父进程 SIGKILL，不走优雅关闭来伪造崩溃。
		await writeFile(
			scriptPath,
			`import { QueryRuntime } from ${JSON.stringify(new URL("../src/runtime.ts", import.meta.url).href)};
import { ModelGateway } from ${JSON.stringify(new URL("../src/model.ts", import.meta.url).href)};
const gateway = new ModelGateway(${JSON.stringify(config)});
const runtime = await QueryRuntime.open({storagePath:${JSON.stringify(storagePath)},onReady:r=>gateway.attachRuntime(r),handler:async(task,signal)=>({status:'completed',result:await gateway.json('decision','测试',{question:task.question},signal,[],0,undefined,4096,{turn_id:task.id,run_id:task.runId})})});
const boundary = ${JSON.stringify(boundary)};
const stop = async(operationId)=>{ process.send({operationId}); await new Promise(()=>{}); };
const prepare = runtime.prepareOperation.bind(runtime);
runtime.prepareOperation = async(...args)=>{const result=await prepare(...args);if(boundary==='prepared')await stop(result.id);return result;};
const dispatch = runtime.dispatchOperation.bind(runtime);
runtime.dispatchOperation = async(id)=>{await dispatch(id);if(boundary==='dispatching')await stop(id);};
const settle = runtime.settleOperation.bind(runtime);
runtime.settleOperation = async(id,status,receipt)=>{if(status==='succeeded'&&boundary==='receipt_received')await stop(id);const result=await settle(id,status,receipt);if(status==='succeeded'&&boundary==='receipt_committed')await stop(id);return result;};
await runtime.enqueue({conversationId:'boundary',requestId:'boundary',question:'本机断点测试'});
`,
		);
		const child = spawn(process.execPath, ["--import", registerPath, "--conditions=source", scriptPath], {
			cwd: repositoryRoot,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG },
		});
		let runtime: QueryRuntime | undefined;
		let stderr = "";
		assert.ok(child.stderr);
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		context.after(async () => {
			if (child.exitCode === null && child.signalCode === null) {
				const closed = once(child, "close");
				child.kill("SIGKILL");
				await closed;
			}
			await runtime?.close();
			server.closeAllConnections();
			await new Promise<void>((done) => server.close(() => done()));
			await rm(directory, { recursive: true, force: true });
		});
		const message = await new Promise<{ operationId: string }>((done, reject) => {
			child.once("message", (value) => done(value as { operationId: string }));
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`未到达断点 ${code}: ${stderr}`)));
		});
		const closed = once(child, "close");
		child.kill("SIGKILL");
		await closed;
		const gateway = new ModelGateway(config);
		let replayed = 0;
		runtime = await QueryRuntime.open({
			storagePath,
			onReady: (current) => gateway.attachRuntime(current),
			handler: async () => {
				replayed++;
				throw new Error("恢复不得重放已接受任务");
			},
		});
		const operation = (await runtime.listOperations())[0];
		assert.equal(operation.id, message.operationId);
		const uncertain = boundary === "dispatching" || boundary === "receipt_received";
		assert.equal(operation.status, uncertain ? "unknown" : boundary === "prepared" ? "not_sent" : "succeeded");
		assert.equal(operation.reservationReleased, !uncertain);
		assert.equal(gateway.pool.stats().active, uncertain ? 1 : 0);
		assert.equal(requests, boundary.startsWith("receipt_") ? 1 : 0);
		await assert.rejects(runtime.dispatchOperation(operation.id), { code: "operation_not_dispatchable" });
		await assert.rejects(runtime.settleOperation(operation.id, "succeeded", { late: true }), {
			code: "stale_operation",
		});
		if (boundary === "receipt_committed") assert.equal(operation.receipt?.status, "completed");
		else if (boundary === "receipt_received") {
			// HTTP 头的在途回执已落盘，但完整结束回执尚未提交；保留部分证据，不冒充成功。
			assert.equal(operation.receipt?.status, "running");
			assert.equal(operation.receipt?.cost, null);
			assert.notEqual(operation.receipt?.operation_status, "succeeded");
		} else assert.equal(operation.receipt, undefined, "未发送阶段不得伪造回执");
		await delay(30);
		assert.equal(replayed, 0);
		assert.equal(requests, boundary.startsWith("receipt_") ? 1 : 0);
	});
}
