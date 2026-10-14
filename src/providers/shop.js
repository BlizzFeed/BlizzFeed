import { HttpError, TIMEOUT_MS, USER_AGENT, waitAfter429 } from './http.js';

const RSC_TYPE = 'text/x-component';
const IGNORED_KEYS = new Set(['cacheMetaData']); // cache ages and the server clock, left out so they never read as a change
export const BANNER_SECTION = 'Banner';
const PRODUCT_PATH = /\/product\/([^/?#]+)/;
const ITEM_PATH = /\/items\/(\d+)/;
const FAMILY_PATH = /\/family\/([a-z0-9-]+)/g;
export const UNTITLED_SECTION = '(untitled)';
const MAX_REDIRECTS = 20;

/** The shop answered, but not with a family payload. */
export class ShopFetchError extends Error {}

/** One per region (a session made on eu. doesn't work on us.): follows the shop's login redirects and keeps their cookies.
 * A cookie goes back to the host that set it, or to its Domain and that domain's subdomains. */
export class ShopSession {
	cookies = new Map(); // by `${domain or host} ${name}`

	cookieHeader(host) {
		return [...this.cookies.values()]
			.filter((c) => (c.domain ? host === c.domain || host.endsWith(`.${c.domain}`) : host === c.host))
			.map((c) => `${c.name}=${c.value}`).join('; ');
	}

	/** A cookie the server expires is dropped. Paths are ignored: every login cookie uses Path=/. */
	remember(response, host) {
		for (const line of response.headers.getSetCookie()) {
			const [pair, ...parts] = line.split(';');
			const attributes = Object.fromEntries(parts.map((part) => part.split('=')).map(([key, ...value]) => [key.trim().toLowerCase(), value.join('=').trim()]));
			const at = pair.indexOf('=');
			const domain = attributes.domain?.replace(/^\./, '').toLowerCase() || undefined;
			const cookie = { name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim(), host, domain };
			const expired = 'max-age' in attributes ? Number(attributes['max-age']) <= 0 : Date.parse(attributes.expires) <= Date.now();
			if (expired) {
				this.cookies.delete(`${domain ?? host} ${cookie.name}`);
			} else {
				this.cookies.set(`${domain ?? host} ${cookie.name}`, cookie);
			}
		}
	}

	/** The response at the end of the redirects, with `url` where it ended. */
	async follow(url) {
		let current = url;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const host = new URL(current).host;
			const response = await fetch(current, {
				redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
				headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en', 'RSC': '1', 'Cookie': this.cookieHeader(host) },
			});
			this.remember(response, host);
			const location = response.headers.get('location');
			if (response.status < 300 || response.status >= 400 || !location) {
				return { status: response.status, statusText: response.statusText, url: current, headers: response.headers, text: await response.text() };
			}
			await response.body?.cancel();
			current = new URL(location, current).href;
		}
		throw new ShopFetchError(`too many redirects from ${url}`);
	}

	/** GET through the redirects. On 429, waits for Retry-After and tries once more. */
	async get(url) {
		const response = await this.follow(url);
		if (response.status !== 429) {
			return response;
		}
		await waitAfter429(response);
		return this.follow(url);
	}
}

async function fetchPayload(session, url) {
	const response = await session.get(url);
	if (response.status >= 400) {
		throw new HttpError(response);
	}
	// The other region's host would mean the other region's prices.
	if (new URL(response.url).host !== new URL(url).host) {
		throw new ShopFetchError(`redirected to ${response.url}`);
	}
	if (!(response.headers.get('content-type') ?? '').startsWith(RSC_TYPE)) {
		const type = response.headers.get('content-type') ?? 'no content type';
		throw new ShopFetchError(`${response.url} served ${type.startsWith('text/html') ? 'an HTML page (the old storefront?)' : `'${type}'`}, not a data payload`);
	}
	return response.text;
}

/** The family page's data payload (the Next.js RSC stream). */
export const fetchFamily = (session, base, family) => fetchPayload(session, `${base}/family/${family}`);

/** The family slugs the shop's home page links to. */
export async function homeFamilies(session, base) {
	return new Set([...(await fetchPayload(session, base)).matchAll(FAMILY_PATH)].map((m) => m[1]));
}

export const itemPageUrl = (base, family, item) => (item.itemId ? `${base}/family/${family}/items/${item.itemId}` : `${base}/product/${item.slug}`);

/** True if the item's page shows a price. Free and "Learn More" items have none, even while on sale. */
export async function itemOnSale(session, base, family, item) {
	const payload = await fetchPayload(session, itemPageUrl(base, family, item));
	return records(payload).some((record) => [...walk(record)].some(([obj]) => obj.fullAmount));
}

/** The JSON records, one `<hex id>:<json>` per line. Other lines are skipped. */
function records(payload) {
	const found = [];
	for (const line of payload.split('\n')) {
		const colon = line.indexOf(':');
		if (colon < 1 || !/^[0-9a-f]+$/.test(line.slice(0, colon))) {
			continue;
		}
		try {
			found.push(JSON.parse(line.slice(colon + 1)));
		} catch {
			// a module reference or other text, not a record
		}
	}
	return found;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Every object in the tree, with the objects above it. */
function* walk(node, ancestors = []) {
	if (isObject(node)) {
		yield [node, ancestors];
		for (const value of Object.values(node)) {
			yield* walk(value, [...ancestors, node]);
		}
	} else if (Array.isArray(node)) {
		for (const value of node) {
			yield* walk(value, ancestors);
		}
	}
}

const isItem = (obj) => 'cmsId' in obj && 'productIds' in obj;

function clean(node) {
	if (Array.isArray(node)) {
		return node.map(clean);
	}
	return isObject(node) ? Object.fromEntries(Object.entries(node).filter(([key]) => !IGNORED_KEYS.has(key)).map(([key, value]) => [key, clean(value)])) : node;
}

/** The ID in a /family/<f>/items/<id>/ link. For a bundle productIds is what it contains, not this. */
export function itemId(destination) {
	const match = (destination || '').match(ITEM_PATH);
	return match ? Number(match[1]) : null;
}

export function itemKey(obj) {
	if (obj.cmsId) {
		return obj.cmsId;
	}
	if (itemId(obj.destination)) {
		return `p:${itemId(obj.destination)}`;
	}
	if (obj.productIds?.length) {
		return `p:${obj.productIds.join(',')}`;
	}
	return `s:${obj.slug || ''}`;
}

/** The title of the nearest enclosing section. */
function section(ancestors) {
	const found = ancestors.findLast((a) => 'title' in a && !isItem(a));
	return found ? found.title || UNTITLED_SECTION : null;
}

function price(raw) {
	if (!raw) {
		return null;
	}
	const cleaned = Object.fromEntries(['fullAmount', 'discountAmount', 'discountPercentage', 'currency', 'raw', 'labelFormat'].map((key) => [key, raw[key] ?? null]));
	for (const key of ['fullAmount', 'discountAmount']) {
		if (cleaned[key]) {
			cleaned[key] = cleaned[key].replaceAll('$$', '$'); // the US shop doubles the dollar sign
		}
	}
	return cleaned;
}

const item = (obj) => ({
	key: itemKey(obj), kind: 'item', cmsId: obj.cmsId ?? null, slug: obj.slug ?? null,
	title: obj.title ?? null, description: obj.description ?? null,
	categoryId: obj.categoryId ?? null, itemId: itemId(obj.destination),
	productIds: obj.productIds || [], subscriptionIds: obj.subscriptionIds || [], destination: obj.destination ?? null,
	image: obj.image?.url ?? null, sections: [],
	badge: obj.marketingBadge?.text ?? null, price: price(obj.price),
	expiresAtMs: obj.expiresAtMs ?? null,
});

/** A header banner. It has no productIds, so the item walk doesn't find it. */
function banner(obj) {
	const cta = obj.callToAction;
	const destination = cta.destination ?? null;
	return {
		key: obj.cmsId || `b:${destination || ''}`, kind: 'banner', cmsId: obj.cmsId ?? null,
		slug: (destination || '').match(PRODUCT_PATH)?.[1] ?? null, itemId: itemId(destination),
		// Some banners are a picture only, with no text, button or link
		title: cta.headline || cta.productPageName || cta.subHeadline || BANNER_SECTION,
		productPageName: (cta.productPageName || '').trim() || null,
		headline: cta.headline ?? null, subHeadline: cta.subHeadline ?? null,
		buttonText: cta.buttonText ?? null, destination,
		image: obj.backgroundImageDesktop?.url ?? null, sections: [],
	};
}

/** Items and banners of a family payload by key. An item in several sections is one entry. */
export function parseItems(payload) {
	const found = new Map();
	for (const record of records(payload)) {
		for (const [obj, ancestors] of walk(record)) {
			let entry;
			if (isItem(obj)) {
				entry = item(clean(obj));
			} else if (isObject(obj.callToAction) && 'cmsId' in obj) {
				entry = banner(clean(obj));
			} else {
				continue;
			}
			if (!found.has(entry.key)) {
				found.set(entry.key, entry);
			}
			const kept = found.get(entry.key);
			const name = entry.kind === 'banner' ? BANNER_SECTION : section(ancestors);
			if (name && !kept.sections.includes(name)) {
				kept.sections.push(name);
			}
		}
	}
	for (const entry of found.values()) {
		entry.sections.sort(); // so the page reordering its sections isn't a change
	}
	return Object.fromEntries(found);
}

/** One line for the dry run. */
export function describe(entry) {
	const cost = entry.price?.fullAmount ? entry.price.raw : entry.price?.labelFormat || '-';
	return `${entry.title}${entry.badge ? ` [${entry.badge}]` : ''}  ${entry.price?.discountAmount ? `${cost} (sale)` : cost}  <${entry.key}>`;
}
