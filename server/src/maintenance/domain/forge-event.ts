import type { Actor, RepoRef, Role } from "../../shared-kernel";

/**
 * Something that happened on a watched repository, already translated from
 * the forge's own vocabulary by an anti-corruption layer (see adapters/forges).
 */
export type ForgeEvent =
	| IssueOpened
	| IssueLabeled
	| ChangeRequestOpened
	| ChangeRequestLabeled;

interface EventBase {
	readonly repo: RepoRef;
	readonly number: number;
	/** Who caused the event (author for "opened", labeller for "labeled"). */
	readonly actor: Actor;
	readonly labels: readonly string[];
}

export interface IssueOpened extends EventBase {
	readonly type: "issue-opened";
	readonly authorRole: Role;
}

export interface IssueLabeled extends EventBase {
	readonly type: "issue-labeled";
	readonly label: string;
	/** Digest of the issue body when the label was added (what the maintainer approved). */
	readonly subjectFingerprint?: string;
}

export interface ChangeRequestOpened extends EventBase {
	readonly type: "change-request-opened";
	readonly authorRole: Role;
	readonly isDraft: boolean;
}

export interface ChangeRequestLabeled extends EventBase {
	readonly type: "change-request-labeled";
	readonly label: string;
	readonly isDraft: boolean;
}

export function isLabelEvent(
	e: ForgeEvent,
): e is IssueLabeled | ChangeRequestLabeled {
	return e.type === "issue-labeled" || e.type === "change-request-labeled";
}
