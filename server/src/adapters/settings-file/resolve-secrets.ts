import {
	containsPlaceholder,
	placeholderName,
	type SettingsIssue,
} from "../../settings/domain";
import type { SecretLookup } from "../secrets/secret-sources";
import { SECRET_FIELDS } from "./schema";

const matches = (pattern: string, path: readonly (string | number)[]) => {
	const parts = pattern.split(".");
	return (
		parts.length === path.length &&
		parts.every((p, i) => p === "*" || p === String(path[i]))
	);
};

const isSecretField = (path: readonly (string | number)[]) =>
	SECRET_FIELDS.some((p) => matches(p, path));

/**
 * Replaces `{MA_NAME}` placeholders in secret fields with their values. A
 * placeholder elsewhere, or one naming an undefined secret, is an issue
 * naming the field (like Frigate). Works on the plain parsed object, before
 * schema validation, so values are checked as resolved.
 */
export function resolveSecrets(
	raw: unknown,
	secrets: SecretLookup,
): { value: unknown; issues: SettingsIssue[]; used: string[] } {
	const issues: SettingsIssue[] = [];
	const used = new Set<string>();
	const walk = (v: unknown, path: (string | number)[]): unknown => {
		if (typeof v === "string") {
			const name = placeholderName(v);
			if (isSecretField(path)) {
				if (!name) {
					// Literal secrets are allowed but discouraged; keep them working.
					return v;
				}
				const s = secrets.get(name);
				if (!s) {
					issues.push({
						path,
						message: `secret ${name} is not defined (Docker secret, environment variable or secrets.yaml)`,
					});
					return v;
				}
				used.add(name);
				return s.value;
			}
			if (name || containsPlaceholder(v)) {
				issues.push({
					path,
					message:
						"placeholders like {MA_NAME} are only allowed in secret fields",
				});
			}
			return v;
		}
		if (Array.isArray(v)) return v.map((x, i) => walk(x, [...path, i]));
		if (v && typeof v === "object") {
			return Object.fromEntries(
				Object.entries(v as Record<string, unknown>).map(([k, x]) => [
					k,
					walk(x, [...path, k]),
				]),
			);
		}
		return v;
	};
	return { value: walk(raw, []), issues, used: [...used] };
}
