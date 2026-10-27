import assert from "node:assert/strict";
import test from "node:test";
import { SchemaDisclosure, SchemaDisclosureError } from "../src/schema-disclosure.ts";

type RecordValue = Record<string, unknown>;
const table = (name: string, columns: string[], target?: string, keys?: string[]) => ({
	name,
	columns: columns.map((column) => ({ name: column, type: "TEXT", nullable: false })),
	foreign_keys: target ? [{ table: target, columns: (keys ?? []).map((key) => ({ from: key, to: key })) }] : [],
});
const relation = (id: string, left: string, right: string, keys: string[]) => ({
	id,
	left_table: left,
	right_table: right,
	pairs: keys.map((key) => ({ left: key, right: key })),
	origin: "database_metadata",
	status: "active",
});
const catalog = {
	schema_fingerprint: "frozen-source",
	tables: [
		table("institutions", ["institution_id"]),
		table("patients", ["institution_id", "patient_id", "name"], "institutions", ["institution_id"]),
		table("stays", ["institution_id", "patient_id", "stay_id", "discharged_at"], "patients", [
			"institution_id",
			"patient_id",
		]),
		table("procedures", ["institution_id", "stay_id", "procedure_id", "performed_at"], "stays", [
			"institution_id",
			"stay_id",
		]),
		table("events", ["institution_id", "procedure_id", "event_id", "event_type"], "procedures", [
			"institution_id",
			"procedure_id",
		]),
		table("orders", ["institution_id", "order_id", "status"]),
		table("unrelated", ["id"]),
	],
	relations: [
		relation("patients_org", "patients", "institutions", ["institution_id"]),
		relation("stay_patient", "stays", "patients", ["institution_id", "patient_id"]),
		relation("procedure_stay", "procedures", "stays", ["institution_id", "stay_id"]),
		relation("event_procedure", "events", "procedures", ["institution_id", "procedure_id"]),
		{ ...relation("candidate", "orders", "procedures", ["institution_id"]), origin: "inferred", status: "candidate" },
	],
	semantics: {
		tables: {
			institutions: { description: "机构" },
			patients: { description: "患者主索引", columns: { name: "患者姓名" } },
			stays: {
				description: "一次住院",
				aliases: ["住院记录"],
				grain: "每行一次住院",
				time_role: "出院时间",
				columns: { discharged_at: "出院时间" },
			},
			procedures: { description: "实际完成操作", columns: { performed_at: "实际操作完成时间" } },
			events: { description: "临床事件", columns: { event_type: "麻醉不良事件分类" } },
			orders: { description: "医嘱", columns: { status: "医嘱状态" } },
		},
		field_bindings: [
			{ logical_field_id: "fld.procedure", physical_field: "procedures.procedure_id" },
			{ logical_field_id: "fld.order", physical_field: "orders.order_id" },
			{ logical_field_id: "fld.event", physical_field: "events.event_id" },
		],
		code_mappings: [
			{ physical_field: "events.event_type", value: "AE99", value_type: "string", meaning: "特殊事件" },
			{ physical_field: "orders.status", value: 1, value_type: "number", meaning: "执行" },
		],
		relations: [
			{ ...relation("candidate", "orders", "procedures", ["institution_id"]), origin: "inferred", status: "candidate" },
		],
		metric_bindings: [
			{
				metric_id: "m1",
				name: "操作事件",
				required_field_ids: ["fld.procedure"],
				dependency_metric_ids: ["m2"],
				rule: "保持完整分子和分母规则",
			},
			{
				metric_id: "m2",
				required_field_bindings: [{ physical_field: "orders.order_id" }],
				time_fields: [{ physical_field: "events.event_id" }],
			},
			{ metric_id: "m3", required_field_ids: ["fld.order"], rule: "无关大规则".repeat(5000) },
		],
		benchmark_conventions: {
			global_rule: "所有统计按机构隔离",
			observed_code_values: { "orders.status": [1], "events.event_type": ["AE99"] },
		},
		future_global_constraint: { text: "未识别扩展约束必须原样保留" },
	},
};
const common = { source_id: "source", version: "version-1" };
const names = (value: RecordValue): string[] => (value.tables as { name: string }[]).map((item) => item.name);

// 全表索引面向模型完整展示，但字段和代码只留在后台索引与按需读取接口。
test("轻量索引覆盖全部物理表且不泄露全量字段或规则，显式粒度保留", () => {
	const disclosure = new SchemaDisclosure({ ...common, catalog });
	const index = disclosure.index();
	assert.equal(index.tables.length, 7);
	assert.deepEqual(
		index.tables.find((item) => item.table_id === "stays"),
		{
			table_id: "stays",
			name: "stays",
			description: "一次住院",
			aliases: ["住院记录"],
			grain: "每行一次住院",
			time_role: "出院时间",
		},
	);
	assert.deepEqual(
		index.tables.find((item) => item.table_id === "unrelated"),
		{ table_id: "unrelated", name: "unrelated", description: null, aliases: [] },
	);
	assert.equal(JSON.stringify(index).includes("performed_at"), false);
	assert.equal(JSON.stringify(index).includes("AE99"), false);
	assert.equal(JSON.stringify(index).includes("无关大规则"), false);
	assert.deepEqual(
		index.metric_index.map((item) => item.metric_id),
		["m1", "m2", "m3"],
	);
	assert.equal(Object.isFrozen(index.tables[0]), true);
	const changed = structuredClone(catalog);
	changed.tables[0].columns.push({ name: "hidden", type: "TEXT", nullable: false });
	assert.notEqual(
		new SchemaDisclosure({ ...common, catalog: changed }).index().receipt.index_hash,
		index.receipt.index_hash,
	);
});

test("搜索复用列/代码证据只提供候选提示，不把提示当成已读元信息", () => {
	const disclosure = new SchemaDisclosure({ ...common, catalog });
	const result = disclosure.search("AE99");
	assert.equal(result.tables[0].table_id, "events");
	assert.equal("columns" in result.tables[0], false);
	assert.deepEqual(names(disclosure.catalog), []);
	assert.deepEqual(disclosure.validatePlan({ from: "events", select: [{ field: "events.event_type" }] }).tables, [
		"events",
	]);
	assert.throws(() => disclosure.search(" ae99 "), /schema_search_no_progress/);
	assert.deepEqual(disclosure.search("zzzz_unknown_no_match").tables, []);
});

test("读取展开完整复合父外键，保留字段类型与代码，不反向展开兄弟事实表", () => {
	const disclosure = new SchemaDisclosure({ ...common, catalog });
	const result = disclosure.read(["events"]);
	assert.deepEqual(names(result.catalog), ["institutions", "patients", "stays", "procedures", "events"]);
	assert.deepEqual((result.catalog.tables as unknown[])[4], catalog.tables[4]);
	assert.deepEqual(
		(result.catalog.relations as { id: string }[]).map((item) => item.id),
		["patients_org", "stay_patient", "procedure_stay", "event_procedure"],
	);
	assert.deepEqual((result.catalog.semantics as RecordValue).code_mappings, [catalog.semantics.code_mappings[0]]);
	assert.deepEqual((result.catalog.semantics as RecordValue).metric_bindings, []);
	assert.deepEqual(
		(result.catalog.semantics as RecordValue).future_global_constraint,
		catalog.semantics.future_global_constraint,
	);
	assert.deepEqual((result.catalog.semantics as RecordValue).benchmark_conventions, {
		global_rule: "所有统计按机构隔离",
		observed_code_values: { "events.event_type": ["AE99"] },
	});
	assert.equal(result.receipt.round, 1);
	assert.equal(result.receipt.dependency_ids.includes("orders"), false);
});

test("只有已确认关联可以补桥，候选关系不能成为执行依据", () => {
	const local = structuredClone(catalog);
	for (const item of local.tables) item.foreign_keys = [];
	const disclosure = new SchemaDisclosure({ ...common, catalog: local });
	assert.deepEqual(names(disclosure.read(["events", "patients", "orders"]).catalog), [
		"patients",
		"stays",
		"procedures",
		"events",
		"orders",
	]);
	assert.deepEqual(
		disclosure.validatePlan({
			from: "orders",
			select: [{ field: "*", aggregate: "count" }],
			joins: [{ relation: "candidate", type: "inner" }],
		}).relations,
		["candidate"],
	);
	const narrow = new SchemaDisclosure({ ...common, catalog: local, max_bridge_hops: 2 });
	assert.deepEqual(names(narrow.read(["events", "patients"]).catalog), ["patients", "events"]);
});

test("显式指标请求完整加载依赖规则与物理表，默认不按共享表猜测所有指标", () => {
	const disclosure = new SchemaDisclosure({ ...common, catalog });
	const result = disclosure.read(["procedures"], ["m1"]);
	assert.deepEqual(names(result.catalog), ["institutions", "patients", "stays", "procedures", "events", "orders"]);
	assert.deepEqual(
		(result.catalog.semantics as RecordValue).metric_bindings,
		catalog.semantics.metric_bindings.slice(0, 2),
	);
	assert.deepEqual(result.receipt.metric_ids, ["m1", "m2"]);
	assert.deepEqual((result.catalog.semantics as RecordValue).disclosure_omissions, {
		metric_bindings: { count: 1, reason: "rules_not_loaded_request_metric_ids" },
	});
	assert.equal(JSON.stringify(result.catalog).includes("无关大规则"), false);
	assert.deepEqual(disclosure.read(["unrelated"]).receipt.metric_ids, ["m1", "m2"]);
});

test("最多三轮且每轮最多五个新增种子，重复及未知身份不消耗可用轮数", () => {
	const disclosure = new SchemaDisclosure({ ...common, catalog });
	assert.throws(() => disclosure.read(["made_up"]), /schema_unknown_table/);
	assert.throws(() => disclosure.read([], ["made_up_metric"]), /schema_unknown_metric/);
	assert.throws(() => disclosure.read(catalog.tables.map((item) => item.name)), /schema_seed_limit_exceeded/);
	disclosure.read(["patients"]);
	assert.throws(() => disclosure.read(["patients", "institutions"]), /schema_read_no_progress/);
	disclosure.read(["orders"]);
	assert.equal(disclosure.read(["unrelated"]).receipt.round, 3);
	assert.throws(() => disclosure.read(["events"]), /schema_read_limit_exceeded/);
	assert.equal(disclosure.receipts.filter((item) => item.action === "read").length, 3);
});

test("预算按完整 Unicode 字符计算，超限原子失败而不截断规则或占用轮次", () => {
	const disclosure = new SchemaDisclosure({ ...common, catalog });
	const index = disclosure.index(),
		read = disclosure.read(["orders"]);
	assert.equal(
		read.receipt.character_budget.actual,
		[...JSON.stringify({ index: { tables: index.tables, metric_index: index.metric_index }, catalog: read.catalog })]
			.length,
	);
	const limited = new SchemaDisclosure({
		...common,
		catalog,
		max_context_chars: read.receipt.character_budget.actual - 1,
	});
	limited.index();
	assert.throws(
		() => limited.read(["orders"]),
		(error) => {
			assert.ok(error instanceof SchemaDisclosureError);
			assert.equal(error.code, "schema_context_budget_exceeded");
			assert.ok(error.receipt!.character_budget.actual > error.receipt!.character_budget.maximum);
			return true;
		},
	);
	assert.deepEqual(names(limited.catalog), []);
	assert.equal(limited.read(["unrelated"]).receipt.round, 1);
});

test("执行引用必须已经读取，且 Linking 必须覆盖 DSL 的全部显式引用", () => {
	const disclosure = new SchemaDisclosure({ ...common, catalog });
	disclosure.read(["orders"]);
	const plan = {
		from: "orders",
		select: [{ field: "orders.order_id", aggregate: "count_distinct", as: "人数" }],
		where: [{ field: "orders.status", op: "eq", value: 1 }],
		order_by: [{ field: "人数", direction: "desc" }],
	};
	assert.doesNotThrow(() =>
		disclosure.assertPlan(plan, { tables: ["orders"], fields: ["orders.order_id", "orders.status"], relations: [] }),
	);
	assert.throws(
		() => disclosure.assertPlan(plan, { tables: ["orders"], fields: ["orders.order_id"], relations: [] }),
		/schema_linking_dsl_mismatch/,
	);
	assert.deepEqual(disclosure.validatePlan({ from: "orders", select: [{ field: "orders.ghost" }] }), {
		tables: [],
		fields: ["orders.ghost"],
		relations: [],
	});
	assert.deepEqual(disclosure.validatePlan({ from: "events", select: [{ field: "events.event_id" }] }), {
		tables: ["events"],
		fields: ["events.event_id"],
		relations: [],
	});
	assert.throws(
		() => disclosure.assertPlan({ from: "events", select: [{ field: "events.event_id" }] }),
		/schema_plan_metadata_not_read/,
	);
	assert.throws(
		() =>
			disclosure.assertPlan(plan, {
				tables: ["orders", "unrelated"],
				fields: ["orders.order_id", "orders.status"],
				relations: [],
			}),
		/schema_plan_metadata_not_read/,
	);
});

test("输入与收据不可变，修改返回值不会扩大已读或授权关系", () => {
	const local = structuredClone(catalog),
		disclosure = new SchemaDisclosure({ ...common, catalog: local });
	local.tables[0].name = "mutated";
	const result = disclosure.read(["orders"]);
	assert.equal(disclosure.index().tables[0].table_id, "institutions");
	assert.equal(Object.isFrozen(result.catalog), true);
	assert.throws(() => (result.catalog.tables as unknown[]).push(local.tables[0]), TypeError);
	assert.throws(() => disclosure.receipts.push(result.receipt), TypeError);
	assert.deepEqual(names(disclosure.catalog), ["orders"]);
});

// 基础业务字典的 metrics 和 L0 的 metric_bindings 格式不同，两者都必须明确披露范围。
test("基础指标按显式业务表完整加载约束，跨表时间字段展开依赖，未知全局约束保留", () => {
	const rules = [
		{
			id: "executed_orders",
			name: "已执行医嘱",
			table: "orders",
			key: "order_id",
			status_field: "orders.status",
			status_value: 1,
			time_field: "procedures.performed_at",
			aggregate: "count",
		},
	];
	const local = { ...catalog, semantics: { ...catalog.semantics, metrics: rules } };
	const disclosure = new SchemaDisclosure({ ...common, catalog: local });
	assert.equal(disclosure.index().metric_index.at(-1)?.metric_id, "executed_orders");
	const narrow = disclosure.read(["unrelated"]);
	assert.deepEqual((narrow.catalog.semantics as RecordValue).metrics, []);
	assert.deepEqual(((narrow.catalog.semantics as RecordValue).disclosure_omissions as RecordValue).metrics, {
		count: 1,
		reason: "rules_not_loaded_read_related_tables_or_request_metric_ids",
	});
	const read = disclosure.read(["orders"]);
	assert.deepEqual((read.catalog.semantics as RecordValue).metrics, rules);
	assert.equal(names(read.catalog).includes("procedures"), true);
	assert.equal(names(read.catalog).includes("stays"), true);
	assert.equal(read.receipt.metric_ids.includes("executed_orders"), true);
	assert.deepEqual((read.catalog.semantics as RecordValue).metric_bindings, []);
	assert.deepEqual(
		new SchemaDisclosure({ ...common, catalog: local }).read([], ["executed_orders"]).catalog.semantics,
		new SchemaDisclosure({ ...common, catalog: local }).read(["orders"]).catalog.semantics,
	);
	assert.throws(
		() =>
			new SchemaDisclosure({
				...common,
				catalog: { ...local, semantics: { ...local.semantics, metrics: [{ ...rules[0], id: "m1" }] } },
			}),
		/schema_duplicate_or_invalid_metric_id/,
	);
});

test("默认列名与聚合输出别名排序对齐 SQL 编译器，不需要读取虚构字段", () => {
	const disclosure = new SchemaDisclosure({ ...common, catalog });
	disclosure.read(["orders"]);
	assert.doesNotThrow(() =>
		disclosure.assertPlan(
			{
				from: "orders",
				select: [{ field: "orders.order_id", aggregate: "count_distinct" }],
				order_by: [{ field: "count_distinct_order_id", direction: "desc" }],
			},
			{ tables: ["orders"], fields: ["orders.order_id"], relations: [] },
		),
	);
	assert.doesNotThrow(() =>
		disclosure.assertPlan(
			{ from: "orders", select: [{ field: "orders.status" }], order_by: [{ field: "status", direction: "asc" }] },
			{ tables: ["orders"], fields: ["orders.status"], relations: [] },
		),
	);
});

test("SQLite 省略复合目标列名时按主键顺序还原，缺少确认关系的 FK 不授权父表", () => {
	const local: RecordValue = structuredClone(catalog);
	const localTables = local.tables as RecordValue[];
	localTables[1].columns = (localTables[1].columns as RecordValue[]).map((column) => ({
		...column,
		primary_key: column.name === "institution_id" ? 1 : column.name === "patient_id" ? 2 : 0,
	}));
	localTables[2].foreign_keys = [
		{
			table: "patients",
			columns: [
				{ from: "institution_id", to: null, sequence: 0 },
				{ from: "patient_id", to: null, sequence: 1 },
			],
		},
	];
	const disclosure = new SchemaDisclosure({ ...common, catalog: local });
	const read = disclosure.read(["stays"]);
	assert.deepEqual(names(read.catalog), ["institutions", "patients", "stays"]);
	const stayPatient = (read.catalog.relations as RecordValue[]).find((item) => item.id === "stay_patient");
	assert.deepEqual(stayPatient?.pairs, [
		{ left: "institution_id", right: "institution_id" },
		{ left: "patient_id", right: "patient_id" },
	]);
	const unconfirmed = {
		...local,
		relations: (local.relations as RecordValue[]).filter((item) => item.id !== "stay_patient"),
	};
	assert.deepEqual(names(new SchemaDisclosure({ ...common, catalog: unconfirmed }).read(["stays"]).catalog), ["stays"]);
});
