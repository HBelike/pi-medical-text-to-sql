import { createHash } from "node:crypto";
import { DomainFailure } from "./domain.ts";
import { object } from "./model.ts";
import { SchemaDisclosure, SchemaDisclosureError } from "./schema-disclosure.ts";

type RecordValue = Record<string, unknown>;
type Requirement = { id: string; text: string };
type Decide = <T>(label: string, prompt: string, input: RecordValue, validate: (value: unknown) => T) => Promise<T>;

// 披露动作共享现有模型额度；三次读取包含首批和两次追加，避免自主取证成为无界循环。
export const DISCLOSURE_POLICY = { max_reads: 3, max_searches: 2, max_actions: 6, max_tables_per_read: 5 } as const;
const SELECT_PROMPT = `你是医疗问数的元数据选择模块。先根据轻量表目录、后台检索提示、原问题及同版本历史识别所需业务对象。目录不是完整schema，不得猜字段、代码或关联。首批选择1至5张直接相关表，随后才能读取字段；必要桥表由程序按已确认关系补齐。表名相似不代表业务事实相同，特别区分申请、计划、实际发生，以及患者、就诊、事件的行粒度。
返回JSON：{"action":"read_schema|search_schema|clarify|blocked","reason":"选择或缺项依据","table_ids":[],"metric_ids":[],"search_query":"仅search_schema填写，描述缺少的业务字段或代码","requirements":[{"id":"r1","text":"原问题中的一个必要数据需求"}],"question":"仅clarify填写","slots":[],"options":[]}。
requirements必须逐项保留统计对象、过滤/排除、时间、分组、去重及分子分母需求，不能省略条件；id唯一且后续不变。read_schema仅使用目录中的table_id或metric_id，每次最多5张新表；若表描述不足，search_schema可在后台全库字段/代码索引中搜索，再选择表。无法从资料确认口径时澄清或blocked，不猜正式指标公式。追问只用业务语言。不要生成DSL或SQL。`;
const PLAN_SUFFIX = `
本轮采用渐进披露，table_index只是全库轻量索引，只有catalog中的完整元信息可作为执行依据。schema_discovery.requirements是首轮从原问题提取的必要需求清单。先检查统计对象、时间、纳排条件、分组、去重及关联路径；表齐了不代表口径正确。
新增动作：{"action":"read_schema","table_ids":["需要补读的新表ID"],"metric_ids":[],"reason":"说明哪些必要需求尚无字段或关联依据"}；或{"action":"search_schema","search_query":"要在全库字段/代码索引查找的业务含义","reason":"明确缺项"}。缺字段或规则时先补读，禁止通过猜测未读表列生成DSL。metric_ids用于完整加载该指标绑定及其依赖，未读取的指标规则不构成计算依据。禁止仅因空结果放宽条件；补读有次数和字符预算，无法解决时clarify或blocked。
action=query时除原格式外必须返回coverage数组：[{"requirement_id":"r1","tables":["DSL实际使用且已读的表"],"fields":["DSL实际使用且已读的table.column"],"relations":["DSL实际使用且已确认的relation id"]}]。每个需求恰好对应一项，至少有一个实际使用的元信息引用。不得用未使用的字段伪装覆盖；该清单只提供可审查证据，不替代原问题或正式规则。linking必须包含DSL实际使用的全部表、字段和关系，不得引用未读对象。`;

export const PROGRESSIVE_PLANNING_SIGNATURE = createHash("sha256")
	.update(SELECT_PROMPT)
	.update(PLAN_SUFFIX)
	.update(JSON.stringify(DISCLOSURE_POLICY))
	.digest("hex");

// 普通分支仍沿用同一决策校验，渐进分支只增加取证动作和明确的需求覆盖证据。
export function validateQueryDecision(value: unknown): RecordValue {
	const plan = object(value);
	if (!["query", "clarify", "blocked"].includes(String(plan.action))) throw new Error("模型决策类型无效");
	if (plan.action === "query") object(plan.dsl);
	if (plan.action === "clarify") {
		if (typeof plan.question !== "string" || !plan.question.trim()) throw new Error("追问缺少具体问题");
		if (
			plan.slots !== undefined &&
			(!Array.isArray(plan.slots) ||
				plan.slots.length > 8 ||
				plan.slots.some((slot) => typeof slot !== "string" || !slot.trim() || slot.length > 100))
		)
			throw new Error("追问slots必须为最多8个具体业务项名称");
	}
	return plan;
}

// 从DSL本身提取证据，不能相信模型另行声明的linking或coverage已正确反映了执行计划。
function planReferences(dsl: unknown, catalog: RecordValue) {
	const plan = object(dsl);
	const tables = new Set<string>(typeof plan.from === "string" ? [plan.from] : []);
	const fields = new Set<string>();
	const relations = new Set<string>();
	const selections = Array.isArray(plan.select) ? plan.select.map(object) : [];
	const aliases = new Set(selections.filter((item) => typeof item.as === "string").map((item) => String(item.as)));
	const field = (value: unknown) => {
		if (typeof value === "string" && value.includes(".")) {
			fields.add(value);
			tables.add(value.split(".")[0]);
		}
	};
	for (const selection of selections) field(selection.field);
	for (const item of Array.isArray(plan.where) ? plan.where : []) field(object(item).field);
	for (const item of Array.isArray(plan.group_by) ? plan.group_by : []) field(item);
	for (const item of Array.isArray(plan.order_by) ? plan.order_by : []) {
		const reference = object(item).field;
		if (!aliases.has(String(reference))) field(reference);
	}
	const byId = new Map(
		(Array.isArray(catalog.relations) ? catalog.relations : []).map((item) => {
			const relation = object(item);
			return [String(relation.id), relation] as const;
		}),
	);
	for (const item of Array.isArray(plan.joins) ? plan.joins : []) {
		const id = String(object(item).relation);
		relations.add(id);
		const relation = byId.get(id);
		if (relation) {
			tables.add(String(relation.left_table));
			tables.add(String(relation.right_table));
		}
	}
	return { tables, fields, relations };
}

export class ProgressivePlanner {
	private readonly options: {
		catalog: RecordValue;
		source_id: string;
		version: string;
		max_context_chars: number;
		initial_limit: number;
		question: string;
		replies: unknown[];
		prior: unknown[];
		as_of: unknown;
		plan_prompt: string;
		decide: Decide;
		observe: (receipt: unknown, phase: string) => Promise<void>;
		assert_source: () => Promise<void>;
	};
	private readonly disclosure: SchemaDisclosure;
	private readonly index: ReturnType<SchemaDisclosure["index"]>;
	private requirements: Requirement[] = [];
	private searchResults: unknown[] = [];
	private searches = 0;
	private actions = 0;
	private initialized = false;
	private draftFilters: unknown[] | undefined;
	private readonly searchQueries = new Set<string>();
	constructor(options: ProgressivePlanner["options"]) {
		this.options = options;
		this.disclosure = new SchemaDisclosure({
			catalog: options.catalog,
			source_id: options.source_id,
			version: options.version,
			max_context_chars: options.max_context_chars,
			initial_limit: Math.min(DISCLOSURE_POLICY.max_tables_per_read, options.initial_limit),
			max_reads: DISCLOSURE_POLICY.max_reads,
		});
		this.index = this.disclosure.index();
	}
	get catalog(): RecordValue {
		return this.disclosure.catalog;
	}

	async plan(correction?: unknown): Promise<RecordValue> {
		if (!this.initialized) {
			await this.options.observe(this.index.receipt, "读取轻量表目录");
			// 后台检索使用完整字段和代码证据，模型只收到轻量候选；续问保留同版本已确认历史线索。
			await this.search(
				// 这里只限制后台排序用的检索词长度；下一次模型仍收到完整问题、补充和历史条件。
				JSON.stringify({
					question: this.options.question,
					replies: this.options.replies,
					prior: this.options.prior,
				}).slice(0, 4000),
				"检索选表线索",
			);
		}
		for (;;) {
			if (this.actions >= DISCLOSURE_POLICY.max_actions)
				throw new DomainFailure("schema_action_budget_exceeded", "元信息取证次数已到上限，尚未形成完整计划");
			await this.options.assert_source();
			const selecting = !this.initialized;
			const metadata = {
				table_index: { tables: this.index.tables, metrics: this.index.metric_index },
				...(selecting ? {} : { catalog: this.catalog }),
				schema_discovery: {
					phase: selecting ? "select" : "plan",
					requirements: this.requirements,
					search_results: this.searchResults,
					policy: DISCLOSURE_POLICY,
				},
			};
			const actual = [...JSON.stringify(metadata)].length;
			if (actual > this.options.max_context_chars) {
				await this.options.observe(
					{
						schema_version: "schema-disclosure-budget/v1",
						status: "failed",
						error_code: "schema_context_budget_exceeded",
						character_budget: { maximum: this.options.max_context_chars, actual, unit: "unicode_code_points" },
					},
					"元信息上下文超出预算",
				);
				throw new DomainFailure("schema_context_budget_exceeded", "表索引与已读元信息总量超出预算");
			}
			this.actions++;
			const decision = await this.options.decide(
				selecting ? "选择首批数据表" : "匹配字段与检查数据需求",
				selecting ? SELECT_PROMPT : `${this.options.plan_prompt}${PLAN_SUFFIX}`,
				{
					question: this.options.question,
					replies: this.options.replies,
					prior: this.options.prior,
					source_id: this.options.source_id,
					as_of: this.options.as_of,
					...metadata,
					...(correction ? { correction } : {}),
				},
				(value) => {
					const plan = object(value);
					if (Object.hasOwn(plan, "pending_schema_tables")) throw new Error("不能声明程序内部的元信息补读状态");
					if (["read_schema", "search_schema"].includes(String(plan.action))) {
						if (typeof plan.reason !== "string" || !plan.reason.trim()) throw new Error("补查必须说明具体数据需求");
						if (selecting) {
							if (!Array.isArray(plan.requirements) || !plan.requirements.length || plan.requirements.length > 32)
								throw new Error("选表必须提取1至32项必要数据需求");
							const ids = new Set<string>();
							for (const item of plan.requirements) {
								const requirement = object(item);
								if (
									typeof requirement.id !== "string" ||
									!requirement.id.trim() ||
									ids.has(requirement.id) ||
									typeof requirement.text !== "string" ||
									!requirement.text.trim()
								)
									throw new Error("数据需求必须有唯一ID和完整业务说明");
								ids.add(requirement.id);
							}
						}
						if (plan.action === "read_schema") {
							if (
								!Array.isArray(plan.table_ids) ||
								plan.table_ids.some((id) => typeof id !== "string") ||
								plan.table_ids.length > Math.min(5, this.options.initial_limit)
							)
								throw new Error("每次读取须给出至多5个真实表ID");
							if (
								plan.metric_ids !== undefined &&
								(!Array.isArray(plan.metric_ids) || plan.metric_ids.some((id) => typeof id !== "string"))
							)
								throw new Error("metric_ids必须为指标ID数组");
						} else if (
							typeof plan.search_query !== "string" ||
							!plan.search_query.trim() ||
							plan.search_query.length > 2000
						)
							throw new Error("元信息搜索必须给出具体且有界的检索词");
						return plan;
					}
					if (selecting && plan.action === "query") throw new Error("必须先读取元信息，才能生成查询计划");
					const parsed = validateQueryDecision(plan);
					if (parsed.action === "query") {
						object(parsed.linking);
						this.preserveDraftFilters(parsed.dsl);
						try {
							this.disclosure.assertPlan(parsed.dsl, parsed.linking);
						} catch (error) {
							// 已知但未读的表先补读，再重新制定计划；绝不直接执行模型猜出的真实表。
							if (
								!(error instanceof SchemaDisclosureError) ||
								!error.missing.tables.length ||
								error.missing.tables.some((id) => !this.index.tables.some((table) => table.table_id === id))
							)
								throw error;
							this.draftFilters ??= structuredClone(
								Array.isArray(object(parsed.dsl).where) ? (object(parsed.dsl).where as unknown[]) : [],
							);
							return { ...parsed, pending_schema_tables: error.missing.tables };
						}
						this.validateCoverage(parsed);
					}
					return parsed;
				},
			);
			if (selecting && Array.isArray(decision.requirements)) {
				const requirements = decision.requirements.map((item) => object(item) as Requirement);
				// 搜索后仍须保留已经提取的需求，不能通过改写ID绕过原条件覆盖。
				if (
					this.requirements.some(
						(before) => !requirements.some((after) => before.id === after.id && before.text === after.text),
					)
				)
					throw new DomainFailure("schema_requirements_changed", "元信息补查删除或改变了原问题的数据需求");
				this.requirements = requirements;
			}
			if (decision.action === "search_schema") {
				const query = String(decision.search_query).trim();
				if (this.searches >= DISCLOSURE_POLICY.max_searches || this.searchQueries.has(query))
					throw new DomainFailure("schema_search_budget_exceeded", "元信息搜索重复或已到次数上限");
				this.searches++;
				this.searchQueries.add(query);
				await this.search(query, "搜索缺失的字段与代码");
				continue;
			}
			if (decision.action === "read_schema" || Array.isArray(decision.pending_schema_tables)) {
				await this.options.assert_source();
				try {
					const result = this.disclosure.read(
						(decision.pending_schema_tables ?? decision.table_ids) as string[],
						(decision.metric_ids ?? []) as string[],
					);
					await this.options.observe(
						{
							...result.receipt,
							reason: decision.reason ?? "DSL引用尚未读取的元信息",
							requirements: this.requirements,
						},
						selecting ? "读取首批表字段与关系" : "补读缺失表字段与关系",
					);
				} catch (error) {
					if (error instanceof SchemaDisclosureError && error.receipt)
						await this.options.observe(
							{ ...error.receipt, status: "failed", error_code: error.code },
							"元信息读取失败",
						);
					throw error;
				}
				this.initialized = true;
				continue;
			}
			return decision;
		}
	}

	private async search(query: string, phase: string): Promise<void> {
		try {
			const result = this.disclosure.search(query);
			this.searchResults = result.tables;
			await this.options.observe(result.receipt, phase);
		} catch (error) {
			if (error instanceof SchemaDisclosureError && error.receipt)
				await this.options.observe({ ...error.receipt, status: "failed", error_code: error.code }, "元信息搜索失败");
			throw error;
		}
	}

	private preserveDraftFilters(dsl: unknown): void {
		if (!this.draftFilters) return;
		const plan = object(dsl);
		const after = Array.isArray(plan.where) ? plan.where : [];
		const fields = new Set(
			(this.catalog.tables as RecordValue[]).flatMap((table) =>
				(table.columns as RecordValue[]).map((column) => `${table.name}.${column.name}`),
			),
		);
		// 补读只补充依据，不能借重新规划删除已有过滤；不存在的草稿字段允许在保留方向和值时纠正。
		if (
			this.draftFilters.some(
				(before) =>
					!after.some((candidate) => {
						if (JSON.stringify(before) === JSON.stringify(candidate)) return true;
						const original = object(before),
							corrected = object(candidate);
						// 空值谓词没有操作数，允许与既有编译修复相同的严格语法等价变换。
						if (
							["is_null", "is_not_null"].includes(String(original.op)) &&
							original.value === null &&
							Object.keys(original).length === 3 &&
							Object.keys(corrected).length === 2 &&
							!Object.hasOwn(corrected, "value") &&
							original.field === corrected.field &&
							original.op === corrected.op
						)
							return true;
						return (
							!fields.has(String(original.field)) &&
							fields.has(String(corrected.field)) &&
							original.op === corrected.op &&
							JSON.stringify(original.value) === JSON.stringify(corrected.value)
						);
					}),
			)
		)
			throw new DomainFailure("schema_read_changed_conditions", "补读元信息后删除或改变了原查询过滤条件");
	}

	private validateCoverage(plan: RecordValue): void {
		if (!Array.isArray(plan.coverage)) throw new Error("查询计划缺少必要数据需求的coverage证据");
		const refs = planReferences(plan.dsl, this.catalog);
		const covered = new Set<string>();
		for (const item of plan.coverage) {
			const entry = object(item);
			if (
				typeof entry.requirement_id !== "string" ||
				covered.has(entry.requirement_id) ||
				!this.requirements.some((requirement) => requirement.id === entry.requirement_id)
			)
				throw new Error("coverage必须逐项引用唯一且已提取的数据需求ID");
			let evidenceCount = 0;
			for (const key of ["tables", "fields", "relations"] as const) {
				if (!Array.isArray(entry[key]) || entry[key].some((id) => typeof id !== "string" || !refs[key].has(id)))
					throw new Error(`coverage.${key}必须引用本次DSL实际使用的元信息`);
				evidenceCount += entry[key].length;
			}
			if (!evidenceCount) throw new Error("每个必要数据需求至少需要一个实际使用的元信息依据");
			covered.add(entry.requirement_id);
		}
		if (this.requirements.some((requirement) => !covered.has(requirement.id)))
			throw new Error("查询计划遗漏了必要数据需求");
	}
}
