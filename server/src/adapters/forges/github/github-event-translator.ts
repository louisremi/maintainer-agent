import { createHash } from "node:crypto";
import type { ForgeEvent } from "../../../maintenance/domain";
import { RepoRef } from "../../../shared-kernel";
import { roleFromAssociation } from "./github-forge-session";

/** What a GitHub webhook means for the server, in domain terms. */
export type TranslatedGithubEvent =
	| { readonly kind: "forge-event"; readonly event: ForgeEvent }
	| {
			readonly kind: "repositories";
			readonly added: RepoRef[];
			readonly removed: RepoRef[];
			readonly mode: "delta" | "replace";
	  }
	| { readonly kind: "ignored"; readonly reason: string };

interface Payload {
	action?: string;
	repository?: { full_name: string };
	sender?: { login: string; type?: string };
	issue?: {
		number: number;
		updated_at?: string;
		body?: string | null;
		user?: { login: string; type?: string };
		author_association?: string;
		labels?: { name: string }[];
		pull_request?: unknown;
	};
	pull_request?: {
		number: number;
		user?: { login: string; type?: string };
		author_association?: string;
		labels?: { name: string }[];
		draft?: boolean;
	};
	label?: { name: string };
	repositories?: { full_name: string }[];
	repositories_added?: { full_name: string }[];
	repositories_removed?: { full_name: string }[];
}

/** Short, stable digest of the text a maintainer approved. */
function fingerprint(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

const isBot = (u?: { login: string; type?: string }) =>
	u?.type === "Bot" || /\[bot\]$/.test(u?.login ?? "");
const ignored = (reason: string): TranslatedGithubEvent => ({
	kind: "ignored",
	reason,
});

/**
 * Anti-corruption layer: turns GitHub webhook payloads into domain events.
 * GitHub's vocabulary (pull requests, author associations, installations)
 * stops here.
 */
export class GithubEventTranslator {
	constructor(private readonly host: string) {}

	translate(eventName: string, payload: Payload): TranslatedGithubEvent {
		switch (eventName) {
			case "issues":
				return this.issue(payload);
			case "pull_request":
				return this.pullRequest(payload);
			case "installation":
				return this.installation(payload);
			case "installation_repositories":
				return this.installationRepositories(payload);
			case "ping":
				return ignored("ping");
			default:
				return ignored(`event ${eventName} is not used`);
		}
	}

	private repo(full: string | undefined): RepoRef | null {
		if (!full) return null;
		try {
			return RepoRef.of("github", this.host, full);
		} catch {
			return null;
		}
	}

	private issue(p: Payload): TranslatedGithubEvent {
		const repo = this.repo(p.repository?.full_name);
		if (!repo || !p.issue || !p.sender)
			return ignored("incomplete issues payload");
		if (p.issue.pull_request) return ignored("issue event for a pull request");
		const labels = (p.issue.labels ?? []).map((l) => l.name);
		const actor = { login: p.sender.login, isBot: isBot(p.sender) };
		if (p.action === "opened") {
			const author = p.issue.user ?? p.sender;
			return {
				kind: "forge-event",
				event: {
					type: "issue-opened",
					repo,
					number: p.issue.number,
					actor: { login: author.login, isBot: isBot(author) },
					labels,
					authorRole: roleFromAssociation(p.issue.author_association),
				},
			};
		}
		if (p.action === "labeled" && p.label) {
			return {
				kind: "forge-event",
				event: {
					type: "issue-labeled",
					repo,
					number: p.issue.number,
					actor,
					labels,
					label: p.label.name,
					...(p.issue.body !== undefined
						? { subjectFingerprint: fingerprint(p.issue.body ?? "") }
						: {}),
				},
			};
		}
		return ignored(`issues.${p.action} is not used`);
	}

	private pullRequest(p: Payload): TranslatedGithubEvent {
		const repo = this.repo(p.repository?.full_name);
		const pr = p.pull_request;
		if (!repo || !pr || !p.sender)
			return ignored("incomplete pull_request payload");
		const labels = (pr.labels ?? []).map((l) => l.name);
		const isDraft = Boolean(pr.draft);
		if (p.action === "opened" || p.action === "ready_for_review") {
			const author = pr.user ?? p.sender;
			return {
				kind: "forge-event",
				event: {
					type: "change-request-opened",
					repo,
					number: pr.number,
					actor: { login: author.login, isBot: isBot(author) },
					labels,
					authorRole: roleFromAssociation(pr.author_association),
					isDraft,
				},
			};
		}
		if (p.action === "labeled" && p.label) {
			return {
				kind: "forge-event",
				event: {
					type: "change-request-labeled",
					repo,
					number: pr.number,
					actor: { login: p.sender.login, isBot: isBot(p.sender) },
					labels,
					label: p.label.name,
					isDraft,
				},
			};
		}
		return ignored(`pull_request.${p.action} is not used`);
	}

	private list(items: { full_name: string }[] | undefined): RepoRef[] {
		return (items ?? [])
			.map((r) => this.repo(r.full_name))
			.filter((r): r is RepoRef => r !== null);
	}

	private installation(p: Payload): TranslatedGithubEvent {
		if (p.action === "created" || p.action === "unsuspend")
			return {
				kind: "repositories",
				added: this.list(p.repositories),
				removed: [],
				mode: "delta",
			};
		if (p.action === "deleted" || p.action === "suspend")
			return {
				kind: "repositories",
				added: [],
				removed: this.list(p.repositories),
				mode: "delta",
			};
		return ignored(`installation.${p.action} is not used`);
	}

	private installationRepositories(p: Payload): TranslatedGithubEvent {
		return {
			kind: "repositories",
			added: this.list(p.repositories_added),
			removed: this.list(p.repositories_removed),
			mode: "delta",
		};
	}
}
