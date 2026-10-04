import type { JobKind, MaintenanceJob } from "./maintenance-job";

/** At most one active job per repository, kind and issue/change request. */
export const DuplicateJobPolicy = {
	allows(
		kind: JobKind,
		number: number,
		activeJobsForRepo: readonly MaintenanceJob[],
	): boolean {
		return !activeJobsForRepo.some(
			(j) => j.isActive && j.kind === kind && j.number === number,
		);
	},
};
