import type { Logger } from "../../shared-kernel";
import { Labels, Markers } from "../domain";
import type { JobHandler, JobResult, JobRunContext } from "./job-handler";
import type {
	AgentRunner,
	ChangePublisher,
	IssueSnapshot,
	OutputSanitizer,
	WorkspacePreparer,
} from "./ports";
import { buildTask, footer } from "./task-builder";

export interface ProposeFixDeps {
	readonly workspaces: WorkspacePreparer;
	readonly agents: AgentRunner;
	readonly publisher: ChangePublisher;
	readonly sanitizer: OutputSanitizer;
	readonly log: Logger;
}

/** Branch names the agent's changes go to; nothing else is ever pushed. */
export const BRANCH_PREFIX = "maintainer-agent/";

/**
 * Proposes a change for an issue as a draft change request, then links it on
 * the issue. The agent only edits a checkout; a model-less publisher checks
 * and pushes the patch, so no forge credential is ever next to the model.
 */
export class ProposeFix implements JobHandler {
	readonly kind = "propose-fix" as const;

	constructor(private readonly d: ProposeFixDeps) {}

	async handle(ctx: JobRunContext): Promise<JobResult> {
		const { job, session } = ctx;
		const issue = await session.getIssue(job.number);
		if (!issue?.isOpen)
			return {
				kind: "succeeded",
				outcome: "issue closed or gone; nothing to do",
			};
		if (issue.labels.includes(Labels.optOut))
			return { kind: "succeeded", outcome: `labelled ${Labels.optOut}` };
		const approved = job.context.approvedFingerprint;
		if (approved && approved !== issue.fingerprint) {
			// The text the agent would act on is not the text the maintainer approved.
			return {
				kind: "escalate",
				reason: `the issue was edited after ${Labels.fix} was added; add the label again to approve the new text`,
			};
		}

		await session.addLabel(job.number, Labels.draftingPr);
		try {
			return await this.run(ctx, issue);
		} finally {
			await session
				.removeLabel(job.number, Labels.draftingPr)
				.catch(() => undefined);
		}
	}

	private async run(
		ctx: JobRunContext,
		issue: IssueSnapshot,
	): Promise<JobResult> {
		const { job, session, policy } = ctx;
		const comments = await session.listIssueComments(job.number, 100);
		const ws = await this.d.workspaces.prepare({
			jobId: job.id,
			mode: "fix",
			git: await session.gitAccess("read"),
			baseSha: ctx.defaultBranch.sha,
			baseBranch: ctx.defaultBranch.name,
		});
		try {
			const prior =
				job.context.analysis ??
				latestAnswer(comments.filter((c) => c.isOwn).map((c) => c.body));
			await this.d.workspaces.writeTask(
				ws,
				buildTask({
					mode: "fix",
					session,
					policy,
					defaultBranch: ctx.defaultBranch,
					subject: issue,
					comments,
					sha: ws.baseSha,
					priorAnalysis: prior,
				}),
			);
			const run = await this.d.agents.proposeFix(ws, {
				model: ctx.models[job.kind],
				stepLimit: policy.fix.stepLimit,
				extraEgress: policy.egress,
			});
			if (!run.ok) {
				if (run.transient) return { kind: "transient", reason: run.reason };
				return ctx.isLastAttempt
					? { kind: "escalate", reason: `no change produced: ${run.reason}` }
					: {
							kind: "agent-failed",
							reason: run.reason,
							...(run.explanation ? { explanation: run.explanation } : {}),
						};
			}

			const [title, body] = await this.d.sanitizer.sanitize(
				[run.value.title, run.value.body],
				{
					webUrl: session.webUrl,
					extraLinks: policy.links,
				},
			);
			if (!title || !body || title.held || body.held) {
				return {
					kind: "escalate",
					reason: `change description held by the sanitiser: ${[...(title?.reasons ?? []), ...(body?.reasons ?? [])].join("; ")}`,
				};
			}
			const change = run.value.withText(title.text, body.text);

			let branch = `${BRANCH_PREFIX}issue-${job.number}`;
			for (let i = 2; await session.branchExists(branch); i++) {
				if (i > 20)
					return {
						kind: "escalate",
						reason: "too many existing agent branches for this issue",
					};
				branch = `${BRANCH_PREFIX}issue-${job.number}-${i}`;
			}
			const published = await this.d.publisher.publish({
				workspace: ws,
				change,
				git: await session.gitAccess("push"),
				branch,
				protectedPaths: policy.protectedPaths(session.protectedPaths),
			});
			if (!published.ok) {
				return published.transient
					? { kind: "transient", reason: published.reason }
					: {
							kind: "escalate",
							reason: `change rejected before pushing: ${published.reason}`,
						};
			}

			const issueRef = session.terms.issueRef(job.number);
			const cr = await session.openDraftChangeRequest({
				head: published.branch,
				base: ctx.defaultBranch.name,
				title: change.title,
				body: [
					Markers.fix,
					change.body.trim(),
					`Fixes ${issueRef}`,
					footer(
						`This draft was written by maintainer-agent for ${issueRef}. Review it like any other contribution.`,
					),
				].join("\n\n"),
			});
			await session.comment(
				job.number,
				[
					Markers.fix,
					`I opened a draft ${session.terms.changeRequest} for this: ${session.terms.changeRequestRef(cr.number)}.`,
					footer("A maintainer reviews it before anything is merged."),
				].join("\n\n"),
			);
			this.d.log.info("change proposed", {
				jobId: job.id,
				repo: job.repo.key,
				issue: job.number,
				changeRequest: cr.number,
				title: issue.title,
			});
			return {
				kind: "succeeded",
				outcome: `draft ${session.terms.changeRequestShort} ${session.terms.changeRequestRef(cr.number)} on ${published.branch}`,
			};
		} finally {
			await this.d.workspaces.release(ws.id);
		}
	}
}

function latestAnswer(ownBodies: readonly string[]): string {
	const answer = [...ownBodies]
		.reverse()
		.find((b) => b.includes(Markers.answer));
	return answer ? answer.replace(Markers.answer, "").trim() : "";
}
