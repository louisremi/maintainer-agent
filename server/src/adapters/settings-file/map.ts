import type {
	ConnectionSettings,
	ModelEndpoint,
	RepositoryLayer,
	Settings,
} from "../../settings/domain";
import type { SettingsFile } from "./schema";

type Layer = SettingsFile["defaults"];

function layer(l: Layer): RepositoryLayer {
	const job = <
		T extends { enabled?: boolean; max_attempts?: number; step_limit?: number },
	>(
		j: T | undefined,
	) =>
		j && {
			...(j.enabled !== undefined ? { enabled: j.enabled } : {}),
			...(j.max_attempts !== undefined ? { maxAttempts: j.max_attempts } : {}),
			...(j.step_limit !== undefined ? { stepLimit: j.step_limit } : {}),
		};
	const out: Record<string, unknown> = {
		enabled: l.enabled,
		connection: l.connection,
		model: l.model,
		answer: job(l.answer),
		fix: l.fix && {
			...job(l.fix),
			...(l.fix.trigger ? { trigger: l.fix.trigger } : {}),
		},
		review: l.review && {
			...job(l.review),
			...(l.review.max_comments !== undefined
				? { maxComments: l.review.max_comments }
				: {}),
			...(l.review.max_diff_lines !== undefined
				? { maxDiffLines: l.review.max_diff_lines }
				: {}),
		},
		instructions: l.instructions,
		playbooks: l.playbooks,
		checks: l.checks,
		egress: l.egress,
		links: l.links,
		protectedPaths: l.protected_paths,
		allowRepositoryEgress: l.allow_repository_egress,
	};
	for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
	return out as RepositoryLayer;
}

/** File format (validated, secrets resolved) → domain settings. */
export function toSettings(f: SettingsFile): Settings {
	const s = f.server;
	return {
		version: f.version,
		server: {
			publicUrl: s.public_url.replace(/\/+$/, ""),
			publicPathsOnlyViaHost: s.public_paths_only_via_host ?? null,
			adminToken: s.admin_token ?? null,
			allowedAccounts: s.allowed_accounts,
			runnerImage: s.runner_image,
			dockerPull: s.docker_pull,
			maxConcurrentJobs: s.max_concurrent_jobs,
			jobRetentionDays: s.job_retention_days,
			gitAuthor: s.git_author,
			limits: {
				maxStepLimit: s.limits.max_step_limit,
				maxAttempts: s.limits.max_attempts,
				maxJobsPerAuthorPerDay: s.limits.max_jobs_per_author_per_day,
				maxReviewComments: s.limits.max_review_comments,
				maxDiffLines: s.limits.max_diff_lines,
			},
		},
		models: Object.fromEntries(
			Object.entries(f.models).map(([k, m]): [string, ModelEndpoint] => [
				k,
				{
					apiBase: m.api_base.replace(/\/+$/, ""),
					model: m.model,
					apiKey: m.api_key ?? null,
				},
			]),
		),
		connections: Object.fromEntries(
			Object.entries(f.connections).map(
				([k, c]): [string, ConnectionSettings] => [
					k,
					{
						platform: c.platform,
						host: c.host,
						displayName: c.display_name ?? null,
						ownerAccount: c.owner_account ?? null,
						appId: c.app_id,
						appSlug: c.app_slug,
						privateKey: c.private_key,
						webhookSecret: c.webhook_secret,
						appearanceDone: c.appearance_done,
					},
				],
			),
		),
		defaults: layer(f.defaults),
		repositories: Object.fromEntries(
			Object.entries(f.repositories).map(([k, l]) => [k, layer(l)]),
		),
	};
}
