import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
type ExtendedSettings =
	| "installationLockPath"
	| "coordinatorStoragePath"
	| "onlineQueueReserve"
	| "sqlConcurrency"
	| "resultMaxRows"
	| "turnRepairLimit"
	| "turnModelCallLimit"
	| "retrievalStrategy"
	| "retrievalMaxContextChars"
	| "retrievalTopK"
	| "accountRpm"
	| "accountTpm"
	| "resourceScopeId";
export type AppConfig = Omit<ReturnType<typeof readConfig>, ExtendedSettings> &
	Partial<Pick<ReturnType<typeof readConfig>, ExtendedSettings>>;

// 渐进披露先读取少量业务表；旧策略保留原候选预算供同题对照。
export function defaultRetrievalTopK(strategy: string): number {
	return strategy === "progressive" ? 5 : 12;
}

// 所有入口共用一份校验后的配置，避免每个模型角色各自放大并发。
export function readConfig(overrides: Record<string, string | undefined> = {}) {
	const localPath = resolve(APP_ROOT, ".env.local");
	const local = existsSync(localPath) ? parseEnv(readFileSync(localPath, "utf8")) : {};
	const env = { ...local, ...process.env, ...overrides };
	const credentialPath = env.PI_CREDENTIALS_ENV_FILE;
	const inherited = credentialPath ? parseEnv(readFileSync(resolve(APP_ROOT, credentialPath), "utf8")) : {};
	const integer = (name: string, fallback: number, min: number, max: number): number => {
		const value = env[name] === undefined ? fallback : Number(env[name]);
		if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}～${max} 的整数`);
		return value;
	};
	const maxActiveRuns = integer("PI_MAX_ACTIVE_RUNS", 5, 1, 10);
	const maxPending = integer("PI_QUEUE_MAX_PENDING", 100, 1, 10000);
	const apiKey = env.PI_MODEL_API_KEY || inherited.LLM_API_KEY || env.DEEPSEEK_API_KEY || "";
	const baseUrl = env.PI_MODEL_BASE_URL || inherited.LLM_BASE_URL || "https://api.deepseek.com";
	const endpoint = new URL(baseUrl);
	if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search) {
		throw new Error("模型端点必须是无嵌入凭据的 HTTP(S) 地址");
	}
	const decisionModel = env.PI_DECISION_MODEL || inherited.LLM_FAST_MODEL || inherited.LLM_MODEL || "deepseek-chat";
	if (!decisionModel.toLowerCase().includes("deepseek")) throw new Error("本批决策模型必须使用 DeepSeek 系列");
	// 百表目录默认渐进披露；词法与完整目录作为显式对照，超预算不能静默裁切口径。
	const retrievalStrategy = env.PI_RETRIEVAL_STRATEGY ?? "progressive";
	if (retrievalStrategy !== "progressive" && retrievalStrategy !== "lexical" && retrievalStrategy !== "full_catalog")
		throw new Error("PI_RETRIEVAL_STRATEGY 必须是 progressive、lexical 或 full_catalog");
	return {
		apiKey,
		baseUrl,
		decisionModel,
		answerModel: env.PI_ANSWER_MODEL || decisionModel,
		maxActiveRuns,
		llmMaxConcurrency: integer("PI_LLM_MAX_CONCURRENCY", 5, 1, 10),
		evalMaxActiveRuns: integer("PI_EVAL_MAX_ACTIVE_RUNS", Math.min(5, maxActiveRuns), 1, maxActiveRuns),
		maxPending,
		// 安装级锁与实验数据目录无关，切换dataDir不能再领一份供应商额度。
		installationLockPath: resolve(APP_ROOT, ".local", "installation-coordinator"),
		coordinatorStoragePath: resolve(APP_ROOT, ".local", "runtime.sqlite"),
		onlineQueueReserve: integer("PI_ONLINE_QUEUE_RESERVE", Math.min(20, Math.floor(maxPending / 5)), 0, maxPending - 1),
		sqlConcurrency: integer("PI_SQL_CONCURRENCY", 2, 1, 10),
		resultMaxRows: integer("PI_RESULT_MAX_ROWS", 5000, 1, 100000),
		turnRepairLimit: integer("PI_TURN_REPAIR_LIMIT", 1, 0, 2),
		turnModelCallLimit: integer("PI_TURN_MODEL_CALL_LIMIT", 8, 1, 32),
		retrievalStrategy,
		retrievalMaxContextChars: integer("PI_RETRIEVAL_MAX_CONTEXT_CHARS", 256000, 1000, 1000000),
		retrievalTopK: integer("PI_RETRIEVAL_TOP_K", defaultRetrievalTopK(retrievalStrategy), 1, 100),
		resourceScopeId: env.PI_RESOURCE_SCOPE_ID || "primary-account",
		accountRpm: env.PI_ACCOUNT_RPM ? integer("PI_ACCOUNT_RPM", 1, 1, 1_000_000) : null,
		accountTpm: env.PI_ACCOUNT_TPM ? integer("PI_ACCOUNT_TPM", 1, 1, 100_000_000) : null,
		queueWaitTimeoutMs: integer("PI_QUEUE_WAIT_TIMEOUT_S", 300, 1, 3600) * 1000,
		llmTimeoutMs: integer("PI_LLM_REQUEST_TIMEOUT_S", 120, 1, 3600) * 1000,
		runTimeoutMs: integer("PI_RUN_TIMEOUT_S", 600, 1, 7200) * 1000,
		port: integer("PI_PORT", 8787, 1024, 65535),
		python: env.PI_PYTHON || "python3",
		dataDir: resolve(APP_ROOT, env.PI_DATA_DIR || ".local"),
	};
}
