/** One problem in a settings file, located when possible. */
export interface SettingsIssue {
	/** Path in the document, e.g. ["repositories", "github.com/o/r", "fix", "step_limit"]. */
	readonly path: readonly (string | number)[];
	readonly message: string;
	/** 1-based position in the file, when known. */
	readonly line?: number;
	readonly column?: number;
}

export function formatIssue(i: SettingsIssue): string {
	const where = i.line ? `line ${i.line}${i.column ? `:${i.column}` : ""}` : "";
	const path = i.path.length ? i.path.join(".") : "(root)";
	return `${where ? `${where} ` : ""}${path}: ${i.message}`;
}
