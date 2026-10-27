// 历史页只读取持久化问答；筛选、分页和完整详情均以服务端记录为准，不补造模型或答案。
const byId = (id) => document.getElementById(id);
const initialQuery = new URLSearchParams(window.location.search);
const contextSource = initialQuery.get("source") || "";
const statusNames = {
	queued: "排队中",
	running: "处理中",
	waiting_for_user: "等待补充",
	completed: "已完成",
	failed: "失败",
	blocked: "无法执行 / 尚不可计算",
	cancelled: "已取消",
	canceled: "已取消",
	interrupted: "已中断",
	error: "失败",
	unrecorded: "未记录",
};
const historyState = {
	items: [],
	total: 0,
	page: 1,
	pageSize: 10,
	loading: false,
	request: null,
	sequence: 0,
	searchTimer: null,
	dialogTrigger: null,
};
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
	timeZone: "Asia/Shanghai",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});
const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
	timeZone: "Asia/Shanghai",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
});

function node(tag, className, text) {
	const item = document.createElement(tag);
	if (className) item.className = className;
	if (text !== undefined && text !== null) item.textContent = String(text);
	return item;
}

function timestamp(value) {
	if (typeof value !== "number" && typeof value !== "string") return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function fullTime(value) {
	const date = timestamp(value);
	return date ? `${dateFormatter.format(date)} ${timeFormatter.format(date)}` : "未记录";
}

function stateLabel(item) {
	return item.status_label || statusNames[item.status] || item.status || "未记录";
}

function statusNode(status, label) {
	const badge = node("span", "history-status", label || statusNames[status] || status || "未记录");
	badge.dataset.status = status || "unknown";
	return badge;
}

function conversationUrl(item) {
	const url = new URL("/", window.location.origin);
	if (item.source_id) url.searchParams.set("source", item.source_id);
	if (item.conversation_id) url.searchParams.set("conversation", item.conversation_id);
	url.searchParams.set("turn", item.id);
	return `${url.pathname}${url.search}`;
}

function hasFilters() {
	return Boolean(
		byId("history-query").value.trim() ||
			byId("history-model").value ||
			byId("history-status").value ||
			byId("history-source").value ||
			byId("history-period").value !== "all",
	);
}

// “今天”使用上海自然日；近 7/30 天使用滚动区间，统一发送 ISO 时间给历史接口。
function sinceValue() {
	const period = byId("history-period").value;
	if (period === "all") return "";
	if (period === "today") {
		const parts = Object.fromEntries(dateFormatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
		return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`).toISOString();
	}
	return new Date(Date.now() - Number(period) * 86400000).toISOString();
}

function updateOptions(id, entries, allLabel) {
	const select = byId(id);
	const current = select.value;
	const values = entries.filter((entry) => entry.value);
	// 原筛选值可能已无对应记录；保留选项，避免刷新悄悄改变查询条件。
	if (current && !values.some((entry) => entry.value === current)) values.push({ value: current, label: current });
	select.replaceChildren();
	for (const entry of [{ value: "", label: allLabel }, ...values]) {
		const option = node("option", "", entry.label);
		option.value = entry.value;
		select.append(option);
	}
	select.value = current;
}

function renderFacets(facets) {
	if (!facets) return;
	updateOptions(
		"history-model",
		(facets.models || []).map((value) => ({ value, label: value })),
		"全部模型",
	);
	updateOptions("history-status", facets.statuses || [], "全部状态");
	updateOptions(
		"history-source",
		(facets.sources || []).map((value) => ({ value, label: value })),
		"全部数据源",
	);
}

function syncPagination() {
	const pages = Math.max(1, Math.ceil(historyState.total / historyState.pageSize));
	byId("history-prev").disabled = historyState.loading || historyState.page <= 1;
	byId("history-next").disabled = historyState.loading || historyState.page >= pages;
	byId("history-refresh").disabled = historyState.loading;
	byId("history-page-label").textContent = `${historyState.page} / ${pages}`;
	byId("history-table-wrap").setAttribute("aria-busy", String(historyState.loading));
	if (historyState.loading) byId("history-range").textContent = "正在读取…";
	else {
		const first = historyState.total ? (historyState.page - 1) * historyState.pageSize + 1 : 0;
		const last = Math.min(historyState.page * historyState.pageSize, historyState.total);
		byId("history-range").textContent = historyState.total
			? `第 ${first}–${last} 条，共 ${historyState.total} 条`
			: "0 条记录";
	}
}

function renderEmpty(title, description, loading = false, allowReset = false) {
	hideCellPreview();
	const table = document.querySelector(".history-table");
	table.classList.add("is-empty");
	table.style.width = "100%";
	const row = node("tr");
	const cell = node("td", "history-empty-cell");
	cell.colSpan = 8;
	const heading = node("p", loading ? "history-loading" : "history-empty-title");
	if (loading) heading.append(node("span", "spinner"));
	heading.append(document.createTextNode(title));
	cell.append(heading);
	if (description) cell.append(node("p", "history-empty-note", description));
	if (allowReset) {
		const reset = node("button", "history-action history-empty-reset", "清除筛选");
		reset.type = "button";
		reset.addEventListener("click", resetFilters);
		cell.append(reset);
	}
	row.append(cell);
	byId("history-rows").replaceChildren(row);
}

function emptyAnswer(item) {
	if (item.status === "waiting_for_user") return "等待用户补充";
	if (item.status === "queued") return "尚未开始应答";
	if (item.status === "running") return "尚未输出答案";
	return "暂无答案输出";
}

function renderRows() {
	byId("history-count").textContent = `${hasFilters() ? "筛选结果" : "全部记录"} · ${historyState.total} 条`;
	if (!historyState.items.length) {
		renderEmpty(
			hasFilters() ? "没有找到符合条件的记录" : "还没有问答记录",
			hasFilters() ? "试试其他关键词，或清除筛选条件。" : "完成一次问询后，可以在这里查看历史。",
			false,
			hasFilters(),
		);
		return;
	}
	document.querySelector(".history-table").classList.remove("is-empty");
	applyColumnWidths();
	const rows = historyState.items.map((item) => {
		const row = node("tr");
		const idCell = node("td");
		const identifier = node("span", "history-id", item.id.slice(0, 8));
		idCell.append(identifier);
		if (item.mode === "eval") idCell.append(node("span", "history-mode", "评测"));
		const questionCell = node("td");
		const question = node("div", "history-cell-text history-question-text", item.question);
		questionCell.append(question, node("span", "history-cell-secondary", item.source_id));
		const answerCell = node("td");
		answerCell.append(
			node("div", item.answer ? "history-cell-text" : "history-cell-empty", item.answer || emptyAnswer(item)),
		);
		const tableCell = node("td");
		const tables = Array.isArray(item.tables) ? item.tables : [];
		if (tables.length) {
			const list = node("ul", "history-table-list");
			for (const table of tables.slice(0, 2)) {
				const entry = node("li", "", table);
				list.append(entry);
			}
			tableCell.append(list);
			if (tables.length > 2) tableCell.append(node("span", "history-cell-secondary", `另有 ${tables.length - 2} 张表`));
			tableCell.append(node("span", "history-cell-secondary", item.table_kind === "matched" ? "匹配表" : "实际查询表"));
		} else tableCell.append(node("span", "history-cell-empty", "未记录"));
		const modelCell = node("td");
		const models = Array.isArray(item.models) ? item.models : [];
		if (models.length) {
			const list = node("div", "history-call-list");
			// 列表只预览前两次调用，完整环节保留在悬浮窗和记录详情内，避免撑高整行。
			for (const model of models.slice(0, 2)) {
				const call = node("div");
				call.append(node("span", "history-call-stage", model.stage), node("span", "history-call-model", model.model));
				list.append(call);
			}
			modelCell.append(list);
			if (models.length > 2)
				modelCell.append(node("span", "history-cell-secondary", `另有 ${models.length - 2} 次调用`));
		} else modelCell.append(node("span", "history-cell-empty", "无已记录调用"));
		const statusCell = node("td");
		statusCell.append(statusNode(item.status, stateLabel(item)));
		const timeCell = node("td");
		const date = timestamp(item.created_at);
		if (date) {
			timeCell.append(
				node("span", "history-date", dateFormatter.format(date)),
				node("span", "history-time", timeFormatter.format(date)),
			);
		} else timeCell.append(node("span", "history-cell-empty", "未记录"));
		const actionsCell = node("td", "history-actions-cell");
		const actions = node("div", "history-row-actions");
		const detail = node("button", "history-action", "查看详情");
		detail.type = "button";
		detail.setAttribute("aria-label", `查看问题详情：${item.question}`);
		detail.addEventListener("click", () => openDetails(item, detail));
		const conversation = node("a", "history-action history-action-secondary", "回到会话");
		conversation.href = conversationUrl(item);
		actions.append(detail, conversation);
		actionsCell.append(actions);
		// 展示文本与原始内容分开保存：单元格可截断，悬浮阅读始终取完整记录。
		for (const [cell, title, content] of [
			[idCell, "记录 ID", `${item.id}\n\n记录来源：${item.mode === "eval" ? "评测任务" : "在线问询"}`],
			[questionCell, "原始问题", `${item.question}\n\n数据源：${item.source_id || "未记录"}`],
			[
				answerCell,
				"答案输出",
				[item.answer || emptyAnswer(item), item.clarification && `待补充信息：${item.clarification}`]
					.filter(Boolean)
					.join("\n\n"),
			],
			[
				tableCell,
				item.table_kind === "matched" ? "匹配表（不代表执行结果）" : "查询表",
				tables.length ? tables.join("\n") : "此记录未保存查询表或匹配表。",
			],
			[
				modelCell,
				"各环节实际模型调用",
				models.length
					? models
							.map(
								(model, index) =>
									`${index + 1}. ${model.stage}\n${model.model}\n状态：${statusNames[model.status] || model.status || "未记录"}`,
							)
							.join("\n\n")
					: "此记录没有已保存的模型调用。",
			],
			[statusCell, "应答状态", [stateLabel(item), item.error].filter(Boolean).join("\n\n")],
			[timeCell, "时间（北京时间）", `提问时间：${fullTime(item.created_at)}\n最后更新：${fullTime(item.updated_at)}`],
		]) {
			attachCellPreview(cell, title, content);
		}
		row.append(idCell, questionCell, answerCell, tableCell, modelCell, statusCell, timeCell, actionsCell);
		return row;
	});
	byId("history-rows").replaceChildren(...rows);
}

// 重复筛选会取消上一请求；迟到结果不能覆盖新条件下的记录或分页状态。
async function loadHistory() {
	clearTimeout(historyState.searchTimer);
	historyState.request?.abort();
	const controller = new AbortController();
	historyState.request = controller;
	const sequence = ++historyState.sequence;
	historyState.loading = true;
	byId("history-error").hidden = true;
	byId("history-count").textContent = "正在读取记录…";
	renderEmpty("正在读取问答历史…", "", true);
	syncPagination();
	const params = new URLSearchParams({ page: String(historyState.page), page_size: String(historyState.pageSize) });
	for (const [name, value] of [
		["q", byId("history-query").value.trim()],
		["model", byId("history-model").value],
		["status", byId("history-status").value],
		["source_id", byId("history-source").value],
		["since", sinceValue()],
	]) {
		if (value) params.set(name, value);
	}
	try {
		const response = await fetch(`/api/history?${params}`, {
			headers: { Accept: "application/json" },
			signal: controller.signal,
		});
		const data = await response.json();
		if (!response.ok)
			throw new Error(typeof data.error === "string" ? data.error : data.error?.message || `HTTP ${response.status}`);
		if (!Array.isArray(data.items)) throw new Error("服务未返回有效的历史记录");
		if (sequence !== historyState.sequence) return;
		historyState.items = data.items;
		historyState.total = Math.max(0, Number(data.total) || 0);
		historyState.page = Math.max(1, Number(data.page) || 1);
		historyState.pageSize = Number(data.page_size) || historyState.pageSize;
		byId("history-page-size").value = String(historyState.pageSize);
		renderFacets(data.facets);
		renderRows();
		byId("history-table-wrap").scrollTop = 0;
	} catch (error) {
		if (controller.signal.aborted || sequence !== historyState.sequence) return;
		historyState.items = [];
		historyState.total = 0;
		historyState.page = 1;
		byId("history-count").textContent = "记录未能载入";
		byId("history-error").textContent = `读取历史失败：${error.message}。请点击“刷新记录”重试。`;
		byId("history-error").hidden = false;
		renderEmpty("暂时无法读取历史", "筛选条件已保留，刷新后可重试。");
	} finally {
		if (sequence === historyState.sequence) {
			historyState.loading = false;
			syncPagination();
		}
	}
}

function detailSection(title, value, className = "") {
	const section = node("section", "history-detail-section");
	section.append(node("h3", "", title), node("p", `history-detail-text ${className}`, value));
	return section;
}

function openDetails(item, trigger) {
	hideCellPreview();
	historyState.dialogTrigger = trigger;
	byId("history-detail-id").textContent = `ID ${item.id}`;
	const summary = node("dl", "history-detail-summary");
	for (const [label, value] of [
		["应答状态", stateLabel(item)],
		["数据源", item.source_id || "未记录"],
		["提问时间（北京时间）", fullTime(item.created_at)],
		["最后更新（北京时间）", fullTime(item.updated_at)],
		["记录来源", item.mode === "eval" ? "评测任务" : "在线问询"],
		["会话 ID", item.conversation_id || "未记录"],
	]) {
		const entry = node("div");
		entry.append(node("dt", "", label), node("dd", "", value));
		summary.append(entry);
	}
	const sections = [
		summary,
		detailSection("原始问题", item.question),
		detailSection("答案输出", item.answer || emptyAnswer(item)),
	];
	if (item.clarification) sections.push(detailSection("待补充信息", item.clarification));
	if (item.error) sections.push(detailSection("任务说明", item.error, "history-detail-error"));
	const tableSection = node("section", "history-detail-section");
	// 匹配依据不等同于执行证明；旧记录缺少完整执行目录时也不能断言没有运行查询。
	tableSection.append(node("h3", "", item.table_kind === "matched" ? "匹配表（不代表执行结果）" : "查询表"));
	if (item.tables?.length) {
		const tables = node("ul", "history-detail-tables");
		for (const table of item.tables) tables.append(node("li", "", table));
		tableSection.append(tables);
	} else tableSection.append(node("p", "history-detail-text history-cell-empty", "此记录未保存查询表或匹配表。"));
	sections.push(tableSection);
	const modelSection = node("section", "history-detail-section");
	modelSection.append(node("h3", "", "各环节实际模型调用"));
	if (item.models?.length) {
		const models = node("ol", "history-detail-calls");
		for (const [index, model] of item.models.entries()) {
			const call = node("li", "history-detail-call");
			call.append(
				node("span", "", `${index + 1}. ${model.stage}`),
				node("span", "", model.model),
				statusNode(model.status),
			);
			models.append(call);
		}
		modelSection.append(models);
	} else
		modelSection.append(
			node("p", "history-detail-text history-cell-empty", "此记录没有已保存的模型调用，无法据当前配置推断历史模型。"),
		);
	sections.push(modelSection);
	byId("history-detail-body").replaceChildren(...sections);
	byId("history-detail-conversation").href = conversationUrl(item);
	byId("history-detail").showModal();
	byId("history-detail-body").scrollTop = 0;
}

function resetFilters() {
	byId("history-query").value = "";
	byId("history-model").value = "";
	byId("history-status").value = "";
	byId("history-source").value = "";
	byId("history-period").value = "all";
	historyState.page = 1;
	loadHistory();
}

// 每列有独立像素宽度；拖拽只更新目标列，表格总宽随之变化，其余列不被浏览器重新分配。
const columnDefaults = [92, 235, 290, 150, 210, 130, 150, 133];
const columnMinimums = [76, 140, 160, 110, 150, 100, 120, 124];
const columnMaximum = 1000;
let columnWidths = [];
let columnDrag = null;

function applyColumnWidths() {
	if (!columnWidths.length) {
		const available = byId("history-table-wrap").clientWidth;
		const total = columnDefaults.reduce((sum, width) => sum + width, 0);
		columnWidths = columnDefaults.map((width) => Math.round(width * Math.max(1, available / total)));
	}
	const table = document.querySelector(".history-table");
	table.style.width = `${columnWidths.reduce((sum, width) => sum + width, 0)}px`;
	table.querySelectorAll("col").forEach((col, index) => {
		col.style.width = `${columnWidths[index]}px`;
	});
	table.querySelectorAll(".history-column-resizer").forEach((handle, index) => {
		handle.setAttribute("aria-valuenow", String(columnWidths[index]));
		handle.setAttribute("aria-valuetext", `${columnWidths[index]} 像素`);
	});
}

function resizeColumn(index, width) {
	columnWidths[index] = Math.max(columnMinimums[index], Math.min(columnMaximum, Math.round(width)));
	applyColumnWidths();
}

function initializeColumnResize() {
	document.querySelectorAll(".history-table th").forEach((heading, index) => {
		const handle = node("span", "history-column-resizer");
		handle.tabIndex = 0;
		handle.setAttribute("role", "separator");
		handle.setAttribute("aria-label", `调整${heading.textContent.trim()}列宽`);
		handle.setAttribute("aria-orientation", "vertical");
		handle.setAttribute("aria-valuemin", String(columnMinimums[index]));
		handle.setAttribute("aria-valuemax", String(columnMaximum));
		handle.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			hideCellPreview();
			columnDrag = { index, pointer: event.pointerId, startX: event.clientX, width: columnWidths[index] };
			handle.setPointerCapture(event.pointerId);
			document.body.classList.add("is-column-resizing");
		});
		handle.addEventListener("pointermove", (event) => {
			if (columnDrag?.index !== index || columnDrag.pointer !== event.pointerId) return;
			resizeColumn(index, columnDrag.width + event.clientX - columnDrag.startX);
		});
		const finishDrag = () => {
			if (columnDrag?.index !== index) return;
			columnDrag = null;
			document.body.classList.remove("is-column-resizing");
		};
		for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
			handle.addEventListener(event, finishDrag);
		// 键盘用户也可逐列微调，双击拖柄恢复该列的初始宽度。
		handle.addEventListener("keydown", (event) => {
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			event.preventDefault();
			resizeColumn(index, columnWidths[index] + (event.key === "ArrowRight" ? 16 : -16));
		});
		handle.addEventListener("dblclick", () => resizeColumn(index, columnDefaults[index]));
		heading.append(handle);
	});
}

// 共用一个非模态阅读浮层；延迟打开避免划过表格时闪烁，移入浮层后仍能滚动和选择文字。
const cellPreview = { element: null, cell: null, showTimer: null, hideTimer: null };

function hideCellPreview() {
	clearTimeout(cellPreview.showTimer);
	clearTimeout(cellPreview.hideTimer);
	cellPreview.cell?.setAttribute("aria-expanded", "false");
	cellPreview.cell = null;
	if (cellPreview.element) cellPreview.element.hidden = true;
}

function deferHideCellPreview() {
	clearTimeout(cellPreview.showTimer);
	clearTimeout(cellPreview.hideTimer);
	// 已用键盘进入阅读区时，鼠标离开原格不应关闭正在阅读的内容。
	cellPreview.hideTimer = setTimeout(() => {
		if (!cellPreview.element.contains(document.activeElement)) hideCellPreview();
	}, 180);
}

function showCellPreview(cell, title, content) {
	clearTimeout(cellPreview.showTimer);
	clearTimeout(cellPreview.hideTimer);
	if (columnDrag || !cell.isConnected) return;
	if (cellPreview.cell === cell) return;
	cellPreview.cell?.setAttribute("aria-expanded", "false");
	cellPreview.cell = cell;
	cell.setAttribute("aria-expanded", "true");
	const popup = cellPreview.element;
	byId("history-preview-title").textContent = title;
	byId("history-preview-content").textContent = content;
	popup.hidden = false;
	byId("history-preview-content").scrollTop = 0;
	const anchor = cell.getBoundingClientRect();
	const bounds = popup.getBoundingClientRect();
	const gap = 8;
	const below = window.innerHeight - anchor.bottom;
	const top = below >= bounds.height + gap ? anchor.bottom + gap : anchor.top - bounds.height - gap;
	popup.style.left = `${Math.max(gap, Math.min(anchor.left, window.innerWidth - bounds.width - gap))}px`;
	popup.style.top = `${Math.max(gap, Math.min(top, window.innerHeight - bounds.height - gap))}px`;
}

function attachCellPreview(cell, title, content) {
	cell.tabIndex = 0;
	cell.classList.add("history-preview-cell");
	cell.setAttribute("aria-haspopup", "dialog");
	cell.setAttribute("aria-controls", "history-cell-preview");
	cell.setAttribute("aria-expanded", "false");
	cell.addEventListener("pointerenter", () => {
		clearTimeout(cellPreview.hideTimer);
		clearTimeout(cellPreview.showTimer);
		if (cellPreview.element.contains(document.activeElement)) return;
		cellPreview.showTimer = setTimeout(() => showCellPreview(cell, title, content), 260);
	});
	cell.addEventListener("pointerleave", deferHideCellPreview);
	cell.addEventListener("focus", () => showCellPreview(cell, title, content));
	cell.addEventListener("blur", (event) => {
		if (!cellPreview.element.contains(event.relatedTarget)) deferHideCellPreview();
	});
	cell.addEventListener("click", () => showCellPreview(cell, title, content));
	cell.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		showCellPreview(cell, title, content);
		byId("history-preview-content").focus({ preventScroll: true });
	});
}

function initializeCellPreview() {
	const popup = node("aside", "history-cell-preview");
	popup.id = "history-cell-preview";
	popup.hidden = true;
	popup.setAttribute("role", "dialog");
	popup.setAttribute("aria-labelledby", "history-preview-title");
	const heading = node("div", "history-preview-heading");
	const title = node("h2");
	title.id = "history-preview-title";
	const close = node("button", "history-preview-close", "×");
	close.type = "button";
	close.setAttribute("aria-label", "关闭单元格详情");
	const dismiss = () => {
		const cell = cellPreview.cell;
		if (popup.contains(document.activeElement)) cell?.focus({ preventScroll: true });
		hideCellPreview();
	};
	close.addEventListener("click", dismiss);
	heading.append(title, close);
	const content = node("div", "history-preview-content");
	content.id = "history-preview-content";
	content.tabIndex = 0;
	popup.append(heading, content);
	const retain = () => clearTimeout(cellPreview.hideTimer);
	popup.addEventListener("pointerenter", retain);
	popup.addEventListener("focusin", retain);
	popup.addEventListener("pointerleave", () => {
		if (!popup.contains(document.activeElement)) deferHideCellPreview();
	});
	popup.addEventListener("focusout", (event) => {
		if (!popup.contains(event.relatedTarget) && event.relatedTarget !== cellPreview.cell) deferHideCellPreview();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !popup.hidden) {
			event.preventDefault();
			dismiss();
		}
	});
	document.addEventListener("pointerdown", (event) => {
		if (!popup.contains(event.target) && !cellPreview.cell?.contains(event.target)) hideCellPreview();
	});
	byId("history-table-wrap").addEventListener("scroll", hideCellPreview, { passive: true });
	window.addEventListener("resize", hideCellPreview);
	document.body.append(popup);
	cellPreview.element = popup;
}

// 页面入口的 source 只用于返回原数据源；列表默认覆盖全部历史，source_id 才是显式筛选。
if (contextSource) {
	const params = new URLSearchParams({ source: contextSource });
	byId("history-back-link").href = `/?${params}`;
	byId("history-brand-link").href = `/?${params}`;
}
for (const [name, id] of [
	["model", "history-model"],
	["status", "history-status"],
	["source_id", "history-source"],
]) {
	const value = initialQuery.get(name);
	if (value) {
		const option = node("option", "", value);
		option.value = value;
		byId(id).append(option);
		byId(id).value = value;
	}
}
byId("history-query").value = initialQuery.get("q") || "";
byId("history-filters").addEventListener("submit", (event) => {
	event.preventDefault();
	historyState.page = 1;
	loadHistory();
});
byId("history-query").addEventListener("input", () => {
	clearTimeout(historyState.searchTimer);
	historyState.searchTimer = setTimeout(() => {
		historyState.page = 1;
		loadHistory();
	}, 300);
});
for (const id of ["history-model", "history-status", "history-source", "history-period"]) {
	byId(id).addEventListener("change", () => {
		historyState.page = 1;
		loadHistory();
	});
}
byId("history-reset").addEventListener("click", resetFilters);
byId("history-refresh").addEventListener("click", loadHistory);
byId("history-page-size").addEventListener("change", () => {
	historyState.pageSize = Number(byId("history-page-size").value);
	historyState.page = 1;
	loadHistory();
});
byId("history-prev").addEventListener("click", () => {
	if (historyState.loading || historyState.page <= 1) return;
	historyState.page -= 1;
	loadHistory();
});
byId("history-next").addEventListener("click", () => {
	if (historyState.loading || historyState.page * historyState.pageSize >= historyState.total) return;
	historyState.page += 1;
	loadHistory();
});
byId("history-detail-close").addEventListener("click", () => byId("history-detail").close());
byId("history-detail").addEventListener("close", () => {
	if (historyState.dialogTrigger?.isConnected) historyState.dialogTrigger.focus({ preventScroll: true });
	else byId("history-table-wrap").focus({ preventScroll: true });
});

function syncTheme() {
	const dark = document.documentElement.dataset.theme === "dark";
	const button = byId("history-theme-toggle");
	button.setAttribute("aria-pressed", String(dark));
	button.setAttribute("aria-label", dark ? "切换到白色主题" : "切换到黑色主题");
	button.title = dark ? "切换到白色主题" : "切换到黑色主题";
	// SVG 不反射 HTML hidden 属性，直接切换属性以正确显示当前主题图标。
	button.querySelector(".theme-icon-light").toggleAttribute("hidden", !dark);
	button.querySelector(".theme-icon-dark").toggleAttribute("hidden", dark);
}
byId("history-theme-toggle").addEventListener("click", () => {
	const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
	document.documentElement.dataset.theme = theme;
	try {
		localStorage.setItem("medical-query-theme", theme);
	} catch {
		/* 无法保存偏好时仍允许本次页面切换。 */
	}
	syncTheme();
});
syncTheme();
initializeColumnResize();
initializeCellPreview();
loadHistory();
