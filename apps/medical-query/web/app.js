/* 页面只展示服务端任务事实；业务状态与结果完整性不由浏览器自行推断。 */
const $ = (id) => document.getElementById(id);
const narrowScreen = window.matchMedia("(max-width: 1100px)");
// 显式数据源链接使用独立会话存储，浏览 L0 时保留原首页的医院 A/B 对话。
const requestedSource = new URL(location.href).searchParams.get("source");
// 从历史记录返回时按会话与回合定位；仅浏览已保存内容，不重新提交查询。
let requestedConversation = new URL(location.href).searchParams.get("conversation");
let requestedTurnId = new URL(location.href).searchParams.get("turn");
const conversationStorageKey = requestedSource
	? `medical-query-conversation:${requestedSource}`
	: "medical-query-conversation";
const sourceStorageKey = requestedSource ? `medical-query-source:${requestedSource}` : "medical-query-source";
const terminalStates = new Set(["completed", "failed", "blocked", "cancelled", "canceled", "interrupted", "error"]);
const statusLabels = {
	queued: "排队中",
	running: "查询中",
	waiting_for_user: "等待补充",
	completed: "已完成",
	failed: "查询失败",
	blocked: "暂时无法完成",
	cancelled: "已取消",
	canceled: "已取消",
	interrupted: "查询中断",
	error: "查询失败",
};
const phaseLabels = {
	queued: "请求已进入队列，等待处理",
	waiting_model: "正在等待模型处理名额",
	waiting_for_model: "正在等待模型处理名额",
	model: "正在理解问题与统计条件",
	understanding: "正在理解问题与统计条件",
	linking: "正在核对数据表与字段",
	planning: "正在整理查询条件",
	compiling: "正在生成并校验查询",
	executing: "正在读取数据",
	execution: "正在读取数据",
	generating: "正在生成结果说明",
	answering: "正在生成结果说明",
	answer: "正在生成结果说明",
	cancelling: "正在停止，请等待执行资源退出",
	cancel_requested: "正在停止，请等待执行资源退出",
};
const ui = {
	sources: [],
	sourceId: "",
	turns: [],
	selectedTurnId: null,
	conversationId: requestedConversation || readStorage(conversationStorageKey) || crypto.randomUUID(),
	busy: false,
	loaded: false,
	pollTimer: null,
	epoch: 0,
	pages: new Map(),
	requestAttempt: null,
	submissionAttempt: null,
	lastAnnouncement: "",
	cancelingId: null,
	panels: { prompt: false, evidence: false },
	widths: { prompt: 300, evidence: 420 },
	promptSignature: "",
	evidenceSignature: "",
	expanded: new Map(),
	turnSignature: "",
	deferTurns: false,
	deferEvidence: false,
};
if (!requestedConversation) writeStorage(conversationStorageKey, ui.conversationId);
$("history-link").href = requestedSource ? `/history?source=${encodeURIComponent(requestedSource)}` : "/history";

// 只保存会话、数据源标识和主题偏好；浏览器不会保存服务端密钥或数据库凭据。
function readStorage(key) {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
function writeStorage(key, value) {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* 隐私模式下仍允许本次页面使用。 */
	}
}

// 黑白主题覆盖整页及查询结果，默认保留浅色；图标表示下一次切换的目标。
function setTheme(theme) {
	const dark = theme === "dark";
	document.documentElement.dataset.theme = dark ? "dark" : "light";
	const label = dark ? "切换到白色主题" : "切换到黑色主题";
	const toggle = $("theme-toggle");
	toggle.setAttribute("aria-label", label);
	toggle.setAttribute("aria-pressed", String(dark));
	toggle.title = label;
	toggle.querySelector(".theme-icon-light").toggleAttribute("hidden", !dark);
	toggle.querySelector(".theme-icon-dark").toggleAttribute("hidden", dark);
	writeStorage("medical-query-theme", dark ? "dark" : "light");
}

function element(tag, className, text) {
	const item = document.createElement(tag);
	if (className) item.className = className;
	if (text !== undefined && text !== null) item.textContent = String(text);
	return item;
}

async function api(path, body) {
	const response = await fetch(
		path,
		body === undefined
			? { headers: { Accept: "application/json" } }
			: {
					method: "POST",
					headers: { "Content-Type": "application/json", Accept: "application/json" },
					body: JSON.stringify(body),
				},
	);
	let data;
	try {
		data = await response.json();
	} catch {
		throw new Error(`服务未返回有效数据（HTTP ${response.status}）`);
	}
	if (!response.ok) {
		const detail = typeof data.error === "string" ? data.error : data.error?.message;
		throw new Error(detail || data.message || `请求失败（HTTP ${response.status}）`);
	}
	return data;
}

function showNotice(message = "") {
	$("notice").textContent = message;
	$("notice").hidden = !message;
}

function activeTurn() {
	return [...ui.turns].reverse().find((turn) => !terminalStates.has(turn.status));
}

function turnFromResponse(data) {
	return data.turn || data;
}

function currentSource() {
	return ui.sources.find((source) => source.id === ui.sourceId);
}

function sourceName(id) {
	return ui.sources.find((source) => source.id === id)?.name || id || "未选择数据源";
}

// L0 当前只验证匹配，不能套用普通查询的 SQL 执行层或“计算完成”表述。
function isL0Turn(turn) {
	return (
		turn?.evidence?.profile === "l0_schema_linking" ||
		ui.sources.find((source) => source.id === turn?.source_id)?.profile === "l0_schema_linking"
	);
}

function turnStatusLabel(turn) {
	if (isL0Turn(turn) && turn.status === "blocked")
		return turn.evidence?.match_status === "no_match" ? "未找到匹配指标" : "匹配已完成 · 尚不可计算";
	return statusLabels[turn.status] || turn.status;
}

// 数据源目录仅使用服务端返回的数据，不以静态示例冒充已接入表。
function renderSources() {
	const select = $("source-select");
	select.replaceChildren();
	if (!ui.sources.length) select.appendChild(element("option", "", "暂无可用数据源"));
	for (const source of ui.sources) {
		const option = element("option", "", source.name || source.id);
		option.value = source.id;
		option.selected = source.id === ui.sourceId;
		select.appendChild(option);
	}
	const source = currentSource();
	const tables = Array.isArray(source?.tables) ? source.tables : [];
	$("source-description").textContent = source
		? "本次问询只使用此数据源；切换后开启新对话。"
		: "请先在服务端接入数据源。";
	$("table-count").textContent = tables.length ? `${tables.length} 张` : "—";
	const list = $("table-list");
	list.replaceChildren();
	for (const table of tables) {
		const name = typeof table === "string" ? table : table.name || table.table_name || table.id;
		if (name) list.appendChild(element("li", "", name));
	}
	if (!list.children.length) list.appendChild(element("li", "muted", "暂无表目录"));
	renderExamples(tables);
	updateComposer();
}

function renderExamples(tables) {
	const names = tables.map((table) => (typeof table === "string" ? table : table.name || table.table_name || ""));
	// 首页只留一句自然语言示例，不展示物理表名；未接入患者表时不承诺该示例可用。
	const examples =
		currentSource()?.profile === "l0_schema_linking"
			? ["门诊人次数与出院人次数比需要哪些数据？"]
			: names.some((name) => /(^|\.)(patients|persons)$/i.test(name))
				? ["年龄 65 岁及以上的患者有多少人？"]
				: [];
	const list = $("example-list");
	list.replaceChildren();
	if (examples.length) list.appendChild(element("span", "example-label", "例如："));
	for (const question of examples) {
		const button = element("button", "example-button", question);
		button.type = "button";
		button.addEventListener("click", () => {
			$("question-input").value = question;
			$("question-input").focus();
			updateComposer();
		});
		list.appendChild(button);
	}
}

function updateComposer() {
	const active = activeTurn();
	const waiting = active?.status === "waiting_for_user";
	const running = active && !waiting;
	const hasText = Boolean($("question-input").value.trim());
	const send = $("send-button");
	send.disabled = !ui.loaded || !currentSource() || !hasText || ui.busy || Boolean(running);
	send.classList.toggle("is-reply", waiting);
	const sendLabel = waiting ? "补充并继续" : "发送问题";
	send.setAttribute("aria-label", sendLabel);
	send.title = sendLabel;
	const arrow = element("span", "", "↑");
	arrow.setAttribute("aria-hidden", "true");
	send.replaceChildren(...(waiting ? [document.createTextNode(`${sendLabel} `), arrow] : [arrow]));
	const input = $("question-input");
	input.placeholder = waiting ? "回答上方问题，也可以直接输入补充说明…" : "输入你的问题…";
	// 单行提问保持轻量，长问题自动长高至上限，避免挤掉上方对话。
	input.style.height = "auto";
	input.style.height = `${Math.min(140, Math.max(36, input.scrollHeight))}px`;
	$("reply-context").hidden = !waiting;
	$("reply-context-text").textContent = waiting ? "正在补充原查询，已明确的条件会继续保留" : "";
	$("stop-button").hidden = !active;
	$("stop-button").disabled = ui.busy || ["cancelling", "cancel_requested"].includes(active?.phase);
	$("stop-button").textContent = ui.cancelingId ? "正在停止…" : waiting ? "结束此查询" : "停止查询";
	$("source-select").disabled = !ui.loaded || !ui.sources.length || ui.busy || Boolean(active);
	$("new-conversation").disabled = !ui.loaded || ui.busy || Boolean(active);
	$("new-conversation").title = active ? "请先结束当前查询，再开启新对话" : "开启新的独立会话";
	$("conversation-status").textContent = active
		? statusLabels[active.status] || "处理中"
		: ui.turns.length
			? "当前问询已结束"
			: "新对话";
	$("composer-hint").textContent = running ? "查询进行中，可停止后开始新的问题" : "Enter 发送 · Shift + Enter 换行";
}

function formatTime(value) {
	if (!value) return "";
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// 轮询只更新当前会话；旧请求迟到时不能写入新会话或重启已结束的任务。
function upsertTurn(turn) {
	if (!turn?.id || (turn.conversation_id && turn.conversation_id !== ui.conversationId)) return;
	const index = ui.turns.findIndex((existing) => existing.id === turn.id);
	if (index !== -1) {
		const prior = ui.turns[index];
		// 停止与轮询可能同时返回；迟到的旧状态不能把已结束任务重新显示为运行中。
		if (new Date(turn.updated_at).getTime() < new Date(prior.updated_at).getTime()) return;
		if (terminalStates.has(prior.status) && !terminalStates.has(turn.status)) return;
	}
	if (index === -1) ui.turns.push(turn);
	else ui.turns[index] = turn;
	if (!ui.selectedTurnId) ui.selectedTurnId = turn.id;
	renderTurns();
	renderPrompts();
	renderEvidence();
	schedulePoll();
}

function renderTurns() {
	const scroller = $("conversation-scroll");
	const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
	const priorScroll = scroller.scrollTop;
	// 空会话只显示欢迎区；开始提问后再呈现会话状态与证据入口。
	const empty = ui.turns.length === 0;
	$("empty-state").hidden = !empty;
	$("workspace").classList.toggle("is-empty", empty);
	$("conversation-header").hidden = empty;
	// 顶部重复入口已移除，两侧把手统一承担展开与收起，窄屏也保留入口。
	$("prompt-splitter").hidden = empty;
	$("evidence-splitter").hidden = empty;
	if (empty) {
		ui.panels.prompt = false;
		ui.panels.evidence = false;
	}
	syncPanels();
	const container = $("turns");
	const signature = JSON.stringify(
		ui.turns.map((turn) => [
			turn.id,
			turn.status,
			turn.phase,
			turn.question,
			turn.answer,
			turn.error,
			turn.accepted_replies,
			turn.result,
		]),
	);
	if (signature !== ui.turnSignature) {
		ui.deferTurns = hasTextSelection(container);
		if (!ui.deferTurns) {
			const offsets = new Map(
				[...container.querySelectorAll(".turn")].map((turn) => [
					turn.dataset.turnId,
					turn.querySelector(".table-scroll")?.scrollLeft || 0,
				]),
			);
			container.replaceChildren(...ui.turns.map(renderTurn));
			for (const turn of container.querySelectorAll(".turn")) {
				const table = turn.querySelector(".table-scroll");
				if (table) table.scrollLeft = offsets.get(turn.dataset.turnId) || 0;
			}
			ui.turnSignature = signature;
		}
	}
	updateComposer();
	if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
	else scroller.scrollTop = priorScroll;
	const latest = ui.turns.at(-1);
	const announcement = latest ? `${latest.id}:${latest.status}:${latest.phase}` : "";
	if (announcement && announcement !== ui.lastAnnouncement) {
		$("live-announcement").textContent = statusLabels[latest.status] || "正在处理查询";
		ui.lastAnnouncement = announcement;
	}
}

function renderTurn(turn) {
	const article = element("article", "turn");
	article.dataset.turnId = turn.id;
	// 用户问题独立成右侧气泡，时间跟随该消息；助手内容留在左侧，便于辨认对话双方。
	const message = element("div", "user-message");
	message.setAttribute("aria-label", "用户问题");
	message.append(
		element("h2", "turn-question", turn.question),
		element("span", "turn-time", formatTime(turn.created_at)),
	);
	article.append(message);
	if (Array.isArray(turn.accepted_replies) && turn.accepted_replies.length) {
		// 补充摘要来自持久化接受记录；刷新后仍能核对本次查询使用过的用户条件。
		const replies = element("div", "accepted-replies");
		replies.setAttribute("aria-label", "用户补充");
		replies.appendChild(element("span", "accepted-label", "已补充"));
		for (const reply of turn.accepted_replies) {
			replies.appendChild(
				element("p", "", typeof reply.answer === "string" ? reply.answer : JSON.stringify(reply.answer)),
			);
		}
		article.appendChild(replies);
	}
	const response = element("div", "assistant-response");
	response.setAttribute("aria-label", "助手回复");
	const heading = element("div", "response-heading");
	heading.appendChild(element("span", "response-label", turnStatusLabel(turn)));
	const evidenceButton = element("button", "text-button", "查看证据");
	evidenceButton.type = "button";
	evidenceButton.addEventListener("click", () => {
		ui.selectedTurnId = turn.id;
		ui.expanded.set(`turn-${turn.id}`, true);
		renderPrompts();
		renderEvidence();
		setPanelOpen("evidence", true);
		const card = $("evidence-content").querySelector(`[data-turn-id="${CSS.escape(turn.id)}"]`);
		if (card) {
			card.open = true;
			card.scrollIntoView({ block: "nearest" });
		}
	});
	heading.appendChild(evidenceButton);
	response.appendChild(heading);
	if (turn.status === "waiting_for_user" && turn.clarification) {
		response.appendChild(renderClarification(turn));
	} else if (turn.answer) {
		// 模型文本只作为文本节点渲染，避免把未信任内容解释成 HTML。
		response.appendChild(
			element(
				"div",
				"answer-text",
				typeof turn.answer === "string" ? turn.answer : JSON.stringify(turn.answer, null, 2),
			),
		);
	} else if (!terminalStates.has(turn.status)) {
		const phase = element("p", "phase-text phase-active");
		phase.appendChild(element("span", "spinner"));
		// 后端可直接返回中文进展；内部英文阶段码必须映射后再进入业务界面。
		const publicPhase = typeof turn.phase === "string" && /[\u4e00-\u9fff]/.test(turn.phase) ? turn.phase : "";
		phase.appendChild(
			document.createTextNode(
				phaseLabels[turn.phase] ||
					publicPhase ||
					(turn.status === "queued" ? phaseLabels.queued : "正在处理查询，请稍候"),
			),
		);
		response.appendChild(phase);
	} else if (!turn.error) {
		const text = ["cancelled", "canceled"].includes(turn.status)
			? "此查询已结束。你可以重新提问。"
			: turn.status === "interrupted"
				? "查询已中断，未确认完整结果。"
				: turn.status === "completed"
					? "本次查询已完成。"
					: "当前查询未完成，请查看任务说明。";
		response.appendChild(element("p", "phase-text", text));
	}
	if (turn.error)
		response.appendChild(
			element(
				"div",
				"error-box",
				typeof turn.error === "string" ? turn.error : turn.error.message || JSON.stringify(turn.error),
			),
		);
	if (turn.result && Array.isArray(turn.result.rows)) response.appendChild(renderResult(turn));
	article.appendChild(response);
	return article;
}

function renderClarification(turn) {
	const box = element("div", "clarification");
	box.appendChild(element("p", "", turn.clarification.question));
	if (turn.clarification.options?.length) {
		const choices = element("div", "clarification-options");
		for (const option of turn.clarification.options) {
			const label = typeof option === "string" ? option : option.label || option.value || "";
			const button = element("button", "clarification-option", label);
			button.type = "button";
			button.disabled = ui.busy;
			button.addEventListener("click", () => {
				choices.querySelectorAll("button").forEach((choice) => {
					choice.classList.toggle("selected", choice === button);
				});
				$("question-input").value = label;
				$("question-input").focus();
				updateComposer();
			});
			choices.appendChild(button);
		}
		box.appendChild(choices);
	}
	box.appendChild(element("p", "clarification-hint", "选择后点击“补充并继续”，也可以在下方直接回答。"));
	return box;
}

// 分页只浏览本次已收到的行，不重新调用模型，也不将已载入行数冒充全量总数。
function renderResult(turn) {
	const result = turn.result;
	const rows = result.rows;
	const columns = Array.isArray(result.columns) ? result.columns : [];
	const paging = ui.pages.get(turn.id) || { page: 1, size: 10 };
	const count = Math.max(1, Math.ceil(rows.length / paging.size));
	paging.page = Math.min(paging.page, count);
	ui.pages.set(turn.id, paging);
	const wrap = element("section", "result");
	wrap.setAttribute("aria-label", "真实查询结果");
	const heading = element("div", "result-heading");
	heading.appendChild(element("strong", "", "查询结果"));
	heading.appendChild(
		element(
			"span",
			`result-meta ${result.complete ? "complete" : "partial"}`,
			`${result.complete ? "完整结果" : "部分结果"}　已载入 ${rows.length.toLocaleString("zh-CN")} 行`,
		),
	);
	wrap.appendChild(heading);
	const scroll = element("div", "table-scroll");
	const table = element("table");
	table.appendChild(element("caption", "sr-only", `查询结果，已载入 ${rows.length} 行`));
	const head = element("thead");
	const headRow = element("tr");
	for (const column of columns) {
		const th = element("th", "", column);
		th.scope = "col";
		headRow.appendChild(th);
	}
	head.appendChild(headRow);
	table.appendChild(head);
	const body = element("tbody");
	const start = (paging.page - 1) * paging.size;
	for (const row of rows.slice(start, start + paging.size)) {
		const tr = element("tr");
		for (let column = 0; column < columns.length; column += 1) {
			const value = Array.isArray(row) ? row[column] : row[columns[column]];
			const text =
				value === null || value === undefined
					? "NULL"
					: typeof value === "object"
						? JSON.stringify(value)
						: String(value);
			tr.appendChild(element("td", value === null || value === undefined ? "null-value" : "", text));
		}
		body.appendChild(tr);
	}
	if (!rows.length) {
		const tr = element("tr");
		const cell = element("td", "empty-cell", result.complete ? "没有符合条件的记录" : "尚未收到结果行，完整性未确认");
		cell.colSpan = Math.max(1, columns.length);
		tr.appendChild(cell);
		body.appendChild(tr);
	}
	table.appendChild(body);
	scroll.appendChild(table);
	wrap.appendChild(scroll);
	const pager = element("div", "pager");
	pager.appendChild(
		element(
			"span",
			"pager-range",
			rows.length ? `第 ${start + 1}–${Math.min(start + paging.size, rows.length)} 行` : "0 行",
		),
	);
	const size = element("select");
	size.setAttribute("aria-label", "每页条数");
	for (const value of [10, 20, 50]) {
		const option = element("option", "", `${value} 条/页`);
		option.value = value;
		option.selected = value === paging.size;
		size.appendChild(option);
	}
	size.addEventListener("change", () => {
		ui.pages.set(turn.id, { page: 1, size: Number(size.value) });
		wrap.replaceWith(renderResult(turn));
	});
	pager.appendChild(size);
	const prev = element("button", "", "上一页");
	prev.type = "button";
	prev.disabled = paging.page <= 1;
	prev.addEventListener("click", () => {
		paging.page -= 1;
		wrap.replaceWith(renderResult(turn));
	});
	pager.appendChild(prev);
	pager.appendChild(element("span", "", `${paging.page} / ${count}`));
	const next = element("button", "", "下一页");
	next.type = "button";
	next.disabled = paging.page >= count;
	next.addEventListener("click", () => {
		paging.page += 1;
		wrap.replaceWith(renderResult(turn));
	});
	pager.appendChild(next);
	wrap.appendChild(pager);
	if (!result.complete)
		wrap.appendChild(
			element("p", "partial-note", "当前仅展示已收到的数据，可能已截断或传输中断，不能作为全部查询结果。"),
		);
	return wrap;
}

// 两侧卡片来自持久化调用与阶段记录；轮询时保留展开、滚动和文本选择位置。
function hasTextSelection(container) {
	const selection = document.getSelection();
	return Boolean(
		selection &&
			!selection.isCollapsed &&
			(container.contains(selection.anchorNode) || container.contains(selection.focusNode)),
	);
}

function replacePanelContent(content, children) {
	const scroll = content.scrollTop;
	const active = content.contains(document.activeElement) ? document.activeElement : null;
	const focusKey = active?.dataset.focusKey;
	const selection = active?.tagName === "TEXTAREA" ? [active.selectionStart, active.selectionEnd] : null;
	const fieldScroll = new Map(
		[...content.querySelectorAll("textarea")].map((field) => [field.dataset.focusKey, field.scrollTop]),
	);
	for (const detail of content.querySelectorAll("details[data-key]")) ui.expanded.set(detail.dataset.key, detail.open);
	content.replaceChildren(...children);
	for (const detail of content.querySelectorAll("details[data-key]")) {
		if (ui.expanded.has(detail.dataset.key)) detail.open = ui.expanded.get(detail.dataset.key);
	}
	for (const field of content.querySelectorAll("textarea"))
		field.scrollTop = fieldScroll.get(field.dataset.focusKey) || 0;
	if (focusKey) {
		const target = content.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
		target?.focus({ preventScroll: true });
		if (selection && target?.tagName === "TEXTAREA") target.setSelectionRange(...selection);
	}
	content.scrollTop = scroll;
}

function formatDuration(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return "";
	return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} 秒`;
}

// 阅读视图逐项展开实际 user 内容，不显示 JSON 包装；系统原文及复制内容保持发送时的文本。
function readablePrompt(text) {
	if (typeof text !== "string") return "该次调用未记录此内容。";
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		return text;
	}
	if (!data || typeof data !== "object") return text;
	if (!Object.keys(data).length) return Array.isArray(data) ? "无条目（空数组）" : "空对象";
	const labels = {
		question: "原始问题",
		replies: "已接受的补充",
		source_id: "数据源",
		as_of: "时间锚点",
		catalog: "实际数据目录",
		prior: "继承的历史上下文",
		correction: "本次修复依据",
		columns: "列",
		rows: "实际结果预览",
		complete: "结果是否完整",
		tables: "数据表",
		name: "名称",
		type: "类型",
		description: "含义",
		relations: "关联关系",
		semantics: "业务语义",
		fields: "字段",
		answer: "补充内容",
		evidence: "已确认依据",
	};
	const lines = [];
	const visit = (name, value, depth) => {
		const prefix = "  ".repeat(depth);
		const label = labels[name] ? `${labels[name]}（${name}）` : name;
		if (value !== null && typeof value === "object") {
			const entries = Array.isArray(value)
				? value.map((item, index) => [`第 ${index + 1} 项`, item])
				: Object.entries(value);
			lines.push(`${prefix}${label}${entries.length ? "：" : Array.isArray(value) ? "：无条目" : "：空对象"}`);
			for (const [key, item] of entries) visit(key, item, depth + 1);
		} else
			lines.push(`${prefix}${label}：${value === null ? "空值（null）" : value === "" ? "空文本" : String(value)}`);
	};
	for (const [name, value] of Object.entries(data)) {
		visit(name, value, 0);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function renderPrompts() {
	const turn = ui.turns.find((item) => item.id === ui.selectedTurnId) || ui.turns.at(-1);
	const selector = $("prompt-turn-select");
	// 切换问题只浏览该轮记录，不触发新的模型请求。
	const optionsKey = JSON.stringify(ui.turns.map((item) => [item.id, item.question]));
	if (selector.dataset.key !== optionsKey) {
		selector.replaceChildren(
			...ui.turns.map((item, index) => {
				const option = element("option", "", `${index + 1}. ${item.question}`);
				option.value = item.id;
				return option;
			}),
		);
		selector.dataset.key = optionsKey;
	}
	selector.value = turn?.id || "";
	const calls = Array.isArray(turn?.model_calls) ? turn.model_calls : [];
	const signature = JSON.stringify([turn?.id, turn?.status, turn?.stages, calls]);
	if (signature === ui.promptSignature) return;
	ui.promptSignature = signature;
	const children = [];
	const l0 = isL0Turn(turn);
	if (!calls.length)
		children.push(
			element(
				"p",
				"panel-note",
				!turn
					? "提问后，在这里查看实际提示词。"
					: terminalStates.has(turn.status)
						? "本轮没有已记录的提示词。旧记录不会按当前模板补造。"
						: "等待实际模型调用，提示词将在调用开始后出现。",
			),
		);
	for (const [index, call] of calls.entries()) {
		const key = `prompt-${turn.id}-${call.id}`;
		const card = element("details", "prompt-card");
		card.dataset.key = key;
		card.open = index === 0;
		const summary = element("summary");
		summary.dataset.focusKey = key;
		const input = recordedInput(turn, { model_call_id: call.id });
		const stage = turn.stages?.find((item) => item.model_call_id === call.id);
		const purpose = l0
			? stage?.label || "指标匹配"
			: call.role === "answer"
				? "结果引用选择"
				: input.correction
					? "定向修复"
					: input.replies?.length
						? "补充后重新决策"
						: "理解与规划";
		// 一张卡对应一次实际调用，L0 使用记录的阶段名，不能把正常第二步误标为修复。
		summary.append(element("span", "call-title", `${index + 1}. ${purpose}`));
		const model = element("span", "call-model", call.model);
		model.title = call.model;
		summary.append(model);
		const status = element(
			"span",
			"call-status",
			call.status === "running" ? "调用中" : statusLabels[call.status] || call.status,
		);
		status.dataset.status = call.status;
		summary.append(status);
		card.append(summary);
		const body = element("div", "prompt-body");
		const meta = element("div", "call-meta");
		if (call.status !== "running" && formatDuration(call.duration_ms))
			meta.append(element("span", "", formatDuration(call.duration_ms)));
		if (typeof call.input_tokens === "number") meta.append(element("span", "", `输入 ${call.input_tokens} token`));
		if (typeof call.output_tokens === "number") meta.append(element("span", "", `输出 ${call.output_tokens} token`));
		if (meta.children.length) body.append(meta);
		// 三个角色区独立滚动；结构化内容仅转换阅读排版，复制始终使用真实收发原文。
		for (const [role, labelText, value] of [
			["system", "system · 系统提示词", call.system_prompt],
			["user", "user · 输入", call.user_prompt],
			["assistant", "assistant · 输出", call.output_text],
		]) {
			const section = element("section", "prompt-section");
			const heading = element("div", "prompt-field-heading");
			const label = element("label", "prompt-label", labelText);
			const field = element("textarea", "prompt-text");
			field.id = `${key}-${role}`;
			field.dataset.focusKey = field.id;
			label.htmlFor = field.id;
			field.readOnly = true;
			field.spellcheck = false;
			field.rows = 8;
			field.value =
				typeof value === "string"
					? value === "" && role === "assistant"
						? call.status === "running"
							? "等待模型输出…"
							: "未收到输出文本。"
						: role === "system"
							? value
							: readablePrompt(value)
					: role === "assistant"
						? "此历史调用未记录输出原文。"
						: "该次调用未记录此内容。";
			const copy = element("button", "copy-prompt text-button", "复制");
			copy.type = "button";
			copy.disabled = typeof value !== "string" || value.length === 0;
			copy.dataset.focusKey = `${key}-${role}-copy`;
			copy.setAttribute("aria-label", `复制调用 ${index + 1} 的 ${role} 原文`);
			copy.title = "复制原文";
			copy.addEventListener("click", async () => {
				try {
					await navigator.clipboard.writeText(value);
					copy.textContent = "已复制";
				} catch {
					copy.textContent = "复制失败";
					copy.title = "请选中文本复制，或检查剪贴板权限";
				}
			});
			heading.append(label, copy);
			section.append(heading, field);
			body.append(section);
		}
		if (terminalStates.has(call.status) && call.status !== "completed" && call.output_text)
			body.append(element("p", "panel-note", "本次调用未成功完成，以上保留已收到的输出。"));
		if (call.error) body.append(element("p", "stage-error", call.error));
		card.append(body);
		children.push(card);
	}
	replacePanelContent($("prompt-content"), children);
}

function appendFacts(parent, entries) {
	const list = element("dl", "stage-facts");
	for (const [label, value] of entries) {
		if (value === undefined || value === null || value === "") continue;
		const row = element("div");
		row.append(element("dt", "", label), element("dd", "", typeof value === "object" ? JSON.stringify(value) : value));
		list.append(row);
	}
	if (list.children.length) parent.append(list);
}

function appendCode(parent, label, value) {
	if (value === undefined || value === null) return;
	const block = element("div", "trace-code");
	block.append(
		element("p", "prompt-label", label),
		element("pre", "", typeof value === "string" ? value : JSON.stringify(value, null, 2)),
	);
	parent.append(block);
}

function appendTags(parent, label, values) {
	if (!Array.isArray(values) || !values.length) return;
	parent.append(element("p", "prompt-label", label));
	const tags = element("div", "evidence-tags");
	for (const value of values)
		tags.append(element("span", "", typeof value === "object" ? JSON.stringify(value) : value));
	parent.append(tags);
}

// 证据表是已取得结果的前五行核对，明确预览范围，不把样本行数称作总数。
function appendTraceResult(parent, result) {
	if (!Array.isArray(result?.rows) || !Array.isArray(result.columns)) return;
	const wrap = element("div", "trace-result");
	wrap.append(
		element(
			"p",
			"panel-note",
			`${result.columns.length} 列 · 已载入 ${result.rows.length} 行 · ${result.complete ? "完整结果" : "部分结果"}`,
		),
	);
	if (result.rows.length) {
		const scroll = element("div", "table-scroll");
		const table = element("table");
		const head = element("thead"),
			header = element("tr");
		for (const name of result.columns) {
			const cell = element("th", "", name);
			cell.scope = "col";
			header.append(cell);
		}
		head.append(header);
		const body = element("tbody");
		for (const row of result.rows.slice(0, 5)) {
			const tr = element("tr");
			result.columns.forEach((name, index) => {
				const value = Array.isArray(row) ? row[index] : row[name];
				tr.append(
					element("td", "", value == null ? "NULL" : typeof value === "object" ? JSON.stringify(value) : value),
				);
			});
			body.append(tr);
		}
		table.append(head, body);
		scroll.append(table);
		wrap.append(scroll);
	} else wrap.append(element("p", "panel-note", result.complete ? "没有符合条件的记录。" : "尚未收到结果行。"));
	if (result.rows.length > 5) wrap.append(element("p", "panel-note", "这里预览前 5 行，更多数据见中间结果表。"));
	parent.append(wrap);
}

// 六层是业务证据视图：理解、匹配和计划来自同一次决策，不补造独立调用或耗时。
const evidenceLayers = [
	["catalog", "数据源与目录", "固定本轮查询的数据范围"],
	["intent", "意图与口径", "明确问题、条件与处理方向"],
	["linking", "Schema Linking", "将业务含义对应到表、字段和关系"],
	["plan", "查询计划", "形成受约束的结构化查询"],
	["execution", "SQL 校验与执行", "编译参数化 SQL，读取真实数据"],
	["answer", "结果核验与回答", "核对结果引用，再交付说明"],
];

// 保留追问运行段和每次修复尝试；失败计划与后续成功计划不能被混成一套证据。
function evidenceAttempts(stages) {
	const runs = new Map();
	for (const stage of stages) {
		const runId = stage.run_id || "unrecorded";
		if (!runs.has(runId)) runs.set(runId, { number: runs.size + 1, catalog: null, attempts: [] });
		const run = runs.get(runId);
		if (stage.kind === "catalog") run.catalog = stage;
		else {
			if (stage.kind === "decision" || !run.attempts.length) run.attempts.push({});
			run.attempts.at(-1)[stage.kind] = stage;
		}
	}
	return [...runs.entries()].flatMap(([runId, run]) =>
		(run.attempts.length ? run.attempts : [{}]).map((attempt, index) => ({
			...attempt,
			catalog: run.catalog,
			runId,
			runNumber: run.number,
			number: index + 1,
			key: `${runId}-${index + 1}`,
		})),
	);
}

// 只解析与当前阶段 ID 关联的实际请求，禁止把最终一次的输入回填到历史修复或追问。
function recordedInput(turn, stage) {
	const call = turn.model_calls?.find((item) => stage?.model_call_id && item.id === stage.model_call_id);
	try {
		const value = JSON.parse(call?.user_prompt || "null");
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

function appendTraceDisclosure(parent, label, value, key) {
	if (value === undefined || value === null) return;
	const detail = element("details", "raw-evidence");
	detail.dataset.key = key;
	const summary = element("summary", "", label);
	summary.dataset.focusKey = key;
	detail.append(summary, element("pre", "", typeof value === "string" ? value : JSON.stringify(value, null, 2)));
	parent.append(detail);
}

// 过层变量保留实际名称和值；复杂对象按需查看，空数组、false 与 0 均保留其真实含义。
function appendHandoff(parent, entries, key) {
	const list = element("dl", "handoff-values");
	for (const [name, value] of entries) {
		if (value === undefined) continue;
		const row = element("div", "trace-variable");
		const label = element("dt", "variable-name");
		label.append(element("code", "", name));
		const content = element("dd", "variable-value");
		if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
			content.textContent = value.length ? value.join("、") : "空数组（0 项）";
		} else if (value !== null && typeof value === "object") {
			appendTraceDisclosure(
				content,
				Array.isArray(value) ? `查看值（${value.length} 项）` : "查看结构化值",
				value,
				`${key}-${name}`,
			);
		} else content.textContent = value === null ? "null" : String(value);
		row.append(label, content);
		list.append(row);
	}
	if (list.children.length) parent.append(list);
}

function layerState(kind, attempt, turn, latest) {
	const stage = ["intent", "linking", "plan"].includes(kind) ? attempt.decision : attempt[kind];
	if (!stage) return { status: "not_run", label: "未执行" };
	if (["intent", "linking", "plan"].includes(kind) && stage.status === "completed") {
		const data = stage.data || {};
		if (kind === "intent") {
			if (data.action === "clarify")
				return {
					status: latest && turn.status === "waiting_for_user" ? "waiting_for_user" : "completed",
					label: latest && turn.status === "waiting_for_user" ? "等待补充" : "已提出追问",
				};
			if (data.action === "blocked") return { status: "blocked", label: "能力不足" };
			return {
				status: data.action === "query" ? "completed" : "failed",
				label: data.action === "query" ? "已决策" : "决策无效",
			};
		}
		const hasOutput =
			kind === "linking"
				? [data.linking?.tables, data.linking?.fields, data.linking?.relations].some(
						(values) => Array.isArray(values) && values.length,
					)
				: data.dsl && typeof data.dsl === "object" && Object.keys(data.dsl).length > 0;
		if (data.action !== "query")
			return { status: hasOutput ? "recorded" : "not_run", label: hasOutput ? "候选记录" : "未执行" };
		return { status: hasOutput ? "completed" : "missing", label: hasOutput ? "已生成" : "未记录产物" };
	}
	return {
		status: stage.status,
		label:
			stage.status === "completed"
				? "已完成"
				: stage.status === "running"
					? "进行中"
					: statusLabels[stage.status] || stage.status,
	};
}

function renderLayer(kind, title, description, index, attempt, turn, latest) {
	const stage = ["intent", "linking", "plan"].includes(kind) ? attempt.decision : attempt[kind];
	const state = layerState(kind, attempt, turn, latest);
	const data = stage?.data || {};
	const decision = attempt.decision?.data || {};
	const input = recordedInput(turn, stage);
	const result = attempt.execution?.data?.result;
	const key = `layer-${turn.id}-${attempt.key}-${kind}`;
	const item = element("li", "stage-item");
	item.dataset.status = state.status;
	item.append(element("span", "layer-node", String(index + 1).padStart(2, "0")));
	const card = element("details", "layer-card");
	card.dataset.key = key;
	// 默认展开字段匹配，其余层先展示职责和状态，六层入口保持清晰可扫描。
	card.open = kind === "linking" && state.status !== "not_run";
	const heading = element("summary", "layer-summary");
	heading.dataset.focusKey = key;
	const row = element("div", "layer-title-row");
	const badge = element("span", "stage-status", state.label);
	badge.dataset.status = state.status;
	row.append(element("h3", "", title), badge);
	heading.append(row, element("p", "layer-description", description));
	const meta = element("div", "layer-meta");
	if (["intent", "linking", "plan"].includes(kind) && stage) {
		meta.append(element("span", "", kind === "intent" ? "理解、匹配与计划共用一次决策" : "共用第 02 层决策记录"));
	} else if (kind === "execution" && stage) meta.append(element("span", "", "校验、编译与执行联合记录"));
	else if (kind === "answer" && data.method === "empty_result_summary")
		meta.append(element("span", "", "空结果说明 · 未调用答案模型"));
	if (stage && !["linking", "plan"].includes(kind)) {
		if (kind === "catalog" && attempt.number > 1) meta.append(element("span", "", "沿用本运行段目录"));
		else if (stage.status !== "running")
			meta.append(element("span", "stage-duration", formatDuration(stage.duration_ms) || "耗时未记录"));
	}
	if (meta.children.length) heading.append(meta);
	card.append(heading);
	const body = element("div", "layer-body");
	const sections = {};
	for (const [type, label] of [
		["input", "输入"],
		["output", "输出"],
		["handoff", kind === "answer" ? "交付变量" : "传递给下一层"],
	]) {
		const section = element("section", `layer-section layer-${type}`);
		section.append(element("h4", "layer-section-heading", label));
		sections[type] = section;
		body.append(section);
	}
	if (kind === "catalog") {
		appendFacts(sections.input, [["当前数据源", sourceName(turn.source_id)]]);
		appendTags(sections.output, "可用数据表", data.tables);
		appendTraceDisclosure(sections.output, "查看完整表列、关系与语义目录", data.catalog, `${key}-catalog`);
		appendHandoff(
			sections.handoff,
			[
				["source_id", data.source_id],
				["source_version", data.source_version],
				["catalog.tables", data.catalog?.tables],
			],
			key,
		);
	} else if (kind === "intent") {
		appendFacts(sections.input, [
			["原始问题", input.question],
			["时间锚点", input.as_of],
			["修复依据", input.correction],
		]);
		appendTraceDisclosure(sections.input, "本次已接受的补充", input.replies, `${key}-replies`);
		appendTraceDisclosure(sections.input, "本次继承的历史条件", input.prior, `${key}-prior`);
		appendFacts(sections.output, [
			["处理方向", { query: "执行查询", clarify: "先补充口径", blocked: "当前无法回答" }[data.action]],
			["决策依据", data.reason],
			["追问", data.question],
		]);
		appendTags(sections.output, "生效条件", data.conditions);
		appendTags(sections.output, "待确认选项", data.options);
		appendHandoff(
			sections.handoff,
			[
				["action", data.action],
				["conditions", data.conditions],
				["as_of", input.as_of],
			],
			key,
		);
	} else if (kind === "linking") {
		appendFacts(sections.input, [
			["问题", input.question],
			["目录范围", Array.isArray(input.catalog?.tables) ? `${input.catalog.tables.length} 张表` : undefined],
		]);
		appendTags(sections.input, "本次条件", data.conditions);
		appendTags(sections.output, "命中表", data.linking?.tables);
		appendTags(sections.output, "命中字段", data.linking?.fields);
		appendTags(sections.output, "使用关系", data.linking?.relations);
		appendHandoff(
			sections.handoff,
			[
				["linking.tables", data.linking?.tables],
				["linking.fields", data.linking?.fields],
				["linking.relations", data.linking?.relations],
			],
			key,
		);
	} else if (kind === "plan") {
		appendTags(sections.input, "匹配字段", data.linking?.fields);
		appendTags(sections.input, "需要保留的条件", data.conditions);
		appendFacts(sections.output, [
			["主表", data.dsl?.from],
			["输出项", data.dsl?.select?.length],
			["过滤条件", data.dsl?.where?.length],
			["关联数", data.dsl?.joins?.length],
		]);
		appendTraceDisclosure(sections.output, "查看完整 DSL 查询计划", data.dsl, `${key}-dsl`);
		appendHandoff(
			sections.handoff,
			[
				["dsl.from", data.dsl?.from],
				["dsl.select", data.dsl?.select],
				["dsl.where", data.dsl?.where],
				["dsl.joins", data.dsl?.joins],
				["dsl.group_by", data.dsl?.group_by],
				["dsl.order_by", data.dsl?.order_by],
				["dsl.limit", data.dsl?.limit],
			],
			key,
		);
	} else if (kind === "execution") {
		appendTraceDisclosure(
			sections.input,
			"本次提交的查询计划",
			data.dsl || (stage ? decision.dsl : undefined),
			`${key}-submitted`,
		);
		appendCode(sections.output, "实际 SQL", data.result?.sql);
		appendCode(sections.output, "绑定参数", data.result?.parameters);
		appendTraceResult(sections.output, data.result);
		appendHandoff(
			sections.handoff,
			[
				["result.columns", data.result?.columns],
				["result.row_count", data.result?.row_count],
				["result.complete", data.result?.complete],
				["result.truncated", data.result?.truncated],
				["result.total", data.result?.total],
			],
			key,
		);
	} else if (kind === "answer") {
		appendFacts(sections.input, [
			["问题", input.question],
			[
				"模型实际接收",
				Array.isArray(input.rows)
					? `${input.rows.length} 行预览`
					: data.method === "empty_result_summary"
						? "0 行，不调用答案模型"
						: undefined,
			],
			["结果范围", input.complete === true ? "完整结果" : input.complete === false ? "部分结果" : undefined],
		]);
		appendTags(sections.input, "结果列", input.columns);
		appendTraceDisclosure(sections.input, "查看答案模型实际收到的结果预览", input.rows, `${key}-preview`);
		if (data.answer) sections.output.append(element("p", "stage-answer", data.answer));
		appendTags(sections.output, "已核对的单元格引用", data.facts);
		appendHandoff(
			sections.handoff,
			[
				["answer_status", data.answer_status],
				["method", data.method],
				["result.complete", stage ? result?.complete : undefined],
				["facts", data.facts],
			],
			key,
		);
	}
	// 阻断与尚未开始的阶段不显示上游候选为执行结果；未采集数据明确留空。
	if (state.status === "not_run") {
		for (const section of Object.values(sections)) {
			while (section.children.length > 1) section.lastElementChild.remove();
		}
	}
	for (const [type, section] of Object.entries(sections)) {
		if (section.children.length === 1)
			section.append(
				element(
					"p",
					"layer-note",
					state.status === "not_run"
						? "此层未执行，无已记录产物。"
						: type === "input"
							? "本条记录未采集该层输入。"
							: stage?.status === "running"
								? "等待本次操作返回。"
								: "本条记录未采集此项。",
				),
			);
	}
	if (stage?.error) body.append(element("p", "stage-error", stage.error));
	if (stage?.model_call_id) {
		// 共享决策层跳向同一真实调用，避免用户把三张业务卡理解为三次独立模型调用。
		const promptButton = element("button", "text-button", "查看该次 LLM 提示词");
		promptButton.type = "button";
		promptButton.dataset.focusKey = `${key}-prompt`;
		promptButton.addEventListener("click", () => {
			ui.selectedTurnId = turn.id;
			renderPrompts();
			setPanelOpen("prompt", true);
			const promptKey = `prompt-${turn.id}-${stage.model_call_id}`;
			const prompt = $("prompt-content").querySelector(`[data-key="${CSS.escape(promptKey)}"]`);
			if (prompt) {
				prompt.open = true;
				ui.expanded.set(promptKey, true);
				prompt.scrollIntoView({ block: "nearest" });
				prompt.querySelector("summary").focus({ preventScroll: true });
			}
		});
		body.append(promptButton);
	}
	if (["linking", "plan"].includes(kind) && decision.action && decision.action !== "query")
		body.append(element("p", "layer-note", "本次决策未进入查询，候选内容没有交给数据库执行。"));
	card.append(body);
	item.append(card);
	return item;
}

function renderEvidence() {
	const signature = JSON.stringify(
		ui.turns.map((turn) => [
			turn.id,
			turn.status,
			turn.stages,
			turn.model_calls,
			turn.evidence,
			turn.answer,
			turn.error,
			turn.clarification,
		]),
	);
	if (signature === ui.evidenceSignature) return;
	// 用户选中 SQL 或证据文字复制时延后替换，选区清除后再显示最新记录。
	ui.deferEvidence = hasTextSelection($("evidence-content"));
	if (ui.deferEvidence) return;
	ui.evidenceSignature = signature;
	const cards = [];
	for (const [reverseIndex, turn] of [...ui.turns].reverse().entries()) {
		const card = element("details", "evidence-turn");
		card.dataset.key = `turn-${turn.id}`;
		card.dataset.turnId = turn.id;
		card.open = turn.id === ui.selectedTurnId;
		const summary = element("summary");
		summary.dataset.focusKey = card.dataset.key;
		const l0 = isL0Turn(turn);
		const status = element("span", "stage-status", turnStatusLabel(turn));
		status.dataset.status = turn.status;
		const stages = Array.isArray(turn.stages) ? turn.stages : [];
		const attempts = evidenceAttempts(stages);
		const overview = element("span", "evidence-turn-overview");
		overview.append(
			status,
			element(
				"span",
				"evidence-count",
				stages.length ? `${l0 ? "指标匹配" : "6 层证据"} · ${stages.length} 条实际记录` : "阶段记录未采集",
			),
		);
		summary.append(
			element(
				"span",
				"evidence-turn-kicker",
				`第 ${ui.turns.length - reverseIndex} 轮问答 · ${formatTime(turn.created_at)}`,
			),
			element("span", "evidence-turn-title", turn.question),
			overview,
		);
		summary.addEventListener("click", () => {
			ui.selectedTurnId = turn.id;
			renderPrompts();
		});
		card.append(summary);
		const body = element("div", "evidence-turn-body");
		appendFacts(body, [
			["数据源", sourceName(turn.source_id)],
			["提问时间", formatTime(turn.created_at)],
		]);
		if (turn.status === "waiting_for_user")
			body.append(element("p", "panel-note", `等待补充：${turn.clarification?.question || "请在输入框补充信息。"}`));
		if (l0) {
			// 按实际阶段展示两次调用，不能把第二次匹配误标为失败后的定向修复。
			body.append(element("p", "panel-note", "当前仅验证指标与结构匹配；合成数据和约定不代表医院正式口径。"));
			const timeline = element("ol", "stage-timeline");
			for (const [index, stage] of stages.entries()) {
				const item = element("li", "stage-item");
				const detail = element("details", "layer-card");
				detail.dataset.key = `l0-${turn.id}-${stage.id || index}`;
				detail.open = true;
				const heading = element("summary", "layer-summary");
				heading.append(
					element("strong", "", stage.label || stage.kind),
					element("span", "stage-status", statusLabels[stage.status] || stage.status),
					element("span", "", formatDuration(stage.duration_ms)),
				);
				detail.append(heading);
				const content = element("div", "layer-body");
				if (stage.data !== undefined)
					appendTraceDisclosure(content, "本环节记录", stage.data, `l0-data-${turn.id}-${index}`);
				if (stage.error) content.append(element("p", "stage-error", stage.error));
				detail.append(content);
				item.append(detail);
				timeline.append(item);
			}
			body.append(timeline);
			if (turn.evidence?.linking) {
				appendFacts(body, [
					["命中指标", (turn.evidence.metric_statuses || []).map((metric) => metric.name).join("、") || "无"],
					["匹配表", turn.evidence.linking.tables.join("、") || "无"],
					["待确认规则", turn.evidence.linking.unresolved_rule_ids.length],
				]);
				appendTraceDisclosure(body, "字段、关系与代码匹配", turn.evidence.linking, `l0-linking-${turn.id}`);
				appendTraceDisclosure(body, "指标能力与缺口", turn.evidence.metric_statuses, `l0-gaps-${turn.id}`);
			}
		} else if (stages.length) {
			for (const [index, attempt] of attempts.entries()) {
				const run = element("section", "evidence-run");
				const heading = element("header", "evidence-run-heading");
				heading.append(
					element(
						"h3",
						"evidence-run-title",
						`运行段 ${attempt.runNumber} · ${attempt.number === 1 ? "首次规划" : `定向修复 ${attempt.number - 1}`}`,
					),
				);
				heading.append(element("p", "evidence-run-note", "第 02–04 层共用一次决策；仅展示实际记录。"));
				run.append(heading);
				const timeline = element("ol", "stage-timeline");
				for (const [layerIndex, [kind, title, description]] of evidenceLayers.entries())
					timeline.append(
						renderLayer(kind, title, description, layerIndex, attempt, turn, index === attempts.length - 1),
					);
				run.append(timeline);
				body.append(run);
			}
		} else
			body.append(
				element(
					"p",
					"panel-note",
					terminalStates.has(turn.status)
						? "这条历史记录未采集逐阶段信息，以下保留已有查询依据。"
						: "等待任务开始，实际阶段将随查询更新。",
				),
			);
		if (turn.error) body.append(element("p", "stage-error", turn.error));
		appendTraceDisclosure(body, "完整查询依据", turn.evidence, `raw-${turn.id}`);
		card.append(body);
		cards.push(card);
	}
	if (!cards.length) cards.push(element("p", "panel-note", "提问后，在这里查看逐轮证据。"));
	replacePanelContent($("evidence-content"), cards);
}

// 只保存两个栏宽；桌面拖动限制中央阅读宽度，窄屏使用单侧抽屉。
function syncPanels() {
	const empty = !ui.turns.length;
	if (empty) ui.panels = { prompt: false, evidence: false };
	const room = Math.max(480, $("workspace-body").clientWidth - 448);
	if (!narrowScreen.matches && ui.panels.prompt && ui.panels.evidence && ui.widths.prompt + ui.widths.evidence > room) {
		ui.widths.prompt = Math.max(240, Math.min(ui.widths.prompt, room - 240));
		ui.widths.evidence = Math.max(240, room - ui.widths.prompt);
	}
	for (const side of ["prompt", "evidence"]) {
		const open = ui.panels[side];
		const width = Math.min(ui.widths[side], room);
		$("workspace").style.setProperty(`--${side}-width`, `${width}px`);
		$("workspace").style.setProperty(`--${side}-track`, `${open ? width : 0}px`);
		$("workspace").classList.toggle(side === "prompt" ? "prompts-open" : "evidence-open", open);
		$(`${side}-panel`).hidden = !open;
		// 把手是桌面与窄屏共同的开合入口，替代重复的顶部按钮和面板标题栏。
		$(`${side}-handle`).setAttribute("aria-expanded", String(open));
		$(`${side}-handle`).setAttribute("aria-controls", `${side}-panel`);
		const name = side === "prompt" ? "提示词" : "查询证据";
		$(`${side}-handle`).setAttribute("aria-label", `${open ? "收起" : "展开"}${name}`);
		$(`${side}-handle`).textContent = (side === "prompt") === open ? "‹" : "›";
		const separator = $(`${side}-splitter`);
		separator.tabIndex = narrowScreen.matches ? -1 : 0;
		separator.setAttribute("aria-valuenow", String(open ? Math.round(width) : 0));
		separator.setAttribute(
			"aria-valuemax",
			String(
				Math.round(
					Math.min(
						640,
						room -
							(ui.panels[side === "prompt" ? "evidence" : "prompt"]
								? ui.widths[side === "prompt" ? "evidence" : "prompt"]
								: 0),
					),
				),
			),
		);
	}
	const modal = narrowScreen.matches && (ui.panels.prompt || ui.panels.evidence);
	for (const side of ["prompt", "evidence"]) $(`${side}-splitter`).inert = modal && !ui.panels[side];
	$("panel-backdrop").hidden = !modal;
	document.querySelector(".chat-panel").inert = modal;
	document.querySelector(".topbar").inert = modal;
	document.querySelector(".composer-dock").inert = modal;
}

function setPanelOpen(side, open, focus = true) {
	const panel = $(`${side}-panel`);
	const handle = $(`${side}-handle`);
	const restoreFocus =
		panel.contains(document.activeElement) ||
		document.activeElement === handle ||
		document.activeElement === $("panel-backdrop");
	ui.panels[side] = Boolean(open && ui.turns.length);
	if (open && narrowScreen.matches) ui.panels[side === "prompt" ? "evidence" : "prompt"] = false;
	syncPanels();
	persistPanels();
	if ((open && focus) || (!open && restoreFocus && ui.turns.length)) handle.focus({ preventScroll: true });
}

function openTurnPanels() {
	// 仅新问题被接受时自动展开；用户手动收起后，轮询不会反复打开。手机保留对话可见。
	if (narrowScreen.matches) return;
	ui.panels = { prompt: true, evidence: true };
	syncPanels();
	persistPanels();
}

// 面板开合按当前会话保存，刷新可恢复手动收起状态；新问题仍按产品约定展开。
function persistPanels() {
	writeStorage("medical-query-panel-state", JSON.stringify({ conversation: ui.conversationId, ...ui.panels }));
}

function resizePanel(side, width) {
	if (narrowScreen.matches) return;
	const other = side === "prompt" ? "evidence" : "prompt";
	const max = Math.min(640, $("workspace-body").clientWidth - 448 - (ui.panels[other] ? ui.widths[other] : 0));
	ui.widths[side] = Math.max(240, Math.min(width, max));
	ui.panels[side] = true;
	syncPanels();
}

// 用浏览器指针捕获处理鼠标/触控拖拽，同时提供方向键、Home/End 和 Enter 折叠。
function bindSplitter(side) {
	const separator = $(`${side}-splitter`);
	let drag = null;
	separator.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || narrowScreen.matches) return;
		event.preventDefault();
		separator.focus();
		separator.dataset.dragged = "false";
		drag = {
			x: event.clientX,
			width: ui.panels[side] ? ui.widths[side] : 0,
			pointer: event.pointerId,
			handle: Boolean(event.target.closest("button")),
		};
		separator.setPointerCapture(event.pointerId);
		$("workspace").classList.add("is-resizing");
	});
	separator.addEventListener("pointermove", (event) => {
		if (!drag || drag.pointer !== event.pointerId) return;
		if (Math.abs(event.clientX - drag.x) < 4 && separator.dataset.dragged !== "true") return;
		separator.dataset.dragged = "true";
		resizePanel(side, drag.width + (event.clientX - drag.x) * (side === "prompt" ? 1 : -1));
	});
	const finish = (event) => {
		if (!drag) return;
		if (event.type === "pointerup" && drag.handle && separator.dataset.dragged !== "true")
			setPanelOpen(side, !ui.panels[side], false);
		drag = null;
		$("workspace").classList.remove("is-resizing");
		writeStorage("medical-query-panel-widths", JSON.stringify(ui.widths));
		persistPanels();
	};
	separator.addEventListener("pointerup", finish);
	separator.addEventListener("pointercancel", finish);
	separator.addEventListener("lostpointercapture", finish);
	// 桌面指针点击由 pointerup 处理；窄屏不启动拖拽，直接由 click 控制抽屉。
	$(`${side}-handle`).addEventListener("click", (event) => {
		if (narrowScreen.matches || event.detail === 0) setPanelOpen(side, !ui.panels[side]);
	});
	separator.addEventListener("keydown", (event) => {
		if (event.target !== separator || narrowScreen.matches) return;
		if (event.key === "Enter") {
			event.preventDefault();
			setPanelOpen(side, !ui.panels[side], false);
			return;
		}
		if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const delta = (event.key === "ArrowRight" ? 20 : -20) * (side === "prompt" ? 1 : -1);
		resizePanel(side, event.key === "Home" ? 240 : event.key === "End" ? 640 : ui.widths[side] + delta);
		writeStorage("medical-query-panel-widths", JSON.stringify(ui.widths));
		persistPanels();
	});
}

function schedulePoll(delay = 1100) {
	clearTimeout(ui.pollTimer);
	const turn = activeTurn();
	if (!turn || turn.status === "waiting_for_user") return;
	const epoch = ui.epoch;
	ui.pollTimer = setTimeout(async () => {
		try {
			const data = await api(`/api/turns/${encodeURIComponent(turn.id)}`);
			if (epoch !== ui.epoch) return;
			showNotice();
			upsertTurn(turnFromResponse(data));
		} catch (error) {
			if (epoch !== ui.epoch) return;
			showNotice(`暂时无法更新任务状态：${error.message}。正在重新连接；不会重复提交查询。`);
			schedulePoll(3000);
		}
	}, delay);
}

async function restoreConversation() {
	const epoch = ui.epoch;
	const data = await api(`/api/turns?conversation_id=${encodeURIComponent(ui.conversationId)}`);
	if (epoch !== ui.epoch) return;
	ui.turns = (Array.isArray(data) ? data : data.turns || []).filter(
		(turn) => !turn.conversation_id || turn.conversation_id === ui.conversationId,
	);
	const latest = ui.turns.at(-1);
	if (requestedConversation && !latest) throw new Error("这条历史会话不存在或已不可用");
	if (requestedSource && latest && latest.source_id !== requestedSource)
		throw new Error("链接的数据源与已保存会话不一致");
	// 隐藏选择器后仍严格恢复原数据源，不能把旧会话静默转到默认库。
	if (latest) ui.sourceId = latest.source_id;
	if (!currentSource())
		showNotice(latest ? "此对话的数据源已不可用，请新建对话后继续。" : "暂无可用数据，请接入数据后刷新页面。");
	ui.selectedTurnId = ui.turns.find((turn) => turn.id === requestedTurnId)?.id || latest?.id || null;
	// 验证真实会话后才保存，失效链接不能覆盖原有会话标识。
	writeStorage(conversationStorageKey, ui.conversationId);
	writeStorage(sourceStorageKey, ui.sourceId);
	renderSources();
	renderTurns();
	renderPrompts();
	renderEvidence();
	schedulePoll();
}

async function submitQuestion(event) {
	event.preventDefault();
	const answer = $("question-input").value.trim();
	if (!answer || ui.busy || !ui.loaded || !currentSource()) return;
	const turn = activeTurn();
	if (turn && turn.status !== "waiting_for_user") return;
	ui.busy = true;
	updateComposer();
	showNotice();
	try {
		let data;
		if (turn) {
			const revision = turn.clarification?.revision;
			const key = `${turn.id}:${revision}:${answer}`;
			if (ui.submissionAttempt?.key !== key) ui.submissionAttempt = { key, id: crypto.randomUUID() };
			data = await api(`/api/turns/${encodeURIComponent(turn.id)}/reply`, {
				submission_id: ui.submissionAttempt.id,
				clarification_id: turn.clarification?.id,
				revision,
				answer,
			});
		} else {
			const key = `${ui.conversationId}:${ui.sourceId}:${answer}`;
			if (ui.requestAttempt?.key !== key) ui.requestAttempt = { key, id: crypto.randomUUID() };
			data = await api("/api/query", {
				conversation_id: ui.conversationId,
				source_id: ui.sourceId,
				question: answer,
				request_id: ui.requestAttempt.id,
			});
		}
		const next = turnFromResponse(data);
		ui.selectedTurnId = next.id;
		$("question-input").value = "";
		ui.requestAttempt = null;
		ui.submissionAttempt = null;
		upsertTurn(next);
		openTurnPanels();
		$("conversation-scroll").scrollTop = $("conversation-scroll").scrollHeight;
	} catch (error) {
		showNotice(`提交未确认：${error.message}。已保留输入，请核对当前任务状态后再试。`);
		// 网络结果不明确时先回读任务，避免将“未收到响应”误认为“没有执行”。
		try {
			await restoreConversation();
		} catch {
			/* 保留原错误与草稿，后续提交复用去重标识。 */
		}
	} finally {
		ui.busy = false;
		updateComposer();
		$("question-input").focus();
	}
}

function newConversation(sourceId = ui.sourceId) {
	if (!ui.loaded || ui.busy || activeTurn()) return;
	// 新对话清除历史定位，刷新时继续恢复新会话，同时保留数据源入口。
	requestedConversation = null;
	requestedTurnId = null;
	const nextUrl = new URL(location.href);
	nextUrl.searchParams.delete("conversation");
	nextUrl.searchParams.delete("turn");
	history.replaceState(null, "", nextUrl);
	clearTimeout(ui.pollTimer);
	ui.epoch += 1;
	ui.conversationId = crypto.randomUUID();
	// 仅新会话允许从不可用的旧库回退到首个可用库；原会话标识始终不变更。
	ui.sourceId = requestedSource
		? ui.sources.find((source) => source.id === requestedSource)?.id || ""
		: ui.sources.find((source) => source.id === sourceId)?.id || ui.sources[0]?.id || "";
	ui.turns = [];
	ui.selectedTurnId = null;
	ui.pages.clear();
	ui.requestAttempt = null;
	ui.submissionAttempt = null;
	ui.expanded.clear();
	ui.promptSignature = "";
	ui.evidenceSignature = "";
	ui.turnSignature = "";
	ui.deferTurns = false;
	ui.deferEvidence = false;
	writeStorage(conversationStorageKey, ui.conversationId);
	writeStorage(sourceStorageKey, ui.sourceId);
	$("question-input").value = "";
	$("prompt-content").replaceChildren();
	$("evidence-content").replaceChildren();
	showNotice(currentSource() ? "" : "暂无可用数据，请接入数据后刷新页面。");
	renderSources();
	renderTurns();
	renderPrompts();
	renderEvidence();
	$("live-announcement").textContent = "新对话";
	$("question-input").focus();
}

$("composer").addEventListener("submit", submitQuestion);
$("question-input").addEventListener("input", updateComposer);
$("question-input").addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		submitQuestion(event);
	}
});
$("new-conversation").addEventListener("click", () => newConversation());
$("source-select").addEventListener("change", (event) => newConversation(event.target.value));
for (const side of ["prompt", "evidence"]) bindSplitter(side);
$("prompt-turn-select").addEventListener("change", (event) => {
	ui.selectedTurnId = event.target.value;
	renderPrompts();
});
$("panel-backdrop").addEventListener("click", () => setPanelOpen(ui.panels.prompt ? "prompt" : "evidence", false));
document.addEventListener("selectionchange", () => {
	if (ui.deferTurns && !hasTextSelection($("turns"))) {
		ui.deferTurns = false;
		renderTurns();
	}
	if (ui.deferEvidence && !hasTextSelection($("evidence-content"))) {
		ui.deferEvidence = false;
		renderEvidence();
	}
});
document.addEventListener("keydown", (event) => {
	const side =
		ui.panels.prompt &&
		($("prompt-panel").contains(document.activeElement) || $("prompt-splitter").contains(document.activeElement))
			? "prompt"
			: ui.panels.evidence
				? "evidence"
				: ui.panels.prompt
					? "prompt"
					: null;
	if (!side) return;
	const panel = $(`${side}-panel`);
	if (event.key === "Escape") setPanelOpen(side, false);
	if (event.key === "Tab" && narrowScreen.matches) {
		// 把手虽在抽屉外，仍作为首个焦点；显式循环顺序避免移除标题栏后失去关闭入口。
		const controls = [...panel.querySelectorAll("button:not(:disabled), summary, textarea, select")].filter(
			(control) => {
				if (!control.getClientRects().length) return false;
				// 部分浏览器为折叠卡片的后代保留布局尺寸；焦点循环只包含真正可操作的展开内容。
				for (let ancestor = control.parentElement; ancestor && ancestor !== panel; ancestor = ancestor.parentElement) {
					if (
						ancestor.tagName === "DETAILS" &&
						!ancestor.open &&
						control !== ancestor.querySelector(":scope > summary")
					) {
						return false;
					}
				}
				return true;
			},
		);
		controls.unshift($(`${side}-handle`));
		const current = controls.indexOf(document.activeElement);
		const next = (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
		event.preventDefault();
		controls[next]?.focus();
	}
});
window.addEventListener("resize", () => {
	if (narrowScreen.matches && ui.panels.prompt && ui.panels.evidence) {
		ui.panels[$("prompt-panel").contains(document.activeElement) ? "evidence" : "prompt"] = false;
	}
	syncPanels();
	if (narrowScreen.matches && (ui.panels.prompt || ui.panels.evidence)) {
		const side = ui.panels.prompt ? "prompt" : "evidence";
		if (!$(`${side}-panel`).contains(document.activeElement)) $(`${side}-handle`).focus({ preventScroll: true });
	}
});
$("theme-toggle").addEventListener("click", () =>
	setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
);
$("stop-button").addEventListener("click", async () => {
	const turn = activeTurn();
	if (!turn || ui.busy) return;
	ui.busy = true;
	ui.cancelingId = turn.id;
	updateComposer();
	showNotice();
	try {
		upsertTurn(turnFromResponse(await api(`/api/turns/${encodeURIComponent(turn.id)}/cancel`, {})));
	} catch (error) {
		showNotice(`未能确认停止：${error.message}。任务状态仍以服务端为准。`);
	} finally {
		ui.busy = false;
		ui.cancelingId = null;
		updateComposer();
	}
});

// 启动时并行读取公共状态和目录，再恢复本会话；没有成功响应就不显示服务就绪。
async function initialize() {
	setTheme(document.documentElement.dataset.theme);
	// 非法或过期的本地宽度不影响页面启动，恢复后仍按当前窗口重新夹紧。
	try {
		const savedWidths = JSON.parse(readStorage("medical-query-panel-widths") || "null");
		for (const side of ["prompt", "evidence"])
			if (Number.isFinite(savedWidths?.[side])) ui.widths[side] = Math.max(240, Math.min(640, savedWidths[side]));
	} catch {
		/* 保留默认宽度。 */
	}
	syncPanels();
	const checks = await Promise.allSettled([api("/api/status"), api("/api/sources")]);
	if (checks[0].status === "fulfilled") {
		const state = checks[0].value;
		const model = typeof state.model === "string" ? state.model : state.model?.name || state.model?.id;
		$("model-name").textContent = model || "服务端未配置";
		$("service-status").className = "service-status connected";
		// 正常状态保持首页安静，仅模型未配置或连接失败时显示服务提示。
		$("service-status").hidden = state.credential_configured !== false;
		$("service-status").lastElementChild.textContent =
			state.credential_configured === false ? "服务已连接，模型待配置" : "服务已连接";
		// 演示库明确标识为合成数据，避免用户把界面样本当作医院真实记录。
		if (state.synthetic_data === true) {
			$("workspace").querySelector(".workspace-footnote").textContent = "当前为合成数据验证环境，不包含真实患者记录。";
			$("service-status").lastElementChild.textContent += " · 合成数据";
		}
	} else {
		$("service-status").className = "service-status offline";
		$("service-status").hidden = false;
		$("service-status").lastElementChild.textContent = "服务暂不可用";
		$("model-name").textContent = "未读取到模型配置";
	}
	if (checks[1].status === "fulfilled") {
		ui.sources = checks[1].value.sources || [];
		const saved = readStorage(sourceStorageKey);
		ui.sourceId = requestedSource
			? ui.sources.find((source) => source.id === requestedSource)?.id || ""
			: ui.sources.find((source) => source.id === saved)?.id || ui.sources[0]?.id || "";
		renderSources();
		try {
			// 恢复完成前禁止发送，避免把待答会话误作新查询或使用默认数据源。
			await restoreConversation();
			ui.loaded = true;
			if (ui.turns.length && !narrowScreen.matches) {
				let savedPanels = null;
				try {
					savedPanels = JSON.parse(readStorage("medical-query-panel-state") || "null");
				} catch {
					/* 使用默认开合状态。 */
				}
				if (savedPanels?.conversation === ui.conversationId) {
					ui.panels = { prompt: savedPanels.prompt === true, evidence: savedPanels.evidence === true };
					syncPanels();
				} else openTurnPanels();
			}
			if (requestedTurnId) {
				const target = $("turns").querySelector(`[data-turn-id="${CSS.escape(requestedTurnId)}"]`);
				if (target) {
					// 与左侧调用卡和右侧证据选中同一回合，历史入口无需再手动寻找原问题。
					target.scrollIntoView({ block: "start", behavior: "instant" });
					const question = target.querySelector(".turn-question");
					question.tabIndex = -1;
					question.focus({ preventScroll: true });
				} else showNotice("未找到指定回合，已展示该会话现存记录。");
			}
		} catch (error) {
			showNotice(`无法恢复当前会话：${error.message}。请刷新重试，避免重复提交。`);
			ui.loaded = false;
		}
	} else {
		showNotice(`读取数据源失败：${checks[1].reason.message}。请确认服务启动后刷新页面。`);
		$("source-select").replaceChildren(element("option", "", "数据源读取失败"));
		$("table-list").replaceChildren(element("li", "muted", "未读取到目录"));
	}
	updateComposer();
}
initialize();
