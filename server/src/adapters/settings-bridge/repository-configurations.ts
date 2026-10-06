import type {
	ModelChoice,
	RepositoryConfiguration,
	RepositoryConfigurations,
} from "../../maintenance/application";
import type { HostLimits, JobKind } from "../../maintenance/domain";
import {
	effectiveRepositorySettings,
	type JobKindName,
	type Settings,
} from "../../settings/domain";
import type { RepoRef } from "../../shared-kernel";

const JOB_KINDS: Record<JobKind, JobKindName> = {
	"answer-issue": "answer",
	"propose-fix": "fix",
	"review-change-request": "review",
};

/** settings.yml repository keys: `host/path`. */
export function settingsKey(repo: RepoRef): string {
	return `${repo.host}/${repo.path}`;
}

export function hostLimits(settings: Settings): HostLimits {
	const l = settings.server.limits;
	return {
		maxStepLimit: l.maxStepLimit,
		maxAttemptsCap: l.maxAttempts,
		maxJobsPerAuthorPerDay: l.maxJobsPerAuthorPerDay,
		maxReviewComments: l.maxReviewComments,
		maxDiffLines: l.maxDiffLines,
	};
}

/**
 * Bridges the settings context to the maintenance context: what the
 * operator configured for each repository, in maintenance's terms.
 */
export class SettingsRepositoryConfigurations
	implements RepositoryConfigurations
{
	constructor(private readonly settings: Settings) {}

	for(repo: RepoRef): RepositoryConfiguration | null {
		const s = effectiveRepositorySettings(this.settings, settingsKey(repo));
		if (!s?.enabled) return null;
		const model = (name: string): ModelChoice => {
			const m = this.settings.models[name];
			if (!m) throw new Error(`unknown model ${name}`); // prevented by validation
			return { apiBase: m.apiBase, model: m.model, apiKey: m.apiKey };
		};
		return {
			base: {
				instructions: s.instructions,
				playbooks: s.playbooks,
				checks: s.checks,
				egress: s.egress,
				links: s.links,
				protectedPaths: s.protectedPaths,
				answer: {
					enabled: s.answer.enabled,
					maxAttempts: s.answer.maxAttempts,
					stepLimit: s.answer.stepLimit,
				},
				fix: {
					enabled: s.fix.enabled,
					trigger: s.fix.trigger,
					maxAttempts: s.fix.maxAttempts,
					stepLimit: s.fix.stepLimit,
				},
				review: {
					enabled: s.review.enabled,
					maxAttempts: s.review.maxAttempts,
					stepLimit: s.review.stepLimit,
					maxComments: s.review.maxComments,
					maxDiffLines: s.review.maxDiffLines,
				},
			},
			models: Object.fromEntries(
				Object.entries(JOB_KINDS).map(([kind, name]) => [
					kind,
					model(s.model[name]),
				]),
			) as Record<JobKind, ModelChoice>,
			allowRepositoryEgress: s.allowRepositoryEgress,
			connectionId: s.connection,
		};
	}

	allModels(): readonly ModelChoice[] {
		const used = new Set<string>();
		for (const key of Object.keys(this.settings.repositories)) {
			const s = effectiveRepositorySettings(this.settings, key);
			if (s?.enabled) for (const name of Object.values(s.model)) used.add(name);
		}
		if (!used.size) used.add("default");
		return [...used].flatMap((name) => {
			const m = this.settings.models[name];
			return m
				? [{ apiBase: m.apiBase, model: m.model, apiKey: m.apiKey }]
				: [];
		});
	}
}
