import { z } from "zod";

const int = (def: number, min = 0) =>
	z.coerce.number().int().min(min).default(def);
const url = z
	.string()
	.url()
	.refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL");

/** Every setting comes from the environment (12-factor). See README "Configuration". */
export const ConfigSchema = z.object({
	PUBLIC_URL: url.transform((u) => u.replace(/\/+$/, "")),
	LLM_API_BASE: url.transform((u) => u.replace(/\/+$/, "")),
	LLM_MODEL: z.string().min(1),
	LLM_API_KEY: z.string().optional(),
	LLM_MODEL_ISSUE: z.string().optional(),
	LLM_MODEL_FIX: z.string().optional(),
	LLM_MODEL_REVIEW: z.string().optional(),
	RUNNER_IMAGE: z.string().min(1).default("louisremi/maintainer-agent:v0.2.0"),
	DATA_DIR: z.string().startsWith("/").default("/srv/maintainer-agent"),
	PORT: int(3000, 1),
	MAX_CONCURRENT_JOBS: int(1, 1),
	MAX_JOBS_PER_AUTHOR_PER_DAY: int(5, 1),
	ALLOWED_ACCOUNTS: z.string().default(""),
	MAX_STEP_LIMIT: int(120, 10),
	MAX_ATTEMPTS_CAP: int(5, 1),
	MAX_REVIEW_COMMENTS: int(50, 0),
	MAX_DIFF_LINES: int(20000, 100),
	ISSUE_STEP_LIMIT: int(30, 5),
	REVIEW_STEP_LIMIT: int(40, 5),
	ADMIN_TOKEN: z.string().min(16).optional(),
	SECRETS_KEY: z.string().min(16).optional(),
	JOB_RETENTION_DAYS: int(14, 1),
	GIT_AUTHOR: z
		.string()
		.regex(/^[^<>]+ <[^<>\s]+@[^<>\s]+>$/)
		.default("maintainer-agent <maintainer-agent@users.noreply.github.com>"),
	GITHUB_APP_ID: z.string().regex(/^\d+$/).optional(),
	GITHUB_PRIVATE_KEY: z.string().optional(),
	GITHUB_WEBHOOK_SECRET: z.string().optional(),
	GITHUB_APP_SLUG: z.string().optional(),
	GITHUB_HOST: z.string().default("github.com"),
	DOCKER_PULL: z.enum(["always", "missing", "never"]).default("missing"),
	/** Host name of PUBLIC_URL on which only GitHub's routes answer (admin stays private). */
	PUBLIC_PATHS_ONLY_VIA_HOST: z
		.string()
		.regex(/^[a-z0-9.-]+$/i)
		.optional(),
});

export type ServerConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
	const parsed = ConfigSchema.safeParse(env);
	if (!parsed.success) {
		const lines = parsed.error.issues.map(
			(i) => `  ${i.path.join(".")}: ${i.message}`,
		);
		throw new Error(`invalid configuration:\n${lines.join("\n")}`);
	}
	const c = parsed.data;
	const github = [
		c.GITHUB_APP_ID,
		c.GITHUB_PRIVATE_KEY,
		c.GITHUB_WEBHOOK_SECRET,
	];
	if (github.some(Boolean) && !github.every(Boolean)) {
		throw new Error(
			"invalid configuration:\n  GITHUB_APP_ID, GITHUB_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET must be set together",
		);
	}
	return c;
}
