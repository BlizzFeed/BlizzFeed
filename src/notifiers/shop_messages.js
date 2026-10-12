import * as d from './discord.js';
import { cardName, familyDir } from '../processors/shop_differ.js';

export const SHOP_URL = 'https://shop.battle.net'; // the plain host sends each reader to their own region
const STATUS = {
	new: '🟢 **New in the shop**', back: '🔁 **Back in the shop**', price: '💵 **Price changed**', sale_start: '🏷️ **Now on sale**',
	sale_end: '⌛ **Sale ended**', gone: '🔴 **Removed from the shop**', banner: '🖼️ **New banner**', details: '📝 **Details changed**',
};
const DIGEST = {
	new: 'new items in the shop', back: 'items back in the shop', price: 'price changes', sale_start: 'items now on sale',
	sale_end: 'sales ended', badge: 'badge changes', gone: 'items removed from the shop', banner: 'banner changes',
	details: 'items with changed details', more: 'more changes',
};
const COLOR = { new: 'added', back: 'added', gone: 'down', banner: 'log', details: 'log' }; // the rest is orange
const MAX_LINES = 12;
const MAX_IMAGES = 10; // the most a gallery holds

/** A digest's title; a post without a type is a mix, folded past the cap. */
export const digestTitle = (type, n) => `${n} ${DIGEST[type ?? 'more']}`;

const url = (destination) => (destination?.startsWith('/') ? SHOP_URL + destination : destination || ''); // the Gear cards link off-site
const image = (src) => (src?.startsWith('//') ? 'https:' + src : src || '');
const firstChange = (event) => Object.values(event.changes)[0];
const titleOf = (event) => (firstChange(event).title || event.key).trim();

/** The price as the shop writes it ("From €49.99"), or null for free and "Learn More" cards. */
function shown(price) {
	if (!price?.fullAmount) {
		return null;
	}
	const label = price.labelFormat || '{0}';
	return label.includes('{0}') ? label.replaceAll('{0}', price.fullAmount) : price.fullAmount;
}

const sale = (price) => `~~${price.fullAmount}~~ **${price.discountAmount}**${price.discountPercentage ? ` (${price.discountPercentage}%)` : ''}`;
const join = (texts) => [...new Set(texts)].join(' / '); // the same in-game currency in both regions shows once

/** states maps 'region/family' to that family's state. */
const itemIn = (states, event, region) => states[familyDir(region, event.family)]?.items[event.key] ?? null;
const artItem = (states, event) => Object.keys(event.changes).map((region) => itemIn(states, event, region)).find(Boolean) ?? {};
const listed = (states, event) => ['eu', 'us'].map((region) => itemIn(states, event, region)).filter((i) => i?.status === 'listed');
const listedPrices = (states, event) => join(listed(states, event).map((i) => shown(i.price)).filter(Boolean).map((p) => `**${p}**`));

function priceText(event, states) {
	const changes = Object.values(event.changes);
	switch (event.type) {
	case 'new':
	case 'back':
		return listedPrices(states, event);
	case 'sale_start':
		return join(listed(states, event).filter((i) => i.price?.discountAmount).map((i) => sale(i.price)));
	case 'sale_end': {
		const prices = listedPrices(states, event);
		if (prices && changes.some((c) => c.sale_kept)) {
			return `${prices} is now the regular price`;
		}
		return prices ? `back to ${prices}` : null;
	}
	case 'price':
		return join(changes.map((c) => `${c.from || '–'} → **${c.to || '–'}**`));
	case 'gone': {
		const prices = join(changes.map((c) => shown(c.price)).filter(Boolean).map((p) => `**${p}**`)); // a banner has no price
		return prices ? `was ${prices}` : null;
	}
	case 'banner':
		return changes[0].button;
	default:
		return null;
	}
}

function status(event) {
	if (event.type !== 'badge') {
		return STATUS[event.type];
	}
	const badge = firstChange(event).to;
	if (badge === 'New') {
		return '✨ **Marked as new in the shop**';
	}
	return badge ? `✨ **${badge}**` : '✨ **Badge removed**';
}

function detailLines(change) {
	const lines = [];
	for (const field of change.changed) {
		if (field === 'image') {
			lines.push('+ Image changed');
			continue;
		}
		const [old, now] = ['from', 'to'].map((side) => change[side][field]).map((v) => (Array.isArray(v) ? v.join(', ') : v || ''));
		lines.push(`- ${d.trim(old, 100)}`, `+ ${d.trim(now, 100)}`);
	}
	return lines;
}

const footer = (verb, now, repoUrl) => d.text(`-# ${verb} ${d.discordTime(now)}${repoUrl ? ` · [BlizzFeed](${repoUrl})` : ''}`);
const payload = (kind, inner) => ({ flags: d.IS_COMPONENTS_V2, components: [{ type: 17, accent_color: d.COLORS[COLOR[kind] ?? 'updated'], components: inner }] });

function buttons(shopUrl, repoUrl, commit, history, channel) {
	const row = shopUrl ? [d.linkButton('Shop', shopUrl)] : [];
	if (channel === 'shop' && repoUrl) {
		if (commit) {
			row.push(d.linkButton('Shop Changes', `${repoUrl}/commit/${commit}`));
		}
		row.push(d.linkButton('History', `${repoUrl}/commits/shop/${history}`));
	}
	return { type: 1, components: row };
}

function statusLine(event, states) {
	const price = event.type === 'badge' ? null : priceText(event, states);
	return price ? `${status(event)} · ${price}` : status(event);
}

/** An item's changes in a run, one status line each. channel is 'feed' or 'shop'. */
export function buildSingle(events, states, logo, repoUrl, commit, now, channel) {
	const [event] = events;
	const [region, change] = Object.entries(event.changes)[0];
	const kind = event.type;
	const item = artItem(states, event);
	const title = titleOf(event);
	let content = `## ${d.trim(title, 256)}\n` + events.map((e) => statusLine(e, states)).join('\n');
	const note = kind === 'banner' ? item.subHeadline : kind === 'details' ? null : item.description;
	if (note) {
		content += `\n${d.trim(note, 200)}`;
	}
	const inner = d.top(d.text(content), logo, title);
	let art = item.image ? [{ media: { url: image(item.image) } }] : [];
	const edited = events.find((e) => e.type === 'details');
	if (edited) {
		const detail = firstChange(edited);
		const block = d.diffBlock(detailLines(detail));
		if (block) {
			inner.push(block);
		}
		if (detail.changed.includes('image')) {
			inner.push(d.text('**Before** (left)  ·  **After** (right)'));
			art = [{ media: { url: image(detail.from.image) }, description: 'Before' }, { media: { url: image(detail.to.image) }, description: 'After' }];
		}
	}
	if (art.length) {
		inner.push({ type: 12, items: art });
	}
	const shopUrl = kind === 'gone' ? null : url(change.destination);
	const history = `${region}/${event.family}/items/${cardName(event.key)}.md`;
	inner.push(d.DIVIDER, buttons(shopUrl, repoUrl, commit, history, channel), d.DIVIDER,
		footer(events.every((e) => e.type === 'details') ? 'Updated' : 'Posted', now, repoUrl));
	return payload(kind, inner);
}

function line(event, states, emoji = false) {
	const change = firstChange(event);
	const title = d.linkLabel(titleOf(event), 60);
	let text = (emoji ? `- ${d.SHOP_EMOJI[event.type]} ` : '- ') + (change.destination ? `[${title}](${url(change.destination)})` : title);
	const price = ['new', 'back', 'sale_start', 'price'].includes(event.type) ? priceText(event, states) : null;
	if (price) {
		text += ` · ${price}`;
	}
	return text;
}

/** A details digest: one diff block per kind of change, each followed by the items it applies to. */
function detailsBody(events, states) {
	const groups = new Map();
	for (const event of events.slice(0, MAX_LINES)) {
		const lines = detailLines(firstChange(event));
		const key = JSON.stringify(lines);
		if (!groups.has(key)) {
			groups.set(key, { lines, items: [] });
		}
		groups.get(key).items.push(line(event, states));
	}
	const body = [...groups.values()].flatMap(({ lines, items }, n) => {
		const block = d.diffBlock(lines);
		return [{ ...block, id: block.id + n }, d.text(items.join('\n'))]; // every id must be unique
	});
	if (events.length > MAX_LINES) {
		body.push(d.text(`-# …and ${events.length - MAX_LINES} more`));
	}
	return body;
}

export function buildDigest(post, states, logo, repoUrl, commit, now, channel) {
	const { events, type: kind } = post;
	const heading = digestTitle(kind, events.length);
	let inner;
	if (kind === 'details') {
		inner = [...d.top(d.text(`## ${heading}`), logo, heading), ...detailsBody(events, states)];
	} else {
		const lines = events.map((e) => line(e, states, kind === null));
		const shownLines = lines.slice(0, MAX_LINES);
		if (lines.length > MAX_LINES) {
			shownLines.push(`-# …and ${lines.length - MAX_LINES} more`);
		}
		inner = d.top(d.text(`## ${heading}\n` + shownLines.join('\n')), logo, heading);
	}
	// The listed items' art, shared art once.
	const art = [...new Set(events.slice(0, MAX_LINES).map((e) => artItem(states, e).image).filter(Boolean).map(image))].slice(0, MAX_IMAGES);
	if (art.length) {
		inner.push({ type: 12, items: art.map((src) => ({ media: { url: src } })) });
	}
	const { family } = events[0];
	inner.push(d.DIVIDER, buttons(`${SHOP_URL}/family/${family}`, repoUrl, commit, `eu/${family}/changes.jsonl`, channel), d.DIVIDER, footer('Posted', now, repoUrl));
	return payload(kind, inner);
}
