import os
from urllib.parse import quote

import yaml

DEFAULT_FAILURES_BEFORE_ALERT = 3
# Discord doesn't show SVG avatars, so logos go through this free proxy, which returns a PNG.
AVATAR_PROXY = "https://wsrv.nl/?output=png&w=256&h=256&fit=contain&url="


class Source:
    def __init__(self, raw, defaults, ping_roles):
        self.raw = raw
        self.id = raw["id"]
        self.name = raw.get("name", self.id)
        self.type = raw["type"]
        self.url = raw["url"]
        self.failures_before_alert = raw.get(
            "failures_before_alert",
            defaults.get("failures_before_alert", DEFAULT_FAILURES_BEFORE_ALERT),
        )
        self.username = raw.get("username")
        avatar = raw.get("avatar")
        self.avatar_url = AVATAR_PROXY + quote(avatar, safe="") if avatar else None
        labels = raw.get("webhook") or []
        if isinstance(labels, str):
            labels = [labels]
        # The first channel is the source's own, any others are shared. Labels whose secret isn't set are skipped.
        self.missing_labels = [label for label in labels if not os.environ.get(f"DISCORD_WEBHOOK_{label}")]
        self.channels = [
            {"url": url, "role": ping_roles.get(label)}
            for label in labels
            if (url := os.environ.get(f"DISCORD_WEBHOOK_{label}"))
        ]


def load_sources(path):
    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    defaults = cfg.get("defaults") or {}
    ping_roles = {str(label): str(role) for label, role in (cfg.get("ping_roles") or {}).items()}
    return [Source(s, defaults, ping_roles) for s in cfg["sources"]]
