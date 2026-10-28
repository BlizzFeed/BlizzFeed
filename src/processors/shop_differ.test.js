import test from 'node:test';
import assert from 'node:assert/strict';
import * as sd from './shop_differ.js';

const T0 = '2026-10-09T10:00:00Z';
const T1 = '2026-10-09T10:05:00Z';
const SOON = '2026-10-09T10:20:00Z';
const LATER = '2026-10-10T11:00:00Z';
const NEEDED = 3;

const item = (key = 'a', fields = {}) => ({
	key, kind: 'item', slug: key, itemId: null, destination: `/product/${key}`, title: key.toUpperCase(), description: 'd', image: 'i.png',
	sections: ['Mounts'], badge: null, price: { fullAmount: '9.99', discountAmount: null }, ...fields,
});
const banner = (key = 'b', fields = {}) => ({ ...item(key), kind: 'banner', price: null, headline: 'H', subHeadline: 'S', buttonText: 'Buy', productPageName: null, destination: '/product/x', ...fields });
const STABLE = Array.from({ length: 8 }, (_, n) => item(`z${n}`)); // so one or two items leaving is under the suspicious-drop share
const page = (...items) => Object.fromEntries(items.map((i) => [i.key, i]));
const run = (old, fetched, now = T1, confirm = async () => false, copies) => sd.sweep(old, fetched, now, NEEDED, confirm, copies);
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

test('a priced item still for sale is unlisted, not gone, and rechecked every sweep', async () => {
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
	assert.deepEqual(asked, ['a', 'a']);
	[, changes] = await run(state, page(item('b'), ...STABLE), LATER, async () => false);
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

test('a replaced banner showing again in a stale copy stays gone unless every extra copy shows it', async () => {
	const state = await baseline(item('a'), banner('old', { subHeadline: '6 months' }));
	const swapped = banner('new', { subHeadline: '12 months' });
	const [after] = await run(state, page(item('a'), swapped, ...STABLE));
	const stale = page(item('a'), banner('old', { subHeadline: '6 months' }), ...STABLE);
	const current = page(item('a'), swapped, ...STABLE);
	let [next, changes] = await run(after, stale, SOON, undefined, extra(current, stale, stale));
	assert.deepEqual(changes, []);
	assert.deepEqual([next.items.old.status, next.items.new.status, next.items.new.misses], ['gone', 'listed', 0]);
	[, changes] = await run(after, stale, SOON);
	assert.deepEqual(changes, []); // no copies to ask
	[, changes] = await run(after, stale, SOON, undefined, extra(stale, stale, stale));
	assert.deepEqual(changes.map((c) => [c.key, c.what]), [['old', 'back']]); // Blizzard really put it back
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

/** A copies callback handing out these pages. */
const extra = (...pages) => async (n) => pages.slice(0, n);
const SALE = (id) => ({ fullAmount: '19.99', discountAmount: '9.99', discountId: id });
const NO_SALE = { fullAmount: '19.99', discountAmount: null, discountId: null };
const members = (price, count = 5) => Array.from({ length: count }, (_, n) => item(`s${n}`, { price: price(n) }));

test('the items of a sale campaign post their start as they appear', async () => {
	let state = await baseline(...members(() => NO_SALE));
	let changes;
	[state, changes] = await run(state, page(...members((n) => (n < 2 ? SALE('X') : NO_SALE)), ...STABLE));
	assert.deepEqual(types(changes), ['sale_start', 'sale_start']);
	[state, changes] = await run(state, page(...members((n) => (n < 5 ? SALE('X') : NO_SALE)), ...STABLE), LATER);
	assert.deepEqual(types(changes), ['sale_start', 'sale_start', 'sale_start']);
	assert.deepEqual(state.campaigns.X.members, ['s0', 's1', 's2', 's3', 's4']);
});

test('a few items of a campaign reading no sale are a stale copy', async () => {
	const state = await baseline(...members(() => SALE('X')));
	const [next, changes] = await run(state, page(...members((n) => (n < 2 ? NO_SALE : SALE('X'))), ...STABLE));
	assert.deepEqual(changes, []);
	assert.equal(next.items.s0.price.discountAmount, '9.99');
	assert.equal(next.campaigns.X.status, 'active'); // built from the saved state on the first sweep
});

test('half a campaign reading no sale ends it for every item still posted on sale', async () => {
	const state = await baseline(...members(() => SALE('X')));
	const [next, changes] = await run(state, page(...members((n) => (n < 3 ? NO_SALE : SALE('X'))), ...STABLE));
	assert.deepEqual(changes.map((c) => [c.key, c.type]), ['s0', 's1', 's2', 's3', 's4'].map((key) => [key, 'sale_end']));
	assert.equal(next.items.s4.price.discountAmount, null);
	assert.equal(next.campaigns.X.status, 'ended');
});

test('a closed campaign ID showing again is ignored, a new ID is not, and most of it returning reopens it', async () => {
	let state = await baseline(...members(() => SALE('X')));
	[state] = await run(state, page(...members(() => NO_SALE), ...STABLE));
	let changes;
	[, changes] = await run(state, page(...members((n) => (n < 1 ? SALE('X') : NO_SALE)), ...STABLE), SOON);
	assert.deepEqual(changes, []);
	[, changes] = await run(state, page(...members((n) => (n < 1 ? SALE('Y') : NO_SALE)), ...STABLE), SOON);
	assert.deepEqual(types(changes), ['sale_start']);
	const again = page(...members((n) => (n < 3 ? SALE('X') : NO_SALE)), ...STABLE);
	[, changes] = await run(state, again, SOON);
	assert.deepEqual(changes, []); // one copy isn't enough to reopen it
	[state, changes] = await run(state, again, SOON, undefined, extra(again, again));
	assert.equal(changes.length, 3);
	assert.equal(state.campaigns.X.status, 'active');
});

test('the same ID starting a sale again after the grace is a first change', async () => {
	let state = await baseline(...members(() => SALE('X')));
	[state] = await run(state, page(...members(() => NO_SALE), ...STABLE));
	const [, changes] = await run(state, page(...members((n) => (n < 1 ? SALE('X') : NO_SALE)), ...STABLE), LATER);
	assert.deepEqual(types(changes), ['sale_start']);
});

test('an item reading no sale in a row leaves a running campaign by itself', async () => {
	let state = await baseline(...members(() => SALE('X')));
	let changes;
	for (let n = 1; n <= 3; n++) {
		const gone = page(...members((i) => (i === 0 ? NO_SALE : SALE('X'))), ...STABLE);
		[state, changes] = await run(state, gone, `2026-10-09T10:${String(10 + n).padStart(2, '0')}:00Z`, undefined, extra(gone, gone, gone));
		assert.deepEqual(types(changes), n < 3 ? [] : ['sale_end']);
	}
	assert.equal(state.items.s0.settle.misses, undefined);
});

test('an item back on sale resets the count of sweeps it read no sale', async () => {
	let state = await baseline(...members(() => SALE('X')));
	for (const price of [NO_SALE, NO_SALE, SALE('X'), NO_SALE]) {
		[state] = await run(state, page(...members((i) => (i === 0 ? price : SALE('X'))), ...STABLE));
	}
	assert.equal(state.items.s0.settle.misses, 1);
});

test('an item moving to a new campaign as the old one ends is not ended', async () => {
	const state = await baseline(...members(() => SALE('X')));
	const [, changes] = await run(state, page(...members((n) => (n < 3 ? NO_SALE : n === 3 ? SALE('Y') : SALE('X'))), ...STABLE));
	assert.deepEqual(changes.map((c) => [c.key, c.type]), [['s0', 'sale_end'], ['s1', 'sale_end'], ['s2', 'sale_end'], ['s4', 'sale_end']]);
});

test('a grey-zone share of a campaign is decided by the pooled extra copies', async () => {
	const state = await baseline(...members(() => SALE('X'), 10));
	const ten = (quiet) => page(...members((n) => (n < quiet ? NO_SALE : SALE('X')), 10), ...STABLE);
	let [next, changes] = await run(state, ten(4), T1, undefined, extra(ten(0), ten(0)));
	assert.deepEqual(changes, []); // 4 of 10, then 0 and 0: a stale copy
	assert.equal(next.campaigns.X.status, 'active');
	[next, changes] = await run(state, ten(4), T1, undefined, extra(ten(8), ten(8)));
	assert.equal(changes.length, 10); // 20 of 30 read no sale
	assert.equal(next.campaigns.X.status, 'ended');
	[next, changes] = await run(state, ten(4), T1, undefined, async () => { throw new Error('down'); });
	assert.deepEqual(changes, []); // can't tell
});

test('a quiet run fetches no extra copies', async () => {
	let asked = 0;
	const state = await baseline(...members(() => SALE('X')));
	await run(state, page(...members(() => SALE('X')), ...STABLE), T1, undefined, async () => { asked++; return []; });
	assert.equal(asked, 0);
});

test('a change undoing one posted in the last 30 minutes posts only when every extra copy shows it', async () => {
	let state = await baseline(item('a'));
	let changes;
	const sale = page(item('a', { price: { fullAmount: '9.99', discountAmount: '4.99' } }), ...STABLE);
	const plain = page(item('a'), ...STABLE);
	[state, changes] = await run(state, sale);
	assert.deepEqual(types(changes), ['sale_start']);
	[, changes] = await run(state, plain, T1, undefined, extra(sale, plain, plain));
	assert.deepEqual(changes, []);
	[, changes] = await run(state, plain, T1);
	assert.deepEqual(changes, []); // no copies to ask
	[, changes] = await run(state, plain, T1, undefined, extra(plain, plain, plain));
	assert.deepEqual(types(changes), ['sale_end']);
	[, changes] = await run(state, plain, LATER); // a day on, it is a first change again
	assert.deepEqual(types(changes), ['sale_end']);
});
