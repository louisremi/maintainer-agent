import { Document } from "yaml";
import { secretName } from "../../settings/domain";

/** What v0.2 kept in environment variables and the database. */
export interface LegacyState {
	readonly env: NodeJS.ProcessEnv;
	readonly connections: readonly {
		id: string;
		host: string;
		displayName: string;
		ownerAccount: string | null;
		appId: string;
		appSlug: string;
		privateKey: string;
		webhookSecret: string;
		appearanceDone: boolean;
	}[];
	/** Repositories as stored by v0.2 (key github:host/owner/name), enabled ones only. */
	readonly enabledRepositories: readonly string[];
}

export interface LegacyImportResult {
	readonly text: string;
	/** Secrets to store in secrets.yaml (the file then references them). */
	readonly secrets: Readonly<Record<string, string>>;
}

const int = (v: string | undefined) =>
	v && /^\d+$/.test(v) ? Number(v) : undefined;

/**
 * Builds a version 1 settings.yml from a v0.2 installation: server values and
 * models from environment variables, GitHub Apps and enabled repositories from
 * the database. Secrets go to secrets.yaml and are referenced by placeholder.
 */
export function buildLegacyImport(state: LegacyState): LegacyImportResult {
	const e = state.env;
	const secrets: Record<string, string> = {};
	const ref = (name: string, value: string | undefined) => {
		if (!value) return undefined;
		secrets[name] = value;
		return `{${name}}`;
	};

	const limits = Object.fromEntries(
		Object.entries({
			max_step_limit: int(e.MAX_STEP_LIMIT),
			max_attempts: int(e.MAX_ATTEMPTS_CAP),
			max_jobs_per_author_per_day: int(e.MAX_JOBS_PER_AUTHOR_PER_DAY),
			max_review_comments: int(e.MAX_REVIEW_COMMENTS),
			max_diff_lines: int(e.MAX_DIFF_LINES),
		}).filter(([, v]) => v !== undefined),
	);
	const server = Object.fromEntries(
		Object.entries({
			public_url: e.PUBLIC_URL ?? "https://agent.example.org",
			public_paths_only_via_host: e.PUBLIC_PATHS_ONLY_VIA_HOST,
			admin_token: ref("MA_ADMIN_TOKEN", e.ADMIN_TOKEN),
			allowed_accounts: (e.ALLOWED_ACCOUNTS ?? "")
				.split(/[\s,]+/)
				.filter(Boolean),
			runner_image: e.RUNNER_IMAGE,
			docker_pull: e.DOCKER_PULL,
			max_concurrent_jobs: int(e.MAX_CONCURRENT_JOBS),
			job_retention_days: int(e.JOB_RETENTION_DAYS),
			git_author: e.GIT_AUTHOR,
			limits: Object.keys(limits).length ? limits : undefined,
		}).filter(([, v]) => v !== undefined),
	);

	const apiKey = ref("MA_LLM_API_KEY", e.LLM_API_KEY);
	const defaultModel = {
		api_base: e.LLM_API_BASE ?? "http://127.0.0.1:8000/v1",
		model: e.LLM_MODEL ?? "openai/your-model",
		...(apiKey ? { api_key: apiKey } : {}),
	};
	const models: Record<string, unknown> = { default: defaultModel };
	const perJob: Record<string, string> = {};
	for (const [job, envName] of [
		["answer", "LLM_MODEL_ISSUE"],
		["fix", "LLM_MODEL_FIX"],
		["review", "LLM_MODEL_REVIEW"],
	] as const) {
		const m = e[envName];
		if (m) {
			models[job] = { ...defaultModel, model: m };
			perJob[job] = job;
		}
	}

	const connections: Record<string, unknown> = {};
	const idFor = new Map<string, string>();
	for (const c of state.connections) {
		const id = c.id === "env" ? "env" : c.id;
		idFor.set(c.id, id);
		connections[id] = {
			platform: "github",
			host: c.host,
			display_name: c.displayName,
			...(c.ownerAccount ? { owner_account: c.ownerAccount } : {}),
			app_id: c.appId,
			app_slug: c.appSlug,
			private_key: ref(secretName("github", id, "private key"), c.privateKey),
			webhook_secret: ref(
				secretName("github", id, "webhook secret"),
				c.webhookSecret,
			),
			...(c.appearanceDone ? { appearance_done: true } : {}),
		};
	}

	const repositories: Record<string, unknown> = {};
	for (const key of state.enabledRepositories) {
		const m = /^[a-z]+:(.+)$/.exec(key);
		if (m?.[1]) repositories[m[1]] = {};
	}

	const doc = new Document({
		version: 1,
		server,
		models,
		connections,
		defaults: {
			...(Object.keys(perJob).length
				? { model: perJob }
				: { model: "default" }),
			answer: { step_limit: int(e.ISSUE_STEP_LIMIT) ?? 30 },
			review: { step_limit: int(e.REVIEW_STEP_LIMIT) ?? 40 },
		},
		repositories,
	});
	doc.commentBefore =
		" yaml-language-server: $schema=https://raw.githubusercontent.com/louisremi/maintainer-agent/main/docs/settings.schema.json\n" +
		" maintainer-agent settings (see docs/settings.md).\n" +
		" Imported from the environment variables and database of v0.2; those\n" +
		" variables can now be removed from docker-compose.yml. Secrets were moved\n" +
		" to secrets.yaml and are referenced as {MA_NAME}.";
	return { text: doc.toString({ lineWidth: 0 }), secrets };
}

/** Whether there is a v0.2 installation to import from. */
export function hasLegacyConfiguration(state: LegacyState): boolean {
	return Boolean(
		state.env.LLM_API_BASE ||
			state.env.PUBLIC_URL ||
			state.connections.length ||
			state.enabledRepositories.length,
	);
}
