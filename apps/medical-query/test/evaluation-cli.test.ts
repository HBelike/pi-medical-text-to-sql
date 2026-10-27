import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runEvaluationCli } from "../src/evaluation/cli.ts";

const exec = promisify(execFile);

// 三个可执行路径共用无副作用帮助和统一 API 契约，不再因旧默认参数直接花费模型调用。
test("统一 CLI 支持无参数与常见帮助选项，旧并发参数明确拒绝", async () => {
	for (const args of [[], ["help"], ["--help"], ["-h"]]) {
		const result = await runEvaluationCli(args);
		assert.ok("usage" in result);
		assert.match(JSON.stringify(result), /统一|v3/);
	}
	await assert.rejects(runEvaluationCli(["--standalone"]), /入口已停用/);
	await assert.rejects(runEvaluationCli(["--concurrency", "5"]), /入口已停用/);
});

test("历史评测 main 导向统一帮助且不启动服务或读取模型凭据", async () => {
	for (const script of ["src/evaluate.ts", "src/l0-evaluate.ts", "src/evaluation/cli.ts"]) {
		const { stdout } = await exec(
			process.execPath,
			["--import", resolve("../../scripts/issues/register.mjs"), "--conditions=source", resolve(script), "--help"],
			{ timeout: 20000, env: { ...process.env, PI_EVAL_URL: "http://127.0.0.1:1" } },
		);
		const result = JSON.parse(stdout);
		assert.ok(result.usage.includes("cli.ts POST experiments request.json"));
		assert.equal(result.base_url, "http://127.0.0.1:1");
	}
});
