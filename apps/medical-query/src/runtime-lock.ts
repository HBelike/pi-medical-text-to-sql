import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Owner = { pid: number; token: string; startedAt?: string };

/** Pi 没有跨进程存储锁，本地 PID 锁确保同一 SQLite 只交给一个运行实例。 */
export class StorageOwnerError extends Error {
	readonly code = "storage_in_use";
	readonly statusCode = 409;
	constructor(message: string) {
		super(message);
		this.name = "StorageOwnerError";
	}
}

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** EPERM 也表示进程存在；无法判定时拒绝接管，不能冒险运行第二个 owner。 */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isCode(error, "ESRCH")) return false;
		if (isCode(error, "EPERM")) return true;
		throw error;
	}
}

function readOwner(path: string): Owner | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Owner>;
		if (!Number.isSafeInteger(value.pid) || value.pid! < 1 || typeof value.token !== "string" || !value.token)
			throw new Error("invalid owner");
		return value as Owner;
	} catch (error) {
		if (isCode(error, "ENOENT")) return undefined;
		throw new StorageOwnerError("存储锁尚未写完或已损坏，未自动删除；请确认无运行实例后处理锁文件");
	}
}

/** 同步完成创建和元数据写入，缩短其他启动者看见空锁文件的窗口。 */
function createOwner(path: string, owner: Owner): boolean {
	let fd: number;
	try {
		fd = openSync(path, "wx", 0o600);
	} catch (error) {
		if (isCode(error, "EEXIST")) return false;
		throw error;
	}
	try {
		writeFileSync(fd, JSON.stringify(owner));
	} catch (error) {
		closeSync(fd);
		unlinkSync(path);
		throw error;
	}
	closeSync(fd);
	return true;
}

export function acquireRuntimeLock(storagePath: string): () => void {
	const path = `${resolve(storagePath)}.owner`;
	mkdirSync(dirname(path), { recursive: true });
	// 随机实例身份与启动时刻随锁保存；PID重用时保守拒绝，不抢占仍存活的旧实例。
	const owner: Owner = {
		pid: process.pid,
		token: randomUUID(),
		startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
	};
	if (!createOwner(path, owner)) {
		const prior = readOwner(path);
		if (prior && alive(prior.pid)) throw new StorageOwnerError(`存储正由进程 ${prior.pid} 使用`);
		// 回收者互斥，防止两个启动者都判断旧 PID 已死后删除对方刚创建的新锁。
		const reclaimPath = `${path}.reclaim`;
		if (!createOwner(reclaimPath, owner)) {
			throw new StorageOwnerError("另一个启动过程正在恢复存储锁；若该恢复进程已退出，请确认后清理恢复标记");
		}
		try {
			const current = readOwner(path);
			if (current && alive(current.pid)) throw new StorageOwnerError(`存储正由进程 ${current.pid} 使用`);
			if (current) unlinkSync(path);
			if (!createOwner(path, owner)) throw new StorageOwnerError("另一个进程已取得存储锁，请稍后重试");
		} finally {
			unlinkSync(reclaimPath);
		}
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const current = readOwner(path);
		// 只释放本实例取得的锁，避免关闭旧实例时影响其他实例。
		if (current?.pid === owner.pid && current.token === owner.token) unlinkSync(path);
	};
}
