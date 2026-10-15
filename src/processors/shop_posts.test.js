import test from 'node:test';
import assert from 'node:assert/strict';
import * as sp from './shop_posts.js';

const FAMILIES = { 'world-of-warcraft': { sources: ['wow-news', 'wow-news-us'] }, 'overwatch': { sources: ['overwatch-news'] } };
const NOW = '2026-10-10T10:00:00+00:00';

const change = ({ kind = 'new', key = 'c-1', slug = 'thing' } = {}) => ({ type: kind, key, slug, seen: NOW });
const fresh = (region, { family = 'overwatch', ...rest } = {}) => [region, family, change(rest)];
const event = (kind, regions, { family = 'overwatch', key = 'c-1' } = {}) => ({ type: kind, family, key, slug: 's', seen: NOW, changes: Object.fromEntries(regions.map((r) => [r, change({ kind, key })])) });
const itemEvent = (kind, extra = {}) => ({ type: kind, family: 'overwatch', key: 'c-1', slug: 's', seen: NOW, changes: { eu: { ...change({ kind }), ...extra } } });
const SHOP = JSON.stringify(['shop', null]);
const shape = (posts) => posts.map((p) => [p.destination, p.events.map((e) => e.type)]);

test('one item\'s changes in a run are one post per destination', () => {
	const posts = sp.plan([itemEvent('sale_end'), itemEvent('price')], FAMILIES);
	const shop = posts.filter((p) => JSON.stringify(p.destination) === SHOP);
	assert.equal(shop.length, 1);
	assert.deepEqual(shop[0].events.map((e) => e.type), ['price', 'sale_end']);
	assert.deepEqual(posts.filter((p) => p.destination[0] === 'feed').map((p) => p.events.map((e) => e.type)), [['price']]); // sale_end isn't a feed type
});

test('a sale that became the regular price goes to the shop channel as a sale end only', () => {
	const posts = sp.plan([itemEvent('price', { sale_kept: true }), itemEvent('sale_end', { sale_kept: true })], FAMILIES);
	assert.deepEqual(shape(posts), [[['shop', null], ['sale_end']]]);
});

test('the same sweep in both regions is one event', () => {
	const [events] = sp.resolve([], [fresh('eu'), fresh('us')], NOW);
	assert.equal(events.length, 1);
	assert.deepEqual(Object.keys(events[0].changes), ['eu', 'us']);
	assert.equal('was' in events[0], false);
});

test('the other region arriving later edits the earlier post', () => {
	let [events, ledger] = sp.resolve([], [fresh('eu')], NOW);
	ledger = sp.remember(ledger, sp.plan(events, FAMILIES), NOW);
	assert.deepEqual(ledger.map((e) => Object.keys(e.changes)), [['eu']]);
	[events, ledger] = sp.resolve(ledger, [fresh('us')], '2026-10-10T10:10:00+00:00');
	assert.deepEqual(ledger.map((e) => [e.paired, Object.keys(e.changes).sort()]), [[true, ['eu', 'us']]]);
	assert.deepEqual(events[0].was, ['eu']);
	assert.deepEqual(Object.keys(events[0].changes).sort(), ['eu', 'us']);
	assert.ok(sp.plan(events, FAMILIES).every((p) => p.edit));
});

test('a late other region is a new event', () => {
	let [events, ledger] = sp.resolve([], [fresh('eu')], NOW);
	ledger = sp.remember(ledger, sp.plan(events, FAMILIES), NOW);
	[events] = sp.resolve(ledger, [fresh('us')], '2026-10-10T11:00:00+00:00');
	assert.equal('was' in events[0], false);
	assert.deepEqual(Object.keys(events[0].changes), ['us']);
});

test('WoW edits the EU feed and posts new to the US feed', () => {
	let [events, ledger] = sp.resolve([], [fresh('eu', { family: 'world-of-warcraft', kind: 'price' })], NOW);
	ledger = sp.remember(ledger, sp.plan(events, FAMILIES), NOW);
	[events] = sp.resolve(ledger, [fresh('us', { family: 'world-of-warcraft', kind: 'price' })], NOW);
	assert.deepEqual(sp.plan(events, FAMILIES).map((p) => [p.destination, p.edit]), [[['feed', 'wow-news'], true], [['feed', 'wow-news-us'], false], [['shop', null], true]]);
});

test('different keys pair by a unique slug only', () => {
	assert.equal(sp.resolve([], [fresh('eu', { key: 'c-1', slug: 'a' }), fresh('us', { key: 'c-2', slug: 'a' })], NOW)[0].length, 1);
	const shared = [fresh('eu', { key: 'c-1', slug: 'a' }), fresh('eu', { key: 'c-3', slug: 'a' }), fresh('us', { key: 'c-2', slug: 'a' })];
	assert.equal(sp.resolve([], shared, NOW)[0].length, 3); // the slug is shared, so it can't tell which one is meant
});

test('other types and families do not pair', () => {
	const [events] = sp.resolve([], [fresh('eu', { kind: 'price' }), fresh('us', { kind: 'new' }), fresh('eu', { family: 'world-of-warcraft' }), fresh('us')], NOW);
	assert.equal(events.length, 4);
});

test('the same change on two families\' pages is posted once per destination, also when the other family follows later', () => {
	const classic = { ...FAMILIES, 'world-of-warcraft-classic': { sources: ['wow-news', 'wow-news-us'] } };
	const both = [fresh('eu', { family: 'world-of-warcraft', kind: 'banner', key: 'b-1' }), fresh('eu', { family: 'world-of-warcraft-classic', kind: 'banner', key: 'b-1' })];
	let [events, ledger] = sp.resolve([], both, NOW);
	let posts = sp.plan(events, classic, ledger);
	assert.deepEqual(posts.map((p) => [p.destination, p.events.map((e) => e.family)]), [[['shop', null], ['world-of-warcraft']]]);
	ledger = sp.remember(ledger, posts, NOW);
	const later = '2026-10-10T10:10:00+00:00';
	[events, ledger] = sp.resolve(ledger, [fresh('us', { family: 'world-of-warcraft', kind: 'banner', key: 'b-1' })], later);
	ledger = sp.remember(ledger, sp.plan(events, classic, ledger), later);
	[events] = sp.resolve(ledger, [fresh('us', { family: 'world-of-warcraft-classic', kind: 'banner', key: 'b-1' })], later);
	assert.deepEqual(sp.plan(events, classic, ledger), []); // the WoW post, edited for the US, already has it
	[events] = sp.resolve([], [fresh('eu', { family: 'world-of-warcraft-classic', kind: 'new', key: 'c-9' })], NOW);
	assert.equal(sp.plan(events, classic, ledger).length, 2); // another item is posted as usual
});

test('a digest is not posted again when the other region follows, but a feed that missed it still gets it', () => {
	const sweep = (region) => [0, 1, 2].map((n) => fresh(region, { key: `c-${n}` }));
	let [events, ledger] = sp.resolve([], sweep('us'), NOW); // Overwatch has no US feed, so only the shop channel
	ledger = sp.remember(ledger, sp.plan(events, FAMILIES), NOW);
	[events] = sp.resolve(ledger, sweep('eu'), '2026-10-10T10:10:00+00:00');
	assert.deepEqual(sp.plan(events, FAMILIES).map((p) => [p.destination, p.kind, p.edit]), [[['feed', 'overwatch-news'], 'digest', false]]);
});

test('WoW posts to each region\'s feed, a game without a US feed does not, and some types are shop-only or logged only', () => {
	assert.deepEqual(sp.audiences(event('price', ['eu', 'us'], { family: 'world-of-warcraft' }), FAMILIES['world-of-warcraft'].sources), [['feed', 'wow-news'], ['feed', 'wow-news-us'], ['shop', null]]);
	assert.deepEqual(sp.audiences(event('new', ['us']), FAMILIES.overwatch.sources), [['shop', null]]);
	assert.deepEqual(sp.audiences(event('gone', ['eu']), FAMILIES.overwatch.sources), [['shop', null]]);
	assert.deepEqual(sp.audiences(event('unlisted', ['eu']), FAMILIES.overwatch.sources), []);
});

test('three of a type make a digest, two stay single, and more than five posts fold into one', () => {
	const events = [...[0, 1, 2].map((n) => event('new', ['eu'], { key: `c-${n}` })), ...[0, 1].map((n) => event('price', ['eu'], { key: `c-${n}` }))];
	const feed = sp.plan(events, FAMILIES).filter((p) => p.destination[0] === 'feed');
	assert.deepEqual(feed.map((p) => [p.kind, p.type, p.events.length]), [['digest', 'new', 3], ['single', 'price', 1], ['single', 'price', 1]]);
	const many = ['new', 'new', 'back', 'back', 'price', 'price', 'badge', 'badge'].map((kind, n) => event(kind, ['eu'], { key: `c-${n}` }));
	const folded = sp.plan(many, FAMILIES).filter((p) => p.destination[0] === 'feed');
	assert.equal(folded.length, sp.MAX_POSTS);
	assert.equal(folded.at(-1).kind, 'more');
	assert.equal(folded.at(-1).events.length, 4);
});
