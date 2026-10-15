import test from 'node:test';
import assert from 'node:assert/strict';
import * as sd from './shop_differ.js';

const T0 = '2026-10-09T10:00:00Z';
const T1 = '2026-10-09T10:05:00Z';
const LATER = '2026-10-10T11:00:00Z';
const NEEDED = 3;

const item = (key = 'a', fields = {}) => ({
	key, kind: 'item', slug: key, itemId: null, destination: `/product/${key}`, title: key.toUpperCase(), description: 'd', image: 'i.png',
	sections: ['Mounts'], badge: null, price: { fullAmount: '9.99', discountAmount: null }, ...fields,
});
const banner = (key = 'b', fields = {}) => ({ ...item(key), kind: 'banner', price: null, headline: 'H', subHeadline: 'S', buttonText: 'Buy', productPageName: null, destination: '/product/x', ...fields });
const STABLE = Array.from({ length: 8 }, (_, n) => item(`z${n}`)); // so one or two items leaving is under the suspicious-drop share
const page = (...items) => Object.fromEntries(items.map((i) => [i.key, i]));
const run = (old, fetched, now = T1, confirm = async () => false) => sd.sweep(old, fetched, now, NEEDED, confirm);
const baseline = async (...items) => (await run(null, page(...items, ...STABLE), T0))[0];
const types = (changes) => changes.map((c) => c.type);

/** Sweeps in which every item but `others` is absent from the page. */
async function missingSweeps(start, sweeps, confirm = async () => false, others = []) {
	let state = start;
	const changes = [];
	for (let n = 0; n < sweeps; n++) {
		let found;
		[state, found] = await run(state, page(...others, ...STABLE), `2026-10-09T10:${String(10 + n).padStart(2, '0')}:00Z`, confirm);
		changes.push(...found);
	}
	return [state, changes];
}

test('a first run records everything and reports nothing', async () => {
	const [state, changes] = await run(null, page(item('a'), banner()));
	assert.deepEqual(changes, []);
	assert.deepEqual(Object.keys(state.items).sort(), ['a', 'b']);
});

test('an unchanged page changes nothing in the state', async () => {
	const state = await baseline(item('a'), banner());
	const [again, changes] = await run(state, page(item('a'), banner(), ...STABLE));
	assert.deepEqual(changes, []);
	assert.deepEqual(again, state); // so no commit every sweep
});

test('a key never seen is new, and one seen to go is back', async () => {
	let state = await baseline(item('a'));
	let changes;
	[state, changes] = await run(state, page(item('a'), item('c'), ...STABLE));
	assert.deepEqual(types(changes), ['new']);
	[state] = await missingSweeps(state, NEEDED, undefined, [item('a')]);
	assert.equal(state.items.c.status, 'gone');
	[state, changes] = await run(state, page(item('a'), item('c'), ...STABLE), LATER);
	assert.deepEqual(types(changes), ['back']);
	assert.equal(state.items.c.status, 'listed');
});

test('price, sale, badge and details changes', async () => {
	let state = await baseline(item('a'));
	let changes;
	[state, changes] = await run(state, page(item('a', { price: { fullAmount: '19.99', discountAmount: '4.99' }, badge: 'New', title: 'Renamed' }), ...STABLE));
	assert.deepEqual(types(changes), ['price', 'sale_start', 'badge', 'details']);
	assert.equal(changes[2].maybe_new, true);
	assert.deepEqual(changes[3].changed, ['title']);
	[, changes] = await run(state, page(item('a', { price: { fullAmount: '19.99', discountAmount: null }, badge: 'New', title: 'Renamed' }), ...STABLE));
	assert.deepEqual(types(changes), ['sale_end']);
});

test('a sale ending at its own price is marked, so the price change isn\'t announced', async () => {
	const state = await baseline(item('a', { price: { fullAmount: '26.00', discountAmount: '24.00' } }));
	let [, changes] = await run(state, page(item('a', { price: { fullAmount: '24.00', discountAmount: null } }), ...STABLE));
	assert.deepEqual(types(changes), ['price', 'sale_end']);
	assert.ok(changes.every((c) => c.sale_kept));
	[, changes] = await run(state, page(item('a', { price: { fullAmount: '20.00', discountAmount: null } }), ...STABLE));
	assert.ok(!changes.some((c) => c.sale_kept));
});

test('a details change keeps the old and new values', async () => {
	const [, changes] = await run(await baseline(item('a')), page(item('a', { title: 'Renamed', sections: ['Mounts', 'Featured'] }), ...STABLE));
	assert.deepEqual(changes[0].from, { title: 'A', sections: ['Mounts'] });
	assert.deepEqual(changes[0].to, { title: 'Renamed', sections: ['Mounts', 'Featured'] });
});

test('a banner\'s product is its own name, else the card it links to', async () => {
	const named = banner('n', { productPageName: 'Forever', slug: 'forever' });
	const unnamed = banner('u', { slug: 'card-slug', itemId: 7 });
	const card = item('c', { slug: 'card-slug', itemId: 7, title: 'The Card' });
	const [, changes] = await run(await baseline(item('a')), page(item('a'), named, unnamed, card, ...STABLE));
	assert.deepEqual(Object.fromEntries(changes.filter((c) => c.type === 'banner').map((c) => [c.key, c.product])), { n: 'Forever', u: 'The Card' });
});

test('banners report added and changed, never price or details', async () => {
	let [state, changes] = await run(await baseline(item('a')), page(item('a'), banner(), ...STABLE));
	assert.deepEqual(changes.map((c) => [c.type, c.what]), [['banner', 'added']]);
	[, changes] = await run(state, page(item('a'), banner('b', { headline: 'Other', title: 'Other' }), ...STABLE));
	assert.deepEqual(types(changes), ['banner']);
	assert.deepEqual(changes[0].changed, ['headline']);
});

test('an item is only gone after enough missed sweeps, and returning before that resets the count', async () => {
	let [state, changes] = await missingSweeps(await baseline(item('a'), item('b')), NEEDED - 1, undefined, [item('b')]);
	assert.deepEqual(changes, []);
	assert.equal(state.items.a.status, 'missing');
	const [back, none] = await run(state, page(item('a'), item('b'), ...STABLE));
	assert.deepEqual(none, []);
	assert.equal(back.items.a.misses, 0);
	[, changes] = await missingSweeps(state, 1, undefined, [item('b')]);
	assert.deepEqual(types(changes), ['gone']);
});

test('a priced item still for sale is unlisted, not gone, and rechecked daily', async () => {
	const asked = [];
	const confirm = async (i) => {
		asked.push(i.key);
		return true;
	};
	let [state, changes] = await missingSweeps(await baseline(item('a'), item('b')), NEEDED, confirm, [item('b')]);
	assert.deepEqual(types(changes), ['unlisted']);
	assert.deepEqual(asked, ['a']);
	[state, changes] = await run(state, page(item('b'), ...STABLE), '2026-10-09T20:00:00Z', confirm);
	assert.deepEqual(changes, []);
	assert.deepEqual(asked, ['a']); // checked less than a day ago
	[, changes] = await run(state, page(item('b'), ...STABLE), LATER);
	assert.deepEqual(types(changes), ['gone']);
});

test('an unlisted item back on the page is listed again, silently', async () => {
	const [state] = await missingSweeps(await baseline(item('a'), item('b')), NEEDED, async () => true, [item('b')]);
	const [back, changes] = await run(state, page(item('a'), item('b'), ...STABLE));
	assert.deepEqual(changes, []);
	assert.equal(back.items.a.status, 'listed');
});

test('free items and banners are gone without asking the item page, and a banner leaving is a removed banner', async () => {
	const confirm = async () => {
		throw new Error('asked');
	};
	const state = await baseline(item('f', { price: { fullAmount: null, raw: 0 } }), banner(), item('c'));
	const [after, changes] = await missingSweeps(state, NEEDED, confirm, [item('c')]);
	assert.deepEqual(changes.map((c) => [c.type, c.what]), [['gone', undefined], ['banner', 'removed']]);
	assert.equal(after.items.b.status, 'gone');
});

test('a new banner for a missing banner\'s product replaces it as one change', async () => {
	const state = await baseline(item('a'), banner('old', { subHeadline: '6 months', image: 'old.png' }), banner('other', { destination: '/product/y' }));
	const swapped = banner('new', { subHeadline: '12 months', image: 'new.png' });
	const [after, changes] = await run(state, page(item('a'), swapped, banner('other', { destination: '/product/y' }), ...STABLE));
	assert.deepEqual(changes.map((c) => [c.type, c.what, c.key, c.replaced, c.changed]), [['banner', 'changed', 'new', 'old', ['subHeadline', 'image']]]);
	assert.equal(after.items.old.status, 'gone');
	const [, later] = await missingSweeps(after, NEEDED, undefined, [item('a'), swapped, banner('other', { destination: '/product/y' })]);
	assert.deepEqual(later, []); // the old one is not reported again
});

test('a failed check is retried next sweep instead of deciding', async () => {
	const broken = async () => {
		throw new Error('network');
	};
	const [state, changes] = await missingSweeps(await baseline(item('a'), item('b')), NEEDED + 1, broken, [item('b')]);
	assert.deepEqual(changes, []);
	assert.equal(state.items.a.status, 'missing');
	const [, later] = await run(state, page(item('b'), ...STABLE));
	assert.deepEqual(types(later), ['gone']);
});

test('a big drop is held once and believed when the next fetch agrees, or forgotten when it recovers', async () => {
	const keep = [item('k')];
	const drop = [0, 1, 2].map((n) => item(`d${n}`));
	const state = await baseline(...keep, ...drop);
	const [held, changes] = await run(state, page(...keep));
	assert.deepEqual(changes, []);
	assert.equal(held.suspect, true);
	assert.deepEqual(held.items, state.items);
	const [believed] = await run(held, page(...keep));
	assert.equal(believed.suspect, false);
	assert.equal(believed.items.d0.misses, 1);
	const [recovered, none] = await run(held, page(...keep, ...drop));
	assert.deepEqual(none, []);
	assert.equal(recovered.suspect, false);
	assert.equal(recovered.items.d0.misses, 0);
});

test('a product-only item that gains a card is the same item', async () => {
	let [state, changes] = await run(await baseline(item('p:5', { itemId: 5, title: 'X' })), page(item('blt1', { itemId: 5, title: 'X' }), ...STABLE));
	assert.deepEqual(changes, []);
	assert.equal('p:5' in state.items, false);
	assert.equal(state.items.blt1.first_seen, T0);
	[state, changes] = await run(state, page(item('blt1', { itemId: 5, title: 'X', price: { fullAmount: '7.99', discountAmount: null } }), ...STABLE));
	assert.deepEqual(types(changes), ['price']);
});

test('a new shop family is reported once, and the first check reports nothing', () => {
	let [fresh, meta] = sd.familyCheck({}, ['a', 'b', 'c'], ['a'], T0);
	assert.deepEqual(fresh, []);
	[fresh, meta] = sd.familyCheck(meta, ['a', 'b', 'c', 'd'], ['a'], T1);
	assert.deepEqual(fresh, ['d']);
	assert.deepEqual(sd.familyCheck(meta, ['a', 'b', 'c', 'd'], ['a'], LATER)[0], []);
});
