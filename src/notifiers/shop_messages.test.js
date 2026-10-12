import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from './shop_messages.js';

const NOW = '2026-10-10T10:00:00+00:00';
const item = (amount, discount = null) => ({ status: 'listed', price: { fullAmount: amount, discountAmount: discount } });
const event = (kind, extra = {}) => ({ type: kind, family: 'f', key: 'c-1', slug: 's', changes: { eu: { type: kind, title: 'T', destination: '/x', seen: NOW, ...extra } } });
const parts = (message) => message.components[0].components;
const statusLines = (events, states) => parts(m.buildSingle(events, states, null, null, null, NOW, 'shop'))[0].content.split('\n').slice(1);

test('a new item shows each region\'s price, and a shared currency once', () => {
	const states = (eu, us) => ({ 'eu/f': { items: { 'c-1': eu } }, 'us/f': { items: { 'c-1': us } } });
	assert.deepEqual(statusLines([event('new')], states(item('€25.00'), item('$25.00'))), ['🟢 **New in the shop** · **€25.00** / **$25.00**']);
	assert.deepEqual(statusLines([event('new')], states(item('500 Coins'), item('500 Coins'))), ['🟢 **New in the shop** · **500 Coins**']);
	assert.deepEqual(statusLines([event('new')], { 'eu/f': { items: { 'c-1': item('€25.00') } } }), ['🟢 **New in the shop** · **€25.00**']);
});

test('one post for an item lists each of its changes, and a kept sale price says so', () => {
	const price = event('price', { from: '2,600 Coins', to: '2,400 Coins' });
	price.changes.us = { ...price.changes.eu, from: '$26', to: '$24' };
	const state = { 'eu/f': { items: { 'c-1': item('2,400 Coins') } } };
	assert.deepEqual(statusLines([price, event('sale_end', { sale_kept: true })], state), [
		'💵 **Price changed** · 2,600 Coins → **2,400 Coins** / $26 → **$24**',
		'⌛ **Sale ended** · **2,400 Coins** is now the regular price',
	]);
});

test('a details post shows old and new text and before and after images', () => {
	const e = event('details', { changed: ['title', 'image'], from: { title: 'A', image: '//x/a.png' }, to: { title: 'B', image: '//x/b.png' } });
	const inner = parts(m.buildSingle([e], {}, null, null, null, NOW, 'shop'));
	assert.ok(inner.some((c) => c.content === '```diff\n- A\n+ B\n+ Image changed\n```'));
	assert.deepEqual(inner.find((c) => c.type === 12).items.map((i) => [i.media.url, i.description]), [['https://x/a.png', 'Before'], ['https://x/b.png', 'After']]);
});

test('a details digest shows one diff block per kind of change, with unique ids', () => {
	const moved = (key, from, to) => ({ ...event('details', { changed: ['sections'], from: { sections: from }, to: { sections: to } }), key });
	const post = { type: 'details', events: [moved('a', [], ['Featured']), moved('b', [], ['Featured']), moved('c', ['Featured'], [])] };
	const blocks = parts(m.buildDigest(post, {}, null, null, null, NOW, 'shop')).filter((c) => c.content?.startsWith('```diff'));
	assert.deepEqual(blocks.map((b) => b.content.split('\n').slice(1, -1)), [['- ', '+ Featured'], ['- Featured', '+ ']]);
	assert.equal(new Set(blocks.map((b) => b.id)).size, 2);
});

test('a digest gallery shows shared art once, and only from the listed items', () => {
	const keys = Array.from({ length: 14 }, (_, i) => `k${i}`);
	const items = Object.fromEntries(keys.map((k, i) => [k, { ...item('1'), image: i < 2 ? '//x/shared.png' : `//x/${i}.png` }]));
	const post = { type: 'new', events: keys.map((key) => ({ ...event('new'), key })) };
	const gallery = parts(m.buildDigest(post, { 'eu/f': { items } }, null, null, null, NOW, 'feed')).find((c) => c.type === 12);
	assert.deepEqual(gallery.items.map((i) => i.media.url), ['https://x/shared.png', ...Array.from({ length: 9 }, (_, i) => `https://x/${i + 2}.png`)]);
});

test('a removed banner has no price to show', () => {
	assert.deepEqual(statusLines([event('gone')], {}), ['🔴 **Removed from the shop**']);
});
