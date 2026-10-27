import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createModelUsageObserver } from "../src/model-usage.ts";

const fullUsage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
const expected = {
	valid: true,
	usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 120 },
};

// 直接观察 Pi 提供的原始事件，不另外解析或转换网络正文。
test("没有用量时保持未知，文本与null用量不重置先前回执", () => {
	const observer = createModelUsageObserver();
	for (const event of [undefined, null, [], "text", {}, { usage: null }, { choices: [{ delta: { content: "正文" } }] }])
		observer.observe(event);
	assert.deepEqual(observer.current(), { valid: false, reason: "missing_usage" });
	observer.observe({ usage: fullUsage });
	for (const event of [{}, { usage: null }, { choices: [{ usage: null, delta: { content: "后续正文" } }] }])
		observer.observe(event);
	assert.deepEqual(observer.current(), expected);
});

for (const [name, usage] of [
	["缺输入", { completion_tokens: 20 }],
	["缺输出", { prompt_tokens: 100 }],
	["null输入", { prompt_tokens: null, completion_tokens: 20 }],
	["字符串输入", { prompt_tokens: "100", completion_tokens: 20 }],
	["负输出", { prompt_tokens: 100, completion_tokens: -1 }],
	["小数输入", { prompt_tokens: 0.5, completion_tokens: 20 }],
	["不安全整数", { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 20 }],
	["总和溢出", { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 20 }],
	["total矛盾", { ...fullUsage, total_tokens: 119 }],
	["total为空", { ...fullUsage, total_tokens: null }],
	["缓存大于输入", { ...fullUsage, prompt_cache_hit_tokens: 101 }],
	["缓存写入为空", { ...fullUsage, prompt_tokens_details: { cache_write_tokens: null } }],
	["缓存读写超额", { ...fullUsage, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 21 } }],
	["缓存别名矛盾", { ...fullUsage, prompt_cache_hit_tokens: 50, cached_tokens: 60 }],
	["缓存详情为空", { ...fullUsage, prompt_tokens_details: null }],
	["负缓存", { ...fullUsage, cached_tokens: -1 }],
	["缓存小数", { ...fullUsage, cached_tokens: 0.5 }],
	["缓存字符串", { ...fullUsage, cached_tokens: "60" }],
	["用量非对象", false],
] as const)
	test(`原始用量${name}时保持未知，不把缺项补为零`, () => {
		const observer = createModelUsageObserver();
		observer.observe({ usage });
		assert.equal(observer.current().valid, false);
	});

test("原始零用量合法，总计缺省可由完整输入输出相加", () => {
	const observer = createModelUsageObserver();
	observer.observe({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
	assert.deepEqual(observer.current(), {
		valid: true,
		usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0 },
	});
	observer.observe({ usage: { prompt_tokens: 100, completion_tokens: 20 } });
	assert.deepEqual(observer.current(), expected);
});

test("缓存读写已计入输入，各供应商缓存别名仅做一致性确认", () => {
	const observer = createModelUsageObserver();
	observer.observe({
		usage: {
			...fullUsage,
			prompt_cache_hit_tokens: 60,
			cached_tokens: 60,
			prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 },
		},
	});
	assert.deepEqual(observer.current(), {
		valid: true,
		usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 60, cache_write_tokens: 10, total_tokens: 120 },
	});
});

test("choice.usage兼容且重复一致来源不叠加，矛盾来源保持未知", () => {
	const observer = createModelUsageObserver();
	observer.observe({ usage: null, choices: [{ usage: fullUsage }] });
	assert.deepEqual(observer.current(), expected);
	observer.observe({ usage: fullUsage, choices: [{ usage: fullUsage }, { usage: fullUsage }] });
	assert.deepEqual(observer.current(), expected);
	observer.observe({ usage: fullUsage, choices: [{ usage: { prompt_tokens: 90, completion_tokens: 20 } }] });
	assert.deepEqual(observer.current(), { valid: false, reason: "conflicting_usage_sources" });
});

test("同事件一个来源缺项便保持未知，不能用另一个完整来源遮盖", () => {
	const observer = createModelUsageObserver();
	observer.observe({ usage: fullUsage, choices: [{ usage: { prompt_tokens: 100 } }] });
	assert.equal(observer.current().valid, false);
	observer.observe({ usage: { prompt_tokens: 100 }, choices: [{ usage: fullUsage }] });
	assert.equal(observer.current().valid, false);
});

test("最后实际usage缺项撤销旧确认，后续完整usage可提供新的确认", () => {
	const observer = createModelUsageObserver();
	observer.observe({ usage: fullUsage });
	observer.observe({ usage: { prompt_tokens: 200 } });
	assert.deepEqual(observer.current(), { valid: false, reason: "incomplete_or_invalid_usage" });
	observer.observe({ choices: [] });
	assert.equal(observer.current().valid, false);
	observer.observe({ usage: fullUsage });
	assert.deepEqual(observer.current(), expected);
});

test("观察器只保留数值副本，调用方修改与正文均不能污染回执", () => {
	const observer = createModelUsageObserver();
	const usage = { ...fullUsage };
	const content = "不保留的正文".repeat(100000);
	const event = { usage, choices: [{ delta: { content } }] };
	observer.observe(event);
	usage.prompt_tokens = 999;
	const snapshot = observer.current();
	assert.ok(snapshot.valid);
	snapshot.usage.input_tokens = 888;
	assert.deepEqual(observer.current(), expected);
	assert.equal(JSON.stringify(observer.current()).includes("正文"), false);
	assert.equal(event.choices[0].delta.content, content);
});

// 真实 Pi 原生 hook 在归一化前接收事件；自定义 fetch 只提供本机合成响应，不建立网络连接。
for (const [name, usage, valid] of [
	["完整", fullUsage, true],
	["缺输出", { prompt_tokens: 100 }, false],
] as const)
	test(`Pi原生事件回调读取${name}用量，正文解析不受影响`, async () => {
		const observer = createModelUsageObserver();
		const content = '{"回答":"原文保持"}';
		const base = { id: "local-usage", object: "chat.completion.chunk", created: 1, model: "deepseek-test" };
		const chunks = [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
		];
		const text = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
		const model: Model<"openai-completions"> = {
			id: "deepseek-test",
			name: "local-only",
			api: "openai-completions",
			provider: "deepseek",
			baseUrl: "http://127.0.0.1:1/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 65536,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		let received = 0;
		const events = stream(model, normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 1 }] }), {
			apiKey: "local-only",
			maxRetries: 0,
			fetch: async () => new Response(text, { headers: { "content-type": "text/event-stream" } }),
			onProviderStreamEvent: (chunk) => {
				received++;
				observer.observe(chunk);
			},
		});
		let deltas = "";
		for await (const event of events) if (event.type === "text_delta") deltas += event.delta;
		const result = await events.result();
		assert.equal(received, 2);
		assert.equal(result.stopReason, "stop");
		assert.equal(deltas, content);
		assert.deepEqual(
			result.content.filter((part) => part.type === "text").map((part) => part.text),
			[content],
		);
		assert.equal(observer.current().valid, valid);
		if (valid) assert.deepEqual(observer.current(), expected);
		else assert.equal(result.usage.output, 0); // Pi 的默认零仅用于其自身解析，不成为原始用量确认。
	});
