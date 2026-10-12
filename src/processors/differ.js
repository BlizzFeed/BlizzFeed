import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../json.js';

const ANNOUNCED = ['title', 'summary', 'image']; // a change here posts "updated"
const QUIET = ['date', 'url', 'shop_url']; // a change only here is saved without a message (a retitle changes the slug too)

export const statePath = (dataDir, sourceId) => path.join(dataDir, sourceId, 'state.json');
export const itemPath = (sourceId, itemId) => `${sourceId}/items/${itemId}.md`;

export function loadState(dataDir, sourceId) {
	const file = statePath(dataDir, sourceId);
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

const field = (item, key) => (key in item ? item[key] : '');

export const changedFields = (prev, item) => ANNOUNCED.filter((key) => field(prev, key) !== item[key]);

/** Append-only diff by id: an item missing from the fetch is never reported as removed.
 * [added, updated, quiet]; quiet items only changed their date, url or shop link. */
export function compute(oldState, items) {
	const old = new Map((oldState ?? []).map((i) => [i.id, i]));
	const [added, updated, quiet] = [[], [], []];
	for (const item of items) {
		const prev = old.get(item.id);
		if (!prev) {
			added.push(item);
		} else if (changedFields(prev, item).length) {
			updated.push(item);
		} else if (QUIET.some((key) => field(prev, key) !== field(item, key))) {
			quiet.push(item);
		}
	}
	return [added, updated, quiet];
}

/** Items with a shop link their saved copy lacked. None on a source's first run. */
export function newShopLinks(oldState, items) {
	const old = new Map((oldState ?? []).map((i) => [i.id, i.shop_url]));
	return oldState?.length ? items.filter((i) => i.shop_url && i.shop_url !== old.get(i.id)) : [];
}

/** Keeps the saved shop link (found in the article text) when the feed's card has none. A card link wins. */
export function keepShopUrls(oldState, items) {
	const saved = new Map((oldState ?? []).filter((i) => i.shop_url).map((i) => [i.id, i.shop_url]));
	for (const item of items) {
		if (!item.shop_url && saved.has(item.id)) {
			item.shop_url = saved.get(item.id);
		}
	}
}

export function merge(oldState, items) {
	const merged = new Map((oldState ?? []).map((i) => [i.id, i]));
	for (const item of items) {
		merged.set(item.id, item);
	}
	return [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function renderMarkdown(item) {
	const lines = [`# ${item.title}`, '', `- URL: ${item.url}`, `- Date: ${item.date}`];
	if (item.image) {
		lines.push(`![](${item.image})`); // an image, not a link, so GitHub's preview shows it
	}
	return [...lines, '', item.summary, ''].join('\n');
}

export function writeSource(dataDir, sourceId, merged, changedItems) {
	fs.mkdirSync(path.join(dataDir, sourceId, 'items'), { recursive: true });
	for (const item of changedItems) {
		fs.writeFileSync(path.join(dataDir, itemPath(sourceId, item.id)), renderMarkdown(item));
	}
	writeJson(statePath(dataDir, sourceId), merged);
}
