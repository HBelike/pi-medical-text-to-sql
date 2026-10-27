import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseDataset } from "../src/evaluation/datasets.ts";
import { type ScoreJob, scoreInWorkers } from "../src/evaluation/score-worker-pool.ts";

// 故障脚本通过真实IPC回执，绝不持有凭据或连接提供商；事件日志只记录合成身份和PID。
const faultWorker = `
import { appendFileSync } from 'node:fs';
process.on('message', job => {
  const control = job.turn.error ?? {};
  const event = kind => appendFileSync(control.log, JSON.stringify({kind, pid:process.pid, case:job.sample.id, at:Date.now(), inherited_secret:!!process.env.SCORE_WORKER_TEST_SECRET})+'\\n');
  event('start');
  process.on('exit', () => event('exit'));
  const result = {
    case_id:job.sample.id, slot_id:job.options.slotId, track:job.sample.track,
    family:job.sample.family, profile:job.sample.profile, expected_action:job.sample.expected_action,
    status:'pass', evaluation_status:'valid', coverage_gaps:job.sample.coverage_gaps,
    input_hash:'a'.repeat(64), scorer_hash:'b'.repeat(64),
    checks:[{check_id:'synthetic',status:'pass',evaluation_status:'valid',reason_code:'local_test',evidence_refs:[],scorer_version:'test/v1',severity:'quality'}],
  };
  const send = (message, done = () => process.disconnect()) => process.send(message, done);
  if (control.mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (control.mode === 'throw') throw new Error('synthetic_worker_exception');
  if (control.mode === 'silent') { process.exit(0); return; }
  if (control.mode === 'error') { send({id:job.id,error:'synthetic_evaluator_error'}); return; }
  if (control.mode === 'wrong-id') { send({id:'wrong',result},()=>send({id:job.id,result})); return; }
  if (control.mode === 'malformed') { send(null); return; }
  if (control.mode === 'wrong-field') { result[control.field] = control.field === 'coverage_gaps' ? ['invented'] : 'wrong'; }
  if (control.mode === 'bad-check') result.checks[0].evidence_refs = 'invalid';
  if (control.mode === 'duplicate' || control.mode === 'late-wrong-id') {
    result.status='fail'; result.checks[0].status='fail';
    send({id:job.id,result},()=>{
      result.status='pass'; result.checks[0].status='pass';
      setTimeout(()=>send({id:control.mode==='duplicate'?job.id:'wrong-late-id',result}),30);
    }); return;
  }
  if (control.mode === 'crash-after-result') { send({id:job.id,result},()=>process.exit(7)); return; }
  if (control.mode === 'result-before-exit') {
    send({id:job.id,result},()=>{event('sent');setTimeout(()=>process.disconnect(),control.delay??1000);}); return;
  }
  setTimeout(()=>send({id:job.id,result}),control.delay??0);
});
`;
type WorkerEvent = { kind: string; pid: number; case: string; at: number; inherited_secret: boolean };
async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pi-score-worker-"));
	const path = join(directory, "worker.mjs"),
		log = join(directory, "events.jsonl");
	await writeFile(path, faultWorker);
	await writeFile(log, "");
	t.after(() => rm(directory, { recursive: true, force: true }));
	const events = async (): Promise<WorkerEvent[]> =>
		(await readFile(log, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	return { path, log, events };
}
function job(id: string, control?: Record<string, unknown>): ScoreJob {
	const question = { id, source_id: "synthetic", question: "合成人次数", as_of: "2026-10-15T12:00:00+08:00" };
	const sample = parseDataset({
		questionsJsonl: JSON.stringify(question),
		goldJsonl: JSON.stringify({
			...question,
			family_id: "synthetic-visits",
			split: "dev",
			category: "synthetic_fact_query",
			expected_action: "answer",
			expected_rows: [{ n: 1 }],
		}),
	}).cases[0];
	return {
		sample,
		turn: {
			status: "completed",
			result: { columns: ["n"], rows: [[1]], row_count: 1, complete: true, truncated: false },
			...(control ? { error: control } : {}),
		},
		options: { slotId: `slot-${id}` },
	};
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 5000;
	for (;;) {
		const value = await read();
		if (ready(value)) return value;
		assert.ok(Date.now() < deadline, "子进程事件应在期限内发生");
		await delay(10);
	}
}
function exited(pid: number): void {
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "返回评分后进程必须已实际退出");
}

test("生产评分子进程返回真实CaseScore及原始槽位身份", async () => {
	const scores = await scoreInWorkers([job("real")], new AbortController().signal);
	assert.equal(scores[0].status, "pass");
	assert.equal(scores[0].evaluation_status, "valid");
	assert.equal(scores[0].case_id, "real");
	assert.equal(scores[0].slot_id, "slot-real");
	assert.ok(scores[0].checks.some((check) => check.check_id === "result" && check.status === "pass"));
});

// 相同请求ID的后到消息不能改写首次失败；错ID在第一条出现则整个子进程协议失败。
for (const mode of ["duplicate", "late-wrong-id"]) {
	test(`评分回执${mode}不能覆盖首条成绩`, async (t) => {
		const env = await fixture(t);
		const [score] = await scoreInWorkers([job(mode, { mode, log: env.log })], new AbortController().signal, 2, {
			workerPath: env.path,
		});
		assert.equal(score.status, "fail");
		assert.equal(score.evaluation_status, "valid");
		exited((await env.events())[0].pid);
	});
}

for (const field of ["case_id", "slot_id", "track", "family", "profile", "expected_action", "coverage_gaps"]) {
	test(`评分子进程拒绝错${field}回执`, async (t) => {
		const env = await fixture(t);
		const [score] = await scoreInWorkers(
			[job(field, { mode: "wrong-field", field, log: env.log })],
			new AbortController().signal,
			2,
			{ workerPath: env.path },
		);
		assert.equal(score.status, "unknown");
		assert.equal(score.evaluation_status, "evaluator_error");
		assert.equal(score.case_id, field);
		assert.equal(score.slot_id, `slot-${field}`);
		assert.equal(score.checks[0].reason_code, `worker_identity_mismatch:${field}`);
		exited((await env.events())[0].pid);
	});
}

for (const [mode, reason] of [
	["wrong-id", "worker_response_id_mismatch"],
	["malformed", "worker_response_id_mismatch"],
	["bad-check", "worker_invalid_check"],
	["error", "worker_reported_error:synthetic_evaluator_error"],
	["throw", "worker_abnormal_exit:1"],
	["silent", "worker_missing_receipt"],
	["crash-after-result", "worker_abnormal_exit:7"],
]) {
	test(`真实评分进程${mode}按裁判故障记录且不接受候选`, async (t) => {
		const env = await fixture(t);
		const [score] = await scoreInWorkers([job(mode, { mode, log: env.log })], new AbortController().signal, 2, {
			workerPath: env.path,
		});
		assert.equal(score.status, "unknown");
		assert.equal(score.evaluation_status, "evaluator_error");
		assert.equal(score.checks[0].reason_code, reason);
		exited((await env.events())[0].pid);
	});
}

for (const mode of ["hang", "result-before-exit"])
	test(`${mode}超时强杀并确认退出后才释放许可`, async (t) => {
		const env = await fixture(t);
		const [score] = await scoreInWorkers(
			[job("timeout", { mode, log: env.log, delay: 5000 })],
			new AbortController().signal,
			2,
			{ workerPath: env.path, timeoutMs: 1500 },
		);
		assert.equal(score.checks[0].reason_code, "worker_timeout");
		assert.equal(score.status, "unknown");
		if (mode === "result-before-exit") assert.ok((await env.events()).some((event) => event.kind === "sent"));
		exited((await env.events())[0].pid);
	});

test("外部SIGKILL不能把已发送的评分任务判为通过", async (t) => {
	const env = await fixture(t);
	const result = scoreInWorkers([job("kill", { mode: "hang", log: env.log })], new AbortController().signal, 2, {
		workerPath: env.path,
	});
	const events = await until(env.events, (values) => values.length > 0);
	process.kill(events[0].pid, "SIGKILL");
	const [score] = await result;
	assert.equal(score.status, "unknown");
	assert.equal(score.checks[0].reason_code, "worker_abnormal_exit:SIGKILL");
	exited(events[0].pid);
});

test("两个成功候选仍等待退出，取消后不提交成绩且不启动剩余槽位", async (t) => {
	const env = await fixture(t),
		controller = new AbortController();
	let returned = false;
	const promise = scoreInWorkers(
		[
			...Array.from({ length: 2 }, (_, index) =>
				job(`cancel-${index}`, { mode: "result-before-exit", log: env.log, delay: 5000 }),
			),
			job("not-started", { log: env.log }),
		],
		controller.signal,
		2,
		{ workerPath: env.path },
	).then((result) => {
		returned = true;
		return result;
	});
	const events = await until(env.events, (values) => values.filter((value) => value.kind === "sent").length === 2);
	assert.equal(returned, false);
	controller.abort(new Error("cancelled-for-test"));
	await assert.rejects(promise, /cancelled-for-test/);
	assert.equal(returned, false);
	for (const pid of new Set(events.map((event) => event.pid))) exited(pid);
	assert.ok((await env.events()).every((event) => event.case !== "not-started"));
});

test("多批评分共享两个真实进程许可，排队取消不启动且不继承父凭据", async (t) => {
	const env = await fixture(t),
		controller = new AbortController();
	const prior = process.env.SCORE_WORKER_TEST_SECRET;
	process.env.SCORE_WORKER_TEST_SECRET = "synthetic-test-sentinel";
	try {
		const first = scoreInWorkers(
			[job("held-a", { log: env.log, delay: 400 }), job("held-b", { log: env.log, delay: 400 })],
			new AbortController().signal,
			2,
			{ workerPath: env.path },
		);
		await until(env.events, (values) => values.filter((value) => value.kind === "start").length === 2);
		const cancelled = scoreInWorkers([job("queued-cancel", { log: env.log })], controller.signal, 2, {
			workerPath: env.path,
		});
		controller.abort(new Error("queued-cancelled"));
		await assert.rejects(cancelled, /queued-cancelled/);
		const second = scoreInWorkers(
			Array.from({ length: 4 }, (_, index) => job(`next-${index}`, { log: env.log, delay: 30 })),
			new AbortController().signal,
			2,
			{ workerPath: env.path },
		);
		const scores = (await Promise.all([first, second])).flat();
		assert.equal(scores.length, 6);
		assert.ok(scores.every((score) => score.status === "pass"));
		const events = await env.events();
		let active = 0,
			peak = 0;
		for (const event of events) {
			assert.equal(event.inherited_secret, false);
			assert.notEqual(event.case, "queued-cancel");
			active += event.kind === "start" ? 1 : -1;
			peak = Math.max(peak, active);
			assert.ok(active >= 0 && active <= 2, "跨调用的实际子进程不能超过共享额度");
		}
		assert.equal(active, 0);
		assert.equal(peak, 2);
		for (const pid of new Set(events.map((event) => event.pid))) exited(pid);
	} finally {
		if (prior === undefined) delete process.env.SCORE_WORKER_TEST_SECRET;
		else process.env.SCORE_WORKER_TEST_SECRET = prior;
	}
});

test("非法并发和超时在启动子进程前拒绝", async () => {
	await assert.rejects(scoreInWorkers([job("invalid")], new AbortController().signal, 0), /invalid_score_concurrency/);
	await assert.rejects(scoreInWorkers([job("invalid")], new AbortController().signal, 3), /invalid_score_concurrency/);
	await assert.rejects(
		scoreInWorkers([job("invalid")], new AbortController().signal, 2, { timeoutMs: 0 }),
		/invalid_score_timeout/,
	);
});
