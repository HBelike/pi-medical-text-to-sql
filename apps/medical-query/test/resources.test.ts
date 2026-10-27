import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readConfig } from "../src/config.ts";
import { ResourcePool } from "../src/resources.ts";

// 上限测试使用实际未结束的异步工作计数，不把快速返回的流对象当作完成。
for (const cap of [1, 5, 10]) {
	test(`资源上限 ${cap}、两倍请求不突破真实活动数`, async () => {
		const pool = new ResourcePool(cap, 2000);
		let active = 0,
			peak = 0;
		await Promise.all(
			Array.from({ length: cap * 2 }, () =>
				pool.run(async () => {
					active++;
					peak = Math.max(peak, active);
					await delay(15);
					active--;
				}, new AbortController().signal),
			),
		);
		assert.equal(peak, cap);
		assert.deepEqual(pool.stats(), { active: 0, pending: 0, peak: cap });
	});
}
test("排队取消不调用工作，运行取消等底层退出才释放", async () => {
	const pool = new ResourcePool(1, 2000);
	const running = new AbortController();
	const barrier = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const first = pool.run(async () => {
		started.resolve();
		await barrier.promise;
	}, running.signal);
	await started.promise;
	const queued = new AbortController();
	let invoked = false;
	const second = pool.run(async () => {
		invoked = true;
	}, queued.signal);
	const secondRejected = assert.rejects(second);
	queued.abort();
	running.abort();
	await secondRejected;
	assert.equal(invoked, false);
	assert.equal(pool.stats().active, 1);
	barrier.resolve();
	await first;
	assert.equal(pool.stats().active, 0);
	await pool.run(async () => {}, new AbortController().signal);
});
test("队列超时和异常均不泄漏名额", async () => {
	const pool = new ResourcePool(1, 15);
	const barrier = Promise.withResolvers<void>();
	const first = pool.run(() => barrier.promise, new AbortController().signal);
	await assert.rejects(
		pool.run(async () => {
			throw new Error("不应启动");
		}, new AbortController().signal),
		/排队超时/,
	);
	barrier.resolve();
	await first;
	await assert.rejects(
		pool.run(async () => {
			throw new Error("受控失败");
		}, new AbortController().signal),
		/受控失败/,
	);
	assert.equal(pool.stats().active, 0);
});
test("配置拒绝非法并发及大于总额度的评测配置", () => {
	assert.throws(() => readConfig({ PI_MAX_ACTIVE_RUNS: "11" }), /1～10/);
	assert.throws(() => readConfig({ PI_MAX_ACTIVE_RUNS: "5", PI_EVAL_MAX_ACTIVE_RUNS: "6" }), /1～5/);
});

// 持续在线不能饿死评测；大实验不能靠更多排队项挤掉其他实验。
test("在线4:1保底与实验轮转共同生效", async () => {
	const pool = new ResourcePool(1, 2000);
	const gate = Promise.withResolvers<void>();
	const first = pool.run(() => gate.promise, new AbortController().signal);
	const order: string[] = [];
	const tasks = Array.from({ length: 12 }, (_, index) =>
		pool.run(async () => {
			order.push(`online${index}`);
		}, new AbortController().signal),
	);
	for (const experiment of ["a", "a", "a", "b"])
		tasks.push(
			pool.run(
				async () => {
					order.push(experiment);
				},
				new AbortController().signal,
				{ mode: "eval", experiment_id: experiment },
			),
		);
	gate.resolve();
	await first;
	await Promise.all(tasks);
	assert.ok(order.indexOf("a") < 5);
	assert.deepEqual(order.filter((name) => name === "a" || name === "b").slice(0, 2), ["a", "b"]);
});

test("未知占用阻止新增发送，显式释放后才准入", async () => {
	const pool = new ResourcePool(1, 2000);
	await pool.run(async (lease) => {
		lease.hold("unknown-call");
	}, new AbortController().signal);
	let sent = false;
	const waiting = pool.run(async () => {
		sent = true;
	}, new AbortController().signal);
	await delay(10);
	assert.equal(sent, false);
	assert.equal(pool.stats().active, 1);
	pool.releaseHold("unknown-call");
	await waiting;
	assert.equal(sent, true);
});

// 速率等待发生在队列，未发送的请求不能在状态面板冒充真实模型在途。
test("账号速率门等待不占模型额度", async () => {
	const pool = new ResourcePool(1, 1000),
		readyAt = Date.now() + 30;
	let reserved = 0;
	const running = pool.run(
		async () => true,
		new AbortController().signal,
		{ mode: "eval" },
		{
			waitMs: () => Math.max(0, readyAt - Date.now()),
			admitted: () => {
				reserved++;
			},
		},
	);
	assert.equal(pool.stats().active, 0);
	assert.equal(pool.stats().pending, 1);
	assert.equal(await running, true);
	assert.equal(reserved, 1);
	assert.equal(pool.stats().active, 0);
});
