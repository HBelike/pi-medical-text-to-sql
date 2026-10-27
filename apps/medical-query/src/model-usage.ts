export type VerifiedModelUsage = {
	/** 供应商报告的总输入，已包含缓存读取与写入，不能再叠加缓存量。 */
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
};
export type ModelUsageObservation = { valid: true; usage: VerifiedModelUsage } | { valid: false; reason: string };

const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const tokenCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// 只接受供应商明确提供的完整计量；SDK 缺字段时补出的零不能成为费用或 TPM 结算依据。
function verifyUsage(value: unknown): ModelUsageObservation {
	const usage = record(value);
	if (!usage || !tokenCount(usage.prompt_tokens) || !tokenCount(usage.completion_tokens))
		return { valid: false, reason: "incomplete_or_invalid_usage" };
	const total = usage.prompt_tokens + usage.completion_tokens;
	if (!Number.isSafeInteger(total) || (usage.total_tokens !== undefined && usage.total_tokens !== total))
		return { valid: false, reason: "inconsistent_total_tokens" };
	const details = usage.prompt_tokens_details === undefined ? {} : record(usage.prompt_tokens_details);
	if (!details) return { valid: false, reason: "invalid_cache_usage" };
	const reads = [details.cached_tokens, usage.prompt_cache_hit_tokens, usage.cached_tokens].filter(
		(item) => item !== undefined,
	);
	const read = reads[0] ?? 0;
	const write = details.cache_write_tokens === undefined ? 0 : details.cache_write_tokens;
	if (
		!tokenCount(read) ||
		!tokenCount(write) ||
		reads.some((item) => !tokenCount(item) || item !== read) ||
		read + write > usage.prompt_tokens
	)
		return { valid: false, reason: "invalid_cache_usage" };
	return {
		valid: true,
		usage: {
			input_tokens: usage.prompt_tokens,
			output_tokens: usage.completion_tokens,
			cache_read_tokens: read,
			cache_write_tokens: write,
			total_tokens: total,
		},
	};
}

/** 接入 Pi 原生 onProviderStreamEvent；调用方须在流完成后决定能否据此结算。 */
export function createModelUsageObserver(): {
	observe(event: unknown): void;
	current(): ModelUsageObservation;
} {
	let latest: ModelUsageObservation = { valid: false, reason: "missing_usage" };
	return {
		observe(event) {
			const parsed = record(event);
			if (!parsed) return;
			let observed: ModelUsageObservation | undefined;
			const accept = (value: unknown) => {
				// 正常文本帧常带 usage:null，它不表示新回执；实际存在的缺项用量则必须撤销旧确认。
				if (value == null) return;
				const candidate = verifyUsage(value);
				if (observed && !observed.valid) return;
				if (!candidate.valid || !observed) observed = candidate;
				else if (JSON.stringify(observed.usage) !== JSON.stringify(candidate.usage))
					observed = { valid: false, reason: "conflicting_usage_sources" };
			};
			accept(parsed.usage);
			// 兼容 choice.usage，但同一事件的多个来源须一致，不能求和或任意挑一个。
			if (Array.isArray(parsed.choices)) for (const choice of parsed.choices) accept(record(choice)?.usage);
			if (observed) latest = observed;
		},
		current() {
			// 仅保留固定大小的计量字段，不保存正文或原始事件，也不向调用方泄漏可变内部引用。
			return latest.valid ? { valid: true, usage: { ...latest.usage } } : { ...latest };
		},
	};
}
