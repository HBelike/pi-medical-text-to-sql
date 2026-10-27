import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RuntimeError } from "../runtime.ts";

export type Stored<T> = { id: string; revision: number; created_at: number; updated_at: number; data: T };
export type SlotRecord = {
	id: string;
	experiment_id: string;
	case_id: string;
	variant_id: string;
	repeat_index: number;
	snapshot_id: string;
	ordinal: number;
	status: string;
	request_id: string;
	execution_id: string;
	conversation_id: string;
	turn_id?: string;
	artifact_id?: string;
	error?: string;
	scored?: boolean;
	origin_slot_id?: string;
	updated_at: number;
};
export type ArtifactRecord = { id: string; kind: string; bytes: number; created_at: number; deleted_at: number | null };
export type CommandIntent = { status: "pending" | "completed"; result?: unknown };

// 内容身份使用排序后的 JSON；完整原文留在产物中，查询列表只读小型元数据。
export function stableJson(value: unknown): string {
	const clean: unknown = JSON.parse(JSON.stringify(value));
	function sorted(item: unknown): unknown {
		if (Array.isArray(item)) return item.map(sorted);
		if (item && typeof item === "object")
			return Object.fromEntries(
				Object.entries(item)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, entry]) => [key, sorted(entry)]),
			);
		return item;
	}
	return JSON.stringify(sorted(clean));
}
export const fingerprint = (value: unknown): string => createHash("sha256").update(stableJson(value)).digest("hex");

/** 应用控制端的唯一持久账本；Pi 继续拥有业务任务，本库不另行运行 Agent。 */
export class EvaluationStore {
	readonly db: DatabaseSync;
	readonly root: string;
	readonly reserveBytes: number;
	private transactionDepth = 0;
	private savepointSequence = 0;
	constructor(root: string, reserveBytes = 32 * 1024 * 1024) {
		this.root = resolve(root);
		this.reserveBytes = reserveBytes;
		mkdirSync(resolve(this.root, "artifacts"), { recursive: true });
		this.db = new DatabaseSync(resolve(this.root, "evaluation.sqlite"));
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
		CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
		CREATE INDEX IF NOT EXISTS objects_page ON objects(kind,created_at,id);
		CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL,ordinal INTEGER NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(experiment_id,ordinal));
		CREATE INDEX IF NOT EXISTS slots_state ON slots(experiment_id,status,ordinal);
		CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,experiment_id TEXT NOT NULL,entity_id TEXT NOT NULL,type TEXT NOT NULL,created_at INTEGER NOT NULL,body TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS events_page ON events(experiment_id,seq);
		CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,hash TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'completed');
		CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,kind TEXT NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,deleted_at INTEGER);
		CREATE TABLE IF NOT EXISTS artifact_refs(owner TEXT NOT NULL,artifact_id TEXT NOT NULL REFERENCES artifacts(id),PRIMARY KEY(owner,artifact_id));
		CREATE TABLE IF NOT EXISTS artifact_deletions(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),last_error TEXT);`);
		// 旧回执均代表完成；迁移只补状态，不把已确认操作重新派发。
		if (
			!this.db
				.prepare("PRAGMA table_info(commands)")
				.all()
				.some((column) => column.name === "status")
		)
			this.db.exec("ALTER TABLE commands ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'");
		this.db.exec("CREATE INDEX IF NOT EXISTS slots_scored ON slots(experiment_id,json_extract(body,'$.scored'))");
		// 只接续已手动删除的 tombstone；未登记或未删除文件不属于自动清理范围。
		this.db.exec(
			"INSERT OR IGNORE INTO artifact_deletions(artifact_id) SELECT id FROM artifacts WHERE deleted_at IS NOT NULL",
		);
		this.flushArtifactDeletions();
	}
	transaction<T>(work: () => T): T {
		// 子模块可保留事务，最外层把业务写入与幂等回执作为同一提交。
		const nested = this.transactionDepth > 0,
			savepoint = `evaluation_${++this.savepointSequence}`;
		this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
		this.transactionDepth++;
		let committed = false;
		try {
			const result = work();
			this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
			committed = true;
			return result;
		} catch (error) {
			if (nested) this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
			else this.db.exec("ROLLBACK");
			throw error;
		} finally {
			this.transactionDepth--;
			// 文件不可回滚：只有最外层提交成功才能执行，内层释放 savepoint 仍不能删正文。
			if (committed && !nested) this.flushArtifactDeletions();
		}
	}
	private flushArtifactDeletions() {
		if (this.transactionDepth) return;
		try {
			const pending = this.db
				.prepare(
					"SELECT d.artifact_id FROM artifact_deletions d JOIN artifacts a ON a.id=d.artifact_id WHERE a.deleted_at IS NOT NULL",
				)
				.all();
			for (const row of pending) {
				const id = String(row.artifact_id);
				if (!/^[a-f0-9]{64}$/.test(id)) continue;
				try {
					unlinkSync(resolve(this.root, "artifacts", `${id}.json`));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						this.db.prepare("UPDATE artifact_deletions SET last_error=? WHERE artifact_id=?").run(String(error), id);
						continue;
					}
				}
				this.db.prepare("DELETE FROM artifact_deletions WHERE artifact_id=?").run(id);
			}
		} catch {
			// 提交后的清理故障不能伪装成事务回滚；持久队列保留，后续提交或重启再次尝试。
		}
	}
	capacity() {
		const fs = statfsSync(this.root);
		const free_bytes = fs.bavail * fs.bsize;
		const usage = this.db
			.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes,COUNT(*) AS count FROM artifacts WHERE deleted_at IS NULL")
			.get()!;
		return {
			free_bytes,
			reserve_bytes: this.reserveBytes,
			artifact_bytes: Number(usage.bytes),
			artifact_count: Number(usage.count),
			accepting: free_bytes > this.reserveBytes,
		};
	}
	assertCapacity(bytes = 0) {
		if (this.capacity().free_bytes < this.reserveBytes + bytes)
			throw new RuntimeError("storage_capacity_exhausted", "存储空间不足，已停止接收新工作；已有证据不会自动删除", 507);
	}
	get<T>(kind: string, id: string): Stored<T> | undefined {
		const row = this.db.prepare("SELECT * FROM objects WHERE kind=? AND id=?").get(kind, id);
		return row
			? {
					id: String(row.id),
					revision: Number(row.revision),
					created_at: Number(row.created_at),
					updated_at: Number(row.updated_at),
					data: JSON.parse(String(row.body)) as T,
				}
			: undefined;
	}
	list<T>(kind: string, after = "", limit = 50): Stored<T>[] {
		return this.db
			.prepare("SELECT id FROM objects WHERE kind=? AND id>? ORDER BY id LIMIT ?")
			.all(kind, after, Math.min(500, Math.max(1, limit)))
			.map((row) => this.get<T>(kind, String(row.id))!);
	}
	all<T>(kind: string): Stored<T>[] {
		// 控制流程需要全集时显式迭代，不能把查询页上限误当实验总数。
		const result: Stored<T>[] = [];
		let after = "";
		while (true) {
			const page = this.list<T>(kind, after, 500);
			result.push(...page);
			if (page.length < 500) return result;
			after = page[page.length - 1].id;
		}
	}
	put<T>(kind: string, id: string, data: T, expected?: number): Stored<T> {
		const prior = this.get<T>(kind, id);
		if (expected !== undefined && (prior?.revision ?? 0) !== expected)
			throw new RuntimeError("revision_conflict", "记录已改变，请刷新后重试");
		const now = Date.now();
		const revision = (prior?.revision ?? 0) + 1;
		this.db
			.prepare(
				"INSERT INTO objects VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,body=excluded.body",
			)
			.run(kind, id, revision, prior?.created_at ?? now, now, stableJson(data));
		return this.get<T>(kind, id)!;
	}
	immutable<T>(kind: string, id: string, data: T): Stored<T> {
		const prior = this.get<T>(kind, id);
		if (prior && stableJson(prior.data) !== stableJson(data))
			throw new RuntimeError("immutable_conflict", "冻结对象不可覆盖");
		return prior ?? this.put(kind, id, data, 0);
	}
	command<T>(id: string, input: unknown): T | undefined {
		const row = this.db.prepare("SELECT hash,body,status FROM commands WHERE id=?").get(id);
		if (!row) return undefined;
		if (row.hash !== fingerprint(input)) throw new RuntimeError("idempotency_conflict", "同一幂等键不能用于不同命令");
		return row.status === "pending" ? undefined : (JSON.parse(String(row.body)) as T);
	}
	beginCommand(id: string, input: unknown): CommandIntent {
		// 先落意图，崩溃后由同键恢复稳定身份；pending 不冒充已完成。
		const inputHash = fingerprint(input);
		this.db
			.prepare("INSERT OR IGNORE INTO commands(id,hash,body,status) VALUES(?,?,'null','pending')")
			.run(id, inputHash);
		const row = this.db.prepare("SELECT hash,body,status FROM commands WHERE id=?").get(id)!;
		if (row.hash !== inputHash) throw new RuntimeError("idempotency_conflict", "同一幂等键不能用于不同命令");
		return row.status === "completed"
			? { status: "completed", result: JSON.parse(String(row.body)) }
			: { status: "pending" };
	}
	finishCommand(id: string, input: unknown, result: unknown) {
		const inputHash = fingerprint(input),
			content = stableJson(result);
		const row = this.db.prepare("SELECT hash,body,status FROM commands WHERE id=?").get(id);
		if (row && (row.hash !== inputHash || (row.status === "completed" && row.body !== content)))
			throw new RuntimeError("idempotency_conflict", "命令输入或完成结果不能覆盖");
		if (row?.status === "completed") return;
		this.db
			.prepare(
				"INSERT INTO commands(id,hash,body,status) VALUES(?,?,?,'completed') ON CONFLICT(id) DO UPDATE SET body=excluded.body,status='completed'",
			)
			.run(id, inputHash, content);
	}
	addSlot(slot: SlotRecord) {
		this.db
			.prepare("INSERT INTO slots VALUES(?,?,?,?,?)")
			.run(slot.id, slot.experiment_id, slot.ordinal, slot.status, stableJson(slot));
	}
	slot(id: string): SlotRecord | undefined {
		const row = this.db.prepare("SELECT body FROM slots WHERE id=?").get(id);
		return row ? (JSON.parse(String(row.body)) as SlotRecord) : undefined;
	}
	updateSlot(slot: SlotRecord) {
		this.db.prepare("UPDATE slots SET status=?,body=? WHERE id=?").run(slot.status, stableJson(slot), slot.id);
	}
	slots(experiment: string, after = -1, limit = 100, states?: string[]): SlotRecord[] {
		const where = states?.length ? ` AND status IN (${states.map(() => "?").join(",")})` : "";
		return this.db
			.prepare(`SELECT body FROM slots WHERE experiment_id=? AND ordinal>?${where} ORDER BY ordinal LIMIT ?`)
			.all(experiment, after, ...(states ?? []), Math.min(10000, Math.max(1, limit)))
			.map((row) => JSON.parse(String(row.body)) as SlotRecord);
	}
	counts(experiment: string): Record<string, number> {
		return Object.fromEntries(
			this.db
				.prepare("SELECT status,COUNT(*) AS count FROM slots WHERE experiment_id=? GROUP BY status")
				.all(experiment)
				.map((row) => [String(row.status), Number(row.count)]),
		);
	}
	scoredCount(experiment: string): number {
		return Number(
			this.db
				.prepare("SELECT COUNT(*) AS total FROM slots WHERE experiment_id=? AND json_extract(body,'$.scored')=1")
				.get(experiment)!.total,
		);
	}
	event(experiment: string, entity: string, type: string, data: unknown) {
		return Number(
			this.db
				.prepare("INSERT INTO events(experiment_id,entity_id,type,created_at,body) VALUES(?,?,?,?,?)")
				.run(experiment, entity, type, Date.now(), stableJson(data)).lastInsertRowid,
		);
	}
	events(experiment: string, after = 0, limit = 200) {
		return this.db
			.prepare("SELECT * FROM events WHERE experiment_id=? AND seq>? ORDER BY seq LIMIT ?")
			.all(experiment, after, Math.min(1000, limit))
			.map((row) => ({
				seq: Number(row.seq),
				experiment_id: String(row.experiment_id),
				entity_id: String(row.entity_id),
				type: String(row.type),
				created_at: Number(row.created_at),
				data: JSON.parse(String(row.body)) as unknown,
			}));
	}
	allEvents(experiment: string): ReturnType<EvaluationStore["events"]> {
		const result: ReturnType<EvaluationStore["events"]> = [];
		let after = 0;
		while (true) {
			const page = this.events(experiment, after, 1000);
			result.push(...page);
			if (page.length < 1000) return result;
			after = page[page.length - 1].seq;
		}
	}
	artifact(value: unknown, kind: string, owner: string): string {
		// 原始观察保留字段顺序，不能改写已绑定发布哈希的结果序列化字节。
		const content = JSON.stringify(value),
			byteCount = Buffer.byteLength(content);
		const id = createHash("sha256").update(content).digest("hex");
		const path = resolve(this.root, "artifacts", `${id}.json`);
		const prior = this.db.prepare("SELECT deleted_at FROM artifacts WHERE id=?").get(id);
		if (prior?.deleted_at !== undefined && prior.deleted_at !== null)
			throw new RuntimeError("artifact_deleted", "相同身份的产物曾被手动删除，不能静默恢复", 410);
		// 预留空间约束新准入；已开始任务仍可使用预留落完整证据，真实容量不足才失败。
		if (!existsSync(path) && this.capacity().free_bytes < byteCount)
			throw new RuntimeError("storage_capacity_exhausted", "磁盘已无足够空间写入完整产物", 507);
		// 文件先完整落盘，提交引用后才对读者可见；失败不产生伪造完成记录。
		if (!existsSync(path)) {
			const temporary = `${path}.${randomUUID()}.tmp`;
			writeFileSync(temporary, content, { mode: 0o600, flush: true });
			renameSync(temporary, path);
		}
		this.db.prepare("INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?,NULL)").run(id, kind, byteCount, Date.now());
		this.refArtifact(id, owner);
		return id;
	}
	refArtifact(id: string, owner: string) {
		const row = this.db.prepare("SELECT deleted_at FROM artifacts WHERE id=?").get(id);
		if (
			!row ||
			row.deleted_at !== null ||
			!/^[a-f0-9]{64}$/.test(id) ||
			!existsSync(resolve(this.root, "artifacts", `${id}.json`))
		)
			throw new RuntimeError("artifact_unavailable", "被引用的完整产物不存在或已删除", 410);
		this.db.prepare("INSERT OR IGNORE INTO artifact_refs VALUES(?,?)").run(owner, id);
	}
	readArtifact<T>(id: string): T {
		if (!/^[a-f0-9]{64}$/.test(id)) throw new RuntimeError("artifact_not_found", "产物不存在", 404);
		const row = this.db.prepare("SELECT deleted_at FROM artifacts WHERE id=?").get(id);
		if (!row || row.deleted_at !== null) throw new RuntimeError("artifact_unavailable", "产物不存在或已手动删除", 410);
		const content = readFileSync(resolve(this.root, "artifacts", `${id}.json`), "utf8");
		if (createHash("sha256").update(content).digest("hex") !== id)
			throw new RuntimeError("artifact_corrupt", "产物内容校验失败");
		return JSON.parse(content) as T;
	}
	artifacts(after = "", limit = 50): ArtifactRecord[] {
		return this.db
			.prepare("SELECT * FROM artifacts WHERE id>? ORDER BY id LIMIT ?")
			.all(after, Math.min(500, limit)) as ArtifactRecord[];
	}
	deletionImpact(id: string) {
		return this.db
			.prepare("SELECT owner FROM artifact_refs WHERE artifact_id=? ORDER BY owner")
			.all(id)
			.map((row) => String(row.owner));
	}
	deleteArtifact(id: string, owners: string[], actor: string, reason: string) {
		if (!/^[a-f0-9]{64}$/.test(id) || !this.db.prepare("SELECT id FROM artifacts WHERE id=?").get(id))
			throw new RuntimeError("artifact_not_found", "产物不存在", 404);
		const affected = this.deletionImpact(id);
		if (affected.some((owner) => !owners.includes(owner)))
			throw new RuntimeError("shared_artifact", "删除范围未覆盖全部引用，请查看影响清单");
		this.transaction(() => {
			this.db.prepare("UPDATE artifacts SET deleted_at=? WHERE id=?").run(Date.now(), id);
			this.db.prepare("INSERT OR IGNORE INTO artifact_deletions(artifact_id) VALUES(?)").run(id);
			this.event("storage", id, "artifact_deleted", { affected, actor, reason });
		});
		return { id, affected, completeness: "artifact_deleted" };
	}
	close() {
		this.db.close();
	}
}
