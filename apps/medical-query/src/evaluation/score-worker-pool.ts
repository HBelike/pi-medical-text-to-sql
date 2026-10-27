import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ResourcePool } from "../resources.ts";
import type { EvaluationCase } from "./datasets.ts";
import type { CaseScore, EvaluationTurn, ScoringOptions } from "./scoring.ts";

export type ScoreJob = { sample: EvaluationCase; turn: EvaluationTurn; options: ScoringOptions };
// 仅供内部定向故障测试指定本地子进程；HTTP输入不能设置执行文件或改变共享CPU额度。
export type ScoreWorkerOptions = { workerPath?: string; timeoutMs?: number };
const sharedCpu = new ResourcePool(2, 300000);
const workerPath = fileURLToPath(new URL("./scoring-worker.ts", import.meta.url));
const workerVersion = "worker/v2";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// 请求ID只证明回执属于此子进程调用，案例与冻结档位也必须逐项相符，不能接受错槽或降档成绩。
function verifiedScore(value: unknown, job: ScoreJob): CaseScore {
	const result = record(value);
	if (!result) throw new Error("worker_invalid_result");
	const identity = {
		case_id: job.sample.id,
		slot_id: job.options.slotId || undefined,
		track: job.sample.track,
		family: job.sample.family,
		profile: job.sample.profile,
		expected_action: job.sample.expected_action,
	};
	for (const [key, expected] of Object.entries(identity))
		if (result[key] !== expected) throw new Error(`worker_identity_mismatch:${key}`);
	if (
		!strings(result.coverage_gaps) ||
		JSON.stringify(result.coverage_gaps) !== JSON.stringify(job.sample.coverage_gaps)
	)
		throw new Error("worker_identity_mismatch:coverage_gaps");
	if (
		!["pass", "fail", "unknown"].includes(String(result.status)) ||
		!["valid", "invalid_gold", "evaluator_error", "evidence_unavailable"].includes(String(result.evaluation_status)) ||
		typeof result.input_hash !== "string" ||
		!/^[a-f0-9]{64}$/.test(result.input_hash) ||
		typeof result.scorer_hash !== "string" ||
		!/^[a-f0-9]{64}$/.test(result.scorer_hash) ||
		!Array.isArray(result.checks) ||
		!result.checks.length
	)
		throw new Error("worker_invalid_result");
	const checks = new Set<string>();
	for (const raw of result.checks) {
		const check = record(raw);
		if (
			!check ||
			typeof check.check_id !== "string" ||
			!check.check_id ||
			checks.has(check.check_id) ||
			!["pass", "fail", "not_applicable", "not_evaluated"].includes(String(check.status)) ||
			!["valid", "invalid_gold", "evaluator_error", "evidence_unavailable"].includes(String(check.evaluation_status)) ||
			typeof check.reason_code !== "string" ||
			!strings(check.evidence_refs) ||
			typeof check.scorer_version !== "string" ||
			!check.scorer_version ||
			!["quality", "critical"].includes(String(check.severity)) ||
			(check.details !== undefined && !record(check.details))
		)
			throw new Error("worker_invalid_check");
		checks.add(check.check_id);
	}
	return result as CaseScore;
}

// 先锁定唯一候选，再等待真实进程正常退出；超时、取消、信号或错误退出均否决已收到的候选。
function executeWorker(job: ScoreJob, signal: AbortSignal, options: ScoreWorkerOptions): Promise<CaseScore> {
	signal.throwIfAborted();
	return new Promise((accept, reject) => {
		const id = randomUUID();
		const child = fork(options.workerPath ?? workerPath, [], {
			execArgv: process.execArgv.filter((arg) => !arg.startsWith("--test")),
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			// 评分进程只获得运行环境；不继承模型密钥、网关配置或其他父进程凭据。
			env: { PATH: process.env.PATH, LANG: process.env.LANG },
		});
		let received = false,
			settled = false;
		let result: CaseScore | undefined;
		let error: Error | undefined;
		const fail = (reason: Error) => {
			if (settled) return;
			error ??= reason;
			// kill仅请求终止，许可仍由close事件确认退出后释放。
			child.kill("SIGKILL");
		};
		const abort = () => fail(new Error("worker_cancelled"));
		const timeout = setTimeout(() => fail(new Error("worker_timeout")), options.timeoutMs ?? 30000);
		signal.addEventListener("abort", abort, { once: true });
		child.on("message", (message: unknown) => {
			if (settled || received || error) return;
			received = true;
			const response = record(message);
			if (!response || response.id !== id) return fail(new Error("worker_response_id_mismatch"));
			if (typeof response.error === "string") return fail(new Error(`worker_reported_error:${response.error}`));
			if (response.error !== undefined) return fail(new Error("worker_invalid_response"));
			try {
				result = verifiedScore(response.result, job);
			} catch (reason) {
				fail(reason instanceof Error ? reason : new Error("worker_invalid_result"));
			}
		});
		child.on("error", fail);
		child.once("close", (code, exitSignal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			if (signal.aborted) reject(new Error("worker_cancelled"));
			else if (error) reject(error);
			else if (code !== 0 || exitSignal) reject(new Error(`worker_abnormal_exit:${code ?? exitSignal ?? "unknown"}`));
			else if (!result) reject(new Error("worker_missing_receipt"));
			else accept(result);
		});
		// 订阅前发生的取消也必须生效；在此之后不再向子进程发送评分任务。
		if (signal.aborted) abort();
		else {
			try {
				child.send({ id, ...job }, (reason) => {
					if (reason) fail(reason);
				});
			} catch (reason) {
				fail(reason instanceof Error ? reason : new Error("worker_send_failed"));
			}
		}
	});
}

/** 全部调用共用两个评分许可；取消等到本批已启动进程退出后拒绝，不返回可提交的成绩。 */
export async function scoreInWorkers(
	jobs: ScoreJob[],
	signal: AbortSignal,
	concurrency = 2,
	options: ScoreWorkerOptions = {},
): Promise<CaseScore[]> {
	signal.throwIfAborted();
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2)
		throw new Error("invalid_score_concurrency");
	if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1))
		throw new Error("invalid_score_timeout");
	const results: CaseScore[] = new Array(jobs.length);
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
			while (cursor < jobs.length && !signal.aborted) {
				const index = cursor++,
					job = jobs[index];
				try {
					results[index] = await sharedCpu.run(() => executeWorker(job, signal, options), signal);
				} catch (error) {
					if (signal.aborted) return;
					results[index] = {
						case_id: job.sample.id,
						slot_id: job.options.slotId,
						track: job.sample.track,
						family: job.sample.family,
						profile: job.sample.profile,
						expected_action: job.sample.expected_action,
						status: "unknown",
						evaluation_status: "evaluator_error",
						checks: [
							{
								check_id: "worker",
								status: "not_evaluated",
								evaluation_status: "evaluator_error",
								reason_code: error instanceof Error ? error.message : "worker_failed",
								evidence_refs: [],
								scorer_version: workerVersion,
								severity: "quality",
							},
						],
						input_hash: "unavailable",
						scorer_hash: workerVersion,
						coverage_gaps: job.sample.coverage_gaps,
					};
				}
			}
		}),
	);
	signal.throwIfAborted();
	return results;
}
