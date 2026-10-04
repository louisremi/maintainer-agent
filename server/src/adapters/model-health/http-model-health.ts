import type {
	ModelCatalog,
	ModelChoice,
	ModelHealth,
} from "../../maintenance/application";
import type { JobKind } from "../../maintenance/domain";

/** Checks that every configured model endpoint answers `/models` (or `/health`). */
export class HttpModelHealth implements ModelHealth {
	private cache: { at: number; ok: boolean } | null = null;

	constructor(
		private readonly endpoints: readonly ModelChoice[],
		private readonly apiKey: string | null,
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly cacheMs = 30_000,
	) {}

	async isAvailable(): Promise<boolean> {
		if (this.cache && Date.now() - this.cache.at < this.cacheMs)
			return this.cache.ok;
		const bases = [
			...new Set(this.endpoints.map((e) => e.apiBase.replace(/\/+$/, ""))),
		];
		const ok = (await Promise.all(bases.map((b) => this.probe(b)))).every(
			Boolean,
		);
		this.cache = { at: Date.now(), ok };
		return ok;
	}

	private async probe(base: string): Promise<boolean> {
		const headers: Record<string, string> = this.apiKey
			? { Authorization: `Bearer ${this.apiKey}` }
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

/** One endpoint for everything, optionally a different model per job kind. */
export class StaticModelCatalog implements ModelCatalog {
	constructor(
		private readonly defaults: ModelChoice,
		private readonly perKind: Partial<Record<JobKind, string>>,
	) {}

	modelFor(kind: JobKind): ModelChoice {
		const model = this.perKind[kind];
		return model ? { apiBase: this.defaults.apiBase, model } : this.defaults;
	}

	all(): ModelChoice[] {
		return [
			this.defaults,
			...(
				["answer-issue", "propose-fix", "review-change-request"] as JobKind[]
			).map((k) => this.modelFor(k)),
		];
	}
}
