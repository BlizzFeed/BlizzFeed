const KEYS = ['id', 'title', 'url', 'date', 'summary', 'image'];
const OPTIONAL = ['shop_url']; // only kept on the item when set

/** A link against the page it came from. An absolute one is kept exactly as it is. */
export function absolute(url, base) {
	return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : new URL(url, base).href;
}

export const squash = (text) => (text ?? '').trim().split(/\s+/).join(' ');

/** One scraped item, normalised; null when it has no usable id or title. */
export function finishItem(raw, baseUrl) {
	const item = Object.fromEntries(KEYS.map((key) => [key, squash(String(raw[key] ?? ''))]));
	if (!item.id || !item.title) {
		return null;
	}
	for (const key of OPTIONAL) {
		if (raw[key]) {
			item[key] = raw[key];
		}
	}
	for (const key of ['url', 'image', 'shop_url']) {
		if (item[key]) {
			item[key] = absolute(item[key], baseUrl);
		}
	}
	return item;
}
