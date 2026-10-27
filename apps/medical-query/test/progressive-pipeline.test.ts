import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { APP_ROOT, readConfig } from "../src/config.ts";
import { DomainService } from "../src/domain.ts";
import { type JsonRecord, type ModelGateway, object } from "../src/model.ts";
import { createPipeline } from "../src/pipeline.ts";
import { type JsonObject, QueryRuntime, type QueryTask } from "../src/runtime.ts";

const requirement = { id: "r1", text: "按患者主键去重统计年龄至少65岁的患者人数" };
const selection = (tableIds = ["patients"], requirementText = requirement.text) => ({
	action: "read_schema",
	table_ids: tableIds,
	metric_ids: [],
	reason: "读取所选业务对象的字段及已确认关系",
	requirements: [{ ...requirement, text: requirementText }],
});
const countPlan = {
	action: "query",
	linking: { tables: ["patients"], fields: ["patients.age", "patients.patient_id"], relations: [] },
	conditions: ["年龄至少65岁", "按患者主键去重"],
	dsl: {
		from: "patients",
		select: [{ field: "patients.patient_id", aggregate: "count_distinct", as: "count" }],
		where: [{ field: "patients.age", op: "gte", value: 65 }],
	},
	coverage: [
		{
			requirement_id: "r1",
			tables: ["patients"],
			fields: ["patients.age", "patients.patient_id"],
			relations: [],
		},
	],
};

type ModelInput = { role: string; input: JsonRecord };
type FakeModel = (phase: string, input: JsonRecord, requests: ModelInput[]) => JsonRecord;

// 保留真实SQLite、目录读取与Durable执行，仅替换付费模型；独立科室表使错误首选不会被外键闭包救回。
async function setup(fake: FakeModel) {
	const dataDir = await mkdtemp(resolve(tmpdir(), "pi-query-progressive-"));
	execFileSync("python3", [resolve(APP_ROOT, "python/build_fixtures.py"), "--output-dir", dataDir]);
	const database = new DatabaseSync(resolve(dataDir, "hospital-a.sqlite"));
	try {
		database.exec("CREATE TABLE departments(department_id TEXT PRIMARY KEY, name TEXT NOT NULL)");
	} finally {
		database.close();
	}
	const requests: ModelInput[] = [];
	const model: Pick<ModelGateway, "json"> = {
		json: async (role, _prompt, value) => {
			const input = object(value);
			requests.push({ role, input: structuredClone(input) });
			if (role === "answer") return { facts: [{ row: 0, column: "count" }] };
			const discovery = object(input.schema_discovery);
			return fake(String(discovery.phase), input, requests);
		},
	};
	const domain = new DomainService({ ...readConfig(), dataDir });
	let runtime: QueryRuntime;
	runtime = await QueryRuntime.open({
		storagePath: resolve(dataDir, "state.sqlite"),
		handler: createPipeline(domain, model, () => runtime),
	});
	let executions = 0;
	const original = domain.call.bind(domain);
	domain.call = async (...args) => {
		if (args[1] === "execute") executions++;
		return original(...args);
	};
	return {
		domain,
		runtime,
		requests,
		executions: () => executions,
		close: async () => {
			await runtime.close();
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}

async function settled(runtime: QueryRuntime, task: QueryTask) {
	const until = Date.now() + 5000;
	while (["queued", "running"].includes(task.status) && Date.now() < until) {
		await delay(10);
		task = (await runtime.get(task.id))!;
	}
	assert.ok(!["queued", "running"].includes(task.status), "任务应在期限内结束");
	return task;
}

function enqueue(runtime: QueryRuntime, requestId: string, context: JsonObject = {}, question = "65岁及以上患者人数") {
	return runtime.enqueue({
		conversationId: "progressive",
		requestId,
		question,
		context: { source_id: "hospital-a", retrieval_strategy: "progressive", retrieval_top_k: 5, ...context },
	});
}

test("首轮只披露表索引，读取后才规划字段并执行真实SQLite", async () => {
	const env = await setup((phase) => (phase === "select" ? selection() : countPlan));
	try {
		const task = await settled(env.runtime, await enqueue(env.runtime, "metadata-only"));
		assert.equal(task.status, "completed");
		const first = env.requests[0].input;
		assert.equal(object(first.schema_discovery).phase, "select");
		assert.ok(Array.isArray(object(first.table_index).tables));
		assert.equal(Object.hasOwn(first, "catalog"), false);
		for (const table of object(first.table_index).tables as JsonRecord[]) {
			assert.equal(Object.hasOwn(table, "columns"), false);
			assert.equal(Object.hasOwn(table, "foreign_keys"), false);
		}
		for (const forbidden of ["patients.age", "code_mappings", "status_value", "status_field", "metric_bindings"])
			assert.equal(JSON.stringify(first.table_index).includes(forbidden), false, forbidden);
		const plan = env.requests.find((request) => object(request.input.schema_discovery ?? {}).phase === "plan")!;
		const catalog = object(plan.input.catalog);
		assert.ok((catalog.tables as JsonRecord[]).some((table) => table.name === "patients"));
		assert.ok(JSON.stringify(catalog).includes('"name":"age"'));
		assert.deepEqual((task.result as { result: { rows: number[][] } }).result.rows, [[3]]);
		assert.equal(env.executions(), 1);
		assert.equal(env.requests.filter((request) => request.role === "decision").length, 2);
	} finally {
		await env.close();
	}
});

test("首次选错独立业务表可补读患者表，保留选表与追加证据", async () => {
	let plans = 0;
	const env = await setup((phase) => {
		if (phase === "select") return selection(["departments"]);
		if (++plans === 1)
			return { action: "read_schema", table_ids: ["patients"], metric_ids: [], reason: "科室目录没有患者年龄及去重键" };
		return countPlan;
	});
	try {
		const task = await settled(env.runtime, await enqueue(env.runtime, "recover-first-selection"));
		assert.equal(task.status, "completed");
		assert.equal(plans, 2);
		assert.equal(env.executions(), 1);
		const trace = object(task.result);
		assert.ok(Array.isArray(trace.retrievals));
		assert.ok(JSON.stringify(trace.retrievals).includes("departments"));
		assert.ok(JSON.stringify(trace.retrievals).includes("patients"));
		assert.deepEqual((task.result as { result: { rows: number[][] } }).result.rows, [[3]]);
	} finally {
		await env.close();
	}
});

test("候选DSL引用未读表必须先补读并重新规划，不能直接交给全库编译器", async () => {
	const executionReads: number[] = [];
	const env = await setup((phase) => (phase === "select" ? selection(["departments"]) : countPlan));
	const original = env.domain.call.bind(env.domain);
	env.domain.call = async (...args) => {
		if (args[1] === "execute")
			executionReads.push(
				env.requests.filter((request) => object(request.input.schema_discovery ?? {}).phase === "plan").length,
			);
		return original(...args);
	};
	try {
		const task = await settled(env.runtime, await enqueue(env.runtime, "unread-dsl"));
		assert.equal(task.status, "completed");
		assert.deepEqual(executionReads, [2]);
		const plans = env.requests.filter((request) => object(request.input.schema_discovery ?? {}).phase === "plan");
		assert.equal(JSON.stringify(plans[0].input.catalog).includes('"name":"patients"'), false);
		assert.equal(JSON.stringify(plans[1].input.catalog).includes('"name":"patients"'), true);
	} finally {
		await env.close();
	}
});

test("重复请求已读表而没有新证据时终止，不消耗SQL次数", async () => {
	const env = await setup((phase) =>
		phase === "select"
			? selection(["departments"])
			: { action: "read_schema", table_ids: ["departments"], metric_ids: [], reason: "再次读取相同表" },
	);
	try {
		const task = await settled(env.runtime, await enqueue(env.runtime, "no-progress"));
		assert.equal(task.status, "failed");
		assert.equal(env.executions(), 0);
		assert.equal(object(task.progress).publication, undefined);
	} finally {
		await env.close();
	}
});

test("正常空结果终止查询，不追加读表、不放宽条件、不调用回答模型", async () => {
	const emptyPlan = {
		...countPlan,
		linking: { tables: ["patients"], fields: ["patients.age", "patients.name"], relations: [] },
		conditions: ["年龄超过150岁"],
		dsl: {
			from: "patients",
			select: [{ field: "patients.name" }],
			where: [{ field: "patients.age", op: "gt", value: 150 }],
		},
		coverage: [
			{ requirement_id: "r1", tables: ["patients"], fields: ["patients.age", "patients.name"], relations: [] },
		],
	};
	const env = await setup((phase) =>
		phase === "select" ? selection(["patients"], "查找年龄超过150岁的患者姓名") : emptyPlan,
	);
	try {
		const task = await settled(env.runtime, await enqueue(env.runtime, "empty", {}, "年龄超过150岁的患者姓名"));
		assert.equal(task.status, "completed");
		assert.deepEqual((task.result as { result: { rows: unknown[] } }).result.rows, []);
		assert.equal(env.executions(), 1);
		assert.deepEqual(
			env.requests.map((request) => request.role),
			["decision", "decision"],
		);
	} finally {
		await env.close();
	}
});

test("续问的首次选表收到同版本已确认历史，仍重新读取当前元信息", async () => {
	const env = await setup((phase) => (phase === "select" ? selection() : countPlan));
	try {
		const first = await settled(env.runtime, await enqueue(env.runtime, "prior-first"));
		assert.equal(first.status, "completed");
		const second = await settled(env.runtime, await enqueue(env.runtime, "prior-next", {}, "按刚才的范围再查一次"));
		assert.equal(second.status, "completed");
		const selectors = env.requests.filter((request) => object(request.input.schema_discovery ?? {}).phase === "select");
		assert.equal(selectors.length, 2);
		assert.deepEqual(selectors[0].input.prior, []);
		assert.equal((selectors[1].input.prior as unknown[]).length, 1);
		assert.ok(JSON.stringify(selectors[1].input.prior).includes("65岁及以上患者人数"));
		assert.ok(JSON.stringify(selectors[1].input.prior).includes("patients.age"));
		assert.equal(env.executions(), 2);
	} finally {
		await env.close();
	}
});

test("轻量索引超过冻结字符预算时保留失败证据且不调用模型或SQL", async () => {
	const env = await setup(() => {
		throw new Error("预算失败不能进入模型");
	});
	try {
		const task = await settled(
			env.runtime,
			await enqueue(env.runtime, "index-budget", { retrieval_max_context_chars: 1 }),
		);
		assert.equal(task.status, "failed");
		assert.equal(env.requests.length, 0);
		assert.equal(env.executions(), 0);
		assert.ok(Array.isArray(object(task.progress).retrievals));
		assert.ok(JSON.stringify(object(task.progress).retrievals).includes("failed"));
		assert.equal(object(task.progress).publication, undefined);
	} finally {
		await env.close();
	}
});

test("表描述缺少字段线索时可搜索元信息，再读取命中的业务表", async () => {
	let plans = 0;
	const dischargePlan = {
		action: "query",
		linking: { tables: ["encounters"], fields: ["encounters.encounter_id", "encounters.status"], relations: [] },
		conditions: ["已出院", "按就诊主键去重"],
		dsl: {
			from: "encounters",
			select: [{ field: "encounters.encounter_id", aggregate: "count_distinct", as: "count" }],
			where: [{ field: "encounters.status", op: "eq", value: "D" }],
		},
		coverage: [
			{
				requirement_id: "r1",
				tables: ["encounters"],
				fields: ["encounters.encounter_id", "encounters.status"],
				relations: [],
			},
		],
	};
	const env = await setup((phase, input) => {
		if (phase === "select") return selection(["departments"], "按就诊主键去重统计已出院就诊人次");
		if (++plans === 1)
			return { action: "search_schema", search_query: "出院时间", reason: "当前科室目录无法定位出院事件字段" };
		if (plans === 2) {
			const hints = object(input.schema_discovery).search_results as JsonRecord[];
			assert.ok(hints.some((hint) => hint.table_id === "encounters"));
			return { action: "read_schema", table_ids: ["encounters"], metric_ids: [], reason: "读取出院字段所属就诊表" };
		}
		return dischargePlan;
	});
	try {
		const task = await settled(env.runtime, await enqueue(env.runtime, "search-field", {}, "统计已出院就诊人次"));
		assert.equal(task.status, "completed");
		assert.equal(plans, 3);
		assert.equal(env.executions(), 1);
		assert.deepEqual((task.result as { result: { rows: number[][] } }).result.rows, [[4]]);
	} finally {
		await env.close();
	}
});

// 覆盖证据由当前DSL核对；缺项仍走已有定向修复预算，不能先执行再补写解释。
test("缺少必要需求coverage只允许有界修复，验证通过前不执行SQL", async () => {
	const env = await setup((phase) => (phase === "select" ? selection() : { ...countPlan, coverage: [] }));
	try {
		const task = await settled(env.runtime, await enqueue(env.runtime, "missing-coverage"));
		assert.equal(task.status, "failed");
		assert.equal(env.executions(), 0);
		assert.equal(task.budget!.repairs, 1);
		assert.equal(env.requests.filter((request) => request.role === "decision").length, 3);
		assert.equal(object(task.progress).publication, undefined);
	} finally {
		await env.close();
	}
});

// 即使首轮选表有效，读取字段前来源变化也必须阻断，不能拿旧索引连接新业务快照。
test("选表完成后数据源变化时拒绝补读与执行", async () => {
	let sourcePath = "";
	const env = await setup((phase) => {
		if (phase === "select") {
			const database = new DatabaseSync(sourcePath);
			try {
				database.exec("INSERT INTO departments VALUES ('changed', '来源已变化')");
			} finally {
				database.close();
			}
			return selection();
		}
		throw new Error("来源变化后不能进入字段规划模型");
	});
	try {
		sourcePath = (await env.domain.source("hospital-a")).path;
		const task = await settled(env.runtime, await enqueue(env.runtime, "source-changed"));
		assert.equal(task.status, "failed");
		assert.match(task.error!.message, /版本已变化/);
		assert.equal(env.requests.length, 1);
		assert.equal(env.executions(), 0);
		assert.equal(object(task.progress).publication, undefined);
	} finally {
		await env.close();
	}
});

// 首个草稿因未读元信息而暂停时，补读提供依据，不授权改变年龄边界或删除过滤。
for (const remove of [false, true])
	test(`未读表自动补读后${remove ? "删除过滤" : "改变过滤取值"}必须在SQL前阻断`, async () => {
		let plans = 0;
		const env = await setup((phase) => {
			if (phase === "select") return selection(["departments"]);
			if (++plans === 1) return countPlan;
			return {
				...countPlan,
				dsl: { ...countPlan.dsl, where: remove ? [] : [{ ...countPlan.dsl.where[0], value: 64 }] },
			};
		});
		try {
			const task = await settled(env.runtime, await enqueue(env.runtime, `draft-filter-${remove}`));
			assert.equal(task.status, "failed");
			assert.match(task.error!.message, /删除或改变/);
			assert.equal(plans, 2);
			assert.equal(env.executions(), 0);
			assert.equal(object(task.progress).publication, undefined);
		} finally {
			await env.close();
		}
	});

// 等价删除空值谓词的冗余null操作数属于语法修正，不改变补读前已经确定的过滤含义。
test("未读表补读后允许严格等价的空值谓词语法修正", async () => {
	let plans = 0;
	const env = await setup((phase) => {
		if (phase === "select") return selection(["departments"]);
		const nullFilter =
			++plans === 1
				? { field: "patients.name", op: "is_null", value: null }
				: { field: "patients.name", op: "is_null" };
		return {
			...countPlan,
			linking: { ...countPlan.linking, fields: [...countPlan.linking.fields, "patients.name"] },
			dsl: { ...countPlan.dsl, where: [...countPlan.dsl.where, nullFilter] },
			coverage: [
				{
					...countPlan.coverage[0],
					fields: [...countPlan.coverage[0].fields, "patients.name"],
				},
			],
		};
	});
	try {
		const task = await settled(env.runtime, await enqueue(env.runtime, "draft-null-syntax"));
		assert.equal(task.status, "completed");
		assert.deepEqual((task.result as { result: { rows: number[][] } }).result.rows, [[0]]);
		assert.equal(env.executions(), 1);
		assert.equal(plans, 2);
	} finally {
		await env.close();
	}
});
