import os
import yaml

DEFAULT_FAILURES_BEFORE_ALERT = 3


class Source:
    def __init__(self, raw, defaults):
        self.raw = raw
        self.id = raw["id"]
        self.name = raw.get("name", self.id)
        self.type = raw["type"]
        self.url = raw["url"]
        self.ping_role = raw.get("ping_role")
        self.failures_before_alert = raw.get(
            "failures_before_alert",
            defaults.get("failures_before_alert", DEFAULT_FAILURES_BEFORE_ALERT),
        )
        webhook = raw.get("webhook")
        self.webhook_url = os.environ.get(f"DISCORD_WEBHOOK_{webhook}") if webhook else None


def load_sources(path):
    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    defaults = cfg.get("defaults") or {}
    return [Source(s, defaults) for s in cfg["sources"]]
