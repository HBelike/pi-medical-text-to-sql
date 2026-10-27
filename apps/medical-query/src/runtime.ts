import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type ConversationId,
	createRegistry,
	defineDoc,
	defineDocFamily,
	defineExtension,
	defineTask,
	Harness,
	type Task,
	type TaskId,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { FairSelector, type ResourceScope } from "./resources.ts";
import { acquireRuntimeLock } from "./runtime-lock.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type QueryStatus =
	| "queued"
	| "running"
	| "waiting_for_user"
	| "completed"
	| "blocked"
	| "failed"
	| "cancelled"
	| "interrupted"
	| "reconciliation_required";
export type ClarificationDraft = { question: string; [key: string]: JsonValue } & { slots?: string[] };
export type Clarification = ClarificationDraft & { id: string; revision: number };
export type AcceptedReply = {
	submissionId: string;
	clarificationId: string;
	revision: number;
	answer: JsonValue;
	acceptedAt: number;
};
export type QueryTask = {
	id: string;
	turnId: string;
	conversationId: string;
	requestId: string;
	question: string;
	context: JsonObject;
	status: QueryStatus;
	runId: string;
	replies: AcceptedReply[];
	createdAt: number;
	updatedAt: number;
	queuedAt: number;
	queueDeadlineAt: number;
	clarificationRevision: number;
	clarification?: Clarification;
	progress?: JsonValue;
	result?: JsonValue;
	runStartedAt?: number;
	runDeadlineAt?: number;
	endedAt?: number;
	durableTaskId?: number;
	cancelRequested?: boolean;
	cancelReason?: string;
	error?: { code: string; message: string };
	budget?: { modelCalls: number; repairs: number; sqlExecutions: number; answerRepairs: number };
};
export type OperationRecord = {
	id: string;
	turnId?: string;
	runId?: string;
	role: string;
	model: string;
	scope: JsonObject;
	requestHash: string;
	input: JsonObject;
	createdAt: number;
	updatedAt: number;
	// 发送权授予时刻独立于准备时刻，重启后的账号速率窗口不能从准备时间推断。
	dispatchedAt?: number;
	status: "prepared" | "dispatching" | "in_flight" | "succeeded" | "failed" | "not_sent" | "unknown";
	epoch: string;
	reservationReleased: boolean;
	receipt?: JsonObject;
	dispositions: {
		request_id: string;
		action: string;
		actor: string;
		reason: string;
		evidence: JsonValue;
		at: number;
	}[];
};
export type ReconcileInput = {
	request_id: string;
	action: "verified_complete" | "verified_terminated" | "manual_release" | "keep";
	actor: string;
	reason: string;
	evidence?: JsonValue;
};
export type RunOutcome =
	| { status: "completed"; result: JsonValue }
	| { status: "waiting_for_user"; clarification: ClarificationDraft }
	| { status: "blocked"; result?: JsonValue }
	| { status: "failed"; result?: JsonValue; error?: string };
export type RunHandler = (
	task: QueryTask,
	signal: AbortSignal,
	updateProgress: (progress: JsonValue) => Promise<void>,
) => Promise<RunOutcome>;
export type RuntimeOptions = {
	storagePath: string;
	handler: RunHandler;
	maxActiveRuns?: number;
	evalMaxActiveRuns?: number;
	maxPending?: number;
	queueWaitTimeoutMs?: number;
	runTimeoutMs?: number;
	onChange?: (task: QueryTask) => void | Promise<void>;
	onError?: (error: unknown) => void;
	installationLockPath?: string;
	onlineQueueReserve?: number;
	onReady?: (runtime: QueryRuntime) => void | Promise<void>;
};
export type EnqueueInput = { conversationId: string; requestId: string; question: string; context?: JsonObject };
export type ReplyInput = {
	turnId: string;
	submissionId: string;
	clarificationId: string;
	revision: number;
	answer: JsonValue;
};
export type RuntimeStats = { active: number; pending: number; peakActive: number; evalActive: number };

/** 业务拒绝采用稳定错误码，调用层可直接映射冲突、容量不足和无效请求。 */
export class RuntimeError extends Error {
	readonly code: string;
	readonly statusCode: number;
	constructor(code: string, message: string, statusCode = 409) {
		super(message);
		this.name = "RuntimeError";
		this.code = code;
		this.statusCode = statusCode;
	}
}

type IndexState = {
	turnIds: string[];
	turns: Record<string, number>;
	conversations: Record<string, number>;
	requests: Record<string, string>;
};
type TurnDocument = { task: QueryTask | null };
type RunInput = { turnId: string; runId: string };
type RunCheckpoint = { phase: "execute" };
type RunReceipt = { status: QueryStatus };
type RunRuntime = TaskRuntime<RunInput, RunCheckpoint, RunReceipt, object>;

// 索引仅保存定位与去重关系；业务状态保存在会话级文档中，不随短生命周期任务结束而退役。
const RuntimeIndex = defineDoc<IndexState>({
	kind: "medical-query.runtime-index",
	version: 1,
	scope: "session",
	initial: () => ({ turnIds: [], turns: {}, conversations: {}, requests: {} }),
});
const QueryTurnDocument = defineDocFamily<TurnDocument, null>({
	kind: "medical-query.query-turn",
	version: 1,
	scope: "conversation",
	family: true,
	history: "latest",
	fork: "initial",
	initial: () => ({ task: null }),
});
// 外部调用独立于短任务保存，重启、取消和人工处置都不抹去未知事实。
const OperationLedger = defineDoc<{
	operations: Record<string, OperationRecord>;
	pausedExperiments: string[];
	cancelledExperiments?: string[];
}>({
	kind: "medical-query.external-operations",
	version: 1,
	scope: "session",
	initial: () => ({ operations: {}, pausedExperiments: [], cancelledExperiments: [] }),
});
const openPaths = new Set<string>();
const context = BACKGROUND_CONTEXT;
const terminal = (status: QueryStatus): boolean => !["queued", "running", "waiting_for_user"].includes(status);
const isEvaluation = (task: QueryTask): boolean => task.context.mode === "eval";
// 高频诊断只复制定位字段，完整提示词与模型回执由按单轮读取的详情接口提供。
function operationIndex(operation: OperationRecord) {
	return {
		id: operation.id,
		turnId: operation.turnId,
		runId: operation.runId,
		role: operation.role,
		model: operation.model,
		status: operation.status,
		createdAt: operation.createdAt,
		updatedAt: operation.updatedAt,
		reservationReleased: operation.reservationReleased,
		experiment_id: operation.scope.experiment_id,
		variant_id: operation.scope.variant_id,
		resource_scope_id: operation.scope.resource_scope_id,
	};
}
const taskScope = (task: QueryTask): ResourceScope => ({
	mode: isEvaluation(task) ? "eval" : "online",
	experiment_id: String(task.context.experiment_id ?? "unscoped"),
	variant_id: String(task.context.variant_id ?? "default"),
});
const keyOf = (value: JsonValue): string => createHash("sha256").update(canonical(value)).digest("hex");

/** 排除 undefined、非有限数和类实例，避免持久化时悄悄丢失业务条件。 */
function canonical(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	throw new RuntimeError("invalid_json", "业务状态必须是严格 JSON 数据", 400);
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const required = (value: string, label: string): void => {
	if (typeof value !== "string" || !value.trim()) throw new RuntimeError("invalid_request", `${label}不能为空`, 400);
};
function integer(value: number, label: string, max = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > max)
		throw new RuntimeError("invalid_config", `${label}必须为 1～${max} 的整数`, 400);
	return value;
}

/** 只结算已经存在但没有结束记录的观察项；崩溃后的真实结束时间未知，不能用重启时刻伪造耗时。 */
function settleOpenTrace(task: QueryTask, status: "failed" | "cancelled" | "interrupted", message: string): void {
	const progress = task.progress;
	if (!progress || typeof progress !== "object" || Array.isArray(progress)) return;
	for (const key of ["stages", "model_calls", "usage"]) {
		const entries = progress[key];
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.status !== "running") continue;
			entry.status = status;
			entry.error = message;
			delete entry.duration_ms;
		}
	}
}

/**
 * Pi Durable 负责原子文档、任务及 SQLite 持久化；此层仅实现产品需要的会话准入和有界队列。
 * 每个已准入运行对应真实的自定义 Durable Task；所有外部工作均在状态提交之外执行。
 */
export class QueryRuntime {
	readonly #options: RuntimeOptions;
	readonly #path: string;
	readonly #maxActive: number;
	readonly #maxEval: number;
	readonly #maxPending: number;
	readonly #queueTimeout: number;
	readonly #runTimeout: number;
	readonly #runTask: Task<RunInput, RunCheckpoint, RunReceipt, object>;
	#harness!: Harness;
	#closing = false;
	#closePromise?: Promise<void>;
	#draining = false;
	#dirty = false;
	#drainPromise: Promise<void> = Promise.resolve();
	#queueTimer?: ReturnType<typeof setTimeout>;
	#peakActive = 0;
	#releaseOwner?: () => void;
	#releaseInstallation?: () => void;
	readonly #epoch = randomUUID();
	readonly #selector = new FairSelector();
	readonly #operationListeners = new Set<(operation: OperationRecord) => void>();

	private constructor(options: RuntimeOptions) {
		this.#options = options;
		this.#path = options.storagePath === ":memory:" ? `:memory:${randomUUID()}` : resolve(options.storagePath);
		this.#maxActive = integer(options.maxActiveRuns ?? 5, "maxActiveRuns", 10);
		this.#maxEval = integer(
			options.evalMaxActiveRuns ?? Math.min(5, this.#maxActive),
			"evalMaxActiveRuns",
			this.#maxActive,
		);
		this.#maxPending = integer(options.maxPending ?? 100, "maxPending");
		this.#queueTimeout = integer(options.queueWaitTimeoutMs ?? 300_000, "queueWaitTimeoutMs");
		this.#runTimeout = integer(options.runTimeoutMs ?? 600_000, "runTimeoutMs");
		this.#runTask = defineTask<RunInput, RunCheckpoint, RunReceipt, object>({
			name: "medical-query.run",
			version: 1,
			initial: () => ({ phase: "execute" }),
			phases: { execute: (task, runtime, taskContext) => this.#execute(task.input, runtime, taskContext) },
			abort: (task, runtime, taskContext) => this.#abort(task.input, task.abortReason, runtime, taskContext),
		});
	}

	/** 启动时先修复业务状态再恢复调度，绝不把未确认的模型/SQL 请求自动重放。 */
	static async open(options: RuntimeOptions): Promise<QueryRuntime> {
		const runtime = new QueryRuntime(options);
		if (openPaths.has(runtime.#path)) throw new RuntimeError("storage_in_use", "该存储已有运行实例持有");
		openPaths.add(runtime.#path);
		try {
			if (options.installationLockPath) runtime.#releaseInstallation = acquireRuntimeLock(options.installationLockPath);
			if (options.storagePath !== ":memory:") runtime.#releaseOwner = acquireRuntimeLock(runtime.#path);
			const registry = createRegistry();
			registry.install(defineExtension({ name: "medical-query", tasks: [runtime.#runTask] }));
			const storage = await openNodeSqliteStorage(options.storagePath);
			try {
				runtime.#harness = await Harness.open(storage, { models: createModels(), registry }, context);
			} catch (error) {
				await storage.close(context);
				throw error;
			}
			await runtime.#harness.commit(async (tx) => {
				const ledger = await tx.doc(OperationLedger);
				for (const operation of Object.values(ledger.operations)) {
					if (operation.status === "prepared") {
						operation.status = "not_sent";
						operation.reservationReleased = true;
					} else if (["dispatching", "in_flight"].includes(operation.status)) operation.status = "unknown";
				}
				for (const item of await runtime.#documents(tx)) {
					if (item.task.status !== "running") continue;
					const uncertain = Object.values(ledger.operations).some(
						(operation) => operation.turnId === item.task.id && operation.status === "unknown",
					);
					item.task.status = uncertain ? "reconciliation_required" : "interrupted";
					item.task.updatedAt = Date.now();
					item.task.endedAt = Date.now();
					item.task.error = { code: "restart_interrupted", message: "上次运行中断，未自动重放外部调用" };
					settleOpenTrace(item.task, "interrupted", item.task.error.message);
				}
			}, context);
			await options.onReady?.(runtime);
			runtime.#harness.resume();
			runtime.#kick();
			return runtime;
		} catch (error) {
			if (runtime.#harness) await runtime.#harness.close(context).catch(() => {});
			runtime.#releaseOwner?.();
			runtime.#releaseInstallation?.();
			openPaths.delete(runtime.#path);
			throw error;
		}
	}

	/** 去重和待准入名额在同一事务登记；内容不同时返回冲突而不复用旧答案。 */
	async enqueue(input: EnqueueInput): Promise<QueryTask> {
		this.#assertOpen();
		required(input.conversationId, "conversationId");
		required(input.requestId, "requestId");
		required(input.question, "question");
		const payload = { question: input.question, context: input.context ?? {} };
		canonical(payload);
		const task = await this.#harness.commit(async (tx) => {
			const index = await tx.doc(RuntimeIndex);
			const requestKey = keyOf([input.conversationId, input.requestId]);
			const prior = index.requests[requestKey];
			if (prior) {
				const existing = await this.#find(tx, prior);
				if (canonical({ question: existing.question, context: clone(existing.context) }) !== canonical(payload)) {
					throw new RuntimeError("request_conflict", "同一 requestId 不能提交不同内容");
				}
				return clone(existing);
			}
			await this.#requireExperimentOpen(tx, payload.context.experiment_id);
			// 数据源归属与首次入队处于同一提交，防止并发新请求把一个会话绑定到两个源。
			const siblings = (await this.#documents(tx)).filter(({ task }) => task.conversationId === input.conversationId);
			if (
				siblings.some(
					({ task }) => canonical(task.context.source_id ?? null) !== canonical(payload.context.source_id ?? null),
				)
			) {
				throw new RuntimeError("source_conflict", "切换数据源必须新建会话");
			}
			await this.#requirePendingCapacity(tx, payload.context.mode === "eval");
			const conversationKey = keyOf(input.conversationId);
			let conversationId = index.conversations[conversationKey] as ConversationId | undefined;
			if (conversationId === undefined) {
				conversationId = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
				index.conversations[conversationKey] = conversationId;
			}
			const now = Date.now();
			const id = randomUUID();
			const created: QueryTask = {
				id,
				turnId: id,
				conversationId: input.conversationId,
				requestId: input.requestId,
				question: input.question,
				context: clone(payload.context),
				status: "queued",
				runId: randomUUID(),
				replies: [],
				createdAt: now,
				updatedAt: now,
				queuedAt: now,
				queueDeadlineAt: now + this.#queueTimeout,
				clarificationRevision: 0,
			};
			(await tx.doc(QueryTurnDocument, conversationId, id, null)).task = created;
			index.turnIds.push(id);
			index.turns[id] = conversationId;
			index.requests[requestKey] = id;
			await tx.appendEntry(conversationId, {
				kind: "medical-query.input",
				data: { turnId: id, question: input.question },
			});
			return clone(created);
		}, context);
		this.#publish(task);
		this.#kick();
		return task;
	}

	// 实验暂停只阻止新准入；既有运行按原预算收尾，用户等待不消耗活动名额。
	async setExperimentPaused(experimentId: string, paused: boolean): Promise<void> {
		required(experimentId, "experimentId");
		await this.#harness.commit(async (tx) => {
			const ledger = await tx.doc(OperationLedger);
			if (!paused) await this.#requireExperimentOpen(tx, experimentId);
			const wasPaused = ledger.pausedExperiments.includes(experimentId);
			ledger.pausedExperiments = ledger.pausedExperiments.filter((id) => id !== experimentId);
			if (paused) ledger.pausedExperiments.push(experimentId);
			// 幂等恢复或重启重施不能续延等待期限，仅真实解除暂停时重新计时。
			else if (wasPaused)
				for (const { task } of await this.#documents(tx))
					if (task.context.experiment_id === experimentId && task.status === "queued")
						task.queueDeadlineAt = Date.now() + this.#queueTimeout;
		}, context);
		this.#kick();
	}

	/** 取消屏障与任务取消意图同提交；晚到入队、追问、预算或独立评分发送都不能穿过。 */
	async cancelExperiment(experimentId: string): Promise<void> {
		this.#assertOpen();
		required(experimentId, "experimentId");
		const tasks = await this.#harness.commit(async (tx) => {
			const ledger = await tx.doc(OperationLedger);
			ledger.cancelledExperiments ??= [];
			if (!ledger.cancelledExperiments.includes(experimentId)) ledger.cancelledExperiments.push(experimentId);
			if (!ledger.pausedExperiments.includes(experimentId)) ledger.pausedExperiments.push(experimentId);
			const pending = (await this.#documents(tx)).filter(
				({ task }) => task.context.experiment_id === experimentId && !terminal(task.status),
			);
			for (const { task } of pending) {
				task.cancelRequested = true;
				task.cancelReason ??= "experiment_cancelled";
				task.updatedAt = Date.now();
			}
			return pending.map(({ task }) => task.id);
		}, context);
		// Pi 传播取消并等待真实 handler 退出；账本未知预留不随本地任务终止而释放。
		await Promise.all(tasks.map((id) => this.#cancel(id, "experiment_cancelled")));
	}
	async #requireExperimentOpen(tx: Tx, experimentId: JsonValue | undefined): Promise<void> {
		if (
			typeof experimentId === "string" &&
			(await tx.doc(OperationLedger)).cancelledExperiments?.includes(experimentId)
		)
			throw new RuntimeError("experiment_cancelled", "实验已取消，不允许新增执行");
	}
	subscribeOperations(listener: (operation: OperationRecord) => void): () => void {
		this.#operationListeners.add(listener);
		return () => {
			this.#operationListeners.delete(listener);
		};
	}
	async listOperations(turnId?: string): Promise<OperationRecord[]> {
		return this.#harness.commit(
			async (tx) =>
				clone(
					Object.values((await tx.doc(OperationLedger)).operations).filter(
						(operation) => turnId === undefined || operation.turnId === turnId,
					),
				),
			context,
		);
	}
	// 全局索引展开时只克隆指定调用，保留输入、回执和处置历史的完整取证能力。
	async getOperation(id: string): Promise<OperationRecord> {
		this.#assertOpen();
		return this.#harness.commit(async (tx) => {
			const operations = (await tx.doc(OperationLedger)).operations;
			if (!Object.hasOwn(operations, id)) throw new RuntimeError("not_found", "调用不存在", 404);
			return clone(operations[id]);
		}, context);
	}
	// 旧状态页保留原有计数和未知调用索引，但不克隆全量输入与回执到 HTTP 层。
	async operationStatusSummary() {
		this.#assertOpen();
		return this.#harness.commit(async (tx) => {
			const ledger = await tx.doc(OperationLedger);
			const operation_counts: Record<string, number> = {};
			const operations: ReturnType<typeof operationIndex>[] = [];
			let unknown_total = 0;
			for (const operation of Object.values(ledger.operations)) {
				operation_counts[operation.status] = (operation_counts[operation.status] ?? 0) + 1;
				if (operation.status !== "unknown") continue;
				unknown_total++;
				if (operations.length < 100) operations.push(operationIndex(operation));
			}
			return { operation_counts, operations, unknown_total };
		}, context);
	}
	// 全局操作列表先过滤并计数，仅复制当前页索引；单轮取证仍由 listOperations 返回完整内容。
	async pageOperations(page: number, pageSize: number, status?: string | null) {
		this.#assertOpen();
		return this.#harness.commit(async (tx) => {
			const ledger = await tx.doc(OperationLedger);
			const items: ReturnType<typeof operationIndex>[] = [];
			const start = (page - 1) * pageSize;
			let total = 0;
			for (const operation of Object.values(ledger.operations)) {
				if (status && operation.status !== status) continue;
				if (total >= start && items.length < pageSize) items.push(operationIndex(operation));
				total++;
			}
			return { items, total, page, page_size: pageSize };
		}, context);
	}
	async prepareOperation(
		input: Omit<
			OperationRecord,
			"createdAt" | "updatedAt" | "dispatchedAt" | "status" | "epoch" | "reservationReleased" | "dispositions"
		>,
	): Promise<OperationRecord> {
		canonical(input);
		return this.#harness.commit(async (tx) => {
			const ledger = await tx.doc(OperationLedger);
			const previous = ledger.operations[input.id];
			if (previous) {
				if (previous.requestHash !== input.requestHash)
					throw new RuntimeError("operation_conflict", "同一操作不能更改请求");
				return clone(previous);
			}
			await this.#requireExperimentOpen(tx, input.scope.experiment_id);
			if (input.turnId) await this.#requireLiveRun(tx, input.turnId, input.runId);
			const operation: OperationRecord = {
				...clone(input),
				createdAt: Date.now(),
				updatedAt: Date.now(),
				status: "prepared",
				epoch: this.#epoch,
				reservationReleased: false,
				dispositions: [],
			};
			ledger.operations[operation.id] = operation;
			return clone(operation);
		}, context);
	}
	async dispatchOperation(id: string): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const operation = (await tx.doc(OperationLedger)).operations[id];
			if (!operation || operation.status !== "prepared" || operation.epoch !== this.#epoch)
				throw new RuntimeError("operation_not_dispatchable", "操作已发送或需对账，禁止重放");
			await this.#requireExperimentOpen(tx, operation.scope.experiment_id);
			if (operation.turnId) {
				const task = await this.#requireLiveRun(tx, operation.turnId, operation.runId);
				this.#consumeBudget(task, "modelCalls");
			} else {
				const limit = Number(operation.scope.call_limit);
				if (typeof operation.scope.budget_id !== "string" || !Number.isSafeInteger(limit) || limit < 1 || limit > 32)
					throw new RuntimeError("budget_required", "独立评分或索引调用必须提供有界预算身份", 400);
				const used = Object.values((await tx.doc(OperationLedger)).operations).filter(
					(item) =>
						item.scope.budget_id === operation.scope.budget_id && !["prepared", "not_sent"].includes(item.status),
				).length;
				if (used >= limit) throw new RuntimeError("budget_exhausted", "独立任务调用预算已耗尽", 422);
			}
			const dispatchedAt = Date.now();
			operation.status = "dispatching";
			operation.dispatchedAt = dispatchedAt;
			operation.updatedAt = dispatchedAt;
		}, context);
	}
	// 网络发送紧前再次检查持久取消意图；它不再计费或改变预算，只负责拦截晚到工作。
	async assertOperationActive(id: string): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const operation = (await tx.doc(OperationLedger)).operations[id];
			if (!operation || operation.epoch !== this.#epoch || operation.status !== "dispatching")
				throw new RuntimeError("operation_not_dispatchable", "操作已停止或已发送");
			await this.#requireExperimentOpen(tx, operation.scope.experiment_id);
			if (operation.turnId) await this.#requireLiveRun(tx, operation.turnId, operation.runId);
		}, context);
	}
	async settleOperation(id: string, status: OperationRecord["status"], receipt: JsonObject): Promise<OperationRecord> {
		canonical(receipt);
		const updated = await this.#harness.commit(async (tx) => {
			const operation = (await tx.doc(OperationLedger)).operations[id];
			if (!operation) throw new RuntimeError("operation_not_found", "调用记录不存在", 404);
			if (operation.epoch !== this.#epoch || !["prepared", "dispatching", "in_flight"].includes(operation.status))
				throw new RuntimeError("stale_operation", "迟到回执需显式对账，不得覆盖当前记录");
			operation.status = status;
			operation.receipt = clone(receipt);
			operation.updatedAt = Date.now();
			operation.reservationReleased = !["dispatching", "in_flight", "unknown", "prepared"].includes(status);
			return clone(operation);
		}, context);
		for (const listener of this.#operationListeners) listener(updated);
		return updated;
	}
	async reconcileOperation(id: string, input: ReconcileInput): Promise<OperationRecord> {
		for (const [key, value] of Object.entries({
			request_id: input.request_id,
			actor: input.actor,
			reason: input.reason,
		}))
			required(value, key);
		const updated = await this.#harness.commit(async (tx) => {
			const operation = (await tx.doc(OperationLedger)).operations[id];
			if (!operation) throw new RuntimeError("operation_not_found", "调用记录不存在", 404);
			const previous = operation.dispositions.find((item) => item.request_id === input.request_id);
			const disposition = { ...input, evidence: input.evidence ?? null };
			if (previous) {
				const { at: _at, ...prior } = clone(previous);
				if (canonical(prior) !== canonical(disposition)) throw new RuntimeError("request_conflict", "处置命令内容冲突");
				return clone(operation);
			}
			if (operation.status !== "unknown") throw new RuntimeError("operation_not_unknown", "仅未知调用可人工处置");
			if (input.action.startsWith("verified_") && (input.evidence === undefined || input.evidence === null))
				throw new RuntimeError("evidence_required", "已确认处置必须提供可核验依据", 400);
			operation.dispositions.push({ ...clone(disposition), at: Date.now() });
			operation.updatedAt = Date.now();
			if (input.action !== "keep") operation.reservationReleased = true;
			// 人工承担风险只释放本地预留，永不把远端未知改成未执行或零费用。
			if (input.action === "verified_complete") operation.status = "succeeded";
			if (input.action === "verified_terminated") operation.status = "failed";
			return clone(operation);
		}, context);
		for (const listener of this.#operationListeners) listener(updated);
		return updated;
	}
	async consumeBudget(
		turnId: string,
		runId: string,
		kind: "repairs" | "sqlExecutions" | "answerRepairs",
	): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const task = await this.#requireLiveRun(tx, turnId, runId);
			this.#consumeBudget(task, kind);
		}, context);
	}
	#consumeBudget(task: QueryTask, kind: "modelCalls" | "repairs" | "sqlExecutions" | "answerRepairs") {
		task.budget ??= { modelCalls: 0, repairs: 0, sqlExecutions: 0, answerRepairs: 0 };
		const budget = task.budget;
		const limit =
			kind === "modelCalls"
				? Number(task.context.model_call_limit ?? 8)
				: kind === "sqlExecutions"
					? 2
					: kind === "answerRepairs"
						? 1
						: Number(task.context.repair_limit ?? 1);
		if (
			!Number.isSafeInteger(limit) ||
			limit < 0 ||
			(kind === "repairs" && limit > 2) ||
			(kind === "modelCalls" && limit > 32) ||
			budget[kind] >= limit
		)
			throw new RuntimeError("budget_exhausted", `${kind}累计预算已耗尽`, 422);
		if (kind === "answerRepairs") this.#consumeBudget(task, "repairs");
		budget[kind]++;
	}
	async #requireLiveRun(tx: Tx, turnId: string, runId?: string): Promise<QueryTask> {
		const task = await this.#find(tx, turnId);
		await this.#requireExperimentOpen(tx, task.context.experiment_id);
		if (task.status !== "running" || task.runId !== runId || task.cancelRequested || this.#closing)
			throw new RuntimeError("execution_stopped", "当前执行已停止，不能发起新工作");
		return task;
	}
	async get(turnId: string): Promise<QueryTask | undefined> {
		this.#assertOpen();
		return this.#harness.commit(async (tx) => {
			const index = await tx.doc(RuntimeIndex);
			if (!Object.hasOwn(index.turns, turnId)) return undefined;
			return clone(await this.#find(tx, turnId));
		}, context);
	}

	async list(conversationId?: string): Promise<QueryTask[]> {
		this.#assertOpen();
		return this.#harness.commit(
			async (tx) =>
				(await this.#documents(tx))
					.filter(({ task }) => conversationId === undefined || task.conversationId === conversationId)
					.map(({ task }) => clone(task)),
			context,
		);
	}

	/** 回答、版本验证及队列占位原子完成；满队列保持原表单可答，重复已接受回答不再占位。 */
	async reply(input: ReplyInput): Promise<QueryTask> {
		this.#assertOpen();
		required(input.submissionId, "submissionId");
		canonical(input.answer);
		const task = await this.#harness.commit(async (tx) => {
			const found = await this.#find(tx, input.turnId);
			const prior = found.replies.find((reply) => reply.submissionId === input.submissionId);
			if (prior) {
				if (
					prior.clarificationId !== input.clarificationId ||
					prior.revision !== input.revision ||
					canonical(clone(prior.answer)) !== canonical(input.answer)
				) {
					throw new RuntimeError("submission_conflict", "同一 submissionId 不能提交不同回答");
				}
				return clone(found);
			}
			await this.#requireExperimentOpen(tx, found.context.experiment_id);
			if (
				found.status !== "waiting_for_user" ||
				found.clarification?.id !== input.clarificationId ||
				found.clarification.revision !== input.revision
			) {
				throw new RuntimeError("stale_clarification", "当前任务不等待此版本的追问回答");
			}
			await this.#requirePendingCapacity(tx, isEvaluation(found));
			const now = Date.now();
			found.replies.push({
				submissionId: input.submissionId,
				clarificationId: input.clarificationId,
				revision: input.revision,
				answer: clone(input.answer),
				acceptedAt: now,
			});
			found.status = "queued";
			found.runId = randomUUID();
			found.queuedAt = now;
			found.queueDeadlineAt = now + this.#queueTimeout;
			found.updatedAt = now;
			delete found.runStartedAt;
			delete found.runDeadlineAt;
			delete found.durableTaskId;
			delete found.endedAt;
			delete found.cancelRequested;
			delete found.cancelReason;
			delete found.error;
			// 新运行段清空当前展示快照，但累计调用及阶段事实跨追问保留，不覆盖原轮执行记录。
			const priorProgress = found.progress;
			if (priorProgress !== null && typeof priorProgress === "object" && !Array.isArray(priorProgress)) {
				const retained: JsonObject = {};
				for (const key of ["usage", "model_calls", "stages", "diagnostics", "repairs", "retrievals"])
					if (Array.isArray(priorProgress[key])) retained[key] = clone(priorProgress[key]);
				if (Object.keys(retained).length) found.progress = retained;
				else delete found.progress;
			} else delete found.progress;
			return clone(found);
		}, context);
		this.#publish(task);
		this.#kick();
		return task;
	}

	/** 活动任务先写取消意图，再由 Pi 传递信号；handler 真正退出后才释放活动名额。 */
	async cancel(turnId: string): Promise<QueryTask> {
		this.#assertOpen();
		return this.#cancel(turnId, "user_cancelled");
	}

	async stats(): Promise<RuntimeStats> {
		this.#assertOpen();
		// 状态面板只需计数；逐个读取当前文档，避免克隆并保留全部历史任务正文。
		return this.#harness.commit(async (tx) => {
			const index = await tx.doc(RuntimeIndex);
			let active = 0;
			let pending = 0;
			let evalActive = 0;
			for (const id of index.turnIds) {
				const task = await this.#find(tx, id);
				if (task.status === "running") {
					active++;
					if (isEvaluation(task)) evalActive++;
				} else if (task.status === "queued") pending++;
			}
			return { active, pending, peakActive: this.#peakActive, evalActive };
		}, context);
	}

	/** 关闭仅中止本进程调用并等待退出；未确认的运行留给下次启动标记 interrupted。 */
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closing = true;
		if (this.#queueTimer) clearTimeout(this.#queueTimer);
		this.#closePromise = (async () => {
			try {
				await this.#drainPromise;
				await this.#harness.close(context);
			} finally {
				this.#releaseOwner?.();
				this.#releaseInstallation?.();
				openPaths.delete(this.#path);
			}
		})();
		return this.#closePromise;
	}

	#assertOpen(): void {
		if (this.#closing) throw new RuntimeError("runtime_closed", "运行实例已关闭", 503);
	}

	async #find(tx: Tx, turnId: string): Promise<QueryTask> {
		const index = await tx.doc(RuntimeIndex);
		if (!Object.hasOwn(index.turns, turnId)) throw new RuntimeError("not_found", "任务不存在", 404);
		const document = await tx.doc(QueryTurnDocument, index.turns[turnId] as ConversationId, turnId, null);
		if (!document.task) throw new Error(`Missing query turn ${turnId}`);
		return document.task as QueryTask;
	}

	async #documents(tx: Tx): Promise<{ task: QueryTask; conversationId: ConversationId }[]> {
		const index = await tx.doc(RuntimeIndex);
		const result: { task: QueryTask; conversationId: ConversationId }[] = [];
		for (const id of index.turnIds)
			result.push({ task: await this.#find(tx, id), conversationId: index.turns[id] as ConversationId });
		return result;
	}

	async #requirePendingCapacity(tx: Tx, evaluation = false): Promise<void> {
		const pending = (await this.#documents(tx)).filter(({ task }) => task.status === "queued");
		const reserve = this.#options.onlineQueueReserve ?? Math.min(20, Math.floor(this.#maxPending / 5));
		if (
			pending.length >= this.#maxPending ||
			(evaluation && pending.filter(({ task }) => isEvaluation(task)).length >= this.#maxPending - reserve)
		) {
			throw new RuntimeError("queue_full", "待执行队列已满，请稍后重试", 429);
		}
	}

	#publish(task: QueryTask): void {
		try {
			const published = this.#options.onChange?.(clone(task));
			if (published) void published.catch((error) => this.#options.onError?.(error));
		} catch (error) {
			this.#options.onError?.(error);
		}
	}

	#kick(): void {
		if (this.#closing) return;
		this.#dirty = true;
		if (this.#draining) return;
		this.#draining = true;
		this.#drainPromise = Promise.resolve()
			.then(() => this.#drain())
			.catch((error) => this.#options.onError?.(error))
			.finally(() => {
				this.#draining = false;
				if (this.#dirty && !this.#closing) this.#kick();
			});
	}

	/** 只选择每个会话最早的未完成任务；待答任务保持会话归属，但不占活动名额。 */
	async #drain(): Promise<void> {
		while (this.#dirty && !this.#closing) {
			this.#dirty = false;
			const changed: QueryTask[] = [];
			let nextDeadline: number | undefined;
			let activeCount = 0;
			await this.#harness.commit(async (tx) => {
				const all = await this.#documents(tx);
				const paused = (await tx.doc(OperationLedger)).pausedExperiments;
				const now = Date.now();
				for (const { task } of all) {
					if (
						task.status === "queued" &&
						task.queueDeadlineAt <= now &&
						!paused.includes(String(task.context.experiment_id))
					) {
						task.status = "failed";
						task.updatedAt = now;
						task.endedAt = now;
						task.error = { code: "queue_timeout", message: "运行段等待准入超时" };
						changed.push(clone(task));
					}
				}
				activeCount = all.filter(({ task }) => task.status === "running").length;
				let evalCount = all.filter(({ task }) => task.status === "running" && isEvaluation(task)).length;
				const seen = new Set<string>();
				const eligible = all.filter(({ task }) => {
					if (terminal(task.status) || seen.has(task.conversationId)) return false;
					seen.add(task.conversationId);
					return task.status === "queued" && !paused.includes(String(task.context.experiment_id));
				});
				const activeScopes = all.filter(({ task }) => task.status === "running").map(({ task }) => taskScope(task));
				while (activeCount < this.#maxActive) {
					const selected = this.#selector.choose(
						eligible.filter(({ task }) => !isEvaluation(task) || evalCount < this.#maxEval),
						({ task }) => taskScope(task),
						activeScopes,
						this.#maxActive,
					);
					if (!selected) break;
					const { task, conversationId } = selected;
					eligible.splice(eligible.indexOf(selected), 1);
					activeScopes.push(taskScope(task));
					const id = await tx.createTask(
						this.#runTask,
						{ turnId: task.id, runId: task.runId },
						{
							conversationId,
							ownership: { kind: "conversation" },
							abandonOnRestart: true,
						},
					);
					task.status = "running";
					task.runStartedAt = now;
					task.runDeadlineAt = now + this.#runTimeout;
					task.updatedAt = now;
					task.durableTaskId = id;
					activeCount++;
					if (isEvaluation(task)) evalCount++;
					changed.push(clone(task));
				}
				for (const { task } of all)
					if (task.status === "queued" && !paused.includes(String(task.context.experiment_id)))
						nextDeadline = Math.min(nextDeadline ?? Infinity, task.queueDeadlineAt);
			}, context);
			this.#peakActive = Math.max(this.#peakActive, activeCount);
			for (const task of changed) this.#publish(task);
			if (this.#queueTimer) clearTimeout(this.#queueTimer);
			if (nextDeadline !== undefined && !this.#closing) {
				this.#queueTimer = setTimeout(
					() => this.#kick(),
					Math.min(2_147_483_647, Math.max(1, nextDeadline - Date.now())),
				);
				this.#queueTimer.unref();
			}
		}
	}

	async #cancel(turnId: string, reason: string): Promise<QueryTask> {
		const marked = await this.#harness.commit(async (tx) => {
			const task = await this.#find(tx, turnId);
			if (terminal(task.status)) return clone(task);
			task.updatedAt = Date.now();
			task.cancelRequested = true;
			task.cancelReason ??= reason;
			if (task.status !== "running") {
				task.status = reason === "run_timeout" ? "failed" : "cancelled";
				task.endedAt = Date.now();
				task.error = { code: reason, message: reason === "run_timeout" ? "运行段超时" : "用户已取消" };
			}
			return clone(task);
		}, context);
		this.#publish(marked);
		if (marked.status === "running" && marked.durableTaskId !== undefined) {
			await this.#harness.abortTask(marked.durableTaskId as TaskId, context);
			await this.#harness.waitForTask(marked.durableTaskId as TaskId, context);
		}
		this.#kick();
		return (await this.get(turnId))!;
	}

	/** 业务 handler 由 Pi 的真实 Task 调用；其输出与任务终态在同一次 Durable commit 内提交。 */
	async #execute(input: RunInput, runtime: RunRuntime, taskContext: Context): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const initial = await this.get(input.turnId);
			if (!initial || initial.runId !== input.runId || initial.status !== "running") {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: { status: "interrupted" } } }),
					taskContext,
				);
				return;
			}
			const remaining = initial.runDeadlineAt! - Date.now();
			if (remaining <= 0) throw new RuntimeError("run_timeout", "运行段超时");
			timer = setTimeout(
				() => {
					if (!this.#closing)
						void this.#cancel(input.turnId, "run_timeout").catch((error) => this.#options.onError?.(error));
				},
				Math.min(2_147_483_647, remaining),
			);
			timer.unref();
			const updateProgress = async (progress: JsonValue): Promise<void> => {
				canonical(progress);
				let updated: QueryTask | undefined;
				// 观察记录可在取消清理期间写入；不改变任务状态或准入，名额仍由 handler 退出后结算。
				await this.#harness.commit(async (tx) => {
					const task = await this.#find(tx, input.turnId);
					if (task.runId !== input.runId || task.status !== "running") return;
					const next = clone(progress);
					if (task.cancelRequested && next && typeof next === "object" && !Array.isArray(next)) {
						// 取消意图与发布在同一提交线上裁决，晚到观察不得偷偷新增数值或答案发布。
						const previous = task.progress;
						delete next.publication;
						if (previous && typeof previous === "object" && !Array.isArray(previous) && previous.publication)
							next.publication = clone(previous.publication);
					}
					task.progress = next;
					task.updatedAt = Date.now();
					updated = clone(task);
				}, context);
				if (updated) this.#publish(updated);
			};
			runtime.signal.throwIfAborted();
			const outcome = await this.#options.handler(initial, runtime.signal, updateProgress);
			runtime.signal.throwIfAborted();
			canonical(outcome);
			if (!["completed", "waiting_for_user", "blocked", "failed"].includes(outcome.status))
				throw new Error("Invalid handler outcome");
			let settled: QueryTask | undefined;
			await runtime.commit(async (tx) => {
				const task = await this.#find(tx, input.turnId);
				if (task.runId !== input.runId || task.status !== "running") throw new Error("Stale task completion");
				// 取消意图先于完成提交时，以取消为准；此时 handler 已退出，可以结算并释放名额。
				if (task.cancelRequested) {
					const reason = task.cancelReason ?? "user_cancelled";
					task.status = reason === "run_timeout" ? "failed" : "cancelled";
					task.updatedAt = Date.now();
					task.endedAt = Date.now();
					task.error = {
						code: reason,
						message: reason === "run_timeout" ? "运行段超时，底层调用已退出" : "用户已取消",
					};
					settleOpenTrace(task, task.status, task.error.message);
					settled = clone(task);
					return { status: "terminal", outcome: { status: "aborted" } };
				}
				task.status = outcome.status;
				task.updatedAt = Date.now();
				task.endedAt = Date.now();
				if (outcome.status === "waiting_for_user") {
					required(outcome.clarification.question, "clarification.question");
					task.clarificationRevision++;
					task.clarification = {
						...clone(outcome.clarification),
						id: randomUUID(),
						revision: task.clarificationRevision,
					};
				} else if (outcome.result !== undefined) task.result = clone(outcome.result);
				// 说明生成失败时仍保留已校验结果，业务失败与数据完整性不合并为一个成功标志。
				if (outcome.status === "failed")
					task.error = { code: "pipeline_failed", message: outcome.error ?? "任务未完整完成" };
				settled = clone(task);
				return { status: "terminal", outcome: { status: "completed", result: { status: task.status } } };
			}, taskContext);
			if (settled) this.#publish(settled);
		} catch (error) {
			// 取消时由 Pi 的 abort handler 在业务代码退出后结算；关闭时保留未确认运行供下次恢复。
			if (runtime.signal.aborted || this.#closing) throw error;
			let failed: QueryTask | undefined;
			await runtime.commit(async (tx) => {
				const task = await this.#find(tx, input.turnId);
				const unknown = Object.values((await tx.doc(OperationLedger)).operations).some(
					(operation) =>
						operation.turnId === task.id && operation.status === "unknown" && !operation.reservationReleased,
				);
				task.status = unknown ? "reconciliation_required" : "failed";
				task.updatedAt = Date.now();
				task.endedAt = Date.now();
				task.error = {
					code: unknown ? "external_call_unknown" : error instanceof RuntimeError ? error.code : "handler_error",
					message: error instanceof Error ? error.message : String(error),
				};
				settleOpenTrace(task, "failed", task.error.message);
				failed = clone(task);
				return { status: "terminal", outcome: { status: "failed", error: { message: task.error.message } } };
			}, taskContext);
			if (failed) this.#publish(failed);
		} finally {
			if (timer) clearTimeout(timer);
			this.#kick();
		}
	}

	async #abort(
		input: RunInput,
		abortReason: "restart" | undefined,
		runtime: RunRuntime,
		taskContext: Context,
	): Promise<void> {
		let ended: QueryTask | undefined;
		await runtime.commit(async (tx) => {
			const task = await this.#find(tx, input.turnId);
			if (task.runId === input.runId && task.status === "running") {
				const reason = abortReason === "restart" ? "restart_interrupted" : (task.cancelReason ?? "user_cancelled");
				task.status =
					reason === "restart_interrupted" ? "interrupted" : reason === "run_timeout" ? "failed" : "cancelled";
				task.updatedAt = Date.now();
				task.endedAt = Date.now();
				task.error = {
					code: reason,
					message:
						reason === "run_timeout"
							? "运行段超时，底层调用已退出"
							: reason === "restart_interrupted"
								? "上次运行中断，未自动重放"
								: "用户已取消",
				};
				settleOpenTrace(task, task.status, task.error.message);
				ended = clone(task);
			}
			return { status: "terminal", outcome: { status: "aborted" } };
		}, taskContext);
		if (ended) this.#publish(ended);
		this.#kick();
	}
}
