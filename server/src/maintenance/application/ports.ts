import type { RepoRef, Role } from "../../shared-kernel";
import type {
	InlineComment,
	JobKind,
	LabelDefinition,
	MaintenanceJob,
	PolicyData,
	ProposedChange,
	RepositoryFilePolicy,
	Review,
	Verdict,
} from "../domain";
import type { AgentTask } from "./agent-task";

// ----------------------------------------------------------------------------- persistence

export interface MaintenanceJobRepository {
	get(id: string): Promise<MaintenanceJob | null>;
	save(job: MaintenanceJob): Promise<void>;
	/** Atomically picks the oldest due queued job and marks it running. */
	claimNext(now: Date): Promise<MaintenanceJob | null>;
	listActive(repo: RepoRef): Promise<MaintenanceJob[]>;
	listByStatus(status: MaintenanceJob["status"]): Promise<MaintenanceJob[]>;
	countTriggeredBy(actorLogin: string, since: Date): Promise<number>;
	listRecent(limit: number): Promise<MaintenanceJob[]>;
	deleteFinishedBefore(before: Date): Promise<string[]>;
}

// ----------------------------------------------------------------------------- forge

export interface IssueSnapshot {
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly authorLogin: string;
	readonly authorRole: Role;
	readonly labels: readonly string[];
	readonly isOpen: boolean;
	/** Digest of the body, comparable with the one recorded when a fix was approved. */
	readonly fingerprint: string;
}

export interface CommentSnapshot {
	readonly authorLogin: string;
	readonly authorRole: Role;
	readonly body: string;
	readonly createdAt: string;
	readonly isOwn: boolean;
}

export interface ChangeRequestSnapshot {
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly authorLogin: string;
	readonly authorRole: Role;
	readonly isOpen: boolean;
	readonly isDraft: boolean;
	readonly baseBranch: string;
	readonly baseSha: string;
	readonly headSha: string;
	/** Git ref on the base repository from which the head commits can be fetched. */
	readonly headFetchRef: string;
}

/** How a git client reaches the repository. Contains a credential: never log it. */
export interface GitAccess {
	readonly remoteUrl: string;
	/** Value of an `Authorization` HTTP header, or null for anonymous access. */
	readonly authorization: string | null;
	/** Host names a git client must reach (for an egress allow-list). */
	readonly egressHosts: readonly string[];
}

/** Words the forge uses, so that prompts and comments read naturally. */
export interface ForgeTerms {
	/** e.g. "pull request" or "merge request". */
	readonly changeRequest: string;
	/** e.g. "PR" or "MR". */
	readonly changeRequestShort: string;
	/** e.g. "#12" or "!12". */
	changeRequestRef(number: number): string;
	issueRef(number: number): string;
}

/**
 * What the maintenance use cases may do on one repository, through the
 * connection that owns it. Implemented by a forge adapter.
 */
export interface ForgeSession {
	readonly repo: RepoRef;
	readonly botLogin: string;
	readonly terms: ForgeTerms;
	/** Web URL of the repository; links under it are always allowed in posts. */
	readonly webUrl: string;
	/** Paths the forge treats as automation config (CI files...): never changed by the agent. */
	readonly protectedPaths: readonly string[];
	permalinkBase(sha: string): string;

	getIssue(number: number): Promise<IssueSnapshot | null>;
	listIssueComments(number: number, limit: number): Promise<CommentSnapshot[]>;
	getChangeRequest(number: number): Promise<ChangeRequestSnapshot | null>;
	getDefaultBranch(): Promise<{ name: string; sha: string }>;
	readFile(path: string, ref: string): Promise<string | null>;
	roleOf(login: string): Promise<Role>;

	comment(number: number, body: string): Promise<{ url: string }>;
	ensureLabels(labels: readonly LabelDefinition[]): Promise<void>;
	addLabel(number: number, label: string): Promise<void>;
	removeLabel(number: number, label: string): Promise<void>;
	branchExists(branch: string): Promise<boolean>;
	openDraftChangeRequest(input: {
		head: string;
		base: string;
		title: string;
		body: string;
	}): Promise<{ number: number; url: string }>;
	postReview(
		number: number,
		input: {
			headSha: string;
			summary: string;
			comments: readonly InlineComment[];
		},
	): Promise<{ url: string }>;

	gitAccess(scope: "read" | "push"): Promise<GitAccess>;
}

/** Opens a {@link ForgeSession} for a watched repository. */
export interface ForgeAccess {
	/**
	 * Null when the repository is not watched, disabled, or (with
	 * `viaConnectionId`) owned by another connection.
	 */
	session(
		repo: RepoRef,
		viaConnectionId?: string,
	): Promise<ForgeSession | null>;
}

// ----------------------------------------------------------------------------- sandbox

export type PolicyValidation =
	| { readonly ok: true; readonly policy: RepositoryFilePolicy }
	| { readonly ok: false; readonly errors: readonly string[] };

/** Validates untrusted policy text from a repository (in isolation). */
export interface PolicyValidator {
	validate(raw: string): Promise<PolicyValidation>;
}

/** A prepared checkout plus the task description for one agent run. */
export interface Workspace {
	readonly id: string;
	readonly baseSha: string;
	readonly headSha: string | null;
	/** Unified diff base...head for reviews. */
	readonly diff: string | null;
}

export interface WorkspacePreparer {
	/** Clones the repository at `baseSha` (and, for reviews, fetches the head). */
	prepare(input: {
		jobId: string;
		mode: AgentTask["mode"];
		git: GitAccess;
		/** Commit to check out (the default branch head, or a change request's base). */
		baseSha: string;
		baseBranch: string;
		/** For reviews: fetch this ref and check out its head commit. */
		head?: { fetchRef: string; sha: string };
	}): Promise<Workspace>;
	/** Writes the task the agent will read. */
	writeTask(workspace: Workspace, task: AgentTask): Promise<void>;
	/** Frees the checkout after the job; logs and outputs stay until pruned. */
	release(workspaceId: string): Promise<void>;
	/** Deletes everything kept for a job. */
	dispose(workspaceId: string): Promise<void>;
}

export type AgentOutcome<T> =
	| { readonly ok: true; readonly value: T }
	/**
	 * `transient`: infrastructure failure (model unreachable...), worth retrying as is.
	 * `explanation`: the agent's own (untrusted) words on why it produced nothing.
	 */
	| {
			readonly ok: false;
			readonly reason: string;
			readonly transient: boolean;
			readonly explanation?: string;
	  };

export interface AgentRunOptions {
	readonly model: ModelChoice;
	readonly stepLimit: number;
	/** Hosts besides the model endpoint the agent may reach (fix mode only). */
	readonly extraEgress: readonly string[];
}

/** Runs the model-driven agent in a sandbox. It never receives a forge credential. */
export interface AgentRunner {
	answerIssue(
		workspace: Workspace,
		options: AgentRunOptions,
	): Promise<AgentOutcome<Verdict>>;
	proposeFix(
		workspace: Workspace,
		options: AgentRunOptions,
	): Promise<AgentOutcome<ProposedChange>>;
	reviewChange(
		workspace: Workspace,
		options: AgentRunOptions,
	): Promise<AgentOutcome<Review>>;
}

export type PublishOutcome =
	| { readonly ok: true; readonly branch: string; readonly commitSha: string }
	| {
			readonly ok: false;
			readonly reason: string;
			readonly transient: boolean;
	  };

/** Pushes a validated patch without any model involved. */
export interface ChangePublisher {
	publish(input: {
		workspace: Workspace;
		change: ProposedChange;
		git: GitAccess;
		branch: string;
		protectedPaths: readonly string[];
	}): Promise<PublishOutcome>;
}

export interface SanitizedText {
	readonly text: string;
	readonly held: boolean;
	readonly reasons: readonly string[];
}

export interface SanitizeOptions {
	/** Links under this URL stay clickable. */
	readonly webUrl: string;
	/** Further allowed https URL prefixes (repository policy). */
	readonly extraLinks: readonly string[];
	/** Hold texts longer than this. */
	readonly maxChars?: number;
}

/** Neutralises untrusted agent text before it is posted (one isolated run per batch). */
export interface OutputSanitizer {
	sanitize(
		texts: readonly string[],
		options: SanitizeOptions,
	): Promise<SanitizedText[]>;
}

// ----------------------------------------------------------------------------- model

export interface ModelChoice {
	readonly apiBase: string;
	readonly model: string;
	/** Sent to the endpoint; reaches agent containers (never a forge credential). */
	readonly apiKey: string | null;
}

/**
 * What the operator configured for a repository (settings.yml), before the
 * repository's own policy file is layered on top. Null: not configured, or
 * paused; the server does nothing there.
 */
export interface RepositoryConfiguration {
	readonly base: PolicyData;
	readonly models: Readonly<Record<JobKind, ModelChoice>>;
	/** Whether the repository's own policy file may add egress hosts. */
	readonly allowRepositoryEgress: boolean;
	/** Connection id the operator chose, if any. */
	readonly connectionId: string | null;
}

export interface RepositoryConfigurations {
	for(repo: RepoRef): RepositoryConfiguration | null;
	/** Every endpoint in use, for the health check. */
	allModels(): readonly ModelChoice[];
}

export interface ModelHealth {
	isAvailable(): Promise<boolean>;
}
