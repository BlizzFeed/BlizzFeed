import json
import os
from datetime import datetime, timezone

HEALTH_FILE = "_health.json"


def load(data_dir):
    path = os.path.join(data_dir, HEALTH_FILE)
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save(data_dir, health):
    with open(os.path.join(data_dir, HEALTH_FILE), "w", encoding="utf-8", newline="\n") as f:
        json.dump(health, f, indent=2, sort_keys=True)
        f.write("\n")


def record_failure(health, source, error):
    """Count consecutive failures; return a 'down' alert on the run the count reaches the threshold.

    The count stops at the threshold, so an ongoing outage leaves the file (and the
    data branch) unchanged instead of committing every run.
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entry = health.setdefault(source.id, {"failures": 0, "since": now})
    if entry["failures"] < source.failures_before_alert:
        entry["failures"] += 1
        if entry["failures"] == source.failures_before_alert:
            return {"source": source.id, "kind": "down", "error": error[:300], "since": entry["since"]}
    return None


def record_success(health, source):
    """Clear the streak; return a 'recovered' alert if a 'down' alert was sent."""
    entry = health.pop(source.id, None)
    if entry and entry["failures"] >= source.failures_before_alert:
        return {"source": source.id, "kind": "recovered", "since": entry["since"]}
    return None
