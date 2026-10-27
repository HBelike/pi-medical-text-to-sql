import { type QueryStatus, type QueryTask, RuntimeError } from "./runtime.ts";

type RecordValue = Record<string, unknown>;
export type HistoryQuery = {
	q: string;
	model: string;
	status: string;
	sourceId: string;
	since?: number;
	page: number;
	pageSize: number;
};
export type HistoryModel = { id: string | null; stage: string; model: string; status: string };
export type HistoryItem = {
	id: string;
	conversation_id: string;
	source_id: string;
	question: string;
	answer: string | null;
	error: string | null;
	clarification: string | null;
	status: QueryStatus;
	status_label: string;
	created_at: number;
	updated_at: number;
	tables: string[];
	table_kind: "queried" | "matched" | "none";
	models: HistoryModel[];
	mode: "online" | "eval";
};
export type HistoryPage = {
	items: HistoryItem[];
	total: number;
	page: number;
	page_size: number;
	facets: { models: string[]; statuses: { value: QueryStatus; label: string }[]; sources: string[] };
};

// 筛选使用任务原始状态；L0的具体阻断含义在行内解释，不把匹配完成当成指标计算成功。
const statusLabels: Record<QueryStatus, string> = {
	queued: "排队中",
	running: "处理中",
	waiting_for_user: "等待补充",
	completed: "已完成",
	blocked: "无法执行 / 尚不可计算",
	failed: "失败",
	cancelled: "已取消",
	interrupted: "已中断",
	// 结果未知与已停止分开显示，不能把可能仍执行的请求当作普通失败。
	reconciliation_required: "调用结果未知 · 需要对账",
};

function record(value: unknown): RecordValue {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}
function records(value: unknown): RecordValue[] {
	return Array.isArray(value) ? value.map(record) : [];
}
function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item) : [];
}

// 参数按公开合同严格校验；问题匹配是字面子串，%与_不会被解释为SQL通配符。
export function parseHistoryQuery(params: URLSearchParams): HistoryQuery {
	const allowed = new Set(["q", "model", "status", "source_id", "since", "page", "page_size"]);
	for (const key of params.keys()) {
		if (!allowed.has(key) || params.getAll(key).length !== 1)
			throw new RuntimeError("invalid_history_filter", `历史筛选参数 ${key} 未支持或重复`, 400);
	}
	const text = (key: string, max: number): string => {
		const value = params.get(key) ?? "";
		if (value.length > max) throw new RuntimeError("invalid_history_filter", `${key} 超过长度限制`, 400);
		return value.trim();
	};
	const pageNumber = (key: string, fallback: number, max: number): number => {
		const raw = params.get(key);
		if (raw === null) return fallback;
		const value = Number(raw);
		if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > max)
			throw new RuntimeError("invalid_history_filter", `${key} 必须为 1～${max} 的整数`, 400);
		return value;
	};
	const status = text("status", 32);
	if (status && !Object.hasOwn(statusLabels, status))
		throw new RuntimeError("invalid_history_filter", "历史应答状态无效", 400);
	const since = text("since", 64);
	let sinceTime: number | undefined;
	if (since) {
		// 必须携带时区并校验日历日期，拒绝Date.parse会自动滚动的2月30日等输入。
		const match = since.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
		sinceTime = Date.parse(since);
		const day = match ? new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`) : undefined;
		if (
			!match ||
			!Number.isFinite(sinceTime) ||
			!day ||
			day.getUTCFullYear() !== Number(match[1]) ||
			day.getUTCMonth() + 1 !== Number(match[2]) ||
			day.getUTCDate() !== Number(match[3]) ||
			Number(match[4]) > 23 ||
			Number(match[5]) > 59 ||
			Number(match[6]) > 59
		)
			throw new RuntimeError("invalid_history_filter", "since 必须为有效的带时区 ISO 时间", 400);
	}
	return {
		q: text("q", 4000),
		model: text("model", 256),
		status,
		sourceId: text("source_id", 128),
		...(sinceTime === undefined ? {} : { since: sinceTime }),
		page: pageNumber("page", 1, Number.MAX_SAFE_INTEGER),
		pageSize: pageNumber("page_size", 10, 100),
	};
}

// 只根据成功执行的DSL及同一运行段目录还原表；Linking候选不得冒充已查询表。
function queryTables(dsl: RecordValue, catalog: RecordValue): string[] | undefined {
	if (typeof dsl.from !== "string" || !dsl.from) return undefined;
	if (dsl.joins !== undefined && !Array.isArray(dsl.joins)) return undefined;
	const tables = new Set([dsl.from]);
	const relations = records(catalog.relations);
	for (const join of records(dsl.joins)) {
		const relation = relations.find((item) => typeof join.relation === "string" && item.id === join.relation);
		if (!relation || typeof relation.left_table !== "string" || typeof relation.right_table !== "string")
			return undefined;
		tables.add(relation.left_table);
		tables.add(relation.right_table);
	}
	return [...tables];
}

// 历史列表只投影已持久化事实，不读取当前源目录、凭据或配置，也不把诊断正文当业务答案。
export function historyItem(task: QueryTask): HistoryItem {
	const payload = record(task.result);
	const progress = record(task.progress);
	const evidence = record(payload.evidence ?? progress.evidence);
	const stages = records(Array.isArray(payload.stages) ? payload.stages : progress.stages);
	const calls = records(Array.isArray(payload.model_calls) ? payload.model_calls : progress.model_calls);
	const usage = records(Array.isArray(payload.usage) ? payload.usage : progress.usage);
	const usageIds = new Set(usage.map((call) => call.id).filter((id) => typeof id === "string"));
	// 旧usage可能没有调用ID；沿用摘要顺序补全调用详情，追问续跑后旧记录仍位于新调用前。
	const orderedCalls = usage.map((entry) => ({
		...entry,
		...calls.find((call) => typeof entry.id === "string" && call.id === entry.id),
	}));
	const models = [...orderedCalls, ...calls.filter((call) => typeof call.id !== "string" || !usageIds.has(call.id))]
		.filter((call) => typeof call.model === "string" && !!call.model)
		.map((call): HistoryModel => {
			const stage = typeof call.id === "string" ? stages.find((item) => item.model_call_id === call.id) : undefined;
			return {
				id: typeof call.id === "string" ? call.id : null,
				stage: typeof stage?.label === "string" ? stage.label : "历史调用（环节未记录）",
				model: String(call.model),
				status: typeof call.status === "string" ? call.status : "unrecorded",
			};
		});
	const latestDecision = [...stages].reverse().find((stage) => stage.kind === "decision");
	const decisionData = record(latestDecision?.data);
	const linking = record(
		evidence.linking ??
			progress.linking ??
			decisionData.linking ??
			(Array.isArray(decisionData.metric_ids) ? decisionData : undefined),
	);
	const matched = [...new Set(strings(linking.tables))];
	let tables = matched;
	let tableKind: HistoryItem["table_kind"] = matched.length ? "matched" : "none";
	const execution = [...stages]
		.reverse()
		.find(
			(stage) => stage.kind === "execution" && stage.status === "completed" && record(record(stage.data).result).sql,
		);
	const executionData = record(execution?.data);
	const result = record(executionData.result ?? payload.result ?? progress.data_result);
	if (evidence.profile !== "l0_schema_linking" && typeof result.sql === "string" && result.sql.trim()) {
		const catalogStage = [...stages]
			.reverse()
			.find(
				(stage) =>
					stage.kind === "catalog" &&
					stage.status === "completed" &&
					(!execution || (typeof execution.run_id === "string" && stage.run_id === execution.run_id)),
			);
		const actualTables = queryTables(
			record(executionData.dsl ?? evidence.dsl),
			record(record(catalogStage?.data).catalog),
		);
		if (actualTables?.length) {
			tables = actualTables;
			tableKind = "queried";
		}
	}
	const l0Blocked = task.status === "blocked" && evidence.profile === "l0_schema_linking";
	return {
		id: task.id,
		conversation_id: task.conversationId,
		source_id: typeof task.context.source_id === "string" ? task.context.source_id : "",
		question: task.question,
		answer: typeof payload.answer === "string" ? payload.answer : null,
		error: typeof task.error?.message === "string" ? task.error.message : null,
		clarification:
			task.status === "waiting_for_user" && typeof task.clarification?.question === "string"
				? task.clarification.question
				: null,
		status: task.status,
		status_label: l0Blocked
			? evidence.match_status === "no_match"
				? "未找到匹配指标"
				: "匹配完成 · 尚不可计算"
			: statusLabels[task.status],
		created_at: task.createdAt,
		updated_at: task.updatedAt,
		tables,
		table_kind: tableKind,
		models,
		mode: task.context.mode === "eval" ? "eval" : "online",
	};
}

// 首版复用现有运行文档；分页只返回轻量摘要，完整提示词、模型输出和结果通过已有详情接口读取。
export function historyPage(tasks: readonly QueryTask[], params: URLSearchParams): HistoryPage {
	const query = parseHistoryQuery(params);
	const all = tasks.map(historyItem);
	const filtered = all
		.filter(
			(item) =>
				(!query.q || item.question.toLocaleLowerCase().includes(query.q.toLocaleLowerCase())) &&
				(!query.model || item.models.some((call) => call.model === query.model)) &&
				(!query.status || item.status === query.status) &&
				(!query.sourceId || item.source_id === query.sourceId) &&
				(query.since === undefined || item.created_at >= query.since),
		)
		.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
	const page = Math.min(query.page, Math.max(1, Math.ceil(filtered.length / query.pageSize)));
	return {
		items: filtered.slice((page - 1) * query.pageSize, page * query.pageSize),
		total: filtered.length,
		page,
		page_size: query.pageSize,
		facets: {
			models: [...new Set(all.flatMap((item) => item.models.map((call) => call.model)))].sort(),
			statuses: (Object.entries(statusLabels) as [QueryStatus, string][]).map(([value, label]) => ({ value, label })),
			sources: [...new Set(all.map((item) => item.source_id).filter(Boolean))].sort(),
		},
	};
}
