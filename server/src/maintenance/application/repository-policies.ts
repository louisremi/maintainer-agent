import type { Logger, RepoRef } from "../../shared-kernel";
import {
	type HostLimits,
	POLICY_FILE_CANDIDATES,
	RepositoryPolicy,
} from "../domain";
import type {
	ForgeSession,
	PolicyValidator,
	RepositoryConfiguration,
	RepositoryConfigurations,
} from "./ports";

export type PolicyLookup =
	| {
			readonly ok: true;
			readonly policy: RepositoryPolicy;
			readonly models: RepositoryConfiguration["models"];
			readonly source: string | null;
	  }
	| {
			readonly ok: false;
			/** The policy file at fault, or null when the repository is not configured. */
			readonly source: string | null;
			readonly errors: readonly string[];
	  };

/**
 * The effective policy of a repository: the operator's settings for it
 * (settings.yml), narrowed by the repository's own policy file found on its
 * default branch and validated in isolation. A repository absent from the
 * settings (or paused) gets nothing; an invalid policy file means the server
 * does nothing there until it is fixed (typos must never silently switch a
 * safeguard off).
 */
export class RepositoryPolicies {
	constructor(
		private readonly validator: PolicyValidator,
		private readonly configurations: RepositoryConfigurations,
		private readonly limits: HostLimits,
		private readonly log: Logger,
	) {}

	isConfigured(repo: RepoRef): boolean {
		return this.configurations.for(repo) !== null;
	}

	async load(
		session: ForgeSession,
		defaultBranch: string,
	): Promise<PolicyLookup> {
		const config = this.configurations.for(session.repo);
		if (!config) {
			return {
				ok: false,
				source: null,
				errors: [
					"the repository is not configured in settings.yml (or is paused)",
				],
			};
		}
		for (const path of POLICY_FILE_CANDIDATES) {
			const raw = await session.readFile(path, defaultBranch);
			if (raw === null) continue;
			const result = await this.validator.validate(raw);
			if (!result.ok) {
				this.log.warn("invalid repository policy; ignoring the repository", {
					repo: session.repo.key,
					path,
					errors: result.errors,
				});
				return { ok: false, source: path, errors: result.errors };
			}
			return {
				ok: true,
				policy: RepositoryPolicy.layered(
					config.base,
					result.policy,
					this.limits,
					config.allowRepositoryEgress,
				),
				models: config.models,
				source: path,
			};
		}
		return {
			ok: true,
			policy: RepositoryPolicy.layered(
				config.base,
				null,
				this.limits,
				config.allowRepositoryEgress,
			),
			models: config.models,
			source: null,
		};
	}
}
