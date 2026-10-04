import { describe, expect, it } from "vitest";
import {
	DuplicateJobPolicy,
	MaintenanceJob,
} from "../../src/maintenance/domain";
import { DomainError } from "../../src/shared-kernel";
import { REPO, T0 } from "../support/builders";

const later = (ms: number) => new Date(T0.getTime() + ms);

function queued() {
	return MaintenanceJob.queue({
		id: "j1",
		repo: REPO,
		kind: "answer-issue",
		number: 3,
		trigger: { cause: "issue-opened", actorLogin: "alice" },
		now: T0,
	});
}

describe("MaintenanceJob", () => {
	it("runs from queued to succeeded", () => {
		const j = queued();
		j.start(T0);
		expect(j.status).toBe("running");
		expect(j.attempts).toBe(1);
		j.succeed("answered", T0);
		expect(j.isActive).toBe(false);
		expect(j.pullEvents().map((e) => e.type)).toEqual([
			"maintenance.job-queued",
			"maintenance.job-succeeded",
		]);
	});

	it("rejects illegal transitions", () => {
		const j = queued();
		expect(() => j.succeed("x", T0)).toThrow(DomainError);
		j.start(T0);
		expect(() => j.start(T0)).toThrow(DomainError);
		j.fail("boom", T0);
		expect(() => j.escalate("x", T0)).toThrow(DomainError);
	});

	it("retries transient failures with a delay, then fails", () => {
		const j = queued();
		j.start(T0);
		expect(j.retryLater("model down", 2, 1000, T0)).toBe(true);
		expect(j.status).toBe("queued");
		expect(() => j.start(T0)).toThrow(/not due/);
		j.start(later(1000));
		expect(j.retryLater("model down", 2, 1000, later(1000))).toBe(false);
		expect(j.status).toBe("failed");
	});

	it("counts agent failures against the policy", () => {
		const j = queued();
		j.start(T0);
		expect(j.isLastAgentAttempt(2)).toBe(false);
		expect(j.agentFailed("no answer", 2, T0)).toBe(true);
		j.start(T0);
		expect(j.isLastAgentAttempt(2)).toBe(true);
		expect(j.agentFailed("no answer", 2, T0)).toBe(false);
		expect(j.status).toBe("failed");
		expect(j.agentFailures).toBe(2);
	});

	it("escalates to needs-human with an event carrying the subject", () => {
		const j = queued();
		j.start(T0);
		j.escalate("held", T0);
		expect(j.status).toBe("needs-human");
		const ev = j.pullEvents().at(-1) as unknown as {
			type: string;
			number: number;
			repoKey: string;
		};
		expect(ev).toMatchObject({
			type: "maintenance.job-escalated",
			number: 3,
			repoKey: REPO.key,
		});
	});

	it("requeues a job interrupted by a restart", () => {
		const j = queued();
		j.start(T0);
		j.recoverAfterCrash(later(5));
		expect(j.status).toBe("queued");
	});

	it("rejects invalid subjects", () => {
		expect(() =>
			MaintenanceJob.queue({
				id: "x",
				repo: REPO,
				kind: "answer-issue",
				number: 0,
				trigger: { cause: "x", actorLogin: "y" },
				now: T0,
			}),
		).toThrow(DomainError);
	});
});

describe("DuplicateJobPolicy", () => {
	it("allows one active job per kind and subject", () => {
		const j = queued();
		expect(DuplicateJobPolicy.allows("answer-issue", 3, [j])).toBe(false);
		expect(DuplicateJobPolicy.allows("propose-fix", 3, [j])).toBe(true);
		expect(DuplicateJobPolicy.allows("answer-issue", 4, [j])).toBe(true);
		j.start(T0);
		j.succeed("done", T0);
		expect(DuplicateJobPolicy.allows("answer-issue", 3, [j])).toBe(true);
	});
});
