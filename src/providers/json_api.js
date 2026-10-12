import { setTimeout as wait } from 'node:timers/promises';
import { finishItem } from './common.js';
import { get } from './http.js';

const PAGE_DELAY_MS = 1000;

/** The value at a dotted path, as text; '' when it's missing. */
function at(obj, dotted) {
	let value = obj;
	for (const part of dotted.split('.')) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return '';
		}
		value = value[part];
	}
	return value === null || value === undefined ? '' : String(value);
}

/** True when each dotted path equals its value, or one of its values when given a list. */
const matches = (entry, where) => Object.entries(where).every(([path, wanted]) => [wanted].flat().map(String).includes(at(entry, path)));

/** The first shopLinks call to action with a url, from the list at `path`; '' if none. */
function shopUrl(entry, path) {
	let list = entry;
	for (const part of path.split('.')) {
		list = list && typeof list === 'object' && !Array.isArray(list) ? list[part] : undefined;
	}
	const action = (Array.isArray(list) ? list : []).find((a) => a && typeof a === 'object' && a.type === 'shopLinks' && a.url);
	return action ? String(action.url) : '';
}

/** Each {dotted.path} replaced by its value; '' when any of them is empty. */
function fill(template, entry) {
	const values = [...template.matchAll(/\{([^}]+)\}/g)].map((m) => at(entry, m[1]));
	return values.every(Boolean) ? template.replace(/\{([^}]+)\}/g, (_, path) => at(entry, path)) : '';
}

async function entries(source, offset) {
	const params = 'offset_param' in source.raw ? { [source.raw.offset_param]: offset } : undefined;
	let data = await (await get(source.url, { headers: { Accept: 'application/json' }, params })).json();
	for (const part of (source.raw.items_path ?? '').split('.').filter(Boolean)) {
		data = data[part];
	}
	return data;
}

/** known: {id: date} from the saved state, or null on a source's first run. The feed is newest update first, so once a
 * page ends on an article we have with the same date, the rest is old. start and pages pick a range instead (deepen). */
export async function fetchFeed(source, known = null, { start = 0, pages = null } = {}) {
	const raw = source.raw;
	const count = pages || (known !== null ? raw.pages ?? 1 : raw.baseline_pages ?? 1);
	const items = [];
	const seen = new Set();
	for (let page = start; page < start + count; page++) {
		if (page > start) {
			await wait(PAGE_DELAY_MS);
		}
		const list = await entries(source, page * (raw.page_size ?? 0));
		for (const entry of list) {
			if (!matches(entry, raw.where ?? {})) {
				continue;
			}
			const fields = Object.fromEntries(Object.entries(raw.fields).map(([name, spec]) => [name, at(entry, spec)]));
			if (raw.url_template) {
				fields.url = fill(raw.url_template, entry) || (fields.url ?? '');
			}
			if (raw.shop_path) {
				fields.shop_url = shopUrl(entry, raw.shop_path);
			}
			const item = finishItem(fields, source.url);
			// A post published between two page requests shifts the list, so skip repeats.
			if (item && !seen.has(item.id)) {
				seen.add(item.id);
				items.push(item);
			}
		}
		if (!('offset_param' in raw) || list.length < (raw.page_size ?? 0)) {
			break;
		}
		if (known !== null && items.length && known[items.at(-1).id] === items.at(-1).date) {
			break;
		}
	}
	return items;
}
