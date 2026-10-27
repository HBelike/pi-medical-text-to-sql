import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import type { AppConfig } from "../src/config.ts";
import { ModelGateway, type ModelOutputBudget, type ModelReceipt } from "../src/model.ts";

// 只用本机 SSE 和显式测试凭据，经过真实 Pi AI 解析器，不加载本地配置或外部模型。
for (const cacheWrite of [0, 10]) {
	const outputBudget = cacheWrite === 0 ? undefined : 8192;
	test(`模型总输入包含缓存读写，实际输出预算${outputBudget ?? 4096}与记录一致`, async (t) => {
		// 原样保留正文空白与分片顺序，推理内容即使由兼容接口返回也不能进入输出卡片。
		const assistantText = ' {\n  "action": "query"\n} ';
		const requests: { path: string | undefined; authorization: string | undefined; body: Record<string, unknown> }[] =
			[];
		const server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk;
			requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
			response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			const base = { id: "local-test", object: "chat.completion.chunk", created: 1, model: "deepseek-test" };
			response.write(
				`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "只供内部推理的测试内容" }, finish_reason: null }] })}\n\n`,
			);
			for (const content of [assistantText.slice(0, 8), assistantText.slice(8)])
				response.write(
					`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
				);
			response.write(
				`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
			);
			// 同时覆盖 DeepSeek 顶层缓存命中和兼容接口的缓存读写拆分两种响应格式。
			const cache =
				cacheWrite === 0
					? { prompt_cache_hit_tokens: 60 }
					: { prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: cacheWrite } };
			response.write(
				`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, ...cache } })}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		t.after(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		});
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const config: AppConfig = {
			apiKey: "test-only-unused-credential",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			decisionModel: "deepseek-test",
			answerModel: "deepseek-test",
			maxActiveRuns: 1,
			llmMaxConcurrency: 1,
			evalMaxActiveRuns: 1,
			maxPending: 1,
			queueWaitTimeoutMs: 2000,
			llmTimeoutMs: 2000,
			runTimeoutMs: 4000,
			port: address.port,
			python: "unused",
			dataDir: "unused",
		};
		const gateway = new ModelGateway(config);
		const receipts: ModelReceipt[] = [];
		const input = { question: "测试问题", context: { omitted: undefined, text: '换行\n与引号"' } };
		let startRecord: ModelReceipt | undefined;
		const result = await gateway.json(
			"decision",
			"返回决策",
			input,
			new AbortController().signal,
			receipts,
			1,
			async () => {
				startRecord = structuredClone(receipts[0]);
				assert.equal(requests.length, 0);
			},
			outputBudget,
		);
		assert.deepEqual(result, { action: "query" });
		assert.equal(receipts.length, 1);
		assert.equal(receipts[0].input_tokens, 100);
		assert.equal(receipts[0].output_tokens, 20);
		assert.equal(receipts[0].cache_read_tokens, 60);
		assert.equal(receipts[0].cache_write_tokens, cacheWrite);
		assert.equal(receipts[0].status, "completed");
		assert.equal(receipts[0].cost, null);
		// 本机真实Pi请求分别覆盖缺省额度和L0额度，禁止只改receipt却未传递给网关。
		assert.equal(receipts[0].max_output_tokens, outputBudget ?? 4096);
		assert.equal(startRecord?.max_output_tokens, outputBudget ?? 4096);
		assert.equal(requests[0].body.max_tokens, outputBudget ?? 4096);
		// 卡片记录必须与 SDK 真正发送的两个消息逐字一致，不能展示不含网关尾缀的模板。
		assert.equal(startRecord?.status, "running");
		assert.equal(typeof startRecord?.id, "string");
		assert.ok(startRecord?.started_at && startRecord.started_at > 0);
		assert.equal(receipts[0].id, startRecord.id);
		assert.equal(receipts[0].user_prompt, JSON.stringify(input));
		assert.equal(startRecord.output_text, "");
		assert.equal(receipts[0].output_text, assistantText);
		assert.equal(JSON.stringify(receipts).includes("只供内部推理的测试内容"), false);
		assert.equal(requests.length, 1);
		assert.equal(requests[0].path, "/v1/chat/completions");
		assert.equal(requests[0].authorization, "Bearer test-only-unused-credential");
		assert.equal(Object.hasOwn(requests[0].body, "thinking"), false);
		assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
		const messages = requests[0].body.messages as { role: string; content: string }[];
		assert.equal(messages.find((message) => message.role === "system")!.content, receipts[0].system_prompt);
		assert.equal(messages.find((message) => message.role === "user")!.content, receipts[0].user_prompt);
		assert.match(receipts[0].system_prompt!, /只返回有效 JSON/);
		assert.equal(JSON.stringify(receipts).includes(config.apiKey), false);
		assert.deepEqual(gateway.pool.stats(), { active: 0, pending: 0, peak: 1 });
		await assert.rejects(
			gateway.json(
				"decision",
				"无效预算",
				{},
				new AbortController().signal,
				[],
				1,
				undefined,
				99999 as ModelOutputBudget,
			),
			/输出额度/,
		);
		assert.equal(requests.length, 1, "越界额度不能发送请求");
	});
}

// 本机异常流覆盖坏JSON、输出截断和缺少完成信号；保留诊断正文不放宽业务成功条件。
for (const scenario of [
	{ name: "无效JSON", text: "不是JSON的真实正文", finish: "stop", expected: /有效 JSON/ },
	{ name: "输出截断", text: '{"linking":', finish: "length", expected: /未完整结束（length）/ },
	{ name: "流中途结束", text: '{"action":"query"', finish: null, expected: /未完整结束（error）/ },
	{ name: "开始前失败", text: "", finish: null, expected: /未完整结束（error）/, httpError: true },
]) {
	test(`${scenario.name}保留已收到正文，不记录推理或网关错误正文`, async (t) => {
		const server = createServer(async (request, response) => {
			for await (const _chunk of request) {
				/* 消费本地请求，避免测试服务在请求尚未读完时提前关闭连接。 */
			}
			if (scenario.httpError) {
				response.writeHead(401, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ error: { message: "网关私有诊断，不属于assistant正文" } }));
				return;
			}
			response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			const base = { id: "local-failure", object: "chat.completion.chunk", created: 1, model: "deepseek-test" };
			response.write(
				`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "不得保存的推理" }, finish_reason: null }] })}\n\n`,
			);
			for (const content of [scenario.text.slice(0, 4), scenario.text.slice(4)])
				response.write(
					`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
				);
			if (scenario.finish)
				response.write(
					`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: scenario.finish }] })}\n\n`,
				);
			response.end("data: [DONE]\n\n");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		t.after(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		});
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const config: AppConfig = {
			apiKey: "test-only-unused-credential",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			decisionModel: "deepseek-test",
			answerModel: "deepseek-test",
			maxActiveRuns: 1,
			llmMaxConcurrency: 1,
			evalMaxActiveRuns: 1,
			maxPending: 1,
			queueWaitTimeoutMs: 2000,
			llmTimeoutMs: 2000,
			runTimeoutMs: 4000,
			port: address.port,
			python: "unused",
			dataDir: "unused",
		};
		const receipts: ModelReceipt[] = [];
		const gateway = new ModelGateway(config);
		await assert.rejects(
			gateway.json("decision", "返回决策", {}, new AbortController().signal, receipts),
			scenario.expected,
		);
		assert.equal(receipts.length, 1);
		// 有明确4xx回执可结算；已发出的中断流缺少远端终态，必须保留未知占用。
		const unknown = scenario.finish === null && !scenario.httpError;
		assert.equal(receipts[0].status, unknown ? "unknown" : "failed");
		assert.equal(receipts[0].output_text, scenario.text);
		assert.equal(JSON.stringify(receipts).includes("不得保存的推理"), false);
		assert.equal(JSON.stringify(receipts).includes("网关私有诊断"), false);
		assert.equal(JSON.stringify(receipts).includes(config.apiKey), false);
		assert.deepEqual(gateway.pool.stats(), { active: unknown ? 1 : 0, pending: 0, peak: 1 });
	});
}
