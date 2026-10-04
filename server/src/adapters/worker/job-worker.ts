import type { Logger } from "../../shared-kernel";

export interface JobRunnerPort {
	execute(): Promise<
		{ kind: "idle" } | { kind: "model-unavailable" } | { kind: "ran" }
	>;
}

export interface PeriodicTask {
	readonly name: string;
	readonly everyMs: number;
	run(): Promise<unknown>;
}

/**
 * Inbound adapter that drives the job queue: up to N loops each run one job
 * at a time; when there is nothing to do they sleep. Periodic housekeeping
 * tasks run on their own timers.
 */
export class JobWorker {
	private running = false;
	private loops: Promise<void>[] = [];
	private timers: NodeJS.Timeout[] = [];
	private wake: (() => void)[] = [];

	constructor(
		private readonly runner: JobRunnerPort,
		private readonly concurrency: number,
		private readonly log: Logger,
		private readonly idleMs = 5_000,
		private readonly modelDownMs = 60_000,
	) {}

	start(periodic: readonly PeriodicTask[] = []): void {
		if (this.running) return;
		this.running = true;
		for (let i = 0; i < this.concurrency; i++) this.loops.push(this.loop(i));
		for (const t of periodic) {
			const tick = () =>
				t.run().catch((err: Error) =>
					this.log.warn("periodic task failed", {
						task: t.name,
						reason: err.message,
					}),
				);
			this.timers.push(setInterval(tick, t.everyMs));
			void tick();
		}
	}

	/** Call when new work was queued, to skip the idle wait. */
	poke(): void {
		for (const w of this.wake.splice(0)) w();
	}

	async stop(): Promise<void> {
		this.running = false;
		for (const t of this.timers) clearInterval(t);
		this.poke();
		await Promise.all(this.loops);
	}

	private async loop(index: number): Promise<void> {
		while (this.running) {
			let wait = 0;
			try {
				const r = await this.runner.execute();
				if (r.kind === "idle") wait = this.idleMs;
				if (r.kind === "model-unavailable") wait = this.modelDownMs;
			} catch (err) {
				this.log.error("worker loop error", {
					loop: index,
					reason: (err as Error).message,
				});
				wait = this.idleMs;
			}
			if (wait && this.running)
				await new Promise<void>((resolve) => {
					const t = setTimeout(resolve, wait);
					this.wake.push(() => {
						clearTimeout(t);
						resolve();
					});
				});
		}
	}
}
