import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** CLI 是统一 API 的客户端，退出不取消任务，不加载凭据或单独创建模型池。 */
export async function runEvaluationCli(args: string[]) {
	const [command = "help", target, bodyFile, outputFile] = args;
	if (["help", "--help", "-h"].includes(command))
		return {
			usage: [
				"cli.ts GET datasets|variants|experiments|status",
				"cli.ts POST experiments request.json",
				"cli.ts POST experiments/<id>/commands command.json",
				"cli.ts POST experiments/<id>/score-sets request.json",
				"cli.ts GET experiments/<id>/export - export.json",
				"cli.ts DELETE artifacts/<id> confirmed-impact.json",
			],
			api: "所有 v3 API 路径均可调用；修改已有记录时 JSON 带 expected_revision，幂等键缺省生成并在回执打印。旧 --concurrency/--standalone 入口已停用，请在实验请求中配置并发。",
			base_url: process.env.PI_EVAL_URL || `http://127.0.0.1:${process.env.PI_PORT || "8787"}`,
		};
	const method = command.toUpperCase();
	if (!["GET", "POST", "DELETE"].includes(method) || !target || target.includes("..") || target.startsWith("/"))
		throw new Error(
			"请使用 npm run eval -- --help 查看统一评测入口；使用 GET/POST/DELETE 和相对 /api/eval 的路径，旧 --concurrency/--standalone 入口已停用",
		);
	const input: Record<string, unknown> =
		method === "GET" ? {} : (JSON.parse(await readFile(resolve(bodyFile || ""), "utf8")) as Record<string, unknown>);
	if (method !== "GET") input.idempotency_key ??= randomUUID();
	// 先打印请求身份，断网或进程中断后仍可用相同键续接，避免无回执时再次创建实验。
	if (method !== "GET") console.error(`评测请求幂等键：${String(input.idempotency_key)}；重试时请保留此键。`);
	const base = process.env.PI_EVAL_URL || `http://127.0.0.1:${process.env.PI_PORT || "8787"}`;
	const response = await fetch(`${base}/api/eval/${target}`, {
		method,
		...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
	});
	const result: unknown = await response.json();
	const receipt = {
		http_status: response.status,
		...(method === "GET" ? {} : { idempotency_key: input.idempotency_key }),
		result,
	};
	if (outputFile)
		await writeFile(resolve(outputFile), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	if (!response.ok) process.exitCode = 1;
	return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	void runEvaluationCli(process.argv.slice(2)).then(
		(result) => console.log(JSON.stringify(result, null, 2)),
		(error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		},
	);
}
