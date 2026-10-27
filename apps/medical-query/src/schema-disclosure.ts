import { createHash } from "node:crypto";
import { retrieveCatalog } from "./knowledge-retrieval.ts";

type RecordValue = Record<string, unknown>;
export type TableCard = {
	table_id: string;
	name: string;
	description: string | null;
	aliases: string[];
	grain?: unknown;
	time_role?: unknown;
};
export type DisclosureMissing = { tables: string[]; fields: string[]; relations: string[] };
export type DisclosureReceipt = {
	schema_version: "schema-disclosure/v1";
	action: "index" | "search" | "read";
	source_id: string;
	input_version: string;
	index_hash: string;
	round: number;
	requested_ids: string[];
	admitted_ids: string[];
	dependency_ids: string[];
	metric_ids: string[];
	character_budget: { maximum: number; actual: number; unit: "unicode_code_points" };
};

// 披露错误独立于 SQL 编译错误；预算、未知身份和无进展请求都不得通过静默截断继续执行。
export class SchemaDisclosureError extends Error {
	readonly code: string;
	readonly missing: DisclosureMissing;
	readonly receipt?: DisclosureReceipt;
	constructor(
		code: string,
		missing: DisclosureMissing = { tables: [], fields: [], relations: [] },
		receipt?: DisclosureReceipt,
	) {
		super(code);
		this.name = "SchemaDisclosureError";
		this.code = code;
		this.missing = structuredClone(missing);
		this.receipt = receipt ? structuredClone(receipt) : undefined;
	}
}

function record(value: unknown): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new SchemaDisclosureError("schema_invalid_record");
	return value as RecordValue;
}

function records(value: unknown): RecordValue[] {
	if (!Array.isArray(value)) throw new SchemaDisclosureError("schema_invalid_array");
	return value.map(record);
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.entries(value)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => a.localeCompare(b, "en"))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
		.join(",")}}`;
}

function snapshot<T>(value: T): T {
	const result = structuredClone(value);
	const freeze = (item: unknown): void => {
		if (item && typeof item === "object") {
			for (const child of Object.values(item)) freeze(child);
			Object.freeze(item);
		}
	};
	freeze(result);
	return result;
}

export class SchemaDisclosure {
	private readonly original: RecordValue;
	private readonly tables: Map<string, RecordValue>;
	private readonly relations: Map<string, RecordValue>;
	private readonly semantics: RecordValue;
	private readonly cards: TableCard[];
	private readonly metrics: Map<string, RecordValue>;
	private readonly bindingMetricIds: Set<string>;
	private readonly businessMetricIds: Set<string>;
	private readonly metricIndex: { metric_id: string; name?: string }[];
	private readonly indexHash: string;
	private readonly sourceId: string;
	private readonly version: string;
	private readonly maximum: number;
	private readonly seedLimit: number;
	private readonly maxReads: number;
	private readonly maxBridgeHops: number;
	private readonly seen = new Set<string>();
	private readonly requestedMetrics = new Set<string>();
	private readonly searched = new Set<string>();
	private readonly history: DisclosureReceipt[] = [];
	private round = 0;
	private current: RecordValue;

	constructor(input: {
		catalog: RecordValue;
		source_id: string;
		version: string;
		max_context_chars?: number;
		initial_limit?: number;
		max_reads?: number;
		max_bridge_hops?: number;
	}) {
		this.original = snapshot(input.catalog);
		this.sourceId = input.source_id;
		this.version = input.version;
		this.maximum = input.max_context_chars ?? 256000;
		this.seedLimit = input.initial_limit ?? 5;
		this.maxReads = input.max_reads ?? 3;
		this.maxBridgeHops = input.max_bridge_hops ?? 4;
		if (
			!this.sourceId ||
			!this.version ||
			!Number.isSafeInteger(this.maximum) ||
			this.maximum < 1 ||
			!Number.isSafeInteger(this.seedLimit) ||
			this.seedLimit < 1 ||
			this.seedLimit > 5 ||
			!Number.isSafeInteger(this.maxReads) ||
			this.maxReads < 1 ||
			this.maxReads > 3 ||
			!Number.isSafeInteger(this.maxBridgeHops) ||
			this.maxBridgeHops < 0 ||
			this.maxBridgeHops > 8
		)
			throw new SchemaDisclosureError("schema_invalid_budget");
		const allTables = records(this.original.tables);
		this.tables = new Map(allTables.map((table) => [String(table.name), table]));
		if (
			this.tables.size !== allTables.length ||
			allTables.some((table) => typeof table.name !== "string" || !table.name)
		)
			throw new SchemaDisclosureError("schema_duplicate_or_invalid_table_id");
		this.semantics = this.original.semantics ? record(this.original.semantics) : {};
		const descriptions = this.semantics.tables ? record(this.semantics.tables) : {};
		this.cards = allTables.map((table) => {
			const description = descriptions[String(table.name)] ? record(descriptions[String(table.name)]) : {};
			const card: TableCard = {
				table_id: String(table.name),
				name: String(table.name),
				description:
					typeof description.description === "string"
						? description.description
						: typeof table.description === "string"
							? table.description
							: null,
				aliases: [...new Set([...strings(table.aliases), ...strings(description.aliases)])],
			};
			// 只传递来源显式声明的粒度/时间角色，不从物理名称或列名补造业务解释。
			for (const key of ["grain", "time_role"] as const)
				if (description[key] !== undefined || table[key] !== undefined) card[key] = description[key] ?? table[key];
			return card;
		});
		const allRelations = records(this.original.relations ?? []).filter(
			(relation) =>
				relation.status === "active" && ["database_metadata", "human_confirmed"].includes(String(relation.origin)),
		);
		this.relations = new Map(allRelations.map((relation) => [String(relation.id), relation]));
		if (this.relations.size !== allRelations.length) throw new SchemaDisclosureError("schema_duplicate_relation_id");
		for (const relation of allRelations) {
			const left = this.tables.get(String(relation.left_table)),
				right = this.tables.get(String(relation.right_table));
			if (
				typeof relation.id !== "string" ||
				!relation.id ||
				!left ||
				!right ||
				!records(relation.pairs).length ||
				records(relation.pairs).some(
					(pair) =>
						!records(left.columns).some((column) => column.name === pair.left) ||
						!records(right.columns).some((column) => column.name === pair.right),
				)
			)
				throw new SchemaDisclosureError("schema_invalid_active_relation");
		}
		const metricBindings = records(this.semantics.metric_bindings ?? []);
		const businessMetrics = records(this.semantics.metrics ?? []);
		const metricEntries: [string, RecordValue][] = [
			...metricBindings.map((binding): [string, RecordValue] => [String(binding.metric_id), binding]),
			...businessMetrics.map((binding): [string, RecordValue] => [String(binding.metric_id ?? binding.id), binding]),
		];
		this.metrics = new Map(metricEntries);
		this.bindingMetricIds = new Set(metricBindings.map((binding) => String(binding.metric_id)));
		this.businessMetricIds = new Set(businessMetrics.map((binding) => String(binding.metric_id ?? binding.id)));
		if (
			this.metrics.size !== metricEntries.length ||
			metricBindings.some((binding) => typeof binding.metric_id !== "string" || !binding.metric_id) ||
			businessMetrics.some(
				(binding) => typeof (binding.metric_id ?? binding.id) !== "string" || !(binding.metric_id ?? binding.id),
			)
		)
			throw new SchemaDisclosureError("schema_duplicate_or_invalid_metric_id");
		this.metricIndex = [...this.metrics].map(([metric_id, binding]) => ({
			metric_id,
			...(typeof binding.name === "string" ? { name: binding.name } : {}),
		}));
		this.indexHash = createHash("sha256")
			.update(
				canonical({
					source_id: this.sourceId,
					version: this.version,
					catalog: this.original,
					policy: "schema-disclosure/v1",
				}),
			)
			.digest("hex");
		this.current = this.project(new Set(), new Set());
	}

	get catalog(): RecordValue {
		return snapshot(this.current);
	}
	get receipts(): DisclosureReceipt[] {
		return snapshot(this.history);
	}

	private receipt(
		action: DisclosureReceipt["action"],
		requested: string[],
		admitted: string[],
		dependencies: string[],
		metricIds: string[],
		payload: unknown,
	): DisclosureReceipt {
		const receipt: DisclosureReceipt = {
			schema_version: "schema-disclosure/v1",
			action,
			source_id: this.sourceId,
			input_version: this.version,
			index_hash: this.indexHash,
			round: this.round + (action === "read" ? 1 : 0),
			requested_ids: requested,
			admitted_ids: admitted,
			dependency_ids: dependencies,
			metric_ids: metricIds,
			character_budget: { maximum: this.maximum, actual: [...canonical(payload)].length, unit: "unicode_code_points" },
		};
		if (receipt.character_budget.actual > this.maximum)
			throw new SchemaDisclosureError("schema_context_budget_exceeded", undefined, receipt);
		return receipt;
	}

	index(): { tables: TableCard[]; metric_index: { metric_id: string; name?: string }[]; receipt: DisclosureReceipt } {
		const payload = { tables: this.cards, metric_index: this.metricIndex };
		const receipt = this.receipt("index", [], [], [], [], payload);
		this.history.push(receipt);
		return snapshot({ ...payload, receipt });
	}

	search(query: string): { tables: (TableCard & { score: number })[]; receipt: DisclosureReceipt } {
		if (typeof query !== "string" || !query.trim() || query.length > 4000)
			throw new SchemaDisclosureError("schema_invalid_search");
		const queryKey = query.normalize("NFKC").trim().toLocaleLowerCase("en-US");
		if (this.searched.has(queryKey)) throw new SchemaDisclosureError("schema_search_no_progress");
		// 复用已有列、代码和中文释义索引，但只返回轻量提示；搜索不会把元信息标成已读，也不隐藏全库表卡。
		const ranked = retrieveCatalog({
			catalog: this.original,
			question: query,
			strategy: "lexical",
			version: this.version,
			source_id: this.sourceId,
			limit: this.seedLimit,
			max_context_chars: Number.MAX_SAFE_INTEGER,
		}).receipt.candidates.slice(0, this.seedLimit);
		const tables = ranked.map(({ id, score }) => ({ ...this.cards.find((card) => card.table_id === id)!, score }));
		const receipt = this.receipt(
			"search",
			[],
			ranked.map((entry) => entry.id),
			[],
			[],
			{ index: { tables: this.cards, metric_index: this.metricIndex }, catalog: this.current, hints: tables },
		);
		this.searched.add(queryKey);
		this.history.push(receipt);
		return snapshot({ tables, receipt });
	}

	read(table_ids: string[], metric_ids: string[] = []): { catalog: RecordValue; receipt: DisclosureReceipt } {
		if (
			!Array.isArray(table_ids) ||
			!Array.isArray(metric_ids) ||
			table_ids.some((id) => typeof id !== "string") ||
			metric_ids.some((id) => typeof id !== "string")
		)
			throw new SchemaDisclosureError("schema_invalid_read");
		const requested = [...new Set(table_ids)],
			metrics = new Set([...this.requestedMetrics, ...metric_ids]);
		const missing = { tables: requested.filter((id) => !this.tables.has(id)), fields: [], relations: [] };
		if (missing.tables.length) throw new SchemaDisclosureError("schema_unknown_table", missing);
		if ([...metrics].some((id) => !this.metrics.has(id))) throw new SchemaDisclosureError("schema_unknown_metric");
		if (this.round >= this.maxReads) throw new SchemaDisclosureError("schema_read_limit_exceeded");
		const newSeeds = requested.filter((id) => !this.seen.has(id));
		if (newSeeds.length > this.seedLimit) throw new SchemaDisclosureError("schema_seed_limit_exceeded");
		if (!newSeeds.length && [...metrics].every((id) => this.requestedMetrics.has(id)))
			throw new SchemaDisclosureError("schema_read_no_progress");
		const selected = new Set([...this.seen, ...requested]);
		this.expandMetricDependencies(selected, metrics);
		const seeds = [...selected];
		// 只在已经请求的业务表之间寻找已确认关系的短桥；共享机构表不会反向展开所有事实表。
		const graph = new Map<string, Set<string>>();
		for (const relation of this.relations.values()) {
			const left = String(relation.left_table),
				right = String(relation.right_table);
			if (!graph.has(left)) graph.set(left, new Set());
			if (!graph.has(right)) graph.set(right, new Set());
			graph.get(left)?.add(right);
			graph.get(right)?.add(left);
		}
		for (let start = 0; start < seeds.length; start++) {
			const paths = new Map<string, string[]>([[seeds[start], [seeds[start]]]]),
				queue = [seeds[start]];
			for (let index = 0; index < queue.length; index++) {
				const name = queue[index],
					path = paths.get(name)!;
				if (path.length - 1 >= this.maxBridgeHops) continue;
				for (const next of [...(graph.get(name) ?? [])].sort())
					if (!paths.has(next)) {
						paths.set(next, [...path, next]);
						queue.push(next);
					}
			}
			for (const target of seeds.slice(start + 1)) for (const name of paths.get(target) ?? []) selected.add(name);
		}
		// 父依赖必须同时有完整、已确认的关联列对；孤立 FK 声明或候选关系不能成为执行依据。
		let dependencySize: number;
		do {
			dependencySize = selected.size;
			this.expandMetricDependencies(selected, metrics);
			for (const name of selected)
				for (const fk of records(this.tables.get(name)!.foreign_keys ?? [])) {
					const pairs = records(fk.columns ?? []);
					const primary = records(this.tables.get(String(fk.table))?.columns ?? [])
						.filter((column) => typeof column.primary_key === "number" && column.primary_key > 0)
						.sort((left, right) => Number(left.primary_key) - Number(right.primary_key));
					// SQLite 可省略目标主键列名；按其主键顺序还原后，仍校验完整复合列对。
					const resolved = pairs.map((pair, index) => ({
						...pair,
						from: pair.from,
						to:
							pair.to ??
							(primary.length === pairs.length
								? primary[typeof pair.sequence === "number" ? pair.sequence : index]?.name
								: undefined),
					}));
					if (
						resolved.length > 0 &&
						[...this.relations.values()].some(
							(relation) =>
								relation.left_table === name &&
								relation.right_table === fk.table &&
								records(relation.pairs).length === pairs.length &&
								resolved.every((pair) =>
									records(relation.pairs).some((actual) => actual.left === pair.from && actual.right === pair.to),
								),
						)
					)
						selected.add(String(fk.table));
				}
		} while (selected.size !== dependencySize);
		const catalog = this.project(selected, metrics);
		const dependencies = [...selected].filter((id) => !requested.includes(id) && !this.seen.has(id));
		const receipt = this.receipt("read", requested, [...selected], dependencies, [...metrics], {
			index: { tables: this.cards, metric_index: this.metricIndex },
			catalog,
		});
		// 预算和依赖检查全部成功后才提交本轮状态，失败请求不会消耗可用读取轮数。
		this.current = catalog;
		this.round++;
		for (const id of selected) this.seen.add(id);
		for (const id of metrics) this.requestedMetrics.add(id);
		this.history.push(receipt);
		return snapshot({ catalog, receipt });
	}

	private expandMetricDependencies(selected: Set<string>, requested: Set<string>): void {
		const fields = new Map(
			records(this.semantics.field_bindings ?? []).map((binding) => [
				String(binding.logical_field_id),
				binding.physical_field,
			]),
		);
		const semanticRelations = records(this.semantics.relations ?? []);
		const addField = (field: string): void => {
			const physical = fields.get(field) ?? field;
			if (typeof physical !== "string" || !physical.includes("."))
				throw new SchemaDisclosureError("schema_metric_field_dependency_missing");
			const [table, column, extra] = physical.split(".");
			if (
				!this.tables.has(table) ||
				extra !== undefined ||
				!records(this.tables.get(table)!.columns).some((item) => item.name === column)
			)
				throw new SchemaDisclosureError("schema_metric_field_dependency_missing");
			selected.add(table);
		};
		const walk = (value: unknown, key = ""): void => {
			if (Array.isArray(value)) {
				for (const item of value) walk(item, key);
				return;
			}
			if (value && typeof value === "object") {
				for (const [childKey, item] of Object.entries(value)) walk(item, childKey);
				return;
			}
			if (typeof value !== "string") return;
			if (
				[
					"physical_field",
					"field_id",
					"required_field_ids",
					"dedup_keys",
					"aggregation_field_id",
					"status_field",
					"time_field",
				].includes(key)
			)
				addField(value);
			if (["required_relation_ids", "relation_path", "relation_id", "runtime_relation_id"].includes(key)) {
				const relation = this.relations.get(value) ?? semanticRelations.find((item) => item.id === value);
				if (!relation) throw new SchemaDisclosureError("schema_metric_relation_dependency_missing");
				selected.add(String(relation.left_table));
				selected.add(String(relation.right_table));
			}
		};
		// 基础字典的 metrics 已明确绑定业务表，读取该表时完整加载其约束；大型 metric_bindings 仍须显式选择。
		for (const id of this.businessMetricIds) {
			const binding = this.metrics.get(id)!;
			if (typeof binding.table === "string" && selected.has(binding.table)) requested.add(id);
		}
		for (const id of requested) {
			const binding = this.metrics.get(id);
			if (!binding) throw new SchemaDisclosureError("schema_metric_dependency_missing");
			for (const dependency of strings(
				binding.dependency_metric_ids ?? binding.required_metric_ids ?? binding.dependencies,
			)) {
				if (!this.metrics.has(dependency)) throw new SchemaDisclosureError("schema_metric_dependency_missing");
				requested.add(dependency);
			}
			if (typeof binding.table === "string") {
				if (!this.tables.has(binding.table)) throw new SchemaDisclosureError("schema_metric_table_dependency_missing");
				selected.add(binding.table);
				if (typeof binding.key === "string") addField(`${binding.table}.${binding.key}`);
			}
			walk(binding);
			for (const businessId of this.businessMetricIds) {
				const business = this.metrics.get(businessId)!;
				if (typeof business.table === "string" && selected.has(business.table)) requested.add(businessId);
			}
		}
		for (const table of selected)
			if (!this.tables.has(table)) throw new SchemaDisclosureError("schema_metric_table_dependency_missing");
	}

	private project(selected: Set<string>, metricIds: Set<string>): RecordValue {
		const selectedField = (value: unknown) => typeof value === "string" && selected.has(value.split(".")[0]);
		const projected: RecordValue = {
			...this.semantics,
			tables: Object.fromEntries(
				Object.entries(this.semantics.tables ? record(this.semantics.tables) : {}).filter(([name]) =>
					selected.has(name),
				),
			),
		};
		for (const key of ["field_bindings", "code_mappings"])
			if (Array.isArray(this.semantics[key]))
				projected[key] = records(this.semantics[key]).filter(
					(item) => typeof item.physical_field !== "string" || selectedField(item.physical_field),
				);
		if (Array.isArray(this.semantics.relations))
			projected.relations = records(this.semantics.relations).filter(
				(relation) => selected.has(String(relation.left_table)) && selected.has(String(relation.right_table)),
			);
		if (Array.isArray(this.semantics.metric_bindings))
			projected.metric_bindings = [...this.metrics]
				.filter(([id]) => this.bindingMetricIds.has(id) && metricIds.has(id))
				.map(([, binding]) => binding);
		if (Array.isArray(this.semantics.metrics))
			projected.metrics = [...this.metrics]
				.filter(([id]) => this.businessMetricIds.has(id) && metricIds.has(id))
				.map(([, binding]) => binding);
		projected.disclosure_omissions = {
			...(this.semantics.disclosure_omissions ? record(this.semantics.disclosure_omissions) : {}),
			metric_bindings: {
				count: [...this.bindingMetricIds].filter((id) => !metricIds.has(id)).length,
				reason: "rules_not_loaded_request_metric_ids",
			},
			...(this.businessMetricIds.size
				? {
						metrics: {
							count: [...this.businessMetricIds].filter((id) => !metricIds.has(id)).length,
							reason: "rules_not_loaded_read_related_tables_or_request_metric_ids",
						},
					}
				: {}),
		};
		if (
			this.semantics.benchmark_conventions &&
			typeof this.semantics.benchmark_conventions === "object" &&
			!Array.isArray(this.semantics.benchmark_conventions)
		) {
			const conventions = record(this.semantics.benchmark_conventions);
			if (
				conventions.observed_code_values &&
				typeof conventions.observed_code_values === "object" &&
				!Array.isArray(conventions.observed_code_values)
			)
				projected.benchmark_conventions = {
					...conventions,
					observed_code_values: Object.fromEntries(
						Object.entries(record(conventions.observed_code_values)).filter(([field]) => selectedField(field)),
					),
				};
		}
		return {
			...this.original,
			tables: [...this.tables].filter(([id]) => selected.has(id)).map(([, table]) => table),
			relations: [...this.relations.values()].filter(
				(relation) => selected.has(String(relation.left_table)) && selected.has(String(relation.right_table)),
			),
			semantics: projected,
		};
	}

	validatePlan(dsl: unknown, linking?: unknown): DisclosureMissing {
		const references = this.planReferences(record(dsl)),
			requiredTables = new Set(references.tables),
			requiredFields = new Set(references.fields),
			requiredRelations = new Set(references.relations);
		const link = linking === undefined ? undefined : record(linking);
		if (link) {
			for (const id of strings(link.tables)) requiredTables.add(id);
			for (const id of strings(link.fields)) requiredFields.add(id);
			for (const id of strings(link.relations)) requiredRelations.add(id);
		}
		for (const field of requiredFields) requiredTables.add(field.split(".")[0]);
		for (const id of requiredRelations) {
			const relation = this.relations.get(id);
			if (relation) {
				requiredTables.add(String(relation.left_table));
				requiredTables.add(String(relation.right_table));
			}
		}
		const availableRelations = new Set(records(this.current.relations).map((item) => String(item.id)));
		return {
			tables: [...requiredTables].filter((name) => !this.seen.has(name)).sort(),
			fields: [...requiredFields]
				.filter((field) => {
					const [table, column, extra] = field.split(".");
					return (
						!this.seen.has(table) ||
						extra !== undefined ||
						!records(this.tables.get(table)?.columns ?? []).some((item) => item.name === column)
					);
				})
				.sort(),
			relations: [...requiredRelations].filter((id) => !availableRelations.has(id)).sort(),
		};
	}

	assertPlan(dsl: unknown, linking?: unknown): void {
		const missing = this.validatePlan(dsl, linking);
		if (Object.values(missing).some((items) => items.length))
			throw new SchemaDisclosureError("schema_plan_metadata_not_read", missing);
		if (linking !== undefined) {
			// Linking 既不能宣称未读证据，也必须覆盖最终 DSL 用到的全部表、列和关系。
			const link = record(linking),
				plan = record(dsl),
				declared = {
					tables: new Set(strings(link.tables)),
					fields: new Set(strings(link.fields)),
					relations: new Set(strings(link.relations)),
				};
			const rawRequired = this.planReferences(plan);
			if (
				rawRequired.tables.some((id) => !declared.tables.has(id)) ||
				rawRequired.fields.some((id) => !declared.fields.has(id)) ||
				rawRequired.relations.some((id) => !declared.relations.has(id))
			)
				throw new SchemaDisclosureError("schema_linking_dsl_mismatch");
		}
	}

	private planReferences(plan: RecordValue): DisclosureMissing {
		const aliases = new Set(
			records(plan.select ?? []).flatMap((item) => {
				if (typeof item.as === "string") return [item.as];
				if (typeof item.field !== "string") return [];
				// 对齐领域编译器的缺省输出别名，避免合法排序被误判为未读取物理字段。
				const column = item.field.split(".").at(-1);
				return [item.aggregate ? `${String(item.aggregate)}_${column}` : String(column)];
			}),
		);
		const fields = new Set(strings(plan.group_by));
		for (const key of ["select", "where", "order_by"])
			for (const item of records(plan[key] ?? []))
				if (typeof item.field === "string" && item.field !== "*" && !(key === "order_by" && aliases.has(item.field)))
					fields.add(item.field);
		const relations = records(plan.joins ?? []).flatMap((item) =>
			typeof item.relation === "string" ? [item.relation] : [],
		);
		const tables = new Set(typeof plan.from === "string" ? [plan.from] : []);
		for (const field of fields) tables.add(field.split(".")[0]);
		for (const id of relations) {
			const relation = this.relations.get(id);
			if (relation) {
				tables.add(String(relation.left_table));
				tables.add(String(relation.right_table));
			}
		}
		return { tables: [...tables], fields: [...fields], relations };
	}
}
