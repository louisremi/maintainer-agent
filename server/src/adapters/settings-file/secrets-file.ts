import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";

/**
 * Adds or replaces entries in secrets.yaml (mode 600), keeping comments and
 * other entries. Used by the app registration and the v0.2 import; the
 * editor never touches this file.
 */
export async function upsertSecrets(
	path: string,
	values: Readonly<Record<string, string>>,
): Promise<void> {
	if (!Object.keys(values).length) return;
	let text = "";
	try {
		text = await readFile(path, "utf8");
	} catch {
		text =
			"# Secrets for settings.yml: {MA_NAME} placeholders resolve from here.\n# Never shown or edited by the admin pages.\n";
	}
	const doc = parseDocument(text);
	if (!doc.contents) doc.contents = doc.createNode({}) as never;
	for (const [k, v] of Object.entries(values)) doc.set(k, v);
	const tmp = join(dirname(path), `.secrets.yaml.${process.pid}.tmp`);
	await writeFile(tmp, doc.toString({ lineWidth: 0 }), { mode: 0o600 });
	await chmod(tmp, 0o600);
	await rename(tmp, path);
}
