import fs from 'node:fs';
import YAML from 'yaml';

const DEFAULT_FAILURES_BEFORE_ALERT = 3;
export const TIERS = ['all', 'new', 'updated'];

/** sources.yaml, which shares source settings with merge keys (<<: *anchor). */
export const readConfig = (path) => YAML.parse(fs.readFileSync(path, 'utf8'), { merge: true });

/** An unquoted channel ID is read as a number, which can't hold its 19 digits. */
function channelId(value, where) {
	if (typeof value === 'number') {
		throw new Error(`sources.yaml: put the channel ID at ${where} in quotes, or it loses its last digits`);
	}
	return String(value);
}

export class Source {
	constructor(raw, defaults, channelIds = {}) {
		this.raw = raw;
		this.id = raw.id;
		this.name = raw.name ?? raw.id;
		this.logo = raw.logo ?? null;
		this.type = raw.type;
		this.url = raw.url;
		this.failuresBeforeAlert = raw.failures_before_alert ?? defaults.failures_before_alert ?? DEFAULT_FAILURES_BEFORE_ALERT;
		// news.blizzard.com/<locale>/...: the page the archive fetches is /<locale>/article/<id>.
		this.locale = new URL(this.url).pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
		this.tierChannels = Object.fromEntries(TIERS.map((tier) => [tier, []]));
		this.unsetChannels = [];
		for (const label of [raw.channels ?? []].flat()) {
			for (const tier of TIERS) {
				const id = channelIds[label]?.[tier];
				if (id) {
					this.tierChannels[tier].push(id);
				} else {
					this.unsetChannels.push(`${label}/${tier}`);
				}
			}
		}
	}
}

/** The channels: block as { label: { tier: channel id } }. A label left empty (WOW:) has no IDs, so what uses it warns and skips it. */
export const labelChannels = (config) => Object.fromEntries(Object.entries(config.channels ?? {}).map(([label, ids]) => [
	String(label), Object.fromEntries(TIERS.filter((tier) => ids?.[tier]).map((tier) => [tier, channelId(ids[tier], `channels.${label}.${tier}`)])),
]));

export function loadSources(path) {
	const config = readConfig(path);
	const channelIds = labelChannels(config);
	return config.sources.map((raw) => new Source(raw, config.defaults ?? {}, channelIds));
}

const ARCHIVE_DEFAULTS = {
	window_days: 7, sweep_minutes: 55, max_fetches: 60, fetch_delay_seconds: 2, backfill_max_fetches: 150,
	backfill_delay_seconds: 1, body_selector: 'article.Content section.blog', failures_before_alert: 3, baseline_days: 30,
};

/** The archive: block of sources.yaml over the defaults. */
export const loadArchiveConfig = (path) => ({ ...ARCHIVE_DEFAULTS, ...readConfig(path).archive });

const SHOP_DEFAULTS = {
	regions: {}, sweep_minutes: 5, fetch_delay_seconds: 1, gone_after_misses: 3, failures_before_alert: 3,
	retry_minutes: [2, 5, 15, 30], family_check_hours: 24, families: {}, channel: null,
};

/** The shop: block of sources.yaml over the defaults. */
export function loadShopConfig(path) {
	const config = { ...SHOP_DEFAULTS, ...readConfig(path).shop };
	channelId(config.channel, 'shop.channel');
	return config;
}

export const YOUTUBE_KINDS = ['video', 'short', 'stream'];

const YOUTUBE_DEFAULTS = {
	channel: null, daily_units: 9000, min_sweep_minutes: 2, failures_before_alert: 3, stream_edit_days: 14, channels: {},
	logo_url: 'https://raw.githubusercontent.com/BlizzFeed/BlizzFeed/main/logos/games/{}.png',
};

/** The youtube: block over the defaults. A feed label not under channels: would drop posts silently, so it throws. */
export function loadYoutubeConfig(path) {
	const root = readConfig(path);
	const config = { ...YOUTUBE_DEFAULTS, ...root.youtube, labels: labelChannels(root) };
	if (config.channel) {
		config.channel = channelId(config.channel, 'youtube.channel');
	}
	config.channels = Object.fromEntries(Object.entries(config.channels ?? {}).map(([handle, raw]) => {
		const kinds = raw.kinds ?? YOUTUBE_KINDS;
		const feeds = raw.feeds ?? [];
		if (!/^UC[\w-]{22}$/.test(raw.id ?? '')) {
			throw new Error(`sources.yaml: youtube.channels.${handle}.id isn't a channel ID (UC...)`);
		}
		for (const kind of kinds.filter((k) => !YOUTUBE_KINDS.includes(k))) {
			throw new Error(`sources.yaml: youtube.channels.${handle}.kinds has "${kind}", expected ${YOUTUBE_KINDS.join(', ')}`);
		}
		const unknown = (labels, where) => {
			for (const label of labels.filter((l) => !(l in (root.channels ?? {})))) {
				throw new Error(`sources.yaml: youtube.channels.${handle}.${where} has "${label}", which isn't under channels:`);
			}
		};
		unknown(feeds, 'feeds');
		// A route without a match would be an empty pattern, which matches every title.
		// A logo is a name in logos/games (world-of-warcraft), made into the URL it is hosted at.
		const logoUrl = (logo, where) => {
			if (logo === undefined) {
				return null;
			}
			if (!/^[a-z0-9-]+$/.test(logo ?? '')) {
				throw new Error(`sources.yaml: youtube.channels.${handle}.${where} "${logo}" isn't a logo name (like world-of-warcraft)`);
			}
			return config.logo_url.replace('{}', logo);
		};
		const routes = (raw.routes ?? []).map((route, n) => {
			const where = `sources.yaml: youtube.channels.${handle}.routes[${n}]`;
			if (typeof route.match !== 'string' || !route.match) {
				throw new Error(`${where} has no match`);
			}
			unknown(route.feeds ?? [], `routes[${n}].feeds`);
			let pattern;
			try {
				pattern = new RegExp(route.match, route.case ? '' : 'i');
			} catch (error) {
				throw new Error(`${where}.match isn't a valid pattern: ${error.message}`);
			}
			return { pattern, feeds: route.feeds ?? [], logo: logoUrl(route.logo, `routes[${n}].logo`) };
		});
		return [handle, { id: raw.id, name: raw.name ?? handle, feeds, kinds, routes, logo: logoUrl(raw.logo, 'logo') }];
	}));
	return config;
}

/** Minutes between sweeps, so a sweep (a call per channel plus the shared video lookup) fits daily_units. */
export const youtubeSweepMinutes = (config) => Math.max(config.min_sweep_minutes, Math.ceil((Object.keys(config.channels).length + 1) * 1440 / config.daily_units));
