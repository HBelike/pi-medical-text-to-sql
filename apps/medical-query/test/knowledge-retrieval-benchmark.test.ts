import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { APP_ROOT } from "../src/config.ts";
import { RetrievalBudgetError, retrieveCatalog } from "../src/knowledge-retrieval.ts";

const execute = promisify(execFile);
type Row = Record<string, unknown>;

// 每次从公开生成器建立独立百表库；先完成全部公共问题召回，再读取独立评分数据作覆盖检查。
test("真实 106 表包的 40 道事实题在默认预算内保留必需表与全部列", { timeout: 60000 }, async (t) => {
	const temporary = await mkdtemp(resolve(tmpdir(), "pi-retrieval-benchmark-"));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const directory = resolve(temporary, "package");
	await execute("python3", [
		resolve(APP_ROOT, "python/build_l0_benchmark.py"),
		"--output-dir",
		directory,
		"--patients-per-institution",
		"8",
	]);
	const { stdout } = await execute(
		"python3",
		[
			"-c",
			`
import json, pathlib, sqlite3, sys
sys.path.insert(0, sys.argv[1])
from domain import load_catalog
root = pathlib.Path(sys.argv[2])
with sqlite3.connect(root / "l0-benchmark.sqlite") as connection:
    print(json.dumps(load_catalog(connection, json.loads((root / "semantic.json").read_text())), ensure_ascii=False))
`,
			resolve(APP_ROOT, "python"),
			directory,
		],
		{ maxBuffer: 8 * 1024 * 1024 },
	);
	const catalog = JSON.parse(stdout) as Row & { tables: Row[] };
	assert.equal(catalog.tables.length, 106);
	const questions = (await readFile(resolve(directory, "questions.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { id: string; source_id: string; question: string })
		.filter((question) => /^L0F-/.test(question.id));
	assert.equal(questions.length, 40);
	const results = questions.map((question) => ({
		id: question.id,
		result: retrieveCatalog({
			catalog,
			question: question.question,
			source_id: question.source_id,
			version: "generated-benchmark/v1",
			strategy: "lexical",
		}),
	}));
	const gold = new Map(
		(await readFile(resolve(directory, "evaluation/gold.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => {
				const row = JSON.parse(line) as { id: string; required_tables?: string[] };
				return [row.id, row] as const;
			}),
	);
	for (const { id, result } of results) {
		const required = gold.get(id)?.required_tables;
		assert.ok(required?.length, `${id}: 需要独立必需表标注`);
		assert.deepEqual(
			required.filter((name) => !result.receipt.admitted_ids.includes(name)),
			[],
			`${id}: 必需表漏召回`,
		);
		assert.equal(result.receipt.fallback, "none", id);
		assert.ok(result.receipt.character_budget.actual <= 256000, id);
		assert.ok(result.catalog.tables.length < catalog.tables.length, `${id}: 不得反向展开整个目录`);
		for (const table of result.catalog.tables) {
			assert.deepEqual(
				table.columns,
				catalog.tables.find((original) => original.name === table.name)?.columns,
				`${id}: 选表列不可裁剪`,
			);
		}
	}
	const chars = results.map(({ result }) => result.receipt.character_budget.actual);
	const counts = results.map(({ result }) => result.catalog.tables.length);
	t.diagnostic(
		`40/40 required-table coverage; chars=${Math.min(...chars)}..${Math.max(...chars)}; tables=${Math.min(...counts)}..${Math.max(...counts)}; no model calls`,
	);
	assert.throws(
		() =>
			retrieveCatalog({
				catalog,
				question: questions[0].question,
				source_id: questions[0].source_id,
				version: "generated-benchmark/v1",
				strategy: "full_catalog",
			}),
		(error) => {
			assert.ok(error instanceof RetrievalBudgetError);
			assert.equal(error.receipt.admitted_ids.length, 106);
			assert.ok(error.receipt.character_budget.actual > error.receipt.character_budget.maximum);
			return true;
		},
	);
});
