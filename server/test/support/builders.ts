import { AccountAllowList, RepoRef } from '../../src/shared-kernel';
import {
  DEFAULT_HOST_LIMITS,
  DEFAULT_POLICY,
  ForgeEvent,
  PolicyData,
  RepositoryPolicy,
} from '../../src/maintenance/domain';

export const REPO = RepoRef.of('github', 'github.com', 'octo/widgets');
export const T0 = new Date('2026-10-01T10:00:00Z');

export function policy(overrides: Partial<PolicyData> = {}): RepositoryPolicy {
  return RepositoryPolicy.from({ ...DEFAULT_POLICY, ...overrides }, DEFAULT_HOST_LIMITS);
}

export function issueOpened(over: Partial<Extract<ForgeEvent, { type: 'issue-opened' }>> = {}): ForgeEvent {
  return {
    type: 'issue-opened',
    repo: REPO,
    number: 7,
    actor: { login: 'alice', isBot: false },
    labels: [],
    authorRole: 'maintainer',
    ...over,
  };
}

export const anyone = AccountAllowList.parse([]);
