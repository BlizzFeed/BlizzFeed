import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const SOURCES_FILE = process.env.SOURCES_FILE ?? fileURLToPath(new URL('../sources.yaml', import.meta.url));
export const repoUrl = () => (process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : null);
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function fail(message) {
	console.error(message);
	process.exit(1);
}

/** With no action flag, prints the usage; an unknown flag exits 2. */
export function parseFlags(options, usage, actions) {
	let values;
	try {
		({ values } = parseArgs({ options, strict: true }));
	} catch (error) {
		console.error(`${error.message}\n\n${usage}`);
		process.exit(2);
	}
	if (!actions.some((name) => values[name])) {
		console.log(usage);
	}
	return values;
}
