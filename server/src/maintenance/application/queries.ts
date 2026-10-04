import type { Clock, DeliveryLog, Logger } from "../../shared-kernel";
import type { MaintenanceJob } from "../domain";
import type { MaintenanceJobRepository, WorkspacePreparer } from "./ports";

export interface JobSummary {
	readonly id: string;
	readonly repo: string;
	readonly kind: string;
	readonly number: number;
	readonly status: string;
	readonly attempts: number;
	readonly outcome: string | null;
	readonly trigger: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export function toJobSummary(j: MaintenanceJob): JobSummary {
	return {
		id: j.id,
		repo: j.repo.key,
		kind: j.kind,
		number: j.number,
		status: j.status,
		attempts: j.attempts,
		outcome: j.outcome,
		trigger: `${j.trigger.cause} by ${j.trigger.actorLogin}`,
		createdAt: j.createdAt.toISOString(),
		updatedAt: j.updatedAt.toISOString(),
	};
}

export class ListRecentJobs {
	constructor(private readonly jobs: MaintenanceJobRepository) {}

	async execute(limit = 50): Promise<JobSummary[]> {
		return (await this.jobs.listRecent(limit)).map(toJobSummary);
	}
}

/** On start-up: jobs that were running when the process stopped run again. */
export class RecoverInterruptedJobs {
	constructor(
		private readonly jobs: MaintenanceJobRepository,
		private readonly clock: Clock,
		private readonly log: Logger,
	) {}

	async execute(): Promise<number> {
		const running = await this.jobs.listByStatus("running");
		for (const j of running) {
			j.recoverAfterCrash(this.clock.now());
			await this.jobs.save(j);
		}
		if (running.length)
			this.log.warn("requeued interrupted jobs", { count: running.length });
		return running.length;
	}
}

/** Deletes finished jobs, their kept files, and old delivery records. */
export class PruneHistory {
	constructor(
		private readonly jobs: MaintenanceJobRepository,
		private readonly workspaces: WorkspacePreparer,
		private readonly deliveries: DeliveryLog,
		private readonly clock: Clock,
		private readonly retentionMs: number,
	) {}

	async execute(): Promise<{ jobs: number; deliveries: number }> {
		const before = new Date(this.clock.now().getTime() - this.retentionMs);
		const ids = await this.jobs.deleteFinishedBefore(before);
		for (const id of ids) await this.workspaces.dispose(id);
		const deliveries = await this.deliveries.prune(before);
		return { jobs: ids.length, deliveries };
	}
}
