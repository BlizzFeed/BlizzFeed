import { logger } from '../log.js';
import { writeJson } from '../json.js';
import { isoSeconds } from '../time.js';
import { FEED_TIERS, ref } from '../processors/shop_posts.js';
import { feedsFor, logoFor, postFor } from '../processors/youtube_posts.js';
import * as discord from './discord.js';
import * as shopMessages from './shop_messages.js';
import * as youtubeMessages from './youtube_messages.js';

const OUTBOX_VERSION = 1;
// Tier channels each kind of post goes to
const ROUTES = { added: ['all', 'new'], updated: ['all', 'updated'], edited: ['all', 'updated'] };

const channels = (source, kind) => [...new Set(ROUTES[kind].flatMap((tier) => source.tierChannels[tier]))];
const commitUrl = (repoUrl, commit) => (repoUrl && commit ? `${repoUrl}/commit/${commit}` : null);

/** One entry per channel. awaits_text: the message has the text-check note, which the bot removes when the archive run
 * reports the article checked or edited. */
function perChannel(source, kind, item, message, detected) {
	const entry = { source: source.id, source_name: source.name, article: item.id, kind, detected, title: item.title, url: item.url, message };
	if (item.awaits_text) {
		entry.awaits_text = true;
	}
	return channels(source, kind).map((channel) => ({ channel, ...entry }));
}

function warnUnset(source) {
	if (source.unsetChannels.length) {
		logger.warning(`${source.id}: no channel ID for ${source.unsetChannels.join(', ')}; skipping those.`);
	}
}

/** sources maps id to Source. */
export function buildTrackerEntries(diff, sources, repoUrl, detected) {
	const out = [];
	for (const [sourceId, entry] of Object.entries(diff.sources)) {
		if (!entry.added.length && !entry.updated.length) {
			continue;
		}
		const source = sources[sourceId];
		warnUnset(source);
		for (const kind of ['added', 'updated']) {
			for (const item of entry[kind]) {
				const message = discord.buildItemMessage(kind, item, commitUrl(repoUrl, entry.commit), repoUrl, {
					summary: discord.summaryUrl(repoUrl, entry.commit, sourceId, item.id),
					archived: discord.archiveUrl(repoUrl, sourceId, item.id),
					history: discord.historyUrl(repoUrl, sourceId, item.id),
					logo: source.logo,
				});
				out.push(...perChannel(source, kind, item, message, detected));
			}
		}
	}
	return out;
}

export function buildArchiveEntries(diff, sources, repoUrl, detected) {
	const out = [];
	for (const [sourceId, entry] of Object.entries(diff.sources)) {
		const edits = entry.articles.filter((c) => c.kind === 'text');
		if (!edits.length) {
			continue;
		}
		const source = sources[sourceId];
		warnUnset(source);
		for (const change of edits) {
			const message = discord.buildEditMessage(change, repoUrl, sourceId, commitUrl(repoUrl, change.commit), source.logo);
			out.push(...perChannel(source, 'edited', change, message, detected));
		}
	}
	return out;
}

/** Articles the archive re-checked without finding an edit, so the bot can remove the text-check note. */
export const buildArchiveChecked = (diff) => Object.entries(diff.sources)
	.flatMap(([source, entry]) => (entry.checked ?? []).map((article) => ({ source, article })));

/** Shop links found in the text of articles whose feed card had none, for the bot to add the button. */
export const buildArchiveShops = (diff) => Object.entries(diff.sources)
	.flatMap(([source, entry]) => (entry.shops ?? []).map((shop) => ({ source, article: shop.id, url: shop.url })));

/** states maps 'region/family' to its state. An edit entry replaces the earlier post with the same ref. */
export function buildShopEntries(posts, states, sources, shopChannel, repoUrl, detected) {
	const out = [];
	for (const post of posts) {
		const [kind, sourceId] = post.destination;
		const source = sources[post.game];
		const { events } = post;
		const changes = Object.values(events[0].changes);
		const commit = changes.at(-1).commit;
		const single = post.kind === 'single';
		const message = single
			? shopMessages.buildSingle(events, states, source.logo, repoUrl, commit, detected, kind)
			: shopMessages.buildDigest(post, states, source.logo, repoUrl, commit, detected, kind);
		const title = single ? changes[0].title || events[0].key : shopMessages.digestTitle(post.type, events.length);
		let targets;
		let name;
		if (kind === 'feed') {
			const feed = sources[sourceId];
			const types = post.kind === 'digest' ? [post.type] : events.map((e) => e.type);
			const tiers = [...new Set(types.flatMap((type) => FEED_TIERS[type]))].sort(); // only feed types reach a feed
			targets = tiers.flatMap((tier) => feed.tierChannels[tier]);
			name = feed.name;
		} else {
			targets = shopChannel ? [shopChannel] : [];
			name = 'Battle.net Shop';
		}
		const postRef = single ? ref(events[0]) : null;
		const entry = { source: sourceId ?? 'shop', source_name: name, article: postRef ?? title, kind: 'shop', detected, title,
			url: shopMessages.SHOP_URL, message, ref: postRef, edit: post.edit };
		out.push(...[...new Set(targets)].map((channel) => ({ channel, ...entry })));
	}
	return out;
}

/** states maps a channel handle to its saved state; config is loadYoutubeConfig's. One entry per channel a change goes to:
 * #youtube always, and the game feeds the video is routed to. A change to a stream's phase carries the ref of the post it edits. */
export function buildYoutubeEntries(diff, config, states, repoUrl, detected) {
	const out = [];
	for (const [handle, entry] of Object.entries(diff.channels)) {
		const channel = config.channels[handle];
		for (const change of entry.changes) {
			const stored = states[handle]?.videos[change.id];
			if (!stored) {
				continue;
			}
			const video = { id: change.id, ...stored };
			const post = postFor(change, video);
			const message = youtubeMessages.buildVideoMessage(video, { name: channel.name, logo: logoFor(channel, video) },
				{ change: change.type === 'edited' ? change : null, repoUrl, commitUrl: commitUrl(repoUrl, entry.commit), now: detected });
			const feeds = feedsFor(channel, video).flatMap((label) => post.tiers.map((tier) => config.labels[label]?.[tier]));
			const targets = new Set([config.channel, ...feeds].filter(Boolean));
			const fields = { source: `youtube:${handle}`, source_name: channel.name, article: video.id, kind: post.kind, detected, title: video.title,
				url: youtubeMessages.watchUrl(video), message };
			if (post.ref) {
				Object.assign(fields, { ref: post.ref, edit: post.edit, edit_for: config.stream_edit_days * 86400 });
			}
			out.push(...[...targets].map((target) => ({ channel: target, ...fields })));
		}
	}
	return out;
}

/** Writes nothing when empty, so no artifact is uploaded. */
export function write(file, workflow, entries, runUrl, checked = [], shops = []) {
	if (!entries.length && !checked.length && !shops.length) {
		logger.info('Nothing for the outbox.');
		return;
	}
	const runId = process.env.GITHUB_RUN_ID;
	const outbox = { version: OUTBOX_VERSION, workflow, run_id: runId ? Number(runId) : null, run_url: runUrl ?? null,
		created: isoSeconds(), entries };
	if (checked.length) {
		outbox.checked = checked;
	}
	if (shops.length) {
		outbox.shops = shops;
	}
	writeJson(file, outbox);
	logger.success(`Outbox: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`
		+ `${checked.length ? `, ${checked.length} checked` : ''}${shops.length ? `, ${shops.length} shop link(s)` : ''}.`);
}
