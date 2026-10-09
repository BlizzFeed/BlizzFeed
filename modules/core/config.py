from urllib.parse import urlparse

import yaml

DEFAULT_FAILURES_BEFORE_ALERT = 3
TIERS = ("all", "new", "updated")


class Source:
    def __init__(self, raw, defaults, channel_ids=None):
        self.raw = raw
        self.id = raw["id"]
        self.name = raw.get("name", self.id)
        self.logo = raw.get("logo")
        self.type = raw["type"]
        self.url = raw["url"]
        self.failures_before_alert = raw.get(
            "failures_before_alert",
            defaults.get("failures_before_alert", DEFAULT_FAILURES_BEFORE_ALERT),
        )
        # news.blizzard.com/<locale>/...: the page the archive fetches is /<locale>/article/<id>.
        self.locale = urlparse(self.url).path.strip("/").split("/")[0]
        # Channel IDs per tier. Labels without an ID are listed in unset_channels.
        channel_labels = raw.get("channels") or []
        if isinstance(channel_labels, str):
            channel_labels = [channel_labels]
        channel_ids = channel_ids or {}
        self.tier_channels = {tier: [] for tier in TIERS}
        self.unset_channels = []
        for label in channel_labels:
            for tier in TIERS:
                if channel_id := channel_ids.get(label, {}).get(tier):
                    self.tier_channels[tier].append(channel_id)
                else:
                    self.unset_channels.append(f"{label}/{tier}")


def load_sources(path):
    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    defaults = cfg.get("defaults") or {}
    # A label left empty (WOW:) has no IDs, so its sources warn and skip it like an empty ID.
    channel_ids = {str(label): {tier: str(ids[tier]) for tier in TIERS if (ids or {}).get(tier)}
                   for label, ids in (cfg.get("channels") or {}).items()}
    return [Source(s, defaults, channel_ids) for s in cfg["sources"]]


ARCHIVE_DEFAULTS = {
    "window_days": 7,
    "sweep_minutes": 55,
    "max_fetches": 60,
    "fetch_delay_seconds": 2,
    "backfill_max_fetches": 150,
    "backfill_delay_seconds": 1,
    "body_selector": "article.Content section.blog",
    "failures_before_alert": 3,
    "baseline_days": 30,
}


def load_archive_config(path):
    """The archive: block of sources.yaml over the defaults."""
    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    return {**ARCHIVE_DEFAULTS, **(cfg.get("archive") or {})}


SHOP_DEFAULTS = {
    "regions": {},
    "sweep_minutes": 5,
    "fetch_delay_seconds": 1,
    "gone_after_misses": 3,
    "failures_before_alert": 3,
    "retry_minutes": [2, 5, 15, 30],
    "family_check_hours": 24,
    "families": {},
}


def load_shop_config(path):
    """The shop: block of sources.yaml over the defaults."""
    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    channel = ((cfg.get("channels") or {}).get("SHOP") or {}).get("all")
    return {**SHOP_DEFAULTS, **(cfg.get("shop") or {}), "channel": str(channel) if channel else None}
