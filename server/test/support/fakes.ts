import type {
	AgentOutcome,
	AgentRunner,
	AgentTask,
	ChangePublisher,
	ChangeRequestSnapshot,
	CommentSnapshot,
	ForgeAccess,
	ForgeSession,
	GitAccess,
	IssueSnapshot,
	ModelHealth,
	OutputSanitizer,
	PolicyValidation,
	PolicyValidator,
	PublishOutcome,
	RepositoryConfiguration,
	RepositoryConfigurations,
	SanitizedText,
	Workspace,
	WorkspacePreparer,
} from "../../src/maintenance/application";
import {
	DEFAULT_POLICY,
	type InlineComment,
	type LabelDefinition,
	type ProposedChange,
	type Review,
	type Verdict,
} from "../../src/maintenance/domain";
import type {
	DeliveryLog,
	DomainEvent,
	EventPublisher,
	IdGenerator,
	Logger,
	RepoRef,
	Role,
	UnitOfWork,
} from "../../src/shared-kernel";

export class FixedClock {
	constructor(public current: Date) {}
	now(): Date {
		return this.current;
	}
	advance(ms: number): void {
		this.current = new Date(this.current.getTime() + ms);
	}
}

export class SequentialIds implements IdGenerator {
	private n = 0;
	constructor(private readonly prefix = "id") {}
	next(): string {
		return `${this.prefix}-${++this.n}`;
	}
}

export class DirectUnitOfWork implements UnitOfWork {
	run<T>(work: () => Promise<T>): Promise<T> {
		return work();
	}
}

export class RecordingPublisher implements EventPublisher {
	readonly events: DomainEvent[] = [];
	readonly subscribers: ((e: DomainEvent) => Promise<void>)[] = [];
	async publish(events: readonly DomainEvent[]): Promise<void> {
		for (const e of events) {
			this.events.push(e);
			for (const s of this.subscribers) await s(e);
		}
	}
}

export class MemoryLogger implements Logger {
	readonly lines: {
		level: string;
		message: string;
		fields?: Record<string, unknown>;
	}[] = [];
	info(message: string, fields?: Record<string, unknown>) {
		this.lines.push({ level: "info", message, ...(fields ? { fields } : {}) });
	}
	warn(message: string, fields?: Record<string, unknown>) {
		this.lines.push({ level: "warn", message, ...(fields ? { fields } : {}) });
	}
	error(message: string, fields?: Record<string, unknown>) {
		this.lines.push({ level: "error", message, ...(fields ? { fields } : {}) });
	}
}

export class MemoryDeliveryLog implements DeliveryLog {
	readonly seen = new Map<string, Date>();
	async recordOnce(source: string, id: string, at: Date) {
		const k = `${source}/${id}`;
		if (this.seen.has(k)) return false;
		this.seen.set(k, at);
		return true;
	}
	async forget(source: string, id: string) {
		this.seen.delete(`${source}/${id}`);
	}
	async prune(before: Date) {
		let n = 0;
		for (const [k, at] of this.seen)
			if (at < before) {
				this.seen.delete(k);
				n++;
			}
		return n;
	}
}

// ----------------------------------------------------------------------------- forge

export interface FakeRepoState {
	issues: Map<number, IssueSnapshot>;
	changeRequests: Map<number, ChangeRequestSnapshot>;
	comments: Map<number, CommentSnapshot[]>;
	files: Map<string, string>;
	roles: Map<string, Role>;
	branches: Set<string>;
	labels: Map<number, Set<string>>;
	ensuredLabels: string[];
	/** Every label change, in order: `+label#n` / `-label#n`. */
	labelLog: string[];
	openedChangeRequests: {
		head: string;
		base: string;
		title: string;
		body: string;
	}[];
	reviews: {
		number: number;
		headSha: string;
		summary: string;
		comments: readonly InlineComment[];
	}[];
}

export function emptyRepoState(): FakeRepoState {
	return {
		issues: new Map(),
		changeRequests: new Map(),
		comments: new Map(),
		files: new Map(),
		roles: new Map(),
		branches: new Set(["main"]),
		labels: new Map(),
		ensuredLabels: [],
		labelLog: [],
		openedChangeRequests: [],
		reviews: [],
	};
}

export class FakeForgeSession implements ForgeSession {
	readonly botLogin = "ma-test[bot]";
	readonly terms = {
		changeRequest: "pull request",
		changeRequestShort: "PR",
		changeRequestRef: (n: number) => `#${n}`,
		issueRef: (n: number) => `#${n}`,
	};
	readonly protectedPaths = [".github/**"];
	readonly webUrl: string;

	constructor(
		readonly repo: RepoRef,
		readonly state: FakeRepoState,
	) {
		this.webUrl = `https://${repo.host}/${repo.path}`;
	}

	permalinkBase(sha: string) {
		return `${this.webUrl}/blob/${sha}`;
	}
	async getIssue(n: number) {
		const i = this.state.issues.get(n);
		return i
			? { ...i, labels: [...(this.state.labels.get(n) ?? i.labels)] }
			: null;
	}
	async listIssueComments(n: number) {
		return [...(this.state.comments.get(n) ?? [])];
	}
	async getChangeRequest(n: number) {
		return this.state.changeRequests.get(n) ?? null;
	}
	async getDefaultBranch() {
		return { name: "main", sha: "a".repeat(40) };
	}
	async readFile(path: string) {
		return this.state.files.get(path) ?? null;
	}
	async roleOf(login: string) {
		return this.state.roles.get(login) ?? "other";
	}
	async comment(n: number, body: string) {
		const list = this.state.comments.get(n) ?? [];
		list.push({
			authorLogin: this.botLogin,
			authorRole: "other",
			body,
			createdAt: "now",
			isOwn: true,
		});
		this.state.comments.set(n, list);
		return { url: `${this.webUrl}/issues/${n}#c${list.length}` };
	}
	async ensureLabels(labels: readonly LabelDefinition[]) {
		this.state.ensuredLabels.push(...labels.map((l) => l.name));
	}
	async addLabel(n: number, label: string) {
		const s =
			this.state.labels.get(n) ??
			new Set(this.state.issues.get(n)?.labels ?? []);
		s.add(label);
		this.state.labels.set(n, s);
		this.state.labelLog.push(`+${label}#${n}`);
	}
	async removeLabel(n: number, label: string) {
		this.state.labels.get(n)?.delete(label);
		this.state.labelLog.push(`-${label}#${n}`);
	}
	async branchExists(b: string) {
		return this.state.branches.has(b);
	}
	async openDraftChangeRequest(input: {
		head: string;
		base: string;
		title: string;
		body: string;
	}) {
		this.state.openedChangeRequests.push(input);
		const number = 100 + this.state.openedChangeRequests.length;
		return { number, url: `${this.webUrl}/pull/${number}` };
	}
	async postReview(
		number: number,
		input: {
			headSha: string;
			summary: string;
			comments: readonly InlineComment[];
		},
	) {
		this.state.reviews.push({ number, ...input });
		return { url: `${this.webUrl}/pull/${number}#review` };
	}
	async gitAccess(scope: "read" | "push"): Promise<GitAccess> {
		return {
			remoteUrl: `${this.webUrl}.git`,
			authorization: `Basic ${scope}-token`,
			egressHosts: [this.repo.host],
		};
	}
}

export class FakeForge implements ForgeAccess {
	readonly repos = new Map<
		string,
		{ state: FakeRepoState; connectionId: string }
	>();
	add(
		repo: RepoRef,
		connectionId = "c1",
		state = emptyRepoState(),
	): FakeRepoState {
		this.repos.set(repo.key, { state, connectionId });
		return state;
	}
	async session(repo: RepoRef, via?: string) {
		const r = this.repos.get(repo.key);
		if (!r || (via && via !== r.connectionId)) return null;
		return new FakeForgeSession(repo, r.state);
	}
}

// ----------------------------------------------------------------------------- sandbox

export class FakePolicyValidator implements PolicyValidator {
	constructor(
		public result: PolicyValidation = {
			ok: true,
			policy: { data: DEFAULT_POLICY, setKeys: [] },
		},
	) {}
	readonly seen: string[] = [];
	async validate(raw: string) {
		this.seen.push(raw);
		return this.result;
	}
}

export class FakeWorkspaces implements WorkspacePreparer {
	readonly prepared: Parameters<WorkspacePreparer["prepare"]>[0][] = [];
	readonly tasks: AgentTask[] = [];
	readonly released: string[] = [];
	readonly disposed: string[] = [];
	diff: string | null = null;
	async prepare(
		input: Parameters<WorkspacePreparer["prepare"]>[0],
	): Promise<Workspace> {
		this.prepared.push(input);
		return {
			id: input.jobId,
			baseSha: input.baseSha,
			headSha: input.head?.sha ?? null,
			diff: input.head ? this.diff : null,
		};
	}
	async writeTask(_ws: Workspace, task: AgentTask) {
		this.tasks.push(task);
	}
	async release(id: string) {
		this.released.push(id);
	}
	async dispose(id: string) {
		this.disposed.push(id);
	}
}

type Scripted<T> = AgentOutcome<T> | (() => AgentOutcome<T>);

export class FakeAgents implements AgentRunner {
	verdicts: Scripted<Verdict>[] = [];
	changes: Scripted<ProposedChange>[] = [];
	reviews: Scripted<Review>[] = [];
	readonly calls: {
		mode: string;
		extraEgress: readonly string[];
		stepLimit: number;
	}[] = [];

	private next<T>(queue: Scripted<T>[], mode: string): AgentOutcome<T> {
		const s = queue.shift();
		if (!s)
			return {
				ok: false,
				reason: `no scripted ${mode} outcome`,
				transient: false,
			};
		return typeof s === "function" ? s() : s;
	}
	async answerIssue(
		_w: Workspace,
		o: { extraEgress: readonly string[]; stepLimit: number },
	) {
		this.calls.push({ mode: "issue", ...o });
		return this.next(this.verdicts, "issue");
	}
	async proposeFix(
		_w: Workspace,
		o: { extraEgress: readonly string[]; stepLimit: number },
	) {
		this.calls.push({ mode: "fix", ...o });
		return this.next(this.changes, "fix");
	}
	async reviewChange(
		_w: Workspace,
		o: { extraEgress: readonly string[]; stepLimit: number },
	) {
		this.calls.push({ mode: "review", ...o });
		return this.next(this.reviews, "review");
	}
}

export class FakePublisher implements ChangePublisher {
	outcome: PublishOutcome | null = null;
	readonly calls: Parameters<ChangePublisher["publish"]>[0][] = [];
	async publish(
		input: Parameters<ChangePublisher["publish"]>[0],
	): Promise<PublishOutcome> {
		this.calls.push(input);
		return (
			this.outcome ?? {
				ok: true,
				branch: input.branch,
				commitSha: "c".repeat(40),
			}
		);
	}
}

/** Marks texts containing "HOLD" as held; otherwise passes them through. */
export class FakeSanitizer implements OutputSanitizer {
	readonly calls: string[][] = [];
	async sanitize(texts: readonly string[]): Promise<SanitizedText[]> {
		this.calls.push([...texts]);
		return texts.map((t) => ({
			text: t,
			held: t.includes("HOLD"),
			reasons: t.includes("HOLD") ? ["test hold"] : [],
		}));
	}
}

const TEST_MODEL = {
	apiBase: "http://model.invalid/v1",
	model: "openai/test",
	apiKey: null,
};

/**
 * What settings.yml would configure: every repository listed in `configured`
 * gets the default policy and the test model; others are not configured.
 */
export class FakeRepositoryConfigurations implements RepositoryConfigurations {
	readonly configured = new Map<string, Partial<RepositoryConfiguration>>();

	add(repo: RepoRef, over: Partial<RepositoryConfiguration> = {}): this {
		this.configured.set(repo.key, over);
		return this;
	}

	for(repo: RepoRef): RepositoryConfiguration | null {
		const over = this.configured.get(repo.key);
		if (!over) return null;
		return {
			base: DEFAULT_POLICY,
			models: {
				"answer-issue": TEST_MODEL,
				"propose-fix": TEST_MODEL,
				"review-change-request": TEST_MODEL,
			},
			allowRepositoryEgress: true,
			connectionId: null,
			...over,
		};
	}

	allModels() {
		return [TEST_MODEL];
	}
}

export class FakeModelHealth implements ModelHealth {
	available = true;
	async isAvailable() {
		return this.available;
	}
}
