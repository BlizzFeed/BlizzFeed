import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as archiver from './archiver.js';

const NOW = new Date('2026-09-30T12:00:00Z');
const CFG = { window_days: 7, baseline_days: 30, max_fetches: 60 };
const item = (id, date) => ({ id, date, title: 'T', url: 'u', image: '', summary: 's' });
const ids = (plan) => plan.map(([i, reason]) => [i.id, reason]);

test('a changed date is fetched whatever its age, an unchanged one is skipped without a sweep', () => {
	assert.deepEqual(ids(archiver.plan([item('old', '2020-01-01T00:00:00Z')], { old: '2019-12-31T00:00:00Z' }, NOW, CFG, false)), [['old', 'changed']]);
	assert.deepEqual(archiver.plan([item('a', '2026-09-29T00:00:00Z')], { a: '2026-09-29T00:00:00Z' }, NOW, CFG, false), []);
});

test('an article the archive never saw is only fetched within baseline_days', () => {
	const items = [item('new', '2026-09-10T00:00:00Z'), item('ancient', '2026-08-01T00:00:00Z')];
	assert.deepEqual(ids(archiver.plan(items, {}, NOW, CFG, false)), [['new', 'changed']]);
});

test('a sweep adds recent unchanged articles, once', () => {
	const items = [item('recent', '2026-09-28T00:00:00Z'), item('stale', '2026-09-01T00:00:00Z'), item('edited', '2026-09-29T00:00:00Z')];
	const index = { recent: '2026-09-28T00:00:00Z', stale: '2026-09-01T00:00:00Z', edited: '2026-09-20T00:00:00Z' };
	assert.deepEqual(ids(archiver.plan(items, index, NOW, CFG, true)), [['edited', 'changed'], ['recent', 'sweep']]);
});

test('select puts changed first, newest first, and caps', () => {
	const candidates = [['s', item('sweep-new', '2026-09-29T00:00:00Z'), 'sweep'], ['s', item('changed-old', '2026-09-01T00:00:00Z'), 'changed'], ['s', item('changed-new', '2026-09-28T00:00:00Z'), 'changed']];
	assert.deepEqual(archiver.select(candidates, 2).map((c) => c[1].id), ['changed-new', 'changed-old']);
});

test('sweepDue', () => {
	assert.equal(archiver.sweepDue({}, 55, NOW), true);
	assert.equal(archiver.sweepDue({ last_sweep: '2026-09-30T11:30:00Z' }, 55, NOW), false);
	assert.equal(archiver.sweepDue({ last_sweep: '2026-09-30T11:05:00Z' }, 55, NOW), true);
});

test('classify and lineChanges', () => {
	const old = archiver.renderFile(item('1', 'd'), 'a\nb\nc\n');
	const newCard = archiver.renderFile({ ...item('1', 'd'), title: 'Other' }, 'a\nb\nc\n');
	const edited = archiver.renderFile(item('1', 'd'), 'a\nB\nc\nd\n');
	assert.equal(archiver.classify(null, old), 'archived');
	assert.equal(archiver.classify(old, old), null);
	assert.equal(archiver.classify(old, newCard), 'card');
	assert.equal(archiver.classify(old, edited), 'text');
	assert.deepEqual(archiver.lineChanges(archiver.splitFile(old)[1], archiver.splitFile(edited)[1]), [1, 1, 0]);
	assert.deepEqual(archiver.lineChanges('a\nb\nc\nd\n', 'a\nX\n'), [0, 1, 2]); // 3 lines became 1: one changed, two removed
});

test('the file layout, and a summary with newlines can\'t break the card split', () => {
	const item1 = { title: 'Hotfixes', url: 'https://news.blizzard.com/en-gb/article/1', image: 'https://x/i.jpg', summary: 'Card.' };
	assert.equal(archiver.renderFile(item1, 'Body.\n'), '# Hotfixes\n\n- URL: https://news.blizzard.com/en-gb/article/1\n![](https://x/i.jpg)\n\n> Card.\n\n---\n\nBody.\n');
	assert.equal(archiver.splitFile(archiver.renderFile({ ...item('1', 'd'), summary: 'one\n\n---\n\ntwo' }, 'Body.\n'))[1], 'Body.\n');
});

test('the shop link is the first item link, and never the shop home page', () => {
	const text = '[Shop](https://shop.battle.net/) [Get the Collection](https://shop.battle.net/family/wow/items/1)\n[Pack](https://shop.battle.net/family/wow/items/2)';
	assert.equal(archiver.findShopUrl(text), 'https://shop.battle.net/family/wow/items/1');
	assert.equal(archiver.findShopUrl('[Shop](https://shop.battle.net/) and https://example.com'), '');
});

test('fillShopUrls uses the saved text, and leaves an existing link alone', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-'));
	t.after(() => fs.rmSync(dir, { recursive: true }));
	const shop = 'https://shop.battle.net/family/world-of-warcraft/items/1';
	const texts = { 1: `See [the shop](https://shop.battle.net/) and [it](${shop})\n`, 2: 'No link\n', 3: `[it](${shop})\n` };
	for (const [id, text] of Object.entries(texts)) {
		archiver.writeArticle(dir, 's', id, archiver.renderFile({ id, title: 'T', url: 'u', image: '', summary: 's' }, text));
	}
	const items = [{ id: '1' }, { id: '2' }, { id: '3', shop_url: 'card' }, { id: '4' }]; // 4 was never archived
	assert.equal(archiver.fillShopUrls(dir, items, 's'), 1);
	assert.deepEqual(items.map((i) => i.shop_url), [shop, undefined, 'card', undefined]);
});
