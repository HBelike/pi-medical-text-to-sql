import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Application } from "../application.ts";
import { publicTurn } from "../application.ts";
import { defaultRetrievalTopK } from "../config.ts";
import type { Source } from "../domain.ts";
import { object } from "../model.ts";
import { type JsonObject, type QueryRuntime, type QueryTask, RuntimeError } from "../runtime.ts";
import { observedPerformance, observedRetrievalCoverage, stageAttribution } from "./attribution.ts";
import {
	type ComparisonProtocol,
	checkComparability,
	compareArms,
	deriveFirstTaskOutcome,
	evaluateQualityGate,
	passK,
	type QualityReport,
	type ScoredObservation,
	summarizeRepairs,
	validateQualityPolicy,
} from "./comparison.ts";
import { type DatasetVersion, loadBenchmarkDataset, parseDataset, publicDataset } from "./datasets.ts";
import { type ScoreJob, scoreInWorkers } from "./score-worker-pool.ts";
import { aggregateScores, type CaseScore, createScoreSet, type ScoreSet } from "./scoring.ts";
import { executionFingerprint, freezeSource, runtimeConfiguration, type SourceSnapshot } from "./snapshots.ts";
import { EvaluationStore, fingerprint, type SlotRecord, type Stored } from "./store.ts";

export type Variant = {
	id: string;
	name: string;
	hash: string;
	model_profile: { decision_model: string; answer_model: string; resource_scope_id: string };
	repair_limit: number;
	model_call_limit: number;
	retrieval_strategy: "full_catalog" | "lexical" | "progressive";
	retrieval_max_context_chars?: number;
	retrieval_top_k?: number;
	repair_policy: "off" | "targeted" | "ordinary_retry";
};
export type Experiment = {
	id: string;
	name: string;
	dataset_id: string;
	variant_ids: string[];
	repeats: number;
	status: "running" | "pausing" | "paused" | "cancelling" | "cancelled" | "completed" | "incomplete";
	case_ids: string[];
	snapshots: Record<string, SourceSnapshot>;
	execution_hash: string;
	quality_policy: Record<string, unknown> | null;
	concurrency: number;
	origin_experiment_id?: string;
	latest_score_set_id?: string;
	error?: string;
	created_at: number;
	scoring_dataset_id?: string;
	comparison_protocol?: ComparisonProtocol;
	reply_scripts?: Record<string, string[]>;
	runtime_configuration?: ReturnType<typeof runtimeConfiguration>;
};
type ScoredRun = ScoreSet & {
	scoring_execution_hash: string;
	experiment_id: string;
	status: "completed";
	report: QualityReport;
	variant_reports: Record<string, QualityReport>;
	repairs: ReturnType<typeof summarizeRepairs>;
	observation_ids: string[];
	created_at: number;
};
type DatasetRegistration = { artifact_id: string; summary: ReturnType<typeof publicDataset>; sources: Source[] };
type Command = Record<string, unknown> & { idempotency_key?: string; expected_revision?: number };
type Verdict = "pass" | "fail" | "unknown" | "unscored";

// 评分无效或证据不足时保留未知，不能把运行完成直接折算为答对或答错。
function verdictFor(score?: { status: string; evaluation_status: string }): Verdict {
	if (!score) return "unscored";
	return score.evaluation_status === "valid" && (score.status === "pass" || score.status === "fail")
		? score.status
		: "unknown";
}

function scoreSummary(scores: CaseScore[] | undefined, total: number) {
	const verdicts = { pass: 0, fail: 0, unknown: 0, unscored: 0 };
	for (const score of scores ?? []) verdicts[verdictFor(score)]++;
	verdicts.unscored = Math.max(0, total - verdicts.pass - verdicts.fail - verdicts.unknown);
	const judged_denominator = verdicts.pass + verdicts.fail;
	return {
		verdicts,
		accuracy: {
			judged: judged_denominator ? verdicts.pass / judged_denominator : null,
			judged_denominator,
			all: scores && total && verdicts.unscored === 0 ? verdicts.pass / total : null,
			all_denominator: total,
		},
	};
}

// 耗时分位数只使用确实记录的非负毫秒值；没有样本时返回 null。
function durationPercentile(values: number[], fraction: number): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function observationDuration(task: QueryTask): number | null {
	return typeof task.endedAt === "number" &&
		Number.isFinite(task.endedAt) &&
		Number.isFinite(task.createdAt) &&
		task.endedAt >= task.createdAt
		? task.endedAt - task.createdAt
		: null;
}

function text(value: unknown, label: string, fallback?: string, max = 4000): string {
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw new RuntimeError("invalid_input", `${label}无效`, 400);
	return value;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
	const number = value === undefined ? fallback : Number(value);
	if (!Number.isSafeInteger(number) || number < min || number > max)
		throw new RuntimeError("invalid_input", `数值必须为 ${min}～${max}`, 400);
	return number;
}
function strings(value: unknown, label: string): string[] {
	if (
		!Array.isArray(value) ||
		!value.length ||
		value.some((item) => typeof item !== "string") ||
		new Set(value).size !== value.length
	)
		throw new RuntimeError("invalid_input", `${label}必须为非空、无重复字符串数组`, 400);
	return value as string[];
}

/** 实验只向同一个 Pi 运行时提交业务请求；定时盘点可重建，不承担第二套模型执行循环。 */
export class EvaluationService {
	readonly store: EvaluationStore;
	readonly app: Application;
	private timer?: ReturnType<typeof setTimeout>;
	private pumping?: Promise<void>;
	private mutation: Promise<unknown> = Promise.resolve();
	private closed = false;
	private roundRobin = 0;
	private codeHash = "";
	private activeCommand?: { key: string; input: Command };
	private readonly scoring = new Map<string, { promise: Promise<void>; controller: AbortController }>();
	private constructor(app: Application) {
		this.app = app;
		this.store = new EvaluationStore(resolve(app.config.dataDir, "evaluation"));
	}
	// Pi 恢复派发前重放控制意图，避免暂停/取消在两份账本提交之间丢失。
	static async restoreControls(runtime: QueryRuntime, dataDir: string) {
		if (!existsSync(resolve(dataDir, "evaluation/evaluation.sqlite"))) return;
		const store = new EvaluationStore(resolve(dataDir, "evaluation"));
		try {
			for (const record of store.all<Experiment>("experiment"))
				await EvaluationService.applyRuntimeControl(runtime, record.data);
		} finally {
			store.close();
		}
	}
	// 以当前控制意图对齐 Pi，包含“继续已提交、旧暂停尚未清除”的恢复断点。
	private static async applyRuntimeControl(runtime: QueryRuntime, experiment: Experiment): Promise<void> {
		if (["cancelling", "cancelled"].includes(experiment.status)) await runtime.cancelExperiment(experiment.id);
		else if (["pausing", "paused"].includes(experiment.status)) await runtime.setExperimentPaused(experiment.id, true);
		else if (experiment.status === "running") await runtime.setExperimentPaused(experiment.id, false);
	}
	private async recoverControl(id: string): Promise<void> {
		const experiment = this.require<Experiment>("experiment", id).data;
		await EvaluationService.applyRuntimeControl(this.app.runtime, experiment);
		if (["cancelling", "cancelled"].includes(experiment.status))
			for (const slot of this.store.slots(id, -1, 10000, ["planned"]))
				this.store.updateSlot({ ...slot, status: "cancelled" });
	}
	static async open(app: Application) {
		const service = new EvaluationService(app);
		try {
			service.codeHash = await executionFingerprint();
			if (!service.store.list("dataset", "", 1).length) {
				const packagePath = resolve(app.config.dataDir, "l0-benchmark-v1");
				if (existsSync(resolve(packagePath, "manifest.json")))
					await service.importDataset({ path: packagePath, idempotency_key: "builtin-l0-v1" });
			}
			if (!service.store.list("variant", "", 1).length) {
				await service.createVariant({
					name: "当前配置 · 不修复",
					repair_limit: 0,
					idempotency_key: "builtin-repair-off",
				});
				await service.createVariant({ name: "定向修复", repair_limit: 1, idempotency_key: "builtin-repair-on" });
				await service.createVariant({
					name: "等预算普通重试",
					repair_limit: 1,
					repair_policy: "ordinary_retry",
					idempotency_key: "builtin-retry",
				});
			}
			// 确定性评分没有外部计费副作用，进程退出后的同一评分意图可安全恢复。
			for (const job of service.store.all<{
				experiment_id: string;
				status: string;
				execution_hash: string;
				experiment: Experiment;
			}>("score_job")) {
				if (job.data.status !== "running") continue;
				if (job.data.execution_hash === service.codeHash) service.startGrade(job.data.experiment, job.id);
				else service.store.put("score_job", job.id, { ...job.data, status: "failed", error: "scorer_version_changed" });
			}
			service.schedule();
			return service;
		} catch (error) {
			service.store.close();
			throw error;
		}
	}
	private exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutation.then(operation, operation);
		this.mutation = result.catch(() => {});
		return result;
	}
	private async command<T>(
		namespace: string,
		input: Command,
		action: () => Promise<T>,
		recover?: () => Promise<void>,
	): Promise<T> {
		return this.exclusive(async () => {
			const key = `${namespace}:${text(input.idempotency_key, "幂等键")}`;
			const prior = this.store.command<T>(key, input);
			if (prior !== undefined) {
				// 幂等回执不重新写控制事件，但跨账本的未完成副作用仍需按当前状态补齐。
				await recover?.();
				return prior;
			}
			this.store.beginCommand(key, input);
			this.activeCommand = { key, input };
			try {
				const result = await action();
				this.store.finishCommand(key, input, result);
				return result;
			} finally {
				this.activeCommand = undefined;
			}
		});
	}
	private commitResult<T>(work: () => T): T {
		const command = this.activeCommand;
		if (!command) throw new Error("missing_command_scope");
		return this.store.transaction(() => {
			const result = work();
			this.store.finishCommand(command.key, command.input, result);
			return result;
		});
	}
	private require<T>(kind: string, id: string): Stored<T> {
		const record = this.store.get<T>(kind, id);
		if (!record) throw new RuntimeError("not_found", "记录不存在", 404);
		return record;
	}
	dataset(id: string): DatasetVersion {
		return this.store.readArtifact<DatasetVersion>(this.require<DatasetRegistration>("dataset", id).data.artifact_id);
	}
	async importDataset(input: Command) {
		return this.command("import_dataset", input, async () => {
			this.store.assertCapacity();
			const dataset =
				typeof input.path === "string"
					? await loadBenchmarkDataset(resolve(input.path))
					: parseDataset({
							questionsJsonl: text(input.questions_jsonl, "公共问题", undefined, 8_000_000),
							goldJsonl: text(input.gold_jsonl, "标准答案", undefined, 8_000_000),
							name: typeof input.name === "string" ? input.name : undefined,
							logicalRelations: Array.isArray(input.logical_relations) ? input.logical_relations : undefined,
						});
			let sources: Source[] = [];
			if (typeof input.path === "string" && existsSync(resolve(input.path, "sources.fragment.json"))) {
				const entries: unknown = JSON.parse(await readFile(resolve(input.path, "sources.fragment.json"), "utf8"));
				if (!Array.isArray(entries)) throw new RuntimeError("invalid_source", "数据源清单必须为数组", 400);
				sources = entries.map((entry) => {
					const source = object(entry);
					const directory = resolve(String(input.path));
					return {
						id: text(source.id, "数据源标识"),
						name: text(source.name, "数据源名称"),
						path: resolve(directory, text(source.path, "数据库路径")),
						...(typeof source.dictionary_path === "string"
							? { dictionary_path: resolve(directory, source.dictionary_path) }
							: {}),
						...(typeof source.knowledge_path === "string"
							? { knowledge_path: resolve(directory, source.knowledge_path) }
							: {}),
					};
				});
			}
			const artifact_id = this.store.artifact(dataset, "private_dataset", `dataset:${dataset.id}`);
			const summary = publicDataset(dataset);
			return this.commitResult(() => {
				this.store.immutable("dataset", dataset.id, { artifact_id, summary, sources });
				return summary;
			});
		});
	}
	async createVariant(input: Command) {
		return this.command("variant", input, async () => {
			const model = object(input.model_profile ?? {});
			const decision_model = text(model.decision_model, "决策模型", this.app.config.decisionModel);
			if (!decision_model.toLowerCase().includes("deepseek"))
				throw new RuntimeError("invalid_model", "决策模型使用 DeepSeek 系列", 400);
			const strategy = input.retrieval_strategy ?? this.app.config.retrievalStrategy ?? "progressive";
			if (!["full_catalog", "lexical", "progressive"].includes(String(strategy)))
				throw new RuntimeError("unregistered_strategy", "检索策略尚未登记", 400);
			const repair_limit = integer(input.repair_limit, 1, 0, 2);
			const repair_policy = input.repair_policy ?? (repair_limit === 0 ? "off" : "targeted");
			if (!["off", "targeted", "ordinary_retry"].includes(String(repair_policy)))
				throw new RuntimeError("invalid_repair_policy", "修复策略未登记", 400);
			if ((repair_policy === "off") !== (repair_limit === 0))
				throw new RuntimeError("invalid_repair_policy", "关闭修复时次数必须为零", 400);
			const data = {
				name: text(input.name, "方案名称"),
				model_profile: {
					decision_model,
					answer_model: text(model.answer_model, "答案模型", this.app.config.answerModel),
					resource_scope_id: this.app.config.resourceScopeId ?? "primary-account",
				},
				repair_limit,
				repair_policy: repair_policy as Variant["repair_policy"],
				model_call_limit: integer(input.model_call_limit, 8, 1, 32),
				retrieval_strategy: strategy as Variant["retrieval_strategy"],
				// 检索预算随方案冻结，不能在同一实验中使用后来修改的默认值。
				retrieval_max_context_chars: integer(
					input.retrieval_max_context_chars,
					this.app.config.retrievalMaxContextChars ?? 256000,
					1000,
					1000000,
				),
				// 显式选择对照策略时按其默认值冻结，避免继承渐进方案的五表预算。
				retrieval_top_k: integer(
					input.retrieval_top_k,
					strategy === (this.app.config.retrievalStrategy ?? "progressive")
						? (this.app.config.retrievalTopK ?? defaultRetrievalTopK(String(strategy)))
						: defaultRetrievalTopK(String(strategy)),
					1,
					100,
				),
			};
			const hash = fingerprint(data);
			const variant: Variant = { id: `variant-${hash}`, hash, ...data };
			return this.commitResult(() => this.store.immutable("variant", variant.id, variant).data);
		});
	}
	async createExperiment(input: Command) {
		return this.command("experiment", input, async () => {
			this.store.assertCapacity();
			if (input.quality_policy != null) {
				const validation = validateQualityPolicy(input.quality_policy);
				if (!validation.valid) throw new RuntimeError("invalid_quality_policy", validation.errors.join(", "), 400);
			}
			const dataset = this.dataset(text(input.dataset_id, "数据集"));
			const variant_ids = strings(input.variant_ids, "方案");
			for (const id of variant_ids) this.require<Variant>("variant", id);
			const repeats = integer(input.repeats, 1, 1, 100);
			const case_ids =
				input.case_ids === undefined ? dataset.cases.map((sample) => sample.id) : strings(input.case_ids, "问题");
			if (case_ids.some((id) => !dataset.cases.some((sample) => sample.id === id)))
				throw new RuntimeError("invalid_case", "题目不属于所选数据集", 400);
			if (case_ids.length * repeats * variant_ids.length > 10000)
				throw new RuntimeError("matrix_too_large", "单实验最多 10000 槽，请按独立实验拆分", 400);
			const registration = this.require<DatasetRegistration>("dataset", dataset.id).data;
			const snapshots: Record<string, SourceSnapshot> = {};
			for (const sourceId of new Set(
				dataset.cases.filter((sample) => case_ids.includes(sample.id)).map((sample) => sample.source_id),
			)) {
				const source =
					registration.sources.find((entry) => entry.id === sourceId) ?? (await this.app.domain.source(sourceId));
				snapshots[sourceId] = await freezeSource(source, this.store.root);
			}
			const id = randomUUID();
			const experiment: Experiment = {
				id,
				name: text(input.name, "实验名称"),
				dataset_id: dataset.id,
				variant_ids,
				repeats,
				status: "running",
				case_ids,
				snapshots,
				execution_hash: this.codeHash,
				runtime_configuration: runtimeConfiguration(this.app.config),
				quality_policy:
					input.quality_policy && typeof input.quality_policy === "object" ? object(input.quality_policy) : null,
				concurrency: integer(input.concurrency, 5, 1, 10),
				created_at: Date.now(),
				...(typeof input.origin_experiment_id === "string" ? { origin_experiment_id: input.origin_experiment_id } : {}),
			};
			if (input.comparison_protocol != null)
				experiment.comparison_protocol = this.freezeProtocol(input.comparison_protocol, experiment);
			if (input.reply_scripts != null) {
				experiment.reply_scripts = {};
				for (const [caseId, replies] of Object.entries(object(input.reply_scripts))) {
					if (!case_ids.includes(caseId) || !Array.isArray(replies) || replies.length > 10)
						throw new RuntimeError("invalid_script", "回复脚本需关联已选问题，最多十轮", 400);
					experiment.reply_scripts[caseId] = replies.map((reply) => text(reply, "脚本回复"));
				}
			}
			// 一次事务登记完整矩阵、幂等回执与请求身份；网络调用只在提交之后发生。
			return this.commitResult(() => {
				this.store.put("experiment", id, experiment, 0);
				this.store.refArtifact(registration.artifact_id, `experiment:${id}`);
				let ordinal = 0;
				for (let repeat = 0; repeat < repeats; repeat++)
					for (const sample of dataset.cases.filter((item) => case_ids.includes(item.id))) {
						// 交错方案顺序降低时间漂移，顺序随槽位冻结，恢复时不再洗牌。
						const offset = (repeat + ordinal) % variant_ids.length;
						for (let index = 0; index < variant_ids.length; index++) {
							const variant_id = variant_ids[(index + offset) % variant_ids.length];
							const slotId = fingerprint([id, sample.id, variant_id, repeat, snapshots[sample.source_id].id]);
							this.store.addSlot({
								id: slotId,
								experiment_id: id,
								case_id: sample.id,
								variant_id,
								repeat_index: repeat,
								snapshot_id: snapshots[sample.source_id].id,
								ordinal: ordinal++,
								status: "planned",
								request_id: `eval-${slotId}`,
								execution_id: randomUUID(),
								conversation_id: `eval-${slotId}`,
								updated_at: Date.now(),
							});
						}
					}
				this.store.event(id, id, "experiment_frozen", {
					slot_count: ordinal,
					execution_hash: experiment.execution_hash,
				});
				return this.experiment(id);
			});
		});
	}
	private freezeProtocol(value: unknown, experiment: Experiment): ComparisonProtocol {
		const raw = object(value);
		const arms = Array.isArray(raw.arms) ? raw.arms.map((entry) => object(entry)) : [];
		if (
			arms.length !== 3 ||
			new Set(arms.map((arm) => arm.kind)).size !== 3 ||
			new Set(arms.map((arm) => arm.variant_id)).size !== 3 ||
			arms.some(
				(arm) =>
					!experiment.variant_ids.includes(String(arm.variant_id)) ||
					!["repair_off", "repair_on", "ordinary_retry"].includes(String(arm.kind)),
			)
		)
			throw new RuntimeError("invalid_comparison_protocol", "严格比较需要三个不同且已选择的修复对照方案", 400);
		const allowed = Array.isArray(raw.allowed_differences)
			? raw.allowed_differences.map((entry) => {
					const item = object(entry);
					return { path: text(item.path, "差异字段"), values: Array.isArray(item.values) ? item.values : [] };
				})
			: [];
		const bundles = Object.fromEntries(
			experiment.variant_ids.map((id) => {
				const { id: _id, hash: _hash, name: _name, ...variant } = this.require<Variant>("variant", id).data;
				return [
					id,
					{
						...variant,
						dataset_hash: this.dataset(experiment.dataset_id).hash,
						execution_hash: experiment.execution_hash,
						source_versions: Object.fromEntries(
							Object.entries(experiment.snapshots).map(([source, snapshot]) => [source, snapshot.source_version]),
						),
						actual_model_revision: "unverified",
					},
				];
			}),
		);
		const protocol: ComparisonProtocol = {
			arms: arms as ComparisonProtocol["arms"],
			allowed_differences: allowed,
			bundles,
			required_verified_paths: [
				...new Set([
					"actual_model_revision",
					...(Array.isArray(raw.required_verified_paths) ? strings(raw.required_verified_paths, "核验字段") : []),
				]),
			],
			equal_budget_paths: [
				...new Set([
					"model_call_limit",
					...(Array.isArray(raw.equal_budget_paths) ? strings(raw.equal_budget_paths, "等预算字段") : []),
				]),
			],
			bootstrap_repetitions: integer(raw.bootstrap_repetitions, 1000, 20, 10000),
			bootstrap_seed: integer(raw.bootstrap_seed, 20261019, 0, 4294967295),
		};
		const validation = checkComparability(bundles, allowed);
		if (!validation.comparable) throw new RuntimeError("unregistered_difference", validation.errors.join(", "), 400);
		for (const arm of protocol.arms) {
			const policy = this.require<Variant>("variant", arm.variant_id).data.repair_policy;
			if (
				policy !== ({ repair_off: "off", repair_on: "targeted", ordinary_retry: "ordinary_retry" } as const)[arm.kind]
			)
				throw new RuntimeError("arm_policy_mismatch", "对照组类型必须符合实际修复策略", 400);
		}
		return protocol;
	}
	experiment(id: string) {
		const record = this.require<Experiment>("experiment", id);
		const counts = this.store.counts(id);
		const planned = Object.values(counts).reduce((a, b) => a + b, 0);
		const scoreId = record.data.latest_score_set_id;
		const latest = scoreId ? this.store.get<ScoredRun>("score_set", scoreId)?.data : undefined;
		const score_set_applicability = scoreId
			? latest
				? (this.store.get<{ status: string }>("applicability", scoreId)?.data.status ?? "current")
				: "missing"
			: null;
		// 已裁定或证据删除的旧评分可追溯，但不能充当当前口径的准确率。
		const summary = scoreSummary(score_set_applicability === "current" ? latest?.scores : undefined, planned);
		const progress = {
			planned,
			pending: counts.planned ?? 0,
			queued: counts.queued ?? 0,
			running: counts.running ?? 0,
			waiting_for_user: counts.waiting_for_user ?? 0,
			reconciliation_required: counts.reconciliation_required ?? 0,
			completed: counts.completed ?? 0,
			blocked: counts.blocked ?? 0,
			failed: counts.failed ?? 0,
			cancelled: counts.cancelled ?? 0,
			interrupted: counts.interrupted ?? 0,
			scored: this.store.scoredCount(id),
		};
		return { ...record.data, revision: record.revision, progress, ...summary, score_set_applicability };
	}
	// 筛选从实验全集开始，分页发生在最后；结果生成模型对应实际 answer_model。
	listExperiments(page = 1, pageSize = 50, query = "", datasetId = "", model = "") {
		const needle = query.trim().toLocaleLowerCase();
		const modelNeedle = model.trim().toLocaleLowerCase();
		const variants = new Map<string, Variant | undefined>();
		const matchesModel = (id: string) => {
			if (!variants.has(id)) variants.set(id, this.store.get<Variant>("variant", id)?.data);
			return variants.get(id)?.model_profile.answer_model.toLocaleLowerCase().includes(modelNeedle) ?? false;
		};
		const all = this.store.all<Experiment>("experiment");
		const running_total = all.filter((record) =>
			["running", "pausing", "cancelling"].includes(record.data.status),
		).length;
		const records = all
			.filter(
				(record) =>
					(!needle || `${record.id} ${record.data.name}`.toLocaleLowerCase().includes(needle)) &&
					(!datasetId || record.data.dataset_id === datasetId) &&
					(!modelNeedle || record.data.variant_ids.some(matchesModel)),
			)
			.sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id));
		return {
			items: records.slice((page - 1) * pageSize, page * pageSize).map((record) => this.experiment(record.id)),
			total: records.length,
			running_total,
			page,
			page_size: pageSize,
		};
	}
	list(kind: string, page = 1, pageSize = 50, filter?: { field: string; value: string }) {
		const allowed = new Set([
			"dataset",
			"variant",
			"experiment",
			"score_set",
			"score_job",
			"comparison",
			"adjudication",
			"release_decision",
			"activation",
		]);
		if (!allowed.has(kind)) throw new RuntimeError("not_found", "集合不存在", 404);
		if (filter && !["experiment_id", "release_decision_id"].includes(filter.field))
			throw new RuntimeError("invalid_filter", "过滤字段无效", 400);
		const where = filter ? " AND json_extract(body,?)=?" : "";
		const parameters = filter ? [kind, `$.${filter.field}`, filter.value] : [kind];
		const total = Number(
			this.store.db.prepare(`SELECT COUNT(*) AS count FROM objects WHERE kind=?${where}`).get(...parameters)!.count,
		);
		const rows = this.store.db
			.prepare(`SELECT id FROM objects WHERE kind=?${where} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`)
			.all(...parameters, pageSize, (page - 1) * pageSize);
		const items = rows.map((row) => {
			const id = String(row.id);
			if (kind === "experiment") return this.experiment(id);
			const record = this.require<Record<string, unknown>>(kind, id);
			return kind === "dataset" ? record.data.summary : { ...record.data, revision: record.revision };
		});
		return { items, total, page, page_size: pageSize };
	}
	// 槽位存储单次限取一万条；游标遍历保证大评测的筛选和统计覆盖全部题次。
	private *experimentSlots(id: string): IterableIterator<SlotRecord> {
		let after = -1;
		while (true) {
			const batch = this.store.slots(id, after, 10000);
			for (const slot of batch) yield slot;
			if (batch.length < 10000) return;
			after = batch[batch.length - 1].ordinal;
		}
	}
	slots(id: string, page = 1, pageSize = 50, status?: string, query?: string) {
		this.require("experiment", id);
		const where = `${status ? " AND status=?" : ""}${query ? " AND (json_extract(body,'$.case_id') LIKE ? ESCAPE '\\' OR json_extract(body,'$.variant_id') LIKE ? ESCAPE '\\')" : ""}`,
			parameters = status ? [id, status] : [id];
		if (query) {
			const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
			parameters.push(pattern, pattern);
		}
		const total = Number(
			this.store.db.prepare(`SELECT COUNT(*) AS count FROM slots WHERE experiment_id=?${where}`).get(...parameters)!
				.count,
		);
		const rows = this.store.db
			.prepare(`SELECT body FROM slots WHERE experiment_id=?${where} ORDER BY ordinal LIMIT ? OFFSET ?`)
			.all(...parameters, pageSize, (page - 1) * pageSize);
		return { items: rows.map((row) => JSON.parse(String(row.body)) as SlotRecord), total, page, page_size: pageSize };
	}
	// 逐题先用完整槽位与最新有效评分过滤，再分页；只读取当前页的执行观察计算耗时。
	questions(id: string, page = 1, pageSize = 50, verdict = "all", query = "") {
		if (!["all", "pass", "fail", "unknown", "unscored"].includes(verdict))
			throw new RuntimeError("invalid_verdict", "逐题判定筛选无效", 400);
		const experiment = this.require<Experiment>("experiment", id).data;
		const dataset = this.require<DatasetRegistration>("dataset", experiment.dataset_id).data.summary;
		const questions = new Map(dataset.cases.map((sample) => [sample.id, sample.question]));
		const scoreId = experiment.latest_score_set_id;
		const scoreSet =
			scoreId && !this.store.get("applicability", scoreId)
				? this.store.get<ScoredRun>("score_set", scoreId)?.data
				: undefined;
		const scores = new Map((scoreSet?.scores ?? []).map((score) => [score.slot_id, score]));
		const needle = query.trim().toLocaleLowerCase();
		const selected: SlotRecord[] = [];
		let total = 0;
		const start = (page - 1) * pageSize;
		for (const slot of this.experimentSlots(id)) {
			const matchesVerdict = verdict === "all" || verdictFor(scores.get(slot.id)) === verdict;
			const matchesQuery =
				!needle ||
				[slot.case_id, slot.id, slot.variant_id, questions.get(slot.case_id) ?? ""].some((value) =>
					value.toLocaleLowerCase().includes(needle),
				);
			if (!matchesVerdict || !matchesQuery) continue;
			if (total >= start && total < start + pageSize) selected.push(slot);
			total++;
		}
		const items = selected.map((slot) => {
			const score = scores.get(slot.id);
			const error_categories = (score?.checks ?? [])
				.filter((check) => check.status === "fail" && check.evaluation_status === "valid")
				.map((check) => ({ check_id: check.check_id, reason_code: check.reason_code }));
			let duration_ms: number | null = null;
			let runtime_error_code: string | null = null;
			if (slot.artifact_id) {
				try {
					const observation = this.store.readArtifact<QueryTask>(slot.artifact_id);
					duration_ms = observationDuration(observation);
					runtime_error_code = observation.error?.code ?? null;
				} catch {
					// 原始产物已删除或不可读时，缺失不能被槽位更新时间伪装成运行耗时。
				}
			}
			return {
				...slot,
				question: questions.get(slot.case_id) ?? null,
				verdict: verdictFor(score),
				score_status: score?.status ?? null,
				evaluation_status: score?.evaluation_status ?? null,
				duration_ms,
				error_categories,
				error_category: error_categories[0]?.reason_code ?? runtime_error_code,
				runtime_error_code,
			};
		});
		return { items, total, page, page_size: pageSize };
	}
	// 汇总只聚合已保存的观察和检查；每个失败标签是检查事实，不宣称因果根因。
	overview(id: string) {
		const experiment = this.experiment(id);
		const scoreId = experiment.score_set_applicability === "current" ? experiment.latest_score_set_id : undefined;
		const scoreSet = scoreId ? this.store.get<ScoredRun>("score_set", scoreId)?.data : undefined;
		const durations: number[] = [];
		const stages = new Map<string, { kind: string; label: string; values: number[]; missing: number }>();
		let total = 0;
		let observations = 0;
		let missing_artifacts = 0;
		let unreadable_artifacts = 0;
		for (const slot of this.experimentSlots(id)) {
			total++;
			if (!slot.artifact_id) {
				missing_artifacts++;
				continue;
			}
			let task: QueryTask;
			try {
				task = this.store.readArtifact<QueryTask>(slot.artifact_id);
			} catch {
				unreadable_artifacts++;
				continue;
			}
			observations++;
			const elapsed = observationDuration(task);
			if (elapsed !== null) durations.push(elapsed);
			const result = object(task.result ?? {});
			const progress = object(task.progress ?? {});
			const rawStages = Array.isArray(result.stages)
				? result.stages
				: Array.isArray(progress.stages)
					? progress.stages
					: [];
			for (const raw of rawStages) {
				const stage = object(raw);
				if (typeof stage.kind !== "string" || typeof stage.label !== "string") continue;
				const key = JSON.stringify([stage.kind, stage.label]);
				if (!stages.has(key)) stages.set(key, { kind: stage.kind, label: stage.label, values: [], missing: 0 });
				const group = stages.get(key)!;
				if (typeof stage.duration_ms === "number" && Number.isFinite(stage.duration_ms) && stage.duration_ms >= 0)
					group.values.push(stage.duration_ms);
				else group.missing++;
			}
		}
		const failures = new Map<string, { check_id: string; reason_code: string; count: number }>();
		for (const score of scoreSet?.scores ?? [])
			for (const check of score.checks)
				if (check.status === "fail" && check.evaluation_status === "valid") {
					const key = JSON.stringify([check.check_id, check.reason_code]);
					const prior = failures.get(key);
					if (prior) prior.count++;
					else failures.set(key, { check_id: check.check_id, reason_code: check.reason_code, count: 1 });
				}
		return {
			experiment_id: id,
			score_set_id: experiment.latest_score_set_id ?? null,
			score_set_applicability: experiment.score_set_applicability,
			total,
			verdicts: experiment.verdicts,
			accuracy: experiment.accuracy,
			duration_ms: {
				count: durations.length,
				p50_ms: durationPercentile(durations, 0.5),
				p95_ms: durationPercentile(durations, 0.95),
				missing: total - durations.length,
			},
			stage_durations: [...stages.values()]
				.map((group) => ({
					kind: group.kind,
					label: group.label,
					count: group.values.length,
					p50_ms: durationPercentile(group.values, 0.5),
					p90_ms: durationPercentile(group.values, 0.9),
					p95_ms: durationPercentile(group.values, 0.95),
					max_ms: group.values.length ? group.values.reduce((max, value) => Math.max(max, value), 0) : null,
					missing: group.missing,
				}))
				.sort((left, right) => left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label)),
			failure_reasons: [...failures.values()].sort(
				(left, right) =>
					right.count - left.count ||
					left.check_id.localeCompare(right.check_id) ||
					left.reason_code.localeCompare(right.reason_code),
			),
			evidence: { observations, missing_artifacts, unreadable_artifacts },
		};
	}
	async slot(id: string) {
		const slot = this.store.slot(id);
		if (!slot) throw new RuntimeError("not_found", "槽位不存在", 404);
		const task = slot.turn_id ? await this.app.runtime.get(slot.turn_id) : undefined;
		let observation = task;
		let observation_status = task ? "runtime_only" : "missing";
		if (slot.artifact_id) {
			try {
				observation = this.store.readArtifact<QueryTask>(slot.artifact_id);
				observation_status = "available";
			} catch {
				observation = undefined;
				observation_status = "unreadable";
			}
		}
		const experiment = this.require<Experiment>("experiment", slot.experiment_id).data;
		const goldDatasetId = experiment.scoring_dataset_id ?? experiment.dataset_id;
		let gold: Record<string, unknown> | null = null;
		try {
			gold = this.dataset(goldDatasetId).cases.find((sample) => sample.id === slot.case_id)?.gold ?? null;
		} catch {
			// gold 产物缺失或已删除时仅标记缺失，不能回退成其他数据集的旧答案。
		}
		const score_sets = this.store
			.all<Record<string, unknown>>("score_set")
			.filter((score) => score.data.experiment_id === slot.experiment_id)
			.map((score) => score.data);
		return {
			...slot,
			gold,
			gold_dataset_id: goldDatasetId,
			observation_status,
			observation,
			turn: observation ? publicTurn(observation) : null,
			attempts: [
				{
					id: slot.execution_id,
					status: slot.status,
					operations: slot.turn_id ? await this.app.runtime.listOperations(slot.turn_id) : [],
					artifacts: slot.artifact_id ? [{ id: slot.artifact_id, kind: "observation" }] : [],
					events: this.store.events(slot.experiment_id).filter((event) => event.entity_id === slot.id),
				},
			],
			score_sets,
		};
	}
	async control(id: string, input: Command) {
		if (input.command === "fork_retry") {
			return this.command(`fork_retry:${id}`, input, async () => {
				const original = this.require<Experiment>("experiment", id);
				if (input.expected_revision !== original.revision)
					throw new RuntimeError("revision_conflict", "实验已改变，请刷新");
				const failed = this.store
					.slots(id, -1, 10000)
					.filter((slot) => ["failed", "interrupted", "reconciliation_required", "cancelled"].includes(slot.status));
				if (!failed.length) throw new RuntimeError("nothing_to_retry", "没有可派生重跑的槽位");
				for (const slot of failed)
					if (
						slot.turn_id &&
						(await this.app.runtime.listOperations(slot.turn_id)).some(
							(operation) => operation.status === "unknown" && !operation.reservationReleased,
						)
					)
						throw new RuntimeError("reconciliation_required", "请先处置未知调用，再显式创建续跑");
				if (original.data.execution_hash !== this.codeHash)
					throw new RuntimeError("execution_version_changed", "续跑必须使用原执行代码；版本改变时请创建独立实验");
				const childId = randomUUID();
				const { latest_score_set_id: _score, comparison_protocol: _protocol, ...base } = original.data;
				const child: Experiment = {
					...base,
					id: childId,
					name: `${base.name} · 续跑`,
					status: "running",
					case_ids: [...new Set(failed.map((slot) => slot.case_id))],
					origin_experiment_id: id,
					created_at: Date.now(),
				};
				return this.commitResult(() => {
					this.store.put("experiment", childId, child, 0);
					this.store.refArtifact(
						this.require<DatasetRegistration>("dataset", child.dataset_id).data.artifact_id,
						`experiment:${childId}`,
					);
					for (const [ordinal, parent] of failed.entries()) {
						const slotId = fingerprint([childId, parent.id]);
						this.store.addSlot({
							id: slotId,
							experiment_id: childId,
							case_id: parent.case_id,
							variant_id: parent.variant_id,
							repeat_index: parent.repeat_index,
							snapshot_id: parent.snapshot_id,
							ordinal,
							status: "planned",
							request_id: `eval-${slotId}`,
							execution_id: randomUUID(),
							conversation_id: `eval-${slotId}`,
							origin_slot_id: parent.id,
							updated_at: Date.now(),
						});
					}
					this.store.event(childId, childId, "explicit_continuation", {
						origin_experiment_id: id,
						origin_slots: failed.map((slot) => slot.id),
						causal_eligible: false,
					});
					return this.experiment(childId);
				});
			});
		}
		return this.command(
			`control:${id}`,
			input,
			async () => {
				const record = this.require<Experiment>("experiment", id);
				if (input.expected_revision !== record.revision)
					throw new RuntimeError("revision_conflict", "实验已改变，请刷新");
				const experiment = record.data;
				if (input.command === "pause" && experiment.status === "running") experiment.status = "pausing";
				else if (input.command === "resume" && ["paused", "pausing"].includes(experiment.status))
					experiment.status = "running";
				else if (input.command === "cancel" && !["cancelled", "completed"].includes(experiment.status))
					experiment.status = "cancelling";
				else throw new RuntimeError("invalid_transition", "当前状态不能执行该命令");
				const result = this.commitResult(() => {
					this.store.put("experiment", id, experiment, record.revision);
					this.store.event(id, id, String(input.command), { actor: input.actor ?? "local-user" });
					return this.experiment(id);
				});
				await this.recoverControl(id);
				return result;
			},
			() => this.recoverControl(id),
		);
	}
	private schedule() {
		if (this.closed) return;
		this.timer = setTimeout(() => {
			this.pumping = this.tick()
				.catch((error) => {
					this.store.event("coordinator", "evaluation", "pump_error", {
						message: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => {
					this.pumping = undefined;
					this.schedule();
				});
		}, 250);
		this.timer.unref();
	}
	async tick() {
		const all = this.store.all<Experiment>("experiment");
		for (const record of all) {
			if (!["completed", "incomplete", "cancelled"].includes(record.data.status) || this.scoring.has(record.id))
				continue;
			const latest = record.data.latest_score_set_id
				? this.require<ScoredRun>("score_set", record.data.latest_score_set_id).data
				: undefined;
			// 裁定可与旧评分并行：按目标口径重排评分，旧 job 不得吞掉新口径的持久意图。
			const datasetId = record.data.scoring_dataset_id ?? record.data.dataset_id;
			const invalidated = latest
				? this.store.get<{ status: string }>("applicability", latest.id)?.data.status
				: undefined;
			if (!latest || invalidated === "regrade_required") {
				await this.grade(record.id, {
					idempotency_key: `automatic-score:${datasetId}:${this.codeHash}:${record.revision}`,
					expected_revision: record.revision,
				});
			}
		}
		const records = all.filter((item) => !["completed", "cancelled", "incomplete"].includes(item.data.status));
		if (!records.length) return;
		const offset = this.roundRobin++ % records.length;
		for (let index = 0; index < records.length; index++) {
			const current = this.require<Experiment>("experiment", records[(index + offset) % records.length].id);
			const experiment = current.data;
			if (experiment.status === "cancelling") {
				await this.app.runtime.cancelExperiment(experiment.id);
				for (const slot of this.store.slots(experiment.id, -1, 10000, ["planned"]))
					this.store.updateSlot({ ...slot, status: "cancelled" });
			}
			await this.refresh(experiment);
			if (experiment.status !== "running") continue;
			const counts = this.store.counts(experiment.id);
			if ((counts.queued ?? 0) + (counts.running ?? 0) >= experiment.concurrency) continue;
			const planned = this.store.slots(experiment.id, -1, 1, ["planned"])[0];
			if (!planned) continue;
			try {
				await this.dispatch(experiment, planned);
			} catch (error) {
				if (error instanceof RuntimeError && ["queue_full", "storage_capacity_exhausted"].includes(error.code))
					continue;
				planned.status = "failed";
				planned.error = error instanceof Error ? error.message : String(error);
				this.store.updateSlot(planned);
				this.store.event(experiment.id, planned.id, "dispatch_failed", { error: planned.error });
			}
		}
	}
	private async dispatch(experiment: Experiment, slot: SlotRecord) {
		this.store.assertCapacity();
		if (
			!experiment.runtime_configuration ||
			fingerprint(experiment.runtime_configuration) !== fingerprint(runtimeConfiguration(this.app.config))
		)
			throw new RuntimeError("runtime_configuration_changed", "模型端点或运行预算已变化，请创建新实验");
		if (experiment.execution_hash !== (await executionFingerprint()))
			throw new RuntimeError("execution_version_changed", "执行代码已改变，停止原版本派发；请派生新实验");
		if (this.require<Experiment>("experiment", experiment.id).data.status !== "running") return;
		const sample = this.dataset(experiment.dataset_id).cases.find((item) => item.id === slot.case_id)!;
		const variant = this.require<Variant>("variant", slot.variant_id).data;
		const snapshot = experiment.snapshots[sample.source_id];
		const execution_context = JSON.parse(
			JSON.stringify({
				experiment_id: experiment.id,
				variant_id: variant.id,
				slot_id: slot.id,
				execution_id: slot.execution_id,
				model_profile: variant.model_profile,
				repair_limit: variant.repair_limit,
				repair_policy: variant.repair_policy,
				model_call_limit: variant.model_call_limit,
				retrieval_strategy: variant.retrieval_strategy,
				retrieval_max_context_chars: variant.retrieval_max_context_chars ?? 256000,
				retrieval_top_k: variant.retrieval_top_k ?? defaultRetrievalTopK(variant.retrieval_strategy),
				source_snapshot: snapshot.source,
				source_version: snapshot.source_version,
			}),
		) as JsonObject;
		// 请求身份在矩阵冻结时已落盘；接收后失去回包时仍以同一身份向 Pi 查询/重取。
		const task = await this.app.query({
			conversation_id: slot.conversation_id,
			source_id: sample.source_id,
			question: sample.question,
			as_of: sample.as_of,
			request_id: slot.request_id,
			mode: "eval",
			execution_context,
		});
		slot.turn_id = task.id;
		slot.status = task.status;
		slot.updated_at = task.updatedAt;
		this.store.transaction(() => {
			this.store.updateSlot(slot);
			this.store.event(experiment.id, slot.id, "dispatched", { turn_id: task.id, request_id: slot.request_id });
		});
	}
	private async refresh(experiment: Experiment) {
		for (const slot of this.store
			.slots(experiment.id, -1, 10000)
			.filter((slot) => !slot.artifact_id || ["queued", "running", "waiting_for_user"].includes(slot.status))) {
			if (!slot.turn_id) continue;
			const task = await this.app.runtime.get(slot.turn_id);
			if (!task) {
				slot.status = "interrupted";
				slot.error = "业务任务记录缺失";
				this.store.updateSlot(slot);
				continue;
			}
			const script = experiment.reply_scripts?.[slot.case_id] ?? [];
			if (
				experiment.status === "running" &&
				task.status === "waiting_for_user" &&
				task.clarification &&
				task.replies.length < script.length
			) {
				// 脚本是开跑前冻结的普通用户回答，不按私有标准答案临时生成。
				await this.app.runtime.reply({
					turnId: task.id,
					submissionId: `${slot.request_id}-reply-${task.replies.length}`,
					clarificationId: task.clarification.id,
					revision: task.clarification.revision,
					answer: script[task.replies.length],
				});
				this.store.updateSlot({ ...slot, status: "queued", artifact_id: undefined });
				continue;
			}
			if (
				slot.status === task.status &&
				slot.updated_at === task.updatedAt &&
				(["queued", "running"].includes(task.status) || slot.artifact_id)
			)
				continue;
			slot.status = task.status;
			slot.updated_at = task.updatedAt;
			if (!["queued", "running"].includes(task.status))
				slot.artifact_id = this.store.artifact(task, "observation", `experiment:${experiment.id}`);
			this.store.transaction(() => {
				this.store.updateSlot(slot);
				this.store.event(experiment.id, slot.id, "observation", {
					status: slot.status,
					artifact_id: slot.artifact_id ?? null,
					phase: object(task.progress ?? {}).phase ?? null,
				});
			});
		}
		const counts = this.store.counts(experiment.id);
		const active = counts.running ?? 0;
		// 单轮澄清本身是已观察的行动；脚本耗尽后封存它，不能让正确追问永久挂住整场。
		const remaining = (counts.planned ?? 0) + (counts.queued ?? 0) + active;
		let status = experiment.status;
		if (status === "pausing" && !active) status = "paused";
		if (status === "cancelling" && !active && !(counts.queued ?? 0)) status = "cancelled";
		else if (status === "running" && remaining === 0)
			status = counts.reconciliation_required || counts.interrupted ? "incomplete" : "completed";
		if (status !== experiment.status) {
			const record = this.require<Experiment>("experiment", experiment.id);
			// 控制命令可能在等待业务回执时到达，绝不以旧快照覆盖用户新意图。
			if (record.data.status === experiment.status) {
				experiment.status = status;
				this.store.put("experiment", experiment.id, { ...record.data, status }, record.revision);
				this.store.event(experiment.id, experiment.id, "state", { status });
			}
		}
	}
	async grade(id: string, input: Command) {
		return this.command(`grade:${id}`, input, async () => {
			if ((await executionFingerprint()) !== this.codeHash)
				throw new RuntimeError("scorer_version_changed", "评分代码已改变，请重启控制端后登记新评分版本");
			const experiment = this.require<Experiment>("experiment", id);
			if (input.expected_revision !== experiment.revision)
				throw new RuntimeError("revision_conflict", "实验版本已改变");
			if ([...this.scoring.keys()].includes(id)) throw new RuntimeError("scoring_active", "该实验正在评分");
			if (!["completed", "incomplete", "cancelled"].includes(experiment.data.status))
				throw new RuntimeError("experiment_active", "请在实验结束后评分，避免观察集在评分期间变化");
			const jobId = randomUUID();
			const result = this.commitResult(() => {
				this.store.put(
					"score_job",
					jobId,
					{
						id: jobId,
						experiment_id: id,
						experiment: experiment.data,
						execution_hash: this.codeHash,
						status: "running",
						created_at: Date.now(),
					},
					0,
				);
				return { id: jobId, experiment_id: id, status: "running" };
			});
			this.startGrade(experiment.data, jobId);
			return result;
		});
	}
	private startGrade(experiment: Experiment, jobId: string) {
		const controller = new AbortController();
		// 评分由独立进程完成；只有全部结果写入后才发布不可变的评分版本。
		const promise = this.performGrade(experiment, jobId, controller.signal)
			.catch((error) => {
				const job = this.require<Record<string, unknown>>("score_job", jobId);
				this.store.put(
					"score_job",
					jobId,
					{ ...job.data, status: this.closed ? "running" : "failed", error: String(error) },
					job.revision,
				);
				this.store.event(experiment.id, jobId, "scoring_failed", { error: String(error) });
			})
			.finally(() => this.scoring.delete(experiment.id));
		this.scoring.set(experiment.id, { promise, controller });
	}
	private async performGrade(experiment: Experiment, jobId: string, signal: AbortSignal) {
		if ((await executionFingerprint()) !== this.codeHash)
			throw new RuntimeError("scorer_version_changed", "评分前版本不一致");
		const dataset = this.dataset(experiment.scoring_dataset_id ?? experiment.dataset_id);
		const slots = this.store.slots(experiment.id, -1, 10000);
		const observations = new Map<string, QueryTask>();
		const catalogs = new Map<string, unknown>();
		const jobs: ScoreJob[] = [];
		const observation_ids: string[] = [];
		for (const slot of slots) {
			if (!slot.artifact_id) continue;
			const sample = dataset.cases.find((item) => item.id === slot.case_id)!;
			const turn = this.store.readArtifact<QueryTask>(slot.artifact_id);
			observations.set(slot.id, turn);
			observation_ids.push(slot.artifact_id);
			if (!catalogs.has(sample.source_id))
				catalogs.set(
					sample.source_id,
					(await this.app.domain.call(experiment.snapshots[sample.source_id].source, "catalog", signal)).catalog,
				);
			jobs.push({
				sample,
				turn,
				options: {
					slotId: slot.id,
					catalog: catalogs.get(sample.source_id),
					logicalRelations: dataset.logical_relations,
					artifacts: { expected_source_version: experiment.snapshots[sample.source_id].source_version },
				},
			});
		}
		const scores = await scoreInWorkers(jobs, signal);
		if ((await executionFingerprint()) !== this.codeHash)
			throw new RuntimeError("scorer_version_changed", "评分期间版本变化，结果不发布");
		const expected = slots.map((slot) => ({
			...dataset.cases.find((sample) => sample.id === slot.case_id)!,
			slot_id: slot.id,
		}));
		const report = aggregateScores(expected, scores);
		const performance = observedPerformance([...observations.values()]);
		Object.assign(report, { cost: performance.cost, duration_ms: performance.end_to_end.p50_ms });
		const variant_reports: Record<string, QualityReport> = {};
		// 私有必需表标注仅用于离线诊断，不进入业务请求、模型上下文或质量放行分数。
		const retrievalEntries = [...observations.entries()].map(([slot_id, turn]) => {
			const slot = slots.find((entry) => entry.id === slot_id)!;
			const sample = dataset.cases.find((entry) => entry.id === slot.case_id)!;
			return { slot_id, turn, required_tables: sample.gold.required_tables as string[] | undefined };
		});
		const retrieval = observedRetrievalCoverage(retrievalEntries);
		const variant_retrieval: Record<string, ReturnType<typeof observedRetrievalCoverage>> = {};
		for (const variant of experiment.variant_ids) {
			const ids = new Set(slots.filter((slot) => slot.variant_id === variant).map((slot) => slot.id));
			variant_reports[variant] = aggregateScores(
				expected.filter((sample) => ids.has(sample.slot_id)),
				scores.filter((score) => ids.has(score.slot_id!)),
			);
			const measured = observedPerformance(
				[...observations.entries()].filter(([id]) => ids.has(id)).map(([, turn]) => turn),
			);
			Object.assign(variant_reports[variant], { cost: measured.cost, duration_ms: measured.end_to_end.p50_ms });
			variant_retrieval[variant] = observedRetrievalCoverage(
				retrievalEntries.filter((entry) => ids.has(entry.slot_id)),
			);
		}
		const repairObservations: ScoredObservation[] = scores.map((score) => {
			const turn = observations.get(score.slot_id!)!;
			const payload = object(turn.result ?? {}),
				progress = object(turn.progress ?? {});
			const repairs = payload.repairs ?? progress.repairs;
			const triggered = Array.isArray(repairs) && repairs.length > 0;
			const rawDiagnostics = payload.diagnostics ?? progress.diagnostics;
			const stages = Array.isArray(payload.stages ?? progress.stages)
				? ((payload.stages ?? progress.stages) as unknown[])
				: [];
			// 仅登记验证器已证明的必要条件反例；模型归因和一般错误不被升级为根因证明。
			const necessaryFailures = (Array.isArray(rawDiagnostics) ? rawDiagnostics : [])
				.map((item) => object(item))
				.filter(
					(item) =>
						item.id === (Array.isArray(repairs) && repairs.length ? object(repairs[0]).diagnostic_id : null) &&
						item.cause_status === "confirmed" &&
						item.required_condition_failure === true &&
						stages.some((stage) => object(stage).id === item.stage_id && object(stage).status === "failed"),
				)
				.map((item) => ({
					check_id: String(item.code),
					artifact_hash: fingerprint(stages.find((stage) => object(stage).id === item.stage_id)),
					predicate: String(item.message),
					validator_version: String(object(item.evidence ?? {}).validator_version ?? experiment.execution_hash),
					evidence_refs: (Array.isArray(item.evidence_refs) ? item.evidence_refs : []).filter(
						(ref): ref is string => typeof ref === "string",
					),
					normal_followup_cannot_resolve: true,
					status: "fail" as const,
				}));
			// 没有介入修复时完整观察即首次路径；介入后不把最终答案倒填为首次。
			return {
				slot_id: score.slot_id!,
				score,
				repair_triggered: triggered,
				first: deriveFirstTaskOutcome({
					profile: score.profile,
					...(triggered
						? { interruptedByRepair: true, necessaryFailures }
						: { firstScore: score, firstTerminal: true }),
				}),
				origin: experiment.origin_experiment_id ? "resumed_unknown" : "online",
			};
		});
		const scoreSet = createScoreSet({
			dataset_hash: this.dataset(experiment.dataset_id).hash,
			gold_hash: dataset.hash,
			observation_hash: fingerprint(observation_ids),
			...(experiment.quality_policy ? { policy_hash: fingerprint(experiment.quality_policy) } : {}),
			...(experiment.latest_score_set_id ? { parent_score_set_id: experiment.latest_score_set_id } : {}),
			scores,
		});
		const scored: ScoredRun = {
			...scoreSet,
			scoring_execution_hash: this.codeHash,
			experiment_id: experiment.id,
			status: "completed",
			report,
			variant_reports,
			repairs: summarizeRepairs(repairObservations),
			observation_ids,
			created_at: Date.now(),
		};
		// 派生摘要随同一不可变评分版本保存，逐题首次证据与局部阶段分母均可回查。
		Object.assign(scored, {
			performance,
			retrieval,
			variant_retrieval,
			stage_repairs: stageAttribution([...observations.values()]),
			attribution: repairObservations.map(({ slot_id, first, repair_triggered, origin }) => ({
				slot_id,
				first,
				repair_triggered,
				origin,
			})),
			stability: experiment.variant_ids.flatMap((variant_id) =>
				experiment.case_ids.map((case_id) => {
					const selected = slots.filter((slot) => slot.variant_id === variant_id && slot.case_id === case_id);
					const evaluated = selected.map((slot) => scores.find((score) => score.slot_id === slot.id));
					const valid = evaluated.every((score) => score?.evaluation_status === "valid" && score.status !== "unknown");
					const outcomes = evaluated.map((score) => score?.status === "pass");
					return {
						variant_id,
						case_id,
						planned: selected.length,
						valid,
						pass_2: valid ? passK(outcomes, 2) : null,
						pass_3: valid ? passK(outcomes, 3) : null,
					};
				}),
			),
		});
		signal.throwIfAborted();
		// 所有检查完成后一次提交评分版本；旧报告与产物保持不变。
		this.store.transaction(() => {
			this.store.immutable("score_set", scored.id, scored);
			for (const artifact of observation_ids) this.store.refArtifact(artifact, `score_set:${scored.id}`);
			this.store.refArtifact(
				this.require<DatasetRegistration>("dataset", dataset.id).data.artifact_id,
				`score_set:${scored.id}`,
			);
			const current = this.require<Experiment>("experiment", experiment.id);
			if ((current.data.scoring_dataset_id ?? current.data.dataset_id) === dataset.id)
				this.store.put(
					"experiment",
					experiment.id,
					{ ...current.data, latest_score_set_id: scored.id },
					current.revision,
				);
			else
				this.store.put("applicability", scored.id, {
					status: "regrade_required",
					reason: "gold_changed_during_scoring",
				});
			for (const slot of slots)
				if (scores.some((score) => score.slot_id === slot.id))
					this.store.updateSlot({ ...this.store.slot(slot.id)!, scored: true });
			this.store.put("score_job", jobId, {
				...this.require<Record<string, unknown>>("score_job", jobId).data,
				id: jobId,
				experiment_id: experiment.id,
				status: "completed",
				score_set_id: scored.id,
			});
			this.store.event(experiment.id, scored.id, "scored", { report, repairs: scored.repairs });
		});
	}
	async reconcile(id: string, input: Command) {
		const actions = ["verified_complete", "verified_terminated", "manual_release", "keep"] as const;
		if (!actions.includes(input.action as (typeof actions)[number]))
			throw new RuntimeError("invalid_action", "对账处置无效", 400);
		return this.app.runtime.reconcileOperation(id, {
			action: input.action as (typeof actions)[number],
			actor: text(input.actor, "操作者"),
			reason: text(input.reason, "处置原因"),
			evidence: JSON.parse(JSON.stringify(input.evidence ?? {})) as JsonObject,
			request_id: text(input.idempotency_key, "幂等键"),
		});
	}
	async reply(id: string, input: Command) {
		return this.command(`reply:${id}`, input, async () => {
			const slot = this.store.slot(id);
			if (!slot?.turn_id) throw new RuntimeError("not_found", "槽位尚无业务任务", 404);
			const task = await this.app.runtime.get(slot.turn_id);
			const submissionId = text(input.idempotency_key, "幂等键");
			const prior = task?.replies.find((reply) => reply.submissionId === submissionId);
			// Pi 已接受但控制回执尚未提交时，用原追问身份重取；不能重复接受或改用新表单。
			if (prior && task) {
				const accepted = await this.app.runtime.reply({
					turnId: task.id,
					submissionId,
					clarificationId: prior.clarificationId,
					revision: integer(input.revision ?? prior.revision, 1, 1, 1000),
					answer: text(input.answer, "补充回答"),
				});
				return this.commitResult(() => publicTurn(accepted));
			}
			if (
				["completed", "cancelled", "incomplete"].includes(
					this.require<Experiment>("experiment", slot.experiment_id).data.status,
				)
			)
				throw new RuntimeError("observation_frozen", "该实验观察已封存，补充回答应创建带回复脚本的新实验");
			if (!task?.clarification) throw new RuntimeError("not_waiting", "当前问题不在等待补充状态");
			const result = publicTurn(
				await this.app.runtime.reply({
					turnId: task.id,
					submissionId: text(input.idempotency_key, "幂等键"),
					clarificationId: task.clarification.id,
					revision: integer(input.revision ?? task.clarification.revision, 1, 1, 1000),
					answer: text(input.answer, "补充回答"),
				}),
			);
			return this.commitResult(() => result);
		});
	}
	async compare(input: Command) {
		return this.command("comparison", input, async () => {
			if (typeof input.experiment_id === "string") {
				const experiment = this.require<Experiment>("experiment", input.experiment_id).data;
				if (!experiment.comparison_protocol || !experiment.latest_score_set_id)
					throw new RuntimeError("protocol_or_scores_missing", "需先冻结三组比较协议并完成评分");
				const scoreSet = this.require<ScoredRun>("score_set", experiment.latest_score_set_id).data;
				// 已裁定或删除证据的旧版本仍可查阅，但不能继续生成有效对照结论。
				if (this.store.get("applicability", scoreSet.id))
					throw new RuntimeError("evidence_invalidated", "评分依据已失效，请等待当前口径完成重评分");
				const cases = this.dataset(experiment.dataset_id).cases;
				const planned = this.store.slots(experiment.id, -1, 10000).map((slot) => ({
					slot_id: slot.id,
					case_id: slot.case_id,
					family: cases.find((sample) => sample.id === slot.case_id)!.family,
					variant_id: slot.variant_id,
					repeat_index: slot.repeat_index,
					snapshot_id: slot.snapshot_id,
				}));
				const result = compareArms(
					planned,
					scoreSet.scores.map((score) => ({
						slot_id: score.slot_id!,
						score,
						origin: experiment.origin_experiment_id ? "resumed_unknown" : "online",
					})),
					experiment.comparison_protocol,
				);
				const comparison = {
					...result,
					id: randomUUID(),
					experiment_id: experiment.id,
					score_set_id: scoreSet.id,
					created_at: Date.now(),
				};
				return this.commitResult(() => this.store.immutable("comparison", comparison.id, comparison).data);
			}
			const left = this.require<Experiment>("experiment", text(input.baseline_experiment_id, "基线实验")).data;
			const right = this.require<Experiment>("experiment", text(input.candidate_experiment_id, "候选实验")).data;
			if (!left.latest_score_set_id || !right.latest_score_set_id)
				throw new RuntimeError("scores_missing", "两个实验都需先评分");
			const leftScore = this.require<ScoredRun>("score_set", left.latest_score_set_id).data;
			const rightScore = this.require<ScoredRun>("score_set", right.latest_score_set_id).data;
			if (this.store.get("applicability", leftScore.id) || this.store.get("applicability", rightScore.id))
				throw new RuntimeError("evidence_invalidated", "比较评分依据已失效，请重新评分");
			const bundle = (run: Experiment, scored: ScoredRun) => ({
				dataset_hash: this.dataset(run.dataset_id).hash,
				gold_hash: scored.gold_hash,
				execution_hash: run.execution_hash,
				source_versions: Object.fromEntries(
					Object.entries(run.snapshots).map(([key, value]) => [key, value.source_version]),
				),
				repeats: run.repeats,
				concurrency: run.concurrency,
				model_variants: run.variant_ids.map((id) => {
					const { id: _id, hash: _hash, name: _name, ...value } = this.require<Variant>("variant", id).data;
					return value;
				}),
				policy_hash: scored.policy_hash,
				scorer_hashes: [...new Set(scored.scores.map((score) => score.scorer_hash))].sort(),
				scoring_execution_hash: scored.scoring_execution_hash,
				actual_model_revision: "unverified",
			});
			// 对比允许差异取冻结协议；临时输入仅用于探索描述，不获得发布或因果资格。
			const requested = Array.isArray(input.allowed_differences)
				? (input.allowed_differences.filter((value) => typeof value === "string") as string[])
				: [];
			const leftBundle = bundle(left, leftScore),
				rightBundle = bundle(right, rightScore);
			const allowed = requested.map((path) => ({
				path,
				values: [object(leftBundle)[path] ?? null, object(rightBundle)[path] ?? null],
			}));
			const comparability = checkComparability({ baseline: leftBundle, candidate: rightBundle }, allowed, [
				"actual_model_revision",
			]);
			const leftSlots = this.store.slots(left.id, -1, 10000),
				rightSlots = this.store.slots(right.id, -1, 10000);
			const pairs = leftSlots.map((slot) => {
				const candidates = rightSlots.filter(
					(other) =>
						other.case_id === slot.case_id &&
						other.repeat_index === slot.repeat_index &&
						other.snapshot_id === slot.snapshot_id,
				);
				const first = leftScore.scores.find((score) => score.slot_id === slot.id);
				const second =
					candidates.length === 1 ? rightScore.scores.find((score) => score.slot_id === candidates[0].id) : undefined;
				return {
					case_id: slot.case_id,
					repeat_index: slot.repeat_index,
					baseline: first?.status ?? "unknown",
					candidate: second?.status ?? "unknown",
					paired: !!first && !!second && first.profile === second.profile,
				};
			});
			const comparison = {
				id: randomUUID(),
				baseline_experiment_id: left.id,
				candidate_experiment_id: right.id,
				baseline_score_set_id: leftScore.id,
				candidate_score_set_id: rightScore.id,
				comparability,
				status: "exploratory",
				causal_claim: false,
				reasons: ["comparison_protocol_not_preregistered", ...comparability.errors],
				pairs,
				repairs: { baseline: leftScore.repairs, candidate: rightScore.repairs },
				created_at: Date.now(),
			};
			return this.commitResult(() => this.store.immutable("comparison", comparison.id, comparison).data);
		});
	}
	async adjudicate(input: Command) {
		const result = await this.command("adjudication", input, async () => {
			const current = this.require<Experiment>("experiment", text(input.experiment_id, "实验"));
			if (input.expected_revision !== current.revision)
				throw new RuntimeError("revision_conflict", "实验已改变，请刷新后裁定");
			const experiment = current.data;
			const slot = this.store.slot(text(input.slot_id, "槽位"));
			if (!slot || slot.experiment_id !== experiment.id)
				throw new RuntimeError("invalid_slot", "槽位不属于该实验", 400);
			const actor = text(input.actor, "裁定人"),
				reason = text(input.reason, "裁定理由");
			if (!slot.artifact_id) throw new RuntimeError("evidence_missing", "必须有原始观察才能裁定");
			const original = this.dataset(experiment.scoring_dataset_id ?? experiment.dataset_id);
			const revised = object(input.revised_gold);
			const previous = original.cases.find((sample) => sample.id === slot.case_id)!;
			for (const field of [
				"id",
				"source_id",
				"question",
				"as_of",
				"check_profile",
				"category",
				"track",
				"family_id",
				"split",
			])
				if (field in revised && fingerprint(revised[field]) !== fingerprint(previous.gold[field] ?? null))
					throw new RuntimeError(
						"frozen_scoring_contract",
						"裁定不能修改问题身份、评分档位、分轨或拆分；请建立新的数据集和实验",
						400,
					);
			if (!Object.keys(revised).length)
				throw new RuntimeError("invalid_gold", "请提交修订的标准答案，不能直接修改分数", 400);
			const dataset = parseDataset({
				name: `${original.name} · 裁定`,
				questionsJsonl: original.cases
					.map((sample) =>
						JSON.stringify({
							id: sample.id,
							source_id: sample.source_id,
							question: sample.question,
							as_of: sample.as_of,
						}),
					)
					.join("\n"),
				goldJsonl: original.cases
					.map((sample) =>
						JSON.stringify(
							sample.id === slot.case_id
								? { ...sample.gold, ...revised, id: sample.id, source_id: sample.source_id }
								: sample.gold,
						),
					)
					.join("\n"),
				logicalRelations: original.logical_relations,
				manifest: {
					version: `adjudicated-${original.hash}`,
					parent_dataset_id: original.id,
					question_count: original.cases.length,
				},
			});
			const artifact_id = this.store.artifact(dataset, "private_dataset", `dataset:${dataset.id}`);
			const affected = this.store
				.all<Experiment>("experiment")
				.filter((record) => record.data.dataset_id === experiment.dataset_id);
			const record = {
				id: randomUUID(),
				experiment_id: experiment.id,
				slot_id: slot.id,
				case_id: slot.case_id,
				actor,
				reason,
				evidence_refs: [slot.artifact_id],
				old_dataset_id: original.id,
				new_dataset_id: dataset.id,
				affected_experiment_ids: affected.map((item) => item.id),
				created_at: Date.now(),
			};
			return this.commitResult(() => {
				this.store.immutable("dataset", dataset.id, {
					artifact_id,
					summary: publicDataset(dataset),
					sources: this.require<DatasetRegistration>("dataset", experiment.dataset_id).data.sources,
				});
				this.store.immutable("adjudication", record.id, record);
				for (const affectedExperiment of affected) {
					this.store.put(
						"experiment",
						affectedExperiment.id,
						{ ...affectedExperiment.data, scoring_dataset_id: dataset.id },
						affectedExperiment.revision,
					);
					this.store.refArtifact(artifact_id, `experiment:${affectedExperiment.id}`);
					for (const score of this.store
						.all<ScoredRun>("score_set")
						.filter((score) => score.data.experiment_id === affectedExperiment.id))
						this.store.put("applicability", score.id, { status: "regrade_required", adjudication_id: record.id });
				}
				return record;
			});
		});
		for (const id of result.affected_experiment_ids) {
			const record = this.require<Experiment>("experiment", id);
			if (!this.scoring.has(id) && ["completed", "incomplete", "cancelled"].includes(record.data.status))
				await this.grade(id, { idempotency_key: `adjudication-${result.id}`, expected_revision: record.revision });
		}
		return result;
	}
	async release(input: Command) {
		return this.command("release", input, async () => {
			const record = this.require<Experiment>("experiment", text(input.experiment_id, "实验"));
			if (input.expected_revision !== record.revision) throw new RuntimeError("revision_conflict", "实验已改变");
			const variant_id = text(input.variant_id, "方案");
			if (!record.data.variant_ids.includes(variant_id))
				throw new RuntimeError("invalid_variant", "方案不属于实验", 400);
			const scoreId = text(input.score_set_id, "评分版本", record.data.latest_score_set_id);
			const scores = this.require<ScoredRun>("score_set", scoreId).data;
			if (scores.experiment_id !== record.id) throw new RuntimeError("score_mismatch", "评分不属于该实验");
			const report = scores.variant_reports[variant_id];
			const policy = validateQualityPolicy(record.data.quality_policy).policy;
			let baseline: (QualityReport & { score_set_id: string; comparable: boolean }) | undefined;
			if (policy?.baseline_non_regression) {
				const prior = this.store.get<ScoredRun>(
					"score_set",
					policy.baseline_non_regression.baseline_score_set_id,
				)?.data;
				if (prior) {
					const priorExperiment = this.require<Experiment>("experiment", prior.experiment_id).data;
					const sameSources =
						fingerprint(
							Object.values(record.data.snapshots)
								.map((item) => item.source_version)
								.sort(),
						) ===
						fingerprint(
							Object.values(priorExperiment.snapshots)
								.map((item) => item.source_version)
								.sort(),
						);
					baseline = {
						...(prior.variant_reports[variant_id] ?? prior.report),
						score_set_id: prior.id,
						comparable:
							!this.store.get("applicability", prior.id) &&
							sameSources &&
							prior.gold_hash === scores.gold_hash &&
							prior.scoring_execution_hash === scores.scoring_execution_hash &&
							fingerprint(prior.scores.map((score) => score.scorer_hash).sort()) ===
								fingerprint(scores.scores.map((score) => score.scorer_hash).sort()) &&
							fingerprint(priorExperiment.case_ids.slice().sort()) ===
								fingerprint(record.data.case_ids.slice().sort()) &&
							priorExperiment.repeats === record.data.repeats,
					};
				}
			}
			const gate = evaluateQualityGate(report, policy, baseline);
			const invalidated = this.store.get<{ status: string }>("applicability", scoreId)?.data.status;
			const decision = {
				...gate,
				...(invalidated ? { status: "evidence_insufficient", reasons: [...gate.reasons, invalidated] } : {}),
				id: randomUUID(),
				experiment_id: record.id,
				variant_id,
				variant_hash: this.require<Variant>("variant", variant_id).data.hash,
				score_set_id: scoreId,
				execution_hash: record.data.execution_hash,
				scoring_execution_hash: scores.scoring_execution_hash,
				created_at: Date.now(),
			};
			return this.commitResult(() => {
				for (const artifact of scores.observation_ids)
					this.store.refArtifact(artifact, `release_decision:${decision.id}`);
				return this.store.immutable("release_decision", decision.id, decision).data;
			});
		});
	}
	async activate(input: Command) {
		return this.command("activation", input, async () => {
			const decision = this.require<Record<string, unknown>>(
				"release_decision",
				text(input.release_decision_id, "发布决定"),
			).data;
			if (decision.status !== "allow" || this.store.get("applicability", String(decision.score_set_id)))
				throw new RuntimeError("release_denied", "质量门未通过或证据已失效，不能激活");
			if (
				decision.execution_hash !== (await executionFingerprint()) ||
				decision.scoring_execution_hash !== this.codeHash
			)
				throw new RuntimeError("execution_version_changed", "代码版本已变化，发布证据不适用于当前版本");
			const scores = this.require<ScoredRun>("score_set", String(decision.score_set_id)).data;
			for (const artifact of scores.observation_ids) this.store.readArtifact(artifact);
			const experiment = this.require<Experiment>("experiment", scores.experiment_id).data;
			// 发布证据同时绑定端点、资源范围和运行预算，不能只核对源码版本。
			if (
				!experiment.runtime_configuration ||
				fingerprint(experiment.runtime_configuration) !== fingerprint(runtimeConfiguration(this.app.config))
			)
				throw new RuntimeError("runtime_configuration_changed", "模型端点或运行预算已变化，请重新评测后激活");
			this.dataset(experiment.scoring_dataset_id ?? experiment.dataset_id);
			const activation = {
				id: randomUUID(),
				release_decision_id: decision.id,
				variant_id: decision.variant_id,
				actor: text(input.actor, "操作者"),
				reason: text(input.reason, "激活原因"),
				created_at: Date.now(),
			};
			return this.commitResult(() => {
				this.store.immutable("activation", activation.id, activation);
				this.store.put("default", "active", activation);
				return activation;
			});
		});
	}
	activeVariant(): Variant | undefined {
		const active = this.store.get<{ variant_id: string }>("default", "active");
		return active ? this.require<Variant>("variant", active.data.variant_id).data : undefined;
	}
	async deleteArtifact(id: string, input: Command) {
		return this.command(`delete:${id}`, input, async () => {
			const impact = this.store.deletionImpact(id);
			const affected = new Set(
				impact.filter((owner) => owner.startsWith("experiment:")).map((owner) => owner.slice(11)),
			);
			for (const owner of impact.filter((owner) => owner.startsWith("dataset:")))
				for (const experiment of this.store.all<Experiment>("experiment"))
					if ([experiment.data.dataset_id, experiment.data.scoring_dataset_id].includes(owner.slice(8)))
						affected.add(experiment.id);
			for (const experimentId of affected) {
				const experiment = this.require<Experiment>("experiment", experimentId).data;
				if (!["completed", "cancelled", "incomplete"].includes(experiment.status))
					throw new RuntimeError("artifact_in_use", "请先停止依赖该产物的活动实验");
				for (const slot of this.store.slots(experiment.id, -1, 10000))
					if (
						slot.turn_id &&
						(await this.app.runtime.listOperations(slot.turn_id)).some(
							(operation) => operation.status === "unknown" && !operation.reservationReleased,
						)
					)
						throw new RuntimeError("reconciliation_required", "请先处置关联未知调用再删除");
			}
			return this.commitResult(() => {
				const result = this.store.deleteArtifact(
					id,
					strings(input.owners, "删除范围"),
					text(input.actor, "操作者"),
					text(input.reason, "删除理由"),
				);
				for (const score of this.store.all<ScoredRun>("score_set"))
					if (affected.has(score.data.experiment_id) || impact.includes(`score_set:${score.id}`))
						this.store.put("applicability", score.id, { status: "artifact_deleted", artifact_id: id });
				return result;
			});
		});
	}
	async exportExperiment(id: string) {
		const experiment = this.experiment(id),
			slots = this.store.slots(id, -1, 10000);
		// 导出以单个实验为边界，只闭包其评分、裁定、发布与证据；对照另一侧仅保留引用，不打包其私有观察。
		const related = (kind: string, predicate: (data: Record<string, unknown>) => boolean) =>
			this.store.all<Record<string, unknown>>(kind).filter((record) => predicate(record.data));
		const scoreRecords = this.store.all<ScoredRun>("score_set").filter((record) => record.data.experiment_id === id);
		const adjudications = related(
			"adjudication",
			(data) =>
				data.experiment_id === id ||
				(Array.isArray(data.affected_experiment_ids) && data.affected_experiment_ids.includes(id)),
		);
		const comparisons = related("comparison", (data) =>
			[data.experiment_id, data.baseline_experiment_id, data.candidate_experiment_id].includes(id),
		);
		const releases = related("release_decision", (data) => data.experiment_id === id);
		const releaseIds = new Set(releases.map((record) => record.id));
		const activations = related("activation", (data) => releaseIds.has(String(data.release_decision_id)));
		const scoreIds = new Set(scoreRecords.map((record) => record.id));
		const applicability = related("applicability", (_data) => true).filter((record) => scoreIds.has(record.id));
		const datasetIds = new Set([
			experiment.dataset_id,
			...(experiment.scoring_dataset_id ? [experiment.scoring_dataset_id] : []),
		]);
		for (const record of adjudications)
			for (const field of ["old_dataset_id", "new_dataset_id"])
				if (typeof record.data[field] === "string") datasetIds.add(record.data[field] as string);
		const datasetHashes = new Set(scoreRecords.flatMap((record) => [record.data.dataset_hash, record.data.gold_hash]));
		// grade 的 dataset_hash/gold_hash 都是完整 DatasetVersion.hash；注册行缺失也保留该身份。
		for (const hash of datasetHashes) datasetIds.add(`dataset-${hash}`);

		type RecordReference = {
			kind: string;
			id: string;
			status: "included" | "record_missing" | "external_reference";
			revision?: number;
		};
		const recordManifest = new Map<string, RecordReference>();
		const reference = (kind: string, recordId: unknown, included = true) => {
			if (typeof recordId !== "string") return;
			const key = `${kind}:${recordId}`;
			if (recordManifest.get(key)?.status === "included") return;
			const record = included ? this.store.get(kind, recordId) : undefined;
			recordManifest.set(key, {
				kind,
				id: recordId,
				status: included
					? record
						? kind === "score_set" && !scoreIds.has(recordId)
							? "external_reference"
							: "included"
						: "record_missing"
					: "external_reference",
				...(record ? { revision: record.revision } : {}),
			});
		};
		reference("experiment", id);
		reference("experiment", experiment.origin_experiment_id, false);
		reference("score_set", experiment.latest_score_set_id);
		for (const [kind, records] of [
			["score_set", scoreRecords],
			["adjudication", adjudications],
			["comparison", comparisons],
			["release_decision", releases],
			["activation", activations],
			["applicability", applicability],
		] as const)
			for (const record of records) reference(kind, record.id);
		for (const record of scoreRecords) reference("score_set", record.data.parent_score_set_id);
		for (const record of [...comparisons, ...adjudications]) {
			for (const field of ["experiment_id", "baseline_experiment_id", "candidate_experiment_id"])
				reference("experiment", record.data[field], record.data[field] === id);
			for (const field of ["score_set_id", "baseline_score_set_id", "candidate_score_set_id"])
				reference(
					"score_set",
					record.data[field],
					field === "score_set_id" || record.data[field.replace("score_set_id", "experiment_id")] === id,
				);
		}
		for (const record of releases) reference("score_set", record.data.score_set_id);

		const artifactRoles = new Map<string, Set<string>>();
		const evidence = (artifactId: unknown, role: string) => {
			if (typeof artifactId !== "string") return;
			if (!artifactRoles.has(artifactId)) artifactRoles.set(artifactId, new Set());
			artifactRoles.get(artifactId)!.add(role);
		};
		for (const slot of slots) evidence(slot.artifact_id, `slot:${slot.id}`);
		for (const record of scoreRecords)
			for (const artifactId of record.data.observation_ids) evidence(artifactId, `score_set:${record.id}`);
		for (const record of adjudications)
			if (Array.isArray(record.data.evidence_refs))
				for (const artifactId of record.data.evidence_refs) evidence(artifactId, `adjudication:${record.id}`);
		const datasets = [...datasetIds].sort().flatMap((datasetId) => {
			reference("dataset", datasetId);
			const record = this.store.get<DatasetRegistration>("dataset", datasetId);
			if (!record) return [];
			evidence(record.data.artifact_id, `dataset:${datasetId}`);
			return [{ id: datasetId, ...record.data }];
		});
		const variants = experiment.variant_ids.flatMap((variantId) => {
			reference("variant", variantId);
			const record = this.store.get<Variant>("variant", variantId);
			return record ? [record.data] : [];
		});

		// 正文逐项验 hash；删除、意外缺失、损坏分别留痕，任何一项失败都不能把整包伪装成完整可重评。
		const readArtifact = (artifactId: string) => {
			try {
				return { id: artifactId, completeness: "verified", content: this.store.readArtifact(artifactId) };
			} catch (error) {
				const metadata = this.store.db.prepare("SELECT deleted_at FROM artifacts WHERE id=?").get(artifactId);
				const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
				return {
					id: artifactId,
					completeness:
						metadata?.deleted_at != null
							? "artifact_deleted"
							: code === "artifact_corrupt"
								? "artifact_corrupt"
								: code === "ENOENT" || !metadata
									? "artifact_missing"
									: "artifact_read_error",
					error_code: code || "read_error",
				};
			}
		};
		const contents = new Map(
			[...artifactRoles.keys()].sort().map((artifactId) => [artifactId, readArtifact(artifactId)]),
		);
		const observationIds = new Set(slots.flatMap((slot) => (slot.artifact_id ? [slot.artifact_id] : [])));
		const artifactManifest = [...contents.values()].map(({ content: _content, ...entry }) => ({
			...entry,
			roles: [...artifactRoles.get(entry.id)!].sort(),
		}));
		const active = this.store.get<Record<string, unknown>>("default", "active");
		return {
			// 保留 v1 字段与正文布局；新增闭包契约独立标版本，旧消费者仍可读取 artifacts / score_sets。
			schema_version: "evaluation-export/v1",
			bundle_contract: "evaluation-evidence-bundle/v2",
			experiment,
			slots,
			events: this.store.allEvents(id),
			artifacts: slots.filter((slot) => slot.artifact_id).map((slot) => contents.get(slot.artifact_id!)!),
			score_sets: scoreRecords.map((record) => record.data),
			completeness: "manifest_with_per_artifact_status",
			snapshots: experiment.snapshots,
			variants,
			datasets,
			dependency_artifacts: [...contents.values()].filter((entry) => !observationIds.has(entry.id)),
			adjudications: adjudications.map((record) => record.data),
			comparisons: comparisons.map((record) => record.data),
			release_decisions: releases.map((record) => record.data),
			activations: activations.map((record) => record.data),
			applicability: applicability.map((record) => ({ score_set_id: record.id, ...record.data })),
			active_activation_id:
				active && activations.some((record) => record.id === active.data.id) ? active.data.id : null,
			artifact_manifest: artifactManifest,
			observation_manifest: slots.map((slot) => ({
				slot_id: slot.id,
				artifact_id: slot.artifact_id ?? null,
				status: slot.artifact_id ? contents.get(slot.artifact_id)!.completeness : "not_recorded",
			})),
			record_manifest: [...recordManifest.values()].sort((a, b) =>
				`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
			),
			deletion_events: this.store.allEvents("storage").filter((event) => artifactRoles.has(event.entity_id)),
			evidence_status:
				slots.every((slot) => !!slot.artifact_id) &&
				artifactManifest.every((entry) => entry.completeness === "verified") &&
				![...recordManifest.values()].some((entry) => entry.status === "record_missing")
					? "complete_for_scoped_regrading"
					: "incomplete",
			// 源快照只携带既有位置与版本，不把 JSON 导出宣称为包含 SQLite 正文的独立执行备份。
			execution_replay: {
				status: "requires_frozen_sources_and_matching_runtime",
				source_snapshots_embedded: false,
				external_references_embedded: false,
			},
		};
	}

	async close() {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		await this.pumping;
		await this.mutation;
		for (const job of this.scoring.values()) job.controller.abort();
		await Promise.allSettled([...this.scoring.values()].map((job) => job.promise));
		this.store.close();
	}
}
