import test from 'node:test';
import assert from 'node:assert/strict';
import * as discord from './discord.js';

const REPO = 'https://github.com/BlizzFeed/BlizzFeed';
const ITEM = { id: '42', title: 'Hotfixes', url: 'https://news.blizzard.com/en-gb/article/42', summary: 'Card text.', image: 'https://x/i.png',
	date: '2026-09-30T10:00:00Z', shop_url: 'https://shop.battle.net/p' };
const CHANGE = { id: '42', title: 'Hotfixes', kind: 'text', url: ITEM.url, image: ITEM.image, added: 1, changed: 2, removed: 3, commit: 'abc123', silent: false };
const SOURCES = { 'wow-news': { id: 'wow-news', name: 'WoW' }, 'other': { id: 'other', name: 'Other' } };
const DOWN = { source: 'wow-news', kind: 'down', error: 'boom', since: '2026-09-30T09:00:00Z' };

const inner = (message) => message.components[0].components;
const buttons = (message) => Object.fromEntries(message.components.at(-1).components.find((c) => c.type === 1).components.map((b) => [b.label, b.url]));
const buttonUrls = (message) => message.components.flatMap((c) => c.components.filter((row) => row.type === 1).flatMap((row) => row.components.map((b) => b.url)));

function walk(node, visit) {
	visit(node);
	for (const child of [...node.components ?? [], ...node.accessory ? [node.accessory] : []]) {
		walk(child, visit);
	}
}

function texts(message) {
	const out = [];
	message.components.forEach((c) => walk(c, (node) => node.type === 10 && out.push(node.content)));
	return out.join('\n');
}

const itemMessage = (action, item = ITEM) => discord.buildItemMessage(action, item, `${REPO}/commit/dat`, REPO, {
	summary: discord.summaryUrl(REPO, 'dat', 'wow-news', '42'), archived: discord.archiveUrl(REPO, 'wow-news', '42'), history: discord.historyUrl(REPO, 'wow-news', '42'),
});

test('update and edit messages carry the ids the bot merges by', () => {
	const updated = { ...ITEM, changed: ['title'], previous_title: 'Old' };
	for (const message of [discord.buildItemMessage('updated', updated, `${REPO}/commit/dat`, REPO), discord.buildEditMessage(CHANGE, REPO, 'wow-news', `${REPO}/commit/arc`)]) {
		const ids = new Set();
		message.components.forEach((c) => walk(c, (node) => ids.add(node.id)));
		assert.ok([discord.DIFF_ID, discord.BUTTONS_ID, discord.FOOTER_ID].every((id) => ids.has(id)));
	}
});

test('a new article links its summary and archive, an updated one its card diff', () => {
	assert.deepEqual(buttons(itemMessage('added')), {
		'Read Article': ITEM.url, 'Shop': ITEM.shop_url, 'Summary': `${REPO}/blob/dat/wow-news/items/42.md`,
		'Archive': `${REPO}/blob/archive/wow-news/42.md`, 'History': `${REPO}/commits/archive/wow-news/42.md`,
	});
	assert.deepEqual(buttons(itemMessage('updated')), {
		'Read Article': ITEM.url, 'Shop': ITEM.shop_url, 'Summary Changes': `${REPO}/commit/dat`, 'History': `${REPO}/commits/archive/wow-news/42.md`,
	});
});

test('an edit message lists its line counts, leaving out zeros', () => {
	const message = discord.buildEditMessage(CHANGE, REPO, 'wow-news', `${REPO}/commit/abc123`);
	assert.deepEqual(buttons(message), { 'Read Article': ITEM.url, 'Article Changes': `${REPO}/commit/abc123`, 'History': `${REPO}/commits/archive/wow-news/42.md` });
	assert.ok(texts(message).includes('+ 1 line added\n~ 2 lines changed\n- 3 lines removed'));
	const body = texts(discord.buildEditMessage({ ...CHANGE, added: 8, changed: 0, removed: 0 }, REPO, 'wow-news', null));
	assert.ok(body.includes('+ 8 lines added') && !body.includes('changed') && !body.includes('removed'));
});

test('the game\'s logo is the thumbnail and the article image the large picture, or a before and after pair on an image change', () => {
	const logo = 'https://x/game.png';
	const pictures = (message) => inner(message).filter((c) => c.type === 12).map((c) => c.items.map((i) => i.media.url));
	const changed = discord.buildItemMessage('updated', { ...ITEM, image: 'https://x/new.png', changed: ['image'], previous_image: 'https://x/old.png' }, null, REPO, { logo });
	assert.deepEqual(pictures(changed), [['https://x/old.png', 'https://x/new.png']]);
	assert.equal(inner(changed)[0].accessory.media.url, logo);
	const other = discord.buildItemMessage('updated', { ...ITEM, changed: ['summary'], previous_image: 'https://x/old.png' }, null, REPO, { logo });
	assert.deepEqual(pictures(other), [[ITEM.image]]);
	assert.equal(inner(other)[0].accessory.media.url, logo);
	const bare = discord.buildItemMessage('added', { ...ITEM, image: '' }, null, REPO, { logo });
	assert.deepEqual(pictures(bare), []);
	assert.equal(inner(bare)[0].accessory.media.url, logo);
	assert.deepEqual(pictures(discord.buildEditMessage(CHANGE, REPO, 'wow-news', null, logo)), [[ITEM.image]]);
});

test('an updated card lists what changed', () => {
	const body = texts(discord.buildItemMessage('updated', { ...ITEM, title: 'New', changed: ['title', 'image'], previous_title: 'Old' }, null, REPO));
	assert.ok(body.includes('- Old\n+ New\n+ Image changed'));
});

test('a title is cut by code point, so an emoji is never split', () => {
	assert.equal(discord.trim('ab🟢cd', 4), 'ab🟢…');
	assert.equal(discord.trim('ab🟢', 3), 'ab🟢');
});

const archiveDiff = (articles, alerts = []) => ({ sweep: true, alerts, sources: { 'wow-news': { articles, gone: [], failed: 0 }, 'other': { articles: [], gone: [], failed: 0 } } });

test('the archive log lists changes and silent edits, or is skipped when nothing changed', () => {
	const articles = [CHANGE, { ...CHANGE, id: '7', title: 'New', kind: 'archived', commit: 'def' }, { ...CHANGE, id: '8', title: 'Quiet', silent: true, commit: 'eee' }];
	const body = texts(discord.buildArchiveLogMessage(archiveDiff(articles), SOURCES, REPO, 'https://run'));
	assert.ok(body.includes('1 of 2 sources changed') && body.includes('2 text edited') && body.includes('1 archived'));
	assert.ok(body.includes(`[Hotfixes](${REPO}/commit/abc123)\n  -# +1 ~2 −3`));
	assert.ok(body.includes('silent edit (date unchanged)'));
	assert.equal(discord.buildArchiveLogMessage(archiveDiff([]), SOURCES, REPO, null), null);
	assert.ok(texts(discord.buildArchiveLogMessage(archiveDiff([], [DOWN]), SOURCES, REPO, null)).includes('WoW - archive failing'));
});

test('a long archive log is cut between lines, not inside a link', () => {
	const articles = Array.from({ length: 30 }, (_, i) => ({ ...CHANGE, id: String(i), title: `A rather long article title number ${i}`, kind: 'archived', commit: String(i).padStart(40, '0') }));
	const body = texts(discord.buildArchiveLogMessage(archiveDiff(articles), SOURCES, REPO, null));
	const lines = body.split('\n').filter((line) => line.startsWith('- '));
	assert.ok(lines.length && lines.every((line) => line.endsWith(')')));
	assert.ok(body.includes(`-# …and ${30 - lines.length} more`));
});

function trackerLog() {
	const entry = { baseline: false, items: 5, added: [{ title: 'Patch', url: 'https://x/patch' }], updated: [], quiet: 0, commit: 'aaa' };
	return discord.buildLogMessage({ alerts: [], sources: { 'wow-news': entry, 'other': { ...entry, added: [] } } }, SOURCES, REPO, 'https://run/data');
}

/** A fetched message: the same components, each with an id. */
function readBack(message) {
	let next = 1;
	const addIds = (node) => {
		if (Array.isArray(node)) {
			return node.map(addIds);
		}
		if (node && typeof node === 'object') {
			return { ...Object.fromEntries(Object.entries(node).map(([k, v]) => [k, addIds(v)])), id: next++ };
		}
		return node;
	};
	return { components: addIds(message.components) };
}

test('the archive log is folded into the tracker post, before the unchanged count', () => {
	const archive = discord.buildArchiveLogMessage(archiveDiff([{ ...CHANGE, kind: 'archived' }]), SOURCES, REPO, 'https://run/archive');
	const merged = discord.mergeArchiveLog(readBack(trackerLog()), archive);
	assert.equal(merged.components.length, 1);
	const body = texts(merged);
	assert.ok(body.indexOf('Patch') < body.indexOf(`${REPO}/commit/abc123`) && body.indexOf(`${REPO}/commit/abc123`) < body.indexOf('Unchanged'));
	assert.deepEqual(buttonUrls(merged), ['https://run/data', 'https://run/archive']);
	assert.ok(!merged.components[0].components.some((c) => 'id' in c));
});

test('archive alerts stay their own container when folded', () => {
	const merged = discord.mergeArchiveLog(readBack(trackerLog()), discord.buildArchiveLogMessage(archiveDiff([CHANGE], [DOWN]), SOURCES, REPO, 'https://run/archive'));
	assert.equal(merged.components.length, 2);
	assert.ok(texts({ components: merged.components.slice(1) }).includes('archive failing'));
	const alone = discord.mergeArchiveLog(readBack(trackerLog()), discord.buildArchiveLogMessage(archiveDiff([], [DOWN]), SOURCES, REPO, null));
	assert.equal(alone.components.length, 2);
	assert.deepEqual(buttonUrls(alone), ['https://run/data']);
});

test('the archive log is not folded into something else, or when the post would get too long', () => {
	const archive = discord.buildArchiveLogMessage(archiveDiff([CHANGE]), SOURCES, REPO, 'https://run/archive');
	const folded = discord.mergeArchiveLog(readBack(trackerLog()), archive);
	assert.equal(discord.mergeArchiveLog(readBack(folded), archive), null); // already has its archive part
	assert.equal(discord.mergeArchiveLog({ components: [] }, archive), null);
	assert.equal(discord.mergeArchiveLog(readBack(archive), archive), null); // not a tracker post
	const many = Array.from({ length: 30 }, (_, i) => ({ ...CHANGE, kind: 'archived', id: String(i), title: `Article number ${i}` }));
	const tracker = trackerLog();
	tracker.components[0].components[2].content += 'x'.repeat(1500);
	assert.equal(discord.mergeArchiveLog(readBack(tracker), discord.buildArchiveLogMessage(archiveDiff(many), SOURCES, REPO, 'https://run/archive')), null);
});

test('shop alerts for a whole region stay in one message within the text limit', () => {
	const down = Array.from({ length: 13 }, (_, n) => ({ source: `eu/family-${n}`, kind: 'down', error: 'x'.repeat(300), since: '2026-09-30T09:00:00Z' }));
	const message = discord.buildShopAlertMessage(down, 'https://run');
	const body = texts(message);
	assert.ok(message.components.length === 1 && body.length <= discord.LOG_TOTAL_TEXT && body.includes('more'));
});

const SHOP_FAMILIES = { overwatch: { name: 'Overwatch' }, hearthstone: { name: 'Hearthstone' } };
const SHOP_REGIONS = { eu: 'https://eu.shop.battle.net/en-gb', us: 'https://us.shop.battle.net/en-us' };
const shopChange = (type, fields = {}) => ({ type, key: 'k', kind: 'item', slug: 's', title: 'Shadow Monarch', destination: '/product/s', seen: '2026-10-09T10:00:00Z', ...fields });
const shopLog = (families) => discord.buildShopLogMessage({ families, alerts: [] }, SHOP_FAMILIES, SHOP_REGIONS, REPO, null);

test('the shop log links each change to its own region\'s page and counts unchanged pages', () => {
	const body = texts(shopLog({ 'us/overwatch': { baseline: false, commit: 'abc', changes: [shopChange('sale_start')] } }));
	assert.ok(body.includes('[Shadow Monarch](https://us.shop.battle.net/en-us/product/s)'));
	assert.ok(body.includes(`[Overwatch · US](${REPO}/commit/abc)`));
	assert.ok(body.includes('Unchanged: 3 shop pages'));
	const banner = shopChange('banner', { kind: 'banner', what: 'added', button: 'Buy Now', product: 'The Bundle' });
	const gear = shopChange('details', { title: 'Gear', destination: 'https://gear.blizzard.com/x', changed: ['title'] });
	const other = texts(shopLog({ 'eu/overwatch': { baseline: false, changes: [banner, gear] } }));
	assert.ok(other.includes('[Buy Now · The Bundle]') && other.includes('(https://gear.blizzard.com/x)'));
	const buttonless = texts(shopLog({ 'eu/overwatch': { baseline: false, changes: [{ ...banner, button: null }] } }));
	assert.ok(buttonless.includes('[The Bundle]'));
	assert.equal(shopLog({ 'eu/overwatch': { baseline: false, changes: [] } }), null);
});

const YOUTUBE_CHANNELS = { Warcraft: { name: 'World of Warcraft' }, Blizzard: { name: 'Blizzard' } };
const youtubeLog = (channels) => discord.buildYoutubeLogMessage({ channels, alerts: [] }, YOUTUBE_CHANNELS, REPO, null);

test('the YouTube log links each change to its video and counts unchanged channels', () => {
	const fresh = { type: 'new', id: 'abc', kind: 'stream', title: 'Live [now]', live: 'upcoming' };
	const edit = { type: 'edited', id: 'x', kind: 'video', title: 'T', fields: { title: {}, description: {} } };
	const body = texts(youtubeLog({ Warcraft: { baseline: false, commit: 'abc', changes: [fresh, edit] }, Blizzard: { baseline: false, changes: [] } }));
	assert.ok(body.includes('[Live (now)](https://www.youtube.com/watch?v=abc)'));
	assert.ok(body.includes(`[World of Warcraft](${REPO}/commit/abc)`) && body.includes('title and description edited'));
	assert.ok(body.includes('Unchanged: 1 channel'));
	assert.equal(youtubeLog({ Warcraft: { baseline: false, changes: [] } }), null);
});
