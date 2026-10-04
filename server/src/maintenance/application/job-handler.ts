import type { JobKind, MaintenanceJob, RepositoryPolicy } from "../domain";
import type { ForgeSession } from "./ports";

export type JobResult =
	| {
			readonly kind: "succeeded";
			readonly outcome: string;
			/** Another job this one asks for (e.g. a fix after an answer). */
			readonly followUp?: {
				readonly kind: JobKind;
				readonly context: Record<string, string>;
			};
	  }
	/** The agent produced nothing usable this time: try again within the policy's attempts. */
	| {
			readonly kind: "agent-failed";
			readonly reason: string;
			readonly explanation?: string;
	  }
	/** Infrastructure failure (model, Docker, forge API): retry later with back-off. */
	| { readonly kind: "transient"; readonly reason: string }
	/** Stop and ask a human (output held back, change rejected...). */
	| { readonly kind: "escalate"; readonly reason: string };

export interface JobRunContext {
	readonly job: MaintenanceJob;
	readonly session: ForgeSession;
	readonly policy: RepositoryPolicy;
	readonly defaultBranch: { readonly name: string; readonly sha: string };
	/** True on the last attempt the policy allows: handlers report instead of retrying. */
	readonly isLastAttempt: boolean;
}

/** Carries out one kind of maintenance job. */
export interface JobHandler {
	readonly kind: JobKind;
	handle(ctx: JobRunContext): Promise<JobResult>;
}
