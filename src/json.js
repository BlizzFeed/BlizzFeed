import fs from 'node:fs';
import path from 'node:path';

/** JSON.stringify(value, null, 2) with keys sorted as text. By hand, as an object puts all-digit keys (article ids) in number order. */
function sorted(value, indent = '') {
	const inner = `${indent}  `;
	if (Array.isArray(value)) {
		return value.length ? `[\n${value.map((v) => inner + sorted(v, inner)).join(',\n')}\n${indent}]` : '[]';
	}
	if (value && typeof value === 'object') {
		const keys = Object.keys(value).sort();
		return keys.length ? `{\n${keys.map((key) => `${inner}${JSON.stringify(key)}: ${sorted(value[key], inner)}`).join(',\n')}\n${indent}}` : '{}';
	}
	return JSON.stringify(value);
}

/** The branch files' format. sortKeys for the ones kept sorted: the archive's index files, _archive.json and _health.json. */
export function stringify(value, { sortKeys = false } = {}) {
	return (sortKeys ? sorted(value) : JSON.stringify(value, null, 2)) + '\n';
}

export function writeJson(file, value, options) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, stringify(value, options));
}
