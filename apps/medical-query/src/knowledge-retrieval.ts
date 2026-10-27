import { createHash } from "node:crypto";

type RecordValue = Record<string, unknown>;
export type RetrievalStrategy = "full_catalog" | "lexical";
export type RetrievalReceipt = {
	schema_version: "retrieval-receipt/v1";
	strategy: RetrievalStrategy;
	input_version: string;
	index_hash: string;
	query_hash: string;
	source_id: string;
	tokenizer: "han-bigram-ascii/v1";
	ranking: "exact-alias-idf/v2";
	character_budget: { maximum: number; actual: number; unit: "unicode_code_points" };
	candidates: { id: string; score: number }[];
	admitted_ids: string[];
	dependency_ids: string[];
	dropped_ids: string[];
	filtered: { id: string; reason: string }[];
	fallback: "none" | "empty_recall_full_catalog";
	policy: { candidate_limit: number; dependency_policy?: "forward-fk-seed-bridge/v2"; max_bridge_hops?: number };
	dependency_edges?: { from: string; to: string; reason: "foreign_key" | "seed_bridge" }[];
	metadata_projection?: { section: string; original_count: number; admitted_count: number }[];
};
type CommonInput = {
	question: string;
	strategy: string;
	version: string;
	source_id: string;
	limit?: number;
	max_context_chars?: number;
	index_hash?: string;
	max_bridge_hops?: number;
};
export type KnowledgeDocument = {
	id: string;
	title: string;
	text: string;
	status: "approved" | "imported" | "review_required" | "rejected" | "retired";
	source_id: string;
	hospital_id?: string;
	valid_from?: string;
	valid_to?: string;
	revoked?: boolean;
	source_ref: string;
	content_hash: string;
	aliases?: string[];
};

// 只对显式传入的公共知识建立索引，不接收题目标记、标准答案或故障注入信息。
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.entries(value)
		.filter(([, entry]) => entry !== undefined)
		.sort(([left], [right]) => left.localeCompare(right, "en"))
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
		.join(",")}}`;
}

function hash(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

function record(value: unknown): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_knowledge_record");
	return value as RecordValue;
}

function records(value: unknown, label: string): RecordValue[] {
	if (!Array.isArray(value)) throw new Error(`invalid_knowledge_array:${label}`);
	return value.map(record);
}

function identifier(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("invalid_knowledge_identity");
	return value;
}

function normalized(text: string): string {
	return text.normalize("NFKC").toLocaleLowerCase("en-US");
}

// 中文采用字符双元组，保留 ASCII 编号完整词；避免依赖 SQLite 默认分词对中文的偶然行为。
export function knowledgeTokens(text: string): string[] {
	const result = new Set<string>();
	for (const part of normalized(text).match(/[\p{Script=Han}]+|[a-z0-9_]+(?:[.:-][a-z0-9_]+)*/gu) ?? []) {
		if (/\p{Script=Han}/u.test(part)) {
			const characters = [...part];
			if (characters.length === 1) result.add(part);
			for (let index = 0; index < characters.length - 1; index++) result.add(characters[index] + characters[index + 1]);
		} else {
			result.add(part);
			for (const token of part.split(/[._:-]/)) if (token.length > 1) result.add(token);
		}
	}
	return [...result].sort();
}

function publicText(item: RecordValue): string {
	const values = [
		item.name,
		item.title,
		item.definition,
		item.description,
		item.label,
		item.original_code,
		item.metric_id,
		item.text,
	];
	if (Array.isArray(item.aliases)) values.push(...item.aliases);
	return values.filter((value) => typeof value === "string").join(" ");
}

function rank(question: string, entries: { id: string; text: string; aliases: string[] }[]) {
	const query = normalized(question),
		queryTokens = new Set(knowledgeTokens(question));
	const queryWords: string[] = query.match(/[a-z0-9_]+(?:[.:-][a-z0-9_]+)*/g) ?? [];
	// 目录共有的“合成测试”等说明不应压过业务字段；逆文档频率只由公共目录统计产生。
	const entryTokens = entries.map((entry) => knowledgeTokens(entry.text));
	const frequencies = new Map<string, number>();
	for (const tokens of entryTokens)
		for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
	const weight = (token: string) => Math.log(1 + entries.length / (frequencies.get(token) ?? 1));
	return entries
		.map((entry, index) => {
			const tokens = entryTokens[index];
			const overlap = tokens.filter((token) => queryTokens.has(token)).reduce((sum, token) => sum + weight(token), 0);
			const exact = [entry.id, ...entry.aliases].filter(Boolean).some((alias) => {
				const value = normalized(alias);
				// 编号按完整 ASCII 词匹配，met.gk-01 不应因为前缀而匹配 met.gk-010。
				return /^[a-z0-9_.:-]+$/.test(value) ? queryWords.includes(value) : query.includes(value);
			});
			return { id: entry.id, score: (exact ? 1000 : 0) + overlap / Math.sqrt(Math.max(1, tokens.length)) };
		})
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id, "en"));
}

function prepare(input: CommonInput, index: unknown, entries: { id: string; text: string; aliases: string[] }[]) {
	if (input.strategy !== "full_catalog" && input.strategy !== "lexical")
		throw new Error(`unregistered_retrieval_strategy:${input.strategy}`);
	identifier(input.version);
	identifier(input.source_id);
	const limit = input.limit ?? 12,
		maximum = input.max_context_chars ?? 256000;
	if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maximum) || maximum < 1)
		throw new Error("invalid_retrieval_budget");
	if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
		throw new Error("duplicate_knowledge_identity");
	const indexHash = hash({
		version: input.version,
		source_id: input.source_id,
		tokenizer: "han-bigram-ascii/v1",
		ranking: "exact-alias-idf/v2",
		index,
	});
	if (input.index_hash && input.index_hash !== indexHash) throw new Error("retrieval_index_version_mismatch");
	const ranked = rank(input.question, entries);
	const fallback = input.strategy === "lexical" && !ranked.length ? "empty_recall_full_catalog" : "none";
	const selected =
		input.strategy === "full_catalog" || fallback !== "none"
			? entries.map((entry) => entry.id)
			: ranked.slice(0, limit).map((entry) => entry.id);
	const receipt: RetrievalReceipt = {
		schema_version: "retrieval-receipt/v1",
		strategy: input.strategy,
		input_version: input.version,
		index_hash: indexHash,
		query_hash: hash(input.question),
		source_id: input.source_id,
		tokenizer: "han-bigram-ascii/v1",
		ranking: "exact-alias-idf/v2",
		character_budget: { maximum, actual: 0, unit: "unicode_code_points" },
		candidates: ranked,
		admitted_ids: selected,
		dependency_ids: [],
		dropped_ids: entries.map((entry) => entry.id).filter((id) => !selected.includes(id)),
		filtered: [],
		fallback,
		policy: { candidate_limit: limit },
	};
	return { selected: new Set(selected), receipt };
}

// 必要依赖展开之后再检查完整预算；超限显式失败，不切掉列、关系或规则来伪装召回成功。
export class RetrievalBudgetError extends Error {
	readonly code = "retrieval_context_budget_exceeded";
	readonly receipt: RetrievalReceipt;
	constructor(receipt: RetrievalReceipt) {
		super(`retrieval_context_budget_exceeded:${receipt.character_budget.actual}:${receipt.character_budget.maximum}`);
		this.receipt = structuredClone(receipt);
	}
}

function finish<T>(value: T, receipt: RetrievalReceipt): { value: T; receipt: RetrievalReceipt } {
	receipt.character_budget.actual = [...canonical(value)].length;
	if (receipt.character_budget.actual > receipt.character_budget.maximum) throw new RetrievalBudgetError(receipt);
	const result = structuredClone({ value, receipt });
	function freeze(entry: unknown): void {
		if (entry && typeof entry === "object") {
			for (const child of Object.values(entry)) freeze(child);
			Object.freeze(entry);
		}
	}
	freeze(result);
	return result;
}

export function retrieveMetrics(input: CommonInput & { metrics: RecordValue[] }) {
	const metrics = input.metrics;
	const prepared = prepare(
		input,
		metrics,
		metrics.map((metric) => ({
			id: identifier(metric.metric_id),
			text: publicText(metric),
			aliases: [metric.name, metric.original_code, ...(Array.isArray(metric.aliases) ? metric.aliases : [])].filter(
				(value): value is string => typeof value === "string",
			),
		})),
	);
	const byId = new Map(metrics.map((metric) => [String(metric.metric_id), metric]));
	const initial = new Set(prepared.selected);
	for (const id of prepared.selected) {
		const metric = byId.get(id);
		if (!metric) throw new Error(`metric_dependency_missing:${id}`);
		// 目录若声明指标依赖则完整展开；实际规则仍由 L0Knowledge.select 按正式绑定投影。
		const dependencies = metric.required_metric_ids ?? metric.dependencies ?? [];
		if (!Array.isArray(dependencies)) throw new Error(`invalid_metric_dependencies:${id}`);
		for (const dependency of dependencies) {
			const dependencyId = identifier(dependency);
			if (!byId.has(dependencyId)) throw new Error(`metric_dependency_missing:${dependencyId}`);
			prepared.selected.add(dependencyId);
		}
	}
	prepared.receipt.admitted_ids = [...prepared.selected];
	prepared.receipt.dependency_ids = [...prepared.selected].filter((id) => !initial.has(id));
	prepared.receipt.dropped_ids = metrics
		.map((metric) => String(metric.metric_id))
		.filter((id) => !prepared.selected.has(id));
	const result = finish(
		metrics.filter((metric) => prepared.selected.has(String(metric.metric_id))),
		prepared.receipt,
	);
	return { metrics: result.value, receipt: result.receipt };
}

export function retrieveCatalog(input: CommonInput & { catalog: RecordValue }) {
	const tables = records(input.catalog.tables, "tables"),
		relations = records(input.catalog.relations ?? [], "relations");
	const semantics = input.catalog.semantics ? record(input.catalog.semantics) : {};
	const descriptions = semantics.tables ? record(semantics.tables) : {};
	// 枚举值本身也是可审计的词法证据：例如用户只给资产类别代码时，仍能找到它所属的物理表。
	const codeMappings = Array.isArray(semantics.code_mappings) ? records(semantics.code_mappings, "code_mappings") : [];
	const prepared = prepare(
		input,
		{ catalog: input.catalog, dependency_policy: "forward-fk-seed-bridge/v2" },
		tables.map((table) => {
			const description = descriptions[String(table.name)] ? record(descriptions[String(table.name)]) : {};
			const describedColumns = description.columns ? record(description.columns) : {};
			const columnText = Object.values(describedColumns).map((value) =>
				typeof value === "string" ? value : publicText(record(value)),
			);
			const tableCodes = codeMappings.filter(
				(entry) => typeof entry.physical_field === "string" && entry.physical_field.split(".")[0] === table.name,
			);
			const aliases = [
				table.name,
				...tableCodes.map((entry) => entry.value).filter((value) => typeof value === "string" && value.length > 1),
				...(Array.isArray(table.aliases) ? table.aliases : []),
				...(Array.isArray(description.aliases) ? description.aliases : []),
			].filter((value): value is string => typeof value === "string");
			return {
				id: identifier(table.name),
				text: [
					publicText(table),
					publicText(description),
					...records(table.columns, "columns").map(publicText),
					...columnText,
					...tableCodes.map((entry) => `${entry.value ?? ""} ${entry.meaning ?? ""} ${entry.concept ?? ""}`),
				].join(" "),
				aliases,
			};
		}),
	);
	const byName = new Map(tables.map((table) => [String(table.name), table]));
	const initial = new Set(prepared.selected);
	const maxBridgeHops = input.max_bridge_hops ?? 4;
	if (!Number.isSafeInteger(maxBridgeHops) || maxBridgeHops < 0 || maxBridgeHops > 8)
		throw new Error("invalid_retrieval_bridge_budget");
	prepared.receipt.policy = {
		...prepared.receipt.policy,
		dependency_policy: "forward-fk-seed-bridge/v2",
		max_bridge_hops: maxBridgeHops,
	};
	const dependencyEdges: NonNullable<RetrievalReceipt["dependency_edges"]> = [];
	// 关联图只用于已召回候选之间的有界最短桥接；共享机构表绝不是反向召回所有业务子表的理由。
	const graph = new Map<string, Set<string>>();
	for (const relation of relations) {
		if (relation.status !== "active" || !["database_metadata", "human_confirmed"].includes(String(relation.origin)))
			continue;
		const left = identifier(relation.left_table),
			right = identifier(relation.right_table);
		if (!byName.has(left) || !byName.has(right)) throw new Error(`relation_dependency_missing:${String(relation.id)}`);
		if (!graph.has(left)) graph.set(left, new Set());
		if (!graph.has(right)) graph.set(right, new Set());
		graph.get(left)?.add(right);
		graph.get(right)?.add(left);
	}
	const seeds = [...initial];
	if (input.strategy === "lexical" && prepared.receipt.fallback === "none") {
		for (let start = 0; start < seeds.length; start++) {
			const paths = new Map<string, string[]>([[seeds[start], [seeds[start]]]]),
				queue = [seeds[start]];
			for (let index = 0; index < queue.length; index++) {
				const name = queue[index],
					path = paths.get(name);
				if (!path) throw new Error("invalid_retrieval_bridge_path");
				if (path.length - 1 >= maxBridgeHops) continue;
				for (const next of [...(graph.get(name) ?? [])].sort()) {
					if (paths.has(next)) continue;
					paths.set(next, [...path, next]);
					queue.push(next);
				}
			}
			for (const target of seeds.slice(start + 1)) {
				const path = paths.get(target);
				if (!path) continue;
				for (let index = 1; index < path.length; index++) {
					prepared.selected.add(path[index]);
					dependencyEdges.push({ from: path[index - 1], to: path[index], reason: "seed_bridge" });
				}
			}
		}
	}
	// 子表指向父表的外键递归完整展开；父表新增后仅继续它自身的出边，不反向纳入兄弟事实表。
	for (const name of prepared.selected) {
		const table = byName.get(name);
		if (!table) throw new Error(`table_dependency_missing:${name}`);
		for (const fk of records(table.foreign_keys ?? [], "foreign_keys")) {
			const target = identifier(fk.table);
			if (!byName.has(target)) throw new Error(`table_dependency_missing:${target}`);
			prepared.selected.add(target);
			dependencyEdges.push({ from: name, to: target, reason: "foreign_key" });
		}
	}
	prepared.receipt.dependency_edges = [...new Map(dependencyEdges.map((edge) => [canonical(edge), edge])).values()];
	prepared.receipt.admitted_ids = [...prepared.selected];
	prepared.receipt.dependency_ids = [...prepared.selected].filter((id) => !initial.has(id));
	prepared.receipt.dropped_ids = tables.map((table) => String(table.name)).filter((id) => !prepared.selected.has(id));
	const selectedRelations = relations.filter(
		(relation) =>
			prepared.selected.has(String(relation.left_table)) && prepared.selected.has(String(relation.right_table)),
	);
	// 仅投影可明确归属到物理表/字段的字典项；计算规则、metric_bindings和未知扩展字段保持完整原文。
	const projectedSemantics: RecordValue & { tables: RecordValue } = {
		...semantics,
		tables: Object.fromEntries(Object.entries(descriptions).filter(([name]) => prepared.selected.has(name))),
	};
	const projection: NonNullable<RetrievalReceipt["metadata_projection"]> = [
		{
			section: "tables",
			original_count: Object.keys(descriptions).length,
			admitted_count: Object.keys(projectedSemantics.tables).length,
		},
	];
	const selectedField = (value: unknown) => typeof value === "string" && prepared.selected.has(value.split(".")[0]);
	for (const key of ["field_bindings", "code_mappings"]) {
		if (!Array.isArray(semantics[key])) continue;
		const original = records(semantics[key], key);
		const selected = original.filter(
			(item) => typeof item.physical_field !== "string" || selectedField(item.physical_field),
		);
		projectedSemantics[key] = selected;
		projection.push({ section: key, original_count: original.length, admitted_count: selected.length });
	}
	if (Array.isArray(semantics.relations)) {
		const original = records(semantics.relations, "semantic_relations");
		const selected = original.filter(
			(relation) =>
				prepared.selected.has(String(relation.left_table)) && prepared.selected.has(String(relation.right_table)),
		);
		projectedSemantics.relations = selected;
		projection.push({ section: "relations", original_count: original.length, admitted_count: selected.length });
	}
	if (
		semantics.benchmark_conventions &&
		typeof semantics.benchmark_conventions === "object" &&
		!Array.isArray(semantics.benchmark_conventions)
	) {
		const conventions = record(semantics.benchmark_conventions);
		if (
			conventions.observed_code_values &&
			typeof conventions.observed_code_values === "object" &&
			!Array.isArray(conventions.observed_code_values)
		) {
			const original = record(conventions.observed_code_values),
				selected = Object.fromEntries(Object.entries(original).filter(([field]) => selectedField(field)));
			projectedSemantics.benchmark_conventions = { ...conventions, observed_code_values: selected };
			projection.push({
				section: "observed_code_values",
				original_count: Object.keys(original).length,
				admitted_count: Object.keys(selected).length,
			});
		}
	}
	prepared.receipt.metadata_projection = projection;
	const projected = {
		...input.catalog,
		tables: tables.filter((table) => prepared.selected.has(String(table.name))),
		relations: selectedRelations,
		...(input.catalog.semantics
			? {
					semantics: projectedSemantics,
				}
			: {}),
	};
	const result = finish(projected, prepared.receipt);
	return { catalog: result.value, receipt: result.receipt };
}

// 文档过滤先于排序：错误医院、失效或未经审核的文字永远不进入候选和模型上下文。
export function retrieveDocuments(
	input: CommonInput & { scope: { hospital_id?: string; as_of: string }; documents: KnowledgeDocument[] },
) {
	const asOf = Date.parse(input.scope.as_of);
	if (!Number.isFinite(asOf)) throw new Error("invalid_retrieval_as_of");
	const filtered: RetrievalReceipt["filtered"] = [];
	const documents = input.documents.filter((document) => {
		let reason = "";
		if (document.revoked || document.status !== "approved") reason = "not_approved_or_revoked";
		else if (document.source_id !== "*" && document.source_id !== input.source_id) reason = "source_mismatch";
		else if (document.hospital_id && document.hospital_id !== input.scope.hospital_id) reason = "hospital_mismatch";
		else if (!document.source_ref || !document.content_hash) reason = "citation_missing";
		else if (
			document.valid_from &&
			(!Number.isFinite(Date.parse(document.valid_from)) || Date.parse(document.valid_from) > asOf)
		)
			reason = "not_effective";
		else if (
			document.valid_to &&
			(!Number.isFinite(Date.parse(document.valid_to)) || Date.parse(document.valid_to) <= asOf)
		)
			reason = "expired";
		if (reason) filtered.push({ id: document.id, reason });
		return !reason;
	});
	const prepared = prepare(
		input,
		{ scope: input.scope, documents: input.documents },
		documents.map((document) => ({
			id: document.id,
			text: `${document.title} ${document.text} ${(document.aliases ?? []).join(" ")}`,
			aliases: [document.title, ...(document.aliases ?? [])],
		})),
	);
	prepared.receipt.filtered = filtered;
	const result = finish(
		documents.filter((document) => prepared.selected.has(document.id)),
		prepared.receipt,
	);
	return { documents: result.value, receipt: result.receipt };
}
