import { Labels, RepositoryPolicy } from '../domain';
import { AgentMode, AgentTask, clip, LIMITS } from './agent-task';
import { ChangeRequestSnapshot, CommentSnapshot, ForgeSession, IssueSnapshot } from './ports';

/** Builds the task file for an agent run from forge snapshots and the policy. */
export function buildTask(input: {
  mode: AgentMode;
  session: ForgeSession;
  policy: RepositoryPolicy;
  defaultBranch: { name: string };
  subject: IssueSnapshot | ChangeRequestSnapshot;
  comments: readonly CommentSnapshot[];
  sha: string;
  priorAnalysis?: string;
  review?: AgentTask['review'];
}): AgentTask {
  const { session, policy, subject } = input;
  const isChange = input.mode === 'review';
  const playbook = input.mode === 'issue' ? policy.data.playbooks.issue
    : input.mode === 'fix' ? policy.data.playbooks.implement
    : policy.data.playbooks.review;
  return {
    version: 2,
    mode: input.mode,
    repository: {
      path: session.repo.path,
      webUrl: session.webUrl,
      permalinkBase: session.permalinkBase(input.sha),
      defaultBranch: input.defaultBranch.name,
    },
    terms: { changeRequest: session.terms.changeRequest, changeRequestShort: session.terms.changeRequestShort },
    subject: {
      kind: isChange ? 'change-request' : 'issue',
      number: subject.number,
      reference: isChange ? session.terms.changeRequestRef(subject.number) : session.terms.issueRef(subject.number),
      title: clip(subject.title, 300),
      body: clip(subject.body, LIMITS.bodyChars),
      authorLogin: subject.authorLogin,
      authorRole: subject.authorRole,
      labels: 'labels' in subject ? [...subject.labels] : [],
    },
    comments: input.comments
      .filter((c) => !c.isOwn)
      .slice(-LIMITS.comments)
      .map((c) => ({ author: c.authorLogin, role: c.authorRole, body: clip(c.body, LIMITS.commentChars), createdAt: c.createdAt })),
    policy: {
      instructions: [...policy.data.instructions],
      playbook,
      checks: [...policy.data.checks],
      protectedPaths: policy.protectedPaths(session.protectedPaths),
      fixLabel: Labels.fix,
    },
    priorAnalysis: clip(input.priorAnalysis ?? '', LIMITS.priorAnalysisChars),
    review: input.review ?? null,
  };
}

/** Closing line of everything the server posts. */
export function footer(note: string): string {
  const sig = '<sub>Automated answer by maintainer-agent. It can be wrong; maintainers decide.</sub>';
  return note ? `${note}\n\n${sig}` : sig;
}
