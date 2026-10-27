// 新版评测中心只消费控制服务的冻结实验、评分和证据；未知值保持空缺，不在页面推断为正确或失败。
const byId = (id) => document.getElementById(id);
const pageState = {
	page: 1,
	pageSize: 10,
	query: "",
	datasetId: "",
	model: "",
	datasets: [],
	variants: [],
	defaultModels: { decision: "", answer: "" },
	items: [],
	runningTotal: 0,
	listSequence: 0,
	detailSequence: 0,
	detailId: "",
	detailExperiment: null,
	questionPage: 1,
	questionVerdict: "all",
	questionQuery: "",
	questionSequence: 0,
	formName: "",
	mutationKeys: new Map(),
	previewOpen: false,
};
const statuses = {
	running: "运行中",
	pausing: "暂停中",
	paused: "已暂停",
	cancelling: "取消中",
	cancelled: "已取消",
	completed: "已完成",
	incomplete: "未完成",
	planned: "待派发",
	queued: "排队中",
	failed: "失败",
	blocked: "已阻断",
	interrupted: "已中断",
	waiting_for_user: "待补充",
	reconciliation_required: "待对账",
};
const verdictLabels = { pass: "正确", fail: "错误", unknown: "不判定", unscored: "未评分" };
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
	timeZone: "Asia/Shanghai",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});
const fullDateFormat = new Intl.DateTimeFormat("zh-CN", {
	timeZone: "Asia/Shanghai",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
});

function make(tag, className = "", value) {
	const element = document.createElement(tag);
	if (className) element.className = className;
	if (value !== undefined && value !== null) element.textContent = String(value);
	return element;
}
function append(parent, ...children) {
	for (const child of children) if (child !== undefined && child !== null) parent.append(child);
	return parent;
}
function action(label, callback, className = "task-button") {
	const button = make("button", className, label);
	button.type = "button";
	button.addEventListener("click", callback);
	return button;
}
function text(value, fallback = "—") {
	if (value === null || value === undefined || value === "") return fallback;
	return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}
function timestamp(value, full = false) {
	const parsed = new Date(value);
	return value && !Number.isNaN(parsed.getTime()) ? (full ? fullDateFormat : dateFormat).format(parsed) : "—";
}
function percent(value) {
	return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}
function duration(value) {
	return typeof value === "number" && Number.isFinite(value)
		? value >= 1000
			? `${(value / 1000).toFixed(1)}s`
			: `${Math.round(value)}ms`
		: "—";
}
function datasetName(id) {
	return pageState.datasets.find((dataset) => dataset.id === id)?.name || id || "未记录";
}
function modelName(id) {
	return id || "未记录";
}
function notice(message) {
	byId("task-announcement").textContent = message;
}
function showError(id, message) {
	const target = byId(id);
	target.textContent = message || "";
	target.hidden = !message;
}
function mutationKey(kind, body) {
	const fingerprint = `${kind}:${JSON.stringify(body)}`;
	if (!pageState.mutationKeys.has(fingerprint)) pageState.mutationKeys.set(fingerprint, crypto.randomUUID());
	return pageState.mutationKeys.get(fingerprint);
}

// 写请求保持一次表单打开期间的幂等身份；断线重试不会多创建一个任务。
async function api(path, options = {}) {
	const response = await fetch(`/api/eval${path}`, {
		method: options.method || "GET",
		credentials: "same-origin",
		headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
		...(options.body ? { body: JSON.stringify(options.body) } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
	let data;
	try {
		data = await response.json();
	} catch {
		throw new Error(`服务响应无法读取（HTTP ${response.status}）`);
	}
	if (!response.ok) throw new Error(data.error || data.message || `请求失败（HTTP ${response.status}）`);
	return data;
}
async function allRegistry(collection) {
	const items = [];
	for (let page = 1; page <= 100; page++) {
		const result = await api(`/${collection}?page=${page}&page_size=100`);
		items.push(...result.items);
		if (items.length >= result.total || !result.items.length) break;
	}
	return items;
}
function setOptions(select, entries, placeholder) {
	const selected = select.value;
	select.replaceChildren(make("option", "", placeholder));
	select.firstChild.value = "";
	for (const [value, label] of entries) {
		const option = make("option", "", label);
		option.value = value;
		select.append(option);
	}
	select.value = entries.some(([value]) => value === selected) ? selected : "";
}

async function loadMetadata() {
	const [datasets, variants, current] = await Promise.all([
		allRegistry("datasets"),
		allRegistry("variants"),
		// 评测页只需要两项当前模型配置；轻量接口避免加载长期运行账本的统计正文。
		api("/config"),
	]);
	pageState.datasets = datasets;
	pageState.variants = variants;
	pageState.defaultModels = { decision: current.model || "", answer: current.answer_model || current.model || "" };
	const datasetChoices = datasets.map((item) => [item.id, `${item.name}（${item.coverage?.total ?? 0} 题）`]);
	setOptions(
		byId("dataset-filter"),
		datasets.map((item) => [item.id, item.name]),
		"全部评测集",
	);
	setOptions(byId("create-dataset"), datasetChoices, "选择评测集");
	const decisionModels = new Set(
		[current.model, ...variants.map((item) => item.model_profile?.decision_model)].filter(Boolean),
	);
	const answerModels = new Set(
		[current.answer_model, ...variants.map((item) => item.model_profile?.answer_model)].filter(Boolean),
	);
	setOptions(
		byId("model-filter"),
		[...answerModels].sort().map((item) => [item, item]),
		"全部模型",
	);
	setOptions(
		byId("create-decision-model"),
		[...decisionModels]
			.filter((item) => item.toLowerCase().includes("deepseek"))
			.sort()
			.map((item) => [item, item]),
		`当前配置（${current.model || "未配置"}）`,
	);
	setOptions(
		byId("create-answer-model"),
		[...answerModels].sort().map((item) => [item, item]),
		`当前配置（${current.answer_model || current.model || "未配置"}）`,
	);
	byId("dataset-filter").value = pageState.datasetId;
	byId("model-filter").value = pageState.model;
}

function statusBadge(value) {
	const badge = make("span", "task-status", statuses[value] || value || "未知");
	badge.dataset.tone = ["completed"].includes(value)
		? "good"
		: ["running", "pausing", "cancelling"].includes(value)
			? "running"
			: ["failed", "cancelled", "incomplete"].includes(value)
				? "bad"
				: "warn";
	return badge;
}
function verdictBadge(value) {
	const badge = make("span", "task-status", verdictLabels[value] || "未评分");
	badge.dataset.tone = value === "pass" ? "good" : value === "fail" ? "bad" : "warn";
	return badge;
}
function taskProgress(experiment) {
	const progress = experiment.progress || {};
	const total = Number(progress.planned) || 0;
	const done = ["completed", "blocked", "failed", "cancelled", "interrupted"].reduce(
		(sum, key) => sum + (Number(progress[key]) || 0),
		0,
	);
	const wrapper = make("div", "task-progress");
	const track = make("span", "task-progress-track");
	const fill = make("span", "task-progress-bar");
	fill.style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
	track.append(fill);
	append(wrapper, track, make("span", "", `${done}/${total}`));
	wrapper.title = "已终结题次 / 全部计划题次";
	return wrapper;
}
function taskRow(experiment) {
	const row = make("tr");
	const id = make("td", "", experiment.id?.slice(0, 8) || "—");
	id.title = experiment.id || "";
	const name = make("td");
	append(
		name,
		make("strong", "task-name", experiment.name || "未命名评测"),
		make(
			"span",
			"task-subtext",
			experiment.variant_ids?.length > 1 ? `${experiment.variant_ids.length} 个运行方案` : "单方案",
		),
	);
	const dataset = make("td", "", datasetName(experiment.dataset_id));
	dataset.title = datasetName(experiment.dataset_id);
	const concurrency = make("td", "", experiment.concurrency ?? "—");
	const state = make("td");
	state.append(statusBadge(experiment.status));
	const progress = make("td");
	progress.append(taskProgress(experiment));
	const accuracy = make("td");
	const accuracyValue = make("span", "task-accuracy", percent(experiment.accuracy?.judged));
	accuracyValue.title = experiment.accuracy?.judged_denominator
		? `已判定题次 ${experiment.accuracy.judged_denominator}；未判定与未评分不计入此分母`
		: "暂无可判定评分";
	if (typeof experiment.accuracy?.judged === "number" && experiment.accuracy.judged < 0.5)
		accuracyValue.dataset.tone = "bad";
	accuracy.append(accuracyValue);
	const time = make("td", "", timestamp(experiment.created_at));
	const controls = make("td");
	const actions = make("div", "task-row-actions");
	append(
		actions,
		action("详情", () => openDetail(experiment.id)),
	);
	if (["running", "pausing", "paused"].includes(experiment.status)) {
		append(
			actions,
			action("取消", () => cancelTask(experiment), "task-button task-button-danger"),
		);
	}
	controls.append(actions);
	append(row, id, name, dataset, concurrency, state, progress, accuracy, time, controls);
	return row;
}
function pagination(host, page, size, total, onPage, onSize) {
	host.replaceChildren();
	const pages = Math.max(1, Math.ceil(total / size));
	append(host, make("span", "", `共 ${total} 条`));
	if (onSize) {
		const selector = make("select");
		selector.setAttribute("aria-label", "每页条数");
		for (const amount of [10, 20, 50]) {
			const option = make("option", "", `${amount} / 页`);
			option.value = String(amount);
			selector.append(option);
		}
		selector.value = String(size);
		selector.addEventListener("change", () => onSize(Number(selector.value)));
		host.append(selector);
	}
	const previous = action("‹", () => onPage(page - 1));
	previous.disabled = page <= 1;
	previous.setAttribute("aria-label", "上一页");
	host.append(previous);
	const from = Math.max(1, page - 2),
		to = Math.min(pages, from + 4);
	for (let number = from; number <= to; number++) {
		const button = action(String(number), () => onPage(number));
		if (number === page) button.setAttribute("aria-current", "page");
		host.append(button);
	}
	const next = action("›", () => onPage(page + 1));
	next.disabled = page >= pages;
	next.setAttribute("aria-label", "下一页");
	append(host, next, make("span", "", `${page} / ${pages} 页`));
}

async function loadTasks(quiet = false) {
	const sequence = ++pageState.listSequence;
	if (!quiet) showError("task-error", "");
	const query = new URLSearchParams({ page: String(pageState.page), page_size: String(pageState.pageSize) });
	if (pageState.query) query.set("q", pageState.query);
	if (pageState.datasetId) query.set("dataset_id", pageState.datasetId);
	if (pageState.model) query.set("model", pageState.model);
	try {
		const result = await api(`/experiments?${query}`);
		if (sequence !== pageState.listSequence) return;
		pageState.items = result.items;
		pageState.runningTotal = Number(result.running_total) || 0;
		byId("task-count").textContent = String(result.total);
		byId("running-count").textContent = String(pageState.runningTotal);
		const body = byId("task-table-body");
		body.replaceChildren(...result.items.map(taskRow));
		byId("task-empty").hidden = Boolean(result.items.length);
		if (!result.items.length) {
			byId("task-empty").querySelector("strong").textContent =
				pageState.query || pageState.datasetId || pageState.model ? "没有符合条件的任务" : "暂无评测记录";
			byId("task-empty").querySelector("p").textContent =
				pageState.query || pageState.datasetId || pageState.model
					? "调整名称、评测集或模型筛选条件。"
					: "选择评测集并发起一次评测，结果会显示在这里。";
		}
		pagination(
			byId("task-pagination"),
			pageState.page,
			pageState.pageSize,
			result.total,
			(page) => {
				pageState.page = page;
				loadTasks();
			},
			(size) => {
				pageState.pageSize = size;
				pageState.page = 1;
				loadTasks();
			},
		);
		if (!result.items.length && pageState.page > 1 && result.total) {
			pageState.page = Math.max(1, Math.ceil(result.total / pageState.pageSize));
			await loadTasks();
		}
	} catch (error) {
		if (sequence === pageState.listSequence) showError("task-error", error.message);
	}
}

function section(title, ...children) {
	const element = make("section", "task-detail-section");
	append(element, make("h3", "task-detail-section-title", title), ...children);
	return element;
}
function metric(label, value, caption = "") {
	const card = make("div", "task-metric-card");
	append(card, make("span", "", label), make("strong", "", value));
	if (caption) card.append(make("small", "", caption));
	return card;
}
function info(label, value) {
	const group = make("div");
	append(group, make("dt", "", label), make("dd", "", value));
	return group;
}
function modelCard(label, value) {
	const card = make("div", "task-model-item");
	append(card, make("span", "", label), make("strong", "", value));
	return card;
}
function empty(message) {
	return make("p", "task-empty-message", message);
}
function barRow(label, amount, max, detail, tone = "") {
	const row = make("div", "task-bar-row");
	const track = make("div", "task-bar-track");
	const fill = make("span", "task-bar-fill");
	if (tone) fill.dataset.tone = tone;
	fill.style.width = `${max > 0 ? Math.max(2, Math.min(100, (amount / max) * 100)) : 0}%`;
	track.append(fill);
	append(row, make("span", "", label), track, make("strong", "", detail));
	return row;
}

// 抽屉先展现整次实验，再在同一滚动区内按页读取逐题记录。
async function openDetail(id) {
	const dialog = byId("detail-layer");
	if (!dialog.open) dialog.showModal();
	pageState.detailId = id;
	pageState.questionPage = 1;
	pageState.questionVerdict = "all";
	pageState.questionQuery = "";
	const sequence = ++pageState.detailSequence;
	byId("detail-title").textContent = `评测详情 · ${id.slice(0, 8)}`;
	byId("detail-body").replaceChildren(empty("正在读取评测详情…"));
	history.replaceState({}, "", `/evaluation/tasks?task=${encodeURIComponent(id)}`);
	try {
		const [experiment, overview] = await Promise.all([
			api(`/experiments/${encodeURIComponent(id)}`),
			api(`/experiments/${encodeURIComponent(id)}/overview`),
		]);
		if (sequence !== pageState.detailSequence) return;
		pageState.detailExperiment = experiment;
		byId("detail-title").textContent = `评测详情 · ${experiment.name || id}`;
		renderDetail(experiment, overview);
		await loadQuestions();
	} catch (error) {
		if (sequence === pageState.detailSequence)
			byId("detail-body").replaceChildren(make("p", "task-alert", error.message));
	}
}
function closeDetail() {
	pageState.detailSequence++;
	pageState.questionSequence++;
	pageState.detailId = "";
	pageState.detailExperiment = null;
	if (byId("detail-layer").open) byId("detail-layer").close();
	history.replaceState({}, "", "/evaluation/tasks");
}
function renderModels(experiment) {
	const grid = make("div", "task-model-grid");
	const variants = (experiment.variant_ids || [])
		.map((id) => pageState.variants.find((item) => item.id === id))
		.filter(Boolean);
	if (!variants.length) return empty("运行方案记录暂不可读。");
	for (const variant of variants) {
		if (variants.length > 1) grid.append(modelCard("运行方案", variant.name || variant.id));
		append(
			grid,
			modelCard("理解、规划与修复", modelName(variant.model_profile?.decision_model)),
			modelCard("答案生成", modelName(variant.model_profile?.answer_model)),
			modelCard("候选表选择", `${variant.retrieval_strategy || "未记录"} 检索`),
			modelCard("SQL 执行", "受约束编译与只读查询"),
		);
	}
	return grid;
}
function renderStageDurations(overview) {
	const container = make("div");
	const rows = overview.stage_durations || [];
	if (!rows.length) return empty("尚无可统计的阶段耗时。单题阶段记录仍可在下方查看。");
	const toolbar = make("div", "task-question-toolbar");
	const segments = make("div", "task-segments");
	const plot = make("div");
	let percentile = "p90_ms";
	const draw = () => {
		const max = Math.max(1, ...rows.map((item) => Number(item[percentile]) || 0));
		plot.replaceChildren(
			...rows.map((item) =>
				barRow(
					item.label || item.kind,
					Number(item[percentile]) || 0,
					max,
					`${duration(item[percentile])} · n=${item.count}`,
					"",
				),
			),
		);
		for (const button of segments.children)
			button.setAttribute("aria-pressed", String(button.dataset.metric === percentile));
	};
	for (const [key, label] of [
		["p50_ms", "p50"],
		["p90_ms", "p90"],
		["p95_ms", "p95"],
	]) {
		const button = action(
			label,
			() => {
				percentile = key;
				draw();
			},
			"",
		);
		button.dataset.metric = key;
		segments.append(button);
	}
	toolbar.append(segments);
	append(
		container,
		toolbar,
		plot,
		make("p", "task-detail-note", "阶段耗时仅统计留有完整阶段证据的题次；各阶段可有不同样本数。"),
	);
	draw();
	return container;
}
function renderFailures(overview) {
	const failures = overview.failure_reasons || [];
	if (!failures.length) return empty("当前评分中没有可归类的失败检查项。");
	const byCheck = new Map(),
		byReason = new Map();
	for (const item of failures) {
		byCheck.set(item.check_id, (byCheck.get(item.check_id) || 0) + item.count);
		byReason.set(item.reason_code, (byReason.get(item.reason_code) || 0) + item.count);
	}
	const groups = make("div", "task-analysis-grid");
	for (const [title, values] of [
		["失败检查项", byCheck],
		["原因码", byReason],
	]) {
		const card = make("div", "task-analysis-card");
		card.append(make("h4", "", title));
		const entries = [...values].sort((a, b) => b[1] - a[1]).slice(0, 7),
			max = entries[0]?.[1] || 1;
		for (const [label, count] of entries) card.append(barRow(label, count, max, String(count), "warn"));
		groups.append(card);
	}
	const details = make("details", "task-detail-note");
	details.append(make("summary", "", "查看检查项与原因码交叉统计"));
	const list = make("ul");
	for (const item of failures) list.append(make("li", "", `${item.check_id} / ${item.reason_code}：${item.count}`));
	details.append(list);
	return append(make("div"), groups, details);
}
function renderDetail(experiment, overview) {
	const host = byId("detail-body");
	const summary = make("dl", "task-detail-summary");
	append(
		summary,
		info("状态", statuses[experiment.status] || experiment.status),
		info("评测集", datasetName(experiment.dataset_id)),
		info("并发数", experiment.concurrency),
		info("题次", `${overview.total ?? experiment.progress?.planned ?? 0}`),
		info("创建时间", timestamp(experiment.created_at, true)),
		info("评测 ID", experiment.id),
	);
	const controls = make("div", "task-inline-actions");
	controls.append(action("刷新详情", () => openDetail(experiment.id)));
	if (["running", "pausing", "paused"].includes(experiment.status))
		controls.append(action("取消任务", () => cancelTask(experiment), "task-button task-button-danger"));
	const counters = overview.verdicts || {};
	const metrics = make("div", "task-metric-grid");
	append(
		metrics,
		metric(
			"已判定准确率",
			percent(overview.accuracy?.judged),
			`${counters.pass || 0} 正确 / ${overview.accuracy?.judged_denominator || 0} 已判定`,
		),
		metric(
			"全量通过率",
			percent(overview.accuracy?.all),
			`计划 ${overview.accuracy?.all_denominator || overview.total || 0} 题次；未评分时不显示百分比`,
		),
		metric("错误 / 未判定", `${counters.fail || 0} / ${counters.unknown || 0}`, "未判定不计入已判定准确率"),
		metric(
			"端到端 p50 / p95",
			`${duration(overview.duration_ms?.p50_ms)} / ${duration(overview.duration_ms?.p95_ms)}`,
			`有效耗时样本 ${overview.duration_ms?.count || 0}`,
		),
	);
	const evidence = overview.evidence || {};
	const evidenceNote = make(
		"p",
		"task-detail-note",
		`证据：${evidence.observations || 0} 条观察；${evidence.missing_artifacts || 0} 条缺失；${evidence.unreadable_artifacts || 0} 条不可读取。准确率基于最新评分版本，缺证据不算正确。`,
	);
	const questions = make("div");
	questions.id = "detail-questions";
	host.replaceChildren(
		controls,
		summary,
		section("模型覆盖", renderModels(experiment)),
		section("评分与耗时", metrics, evidenceNote),
		section("耗时分析（各阶段）", renderStageDurations(overview)),
		section("错误归因分析", renderFailures(overview)),
		section("逐题明细", questions),
	);
}

function questionSection() {
	const host = byId("detail-questions");
	const toolbar = make("div", "task-question-toolbar");
	const filters = make("div", "task-segments");
	for (const [value, label] of [
		["all", "全部"],
		["pass", "正确"],
		["fail", "错误"],
		["unknown", "不判定"],
		["unscored", "未评分"],
	]) {
		const button = action(
			label,
			() => {
				pageState.questionVerdict = value;
				pageState.questionPage = 1;
				loadQuestions();
			},
			"",
		);
		button.setAttribute("aria-pressed", String(pageState.questionVerdict === value));
		filters.append(button);
	}
	const search = make("input", "task-question-query");
	search.type = "search";
	search.placeholder = "搜索题号";
	search.setAttribute("aria-label", "搜索题号");
	search.value = pageState.questionQuery;
	search.addEventListener("change", () => {
		pageState.questionQuery = search.value.trim();
		pageState.questionPage = 1;
		loadQuestions();
	});
	search.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			search.blur();
		}
	});
	append(
		toolbar,
		filters,
		search,
		action("刷新", () => loadQuestions()),
	);
	const tableWrap = make("div", "task-question-table-wrap");
	const table = make("table", "task-question-table");
	const head = make("thead");
	const headRow = make("tr");
	for (const label of ["", "题号 / 问题", "判定", "耗时", "归因", "操作"]) headRow.append(make("th", "", label));
	head.append(headRow);
	const body = make("tbody");
	body.id = "question-table-body";
	append(table, head, body);
	tableWrap.append(table);
	const pages = make("nav", "task-pagination");
	pages.id = "question-pagination";
	host.replaceChildren(toolbar, tableWrap, pages);
	return body;
}
async function loadQuestions() {
	if (!pageState.detailId || !byId("detail-questions")) return;
	const experimentId = pageState.detailId,
		sequence = ++pageState.questionSequence;
	const body = questionSection();
	const loading = make("tr");
	const cell = make("td", "task-table-message", "正在读取逐题记录…");
	cell.colSpan = 6;
	loading.append(cell);
	body.append(loading);
	const query = new URLSearchParams({
		page: String(pageState.questionPage),
		page_size: "10",
		verdict: pageState.questionVerdict,
	});
	if (pageState.questionQuery) query.set("q", pageState.questionQuery);
	try {
		const result = await api(`/experiments/${encodeURIComponent(experimentId)}/questions?${query}`);
		if (sequence !== pageState.questionSequence || experimentId !== pageState.detailId) return;
		body.replaceChildren();
		if (!result.items.length) {
			const row = make("tr"),
				td = make("td", "task-table-message", "没有符合条件的题目");
			td.colSpan = 6;
			row.append(td);
			body.append(row);
		}
		for (const item of result.items) body.append(questionRow(item));
		pagination(byId("question-pagination"), pageState.questionPage, 10, result.total, (page) => {
			pageState.questionPage = page;
			loadQuestions();
		});
	} catch (error) {
		if (sequence === pageState.questionSequence) {
			const row = make("tr"),
				td = make("td", "task-table-message", error.message);
			td.colSpan = 6;
			row.append(td);
			body.replaceChildren(row);
		}
	}
}
function questionRow(item) {
	const row = make("tr", "task-question-row"),
		cells = [];
	const detailId = `question-detail-${item.id}`;
	const expand = action("›", () => toggleQuestion(row, item), "task-question-expand");
	expand.setAttribute("aria-label", `展开题目 ${item.case_id}`);
	expand.setAttribute("aria-expanded", "false");
	expand.setAttribute("aria-controls", detailId);
	const first = make("td");
	first.append(expand);
	cells.push(first);
	const question = make("td");
	append(
		question,
		make("strong", "task-name", item.case_id),
		make("span", "task-subtext", item.question || "题目文本未记录"),
	);
	cells.push(question);
	const verdict = make("td");
	verdict.append(verdictBadge(item.verdict));
	cells.push(verdict);
	cells.push(make("td", "", duration(item.duration_ms)));
	cells.push(make("td", "", item.error_category || "—"));
	const operation = make("td");
	const process = action("过程", () => toggleQuestion(row, item), "task-question-process");
	process.setAttribute("aria-expanded", "false");
	process.setAttribute("aria-controls", detailId);
	operation.append(process);
	cells.push(operation);
	append(row, ...cells);
	row.addEventListener("click", (event) => {
		if (!event.target.closest("button")) toggleQuestion(row, item);
	});
	return row;
}
async function toggleQuestion(row, item) {
	const next = row.nextElementSibling;
	if (next?.classList.contains("task-expanded-row")) {
		next.remove();
		for (const button of row.querySelectorAll("[aria-expanded]")) button.setAttribute("aria-expanded", "false");
		return;
	}
	const detailRow = make("tr", "task-expanded-row"),
		cell = make("td");
	detailRow.id = `question-detail-${item.id}`;
	cell.colSpan = 6;
	cell.append(make("div", "task-question-detail", "正在读取执行过程…"));
	detailRow.append(cell);
	row.after(detailRow);
	for (const button of row.querySelectorAll("[aria-expanded]")) button.setAttribute("aria-expanded", "true");
	const currentDetail = pageState.detailId;
	try {
		const record = await api(`/slots/${encodeURIComponent(item.id)}`);
		if (detailRow.isConnected && currentDetail === pageState.detailId)
			cell.replaceChildren(renderQuestionDetail(item, record));
	} catch (error) {
		if (detailRow.isConnected) cell.replaceChildren(make("div", "task-alert", error.message));
	}
}
function labelled(label, value, code = false) {
	const wrapper = make("div");
	const title = make("strong", "task-detail-label", label);
	const content = code ? make("pre", "task-code", text(value)) : make("p", "", text(value));
	append(wrapper, title, content);
	return wrapper;
}
function inspection(label, value) {
	const details = make("details", "task-trace-item");
	details.append(make("summary", "", label));
	details.append(make("pre", "task-code", text(value)));
	return details;
}
function renderQuestionDetail(item, record) {
	const turn = record.turn || {},
		gold = record.gold || null,
		evidence = turn.evidence || {};
	const stages = Array.isArray(turn.stages) ? turn.stages : [];
	// 成功执行阶段记录的 SQL 比页面摘要更完整；候选表与真正执行的 DSL 分开展示。
	const execution = [...stages]
		.reverse()
		.find((stage) => stage.kind === "execution" && stage.status === "completed" && stage.data?.result?.sql);
	const decision = [...stages].reverse().find((stage) => stage.kind === "decision" && stage.data?.linking);
	const actualSql = execution?.data?.result?.sql || evidence.sql || turn.result?.sql;
	const actualDsl = execution?.data?.dsl || evidence.dsl;
	const linking = evidence.linking || decision?.data?.linking;
	const scoreSet =
		pageState.detailExperiment?.score_set_applicability === "current"
			? record.score_sets?.find((set) => set.id === pageState.detailExperiment.latest_score_set_id)
			: undefined;
	const score = scoreSet?.scores?.find((entry) => entry.slot_id === item.id);
	const container = make("div", "task-question-detail");
	const grid = make("dl");
	const expected = gold?.expected_rows ?? gold?.expected_action ?? null;
	const answer = turn.answer ?? turn.publication?.answer ?? null;
	const pair = (label, value, code = false) => {
		const valueNode = make("dd");
		valueNode.append(code ? make("pre", "task-code", text(value)) : make("span", "", text(value)));
		append(grid, make("dt", "", label), valueNode);
	};
	pair("问题", item.question || turn.question || "未记录");
	pair("标准答案 / 预期动作", expected, typeof expected === "object");
	pair(
		"判定",
		`${verdictLabels[item.verdict] || "未评分"} · ${text(score?.evaluation_status || item.evaluation_status)}`,
	);
	pair(turn.publication ? "已发布回答" : "模型回答（未确认发布）", answer);
	pair("实际 SQL", actualSql || "此题未执行 SQL", Boolean(actualSql));
	pair("参考 SQL", gold?.reference_sql || "此题没有参考 SQL", Boolean(gold?.reference_sql));
	pair("候选表 / 关联", linking?.tables || linking || "未记录", true);
	if (actualDsl) pair("已执行 DSL", actualDsl, true);
	// 标准题集中的必需表不是本轮实际选表，不能用它补齐缺失的执行证据。
	if (gold?.required_tables) pair("标准必需表", gold.required_tables, true);
	pair("端到端耗时", duration(item.duration_ms));
	container.append(grid);
	if (item.error_categories?.length)
		container.append(
			labelled(
				"失败检查项",
				item.error_categories.map((entry) => `${entry.check_id} / ${entry.reason_code}`).join("；"),
			),
		);
	const traces = make("div", "task-trace-list");
	if (stages.length) {
		for (const stage of stages) {
			const call = turn.model_calls?.find((entry) => entry.id === stage.model_call_id);
			traces.append(
				inspection(
					`${stage.label || stage.kind} · ${statuses[stage.status] || stage.status || "未知"} · ${duration(stage.duration_ms)}`,
					{
						stage: stage.data,
						error: stage.error,
						model: call?.model,
						prompt: call?.system_prompt,
						input: call?.user_prompt,
						output: call?.output_text,
					},
				),
			);
		}
	} else traces.append(empty("当前题目没有阶段记录。"));
	container.append(section("执行过程", traces));
	const more = make("div", "task-trace-list");
	if (score) more.append(inspection("评分检查明细", score.checks));
	if (gold) more.append(inspection("完整标准记录", gold));
	if (turn.result) more.append(inspection("查询结果", turn.result));
	if (record.attempts?.length) more.append(inspection("执行历史与事件", record.attempts));
	container.append(section("完整证据", more));
	return container;
}

async function cancelTask(experiment) {
	if (!window.confirm(`取消评测“${experiment.name || experiment.id}”？已完成的题次和证据会保留。`)) return;
	try {
		await api(`/experiments/${encodeURIComponent(experiment.id)}/commands`, {
			method: "POST",
			body: {
				command: "cancel",
				reason: "用户在新版评测中心取消",
				expected_revision: experiment.revision,
				idempotency_key: crypto.randomUUID(),
			},
		});
		notice("已提交取消请求");
		await loadTasks();
		if (pageState.detailId === experiment.id) await openDetail(experiment.id);
	} catch (error) {
		showError("task-error", error.message);
	}
}

function openCreate() {
	pageState.formName = "";
	pageState.mutationKeys.clear();
	pageState.previewOpen = false;
	const preview = byId("dataset-preview-panel");
	if (preview) preview.hidden = true;
	showError("create-error", "");
	byId("create-form").reset();
	byId("create-concurrency").value = "1";
	byId("create-dialog").showModal();
}
function closeCreate() {
	byId("create-dialog").close();
}
function datasetPreview() {
	let panel = byId("dataset-preview-panel");
	if (!panel) {
		panel = make("div", "task-preview-panel");
		panel.id = "dataset-preview-panel";
		byId("create-dataset").closest(".task-form-dataset-row").after(panel);
	}
	pageState.previewOpen = !pageState.previewOpen;
	panel.hidden = !pageState.previewOpen;
	if (!pageState.previewOpen) return;
	const dataset = pageState.datasets.find((item) => item.id === byId("create-dataset").value);
	if (!dataset) {
		panel.textContent = "请先选择评测集。";
		return;
	}
	panel.replaceChildren(
		make("strong", "", `${dataset.name} · ${dataset.coverage?.total ?? dataset.cases?.length ?? 0} 题`),
	);
	const list = make("ol");
	for (const item of (dataset.cases || []).slice(0, 8)) list.append(make("li", "", `${item.id}　${item.question}`));
	panel.append(list);
	if ((dataset.cases || []).length > 8) panel.append(make("p", "", `仅预览前 8 题，共 ${dataset.cases.length} 题。`));
}
async function uploadDataset() {
	const questions = byId("questions-file").files[0],
		gold = byId("gold-file").files[0];
	const name = byId("dataset-name").value.trim();
	if (!name || !questions || !gold) {
		showError("create-error", "请填写评测集名称，并选择 questions.jsonl 与 gold.jsonl 两个文件。");
		return;
	}
	if (questions.size + gold.size > 7_500_000) {
		showError("create-error", "两份文件合计需小于 7.5 MB；较大的数据包请在旧版工作台按本机目录导入。");
		return;
	}
	const button = byId("upload-dataset");
	button.disabled = true;
	showError("create-error", "");
	try {
		const body = { name, questions_jsonl: await questions.text(), gold_jsonl: await gold.text() };
		// 大文件不进入幂等键缓存；文件元数据足以识别本次表单上传的重试。
		const uploadSignature = [name, questions.name, questions.size, questions.lastModified, gold.name, gold.size, gold.lastModified];
		const result = await api("/datasets", {
			method: "POST",
			body: { ...body, idempotency_key: mutationKey("dataset", uploadSignature) },
		});
		await loadMetadata();
		byId("create-dataset").value = result.id;
		notice(`已导入评测集：${result.name || name}`);
	} catch (error) {
		showError("create-error", error.message);
	} finally {
		button.disabled = false;
	}
}
async function submitCreate(event) {
	event.preventDefault();
	showError("create-error", "");
	const dataset = pageState.datasets.find((item) => item.id === byId("create-dataset").value);
	if (!dataset) {
		showError("create-error", "请选择评测集。");
		return;
	}
	const concurrency = Number(byId("create-concurrency").value);
	if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10) {
		showError("create-error", "并发数必须是 1 到 10 的整数。");
		return;
	}
	const name =
		byId("create-name").value.trim() ||
		pageState.formName ||
		`评测 · ${dataset.name} · ${fullDateFormat.format(new Date())}`;
	pageState.formName = name;
	const decision = byId("create-decision-model").value || pageState.defaultModels.decision;
	const answer = byId("create-answer-model").value || pageState.defaultModels.answer;
	if (!decision || !answer) {
		showError("create-error", "模型配置未读取到，请检查服务配置后重试。");
		return;
	}
	const button = byId("create-submit");
	button.disabled = true;
	button.textContent = "正在发起…";
	try {
		const variantBody = {
			name: `问答评测 · ${decision} / ${answer}`,
			model_profile: { decision_model: decision, answer_model: answer },
		};
		const variant = await api("/variants", {
			method: "POST",
			body: { ...variantBody, idempotency_key: mutationKey("variant", variantBody) },
		});
		const experimentBody = {
			name,
			dataset_id: dataset.id,
			variant_ids: [variant.id],
			concurrency,
			repeats: 1,
		};
		const experiment = await api("/experiments", {
			method: "POST",
			body: { ...experimentBody, idempotency_key: mutationKey("experiment", experimentBody) },
		});
		closeCreate();
		await loadMetadata();
		await loadTasks();
		notice(`已发起评测：${name}`);
		await openDetail(experiment.id);
	} catch (error) {
		showError("create-error", error.message);
	} finally {
		button.disabled = false;
		button.textContent = "开始评测";
	}
}

function setTheme() {
	const dark = document.documentElement.dataset.theme === "dark";
	byId("theme-button").textContent = dark ? "白色主题" : "黑色主题";
	byId("theme-button").setAttribute("aria-pressed", String(dark));
}
function bindEvents() {
	byId("theme-button").addEventListener("click", () => {
		const dark = document.documentElement.dataset.theme !== "dark";
		document.documentElement.dataset.theme = dark ? "dark" : "light";
		try {
			localStorage.setItem("medical-query-theme", dark ? "dark" : "light");
		} catch {
			/* 无持久存储时仅切换本页。 */
		}
		setTheme();
	});
	byId("refresh-button").addEventListener("click", () => loadTasks());
	byId("task-filters").addEventListener("submit", (event) => {
		event.preventDefault();
		pageState.query = byId("task-search").value.trim();
		pageState.datasetId = byId("dataset-filter").value;
		pageState.model = byId("model-filter").value;
		pageState.page = 1;
		loadTasks();
	});
	let searchTimer;
	byId("task-search").addEventListener("input", () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => byId("task-filters").requestSubmit(), 300);
	});
	for (const id of ["dataset-filter", "model-filter"])
		byId(id).addEventListener("change", () => byId("task-filters").requestSubmit());
	byId("detail-close").addEventListener("click", closeDetail);
	byId("detail-layer").addEventListener("cancel", (event) => {
		event.preventDefault();
		closeDetail();
	});
	byId("create-button").addEventListener("click", openCreate);
	byId("create-close").addEventListener("click", closeCreate);
	for (const button of document.querySelectorAll("[data-close-create]")) button.addEventListener("click", closeCreate);
	byId("create-dataset-preview").addEventListener("click", datasetPreview);
	byId("create-dataset").addEventListener("change", () => {
		pageState.previewOpen = false;
		const panel = byId("dataset-preview-panel");
		if (panel) panel.hidden = true;
	});
	byId("upload-dataset").addEventListener("click", uploadDataset);
	byId("create-form").addEventListener("submit", submitCreate);
	window.addEventListener("popstate", () => {
		const task = new URLSearchParams(location.search).get("task");
		if (task) openDetail(task);
		else if (byId("detail-layer").open) closeDetail();
	});
}

async function init() {
	setTheme();
	bindEvents();
	try {
		await loadMetadata();
		await loadTasks();
		const task = new URLSearchParams(location.search).get("task");
		if (task) await openDetail(task);
	} catch (error) {
		showError("task-error", error.message);
	}
	setInterval(() => {
		if (!document.hidden && pageState.runningTotal > 0) loadTasks(true);
	}, 10_000);
}
init();
