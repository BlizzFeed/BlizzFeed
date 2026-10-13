import { setTimeout as wait } from 'node:timers/promises';
import { logger } from '../log.js';
import { USER_AGENT } from '../providers/http.js';

const POST_ATTEMPTS = 3;
const TIMEOUT_MS = 10000;
export const COLORS = { added: 0x57F287, updated: 0xFAA61A, down: 0xED4245, recovered: 0x57F287, log: 0x5865F2, stream: 0x9B59B6 };
const LOG_USERNAME = 'BlizzFeed Log';
const LOG_AVATAR = 'https://raw.githubusercontent.com/BlizzFeed/BlizzFeed/main/logos/BlizzFeed_ServerIcon_512.png';
const LOGO = 'https://raw.githubusercontent.com/BlizzFeed/BlizzFeed/main/logos/BlizzFeed_AppLogo_200-nobg.png';
const LOG_TEXT_BUDGET = 3000; // Discord allows 4000 characters of text per message; the rest is header and footer
export const IS_COMPONENTS_V2 = 1 << 15; // message flag: content/embeds are disabled, components only
export const DIVIDER = { type: 14, divider: true, spacing: 1 };
const LOG_HEADING = 'Changes detected';
const ARCHIVE_LOG_HEADING = 'Archive changes';
const SHOP_LOG_HEADING = 'Shop changes';
const YOUTUBE_LOG_HEADING = 'YouTube changes';
const ARCHIVE_SECTION = '### 📦 Archive';
export const LOG_TOTAL_TEXT = 4000; // Discord's limit for the text of one message
// Component ids the bot looks for when it merges two posts (same numbers in the bot's merge.js)
export const [DIFF_ID, BUTTONS_ID, FOOTER_ID, NOTE_ID] = [100, 101, 102, 103];
const TEXT_CHECK_NOTE = '-# ⏳ Checking the article text for changes…';

/** Cuts by code point, so an emoji is never split. Budgets elsewhere use .length, which only errs on the safe side. */
export function trim(text, limit) {
	const chars = [...text];
	return chars.length <= limit ? text : chars.slice(0, limit - 1).join('') + '…';
}

const plural = (n, word) => `${n} ${word}${n !== 1 ? 's' : ''}`;
export const linkLabel = (text, limit) => trim(text, limit).replaceAll('[', '(').replaceAll(']', ')');
const nowIso = () => new Date().toISOString();

/** '<t:ts:s> (<t:ts:R>)' renders in each reader's local time; relativeOnly keeps just the '1 minute ago'. Falls back to the raw text. */
export function discordTime(iso, relativeOnly = false) {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) {
		return iso;
	}
	const ts = Math.floor(ms / 1000);
	return relativeOnly ? `<t:${ts}:R>` : `<t:${ts}:s> (<t:${ts}:R>)`;
}

/** Fenced block for log-like text; a ``` inside it would close the block early. */
const codeBlock = (text) => `\`\`\`\n${text.replaceAll('```', "'''")}\n\`\`\``;

export const text = (content, id = null) => (id === null ? { type: 10, content } : { type: 10, id, content });

/** A text with the BlizzFeed logo as its thumbnail. */
const withLogo = (content) => ({ type: 9, components: [text(content)], accessory: { type: 11, media: { url: LOGO } } });

export const linkButton = (label, url) => ({ type: 2, style: 5, label, url });

/** The article's commit history on the archive branch. GitHub answers 200 for a path it hasn't seen yet. */
export const historyUrl = (repoUrl, sourceId, itemId) => (repoUrl ? `${repoUrl}/commits/archive/${sourceId}/${itemId}.md` : null);

/** The article's saved copy on the archive branch. It 404s until the archive run has written it. */
export const archiveUrl = (repoUrl, sourceId, itemId) => (repoUrl ? `${repoUrl}/blob/archive/${sourceId}/${itemId}.md` : null);

/** The card's Markdown file at the commit that wrote it, which GitHub renders as a page. */
export const summaryUrl = (repoUrl, commit, sourceId, itemId) => (repoUrl && commit ? `${repoUrl}/blob/${commit}/${sourceId}/items/${itemId}.md` : null);

/** A ```diff block, which Discord colours green for + and red for -. null when there's nothing to show. */
export function diffBlock(lines) {
	if (!lines.length) {
		return null;
	}
	const body = lines.join('\n').replaceAll('`', "'"); // a backtick in a title would end the block
	return text(`\`\`\`diff\n${body}\n\`\`\``, DIFF_ID);
}

function cardDiffLines(item) {
	const changed = item.changed ?? [];
	const lines = [];
	if (changed.includes('title')) {
		lines.push(`- ${trim(item.previous_title ?? '', 100)}`, `+ ${trim(item.title, 100)}`);
	}
	if (changed.includes('summary')) {
		lines.push('+ Summary changed');
	}
	if (changed.includes('image')) {
		lines.push('+ Image changed');
	}
	return lines;
}

/** The + / ~ / - lines of an edited article's text, leaving out what is zero. */
export const lineCountLines = (change) => [['+', 'added'], ['~', 'changed'], ['-', 'removed']]
	.filter(([, key]) => change[key])
	.map(([sign, key]) => `${sign} ${change[key]} line${change[key] !== 1 ? 's' : ''} ${key}`);

/** The title text, in a section with the thumbnail beside it when there is one. */
export function top(content, thumbnail, title) {
	if (!thumbnail) {
		return [content];
	}
	return [{ type: 9, components: [content], accessory: { type: 11, media: { url: thumbnail }, description: [...title].slice(0, 1024).join('') } }];
}

const buttonRow = (pairs) => pairs.filter(([, url]) => url).map(([label, url]) => linkButton(label, url));
const site = (repoUrl) => (repoUrl ? `[BlizzFeed](${repoUrl})` : 'BlizzFeed');
const container = (color, components) => ({ flags: IS_COMPONENTS_V2, components: [{ type: 17, accent_color: color, components }] });

/** A new or updated article. An update shows what changed on its card, and a note while the archive re-checks the text
 * (the bot removes it). The thumbnail is the article's image, else the game's logo. */
export function buildItemMessage(action, item, commitUrl, repoUrl, { summary = null, archived = null, history = null, logo = null } = {}) {
	const title = trim(item.title, 256);
	const body = text(trim(`## ${title}\n${trim(item.summary, 600)}`, 3000));
	const updated = action === 'updated';
	const before = updated && (item.changed ?? []).includes('image') ? item.previous_image : '';
	// With a Before / After pair the new image would only repeat, so the game's logo goes there instead.
	const inner = top(body, before ? logo : item.image || logo, title);
	const block = updated ? diffBlock(cardDiffLines(item)) : null;
	if (block) {
		inner.push(block);
	}
	if (before && item.image) {
		inner.push(text('**Before** (left)  ·  **After** (right)'),
			{ type: 12, items: [{ media: { url: before }, description: 'Before' }, { media: { url: item.image }, description: 'After' }] });
	}
	const buttons = buttonRow([['Read Article', item.url], ['Shop', item.shop_url], updated ? ['Summary Changes', commitUrl] : ['Summary', summary],
		['Archive', updated ? null : archived], ['History', history]]);
	if (buttons.length) {
		inner.push(DIVIDER, { type: 1, id: BUTTONS_ID, components: buttons });
	}
	// An update keeps the article's original date, so it's stamped with when we noticed the change.
	const when = updated ? nowIso() : item.date;
	const posted = when ? `${updated ? 'Updated' : 'Posted'} ${discordTime(when)} · ` : '';
	inner.push(DIVIDER, text(`-# ${posted}${site(repoUrl)}`, FOOTER_ID));
	if (updated && item.awaits_text) {
		inner.push(text(TEXT_CHECK_NOTE, NOTE_ID));
	}
	return container(COLORS[action], inner);
}

/** An article whose text was edited: like an update, with the line counts and Read Article / Article Changes / History. */
export function buildEditMessage(change, repoUrl, sourceId, commitUrl, logo = null) {
	const title = trim(change.title, 256);
	const body = text(trim(`## ${title}\n${trim(change.summary ?? '', 600)}`.trimEnd(), 3000));
	const inner = top(body, change.image || logo, title);
	const block = diffBlock(lineCountLines(change));
	if (block) {
		inner.push(block);
	}
	const buttons = buttonRow([['Read Article', change.url], ['Article Changes', commitUrl], ['History', historyUrl(repoUrl, sourceId, change.id)]]);
	if (buttons.length) {
		inner.push(DIVIDER, { type: 1, id: BUTTONS_ID, components: buttons });
	}
	inner.push(DIVIDER, text(`-# Updated ${discordTime(nowIso())} · ${site(repoUrl)}`, FOOTER_ID));
	return container(COLORS.updated, inner);
}

export function buildAlertMessage(name, alert, runUrl, what = 'source') {
	const since = discordTime(alert.since, true);
	let content;
	if (alert.kind === 'down') {
		content = `## ${name} - ${what} failing\nFailing since ${since}.\n${codeBlock(alert.error)}${runUrl ? `\n[Run logs](${runUrl})` : ''}`;
	} else {
		content = `## ${name} - ${what} recovered\nBack to normal (was failing since ${since}).`;
	}
	return container(COLORS[alert.kind], [withLogo(trim(content, 3000))]);
}

const recoveredPart = (since) => `✅ recovered (was failing since ${discordTime(since, true)})`;
const commitTitle = (name, repoUrl, commit) => (repoUrl && commit ? `[${name}](${repoUrl}/commit/${commit})` : name);
const recoveries = (alerts) => Object.fromEntries(alerts.filter((a) => a.kind === 'recovered').map((a) => [a.source, a.since]));

/** One source's part of the log: a counts line (linked to its commit), then a line per announced item. */
function logEntry(name, entry, repoUrl, recoveredSince) {
	let parts;
	if (entry.baseline) {
		parts = [`🆕 baseline, ${entry.items} items stored, no notifications`];
	} else {
		parts = [];
		if (entry.added.length) {
			parts.push(`+${entry.added.length} new`);
		}
		if (entry.updated.length) {
			parts.push(`${entry.updated.length} updated`);
		}
		if (entry.quiet) {
			parts.push(`${entry.quiet} quiet${parts.length ? '' : ' (date/url only, nothing announced)'}`);
		}
	}
	if (recoveredSince) {
		parts.push(recoveredPart(recoveredSince));
	}
	const lines = [`**${commitTitle(name, repoUrl, entry.commit)}** · ${parts.join(', ')}`];
	for (const [emoji, action] of [['🟢', 'added'], ['🟠', 'updated']]) {
		for (const item of entry[action]) {
			lines.push(`- ${emoji} [${linkLabel(item.title, 100)}](${item.url})`);
		}
	}
	return lines.join('\n');
}

/** Dev/debug summary of a run, or null when nothing changed. A failing source gets its own red container; one that
 * recovered is listed with the changes. */
export function buildLogMessage(diff, sources, repoUrl, runUrl) {
	const recovered = recoveries(diff.alerts);
	const blocks = [];
	for (const [sourceId, entry] of Object.entries(diff.sources)) {
		if (entry.baseline || entry.added.length || entry.updated.length || entry.quiet || sourceId in recovered) {
			blocks.push(logEntry(sources[sourceId]?.name ?? sourceId, entry, repoUrl, recovered[sourceId]));
		}
	}
	const down = diff.alerts.filter((a) => a.kind === 'down');
	if (!blocks.length && !down.length) {
		return null;
	}
	const containers = blocks.length ? [logContainer(LOG_HEADING, blocks, Object.keys(diff.sources).length, runUrl, 'Data run')] : [];
	for (const alert of down) {
		containers.push(...buildAlertMessage(sources[alert.source]?.name ?? alert.source, alert, runUrl).components);
	}
	return logPayload(containers);
}

export const SHOP_EMOJI = {
	new: '🟢', back: '🔁', gone: '🔴', unlisted: '👻', price: '💵', sale_start: '🏷️', sale_end: '⌛', badge: '✨', details: '📝', banner: '🖼️',
};
const SHOP_LABEL = {
	new: 'new', back: 'back', gone: 'gone', unlisted: 'unlisted', price: 'price', sale_start: 'sale started', sale_end: 'sale ended',
	badge: 'badge', details: 'details', banner: 'banner',
};
const SHOP_ORDER = Object.keys(SHOP_LABEL);
const SHOP_PLURAL = ['price', 'badge', 'banner'];

function countBy(list, key) {
	const counts = {};
	for (const entry of list) {
		counts[entry[key]] = (counts[entry[key]] ?? 0) + 1;
	}
	return counts;
}

function shopCounts(changes) {
	const counts = countBy(changes, 'type');
	return SHOP_ORDER.filter((kind) => kind in counts)
		.map((kind) => `${counts[kind]} ${SHOP_LABEL[kind]}${counts[kind] > 1 && SHOP_PLURAL.includes(kind) ? 's' : ''}`).join(', ');
}

/** One changed field: sections show their old and new values, the rest just say they changed. */
function shopField(change, field) {
	if (field !== 'sections' || change.type !== 'details') {
		return `${field} changed`;
	}
	const [old, now] = ['from', 'to'].map((side) => change[side].sections.join(', ') || 'none');
	return `sections: ${old} → ${now}`;
}

/** The small line under a change, if it needs one. */
function shopDetail(change) {
	if (change.type === 'price') {
		return `${change.from || '–'} → ${change.to || '–'}`;
	}
	if (change.type === 'badge') {
		return `${change.from || 'no badge'} → ${change.to || 'no badge'}`;
	}
	if (['details', 'banner'].includes(change.type) && change.changed?.length) {
		return change.changed.map((field) => shopField(change, field)).join(' · ');
	}
	return change.what === 'back' ? 'back' : null;
}

/** A change as a line linked to its shop page. */
function shopLine(change, base) {
	// Some banners have no button text.
	const label = change.type === 'banner' && change.product ? [change.button, change.product].filter(Boolean).join(' · ') : (change.title || change.key).trim();
	const destination = change.destination || '';
	const url = destination.startsWith('/') ? base + destination : destination; // the Gear cards link off-site
	const lines = [`- ${SHOP_EMOJI[change.type]} ${url ? `[${linkLabel(label, 80)}](${url})` : linkLabel(label, 80)}`];
	const detail = shopDetail(change);
	if (detail) {
		lines.push(`  -# ${detail}`);
	}
	return lines.join('\n');
}

/** One shop page's part of the log: a counts line linked to its commit, then a line per change. */
function shopEntry(name, entry, base, repoUrl, recoveredSince) {
	let parts;
	if (entry.baseline) {
		parts = [`🆕 baseline, ${entry.items} items stored, nothing reported`];
	} else {
		parts = entry.changes.length ? [shopCounts(entry.changes)] : [];
	}
	if (recoveredSince) {
		parts.push(recoveredPart(recoveredSince));
	}
	const lines = [`**${commitTitle(name, repoUrl, entry.commit)}** · ${parts.join(', ')}`];
	const sorted = entry.changes.toSorted((a, b) => SHOP_ORDER.indexOf(a.type) - SHOP_ORDER.indexOf(b.type));
	return [...lines, ...sorted.map((change) => shopLine(change, base))].join('\n');
}

/** Summary of a shop run for the log channel, or null when nothing happened. Failing pages are a message of their own. */
export function buildShopLogMessage(diff, families, regions, repoUrl, runUrl) {
	const recovered = recoveries(diff.alerts);
	const blocks = [];
	for (const [label, entry] of Object.entries(diff.families)) {
		if (entry.baseline || entry.changes.length || label in recovered) {
			const [region, family] = label.split('/');
			blocks.push(shopEntry(`${families[family].name} · ${region.toUpperCase()}`, entry, regions[region], repoUrl, recovered[label]));
		}
	}
	if (!blocks.length) {
		return null;
	}
	const pages = Object.keys(families).length * Object.keys(regions).length;
	return logPayload([logContainer(SHOP_LOG_HEADING, blocks, pages, runUrl, 'Shop run', 'shop page')]);
}

/** Shop families the home page links to that aren't in sources.yaml, for the log channel. */
export function buildNewFamiliesMessage(slugs, base) {
	const lines = slugs.map((slug) => `- [${slug}](${base}/family/${slug})`).join('\n');
	const content = `## New shop families\n${lines}\n-# Not tracked. Add them under shop: families in sources.yaml to follow them.`;
	return logPayload([{ type: 17, accent_color: COLORS.log, components: [withLogo(content)] }]);
}

const YOUTUBE_EMOJI = { video: '🎬', short: '📱', stream: '🔴', edited: '✏️', live: '🔴', rescheduled: '🕒' };
const YOUTUBE_ORDER = ['new', 'live', 'rescheduled', 'edited'];

/** A change as a line linked to its video, with the detail under it. */
function youtubeLine(change) {
	const emoji = change.type === 'new' ? YOUTUBE_EMOJI[change.kind] : change.type === 'live' && change.to === 'ended' ? '⏹️' : YOUTUBE_EMOJI[change.type];
	const lines = [`- ${emoji} [${linkLabel(change.title, 80)}](https://www.youtube.com/watch?v=${change.id})`];
	if (change.type === 'new') {
		lines.push(`  -# new ${change.premiere ? 'premiere' : change.kind}${change.live !== 'none' ? `, ${change.live}` : ''}`);
	} else if (change.type === 'live') {
		lines.push(`  -# ${change.from} → ${change.to}`);
	} else if (change.type === 'edited') {
		lines.push(`  -# ${Object.keys(change.fields).join(' and ')} edited`);
	} else {
		lines.push('  -# start time changed');
	}
	return lines.join('\n');
}

/** One channel's part of the log: a counts line linked to its commit, then a line per change. */
function youtubeEntry(name, entry, repoUrl, recoveredSince) {
	const counts = countBy(entry.changes, 'type');
	const parts = entry.baseline ? [`🆕 baseline, ${entry.videos} videos stored, nothing reported`] : YOUTUBE_ORDER.filter((type) => type in counts).map((type) => `${counts[type]} ${type}`);
	if (recoveredSince) {
		parts.push(recoveredPart(recoveredSince));
	}
	const sorted = entry.changes.toSorted((a, b) => YOUTUBE_ORDER.indexOf(a.type) - YOUTUBE_ORDER.indexOf(b.type));
	return [`**${commitTitle(name, repoUrl, entry.commit)}** · ${parts.join(', ')}`, ...sorted.map(youtubeLine)].join('\n');
}

/** Summary of a YouTube run for the log channel, or null when nothing happened. Failing channels are a message of their own. */
export function buildYoutubeLogMessage(diff, channels, repoUrl, runUrl) {
	const recovered = recoveries(diff.alerts);
	const blocks = Object.entries(diff.channels)
		.filter(([handle, entry]) => entry.baseline || entry.changes.length || handle in recovered)
		.map(([handle, entry]) => youtubeEntry(channels[handle]?.name ?? handle, entry, repoUrl, recovered[handle]));
	return blocks.length ? logPayload([logContainer(YOUTUBE_LOG_HEADING, blocks, Object.keys(channels).length, runUrl, 'YouTube run', 'channel')]) : null;
}

/** Shop pages that started or stopped failing, in one container however many there are. */
export const buildShopAlertMessage = (alerts, runUrl) => alertsMessage(alerts, runUrl, 'Shop pages');

export const buildYoutubeAlertMessage = (alerts, runUrl) => alertsMessage(alerts, runUrl, 'YouTube channels');

function alertsMessage(alerts, runUrl, noun) {
	const blocks = [];
	const down = alerts.filter((a) => a.kind === 'down');
	if (down.length) {
		blocks.push(`## ${noun} failing\n` + down.map((a) => `- \`${a.source}\` since ${discordTime(a.since, true)}: ${trim(a.error, 100)}`).join('\n'));
	}
	const recovered = alerts.filter((a) => a.kind === 'recovered');
	if (recovered.length) {
		blocks.push(`## ${noun} recovered\n` + recovered.map((a) => `- \`${a.source}\` (was failing since ${discordTime(a.since, true)})`).join('\n'));
	}
	if (!blocks.length) {
		return null;
	}
	const inner = [text(blocks.map((block) => fitLines(block, Math.floor(LOG_TEXT_BUDGET / 2))).join('\n\n'))];
	if (runUrl) {
		inner.push({ type: 1, components: [linkButton('Run logs', runUrl)] });
	}
	return logPayload([{ type: 17, accent_color: COLORS[down.length ? 'down' : 'recovered'], components: inner }]);
}

const logPayload = (containers) => ({ flags: IS_COMPONENTS_V2, username: LOG_USERNAME, avatar_url: LOG_AVATAR, components: containers });

/** Cut a block at a line end, so a link is never cut in half, and say how many lines were left out. */
function fitLines(block, limit) {
	if (block.length <= limit) {
		return block;
	}
	const lines = block.split('\n');
	const kept = [];
	let size = 0;
	for (const line of lines) {
		if (kept.length && size + line.length + 1 > limit - 30) { // room for the note
			break;
		}
		kept.push(line);
		size += line.length + 1;
	}
	return [...kept, `-# …and ${lines.length - kept.length} more`].join('\n');
}

/** The blurple summary container: a block per changed source, trimmed to fit, then an unchanged count. */
function logContainer(heading, blocks, total, runUrl, runLabel, noun = 'source') {
	const shown = [];
	let used = 0;
	for (const block of blocks) {
		if (shown.length && used + block.length > LOG_TEXT_BUDGET) {
			break;
		}
		shown.push(fitLines(block, LOG_TEXT_BUDGET));
		used += block.length + 2;
	}
	if (shown.length < blocks.length) {
		shown.push(`-# …and ${plural(blocks.length - shown.length, `more ${noun}`)}`);
	}
	const inner = [withLogo(`## ${heading}\n-# ${discordTime(nowIso())} · ${blocks.length} of ${total} ${noun}s changed`), DIVIDER, text(shown.join('\n\n'))];
	if (total > blocks.length) {
		inner.push(DIVIDER, text(`-# Unchanged: ${plural(total - blocks.length, noun)}`));
	}
	if (runUrl) {
		inner.push({ type: 1, components: [linkButton(runLabel, runUrl)] });
	}
	return { type: 17, accent_color: COLORS.log, components: inner };
}

const ARCHIVE_EMOJI = { archived: '📦', text: '📝', card: '🎴', reformatted: '🔧' };
const ARCHIVE_LABEL = { archived: 'archived', text: 'text edited', card: 'summary changed', reformatted: 'reformatted' };

/** One source's part of the archive log: a counts line, then a line per article linked to its commit. */
function archiveLogEntry(name, entry, repoUrl, recoveredSince) {
	const counts = countBy(entry.articles, 'kind');
	const parts = Object.keys(ARCHIVE_LABEL).filter((kind) => kind in counts).map((kind) => `${counts[kind]} ${ARCHIVE_LABEL[kind]}`);
	const backfill = 'left' in entry; // only a backfill run has it; its article lines would fill the message
	if (backfill) {
		parts.push(entry.left ? `${entry.left} left to backfill` : 'backfill complete');
	}
	if (recoveredSince) {
		parts.push(recoveredPart(recoveredSince));
	}
	const lines = [`**${name}** · ${parts.join(', ')}`];
	for (const change of backfill ? [] : entry.articles) {
		const detail = change.kind === 'text' ? [`+${change.added} ~${change.changed} −${change.removed}`] : [];
		if (change.silent) { // only the window sweep finds these, so they show whether it's worth widening
			detail.push('silent edit (date unchanged)');
		}
		lines.push(`- ${ARCHIVE_EMOJI[change.kind]} ${commitTitle(linkLabel(change.title, 100), repoUrl, change.commit)}`);
		if (detail.length) {
			lines.push(`  -# ${detail.join(' · ')}`);
		}
	}
	return lines.join('\n');
}

/** Summary of an archive run for the log channel, or null when nothing changed. Archive alerts only ever go here. */
export function buildArchiveLogMessage(diff, sources, repoUrl, runUrl) {
	const recovered = recoveries(diff.alerts);
	const blocks = [];
	for (const [sourceId, entry] of Object.entries(diff.sources)) {
		if (entry.articles.length || sourceId in recovered) {
			blocks.push(archiveLogEntry(sources[sourceId]?.name ?? sourceId, entry, repoUrl, recovered[sourceId]));
		}
	}
	const down = diff.alerts.filter((a) => a.kind === 'down');
	if (!blocks.length && !down.length) {
		return null;
	}
	// diff only has the sources fetched this run, so count from all of them.
	const containers = blocks.length ? [logContainer(ARCHIVE_LOG_HEADING, blocks, Object.keys(sources).length, runUrl, 'Archive run')] : [];
	for (const alert of down) {
		containers.push(...buildAlertMessage(sources[alert.source]?.name ?? alert.source, alert, runUrl, 'archive').components);
	}
	return logPayload(containers);
}

/** Discord adds ids to the components of a message it sends back; drop them so they can't clash with new parts. */
function withoutIds(node) {
	if (Array.isArray(node)) {
		return node.map(withoutIds);
	}
	if (node && typeof node === 'object') {
		return Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'id').map(([key, value]) => [key, withoutIds(value)]));
	}
	return node;
}

function heading(part) {
	let first = part.components?.[0];
	if (first?.type === 9) { // the heading sits in a section, beside the logo
		first = first.components[0];
	}
	return first?.type === 10 ? first.content.split('\n')[0] : null;
}

function textLength(node) {
	if (Array.isArray(node)) {
		return node.reduce((sum, n) => sum + textLength(n), 0);
	}
	if (node && typeof node === 'object') {
		return (node.type === 10 ? node.content.length : 0) + textLength(node.components ?? []);
	}
	return 0;
}

/** Fold an archive run's log into the tracker run's log post. null when that post isn't a run log, already has an
 * archive section, or would get too long. */
export function mergeArchiveLog(existing, archive) {
	const components = withoutIds(existing.components ?? []);
	const log = components.find((c) => c.type === 17 && heading(c) === `## ${LOG_HEADING}`);
	if (!log || log.components.some((c) => c.type === 10 && c.content.startsWith(ARCHIVE_SECTION))) {
		return null;
	}
	const inner = log.components;
	const archiveLog = archive.components.find((c) => heading(c) === `## ${ARCHIVE_LOG_HEADING}`);
	if (archiveLog) {
		// Before the unchanged count, or else before the buttons.
		const at = inner.findIndex((c, i) => i >= 3 && [14, 1].includes(c.type));
		inner.splice(at === -1 ? inner.length : at, 0, DIVIDER, text(`${ARCHIVE_SECTION}\n${archiveLog.components[2].content}`));
		const buttons = archiveLog.components.find((c) => c.type === 1)?.components ?? [];
		if (buttons.length) {
			let row = inner.find((c) => c.type === 1);
			if (!row) {
				row = { type: 1, components: [] };
				inner.push(row);
			}
			row.components.push(...buttons);
		}
	}
	const merged = { flags: IS_COMPONENTS_V2, components: [...components, ...archive.components.filter((c) => c !== archiveLog)] };
	return textLength(merged.components) <= LOG_TOTAL_TEXT ? merged : null;
}

/** Seconds to wait after a 429, from Discord's JSON body, else 2. */
async function retryDelay(response) {
	const seconds = Number((await response.json().catch(() => null))?.retry_after);
	return Number.isNaN(seconds) ? 2 : Math.min(Math.max(seconds, 0), 30);
}

// Errors where the request can't have reached Discord, so a retry can't post twice. A timeout may have been accepted.
const NEVER_SENT = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'];

/** Retries a 429 (after Discord's retry_after), a 5xx and a failed connect (with backoff). Any other 4xx or error fails
 * at once. Returns the response, or null. */
async function request(method, url, payload = null) {
	const target = URL.parse(url);
	if (!target) {
		logger.error('Discord request failed: the webhook URL is not valid');
		return null;
	}
	target.searchParams.set('with_components', 'true');
	target.searchParams.set('wait', 'true'); // a POST answers with the new message
	const headers = { 'User-Agent': USER_AGENT, ...(payload ? { 'Content-Type': 'application/json' } : {}) };
	for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt++) {
		let response;
		try {
			response = await fetch(target, { method, headers, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
		} catch (error) {
			const reason = error.cause?.message ?? error.message;
			if (NEVER_SENT.includes(error.cause?.code) && attempt < POST_ATTEMPTS) {
				logger.warning(`Discord connect failed (attempt ${attempt}/${POST_ATTEMPTS}): ${reason}`);
				await wait(2 ** attempt * 1000);
				continue;
			}
			logger.error(`Discord request failed: ${reason}`);
			return null;
		}
		if (response.status === 200 || response.status === 204) {
			return response;
		}
		if (response.status === 429) {
			await wait(await retryDelay(response) * 1000);
		} else if (response.status >= 500 && attempt < POST_ATTEMPTS) {
			await response.body?.cancel();
			logger.warning(`Discord returned ${response.status} (attempt ${attempt}/${POST_ATTEMPTS})`);
			await wait(2 ** attempt * 1000);
		} else {
			logger.error(`Discord returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
			return null;
		}
	}
	return null;
}

const json = async (response) => (response ? response.json().catch(() => null) : null);

/** POST a message. Returns its id, or null. */
export const post = async (webhookUrl, payload) => (await json(await request('POST', webhookUrl, payload)))?.id ?? null;

/** The message's URL, kept apart from any query on the webhook (such as ?thread_id=). */
function messageUrl(webhookUrl, messageId) {
	const target = URL.parse(webhookUrl);
	if (target) {
		target.pathname += `/messages/${messageId}`;
	}
	return target?.href ?? webhookUrl;
}

export const fetchMessage = async (webhookUrl, messageId) => json(await request('GET', messageUrl(webhookUrl, messageId)));

export async function editMessage(webhookUrl, messageId, payload) {
	const response = await request('PATCH', messageUrl(webhookUrl, messageId), payload);
	await response?.body?.cancel();
	return response !== null;
}

function logWebhook(what) {
	const url = process.env.DISCORD_WEBHOOK_LOG;
	if (!url) {
		logger.info(`DISCORD_WEBHOOK_LOG isn't set; skipping the ${what}.`);
	}
	return url;
}

/** Post the run summary to the log channel and return its message id. It never fails the run. */
export async function sendLog(diff, sources, repoUrl, runUrl) {
	const url = logWebhook('run log');
	const message = url ? buildLogMessage(diff, sources, repoUrl, runUrl) : null;
	const id = message ? await post(url, message) : null;
	if (id) {
		logger.info('Posted the run log.');
	}
	return id;
}

/** The shop run's summary, then its failing or recovered pages: two messages, so together they can't pass Discord's text limit. */
export async function sendShopLog(diff, families, regions, repoUrl, runUrl) {
	const url = logWebhook('shop log');
	if (!url) {
		return;
	}
	for (const message of [buildShopLogMessage(diff, families, regions, repoUrl, runUrl), buildShopAlertMessage(diff.alerts, runUrl)]) {
		if (message && await post(url, message)) {
			logger.info('Posted the shop log.');
		}
	}
}

/** The YouTube run's summary, then its failing or recovered channels. */
export async function sendYoutubeLog(diff, channels, repoUrl, runUrl) {
	const url = logWebhook('YouTube log');
	if (!url) {
		return;
	}
	for (const message of [buildYoutubeLogMessage(diff, channels, repoUrl, runUrl), buildYoutubeAlertMessage(diff.alerts, runUrl)]) {
		if (message && await post(url, message)) {
			logger.info('Posted the YouTube log.');
		}
	}
}

/** True when the new shop families went out. */
export async function sendNewFamilies(slugs, base) {
	const url = logWebhook('new families');
	return Boolean(url && await post(url, buildNewFamiliesMessage(slugs, base)));
}

/** The archive summary and alerts. With logMessage, the tracker run's post, it is added to that post instead, or posted
 * on its own if that fails. It never fails the run. */
export async function sendArchiveLog(diff, sources, repoUrl, runUrl, logMessage = null) {
	const url = logWebhook('archive log');
	const message = url ? buildArchiveLogMessage(diff, sources, repoUrl, runUrl) : null;
	if (!message) {
		return;
	}
	if (logMessage) {
		const existing = await fetchMessage(url, logMessage);
		const merged = existing ? mergeArchiveLog(existing, message) : null;
		if (merged && await editMessage(url, logMessage, merged)) {
			logger.info('Added the archive log to the run log.');
			return;
		}
		logger.warning("Couldn't add the archive log to the run log; posting it on its own.");
	}
	if (await post(url, message)) {
		logger.info('Posted the archive log.');
	}
}
