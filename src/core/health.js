import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../json.js';
import { isoSeconds } from '../time.js';

export const HEALTH_FILE = '_health.json';

export function load(dir) {
	const file = path.join(dir, HEALTH_FILE);
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

export const save = (dir, health) => writeJson(path.join(dir, HEALTH_FILE), health, { sortKeys: true });

/** Counts consecutive failures, and returns a 'down' alert on the run the count reaches the threshold. The count stops
 * there, so an ongoing outage leaves the file (and the branch) unchanged instead of committing every run. */
export function recordFailure(health, source, error) {
	const now = isoSeconds();
	const entry = (health[source.id] ??= { failures: 0, since: now });
	if (entry.failures < source.failuresBeforeAlert) {
		entry.failures++;
		if (entry.failures === source.failuresBeforeAlert) {
			return { source: source.id, kind: 'down', error: error.slice(0, 300), since: entry.since };
		}
	}
	return null;
}

/** Clears the streak, and returns a 'recovered' alert if a 'down' alert was sent. */
export function recordSuccess(health, source) {
	const entry = health[source.id];
	delete health[source.id];
	return entry && entry.failures >= source.failuresBeforeAlert ? { source: source.id, kind: 'recovered', since: entry.since } : null;
}
