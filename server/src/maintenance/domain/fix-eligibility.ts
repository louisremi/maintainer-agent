import { Role } from '../../shared-kernel';
import { Verdict } from './agent-results';
import { RepositoryPolicy } from './repository-policy';

export type FixDecision =
  | { readonly kind: 'propose' }
  | { readonly kind: 'suggest-label' }
  | { readonly kind: 'none' };

/**
 * After an issue was analysed: should the agent go on and propose a change?
 * Automatically only for maintainers' issues (unless the policy asks for a
 * label every time); for everyone else a maintainer adds `agent-fix`.
 */
export const FixEligibility = {
  decide(verdict: Verdict, authorRole: Role, policy: RepositoryPolicy): FixDecision {
    if (!verdict.callsForChange || !policy.fix.enabled) return { kind: 'none' };
    if (policy.fix.trigger === 'maintainers' && authorRole === 'maintainer') return { kind: 'propose' };
    return { kind: 'suggest-label' };
  },
};
