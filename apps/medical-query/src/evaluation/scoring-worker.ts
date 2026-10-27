import type { EvaluationCase } from "./datasets.ts";
import { type EvaluationTurn, type ScoringOptions, scoreCase } from "./scoring.ts";

// 私有 gold 仅进入评分子进程；业务模型进程收不到它，也不能据此修复答案。
process.on("message", (job: { id: string; sample: EvaluationCase; turn: EvaluationTurn; options: ScoringOptions }) => {
	void scoreCase(job.sample, job.turn, job.options).then(
		(result) => process.send?.({ id: job.id, result }, () => process.disconnect?.()),
		(error) =>
			process.send?.({ id: job.id, error: error instanceof Error ? error.message : String(error) }, () =>
				process.disconnect?.(),
			),
	);
});
