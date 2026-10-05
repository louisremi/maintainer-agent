import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { SECRET_NAME } from "../../settings/domain";

export interface SecretValue {
	readonly value: string;
	readonly source: string;
}

export interface SecretLookup {
	get(name: string): SecretValue | undefined;
	/** Names defined in more than one source with different values (higher one wins). */
	readonly duplicates: readonly {
		name: string;
		used: string;
		ignored: string[];
	}[];
	/** For the admin page: which source each name comes from (never the value). */
	sources(): { name: string; source: string }[];
}

/**
 * Secret values for `{MA_NAME}` placeholders, from (highest precedence first):
 * Docker secrets (`/run/secrets` or $CREDENTIALS_DIRECTORY), the container
 * environment, then `secrets.yaml` next to settings.yml. Same order as
 * Frigate. Only names starting with MA_ are considered.
 */
export function loadSecretSources(opts: {
	env: NodeJS.ProcessEnv;
	secretsFile: string;
	secretsDir?: string;
}): SecretLookup {
	const layers: { label: string; values: Record<string, string> }[] = [];

	const dir =
		opts.secretsDir ?? opts.env.CREDENTIALS_DIRECTORY ?? "/run/secrets";
	const fromDir: Record<string, string> = {};
	if (existsSync(dir)) {
		for (const name of readdirSync(dir)) {
			if (!SECRET_NAME.test(name)) continue;
			const p = join(dir, name);
			if (statSync(p).isFile())
				fromDir[name] = readFileSync(p, "utf8").replace(/\r?\n$/, "");
		}
	}
	layers.push({ label: "docker secrets", values: fromDir });

	const fromEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(opts.env))
		if (SECRET_NAME.test(k) && v !== undefined) fromEnv[k] = v;
	layers.push({ label: "environment", values: fromEnv });

	const fromFile: Record<string, string> = {};
	if (existsSync(opts.secretsFile)) {
		const doc = parse(readFileSync(opts.secretsFile, "utf8")) as unknown;
		if (doc !== null && doc !== undefined) {
			if (typeof doc !== "object" || Array.isArray(doc))
				throw new Error(`${opts.secretsFile} must be a map of MA_NAME: value`);
			for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
				if (!SECRET_NAME.test(k))
					throw new Error(
						`${opts.secretsFile}: ${k} must start with MA_ (letters, digits, _)`,
					);
				if (typeof v !== "string" && typeof v !== "number")
					throw new Error(`${opts.secretsFile}: ${k} must be a string`);
				fromFile[k] = String(v);
			}
		}
	}
	layers.push({ label: "secrets.yaml", values: fromFile });

	const resolved = new Map<string, SecretValue>();
	const duplicates: { name: string; used: string; ignored: string[] }[] = [];
	for (const name of new Set(layers.flatMap((l) => Object.keys(l.values)))) {
		const defined = layers.filter((l) => name in l.values);
		const [top] = defined;
		const value = top?.values[name];
		if (!top || value === undefined) continue;
		resolved.set(name, { value, source: top.label });
		const differing = defined
			.slice(1)
			.filter((l) => l.values[name] !== top.values[name]);
		if (differing.length)
			duplicates.push({
				name,
				used: top.label,
				ignored: differing.map((l) => l.label),
			});
	}
	return {
		get: (name) => resolved.get(name),
		duplicates,
		sources: () =>
			[...resolved]
				.map(([name, v]) => ({ name, source: v.source }))
				.sort((a, b) => a.name.localeCompare(b.name)),
	};
}
