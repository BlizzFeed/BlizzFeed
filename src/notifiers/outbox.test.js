import test from 'node:test';
import assert from 'node:assert/strict';
import { Source } from '../core/config.js';
import * as outbox from './outbox.js';

const REPO = 'https://github.com/BlizzFeed/BlizzFeed';
const IDS = { DIABLO4: { all: 'd4', new: 'd4n', updated: 'd4u' }, DIABLO: { all: 'd', new: 'dn', updated: 'du' } };
const ITEM = { id: '42', title: 'Hotfixes', url: 'https://x/42', summary: 's', image: null, date: '2026-09-30T10:00:00Z' };

const source = (labels, ids = IDS) => ({ d4: new Source({ id: 'd4', name: 'Diablo IV News', type: 'json', url: 'https://x/en-gb/f', channels: labels }, {}, ids) });
const channels = (entries) => entries.map((e) => e.channel).sort();
const trackerDiff = ({ added = [], updated = [] }) => ({ sources: { d4: { added, updated, quiet: 0 } } });

test('a new article goes to all and new of every label, an update or edit to all and updated', () => {
	const sources = source(['DIABLO4', 'DIABLO']);
	assert.deepEqual(channels(outbox.buildTrackerEntries(trackerDiff({ added: [ITEM] }), sources, REPO, 't')), ['d', 'd4', 'd4n', 'dn']);
	const updated = outbox.buildTrackerEntries(trackerDiff({ updated: [ITEM] }), sources, REPO, 't');
	const edited = outbox.buildArchiveEntries({ sources: { d4: { articles: [{ ...ITEM, kind: 'text', added: 1, removed: 1 }] } } }, sources, REPO, 't');
	assert.deepEqual(channels(updated), ['d', 'd4', 'd4u', 'du']);
	assert.deepEqual(channels(edited), channels(updated));
	assert.ok(edited.every((e) => e.kind === 'edited'));
});

test('missing ids are skipped, and other archive kinds are not posted', () => {
	const sources = source(['DIABLO4', 'WOW'], { DIABLO4: { all: 'd4' } });
	assert.deepEqual(channels(outbox.buildTrackerEntries(trackerDiff({ added: [ITEM] }), sources, REPO, 't')), ['d4']);
	assert.deepEqual(outbox.buildArchiveEntries({ sources: { d4: { articles: [{ ...ITEM, kind: 'card' }] } } }, sources, REPO, 't'), []);
});

function shopPost(kind, edit = false) {
	const change = { type: kind, title: 'T', destination: '/x', key: 'c-1', slug: 's', seen: 't', commit: 'abc', from: '1', to: '2' };
	return { destination: ['feed', 'ow'], game: 'ow', kind: 'single', type: kind, edit, events: [{ type: kind, family: 'overwatch', key: 'c-1', slug: 's', changes: { eu: change } }] };
}

const SHOP_SOURCES = { ow: { name: 'Overwatch', logo: null, tierChannels: { all: ['1'], new: ['2'], updated: ['3'] } } };
const shopEntries = (post) => outbox.buildShopEntries([post], {}, SHOP_SOURCES, '9', null, '2026-10-10T10:00:00Z');

test('a new shop item goes to all and new, a change to all and updated, and an edit carries its ref', () => {
	assert.deepEqual(shopEntries(shopPost('new')).map((e) => e.channel), ['1', '2']);
	assert.deepEqual(shopEntries(shopPost('price')).map((e) => e.channel), ['1', '3']);
	const edits = shopEntries(shopPost('price', true));
	assert.ok(edits.every((e) => e.ref === 'overwatch:price:c-1' && e.edit));
});
