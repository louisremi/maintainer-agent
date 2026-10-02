import { createHash } from 'node:crypto';
import { RepoRef, Role } from '../../../shared-kernel';
import {
  ChangeRequestSnapshot,
  CommentSnapshot,
  ForgeSession,
  ForgeTerms,
  GitAccess,
  IssueSnapshot,
} from '../../../maintenance/application';
import { InlineComment, LabelDefinition } from '../../../maintenance/domain';
import { GithubAppClient, TokenScope } from './github-app-client';
import { GithubApiError } from './github-http';

const MAINTAINER_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const MAINTAINER_PERMISSIONS = ['admin', 'maintain', 'write'];

export const GITHUB_TERMS: ForgeTerms = {
  changeRequest: 'pull request',
  changeRequestShort: 'PR',
  changeRequestRef: (n) => `#${n}`,
  issueRef: (n) => `#${n}`,
};

/** Files GitHub runs as automation: an agent change must never touch them. */
export const GITHUB_PROTECTED_PATHS = ['.github/**'];

interface GhUser { login: string; type?: string }
interface GhLabel { name: string }
interface GhIssue {
  number: number; title: string; body: string | null; user: GhUser | null; author_association: string;
  labels: (GhLabel | string)[]; state: string; pull_request?: unknown;
}
interface GhComment { user: GhUser | null; author_association: string; body: string | null; created_at: string; performed_via_github_app?: { slug: string } | null }
interface GhPull {
  number: number; title: string; body: string | null; user: GhUser | null; author_association: string; state: string; draft?: boolean;
  base: { ref: string; sha: string }; head: { sha: string };
}

export function roleFromAssociation(association: string | undefined): Role {
  return MAINTAINER_ASSOCIATIONS.includes(association ?? '') ? 'maintainer' : 'other';
}

const labelName = (l: GhLabel | string) => (typeof l === 'string' ? l : l.name);
const enc = encodeURIComponent;

/** The GitHub implementation of {@link ForgeSession} for one repository. */
export class GithubForgeSession implements ForgeSession {
  readonly terms = GITHUB_TERMS;
  readonly protectedPaths = GITHUB_PROTECTED_PATHS;
  readonly webUrl: string;
  readonly botLogin: string;
  private readonly base: string;

  constructor(readonly repo: RepoRef, private readonly app: GithubAppClient) {
    this.webUrl = `${app.host.webUrl}/${repo.path}`;
    this.botLogin = app.access.credentials.botLogin;
    this.base = `/repos/${repo.owner}/${repo.name}`;
  }

  permalinkBase(sha: string): string {
    return `${this.webUrl}/blob/${sha}`;
  }

  private async call<T>(scope: TokenScope, method: string, path: string, body?: unknown, accept?: string): Promise<T> {
    const token = await this.app.repoToken(this.repo.owner, this.repo.name, scope);
    return this.app.http.request<T>(method, `${this.base}${path}`, `token ${token}`, body, accept);
  }

  private async optional<T>(p: Promise<T>): Promise<T | null> {
    try {
      return await p;
    } catch (err) {
      if (err instanceof GithubApiError && (err.status === 404 || err.status === 410)) return null;
      throw err;
    }
  }

  async getIssue(number: number): Promise<IssueSnapshot | null> {
    const i = await this.optional(this.call<GhIssue>('write-issues', 'GET', `/issues/${number}`));
    if (!i || i.pull_request) return null;
    return {
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      authorLogin: i.user?.login ?? 'ghost',
      authorRole: roleFromAssociation(i.author_association),
      labels: i.labels.map(labelName),
      isOpen: i.state === 'open',
      fingerprint: createHash('sha256').update(i.body ?? '').digest('hex').slice(0, 32),
    };
  }

  async listIssueComments(number: number, limit: number): Promise<CommentSnapshot[]> {
    const per = Math.min(100, Math.max(1, limit));
    const out: CommentSnapshot[] = [];
    for (let page = 1; out.length < limit && page <= 10; page++) {
      const batch = await this.call<GhComment[]>('write-issues', 'GET', `/issues/${number}/comments?per_page=${per}&page=${page}`);
      for (const c of batch) {
        const login = c.user?.login ?? 'ghost';
        out.push({
          authorLogin: login,
          authorRole: roleFromAssociation(c.author_association),
          body: c.body ?? '',
          createdAt: c.created_at,
          isOwn: login.toLowerCase() === this.botLogin.toLowerCase(),
        });
      }
      if (batch.length < per) break;
    }
    return out.slice(-limit);
  }

  async getChangeRequest(number: number): Promise<ChangeRequestSnapshot | null> {
    const p = await this.optional(this.call<GhPull>('write-issues', 'GET', `/pulls/${number}`));
    if (!p) return null;
    return {
      number: p.number,
      title: p.title,
      body: p.body ?? '',
      authorLogin: p.user?.login ?? 'ghost',
      authorRole: roleFromAssociation(p.author_association),
      isOpen: p.state === 'open',
      isDraft: Boolean(p.draft),
      baseBranch: p.base.ref,
      baseSha: p.base.sha,
      headSha: p.head.sha,
      headFetchRef: `refs/pull/${p.number}/head`,
    };
  }

  async getDefaultBranch(): Promise<{ name: string; sha: string }> {
    const r = await this.call<{ default_branch: string }>('read', 'GET', '');
    const b = await this.call<{ commit: { sha: string } }>('read', 'GET', `/branches/${enc(r.default_branch)}`);
    return { name: r.default_branch, sha: b.commit.sha };
  }

  async readFile(path: string, ref: string): Promise<string | null> {
    const segments = path.split('/').map(enc).join('/');
    const r = await this.optional(this.call<{ type: string; encoding?: string; content?: string; size: number }>(
      'read', 'GET', `/contents/${segments}?ref=${enc(ref)}`,
    ));
    if (!r || Array.isArray(r) || r.type !== 'file' || r.encoding !== 'base64' || r.size > 256 * 1024) return null;
    return Buffer.from(r.content ?? '', 'base64').toString('utf8');
  }

  async roleOf(login: string): Promise<Role> {
    const r = await this.optional(this.call<{ permission: string; role_name?: string }>('read', 'GET', `/collaborators/${enc(login)}/permission`));
    if (!r) return 'other';
    return MAINTAINER_PERMISSIONS.includes(r.role_name ?? r.permission) || MAINTAINER_PERMISSIONS.includes(r.permission) ? 'maintainer' : 'other';
  }

  async comment(number: number, body: string): Promise<{ url: string }> {
    const r = await this.call<{ html_url: string }>('write-issues', 'POST', `/issues/${number}/comments`, { body });
    return { url: r.html_url };
  }

  async ensureLabels(labels: readonly LabelDefinition[]): Promise<void> {
    for (const l of labels) {
      try {
        await this.call('write-issues', 'POST', '/labels', { name: l.name, color: l.color, description: l.description });
      } catch (err) {
        if (!(err instanceof GithubApiError && err.status === 422)) throw err; // 422 = exists
      }
    }
  }

  async addLabel(number: number, label: string): Promise<void> {
    await this.call('write-issues', 'POST', `/issues/${number}/labels`, { labels: [label] });
  }

  async removeLabel(number: number, label: string): Promise<void> {
    await this.optional(this.call('write-issues', 'DELETE', `/issues/${number}/labels/${enc(label)}`));
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await this.optional(this.call('read', 'GET', `/branches/${branch.split('/').map(enc).join('/')}`))) !== null;
  }

  async openDraftChangeRequest(input: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const r = await this.call<{ number: number; html_url: string }>('write-issues', 'POST', '/pulls', { ...input, draft: true, maintainer_can_modify: true });
    return { number: r.number, url: r.html_url };
  }

  async postReview(number: number, input: { headSha: string; summary: string; comments: readonly InlineComment[] }): Promise<{ url: string }> {
    const r = await this.call<{ html_url: string }>('write-issues', 'POST', `/pulls/${number}/reviews`, {
      commit_id: input.headSha,
      event: 'COMMENT',
      body: input.summary,
      comments: input.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
    });
    return { url: r.html_url };
  }

  async gitAccess(scope: 'read' | 'push'): Promise<GitAccess> {
    const token = await this.app.repoToken(this.repo.owner, this.repo.name, scope === 'push' ? 'push' : 'read');
    return {
      remoteUrl: `${this.webUrl}.git`,
      authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      egressHosts: this.app.host.egressHosts,
    };
  }
}
