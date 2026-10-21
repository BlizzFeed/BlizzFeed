import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeJson } from '../json.js';

const SUSPECT_DROP = 0.25; // a fetch losing more than this share of the listed items is held for a second look
const END_SHARE = 0.5; // a sale campaign ends when this share of its items read "no sale" in one sweep
const MIN_POOL = 4; // a smaller campaign is too small to tell a stale copy from a real end
const LEAVE_SWEEPS = 3; // sweeps in a row an item reads "no sale" before it leaves a running campaign alone
const CLOSED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const META_FILE = 'meta.json';
const DETAIL_FIELDS = ['title', 'description', 'image', 'sections'];
const BANNER_FIELDS = ['headline', 'subHeadline', 'buttonText', 'destination'];

export const familyDir = (region, family) => `${region}/${family}`;
export const statePath = (shopDir, region, family) => path.join(shopDir, familyDir(region, family), 'state.json');

export function loadState(shopDir, region, family) {
	const file = statePath(shopDir, region, family);
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/** [families to report, new meta]. The first check reports nothing. */
export function familyCheck(meta, slugs, tracked, now) {
	const reported = new Set(meta.reported ?? []);
	const untracked = [...new Set(slugs)].filter((slug) => !tracked.includes(slug));
	const fresh = 'last_family_check' in meta ? untracked.filter((slug) => !reported.has(slug)).sort() : [];
	return [fresh, { last_family_check: now, reported: [...new Set([...reported, ...untracked])].sort() }];
}

export const cardName = (key) => key.replaceAll(':', '-').replaceAll(',', '_');

const priced = (item) => item.kind === 'item' && Boolean(item.price?.fullAmount);
const value = (item, key) => item[key] ?? null; // so a missing field equals a null one

function differing(prev, item, fields) {
	const changed = fields.filter((key) => !isDeepStrictEqual(value(prev, key), value(item, key)));
	return { changed, from: Object.fromEntries(changed.map((key) => [key, value(prev, key)])), to: Object.fromEntries(changed.map((key) => [key, value(item, key)])) };
}

/** A banner's product name: its own, else the title of the item card it links to. */
function product(bannerItem, fetched) {
	if (bannerItem.productPageName) {
		return bannerItem.productPageName;
	}
	return Object.values(fetched).find((i) => i.kind === 'item' && ((i.itemId && i.itemId === bannerItem.itemId) || (i.slug && i.slug === bannerItem.slug)))?.title ?? null;
}

/** A saved banner that left the page as a new banner for the same product arrived: Blizzard swapped the art and text. */
function replacedBanner(items, fetched, item) {
	if (item.kind !== 'banner' || !item.destination) {
		return null;
	}
	return Object.values(items).find((i) => i.kind === 'banner' && i.status !== 'gone' && !(i.key in fetched) && i.destination === item.destination) ?? null;
}

/** [type, extra] for each way the fetched item differs from the saved one. */
function compare(prev, item) {
	if (item.kind === 'banner') {
		const found = differing(prev, item, BANNER_FIELDS);
		return found.changed.length ? [['banner', { what: 'changed', ...found }]] : [];
	}
	const changes = [];
	const [old, now] = [prev.price ?? {}, item.price ?? {}];
	// A sale that ends by making its price the list price costs buyers nothing, so posts skip the price change.
	const ended = old.discountAmount && !now.discountAmount;
	const kept = ended && old.discountAmount === (now.fullAmount ?? null) ? { sale_kept: true } : {};
	if ((old.fullAmount ?? null) !== (now.fullAmount ?? null)) {
		changes.push(['price', { from: old.fullAmount ?? null, to: now.fullAmount ?? null, ...kept }]);
	}
	if (Boolean(old.discountAmount) !== Boolean(now.discountAmount)) {
		changes.push([now.discountAmount ? 'sale_start' : 'sale_end', kept]);
	}
	if (value(prev, 'badge') !== value(item, 'badge')) {
		changes.push(['badge', { from: value(prev, 'badge'), to: value(item, 'badge'), maybe_new: item.badge === 'New' }]);
	}
	const details = differing(prev, item, DETAIL_FIELDS);
	if (details.changed.length) {
		changes.push(['details', details]);
	}
	return changes;
}

const onSale = (price) => Boolean(price?.discountAmount);
const regular = (item) => item?.kind === 'item';

/** A campaign for each discount ID with a sale saved on it, for the first run after the campaigns were introduced. */
function savedCampaigns(items, now) {
	const campaigns = {};
	for (const item of Object.values(items)) {
		const id = item.status === 'listed' && onSale(item.price) && item.price.discountId;
		if (id) {
			(campaigns[id] ??= { status: 'active', members: [], started: now }).members.push(item.key);
		}
	}
	return campaigns;
}

/** [campaigns, the fetched items as they should be judged].
 * A stale copy only shows the old state, so a sale ends when most of its campaign reads "no sale", not when one item does. */
function settle(old, items, fetched, now) {
	const campaigns = old.campaigns ? structuredClone(old.campaigns) : savedCampaigns(items, now);
	const judged = { ...fetched };
	const keep = (key) => { judged[key] = { ...fetched[key], price: items[key].price }; }; // the saved price stays as posted
	for (const [id, campaign] of Object.entries(campaigns)) {
		const here = (key) => regular(fetched[key]) && items[key]?.status === 'listed';
		if (campaign.status === 'active') {
			const posted = Object.keys(fetched).filter((key) => here(key) && onSale(items[key].price) && items[key].price.discountId === id);
			const quiet = posted.filter((key) => !onSale(fetched[key].price));
			if (posted.length < MIN_POOL) {
				posted.forEach((key) => delete items[key].settle);
				continue;
			}
			if (quiet.length >= END_SHARE * posted.length) {
				Object.assign(campaign, { status: 'ended', ended: now });
				for (const key of posted) {
					delete items[key].settle;
					if (onSale(fetched[key].price) && fetched[key].price.discountId === id) { // still shown on sale by a stale copy; a different campaign's sale stays on
						judged[key] = { ...fetched[key], price: { ...fetched[key].price, discountAmount: null, discountPercentage: null, discountId: null } };
					}
				}
				continue;
			}
			for (const key of posted) {
				const misses = quiet.includes(key) ? (items[key].settle?.misses ?? 0) + 1 : 0;
				if (misses && misses < LEAVE_SWEEPS) {
					items[key].settle = { misses };
					keep(key);
				} else {
					delete items[key].settle; // an item reading "no sale" for good leaves the running campaign by itself
				}
			}
		} else if (Date.parse(now) - Date.parse(campaign.ended) > CLOSED_KEEP_MS) {
			delete campaigns[id];
		} else {
			const present = campaign.members.filter((key) => here(key) && !onSale(items[key].price));
			const back = present.filter((key) => onSale(fetched[key].price) && fetched[key].price.discountId === id);
			if (present.length >= MIN_POOL && back.length >= END_SHARE * present.length) {
				campaign.status = 'active'; // Blizzard extended it
				delete campaign.ended;
			} else {
				back.forEach(keep);
			}
		}
	}
	for (const [key, item] of Object.entries(judged)) {
		const id = regular(item) && onSale(item.price) && item.price.discountId;
		if (id && campaigns[id]?.status !== 'ended') {
			const campaign = (campaigns[id] ??= { status: 'active', members: [], started: now });
			if (!campaign.members.includes(key)) {
				campaign.members.push(key);
			}
		}
	}
	return [campaigns, judged];
}

/** [new state, changes]. old is null on a family's first run, which reports nothing.
 * confirm(item) resolves to true when the item's own page still shows a price. */
export async function sweep(old, fetched, now, missesNeeded, confirm) {
	if (old === null) {
		const items = Object.fromEntries(Object.entries(fetched).map(([key, i]) => [key, { ...i, first_seen: now, status: 'listed', misses: 0 }]));
		return [{ items, suspect: false }, []];
	}
	const items = Object.fromEntries(Object.entries(old.items).map(([key, i]) => [key, { ...i }]));
	const listed = Object.keys(items).filter((key) => items[key].status === 'listed');
	const vanished = listed.filter((key) => !(key in fetched));
	if (vanished.length > SUSPECT_DROP * listed.length && !old.suspect) {
		return [{ ...old, suspect: true }, []]; // believed if the next fetch agrees
	}
	for (const [key, item] of Object.entries(fetched)) { // a product-only item that gained a card keeps its history under the new key
		if (!(key in items) && item.kind === 'item' && item.itemId) {
			const before = Object.keys(items).find((k) => !(k in fetched) && items[k].kind === 'item' && items[k].status !== 'gone' && items[k].itemId === item.itemId);
			if (before) {
				items[key] = items[before];
				delete items[before];
			}
		}
	}

	const [campaigns, judged] = settle(old, items, fetched, now);
	const changes = [];
	const log = (type, item, extra = {}) => {
		const record = { type, key: item.key, kind: item.kind, slug: item.slug, title: item.title, destination: item.destination, seen: now };
		Object.assign(record, item.kind === 'banner' ? { button: item.buttonText, product: product(item, fetched) } : { price: item.price });
		changes.push({ ...record, ...extra });
	};

	for (const [key, item] of Object.entries(judged)) {
		const prev = items[key];
		const replaced = !prev && replacedBanner(items, fetched, item);
		if (replaced) {
			Object.assign(replaced, { status: 'gone', gone_since: now }); // its successor reports the change
			const found = differing(replaced, item, [...BANNER_FIELDS, 'image']);
			if (found.changed.length) {
				log('banner', item, { what: 'changed', replaced: replaced.key, ...found });
			}
		} else if (!prev || prev.status === 'gone') {
			if (item.kind === 'banner') {
				log('banner', item, { what: prev ? 'back' : 'added' });
			} else {
				log(prev ? 'back' : 'new', item);
			}
		} else {
			for (const [type, extra] of compare(prev, item)) {
				log(type, item, extra);
			}
		}
		items[key] = { ...item, first_seen: prev ? prev.first_seen : now, status: 'listed', misses: 0, ...(prev?.settle ? { settle: prev.settle } : {}) };
	}

	for (const [key, item] of Object.entries(items)) {
		if (key in fetched || item.status === 'gone') {
			continue;
		}
		if (item.status !== 'unlisted') { // an unlisted item is asked about again every sweep
			item.status = 'missing';
			item.misses++;
			if (item.misses < missesNeeded) {
				continue;
			}
		}
		// Banners and price-less items can't be confirmed by their page.
		if (priced(item)) {
			let stillForSale;
			try {
				stillForSale = await confirm(item);
			} catch {
				continue; // can't tell; the next sweep asks again
			}
			if (stillForSale) {
				if (item.status !== 'unlisted') {
					item.status = 'unlisted';
					log('unlisted', item);
				}
				continue;
			}
		}
		item.status = 'gone';
		item.gone_since = now;
		if (item.kind === 'banner') {
			log('banner', item, { what: 'removed' }); // the product it showed is usually still for sale
		} else {
			log('gone', item);
		}
	}
	return [{ items, suspect: false, ...(Object.keys(campaigns).length ? { campaigns } : {}) }, changes];
}

export function renderMarkdown(item) {
	const price = item.price ?? {};
	const lines = [`# ${item.title}`, '', `- Key: ${item.key}`, `- Status: ${item.status}`, `- Sections: ${item.sections.join(', ')}`, `- First seen: ${item.first_seen}`];
	if (item.badge) {
		lines.push(`- Badge: ${item.badge}`);
	}
	if (price.fullAmount) {
		lines.push(`- Price: ${price.fullAmount}`);
	}
	if (price.discountAmount) {
		lines.push(`- On sale: ${price.discountAmount}`);
	}
	if (item.image) {
		lines.push(`![](${item.image.startsWith('//') ? 'https:' : ''}${item.image})`);
	}
	return [...lines, '', item.description || item.subHeadline || '', ''].join('\n');
}

/** state.json, a card for each changed item (every item on a baseline) and the change log. */
export function writeFamily(shopDir, region, family, state, changes, baseline) {
	const root = path.join(shopDir, familyDir(region, family));
	fs.mkdirSync(path.join(root, 'items'), { recursive: true });
	const touched = baseline ? Object.keys(state.items) : new Set(changes.flatMap((c) => [c.key, c.replaced].filter(Boolean)));
	for (const key of touched) {
		fs.writeFileSync(path.join(root, 'items', `${cardName(key)}.md`), renderMarkdown(state.items[key]));
	}
	if (changes.length) {
		fs.appendFileSync(path.join(root, 'changes.jsonl'), changes.map((change) => `${JSON.stringify(change)}\n`).join(''));
	}
	writeJson(statePath(shopDir, region, family), state);
}
