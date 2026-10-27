import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type AppConfig, defaultRetrievalTopK } from "./config.ts";
import { DomainService, type Source } from "./domain.ts";
import { EvaluationService } from "./evaluation/service.ts";
import { executionFingerprint, runtimeConfiguration } from "./evaluation/snapshots.ts";
import { fingerprint } from "./evaluation/store.ts";
import { ModelGateway, object } from "./model.ts";
import { createPipeline } from "./pipeline.ts";
import { type JsonObject, QueryRuntime, type QueryTask, type RunOutcome, RuntimeError } from "./runtime.ts";

export class Application {
	readonly domain: DomainService;
	readonly models: ModelGateway;
	runtime!: QueryRuntime;
	evaluation!: EvaluationService;
	readonly config: AppConfig;
	private executionHash = "";
	private constructor(config: AppConfig) {
		this.config = config;
		this.domain = new DomainService(config);
		this.models = new ModelGateway(config);
	}
	static async open(config: AppConfig): Promise<Application> {
		const app = new Application(config);
		app.executionHash = await executionFingerprint();
		await mkdir(config.dataDir, { recursive: true });
		const pipeline = createPipeline(app.domain, app.models, () => app.runtime);
		app.runtime = await QueryRuntime.open({
			storagePath: config.coordinatorStoragePath ?? resolve(config.dataDir, "runtime.sqlite"),
			maxActiveRuns: config.maxActiveRuns,
			evalMaxActiveRuns: config.evalMaxActiveRuns,
			maxPending: config.maxPending,
			// 业务准入与模型出口使用同一个在线保留配置，显式零值也必须透传。
			onlineQueueReserve: config.onlineQueueReserve,
			queueWaitTimeoutMs: config.queueWaitTimeoutMs,
			runTimeoutMs: config.runTimeoutMs,
			installationLockPath: config.installationLockPath,
			// 外部调用账本恢复后再准入，避免未知请求因启动顺序失去额度占用。
			onReady: async (runtime) => {
				app.runtime = runtime;
				await app.models.attachRuntime(runtime);
				await EvaluationService.restoreControls(runtime, config.dataDir);
			},
			// 边界统一为可持久化JSON，原始SDK对象和密钥不进入业务文档。
			handler: async (task, signal, update) => {
				// 恢复的队列不能以新代码静默继续，产物发布也必须留在同一执行版本。
				const verify = async () => {
					if (
						(task.context.execution_hash && task.context.execution_hash !== app.executionHash) ||
						(task.context.runtime_configuration_hash &&
							task.context.runtime_configuration_hash !== fingerprint(runtimeConfiguration(config))) ||
						(await executionFingerprint()) !== app.executionHash
					)
						throw new RuntimeError("execution_version_changed", "执行版本已变化，请创建新尝试");
				};
				await verify();
				const outcome = await pipeline(task, signal, async (progress) => {
					if (progress && typeof progress === "object" && !Array.isArray(progress) && progress.publication)
						await verify();
					await update(progress);
				});
				await verify();
				return JSON.parse(JSON.stringify(outcome)) as RunOutcome;
			},
		});
		try {
			app.evaluation = await EvaluationService.open(app);
		} catch (error) {
			await app.runtime.close();
			throw error;
		}
		return app;
	}
	async query(input: {
		conversation_id: string;
		source_id: string;
		question: string;
		request_id: string;
		mode?: string;
		as_of?: string;
		// 仅控制端实验服务可传冻结配置；公共 HTTP 问答不透传此对象或私有 gold。
		execution_context?: JsonObject;
	}) {
		const mode = input.mode === "eval" ? "eval" : "online";
		const asOf = input.as_of || "2026-10-15T12:00:00+08:00";
		// 先按用户提交识别重试，数据快照变更或暂时不可读不应阻断已有任务的回执。
		const prior = (await this.runtime.list(input.conversation_id)).find((task) => task.requestId === input.request_id);
		if (prior) {
			if (
				prior.question !== input.question ||
				prior.context.source_id !== input.source_id ||
				prior.context.mode !== mode ||
				prior.context.as_of !== asOf ||
				fingerprint(prior.context.execution_identity ?? null) !== fingerprint(input.execution_context ?? null)
			) {
				throw new RuntimeError("request_conflict", "同一 requestId 不能提交不同内容");
			}
			return prior;
		}
		// 默认配置只在新会话绑定，发布新方案不能悄悄改写进行中的会话。
		let execution = input.execution_context;
		if (mode === "online" && !execution) {
			const turns = await this.runtime.list(input.conversation_id);
			const bound = turns.find((turn) => turn.context.online_variant)?.context.online_variant;
			const variant = bound ??
				(turns.length
					? {
							model_profile: { decision_model: this.config.decisionModel, answer_model: this.config.answerModel },
							repair_limit: this.config.turnRepairLimit ?? 1,
							model_call_limit: this.config.turnModelCallLimit ?? 8,
							repair_policy: "targeted",
							retrieval_strategy: this.config.retrievalStrategy ?? "progressive",
							retrieval_max_context_chars: this.config.retrievalMaxContextChars ?? 256000,
							retrieval_top_k:
								this.config.retrievalTopK ?? defaultRetrievalTopK(this.config.retrievalStrategy ?? "progressive"),
						}
					: this.evaluation.activeVariant()) ?? {
					model_profile: { decision_model: this.config.decisionModel, answer_model: this.config.answerModel },
					repair_limit: this.config.turnRepairLimit ?? 1,
					model_call_limit: this.config.turnModelCallLimit ?? 8,
					repair_policy: "targeted",
					retrieval_strategy: this.config.retrievalStrategy ?? "progressive",
					retrieval_max_context_chars: this.config.retrievalMaxContextChars ?? 256000,
					retrieval_top_k:
						this.config.retrievalTopK ?? defaultRetrievalTopK(this.config.retrievalStrategy ?? "progressive"),
				};
			if (variant) {
				const selected = object(variant);
				execution = JSON.parse(
					JSON.stringify({
						online_variant: selected,
						model_profile: selected.model_profile,
						repair_limit: selected.repair_limit,
						repair_policy: selected.repair_policy,
						model_call_limit: selected.model_call_limit,
						retrieval_strategy: selected.retrieval_strategy,
						retrieval_max_context_chars: selected.retrieval_max_context_chars ?? 256000,
						// 已冻结的显式旧策略继续使用自己的默认预算，不能被新默认改写。
						retrieval_top_k: selected.retrieval_top_k ?? defaultRetrievalTopK(String(selected.retrieval_strategy)),
					}),
				) as JsonObject;
			}
		}
		const source = input.execution_context?.source_snapshot
			? (input.execution_context.source_snapshot as unknown as Source)
			: await this.domain.source(input.source_id);
		const sourceVersion = await this.domain.fingerprint(source);
		if (input.execution_context?.source_version && input.execution_context.source_version !== sourceVersion)
			throw new RuntimeError("snapshot_changed", "冻结业务快照已改变，不允许继续执行");
		return this.runtime.enqueue({
			conversationId: input.conversation_id,
			requestId: input.request_id,
			question: input.question,
			context: {
				...execution,
				execution_hash: this.executionHash,
				runtime_configuration_hash: fingerprint(runtimeConfiguration(this.config)),
				execution_identity: input.execution_context ?? null,
				source_id: source.id,
				source_version: sourceVersion,
				mode,
				as_of: asOf,
			},
		});
	}
	async close() {
		await this.evaluation?.close();
		await this.runtime.close();
	}
}

// 公共响应只输出产品状态，避免把Durable内部记录或配置秘密暴露给页面。
export function publicTurn(task: QueryTask) {
	const payload =
		task.result && typeof task.result === "object" && !Array.isArray(task.result) ? object(task.result) : {};
	const progress =
		task.progress && typeof task.progress === "object" && !Array.isArray(task.progress) ? object(task.progress) : {};
	const publication = object(payload.publication || progress.publication || {});
	// 只有显式发布产物可以进入主聊天；旧任务/候选 data_result 不自动获得发布资格。
	const fullResult = publication.status === "published" ? object(publication.result) : undefined;
	const previewRows = (
		Array.isArray(fullResult?.preview_rows)
			? fullResult.preview_rows
			: Array.isArray(fullResult?.rows)
				? fullResult.rows.slice(0, 200)
				: []
	) as unknown[][];
	const result = fullResult
		? { ...fullResult, rows: previewRows, preview: Number(fullResult.row_count) > previewRows.length }
		: undefined;
	return {
		id: task.id,
		conversation_id: task.conversationId,
		source_id: task.context.source_id,
		question: task.question,
		status: task.status,
		phase: progress.phase,
		clarification: task.clarification,
		answer: payload.answer,
		accepted_replies: task.replies.map((reply) => ({ answer: reply.answer, accepted_at: reply.acceptedAt })),
		result,
		result_artifact_ref: result
			? {
					kind: "publication",
					turn_id: task.id,
					result_hash: publication.result_hash,
					row_count: fullResult?.row_count,
				}
			: undefined,
		evidence: payload.evidence || progress.evidence || progress.linking,
		usage: payload.usage || progress.usage || [],
		// 调用文本与阶段独立于业务 evidence；旧任务缺少采集记录时保持空数组。
		model_calls: Array.isArray(payload.model_calls)
			? payload.model_calls
			: Array.isArray(progress.model_calls)
				? progress.model_calls
				: [],
		stages: Array.isArray(payload.stages) ? payload.stages : Array.isArray(progress.stages) ? progress.stages : [],
		error: task.error?.message,
		created_at: task.createdAt,
		updated_at: task.updatedAt,
		queued_at: task.queuedAt,
		run_started_at: task.runStartedAt,
		data_state: result ? "available" : "none",
		publication: publication.status === "published" ? { ...publication, result } : undefined,
		answer_status: payload.answer_status,
	};
}
