import type {
	Clock,
	EventPublisher,
	IdGenerator,
	Logger,
	UnitOfWork,
} from "../../shared-kernel";
import {
	DuplicateJobPolicy,
	type JobKind,
	MaintenanceJob,
	type RepositoryPolicy,
} from "../domain";
import type { JobHandler, JobResult } from "./job-handler";
import type {
	ForgeAccess,
	MaintenanceJobRepository,
	ModelHealth,
} from "./ports";
import type { RepositoryPolicies } from "./repository-policies";

export interface RunNextJobDeps {
	readonly jobs: MaintenanceJobRepository;
	readonly forge: ForgeAccess;
	readonly policies: RepositoryPolicies;
	readonly handlers: readonly JobHandler[];
	readonly modelHealth: ModelHealth;
	readonly ids: IdGenerator;
	readonly clock: Clock;
	readonly uow: UnitOfWork;
	readonly events: EventPublisher;
	readonly log: Logger;
	/** Infrastructure retries before a job fails, and the base back-off. */
	readonly maxRuns: number;
	readonly retryDelayMs: number;
}

export type RunNextJobResult =
	| { readonly kind: "idle" }
	| { readonly kind: "model-unavailable" }
	| {
			readonly kind: "ran";
			readonly jobId: string;
			readonly status: MaintenanceJob["status"];
	  };

function maxAgentAttempts(kind: JobKind, policy: RepositoryPolicy): number {
	switch (kind) {
		case "answer-issue":
			return policy.answer.maxAttempts;
		case "propose-fix":
			return policy.fix.maxAttempts;
		case "review-change-request":
			return policy.review.maxAttempts;
	}
}

/**
 * Claims the oldest due job and carries it out with the handler for its
 * kind, then records the outcome on the job. Nothing is claimed while the
 * model is unavailable, so jobs simply wait.
 */
export class RunNextJob {
	private readonly byKind: ReadonlyMap<JobKind, JobHandler>;

	constructor(private readonly d: RunNextJobDeps) {
		this.byKind = new Map(d.handlers.map((h) => [h.kind, h]));
	}

	async execute(): Promise<RunNextJobResult> {
		if (!(await this.d.modelHealth.isAvailable()))
			return { kind: "model-unavailable" };
		const job = await this.d.uow.run(() =>
			this.d.jobs.claimNext(this.d.clock.now()),
		);
		if (!job) return { kind: "idle" };
		this.d.log.info("job started", {
			jobId: job.id,
			repo: job.repo.key,
			kind: job.kind,
			number: job.number,
			attempt: job.attempts,
		});

		let followUp: MaintenanceJob | null = null;
		try {
			const { result, policy } = await this.runHandler(job);
			followUp = await this.apply(job, result, policy);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this.d.log.error("job crashed", { jobId: job.id, reason });
			if (job.status === "running")
				this.retry(job, `unexpected error: ${reason}`);
		}

		await this.d.uow.run(async () => {
			await this.d.jobs.save(job);
			if (followUp) await this.d.jobs.save(followUp);
		});
		await this.d.events.publish([
			...job.pullEvents(),
			...(followUp?.pullEvents() ?? []),
		]);
		this.d.log.info("job finished", {
			jobId: job.id,
			status: job.status,
			outcome: job.outcome,
		});
		return { kind: "ran", jobId: job.id, status: job.status };
	}

	private async runHandler(
		job: MaintenanceJob,
	): Promise<{ result: JobResult; policy: RepositoryPolicy | null }> {
		const handler = this.byKind.get(job.kind);
		if (!handler)
			return {
				result: { kind: "escalate", reason: `no handler for ${job.kind}` },
				policy: null,
			};
		const session = await this.d.forge.session(job.repo);
		if (!session)
			return {
				result: {
					kind: "succeeded",
					outcome: "repository no longer watched; dropped",
				},
				policy: null,
			};
		const defaultBranch = await session.getDefaultBranch();
		const lookup = await this.d.policies.load(session, defaultBranch.name);
		if (!lookup.ok)
			return {
				result: {
					kind: "succeeded",
					outcome: lookup.source
						? `invalid policy in ${lookup.source}; dropped`
						: "repository no longer configured; dropped",
				},
				policy: null,
			};
		const result = await handler.handle({
			job,
			session,
			policy: lookup.policy,
			models: lookup.models,
			defaultBranch,
			isLastAttempt: job.isLastAgentAttempt(
				maxAgentAttempts(job.kind, lookup.policy),
			),
		});
		return { result, policy: lookup.policy };
	}

	private async apply(
		job: MaintenanceJob,
		result: JobResult,
		policy: RepositoryPolicy | null,
	): Promise<MaintenanceJob | null> {
		const now = this.d.clock.now();
		switch (result.kind) {
			case "succeeded": {
				job.succeed(result.outcome, now);
				if (!result.followUp) return null;
				const active = await this.d.jobs.listActive(job.repo);
				if (
					!DuplicateJobPolicy.allows(result.followUp.kind, job.number, active)
				)
					return null;
				return MaintenanceJob.queue({
					id: this.d.ids.next(),
					repo: job.repo,
					kind: result.followUp.kind,
					number: job.number,
					trigger: {
						cause: `job:${job.id}`,
						actorLogin: job.trigger.actorLogin,
					},
					context: result.followUp.context,
					now,
				});
			}
			case "agent-failed":
				job.agentFailed(
					result.reason,
					policy ? maxAgentAttempts(job.kind, policy) : 1,
					now,
				);
				return null;
			case "transient":
				this.retry(job, result.reason);
				return null;
			case "escalate":
				job.escalate(result.reason, now);
				return null;
		}
	}

	private retry(job: MaintenanceJob, reason: string): void {
		const delay = this.d.retryDelayMs * 2 ** Math.max(0, job.attempts - 1);
		job.retryLater(reason, this.d.maxRuns, delay, this.d.clock.now());
	}
}
