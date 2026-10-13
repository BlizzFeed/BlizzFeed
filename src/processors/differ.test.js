import test from 'node:test';
import assert from 'node:assert/strict';
import * as differ from './differ.js';

const OLD = { id: '1', title: 'Old', summary: 'S', image: 'i.png', date: 'd', url: 'u' };

test('changedFields lists only what differs', () => {
	assert.deepEqual(differ.changedFields(OLD, { ...OLD, title: 'New', image: 'j.png', date: 'd2' }), ['title', 'image']);
});

test('a date-only change is quiet, not updated', () => {
	const [added, updated, quiet] = differ.compute([OLD], [{ ...OLD, date: 'd2' }]);
	assert.deepEqual([added, updated, quiet.length], [[], [], 1]);
});

test('new shop links are an added or changed link, but not on a first run', () => {
	const old = [{ ...OLD, shop_url: 'a' }, { ...OLD, id: '2' }];
	const items = [{ ...OLD, shop_url: 'a' }, { ...OLD, id: '2', shop_url: 'b' }, { ...OLD, id: '3', shop_url: 'c' }, { ...OLD, id: '4' }];
	assert.deepEqual(differ.newShopLinks(old, items).map((i) => i.id), ['2', '3']);
	assert.deepEqual(differ.newShopLinks(null, items), []);
});

test('a saved shop link survives a feed card without one, but a card link wins', () => {
	const old = [{ ...OLD, shop_url: 'saved' }, { ...OLD, id: '2', shop_url: 'saved' }, { ...OLD, id: '3' }];
	const items = [{ ...OLD }, { ...OLD, id: '2', shop_url: 'card' }, { ...OLD, id: '3' }, { ...OLD, id: '4' }];
	differ.keepShopUrls(old, items);
	assert.deepEqual(items.map((i) => i.shop_url), ['saved', 'card', undefined, undefined]);
	assert.deepEqual(differ.compute(old, [{ ...OLD, shop_url: 'saved' }]), [[], [], []]);
});

test('an old copy served right after an edit keeps the edit, and a revert counts once the window has passed', () => {
	const run = (state, summary, now) => {
		const items = differ.settle(state, [{ ...OLD, summary }], now);
		return [differ.compute(state, items)[1].length, differ.merge(state, items)];
	};
	let [posted, state] = run([OLD], 'Fixed', '2026-10-13T16:36:00Z');
	assert.equal(posted, 1);
	[posted, state] = run(state, 'S', '2026-10-13T16:37:00Z'); // the old copy again
	assert.deepEqual([posted, state[0].summary], [0, 'Fixed']);
	[posted, state] = run(state, 'S', '2026-10-13T17:10:00Z');
	assert.deepEqual([posted, state[0].summary], [1, 'S']);
});
