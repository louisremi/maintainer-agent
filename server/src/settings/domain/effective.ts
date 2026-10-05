import {
	BUILT_IN_REPOSITORY_SETTINGS,
	JOB_KIND_NAMES,
	type ModelSelection,
	type RepositoryLayer,
	type RepositorySettings,
	type ServerLimits,
	type Settings,
} from "./settings";

type Plain = Record<string, unknown>;

const isMap = (v: unknown): v is Plain =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Layers `over` onto `base`: maps merge key by key, lists and scalars
 * replace, and a key that is absent (or undefined) inherits. Same rules as
 * Frigate's global/camera overrides.
 */
export function mergeLayers<T>(base: T, over: unknown): T {
	if (over === undefined) return base;
	if (!isMap(base) || !isMap(over)) return over as T;
	const out: Plain = { ...base };
	for (const [k, v] of Object.entries(over)) {
		if (v === undefined) continue;
		out[k] = k in base ? mergeLayers(base[k], v) : v;
	}
	return out as T;
}

const clamp = (v: number, lo: number, hi: number) =>
	Math.max(lo, Math.min(hi, Math.trunc(v)));

function modelSelection(
	layers: readonly (string | Partial<ModelSelection> | undefined)[],
): ModelSelection {
	const sel: Record<string, string> = {
		answer: "default",
		fix: "default",
		review: "default",
	};
	for (const layer of layers) {
		if (layer === undefined) continue;
		if (typeof layer === "string") {
			for (const k of JOB_KIND_NAMES) sel[k] = layer;
		} else {
			for (const k of JOB_KIND_NAMES) {
				const v = layer[k];
				if (v) sel[k] = v;
			}
		}
	}
	return sel as unknown as ModelSelection;
}

/** Applies the server's caps: nothing configured can exceed them. */
export function clampToLimits(
	s: RepositorySettings,
	limits: ServerLimits,
): RepositorySettings {
	const attempts = (n: number) => clamp(n, 1, limits.maxAttempts);
	const steps = (n: number) => clamp(n, 5, limits.maxStepLimit);
	return {
		...s,
		answer: {
			...s.answer,
			maxAttempts: attempts(s.answer.maxAttempts),
			stepLimit: steps(s.answer.stepLimit),
		},
		fix: {
			...s.fix,
			maxAttempts: attempts(s.fix.maxAttempts),
			stepLimit: steps(s.fix.stepLimit),
		},
		review: {
			...s.review,
			maxAttempts: attempts(s.review.maxAttempts),
			stepLimit: steps(s.review.stepLimit),
			maxComments: clamp(s.review.maxComments, 0, limits.maxReviewComments),
			maxDiffLines: clamp(s.review.maxDiffLines, 100, limits.maxDiffLines),
		},
	};
}

/**
 * The settings of one repository: built-in values → `defaults` →
 * `repositories.<key>`, clamped to `server.limits`. Null when the
 * repository is not listed (the server ignores it).
 */
export function effectiveRepositorySettings(
	settings: Settings,
	repoKey: string,
): RepositorySettings | null {
	const layer = settings.repositories[repoKey];
	if (layer === undefined) return null;
	const { model: defaultsModel, ...defaults } = settings.defaults;
	const { model: repoModel, ...repo } = layer ?? {};
	const merged = mergeLayers(
		mergeLayers(BUILT_IN_REPOSITORY_SETTINGS, defaults),
		repo,
	) as Omit<RepositorySettings, "model">;
	return clampToLimits(
		{ ...merged, model: modelSelection([defaultsModel, repoModel]) },
		settings.server.limits,
	);
}

/** Model names referenced anywhere, for validation. */
export function referencedModelNames(settings: Settings): {
	name: string;
	path: (string | number)[];
}[] {
	const out: { name: string; path: (string | number)[] }[] = [];
	const collect = (
		m: RepositoryLayer["model"],
		path: (string | number)[],
	): void => {
		if (m === undefined) return;
		if (typeof m === "string") out.push({ name: m, path });
		else
			for (const k of JOB_KIND_NAMES) {
				const v = m[k];
				if (v) out.push({ name: v, path: [...path, k] });
			}
	};
	collect(settings.defaults.model, ["defaults", "model"]);
	for (const [key, layer] of Object.entries(settings.repositories)) {
		collect(layer?.model, ["repositories", key, "model"]);
	}
	return out;
}
