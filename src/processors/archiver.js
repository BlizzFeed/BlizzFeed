import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../json.js';
import { opcodes } from './difflib.js';

// Bump when a change here alters the saved Markdown. The next runs then commit the new format as
// "reformatted" without posting, instead of reporting every recent article as edited.
export const CONVERTER_VERSION = 3;
const SHOP_LINK = /\]\((https:\/\/shop\.battle\.net\/[^)\s]*\/items\/[^)\s]*)\)/;
const CARD_TEXT_SEPARATOR = '\n\n---\n\n';
export const ARCHIVE_STATE_FILE = '_archive.json';
const DAY_MS = 86400 * 1000;

/** The first shop item link in the text: the main one, as a collection comes before its bundles. */
export const findShopUrl = (text) => text.match(SHOP_LINK)?.[1] ?? '';

/** The archived file: the card, then a separator, then the article text. lastUpdated is left out on purpose. */
export function renderFile(item, text) {
	const summary = item.summary.trim().split(/\s+/).join(' '); // one line, so the separator below can't appear inside the card
	const lines = [`# ${item.title}`, '', `- URL: ${item.url}`];
	if (item.image) {
		lines.push(`![](${item.image})`);
	}
	return [...lines, '', `> ${summary}`, '', '---', '', text].join('\n');
}

export function sweepDue(archiveState, sweepMinutes, now) {
	const last = archiveState.last_sweep;
	return !last || now - Date.parse(last) >= sweepMinutes * 60000;
}

const newestFirst = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

/** [item, reason] to fetch: "changed" when the feed date differs from the archive's (or a new article within baseline_days),
 * and on a sweep, "sweep" for the rest updated within window_days, to catch edits that don't bump the date. */
export function plan(items, index, now, cfg, sweep) {
	const byDate = [...items].sort(newestFirst);
	const baselineCutoff = now - cfg.baseline_days * DAY_MS;
	const windowCutoff = now - cfg.window_days * DAY_MS;
	const changed = (item) => (item.id in index ? index[item.id] !== item.date : Date.parse(item.date) >= baselineCutoff);
	const chosen = byDate.filter(changed).map((item) => [item, 'changed']);
	if (sweep) {
		const picked = new Set(chosen.map(([item]) => item.id));
		chosen.push(...byDate.filter((item) => !picked.has(item.id) && Date.parse(item.date) >= windowCutoff).map((item) => [item, 'sweep']));
	}
	return chosen;
}

/** One source's articles not in the archive yet, whatever their age. */
export const planBackfill = (items, index) => items.filter((item) => !(item.id in index));

/** The run's [source, item, reason] candidates, capped: changed before sweep, newest first within each. What is cut carries over. */
export function select(candidates, maxFetches) {
	return [...candidates].sort((a, b) => newestFirst(a[1], b[1])).sort((a, b) => (a[2] !== 'changed') - (b[2] !== 'changed')).slice(0, maxFetches);
}

/** [card, text] of an archived file. */
export function splitFile(content) {
	const at = content.indexOf(CARD_TEXT_SEPARATOR);
	return at === -1 ? [content, ''] : [content.slice(0, at), content.slice(at + CARD_TEXT_SEPARATOR.length)];
}

const lines = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/** [added, changed, removed] line counts between two texts. A block of lines replaced by another counts as changed lines,
 * as many as the shorter side has; what the longer side has over is added or removed. */
export function lineChanges(oldText, newText) {
	let [added, changed, removed] = [0, 0, 0];
	for (const [tag, i1, i2, j1, j2] of opcodes(lines(oldText), lines(newText))) {
		if (tag === 'insert') {
			added += j2 - j1;
		} else if (tag === 'delete') {
			removed += i2 - i1;
		} else if (tag === 'replace') {
			changed += Math.min(i2 - i1, j2 - j1);
			added += Math.max(j2 - j1 - (i2 - i1), 0);
			removed += Math.max(i2 - i1 - (j2 - j1), 0);
		}
	}
	return [added, changed, removed];
}

/** How an article changed: archived (no old file), text, card, or null when identical. */
export function classify(oldContent, newContent) {
	if (oldContent === null) {
		return 'archived';
	}
	if (oldContent === newContent) {
		return null;
	}
	return splitFile(oldContent)[1] !== splitFile(newContent)[1] ? 'text' : 'card';
}

export const indexPath = (archiveDir, sourceId) => path.join(archiveDir, sourceId, 'index.json');
export const articlePath = (sourceId, articleId) => `${sourceId}/${articleId}.md`;

const loadJson = (file, empty) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : empty);

export const loadIndex = (archiveDir, sourceId) => loadJson(indexPath(archiveDir, sourceId), {});
export const saveIndex = (archiveDir, sourceId, index) => writeJson(indexPath(archiveDir, sourceId), index, { sortKeys: true });
export const loadArchiveState = (archiveDir) => loadJson(path.join(archiveDir, ARCHIVE_STATE_FILE), {});
export const saveArchiveState = (archiveDir, state) => writeJson(path.join(archiveDir, ARCHIVE_STATE_FILE), state, { sortKeys: true });

export function readArticle(archiveDir, sourceId, articleId) {
	const file = path.join(archiveDir, articlePath(sourceId, articleId));
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n') : null;
}

export function writeArticle(archiveDir, sourceId, articleId, content) {
	const file = path.join(archiveDir, articlePath(sourceId, articleId));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

/** Sets shop_url on the items without one from the first shop link in their saved text. Returns how many. */
export function fillShopUrls(archiveDir, items, sourceId) {
	let saved = 0;
	for (const item of items.filter((i) => !i.shop_url)) {
		const content = readArticle(archiveDir, sourceId, item.id);
		const url = content && findShopUrl(splitFile(content)[1]);
		if (url) {
			item.shop_url = url;
			saved++;
		}
	}
	return saved;
}
