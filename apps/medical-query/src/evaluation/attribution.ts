import type { QueryTask } from "../runtime.ts";
import { summarizeStageRepairs } from "./comparison.ts";
import { asRecord } from "./datasets.ts";

type RecordValue = Record<string, unknown>;
const records = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(asRecord) : []);

/** 从真实阶段和修复引用统计局部校验机会；阶段通过只代表该阶段的校验，不代替整题评分。 */
export function stageAttribution(turns: QueryTask[]) {
	const opportunities: {
		slot_id: string;
		stage_id: string;
		stage: string;
		before: "pass" | "fail" | "unknown";
		after: "pass" | "fail" | "unknown";
		triggered: boolean;
		protected_constraints_preserved: boolean;
		evidence_refs: string[];
	}[] = [];
	for (const turn of turns) {
		const payload = asRecord(turn.result ?? turn.progress);
		const stages = records(payload.stages),
			repairs = records(payload.repairs);
		const repairedStages = new Set(repairs.map((repair) => repair.after_stage_id));
		const seen = new Set<string>();
		for (const stage of stages) {
			if (stage.kind === "catalog" || repairedStages.has(stage.id)) continue;
			// 同一轮同一标签只取第一次校验，普通重试/多次修复不能扩充机会分母。
			const key = JSON.stringify([stage.run_id, stage.kind, stage.label]);
			if (seen.has(key)) continue;
			seen.add(key);
			const related = repairs.filter((repair) => repair.attempt_id === stage.id);
			// 顺着 after_stage_id 追踪同一次机会的后续修复，不跨标签拼接成功证据。
			for (let index = 0; index < related.length; index++) {
				for (const next of repairs)
					if (next.attempt_id === related[index].after_stage_id && !related.includes(next)) related.push(next);
			}
			const final = related.at(-1),
				afterStage = final ? stages.find((item) => item.id === final.after_stage_id) : stage;
			const before = stage.status === "completed" ? "pass" : stage.status === "failed" ? "fail" : "unknown";
			const after = final
				? afterStage?.status === "failed"
					? "fail"
					: final.revalidated === true && afterStage?.status === "completed"
						? "pass"
						: "unknown"
				: before;
			opportunities.push({
				slot_id: String(turn.context.slot_id ?? turn.id),
				stage_id: String(stage.id),
				stage: `${stage.kind}:${stage.label}`,
				before,
				after,
				triggered: related.length > 0,
				// 只认生产校验明确记录的约束保持；null 不推断成 true。
				protected_constraints_preserved: !final || final.protected_constraints_preserved === true,
				evidence_refs: [stage.id, ...related.flatMap((repair) => [repair.diagnostic_id, repair.after_stage_id])].filter(
					(id): id is string => typeof id === "string",
				),
			});
		}
	}
	return { basis: "recorded_local_stage_validation", groups: summarizeStageRepairs(opportunities), opportunities };
}

/** 耗时使用实际墙钟与模型回执，未知费用/用量保留 null 和未知计数。 */
export function observedPerformance(turns: QueryTask[]) {
	const calls = turns.flatMap((turn) => records(asRecord(turn.result ?? turn.progress).usage));
	const durations = turns
		.filter((turn) => turn.endedAt != null)
		.map((turn) => turn.endedAt! - turn.createdAt)
		.sort((a, b) => a - b);
	const sum = (key: string) => {
		const known = calls.filter((call) => typeof call[key] === "number" && Number.isFinite(call[key]));
		return {
			known_total: known.reduce((total, call) => total + Number(call[key]), 0),
			unknown_calls: calls.length - known.length,
		};
	};
	return {
		calls: calls.length,
		cost:
			calls.length === 0 ? 0 : calls.every((call) => typeof call.cost === "number") ? sum("cost").known_total : null,
		input_tokens: sum("input_tokens"),
		output_tokens: sum("output_tokens"),
		cache_read_tokens: sum("cache_read_tokens"),
		model_queue_ms: sum("queue_ms"),
		model_duration_ms: sum("duration_ms"),
		end_to_end: {
			count: durations.length,
			p50_ms: durations.length ? durations[Math.ceil(durations.length * 0.5) - 1] : null,
			p95_ms: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null,
			p95_is_sample_max: durations.length > 0 && durations.length < 20,
		},
		gating: false,
	};
}

/** 只比较已归档的实际披露与私有 gold，不把搜索提示、失败读取或旧运行段当已读元信息。 */
export function observedRetrievalCoverage(entries: { turn: QueryTask; required_tables?: string[]; slot_id: string }[]) {
	const items = entries.map(({ turn, required_tables, slot_id }) => {
		const payload = asRecord(turn.result ?? turn.progress),
			allReceipts = records(payload.retrievals);
		const runIds = new Set(
			[...allReceipts, ...records(payload.stages)]
				.map((entry) => entry.run_id)
				.filter((id): id is string => typeof id === "string"),
		);
		const runId = turn.runId ?? [...runIds].at(-1) ?? null;
		// 旧归档没有 run_id 时只允许单运行段回退；多轮混合且无法归属的收据保持未知。
		const receipts = allReceipts.filter((receipt) =>
			typeof receipt.run_id === "string"
				? receipt.run_id === runId
				: runIds.size <= 1 && (!runIds.size || runIds.has(String(runId))),
		);
		const l0 =
			asRecord(payload.evidence).profile === "l0_schema_linking" ||
			typeof asRecord(turn.context.source_snapshot).knowledge_path === "string" ||
			allReceipts.some((receipt) => receipt.schema_version === "knowledge-projection/v1");
		const progressive = receipts.some((receipt) => receipt.schema_version === "schema-disclosure/v1");
		const attempts = l0
			? []
			: receipts.filter((receipt) =>
					progressive
						? receipt.schema_version === "schema-disclosure/v1" && receipt.action === "read"
						: receipt.schema_version === "retrieval-receipt/v1",
				);
		const successful = attempts.filter(
			(receipt) =>
				!receipt.error_code &&
				(receipt.status === undefined || ["complete", "completed", "succeeded"].includes(String(receipt.status))),
		);
		const required = required_tables === undefined ? null : [...new Set(required_tables)].sort();
		const reason = l0
			? "l0_rule_projection_not_fact_table_retrieval"
			: required === null
				? "required_tables_not_annotated"
				: !successful.length
					? "successful_current_run_read_not_recorded"
					: null;
		const view = (receipt: RecordValue | undefined) => {
			const admitted =
				receipt && Array.isArray(receipt.admitted_ids) && receipt.admitted_ids.every((id) => typeof id === "string")
					? [...new Set(receipt.admitted_ids as string[])].sort()
					: null;
			const missing = reason === null && admitted ? required!.filter((table) => !admitted.includes(table)) : null;
			const actual = asRecord(receipt?.character_budget).actual;
			return {
				complete: missing === null ? null : missing.length === 0,
				admitted_ids: admitted,
				missing_tables: missing,
				characters: typeof actual === "number" && Number.isFinite(actual) && actual >= 0 ? actual : null,
			};
		};
		const characterValues = successful.map((receipt) => asRecord(receipt.character_budget).actual);
		const knownCharacters = characterValues.filter(
			(value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
		);
		return {
			slot_id,
			run_id: runId,
			track: l0 ? "l0_schema_linking" : "fact_query",
			strategy: progressive ? "progressive" : (attempts.at(-1)?.strategy ?? turn.context.retrieval_strategy ?? null),
			required_tables: required,
			first: view(successful[0]),
			final: view(successful.at(-1)),
			read_attempts: attempts.length,
			successful_reads: successful.length,
			failed_reads: attempts.length - successful.length,
			// 每次成功披露都按实际累计上下文计量；该总量不是去重字典大小，也不是 token 数。
			read_characters: {
				known_total: knownCharacters.reduce((sum, value) => sum + value, 0),
				unknown_reads: characterValues.length - knownCharacters.length,
			},
			reason,
		};
	});
	const applicable = items.filter((item) => item.track === "fact_query");
	return {
		basis: "recorded_current_run_catalog_reads",
		gating: false,
		aggregate: {
			slots: items.length,
			applicable: applicable.length,
			not_applicable: items.length - applicable.length,
			known: applicable.filter((item) => item.first.complete !== null && item.final.complete !== null).length,
			unknown: applicable.filter((item) => item.first.complete === null || item.final.complete === null).length,
			first_complete: applicable.filter((item) => item.first.complete === true).length,
			final_complete: applicable.filter((item) => item.final.complete === true).length,
			recovered: applicable.filter((item) => item.first.complete === false && item.final.complete === true).length,
			regressed: applicable.filter((item) => item.first.complete === true && item.final.complete === false).length,
		},
		items,
	};
}
