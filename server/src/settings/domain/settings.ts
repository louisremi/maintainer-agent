/**
 * The server's settings, as read from `settings.yml` once validated and with
 * secrets resolved. Plain data: the YAML, the schema library and the secret
 * sources live in adapters.
 */

/** Current schema version of settings.yml. Bump it with a migration. */
export const CURRENT_SETTINGS_VERSION = 1;

export type JobKindName = "answer" | "fix" | "review";
export const JOB_KIND_NAMES: readonly JobKindName[] = [
	"answer",
	"fix",
	"review",
];

export interface ServerLimits {
	readonly maxStepLimit: number;
	readonly maxAttempts: number;
	readonly maxJobsPerAuthorPerDay: number;
	readonly maxReviewComments: number;
	readonly maxDiffLines: number;
}

export interface ServerSettings {
	readonly publicUrl: string;
	readonly publicPathsOnlyViaHost: string | null;
	readonly adminToken: string | null;
	readonly allowedAccounts: readonly string[];
	readonly runnerImage: string;
	readonly dockerPull: "always" | "missing" | "never";
	readonly maxConcurrentJobs: number;
	readonly jobRetentionDays: number;
	readonly gitAuthor: string;
	readonly limits: ServerLimits;
}

export interface ModelEndpoint {
	readonly apiBase: string;
	readonly model: string;
	readonly apiKey: string | null;
}

export interface ConnectionSettings {
	readonly platform: "github" | "gitlab";
	readonly host: string;
	readonly displayName: string | null;
	readonly ownerAccount: string | null;
	readonly appId: string;
	readonly appSlug: string;
	readonly privateKey: string;
	readonly webhookSecret: string;
	readonly appearanceDone: boolean;
}

/** Per job kind: the name of an entry in `models`. */
export type ModelSelection = Readonly<Record<JobKindName, string>>;

export interface JobSettings {
	readonly enabled: boolean;
	readonly maxAttempts: number;
	readonly stepLimit: number;
}

/** Everything a repository can be configured with (fully resolved). */
export interface RepositorySettings {
	readonly enabled: boolean;
	readonly connection: string | null;
	readonly model: ModelSelection;
	readonly answer: JobSettings;
	readonly fix: JobSettings & { readonly trigger: "maintainers" | "label" };
	readonly review: JobSettings & {
		readonly maxComments: number;
		readonly maxDiffLines: number;
	};
	readonly instructions: readonly string[];
	readonly playbooks: {
		readonly issue: string;
		readonly implement: string;
		readonly review: string;
	};
	readonly checks: readonly string[];
	readonly egress: readonly string[];
	readonly links: readonly string[];
	readonly protectedPaths: readonly string[];
	/** Whether the repository's own policy file may add egress hosts. */
	readonly allowRepositoryEgress: boolean;
}

/** A partial layer as written in `defaults` or `repositories.<key>`. */
export type RepositoryLayer = DeepPartial<Omit<RepositorySettings, "model">> & {
	readonly model?: string | Partial<ModelSelection>;
};

export type DeepPartial<T> = T extends readonly unknown[]
	? T
	: T extends object
		? { readonly [K in keyof T]?: DeepPartial<T[K]> }
		: T;

export interface Settings {
	readonly version: number;
	readonly server: ServerSettings;
	readonly models: Readonly<Record<string, ModelEndpoint>>;
	readonly connections: Readonly<Record<string, ConnectionSettings>>;
	readonly defaults: RepositoryLayer;
	/** Keyed by `host/path`, e.g. `github.com/owner/name`. */
	readonly repositories: Readonly<Record<string, RepositoryLayer>>;
}

/** Built-in values below `defaults`. */
export const BUILT_IN_REPOSITORY_SETTINGS: Omit<RepositorySettings, "model"> = {
	enabled: true,
	connection: null,
	answer: { enabled: true, maxAttempts: 2, stepLimit: 30 },
	fix: { enabled: true, trigger: "maintainers", maxAttempts: 2, stepLimit: 80 },
	review: {
		enabled: true,
		maxAttempts: 2,
		stepLimit: 40,
		maxComments: 20,
		maxDiffLines: 5000,
	},
	instructions: [],
	playbooks: { issue: "", implement: "", review: "" },
	checks: [],
	egress: [],
	links: [],
	protectedPaths: [],
	allowRepositoryEgress: true,
};

export const BUILT_IN_LIMITS: ServerLimits = {
	maxStepLimit: 120,
	maxAttempts: 5,
	maxJobsPerAuthorPerDay: 5,
	maxReviewComments: 50,
	maxDiffLines: 20000,
};
