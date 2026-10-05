import type { ParseResult, SettingsParser } from "../../settings/application";
import type { SecretLookup } from "../secrets/secret-sources";
import { toSettings } from "./map";
import { locate, parseYaml, semanticIssues, zodIssues } from "./parse";
import { resolveSecrets } from "./resolve-secrets";
import { SettingsFileSchema } from "./schema";

/** YAML text → validated domain settings (schema, secrets, references). */
export class YamlSettingsParser implements SettingsParser {
	constructor(private readonly secrets: () => SecretLookup) {}

	parse(text: string): ParseResult {
		const { doc, lines, issues } = parseYaml(text);
		if (issues.length) return { ok: false, issues };
		const raw = doc.toJS() as unknown;
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			return {
				ok: false,
				issues: [{ path: [], message: "the settings file must be a YAML map" }],
			};
		}
		const resolved = resolveSecrets(raw, this.secrets());
		const secretIssues = resolved.issues.map((i) => ({
			...i,
			...locate(doc, lines, i.path),
		}));
		const result = SettingsFileSchema.safeParse(resolved.value);
		if (!result.success)
			return {
				ok: false,
				issues: [...secretIssues, ...zodIssues(result.error, doc, lines)],
			};
		if (secretIssues.length) return { ok: false, issues: secretIssues };
		const settings = toSettings(result.data);
		const semantic = semanticIssues(settings, doc, lines);
		if (semantic.length) return { ok: false, issues: semantic };
		return { ok: true, settings, secretsUsed: resolved.used };
	}
}
