/**
 * Secret placeholders, as in Frigate: a whole value written `{MA_NAME}` is
 * replaced by the secret named MA_NAME (from Docker secrets, the container
 * environment or secrets.yaml). Only fields documented as secret accept them.
 */
const PLACEHOLDER = /^\{(MA_[A-Z0-9_]+)\}$/;
const ANY_PLACEHOLDER = /\{MA_[A-Z0-9_]*\}/;

export function placeholderName(value: string): string | null {
	return PLACEHOLDER.exec(value.trim())?.[1] ?? null;
}

export function containsPlaceholder(value: string): boolean {
	return ANY_PLACEHOLDER.test(value);
}

export const SECRET_NAME = /^MA_[A-Z0-9_]+$/;

/** A secret name derived from parts, e.g. ("conn", "pT65", "private key") → MA_CONN_PT65_PRIVATE_KEY. */
export function secretName(...parts: string[]): string {
	return `MA_${parts
		.map((p) => p.toUpperCase().replace(/[^A-Z0-9]+/g, "_"))
		.join("_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")}`;
}
