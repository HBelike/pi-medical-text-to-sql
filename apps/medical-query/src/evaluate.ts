import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Application, publicTurn } from "./application.ts";
import { APP_ROOT, readConfig } from "./config.ts";
import { DomainService } from "./domain.ts";
import { runEvaluationCli } from "./evaluation/cli.ts";
import { PIPELINE_SIGNATURE } from "./pipeline.ts";
import { acquireRuntimeLock } from "./runtime-lock.ts";

type ExpectedAction = "answer" | "clarify" | "abstain";
type EvalCase = {
	id: string;
	source_id: string;
	question: string;
	expected_action: ExpectedAction;
	expected_rows?: unknown[][];
	required_tables?: string[];
	required_fields?: string[];
	as_of?: string;
};
type CliOptions = { concurrency: 1 | 5 | 10; limit: number; output?: string; help: boolean; standalone: boolean };
type EvalTurn = {
	id: string;
	status: string;
	result?: unknown;
	evidence?: unknown;
	usage?: unknown;
	answer?: unknown;
	error?: string;
	run_queue_ms?: number | null;
};
type QueryInput = {
	conversation_id: string;
	source_id: string;
	question: string;
	request_id: string;
	mode: "eval";
	as_of: string;
};
type EvalClient = {
	query(input: QueryInput): Promise<EvalTurn>;
	get(id: string): Promise<EvalTurn>;
	cancel(id: string): Promise<EvalTurn>;
	status(): Promise<Record<string, unknown>>;
};
type UsageItem = {
	role: string;
	model: string;
	status: string;
	input_tokens: number | null;
	output_tokens: number | null;
	queue_ms: number | null;
	duration_ms: number | null;
	cost: number | null;
};
type CaseResult = {
	id: string;
	source_id: string;
	question: string;
	expected_action: ExpectedAction;
	actual_action: string;
	status: string;
	passed: boolean;
	action_match: boolean;
	rows_match: boolean | null;
	expected_rows?: unknown[][];
	actual_rows?: unknown[][];
	result_complete: boolean | null;
	duration_ms: number;
	run_queue_ms: number | null;
	usage: UsageItem[];
	usage_complete: boolean;
	error?: string;
	turn_id?: string;
	answer?: unknown;
	linking?: Record<string, unknown>;
	public_turn?: EvalTurn;
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// CLI 明确限制付费评测规模，默认只跑三题，只有显式 --limit 0 才选择全题。
export function parseArgs(args: string[]): CliOptions {
	const result: CliOptions = { concurrency: 1, limit: 3, help: false, standalone: false };
	for (let index = 0; index < args.length; index++) {
		const name = args[index];
		if (name === "--help" || name === "-h") {
			result.help = true;
			continue;
		}
		if (name === "--standalone") {
			result.standalone = true;
			continue;
		}
		if (!["--concurrency", "--limit", "--output"].includes(name)) throw new Error(`未知参数：${name}`);
		const value = args[++index];
		if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数值`);
		if (name === "--output") {
			result.output = resolve(value);
			continue;
		}
		if (!/^\d+$/.test(value)) throw new Error(`${name} 必须是非负整数`);
		const integer = Number(value);
		if (!Number.isSafeInteger(integer)) throw new Error(`${name} 超过整数范围`);
		if (name === "--concurrency") {
			if (integer !== 1 && integer !== 5 && integer !== 10) throw new Error("并发只支持 1、5 或 10");
			result.concurrency = integer;
		} else result.limit = integer;
	}
	return result;
}

function loadCases(raw: string): EvalCase[] {
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) throw new Error("评测用例必须是数组");
	const ids = new Set<string>();
	return parsed.map((entry) => {
		const item = record(entry);
		if (
			!item ||
			typeof item.id !== "string" ||
			!item.id ||
			ids.has(item.id) ||
			typeof item.source_id !== "string" ||
			typeof item.question !== "string" ||
			!item.question.trim() ||
			!["answer", "clarify", "abstain"].includes(String(item.expected_action))
		) {
			throw new Error("评测样本缺少必要字段、行动错误或 ID 重复");
		}
		ids.add(item.id);
		if (
			item.expected_action === "answer" &&
			(!Array.isArray(item.expected_rows) || !item.expected_rows.every(Array.isArray))
		) {
			throw new Error(`${item.id} 缺少合法结果 gold，不能计为通过`);
		}
		return {
			id: item.id,
			source_id: item.source_id,
			question: item.question,
			expected_action: item.expected_action as ExpectedAction,
			...(Array.isArray(item.expected_rows) ? { expected_rows: item.expected_rows as unknown[][] } : {}),
			required_tables: strings(item.required_tables),
			required_fields: strings(item.required_fields),
			...(typeof item.as_of === "string" ? { as_of: item.as_of } : {}),
		};
	});
}

// 结果按带类型的行多重集比较：保留重复、NULL 和列位置，不要求 SQL 或列别名相同。
export function typedRowsEqual(actual: unknown, expected: unknown[][]): boolean {
	if (!Array.isArray(actual) || !actual.every(Array.isArray)) return false;
	const left = actual.map((row) => JSON.stringify(row)).sort();
	const right = expected.map((row) => JSON.stringify(row)).sort();
	return left.length === right.length && left.every((row, index) => row === right[index]);
}

// 服务可以登记额外来源，但本轮每个冻结来源的身份和内容指纹必须一致。
export function sameSourceVersions(expected: { id: string; fingerprint: string }[], actual: unknown): boolean {
	if (!Array.isArray(actual)) return false;
	return expected.every(
		(source) =>
			actual.filter((entry) => record(entry)?.id === source.id).length === 1 &&
			actual.some((entry) => record(entry)?.id === source.id && record(entry)?.fingerprint === source.fingerprint),
	);
}

function linkingDiagnostics(view: EvalTurn, sample: EvalCase): Record<string, unknown> {
	const evidence = record(view.evidence);
	const declared = record(evidence?.linking) || evidence || {};
	const dsl = record(evidence?.dsl);
	const fields = new Set<string>();
	for (const key of ["select", "where", "order_by"]) {
		const entries = dsl?.[key];
		if (!Array.isArray(entries)) continue;
		for (const item of entries) {
			const field = record(item)?.field;
			if (typeof field === "string" && field.includes(".")) fields.add(field);
		}
	}
	for (const field of strings(dsl?.group_by)) fields.add(field);
	const tables = new Set([...fields].map((field) => field.slice(0, field.lastIndexOf("."))));
	if (typeof dsl?.from === "string") tables.add(dsl.from);
	const requiredTables = sample.required_tables || [];
	const requiredFields = sample.required_fields || [];
	return {
		declared_tables: strings(declared.tables),
		declared_qualified_fields: strings(declared.fields),
		declared_relations: strings(declared.relations),
		plan_tables_visible_in_references: [...tables].sort(),
		plan_qualified_fields: [...fields].sort(),
		exact_required_tables_present: requiredTables.filter((table) => tables.has(table)),
		exact_required_fields_present: requiredFields.filter((field) => fields.has(field)),
		missing_exact_tables: requiredTables.filter((table) => !tables.has(table)),
		missing_exact_fields: requiredFields.filter((field) => !fields.has(field)),
		diagnostic_only: true,
		note: "限定身份精确命中仅作诊断。当前 gold 未完整列出等价映射；例如直接对就诊患者键去重可省略患者表，不能因路径不同否决正确结果。结果匹配仍不能单独证明所有医学语义正确。",
	};
}

function usages(value: unknown): UsageItem[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const usage = record(item);
		if (!usage) return [];
		return [
			{
				role: String(usage.role || "unknown"),
				model: String(usage.model || "unknown"),
				status: String(usage.status || "unknown"),
				input_tokens: numberOrNull(usage.input_tokens),
				output_tokens: numberOrNull(usage.output_tokens),
				queue_ms: numberOrNull(usage.queue_ms),
				duration_ms: numberOrNull(usage.duration_ms),
				cost: numberOrNull(usage.cost),
			},
		];
	});
}

// 默认经同一 HTTP 服务提交评测，在线和评测共享服务进程中的运行与模型额度。
export function createHttpClient(baseUrl: string, request: typeof fetch = fetch): EvalClient {
	const call = async (path: string, payload?: unknown): Promise<Record<string, unknown>> => {
		const response = await request(new URL(path, baseUrl), {
			method: payload === undefined ? "GET" : "POST",
			headers: { "Content-Type": "application/json" },
			...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
			signal: AbortSignal.timeout(30_000),
		});
		const data = record(await response.json());
		if (!response.ok || !data)
			throw new Error(typeof data?.error === "string" ? data.error : `评测服务请求失败（${response.status}）`);
		return data;
	};
	const turn = (data: Record<string, unknown>): EvalTurn => {
		if (typeof data.id !== "string" || typeof data.status !== "string") throw new Error("评测服务返回无效任务");
		const queued = numberOrNull(data.queued_at),
			started = numberOrNull(data.run_started_at);
		return {
			...data,
			id: data.id,
			status: data.status,
			run_queue_ms: queued !== null && started !== null ? started - queued : null,
			...(typeof data.error === "string" ? { error: data.error } : {}),
		};
	};
	return {
		query: async (input) => turn(await call("/api/query", input)),
		get: async (id) => turn(await call(`/api/turns/${encodeURIComponent(id)}`)),
		cancel: async (id) => turn(await call(`/api/turns/${encodeURIComponent(id)}/cancel`, {})),
		status: () => call("/api/status?sources=1"),
	};
}

async function evaluateCase(
	client: EvalClient,
	sample: EvalCase,
	runId: string,
	timeoutMs: number,
): Promise<CaseResult> {
	const started = Date.now();
	let current: EvalTurn | undefined;
	let timedOut = false;
	try {
		// 只把问题和正常运行上下文交给产品；标准答案、正确表列均留在评测器。
		current = await client.query({
			conversation_id: `eval-${runId}-${sample.id}`,
			source_id: sample.source_id,
			question: sample.question,
			request_id: randomUUID(),
			mode: "eval",
			as_of: sample.as_of || "2026-10-15T12:00:00+08:00",
		});
		const deadline = started + timeoutMs;
		while (current.status === "queued" || current.status === "running") {
			if (Date.now() > deadline) {
				timedOut = true;
				// 等待真实取消结果后再释放评测 worker，超时样本保留在分母中。
				current = await client.cancel(current.id);
				break;
			}
			await delay(200);
			current = await client.get(current.id);
			if (!current) throw new Error("评测运行状态丢失");
		}
		const view = current;
		const actualAction = timedOut
			? "report_failure"
			: current.status === "completed"
				? "answer"
				: current.status === "waiting_for_user"
					? "clarify"
					: current.status === "blocked"
						? "abstain"
						: "report_failure";
		const result = record(view.result);
		const rawRows = result?.rows;
		const actualRows = Array.isArray(rawRows) && rawRows.every(Array.isArray) ? (rawRows as unknown[][]) : undefined;
		const rowsMatch =
			sample.expected_action === "answer" ? typedRowsEqual(actualRows, sample.expected_rows || []) : null;
		const complete = typeof result?.complete === "boolean" ? result.complete : null;
		const actionMatch = actualAction === sample.expected_action;
		const usage = usages(view.usage);
		return {
			id: sample.id,
			source_id: sample.source_id,
			question: sample.question,
			expected_action: sample.expected_action,
			actual_action: actualAction,
			status: current.status,
			action_match: actionMatch,
			rows_match: rowsMatch,
			passed: actionMatch && (sample.expected_action !== "answer" || (rowsMatch === true && complete === true)),
			...(sample.expected_rows ? { expected_rows: sample.expected_rows } : {}),
			...(actualRows ? { actual_rows: actualRows } : {}),
			result_complete: complete,
			duration_ms: Date.now() - started,
			run_queue_ms: current.run_queue_ms ?? null,
			usage,
			usage_complete: usage.length > 0 && ["completed", "blocked", "waiting_for_user"].includes(current.status),
			...(timedOut ? { error: "评测等待超时，已请求取消，按失败保留" } : view.error ? { error: view.error } : {}),
			turn_id: current.id,
			answer: view.answer,
			linking: linkingDiagnostics(view, sample),
			public_turn: view,
		};
	} catch (error) {
		return {
			id: sample.id,
			source_id: sample.source_id,
			question: sample.question,
			expected_action: sample.expected_action,
			actual_action: "report_failure",
			status: "failed",
			passed: false,
			action_match: false,
			rows_match: sample.expected_action === "answer" ? false : null,
			result_complete: null,
			duration_ms: Date.now() - started,
			run_queue_ms: null,
			usage: [],
			usage_complete: false,
			...(current ? { turn_id: current.id } : {}),
			error: error instanceof Error ? error.message : "评测执行失败",
		};
	}
}

function percentile(values: number[], percent: number): number | null {
	if (values.length === 0) return null;
	const ordered = [...values].sort((a, b) => a - b);
	return ordered[Math.max(0, Math.ceil(percent * ordered.length) - 1)];
}

export async function evaluate(options: CliOptions): Promise<string> {
	const concurrency = String(options.concurrency);
	const originalConfig = readConfig(
		options.standalone
			? { PI_MAX_ACTIVE_RUNS: concurrency, PI_LLM_MAX_CONCURRENCY: concurrency, PI_EVAL_MAX_ACTIVE_RUNS: concurrency }
			: {},
	);
	const rawCases = await readFile(resolve(APP_ROOT, "fixtures/cases.json"), "utf8");
	const allCases = loadCases(rawCases);
	const selected = options.limit === 0 ? allCases : allCases.slice(0, options.limit);
	if (selected.length === 0) throw new Error("没有可执行的评测用例");
	const sourceLoader = new DomainService(originalConfig);
	const sources = await sourceLoader.sources();
	if (selected.some((sample) => !sources.some((source) => source.id === sample.source_id)))
		throw new Error("用例引用的数据源未登记，请先生成夹具");
	const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
	const reportsDir = resolve(originalConfig.dataDir, "evaluations");
	await mkdir(reportsDir, { recursive: true });
	let dataDir: string | null = null;
	const sourceVersions = await Promise.all(
		sources.map(async (source) => ({ id: source.id, fingerprint: await sourceLoader.fingerprint(source) })),
	);
	const outputPath = options.output || resolve(reportsDir, `${runId}.json`);
	await mkdir(dirname(outputPath), { recursive: true });
	// 拒绝覆盖旧报告，运行前先留下最小状态，异常不会被冒充为完整测量。
	await writeFile(
		outputPath,
		`${JSON.stringify(
			{
				run_id: runId,
				status: "running",
				pipeline_signature: options.standalone ? PIPELINE_SIGNATURE : null,
				selected_ids: selected.map((sample) => sample.id),
				data_dir: dataDir,
			},
			null,
			2,
		)}\n`,
		{ flag: "wx" },
	);
	const started = Date.now();
	const results = new Array<CaseResult>(selected.length);
	let application: Application | undefined;
	let releaseOwner: (() => void) | undefined;
	let pipelineSignature: unknown = options.standalone ? PIPELINE_SIGNATURE : null;
	try {
		let client: EvalClient;
		if (options.standalone) {
			// 基线虽然使用独立会话库，也先占有主服务的锁，禁止另起模型池叠加额度。
			releaseOwner = acquireRuntimeLock(resolve(originalConfig.dataDir, "runtime.sqlite"));
			dataDir = await mkdtemp(resolve(reportsDir, `runtime-${runId}-`));
			await writeFile(resolve(dataDir, "sources.json"), `${JSON.stringify(sources, null, 2)}\n`);
			const app = await Application.open({ ...originalConfig, dataDir });
			application = app;
			client = {
				query: async (input) => publicTurn(await app.query(input)),
				get: async (id) => {
					const task = await app.runtime.get(id);
					if (!task) throw new Error("评测运行状态丢失");
					return {
						...publicTurn(task),
						run_queue_ms: task.runStartedAt === undefined ? null : task.runStartedAt - task.queuedAt,
					};
				},
				cancel: async (id) => publicTurn(await app.runtime.cancel(id)),
				status: async () => ({
					pipeline_signature: PIPELINE_SIGNATURE,
					model: originalConfig.decisionModel,
					answer_model: originalConfig.answerModel,
					source_versions: await Promise.all(
						sources.map(async (source) => ({ id: source.id, fingerprint: await sourceLoader.fingerprint(source) })),
					),
					limits: {
						active_runs: originalConfig.maxActiveRuns,
						llm: originalConfig.llmMaxConcurrency,
						eval: originalConfig.evalMaxActiveRuns,
					},
					queue_wait_timeout_ms: originalConfig.queueWaitTimeoutMs,
					run_timeout_ms: originalConfig.runTimeoutMs,
					llm_timeout_ms: originalConfig.llmTimeoutMs,
					stats: {
						runtime: await app.runtime.stats(),
						llm: app.models.pool.stats(),
						database: app.domain.pool.stats(),
					},
				}),
			};
		} else client = createHttpClient(`http://127.0.0.1:${originalConfig.port}`);
		const initialStatus = await client.status();
		const selectedVersions = sourceVersions.filter((source) =>
			selected.some((sample) => sample.source_id === source.id),
		);
		if (!sameSourceVersions(selectedVersions, initialStatus.source_versions))
			throw new Error("服务数据源版本与本地冻结评测来源不一致，未提交题目");
		const actualLimits = record(initialStatus.limits) || {};
		pipelineSignature = initialStatus.pipeline_signature ?? null;
		const queueWaitMs = numberOrNull(initialStatus.queue_wait_timeout_ms);
		const runTimeoutMs = numberOrNull(initialStatus.run_timeout_ms);
		if (queueWaitMs === null || runTimeoutMs === null || typeof pipelineSignature !== "string")
			throw new Error("服务缺少评测配置或版本信息，请更新并重启服务");
		let next = 0;
		// worker 完成一题再领取下一题，避免一次创建全量请求或绕过应用共享额度。
		await Promise.all(
			Array.from({ length: Math.min(options.concurrency, selected.length) }, async () => {
				while (next < selected.length) {
					const index = next++;
					results[index] = await evaluateCase(client, selected[index], runId, queueWaitMs + runTimeoutMs + 10_000);
				}
			}),
		);
		const totalMs = Date.now() - started;
		const finalStatus = await client.status();
		const processStats = record(finalStatus.stats) || {};
		const runtime = record(processStats.runtime) || {};
		const llm = record(processStats.llm) || {};
		const database = record(processStats.database) || {};
		const afterVersions = await Promise.all(
			sources.map(async (source) => ({ id: source.id, fingerprint: await sourceLoader.fingerprint(source) })),
		);
		const stableSources =
			JSON.stringify(afterVersions) === JSON.stringify(sourceVersions) &&
			sameSourceVersions(selectedVersions, finalStatus.source_versions) &&
			finalStatus.pipeline_signature === pipelineSignature;
		const passed = results.filter((item) => item.passed).length;
		const answerable = results.filter((item) => item.expected_action === "answer");
		const nonAnswerable = results.filter((item) => item.expected_action !== "answer");
		const receipts = results.flatMap((item) => item.usage);
		const inputKnown =
			receipts.every((item) => item.input_tokens !== null) && results.every((item) => item.usage_complete);
		const outputKnown =
			receipts.every((item) => item.output_tokens !== null) && results.every((item) => item.usage_complete);
		const costKnown = receipts.every((item) => item.cost !== null) && results.every((item) => item.usage_complete);
		const totalCost = costKnown ? receipts.reduce((total, item) => total + (item.cost || 0), 0) : null;
		const ratio = (numerator: number, denominator: number) => ({
			numerator,
			denominator,
			value: denominator > 0 ? numerator / denominator : null,
		});
		const report = {
			run_id: runId,
			status: stableSources ? "completed" : "invalid_snapshot",
			created_at: new Date(started).toISOString(),
			// 提示词变更会生成不同签名，比较 1/5/10 并发时可核对同一版本。
			pipeline_signature: pipelineSignature,
			execution_mode: options.standalone ? "standalone_exclusive" : "shared_http_service",
			kind: "real_model_on_synthetic_sqlite",
			dataset_hash: createHash("sha256").update(rawCases).digest("hex"),
			selected_ids: selected.map((sample) => sample.id),
			case_count: selected.length,
			data_dir: dataDir,
			source_versions: sourceVersions,
			service_source_versions: initialStatus.source_versions,
			sources_unchanged: stableSources,
			configuration: {
				concurrency: options.concurrency,
				requested_concurrency: options.concurrency,
				max_active_runs: actualLimits.active_runs,
				llm_max_concurrency: actualLimits.llm,
				eval_max_active_runs: actualLimits.eval,
				decision_model: initialStatus.model,
				answer_model: initialStatus.answer_model,
				queue_wait_timeout_ms: queueWaitMs,
				run_timeout_ms: runTimeoutMs,
				llm_timeout_ms: initialStatus.llm_timeout_ms,
			},
			quality: {
				action_and_result_success: ratio(passed, results.length),
				answerable_correct_delivery: ratio(answerable.filter((item) => item.passed).length, answerable.length),
				answer_coverage: ratio(results.filter((item) => item.actual_action === "answer").length, results.length),
				nonanswerable_wrong_answer: ratio(
					nonAnswerable.filter((item) => item.actual_action === "answer").length,
					nonAnswerable.length,
				),
			},
			performance: {
				total_ms: totalMs,
				tasks_per_second: totalMs > 0 ? (results.length * 1000) / totalMs : null,
				all_task_p50_ms: percentile(
					results.map((item) => item.duration_ms),
					0.5,
				),
				all_task_p95_ms: percentile(
					results.map((item) => item.duration_ms),
					0.95,
				),
				success_task_p50_ms: percentile(
					results.filter((item) => item.passed).map((item) => item.duration_ms),
					0.5,
				),
				success_task_p95_ms: percentile(
					results.filter((item) => item.passed).map((item) => item.duration_ms),
					0.95,
				),
				run_queue_p95_ms: percentile(
					results.flatMap((item) => (item.run_queue_ms === null ? [] : [item.run_queue_ms])),
					0.95,
				),
				llm_queue_p95_ms: percentile(
					receipts.flatMap((item) => (item.queue_ms === null ? [] : [item.queue_ms])),
					0.95,
				),
				active_runs_peak: options.standalone ? runtime.peakActive : null,
				llm_requests_peak: options.standalone ? llm.peak : null,
				database_calls_peak: options.standalone ? database.peak : null,
				peak_scope: options.standalone ? "本轮独占实例" : "共享服务累计峰值不能归为本轮，故本轮峰值为 null",
				process_cumulative_stats: processStats,
			},
			usage: {
				known_calls: receipts.length,
				failed_or_cancelled_calls: receipts.filter((item) => item.status !== "completed").length,
				usage_complete: results.every((item) => item.usage_complete),
				input_tokens: inputKnown ? receipts.reduce((total, item) => total + (item.input_tokens || 0), 0) : null,
				output_tokens: outputKnown ? receipts.reduce((total, item) => total + (item.output_tokens || 0), 0) : null,
				cost: totalCost,
				cost_per_success_task: totalCost !== null && passed > 0 ? totalCost / passed : null,
				cost_note: "网关未提供可确认价格时记 null；失败请求的缺失用量不补零。",
			},
			limits: [
				"仅报告本次合成夹具的行动和结果表现，不代表真实医院准确率或完整 P0 验收。",
				"未自动回答澄清；clarify 仅核对是否进入待答，问题语义与完整多轮完成仍需单独标注。",
				"当前结果比较为类型敏感的行多重集，未声明排名/列角色/数值容差 gold；不评价缺失的答案事实 gold。",
				"Linking 为精确限定身份诊断，缺失等价路径 gold 时不单独否决任务；单快照结果等价不能证明语义全部正确。",
				"快照改变时整份报告失效；不得用其中统计宣称稳定基准成绩。",
			],
			items: results,
		};
		await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
		console.log(
			JSON.stringify({
				output: outputPath,
				cases: selected.length,
				passed,
				snapshot_valid: stableSources,
				total_ms: totalMs,
				llm_peak: report.performance.llm_requests_peak,
				cost: report.usage.cost,
			}),
		);
		return outputPath;
	} catch (error) {
		await writeFile(
			outputPath,
			`${JSON.stringify(
				{
					run_id: runId,
					status: "failed",
					pipeline_signature: pipelineSignature,
					items: results.filter(Boolean),
					error: error instanceof Error ? error.message : "评测器失败",
					data_dir: dataDir,
				},
				null,
				2,
			)}\n`,
		);
		throw error;
	} finally {
		try {
			await application?.close();
		} finally {
			releaseOwner?.();
		}
	}
}

// 保留历史纯比较器和参数契约；可执行入口统一消费持久化实验 API，不再另启内存评测池。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		console.log(JSON.stringify(await runEvaluationCli(process.argv.slice(2)), null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "评测失败");
		process.exitCode = 1;
	}
}
