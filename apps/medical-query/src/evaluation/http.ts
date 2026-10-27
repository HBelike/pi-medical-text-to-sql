import type { Application } from "../application.ts";
import { RuntimeError } from "../runtime.ts";

// 分页拒绝 NaN、负数和小数；上限统一约束，客户端不能绕过有界读取。
function pageNumber(raw: string | null, fallback: number, maximum: number, minimum = 1): number {
	if (raw === null) return fallback;
	const value = Number(raw);
	if (!raw.trim() || !Number.isSafeInteger(value) || value < minimum)
		throw new RuntimeError("invalid_pagination", "分页或游标必须为合法整数", 400);
	return Math.min(value, maximum);
}

/** 工作台与 CLI 消费同一控制入口；未知子路由不会降格为有效详情。 */
export async function evaluationHttp(
	method: string,
	url: URL,
	input: Record<string, unknown>,
	app: Application,
): Promise<{ status: number; value: unknown } | undefined> {
	if (!url.pathname.startsWith("/api/eval/")) return undefined;
	let parts: string[];
	try {
		parts = url.pathname.slice("/api/eval/".length).split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		throw new RuntimeError("invalid_path", "接口路径编码无效", 400);
	}
	const [collection, id, operation] = parts;
	if (parts.length > 3 || parts.some((part) => part.includes("/")))
		throw new RuntimeError("not_found", "评测接口不存在", 404);
	const service = app.evaluation;
	const page = pageNumber(url.searchParams.get("page"), 1, Number.MAX_SAFE_INTEGER);
	const size = pageNumber(url.searchParams.get("page_size"), 25, 100);
	const result = (value: unknown, status = 200) => ({ status, value });
	// 新评测表单只读取当前模型名，不触发全量历史任务统计。
	if (collection === "config" && parts.length === 1 && method === "GET")
		return result({ model: app.config.decisionModel, answer_model: app.config.answerModel });
	if (collection === "status" && parts.length === 1 && method === "GET") {
		// 旧诊断页仍返回同一摘要，避免为刷新状态读取所有调用正文。
		const operations = await app.runtime.operationStatusSummary();
		return result({
			storage: service.store.capacity(),
			runtime: await app.runtime.stats(),
			models: app.models.pool.stats(),
			...operations,
		});
	}
	const kinds: Record<string, string> = {
		datasets: "dataset",
		variants: "variant",
		experiments: "experiment",
		"score-sets": "score_set",
		"score-jobs": "score_job",
		comparisons: "comparison",
		adjudications: "adjudication",
		"release-decisions": "release_decision",
		activations: "activation",
	};
	if (collection === "experiments" && method === "GET" && !id)
		return result(
			service.listExperiments(
				page,
				size,
				url.searchParams.get("q") || "",
				url.searchParams.get("dataset_id") || "",
				url.searchParams.get("model") || "",
			),
		);
	if (method === "GET" && Object.hasOwn(kinds, collection) && !id) {
		const filterField =
			collection === "activations"
				? "release_decision_id"
				: ["score-sets", "score-jobs", "adjudications", "release-decisions"].includes(collection)
					? "experiment_id"
					: undefined;
		const filterValue = filterField ? url.searchParams.get(filterField) : null;
		return result(
			service.list(
				kinds[collection],
				page,
				size,
				filterField && filterValue ? { field: filterField, value: filterValue } : undefined,
			),
		);
	}
	if (collection === "datasets" && method === "POST" && !id) return result(await service.importDataset(input), 201);
	if (collection === "variants" && method === "POST" && !id) return result(await service.createVariant(input), 201);
	if (collection === "experiments") {
		if (method === "POST" && !id) return result(await service.createExperiment(input), 202);
		if (method === "GET" && id && !operation) return result(service.experiment(id));
		if (method === "GET" && operation === "overview") return result(service.overview(id));
		if (method === "GET" && operation === "questions")
			return result(
				service.questions(id, page, size, url.searchParams.get("verdict") || "all", url.searchParams.get("q") || ""),
			);
		if (method === "GET" && operation === "slots")
			return result(
				service.slots(
					id,
					page,
					size,
					url.searchParams.get("status") || undefined,
					url.searchParams.get("q") || undefined,
				),
			);
		if (method === "GET" && operation === "events") {
			const after = pageNumber(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER, 0);
			const limit = pageNumber(url.searchParams.get("limit"), 200, 1000);
			const items = service.store.events(id, after, limit);
			return result({ items, next_cursor: items.at(-1)?.seq ?? after });
		}
		if (method === "POST" && operation === "commands")
			return result(
				input.command === "regrade" ? await service.grade(id, input) : await service.control(id, input),
				202,
			);
		if (operation === "score-sets") {
			if (method === "POST") return result(await service.grade(id, input), 202);
			if (method === "GET") return result(service.list("score_set", page, size, { field: "experiment_id", value: id }));
		}
		if (method === "GET" && operation === "score-jobs")
			return result(service.list("score_job", page, size, { field: "experiment_id", value: id }));
		if (method === "GET" && operation === "export") return result(await service.exportExperiment(id));
	}
	if (collection === "slots" && id) {
		if (method === "GET" && !operation) return result(await service.slot(id));
		if (method === "POST" && operation === "reply") return result(await service.reply(id, input), 202);
	}
	if (collection === "operations") {
		if (method === "GET" && !id) {
			const turn = url.searchParams.get("turn_id") || undefined;
			const status = url.searchParams.get("status");
			// 旧全局列表仍按原顺序和状态筛选，仅当前页建立轻量索引。
			if (!turn) return result(await app.runtime.pageOperations(page, size, status));
			const operations = (await app.runtime.listOperations(turn)).filter((entry) => !status || entry.status === status);
			return result({
				items: operations.slice((page - 1) * size, page * size),
				total: operations.length,
				page,
				page_size: size,
			});
		}
		// 索引展开只按 id 读取一条完整账本记录，不回退为全量列表查找。
		if (method === "GET" && id && !operation) return result(await app.runtime.getOperation(id));
		if (method === "POST" && operation === "reconcile") return result(await service.reconcile(id, input));
	}
	if (method === "POST" && !id && collection === "comparisons") return result(await service.compare(input), 201);
	if (method === "POST" && !id && collection === "adjudications") return result(await service.adjudicate(input), 201);
	if (method === "POST" && !id && collection === "release-decisions") return result(await service.release(input), 201);
	if (method === "POST" && !id && collection === "activations") return result(await service.activate(input), 201);
	if (collection === "artifacts") {
		if (method === "GET" && !id) {
			const items = service.store.artifacts(url.searchParams.get("after") || "", size);
			return result({ items, next_cursor: items.at(-1)?.id ?? "", storage: service.store.capacity() });
		}
		if (method === "GET" && operation === "impact") return result({ affected: service.store.deletionImpact(id), id });
		if (method === "GET" && id && !operation) return result({ id, content: service.store.readArtifact(id) });
		if (method === "DELETE" && id && !operation) return result(await service.deleteArtifact(id, input));
	}
	if (method === "GET" && id && !operation && Object.hasOwn(kinds, collection)) {
		const row = service.store.get<Record<string, unknown>>(kinds[collection], id);
		if (row) return result(collection === "datasets" ? row.data.summary : { ...row.data, revision: row.revision });
	}
	throw new RuntimeError("not_found", "评测接口不存在", 404);
}
