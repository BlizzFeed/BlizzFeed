// Article archive: fetch -> commit -> outbox -> notify.
import { setTimeout as wait } from 'node:timers/promises';
import { SOURCES_FILE, fail, parseFlags, readJson, repoUrl } from './cli.js';
import { writeJson } from './json.js';
import { logger } from './log.js';
import { isoSeconds } from './time.js';
import * as gitops from './core/gitops.js';
import * as health from './core/health.js';
import { loadArchiveConfig, loadSources } from './core/config.js';
import * as discord from './notifiers/discord.js';
import * as outbox from './notifiers/outbox.js';
import * as archiver from './processors/archiver.js';
import * as differ from './processors/differ.js';
import { toMarkdown } from './processors/markdown.js';
import { ArticleGone, BodyNotFound, fetchBody } from './providers/article.js';

const DATA_DIR = process.env.DATA_DIR ?? 'data';
const ARCHIVE_DIR = process.env.ARCHIVE_DIR ?? 'archive';
const DIFF_FILE = process.env.ARCHIVE_DIFF_FILE ?? 'archive-diff.json';
const OUTBOX_FILE = process.env.OUTBOX_FILE ?? 'outbox.json';
const COMMIT_VERBS = { archived: 'archived', text: 'text edited:', card: 'summary changed:', reformatted: 'reformatted:' };

const sourcesById = () => Object.fromEntries(loadSources(SOURCES_FILE).map((s) => [s.id, s]));

/** Fetch and save one article: [its change entry, or null when nothing changed; its text's shop link or '']. Throws
 * ArticleGone for a 404 or 410, and anything else for a failed fetch. Never writes a bad file. */
async function archiveOne(source, item, index, cfg, reformat) {
	const text = toMarkdown(await fetchBody(source.locale, item.id, cfg.body_selector));
	const content = archiver.renderFile(item, text);
	const old = archiver.readArticle(ARCHIVE_DIR, source.id, item.id);
	const shop = archiver.findShopUrl(text);
	let kind = archiver.classify(old, content);
	if (kind === null) {
		return [null, shop];
	}
	if (kind === 'text' && reformat) {
		kind = 'reformatted'; // most likely our converter changed, not the article, so it isn't posted
	}
	archiver.writeArticle(ARCHIVE_DIR, source.id, item.id, content);
	const entry = { id: item.id, title: item.title, kind, url: item.url, summary: item.summary, image: item.image, path: archiver.articlePath(source.id, item.id) };
	if (kind === 'text') {
		[entry.added, entry.changed, entry.removed] = archiver.lineChanges(archiver.splitFile(old)[1], archiver.splitFile(content)[1]);
		entry.silent = index[item.id] === item.date; // the date didn't move, so only the window sweep could have found this edit
	}
	return [entry, shop];
}

/** backfill: only articles the archive has never seen, and stop at the first failed fetch. */
async function fetchArticles(backfill, onlySource) {
	const cfg = loadArchiveConfig(SOURCES_FILE);
	const now = new Date();
	const archiveState = archiver.loadArchiveState(ARCHIVE_DIR);
	// A new converter version re-checks the whole window at once, so no old-format file is left to show up as an edit later.
	const reformat = !backfill && archiveState.converter !== archiver.CONVERTER_VERSION;
	const sweep = !backfill && (reformat || archiver.sweepDue(archiveState, cfg.sweep_minutes, now));

	let sources = loadSources(SOURCES_FILE);
	if (onlySource) {
		sources = sources.filter((s) => s.id === onlySource);
		if (!sources.length) {
			fail(`Unknown source: ${onlySource}`);
		}
	}
	const indexes = {};
	const states = {};
	const candidates = [];
	for (const source of sources) {
		const items = differ.loadState(DATA_DIR, source.id);
		if (items === null) {
			continue;
		}
		states[source.id] = items;
		indexes[source.id] = archiver.loadIndex(ARCHIVE_DIR, source.id);
		if (backfill) {
			candidates.push(...archiver.planBackfill(items, indexes[source.id]).map((item) => [source, item, 'backfill']));
		} else {
			candidates.push(...archiver.plan(items, indexes[source.id], now, cfg, sweep).map(([item, reason]) => [source, item, reason]));
		}
	}
	const [limit, delay] = backfill ? [cfg.backfill_max_fetches, cfg.backfill_delay_seconds] : [cfg.max_fetches, cfg.fetch_delay_seconds];
	const selected = archiver.select(candidates, limit);
	logger.info(`${candidates.length} article(s) due, fetching ${selected.length}${sweep ? ' (window sweep included)' : ''}`);

	// Old pages can have other markup, so in a backfill an unreadable body is skipped like a 404/410.
	const skipped = (error) => error instanceof ArticleGone || (backfill && error instanceof BodyNotFound);
	const diff = { sweep, sources: {}, alerts: [] };
	for (const [n, [source, item, reason]] of selected.entries()) {
		if (n) {
			await wait(delay * 1000);
		}
		const entry = (diff.sources[source.id] ??= { articles: [], gone: [], failed: 0, checked: [], shops: [] });
		let change = null;
		let shop = '';
		try {
			[change, shop] = await archiveOne(source, item, indexes[source.id], cfg, reformat);
		} catch (error) {
			if (!skipped(error)) {
				logger.error(`[${source.id}] ${item.id} failed: ${error.message}`);
				entry.failed++;
				entry.error ??= error.message;
				if (backfill) {
					break;
				}
				continue; // left out of the index, so the next run tries it again
			}
			logger.warning(`[${source.id}] ${item.id} can't be archived (${error.constructor.name}), skipping it`);
			entry.gone.push(item.id);
		}
		if (change) {
			entry.articles.push(change);
			logger.success(`[${source.id}] ${change.kind}: ${item.title}`);
		}
		if (shop && reason === 'changed' && !item.shop_url) {
			entry.shops.push({ id: item.id, url: shop });
		}
		// A date bump the tracker may have posted with the text-check note, and no text edit to follow it.
		if (reason === 'changed' && change?.kind !== 'text') {
			entry.checked.push(item.id);
		}
		indexes[source.id][item.id] = item.date;
	}

	// After the fetches, so a file written this run counts.
	for (const [sourceId, items] of Object.entries(states)) {
		const saved = archiver.fillShopUrls(ARCHIVE_DIR, items, sourceId);
		if (saved) {
			differ.writeSource(DATA_DIR, sourceId, items, []);
			(diff.shop_urls ??= {})[sourceId] = saved;
		}
	}

	if (backfill) {
		for (const [sourceId, entry] of Object.entries(diff.sources)) {
			entry.left = candidates.filter(([s, item]) => s.id === sourceId && !(item.id in indexes[sourceId])).length;
		}
	}

	const healthState = health.load(ARCHIVE_DIR);
	for (const [sourceId, entry] of Object.entries(diff.sources)) {
		archiver.saveIndex(ARCHIVE_DIR, sourceId, indexes[sourceId]);
		// The alert threshold is the archive's own, not the feed's.
		const watched = { id: sourceId, failuresBeforeAlert: cfg.failures_before_alert };
		const alert = entry.failed ? health.recordFailure(healthState, watched, entry.error) : health.recordSuccess(healthState, watched);
		if (alert) {
			diff.alerts.push(alert);
		}
	}
	if (sweep) {
		archiveState.last_sweep = isoSeconds(now);
	}
	// Only once everything due was fetched; otherwise the next run carries on reformatting.
	if (!backfill && selected.length === candidates.length && !Object.values(diff.sources).some((e) => e.failed)) {
		archiveState.converter = archiver.CONVERTER_VERSION;
	}
	archiver.saveArchiveState(ARCHIVE_DIR, archiveState);
	health.save(ARCHIVE_DIR, healthState);
	writeJson(DIFF_FILE, diff);
}

/** Commit and push the links fetchArticles() saved. A rejected push (the tracker pushed first) is only logged: posts must not
 * wait for it, and the next run finds the links again. */
function saveShopUrls(diff) {
	if (!diff.shop_urls) {
		return;
	}
	for (const [sourceId, saved] of Object.entries(diff.shop_urls)) {
		gitops.commitPaths(DATA_DIR, [`${sourceId}/state.json`], `${sourceId}: ${saved} shop links saved`);
	}
	try {
		gitops.push(DATA_DIR);
	} catch (error) {
		logger.warning(`Shop links not saved to the data branch this run: ${error.message}`);
	}
}

/** One commit per changed article, one for the run's state files, then a single push. */
function commit() {
	const diff = readJson(DIFF_FILE);
	for (const [sourceId, entry] of Object.entries(diff.sources)) {
		for (const change of entry.articles) {
			change.commit = gitops.commitPaths(ARCHIVE_DIR, [change.path], `${sourceId}: ${COMMIT_VERBS[change.kind]} ${change.title}`);
		}
	}
	const statePaths = Object.keys(diff.sources).map((sourceId) => `${sourceId}/index.json`);
	gitops.commitPaths(ARCHIVE_DIR, [...statePaths, archiver.ARCHIVE_STATE_FILE, health.HEALTH_FILE], 'archive state');
	gitops.push(ARCHIVE_DIR); // a no-op when nothing was committed
	saveShopUrls(diff);
	writeJson(DIFF_FILE, diff);
}

function writeOutbox() {
	const diff = readJson(DIFF_FILE);
	const entries = outbox.buildArchiveEntries(diff, sourcesById(), repoUrl(), isoSeconds());
	outbox.write(OUTBOX_FILE, 'archive', entries, process.env.ACTIONS_RUN_URL, outbox.buildArchiveChecked(diff), outbox.buildArchiveShops(diff));
}

async function notify() {
	await discord.sendArchiveLog(readJson(DIFF_FILE), sourcesById(), repoUrl(), process.env.ACTIONS_RUN_URL, process.env.LOG_MESSAGE || null);
	logger.success('Notify complete.');
}

const USAGE = `Usage: node src/archive.js [flags]

Article archive: fetch -> commit -> notify
  --fetch       fetch due articles, write files + archive-diff.json
  --backfill    with --fetch: only articles never archived, newest first
  --source ID   with --fetch: only this source id
  --commit      commit per article, push, record SHAs in archive-diff.json
  --outbox      write outbox.json from archive-diff.json, for the bot
  --notify      post the run summary to the log channel`;

const flag = { type: 'boolean' };
const ACTIONS = ['fetch', 'commit', 'outbox', 'notify'];
const args = parseFlags({ ...Object.fromEntries(ACTIONS.map((name) => [name, flag])), backfill: flag, source: { type: 'string' } }, USAGE, ACTIONS);

if (args.fetch) {
	await fetchArticles(args.backfill, args.source);
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
