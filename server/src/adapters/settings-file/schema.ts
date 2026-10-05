import { z } from "zod";
import { CURRENT_SETTINGS_VERSION } from "../../settings/domain";

/**
 * The settings.yml schema (current version). Field names are snake_case as
 * written in the file; `toSettings` maps them to the domain. Fields marked
 * `secret` accept a `{MA_NAME}` placeholder (and only those do).
 * docs/settings.schema.json is generated from this (pnpm schema:write).
 */

const secret = (description: string) =>
	z
		.string()
		.min(1)
		.describe(`${description} Secret: write a {MA_NAME} placeholder.`)
		.meta({ secret: true });

const host = z
	.string()
	.regex(
		/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/,
		"must be a host name (optionally with :port)",
	);
const httpUrl = z.string().regex(/^https?:\/\/\S+$/, "must be an http(s) URL");
const posInt = z.number().int().positive();
const relPath = z
	.string()
	.regex(
		/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/*@+-]+$/,
		"must be a relative path without '..'",
	);
const egressHost = z
	.string()
	.regex(
		/^[a-z0-9*]([a-z0-9*.-]*[a-z0-9])?$/,
		"must be a host name (one leading label may contain *)",
	);
const linkPrefix = z
	.string()
	.regex(/^https:\/\/[A-Za-z0-9.-]+(\/\S*)?$/, "must be an https URL prefix");
const modelName = z
	.string()
	.regex(/^[A-Za-z0-9_-]+$/, "must name an entry of `models`");

const limits = z
	.object({
		max_step_limit: posInt
			.default(120)
			.describe("Most agent steps any job may take."),
		max_attempts: posInt.default(5).describe("Most agent attempts per job."),
		max_jobs_per_author_per_day: posInt
			.default(5)
			.describe("Automatic jobs per non-maintainer author per day."),
		max_review_comments: z
			.number()
			.int()
			.min(0)
			.default(50)
			.describe("Most inline comments per review."),
		max_diff_lines: posInt
			.default(20000)
			.describe("Largest diff reviewed line by line."),
	})
	.strict()
	.describe(
		"Host caps. Values configured in `defaults`, `repositories` or a repository's own policy file are clamped to them.",
	);

const server = z
	.object({
		public_url: httpUrl.describe(
			"HTTPS URL where the forge reaches this server (webhooks, app registration).",
		),
		public_paths_only_via_host: host
			.optional()
			.describe(
				"Host name of public_url on which only webhooks, the registration callback and /healthz answer; /admin stays on other addresses.",
			),
		admin_token: secret("Password of /admin (any user name).").optional(),
		allowed_accounts: z
			.array(z.string().regex(/^[A-Za-z0-9._/-]+$/))
			.default([])
			.describe(
				"Accounts (`name` or `host/name`) whose repositories this server may serve. Empty: any. Required for public apps.",
			),
		runner_image: z
			.string()
			.min(1)
			.default("louisremi/maintainer-agent:latest")
			.describe("Image of the agent containers."),
		docker_pull: z
			.enum(["always", "missing", "never"])
			.default("missing")
			.describe("Pull the runner image at start."),
		max_concurrent_jobs: posInt.default(1).describe("Agent runs in parallel."),
		job_retention_days: posInt
			.default(14)
			.describe("Finished jobs and their files are deleted after this."),
		git_author: z
			.string()
			.regex(/^[^<>]+ <[^<>\s]+@[^<>\s]+>$/, "must look like 'Name <email>'")
			.default("maintainer-agent <maintainer-agent@users.noreply.github.com>")
			.describe("Author of proposed commits."),
		limits: limits.default(() => limits.parse({})),
	})
	.strict();

const model = z
	.object({
		api_base: httpUrl.describe(
			"OpenAI-compatible base URL, e.g. http://10.0.0.5:8000/v1.",
		),
		model: z
			.string()
			.min(1)
			.describe("litellm model name, e.g. openai/<served-model-id>."),
		api_key: secret("API key sent to the endpoint.").optional(),
	})
	.strict();

const connection = z
	.object({
		platform: z.enum(["github", "gitlab"]).default("github"),
		host: host.default("github.com"),
		display_name: z.string().optional(),
		owner_account: z
			.string()
			.optional()
			.describe(
				"Organisation the app is registered under; omit for a personal account.",
			),
		app_id: z
			.union([z.string().regex(/^\d+$/), posInt.transform(String)])
			.describe("GitHub App id."),
		app_slug: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.describe("GitHub App slug (its URL name)."),
		private_key: secret("GitHub App private key (PEM)."),
		webhook_secret: secret("GitHub App webhook secret."),
		appearance_done: z
			.boolean()
			.default(false)
			.describe("The app's logo was uploaded (hides the reminder in /admin)."),
	})
	.strict();

const job = {
	enabled: z.boolean().optional(),
	max_attempts: posInt.optional(),
	step_limit: posInt.optional(),
};

const modelSelection = z.union([
	modelName,
	z
		.object({
			answer: modelName.optional(),
			fix: modelName.optional(),
			review: modelName.optional(),
		})
		.strict(),
]);

const repositoryLayer = z
	.object({
		enabled: z
			.boolean()
			.optional()
			.describe("false keeps the entry but pauses processing."),
		connection: z
			.string()
			.optional()
			.describe(
				"Id under `connections` to act through (needed only when several reach the repository).",
			),
		model: modelSelection
			.optional()
			.describe("Model name for every job, or per job: {answer, fix, review}."),
		answer: z
			.object({ ...job })
			.strict()
			.optional()
			.describe("First answers to new issues."),
		fix: z
			.object({ ...job, trigger: z.enum(["maintainers", "label"]).optional() })
			.strict()
			.optional()
			.describe("Draft pull requests for bugs and features."),
		review: z
			.object({
				...job,
				max_comments: z.number().int().min(0).optional(),
				max_diff_lines: posInt.optional(),
			})
			.strict()
			.optional()
			.describe("Comment-only reviews of new pull requests."),
		instructions: z
			.array(relPath)
			.max(10)
			.optional()
			.describe("Files the agent reads first."),
		playbooks: z
			.object({
				issue: relPath.optional(),
				implement: relPath.optional(),
				review: relPath.optional(),
			})
			.strict()
			.optional(),
		checks: z
			.array(z.string().max(300))
			.max(10)
			.optional()
			.describe("Commands the fix agent runs to verify a change."),
		egress: z
			.array(egressHost)
			.max(50)
			.optional()
			.describe("Extra hosts the fix agent may reach."),
		links: z
			.array(linkPrefix)
			.max(20)
			.optional()
			.describe("Extra URL prefixes allowed as links in posted text."),
		protected_paths: z
			.array(relPath)
			.max(50)
			.optional()
			.describe("Paths a proposed change must never touch."),
		allow_repository_egress: z
			.boolean()
			.optional()
			.describe(
				"Whether the repository's own policy file may add egress hosts.",
			),
	})
	.strict();

const repoKey = z
	.string()
	.regex(
		/^[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9_.-]+){2,}$/,
		"must be host/owner/name, e.g. github.com/octo/repo",
	);

export const SettingsFileSchema = z
	.object({
		version: z
			.literal(CURRENT_SETTINGS_VERSION)
			.describe("Schema version. The server migrates older files on start."),
		server,
		models: z
			.record(modelName, model)
			.refine((m) => "default" in m, "a model named `default` is required")
			.describe(
				"Named model endpoints; `default` is used unless a repository selects another.",
			),
		connections: z
			.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), connection)
			.default({})
			.describe(
				"Forge accounts (GitHub Apps). The key is the webhook path: /webhooks/<key>.",
			),
		defaults: repositoryLayer
			.default({})
			.describe(
				"Applies to every repository; a repository entry overrides it per key (maps merge, lists replace).",
			),
		repositories: z
			.record(
				repoKey,
				repositoryLayer.nullable().transform((v) => v ?? {}),
			)
			.default({})
			.describe(
				"The repositories this server acts on, keyed host/owner/name. Others are ignored.",
			),
	})
	.strict();

export type SettingsFile = z.output<typeof SettingsFileSchema>;

/** Paths (as dotted patterns, `*` = any key) of fields that hold secrets. */
export const SECRET_FIELDS: readonly string[] = [
	"server.admin_token",
	"models.*.api_key",
	"connections.*.private_key",
	"connections.*.webhook_secret",
];

export function settingsJsonSchema(): unknown {
	return z.toJSONSchema(SettingsFileSchema, {
		io: "input",
		target: "draft-2020-12",
	});
}
