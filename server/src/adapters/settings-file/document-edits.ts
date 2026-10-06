import { isMap, parseDocument, YAMLMap } from "yaml";

/**
 * Programmatic edits of settings.yml text that keep the operator's comments
 * and formatting (yaml Document API). Each returns the new text.
 */
function mapAt(doc: ReturnType<typeof parseDocument>, key: string): YAMLMap {
	let node = doc.get(key, true);
	if (!isMap(node)) {
		node = new YAMLMap();
		doc.set(key, node);
	}
	const map = node as YAMLMap;
	map.flow = false;
	return map;
}

export function addConnection(
	text: string,
	id: string,
	connection: Record<string, unknown>,
): string {
	const doc = parseDocument(text);
	const connections = mapAt(doc, "connections");
	if (connections.has(id)) throw new Error(`connections.${id} already exists`);
	connections.set(id, doc.createNode(connection));
	return doc.toString({ lineWidth: 0 });
}

export function setConnectionField(
	text: string,
	id: string,
	field: string,
	value: unknown,
): string {
	const doc = parseDocument(text);
	if (!doc.hasIn(["connections", id]))
		throw new Error(`no connection ${id} in settings`);
	doc.setIn(["connections", id, field], value);
	return doc.toString({ lineWidth: 0 });
}
