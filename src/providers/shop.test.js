import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as shop from './shop.js';

const load = (name) => shop.parseItems(fs.readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), 'utf8'));
const wow = load('shop-wow.rsc'); // real family payloads, trimmed to the records that hold items and banners
const overwatch = load('shop-overwatch.rsc');

/** A payload like the shop's: `<hex id>:<json>` lines mixed with module references that aren't JSON. */
const stream = (...records) => ['2:I[9766,[],""]', ...records.map((r, i) => `${(i + 3).toString(16)}:${JSON.stringify(r)}`)].join('\n') + '\n';
const card = (fields = {}) => ({ cmsId: null, productIds: [1], slug: 'thing', title: 'Thing', ...fields });

test('WoW has its curated cards, product-only items and banners', () => {
	const kinds = Object.values(wow).map((i) => i.kind);
	assert.equal(kinds.filter((k) => k === 'item').length, 143);
	assert.equal(kinds.filter((k) => k === 'banner').length, 5);
	assert.equal(Object.values(wow).filter((i) => i.kind === 'item' && i.cmsId === null).length, 38);
});

test('an item in several sections is one entry listing them all', () => {
	assert.deepEqual(wow.blt3c75df04a7ee8b14.sections, ['Games', 'Great for New Players']);
});

test('both section shapes and an untitled one are named', () => {
	const sections = new Set(Object.values(overwatch).flatMap((i) => i.sections));
	for (const name of ['Seasonal Offers', 'Featured', shop.UNTITLED_SECTION]) {
		assert.ok(sections.has(name), name);
	}
	assert.ok(Object.values(overwatch).every((i) => i.sections.length));
});

test('bundles are keyed by the link id, not by what they contain', () => {
	const bundle = Object.values(overwatch).find((i) => i.slug === 'overwatch-shadow-monarch-mega-bundle');
	assert.equal(bundle.key, `p:${bundle.itemId}`);
	assert.equal(bundle.key, 'p:2129813');
	assert.ok(!bundle.productIds.includes(bundle.itemId));
});

test('a sale is a discount amount, and a subscription saving is not', () => {
	assert.ok(Object.values(overwatch).some((i) => i.price?.discountAmount));
	const subscription = Object.values(wow).find((i) => i.kind === 'item' && i.subscriptionIds.length);
	assert.ok(subscription.price.discountPercentage && !subscription.price.discountAmount);
});

test('a banner-only product is reached through its banner', () => {
	const banners = Object.values(wow).filter((i) => i.kind === 'banner');
	assert.ok(banners.some((b) => b.slug === 'world-of-warcraft-forever'));
	assert.ok(!Object.values(wow).some((i) => i.kind === 'item' && i.slug === 'world-of-warcraft-forever'));
});

test('the doubled dollar sign of the US shop is cleaned', () => {
	const { price } = shop.parseItems(stream({ title: 'Shop', cards: [card({ price: { fullAmount: '$$29.99', discountAmount: '$$9.99' } })] }))['p:1'];
	assert.deepEqual([price.fullAmount, price.discountAmount], ['$29.99', '$9.99']);
});

test('cache metadata never shows up as a change', () => {
	const payload = (age) => stream({ title: 'Shop', cards: [card({ cacheMetaData: { serverTimeMs: age }, price: { raw: 5 } })] });
	assert.deepEqual(shop.parseItems(payload(1)), shop.parseItems(payload(2)));
});

test('lines that are not JSON are skipped', () => {
	const items = shop.parseItems(stream({ title: 'Shop', cards: [card()] }) + ':HC"https://cdn"\nbroken:{oops\n');
	assert.deepEqual(Object.keys(items), ['p:1']);
});

test('the key is the cms id, then the link id, then the product ids, then the slug', () => {
	assert.equal(shop.itemKey(card({ cmsId: 'blt1' })), 'blt1');
	assert.equal(shop.itemKey(card({ destination: '/family/x/items/77/thing' })), 'p:77');
	assert.equal(shop.itemKey(card({ productIds: [3, 4] })), 'p:3,4');
	assert.equal(shop.itemKey(card({ productIds: [] })), 's:thing');
});

test('a banner that is only a picture still has a title', () => {
	const payload = stream({ cmsId: 'blt9', callToAction: { headline: '', subHeadline: '', destination: null } });
	assert.equal(shop.parseItems(payload).blt9.title, shop.BANNER_SECTION);
});

/** Answers at the URL asked for, unless `url` says it was redirected. */
function fakeSession(text, { type = 'text/x-component', url = null } = {}) {
	const session = { requested: [] };
	session.get = async (asked) => {
		session.requested.push(asked);
		return { status: 200, statusText: 'OK', url: url ?? asked, headers: new Headers({ 'content-type': type }), text };
	};
	return session;
}

test('a page that is not the data payload is an error', async () => {
	await assert.rejects(shop.fetchFamily(fakeSession('<html>login</html>', { type: 'text/html' }), 'https://eu.shop.battle.net/en-gb', 'overwatch'), shop.ShopFetchError);
});

test('a redirect to the other region\'s shop is an error', async () => {
	const session = fakeSession('1:{}', { url: 'https://us.shop.battle.net/en-us/family/overwatch' });
	await assert.rejects(shop.fetchFamily(session, 'https://eu.shop.battle.net/en-gb', 'overwatch'), shop.ShopFetchError);
});

test('an item page confirms a sale only when it has a price', async () => {
	for (const [price, expected] of [[{ fullAmount: '€9.99', raw: 9.99 }, true], [null, false]]) {
		const session = fakeSession(stream({ title: 'Shop', price }));
		assert.equal(await shop.itemOnSale(session, 'https://eu.shop.battle.net/en-gb', 'overwatch', { itemId: 77, slug: 'thing' }), expected);
		assert.deepEqual(session.requested, ['https://eu.shop.battle.net/en-gb/family/overwatch/items/77']);
	}
});

test('a session sends a cookie back to its own host, and a domain cookie to the domain', () => {
	const session = new shop.ShopSession();
	const answer = (...cookies) => ({ headers: new Headers(cookies.map((c) => ['set-cookie', c])) });
	session.remember(answer('XSRF-TOKEN=a; Path=/; Secure', 'deviceTrackingId=b; Domain=.battle.net; Path=/'), 'eu.shop.battle.net');
	session.remember(answer('SESSIONID=c; Path=/'), 'oauth.battle.net');
	assert.equal(session.cookieHeader('eu.shop.battle.net'), 'XSRF-TOKEN=a; deviceTrackingId=b');
	assert.equal(session.cookieHeader('oauth.battle.net'), 'deviceTrackingId=b; SESSIONID=c');
	assert.equal(session.cookieHeader('us.shop.battle.net'), 'deviceTrackingId=b');
	session.remember(answer('XSRF-TOKEN=; Max-Age=0', 'deviceTrackingId=; Domain=battle.net; Expires=Thu, 01 Jan 1970 00:00:00 GMT'), 'eu.shop.battle.net');
	assert.equal(session.cookieHeader('eu.shop.battle.net'), ''); // both expired by the server
});
