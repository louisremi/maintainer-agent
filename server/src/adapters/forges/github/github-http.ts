import { createSign } from "node:crypto";

/** A GitHub API error with its HTTP status. */
export class GithubApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly method: string,
		readonly path: string,
	) {
		super(`GitHub API ${method} ${path} failed with ${status}: ${message}`);
		this.name = "GithubApiError";
	}

	/** Worth retrying later (rate limits, outages). */
	get transient(): boolean {
		return (
			this.status === 0 ||
			this.status === 429 ||
			this.status >= 500 ||
			(this.status === 403 && /rate limit/i.test(this.message))
		);
	}
}

export interface GithubHost {
	/** Web host, e.g. github.com or a GitHub Enterprise Server host. */
	readonly host: string;
	readonly webUrl: string;
	readonly apiUrl: string;
	/** Hosts a git client and the API need (for egress allow-lists). */
	readonly egressHosts: readonly string[];
}

/** github.com or a GitHub Enterprise Server host (API under /api/v3). */
export function githubHost(host: string): GithubHost {
	const h = host.toLowerCase();
	if (h === "github.com") {
		return {
			host: h,
			webUrl: "https://github.com",
			apiUrl: "https://api.github.com",
			egressHosts: ["github.com", "api.github.com", "codeload.github.com"],
		};
	}
	return {
		host: h,
		webUrl: `https://${h}`,
		apiUrl: `https://${h}/api/v3`,
		egressHosts: [h.replace(/:\d+$/, "")],
	};
}

export type Fetch = typeof fetch;

/** Minimal JSON client for the GitHub REST API. */
export class GithubHttp {
	constructor(
		private readonly host: GithubHost,
		private readonly fetchImpl: Fetch = fetch,
	) {}

	async request<T>(
		method: string,
		path: string,
		auth: string | null,
		body?: unknown,
		accept = "application/vnd.github+json",
	): Promise<T> {
		const headers: Record<string, string> = {
			Accept: accept,
			"User-Agent": "maintainer-agent",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		if (auth) headers.Authorization = auth;
		if (body !== undefined) headers["Content-Type"] = "application/json";
		let res: Response;
		try {
			res = await this.fetchImpl(`${this.host.apiUrl}${path}`, {
				method,
				headers,
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				signal: AbortSignal.timeout(30_000),
			});
		} catch (err) {
			throw new GithubApiError(
				0,
				err instanceof Error ? err.message : String(err),
				method,
				path,
			);
		}
		if (res.status === 204) return undefined as T;
		const text = await res.text();
		if (!res.ok) {
			let message = text.slice(0, 300);
			try {
				message = (JSON.parse(text) as { message?: string }).message ?? message;
			} catch {
				/* keep text */
			}
			throw new GithubApiError(res.status, message, method, path);
		}
		if (accept.includes("diff") || accept.includes("raw")) return text as T;
		return (text ? JSON.parse(text) : undefined) as T;
	}
}

/** A short-lived JWT identifying a GitHub App (RS256, 9 minutes). */
export function appJwt(
	appId: string,
	privateKeyPem: string,
	now = Date.now(),
): string {
	const enc = (o: object) =>
		Buffer.from(JSON.stringify(o)).toString("base64url");
	const iat = Math.floor(now / 1000) - 60;
	const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat, exp: iat + 540, iss: appId })}`;
	const signature = createSign("RSA-SHA256")
		.update(unsigned)
		.sign(privateKeyPem)
		.toString("base64url");
	return `${unsigned}.${signature}`;
}
