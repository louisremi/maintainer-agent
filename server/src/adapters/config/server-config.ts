import { z } from "zod";

/**
 * Bootstrap configuration from the environment: only where things are and
 * how to reach the process. Everything about behaviour lives in
 * CONFIG_DIR/settings.yml (see docs/settings.md). The v0.2 variables
 * (PUBLIC_URL, LLM_*, MAX_*, GITHUB_*...) are read once, by the settings
 * migration that creates settings.yml from them.
 */
export const BootstrapSchema = z.object({
	CONFIG_DIR: z.string().startsWith("/").default("/config"),
	DATA_DIR: z.string().startsWith("/").default("/srv/maintainer-agent"),
	PORT: z.coerce.number().int().min(1).max(65535).default(3000),
	/** Key for the few secrets still kept in the database (e.g. pending registrations). */
	MA_SECRETS_KEY: z.string().min(16).optional(),
	/** v0.2 name of MA_SECRETS_KEY, still honoured. */
	SECRETS_KEY: z.string().min(16).optional(),
});

export type ServerConfig = z.infer<typeof BootstrapSchema> & {
	/** MA_SECRETS_KEY or SECRETS_KEY. */
	readonly secretsKey: string | null;
};

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
	const parsed = BootstrapSchema.safeParse(env);
	if (!parsed.success) {
		const lines = parsed.error.issues.map(
			(i) => `  ${i.path.join(".")}: ${i.message}`,
		);
		throw new Error(`invalid configuration:\n${lines.join("\n")}`);
	}
	const c = parsed.data;
	return { ...c, secretsKey: c.MA_SECRETS_KEY ?? c.SECRETS_KEY ?? null };
}

/** v0.2 variables that settings.yml replaces (warned about when still set). */
export const LEGACY_VARIABLES = [
	"PUBLIC_URL",
	"PUBLIC_PATHS_ONLY_VIA_HOST",
	"LLM_API_BASE",
	"LLM_MODEL",
	"LLM_API_KEY",
	"LLM_MODEL_ISSUE",
	"LLM_MODEL_FIX",
	"LLM_MODEL_REVIEW",
	"RUNNER_IMAGE",
	"MAX_CONCURRENT_JOBS",
	"MAX_JOBS_PER_AUTHOR_PER_DAY",
	"ALLOWED_ACCOUNTS",
	"MAX_STEP_LIMIT",
	"MAX_ATTEMPTS_CAP",
	"MAX_REVIEW_COMMENTS",
	"MAX_DIFF_LINES",
	"ISSUE_STEP_LIMIT",
	"REVIEW_STEP_LIMIT",
	"ADMIN_TOKEN",
	"JOB_RETENTION_DAYS",
	"GIT_AUTHOR",
	"GITHUB_APP_ID",
	"GITHUB_PRIVATE_KEY",
	"GITHUB_WEBHOOK_SECRET",
	"GITHUB_APP_SLUG",
	"GITHUB_HOST",
	"DOCKER_PULL",
] as const;
