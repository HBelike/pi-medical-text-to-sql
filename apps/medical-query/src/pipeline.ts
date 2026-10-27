import { createHash, randomUUID } from "node:crypto";
import { DomainFailure, type DomainService, type QueryResult, resultContentHash, type Source } from "./domain.ts";
import { RetrievalBudgetError, retrieveCatalog, retrieveMetrics } from "./knowledge-retrieval.ts";
import {
	L0_IDENTIFY_PROMPT,
	L0_LINK_MAX_OUTPUT_TOKENS,
	L0_LINK_PROMPT,
	L0_PIPELINE_SIGNATURE,
	L0_PROFILE,
	L0Knowledge,
	type L0Linking,
	type L0Selection,
	validateL0Linking,
} from "./l0-knowledge.ts";
import {
	type ModelExecutionScope,
	ModelFailure,
	type ModelGateway,
	type ModelOutputBudget,
	type ModelReceipt,
	object,
} from "./model.ts";
import { PROGRESSIVE_PLANNING_SIGNATURE, ProgressivePlanner, validateQueryDecision } from "./progressive-planning.ts";
import type { JsonValue, QueryRuntime, RunHandler } from "./runtime.ts";
import { SchemaDisclosureError } from "./schema-disclosure.ts";

const PLAN_PROMPT = `你是医疗结构化问数的决策与Schema Linking模块。只使用给出的当前数据源结构和已确认semantics。保持原问题及用户补充全部条件，继承历史时仅继承相关且未被修改的条件。不得猜测状态码、关联或异常阈值。不存在或能力不支持时blocked；关键业务信息缺失且用户能补充时clarify；明确问题直接query，不强制追问。返回JSON：
{"action":"query|clarify|blocked","reason":"简短可核查说明","question":"仅clarify填写","options":[],"slots":["仅clarify：具体待确认业务项，如统计时间范围、统计对象或时间口径"],"linking":{"tables":[],"fields":[],"relations":[]},"conditions":["原问题条件"],"dsl":{}}
DSL唯一格式：{"from":"表","select":[{"field":"表.列或*","aggregate":"可省略,count|sum|avg|min|max|count_distinct","as":"输出名"}],"joins":[{"relation":"目录relation id","type":"inner|left"}],"where":[{"field":"表.列","op":"eq|ne|gt|gte|lt|lte|in|not_in|like|is_null|is_not_null","value":"标量或数组"}],"group_by":["表.列"],"order_by":[{"field":"输出别名或表.列","direction":"asc|desc"}],"limit":可省略整数}。
字段必须完整限定，只有count可用*；is_null/is_not_null条件只有field和op两键，不填写value（包括null）；数组按实际需要留空；aggregate省略表示普通列；禁止SQL片段、表达式、猜JOIN。人数通常count_distinct患者键，人次按就诊键；复合关系只能用目录relation；必须满足所有条件。日期按资料固定时间；没有支持的运算不能用近似公式替代。追问question和options只用业务语言，不出现表名、字段名、状态代码、SQL或运算符；代码映射只保留内部计划。`;

// 回答模型只选择可核验的单元格引用，数值和最终语句由服务端确定性生成。
const ANSWER_PROMPT = `从查询结果选择最多6个值得展示的单元格，返回JSON {"facts":[{"row":0,"column":"结果列名"}]}。
只选真实存在的行和列，不计算新数字；结果为空返回facts空数组。不输出自由数值或医学建议。`;

// 报告固定实际提示词版本，防止把不同提示词下的并发测量混成同一基线。
export const PIPELINE_SIGNATURE = createHash("sha256")
	.update(PLAN_PROMPT)
	.update(ANSWER_PROMPT)
	.update(L0_PIPELINE_SIGNATURE)
	.update(PROGRESSIVE_PLANNING_SIGNATURE)
	.update("v4-progressive-schema-disclosure-1-scoped-budget-publication-l0-dependencies-3")
	.digest("hex");

export type StageRecord = {
	id: string;
	run_id: string;
	kind: "catalog" | "decision" | "execution" | "answer";
	label: string;
	status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
	started_at: number;
	duration_ms?: number;
	model_call_id?: string;
	data?: JsonValue;
	error?: string;
};

type L0RuleDependency = Record<string, unknown> & {
	metric_id: unknown;
	path: string;
	scope: string;
	field: string;
	op: string;
	value: unknown;
};
type L0CodeFilter = L0Linking["code_filters"][number];
const L0_DEPENDENCY_VALIDATOR_VERSION = "l0-dependencies/v2";

// IN是有类型的集合，顺序和重复项不改变语义；不能把字符串代码与数值代码视为相同。
const sameCodeValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function sameCodeSet(left: unknown, right: unknown): boolean {
	if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) return false;
	return (
		left.every((value) => right.some((other) => sameCodeValue(value, other))) &&
		right.every((value) => left.some((other) => sameCodeValue(value, other)))
	);
}
function equivalentCodeFilter(actual: L0CodeFilter, expected: L0CodeFilter): boolean {
	if (actual.field !== expected.field) return false;
	if (actual.op === expected.op)
		return ["in", "not_in"].includes(actual.op)
			? sameCodeSet(actual.value, expected.value)
			: sameCodeValue(actual.value, expected.value);
	if ((expected.op === "eq" && actual.op === "in") || (expected.op === "ne" && actual.op === "not_in"))
		return sameCodeSet(actual.value, [expected.value]);
	if ((expected.op === "in" && actual.op === "eq") || (expected.op === "not_in" && actual.op === "ne"))
		return sameCodeSet([actual.value], expected.value);
	return false;
}

/** 叶子保留原路径；等价集合只从完整的同字段正向OR子树推导，绝不跨all、指标或分子/分母合并。 */
function l0DependencyProjection(selection: L0Selection) {
	const bindings = new Map(
		(selection.input.field_bindings as Record<string, unknown>[]).map((binding) => [
			binding.logical_field_id,
			binding.physical_field,
		]),
	);
	const dependencies: L0RuleDependency[] = [];
	const alternatives = new Map<L0RuleDependency, L0CodeFilter[]>();
	const branches = new Map<L0RuleDependency, string[]>();
	const inverse: Record<string, string> = {
		eq: "ne",
		ne: "eq",
		in: "not_in",
		not_in: "in",
		is_null: "is_not_null",
		is_not_null: "is_null",
	};
	const positiveSet = (value: unknown): L0CodeFilter | undefined => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		const node = object(value);
		if (node.not || node.all) return;
		if (Array.isArray(node.any)) {
			if (!node.any.length || node.field_id) return;
			const parts = node.any.map(positiveSet);
			const first = parts[0];
			if (!first || parts.some((part) => !part || part.field !== first.field)) return;
			return { field: first.field, op: "in", value: parts.flatMap((part) => part!.value as unknown[]) };
		}
		const field = bindings.get(node.field_id);
		const values = node.operator === "eq" ? [node.value] : node.operator === "in" ? node.value : undefined;
		if (
			typeof field !== "string" ||
			!Array.isArray(values) ||
			!values.length ||
			values.some((item) => !["string", "number", "boolean"].includes(typeof item))
		)
			return;
		return { field, op: "in", value: values };
	};
	for (const metric of selection.input.metrics as Record<string, unknown>[]) {
		const walk = (value: unknown, path: string, negated = false, branchPath: string[] = []): void => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return;
			const node = object(value);
			const start = dependencies.length;
			for (const operator of ["all", "any"])
				if (Array.isArray(node[operator]))
					(node[operator] as unknown[]).forEach((child, index) => {
						// 否定下按De Morgan记录有效OR分支，阻止跨备选分支借用肯定条件。
						const disjunctive = negated ? operator === "all" : operator === "any";
						const childPath = `${path}.${operator}[${index}]`;
						walk(child, childPath, negated, disjunctive ? [...branchPath, childPath] : branchPath);
					});
			if (node.not) walk(node.not, `${path}.not`, !negated, branchPath);
			if (!negated && Array.isArray(node.any)) {
				const equivalent = positiveSet(node);
				if (equivalent)
					for (const dependency of dependencies.slice(start))
						alternatives.set(dependency, [...(alternatives.get(dependency) ?? []), equivalent]);
			}
			const field = bindings.get(node.field_id);
			let op = String(node.operator ?? "");
			if (negated) op = inverse[op] ?? "unsupported";
			if (typeof field !== "string" || !["eq", "ne", "in", "not_in", "is_null", "is_not_null"].includes(op)) return;
			if (!["is_null", "is_not_null"].includes(op) && (node.value === null || node.value === undefined)) return;
			const dependency: L0RuleDependency = {
				metric_id: metric.metric_id,
				path,
				scope: path.split(".")[0],
				field,
				op,
				value: node.value ?? null,
				provenance: node.provenance ?? null,
			};
			dependencies.push(dependency);
			branches.set(dependency, branchPath);
		};
		for (const component of ["numerator", "denominator"]) {
			const part = metric[component];
			if (part && typeof part === "object" && !Array.isArray(part))
				walk(object(part).conditions, `${component}.conditions`);
		}
	}
	return { dependencies, alternatives, branches };
}

/** 对外证据仍是带原作用域的条件引用清单，不转换为可执行的全局AND。 */
export function l0RuleDependencies(selection: L0Selection): Record<string, unknown>[] {
	return l0DependencyProjection(selection).dependencies;
}

/** 新版生产验证只读权威JSON。缺项保留首个候选并交定向修复，不能拿gold或补造正式口径。 */
export function validateL0Dependencies(linking: L0Linking, selection: L0Selection): L0Linking {
	const missing: Record<string, unknown> = {};
	const sets: [keyof L0Linking, string[]][] = [
		["tables", selection.tables.map((table) => String(table.name))],
		[
			"fields",
			(selection.input.field_bindings as Record<string, unknown>[]).map((binding) => String(binding.physical_field)),
		],
		["relations", selection.relations.map((relation) => String(relation.id))],
		["candidate_relations", selection.candidateRelations.map((relation) => String(relation.id))],
		["time_fields", selection.timeFields],
		["unresolved_rule_ids", selection.gaps.map((gap) => String(gap.issue_id))],
	];
	for (const [key, required] of sets) {
		const absent = required.filter((value) => !(linking[key] as string[]).includes(value));
		if (absent.length) missing[key] = [...new Set(absent)];
	}
	const { dependencies, alternatives, branches } = l0DependencyProjection(selection);
	const covers = (expected: L0RuleDependency) => {
		if (linking.code_filters.some((actual) => equivalentCodeFilter(actual, expected))) return true;
		if (
			alternatives
				.get(expected)
				?.some((alternative) => linking.code_filters.some((actual) => equivalentCodeFilter(actual, alternative)))
		)
			return true;
		// 仅权威规则在同指标、同分子/分母、同合取上下文必有的eq可省略冗余ne。
		// 例如GK23分母SUCCESS可排除NO_SHOW，分子或另一个OR分支的SUCCESS不能借用。
		return (
			expected.op === "ne" &&
			dependencies.some(
				(witness) =>
					witness.metric_id === expected.metric_id &&
					witness.scope === expected.scope &&
					witness.field === expected.field &&
					witness.op === "eq" &&
					!sameCodeValue(witness.value, expected.value) &&
					branches.get(witness)!.every((branch) => branches.get(expected)!.includes(branch)) &&
					linking.code_filters.some((actual) => equivalentCodeFilter(actual, witness)),
			)
		);
	};
	const absentConditions = dependencies.filter((dependency) => !covers(dependency));
	if (absentConditions.length) missing.scoped_conditions = absentConditions;
	if (Object.keys(missing).length)
		throw new DomainFailure(
			"missing_rule_dependencies",
			`所选指标缺少必要结构化依赖：${JSON.stringify(missing)}`,
			true,
			{ missing, validator_version: L0_DEPENDENCY_VALIDATOR_VERSION },
		);
	return linking;
}

export function createPipeline(
	domain: DomainService,
	models: Pick<ModelGateway, "json">,
	getRuntime: () => QueryRuntime,
): RunHandler {
	// SDK结果在持久化边界转换为纯JSON，明确剔除不存在的可选属性。
	const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
	return async (task, signal, progress) => {
		// 追问只继承已记录的事实，不为旧任务按新模板补造提示词或阶段。
		const saved =
			task.progress && typeof task.progress === "object" && !Array.isArray(task.progress) ? task.progress : {};
		const savedCalls: ModelReceipt[] = Array.isArray(saved.model_calls)
			? (JSON.parse(JSON.stringify(saved.model_calls)) as ModelReceipt[])
			: [];
		const receipts: ModelReceipt[] = (
			Array.isArray(saved.usage) ? (JSON.parse(JSON.stringify(saved.usage)) as ModelReceipt[]) : []
		).map((receipt) => ({ ...receipt, ...savedCalls.find((call) => call.id && call.id === receipt.id) }));
		const stages: StageRecord[] = Array.isArray(saved.stages)
			? (JSON.parse(JSON.stringify(saved.stages)) as StageRecord[])
			: [];
		const diagnostics: Record<string, unknown>[] = Array.isArray(saved.diagnostics)
			? (structuredClone(saved.diagnostics) as Record<string, unknown>[])
			: [];
		const repairs: Record<string, unknown>[] = Array.isArray(saved.repairs)
			? (structuredClone(saved.repairs) as Record<string, unknown>[])
			: [];
		const retrievals: unknown[] = Array.isArray(saved.retrievals) ? structuredClone(saved.retrievals) : [];
		let pendingRepair: Record<string, unknown> | undefined;
		const artifactHash = (value: unknown) =>
			createHash("sha256")
				.update(JSON.stringify(value ?? null))
				.digest("hex");
		const scope: ModelExecutionScope = {
			turn_id: task.id,
			run_id: task.runId,
			mode: task.context.mode === "eval" ? "eval" : "online",
			experiment_id: String(task.context.experiment_id ?? "unscoped"),
			variant_id: String(task.context.variant_id ?? "default"),
			execution_id: String(task.context.execution_id ?? task.id),
			slot_id: String(task.context.slot_id ?? task.id),
			...(task.context.model_profile
				? { model_profile: object(task.context.model_profile) as ModelExecutionScope["model_profile"] }
				: {}),
		};
		const trace = () => ({
			// 提示词与输出原文只保存在实际调用卡片，不复制到用量摘要或后续问题的 evidence。
			usage: receipts.map(({ system_prompt: _system, user_prompt: _user, output_text: _output, ...usage }) => usage),
			model_calls: receipts.filter(
				(receipt) => receipt.id && typeof receipt.system_prompt === "string" && typeof receipt.user_prompt === "string",
			),
			stages,
			diagnostics,
			repairs,
			retrievals,
		});
		let currentProgress: Record<string, unknown> = {};
		const update = (value: Record<string, unknown> = {}) => {
			currentProgress = { ...currentProgress, ...value, ...trace() };
			return progress(json(currentProgress));
		};
		// 每项记录覆盖真正调用的整段操作（含该段资源等待），不拆分当前未独立执行的内部步骤。
		const recordStage = async <T>(
			kind: StageRecord["kind"],
			label: string,
			operation: (stage: StageRecord) => Promise<T>,
			describe: (value: T) => unknown,
			phase = label,
		): Promise<T> => {
			const stage: StageRecord = {
				id: randomUUID(),
				run_id: task.runId,
				kind,
				label,
				status: "running",
				started_at: Date.now(),
			};
			stages.push(stage);
			const repairing = pendingRepair?.target_kind === kind ? pendingRepair : undefined;
			if (repairing) repairing.after_stage_id = stage.id;
			await update({ phase });
			try {
				const value = await operation(stage);
				stage.status = "completed";
				stage.data = json(describe(value));
				if (pendingRepair && pendingRepair.target_kind === kind) {
					pendingRepair.after_artifact_hash = artifactHash(value);
					pendingRepair.after_stage_id = stage.id;
					pendingRepair.revalidated = pendingRepair.stage !== "execution";
					if (kind === "answer") pendingRepair.protected_constraints_preserved = true;
					pendingRepair = undefined;
				}
				return value;
			} catch (error) {
				stage.status = signal.aborted ? "cancelled" : "failed";
				stage.error = signal.aborted ? "任务已停止" : error instanceof Error ? error.message : "阶段执行失败";
				if (kind === "answer")
					stage.data = {
						...object(stage.data ?? {}),
						answer: "查询数据已保留，可查看下方结果表。",
						answer_status: stage.status,
					};
				throw error;
			} finally {
				if (repairing) {
					repairing.after_artifact_hash = artifactHash(
						stage.data ?? receipts.find((receipt) => receipt.id === stage.model_call_id)?.output_text,
					);
					repairing.after_stage_id = stage.id;
				}
				stage.duration_ms = Date.now() - stage.started_at;
				await update();
			}
		};
		const repair = async (error: unknown, stage: StageRecord | undefined, answer = false): Promise<boolean> => {
			const allowed =
				task.context.repair_policy !== "off" &&
				(error instanceof DomainFailure || error instanceof ModelFailure) &&
				error.repairable;
			const diagnostic = {
				id: randomUUID(),
				stage_id: stage?.id,
				run_id: task.runId,
				code: error instanceof DomainFailure || error instanceof ModelFailure ? error.code : "unclassified_failure",
				message: error instanceof Error ? error.message : "阶段失败",
				certainty: error instanceof DomainFailure || error instanceof ModelFailure ? "confirmed" : "unknown",
				cause_status: error instanceof DomainFailure || error instanceof ModelFailure ? "confirmed" : "unknown",
				evidence_refs: [stage?.id, stage?.model_call_id].filter(Boolean),
				required_condition_failure:
					error instanceof DomainFailure ||
					(error instanceof ModelFailure && ["model_json", "model_length"].includes(error.code)),
				repairable: allowed,
				repaired: false,
				evidence: {
					stage_id: stage?.id,
					model_call_id: stage?.model_call_id,
					...(error instanceof DomainFailure && error.details ? error.details : {}),
				},
			};
			diagnostics.push(diagnostic);
			await update();
			if (!allowed || signal.aborted) return false;
			try {
				await getRuntime().consumeBudget(task.id, task.runId, answer ? "answerRepairs" : "repairs");
			} catch (budgetError) {
				if (
					typeof budgetError === "object" &&
					budgetError !== null &&
					"code" in budgetError &&
					budgetError.code === "budget_exhausted"
				)
					return false;
				throw budgetError;
			}
			diagnostic.repaired = true;
			pendingRepair = {
				stage: stage?.kind,
				attempt_id: stage?.id,
				diagnostic_id: diagnostic.id,
				target_kind: stage?.kind === "execution" ? "decision" : stage?.kind,
				before_artifact_hash: artifactHash(
					stage?.data ?? receipts.find((receipt) => receipt.id === stage?.model_call_id)?.output_text,
				),
				after_artifact_hash: null,
				protected_constraints_preserved: null,
				repair_triggered: true,
				revalidated: false,
				policy: task.context.repair_policy ?? "targeted",
			};
			repairs.push(pendingRepair);
			await update();
			return true;
		};
		// 仅重试失败模型阶段，并给出程序检查证据；不重跑已发布SQL、不修改业务约束。
		const validatedModel = async <T>(
			role: "decision" | "answer",
			label: string,
			prompt: string,
			input: Record<string, unknown>,
			validate: (value: unknown) => T,
			maxOutputTokens: ModelOutputBudget = 4096,
		): Promise<T> => {
			let correction: Record<string, unknown> | undefined;
			let transientRetries = 0;
			for (;;) {
				try {
					return await recordStage(
						role,
						label,
						async (stage) => {
							const value = await models.json(
								role,
								prompt,
								{ ...input, ...(correction ? { correction } : {}) },
								signal,
								receipts,
								task.context.mode === "eval" ? 0 : 1,
								() => {
									stage.model_call_id = receipts.at(-1)?.id;
									return update({ phase: label });
								},
								maxOutputTokens,
								scope,
							);
							stage.data = json({ candidate: value });
							try {
								return validate(value);
							} catch (error) {
								if (error instanceof DomainFailure) throw error;
								throw new DomainFailure(
									"model_schema",
									error instanceof Error ? error.message : "输出结构不合法",
									true,
								);
							}
						},
						(value) => value,
						"等待模型资源",
					);
				} catch (error) {
					if (
						error instanceof ModelFailure &&
						error.code === "model_rate_limited" &&
						transientRetries++ < 1 &&
						!signal.aborted
					) {
						diagnostics.push({
							id: randomUUID(),
							code: error.code,
							stage_id: stages.at(-1)?.id,
							cause_status: "confirmed",
							repair_triggered: false,
							retry: "transient",
							evidence_refs: [stages.at(-1)?.model_call_id],
						});
						await update();
						continue;
					}
					if (!(await repair(error, stages.at(-1), role === "answer"))) throw error;
					correction =
						task.context.repair_policy === "ordinary_retry"
							? { instruction: "请按原问题重新生成，仍须遵守原来的格式与业务约束。" }
							: {
									failure: error instanceof Error ? error.message : "结构错误",
									instruction: "仅修正此阶段被指出的问题，保留全部已确认业务条件，不输出SQL，不补造缺失口径。",
								};
				}
			}
		};
		const sourceId = String(task.context.source_id);
		const { source, fingerprint, catalog, knowledge } = await recordStage(
			"catalog",
			"读取数据结构与语义",
			async () => {
				let source: Source;
				if (task.context.source_snapshot) {
					const frozen = object(task.context.source_snapshot);
					if (
						frozen.id !== sourceId ||
						typeof frozen.path !== "string" ||
						typeof frozen.name !== "string" ||
						(frozen.dictionary_path !== undefined && typeof frozen.dictionary_path !== "string") ||
						(frozen.knowledge_path !== undefined && typeof frozen.knowledge_path !== "string")
					)
						throw new Error("冻结数据源格式不合法");
					source = frozen as Source;
				} else source = await domain.source(sourceId);
				const fingerprint = await domain.fingerprint(source);
				if (task.context.source_version && task.context.source_version !== fingerprint)
					throw new Error("数据源版本已变化，请新建任务");
				const original = object((await domain.call(source, "catalog", signal, undefined, scope)).catalog);
				const knowledge = source.knowledge_path ? await L0Knowledge.load(source.knowledge_path) : undefined;
				// L0仅保留物理目录；大字典按选中指标投影，不进入全量提示词或目录观察记录。
				const catalog = knowledge
					? { tables: original.tables, relations: original.relations, schema_fingerprint: original.schema_fingerprint }
					: original;
				return { source, fingerprint, catalog, knowledge };
			},
			(value) => ({
				source_id: sourceId,
				source_version: value.fingerprint,
				tables: Array.isArray(object(value.catalog).tables)
					? (object(value.catalog).tables as unknown[]).map((table) => object(table).name)
					: [],
				catalog: value.catalog,
			}),
		);
		const previous = (await getRuntime().list(task.conversationId))
			.filter((item) => {
				if (item.id === task.id || !(item.status === "completed" || (knowledge && item.status === "blocked")))
					return false;
				const payload =
					item.result && typeof item.result === "object" && !Array.isArray(item.result) ? object(item.result) : {};
				const evidence =
					payload.evidence && typeof payload.evidence === "object" && !Array.isArray(payload.evidence)
						? object(payload.evidence)
						: {};
				// 同一会话也只能继承同版本来源，避免旧字段/代码证据污染新快照。
				return evidence.source_id === sourceId && evidence.source_version === fingerprint;
			})
			.slice(-3);
		const prior = previous.map((item) => {
			const previousResult =
				item.result && typeof item.result === "object" && !Array.isArray(item.result) ? object(item.result) : {};
			// 续问继承已确认口径与计划，不把历史数值或整表再次喂给模型当作实时答案。
			const priorEvidence = previousResult.evidence;
			// L0的blocked是匹配分支终态，可继承业务引用，但提示词、阶段和全量知识不进后续历史。
			const evidence =
				knowledge && priorEvidence && typeof priorEvidence === "object" && !Array.isArray(priorEvidence)
					? {
							profile: object(priorEvidence).profile,
							linking: object(priorEvidence).linking,
							metric_statuses: object(priorEvidence).metric_statuses,
						}
					: priorEvidence;
			return { question: item.question, replies: item.replies, evidence };
		});
		// 失败的预算检查也留下实际候选与完整依赖收据，不能伪装成一次成功检索或进入模型修复。
		const retrieve = async <T>(operation: () => T): Promise<T> => {
			try {
				return operation();
			} catch (error) {
				if (error instanceof RetrievalBudgetError || (error instanceof SchemaDisclosureError && error.receipt)) {
					retrievals.push({ ...error.receipt, run_id: task.runId, status: "failed", error_code: error.code });
					await update({ phase: "检索上下文超出预算" });
				}
				throw error;
			}
		};
		// 使用任务持久化的检索配置，确保实验快照与在线执行遵循相同预算和候选上限。
		const retrievalSettings = {
			strategy: String(task.context.retrieval_strategy ?? "lexical"),
			max_context_chars: Number(task.context.retrieval_max_context_chars ?? 256000),
			limit: Number(task.context.retrieval_top_k ?? 12),
		};
		if (knowledge) {
			const retrieved = await retrieve(() =>
				retrieveMetrics({
					question: [task.question, ...task.replies.map((reply) => JSON.stringify(reply.answer))].join("\n"),
					...retrievalSettings,
					// L0先识别指标再完整展开规则依赖，不把普通查询的物理表选择套到正式指标上。
					strategy: retrievalSettings.strategy === "progressive" ? "lexical" : retrievalSettings.strategy,
					limit: retrievalSettings.strategy === "progressive" ? 12 : retrievalSettings.limit,
					version: fingerprint,
					source_id: sourceId,
					metrics: knowledge.index(),
				}),
			);
			retrievals.push({ ...retrieved.receipt, run_id: task.runId });
			await update({ phase: "指标候选检索" });
			// 两次模型调用复用同一网关、资源池与Durable阶段；没有SQL执行或回答模型分支。
			const decide = async <T>(
				label: string,
				prompt: string,
				input: Record<string, unknown>,
				validate: (value: unknown) => T,
				maxOutputTokens: ModelOutputBudget = 4096,
			) => validatedModel("decision", label, prompt, input, validate, maxOutputTokens);
			if ((await domain.fingerprint(source)) !== fingerprint) throw new Error("数据源版本已变化");
			const metricIds = await decide(
				"识别医疗指标",
				L0_IDENTIFY_PROMPT,
				{ question: task.question, replies: task.replies, prior, metric_catalog: retrieved.metrics },
				(value) => {
					const ids = knowledge.identify(value);
					if (ids.some((id) => !retrieved.receipt.admitted_ids.includes(id))) throw new Error("指标不在本次检索候选内");
					return ids;
				},
			);
			const selection = knowledge.select(metricIds, catalog);
			// 识别候选与规则依赖展开分别留证，不能把裁剪后的指标匹配误报为全库选表。
			retrievals.push({
				schema_version: "knowledge-projection/v1",
				source_id: sourceId,
				source_version: fingerprint,
				run_id: task.runId,
				metric_ids: metricIds,
				input_hash: artifactHash(selection.input),
				tables: selection.tables.map((table) => table.name),
				fields: (selection.input.field_bindings as Record<string, unknown>[]).map((binding) => binding.physical_field),
				relations: selection.relations.map((relation) => relation.id),
				candidate_relations: selection.candidateRelations.map((relation) => relation.id),
				time_fields: selection.timeFields,
				gaps: selection.gaps.map((gap) => gap.issue_id),
				status: "complete",
			});
			await update();
			const linking = await decide(
				"匹配字段、关系与规则缺口",
				`${L0_LINK_PROMPT}\n本次依赖完整性验证要求：必须覆盖知识包field_bindings、relation_bindings、time_fields、gaps的全部所选指标依赖；code_filters是已绑定条件叶子的引用清单，不是可直接执行的全局AND，保留原规则分子/分母作用域。缺参数的条件不能编造值。`,
				{
					question: task.question,
					replies: task.replies,
					prior,
					as_of: task.context.as_of,
					knowledge: selection.input,
				},
				(value) => validateL0Dependencies(validateL0Linking(value, selection), selection),
				L0_LINK_MAX_OUTPUT_TOKENS,
			);
			if ((await domain.fingerprint(source)) !== fingerprint) throw new Error("数据源版本已变化");
			const evidence = {
				profile: L0_PROFILE,
				source_id: sourceId,
				source_version: fingerprint,
				as_of: task.context.as_of,
				match_status: metricIds.length ? "matched" : "no_match",
				linking,
				metric_statuses: selection.metricStatuses,
				rule_dependencies: l0RuleDependencies(selection),
				dependency_validator_version: L0_DEPENDENCY_VALIDATOR_VERSION,
			};
			await update({ phase: "记录匹配边界", evidence });
			const answer = await recordStage(
				"answer",
				"记录匹配结果与计算边界",
				async () =>
					metricIds.length
						? `已识别：${selection.metricStatuses.map((metric) => metric.name).join("、")}。已记录字段、关系和规则缺口。本期仅验证Schema Linking，指标仍保留原有阻断状态，未执行SQL或生成指标数值。`
						: "当前指标目录未匹配到相应指标。本期仅验证Schema Linking，未执行SQL或生成指标数值。",
				(value) => ({ answer: value, method: "deterministic_linking_boundary" }),
			);
			return { status: "blocked", result: json({ answer, evidence, ...trace() }) };
		}
		let decision: ReturnType<typeof object> = {};
		// 新策略让模型先看轻量索引并有限补读；旧策略保留为可冻结的对照，不混用两种上下文。
		const progressive =
			retrievalSettings.strategy === "progressive"
				? await retrieve(
						() =>
							new ProgressivePlanner({
								catalog,
								source_id: sourceId,
								version: fingerprint,
								max_context_chars: retrievalSettings.max_context_chars,
								initial_limit: retrievalSettings.limit,
								question: task.question,
								replies: task.replies,
								prior,
								as_of: task.context.as_of,
								plan_prompt: PLAN_PROMPT,
								decide: (label, prompt, input, validate) => validatedModel("decision", label, prompt, input, validate),
								observe: async (receipt, phase) => {
									retrievals.push({ ...object(receipt), run_id: task.runId });
									await update({ phase });
								},
								assert_source: async () => {
									if ((await domain.fingerprint(source)) !== fingerprint)
										throw new DomainFailure("source_version_changed", "数据源版本已变化");
								},
							}),
					)
				: undefined;
		const retrieved = progressive
			? undefined
			: await retrieve(() =>
					retrieveCatalog({
						question: [task.question, ...task.replies.map((reply) => JSON.stringify(reply.answer))].join("\n"),
						...retrievalSettings,
						version: fingerprint,
						source_id: sourceId,
						catalog,
					}),
				);
		if (retrieved) {
			retrievals.push({ ...retrieved.receipt, run_id: task.runId });
			await update({ phase: "数据表候选检索" });
		}
		let result: QueryResult | undefined;
		const errors: string[] = [];
		let protectedFilters: unknown[] = [];
		const physicalFields = () =>
			new Set(
				((progressive?.catalog ?? retrieved!.catalog).tables as Record<string, unknown>[]).flatMap((table) =>
					(table.columns as Record<string, unknown>[]).map((column) => `${table.name}.${column.name}`),
				),
			);
		const preservesFilter = (before: unknown, after: unknown): boolean => {
			if (JSON.stringify(before) === JSON.stringify(after)) return true;
			const original = object(before),
				candidate = object(after);
			// 空值判断没有操作数：仅允许同字段、同方向删除冗余value:null，不借语法修复改变条件。
			if (
				["is_null", "is_not_null"].includes(String(original.op)) &&
				original.value === null &&
				Object.keys(original).length === 3 &&
				Object.keys(candidate).length === 2 &&
				!Object.hasOwn(candidate, "value") &&
				original.field === candidate.field &&
				original.op === candidate.op
			)
				return true;
			// 首个候选的不存在字段不是已确认口径；允许纠正引用，但操作符和值必须逐字保留。
			return (
				!physicalFields().has(String(original.field)) &&
				physicalFields().has(String(candidate.field)) &&
				original.op === candidate.op &&
				JSON.stringify(original.value) === JSON.stringify(candidate.value)
			);
		};
		// 最多一次定向修复：不能因正常空结果去放宽条件。
		for (let attempt = 0; attempt < 2; attempt++) {
			await update({ phase: "等待模型资源", attempt: attempt + 1 });
			decision = progressive
				? await progressive.plan(errors.at(-1))
				: await validatedModel(
						"decision",
						"理解问题、匹配字段与制定计划",
						PLAN_PROMPT,
						{
							question: task.question,
							replies: task.replies,
							source_id: sourceId,
							as_of: task.context.as_of,
							catalog: retrieved!.catalog,
							prior,
							correction: errors.length
								? task.context.repair_policy === "ordinary_retry"
									? "请按原问题重新生成，保留全部条件。"
									: errors.at(-1)
								: undefined,
						},
						validateQueryDecision,
					);
			await update({
				phase: "校验查询计划",
				linking: decision.linking,
				conditions: decision.conditions,
				usage: receipts,
			});
			if (decision.action === "clarify") {
				if (typeof decision.question !== "string" || !decision.question.trim()) throw new Error("追问缺少具体问题");
				if (task.replies.length >= 3)
					return { status: "blocked", result: json({ answer: "补充轮次已到上限，仍缺少必要口径。", ...trace() }) };
				return {
					status: "waiting_for_user" as const,
					clarification: {
						question: decision.question,
						...(Array.isArray(decision.slots) ? { slots: decision.slots as string[] } : {}),
						options: Array.isArray(decision.options)
							? decision.options.filter((value) => typeof value === "string").slice(0, 8)
							: [],
					},
				};
			}
			if (decision.action === "blocked")
				return {
					status: "blocked",
					result: json({ answer: String(decision.reason || "当前数据或算子不足以回答"), ...trace() }),
				};
			if (decision.action !== "query") throw new Error("模型决策类型无效");
			const where = object(decision.dsl).where;
			if (attempt === 0) protectedFilters = Array.isArray(where) ? structuredClone(where) : [];
			else if (
				protectedFilters.some(
					(filter) => !Array.isArray(where) || !where.some((candidate) => preservesFilter(filter, candidate)),
				)
			)
				throw new DomainFailure("repair_changed_conditions", "定向修复删除或改变了原查询过滤条件，已阻止执行");
			if (attempt > 0 && repairs.at(-1)) repairs.at(-1)!.protected_constraints_preserved = true;
			try {
				result = await recordStage(
					"execution",
					"校验编译并执行查询",
					async (stage) => {
						stage.data = json({ dsl: decision.dsl });
						if ((await domain.fingerprint(source)) !== fingerprint) throw new Error("数据源版本已变化");
						await getRuntime().consumeBudget(task.id, task.runId, "sqlExecutions");
						return (await domain.call(source, "execute", signal, decision.dsl, scope)) as unknown as QueryResult;
					},
					(value) => ({ dsl: decision.dsl, result: value }),
				);
				for (const repair of repairs)
					if (repair.stage === "execution" && repair.after_stage_id) repair.revalidated = true;
				break;
			} catch (error) {
				signal.throwIfAborted();
				const message = error instanceof Error ? error.message : "查询校验失败";
				if (message.includes("版本已变化") || attempt === 1 || !(await repair(error, stages.at(-1)))) throw error;
				errors.push(message);
			}
		}
		if (!result) throw new Error("没有可用的执行结果");
		const evidence = {
			source_id: sourceId,
			source_version: fingerprint,
			as_of: task.context.as_of,
			linking: decision.linking,
			conditions: decision.conditions,
			...(progressive ? { requirement_coverage: decision.coverage, schema_disclosure: "progressive/v1" } : {}),
			dsl: decision.dsl,
			sql: result.sql,
			parameters: result.parameters,
			repairs: errors,
			plan_hash: createHash("sha256").update(JSON.stringify(decision.dsl)).digest("hex"),
		};
		// 数值发布前完成来源、编译结果和数据完整性检查；失败产物仅作为调试候选保留。
		await update({ phase: "验证查询结果", candidate_result: result, evidence });
		if ((await domain.fingerprint(source)) !== fingerprint)
			throw new DomainFailure("source_version_changed", "数据源版本已变化");
		if (!result.complete || result.truncated)
			throw new DomainFailure("incomplete_result", "查询结果不完整，未发布数值，请缩小范围或调整已登记结果预算");
		if (
			!Array.isArray(result.columns) ||
			result.columns.some((column) => typeof column !== "string") ||
			new Set(result.columns).size !== result.columns.length ||
			!Array.isArray(result.rows) ||
			result.rows.some((row) => !Array.isArray(row) || row.length !== result.columns.length) ||
			result.row_count !== result.rows.length ||
			typeof result.sql !== "string"
		)
			throw new DomainFailure("invalid_result_shape", "领域结果结构或完整行数不一致");
		const contentHash = resultContentHash(result);
		if (
			result.result_content_hash !== undefined &&
			(result.hash_algorithm !== "medical-query-result/v1" || result.result_content_hash !== contentHash)
		)
			throw new DomainFailure("result_hash_mismatch", "完整结果内容校验和不一致，未发布数值");
		signal.throwIfAborted();
		const publication: Record<string, unknown> = {
			id: randomUUID(),
			version: 1,
			status: "published",
			result,
			evidence,
			source_version: fingerprint,
			result_hash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
			validation: {
				status: "passed",
				checks: ["source_version", "compiler", "read_only", "complete_result", "row_shape", "content_hash"],
				result_content_hash: contentHash,
			},
			published_at: Date.now(),
		};
		await update({ phase: "生成结果说明", publication });
		const summary =
			result.rows.length === 0
				? "没有符合条件的记录。"
				: result.complete
					? `本次查询返回 ${result.rows.length} 行。`
					: `已展示前 ${result.rows.length} 行，结果尚不完整，请缩小范围。`;
		let facts: string[] = [];
		try {
			if (result.rows.length > 0)
				facts = await validatedModel(
					"answer",
					"生成并核对结果说明",
					ANSWER_PROMPT,
					{
						question: task.question,
						columns: result.columns,
						rows: result.rows.slice(0, 20),
						complete: result.complete,
					},
					(value) => {
						const selected = object(value);
						if (!Array.isArray(selected.facts) || selected.facts.length > 6) throw new Error("回答引用格式无效");
						return selected.facts.map((value) => {
							const fact = object(value);
							if (!Number.isInteger(fact.row) || typeof fact.column !== "string") throw new Error("回答引用无效");
							const row = Number(fact.row),
								column = result!.columns.indexOf(fact.column);
							if (row < 0 || row >= Math.min(result!.rows.length, 20) || column < 0)
								throw new Error("回答引用超出真实结果范围");
							const cell = result!.rows[row][column];
							return `第 ${row + 1} 行 ${fact.column}：${cell === null ? "空值" : String(cell)}`;
						});
					},
				);
			else
				await recordStage(
					"answer",
					"生成并核对结果说明",
					async () => [],
					() => ({ answer: summary, answer_status: "completed", facts: [], method: "empty_result_summary" }),
				);
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof ModelFailure && error.code === "external_call_unknown") throw error;
			return {
				status: "failed",
				error: "数据已取得，结果说明生成失败",
				result: json({
					publication,
					result,
					evidence,
					...trace(),
					answer_status: "failed",
					answer: "查询数据已保留，可查看下方结果表。",
				}),
			};
		}
		signal.throwIfAborted();
		publication.answer = [summary, ...facts].join("\n");
		publication.answer_status = "completed";
		await update({ phase: "完成", publication });
		return {
			status: "completed",
			result: json({
				publication,
				answer: [summary, ...facts].join("\n"),
				answer_status: "completed",
				result,
				evidence,
				...trace(),
			}),
		};
	};
}
