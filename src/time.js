/** ISO timestamp without milliseconds, as the branch files have them. */
export function isoSeconds(date = new Date()) {
	return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
