import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type PublicQuestion = { id: string; source_id: string; question: string; as_of: string };
export type CheckProfile = "linking" | "result_only" | "task_complete";
export type ExpectedAction = "answer" | "clarify" | "blocked";
export type EvaluationCase = PublicQuestion & {
	id: string;
	track: string;
	family: string;
	split: "dev" | "holdout";
	expected_action: ExpectedAction;
	profile: CheckProfile;
	gold: Record<string, unknown>;
	coverage_gaps: string[];
};
export type DatasetVersion = {
	id: string;
	name: string;
	hash: string;
	schema_version: "evaluation-dataset/v1";
	version: string;
	cases: EvaluationCase[];
	manifest: Record<string, unknown>;
	logical_relations: unknown[];
	coverage: { total: number; tracks: Record<string, number>; families: number; profiles: Record<string, number> };
};

// 统一序列化用于内容身份，不依赖 JSON 属性插入顺序，拒绝不可复核的特殊数值。
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	throw new Error("invalid_dataset：必须使用有限 JSON 值");
}

export function contentHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// 冻结输入快照和所有嵌套 gold；重评只能产生新对象，不能原地改旧标准答案。
export function immutable<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) immutable(child);
		Object.freeze(value);
	}
	return value;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`invalid_dataset：${label} 不能为空`);
	return value;
}

function jsonLines(raw: string, label: string): Record<string, unknown>[] {
	const entries = raw.split(/\r?\n/).filter((line) => line.trim());
	if (!entries.length) throw new Error(`invalid_dataset：${label} 为空`);
	return entries.map((line, index) => {
		const item: unknown = JSON.parse(line);
		if (!item || typeof item !== "object" || Array.isArray(item))
			throw new Error(`invalid_dataset：${label} 第 ${index + 1} 行不是对象`);
		canonicalJson(item);
		return item as Record<string, unknown>;
	});
}

function stringList(value: unknown, label: string): string[] {
	if (
		!Array.isArray(value) ||
		value.some((entry) => typeof entry !== "string") ||
		new Set(value).size !== value.length
	) {
		throw new Error(`invalid_gold：${label} 必须为无重复字符串数组`);
	}
	return value as string[];
}

export type ComparisonContractV2 = {
	version: "comparison/v2";
	mode: "exact" | "declared_aliases" | "single_value";
	columns: string[];
	aliases: Record<string, string[]>;
};
export type ClarificationContractV2 = {
	version: "clarification/v2";
	vocabulary_id: string;
	vocabulary_hash: string;
	required: string[];
	permitted_extra: string[];
	terms: Map<string, string>;
};

// 新契约必须显式登记版本和字段；拼写错误不能静默退回旧比较逻辑。
function contractObject(value: unknown, allowed: string[], label: string): Record<string, unknown> {
	const object = asRecord(value);
	if (
		!value ||
		Array.isArray(value) ||
		typeof value !== "object" ||
		Object.keys(object).some((key) => !allowed.includes(key))
	)
		throw new Error(`invalid_gold：${label} 对象或字段无效`);
	return object;
}
function contractStrings(value: unknown, label: string, nonempty = false): string[] {
	const values = stringList(value, label);
	if ((nonempty && !values.length) || values.some((item) => !item.trim()))
		throw new Error(`invalid_gold：${label} 不能为空`);
	return values;
}

// 导入与直接离线重评共用验证器，旧 exact/未声明契约保持原行为，新能力不能隐式启用。
export function comparisonContractV2(gold: Record<string, unknown>): ComparisonContractV2 | undefined {
	const comparison = asRecord(gold.comparison);
	if (comparison.contract_version === undefined) {
		if (comparison.column_names !== undefined && comparison.column_names !== "exact")
			throw new Error("invalid_gold：新列名模式必须声明 comparison/v2");
		return undefined;
	}
	contractObject(
		comparison,
		["contract_version", "column_names", "row_order", "numeric_tolerance", "null_is_zero"],
		"comparison",
	);
	if (
		comparison.contract_version !== "comparison/v2" ||
		!["exact", "declared_aliases", "single_value"].includes(String(comparison.column_names)) ||
		!["ordered", "unordered_multiset"].includes(String(comparison.row_order)) ||
		comparison.null_is_zero !== false ||
		typeof comparison.numeric_tolerance !== "number" ||
		!Number.isFinite(comparison.numeric_tolerance) ||
		comparison.numeric_tolerance < 0
	)
		throw new Error("invalid_gold：comparison/v2 版本、模式、行序或数值约束无效");
	const contract = contractObject(gold.result_contract, ["columns", "aliases", "column_settings"], "result_contract");
	const columns = contractStrings(contract.columns, "result_contract.columns", true);
	if (comparison.column_names === "single_value" && columns.length !== 1)
		throw new Error("invalid_gold：single_value 必须恰有一个角色");
	if (
		gold.expected_columns !== undefined &&
		canonicalJson(contractStrings(gold.expected_columns, "expected_columns")) !== canonicalJson(columns)
	)
		throw new Error("invalid_gold：expected_columns 与角色声明冲突");
	if (
		!Array.isArray(gold.expected_rows) ||
		gold.expected_rows.some(
			(row) =>
				!row ||
				typeof row !== "object" ||
				Array.isArray(row) ||
				canonicalJson(Object.keys(row).sort()) !== canonicalJson([...columns].sort()),
		)
	)
		throw new Error("invalid_gold：结果行必须与声明角色一一对应");
	const aliases: Record<string, string[]> = Object.fromEntries(columns.map((column) => [column, []]));
	if (contract.aliases !== undefined) {
		if (comparison.column_names !== "declared_aliases") throw new Error("invalid_gold：当前列名模式不允许 aliases");
		const declared = contractObject(contract.aliases, columns, "aliases");
		const used = new Set(columns);
		for (const [role, values] of Object.entries(declared)) {
			aliases[role] = contractStrings(values, `aliases.${role}`);
			for (const name of aliases[role]) {
				if (used.has(name)) throw new Error("invalid_gold：角色别名冲突");
				used.add(name);
			}
		}
	}
	const settings =
		contract.column_settings === undefined ? {} : contractObject(contract.column_settings, columns, "column_settings");
	for (const role of columns) {
		const setting = !Object.hasOwn(settings, role)
			? {}
			: contractObject(settings[role], ["type", "absolute_tolerance", "relative_tolerance"], `column_settings.${role}`);
		if (setting.type !== undefined && !["integer", "decimal", "string", "boolean"].includes(String(setting.type)))
			throw new Error("invalid_gold：列类型无效");
		for (const key of ["absolute_tolerance", "relative_tolerance"])
			if (
				setting[key] !== undefined &&
				(typeof setting[key] !== "number" || !Number.isFinite(setting[key]) || setting[key] < 0)
			)
				throw new Error("invalid_gold：列容差无效");
		for (const row of gold.expected_rows) {
			const value = asRecord(row)[role];
			if (value === null) continue;
			if (
				!["number", "string", "boolean"].includes(typeof value) ||
				(typeof value === "number" &&
					(!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) ||
				(setting.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value))) ||
				(setting.type === "decimal" && typeof value !== "number") ||
				(setting.type === "string" && typeof value !== "string") ||
				(setting.type === "boolean" && typeof value !== "boolean")
			)
				throw new Error("invalid_gold：gold 值与列类型不符");
		}
	}
	return { version: "comparison/v2", mode: comparison.column_names as ComparisonContractV2["mode"], columns, aliases };
}

// 词表随私有 gold 冻结并核内容 hash；这里只接受审核词表精确映射，不用模型输出扩展同义词。
export function clarificationContractV2(gold: Record<string, unknown>): ClarificationContractV2 | undefined {
	if (gold.clarification_contract === undefined) return undefined;
	const contract = contractObject(
		gold.clarification_contract,
		[
			"version",
			"vocabulary_id",
			"vocabulary_hash",
			"vocabulary",
			"required_concepts",
			"permitted_extra_concepts",
			"matching",
			"normalization",
		],
		"clarification_contract",
	);
	if (
		contract.version !== "clarification/v2" ||
		contract.matching !== "reviewed_exact_aliases" ||
		contract.normalization !== "nfkc_trim" ||
		gold.required_clarifications !== undefined
	)
		throw new Error("invalid_gold：澄清版本、匹配方式无效或与旧 slots 契约冲突");
	const vocabulary = contractObject(
		contract.vocabulary,
		["id", "version", "review_status", "reviewer", "reason", "source_refs", "concepts"],
		"vocabulary",
	);
	if (
		vocabulary.version !== "clarification-vocabulary/v1" ||
		vocabulary.review_status !== "approved" ||
		["id", "reviewer", "reason"].some(
			(key) => typeof vocabulary[key] !== "string" || !String(vocabulary[key]).trim(),
		) ||
		contract.vocabulary_id !== vocabulary.id ||
		contract.vocabulary_hash !== contentHash(vocabulary)
	)
		throw new Error("invalid_gold：词表未经审核或身份、内容 hash 不符");
	contractStrings(vocabulary.source_refs, "vocabulary.source_refs", true);
	if (!Array.isArray(vocabulary.concepts) || !vocabulary.concepts.length) throw new Error("invalid_gold：词表缺少概念");
	const terms = new Map<string, string>(),
		ids = new Set<string>();
	for (const raw of vocabulary.concepts) {
		const concept = contractObject(raw, ["id", "definition", "aliases"], "concept");
		if (
			typeof concept.id !== "string" ||
			!/^[a-z][a-z0-9_]*$/.test(concept.id) ||
			ids.has(concept.id) ||
			typeof concept.definition !== "string" ||
			!concept.definition.trim()
		)
			throw new Error("invalid_gold：概念身份或定义无效");
		ids.add(concept.id);
		for (const term of [concept.id, ...contractStrings(concept.aliases, "concept.aliases")]) {
			const normalized = term.normalize("NFKC").trim();
			if (terms.has(normalized)) throw new Error("invalid_gold：规范化后的概念别名重叠或歧义");
			terms.set(normalized, concept.id);
		}
	}
	const required = contractStrings(contract.required_concepts, "required_concepts", true),
		permitted = contractStrings(contract.permitted_extra_concepts, "permitted_extra_concepts");
	if ([...required, ...permitted].some((id) => !ids.has(id)) || permitted.some((id) => required.includes(id)))
		throw new Error("invalid_gold：必需/允许概念未知或冲突");
	return {
		version: "clarification/v2",
		vocabulary_id: String(vocabulary.id),
		vocabulary_hash: String(contract.vocabulary_hash),
		required,
		permitted_extra: permitted,
		terms,
	};
}

function validateGold(gold: Record<string, unknown>, id: string): void {
	const comparison = comparisonContractV2(gold);
	const clarification = clarificationContractV2(gold);
	if ((comparison && gold.expected_action !== "answer") || (clarification && gold.expected_action !== "clarify"))
		throw new Error(`invalid_gold：${id} 比较契约与预期行动不一致`);
	if (!["answer", "clarify", "blocked"].includes(String(gold.expected_action)))
		throw new Error(`invalid_gold：${id} 行动无效`);
	if (gold.expected_action === "answer") {
		if (
			!Array.isArray(gold.expected_rows) ||
			gold.expected_rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))
		) {
			throw new Error(`invalid_gold：${id} 缺少对象行结果`);
		}
		const rows = gold.expected_rows as Record<string, unknown>[];
		const columns = rows.length
			? Object.keys(rows[0]).sort()
			: stringList(gold.expected_columns ?? asRecord(gold.result_contract).columns ?? [], `${id}.expected_columns`);
		if (rows.some((row) => canonicalJson(Object.keys(row).sort()) !== canonicalJson(columns)))
			throw new Error(`invalid_gold：${id} 结果列不一致`);
		const tolerance = asRecord(gold.comparison).numeric_tolerance;
		if (tolerance !== undefined && (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0))
			throw new Error(`invalid_gold：${id} 容差无效`);
		if (
			gold.category === "synthetic_calculation" &&
			(gold.official_metric_calculation !== false || typeof gold.test_rule_id !== "string")
		)
			throw new Error(`invalid_gold：${id} 合成公式缺少独立测试规则身份`);
	}
	for (const key of [
		"required_metric_ids",
		"required_tables",
		"required_fields",
		"required_time_fields",
		"required_gap_ids",
		"required_logical_relations",
		"candidate_relation_ids",
		"required_clarifications",
		"forbidden_actions",
	]) {
		if (gold[key] !== undefined) stringList(gold[key], `${id}.${key}`);
	}
	if (String(gold.category).startsWith("official_metric_")) {
		for (const key of ["required_metric_ids", "required_tables", "required_fields", "required_gap_ids"])
			stringList(gold[key], `${id}.${key}`);
		if (gold.expected_action !== "blocked" || !Array.isArray(gold.expected_execution_statuses))
			throw new Error(`invalid_gold：${id} 正式边界不完整`);
	}
	if (gold.expected_action === "clarify" && !clarification)
		stringList(gold.required_clarifications, `${id}.required_clarifications`);
	// 完整任务的三个契约都必须先有可执行标注，避免付费运行后才发现 gold 缺失。
	for (const name of ["semantic_contract", "answer_contract", "process_contract"]) {
		if (gold[name] === undefined && gold.check_profile !== "task_complete") continue;
		const assertions = asRecord(gold[name]).assertions,
			seen = new Set<string>();
		if (!Array.isArray(assertions) || !assertions.length) throw new Error(`invalid_gold：${id}.${name} 缺少断言`);
		for (const raw of assertions) {
			const item = asRecord(raw);
			if (
				typeof item.id !== "string" ||
				!item.id ||
				seen.has(item.id) ||
				typeof item.path !== "string" ||
				(!item.path.startsWith("turn.") && !item.path.startsWith("artifacts.")) ||
				item.path.split(".").some((part) => ["__proto__", "constructor", "prototype"].includes(part)) ||
				!["equals", "contains_all", "set_equals", "absent", "includes"].includes(String(item.op)) ||
				(item.op !== "absent" && !Object.hasOwn(item, "expected"))
			)
				throw new Error(`invalid_gold：${id}.${name} 断言无效`);
			if (
				(["contains_all", "set_equals"].includes(String(item.op)) && !Array.isArray(item.expected)) ||
				(item.op === "includes" && typeof item.expected !== "string")
			)
				throw new Error(`invalid_gold：${id}.${name} 断言类型无效`);
			seen.add(item.id);
		}
	}
}

// 136 题原包直接导入，标注能力如实登记；缺完整语义和答案 gold 时不冒充 task_complete。
export function parseDataset(input: {
	questionsJsonl: string;
	goldJsonl: string;
	manifest?: unknown;
	name?: string;
	logicalRelations?: unknown[];
}): DatasetVersion {
	const questions = jsonLines(input.questionsJsonl, "questions"),
		goldRows = jsonLines(input.goldJsonl, "gold");
	const goldById = new Map<string, Record<string, unknown>>();
	for (const gold of goldRows) {
		const id = requiredString(gold.id, "gold.id");
		if (goldById.has(id)) throw new Error(`invalid_gold：重复 ID ${id}`);
		goldById.set(id, gold);
	}
	const ids = new Set<string>(),
		familySplits = new Map<string, string>();
	const cases = questions.map((question) => {
		if (Object.keys(question).sort().join(",") !== "as_of,id,question,source_id")
			throw new Error("invalid_dataset：公共问题只允许四字段，禁止携带 gold");
		const id = requiredString(question.id, "question.id"),
			source = requiredString(question.source_id, `${id}.source_id`);
		if (ids.has(id)) throw new Error(`invalid_dataset：重复问题 ${id}`);
		ids.add(id);
		const gold = goldById.get(id);
		if (!gold || gold.source_id !== source) throw new Error(`invalid_gold：${id} 缺 gold 或来源不一致`);
		validateGold(gold, id);
		const family = requiredString(gold.family_id ?? gold.family, `${id}.family`),
			split = gold.split;
		if (split !== "dev" && split !== "holdout") throw new Error(`invalid_gold：${id} 拆分无效`);
		if (familySplits.has(family) && familySplits.get(family) !== split)
			throw new Error(`invalid_gold：family ${family} 跨拆分泄漏`);
		familySplits.set(family, split);
		const asOf = requiredString(question.as_of, `${id}.as_of`);
		if (!Number.isFinite(Date.parse(asOf))) throw new Error(`invalid_dataset：${id} 时间锚点无效`);
		const profile = gold.check_profile ?? (gold.expected_action === "answer" ? "result_only" : "linking");
		if (!["linking", "result_only", "task_complete"].includes(String(profile)))
			throw new Error(`invalid_gold：${id} 评分档位无效`);
		const coverageGaps: string[] = [];
		if (gold.expected_action === "answer" && !gold.semantic_contract)
			coverageGaps.push("semantic_contract_not_annotated");
		if (gold.expected_action === "answer" && !gold.answer_contract) coverageGaps.push("answer_contract_not_annotated");
		if (profile === "task_complete" && coverageGaps.length) throw new Error(`invalid_gold：${id} 完整任务缺少必需标注`);
		return {
			id,
			source_id: source,
			question: requiredString(question.question, `${id}.question`),
			as_of: asOf,
			track: requiredString(gold.category ?? gold.track, `${id}.track`),
			family,
			split,
			expected_action: gold.expected_action as ExpectedAction,
			profile: profile as CheckProfile,
			gold,
			coverage_gaps: coverageGaps,
		} satisfies EvaluationCase;
	});
	if (cases.length !== goldRows.length) throw new Error("invalid_gold：问题和 gold 不是一一对应");
	const manifest = asRecord(input.manifest),
		version = typeof manifest.version === "string" ? manifest.version : "import-v1";
	if (manifest.question_count !== undefined && manifest.question_count !== cases.length)
		throw new Error("invalid_dataset：manifest 题数不符");
	const logicalRelations = input.logicalRelations ?? [];
	const hash = contentHash({ questions, gold: goldRows, manifest, logicalRelations });
	const tracks: Record<string, number> = {},
		profiles: Record<string, number> = {};
	for (const sample of cases) {
		tracks[sample.track] = (tracks[sample.track] || 0) + 1;
		profiles[sample.profile] = (profiles[sample.profile] || 0) + 1;
	}
	return immutable({
		id: `dataset-${hash}`,
		name: input.name || version,
		hash,
		schema_version: "evaluation-dataset/v1",
		version,
		cases,
		manifest,
		logical_relations: logicalRelations,
		coverage: { total: cases.length, tracks, families: familySplits.size, profiles },
	});
}

// 文件包先核全部 manifest 指纹；路径不得逃出包，公开入口不返回私有 gold 内容。
export async function loadBenchmarkDataset(directory: string): Promise<DatasetVersion> {
	const root = await realpath(directory),
		manifest = asRecord(JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")));
	const files = asRecord(manifest.files_sha256);
	const verified = new Map<string, Buffer>();
	for (const required of ["questions.jsonl", "evaluation/gold.jsonl"])
		if (typeof files[required] !== "string") throw new Error(`invalid_dataset：缺文件指纹 ${required}`);
	for (const [name, expected] of Object.entries(files)) {
		if (
			isAbsolute(name) ||
			name.split(/[\\/]/).includes("..") ||
			typeof expected !== "string" ||
			!/^[a-f0-9]{64}$/.test(expected)
		)
			throw new Error("invalid_dataset：文件清单无效");
		const path = await realpath(resolve(root, name)),
			rel = relative(root, path);
		if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("invalid_dataset：文件路径越界");
		const bytes = await readFile(path);
		if (createHash("sha256").update(bytes).digest("hex") !== expected)
			throw new Error(`invalid_dataset：快照指纹不符 ${name}`);
		// 只保留需要解析的小文件，DB 指纹验证后释放，且不二次读取已验证内容。
		if (["questions.jsonl", "evaluation/gold.jsonl", "knowledge/mock_semantics.json"].includes(name))
			verified.set(name, bytes);
	}
	const semantics = verified.has("knowledge/mock_semantics.json")
		? asRecord(JSON.parse(verified.get("knowledge/mock_semantics.json")!.toString("utf8")))
		: {};
	return parseDataset({
		manifest,
		questionsJsonl: verified.get("questions.jsonl")!.toString("utf8"),
		goldJsonl: verified.get("evaluation/gold.jsonl")!.toString("utf8"),
		logicalRelations: Array.isArray(semantics.relations) ? semantics.relations : [],
	});
}

export function publicQuestion(sample: PublicQuestion): PublicQuestion {
	return { id: sample.id, source_id: sample.source_id, question: sample.question, as_of: sample.as_of };
}

export function publicDataset(dataset: DatasetVersion) {
	return {
		id: dataset.id,
		name: dataset.name,
		hash: dataset.hash,
		version: dataset.version,
		schema_version: dataset.schema_version,
		coverage: structuredClone(dataset.coverage),
		cases: dataset.cases.map(publicQuestion),
	};
}
