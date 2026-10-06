import type { ModelChoice, ModelHealth } from "../../maintenance/application";

/**
 * Checks that every configured model endpoint answers `/models` (or
 * `/health`), each with its own API key. Jobs wait while one is down.
 */
export class HttpModelHealth implements ModelHealth {
	private cache: { at: number; ok: boolean } | null = null;

	constructor(
		private readonly endpoints: () => readonly ModelChoice[],
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly cacheMs = 30_000,
	) {}

	async isAvailable(): Promise<boolean> {
		if (this.cache && Date.now() - this.cache.at < this.cacheMs)
			return this.cache.ok;
		const byBase = new Map<string, string | null>();
		for (const e of this.endpoints()) {
			const base = e.apiBase.replace(/\/+$/, "");
			if (!byBase.has(base) || e.apiKey) byBase.set(base, e.apiKey);
		}
		const ok = (
			await Promise.all([...byBase].map(([b, key]) => this.probe(b, key)))
		).every(Boolean);
		this.cache = { at: Date.now(), ok };
		return ok;
	}

	private async probe(base: string, apiKey: string | null): Promise<boolean> {
		const headers: Record<string, string> = apiKey
			? { Authorization: `Bearer ${apiKey}` }
			: {};
		for (const url of [
			`${base}/models`,
			`${base.replace(/\/v1$/, "")}/health`,
		]) {
			try {
				const r = await this.fetchImpl(url, {
					headers,
					signal: AbortSignal.timeout(10_000),
				});
				if (r.ok) return true;
			} catch {
				// try the next URL
			}
		}
		return false;
	}
}
