import { describe, expect, it } from 'vitest';
import { AccountAllowList } from '../../src/shared-kernel';
import { EventTriage, FixEligibility, ForgeEvent, TriageContext, Verdict } from '../../src/maintenance/domain';
import { anyone, issueOpened, policy, REPO } from '../support/builders';

const ctx = (over: Partial<TriageContext> = {}): TriageContext => ({
  policy: policy(),
  allowList: anyone,
  ownBotLogin: 'ma-test[bot]',
  actorRole: null,
  authorJobsToday: 0,
  maxJobsPerAuthorPerDay: 5,
  ...over,
});

const labeled = (label: string, kind: 'issue' | 'cr' = 'issue'): ForgeEvent =>
  kind === 'issue'
    ? { type: 'issue-labeled', repo: REPO, number: 7, actor: { login: 'bob', isBot: false }, labels: [label], label }
    : { type: 'change-request-labeled', repo: REPO, number: 7, actor: { login: 'bob', isBot: false }, labels: [label], label, isDraft: false };

const crOpened = (over: Partial<Extract<ForgeEvent, { type: 'change-request-opened' }>> = {}): ForgeEvent => ({
  type: 'change-request-opened', repo: REPO, number: 9, actor: { login: 'carol', isBot: false }, labels: [], authorRole: 'other', isDraft: false, ...over,
});

const decide = (e: ForgeEvent, c: Partial<TriageContext> = {}) => EventTriage.decide(e, ctx(c));

describe('EventTriage', () => {
  it.each([
    ['a new issue is answered', issueOpened(), {}, 'answer-issue'],
    ['an outsider issue is answered too', issueOpened({ authorRole: 'other' }), {}, 'answer-issue'],
    ['agent-fix by a maintainer proposes a fix', labeled('agent-fix'), { actorRole: 'maintainer' }, 'propose-fix'],
    ['a new change request is reviewed', crOpened(), {}, 'review-change-request'],
    ['agent-rereview by a maintainer reviews again', labeled('agent-rereview', 'cr'), { actorRole: 'maintainer' }, 'review-change-request'],
    ['maintainers are not capped', issueOpened(), { authorJobsToday: 99 }, 'answer-issue'],
  ] as const)('%s', (_, event, c, job) => {
    expect(decide(event, c)).toEqual({ kind: 'job', job });
  });

  it.each([
    ['accounts outside the allow-list', issueOpened(), { allowList: AccountAllowList.parse('someone-else') }, /not allowed/],
    ['bots', issueOpened({ actor: { login: 'renovate[bot]', isBot: true } }), {}, /bot/],
    ['the agent itself', issueOpened({ actor: { login: 'ma-test', isBot: false } }), {}, /bot/],
    ['opted-out items', issueOpened({ labels: ['no-agent'] }), {}, /no-agent/],
    ['agent-fix from a non-maintainer', labeled('agent-fix'), { actorRole: 'other' }, /not added by a maintainer/],
    ['other labels', labeled('bug'), { actorRole: 'maintainer' }, /not for the agent/],
    ['draft change requests', crOpened({ isDraft: true }), {}, /draft/],
    ['outsiders over the daily cap', issueOpened({ authorRole: 'other' }), { authorJobsToday: 5 }, /daily job limit/],
    ['answers disabled by policy', issueOpened(), { policy: policy({ answer: { enabled: false, maxAttempts: 1 } }) }, /disabled/],
    ['reviews disabled by policy', crOpened(), { policy: policy({ review: { enabled: false, maxComments: 1, maxDiffLines: 100, maxAttempts: 1 } }) }, /disabled/],
    ['fixes disabled by policy', labeled('agent-fix'), { actorRole: 'maintainer', policy: policy({ fix: { enabled: false, trigger: 'maintainers', maxAttempts: 1, stepLimit: 20 } }) }, /disabled/],
  ] as const)('ignores %s', (_, event, c, reason) => {
    const d = decide(event, c as Partial<TriageContext>);
    expect(d.kind).toBe('ignore');
    if (d.kind === 'ignore') expect(d.reason).toMatch(reason);
  });
});

describe('FixEligibility', () => {
  const bug = Verdict.of('bug', 'analysis');
  const question = Verdict.of('question', 'answer');

  it('proposes automatically for maintainers and suggests the label for others', () => {
    expect(FixEligibility.decide(bug, 'maintainer', policy()).kind).toBe('propose');
    expect(FixEligibility.decide(bug, 'other', policy()).kind).toBe('suggest-label');
    expect(FixEligibility.decide(question, 'maintainer', policy()).kind).toBe('none');
  });

  it('always asks for the label when the policy says so', () => {
    const p = policy({ fix: { enabled: true, trigger: 'label', maxAttempts: 2, stepLimit: 80 } });
    expect(FixEligibility.decide(bug, 'maintainer', p).kind).toBe('suggest-label');
  });

  it('does nothing when fixes are disabled', () => {
    const p = policy({ fix: { enabled: false, trigger: 'maintainers', maxAttempts: 2, stepLimit: 80 } });
    expect(FixEligibility.decide(bug, 'maintainer', p).kind).toBe('none');
  });
});
