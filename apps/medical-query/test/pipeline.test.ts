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
import type { RetrievalReceipt } from "../src/knowledge-retrieval.ts";
import type { ModelGateway, ModelReceipt } from "../src/model.ts";
import { createPipeline } from "../src/pipeline.ts";
import { QueryRuntime, type QueryTask } from "../src/runtime.ts";

const countPlan = {
	action: "query",
	linking: { tables: ["patients"], fields: ["patients.age", "patients.patient_id"] },
	conditions: ["年龄至少65岁"],
	dsl: {
		from: "patients",
		select: [{ field: "patients.patient_id", aggregate: "count_distinct", as: "count" }],
		where: [{ field: "patients.age", op: "gte", value: 65 }],
	},
};

// 使用真实SQLite与Pi任务、仅替换付费模型，验证计划执行和失败后保留数据的边界。
async function setup(model: Pick<ModelGateway, "json">, settings: { resultMaxRows?: number } = {}) {
	const dataDir = await mkdtemp(resolve(tmpdir(), "pi-query-pipeline-"));
	execFileSync("python3", [resolve(APP_ROOT, "python/build_fixtures.py"), "--output-dir", dataDir]);
	const domain = new DomainService({ ...readConfig(), ...settings, dataDir });
	let runtime: QueryRuntime;
	runtime = await QueryRuntime.open({
		storagePath: resolve(dataDir, "state.sqlite"),
		handler: createPipeline(domain, model, () => runtime),
	});
	return {
		domain,
		runtime,
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

// facts与指标分支共享任务检索预算；预算失败保留目录证据，不消耗模型或SQL次数。
test("facts检索使用冻结配置并保留预算失败收据", async () => {
	let calls = 0;
	const env = await setup({
		json: async (role) => {
			calls++;
			return role === "answer" ? { facts: [] } : countPlan;
		},
	});
	try {
		const run = async (requestId: string, maximum: number) =>
			settled(
				env.runtime,
				await env.runtime.enqueue({
					conversationId: requestId,
					requestId,
					question: "patients 65岁及以上人数",
					context: {
						source_id: "hospital-a",
						retrieval_strategy: "lexical",
						retrieval_top_k: 1,
						retrieval_max_context_chars: maximum,
					},
				}),
			);
		const success = await run("budget-ok", 30000);
		assert.equal(success.status, "completed");
		const receipt = (success.result as { retrievals: RetrievalReceipt[] }).retrievals[0];
		assert.equal(receipt.strategy, "lexical");
		assert.equal(receipt.character_budget.maximum, 30000);
		assert.equal(receipt.policy.candidate_limit, 1);
		assert.ok(receipt.admitted_ids.includes("patients"));
		const failure = await run("budget-failed", 1);
		assert.equal(failure.status, "failed");
		assert.equal(calls, 2);
		const failedReceipt = (
			failure.progress as { retrievals: (RetrievalReceipt & { status: string; error_code: string })[] }
		).retrievals[0];
		assert.equal(failedReceipt.status, "failed");
		assert.equal(failedReceipt.error_code, "retrieval_context_budget_exceeded");
		assert.equal(failedReceipt.character_budget.maximum, 1);
		assert.ok(failedReceipt.character_budget.actual > 1);
		assert.equal((failure.progress as { publication?: unknown }).publication, undefined);
	} finally {
		await env.close();
	}
});

test("真实SQLite结果用于回答，回答阶段失败仍保留完整表格", async () => {
	const env = await setup({
		json: async (role) => {
			if (role === "answer") throw new Error("受控模型故障");
			return countPlan;
		},
	});
	try {
		const task = await settled(
			env.runtime,
			await env.runtime.enqueue({
				conversationId: "one",
				requestId: "one",
				question: "65岁及以上人数",
				context: { source_id: "hospital-a" },
			}),
		);
		assert.equal(task.status, "failed");
		const payload = task.result as { result: { rows: number[][]; complete: boolean }; answer_status: string };
		assert.deepEqual(payload.result.rows, [[3]]);
		assert.equal(payload.result.complete, true);
		assert.equal(payload.answer_status, "failed");
	} finally {
		await env.close();
	}
});
test("业务追问不执行SQL或调用回答模型，补充后同一任务续跑", async () => {
	let calls = 0;
	const env = await setup({
		json: async (role, prompt, input, _signal, receipts, _priority, onStart) => {
			calls++;
			const output =
				calls === 1
					? { action: "clarify", question: "按哪个年龄范围统计？", slots: ["患者年龄范围"], options: ["65岁及以上"] }
					: role === "answer"
						? { facts: [{ row: 0, column: "count" }] }
						: countPlan;
			// 每段记录独立的原始输出；追问恢复后调用卡片保留原文，用量摘要不能重复保存。
			receipts.push({
				id: `fake-call-${calls}`,
				system_prompt: prompt,
				user_prompt: JSON.stringify(input),
				output_text: JSON.stringify(output),
				role,
				model: "fake",
				queue_ms: 0,
				duration_ms: 1,
				input_tokens: 2,
				output_tokens: 3,
				cost: null,
				status: "completed",
			});
			await onStart?.();
			return output;
		},
	});
	let executions = 0;
	const original = env.domain.call.bind(env.domain);
	env.domain.call = async (...args) => {
		if (args[1] === "execute") executions++;
		return original(...args);
	};
	try {
		const first = await settled(
			env.runtime,
			await env.runtime.enqueue({
				conversationId: "two",
				requestId: "two",
				question: "统计患者人数",
				context: { source_id: "hospital-a" },
			}),
		);
		assert.equal(first.status, "waiting_for_user");
		assert.deepEqual(first.clarification!.slots, ["患者年龄范围"]);
		assert.equal(executions, 0);
		assert.equal(calls, 1);
		const firstTrace = first.progress as { model_calls: ModelReceipt[]; usage: ModelReceipt[] };
		assert.equal(firstTrace.model_calls.length, 1);
		assert.equal(JSON.parse(firstTrace.model_calls[0].output_text!).action, "clarify");
		assert.equal(Object.hasOwn(firstTrace.usage[0], "output_text"), false);
		const second = await settled(
			env.runtime,
			await env.runtime.reply({
				turnId: first.id,
				submissionId: "reply",
				clarificationId: first.clarification!.id,
				revision: first.clarification!.revision,
				answer: "65岁及以上",
			}),
		);
		assert.equal(second.id, first.id);
		assert.equal(second.status, "completed");
		assert.equal(executions, 1);
		const finalTrace = second.result as { model_calls: ModelReceipt[]; usage: ModelReceipt[]; evidence: object };
		assert.equal(finalTrace.usage.length, 3);
		assert.equal(finalTrace.model_calls.length, 3);
		assert.equal(finalTrace.model_calls[0].output_text, firstTrace.model_calls[0].output_text);
		assert.deepEqual(JSON.parse(finalTrace.model_calls[1].output_text!), countPlan);
		assert.deepEqual(JSON.parse(finalTrace.model_calls[2].output_text!), { facts: [{ row: 0, column: "count" }] });
		assert.ok(finalTrace.usage.every((receipt) => !Object.hasOwn(receipt, "output_text")));
		assert.equal(JSON.stringify(finalTrace.evidence).includes("output_text"), false);
	} finally {
		await env.close();
	}
});
test("正常空集不修复不凑结果，编译失败最多修复一次", async () => {
	let calls = 0;
	const env = await setup({
		json: async () => {
			calls++;
			if (calls === 1) return { ...countPlan, dsl: { from: "patients", select: [{ field: "patients.missing" }] } };
			return {
				...countPlan,
				dsl: {
					from: "patients",
					select: [{ field: "patients.name" }],
					where: [{ field: "patients.age", op: "gt", value: 150 }],
				},
			};
		},
	});
	try {
		const task = await settled(
			env.runtime,
			await env.runtime.enqueue({
				conversationId: "three",
				requestId: "three",
				question: "年龄超过150岁的姓名",
				context: { source_id: "hospital-a" },
			}),
		);
		assert.equal(task.status, "completed");
		assert.equal(calls, 2);
		assert.deepEqual((task.result as { result: { rows: unknown[] } }).result.rows, []);
	} finally {
		await env.close();
	}
});
test("不存在的答案单元格不发布，已有数据保留", async () => {
	const env = await setup({
		json: async (role) => (role === "answer" ? { facts: [{ row: 999, column: "count" }] } : countPlan),
	});
	try {
		const task = await settled(
			env.runtime,
			await env.runtime.enqueue({
				conversationId: "four",
				requestId: "four",
				question: "65岁及以上人数",
				context: { source_id: "hospital-a" },
			}),
		);
		assert.equal(task.status, "failed");
		assert.deepEqual((task.result as { result: { rows: unknown[] } }).result.rows, [[3]]);
	} finally {
		await env.close();
	}
});

// 两种修复策略只有纠错证据不同，均使用同样执行与预算；修复失败的原候选不能覆盖掉。
for (const policy of ["targeted", "ordinary_retry"]) {
	test(`${policy}编译修复遵循同预算且不混用定向诊断`, async () => {
		const inputs: Record<string, unknown>[] = [];
		const env = await setup({
			json: async (role, _prompt, input) => {
				if (role === "answer") return { facts: [] };
				inputs.push(input as Record<string, unknown>);
				return inputs.length === 1
					? { ...countPlan, dsl: { ...countPlan.dsl, select: [{ field: "patients.missing" }] } }
					: countPlan;
			},
		});
		try {
			const task = await settled(
				env.runtime,
				await env.runtime.enqueue({
					conversationId: policy,
					requestId: "one",
					question: "65岁及以上人数",
					context: { source_id: "hospital-a", repair_policy: policy },
				}),
			);
			assert.equal(task.status, "completed");
			assert.equal(task.budget!.repairs, 1);
			assert.equal(task.budget!.sqlExecutions, 2);
			assert.equal(JSON.stringify(inputs[1].correction).includes("patients.missing"), policy === "targeted");
			const payload = task.result as {
				repairs: {
					revalidated: boolean;
					protected_constraints_preserved: boolean;
					before_artifact_hash: string;
					after_artifact_hash: string;
				}[];
			};
			assert.equal(payload.repairs[0].revalidated, true);
			assert.equal(payload.repairs[0].protected_constraints_preserved, true);
			assert.notEqual(payload.repairs[0].before_artifact_hash, payload.repairs[0].after_artifact_hash);
		} finally {
			await env.close();
		}
	});
}

test("答案引用修复只重试答案，完整计算不重放", async () => {
	let answers = 0,
		executions = 0;
	const env = await setup({
		json: async (role) =>
			role === "answer" ? { facts: [{ row: ++answers === 1 ? 999 : 0, column: "count" }] } : countPlan,
	});
	const original = env.domain.call.bind(env.domain);
	env.domain.call = async (...args) => {
		if (args[1] === "execute") executions++;
		return original(...args);
	};
	try {
		const task = await settled(
			env.runtime,
			await env.runtime.enqueue({
				conversationId: "answer",
				requestId: "one",
				question: "65岁及以上人数",
				context: { source_id: "hospital-a" },
			}),
		);
		assert.equal(task.status, "completed");
		assert.equal(executions, 1);
		assert.equal(answers, 2);
		assert.equal(task.budget!.answerRepairs, 1);
		assert.equal(task.budget!.repairs, 1);
		const payload = task.result as {
			publication: { answer: string };
			stages: { kind: string; status: string; data?: { candidate?: unknown } }[];
		};
		assert.match(payload.publication.answer, /count：3/);
		assert.deepEqual(
			payload.stages.find((stage) => stage.kind === "answer" && stage.status === "failed")!.data!.candidate,
			{ facts: [{ row: 999, column: "count" }] },
		);
	} finally {
		await env.close();
	}
});

test("冻结数据源执行不回退当前注册表", async () => {
	const env = await setup({ json: async (role) => (role === "answer" ? { facts: [] } : countPlan) });
	try {
		const source = await env.domain.source("hospital-a"),
			version = await env.domain.fingerprint(source);
		env.domain.source = async () => {
			throw new Error("不得读取变化的当前注册表");
		};
		const task = await settled(
			env.runtime,
			await env.runtime.enqueue({
				conversationId: "snapshot",
				requestId: "one",
				question: "65岁及以上人数",
				context: { source_id: source.id, source_snapshot: source, source_version: version },
			}),
		);
		assert.equal(task.status, "completed");
		assert.equal((task.result as { publication: { source_version: string } }).publication.source_version, version);
	} finally {
		await env.close();
	}
});

// 同一批真实SQLite行分别验证完整交付和结果预算失败；预览上限不能冒充完整数据上限。
for (const maxRows of [5000, 200])
	test(`301行真实结果在预算${maxRows}下执行与发布`, async () => {
		const plan = {
			action: "query",
			dsl: { from: "patients", select: [{ field: "patients.patient_id" }] },
			linking: { tables: ["patients"], fields: ["patients.patient_id"] },
			conditions: [],
		};
		const env = await setup(
			{ json: async (role) => (role === "answer" ? { facts: [] } : plan) },
			{ resultMaxRows: maxRows },
		);
		try {
			const source = await env.domain.source("hospital-a"),
				db = new DatabaseSync(source.path);
			try {
				const row = db.prepare("SELECT * FROM patients LIMIT 1").get()!;
				const columns = Object.keys(row);
				const existing = Number(db.prepare("SELECT COUNT(*) AS n FROM patients").get()!.n);
				const insert = db.prepare(
					`INSERT INTO patients (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
				);
				for (let index = 0; index < 301 - existing; index++)
					insert.run(...columns.map((column) => (column === "patient_id" ? `ADDED_${index}` : row[column])));
			} finally {
				db.close();
			}
			const task = await settled(
				env.runtime,
				await env.runtime.enqueue({
					conversationId: "full",
					requestId: "one",
					question: "列出患者编号",
					context: { source_id: source.id },
				}),
			);
			if (maxRows === 200) {
				assert.equal(task.status, "failed");
				assert.equal((task.progress as { publication?: unknown }).publication, undefined);
				assert.match(task.error!.message, /不完整/);
			} else {
				assert.equal(task.status, "completed");
				const publication = (
					task.result as {
						publication: {
							result: { rows: unknown[]; preview_rows: unknown[]; complete: boolean; result_content_hash: string };
							validation: { result_content_hash: string };
						};
					}
				).publication;
				assert.equal(publication.result.rows.length, 301);
				assert.equal(publication.result.preview_rows.length, 200);
				assert.equal(publication.result.complete, true);
				assert.equal(publication.validation.result_content_hash, publication.result.result_content_hash);
			}
		} finally {
			await env.close();
		}
	});

// 错误物理字段可纠正，但同一次修复不得借机删去用户的过滤值。
for (const remove of [false, true])
	test(`不存在的过滤字段修复${remove ? "删除条件时拒绝" : "保留取值时允许"}`, async () => {
		let decisions = 0;
		const env = await setup({
			json: async (role) => {
				if (role === "answer") return { facts: [] };
				decisions++;
				if (decisions === 1)
					return {
						...countPlan,
						dsl: { ...countPlan.dsl, where: [{ field: "patients.missing_age", op: "gte", value: 65 }] },
					};
				return { ...countPlan, dsl: { ...countPlan.dsl, where: remove ? [] : countPlan.dsl.where } };
			},
		});
		try {
			const task = await settled(
				env.runtime,
				await env.runtime.enqueue({
					conversationId: "filter",
					requestId: "one",
					question: "65岁及以上人数",
					context: { source_id: "hospital-a" },
				}),
			);
			assert.equal(task.status, remove ? "failed" : "completed");
			assert.equal(task.budget!.sqlExecutions, remove ? 1 : 2);
			if (remove) assert.equal((task.progress as { publication?: unknown }).publication, undefined);
		} finally {
			await env.close();
		}
	});

// 空值谓词没有操作数；修复只可删除冗余 null，原候选和编译失败仍必须完整留证。
for (const op of ["is_null", "is_not_null"])
	for (const policy of ["targeted", "ordinary_retry"])
		test(`${policy}允许${op}删除冗余null操作数，保留首次失败和其他条件`, async () => {
			let decisions = 0;
			const before = { field: "patients.name", op, value: null };
			const after = { field: "patients.name", op };
			const env = await setup({
				json: async (role) => {
					if (role === "answer") return { facts: [] };
					return {
						...countPlan,
						dsl: { ...countPlan.dsl, where: [...countPlan.dsl.where, ++decisions === 1 ? before : after] },
					};
				},
			});
			try {
				const task = await settled(
					env.runtime,
					await env.runtime.enqueue({
						conversationId: "null-repair",
						requestId: "one",
						question: "统计65岁及以上患者姓名是否为空的人数",
						context: { source_id: "hospital-a", repair_policy: policy },
					}),
				);
				assert.equal(task.status, "completed");
				assert.equal(decisions, 2);
				assert.equal(task.budget!.sqlExecutions, 2);
				assert.equal(task.budget!.repairs, 1);
				const payload = task.result as {
					stages: { kind: string; status: string; error?: string; data: { dsl: { where: unknown[] } } }[];
					repairs: { protected_constraints_preserved: boolean; revalidated: boolean }[];
				};
				const executions = payload.stages.filter((stage) => stage.kind === "execution");
				assert.equal(executions[0].status, "failed");
				assert.match(executions[0].error!, /空值判断不接受\s*value/);
				assert.deepEqual(executions[0].data.dsl.where, [...countPlan.dsl.where, before]);
				assert.deepEqual(executions[1].data.dsl.where, [...countPlan.dsl.where, after]);
				assert.equal(payload.repairs[0].protected_constraints_preserved, true);
				assert.equal(payload.repairs[0].revalidated, true);
			} finally {
				await env.close();
			}
		});

for (const scenario of [
	{ name: "改变字段", after: [{ field: "patients.patient_id", op: "is_null" }] },
	{ name: "改变空值方向", after: [{ field: "patients.name", op: "is_not_null" }] },
	{ name: "删除整个条件", after: [] },
	{ name: "改变其他取值", after: [{ field: "patients.name", op: "is_null" }], age: 64 },
	{ name: "删除非null操作数", after: [{ field: "patients.name", op: "is_null" }], originalValue: 0 },
])
	test(`空值语法修复不得${scenario.name}`, async () => {
		let decisions = 0;
		const env = await setup({
			json: async (role) => {
				if (role === "answer") throw new Error("拒绝的候选不能进入答案生成");
				return {
					...countPlan,
					dsl: {
						...countPlan.dsl,
						where:
							++decisions === 1
								? [
										...countPlan.dsl.where,
										{ field: "patients.name", op: "is_null", value: scenario.originalValue ?? null },
									]
								: [{ ...countPlan.dsl.where[0], value: scenario.age ?? 65 }, ...scenario.after],
					},
				};
			},
		});
		try {
			const task = await settled(
				env.runtime,
				await env.runtime.enqueue({
					conversationId: "null-constraint",
					requestId: "one",
					question: "统计65岁及以上姓名为空的患者人数",
					context: { source_id: "hospital-a" },
				}),
			);
			assert.equal(task.status, "failed");
			assert.match(task.error!.message, /删除或改变/);
			assert.equal(task.budget!.sqlExecutions, 1);
			assert.equal((task.progress as { publication?: unknown }).publication, undefined);
		} finally {
			await env.close();
		}
	});
