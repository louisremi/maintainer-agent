import { isMap, isScalar, parseDocument } from "yaml";
import type {
	SettingsMigration,
	SettingsMigrations,
} from "../../settings/application";
import { CURRENT_SETTINGS_VERSION } from "../../settings/domain";

/**
 * The data a 0 → 1 migration imports: settings that lived in environment
 * variables and the database before settings.yml existed. Built by the
 * composition root, which knows both.
 */
export type LegacyImport = () => Promise<string>;

/**
 * Ordered schema migrations of settings.yml. Each step takes the text of
 * version N and returns version N+1, keeping comments where it can (yaml
 * Document API). Add one per schema change; never edit a released step.
 */
export class YamlSettingsMigrations implements SettingsMigrations {
	readonly current = CURRENT_SETTINGS_VERSION;

	constructor(private readonly legacyImport: LegacyImport) {}

	versionOf(text: string): number {
		if (!text.trim()) return 0;
		const doc = parseDocument(text);
		const v = doc.get("version");
		return typeof v === "number" && Number.isInteger(v) ? v : 0;
	}

	steps(): readonly SettingsMigration[] {
		return [
			{
				from: 0,
				to: 1,
				description:
					"create settings.yml from the environment variables and database of v0.2",
				migrate: async (text) => {
					// An existing file without a version (hand-written before v1): keep it,
					// stamp it. An empty/missing one: import the legacy configuration.
					if (text.trim()) {
						const doc = parseDocument(text);
						const contents = doc.contents;
						if (!isMap(contents)) return `version: 1\n${text}`;
						const items = contents.items;
						const keyOf = (p: (typeof items)[number]) =>
							isScalar(p.key) ? p.key.value : p.key;
						const existing = items.findIndex((p) => keyOf(p) === "version");
						if (existing >= 0) items.splice(existing, 1);
						const pair = doc.createPair("version", 1);
						// The file's leading comment is attached to its first key: keep it on top.
						const first = items[0];
						if (
							first &&
							isScalar(first.key) &&
							first.key.commentBefore &&
							isScalar(pair.key)
						) {
							pair.key.commentBefore = first.key.commentBefore;
							first.key.commentBefore = undefined;
						}
						items.unshift(pair as (typeof items)[number]);
						return doc.toString();
					}
					return this.legacyImport();
				},
			},
		];
	}
}
