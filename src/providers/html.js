import * as cheerio from 'cheerio';
import { finishItem } from './common.js';
import { get } from './http.js';

const NOT_TEXT = new Set(['script', 'style', 'template']);

/** The element's text pieces, each trimmed, joined by a space. */
export function textOf(node) {
	const pieces = [];
	const walk = (n) => {
		if (n.type === 'text') {
			pieces.push(n.data.trim());
		} else if (n.children && !NOT_TEXT.has(n.name)) {
			n.children.forEach(walk);
		}
	};
	walk(node);
	return pieces.filter(Boolean).join(' ');
}

function extract($, element, spec) {
	const { selector, attr, json_key: jsonKey, regex } = typeof spec === 'string' ? { selector: spec } : spec;
	const target = selector ? $(element).find(selector).first() : $(element);
	if (!target.length) {
		return '';
	}
	let value = attr ? target.attr(attr) ?? '' : textOf(target[0]);
	if (jsonKey) {
		try {
			value = String(JSON.parse(value)[jsonKey] ?? '');
		} catch {
			value = '';
		}
	}
	if (regex) {
		value = value.match(new RegExp(regex))?.[1] ?? '';
	}
	return value;
}

/** The items on a page, by the source's CSS selectors. */
export async function fetchFeed(source) {
	const $ = cheerio.load(await (await get(source.url)).text(), { xml: { xmlMode: false } }); // htmlparser2, like the article pages
	const prefix = source.raw.url_prefix;
	const items = [];
	for (const element of $(source.raw.item_selector).toArray()) {
		const raw = Object.fromEntries(Object.entries(source.raw.fields).map(([name, spec]) => [name, extract($, element, spec)]));
		if (prefix && raw.url?.startsWith('/')) {
			raw.url = prefix.replace(/\/+$/, '') + raw.url;
		}
		const item = finishItem(raw, source.url);
		if (item) {
			items.push(item);
		}
	}
	return items;
}
