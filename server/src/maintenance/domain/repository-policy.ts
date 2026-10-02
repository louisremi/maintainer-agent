import { DomainError } from '../../shared-kernel';
import { HostLimits } from './host-limits';

/** Where a repository may keep its policy, in lookup order. Always protected. */
export const POLICY_FILE_CANDIDATES = [
  '.maintainer-agent.yml',
  '.github/maintainer-agent.yml',
  '.gitlab/maintainer-agent.yml',
] as const;

export type FixTrigger = 'maintainers' | 'label';

/** The validated, normalised policy as produced by the policy validator. */
export interface PolicyData {
  readonly instructions: readonly string[];
  readonly playbooks: { readonly issue: string; readonly implement: string; readonly review: string };
  readonly checks: readonly string[];
  readonly egress: readonly string[];
  readonly links: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly answer: { readonly enabled: boolean; readonly maxAttempts: number };
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
  };
}

export const DEFAULT_POLICY: PolicyData = {
  instructions: [],
  playbooks: { issue: '', implement: '', review: '' },
  checks: [],
  egress: [],
  links: [],
  protectedPaths: [],
  answer: { enabled: true, maxAttempts: 2 },
  fix: { enabled: true, trigger: 'maintainers', maxAttempts: 2, stepLimit: 80 },
  review: { enabled: true, maxComments: 20, maxDiffLines: 5000, maxAttempts: 2 },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.trunc(v)));

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
    for (const p of [...data.instructions, ...data.protectedPaths, data.playbooks.issue, data.playbooks.implement, data.playbooks.review]) {
      if (p.startsWith('/') || p.split('/').includes('..')) throw new DomainError(`unsafe path in policy: ${p}`);
    }
    const cap = limits.maxAttemptsCap;
    return new RepositoryPolicy({
      ...data,
      protectedPaths: [...new Set([...data.protectedPaths, ...POLICY_FILE_CANDIDATES])].sort(),
      answer: { ...data.answer, maxAttempts: clamp(data.answer.maxAttempts, 1, cap) },
      fix: {
        ...data.fix,
        maxAttempts: clamp(data.fix.maxAttempts, 1, cap),
        stepLimit: clamp(data.fix.stepLimit, 10, limits.maxStepLimit),
      },
      review: {
        ...data.review,
        maxAttempts: clamp(data.review.maxAttempts, 1, cap),
        maxComments: clamp(data.review.maxComments, 0, limits.maxReviewComments),
        maxDiffLines: clamp(data.review.maxDiffLines, 100, limits.maxDiffLines),
      },
    });
  }

  get answer() { return this.data.answer; }
  get fix() { return this.data.fix; }
  get review() { return this.data.review; }
  get egress() { return this.data.egress; }
  get links() { return this.data.links; }

  /** Paths no proposed change may touch: the policy's, the forge's and the policy files. */
  protectedPaths(forgeDefaults: readonly string[]): string[] {
    return [...new Set([...this.data.protectedPaths, ...forgeDefaults])].sort();
  }
}
