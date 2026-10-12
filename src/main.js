// Page tracker: scrape -> commit -> outbox -> notify, and the same for the Battle.net Shop.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { SOURCES_FILE, fail, parseFlags, readJson, repoUrl } from './cli.js';
import { writeJson } from './json.js';
import { logger } from './log.js';
import { isoSeconds } from './time.js';
import * as gitops from './core/gitops.js';
import * as health from './core/health.js';
import { loadShopConfig, loadSources } from './core/config.js';
import * as discord from './notifiers/discord.js';
import * as outbox from './notifiers/outbox.js';
import * as differ from './processors/differ.js';
import * as shopDiffer from './processors/shop_differ.js';
import * as shopPosts from './processors/shop_posts.js';
import * as htmlProvider from './providers/html.js';
import * as jsonProvider from './providers/json_api.js';
import * as shop from './providers/shop.js';

const PROVIDERS = { html: htmlProvider.fetchFeed, json: jsonProvider.fetchFeed };
const MAX_FETCH_ATTEMPTS = 3;
const MAX_DEEPEN_PAGES = 20;
const FETCH_WORKERS = 4; // sources fetched at once; kept small to not get in trouble with Blizzard

const DATA_DIR = process.env.OUTPUT_DIR ?? 'data';
const DIFF_FILE = process.env.DIFF_FILE ?? 'diff.json';
const OUTBOX_FILE = process.env.OUTBOX_FILE ?? 'outbox.json';
const SHOP_DIR = process.env.SHOP_DIR ?? 'shop';
const SHOP_DIFF_FILE = process.env.SHOP_DIFF_FILE ?? 'shop-diff.json';

const sourcesById = () => Object.fromEntries(loadSources(SOURCES_FILE).map((s) => [s.id, s]));

async function fetchWithRetry(source, known) {
	for (let attempt = 1; ; attempt++) {
		try {
			const items = await PROVIDERS[source.type](source, known);
			if (items.length || source.raw.allow_empty) {
				return items;
			}
			throw new Error('fetch returned no items (markup or API changed?)');
		} catch (error) {
			logger.warning(`[${source.id}] attempt ${attempt}/${MAX_FETCH_ATTEMPTS} failed: ${error.message}`);
			if (attempt === MAX_FETCH_ATTEMPTS) {
				throw error;
			}
			await wait(2 ** (attempt - 1) * 1000);
		}
	}
}

/** fn over the list, at most limit at a time, results in list order. */
async function mapLimit(list, limit, fn) {
	const results = new Array(list.length);
	let next = 0;
	const worker = async () => {
		while (next < list.length) {
			const i = next++;
			results[i] = await fn(list[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
	return results;
}

/** An updated item for diff.json, with the fields that changed and the title and image it had before. awaits_text: the date
 * moved too, so the archive run this one starts re-checks the text. The state file keeps the plain item. */
function withChanges(oldState, item) {
	const prev = oldState.find((i) => i.id === item.id);
	return { ...item, changed: differ.changedFields(prev, item), previous_title: prev.title, previous_image: prev.image ?? '', awaits_text: prev.date !== item.date };
}

async function scrape() {
	const state = health.load(DATA_DIR);
	const diff = { sources: {}, alerts: [] };
	// Fetch a few sources at once, then handle the results in sources.yaml order.
	const sources = loadSources(SOURCES_FILE);
	const oldStates = sources.map((source) => differ.loadState(DATA_DIR, source.id));
	const results = await mapLimit(sources, FETCH_WORKERS, async (source, i) => {
		const known = oldStates[i] && Object.fromEntries(oldStates[i].map((item) => [item.id, item.date]));
		try {
			return { items: await fetchWithRetry(source, known) };
		} catch (error) {
			return { error };
		}
	});

	sources.forEach((source, i) => {
		const oldState = oldStates[i];
		const { items, error } = results[i];
		const baseline = oldState === null;
		let alert;
		if (error) {
			logger.error(`[${source.id}] failed: ${error.message}`);
			alert = health.recordFailure(state, source, error.message);
		} else {
			alert = health.recordSuccess(state, source);
			differ.keepShopUrls(oldState, items);
			const [added, updated, quiet] = differ.compute(oldState, items);
			differ.writeSource(DATA_DIR, source.id, differ.merge(oldState, items), [...added, ...updated, ...quiet]);
			// A baseline writes everything but announces nothing. Quiet items are saved but never announced.
			diff.sources[source.id] = {
				baseline, items: items.length, added: baseline ? [] : added, updated: updated.map((item) => withChanges(oldState, item)),
				quiet: quiet.length, shop_links: differ.newShopLinks(oldState, items).length,
			};
			logger.success(`[${source.id}] ${items.length} items, +${added.length} new, ${updated.length} updated, ${quiet.length} quiet${baseline ? ' (baseline, no notifications)' : ''}`);
		}
		if (alert) {
			diff.alerts.push(alert);
		}
	});
	health.save(DATA_DIR, state);
	writeJson(DIFF_FILE, diff);
}

/** Store older articles from deeper feed pages, announcing nothing. One pass, no retries. */
async function deepen(sourceId, fromPage, pages) {
	if (!(fromPage >= 0 && pages >= 1 && pages <= MAX_DEEPEN_PAGES)) {
		fail(`--from-page must be 0 or more, and --pages 1 to ${MAX_DEEPEN_PAGES}`);
	}
	const source = loadSources(SOURCES_FILE).find((s) => s.id === sourceId);
	if (!source) {
		fail(`Unknown source: ${sourceId}`);
	}
	const oldState = differ.loadState(DATA_DIR, source.id);
	if (oldState === null) {
		fail(`${source.id} has no saved state yet; let the tracker run first`);
	}
	const known = new Set(oldState.map((i) => i.id));
	const older = (await jsonProvider.fetchFeed(source, null, { start: fromPage, pages })).filter((i) => !known.has(i.id));
	differ.writeSource(DATA_DIR, source.id, differ.merge(oldState, older), older);
	// A baseline, so nothing is announced.
	writeJson(DIFF_FILE, { sources: { [source.id]: { baseline: true, items: older.length, added: [], updated: [], quiet: 0 } }, alerts: [] });
	logger.success(`[${source.id}] ${older.length} older items stored. Next: --from-page ${fromPage + pages}`);
}

/** One commit per changed source, then a single push. Records each SHA in diff.json. */
function commit() {
	const diff = readJson(DIFF_FILE);
	for (const [sourceId, entry] of Object.entries(diff.sources)) {
		const message = entry.baseline ? `${sourceId}: baseline` : `${sourceId}: ${entry.added.length} new, ${entry.updated.length} updated`;
		entry.commit = gitops.commitPaths(DATA_DIR, [sourceId], message);
	}
	gitops.commitPaths(DATA_DIR, [health.HEALTH_FILE], 'health state');
	gitops.push(DATA_DIR); // a no-op when nothing was committed
	writeJson(DIFF_FILE, diff);
}

function writeOutbox() {
	const entries = outbox.buildTrackerEntries(readJson(DIFF_FILE), sourcesById(), repoUrl(), isoSeconds());
	outbox.write(OUTBOX_FILE, 'tracker', entries, process.env.ACTIONS_RUN_URL);
}

async function notify() {
	const messageId = await discord.sendLog(readJson(DIFF_FILE), sourcesById(), repoUrl(), process.env.ACTIONS_RUN_URL);
	if (messageId && process.env.GITHUB_OUTPUT) { // for the archive run the workflow starts next
		fs.appendFileSync(process.env.GITHUB_OUTPUT, `log_message=${messageId}\n`);
	}
	logger.success('Notify complete.');
}

/** The shop config, regions and families, narrowed by --region and --family. */
function shopTargets(region, family) {
	const config = loadShopConfig(SOURCES_FILE);
	const regions = Object.entries(config.regions).filter(([name]) => !region || name === region);
	const families = Object.keys(config.families).filter((slug) => !family || slug === family);
	if (!regions.length || !families.length) {
		fail(`Nothing to fetch: regions ${JSON.stringify(Object.keys(config.regions))}, families ${JSON.stringify(Object.keys(config.families))}`);
	}
	return [config, regions, families];
}

/** Print what each shop page lists, by section. Saves nothing. */
async function shopDryRun(region, family) {
	const [config, regions, families] = shopTargets(region, family);
	for (const [name, base] of regions) {
		const session = new shop.ShopSession();
		for (const slug of families) {
			const items = shop.parseItems(await shop.fetchFamily(session, base, slug));
			const sections = new Map();
			for (const item of Object.values(items)) {
				for (const section of item.sections) {
					sections.set(section, [...(sections.get(section) ?? []), item]);
				}
			}
			console.log(`\n== ${name} / ${slug}: ${Object.keys(items).length} items ==`);
			for (const [section, members] of sections) {
				console.log(`  ${section} (${members.length})`);
				members.forEach((item) => console.log(`    - ${shop.describe(item)}`));
			}
			await wait(config.fetch_delay_seconds * 1000);
		}
	}
}

/** Fetch the shop pages, write the changes under SHOP_DIR and list them in shop-diff.json. */
async function shopSweep(region, family) {
	const [config, regions, families] = shopTargets(region, family);
	const state = health.load(SHOP_DIR);
	const diff = { families: {}, alerts: [] };
	const now = isoSeconds();
	for (const [name, base] of regions) {
		const session = new shop.ShopSession();
		for (const [n, slug] of families.entries()) {
			if (n) {
				await wait(config.fetch_delay_seconds * 1000);
			}
			const label = shopDiffer.familyDir(name, slug);
			const watched = { id: label, failuresBeforeAlert: config.failures_before_alert };
			let items;
			try {
				items = shop.parseItems(await shop.fetchFamily(session, base, slug));
				if (!Object.keys(items).length) {
					throw new Error('no items (page changed?)');
				}
			} catch (error) {
				logger.error(`[${label}] failed: ${error.message}`);
				const alert = health.recordFailure(state, watched, error.message);
				if (alert) {
					diff.alerts.push(alert);
				}
				continue;
			}
			const alert = health.recordSuccess(state, watched);
			if (alert) {
				diff.alerts.push(alert);
			}
			const old = shopDiffer.loadState(SHOP_DIR, name, slug);
			const [fresh, changes] = await shopDiffer.sweep(old, items, now, config.gone_after_misses, (item) => shop.itemOnSale(session, base, slug, item));
			shopDiffer.writeFamily(SHOP_DIR, name, slug, fresh, changes, old === null);
			diff.families[label] = { baseline: old === null, items: Object.keys(items).length, changes };
			logger.success(`[${label}] ${Object.keys(items).length} items, ${changes.length} change(s)${old === null ? ' (baseline, nothing reported)' : ''}`);
		}
	}
	health.save(SHOP_DIR, state);
	writeJson(SHOP_DIFF_FILE, diff);
}

async function shopNotify() {
	const config = loadShopConfig(SOURCES_FILE);
	await discord.sendShopLog(readJson(SHOP_DIFF_FILE), config.families, config.regions, repoUrl(), process.env.ACTIONS_RUN_URL);
	logger.success('Notify complete.');
}

/** Once a day, tells the log channel about shop families that aren't in sources.yaml. */
async function shopFamilies() {
	const config = loadShopConfig(SOURCES_FILE);
	const file = path.join(SHOP_DIR, shopDiffer.META_FILE);
	const meta = fs.existsSync(file) ? readJson(file) : {};
	const now = isoSeconds();
	if (meta.last_family_check && Date.parse(now) - Date.parse(meta.last_family_check) < config.family_check_hours * 3600000) {
		return;
	}
	const base = Object.values(config.regions)[0];
	let slugs;
	try {
		slugs = await shop.homeFamilies(new shop.ShopSession(), base);
	} catch (error) {
		logger.warning(`Couldn't read the shop's home page: ${error.message}`);
		return;
	}
	const [fresh, updated] = shopDiffer.familyCheck(meta, slugs, Object.keys(config.families), now);
	if (fresh.length && !await discord.sendNewFamilies(fresh, base)) {
		return; // reported again next run
	}
	writeJson(file, updated);
	logger.success(`Shop families checked: ${fresh.length} new.`);
}

/** One commit per changed family, then a single push. Records each SHA in shop-diff.json. */
function shopCommit() {
	const diff = readJson(SHOP_DIFF_FILE);
	for (const [label, entry] of Object.entries(diff.families)) {
		const counts = new Map();
		for (const change of entry.changes) {
			const kind = change.type.replaceAll('_', ' ');
			counts.set(kind, (counts.get(kind) ?? 0) + 1);
		}
		const summary = entry.baseline ? 'baseline' : [...counts].map(([kind, n]) => `${n} ${kind}`).join(', ') || 'state';
		entry.commit = gitops.commitPaths(SHOP_DIR, [label], `${label}: ${summary}`);
	}
	gitops.commitPaths(SHOP_DIR, [health.HEALTH_FILE], 'health state');
	gitops.commitPaths(SHOP_DIR, [shopDiffer.META_FILE], 'family check');
	gitops.push(SHOP_DIR);
	writeJson(SHOP_DIFF_FILE, diff);
}

/** The shop run's posts for the bot, and the ledger of recent posts that lets the other region edit them. */
function shopOutbox() {
	const config = loadShopConfig(SOURCES_FILE);
	const diff = readJson(SHOP_DIFF_FILE);
	const now = isoSeconds();
	const fresh = Object.entries(diff.families).flatMap(([label, entry]) => entry.changes.map((change) => [...label.split('/'), { ...change, commit: entry.commit ?? null }]));
	const [events, ledger] = shopPosts.resolve(shopPosts.loadLedger(SHOP_DIR), fresh, now);
	const posts = shopPosts.plan(events, config.families);
	const states = {};
	if (posts.length) {
		for (const region of Object.keys(config.regions)) {
			for (const family of new Set(events.map((e) => e.family))) {
				states[shopDiffer.familyDir(region, family)] = shopDiffer.loadState(SHOP_DIR, region, family);
			}
		}
	}
	const entries = outbox.buildShopEntries(posts, states, sourcesById(), config.channel, repoUrl(), now);
	outbox.write(OUTBOX_FILE, 'shop', entries, process.env.ACTIONS_RUN_URL);
	shopPosts.saveLedger(SHOP_DIR, shopPosts.remember(ledger, posts, now));
	gitops.commitPaths(SHOP_DIR, [shopPosts.LEDGER_FILE], 'posted ledger');
	gitops.push(SHOP_DIR);
}

const USAGE = `Usage: node src/main.js [flags]

Page tracker: scrape -> commit -> notify
  --scrape          fetch sources, write files + diff.json
  --deepen          store older articles from deeper feed pages, announcing nothing
  --source ID       with --deepen: the source id
  --from-page N     with --deepen: first page to read (default 10)
  --pages N         with --deepen: how many pages to read (default 10)
  --commit          commit per source, push, record SHAs in diff.json
  --outbox          write outbox.json from diff.json, for the bot
  --notify          post the run summary to the log channel
  --shop            Battle.net Shop tracking: fetch, write changes + shop-diff.json
  --dry-run         with --shop: print what the shop lists, save nothing
  --region R        with --shop: only this region (eu or us)
  --family SLUG     with --shop: only this shop family slug
  --shop-families   once a day, report shop families that aren't in sources.yaml
  --shop-commit     commit the shop run per family, push, record SHAs in shop-diff.json
  --shop-outbox     write outbox.json from shop-diff.json, for the bot
  --shop-notify     post the shop run summary to the log channel`;

const flag = { type: 'boolean' };
const ACTIONS = ['scrape', 'deepen', 'commit', 'outbox', 'notify', 'shop', 'shop-commit', 'shop-families', 'shop-outbox', 'shop-notify'];
const args = parseFlags({
	...Object.fromEntries(ACTIONS.map((name) => [name, flag])), 'dry-run': flag,
	'source': { type: 'string' }, 'from-page': { type: 'string', default: '10' }, 'pages': { type: 'string', default: '10' },
	'region': { type: 'string' }, 'family': { type: 'string' },
}, USAGE, ACTIONS);

if (args.scrape) {
	await scrape();
}
if (args.deepen) {
	await deepen(args.source, Number(args['from-page']), Number(args.pages));
}
if (args.commit) {
	commit();
}
if (args.outbox) {
	writeOutbox();
}
if (args.notify) {
	await notify();
}
if (args.shop) {
	await (args['dry-run'] ? shopDryRun : shopSweep)(args.region, args.family);
}
if (args['shop-families']) {
	await shopFamilies();
}
if (args['shop-commit']) {
	shopCommit();
}
if (args['shop-outbox']) {
	shopOutbox();
}
if (args['shop-notify']) {
	await shopNotify();
}
