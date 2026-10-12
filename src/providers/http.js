import { setTimeout as wait } from 'node:timers/promises';

export const USER_AGENT = 'BlizzFeed/1.0 (+https://github.com/BlizzFeed/BlizzFeed; news change tracker)';
const DEFAULT_RETRY_SECONDS = 5;
const MAX_RETRY_SECONDS = 30;
export const TIMEOUT_MS = 20000;

export class HttpError extends Error {
	constructor(response) {
		super(`${response.status} ${response.statusText} for ${response.url}`);
		this.status = response.status;
	}
}

/** Seconds to wait after a 429. Retry-After can also be a date, which we don't parse. */
export async function waitAfter429(response) {
	const seconds = parseInt(response.headers.get('Retry-After'), 10);
	await wait((Number.isNaN(seconds) ? DEFAULT_RETRY_SECONDS : Math.min(Math.max(seconds, 0), MAX_RETRY_SECONDS)) * 1000);
}

/** GET with our User-Agent. On 429, waits for Retry-After (max 30s) and tries once more. Throws HttpError on 4xx/5xx. */
export async function get(url, { headers = {}, params } = {}) {
	const target = new URL(url);
	for (const [key, value] of Object.entries(params ?? {})) {
		target.searchParams.set(key, value);
	}
	const send = () => fetch(target, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
	let response = await send();
	if (response.status === 429) {
		await response.body?.cancel();
		await waitAfter429(response);
		response = await send();
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new HttpError(response);
	}
	return response;
}
