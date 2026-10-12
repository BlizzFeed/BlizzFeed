import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../json.js';

export const LEDGER_FILE = 'posted.json';
const EDIT_WINDOW_MS = 30 * 60 * 1000; // a one-sided post is edited when the other region follows within this
const DIGEST_AT = 3; // changes of one type, per game and destination in a run
export const MAX_POSTS = 5; // per game and destination in a run; the rest fold into one post
const NEW_TYPES = ['new', 'back'];
const UPDATE_TYPES = ['price', 'sale_start', 'badge'];
const ORDER = [...NEW_TYPES, ...UPDATE_TYPES, 'sale_end', 'gone', 'banner', 'details']; // unlisted is logged only
const REGIONS = ['eu', 'us'];
// Tier channels of a game's feed per type; the other types only go to the shop channel
export const FEED_TIERS = Object.fromEntries([...NEW_TYPES.map((t) => [t, ['all', 'new']]), ...UPDATE_TYPES.map((t) => [t, ['all', 'updated']])]);

export function loadLedger(shopDir) {
	const file = path.join(shopDir, LEDGER_FILE);
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

export const saveLedger = (shopDir, ledger) => writeJson(path.join(shopDir, LEDGER_FILE), ledger);

/** How the bot finds an earlier post to edit. */
export const ref = (event) => `${event.family}:${event.type}:${event.key}`;

const toEvent = (region, family, change) => ({ type: change.type, family, key: change.key, slug: change.slug, seen: change.seen, changes: { [region]: change } });

/** The same change in the other region: by key, else by slug when that is unambiguous (Diablo II's keys differ). */
function partner(event, others) {
	const same = others.filter((o) => o.family === event.family && o.type === event.type && !Object.keys(o.changes).some((r) => r in event.changes));
	const byKey = same.find((o) => o.key === event.key);
	if (byKey) {
		return byKey;
	}
	const clash = same.filter((o) => o.slug && o.slug === event.slug);
	return clash.length === 1 && event.slug ? clash[0] : null;
}

/** [events, ledger] from fresh [[region, family, change]]. An event whose other region is in the ledger gets `was`,
 * the regions already posted, so its post is edited. */
export function resolve(ledger, fresh, now) {
	const cutoff = Date.parse(now) - EDIT_WINDOW_MS;
	const kept = ledger.filter((e) => Date.parse(e.at) > cutoff);
	const events = [];
	for (const [region, family, change] of fresh) {
		const event = toEvent(region, family, change);
		const match = partner(event, events);
		if (match) {
			match.changes[region] = change;
		} else {
			events.push(event);
		}
	}
	for (const event of events) {
		const match = partner(event, kept);
		if (match) {
			kept.splice(kept.indexOf(match), 1);
			event.was = Object.keys(match.changes).sort();
			event.changes = { ...match.changes, ...event.changes };
		}
	}
	return [events, kept];
}

/** Adds the one-sided events posted on their own to the ledger. */
export function remember(ledger, posts, now) {
	const known = new Set(ledger.map(ref));
	for (const post of posts) {
		for (const event of post.events) {
			if (post.kind === 'single' && !post.edit && Object.keys(event.changes).length === 1 && !known.has(ref(event))) {
				const { was: _was, ...rest } = event;
				ledger.push({ ...rest, at: now });
				known.add(ref(event));
			}
		}
	}
	return ledger;
}

/** ['feed', source id] or ['shop', null] for each destination: a feed gets the events its region saw, the shop channel all.
 * A family's sources are [EU feed, US feed]; most have only the EU one. */
export function audiences(event, sources, regions = null) {
	if (event.type === 'unlisted') {
		return [];
	}
	const seen = regions?.length ? regions : Object.keys(event.changes);
	const feeds = FEED_TIERS[event.type] ? REGIONS.map((region, i) => (seen.includes(region) ? sources[i] : null)).filter(Boolean) : [];
	return [...new Set(feeds)].map((feed) => ['feed', feed]).concat([['shop', null]]);
}

/** A post per item, so an item with several changes in a run is one post. */
function singles(events) {
	const items = new Map();
	for (const event of [...events].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type))) {
		const id = `${event.family} ${event.key}`;
		items.set(id, [...(items.get(id) ?? []), event]);
	}
	return [...items.values()].map((group) => ({ kind: 'single', type: group[0].type, events: group }));
}

/** A price change that only made the sale price the list price isn't news; the sale ending is. */
const announced = (event) => !(event.type === 'price' && Object.values(event.changes).some((c) => c.sale_kept));

/** The posts of a run: {destination, game (the family's first feed), edit, kind (single, digest or more), type, events}.
 * Edits go to destinations the event was already posted to; the rest are digested and capped. */
export function plan(events, families) {
	const groups = new Map();
	for (const event of events.filter(announced)) {
		const sources = families[event.family].sources;
		const before = 'was' in event ? audiences(event, sources, event.was).map((d) => JSON.stringify(d)) : [];
		for (const destination of audiences(event, sources)) {
			const edit = before.includes(JSON.stringify(destination));
			const id = JSON.stringify([destination, sources[0], edit]);
			if (!groups.has(id)) {
				groups.set(id, { destination, game: sources[0], edit, members: [] });
			}
			groups.get(id).members.push(event);
		}
	}
	const posts = [];
	for (const { destination, game, edit, members } of groups.values()) {
		let built;
		if (edit) {
			built = singles(members);
		} else {
			built = ORDER.map((type) => ({ kind: 'digest', type, events: members.filter((e) => e.type === type) })).filter((p) => p.events.length >= DIGEST_AT);
			const digested = new Set(built.flatMap((p) => p.events));
			built.push(...singles(members.filter((e) => !digested.has(e))));
			if (built.length > MAX_POSTS) {
				built = [...built.slice(0, MAX_POSTS - 1), { kind: 'more', type: null, events: built.slice(MAX_POSTS - 1).flatMap((p) => p.events) }];
			}
		}
		posts.push(...built.map((post) => ({ destination, game, edit, ...post })));
	}
	return posts;
}
