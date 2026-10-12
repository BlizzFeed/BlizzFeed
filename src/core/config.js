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

export function loadSources(path) {
	const config = readConfig(path);
	// A label left empty (WOW:) has no IDs, so its sources warn and skip it like an empty ID.
	const channelIds = Object.fromEntries(Object.entries(config.channels ?? {}).map(([label, ids]) => [
		String(label), Object.fromEntries(TIERS.filter((tier) => ids?.[tier]).map((tier) => [tier, channelId(ids[tier], `channels.${label}.${tier}`)])),
	]));
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
