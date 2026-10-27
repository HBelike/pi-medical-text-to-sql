import { createHash } from "node:crypto";
import {
	asRecord,
	type CheckProfile,
	canonicalJson,
	clarificationContractV2,
	comparisonContractV2,
	contentHash,
	type EvaluationCase,
	immutable,
} from "./datasets.ts";

export type EvaluationTurn = {
	status: string;
	id?: string;
	result?: unknown;
	progress?: unknown;
	evidence?: unknown;
	answer?: unknown;
	answer_status?: unknown;
	clarification?: unknown;
	stages?: unknown;
	publication?: unknown;
	error?: unknown;
};
export type CheckStatus = "pass" | "fail" | "not_applicable" | "not_evaluated";
export type EvaluationStatus = "valid" | "invalid_gold" | "evaluator_error" | "evidence_unavailable";
export type CheckResult = {
	check_id: string;
	status: CheckStatus;
	evaluation_status: EvaluationStatus;
	reason_code: string;
	evidence_refs: string[];
	scorer_version: string;
	severity: "quality" | "critical";
	details?: Record<string, unknown>;
};
export type ScoreInput = {
	sample: EvaluationCase;
	turn: EvaluationTurn;
	catalog?: unknown;
	logicalRelations?: unknown[];
	artifacts?: Record<string, unknown>;
};
export type ScorerDefinition = {
	id: string;
	version: string;
	dependencies: string[];
	required_evidence: string[];
	budget_ms: number;
	severity?: "quality" | "critical";
	applicable?: (input: ScoreInput) => boolean;
	score: (
		input: ScoreInput,
		signal: AbortSignal,
	) =>
		| Omit<CheckResult, "check_id" | "scorer_version" | "severity">
		| Promise<Omit<CheckResult, "check_id" | "scorer_version" | "severity">>;
};
export type CaseScore = {
	case_id: string;
	slot_id?: string;
	track: string;
	family: string;
	profile: CheckProfile;
	expected_action: string;
	status: "pass" | "fail" | "unknown";
	evaluation_status: EvaluationStatus;
	checks: CheckResult[];
	input_hash: string;
	scorer_hash: string;
	coverage_gaps: string[];
};
export type ScoreSet = {
	id: string;
	schema_version: "evaluation-score-set/v1";
	dataset_hash: string;
	observation_hash: string;
	gold_hash: string;
	policy_hash: string | null;
	parent_score_set_id: string | null;
	scores: CaseScore[];
};
export type ScoringOptions = {
	registry?: ScorerRegistry;
	profile?: CheckProfile;
	slotId?: string;
	catalog?: unknown;
	logicalRelations?: unknown[];
	artifacts?: Record<string, unknown>;
};
export type EvidenceAssertion = {
	id: string;
	path: string;
	op: "equals" | "contains_all" | "set_equals" | "absent" | "includes";
	expected?: unknown;
};

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
function strings(value: unknown): string[] {
	return list(value).filter((entry): entry is string => typeof entry === "string");
}

// 同时接受 publicTurn 和原始 QueryTask；绝不把首次缺失产物用最终结果补齐。
export function normalizeTurn(turn: EvaluationTurn): EvaluationTurn {
	const payload = asRecord(turn.result),
		progress = asRecord(turn.progress);
	const nested = "result" in payload || "evidence" in payload || "answer" in payload || "answer_status" in payload;
	const publication = asRecord(turn.publication ?? payload.publication ?? progress.publication);
	return {
		...turn,
		result: publication.status === "published" ? publication.result : nested ? payload.result : turn.result,
		publication: Object.keys(publication).length ? publication : undefined,
		evidence: turn.evidence ?? payload.evidence ?? progress.evidence ?? progress.linking,
		answer: turn.answer ?? payload.answer ?? publication.answer,
		answer_status: turn.answer_status ?? payload.answer_status ?? publication.answer_status,
		stages: turn.stages ?? payload.stages ?? progress.stages,
	};
}

// 评分器独立重算跨语言内容摘要，不调用产品执行器，也不因 JSON 的 1.0/1 差异误判。
export function resultArtifactContentHash(value: unknown): string {
	const result = asRecord(value);
	if (!Array.isArray(result.columns) || !Array.isArray(result.rows)) throw new Error("invalid_result_artifact_shape");
	const digest = createHash("sha256").update("medical-query-result/v1\n");
	const cell = (value: unknown) => {
		if (value === null) digest.update("N;");
		else if (typeof value === "boolean") digest.update(value ? "B1;" : "B0;");
		else if (
			typeof value === "number" &&
			Number.isFinite(value) &&
			(!Number.isInteger(value) || Number.isSafeInteger(value))
		) {
			const bytes = Buffer.alloc(8);
			bytes.writeDoubleBE(value === 0 ? 0 : value);
			digest.update(`D${bytes.toString("hex")};`);
		} else if (typeof value === "string") digest.update(`S${Buffer.byteLength(value, "utf8")}:${value};`);
		else throw new Error("invalid_result_artifact_cell");
	};
	digest.update(`C${result.columns.length};`);
	for (const column of result.columns) {
		if (typeof column !== "string") throw new Error("invalid_result_artifact_column");
		cell(column);
	}
	digest.update(`R${result.rows.length};`);
	for (const row of result.rows) {
		if (!Array.isArray(row) || row.length !== result.columns.length) throw new Error("invalid_result_artifact_row");
		digest.update("[");
		row.forEach(cell);
		digest.update("]");
	}
	digest.update(`C${result.complete ? 1 : 0}T${result.truncated ? 1 : 0};`);
	return digest.digest("hex");
}

// 只读取调用方从冻结产物仓加载的内容映射；模型提供的路径、URL 或预览绝不触发文件读取。
function resolveResultArtifact(turn: EvaluationTurn, artifacts?: Record<string, unknown>) {
	const result = asRecord(turn.result),
		publication = asRecord(turn.publication);
	if (result.preview !== true) return { turn };
	const hash = publication.result_hash,
		available = asRecord(artifacts?.full_results);
	if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || !Object.hasOwn(available, hash))
		return { turn, issue: "evidence_unavailable" as const, reason: "complete_result_artifact_unavailable" };
	const full = asRecord(available[hash]);
	if (createHash("sha256").update(JSON.stringify(full)).digest("hex") !== hash || full.preview === true)
		return { turn, issue: "evaluator_error" as const, reason: "loaded_result_artifact_hash_mismatch" };
	return { turn: { ...turn, result: full, publication: { ...publication, result: full } } };
}

function at(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((current, key) => {
		if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
		if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)];
		return asRecord(current)[key];
	}, value);
}

function check(
	status: CheckStatus,
	reason: string,
	refs: string[],
	details?: Record<string, unknown>,
	evaluation: EvaluationStatus = "valid",
) {
	return {
		status,
		reason_code: reason,
		evidence_refs: refs,
		evaluation_status: evaluation,
		...(details ? { details } : {}),
	};
}

// 注册检查器不执行产品代码；依赖失败与检查器故障分别保留，不能转为模型失败。
export class ScorerRegistry {
	private readonly definitions = new Map<string, ScorerDefinition>();
	register(definition: ScorerDefinition): this {
		if (
			!definition.id ||
			!definition.version ||
			this.definitions.has(definition.id) ||
			!Number.isFinite(definition.budget_ms) ||
			definition.budget_ms <= 0
		)
			throw new Error("invalid_scorer：身份、版本或预算无效");
		this.definitions.set(definition.id, definition);
		return this;
	}
	fingerprint(): string {
		return contentHash(
			[...this.definitions.values()]
				.map((definition) => ({
					id: definition.id,
					version: definition.version,
					dependencies: definition.dependencies,
					required_evidence: definition.required_evidence,
					budget_ms: definition.budget_ms,
					severity: definition.severity ?? "quality",
					implementation: String(definition.score),
					applicability: String(definition.applicable),
				}))
				.sort((a, b) => a.id.localeCompare(b.id)),
		);
	}
	async run(input: ScoreInput, required: string[]): Promise<CheckResult[]> {
		// 扩展评分器只能读冻结观察；不能改写 gold 或为后续检查补造证据。
		input = immutable(structuredClone(input));
		const order: string[] = [],
			visiting = new Set<string>(),
			visited = new Set<string>();
		const visit = (id: string) => {
			if (visited.has(id)) return;
			const definition = this.definitions.get(id);
			if (!definition || visiting.has(id)) throw new Error(`invalid_scorer：缺依赖或循环 ${id}`);
			visiting.add(id);
			for (const dependency of definition.dependencies) visit(dependency);
			visiting.delete(id);
			visited.add(id);
			order.push(id);
		};
		try {
			required.forEach(visit);
		} catch (error) {
			return [
				{
					check_id: "scorer_contract",
					scorer_version: "1",
					severity: "quality",
					...check("not_evaluated", "invalid_scorer_dependencies", [], { error: String(error) }, "evaluator_error"),
				},
			];
		}
		const results = new Map<string, CheckResult>();
		for (const id of order) {
			const definition = this.definitions.get(id)!;
			const metadata = {
				check_id: id,
				scorer_version: definition.version,
				severity: definition.severity ?? ("quality" as const),
			};
			let timer: ReturnType<typeof setTimeout> | undefined;
			const controller = new AbortController();
			try {
				if (definition.applicable && !definition.applicable(input)) {
					results.set(id, { ...metadata, ...check("not_applicable", "declared_inapplicable", []) });
					continue;
				}
				if (definition.dependencies.some((dependency) => results.get(dependency)?.status !== "pass")) {
					results.set(id, { ...metadata, ...check("not_evaluated", "dependency_failed", definition.dependencies) });
					continue;
				}
				const missing = definition.required_evidence.filter((path) => at(input, path) === undefined);
				if (missing.length) {
					results.set(id, { ...metadata, ...check("fail", "required_product_evidence_missing", missing) });
					continue;
				}
				const value = await Promise.race([
					Promise.resolve().then(() => definition.score(input, controller.signal)),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							controller.abort();
							reject(new Error("scorer_timeout"));
						}, definition.budget_ms);
					}),
				]);
				if (
					!["pass", "fail", "not_applicable", "not_evaluated"].includes(value.status) ||
					!["valid", "invalid_gold", "evaluator_error", "evidence_unavailable"].includes(value.evaluation_status) ||
					typeof value.reason_code !== "string" ||
					!Array.isArray(value.evidence_refs) ||
					value.evidence_refs.some((ref) => typeof ref !== "string")
				)
					throw new Error("invalid_scorer_output");
				results.set(id, { ...value, ...metadata });
			} catch (error) {
				results.set(id, {
					...metadata,
					...check(
						"not_evaluated",
						"scorer_exception",
						[],
						{ error: error instanceof Error ? error.message : String(error) },
						"evaluator_error",
					),
				});
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
		return [...results.values()];
	}
}

function setCheck(actual: unknown, required: unknown, exact = false) {
	const wanted = strings(required),
		values = strings(actual),
		valid = Array.isArray(actual) && values.length === actual.length && new Set(values).size === values.length;
	const missing = wanted.filter((value) => !values.includes(value)),
		unexpected = exact ? values.filter((value) => !wanted.includes(value)) : [];
	return { passed: valid && !missing.length && !unexpected.length, missing, unexpected };
}

// 关系按完整列对比较而非运行时 FK 编号，保留跨机构复合键，允许正反方向。
export function canonicalRelation(value: unknown): string {
	const relation = asRecord(value),
		left = relation.left_table,
		right = relation.right_table;
	if (typeof left !== "string" || typeof right !== "string" || !Array.isArray(relation.pairs) || !relation.pairs.length)
		throw new Error("invalid_relation");
	const pairs = relation.pairs.map((entry) => {
		const pair = asRecord(entry);
		if (typeof pair.left !== "string" || typeof pair.right !== "string") throw new Error("invalid_relation_pair");
		return [
			pair.left.includes(".") ? pair.left : `${left}.${pair.left}`,
			pair.right.includes(".") ? pair.right : `${right}.${pair.right}`,
		]
			.sort()
			.join("=");
	});
	if (new Set(pairs).size !== pairs.length) throw new Error("duplicate_relation_pair");
	return pairs.sort().join("&");
}

function resultRows(turn: EvaluationTurn): Record<string, unknown>[] | undefined {
	const result = asRecord(turn.result);
	if (!Array.isArray(result.rows)) return undefined;
	if (result.rows.every((row) => row && typeof row === "object" && !Array.isArray(row)))
		return result.rows as Record<string, unknown>[];
	const columns = strings(result.columns);
	if (
		!Array.isArray(result.columns) ||
		columns.length !== result.columns.length ||
		new Set(columns).size !== columns.length ||
		!result.rows.every((row) => Array.isArray(row) && row.length === columns.length)
	)
		return undefined;
	return result.rows.map((row) =>
		Object.fromEntries(columns.map((column, index) => [column, (row as unknown[])[index]])),
	);
}

function cellEqual(
	actual: unknown,
	expected: unknown,
	settings: Record<string, unknown>,
	fallbackTolerance: number,
): boolean {
	if (actual === null || expected === null) return actual === expected;
	if (typeof actual !== typeof expected) return false;
	if (typeof expected !== "number")
		return typeof expected === "string" || typeof expected === "boolean" ? actual === expected : false;
	if (typeof actual !== "number" || !Number.isFinite(actual) || !Number.isFinite(expected)) return false;
	if (settings.type === "integer" || (settings.type === undefined && Number.isInteger(expected)))
		return Number.isInteger(actual) && actual === expected;
	const absolute = typeof settings.absolute_tolerance === "number" ? settings.absolute_tolerance : fallbackTolerance;
	const relative = typeof settings.relative_tolerance === "number" ? settings.relative_tolerance : 0;
	return absolute >= 0 && relative >= 0 && Math.abs(actual - expected) <= absolute + relative * Math.abs(expected);
}

type ResultComparison = {
	passed: boolean;
	reason: string;
	evaluation_status?: EvaluationStatus;
	details?: Record<string, unknown>;
};

// 新契约先固定物理列到业务角色的唯一映射，再复用类型化多重集；不按数值猜测多列对应关系。
export function compareResults(turn: EvaluationTurn, gold: Record<string, unknown>): ResultComparison {
	let contract: ReturnType<typeof comparisonContractV2>;
	try {
		contract = comparisonContractV2(gold);
	} catch (error) {
		return {
			passed: false,
			reason: "comparison_contract_invalid",
			evaluation_status: "invalid_gold",
			details: { error: String(error) },
		};
	}
	if (!contract) return compareLegacyResults(turn, gold);
	const result = asRecord(turn.result),
		bindings: Record<string, string> = Object.fromEntries(contract.columns.map((role) => [role, ""]));
	const details: Record<string, unknown> = {
		contract_version: contract.version,
		mode: contract.mode,
		gold_columns: contract.columns,
		actual_columns: result.columns ?? null,
		role_bindings: bindings,
		structure: "unverified",
		values: "not_evaluated",
	};
	const fail = (reason: string, evaluation_status: EvaluationStatus = "valid"): ResultComparison => ({
		passed: false,
		reason,
		evaluation_status,
		details,
	});
	if (result.complete !== true || result.truncated === true) return fail("result_missing_truncated_or_row_count");
	if (result.columns === undefined) return fail("result_column_evidence_unavailable", "evidence_unavailable");
	if (
		!Array.isArray(result.columns) ||
		result.columns.some((name) => typeof name !== "string" || !name.trim()) ||
		new Set(result.columns).size !== result.columns.length ||
		result.columns.length !== contract.columns.length
	)
		return fail("result_column_shape_mismatch");
	const columns = result.columns as string[];
	const used = new Set<string>();
	for (const role of contract.columns) {
		const candidates =
			contract.mode === "single_value"
				? columns
				: columns.filter((column) => column === role || (contract.aliases[role] ?? []).includes(column));
		if (candidates.length !== 1 || used.has(candidates[0])) return fail("result_role_binding_mismatch");
		bindings[role] = candidates[0];
		used.add(candidates[0]);
	}
	const rows = resultRows(turn);
	if (!rows || rows.some((row) => canonicalJson(Object.keys(row).sort()) !== canonicalJson([...columns].sort())))
		return fail("result_row_shape_mismatch");
	if (
		rows.some((row) =>
			Object.values(row).some(
				(value) =>
					value !== null &&
					(!["string", "number", "boolean"].includes(typeof value) ||
						(typeof value === "number" &&
							(!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))),
			),
		)
	)
		return fail("invalid_result_cell");
	if (result.result_content_hash !== undefined) {
		try {
			if (
				result.hash_algorithm !== "medical-query-result/v1" ||
				result.result_content_hash !== resultArtifactContentHash(result)
			)
				return fail("result_content_hash_mismatch");
		} catch {
			return fail("invalid_result_content");
		}
	}
	details.structure = "passed";
	// 内容 hash 始终先校验原始产物；映射是评分临时视图，不覆盖观察或其列名。
	const { result_content_hash: _hash, ...mappedResult } = result;
	const compared = compareLegacyResults(
		{
			...turn,
			result: {
				...mappedResult,
				columns: contract.columns,
				rows: rows.map((row) => Object.fromEntries(contract.columns.map((role) => [role, row[bindings[role]]]))),
			},
		},
		{ ...gold, result_contract: { ...asRecord(gold.result_contract), aliases: {} } },
	);
	details.values = compared.passed ? "passed" : "failed";
	return { ...compared, details };
}

// 旧契约不回溯放宽；多重集使用二分图匹配，避免近似值的贪心配对错误，也不会吞掉重复行。
function compareLegacyResults(turn: EvaluationTurn, gold: Record<string, unknown>) {
	const actual = resultRows(turn),
		expected = list(gold.expected_rows).map(asRecord),
		result = asRecord(turn.result);
	if (
		!actual ||
		result.complete !== true ||
		result.truncated === true ||
		(result.row_count !== undefined && result.row_count !== actual.length) ||
		actual.length !== expected.length
	)
		return { passed: false, reason: "result_missing_truncated_or_row_count" };
	if (result.result_content_hash !== undefined) {
		try {
			if (
				result.hash_algorithm !== "medical-query-result/v1" ||
				result.result_content_hash !== resultArtifactContentHash(result)
			)
				return { passed: false, reason: "result_content_hash_mismatch" };
		} catch {
			return { passed: false, reason: "invalid_result_content" };
		}
	}
	const contract = asRecord(gold.result_contract),
		aliases = asRecord(contract.aliases),
		settings = asRecord(contract.column_settings);
	const tolerance =
		typeof asRecord(gold.comparison).numeric_tolerance === "number"
			? Number(asRecord(gold.comparison).numeric_tolerance)
			: 0;
	const rowEqual = (left: Record<string, unknown>, right: Record<string, unknown>): boolean => {
		const used = new Set<string>();
		for (const [role, expectedValue] of Object.entries(right)) {
			const permitted = [role, ...strings(aliases[role])],
				present = permitted.filter((name) => Object.hasOwn(left, name));
			if (present.length !== 1 || used.has(present[0])) return false;
			used.add(present[0]);
			if (!cellEqual(left[present[0]], expectedValue, asRecord(settings[role]), tolerance)) return false;
		}
		return used.size === Object.keys(left).length;
	};
	if (asRecord(gold.comparison).row_order === "ordered")
		return { passed: expected.every((row, index) => rowEqual(actual[index], row)), reason: "ordered_typed_rows" };
	// 完整数千行的精确比较用带计数的多重集，只有浮点容差配对才需要二分图。
	const roles = expected.length ? Object.keys(expected[0]) : [];
	const exact =
		expected.length > 0 &&
		expected.every(
			(row) =>
				canonicalJson(Object.keys(row).sort()) === canonicalJson([...roles].sort()) &&
				Object.entries(row).every(([role, value]) => {
					if (typeof value !== "number") return true;
					const setting = asRecord(settings[role]);
					return (
						setting.type === "integer" ||
						(setting.type === undefined && Number.isInteger(value)) ||
						((setting.absolute_tolerance ?? tolerance) === 0 && (setting.relative_tolerance ?? 0) === 0)
					);
				}),
		);
	if (exact) {
		const counts = new Map<string, number>();
		for (const row of expected) {
			const key = canonicalJson(roles.map((role) => row[role]));
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		for (const row of actual) {
			const used = new Set<string>(),
				values: unknown[] = [];
			for (const role of roles) {
				const present = [role, ...strings(aliases[role])].filter((name) => Object.hasOwn(row, name));
				if (present.length !== 1 || used.has(present[0])) return { passed: false, reason: "typed_exact_multiset" };
				used.add(present[0]);
				values.push(row[present[0]]);
			}
			if (used.size !== Object.keys(row).length) return { passed: false, reason: "typed_exact_multiset" };
			const key = canonicalJson(values),
				remaining = counts.get(key) ?? 0;
			if (!remaining) return { passed: false, reason: "typed_exact_multiset" };
			counts.set(key, remaining - 1);
		}
		return { passed: true, reason: "typed_exact_multiset" };
	}
	const matched = new Map<number, number>();
	const assign = (wanted: number, seen: Set<number>): boolean => {
		for (let candidate = 0; candidate < actual.length; candidate++) {
			if (seen.has(candidate) || !rowEqual(actual[candidate], expected[wanted])) continue;
			seen.add(candidate);
			const prior = matched.get(candidate);
			if (prior === undefined || assign(prior, seen)) {
				matched.set(candidate, wanted);
				return true;
			}
		}
		return false;
	};
	return { passed: expected.every((_, index) => assign(index, new Set())), reason: "typed_role_multiset" };
}

function assertions(input: ScoreInput, contract: unknown) {
	const entries = list(asRecord(contract).assertions);
	if (!entries.length) return check("not_evaluated", "annotation_missing", [], undefined, "invalid_gold");
	const failures: string[] = [],
		refs: string[] = [];
	for (const raw of entries) {
		const entry = asRecord(raw);
		if (
			typeof entry.id !== "string" ||
			typeof entry.path !== "string" ||
			!["equals", "contains_all", "set_equals", "absent", "includes"].includes(String(entry.op)) ||
			(entry.op !== "absent" && !Object.hasOwn(entry, "expected"))
		)
			return check("not_evaluated", "invalid_assertion", [], undefined, "invalid_gold");
		const actual = at(input, entry.path);
		refs.push(entry.path);
		let passed = false;
		if (entry.op === "absent") passed = actual === undefined;
		else if (entry.op === "equals")
			passed = actual !== undefined && canonicalJson(actual) === canonicalJson(entry.expected);
		else if (entry.op === "includes")
			passed = typeof actual === "string" && typeof entry.expected === "string" && actual.includes(entry.expected);
		else if (Array.isArray(actual) && Array.isArray(entry.expected)) {
			const values = actual.map(canonicalJson),
				wanted = entry.expected.map(canonicalJson);
			passed =
				wanted.every((value) => values.includes(value)) &&
				(entry.op !== "set_equals" ||
					(values.length === wanted.length && values.every((value) => wanted.includes(value))));
		}
		if (!passed) failures.push(entry.id);
	}
	return check(
		failures.length ? "fail" : "pass",
		failures.length ? "assertion_mismatch" : "assertions_satisfied",
		refs,
		{ failures },
	);
}

export function createDefaultScorers(): ScorerRegistry {
	const registry = new ScorerRegistry();
	const register = (id: string, score: ScorerDefinition["score"], severity: "quality" | "critical" = "quality") =>
		registry.register({
			id,
			version: ["result", "clarification"].includes(id) ? "2.0.0" : "1.0.0",
			dependencies: [],
			required_evidence: [],
			budget_ms: 5000,
			severity,
			score,
		});
	register("action", ({ sample, turn }) => {
		const actual =
			turn.status === "completed"
				? "answer"
				: turn.status === "waiting_for_user"
					? "clarify"
					: turn.status === "blocked"
						? "blocked"
						: "failure";
		return check(actual === sample.expected_action ? "pass" : "fail", "action", ["turn.status"], {
			actual,
			expected: sample.expected_action,
		});
	});
	register("result", ({ sample, turn }) => {
		const compared = compareResults(turn, sample.gold);
		return check(
			compared.evaluation_status && compared.evaluation_status !== "valid"
				? "not_evaluated"
				: compared.passed
					? "pass"
					: "fail",
			compared.reason,
			["turn.result"],
			compared.details,
			compared.evaluation_status,
		);
	});
	register("linking", ({ sample, turn, catalog, logicalRelations }) => {
		const gold = sample.gold,
			evidence = asRecord(turn.evidence),
			linking = asRecord(evidence.linking),
			checks: Record<string, unknown> = {};
		for (const [actual, expected, exact] of [
			["metric_ids", "required_metric_ids", true],
			["tables", "required_tables", false],
			["fields", "required_fields", false],
			["time_fields", "required_time_fields", false],
			["candidate_relations", "candidate_relation_ids", true],
		] as const) {
			if (gold[expected] !== undefined) checks[actual] = setCheck(linking[actual], gold[expected], exact);
		}
		const relationIds = strings(gold.required_logical_relations).filter(
			(id) => !strings(gold.candidate_relation_ids).includes(id),
		);
		if (relationIds.length) {
			const definitions = logicalRelations || list(gold.logical_relation_definitions);
			const relations = list(asRecord(catalog).relations);
			if (!definitions.length || !relations.length)
				return check(
					"not_evaluated",
					"relation_evidence_unavailable",
					["catalog.relations"],
					undefined,
					"evidence_unavailable",
				);
			try {
				const required = relationIds.map((id) => {
					const found = definitions.find((value) => asRecord(value).id === id);
					if (!found) throw new Error("missing_gold_relation");
					return canonicalRelation(found);
				});
				const actual = list(linking.relations).map((id) => {
					const found = relations.find((value) => asRecord(value).id === id);
					return found ? canonicalRelation(found) : `unknown:${String(id)}`;
				});
				checks.relations = {
					...setCheck(actual, required),
					passed: setCheck(actual, required).passed && !actual.some((value) => value.startsWith("unknown:")),
				};
			} catch {
				return check("not_evaluated", "relation_contract_invalid", [], undefined, "invalid_gold");
			}
		}
		if (gold.expected_execution_statuses !== undefined)
			checks.metric_statuses = setCheck(
				list(evidence.metric_statuses).map((value) => `${asRecord(value).metric_id}:${asRecord(value).status}`),
				list(gold.expected_execution_statuses).map((value) => `${asRecord(value).metric_id}:${asRecord(value).status}`),
				true,
			);
		if (gold.expected_match_status !== undefined)
			checks.match_status = { passed: evidence.match_status === gold.expected_match_status };
		if (gold.expected_match_status === "no_match")
			checks.empty_selection = {
				passed:
					[
						"metric_ids",
						"tables",
						"fields",
						"time_fields",
						"relations",
						"candidate_relations",
						"code_filters",
						"unresolved_rule_ids",
					].every((key) => Array.isArray(linking[key]) && list(linking[key]).length === 0) &&
					Array.isArray(evidence.metric_statuses) &&
					evidence.metric_statuses.length === 0,
			};
		return check(
			Object.values(checks).every((value) => asRecord(value).passed === true) ? "pass" : "fail",
			"linking_requirements",
			["turn.evidence.linking"],
			checks,
		);
	});
	register("blockers", ({ sample, turn }) => {
		const expected = strings(sample.gold.required_gap_ids),
			evidence = asRecord(turn.evidence),
			linking = asRecord(evidence.linking);
		const actual = linking.unresolved_rule_ids ?? evidence.required_gap_ids;
		const gaps = expected.length ? setCheck(actual, expected) : { passed: evidence.match_status === "no_match" };
		return check(gaps.passed ? "pass" : "fail", "blocked_reason", ["turn.evidence"], { gaps });
	});
	register(
		"blocked_boundary",
		({ turn }) => {
			const evidence = asRecord(turn.evidence);
			const forbidden =
				(turn.result !== undefined && turn.result !== null) ||
				evidence.sql !== undefined ||
				list(turn.stages).some((stage) => asRecord(stage).kind === "execution");
			return check(
				forbidden ? "fail" : "pass",
				"blocked_no_execution_or_value",
				["turn.evidence", "turn.stages", "turn.result"],
				{ prohibited_execution_or_value: forbidden },
			);
		},
		"critical",
	);
	register("clarification", ({ sample, turn }) => {
		const evidence = asRecord(turn.evidence),
			actual = evidence.clarification_slots ?? asRecord(turn.clarification).slots;
		// v2 只核审核概念；未知表达保留为缺证据，不靠子串或模型自评将措辞差异判成通过。
		let contract: ReturnType<typeof clarificationContractV2>;
		try {
			contract = clarificationContractV2(sample.gold);
		} catch (error) {
			return check("not_evaluated", "clarification_contract_invalid", [], { error: String(error) }, "invalid_gold");
		}
		if (contract) {
			if (!Array.isArray(actual) || actual.some((slot) => typeof slot !== "string" || !slot.trim()))
				return check(
					"not_evaluated",
					"clarification_slots_unavailable",
					["turn.clarification"],
					undefined,
					"evidence_unavailable",
				);
			const mappings = (actual as string[]).map((raw) => ({
				raw,
				concept: contract.terms.get(raw.normalize("NFKC").trim()) ?? null,
			}));
			const concepts = mappings.flatMap((entry) => (entry.concept ? [entry.concept] : []));
			const missing = contract.required.filter((id) => !concepts.includes(id)),
				unexpected = concepts.filter((id) => !contract.required.includes(id) && !contract.permitted_extra.includes(id)),
				unmapped = mappings.filter((entry) => entry.concept === null).map((entry) => entry.raw);
			const details = {
				contract_version: contract.version,
				vocabulary_id: contract.vocabulary_id,
				vocabulary_hash: contract.vocabulary_hash,
				question: asRecord(turn.clarification).question ?? evidence.clarification_question ?? null,
				raw_slots: actual,
				mappings,
				missing,
				unexpected,
				unmapped,
				duplicate_concepts: concepts.length !== new Set(concepts).size,
				question_semantics: "not_evaluated",
			};
			if (turn.result !== undefined) return check("fail", "clarification_published_value", ["turn.result"], details);
			if (unmapped.length)
				return check(
					"not_evaluated",
					"clarification_unmapped_expression",
					["turn.clarification", "turn.evidence.clarification_slots"],
					details,
					"evidence_unavailable",
				);
			return check(
				missing.length || unexpected.length || details.duplicate_concepts ? "fail" : "pass",
				"reviewed_clarification_concepts",
				["turn.clarification", "turn.evidence.clarification_slots"],
				details,
			);
		}
		const slots = setCheck(actual, sample.gold.required_clarifications, true);
		return check(
			slots.passed && turn.result === undefined ? "pass" : "fail",
			"clarification_slots",
			["turn.clarification", "turn.evidence.clarification_slots"],
			slots,
		);
	});
	register("semantic", (input) => assertions(input, input.sample.gold.semantic_contract));
	// 发布证明绑定实际完整结果、SQL/参数、源版本与内嵌验证报告，候选进度不能替代。
	register(
		"publication",
		({ sample, turn, artifacts }) => {
			const publication = asRecord(turn.publication),
				result = asRecord(publication.result),
				evidence = asRecord(publication.evidence),
				validation = asRecord(publication.validation);
			const hash = Object.keys(result).length
				? createHash("sha256").update(JSON.stringify(result)).digest("hex")
				: null;
			const rows = resultRows({ status: "completed", result }),
				checks = strings(validation.checks);
			const sourceMatches =
				typeof publication.source_version === "string" &&
				!!publication.source_version &&
				publication.source_version === evidence.source_version &&
				evidence.source_id === sample.source_id &&
				(artifacts?.expected_source_version === undefined ||
					publication.source_version === artifacts.expected_source_version);
			const bindings =
				result.sql !== undefined &&
				evidence.sql === result.sql &&
				canonicalJson(evidence.parameters ?? null) === canonicalJson(result.parameters ?? null) &&
				(turn.answer_status !== "completed" ||
					(publication.answer_status === "completed" && publication.answer === turn.answer));
			const passed =
				publication.status === "published" &&
				typeof publication.id === "string" &&
				typeof publication.version === "number" &&
				publication.version >= 1 &&
				publication.result_hash === hash &&
				sourceMatches &&
				bindings &&
				result.complete === true &&
				result.truncated !== true &&
				!!rows &&
				result.row_count === rows.length &&
				validation.status === "passed" &&
				["source_version", "compiler", "read_only", "complete_result", "row_shape"].every((name) =>
					checks.includes(name),
				);
			return check(passed ? "pass" : "fail", "verified_publication_binding", ["turn.publication"], {
				source_matches: sourceMatches,
				result_hash_matches: publication.result_hash === hash,
				sql_parameters_match: bindings,
			});
		},
		"critical",
	);
	register("answer", (input) => {
		if (input.turn.answer_status !== "completed" || typeof input.turn.answer !== "string" || !input.turn.answer.trim())
			return check("fail", "answer_not_completed", ["turn.answer_status", "turn.answer"]);
		return assertions(input, input.sample.gold.answer_contract);
	});
	register("process", (input) => assertions(input, input.sample.gold.process_contract), "critical");
	return registry;
}

// 主档位冻结后不能因失败降级；附加 result_only 分析须创建独立 score set。
export async function scoreCase(
	sample: EvaluationCase,
	rawTurn: EvaluationTurn,
	options: ScoringOptions = {},
): Promise<CaseScore> {
	if (options.profile && options.profile !== sample.profile)
		throw new Error("score_profile_conflict：不得事后更换档位");
	const resolved = resolveResultArtifact(normalizeTurn(rawTurn), options.artifacts);
	const turn = resolved.turn,
		registry = options.registry ?? createDefaultScorers();
	const required = [
		"action",
		...(sample.expected_action === "answer"
			? ["result"]
			: sample.expected_action === "clarify"
				? ["clarification"]
				: ["linking", "blockers", "blocked_boundary"]),
	];
	if (sample.profile === "task_complete")
		required.push("semantic", "answer", "process", ...(sample.expected_action === "answer" ? ["publication"] : []));
	for (const id of strings(sample.gold.required_checks)) if (!required.includes(id)) required.push(id);
	const input: ScoreInput = {
		sample,
		turn,
		...(options.catalog === undefined ? {} : { catalog: options.catalog }),
		...(options.logicalRelations ? { logicalRelations: options.logicalRelations } : {}),
		...(options.artifacts ? { artifacts: options.artifacts } : {}),
	};
	const checks = await registry.run(input, required);
	// 公共预览缺完整产物属于观察链缺证据，不把裁判取证失败计作模型结果错误。
	if (resolved.issue)
		for (const value of checks)
			if (["result", "publication"].includes(value.check_id)) {
				value.status = "not_evaluated";
				value.evaluation_status = resolved.issue;
				value.reason_code = resolved.reason!;
				value.evidence_refs = ["artifacts.full_results", "turn.publication.result_hash"];
			}
	const invalid = checks.find((value) => value.evaluation_status !== "valid");
	const status = checks.some((value) => value.status === "fail")
		? "fail"
		: required.every((id) => checks.some((value) => value.check_id === id && value.status === "pass"))
			? "pass"
			: "unknown";
	// undefined 是 JS 缺字段，不属于冻结 JSON；序列化只用于复制观察，不修改原任务。
	const inputHash = contentHash(JSON.parse(JSON.stringify(input)));
	return immutable({
		case_id: sample.id,
		...(options.slotId ? { slot_id: options.slotId } : {}),
		track: sample.track,
		family: sample.family,
		profile: sample.profile,
		expected_action: sample.expected_action,
		status,
		evaluation_status: invalid?.evaluation_status ?? "valid",
		checks,
		input_hash: inputHash,
		scorer_hash: registry.fingerprint(),
		coverage_gaps: [...sample.coverage_gaps],
	});
}

export function aggregateScores(
	expectedCases: (Pick<EvaluationCase, "id" | "track" | "family"> & { slot_id?: string })[],
	scores: CaseScore[],
) {
	const expected = new Set(expectedCases.map((sample) => sample.slot_id ?? sample.id)),
		observed = new Set<string>();
	const duplicates: string[] = [],
		unexpected: string[] = [];
	for (const score of scores) {
		const id = score.slot_id ?? score.case_id;
		if (observed.has(id)) duplicates.push(id);
		observed.add(id);
		if (!expected.has(id)) unexpected.push(id);
	}
	const missing = [...expected].filter((id) => !observed.has(id));
	const identityMismatch = scores.some((score) => {
		const sample = expectedCases.find((item) => (item.slot_id ?? item.id) === (score.slot_id ?? score.case_id));
		return sample && (sample.id !== score.case_id || sample.track !== score.track || sample.family !== score.family);
	});
	const invalidPlan = expected.size !== expectedCases.length || !expectedCases.length;
	const mixedScorers = new Set(scores.map((score) => score.scorer_hash)).size > 1;
	const status =
		invalidPlan ||
		mixedScorers ||
		identityMismatch ||
		duplicates.length ||
		unexpected.length ||
		scores.some((score) => ["invalid_gold", "evaluator_error"].includes(score.evaluation_status))
			? "invalid"
			: missing.length || scores.some((score) => score.evaluation_status !== "valid" || score.status === "unknown")
				? "incomplete"
				: "valid";
	const tracks: Record<
		string,
		{
			numerator: number;
			denominator: number;
			failed: number;
			unevaluated: number;
			value: number | null;
			families: number;
			profiles: Record<string, number>;
		}
	> = {};
	const checks: Record<
		string,
		{ applicable: number; passed: number; failed: number; unevaluated: number; severity: "quality" | "critical" }
	> = {};
	for (const sample of expectedCases) {
		tracks[sample.track] ??= {
			numerator: 0,
			denominator: 0,
			failed: 0,
			unevaluated: 0,
			value: null,
			families: new Set(expectedCases.filter((value) => value.track === sample.track).map((value) => value.family))
				.size,
			profiles: {},
		};
		const group = tracks[sample.track];
		group.denominator++;
		const score = scores.find((value) => (value.slot_id ?? value.case_id) === (sample.slot_id ?? sample.id));
		if (score) group.profiles[score.profile] = (group.profiles[score.profile] ?? 0) + 1;
		if (score?.evaluation_status === "valid" && score.status === "pass") group.numerator++;
		else if (score?.evaluation_status === "valid" && score.status === "fail") group.failed++;
		else group.unevaluated++;
	}
	for (const score of scores)
		for (const result of score.checks) {
			checks[result.check_id] ??= {
				applicable: 0,
				passed: 0,
				failed: 0,
				unevaluated: 0,
				severity: result.severity,
			};
			const group = checks[result.check_id];
			if (result.severity === "critical") group.severity = "critical";
			if (result.status === "not_applicable") continue;
			group.applicable++;
			if (result.evaluation_status !== "valid" || result.status === "not_evaluated") group.unevaluated++;
			else if (result.status === "pass") group.passed++;
			else group.failed++;
		}
	for (const group of Object.values(tracks))
		group.value = group.denominator ? group.numerator / group.denominator : null;
	return {
		status: status as "valid" | "incomplete" | "invalid",
		planned: expectedCases.length,
		scored: scores.length,
		missing,
		duplicates,
		unexpected,
		invalid_plan: invalidPlan,
		mixed_scorers: mixedScorers,
		identity_mismatch: identityMismatch,
		tracks,
		checks,
		quality: status === "valid" ? tracks : null,
	};
}

export function createScoreSet(input: {
	dataset_hash: string;
	observation_hash: string;
	gold_hash: string;
	policy_hash?: string;
	parent_score_set_id?: string;
	scores: CaseScore[];
}): ScoreSet {
	const body = {
		schema_version: "evaluation-score-set/v1" as const,
		dataset_hash: input.dataset_hash,
		observation_hash: input.observation_hash,
		gold_hash: input.gold_hash,
		policy_hash: input.policy_hash ?? null,
		parent_score_set_id: input.parent_score_set_id ?? null,
		scores: structuredClone(input.scores),
	};
	return immutable({ id: `scores-${contentHash(body)}`, ...body });
}

export function createAdjudication(input: {
	score_set_id: string;
	check_ids: string[];
	case_ids: string[];
	reviewer: string;
	reason: string;
	evidence_refs: string[];
	revised_gold_hash: string;
	affected_variant_ids: string[];
	created_at: string;
}) {
	if (
		!input.score_set_id ||
		!/^[a-f0-9]{64}$/.test(input.revised_gold_hash) ||
		!input.reviewer.trim() ||
		!input.reason.trim() ||
		!input.case_ids.length ||
		!input.check_ids.length ||
		!input.evidence_refs.length ||
		!input.affected_variant_ids.length ||
		!Number.isFinite(Date.parse(input.created_at))
	)
		throw new Error("invalid_adjudication：裁定必须有范围、审核人和证据");
	return immutable({
		id: `adjudication-${contentHash(input)}`,
		...structuredClone(input),
		requires_rescore_all_affected: true,
	});
}
