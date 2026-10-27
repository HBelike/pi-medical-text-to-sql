import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { EvaluationStore, fingerprint, type SlotRecord } from "../src/evaluation/store.ts";

async function setup(t: TestContext, reserve = 0) {
	const directory = await mkdtemp(resolve(tmpdir(), "pi-evaluation-store-"));
	const store = new EvaluationStore(directory, reserve);
	t.after(async () => {
		try {
			store.close();
		} catch {
			/* 重启测试可能已经关闭旧连接。 */
		}
		await rm(directory, { recursive: true, force: true });
	});
	return { store, directory };
}

// 重启测试只重开持久账本，不连接提供方或读取真实 API key。
test("意图重启后仍为 pending；业务状态与幂等完成回执同事务提交", async (t) => {
	const { store, directory } = await setup(t);
	const input = { question: "test" };
	assert.deepEqual(store.beginCommand("create:one", input), { status: "pending" });
	assert.equal(store.command("create:one", input), undefined);
	store.close();
	const reopened = new EvaluationStore(directory, 0);
	try {
		assert.deepEqual(reopened.beginCommand("create:one", input), { status: "pending" });
		assert.throws(
			() =>
				reopened.transaction(() => {
					reopened.put("experiment", "stable-id", { name: "stable" });
					reopened.finishCommand("create:one", input, { id: "stable-id" });
					throw new Error("crash-before-commit");
				}),
			/crash-before-commit/,
		);
		assert.equal(reopened.get("experiment", "stable-id"), undefined);
		assert.equal(reopened.command("create:one", input), undefined);
		reopened.transaction(() => {
			reopened.put("experiment", "stable-id", { name: "stable" });
			reopened.finishCommand("create:one", input, { id: "stable-id" });
		});
		assert.deepEqual(reopened.command("create:one", input), { id: "stable-id" });
		assert.doesNotThrow(() => reopened.finishCommand("create:one", input, { id: "stable-id" }));
		assert.throws(() => reopened.finishCommand("create:one", input, { id: "second-id" }), /不能覆盖/);
		assert.throws(() => reopened.beginCommand("create:one", { question: "different" }), /不同命令/);
	} finally {
		reopened.close();
	}
});

test("嵌套事务单独回滚后可继续外层事务，最外层失败一起回滚", async (t) => {
	const { store } = await setup(t);
	store.transaction(() => {
		store.put("experiment", "outer", { value: 1 });
		assert.throws(
			() =>
				store.transaction(() => {
					store.put("experiment", "nested", { value: 2 });
					throw new Error("nested-failure");
				}),
			/nested-failure/,
		);
		store.put("experiment", "after", { value: 3 });
	});
	assert.equal(store.get("experiment", "nested"), undefined);
	assert.ok(store.get("experiment", "outer"));
	assert.throws(
		() =>
			store.transaction(() => {
				store.transaction(() => store.put("experiment", "rolled-back", {}));
				throw new Error("outer-failure");
			}),
		/outer-failure/,
	);
	assert.equal(store.get("experiment", "rolled-back"), undefined);
});

test("全集遍历跨越 500 条记录及 1000 条事件，评分计数来自索引", async (t) => {
	const { store } = await setup(t);
	store.transaction(() => {
		for (let index = 0; index < 501; index++) store.put("experiment", `e-${String(index).padStart(4, "0")}`, { index });
		for (let index = 0; index < 1005; index++) store.event("one", String(index), "test", { index });
	});
	assert.equal(store.list("experiment", "", 1000).length, 500);
	assert.equal(store.all("experiment").length, 501);
	assert.equal(store.allEvents("one").length, 1005);
	const slot: SlotRecord = {
		id: "slot",
		experiment_id: "one",
		case_id: "case",
		variant_id: "variant",
		repeat_index: 0,
		snapshot_id: "snapshot",
		ordinal: 0,
		status: "completed",
		request_id: "request",
		execution_id: "execution",
		conversation_id: "conversation",
		updated_at: 0,
	};
	store.addSlot(slot);
	assert.equal(store.scoredCount("one"), 0);
	store.updateSlot({ ...slot, scored: true });
	assert.equal(store.scoredCount("one"), 1);
	assert.equal(store.scoredCount("another"), 0);
});

test("共享引用必须覆盖全部删除影响，删除后相同内容不能静默复活", async (t) => {
	const { store } = await setup(t);
	const value = { response: "complete" },
		id = store.artifact(value, "observation", "experiment:first");
	store.refArtifact(id, "experiment:second");
	assert.deepEqual(store.deletionImpact(id), ["experiment:first", "experiment:second"]);
	assert.throws(() => store.deleteArtifact(id, ["experiment:first"], "tester", "test"), /全部引用/);
	store.deleteArtifact(id, ["experiment:first", "experiment:second"], "tester", "test");
	assert.throws(() => store.readArtifact(id), /已手动删除/);
	assert.throws(() => store.artifact(value, "observation", "experiment:third"), /不能静默恢复/);
	assert.throws(() => store.refArtifact(id, "experiment:third"), /不存在或已删除/);
	assert.throws(() => store.refArtifact("0".repeat(64), "experiment:first"), /不存在或已删除/);
	assert.equal(store.allEvents("storage")[0].type, "artifact_deleted");
});

test("新准入因预留空间背压时，已开始任务仍能落盘完整证据", async (t) => {
	const { store } = await setup(t, Number.MAX_SAFE_INTEGER);
	assert.throws(() => store.assertCapacity(), /空间不足/);
	const id = store.artifact({ final: "durable evidence" }, "observation", "experiment:existing");
	assert.deepEqual(store.readArtifact(id), { final: "durable evidence" });
});

test("旧完成回执增加状态字段后保持完成，不重复派发", async (t) => {
	const directory = await mkdtemp(resolve(tmpdir(), "pi-store-migration-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const database = new DatabaseSync(resolve(directory, "evaluation.sqlite"));
	database.exec("CREATE TABLE commands(id TEXT PRIMARY KEY,hash TEXT NOT NULL,body TEXT NOT NULL)");
	database
		.prepare("INSERT INTO commands VALUES(?,?,?)")
		.run("legacy", fingerprint({ input: true }), JSON.stringify({ id: "existing" }));
	database.close();
	const store = new EvaluationStore(directory, 0);
	try {
		assert.deepEqual(store.command("legacy", { input: true }), { id: "existing" });
		assert.equal(store.beginCommand("legacy", { input: true }).status, "completed");
	} finally {
		store.close();
	}
});

test("删除在外层事务回滚时保留正文、引用和原始可读状态", async (t) => {
	const { store, directory } = await setup(t);
	const value = { answer: "完整原始证据" };
	const id = store.artifact(value, "observation", "experiment:rollback");
	const path = resolve(directory, "artifacts", `${id}.json`);
	assert.throws(
		() =>
			store.transaction(() => {
				store.deleteArtifact(id, ["experiment:rollback"], "tester", "模拟外层提交前失败");
				assert.ok(existsSync(path), "savepoint 释放不代表外层删除授权已提交");
				throw new Error("outer-delete-rollback");
			}),
		/outer-delete-rollback/,
	);
	assert.deepEqual(store.readArtifact(id), value);
	assert.deepEqual(store.deletionImpact(id), ["experiment:rollback"]);
	assert.equal(store.allEvents("storage").length, 0);
	assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM artifact_deletions").get()!.n, 0);
});

test("内层删除回滚不影响外层提交，正式删除只在最外层提交后清理正文", async (t) => {
	const { store, directory } = await setup(t);
	const value = { answer: "保留到最终提交" };
	const id = store.artifact(value, "observation", "experiment:nested");
	const path = resolve(directory, "artifacts", `${id}.json`);
	store.transaction(() => {
		assert.throws(
			() =>
				store.transaction(() => {
					store.deleteArtifact(id, ["experiment:nested"], "tester", "模拟内层失败");
					throw new Error("nested-delete-rollback");
				}),
			/nested-delete-rollback/,
		);
		store.put("experiment", "unrelated-commit", { saved: true });
	});
	assert.deepEqual(store.readArtifact(id), value);
	store.transaction(() => {
		store.deleteArtifact(id, ["experiment:nested"], "tester", "明确提交删除");
		assert.ok(existsSync(path));
	});
	assert.equal(existsSync(path), false);
	assert.throws(() => store.readArtifact(id), { code: "artifact_unavailable" });
	assert.equal(store.allEvents("storage").length, 1);
	assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM artifact_deletions").get()!.n, 0);
});

test("SQLite 提交自身被拒绝时不清理正文，回滚后仍能正常提交", async (t) => {
	const { store, directory } = await setup(t);
	const value = { answer: "提交失败时保留证据" };
	const id = store.artifact(value, "observation", "experiment:commit-failure");
	const path = resolve(directory, "artifacts", `${id}.json`);
	// 延迟外键把故障固定在 COMMIT 而非 work()，覆盖事务已执行完但未获最终提交的窗口。
	store.db.exec(`CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
		CREATE TABLE commit_child(parent_id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`);
	assert.throws(
		() =>
			store.transaction(() => {
				store.deleteArtifact(id, ["experiment:commit-failure"], "tester", "模拟最终提交失败");
				store.db.prepare("INSERT INTO commit_child VALUES(?)").run(1);
			}),
		/FOREIGN KEY constraint failed/,
	);
	assert.ok(existsSync(path));
	assert.deepEqual(store.readArtifact(id), value);
	assert.equal(store.allEvents("storage").length, 0);
	assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM artifact_deletions").get()!.n, 0);
	store.transaction(() => store.put("experiment", "after-rejected-commit", { saved: true }));
	assert.ok(store.get("experiment", "after-rejected-commit"));
	assert.deepEqual(store.readArtifact(id), value);
});

test("清理失败保留持久删除意图，重启仅重试 tombstone 而不清理其他正文", async (t) => {
	const { store, directory } = await setup(t);
	const id = store.artifact({ answer: "待删除" }, "observation", "experiment:deleted");
	const retained = store.artifact({ answer: "必须保留" }, "observation", "experiment:retained");
	const path = resolve(directory, "artifacts", `${id}.json`);
	const backup = `${path}.test-saved`;
	// 用同名目录制造确定的 unlink 失败，不依赖当前用户权限或磁盘容量。
	renameSync(path, backup);
	mkdirSync(path);
	assert.doesNotThrow(() => store.deleteArtifact(id, ["experiment:deleted"], "tester", "测试重启接续清理"));
	assert.throws(() => store.readArtifact(id), { code: "artifact_unavailable" });
	assert.ok(store.db.prepare("SELECT last_error FROM artifact_deletions WHERE artifact_id=?").get(id)!.last_error);
	store.close();
	rmSync(path, { recursive: true });
	renameSync(backup, path);
	const unregistered = resolve(directory, "artifacts", `${"f".repeat(64)}.json`);
	writeFileSync(unregistered, "未登记的文件不属于已授权删除范围");
	const reopened = new EvaluationStore(directory, 0);
	try {
		assert.equal(existsSync(path), false);
		assert.throws(() => reopened.readArtifact(id), { code: "artifact_unavailable" });
		assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM artifact_deletions").get()!.n, 0);
		assert.deepEqual(reopened.readArtifact(retained), { answer: "必须保留" });
		assert.ok(existsSync(unregistered));
		assert.equal(reopened.allEvents("storage").length, 1, "恢复清理不伪造第二次用户删除");
	} finally {
		reopened.close();
	}
});
