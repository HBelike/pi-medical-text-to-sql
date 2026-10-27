// 工作台只展示控制服务的权威记录；不在浏览器重算成绩、补造进度或推断未知调用已结束。
const el = (id) => document.getElementById(id);
const state = {
	view: "experiments",
	experimentId: "",
	experiment: null,
	tab: "slots",
	page: 1,
	pageSize: 20,
	slotPage: 1,
	scorePage: 1,
	scoreJobPage: 1,
	operationPage: 1,
	slotStatus: "",
	slotQuery: "",
	auto: true,
	request: null,
	sequence: 0,
	eventCursor: 0,
	events: [],
	modalSequence: 0,
	timer: null,
	loading: false,
	artifactCursors: [""],
	metadata: new Map(),
};
const titles = {
	experiments: ["实验", "把同一批问题交给多个运行方案，保留每次尝试、独立评分和完整证据。"],
	datasets: ["数据与知识", "检查题集覆盖、评分档位、知识与数据快照。正式口径缺口与合成数据分别保留。"],
	variants: ["运行方案", "冻结模型、检索和修复配置。实验开始后不随当前默认配置变化。"],
	comparisons: ["对比与归因", "先检查是否可比，再查看改善与退化；根因判断必须引用检查证据。"],
	releases: ["质量发布", "质量决定是否允许激活。耗时与费用提供参考，严重违规不能被平均成绩抵消。"],
	artifacts: ["产物存储", "完整调用、查询结果与修复记录保留至手动删除。删除前展示所有受影响引用。"],
};
const labels = {
	draft: "草稿",
	planned: "待派发",
	queued: "排队中",
	running: "运行中",
	pausing: "正在暂停",
	paused: "已暂停",
	cancelling: "正在停止",
	cancelled: "已取消",
	canceled: "已取消",
	completed: "已完成",
	succeeded: "执行完成",
	failed: "失败",
	blocked: "已阻断",
	interrupted: "已中断",
	waiting_for_user: "等待补充",
	reconciliation_required: "待对账",
	unknown: "结果未知",
	prepared: "已准备",
	dispatching: "正在派发",
	in_flight: "调用中",
	not_sent: "确认未发送",
	allow: "允许发布",
	deny: "拒绝发布",
	evidence_insufficient: "证据不足",
	pass: "通过",
	fail: "未通过",
	valid: "有效",
	invalid: "无效",
	incomplete: "不完整",
	partial: "部分保留",
	complete: "完整",
	artifact_deleted: "产物已删除",
	active: "已激活",
	inactive: "未激活",
	exploratory: "探索性比较",
	comparable: "可比较",
	not_comparable: "不可作严格比较",
	not_applicable: "不适用",
	not_evaluated: "未评判",
	linking: "指标与 Schema 匹配",
	result_only: "查询结果",
	task_complete: "完整任务",
	repair_off: "不修复",
	repair_on: "自动修复",
	ordinary_retry: "普通重试",
};
const goodStates = new Set(["allow", "pass", "succeeded", "completed", "valid", "complete", "active"]);
const badStates = new Set(["deny", "fail", "failed", "invalid", "artifact_deleted"]);
const warnStates = new Set([
	"unknown",
	"reconciliation_required",
	"evidence_insufficient",
	"incomplete",
	"partial",
	"blocked",
	"waiting_for_user",
]);
const mutations = new Map();
const timeFormat = new Intl.DateTimeFormat("zh-CN", {
	timeZone: "Asia/Shanghai",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
});

function node(tag, className, text) {
	const result = document.createElement(tag);
	if (className) result.className = className;
	if (text !== undefined && text !== null) result.textContent = String(text);
	return result;
}

function button(text, action, style = "") {
	const result = node("button", `eval-button ${style}`, text);
	result.type = "button";
	result.addEventListener("click", action);
	return result;
}

function link(text, action) {
	const result = button(text, action);
	result.className = "eval-link";
	return result;
}

function status(value) {
	const result = node("span", "eval-status", labels[value] || value || "未记录");
	result.dataset.tone = goodStates.has(value)
		? "good"
		: badStates.has(value)
			? "bad"
			: warnStates.has(value)
				? "warn"
				: "neutral";
	return result;
}

function date(value) {
	if (value === undefined || value === null || value === "") return "未记录";
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? String(value) : timeFormat.format(parsed);
}

function display(value) {
	return value === undefined || value === null
		? "未记录"
		: typeof value === "object"
			? JSON.stringify(value, null, 2)
			: String(value);
}

function bytes(value) {
	if (!Number.isFinite(value)) return "未记录";
	if (value < 1024) return `${value} B`;
	if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
	if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
	return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function unwrap(value) {
	return value?.data && typeof value.data === "object" && !Array.isArray(value.data) && value.id
		? {
				...value.data,
				id: value.id,
				revision: value.revision,
				created_at: value.created_at,
				updated_at: value.updated_at,
			}
		: value;
}

function rows(value) {
	return (Array.isArray(value) ? value : value?.items || []).map(unwrap);
}

function jsonDetails(title, value, open = false) {
	const details = node("details", "eval-json");
	details.open = open;
	details.append(node("summary", "", title), node("pre", "", display(value)));
	return details;
}

function definition(entries) {
	const result = node("dl", "eval-definition");
	for (const [name, value] of entries) {
		result.append(node("dt", "", name));
		const content = node("dd");
		content.append(value instanceof Node ? value : document.createTextNode(display(value)));
		result.append(content);
	}
	return result;
}

function section(title, ...content) {
	const result = node("section", "eval-section");
	result.append(node("h3", "", title), ...content);
	return result;
}

function empty(title, note, action) {
	const result = node("div", "eval-empty");
	result.append(node("strong", "", title), node("p", "", note));
	if (action) result.append(action);
	return result;
}

function table(headers, items, buildRow, caption) {
	const wrap = node("div", "eval-table-wrap");
	wrap.tabIndex = 0;
	wrap.setAttribute("role", "region");
	wrap.setAttribute("aria-label", caption);
	const result = node("table", "eval-table");
	const heading = node("tr");
	for (const title of headers) {
		const cell = node("th", "", title);
		cell.scope = "col";
		heading.append(cell);
	}
	const head = node("thead");
	head.append(heading);
	const body = node("tbody");
	for (const item of items) {
		const row = node("tr");
		for (const value of buildRow(item)) {
			const cell = node("td");
			cell.append(value instanceof Node ? value : document.createTextNode(display(value)));
			row.append(cell);
		}
		body.append(row);
	}
	result.append(node("caption", "sr-only", caption), head, body);
	wrap.append(result);
	return wrap;
}

function named(main, secondary) {
	const result = node("div");
	result.append(main instanceof Node ? main : document.createTextNode(display(main)));
	if (secondary !== undefined) result.append(node("small", "eval-muted eval-small", secondary));
	return result;
}

function actions(...items) {
	const result = node("div", "eval-actions");
	result.append(...items);
	return result;
}

function message(text, error = false) {
	const target = el(error ? "eval-error" : "eval-notice");
	target.textContent = text;
	target.hidden = !text;
	el("eval-announcement").textContent = text;
}

// 网络中断后的写命令保留幂等键；用户重试相同请求不会因为新键而重复创建实验。
async function api(path, options = {}) {
	const { body, method = "GET", signal } = options;
	const requestBody = body ? { ...body } : undefined;
	let fingerprint;
	if (method !== "GET") {
		fingerprint = `${method}:${path}:${JSON.stringify(body || {})}`;
		if (!mutations.has(fingerprint)) mutations.set(fingerprint, crypto.randomUUID());
		requestBody.idempotency_key ||= mutations.get(fingerprint);
	}
	const response = await fetch(`/api/eval${path}`, {
		method,
		credentials: "same-origin",
		signal,
		headers: { Accept: "application/json", ...(requestBody ? { "Content-Type": "application/json" } : {}) },
		...(requestBody ? { body: JSON.stringify(requestBody) } : {}),
	});
	let data;
	try {
		data = await response.json();
	} catch {
		throw new Error(`服务返回了无法读取的内容（HTTP ${response.status}）。请刷新后重试。`);
	}
	if (!response.ok) {
		const detail = typeof data.error === "object" ? data.error.message : data.error;
		const problem = new Error(data.message || detail || `请求未完成（HTTP ${response.status}）`);
		problem.code = data.code || data.error?.code;
		throw problem;
	}
	if (fingerprint) mutations.delete(fingerprint);
	return data;
}

async function registryItems(path) {
	// 选择器逐页读取登记元数据，避免第 101 个数据/方案/实验在表单里永久不可选。
	const entries = new Map();
	for (let page = 1; ; page++) {
		const response = await api(`${path}?page=${page}&page_size=100`),
			items = rows(response);
		for (const item of items) entries.set(item.id, item);
		if (items.length < 100 || (Number.isFinite(response.total) && page * 100 >= response.total))
			return [...entries.values()];
	}
}

function currentRoute() {
	const query = new URLSearchParams(location.search);
	state.view = Object.hasOwn(titles, query.get("view")) ? query.get("view") : "experiments";
	state.experimentId = state.view === "experiments" ? query.get("experiment") || "" : "";
}

function navigate(view, experimentId = "") {
	const query = new URLSearchParams({ view });
	if (experimentId) query.set("experiment", experimentId);
	history.pushState({}, "", `/evaluation?${query}`);
	state.page = 1;
	state.artifactCursors = [""];
	state.slotPage = 1;
	state.scorePage = 1;
	state.scoreJobPage = 1;
	state.operationPage = 1;
	state.tab = "slots";
	state.events = [];
	state.eventCursor = 0;
	currentRoute();
	refresh();
}

function pagination(data, length, page, onPage) {
	const result = node("div", "eval-pagination");
	const total = Number.isFinite(data.total) ? data.total : null;
	result.append(node("span", "", total === null ? `本页 ${length} 条` : `共 ${total} 条`));
	const previous = button("上一页", () => onPage(page - 1));
	previous.disabled = page <= 1;
	const next = button("下一页", () => onPage(page + 1));
	const pageSize = data.page_size || state.pageSize;
	next.disabled = total === null ? length < pageSize : page * pageSize >= total;
	result.append(actions(previous, node("span", "", `第 ${page} 页`), next));
	return result;
}

// 请求序号防止快速切换页签时，旧响应覆盖当前实验；自动刷新不会关闭正在填写的对话框。
async function refresh(quiet = false) {
	if (quiet && (state.loading || document.hidden || el("eval-dialog").open)) return;
	state.request?.abort();
	state.request = new AbortController();
	const sequence = ++state.sequence;
	state.loading = true;
	if (!quiet) {
		message("");
		message("", true);
		el("eval-content").setAttribute("aria-busy", "true");
		el("eval-content").replaceChildren(empty("正在读取记录", "连接同一控制服务，刷新不会重新派发任务。"));
	}
	const [title, description] = titles[state.view];
	el("eval-title").textContent = state.experimentId ? "实验详情" : title;
	el("eval-description").textContent = description;
	document.querySelectorAll("[data-view]").forEach((item) => {
		item.setAttribute("aria-current", item.dataset.view === state.view ? "page" : "false");
	});
	configurePageActions();
	try {
		const content = state.experimentId
			? await experimentPage(state.request.signal)
			: await collectionPage(state.request.signal);
		if (sequence !== state.sequence) return;
		const scroll = el("evaluation-main").scrollTop;
		el("eval-content").replaceChildren(content);
		if (quiet) el("evaluation-main").scrollTop = scroll;
	} catch (error) {
		if (error.name === "AbortError" || sequence !== state.sequence) return;
		message(error.message, true);
		if (!quiet)
			el("eval-content").replaceChildren(
				empty(
					"记录暂时无法读取",
					"检查服务是否正在运行，然后重新读取。已有实验不会因此取消。",
					button("重新读取", () => refresh()),
				),
			);
	} finally {
		if (sequence === state.sequence) {
			state.loading = false;
			el("eval-content").setAttribute("aria-busy", "false");
		}
	}
}

function configurePageActions() {
	const target = el("eval-page-actions");
	target.replaceChildren();
	if (state.experimentId) target.append(button("返回实验", () => navigate("experiments")));
	target.append(button("刷新", () => refresh()));
	const newActions = {
		experiments: ["创建实验", createExperiment],
		datasets: ["导入数据包", importDataset],
		variants: ["创建方案", createVariant],
		comparisons: ["创建对比", createComparison],
	};
	if (!state.experimentId && newActions[state.view]) {
		const [title, action] = newActions[state.view];
		target.append(button(title, action, "eval-button-primary"));
	}
}

async function collectionPage(signal) {
	const endpoint = state.view === "releases" ? "release-decisions" : state.view;
	const cursor =
		state.view === "artifacts" ? `&after=${encodeURIComponent(state.artifactCursors[state.page - 1] || "")}` : "";
	const data = await api(`/${endpoint}?page=${state.page}&page_size=${state.pageSize}${cursor}`, { signal });
	if (state.view === "artifacts") state.artifactCursors[state.page] = data.next_cursor || "";
	const items = rows(data);
	const fragment = node("div");
	if (data.capacity || data.storage) fragment.append(capacitySummary(data.capacity || data.storage));
	if (data.resources) fragment.append(section("共享资源", jsonDetails("查看控制端资源快照", data.resources)));
	if (!items.length) {
		const notes = {
			experiments: "先登记数据和运行方案，再创建实验。运行记录、失败与待对账状态都会保留。",
			datasets: "导入已有 benchmark 目录，或分别提供公共问题与独立 gold 文件。",
			variants: "创建并冻结 DeepSeek 模型、检索方式与修复预算，供实验选择。",
			comparisons: "选择已记录的基线与候选实验，声明允许变化项，生成可比性报告。",
			releases: "在实验详情中生成质量决定。证据不足的实验不会被当作通过。",
			artifacts: "执行与评分产物将在这里登记。服务不会因保留期限自动删除文件。",
		};
		fragment.append(empty("暂无记录", notes[state.view]));
		return fragment;
	}
	if (state.view === "experiments")
		fragment.append(
			table(
				["实验", "运行状态", "计划与进度", "数据版本", "更新时间", "操作"],
				items,
				(item) => [
					named(
						link(item.name || item.id, () => navigate("experiments", item.id)),
						item.id,
					),
					status(item.status || item.control_state),
					progressLabel(item.progress || item.counts),
					item.dataset_id,
					date(item.updated_at || item.created_at),
					link("查看实验", () => navigate("experiments", item.id)),
				],
				"实验列表",
			),
		);
	if (state.view === "datasets")
		fragment.append(
			table(
				["数据集", "覆盖", "评分档位", "版本", "操作"],
				items,
				(item) => [
					named(item.name || item.id, item.id),
					named(
						`${item.coverage?.total ?? item.case_count ?? "未记录"} 题`,
						item.coverage?.families === undefined ? "" : `${item.coverage.families} 个问题族`,
					),
					Object.entries(item.coverage?.profiles || {})
						.map(([key, count]) => `${labels[key] || key} ${count}`)
						.join("；") || "未记录",
					item.version || item.hash,
					link("查看覆盖与快照", () => datasetDetail(item)),
				],
				"数据版本列表",
			),
		);
	if (state.view === "variants")
		fragment.append(
			table(
				["方案", "决策 / 答案模型", "检索", "修复 / 调用预算", "操作"],
				items,
				(item) => [
					named(item.name || item.id, item.id),
					named(
						item.model_profile?.decision_model || item.decision_model,
						item.model_profile?.answer_model || item.answer_model,
					),
					item.retrieval_strategy || "未记录",
					`${item.repair_limit ?? "未记录"} / ${item.model_call_limit ?? "未记录"}`,
					link("查看冻结配置", () => showRecord("运行方案", `/variants/${encodeURIComponent(item.id)}`, item)),
				],
				"运行方案列表",
			),
		);
	if (state.view === "comparisons")
		fragment.append(
			table(
				["对比", "实验 / 基线", "对照 / 候选", "可比性", "创建时间", "操作"],
				items,
				(item) => [
					item.name || item.id,
					item.experiment_id || item.baseline_experiment_id || item.baseline_id,
					item.experiment_id ? "预注册三组对照" : item.candidate_experiment_id || item.candidate_id,
					status(
						item.comparable === false
							? "not_comparable"
							: item.comparable === true
								? "comparable"
								: item.comparability?.status || item.status,
					),
					date(item.created_at),
					link("查看对比与归因", () => comparisonDetail(item)),
				],
				"方案对比列表",
			),
		);
	if (state.view === "releases")
		fragment.append(
			table(
				["质量决定", "实验 / 方案", "判定", "配置指纹", "创建时间", "操作"],
				items,
				(item) => [
					item.id,
					named(item.experiment_id, item.variant_id),
					status(item.decision || item.status),
					item.config_hash || item.variant_hash || "未记录",
					date(item.created_at),
					actions(
						link("查看依据", () => releaseDetail(item)),
						...((item.decision || item.status) === "allow" ? [link("激活配置", () => activationForm(item))] : []),
					),
				],
				"质量发布记录",
			),
		);
	if (state.view === "artifacts")
		fragment.append(
			table(
				["产物", "类型", "大小", "完整性", "创建时间", "操作"],
				items,
				(item) => [
					item.id,
					item.kind || item.type,
					bytes(item.bytes),
					status(item.deleted_at ? "artifact_deleted" : item.completeness || "complete"),
					date(item.created_at),
					actions(
						...(item.deleted_at
							? []
							: [link("查看", () => artifactDetail(item)), link("删除影响", () => deletionForm(item))]),
					),
				],
				"完整产物与删除记录",
			),
		);
	fragment.append(
		pagination(data, items.length, state.page, (page) => {
			state.page = page;
			refresh();
		}),
	);
	return fragment;
}

function progressLabel(value) {
	if (!value) return "未记录";
	const total = value.planned ?? value.total;
	return [
		`计划 ${total ?? "未记录"}`,
		`完成 ${value.completed ?? value.succeeded ?? 0}`,
		`阻断 ${value.blocked ?? 0}`,
		`运行 ${value.running ?? 0}`,
		`待对账 ${value.reconciliation_required ?? 0}`,
	].join(" / ");
}

function capacitySummary(value) {
	return definition([
		["产物占用", bytes(value.artifact_bytes)],
		["可用空间", bytes(value.free_bytes)],
		["接收新工作", value.accepting === false ? "已背压，空间不足" : value.accepting === true ? "正常" : "未记录"],
		["保留规则", "直到手动删除；共享产物先核对引用影响"],
	]);
}

async function experimentPage(signal) {
	const record = await api(`/experiments/${encodeURIComponent(state.experimentId)}`, { signal });
	const experiment = unwrap(record.experiment || record);
	state.experiment = experiment;
	// 名称来自已冻结身份对应的登记记录；只补充展示，不用目录重算执行结果或成绩。
	if (!state.metadata.has(experiment.id)) {
		const [dataset, variants] = await Promise.all([
			api(`/datasets/${encodeURIComponent(experiment.dataset_id)}`, { signal }),
			Promise.all(experiment.variant_ids.map((id) => api(`/variants/${encodeURIComponent(id)}`, { signal }))),
		]);
		state.metadata.set(experiment.id, { dataset, variants });
	}
	el("eval-title").textContent = experiment.name || "实验详情";
	el("eval-description").textContent =
		`${experiment.id} · 修订 ${experiment.revision ?? "未记录"} · ${date(experiment.created_at)}`;
	const fragment = node("div");
	const progress = experiment.progress || record.progress || experiment.counts || {};
	const stats = node("dl", "eval-stat-row");
	for (const [title, value] of [
		["计划题次", progress.planned ?? progress.total],
		["已完成", progress.completed ?? progress.succeeded],
		["运行阻断", progress.blocked],
		["运行中", progress.running],
		["待对账", progress.reconciliation_required],
		["失败", progress.failed],
		["已评分", progress.scored],
	]) {
		const item = node("div", "eval-stat");
		item.append(node("dt", "", title), node("dd", "", value ?? "—"));
		stats.append(item);
	}
	fragment.append(stats);
	// 槽位列表不携带权威预期动作，不能把所有 blocked 当成功或错误；质量结论交给分轨评分。
	fragment.append(
		node(
			"p",
			"eval-inline-note",
			"以上是运行状态，不代表评分通过。阻断可能是预期的边界行为，也可能是应答题失败；请按题目预期与分轨评分判断。",
		),
	);
	const controls = actions(status(experiment.status || experiment.control_state));
	const actualState = experiment.status || experiment.control_state;
	for (const [command, title] of [
		["pause", "暂停派发"],
		["resume", "恢复执行"],
		["cancel", "停止实验"],
		["fork_retry", "派生重跑"],
	]) {
		const active = ["running", "queued", "pausing", "waiting_for_user"].includes(actualState);
		const allowed =
			command === "pause"
				? active && actualState !== "pausing"
				: command === "resume"
					? ["paused", "interrupted", "reconciliation_required"].includes(actualState)
					: command === "cancel"
						? active || actualState === "paused"
						: ["completed", "failed", "cancelled", "interrupted", "incomplete"].includes(actualState);
		const control = button(
			title,
			() => commandForm(command, experiment),
			command === "cancel" ? "eval-button-danger" : "",
		);
		control.disabled = !allowed;
		controls.append(control);
	}
	controls.append(
		button("重新评分", () => regradeForm(experiment)),
		button("检查发布资格", () => releaseForm(experiment)),
		button("导出实验", () => exportExperiment(experiment)),
	);
	fragment.append(controls);
	const sub = node("div", "eval-progress-line");
	sub.append(
		node("span", "", `待派发 ${progress.pending ?? "—"}`),
		node("span", "", `排队 ${progress.queued ?? "—"}`),
		node("span", "", `等待补充 ${progress.waiting_for_user ?? "—"}`),
		node("span", "", `已取消 ${progress.cancelled ?? "—"}`),
		node("span", "", `证据完整性：${labels[experiment.completeness] || experiment.completeness || "未记录"}`),
	);
	fragment.append(sub);
	if (experiment.error || experiment.recovery_reason)
		fragment.append(node("p", "eval-alert", experiment.error || experiment.recovery_reason));
	const tabs = node("div", "eval-tabs");
	tabs.setAttribute("role", "tablist");
	tabs.setAttribute("aria-label", "实验详情");
	for (const [key, name] of [
		["slots", "逐题记录"],
		["scores", "评分与归因"],
		["events", "运行事件"],
		["configuration", "冻结配置与资源"],
	]) {
		const tab = button(name, () => {
			state.tab = key;
			refresh();
		});
		tab.setAttribute("role", "tab");
		tab.setAttribute("aria-selected", String(state.tab === key));
		tabs.append(tab);
	}
	fragment.append(tabs);
	if (state.tab === "slots") fragment.append(await slotList(signal));
	if (state.tab === "scores") {
		const [scores, jobs] = await Promise.all([
			api(`/experiments/${encodeURIComponent(state.experimentId)}/score-sets?page=${state.scorePage}&page_size=5`, {
				signal,
			}),
			api(
				`/experiments/${encodeURIComponent(state.experimentId)}/score-jobs?page=${state.scoreJobPage}&page_size=${state.pageSize}`,
				{ signal },
			),
		]);
		const jobItems = rows(jobs);
		if (jobItems.length)
			fragment.append(
				section(
					"评分任务",
					table(
						["任务", "状态", "创建时间", "错误或评分版本"],
						jobItems,
						(job) => [
							job.id,
							status(job.status),
							date(job.created_at),
							job.error || job.score_set_id || "等待完成回执",
						],
						"独立评分任务状态",
					),
				),
			);
		if (jobItems.length)
			fragment.append(
				pagination(jobs, jobItems.length, state.scoreJobPage, (page) => {
					state.scoreJobPage = page;
					refresh();
				}),
			);
		const items = rows(scores);
		// 评分版本独立分页，保留历史可访问性，同时避免每次轮询下载整段重评历史。
		fragment.append(
			pagination(scores, items.length, state.scorePage, (page) => {
				state.scorePage = page;
				refresh();
			}),
		);
		if (!items.length)
			fragment.append(
				empty(
					"还没有评分记录",
					"执行产物保留后，可运行独立评分。缺失标注和缺失产物会分别记录。",
					button("运行评分", () => regradeForm(experiment)),
				),
			);
		for (const score of items) {
			fragment.append(scoreSummary(score));
		}
	}
	if (state.tab === "events") {
		const events = await api(
			`/experiments/${encodeURIComponent(state.experimentId)}/events?after=${state.eventCursor}&limit=200`,
			{ signal },
		);
		const merged = new Map(state.events.map((item) => [item.seq ?? item.id, item]));
		for (const event of rows(events)) merged.set(event.seq ?? event.id, event);
		state.events = [...merged.values()].slice(-1000);
		state.eventCursor = events.next_cursor ?? state.events.at(-1)?.seq ?? state.eventCursor;
		const list = node("ol", "eval-event-list");
		for (const event of state.events) {
			const item = node("li");
			const content = node("div");
			content.append(
				node("strong", "", event.type || event.name),
				jsonDetails(`事件 ${event.seq ?? event.id} · ${event.entity_id || ""}`, event.data || event),
			);
			item.append(node("time", "", date(event.created_at || event.timestamp)), content);
			list.append(item);
		}
		fragment.append(
			node(
				"p",
				"eval-inline-note",
				"按服务端序号读取事件，重连时去重。页面最多保留最近 1,000 条，完整记录仍在服务端。",
			),
			state.events.length ? list : empty("暂无运行事件", "开始执行后，派发、恢复、评分和控制操作会按顺序记录。"),
		);
	}
	if (state.tab === "configuration") {
		// 未知记录会在人工释放后继续保留，必须分页读全账本，不能只展示状态摘要的前 100 条。
		const [serviceStatus, operationRecords] = await Promise.all([
			api("/status", { signal }),
			api(`/operations?status=unknown&page=${state.operationPage}&page_size=25`, { signal }),
		]);
		fragment.append(
			definition([
				["数据版本", experiment.dataset_id],
				["运行方案", experiment.variant_ids],
				["独立重复", experiment.repeats],
				["活动任务上限", experiment.concurrency],
				["质量政策", experiment.quality_policy ?? "未配置；实验可执行，不能自动放行"],
				["允许差异", experiment.allowed_differences],
			]),
		);
		if (record.resources || experiment.resources || serviceStatus)
			fragment.append(
				section(
					"当前共享额度",
					jsonDetails("控制端资源、队列和未知占位", record.resources || experiment.resources || serviceStatus, true),
				),
			);
		const unknownOperations = rows(operationRecords);
		const unknownSection = section(
			"共享额度中的未知调用",
			node("p", "eval-inline-note", "此处包含全部实验的未知调用。人工释放仅改变本地额度，原调用仍保留未知状态。"),
		);
		for (const operation of unknownOperations) unknownSection.append(operationRow(operation));
		if (!unknownOperations.length) unknownSection.append(node("p", "eval-inline-note", "本页没有未知调用。"));
		unknownSection.append(
			pagination(operationRecords, unknownOperations.length, state.operationPage, (page) => {
				state.operationPage = page;
				refresh();
			}),
		);
		fragment.append(unknownSection);
		fragment.append(section("完整冻结记录", jsonDetails("查看配置、版本与快照指纹", experiment, true)));
	}
	return fragment;
}

// 比率只格式化服务端返回值，完整分母、未知和评测故障保持各自含义。
function scoreSummary(score) {
	const report = score.report || {},
		tracks = Object.entries(report.tracks || {});
	const result = section(
		`评分版本 ${score.id || score.version || "未记录"}`,
		definition([
			["报告有效性", status(report.status || score.validity || "unknown")],
			["计划 / 已评分", `${report.planned ?? "未记录"} / ${report.scored ?? "未记录"}`],
			["评分时间", date(score.created_at)],
			["观察指纹", score.observation_hash || score.artifact_id],
		]),
	);
	if (tracks.length)
		result.append(
			section(
				"分轨质量",
				table(
					["业务轨道", "通过 / 计划", "未通过", "未知或待评分", "通过率", "问题族"],
					tracks,
					([name, track]) => [
						name,
						`${track.numerator ?? "—"} / ${track.denominator ?? "—"}`,
						track.failed,
						track.unevaluated,
						Number.isFinite(track.value) ? `${(track.value * 100).toFixed(1)}%` : "不可判定",
						track.families,
					],
					"不同业务轨道的质量，不合并掩盖拒答与计算差异",
				),
			),
		);
	const checks = Object.entries(report.checks || {});
	if (checks.length)
		result.append(
			section(
				"检查结果",
				table(
					["检查项", "等级", "适用数", "通过", "失败", "未评判"],
					checks,
					([name, check]) => [
						name,
						check.severity === "critical" ? "严重约束" : "质量",
						check.applicable,
						check.passed,
						check.failed,
						check.unevaluated,
					],
					"独立检查结果",
				),
			),
		);
	if (score.repairs)
		result.append(section("整题修复", jsonDetails("首次失败、未知、触发与最终评分", score.repairs, true)));
	// 局部校验与整题成败使用各自分母，仅格式化服务端冻结摘要，不能在页面重新计算归因。
	if (score.stage_repairs) {
		result.append(
			section(
				"局部阶段修复",
				node("p", "eval-inline-note", "这里统计单个阶段的校验机会。局部修复通过不代表整题正确，也不构成因果结论。"),
				table(
					["阶段", "机会", "初始失败", "初始通过", "初始未知", "失败后触发", "恢复", "误触发", "有害修复"],
					Object.entries(score.stage_repairs.groups || {}),
					([stage, group]) => [stage, group.N, group.F, group.C, group.W, group.T, group.R, group.U, group.H],
					"按局部阶段的校验机会统计修复",
				),
				jsonDetails("逐阶段证据与修复引用", score.stage_repairs.opportunities || []),
			),
		);
	}
	if (score.performance) {
		const performance = score.performance;
		const metric = (value) =>
			value ? `${display(value.known_total)}（${value.unknown_calls ?? "未记录"} 次未知）` : "未记录";
		result.append(
			section(
				"耗时与费用参考",
				node("p", "eval-inline-note", "展示实际回执与墙钟耗时。缺失费用不按零处理；耗时与费用不参与质量发布门。"),
				definition([
					["模型调用", performance.calls],
					["费用", performance.cost == null ? "未完整记录" : performance.cost],
					["输入 token", metric(performance.input_tokens)],
					["输出 token", metric(performance.output_tokens)],
					["缓存读取 token", metric(performance.cache_read_tokens)],
					["模型队列累计 ms", metric(performance.model_queue_ms)],
					["模型调用累计 ms", metric(performance.model_duration_ms)],
					["端到端样本", performance.end_to_end?.count],
					[
						"端到端 p50 / p95 ms",
						`${display(performance.end_to_end?.p50_ms)} / ${display(performance.end_to_end?.p95_ms)}`,
					],
					[
						"分位数说明",
						performance.end_to_end?.p95_is_sample_max ? "不足 20 个样本，p95 等于样本最大值" : "按服务端样本分位数",
					],
				]),
			),
		);
	}
	if (Array.isArray(score.attribution) && score.attribution.length) {
		result.append(
			section(
				"逐题首次证据与归因",
				table(
					["题次", "首次状态", "证据基础", "修复触发", "归因证据"],
					score.attribution,
					(item) => [
						link(item.slot_id, () => slotDetail({ id: item.slot_id })),
						status(item.first?.status),
						item.first?.basis,
						item.repair_triggered === true ? "是" : "否",
						jsonDetails("首次判断与来源", { first: item.first, origin: item.origin }),
					],
					"首次观察与归因依据",
				),
			),
		);
	}
	if (Array.isArray(score.stability) && score.stability.length) {
		const probability = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "不可判定");
		result.append(
			section(
				"独立重复稳定性",
				node(
					"p",
					"eval-inline-note",
					"pass² / pass³ 表示独立抽取 2 / 3 次均通过的稳定性。有效次数不足或含未知时保留不可判定。",
				),
				table(
					["问题", "方案", "计划重复", "评分有效", "pass²", "pass³"],
					score.stability,
					(item) => [
						item.case_id,
						variantNameFor(item),
						item.planned,
						item.valid === true ? "有效" : "不可判定",
						probability(item.pass_2),
						probability(item.pass_3),
					],
					"重复运行稳定性，直接消费评分服务结果",
				),
			),
		);
	}
	result.append(jsonDetails("完整评分记录与逐题证据", score));
	return result;
}

async function exportExperiment(experiment) {
	try {
		const data = await api(`/experiments/${encodeURIComponent(experiment.id)}/export`);
		const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
		const anchor = node("a");
		anchor.href = url;
		anchor.download = `experiment-${experiment.id}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
		message("已导出服务端实验记录。完整性以包内清单为准。");
	} catch (error) {
		message(error.message, true);
	}
}

async function slotList(signal) {
	const query = new URLSearchParams({ page: String(state.slotPage), page_size: String(state.pageSize) });
	if (state.slotStatus) query.set("status", state.slotStatus);
	if (state.slotQuery) query.set("q", state.slotQuery);
	const data = await api(`/experiments/${encodeURIComponent(state.experimentId)}/slots?${query}`, { signal });
	const items = rows(data),
		fragment = node("div");
	const form = node("form", "eval-toolbar");
	const searchLabel = node("label", "", "题目 ID 或方案 ID");
	const search = node("input");
	search.type = "search";
	search.value = state.slotQuery;
	search.placeholder = "筛选逐题记录";
	searchLabel.append(search);
	const statusLabel = node("label", "", "执行状态"),
		select = node("select");
	for (const value of [
		"",
		"planned",
		"queued",
		"running",
		"succeeded",
		"completed",
		"failed",
		"blocked",
		"waiting_for_user",
		"reconciliation_required",
		"cancelled",
		"interrupted",
	]) {
		const option = node("option", "", value ? labels[value] : "全部状态");
		option.value = value;
		select.append(option);
	}
	select.value = state.slotStatus;
	statusLabel.append(select);
	const apply = button("筛选", () => {});
	apply.type = "submit";
	const autoLabel = node("label", "eval-auto"),
		auto = node("input");
	auto.type = "checkbox";
	auto.checked = state.auto;
	auto.addEventListener("change", () => {
		state.auto = auto.checked;
	});
	autoLabel.append(auto, document.createTextNode("自动刷新"));
	form.append(searchLabel, statusLabel, apply, autoLabel);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		state.slotQuery = search.value.trim();
		state.slotStatus = select.value;
		state.slotPage = 1;
		refresh();
	});
	fragment.append(form);
	if (!items.length)
		fragment.append(empty("没有符合条件的题次", "调整筛选条件，或等待实验派发。计划中的失败和未知题次不会被移除。"));
	else
		fragment.append(
			table(
				["题目", "方案 / 重复", "状态", "评分", "更新时间", "操作"],
				items,
				(item) => [
					named(item.question || questionFor(item), `${item.case_id} · ${item.id}`),
					named(
						item.variant_name || variantNameFor(item),
						`重复 ${Number.isFinite(item.repeat_index) ? item.repeat_index + 1 : "未记录"}`,
					),
					status(item.status),
					item.score_status ? status(item.score_status) : item.scored === true ? "已评分" : "待评分",
					date(item.updated_at),
					actions(
						link("展开证据", () => slotDetail(item)),
						link("提出裁定", () => adjudicationForm(item)),
					),
				],
				"逐题执行与评分记录",
			),
		);
	fragment.append(
		pagination(data, items.length, state.slotPage, (page) => {
			state.slotPage = page;
			refresh();
		}),
	);
	return fragment;
}

function questionFor(slot) {
	return (
		state.metadata
			.get(slot.experiment_id || state.experimentId)
			?.dataset.cases?.find((item) => item.id === slot.case_id)?.question || slot.case_id
	);
}

function variantNameFor(slot) {
	return (
		state.metadata.get(slot.experiment_id || state.experimentId)?.variants.find((item) => item.id === slot.variant_id)
			?.name || slot.variant_id
	);
}

async function datasetDetail(dataset) {
	const body = modal("数据与知识版本", dataset.id),
		sequence = state.modalSequence;
	try {
		const record = await api(`/datasets/${encodeURIComponent(dataset.id)}`);
		if (sequence !== state.modalSequence) return;
		body.append(
			definition([
				["名称", record.name],
				["版本", record.version],
				["内容指纹", record.hash],
				["题目数", record.coverage?.total],
				["问题族", record.coverage?.families],
			]),
		);
		body.append(
			section(
				"业务轨道覆盖",
				table(
					["轨道", "题数"],
					Object.entries(record.coverage?.tracks || {}),
					([name, count]) => [name, count],
					"题集业务覆盖",
				),
			),
		);
		body.append(
			section(
				"评测问题",
				table(
					["题目", "数据源", "问题"],
					record.cases || [],
					(item) => [item.id, item.source_id, item.question],
					"冻结问题列表",
				),
			),
		);
		body.append(jsonDetails("完整登记记录", record));
	} catch (error) {
		if (sequence === state.modalSequence) body.append(node("p", "eval-alert", error.message));
	}
}

function modal(title, description = "") {
	++state.modalSequence;
	el("eval-dialog-title").textContent = title;
	el("eval-dialog-description").textContent = description;
	const body = el("eval-dialog-body");
	body.replaceChildren();
	if (!el("eval-dialog").open) el("eval-dialog").showModal();
	return body;
}

async function showRecord(title, path, fallback) {
	const body = modal(title, fallback?.id || "");
	body.append(empty("正在读取详情", "完整记录由服务端返回。"));
	const sequence = state.modalSequence;
	try {
		const data = await api(path);
		if (sequence !== state.modalSequence) return;
		body.replaceChildren(jsonDetails("完整记录", unwrap(data), true));
	} catch (error) {
		if (sequence !== state.modalSequence) return;
		body.replaceChildren(node("p", "eval-alert", error.message));
		if (fallback) body.append(jsonDetails("列表中的已知记录（详情读取失败）", fallback, true));
	}
}

// 详情中的所有文本通过 textContent 写入；提示词、SQL 和外部输出不能作为页面脚本执行。
async function slotDetail(slot) {
	const body = modal("逐题执行证据", `${slot.case_id} · ${slot.id}`);
	body.append(empty("正在读取执行链", "保留首次尝试及后续修复，候选产物不代表已发布答案。"));
	const sequence = state.modalSequence;
	try {
		const record = await api(`/slots/${encodeURIComponent(slot.id)}`);
		if (sequence !== state.modalSequence) return;
		const item = unwrap(record.slot || record);
		body.replaceChildren(
			node("p", "eval-candidate", "以下包含工作台调试候选。只有通过必要校验并带发布记录的数值，才可视为已发布结果。"),
		);
		body.append(
			definition([
				["问题", item.question || record.turn?.question || slot.question || questionFor(item)],
				["状态", status(item.status)],
				["实验", item.experiment_id || state.experimentId],
				["当前执行", item.execution_id],
				["原始题次", item.origin_slot_id || "当前实验原始题次"],
			]),
		);
		// 控制服务返回实际执行观察，提示词和证据直接展示原始采集记录，缺失时不补造环节。
		if (record.observation || record.turn) body.append(observationDetails(record));
		const attempts = record.attempts || item.attempts || [];
		for (const attempt of attempts) {
			const block = node("section", "eval-attempt");
			block.append(node("h3", "", `尝试 ${attempt.id || attempt.execution_id || "未记录"}`), status(attempt.status));
			for (const operation of attempt.operations || []) block.append(operationRow(operation));
			for (const key of [
				"retrieval",
				"prompts",
				"outputs",
				"dsl",
				"sql",
				"parameters",
				"result",
				"checks",
				"diagnoses",
				"repairs",
				"publication",
				"events",
			]) {
				if (attempt[key] !== undefined)
					block.append(
						jsonDetails(
							{
								retrieval: "检索与口径依据",
								prompts: "实际提示词",
								outputs: "模型输出",
								dsl: "查询计划",
								sql: "SQL",
								parameters: "参数",
								result: "候选结果",
								checks: "校验依据",
								diagnoses: "归因与证据",
								repairs: "修复记录",
								publication: "数值发布记录",
								events: "尝试事件",
							}[key],
							attempt[key],
						),
					);
			}
			for (const artifact of attempt.artifacts || [])
				block.append(
					button(`查看产物 ${artifact.kind || artifact.id || artifact}`, () =>
						artifactDetail(typeof artifact === "string" ? { id: artifact } : artifact),
					),
				);
			block.append(jsonDetails("完整尝试记录", attempt));
			body.append(block);
		}
		for (const operation of record.operations || item.operations || []) body.append(operationRow(operation));
		for (const score of record.score_sets || item.score_sets || [])
			body.append(section(`评分 ${score.id || ""}`, jsonDetails("检查、分母与归因", score, true)));
		if (item.artifact_id)
			body.append(
				section(
					"执行产物",
					button("查看完整执行观察", () => artifactDetail({ id: item.artifact_id })),
				),
			);
		if (item.status === "waiting_for_user" && !item.artifact_id)
			body.append(button("补充当前任务", () => replyForm(item)));
		else if (record.turn?.status === "waiting_for_user")
			body.append(
				node(
					"p",
					"eval-notice",
					"本题已按单轮澄清观察封存。需要继续多轮验证时，请创建带回复脚本的新实验，保留本次观察与评分。",
				),
			);
		body.append(
			section(
				"复核",
				actions(
					button("提出 gold 裁定", () => adjudicationForm(item)),
					button("重新读取", () => slotDetail(slot)),
				),
			),
			jsonDetails("服务端完整详情", record),
		);
	} catch (error) {
		if (sequence === state.modalSequence) body.replaceChildren(node("p", "eval-alert", error.message));
	}
}

function observationDetails(record) {
	const turn = record.turn || {},
		observation = record.observation || {};
	const payload = observation.result || observation.progress || {};
	const result = section(
		"实际调用与证据",
		node("p", "eval-inline-note", "展示实际发送的提示词、收到的正文及每个环节的产物。候选数值不会因此获得发布资格。"),
	);
	if (turn.answer) result.append(section("答案", node("p", "eval-inline-note", turn.answer)));
	if (turn.clarification) result.append(jsonDetails("需要补充的口径", turn.clarification, true));
	for (const call of turn.model_calls || payload.model_calls || []) {
		const card = node("details", "eval-json");
		card.append(
			node(
				"summary",
				"",
				`${call.role} · ${call.model} · ${labels[call.status] || call.status} · ${call.duration_ms ?? "—"} ms`,
			),
		);
		const fields = node("div", "eval-prompt-fields");
		for (const [label, value] of [
			["system", call.system_prompt],
			["user", call.user_prompt],
			["收到的正文", call.output_text],
		]) {
			if (typeof value !== "string") continue;
			const group = node("label", "eval-field", label),
				area = node("textarea", "eval-source-input");
			area.readOnly = true;
			area.rows = 7;
			area.value = value;
			group.append(area);
			fields.append(group);
		}
		fields.append(jsonDetails("用量与回执", call));
		card.append(fields);
		result.append(card);
	}
	for (const stage of turn.stages || payload.stages || [])
		result.append(
			jsonDetails(
				`${stage.label || stage.kind} · ${labels[stage.status] || stage.status} · ${stage.duration_ms ?? "—"} ms`,
				stage,
			),
		);
	for (const [key, label] of [
		["retrievals", "检索收据"],
		["diagnostics", "失败归因"],
		["repairs", "修复过程"],
		["evidence", "查询与口径证据"],
		["publication", "发布校验记录"],
	]) {
		if (payload[key] !== undefined) result.append(jsonDetails(label, payload[key]));
	}
	return result;
}

function operationRow(operation) {
	const row = node("div", "eval-operation");
	// 全局未知调用列表只传定位索引；用户打开证据或对账窗口时按 ID 读取原调用正文。
	let fullOperation = operation.scope && operation.input ? operation : null;
	const readFullOperation = async () => {
		if (!fullOperation) fullOperation = unwrap(await api(`/operations/${encodeURIComponent(operation.id)}`));
		return fullOperation;
	};
	row.append(
		named(operation.role || operation.stage || operation.id, operation.id),
		status(operation.status || operation.state),
	);
	if (["unknown", "reconciliation_required"].includes(operation.status || operation.state)) {
		// 状态未知与额度占用是两个事实，释放预约不能在界面上被误读为调用已经成功或终止。
		row.append(
			node("span", "eval-inline-note", operation.reservationReleased ? "本地占位已释放；结果仍未知" : "仍保留本地占位"),
			button(operation.reservationReleased ? "补充对账" : "对账处置", async () => {
				try {
					reconciliationForm(await readFullOperation());
				} catch (error) {
					message(error.message, true);
				}
			}),
		);
	}
	if (operation.experiment_id) row.append(node("span", "eval-inline-note", `实验 ${operation.experiment_id}`));
	const details = jsonDetails("调用账本", fullOperation || "展开后读取完整调用账本");
	if (!fullOperation)
		details.addEventListener("toggle", async () => {
			if (!details.open || fullOperation) return;
			const pre = details.querySelector("pre");
			pre.textContent = "正在读取完整调用账本…";
			try {
				pre.textContent = display(await readFullOperation());
			} catch (error) {
				pre.textContent = error.message;
			}
		});
	row.append(details);
	return row;
}

async function artifactDetail(artifact) {
	const body = modal("完整产物", artifact.id);
	body.append(empty("正在读取产物", "读取内容指纹对应的完整记录。"));
	const sequence = state.modalSequence;
	try {
		const data = await api(`/artifacts/${encodeURIComponent(artifact.id)}`);
		if (sequence !== state.modalSequence) return;
		const content = data.content ?? data;
		const download = button("导出 JSON", () => {
			const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
			const anchor = node("a");
			anchor.href = url;
			anchor.download = `${artifact.id}.json`;
			anchor.click();
			URL.revokeObjectURL(url);
		});
		body.replaceChildren(
			node("p", "eval-inline-note", "此处显示真实产物。包含候选结果时，请同时核对其校验与发布记录。"),
			download,
			jsonDetails("完整内容", content, true),
		);
	} catch (error) {
		if (sequence === state.modalSequence) body.replaceChildren(node("p", "eval-alert", error.message));
	}
}

function field(
	form,
	name,
	label,
	{ type = "text", value, required = false, note = "", choices, min, max, rows: rowCount = 5 } = {},
) {
	const wrap = node("div", "eval-field"),
		labelNode = node("label", "", label);
	const id = `field-${name}-${state.modalSequence}`;
	labelNode.htmlFor = id;
	const input = node(choices ? "select" : type === "textarea" ? "textarea" : "input");
	input.id = id;
	input.name = name;
	input.required = required;
	if (!choices && type !== "textarea") input.type = type;
	if (type === "textarea") {
		input.rows = rowCount;
		input.spellcheck = false;
		input.className = "eval-source-input";
	}
	if (min !== undefined) input.min = String(min);
	if (max !== undefined) input.max = String(max);
	if (choices)
		for (const [optionValue, title] of choices) {
			const option = node("option", "", title);
			option.value = optionValue;
			input.append(option);
		}
	// 未指定默认值时使用首个真实选项；显式空选项保留，避免显示首项却提交空字符串。
	input.value = value ?? choices?.[0]?.[0] ?? "";
	wrap.append(labelNode, input);
	if (note) {
		const description = node("small", "", note);
		description.id = `${id}-note`;
		input.setAttribute("aria-describedby", description.id);
		wrap.append(description);
	}
	form.append(wrap);
	return input;
}

function jsonValue(input, fallback = {}) {
	if (!input.value.trim()) return fallback;
	let value;
	try {
		value = JSON.parse(input.value);
	} catch {
		throw new Error(`${input.labels?.[0]?.textContent || input.name} 不是合法 JSON。`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请填写 JSON 对象。");
	return value;
}

function formShell(title, description, submitText, work) {
	const body = modal(title, description),
		form = node("form", "eval-form");
	const error = node("div", "eval-alert eval-form-error");
	error.hidden = true;
	error.setAttribute("role", "alert");
	const fields = node("div", "eval-form");
	const submit = button(submitText, () => {}, "eval-button-primary");
	submit.type = "submit";
	const footer = node("div", "eval-form-footer");
	footer.append(
		button("关闭", () => el("eval-dialog").close()),
		submit,
	);
	form.append(fields, error, footer);
	body.append(form);
	const sequence = state.modalSequence;
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (submit.disabled) return;
		error.hidden = true;
		submit.disabled = true;
		submit.textContent = "正在提交…";
		try {
			const result = await work(fields);
			if (sequence !== state.modalSequence) return;
			el("eval-dialog").close();
			await refresh();
			message(result?.message || "操作已由控制服务记录。请以最新状态为准。");
		} catch (problem) {
			if (sequence !== state.modalSequence) return;
			error.textContent = `${problem.message}${problem.code === "revision_conflict" ? " 请关闭窗口并刷新，再核对最新修订。" : ""}`;
			error.hidden = false;
			error.scrollIntoView({ block: "nearest" });
		} finally {
			submit.disabled = false;
			submit.textContent = submitText;
		}
	});
	return { fields, submit, error };
}

async function createExperiment() {
	const body = modal("创建实验", "选定的数据、方案和质量政策将在创建时冻结，随后开始执行。");
	body.append(empty("正在读取可用版本", "实验使用固定版本，不读取执行过程中改变的默认配置。"));
	const sequence = state.modalSequence;
	try {
		const [datasets, variants] = await Promise.all([registryItems("/datasets"), registryItems("/variants")]);
		if (sequence !== state.modalSequence) return;
		if (!datasets.length || !variants.length) {
			body.replaceChildren(
				empty(
					"尚缺创建条件",
					`${datasets.length ? "" : "请先导入数据集。"}${variants.length ? "" : "请先创建运行方案。"}`,
				),
			);
			return;
		}
		let name, dataset, repeats, concurrency, policy, protocol;
		const variantInputs = [];
		const { fields } = formShell(
			"创建实验",
			"创建即冻结并启动。未设置质量政策的实验可运行，但不能自动获得发布资格。",
			"冻结并开始",
			async () => {
				const selected = variantInputs.filter((input) => input.checked).map((input) => input.value);
				if (!selected.length) throw new Error("至少选择一个运行方案。");
				const result = await api("/experiments", {
					method: "POST",
					body: {
						name: name.value.trim(),
						dataset_id: dataset.value,
						variant_ids: selected,
						repeats: Number(repeats.value),
						concurrency: Number(concurrency.value),
						quality_policy: jsonValue(policy, null),
						comparison_protocol: jsonValue(protocol, null),
					},
				});
				const experiment = unwrap(result.experiment || result);
				if (experiment.id) {
					state.experimentId = experiment.id;
					state.view = "experiments";
					history.replaceState({}, "", `/evaluation?view=experiments&experiment=${encodeURIComponent(experiment.id)}`);
				}
				return result;
			},
		);
		name = field(fields, "name", "实验名称", { required: true, note: "用名称说明本次要验证的差异。" });
		dataset = field(fields, "dataset", "数据版本", {
			choices: datasets.map((item) => [
				item.id,
				`${item.name || item.id}（${item.coverage?.total ?? item.case_count ?? "未知"} 题）`,
			]),
		});
		const checklist = node("fieldset", "eval-field");
		checklist.append(node("legend", "", "运行方案（可多选）"));
		const list = node("div", "eval-checklist");
		for (const variant of variants) {
			const label = node("label"),
				input = node("input");
			input.type = "checkbox";
			input.value = variant.id;
			const detail = node("span", "", variant.name || variant.id);
			detail.append(
				node(
					"small",
					"",
					`${variant.model_profile?.decision_model || "模型未记录"} / ${variant.retrieval_strategy || "检索未记录"} / 修复上限 ${variant.repair_limit ?? "未记录"}`,
				),
			);
			label.append(input, detail);
			list.append(label);
			variantInputs.push(input);
		}
		checklist.append(list);
		fields.append(checklist);
		const grid = node("div", "eval-form-grid");
		fields.append(grid);
		repeats = field(grid, "repeats", "独立重复次数", { type: "number", value: "1", min: 1, max: 100, required: true });
		concurrency = field(grid, "concurrency", "活动任务上限", {
			type: "number",
			value: "5",
			min: 1,
			max: 10,
			required: true,
			note: "受控制端共享额度约束；增加方案不会增加账号额度。",
		});
		fields.append(node("p", "eval-inline-note", "评分档位按题集逐题冻结。完整任务评分需要对应标注，不会运行后降档。"));
		policy = field(fields, "quality_policy", "预注册质量政策（JSON，可留空）", {
			type: "textarea",
			note: "使用已确认的质量阈值与覆盖要求。耗时、费用不作为否决项。留空不会自动放行。",
		});
		protocol = field(fields, "comparison_protocol", "预注册对照协议（JSON，可留空）", {
			type: "textarea",
			note: "严格三组对照需在执行前声明方案、允许变化及等预算字段。留空的跨实验对比仅作探索。",
		});
		fields.append(
			button("根据所选方案填写三组协议", () => {
				const selected = variants.filter((variant) =>
					variantInputs.some((input) => input.checked && input.value === variant.id),
				);
				const arms = selected.map((variant) => ({
					variant_id: variant.id,
					kind:
						variant.repair_policy === "ordinary_retry"
							? "ordinary_retry"
							: variant.repair_policy === "off" || variant.repair_limit === 0
								? "repair_off"
								: "repair_on",
				}));
				if (new Set(arms.map((arm) => arm.kind)).size !== 3) {
					protocol.setCustomValidity("请先分别选择不修复、定向修复和普通重试方案。");
					protocol.reportValidity();
					return;
				}
				protocol.setCustomValidity("");
				protocol.value = JSON.stringify(
					{
						arms,
						allowed_differences: ["repair_policy", "repair_limit"].map((path) => ({
							path,
							values: [...new Set(selected.map((variant) => variant[path]))],
						})),
						required_verified_paths: ["actual_model_revision"],
						equal_budget_paths: ["model_call_limit"],
						bootstrap_seed: 2026,
						bootstrap_repetitions: 1000,
					},
					null,
					2,
				);
			}),
		);
		protocol.addEventListener("input", () => protocol.setCustomValidity(""));
	} catch (error) {
		if (sequence === state.modalSequence) body.replaceChildren(node("p", "eval-alert", error.message));
	}
}

function importDataset() {
	let source, name, path, questions, gold;
	const { fields } = formShell(
		"导入数据版本",
		"公共问题与独立 gold 分开保存。服务端检查问题身份、标注和快照指纹。",
		"校验并登记",
		() =>
			api("/datasets", {
				method: "POST",
				body:
					source.value === "path"
						? { path: path.value.trim(), name: name.value.trim() }
						: { name: name.value.trim(), questions_jsonl: questions.value, gold_jsonl: gold.value },
			}),
	);
	source = field(fields, "source", "导入方式", {
		choices: [
			["path", "本机数据包目录"],
			["text", "公共问题与 gold 文本"],
		],
	});
	name = field(fields, "name", "数据集名称", { note: "可留空，沿用数据包版本名称。" });
	const pathGroup = node("div", "eval-form"),
		textGroup = node("div", "eval-form");
	fields.append(pathGroup, textGroup);
	textGroup.hidden = true;
	path = field(pathGroup, "path", "数据包绝对路径", {
		required: true,
		note: "使用包含 manifest.json、questions.jsonl 和 evaluation/gold.jsonl 的本机目录。",
	});
	questions = field(textGroup, "questions_jsonl", "公共问题 JSONL", {
		type: "textarea",
		note: "每行仅包含 id、source_id、question、as_of 四个字段。",
	});
	gold = field(textGroup, "gold_jsonl", "独立 gold JSONL", {
		type: "textarea",
		note: "只交给评测服务；产品问答请求不会携带这些标准答案。",
	});
	source.addEventListener("change", () => {
		const isPath = source.value === "path";
		pathGroup.hidden = !isPath;
		textGroup.hidden = isPath;
		path.required = isPath;
		questions.required = !isPath;
		gold.required = !isPath;
	});
}

function createVariant() {
	let name, decision, answer, retrieval, retrievalChars, retrievalTopK, repair, repairPolicy, calls;
	const { fields } = formShell(
		"创建运行方案",
		"方案记录实际模型与预算，创建后保留独立版本。不会在浏览器读取或保存 API key。",
		"冻结方案",
		() =>
			api("/variants", {
				method: "POST",
				body: {
					name: name.value.trim(),
					model_profile: {
						...(decision.value.trim() ? { decision_model: decision.value.trim() } : {}),
						...(answer.value.trim() ? { answer_model: answer.value.trim() } : {}),
					},
					retrieval_strategy: retrieval.value,
					retrieval_max_context_chars: Number(retrievalChars.value),
					retrieval_top_k: Number(retrievalTopK.value),
					repair_limit: Number(repair.value),
					repair_policy: repairPolicy.value,
					model_call_limit: Number(calls.value),
				},
			}),
	);
	name = field(fields, "name", "方案名称", { required: true });
	const models = node("div", "eval-form-grid");
	fields.append(models);
	decision = field(models, "decision_model", "决策模型 ID", {
		note: "留空使用控制服务的实际决策模型；显式指定时必须使用已配置的 DeepSeek 模型。",
	});
	answer = field(models, "answer_model", "答案模型 ID", { note: "留空使用控制服务的实际答案模型。" });
	fields.append(node("p", "eval-inline-note", "所有方案共享控制服务配置的同一账号额度；此处不另建并发池。"));
	retrieval = field(fields, "retrieval_strategy", "检索方式", {
		choices: [
			["progressive", "渐进披露：表索引与按需元信息"],
			["lexical", "结构化规则与词法检索"],
			["full_catalog", "全目录对照"],
		],
		note: "渐进披露允许依据明确缺项补读；词法与全目录可作为同题对照。",
	});
	// 检索预算与方案一同冻结，便于比较召回范围；必要依赖超限由服务明确报错。
	const retrievalLimits = node("div", "eval-form-grid");
	fields.append(retrievalLimits);
	retrievalChars = field(retrievalLimits, "retrieval_max_context_chars", "检索字符预算", {
		type: "number",
		min: 1000,
		max: 1000000,
		value: "256000",
		required: true,
		note: "按 Unicode 字符计量。完整规则及必要依赖超出预算时停止，并保存检索证据。",
	});
	retrievalTopK = field(retrievalLimits, "retrieval_top_k", "首轮候选表上限", {
		type: "number",
		min: 1,
		max: 100,
		value: "5",
		required: true,
		note: "渐进披露首轮最多读取5张直接业务表，必要关系和补读另行展开；全目录不按此数量裁剪。",
	});
	// 切换策略时只调整未由用户修改的默认预算，保留显式输入用于可复现实验。
	let defaultTopK = "5";
	retrieval.addEventListener("change", () => {
		const nextDefault = retrieval.value === "progressive" ? "5" : "12";
		if (retrievalTopK.value === defaultTopK) retrievalTopK.value = nextDefault;
		defaultTopK = nextDefault;
	});
	const limits = node("div", "eval-form-grid");
	repairPolicy = field(fields, "repair_policy", "修复对照方式", {
		choices: [
			["targeted", "根据检查证据定向修复"],
			["off", "不修复"],
			["ordinary_retry", "同预算普通重试"],
		],
	});
	fields.append(limits);
	repair = field(limits, "repair_limit", "语义修复上限", {
		type: "number",
		min: 0,
		max: 2,
		value: "1",
		required: true,
	});
	calls = field(limits, "model_call_limit", "每题模型调用上限", {
		type: "number",
		min: 1,
		max: 32,
		value: "8",
		required: true,
		note: "普通重试与修复均计入预算。",
	});
	repairPolicy.addEventListener("change", () => {
		if (repairPolicy.value === "off") {
			repair.value = "0";
			repair.disabled = true;
		} else {
			repair.disabled = false;
			if (Number(repair.value) < 1) repair.value = "1";
		}
	});
}

function commandForm(command, experiment) {
	const descriptions = {
		pause: "停止派发新题次，在途调用继续收尾。远端未知调用仍需要对账。",
		resume: "恢复确定可运行的工作；结果未知的调用不会自动重发。",
		cancel: "停止新增调用并请求终止本地工作。远端是否完成必须以账本回执为准。",
		fork_retry: "创建带新身份的重跑记录；原失败、未知调用及可能费用全部保留。",
	};
	let reason;
	const { fields } = formShell(
		{ pause: "暂停派发", resume: "恢复执行", cancel: "停止实验", fork_retry: "派生重跑" }[command],
		descriptions[command],
		"记录并执行",
		async () => {
			const result = await api(`/experiments/${encodeURIComponent(experiment.id)}/commands`, {
				method: "POST",
				body: { command, reason: reason.value.trim(), expected_revision: experiment.revision },
			});
			const next = unwrap(result.experiment || result);
			if (command === "fork_retry" && next.id && next.id !== experiment.id) {
				state.experimentId = next.id;
				state.tab = "slots";
				state.slotPage = 1;
				history.replaceState({}, "", `/evaluation?view=experiments&experiment=${encodeURIComponent(next.id)}`);
			}
			return result;
		},
	);
	fields.append(
		definition([
			["实验", experiment.name || experiment.id],
			["当前修订", experiment.revision],
			["当前状态", status(experiment.status || experiment.control_state)],
		]),
	);
	reason = field(fields, "reason", "操作说明", { type: "textarea", required: true, rows: 3 });
}

function regradeForm(experiment) {
	let reason;
	const { fields } = formShell(
		"重新评分",
		"使用已保留的执行观察生成新评分版本；不覆盖旧成绩，不重新运行产品问答。",
		"生成新评分版本",
		() =>
			api(`/experiments/${encodeURIComponent(experiment.id)}/score-sets`, {
				method: "POST",
				body: { expected_revision: experiment.revision, reason: reason.value.trim() },
			}),
	);
	reason = field(fields, "reason", "评分说明", {
		required: true,
		type: "textarea",
		rows: 3,
		note: "模型评分器若需新增调用，也必须经过共享额度并记录费用。",
	});
}

function reconciliationForm(operation) {
	let outcome, actor, reason, evidence;
	const { fields } = formShell(
		"处置未知调用",
		"先核对提供方回执与旧请求身份。接受未知风险不会把未知事实改写为未执行。",
		"保存对账决定",
		() =>
			api(`/operations/${encodeURIComponent(operation.id)}/reconcile`, {
				method: "POST",
				body: {
					action: outcome.value,
					actor: actor.value.trim(),
					reason: reason.value.trim(),
					evidence: jsonValue(evidence),
					expected_revision: operation.revision,
				},
			}),
	);
	fields.append(jsonDetails("原调用账本", operation));
	outcome = field(fields, "outcome", "对账结果", {
		choices: [
			["keep", operation.reservationReleased ? "保留未知结果（不恢复已释放占位）" : "继续等待 / 保持未知占位"],
			["verified_complete", "有证据证明调用完成"],
			["verified_terminated", "有证据证明未接受或已终止"],
			["manual_release", "明确接受未知风险并释放本地占位"],
		],
		note: "释放占位不会证明远端已停止；严格并发保证可能因此降级。",
	});
	actor = field(fields, "actor", "操作人", { required: true });
	reason = field(fields, "reason", "对账理由", { type: "textarea", required: true, rows: 3 });
	evidence = field(fields, "evidence", "回执与依据（JSON）", {
		type: "textarea",
		required: true,
		note: "记录提供方请求 ID、回执或人工判断依据，不填写密钥。",
	});
}

function replyForm(slot) {
	let reply;
	const { fields } = formShell(
		"补充当前任务",
		"回复保存在当前尝试中。暂停中的实验不会因为回复而隐式恢复。",
		"保存回复",
		() =>
			api(`/slots/${encodeURIComponent(slot.id)}/reply`, {
				method: "POST",
				body: {
					answer: reply.value.trim(),
					expected_revision: state.experiment?.revision,
				},
			}),
	);
	reply = field(fields, "reply", "补充内容", { required: true, type: "textarea" });
}

function adjudicationForm(slot) {
	let actor, reason, revisedGold;
	const { fields } = formShell(
		"提出 gold 裁定",
		"保存裁定理由与新标准答案。服务端定位全部受影响观察；不会直接手改某个方案的分数。",
		"登记裁定",
		() =>
			api("/adjudications", {
				method: "POST",
				body: {
					experiment_id: slot.experiment_id || state.experimentId,
					slot_id: slot.id,
					case_id: slot.case_id,
					actor: actor.value.trim(),
					reason: reason.value.trim(),
					revised_gold: jsonValue(revisedGold),
					expected_revision: state.experiment?.revision,
				},
			}),
	);
	fields.append(
		definition([
			["题目", slot.case_id],
			["题次", slot.id],
		]),
	);
	actor = field(fields, "actor", "裁定人", { required: true });
	reason = field(fields, "reason", "依据与理由", {
		type: "textarea",
		required: true,
		note: "说明原标注的问题并引用证据。裁定不改变已经发生的执行观察。",
	});
	revisedGold = field(fields, "revised_gold", "修订后的 gold（JSON）", { type: "textarea", required: true });
}

async function createComparison() {
	const body = modal("创建方案对比", "相同案例、快照和评分协议的配对才支持相应结论。");
	body.append(empty("正在读取实验", "选择基线与候选，声明允许变化项。"));
	const sequence = state.modalSequence;
	try {
		const experiments = await registryItems("/experiments");
		if (sequence !== state.modalSequence) return;
		if (!experiments.length) {
			body.replaceChildren(empty("尚无实验记录", "先创建带对照协议的多方案实验，或分别执行基线与候选。"));
			return;
		}
		let mode, baseline, candidate, differences;
		const { fields } = formShell(
			"创建方案对比",
			"允许变化项使用具体配置字段。未声明的漂移会使相关结论不可发布。",
			"生成对比报告",
			() => {
				if (mode.value === "preregistered")
					return api("/comparisons", { method: "POST", body: { experiment_id: baseline.value } });
				if (baseline.value === candidate.value) throw new Error("基线与候选必须是不同实验。");
				return api("/comparisons", {
					method: "POST",
					body: {
						baseline_experiment_id: baseline.value,
						candidate_experiment_id: candidate.value,
						allowed_differences: differences.value
							.split(/[,，\n]/)
							.map((value) => value.trim())
							.filter(Boolean),
					},
				});
			},
		);
		const choices = experiments.map((item) => [
			item.id,
			`${item.name || item.id}（${labels[item.status] || item.status || "未记录"}）`,
		]);
		mode = field(fields, "comparison_mode", "对比方式", {
			choices: [
				["preregistered", "单实验的预注册多方案对照"],
				["exploratory", "跨实验探索性对比"],
			],
		});
		baseline = field(fields, "baseline", "实验 / 基线实验", { choices });
		const crossFields = node("div", "eval-form");
		fields.append(crossFields);
		crossFields.hidden = true;
		candidate = field(crossFields, "candidate", "候选实验", {
			choices,
			value: experiments[1]?.id || experiments[0].id,
		});
		differences = field(crossFields, "allowed_differences", "允许变化的字段", {
			type: "textarea",
			required: false,
			rows: 3,
			note: "每行一个明确字段，例如 repair_limit。不要用通配符掩盖整体代码或知识漂移。",
		});
		mode.addEventListener("change", () => {
			crossFields.hidden = mode.value !== "exploratory";
			differences.required = mode.value === "exploratory";
		});
	} catch (error) {
		if (sequence === state.modalSequence) body.replaceChildren(node("p", "eval-alert", error.message));
	}
}

async function comparisonDetail(comparison) {
	const body = modal("方案对比与归因", comparison.id);
	body.append(empty("正在读取对比报告", "成绩与归因直接使用服务端记录。"));
	const sequence = state.modalSequence;
	try {
		const record = unwrap(await api(`/comparisons/${encodeURIComponent(comparison.id)}`));
		if (sequence !== state.modalSequence) return;
		body.replaceChildren(
			definition([
				[
					"可比性",
					status(
						record.comparable === false
							? "not_comparable"
							: record.comparable === true
								? "comparable"
								: record.comparability?.status || record.status,
					),
				],
				[
					"限制与原因",
					record.comparability?.errors || record.comparability?.reasons || record.errors || record.reasons,
				],
				["协议指纹", record.protocol_hash || record.comparability?.protocol_hash],
				["允许差异", record.allowed_differences || record.comparability?.differences],
			]),
		);
		if (record.experiment_id) {
			body.append(
				definition([
					["实验", record.experiment_id],
					["评分版本", record.score_set_id],
					["结论边界", record.causal_scope],
				]),
			);
			const reports = record.comparisons || record.diagnostic_comparisons;
			if (!record.comparable)
				body.append(
					node("p", "eval-candidate", "必要可比性条件未满足。以下配对数字仅用于排查，不构成修复有效性的严格结论。"),
				);
			if (reports)
				body.append(
					section(
						"配对统计",
						table(
							["对照", "配对数", "改善", "退化", "两组均通过", "差值", "区间"],
							Object.entries(reports),
							([name, report]) => [
								name,
								report.pairs,
								report.improvements,
								report.harms,
								report.both_pass,
								report.delta,
								report.interval
									? `${report.interval.lower} ～ ${report.interval.upper}（${report.interval.clusters} 个问题族）`
									: "未记录",
							],
							"服务端配对统计",
						),
					),
				);
			body.append(jsonDetails("完整对比报告", record));
			return;
		}
		const grid = node("div", "eval-compare-grid");
		grid.append(
			section("基线", jsonDetails("基线成绩与配置", record.baseline || record.baseline_experiment_id, true)),
			section("候选", jsonDetails("候选成绩与配置", record.candidate || record.candidate_experiment_id, true)),
		);
		body.append(
			grid,
			section("逐题改善、退化与未知", jsonDetails("配对结果", record.pairs || record.paired_results || record, true)),
			section(
				"归因与修复",
				jsonDetails(
					"首次 / 最终成绩、触发分母和证据",
					record.attribution || record.diagnosis || record.repairs || "报告未提供归因字段",
				),
			),
			jsonDetails("完整对比报告", record),
		);
	} catch (error) {
		if (sequence === state.modalSequence) body.replaceChildren(node("p", "eval-alert", error.message));
	}
}

function releaseForm(experiment) {
	let variant, score;
	const { fields } = formShell(
		"检查发布资格",
		"只检查冻结质量政策与证据。通过检查后仍需要单独激活配置。",
		"生成质量决定",
		() =>
			api("/release-decisions", {
				method: "POST",
				body: {
					experiment_id: experiment.id,
					variant_id: variant.value,
					...(score.value.trim() ? { score_set_id: score.value.trim() } : {}),
					expected_revision: experiment.revision,
				},
			}),
	);
	variant = field(fields, "variant", "运行方案", {
		choices: (experiment.variant_ids || []).map((id) => [
			id,
			variantNameFor({ variant_id: id, experiment_id: experiment.id }),
		]),
	});
	score = field(fields, "score_set_id", "评分版本 ID", {
		note: "可留空，由服务端选择并绑定最新有效评分；缺少充分证据时不能放行。",
	});
	fields.append(jsonDetails("实验冻结的质量政策", experiment.quality_policy ?? "未配置：只能生成证据不足决定", true));
}

async function releaseDetail(item) {
	const body = modal("质量发布依据", item.id);
	body.append(empty("正在读取质量决定", "决定与激活记录分别留存。"));
	const sequence = state.modalSequence;
	try {
		const record = unwrap(await api(`/release-decisions/${encodeURIComponent(item.id)}`));
		if (sequence !== state.modalSequence) return;
		body.replaceChildren(
			definition([
				["判定", status(record.decision || record.status)],
				["配置指纹", record.config_hash || record.variant_hash],
				["质量政策指纹", record.policy_hash || record.policy_version || record.policy_id],
				["说明", record.reasons || record.reason],
			]),
			jsonDetails("质量检查、严重违规与证据", record, true),
		);
		if ((record.decision || record.status) === "allow")
			body.append(button("激活此配置", () => activationForm(record), "eval-button-primary"));
		const activationReply = await api(`/activations?release_decision_id=${encodeURIComponent(item.id)}`);
		if (sequence === state.modalSequence) {
			const records = rows(activationReply);
			// 激活回执与允许发布分别展示，避免用户把“通过门槛”误认成已更新默认配置。
			body.append(
				section(
					"激活与回退记录",
					records.length
						? table(
								["激活回执", "操作人", "说明", "时间"],
								records,
								(item) => [item.id, item.actor, item.reason, date(item.created_at)],
								"控制服务已保存的配置激活回执",
							)
						: node("p", "eval-inline-note", "尚无此质量决定的激活回执。"),
					jsonDetails("完整激活历史", records),
				),
			);
		}
	} catch (error) {
		if (sequence === state.modalSequence) body.append(node("p", "eval-alert", error.message));
	}
}

function activationForm(decision) {
	let actor, reason;
	const { fields } = formShell(
		"激活已通过配置",
		"控制服务将再次核对配置指纹、质量政策与证据，并原子更新默认配置。正在执行的实验继续使用原冻结方案。",
		"激活配置",
		() =>
			api("/activations", {
				method: "POST",
				body: {
					release_decision_id: decision.id,
					actor: actor.value.trim(),
					reason: reason.value.trim(),
					expected_revision: decision.revision,
				},
			}),
	);
	fields.append(
		definition([
			["质量决定", decision.id],
			["配置指纹", decision.config_hash || decision.variant_hash],
			["实验", decision.experiment_id],
		]),
	);
	actor = field(fields, "actor", "操作人", { required: true });
	reason = field(fields, "reason", "激活或回退说明", {
		required: true,
		type: "textarea",
		rows: 3,
		note: "回退时选择历史上通过且证据仍有效的配置，重新记录激活。",
	});
}

async function deletionForm(artifact) {
	const body = modal("核对删除影响", artifact.id);
	body.append(empty("正在读取引用关系", "共享产物可能影响多个实验、历史重评和发布依据。"));
	const sequence = state.modalSequence;
	try {
		const impact = await api(`/artifacts/${encodeURIComponent(artifact.id)}/impact`);
		if (sequence !== state.modalSequence) return;
		const owners = Array.isArray(impact) ? impact : impact.affected || impact.owners || [];
		let actor, reason, confirmation;
		const { fields } = formShell(
			"手动删除产物",
			"删除完整正文会让相关历史无法完整重评。摘要与删除标记仍保留；此操作不自动删除其他产物。",
			"删除此产物",
			() => {
				if (confirmation.value !== "确认删除") throw new Error("请填写“确认删除”，表示已核对全部影响范围。");
				return api(`/artifacts/${encodeURIComponent(artifact.id)}`, {
					method: "DELETE",
					body: {
						owners,
						actor: actor.value.trim(),
						reason: reason.value.trim(),
						expected_revision: impact.revision ?? artifact.revision,
					},
				});
			},
		);
		fields.append(
			definition([
				["产物", artifact.id],
				["大小", bytes(artifact.bytes)],
				["全部受影响引用", owners.length ? owners.join("\n") : "未发现引用"],
			]),
			jsonDetails("完整删除影响", impact, true),
		);
		actor = field(fields, "actor", "操作人", { required: true });
		reason = field(fields, "reason", "删除理由", { required: true, type: "textarea", rows: 3 });
		confirmation = field(fields, "confirmation", "输入“确认删除”", { required: true });
	} catch (error) {
		if (sequence === state.modalSequence) body.replaceChildren(node("p", "eval-alert", error.message));
	}
}

// 主题与导航只影响界面；浏览器断线或关闭不会给服务器发送取消指令。
function updateTheme() {
	const dark = document.documentElement.dataset.theme === "dark";
	el("eval-theme").textContent = dark ? "白色主题" : "黑色主题";
	el("eval-theme").setAttribute("aria-pressed", String(dark));
	el("eval-theme").setAttribute("aria-label", dark ? "切换到白色主题" : "切换到黑色主题");
}
el("eval-theme").addEventListener("click", () => {
	const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
	document.documentElement.dataset.theme = theme;
	try {
		localStorage.setItem("medical-query-theme", theme);
	} catch {
		/* 当前页面仍然可用，不把偏好保存失败误报为实验故障。 */
	}
	updateTheme();
});
el("eval-dialog-close").addEventListener("click", () => el("eval-dialog").close());
el("eval-dialog").addEventListener("close", () => {
	++state.modalSequence;
});
document.querySelectorAll("[data-view]").forEach((item) => {
	item.addEventListener("click", (event) => {
		event.preventDefault();
		navigate(item.dataset.view);
	});
});
window.addEventListener("popstate", () => {
	state.page = 1;
	state.slotPage = 1;
	state.scorePage = 1;
	state.scoreJobPage = 1;
	state.operationPage = 1;
	state.tab = "slots";
	state.events = [];
	state.eventCursor = 0;
	currentRoute();
	refresh();
});
document.addEventListener("visibilitychange", () => {
	if (!document.hidden && state.auto) refresh(true);
});
state.timer = window.setInterval(() => {
	// 编辑筛选或选择证据文本时保持原视图，避免轮询替换焦点与选区。
	const active = document.activeElement;
	const interacting = active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
	const selectedText = window.getSelection()?.toString();
	if (state.auto && state.view === "experiments" && !interacting && !selectedText) refresh(true);
}, 5000);
updateTheme();
currentRoute();
refresh();
