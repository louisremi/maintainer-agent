import { DomainError } from "../../shared-kernel";
import type { HostLimits } from "./host-limits";

/** Where a repository may keep its policy, in lookup order. Always protected. */
export const POLICY_FILE_CANDIDATES = [
	".maintainer-agent.yml",
	".github/maintainer-agent.yml",
	".gitlab/maintainer-agent.yml",
] as const;

export type FixTrigger = "maintainers" | "label";

/** The validated, normalised policy as produced by the policy validator. */
export interface PolicyData {
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
	readonly answer: {
		readonly enabled: boolean;
		readonly maxAttempts: number;
		readonly stepLimit: number;
	};
	readonly fix: {
		readonly enabled: boolean;
		readonly trigger: FixTrigger;
		readonly maxAttempts: number;
		readonly stepLimit: number;
	};
	readonly review: {
		readonly enabled: boolean;
		readonly maxComments: number;
		readonly maxDiffLines: number;
		readonly maxAttempts: number;
		readonly stepLimit: number;
	};
}

/**
 * A repository's own policy file, as validated: its values plus which
 * settings it actually wrote (dotted names, e.g. "fix.step_limit"). Only
 * those are layered over the server's settings.
 */
export interface RepositoryFilePolicy {
	readonly data: PolicyData;
	readonly setKeys: readonly string[];
}

export const DEFAULT_POLICY: PolicyData = {
	instructions: [],
	playbooks: { issue: "", implement: "", review: "" },
	checks: [],
	egress: [],
	links: [],
	protectedPaths: [],
	answer: { enabled: true, maxAttempts: 2, stepLimit: 30 },
	fix: { enabled: true, trigger: "maintainers", maxAttempts: 2, stepLimit: 80 },
	review: {
		enabled: true,
		maxComments: 20,
		maxDiffLines: 5000,
		maxAttempts: 2,
		stepLimit: 40,
	},
};

const clamp = (v: number, lo: number, hi: number) =>
	Math.max(lo, Math.min(hi, Math.trunc(v)));

/**
 * How maintainer-agent behaves in one repository. The policy comes from the
 * repository itself, so it can tailor behaviour but never widen what the
 * server operator allows: every limit is clamped to {@link HostLimits}.
 */
export class RepositoryPolicy {
	private constructor(readonly data: PolicyData) {}

	static defaults(limits: HostLimits): RepositoryPolicy {
		return RepositoryPolicy.from(DEFAULT_POLICY, limits);
	}

	static from(data: PolicyData, limits: HostLimits): RepositoryPolicy {
		for (const p of [
			...data.instructions,
			...data.protectedPaths,
			data.playbooks.issue,
			data.playbooks.implement,
			data.playbooks.review,
		]) {
			if (p.startsWith("/") || p.split("/").includes(".."))
				throw new DomainError(`unsafe path in policy: ${p}`);
		}
		const cap = limits.maxAttemptsCap;
		return new RepositoryPolicy({
			...data,
			protectedPaths: [
				...new Set([...data.protectedPaths, ...POLICY_FILE_CANDIDATES]),
			].sort(),
			answer: {
				...data.answer,
				maxAttempts: clamp(data.answer.maxAttempts, 1, cap),
				stepLimit: clamp(data.answer.stepLimit, 5, limits.maxStepLimit),
			},
			fix: {
				...data.fix,
				maxAttempts: clamp(data.fix.maxAttempts, 1, cap),
				stepLimit: clamp(data.fix.stepLimit, 10, limits.maxStepLimit),
			},
			review: {
				...data.review,
				maxAttempts: clamp(data.review.maxAttempts, 1, cap),
				maxComments: clamp(
					data.review.maxComments,
					0,
					limits.maxReviewComments,
				),
				maxDiffLines: clamp(data.review.maxDiffLines, 100, limits.maxDiffLines),
				stepLimit: clamp(data.review.stepLimit, 5, limits.maxStepLimit),
			},
		});
	}

	/**
	 * The operator's settings for a repository with the repository's own
	 * file layered on top. The file can only narrow: it can switch features
	 * off, lower limits, add checks, links and protected paths, and add
	 * egress hosts only when the operator allows it. It can never switch on
	 * what the operator switched off, nor raise a limit.
	 */
	static layered(
		base: PolicyData,
		file: RepositoryFilePolicy | null,
		limits: HostLimits,
		allowRepositoryEgress: boolean,
	): RepositoryPolicy {
		if (!file) return RepositoryPolicy.from(base, limits);
		const set = new Set(file.setKeys);
		const has = (k: string) => set.has(k);
		const f = file.data;
		const lower = (b: number, k: string, v: number) =>
			has(k) ? Math.min(b, v) : b;
		const narrowOn = (b: boolean, k: string, v: boolean) =>
			has(k) ? b && v : b;
		const union = (b: readonly string[], k: string, v: readonly string[]) =>
			has(k) ? [...new Set([...b, ...v])] : b;
		const pick = (b: string, k: string, v: string) => (has(k) && v ? v : b);
		return RepositoryPolicy.from(
			{
				instructions: has("instructions") ? f.instructions : base.instructions,
				playbooks: {
					issue: pick(
						base.playbooks.issue,
						"playbooks.issue",
						f.playbooks.issue,
					),
					implement: pick(
						base.playbooks.implement,
						"playbooks.implement",
						f.playbooks.implement,
					),
					review: pick(
						base.playbooks.review,
						"playbooks.review",
						f.playbooks.review,
					),
				},
				checks: union(base.checks, "checks", f.checks),
				egress: allowRepositoryEgress
					? union(base.egress, "egress", f.egress)
					: base.egress,
				links: union(base.links, "links", f.links),
				protectedPaths: union(
					base.protectedPaths,
					"protected_paths",
					f.protectedPaths,
				),
				answer: {
					enabled: narrowOn(
						base.answer.enabled,
						"answer.enabled",
						f.answer.enabled,
					),
					maxAttempts: lower(
						base.answer.maxAttempts,
						"answer.max_attempts",
						f.answer.maxAttempts,
					),
					stepLimit: base.answer.stepLimit,
				},
				fix: {
					enabled: narrowOn(base.fix.enabled, "fix.enabled", f.fix.enabled),
					// "label" is the stricter trigger: a file may require it, never relax it.
					trigger:
						base.fix.trigger === "label" ||
						(has("fix.trigger") && f.fix.trigger === "label")
							? "label"
							: "maintainers",
					maxAttempts: lower(
						base.fix.maxAttempts,
						"fix.max_attempts",
						f.fix.maxAttempts,
					),
					stepLimit: lower(
						base.fix.stepLimit,
						"fix.step_limit",
						f.fix.stepLimit,
					),
				},
				review: {
					enabled: narrowOn(
						base.review.enabled,
						"review.enabled",
						f.review.enabled,
					),
					maxComments: lower(
						base.review.maxComments,
						"review.max_comments",
						f.review.maxComments,
					),
					maxDiffLines: lower(
						base.review.maxDiffLines,
						"review.max_diff_lines",
						f.review.maxDiffLines,
					),
					maxAttempts: lower(
						base.review.maxAttempts,
						"review.max_attempts",
						f.review.maxAttempts,
					),
					stepLimit: base.review.stepLimit,
				},
			},
			limits,
		);
	}

	get answer() {
		return this.data.answer;
	}
	get fix() {
		return this.data.fix;
	}
	get review() {
		return this.data.review;
	}
	get egress() {
		return this.data.egress;
	}
	get links() {
		return this.data.links;
	}

	/** Paths no proposed change may touch: the policy's, the forge's and the policy files. */
	protectedPaths(forgeDefaults: readonly string[]): string[] {
		return [...new Set([...this.data.protectedPaths, ...forgeDefaults])].sort();
	}
}
