import type { Logger } from "../../shared-kernel";
import { FixEligibility, Labels, Markers } from "../domain";
import type { JobHandler, JobResult, JobRunContext } from "./job-handler";
import type {
	AgentRunner,
	ModelCatalog,
	OutputSanitizer,
	WorkspacePreparer,
} from "./ports";
import { buildTask, footer } from "./task-builder";

export interface AnswerIssueDeps {
	readonly workspaces: WorkspacePreparer;
	readonly agents: AgentRunner;
	readonly sanitizer: OutputSanitizer;
	readonly models: ModelCatalog;
	readonly stepLimit: number;
	readonly log: Logger;
}

/**
 * Answers a new issue with one comment. For bugs and feature requests the
 * answer is the analysis; a change is then proposed automatically for
 * maintainers, or after a maintainer adds `agent-fix` for everyone else.
 */
export class AnswerIssue implements JobHandler {
	readonly kind = "answer-issue" as const;

	constructor(private readonly d: AnswerIssueDeps) {}

	async handle(ctx: JobRunContext): Promise<JobResult> {
		const { job, session, policy } = ctx;
		const issue = await session.getIssue(job.number);
		if (!issue?.isOpen)
			return {
				kind: "succeeded",
				outcome: "issue closed or gone; nothing to do",
			};
		if (issue.labels.includes(Labels.optOut))
			return { kind: "succeeded", outcome: `labelled ${Labels.optOut}` };

		const comments = await session.listIssueComments(job.number, 100);
		if (comments.some((c) => c.isOwn && c.body.includes(Markers.answer))) {
			return { kind: "succeeded", outcome: "already answered" };
		}

		const git = await session.gitAccess("read");
		const ws = await this.d.workspaces.prepare({
			jobId: job.id,
			mode: "issue",
			git,
			baseSha: ctx.defaultBranch.sha,
			baseBranch: ctx.defaultBranch.name,
		});
		try {
			await this.d.workspaces.writeTask(
				ws,
				buildTask({
					mode: "issue",
					session,
					policy,
					defaultBranch: ctx.defaultBranch,
					subject: issue,
					comments,
					sha: ws.baseSha,
				}),
			);
			const run = await this.d.agents.answerIssue(ws, {
				model: this.d.models.modelFor(job.kind),
				stepLimit: this.d.stepLimit,
				extraEgress: [],
			});
			if (!run.ok)
				return run.transient
					? { kind: "transient", reason: run.reason }
					: { kind: "agent-failed", reason: run.reason };

			const verdict = run.value;
			const [answer] = await this.d.sanitizer.sanitize([verdict.answer], {
				webUrl: session.webUrl,
				extraLinks: policy.links,
			});
			if (!answer || answer.held) {
				return {
					kind: "escalate",
					reason: `answer held by the sanitiser: ${answer?.reasons.join("; ") ?? "no output"}`,
				};
			}

			// A maintainer's `agent-fix` label (already present) queues the fix by itself.
			const decision = issue.labels.includes(Labels.fix)
				? { kind: "none" as const }
				: FixEligibility.decide(verdict, issue.authorRole, policy);
			const cr = session.terms.changeRequest;
			const note =
				decision.kind === "propose"
					? `I am now preparing a draft ${cr} for this and will link it here.`
					: decision.kind === "suggest-label"
						? `A maintainer can add the \`${Labels.fix}\` label to have me propose this change as a ${cr}.`
						: "";
			await session.comment(
				job.number,
				[Markers.answer, answer.text.trim(), footer(note)].join("\n\n"),
			);

			return decision.kind === "propose"
				? {
						kind: "succeeded",
						outcome: `answered (${verdict.kind}); fix requested`,
						followUp: {
							kind: "propose-fix",
							context: { analysis: answer.text, verdictKind: verdict.kind },
						},
					}
				: { kind: "succeeded", outcome: `answered (${verdict.kind})` };
		} finally {
			await this.d.workspaces.release(ws.id);
		}
	}
}
