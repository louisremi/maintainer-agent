import type { AccountAllowList, Role } from "../../shared-kernel";
import type { ForgeEvent } from "./forge-event";
import { Labels } from "./labels";
import type { JobKind } from "./maintenance-job";
import type { RepositoryPolicy } from "./repository-policy";

export interface TriageContext {
	readonly policy: RepositoryPolicy;
	readonly allowList: AccountAllowList;
	/** Login under which the connection itself acts (its own events are ignored). */
	readonly ownBotLogin: string;
	/** Role of the actor of a label event (resolved by the caller through the forge). */
	readonly actorRole: Role | null;
	/** Jobs this author already triggered in the last 24 hours. */
	readonly authorJobsToday: number;
	readonly maxJobsPerAuthorPerDay: number;
}

export type TriageDecision =
	| { readonly kind: "job"; readonly job: JobKind }
	| { readonly kind: "ignore"; readonly reason: string };

const ignore = (reason: string): TriageDecision => ({ kind: "ignore", reason });
const job = (kind: JobKind): TriageDecision => ({ kind: "job", job: kind });

/**
 * Decides what a forge event asks of the maintainer agent. Pure: everything it
 * needs is in the event and the context.
 *
 * - Nobody can make the agent act on a repository outside the allow-list, on
 *   items labelled `no-agent`, or by being a bot (including the agent itself).
 * - New issues are answered; whether a change is then proposed is decided
 *   after the analysis (see {@link FixEligibility}).
 * - `agent-fix` and `agent-rereview` only count when a maintainer adds them.
 * - New, non-draft change requests are reviewed, once (not the agent's own
 *   drafts; a maintainer can ask for another review with `agent-rereview`).
 * - Automatic jobs per author per day are capped, so one person cannot use the
 *   operator's model at will; maintainers' explicit labels are not capped.
 */
export const EventTriage = {
	decide(event: ForgeEvent, ctx: TriageContext): TriageDecision {
		if (!ctx.allowList.allows(event.repo))
			return ignore("account not allowed on this server");
		if (event.actor.isBot || sameLogin(event.actor.login, ctx.ownBotLogin))
			return ignore("event caused by a bot");
		if (event.labels.includes(Labels.optOut))
			return ignore(`labelled ${Labels.optOut}`);

		const capped = ctx.authorJobsToday >= ctx.maxJobsPerAuthorPerDay;
		switch (event.type) {
			case "issue-opened":
				if (!ctx.policy.answer.enabled)
					return ignore("answers are disabled by the repository policy");
				if (capped && event.authorRole !== "maintainer")
					return ignore("daily job limit reached for this author");
				return job("answer-issue");

			case "issue-labeled":
				if (event.label !== Labels.fix)
					return ignore(`label ${event.label} is not for the agent`);
				if (ctx.actorRole !== "maintainer")
					return ignore(`${Labels.fix} was not added by a maintainer`);
				if (!ctx.policy.fix.enabled)
					return ignore("fixes are disabled by the repository policy");
				return job("propose-fix");

			case "change-request-opened":
				if (!ctx.policy.review.enabled)
					return ignore("reviews are disabled by the repository policy");
				if (event.isDraft) return ignore("draft change request");
				if (capped && event.authorRole !== "maintainer")
					return ignore("daily job limit reached for this author");
				return job("review-change-request");

			case "change-request-labeled":
				if (event.label !== Labels.rereview)
					return ignore(`label ${event.label} is not for the agent`);
				if (ctx.actorRole !== "maintainer")
					return ignore(`${Labels.rereview} was not added by a maintainer`);
				if (!ctx.policy.review.enabled)
					return ignore("reviews are disabled by the repository policy");
				return job("review-change-request");
		}
	},
};

function sameLogin(a: string, b: string): boolean {
	const norm = (s: string) => s.toLowerCase().replace(/\[bot\]$/, "");
	return b !== "" && norm(a) === norm(b);
}
