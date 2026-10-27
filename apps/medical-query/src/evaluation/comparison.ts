import { asRecord, type CheckProfile, canonicalJson, contentHash, immutable } from "./datasets.ts";
import type { CaseScore } from "./scoring.ts";

export type AllowedDifference = { path: string; values: unknown[] };
export type PlannedSlot = {
	slot_id: string;
	case_id: string;
	family: string;
	variant_id: string;
	repeat_index: number;
	snapshot_id: string;
};
export type RepairArm = "repair_off" | "repair_on" | "ordinary_retry";
export type ComparisonProtocol = {
	arms: { variant_id: string; kind: RepairArm }[];
	bundles: Record<string, Record<string, unknown>>;
	allowed_differences: AllowedDifference[];
	required_verified_paths: string[];
	equal_budget_paths: string[];
	bootstrap_repetitions?: number;
	bootstrap_seed?: number;
};
export type NecessaryFailure = {
	check_id: string;
	artifact_hash: string;
	predicate: string;
	validator_version: string;
	evidence_refs: string[];
	normal_followup_cannot_resolve: boolean;
	status: "fail";
};
export type FirstTaskOutcome = {
	status: "pass" | "fail" | "unknown";
	basis:
		| "observed_complete"
		| "observed_terminal_failure"
		| "necessary_condition_failure"
		| "interrupted_by_repair"
		| "insufficient_evidence";
	profile: CheckProfile;
	evidence_refs: string[];
};
export type ScoredObservation = {
	slot_id: string;
	score: CaseScore;
	first?: FirstTaskOutcome;
	repair_triggered?: boolean;
	origin?: "online" | "resumed_unknown" | "shadow_replay" | "cached_answer";
	uncertainty?: string[];
};
export type QualityPolicy = {
	id: string;
	thresholds: {
		track: string;
		minimum_pass_rate: number;
		minimum_cases: number;
		minimum_families?: number;
		profile?: CheckProfile;
	}[];
	severe_checks: { check_id: string; minimum_samples: number }[];
	baseline_non_regression?: { baseline_score_set_id: string; tracks: { track: string; maximum_regression: number }[] };
};
export type QualityReport = {
	status: "valid" | "incomplete" | "invalid";
	tracks: Record<
		string,
		{
			numerator: number;
			denominator: number;
			value: number | null;
			families?: number;
			profiles?: Record<string, number>;
		}
	>;
	checks?: Record<
		string,
		{ applicable: number; passed: number; failed: number; unevaluated: number; severity?: "quality" | "critical" }
	>;
	cost?: number | null;
	duration_ms?: number | null;
};
export const REQUIRED_SEVERE_CHECKS = ["publication", "blocked_boundary", "process"] as const;

// 外部政策先校验再使用；缺门槛和空对象都只能得到证据不足，不能抛错或默许发布。
export function validateQualityPolicy(value: unknown): {
	valid: boolean;
	errors: string[];
	policy: QualityPolicy | null;
} {
	const raw = asRecord(value),
		errors: string[] = [];
	if (typeof raw.id !== "string" || !raw.id.trim()) errors.push("quality_policy_id_missing");
	if (!Array.isArray(raw.thresholds) || !raw.thresholds.length) errors.push("quality_thresholds_missing");
	if (!Array.isArray(raw.severe_checks) || !raw.severe_checks.length) errors.push("severe_checks_missing");
	const tracks = new Set<string>(),
		checks = new Set<string>();
	for (const entry of Array.isArray(raw.thresholds) ? raw.thresholds : []) {
		const item = asRecord(entry),
			track = item.track;
		if (
			typeof track !== "string" ||
			!track.trim() ||
			tracks.has(track) ||
			typeof item.minimum_pass_rate !== "number" ||
			!Number.isFinite(item.minimum_pass_rate) ||
			item.minimum_pass_rate < 0 ||
			item.minimum_pass_rate > 1 ||
			!Number.isSafeInteger(item.minimum_cases) ||
			Number(item.minimum_cases) < 1 ||
			(item.minimum_families !== undefined &&
				(!Number.isSafeInteger(item.minimum_families) || Number(item.minimum_families) < 1)) ||
			(item.profile !== undefined && !["linking", "result_only", "task_complete"].includes(String(item.profile)))
		)
			errors.push(`invalid_threshold:${String(track)}`);
		if (typeof track === "string") tracks.add(track);
	}
	for (const entry of Array.isArray(raw.severe_checks) ? raw.severe_checks : []) {
		const item = asRecord(entry),
			id = item.check_id;
		if (
			typeof id !== "string" ||
			!id.trim() ||
			checks.has(id) ||
			!Number.isSafeInteger(item.minimum_samples) ||
			Number(item.minimum_samples) < 1
		)
			errors.push(`invalid_severe_check:${String(id)}`);
		if (typeof id === "string") checks.add(id);
	}
	for (const id of REQUIRED_SEVERE_CHECKS) if (!checks.has(id)) errors.push(`required_severe_check_missing:${id}`);
	if (raw.baseline_non_regression !== undefined) {
		const baseline = asRecord(raw.baseline_non_regression),
			seen = new Set<string>();
		if (
			typeof baseline.baseline_score_set_id !== "string" ||
			!baseline.baseline_score_set_id.trim() ||
			!Array.isArray(baseline.tracks) ||
			!baseline.tracks.length
		)
			errors.push("invalid_baseline_contract");
		for (const entry of Array.isArray(baseline.tracks) ? baseline.tracks : []) {
			const item = asRecord(entry);
			if (
				typeof item.track !== "string" ||
				!tracks.has(item.track) ||
				seen.has(item.track) ||
				typeof item.maximum_regression !== "number" ||
				!Number.isFinite(item.maximum_regression) ||
				item.maximum_regression < 0 ||
				item.maximum_regression > 1
			)
				errors.push(`invalid_baseline_track:${String(item.track)}`);
			if (typeof item.track === "string") seen.add(item.track);
		}
		for (const track of tracks) if (!seen.has(track)) errors.push(`baseline_track_missing:${track}`);
	}
	return { valid: !errors.length, errors, policy: errors.length ? null : (structuredClone(value) as QualityPolicy) };
}

function flatten(value: unknown, prefix = "", target: Record<string, unknown> = {}): Record<string, unknown> {
	const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
	if (!entries.length) {
		if (prefix) target[prefix] = value;
		return target;
	}
	for (const [key, child] of entries) flatten(child, prefix ? `${prefix}.${key}` : key, target);
	return target;
}

// 白名单只放行预注册的精确叶字段与值域，额外漂移不能被“模型不同”笼统掩盖。
export function checkComparability(
	bundles: Record<string, Record<string, unknown>>,
	allowedDifferences: AllowedDifference[],
	requiredVerifiedPaths: string[] = [],
) {
	const errors: string[] = [],
		differences: { path: string; values: Record<string, unknown>; allowed: boolean }[] = [];
	const names = Object.keys(bundles),
		flattened = Object.fromEntries(names.map((name) => [name, flatten(bundles[name])]));
	if (names.length < 2) errors.push("at_least_two_bundles_required");
	const allowed = new Map<string, AllowedDifference>();
	for (const entry of allowedDifferences) {
		if (
			!entry.path ||
			/[*[\]]/.test(entry.path) ||
			entry.path.split(".").some((part) => ["__proto__", "constructor", "prototype"].includes(part)) ||
			!entry.values.length ||
			allowed.has(entry.path)
		)
			errors.push(`invalid_allowed_difference:${entry.path}`);
		else allowed.set(entry.path, entry);
	}
	for (const path of new Set(Object.values(flattened).flatMap((value) => Object.keys(value)))) {
		const values = Object.fromEntries(names.map((name) => [name, flattened[name][path] ?? null]));
		const serialized = names.map((name) =>
			canonicalJson(flattened[name][path] === undefined ? { missing: true } : flattened[name][path]),
		);
		if (new Set(serialized).size <= 1) continue;
		const policy = allowed.get(path),
			permitted =
				!!policy &&
				names.every(
					(name) =>
						flattened[name][path] !== undefined &&
						policy.values.some((value) => canonicalJson(value) === canonicalJson(flattened[name][path])),
				);
		differences.push({ path, values, allowed: permitted });
		if (!permitted) errors.push(`unregistered_difference:${path}`);
	}
	for (const path of requiredVerifiedPaths)
		for (const name of names) {
			const value = flattened[name][path];
			if (
				value === undefined ||
				value === null ||
				["unknown", "unverified", "provider_revision_unverified"].includes(String(value))
			)
				errors.push(`unverified:${name}:${path}`);
		}
	return immutable({
		comparable: errors.length === 0,
		errors,
		differences,
		protocol_hash: contentHash({ allowedDifferences, requiredVerifiedPaths }),
	});
}

// 第一份完整任务证据才能证明通过；必要硬条件的充分失败证据不要求虚构最终答案。
export function deriveFirstTaskOutcome(input: {
	profile: CheckProfile;
	firstScore?: CaseScore;
	firstTerminal?: boolean;
	necessaryFailures?: NecessaryFailure[];
	interruptedByRepair?: boolean;
}): FirstTaskOutcome {
	const score = input.firstScore;
	if (score?.evaluation_status === "valid" && score.profile === input.profile && score.status === "pass")
		return { status: "pass", basis: "observed_complete", profile: input.profile, evidence_refs: [score.input_hash] };
	if (
		input.firstTerminal &&
		score?.evaluation_status === "valid" &&
		score.profile === input.profile &&
		score.status === "fail"
	)
		return {
			status: "fail",
			basis: "observed_terminal_failure",
			profile: input.profile,
			evidence_refs: score.checks.filter((check) => check.status === "fail").flatMap((check) => check.evidence_refs),
		};
	const proof = input.necessaryFailures?.find(
		(failure) =>
			failure.status === "fail" &&
			failure.check_id &&
			/^[a-f0-9]{64}$/.test(failure.artifact_hash) &&
			failure.predicate &&
			failure.validator_version &&
			failure.evidence_refs.length > 0 &&
			failure.normal_followup_cannot_resolve,
	);
	if (proof)
		return {
			status: "fail",
			basis: "necessary_condition_failure",
			profile: input.profile,
			evidence_refs: [...proof.evidence_refs, proof.artifact_hash],
		};
	return {
		status: "unknown",
		basis: input.interruptedByRepair ? "interrupted_by_repair" : "insufficient_evidence",
		profile: input.profile,
		evidence_refs: [],
	};
}

export function summarizeRepairs(observations: ScoredObservation[]) {
	if (new Set(observations.map((item) => item.slot_id)).size !== observations.length)
		throw new Error("duplicate_repair_slot");
	const counts = {
		N: observations.length,
		F: 0,
		F_observed: 0,
		F_proven: 0,
		C: 0,
		W: 0,
		T: 0,
		R: 0,
		U: 0,
		H: 0,
		V: 0,
		triggered: 0,
		unknown_to_pass: 0,
		unknown_to_fail: 0,
	};
	for (const observation of observations) {
		const first = observation.first,
			triggered = observation.repair_triggered === true;
		const sameProfile = first?.profile === observation.score.profile,
			finalValid = observation.score.evaluation_status === "valid";
		const known = sameProfile && first && first.evidence_refs.length > 0;
		if (triggered) counts.triggered++;
		if (
			known &&
			first.status === "fail" &&
			["observed_terminal_failure", "necessary_condition_failure"].includes(first.basis)
		) {
			counts.F++;
			if (first.basis === "necessary_condition_failure") counts.F_proven++;
			else counts.F_observed++;
			if (triggered) {
				counts.T++;
				if (finalValid && observation.score.status === "pass") counts.R++;
			}
		} else if (known && first.status === "pass" && first.basis === "observed_complete") {
			counts.C++;
			if (triggered) {
				counts.U++;
				if (finalValid && observation.score.status === "fail") counts.H++;
			}
		} else {
			counts.W++;
			if (triggered) counts.V++;
			if (finalValid && observation.score.status === "pass") counts.unknown_to_pass++;
			if (finalValid && observation.score.status === "fail") counts.unknown_to_fail++;
		}
	}
	const ratio = (numerator: number, denominator: number) => ({
		numerator,
		denominator,
		value: denominator ? numerator / denominator : null,
	});
	return {
		...counts,
		rescue: ratio(counts.R, counts.F),
		recovery_after_trigger: ratio(counts.R, counts.T),
		false_trigger: ratio(counts.U, counts.C),
		harmful_repair: ratio(counts.H, counts.C),
		harm_after_false_trigger: ratio(counts.H, counts.U),
		initial_unknown: ratio(counts.W, counts.N),
		causal_claim: false,
	};
}

// 阶段机会包含未修复的正常候选，否则误触发率的分母会被选择性采样污染。
export function summarizeStageRepairs(
	opportunities: {
		stage: string;
		before: "pass" | "fail" | "unknown";
		after: "pass" | "fail" | "unknown";
		triggered: boolean;
		protected_constraints_preserved: boolean;
	}[],
) {
	const groups: Record<
		string,
		{ N: number; F: number; C: number; W: number; T: number; R: number; U: number; H: number; V: number }
	> = {};
	for (const item of opportunities) {
		groups[item.stage] ??= { N: 0, F: 0, C: 0, W: 0, T: 0, R: 0, U: 0, H: 0, V: 0 };
		const group = groups[item.stage];
		group.N++;
		if (item.before === "fail") {
			group.F++;
			if (item.triggered) {
				group.T++;
				if (item.after === "pass" && item.protected_constraints_preserved) group.R++;
			}
		} else if (item.before === "pass") {
			group.C++;
			if (item.triggered) {
				group.U++;
				if (item.after === "fail" || !item.protected_constraints_preserved) group.H++;
			}
		} else {
			group.W++;
			if (item.triggered) group.V++;
		}
	}
	return groups;
}

export function passK(outcomes: boolean[], k: number): number | null {
	if (!Number.isSafeInteger(k) || k < 1) throw new Error("invalid_pass_k");
	if (outcomes.length < k) return null;
	const successes = outcomes.filter(Boolean).length;
	if (successes < k) return 0;
	let value = 1;
	for (let index = 0; index < k; index++) value *= (successes - index) / (outcomes.length - index);
	return value;
}

function clusterInterval(pairs: { family: string; delta: number }[], repetitions: number, initialSeed: number) {
	const families = [...new Set(pairs.map((pair) => pair.family))];
	if (families.length < 2)
		return { lower: null, upper: null, method: "family_cluster_bootstrap", clusters: families.length };
	let seed = initialSeed >>> 0;
	const samples: number[] = [];
	for (let iteration = 0; iteration < repetitions; iteration++) {
		let total = 0,
			count = 0;
		for (let index = 0; index < families.length; index++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			const selected = families[Math.floor((seed / 4294967296) * families.length)];
			for (const pair of pairs)
				if (pair.family === selected) {
					total += pair.delta;
					count++;
				}
		}
		samples.push(total / count);
	}
	samples.sort((a, b) => a - b);
	return {
		lower: samples[Math.floor((samples.length - 1) * 0.025)],
		upper: samples[Math.ceil((samples.length - 1) * 0.975)],
		method: "family_cluster_bootstrap",
		clusters: families.length,
	};
}

export function compareArms(
	expectedSlots: PlannedSlot[],
	observations: ScoredObservation[],
	protocol: ComparisonProtocol,
) {
	const comparability = checkComparability(
			protocol.bundles,
			protocol.allowed_differences,
			protocol.required_verified_paths,
		),
		errors = [...comparability.errors];
	const arms = new Map(protocol.arms.map((arm) => [arm.kind, arm.variant_id]));
	if (
		protocol.arms.length !== 3 ||
		arms.size !== 3 ||
		!["repair_off", "repair_on", "ordinary_retry"].every((kind) => arms.has(kind as RepairArm)) ||
		new Set(protocol.arms.map((arm) => arm.variant_id)).size !== 3
	)
		errors.push("three_distinct_repair_arms_required");
	if (!expectedSlots.length) errors.push("planned_slots_missing");
	if (
		Object.keys(protocol.bundles).length !== protocol.arms.length ||
		protocol.arms.some((arm) => !Object.hasOwn(protocol.bundles, arm.variant_id))
	)
		errors.push("arm_bundle_mismatch");
	if (!protocol.equal_budget_paths.length) errors.push("equal_budget_contract_missing");
	for (const path of protocol.equal_budget_paths) {
		const values = protocol.arms.map((arm) => flatten(protocol.bundles[arm.variant_id] ?? {})[path]);
		if (
			values.some((value) => value === undefined || value === null) ||
			new Set(values.map((value) => (value === undefined ? "missing" : canonicalJson(value)))).size !== 1
		)
			errors.push(`unequal_or_missing_budget:${path}`);
	}
	const bySlot = new Map<string, ScoredObservation>(),
		planned = new Set(expectedSlots.map((slot) => slot.slot_id));
	if (planned.size !== expectedSlots.length) errors.push("duplicate_planned_slot");
	for (const observation of observations) {
		if (bySlot.has(observation.slot_id)) errors.push(`duplicate_observation:${observation.slot_id}`);
		if (!planned.has(observation.slot_id)) errors.push(`unexpected_slot:${observation.slot_id}`);
		const slot = expectedSlots.find((item) => item.slot_id === observation.slot_id);
		if (
			slot &&
			(slot.case_id !== observation.score.case_id ||
				slot.family !== observation.score.family ||
				(observation.score.slot_id !== undefined && observation.score.slot_id !== slot.slot_id))
		)
			errors.push(`observation_identity_mismatch:${observation.slot_id}`);
		if ((observation.origin && observation.origin !== "online") || observation.uncertainty?.length)
			errors.push(`contaminated_observation:${observation.slot_id}`);
		bySlot.set(observation.slot_id, observation);
	}
	const groups = new Map<string, PlannedSlot[]>();
	for (const slot of expectedSlots) {
		const key = canonicalJson([slot.case_id, slot.family, slot.repeat_index, slot.snapshot_id]);
		groups.set(key, [...(groups.get(key) ?? []), slot]);
	}
	const comparisons: Record<
		string,
		{
			pairs: number;
			improvements: number;
			harms: number;
			both_pass: number;
			both_fail: number;
			delta: number | null;
			interval: ReturnType<typeof clusterInterval> | null;
		}
	> = {};
	const repetitions = protocol.bootstrap_repetitions ?? 1000;
	if (!Number.isSafeInteger(repetitions) || repetitions < 20 || repetitions > 10000)
		errors.push("invalid_bootstrap_repetitions");
	for (const [left, right] of [
		["repair_off", "repair_on"],
		["ordinary_retry", "repair_on"],
	] as const) {
		let improvements = 0,
			harms = 0,
			bothPass = 0,
			bothFail = 0;
		const pairs: { family: string; delta: number }[] = [];
		for (const [key, group] of groups) {
			const leftSlots = group.filter((slot) => slot.variant_id === arms.get(left)),
				rightSlots = group.filter((slot) => slot.variant_id === arms.get(right));
			if (leftSlots.length !== 1 || rightSlots.length !== 1) {
				errors.push(`missing_or_duplicate_pair:${left}:${key}`);
				continue;
			}
			const first = bySlot.get(leftSlots[0].slot_id)?.score,
				second = bySlot.get(rightSlots[0].slot_id)?.score;
			if (
				!first ||
				!second ||
				first.evaluation_status !== "valid" ||
				second.evaluation_status !== "valid" ||
				first.status === "unknown" ||
				second.status === "unknown" ||
				first.profile !== second.profile
			) {
				errors.push(`unscorable_pair:${left}:${key}`);
				continue;
			}
			if (first.status === "fail" && second.status === "pass") improvements++;
			else if (first.status === "pass" && second.status === "fail") harms++;
			else if (first.status === "pass") bothPass++;
			else bothFail++;
			pairs.push({
				family: group[0].family,
				delta: Number(second.status === "pass") - Number(first.status === "pass"),
			});
		}
		comparisons[`${left}_vs_${right}`] = {
			pairs: pairs.length,
			improvements,
			harms,
			both_pass: bothPass,
			both_fail: bothFail,
			delta: pairs.length ? (improvements - harms) / pairs.length : null,
			interval:
				repetitions >= 20 && repetitions <= 10000
					? clusterInterval(pairs, repetitions, protocol.bootstrap_seed ?? 20261019)
					: null,
		};
	}
	for (const slot of expectedSlots) if (!bySlot.has(slot.slot_id)) errors.push(`missing_observation:${slot.slot_id}`);
	const valid = errors.length === 0;
	return immutable({
		status: valid ? ("valid" as const) : ("incomplete" as const),
		comparable: valid,
		errors: [...new Set(errors)],
		comparisons: valid ? comparisons : null,
		diagnostic_comparisons: comparisons,
		comparability,
		protocol_hash: contentHash(protocol),
		causal_scope: "paired_policy_average_not_individual_causality",
	});
}

// 门槛完全来自冻结政策，费用/耗时只有提示；未知证据不能靠高分抵消。
export function evaluateQualityGate(
	report: QualityReport,
	policyInput: unknown,
	baseline?: QualityReport & { score_set_id: string; comparable: boolean },
) {
	const denied: string[] = [],
		insufficient: string[] = [];
	const validated = validateQualityPolicy(policyInput),
		policy = validated.policy;
	if (report.status !== "valid") insufficient.push(`report_${report.status}`);
	if (!validated.valid) insufficient.push(...validated.errors);
	// 所有已观察严重违规都独立拒绝发布，政策漏列某检查项不能绕过。
	for (const [id, observed] of Object.entries(report.checks ?? {}))
		if (observed.failed > 0 && (observed.severity === "critical" || REQUIRED_SEVERE_CHECKS.some((name) => name === id)))
			denied.push(`critical_violation:${id}`);
	if (policy) {
		for (const threshold of policy.thresholds) {
			if (
				!Number.isFinite(threshold.minimum_pass_rate) ||
				threshold.minimum_pass_rate < 0 ||
				threshold.minimum_pass_rate > 1 ||
				!Number.isSafeInteger(threshold.minimum_cases) ||
				threshold.minimum_cases < 1
			) {
				insufficient.push(`invalid_threshold:${threshold.track}`);
				continue;
			}
			const group = report.tracks[threshold.track];
			if (!group || group.denominator < threshold.minimum_cases || group.value === null) {
				insufficient.push(`coverage_missing:${threshold.track}`);
				continue;
			}
			if (threshold.minimum_families !== undefined && (group.families ?? 0) < threshold.minimum_families)
				insufficient.push(`family_coverage_missing:${threshold.track}`);
			if (threshold.profile && group.profiles?.[threshold.profile] !== group.denominator)
				insufficient.push(`profile_coverage_missing:${threshold.track}`);
			if (group.value < threshold.minimum_pass_rate) denied.push(`quality_below_threshold:${threshold.track}`);
		}
		for (const severe of policy.severe_checks) {
			const observed = report.checks?.[severe.check_id];
			if (observed?.failed) denied.push(`severe_violation:${severe.check_id}`);
			if (
				!Number.isSafeInteger(severe.minimum_samples) ||
				severe.minimum_samples < 1 ||
				!observed ||
				observed.applicable < severe.minimum_samples ||
				observed.unevaluated > 0
			)
				insufficient.push(`severe_evidence_missing:${severe.check_id}`);
		}
		// 同版本裁判、gold 与配对快照由调用方核验，未确认可比性不能自动认定不退化。
		if (policy.baseline_non_regression) {
			const contract = policy.baseline_non_regression;
			if (
				!baseline ||
				baseline.score_set_id !== contract.baseline_score_set_id ||
				!baseline.comparable ||
				baseline.status !== "valid"
			)
				insufficient.push("baseline_evidence_missing_or_incomparable");
			else
				for (const item of contract.tracks) {
					const current = report.tracks[item.track],
						prior = baseline.tracks[item.track];
					if (
						!current ||
						!prior ||
						current.value === null ||
						prior.value === null ||
						current.denominator !== prior.denominator
					)
						insufficient.push(`baseline_coverage_mismatch:${item.track}`);
					else if (prior.value - current.value > item.maximum_regression + Number.EPSILON)
						denied.push(`quality_regression:${item.track}`);
				}
		}
	}
	const status = denied.length ? "deny" : insufficient.length ? "evidence_insufficient" : "allow";
	return immutable({
		status: status as "allow" | "deny" | "evidence_insufficient",
		reasons: [...denied, ...insufficient],
		policy_hash: policy ? contentHash(policy) : null,
		performance_hints: { cost: report.cost ?? null, duration_ms: report.duration_ms ?? null, gating: false },
	});
}
