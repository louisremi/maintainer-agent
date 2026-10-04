import { AggregateRoot, DomainError, type RepoRef } from "../../shared-kernel";

export type JobKind = "answer-issue" | "propose-fix" | "review-change-request";
export type JobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "needs-human";

export interface JobTrigger {
	/** The forge event type, or `job:<id>` when another job requested this one. */
	readonly cause: string;
	readonly actorLogin: string;
}

export interface MaintenanceJobProps {
	id: string;
	repo: RepoRef;
	kind: JobKind;
	number: number;
	trigger: JobTrigger;
	/** Data handed over from an earlier job (e.g. the analysis that led to a fix). */
	context: Record<string, string>;
	status: JobStatus;
	/** Times the job was started. */
	attempts: number;
	/** Runs in which the agent produced nothing usable (bounded by the repository policy). */
	agentFailures: number;
	notBefore: Date;
	outcome: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export class JobQueued {
	readonly type = "maintenance.job-queued";
	constructor(
		readonly jobId: string,
		readonly kind: JobKind,
		readonly repoKey: string,
		readonly occurredAt: Date,
	) {}
}
export class JobSucceeded {
	readonly type = "maintenance.job-succeeded";
	constructor(
		readonly jobId: string,
		readonly outcome: string,
		readonly occurredAt: Date,
	) {}
}
export class JobFailed {
	readonly type = "maintenance.job-failed";
	constructor(
		readonly jobId: string,
		readonly reason: string,
		readonly occurredAt: Date,
	) {}
}
export class JobEscalated {
	readonly type = "maintenance.job-escalated";
	constructor(
		readonly jobId: string,
		readonly repoKey: string,
		readonly number: number,
		readonly reason: string,
		readonly occurredAt: Date,
	) {}
}

const TERMINAL: readonly JobStatus[] = ["succeeded", "failed", "needs-human"];

/**
 * One unit of maintenance work on one issue or change request.
 *
 *   queued ─start─► running ─succeed─► succeeded
 *      ▲               ├────fail────► failed
 *      └──retryLater───┤
 *                      └──escalate──► needs-human
 */
export class MaintenanceJob extends AggregateRoot {
	private constructor(private props: MaintenanceJobProps) {
		super();
	}

	static queue(input: {
		id: string;
		repo: RepoRef;
		kind: JobKind;
		number: number;
		trigger: JobTrigger;
		context?: Record<string, string>;
		now: Date;
	}): MaintenanceJob {
		if (!Number.isInteger(input.number) || input.number < 1)
			throw new DomainError("job subject must be a positive number");
		const job = new MaintenanceJob({
			id: input.id,
			repo: input.repo,
			kind: input.kind,
			number: input.number,
			trigger: input.trigger,
			context: { ...(input.context ?? {}) },
			status: "queued",
			attempts: 0,
			agentFailures: 0,
			notBefore: input.now,
			outcome: null,
			createdAt: input.now,
			updatedAt: input.now,
		});
		job.record(new JobQueued(job.id, job.kind, job.repo.key, input.now));
		return job;
	}

	static restore(props: MaintenanceJobProps): MaintenanceJob {
		return new MaintenanceJob({ ...props, context: { ...props.context } });
	}

	start(now: Date): void {
		this.expect("queued", "start");
		if (now < this.props.notBefore) throw new DomainError("job is not due yet");
		this.props = {
			...this.props,
			status: "running",
			attempts: this.props.attempts + 1,
			updatedAt: now,
		};
	}

	succeed(outcome: string, now: Date): void {
		this.expect("running", "succeed");
		this.props = {
			...this.props,
			status: "succeeded",
			outcome,
			updatedAt: now,
		};
		this.record(new JobSucceeded(this.id, outcome, now));
	}

	fail(reason: string, now: Date): void {
		this.expect("running", "fail");
		this.props = {
			...this.props,
			status: "failed",
			outcome: reason,
			updatedAt: now,
		};
		this.record(new JobFailed(this.id, reason, now));
	}

	/** The agent could not produce something usable: a maintainer must decide. */
	escalate(reason: string, now: Date): void {
		this.expect("running", "escalate");
		this.props = {
			...this.props,
			status: "needs-human",
			outcome: reason,
			updatedAt: now,
		};
		this.record(
			new JobEscalated(this.id, this.repo.key, this.number, reason, now),
		);
	}

	/**
	 * A transient failure: run again later, unless the attempts are used up, in
	 * which case the job fails. Returns whether a retry was scheduled.
	 */
	retryLater(
		reason: string,
		maxAttempts: number,
		delayMs: number,
		now: Date,
	): boolean {
		this.expect("running", "retry");
		if (this.props.attempts >= maxAttempts) {
			this.fail(
				`${reason} (gave up after ${this.props.attempts} attempts)`,
				now,
			);
			return false;
		}
		this.props = {
			...this.props,
			status: "queued",
			outcome: reason,
			notBefore: new Date(now.getTime() + delayMs),
			updatedAt: now,
		};
		return true;
	}

	/**
	 * The agent produced nothing usable. Runs again (immediately) while the
	 * policy allows more agent attempts, otherwise the job fails. Returns
	 * whether it will run again.
	 */
	agentFailed(reason: string, maxAgentAttempts: number, now: Date): boolean {
		this.expect("running", "record an agent failure for");
		const failures = this.props.agentFailures + 1;
		if (failures >= maxAgentAttempts) {
			this.props = { ...this.props, agentFailures: failures };
			this.fail(`${reason} (agent gave up after ${failures} attempts)`, now);
			return false;
		}
		this.props = {
			...this.props,
			status: "queued",
			agentFailures: failures,
			outcome: reason,
			notBefore: now,
			updatedAt: now,
		};
		return true;
	}

	/** Whether the next agent failure exhausts the policy's attempts. */
	isLastAgentAttempt(maxAgentAttempts: number): boolean {
		return this.props.agentFailures + 1 >= maxAgentAttempts;
	}

	/** The process stopped while the job ran (restart): run it again once. */
	recoverAfterCrash(now: Date): void {
		if (this.props.status !== "running") return;
		this.props = {
			...this.props,
			status: "queued",
			notBefore: now,
			outcome: "interrupted by a restart",
			updatedAt: now,
		};
	}

	private expect(status: JobStatus, action: string): void {
		if (this.props.status !== status) {
			throw new DomainError(
				`cannot ${action} a job that is ${this.props.status}`,
			);
		}
	}

	get isActive(): boolean {
		return !TERMINAL.includes(this.props.status);
	}
	get id(): string {
		return this.props.id;
	}
	get repo(): RepoRef {
		return this.props.repo;
	}
	get kind(): JobKind {
		return this.props.kind;
	}
	get number(): number {
		return this.props.number;
	}
	get trigger(): JobTrigger {
		return this.props.trigger;
	}
	get context(): Readonly<Record<string, string>> {
		return this.props.context;
	}
	get status(): JobStatus {
		return this.props.status;
	}
	get attempts(): number {
		return this.props.attempts;
	}
	get agentFailures(): number {
		return this.props.agentFailures;
	}
	get notBefore(): Date {
		return this.props.notBefore;
	}
	get outcome(): string | null {
		return this.props.outcome;
	}
	get createdAt(): Date {
		return this.props.createdAt;
	}
	get updatedAt(): Date {
		return this.props.updatedAt;
	}

	snapshot(): Readonly<MaintenanceJobProps> {
		return { ...this.props, context: { ...this.props.context } };
	}
}
