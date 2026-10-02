import { ConnectionAccess } from '../../../connections/application';
import { appJwt, Fetch, githubHost, GithubHost, GithubHttp } from './github-http';

export type TokenScope = 'read' | 'write-issues' | 'push';

/** Minimal permissions per use. Tokens are also limited to one repository. */
const SCOPE_PERMISSIONS: Record<TokenScope, Record<string, string>> = {
  read: { contents: 'read', metadata: 'read' },
  'write-issues': { contents: 'read', issues: 'write', pull_requests: 'write', metadata: 'read' },
  push: { contents: 'write', metadata: 'read' },
};

interface CachedToken { token: string; expiresAt: number }

/**
 * Acts as one GitHub App: finds installations and mints installation tokens
 * downscoped to a single repository and the permissions a step needs.
 */
export class GithubAppClient {
  readonly host: GithubHost;
  readonly http: GithubHttp;
  private readonly installations = new Map<string, { id: number; at: number }>();
  private readonly tokens = new Map<string, CachedToken>();

  constructor(readonly access: ConnectionAccess, fetchImpl: Fetch = fetch, private readonly now: () => number = Date.now) {
    this.host = githubHost(access.host);
    this.http = new GithubHttp(this.host, fetchImpl);
  }

  private jwt(): string {
    const key = this.access.credentials.secrets['privateKey'];
    if (!key) throw new Error(`connection ${this.access.connectionId} has no private key`);
    return `Bearer ${appJwt(this.access.credentials.appId, key, this.now())}`;
  }

  async appRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.http.request<T>(method, path, this.jwt(), body);
  }

  async installationIdFor(owner: string, repo: string): Promise<number> {
    const key = `${owner}/${repo}`.toLowerCase();
    const cached = this.installations.get(key);
    if (cached && this.now() - cached.at < 10 * 60_000) return cached.id;
    const r = await this.appRequest<{ id: number }>('GET', `/repos/${owner}/${repo}/installation`);
    this.installations.set(key, { id: r.id, at: this.now() });
    return r.id;
  }

  /** An installation token for one repository; cached until shortly before it expires. */
  async repoToken(owner: string, repo: string, scope: TokenScope): Promise<string> {
    const key = `${owner}/${repo}:${scope}`.toLowerCase();
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - this.now() > 5 * 60_000) return cached.token;
    const installation = await this.installationIdFor(owner, repo);
    const r = await this.appRequest<{ token: string; expires_at: string }>('POST', `/app/installations/${installation}/access_tokens`, {
      repositories: [repo],
      permissions: SCOPE_PERMISSIONS[scope],
    });
    this.tokens.set(key, { token: r.token, expiresAt: Date.parse(r.expires_at) });
    return r.token;
  }

  /** An installation token for listing an installation's repositories. */
  async installationToken(installationId: number): Promise<string> {
    const r = await this.appRequest<{ token: string }>('POST', `/app/installations/${installationId}/access_tokens`, {
      permissions: { metadata: 'read' },
    });
    return r.token;
  }
}

/** Keeps one client per connection (and its token caches) for the process lifetime. */
export class GithubAppClients {
  private readonly clients = new Map<string, { client: GithubAppClient; fingerprint: string }>();

  constructor(private readonly fetchImpl: Fetch = fetch) {}

  for(access: ConnectionAccess): GithubAppClient {
    const fingerprint = `${access.host}|${access.credentials.appId}|${access.credentials.secrets['privateKey']?.length ?? 0}`;
    const existing = this.clients.get(access.connectionId);
    if (existing && existing.fingerprint === fingerprint) return existing.client;
    const client = new GithubAppClient(access, this.fetchImpl);
    this.clients.set(access.connectionId, { client, fingerprint });
    return client;
  }
}
