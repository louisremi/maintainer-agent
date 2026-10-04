import type { Logger } from "../../shared-kernel";
import { DiffHunks, InlineCommentPlacement, Labels, Markers } from "../domain";
import type { JobHandler, JobResult, JobRunContext } from "./job-handler";
import type {
	AgentRunner,
	ModelCatalog,
	OutputSanitizer,
	WorkspacePreparer,
} from "./ports";
import { buildTask, footer } from "./task-builder";

export interface ReviewChangeRequestDeps {
	readonly workspaces: WorkspacePreparer;
	readonly agents: AgentRunner;
	readonly sanitizer: OutputSanitizer;
	readonly models: ModelCatalog;
	readonly stepLimit: number;
	readonly log: Logger;
}

/**
 * Reviews a change request with one review made of a summary and inline
 * comments. Reviews only ever comment: the agent never approves, never
 * requests changes, and never merges.
 */
export class ReviewChangeRequest implements JobHandler {
	readonly kind = "review-change-request" as const;

	constructor(private readonly d: ReviewChangeRequestDeps) {}

	async handle(ctx: JobRunContext): Promise<JobResult> {
		const { job, session, policy } = ctx;
		const cr = await session.getChangeRequest(job.number);
		if (!cr?.isOpen)
			return {
				kind: "succeeded",
				outcome: "change request closed or gone; nothing to do",
			};
		if (cr.isDraft && job.trigger.cause !== "change-request-labeled")
			return { kind: "succeeded", outcome: "change request is a draft" };

		const ws = await this.d.workspaces.prepare({
			jobId: job.id,
			mode: "review",
			git: await session.gitAccess("read"),
			baseSha: cr.baseSha,
			baseBranch: cr.baseBranch,
			head: { fetchRef: cr.headFetchRef, sha: cr.headSha },
		});
		try {
			const hunks = DiffHunks.parse(ws.diff ?? "");
			if (hunks.files.length === 0) {
				return { kind: "succeeded", outcome: "empty diff; nothing to review" };
			}
			const summaryOnly = hunks.totalChangedLines > policy.review.maxDiffLines;
			const comments = await session.listIssueComments(job.number, 50);
			await this.d.workspaces.writeTask(
				ws,
				buildTask({
					mode: "review",
					session,
					policy,
					defaultBranch: ctx.defaultBranch,
					subject: cr,
					comments,
					sha: cr.headSha,
					review: {
						baseSha: cr.baseSha,
						headSha: cr.headSha,
						maxComments: summaryOnly ? 0 : policy.review.maxComments,
						summaryOnly,
						changedLines: hunks.totalChangedLines,
					},
				}),
			);
			const run = await this.d.agents.reviewChange(ws, {
				model: this.d.models.modelFor(job.kind),
				stepLimit: this.d.stepLimit,
				extraEgress: [],
			});
			if (!run.ok)
				return run.transient
					? { kind: "transient", reason: run.reason }
					: { kind: "agent-failed", reason: run.reason };

			const placed = InlineCommentPlacement.place(
				run.value,
				hunks,
				summaryOnly ? 0 : policy.review.maxComments,
			);
			const texts = await this.d.sanitizer.sanitize(
				[placed.summary, ...placed.comments.map((c) => c.body)],
				{
					webUrl: session.webUrl,
					extraLinks: policy.links,
				},
			);
			const held = texts.filter((t) => t.held);
			if (texts.length !== placed.comments.length + 1 || held.length) {
				return {
					kind: "escalate",
					reason: `review held by the sanitiser: ${held.flatMap((t) => t.reasons).join("; ")}`,
				};
			}
			const [summary, ...bodies] = texts;
			if (!summary) {
				return {
					kind: "escalate",
					reason: "the sanitiser returned no summary",
				};
			}
			const note = summaryOnly
				? `This change touches ${hunks.totalChangedLines} lines, more than this repository's review limit, so this is a summary only.`
				: `A maintainer can add the \`${Labels.rereview}\` label to ask for a fresh review after new commits.`;
			const review = await session.postReview(job.number, {
				headSha: cr.headSha,
				summary: [Markers.review, summary.text.trim(), footer(note)].join(
					"\n\n",
				),
				comments: placed.comments.map((c, i) => ({
					...c,
					body: bodies[i]?.text.trim() ?? c.body,
				})),
			});
			if (job.trigger.cause === "change-request-labeled") {
				await session
					.removeLabel(job.number, Labels.rereview)
					.catch(() => undefined);
			}
			this.d.log.info("review posted", {
				jobId: job.id,
				repo: job.repo.key,
				number: job.number,
				comments: placed.comments.length,
				url: review.url,
			});
			return {
				kind: "succeeded",
				outcome: `reviewed with ${placed.comments.length} inline comment(s)`,
			};
		} finally {
			await this.d.workspaces.release(ws.id);
		}
	}
}
