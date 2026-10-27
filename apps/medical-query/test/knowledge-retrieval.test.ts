import assert from "node:assert/strict";
import test from "node:test";
import {
	type KnowledgeDocument,
	knowledgeTokens,
	RetrievalBudgetError,
	retrieveCatalog,
	retrieveDocuments,
	retrieveMetrics,
} from "../src/knowledge-retrieval.ts";

const common = { question: "门诊量", strategy: "lexical", version: "frozen-1", source_id: "hospital-source", limit: 1 };
const metrics = [
	{
		metric_id: "met.gk-01",
		name: "门诊人次",
		original_code: "GK-01",
		aliases: ["门诊量"],
		definition: "按门诊就诊去重",
		dependencies: ["denominator"],
	},
	{ metric_id: "denominator", name: "机构范围", aliases: [], definition: "必需机构条件" },
	{ metric_id: "met.gk-010", name: "健康档案", aliases: [], definition: "未纳入当前查询" },
];

// 精确编号及中文别名要可靠召回，必要口径不能被 top-k 裁掉；输入目录保持不可变。
test("中文别名和完整编号召回，并保留跨 top-k 的必要依赖", () => {
	assert.deepEqual(knowledgeTokens("门诊量 GK-01"), ["01", "gk", "gk-01", "诊量", "门诊"].sort());
	const result = retrieveMetrics({ ...common, metrics });
	assert.deepEqual(
		result.metrics.map((metric) => metric.metric_id),
		["met.gk-01", "denominator"],
	);
	assert.deepEqual(result.receipt.dependency_ids, ["denominator"]);
	assert.deepEqual(result.receipt.dropped_ids, ["met.gk-010"]);
	assert.equal(result.receipt.fallback, "none");
	assert.equal(Object.isFrozen(result.metrics[0]), true);
	assert.equal(Object.isFrozen(metrics[0]), false);
	assert.equal(retrieveMetrics({ ...common, question: "met.gk-010", metrics }).metrics[0].metric_id, "met.gk-010");
});

test("空召回显式回退全目录，索引变化拒绝冒充同一冻结版本", () => {
	const result = retrieveMetrics({ ...common, question: "zzzzunknown", metrics });
	assert.equal(result.metrics.length, metrics.length);
	assert.equal(result.receipt.fallback, "empty_recall_full_catalog");
	assert.throws(
		() =>
			retrieveMetrics({
				...common,
				metrics: [...metrics, { metric_id: "new", name: "新指标" }],
				index_hash: result.receipt.index_hash,
			}),
		/retrieval_index_version_mismatch/,
	);
	assert.throws(() => retrieveMetrics({ ...common, metrics, strategy: "hybrid" }), /unregistered_retrieval_strategy/);
});

test("规则预算超限与缺少依赖明确报错，不静默截断", () => {
	assert.throws(
		() => retrieveMetrics({ ...common, metrics, max_context_chars: 20 }),
		/retrieval_context_budget_exceeded/,
	);
	assert.throws(() => retrieveMetrics({ ...common, metrics: [metrics[0]] }), /metric_dependency_missing/);
});

const catalog = {
	tables: [
		{
			name: "visits",
			description: "门诊量",
			columns: [{ name: "id" }, { name: "org_id" }, { name: "registered_at" }],
			foreign_keys: [{ table: "orgs", columns: [{ from: "org_id", to: "id" }] }],
		},
		{
			name: "orgs",
			columns: [{ name: "id" }, { name: "tenant_id" }],
			foreign_keys: [{ table: "tenants", columns: [{ from: "tenant_id", to: "id" }] }],
		},
		{ name: "tenants", columns: [{ name: "id" }, { name: "name" }], foreign_keys: [] },
		{ name: "unrelated", columns: [{ name: "id" }], foreign_keys: [] },
	],
	relations: [
		{
			id: "r1",
			left_table: "visits",
			right_table: "orgs",
			pairs: [{ left: "org_id", right: "id" }],
			origin: "database_metadata",
			status: "active",
		},
		{
			id: "r2",
			left_table: "orgs",
			right_table: "tenants",
			pairs: [{ left: "tenant_id", right: "id" }],
			origin: "database_metadata",
			status: "active",
		},
		{
			id: "unconfirmed",
			left_table: "visits",
			right_table: "unrelated",
			pairs: [],
			origin: "inferred",
			status: "candidate",
		},
	],
};

test("表召回保留全部列和递归外键闭包，候选关系不扩大范围", () => {
	const result = retrieveCatalog({ ...common, catalog });
	assert.deepEqual(
		result.catalog.tables.map((table) => table.name),
		["visits", "orgs", "tenants"],
	);
	assert.deepEqual(result.catalog.tables[0].columns, catalog.tables[0].columns);
	assert.deepEqual(
		result.catalog.relations.map((relation) => relation.id),
		["r1", "r2"],
	);
	assert.deepEqual(result.receipt.dependency_ids, ["orgs", "tenants"]);
	assert.deepEqual(result.receipt.dropped_ids, ["unrelated"]);
	assert.throws(
		() => retrieveCatalog({ ...common, catalog: { ...catalog, tables: [catalog.tables[0]] } }),
		/(table|relation)_dependency_missing/,
	);
});

test("使用已登记中文表列语义召回，不依赖物理英文表名", () => {
	const local = {
		tables: [
			{ name: "x", columns: [{ name: "a" }], foreign_keys: [] },
			{ name: "y", columns: [{ name: "b" }], foreign_keys: [] },
		],
		relations: [],
		semantics: {
			tables: {
				x: { description: "体检记录", aliases: ["健康筛查"], columns: { a: "体检编号" } },
				y: { description: "药品账单", columns: { b: "账单编号" } },
			},
			rule: "保留全部正式约束",
		},
	};
	const result = retrieveCatalog({ ...common, question: "健康筛查", catalog: local });
	assert.deepEqual(result.receipt.admitted_ids, ["x"]);
	assert.equal(result.receipt.fallback, "none");
	assert.equal((result.catalog.semantics as Record<string, unknown>).rule, "保留全部正式约束");
	assert.deepEqual(Object.keys(result.catalog.semantics?.tables ?? {}), ["x"]);
});

const approved: KnowledgeDocument = {
	id: "approved",
	title: "门诊口径",
	text: "审核后的机构范围说明",
	status: "approved",
	source_id: common.source_id,
	hospital_id: "hospital-a",
	valid_from: "2025-01-01",
	valid_to: "2027-01-01",
	source_ref: "manual:v1#p2",
	content_hash: "frozen-content-hash",
};

test("文档先过滤医院、生效时间与审核状态，空召回只回退合格知识", () => {
	const documents: KnowledgeDocument[] = [
		approved,
		{ ...approved, id: "wrong-hospital", hospital_id: "hospital-b" },
		{ ...approved, id: "revoked", revoked: true },
		{ ...approved, id: "unreviewed", status: "review_required" },
		{ ...approved, id: "expired", valid_to: "2026-01-01" },
		{ ...approved, id: "wrong-source", source_id: "another" },
		{ ...approved, id: "no-citation", source_ref: "" },
	];
	const result = retrieveDocuments({
		...common,
		question: "unknownterm",
		scope: { hospital_id: "hospital-a", as_of: "2026-10-19" },
		documents,
	});
	assert.deepEqual(
		result.documents.map((document) => document.id),
		["approved"],
	);
	assert.equal(result.receipt.filtered.length, 6);
	assert.equal(result.receipt.candidates.length, 0);
	assert.equal(result.receipt.fallback, "empty_recall_full_catalog");
	assert.deepEqual(
		retrieveDocuments({ ...common, scope: { as_of: "2026-10-19" }, documents: [approved] }).documents,
		[],
	);
	assert.throws(
		() => retrieveDocuments({ ...common, scope: { as_of: "invalid" }, documents }),
		/invalid_retrieval_as_of/,
	);
});

// 共享维度仅允许顺着外键访问，不能把“机构”当成所有事实表的反向召回入口。
test("共享机构维度不展开未命中的兄弟事实表", () => {
	const local = structuredClone(catalog);
	local.tables[3].foreign_keys = [{ table: "orgs", columns: [{ from: "id", to: "id" }] }];
	local.relations.push({
		id: "sibling",
		left_table: "unrelated",
		right_table: "orgs",
		pairs: [{ left: "id", right: "id" }],
		origin: "database_metadata",
		status: "active",
	});
	const result = retrieveCatalog({ ...common, catalog: local });
	assert.deepEqual(result.receipt.admitted_ids, ["visits", "orgs", "tenants"]);
	assert.equal(
		result.receipt.dependency_edges?.some((edge) => edge.to === "unrelated"),
		false,
	);
	assert.equal(result.receipt.policy.dependency_policy, "forward-fk-seed-bridge/v2");
});

// 只有同时命中的两个业务表可以寻找有界桥接，未审核关系和路径外的表不会乘机进入上下文。
test("已确认关系仅桥接初始候选，跳数上限写入收据", () => {
	const local = {
		tables: ["alpha", "bridge", "omega", "stranger"].map((name) => ({
			name,
			columns: [{ name: "id" }],
			foreign_keys: [],
		})),
		relations: [
			{ id: "a", left_table: "alpha", right_table: "bridge", origin: "human_confirmed", status: "active" },
			{ id: "b", left_table: "bridge", right_table: "omega", origin: "human_confirmed", status: "active" },
			{ id: "unreviewed", left_table: "alpha", right_table: "stranger", origin: "inferred", status: "candidate" },
		],
	};
	const result = retrieveCatalog({ ...common, question: "alpha omega", limit: 2, max_bridge_hops: 2, catalog: local });
	assert.deepEqual(result.receipt.dependency_ids, ["bridge"]);
	assert.equal(result.receipt.policy.max_bridge_hops, 2);
	assert.equal(
		result.receipt.dependency_edges?.every((edge) => edge.reason === "seed_bridge"),
		true,
	);
	const bounded = retrieveCatalog({ ...common, question: "alpha omega", limit: 2, max_bridge_hops: 1, catalog: local });
	assert.deepEqual(bounded.receipt.dependency_ids, []);
	assert.throws(
		() => retrieveCatalog({ ...common, catalog: local, max_bridge_hops: -1 }),
		/invalid_retrieval_bridge_budget/,
	);
});

test("枚举代码定位所属表，字段字典按归属投影但计算规则不截断", () => {
	const local = {
		tables: ["balances", "visits"].map((name) => ({ name, columns: [{ name: "kind" }], foreign_keys: [] })),
		relations: [],
		semantics: {
			tables: { balances: { description: "财务余额" }, visits: { description: "门诊就诊" } },
			field_bindings: [
				{ physical_field: "balances.kind" },
				{ physical_field: "visits.kind" },
				{ logical_field_id: "unbound-rule" },
			],
			code_mappings: [
				{ physical_field: "balances.kind", value: "CURRENT_LIABILITY", meaning: "流动负债" },
				{ physical_field: "visits.kind", value: "OUTPATIENT" },
			],
			metric_bindings: [
				{ metric_id: "ratio", required_field_ids: ["balances.kind", "visits.kind"], official_rule: "完整保留" },
			],
			benchmark_conventions: {
				global_rule: "零分母不能替成零",
				observed_code_values: { "balances.kind": ["CURRENT_LIABILITY"], "visits.kind": ["OUTPATIENT"] },
			},
			future_rule: { source: "必须保留的扩展约束" },
		},
	};
	const result = retrieveCatalog({ ...common, question: "CURRENT_LIABILITY", catalog: local });
	assert.deepEqual(result.receipt.admitted_ids, ["balances"]);
	assert.deepEqual(result.catalog.semantics?.field_bindings, [
		local.semantics.field_bindings[0],
		local.semantics.field_bindings[2],
	]);
	assert.deepEqual(result.catalog.semantics?.code_mappings, [local.semantics.code_mappings[0]]);
	assert.deepEqual(result.catalog.semantics?.metric_bindings, local.semantics.metric_bindings);
	assert.deepEqual(result.catalog.semantics?.future_rule, local.semantics.future_rule);
	assert.deepEqual(result.catalog.semantics?.benchmark_conventions, {
		global_rule: "零分母不能替成零",
		observed_code_values: { "balances.kind": ["CURRENT_LIABILITY"] },
	});
	assert.ok(
		result.receipt.metadata_projection?.some(
			(item) => item.section === "code_mappings" && item.original_count === 2 && item.admitted_count === 1,
		),
	);
});

test("全目录和空召回回退超限时保留可归因的完整检索收据", () => {
	for (const strategy of ["full_catalog", "lexical"]) {
		assert.throws(
			() => retrieveCatalog({ ...common, question: "zzzzunknown", catalog, strategy, max_context_chars: 1 }),
			(error) => {
				assert.ok(error instanceof RetrievalBudgetError);
				assert.equal(error.code, "retrieval_context_budget_exceeded");
				assert.equal(error.receipt.character_budget.maximum, 1);
				assert.ok(error.receipt.character_budget.actual > 1);
				assert.equal(error.receipt.admitted_ids.length, 4);
				assert.equal(error.receipt.fallback, strategy === "lexical" ? "empty_recall_full_catalog" : "none");
				assert.equal(error.receipt.index_hash.length, 64);
				return true;
			},
		);
	}
});
