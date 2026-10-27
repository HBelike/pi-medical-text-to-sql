export type ResourceScope = { mode?: "online" | "eval"; experiment_id?: string; variant_id?: string };

// 两级公平选择器同时用于业务准入和模型出口；空闲份额可借用，在途工作不抢占。
export class FairSelector {
	private onlineBurst = 0;
	private lastExperiment = "";
	private readonly lastVariants = new Map<string, string>();
	choose<T>(
		items: readonly T[],
		scope: (item: T) => ResourceScope,
		active: readonly ResourceScope[],
		capacity: number,
	): T | undefined {
		const online = items.filter((item) => scope(item).mode !== "eval");
		const evaluation = items.filter((item) => scope(item).mode === "eval");
		if (!items.length) return undefined;
		let takeEval = online.length === 0;
		if (online.length && evaluation.length) {
			const evalActive = active.filter((item) => item.mode === "eval").length;
			const onlineActive = active.length - evalActive;
			takeEval = capacity > 1 && evalActive === 0 && onlineActive > 0;
			if (!(capacity > 1 && onlineActive === 0 && evalActive > 0)) takeEval ||= this.onlineBurst >= 4;
		}
		if (!takeEval || !evaluation.length) {
			this.onlineBurst++;
			return online[0];
		}
		this.onlineBurst = 0;
		const experiments = [...new Set(evaluation.map((item) => scope(item).experiment_id ?? "unscoped"))];
		const prior = experiments.indexOf(this.lastExperiment);
		const experiment = experiments[(prior + 1) % experiments.length];
		this.lastExperiment = experiment;
		const group = evaluation.filter((item) => (scope(item).experiment_id ?? "unscoped") === experiment);
		const variants = [...new Set(group.map((item) => scope(item).variant_id ?? "default"))];
		const variant = variants[(variants.indexOf(this.lastVariants.get(experiment) ?? "") + 1) % variants.length];
		this.lastVariants.set(experiment, variant);
		return group.find((item) => (scope(item).variant_id ?? "default") === variant);
	}
}

type Pending = { scope: ResourceScope; start: () => void; admission?: () => number; onAdmit?: () => void };
export type ResourceAdmission = { waitMs: () => number; admitted: () => void };
export type ResourceLease = { hold: (operationId: string) => void };

// 运行取消只传给实际工作；未知远端调用将许可转为持久账本对应的保留占用。
export class ResourcePool {
	private readonly queue: Pending[] = [];
	private readonly running = new Map<symbol, ResourceScope>();
	private readonly held = new Map<string, ResourceScope>();
	private readonly releasedBeforeExit = new Set<string>();
	private readonly selector = new FairSelector();
	private admissionTimer?: ReturnType<typeof setTimeout>;
	private peak = 0;
	private readonly concurrency: number;
	private readonly waitTimeoutMs: number;
	private readonly options: { maxPending?: number; onlineReserve?: number };
	constructor(
		concurrency: number,
		waitTimeoutMs = 300000,
		options: { maxPending?: number; onlineReserve?: number } = {},
	) {
		this.concurrency = concurrency;
		this.waitTimeoutMs = waitTimeoutMs;
		this.options = options;
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error("资源并发必须为1～10");
	}
	stats() {
		return { active: this.running.size + this.held.size, pending: this.queue.length, peak: this.peak };
	}
	reservations() {
		return [...this.held.keys()];
	}
	restoreHold(id: string, scope: ResourceScope = {}) {
		this.held.set(id, scope);
		this.peak = Math.max(this.peak, this.stats().active);
	}
	releaseHold(id: string) {
		if (!this.held.delete(id)) this.releasedBeforeExit.add(id);
		this.drain();
	}
	private drain() {
		if (this.admissionTimer) clearTimeout(this.admissionTimer);
		while (this.stats().active < this.concurrency && this.queue.length) {
			// 速率门只筛选合格候选，不占模型在途许可；调度与预留在同一同步步骤完成。
			let minimumWait = Infinity;
			const eligible = this.queue.filter((item) => {
				const wait = item.admission?.() ?? 0;
				minimumWait = Math.min(minimumWait, wait);
				return wait <= 0;
			});
			if (!eligible.length) {
				this.admissionTimer = setTimeout(() => this.drain(), Math.max(1, Math.min(minimumWait, 60000)));
				return;
			}
			const selected = this.selector.choose(
				eligible,
				(item) => item.scope,
				[...this.running.values(), ...this.held.values()],
				this.concurrency,
			)!;
			this.queue.splice(this.queue.indexOf(selected), 1);
			selected.onAdmit?.();
			selected.start();
		}
	}
	async run<T>(
		operation: (lease: ResourceLease) => Promise<T>,
		signal: AbortSignal,
		priority: number | ResourceScope = 1,
		admission?: ResourceAdmission,
	): Promise<T> {
		signal.throwIfAborted();
		const scope: ResourceScope = typeof priority === "number" ? { mode: priority > 0 ? "online" : "eval" } : priority;
		const max = this.options.maxPending ?? 100;
		const evalLimit = max - (this.options.onlineReserve ?? Math.min(20, Math.floor(max / 5)));
		if (
			this.queue.length >= max ||
			(scope.mode === "eval" && this.queue.filter((item) => item.scope.mode === "eval").length >= evalLimit)
		)
			throw new Error("资源队列已满");
		return new Promise<T>((accept, reject) => {
			const remove = (error: Error) => {
				const index = this.queue.indexOf(entry);
				if (index < 0) return;
				this.queue.splice(index, 1);
				cleanup();
				this.drain();
				reject(error);
			};
			const abort = () => remove(signal.reason instanceof Error ? signal.reason : new Error("任务已停止"));
			const timer = setTimeout(() => remove(new Error("资源排队超时")), this.waitTimeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
			};
			const entry: Pending = {
				scope,
				admission: admission?.waitMs,
				onAdmit: admission?.admitted,
				start: () => {
					cleanup();
					if (signal.aborted) {
						reject(signal.reason);
						return;
					}
					const id = Symbol();
					this.running.set(id, scope);
					this.peak = Math.max(this.peak, this.stats().active);
					let retained: string | undefined;
					const finish = () => {
						this.running.delete(id);
						if (retained && !this.releasedBeforeExit.delete(retained)) this.held.set(retained, scope);
						this.drain();
					};
					Promise.resolve()
						.then(() =>
							operation({
								hold: (operationId) => {
									retained = operationId;
								},
							}),
						)
						.then(
							(value) => {
								finish();
								accept(value);
							},
							(error) => {
								finish();
								reject(error);
							},
						);
				},
			};
			this.queue.push(entry);
			signal.addEventListener("abort", abort, { once: true });
			this.drain();
		});
	}
}
