import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Application, publicTurn } from "./application.ts";
import { APP_ROOT, readConfig } from "./config.ts";
import { evaluationHttp } from "./evaluation/http.ts";
import { historyPage } from "./history.ts";
import { object } from "./model.ts";
import { PIPELINE_SIGNATURE } from "./pipeline.ts";
import { RuntimeError } from "./runtime.ts";

// 本产品契约为单机部署，统一控制端仅监听本机。
const config = readConfig();
const app = await Application.open(config);
const json = (response: ServerResponse, status: number, value: unknown) => {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	response.end(JSON.stringify(value));
};
async function body(request: IncomingMessage) {
	let text = "";
	for await (const chunk of request) {
		text += chunk;
		const limit = request.url?.startsWith("/api/eval/") ? 8 * 1024 * 1024 : 32768;
		if (Buffer.byteLength(text) > limit) throw new RuntimeError("input_too_large", "输入过长", 413);
	}
	try {
		return object(JSON.parse(text));
	} catch {
		throw new RuntimeError("invalid_json", "请求必须是 JSON 对象", 400);
	}
}
function required(value: unknown, name: string, max = 4000): string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw new RuntimeError("invalid_input", `${name} 无效`, 400);
	return value;
}
const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url || "/", `http://127.0.0.1:${config.port}`);
		if (["POST", "DELETE"].includes(request.method || "")) {
			const origin = request.headers.origin;
			if (origin && ![`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`].includes(origin))
				throw new RuntimeError("origin", "不接受跨站请求", 403);
			if (!request.headers["content-type"]?.includes("application/json"))
				throw new RuntimeError("content_type", "请使用 JSON 请求", 415);
		}
		if (url.pathname.startsWith("/api/eval/")) {
			const input = ["POST", "DELETE"].includes(request.method || "") ? await body(request) : {};
			const handled = await evaluationHttp(request.method || "GET", url, input, app);
			if (handled) {
				json(response, handled.status, handled.value);
				return;
			}
		}
		if (request.method === "GET" && url.pathname === "/api/status") {
			// 快照哈希仅在评测核验时计算，网页的频繁状态轮询不重复读取整份业务库。
			const sourceVersions =
				url.searchParams.get("sources") === "1"
					? await Promise.all(
							(await app.domain.sources()).map(async (source) => ({
								id: source.id,
								fingerprint: await app.domain.fingerprint(source),
							})),
						)
					: undefined;
			json(response, 200, {
				model: config.decisionModel,
				answer_model: config.answerModel,
				credential_configured: Boolean(config.apiKey),
				pipeline_signature: PIPELINE_SIGNATURE,
				source_versions: sourceVersions,
				limits: { active_runs: config.maxActiveRuns, llm: config.llmMaxConcurrency, eval: config.evalMaxActiveRuns },
				queue_wait_timeout_ms: config.queueWaitTimeoutMs,
				run_timeout_ms: config.runTimeoutMs,
				llm_timeout_ms: config.llmTimeoutMs,
				stats: { runtime: await app.runtime.stats(), llm: app.models.pool.stats(), database: app.domain.pool.stats() },
				stage: "Pi 问数与统一评测控制台",
				synthetic_data: true,
			});
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/sources") {
			const sources = [];
			for (const source of await app.domain.sources()) {
				const catalog = object((await app.domain.call(source, "catalog", AbortSignal.timeout(15000))).catalog);
				sources.push({
					id: source.id,
					name: source.name,
					// 仅公开能力类型，页面据此说明 L0 匹配边界，不暴露本地知识目录。
					profile: source.knowledge_path ? "l0_schema_linking" : "query",
					tables: Array.isArray(catalog.tables) ? catalog.tables.map((item) => object(item).name) : [],
				});
			}
			json(response, 200, { sources });
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/turns") {
			const conversation = required(url.searchParams.get("conversation_id"), "会话标识", 128);
			json(response, 200, { turns: (await app.runtime.list(conversation)).map(publicTurn) });
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/history") {
			// 跨会话历史只读取已持久化任务，不要求原业务源仍在线，也不重新调用模型或SQL。
			json(response, 200, historyPage(await app.runtime.list(), url.searchParams));
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/query") {
			const data = await body(request);
			// 评测和网页都经过同一准入池，评测仅补充类别及固定时间，不可自设资源额度。
			const mode = data.mode === "eval" ? "eval" : "online";
			const asOf = mode === "eval" && typeof data.as_of === "string" ? data.as_of : undefined;
			if (asOf && !Number.isFinite(Date.parse(asOf))) throw new RuntimeError("invalid_time", "评测时间无效", 400);
			const task = await app.query({
				conversation_id: required(data.conversation_id, "会话标识", 128),
				source_id: required(data.source_id, "数据源", 128),
				request_id: required(data.request_id, "请求标识", 128),
				question: required(data.question, "问题"),
				mode,
				as_of: asOf,
			});
			json(response, 202, publicTurn(task));
			return;
		}
		const turnMatch = url.pathname.match(/^\/api\/turns\/([^/]+)(?:\/(reply|cancel))?$/);
		if (turnMatch) {
			const turnId = decodeURIComponent(turnMatch[1]);
			const task = await app.runtime.get(turnId);
			if (!task) throw new RuntimeError("not_found", "任务不存在", 404);
			if (request.method === "GET" && !turnMatch[2]) {
				json(response, 200, publicTurn(task));
				return;
			}
			if (request.method === "POST" && turnMatch[2] === "cancel") {
				json(response, 200, publicTurn(await app.runtime.cancel(turnId)));
				return;
			}
			if (request.method === "POST" && turnMatch[2] === "reply") {
				const data = await body(request);
				if (!Number.isInteger(data.revision)) throw new RuntimeError("invalid_revision", "表单版本无效", 400);
				const resumed = await app.runtime.reply({
					turnId,
					submissionId: required(data.submission_id, "提交标识", 128),
					clarificationId:
						typeof data.clarification_id === "string" ? data.clarification_id : task.clarification?.id || "",
					revision: Number(data.revision),
					answer: required(data.answer, "补充内容"),
				});
				json(response, 202, publicTurn(resumed));
				return;
			}
		}
		if (
			request.method === "GET" &&
			[
				"/",
				"/app.js",
				"/styles.css",
				"/history",
				"/history.js",
				"/history.css",
				"/evaluation",
				"/evaluation.js",
				"/evaluation.css",
				"/evaluation/tasks",
				"/evaluation-tasks.js",
				"/evaluation-tasks.css",
			].includes(url.pathname)
		) {
			// 新旧评测页与历史页只走固定静态资源白名单，不允许 URL 直接访问任意本地文件。
			const file =
				url.pathname === "/"
					? "index.html"
					: url.pathname === "/history"
						? "history.html"
						: url.pathname === "/evaluation"
							? "evaluation.html"
							: url.pathname === "/evaluation/tasks"
								? "evaluation-tasks.html"
								: url.pathname.slice(1);
			const type = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "application/javascript";
			response.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
			response.end(await readFile(resolve(APP_ROOT, "web", file)));
			return;
		}
		json(response, 404, { error: "接口不存在" });
	} catch (error) {
		const status = error instanceof RuntimeError ? error.statusCode : 500;
		json(response, status, {
			error: error instanceof RuntimeError ? error.message : "操作失败，请检查本地数据源与运行配置",
			code: error instanceof RuntimeError ? error.code : "internal_error",
		});
	}
});
server.listen(config.port, "127.0.0.1", () =>
	console.log(
		`Pi 智能问数：http://127.0.0.1:${config.port}；决策模型 ${config.decisionModel}；并发 ${config.maxActiveRuns}/${config.llmMaxConcurrency}`,
	),
);
let closing = false;
const shutdown = async () => {
	if (closing) return;
	closing = true;
	server.close();
	await app.close();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
