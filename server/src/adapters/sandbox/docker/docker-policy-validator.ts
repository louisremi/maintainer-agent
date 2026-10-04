import { z } from "zod";
import type {
	PolicyValidation,
	PolicyValidator,
} from "../../../maintenance/application";
import type { PolicyData } from "../../../maintenance/domain";
import type { DockerSandbox } from "./sandbox";

const PolicySchema = z.object({
	instructions: z.array(z.string()),
	playbooks: z.object({
		issue: z.string(),
		implement: z.string(),
		review: z.string(),
	}),
	checks: z.array(z.string()),
	egress: z.array(z.string()),
	links: z.array(z.string()),
	protected_paths: z.array(z.string()),
	answer: z.object({ enabled: z.boolean(), max_attempts: z.number().int() }),
	fix: z.object({
		enabled: z.boolean(),
		trigger: z.enum(["maintainers", "label"]),
		max_attempts: z.number().int(),
		step_limit: z.number().int(),
	}),
	review: z.object({
		enabled: z.boolean(),
		max_comments: z.number().int(),
		max_diff_lines: z.number().int(),
		max_attempts: z.number().int(),
	}),
});

export function toPolicyData(json: unknown): PolicyData {
	const p = PolicySchema.parse(json);
	return {
		instructions: p.instructions,
		playbooks: p.playbooks,
		checks: p.checks,
		egress: p.egress,
		links: p.links,
		protectedPaths: p.protected_paths,
		answer: { enabled: p.answer.enabled, maxAttempts: p.answer.max_attempts },
		fix: {
			enabled: p.fix.enabled,
			trigger: p.fix.trigger,
			maxAttempts: p.fix.max_attempts,
			stepLimit: p.fix.step_limit,
		},
		review: {
			enabled: p.review.enabled,
			maxComments: p.review.max_comments,
			maxDiffLines: p.review.max_diff_lines,
			maxAttempts: p.review.max_attempts,
		},
	};
}

/**
 * Validates a repository's policy file with the runner's `policy` role, in a
 * container without network: the file is untrusted input.
 */
export class DockerPolicyValidator implements PolicyValidator {
	constructor(
		private readonly sandbox: DockerSandbox,
		private readonly limits: { maxStepLimit: number; maxAttemptsCap: number },
	) {}

	async validate(raw: string): Promise<PolicyValidation> {
		const r = await this.sandbox.run({
			role: "policy",
			runId: `policy-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
			args: [],
			env: {
				MAX_STEP_LIMIT: String(this.limits.maxStepLimit),
				MAX_ATTEMPTS_CAP: String(this.limits.maxAttemptsCap),
			},
			mounts: [],
			egress: [],
			memoryMb: 128,
			timeoutMs: 30_000,
			readOnlyRoot: true,
			stdin: raw.slice(0, 65536),
		});
		if (r.exitCode === 1) {
			const errors = r.stderr
				.split("\n")
				.map((l) => l.replace(/^policy error: /, "").trim())
				.filter(Boolean);
			return { ok: false, errors: errors.length ? errors : ["invalid policy"] };
		}
		if (r.exitCode !== 0)
			throw new Error(
				`policy validator failed (exit ${r.exitCode}): ${r.stderr.slice(0, 300)}`,
			);
		try {
			return { ok: true, data: toPolicyData(JSON.parse(r.stdout)) };
		} catch (err) {
			throw new Error(
				`policy validator returned unexpected output: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
