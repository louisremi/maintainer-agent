import { generateKeyPairSync } from 'node:crypto';

export const { privateKey: TEST_PEM, publicKey: TEST_PUBLIC_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  auth: string | null;
  body: unknown;
}

type Handler = (req: RecordedRequest) => { status?: number; body?: unknown; text?: string } | undefined;

/** A scriptable stand-in for the GitHub API, used as the `fetch` implementation. */
export class FakeGithubApi {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: { method: string; pattern: RegExp; handler: Handler }[] = [];

  constructor(private readonly apiBase = 'https://api.github.com') {}

  on(method: string, pattern: RegExp | string, handler: Handler | { status?: number; body?: unknown; text?: string }): this {
    const p = typeof pattern === 'string' ? new RegExp(`^${pattern.replace(/[.?*+^$()[\]{}|\\]/g, '\\$&')}$`) : pattern;
    this.routes.push({ method, pattern: p, handler: typeof handler === 'function' ? handler : () => handler });
    return this;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = url.startsWith(this.apiBase) ? url.slice(this.apiBase.length) : url;
    const headers = new Headers(init?.headers);
    const req: RecordedRequest = {
      method: init?.method ?? 'GET',
      url,
      path,
      auth: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    this.requests.push(req);
    for (const r of [...this.routes].reverse()) {
      if (r.method === req.method && r.pattern.test(path)) {
        const res = r.handler(req);
        if (!res) continue;
        const status = res.status ?? 200;
        if (status === 204) return new Response(null, { status });
        return new Response(res.text ?? JSON.stringify(res.body ?? {}), { status });
      }
    }
    return new Response(JSON.stringify({ message: `no fake route for ${req.method} ${path}` }), { status: 404 });
  };

  /** Installation lookup and token minting for one repository. */
  withInstallation(owner: string, repo: string, installationId = 99): this {
    this.on('GET', `/repos/${owner}/${repo}/installation`, { body: { id: installationId } });
    let n = 0;
    this.on('POST', `/app/installations/${installationId}/access_tokens`, (req) => ({
      status: 201,
      body: { token: `ghs_test${++n}_${JSON.stringify((req.body as { permissions?: object }).permissions)}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
    }));
    return this;
  }
}
