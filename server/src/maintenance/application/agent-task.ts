import type { Role } from "../../shared-kernel";

export type AgentMode = "issue" | "fix" | "review";

/**
 * Everything an agent run is told, written next to the checkout. Text that
 * came from people (titles, bodies, comments) is marked untrusted by the
 * runner's prompts; nothing here is a credential.
 */
export interface AgentTask {
	readonly version: 2;
	readonly mode: AgentMode;
	readonly repository: {
		readonly path: string;
		readonly webUrl: string;
		readonly permalinkBase: string;
		readonly defaultBranch: string;
	};
	readonly terms: {
		readonly changeRequest: string;
		readonly changeRequestShort: string;
	};
	readonly subject: {
		readonly kind: "issue" | "change-request";
		readonly number: number;
		readonly reference: string;
		readonly title: string;
		readonly body: string;
		readonly authorLogin: string;
		readonly authorRole: Role;
		readonly labels: readonly string[];
	};
	readonly comments: readonly {
		readonly author: string;
		readonly role: Role;
		readonly body: string;
		readonly createdAt: string;
	}[];
	readonly policy: {
		readonly instructions: readonly string[];
		/** Repository playbook path, or "" for the runner's generic one. */
		readonly playbook: string;
		readonly checks: readonly string[];
		readonly protectedPaths: readonly string[];
		readonly fixLabel: string;
	};
	/** Analysis from the job that requested this one (fix after answer). */
	readonly priorAnalysis: string;
	readonly review: null | {
		readonly baseSha: string;
		readonly headSha: string;
		readonly maxComments: number;
		readonly summaryOnly: boolean;
		readonly changedLines: number;
	};
}

export const LIMITS = {
	bodyChars: 20000,
	commentChars: 4000,
	comments: 20,
	priorAnalysisChars: 8000,
} as const;

export function clip(text: string, max: number): string {
	return text.length <= max
		? text
		: `${text.slice(0, max)}\n[… truncated ${text.length - max} characters]`;
}
