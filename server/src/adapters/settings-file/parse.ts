import {
	type Document,
	isMap,
	isScalar,
	isSeq,
	LineCounter,
	type Node,
	parseDocument,
} from "yaml";
import type { ZodError } from "zod";
import {
	referencedModelNames,
	type Settings,
	type SettingsIssue,
} from "../../settings/domain";

/** Parses YAML text, keeping positions; syntax errors become issues. */
export function parseYaml(text: string): {
	doc: Document;
	lines: LineCounter;
	issues: SettingsIssue[];
} {
	const lines = new LineCounter();
	const doc = parseDocument(text, {
		lineCounter: lines,
		prettyErrors: false,
		uniqueKeys: true,
	});
	const issues: SettingsIssue[] = doc.errors.map((e) => {
		const pos = lines.linePos(e.pos[0]);
		return {
			path: [],
			message: e.message.split("\n")[0] ?? e.message,
			line: pos.line,
			column: pos.col,
		};
	});
	return { doc, lines, issues };
}

/** The node at a path, to locate an issue in the file. */
function nodeAt(
	doc: Document,
	path: readonly (string | number)[],
): Node | null {
	let node: unknown = doc.contents;
	let last: Node | null = (doc.contents as Node | null) ?? null;
	for (const key of path) {
		if (isMap(node)) {
			const pair = node.items.find(
				(p) => (isScalar(p.key) ? p.key.value : p.key) === key,
			);
			if (!pair) return last;
			node = pair.value ?? pair.key;
			last = (pair.value as Node | null) ?? (pair.key as Node | null) ?? last;
		} else if (isSeq(node) && typeof key === "number") {
			node = node.items[key];
			last = (node as Node | null) ?? last;
		} else {
			return last;
		}
	}
	return last;
}

export function locate(
	doc: Document,
	lines: LineCounter,
	path: readonly (string | number)[],
): { line?: number; column?: number } {
	const n = nodeAt(doc, path);
	const offset = n?.range?.[0];
	if (offset === undefined) return {};
	const p = lines.linePos(offset);
	return { line: p.line, column: p.col };
}

export function zodIssues(
	error: ZodError,
	doc: Document,
	lines: LineCounter,
): SettingsIssue[] {
	return error.issues.map((i) => {
		const path = i.path.filter(
			(p): p is string | number => typeof p !== "symbol",
		);
		const extra =
			i.code === "unrecognized_keys"
				? `: ${(i as { keys: string[] }).keys.join(", ")}`
				: "";
		return {
			path,
			message: `${i.message}${extra}`,
			...locate(doc, lines, path),
		};
	});
}

/** Cross-field checks the schema cannot express. */
export function semanticIssues(
	settings: Settings,
	doc: Document,
	lines: LineCounter,
): SettingsIssue[] {
	const issues: SettingsIssue[] = [];
	for (const ref of referencedModelNames(settings)) {
		if (!(ref.name in settings.models)) {
			issues.push({
				path: ref.path,
				message: `unknown model "${ref.name}" (define it under models)`,
				...locate(doc, lines, ref.path),
			});
		}
	}
	const connectionIds = Object.keys(settings.connections);
	const check = (c: string | null | undefined, path: (string | number)[]) => {
		if (c && !connectionIds.includes(c))
			issues.push({
				path,
				message: `unknown connection "${c}"`,
				...locate(doc, lines, path),
			});
	};
	check(settings.defaults.connection, ["defaults", "connection"]);
	for (const [key, l] of Object.entries(settings.repositories)) {
		check(l.connection, ["repositories", key, "connection"]);
		const host = key.split("/")[0];
		const conn = l.connection ? settings.connections[l.connection] : undefined;
		if (conn && conn.host !== host) {
			issues.push({
				path: ["repositories", key, "connection"],
				message: `connection "${l.connection}" is for ${conn.host}, not ${host}`,
				...locate(doc, lines, ["repositories", key, "connection"]),
			});
		}
	}
	for (const [id, c] of Object.entries(settings.connections)) {
		if (c.platform !== "github") {
			issues.push({
				path: ["connections", id, "platform"],
				message: `${c.platform} connections are not supported yet`,
				...locate(doc, lines, ["connections", id, "platform"]),
			});
		}
	}
	return issues;
}
