import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeJson } from '../json.js';

const SUSPECT_DROP = 0.25; // a fetch losing more than this share of the listed items is held for a second look
const END_SHARE = 0.5; // a sale campaign ends when this share of its items read "no sale" in one sweep
const MIN_POOL = 4; // a smaller campaign is too small to tell a stale copy from a real end
const GREY_SHARE = 0.3; // from this share of a campaign reading "no sale", extra copies of the page decide
const GREY_COPIES = 2;
const CHECK_COPIES = 3;
const SETTLE_MS = 60 * 60 * 1000; // a change undoing one posted within this long is checked against extra copies
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
const sameState = (a, b) => (a?.fullAmount ?? null) === (b?.fullAmount ?? null) && (a?.discountAmount ?? null) === (b?.discountAmount ?? null);
const priceChange = ([type]) => ['price', 'sale_start', 'sale_end'].includes(type);

/** Extra copies of the family page for one run: asks `copies` for what is missing, and null once it fails ("can't tell"). */
function pooler(copies) {
	const got = [];
	let failed = !copies;
	return async (n) => {
		try {
			if (!failed && got.length < n) {
				got.push(...await copies(n - got.length));
			}
		} catch {
			failed = true;
		}
		return failed ? null : got.slice(0, n);
	};
}

/** [pages showing `read`, pages listing the item], summed over the keys and pages. */
function tally(pages, keys, read) {
	let [hit, seen] = [0, 0];
	for (const key of keys) {
		for (const page of pages.filter((p) => regular(p[key]))) {
			seen++;
			hit += Number(read(page[key]));
		}
	}
	return [hit, seen];
}

/** Sets or clears an item's count of sweeps reading "no sale", leaving the rest of its settle record. */
function setMisses(item, misses) {
	const settle = { ...item.settle };
	if (misses) {
		settle.misses = misses;
	} else {
		delete settle.misses;
	}
	if (Object.keys(settle).length) {
		item.settle = settle;
	} else {
		delete item.settle;
	}
}

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
 * A stale copy only shows the old state, so a sale ends when most of its campaign reads "no sale", not when one item does.
 * pool(n) resolves to n more copies of the page, or null when they can't be had. */
async function settle(old, items, fetched, now, pool) {
	const campaigns = old.campaigns ? structuredClone(old.campaigns) : savedCampaigns(items, now);
	const judged = { ...fetched };
	const decided = new Set(); // judged with their whole campaign
	const keep = (key) => { judged[key] = { ...fetched[key], price: items[key].price }; }; // the saved price stays as posted
	for (const item of Object.values(items)) {
		if (item.settle?.until && Date.parse(item.settle.until) <= Date.parse(now)) {
			const { from, until, ...rest } = item.settle;
			item.settle = rest;
			setMisses(item, rest.misses);
		}
	}
	for (const [id, campaign] of Object.entries(campaigns)) {
		const here = (key) => regular(fetched[key]) && items[key]?.status === 'listed';
		if (campaign.status === 'active') {
			const posted = Object.keys(fetched).filter((key) => here(key) && onSale(items[key].price) && items[key].price.discountId === id);
			const quiet = posted.filter((key) => !onSale(fetched[key].price));
			if (posted.length < MIN_POOL) {
				posted.forEach((key) => setMisses(items[key], 0));
				continue;
			}
			posted.forEach((key) => decided.add(key));
			let ending = quiet.length >= END_SHARE * posted.length;
			if (!ending && quiet.length >= GREY_SHARE * posted.length) {
				const more = await pool(GREY_COPIES);
				if (more) {
					const [hit, seen] = tally([fetched, ...more], posted, (item) => !onSale(item.price));
					ending = hit >= END_SHARE * seen;
				}
			}
			if (ending) {
				Object.assign(campaign, { status: 'ended', ended: now });
				for (const key of posted) {
					setMisses(items[key], 0);
					if (onSale(fetched[key].price) && fetched[key].price.discountId === id) { // still shown on sale by a stale copy; a different campaign's sale stays on
						judged[key] = { ...fetched[key], price: { ...fetched[key].price, discountAmount: null, discountPercentage: null, discountId: null } };
					}
				}
				continue;
			}
			for (const key of posted) {
				let misses = quiet.includes(key) ? (items[key].settle?.misses ?? 0) + 1 : 0;
				if (misses >= LEAVE_SWEEPS) { // an item reading "no sale" for good leaves the running campaign by itself, once the extra copies agree
					const pages = await pool(CHECK_COPIES);
					if (pages?.every((page) => regular(page[key]) && !onSale(page[key].price))) {
						misses = 0;
					} else {
						misses = pages ? 0 : LEAVE_SWEEPS - 1;
						keep(key);
					}
				} else if (misses) {
					keep(key);
				}
				setMisses(items[key], misses);
			}
		} else if (Date.parse(now) - Date.parse(campaign.ended) > CLOSED_KEEP_MS) {
			delete campaigns[id];
		} else {
			const present = campaign.members.filter((key) => here(key) && !onSale(items[key].price));
			const returning = (item) => onSale(item.price) && item.price.discountId === id;
			const back = present.filter((key) => returning(fetched[key]));
			let reopen = false;
			if (present.length >= MIN_POOL && back.length >= GREY_SHARE * present.length) {
				const more = await pool(GREY_COPIES);
				if (more) {
					const [hit, seen] = tally([fetched, ...more], present, returning);
					reopen = hit >= END_SHARE * seen;
				}
			}
			if (reopen) {
				campaign.status = 'active'; // Blizzard extended it
				delete campaign.ended;
			} else {
				back.forEach(keep);
			}
			if (present.length >= MIN_POOL) {
				back.forEach((key) => decided.add(key));
			}
		}
	}
	// A change that undoes one posted in the last hour has to show in every extra copy too.
	const reversals = Object.keys(judged).filter((key) => {
		const [prev, item] = [items[key], judged[key]];
		return !decided.has(key) && regular(item) && prev?.status === 'listed' && prev.settle?.from && sameState(item.price, prev.settle.from) && !sameState(item.price, prev.price);
	});
	if (reversals.length) {
		const pages = await pool(CHECK_COPIES);
		for (const key of reversals) {
			if (!pages?.every((page) => regular(page[key]) && sameState(page[key].price, judged[key].price))) {
				keep(key);
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
 * confirm(item) resolves to true when the item's own page still shows a price.
 * copies(n) resolves to n more parsed copies of the family page, and rejects when it can't. */
export async function sweep(old, fetched, now, missesNeeded, confirm, copies) {
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

	const [campaigns, judged] = await settle(old, items, fetched, now, pooler(copies));
	const changes = [];
	const log = (type, item, extra = {}) => {
		const record = { type, key: item.key, kind: item.kind, slug: item.slug, title: item.title, destination: item.destination, seen: now };
		Object.assign(record, item.kind === 'banner' ? { button: item.buttonText, product: product(item, fetched) } : { price: item.price });
		changes.push({ ...record, ...extra });
	};

	for (const [key, item] of Object.entries(judged)) {
		const prev = items[key];
		let posted = null;
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
			const found = compare(prev, item);
			for (const [type, extra] of found) {
				log(type, item, extra);
			}
			if (found.some(priceChange)) {
				posted = { from: { fullAmount: prev.price?.fullAmount ?? null, discountAmount: prev.price?.discountAmount ?? null }, until: new Date(Date.parse(now) + SETTLE_MS).toISOString() };
			}
		}
		const record = { ...prev?.settle, ...posted };
		items[key] = { ...item, first_seen: prev ? prev.first_seen : now, status: 'listed', misses: 0, ...(Object.keys(record).length ? { settle: record } : {}) };
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
