import json
import os
from datetime import datetime, timezone

from loguru import logger

from modules.notifiers import discord

OUTBOX_VERSION = 1
# Tier channels each kind of post goes to
ROUTES = {"added": ("all", "new"), "updated": ("all", "updated"), "edited": ("all", "updated")}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _channels(source, kind):
    ids = []
    for tier in ROUTES[kind]:
        ids += source.tier_channels[tier]
    return list(dict.fromkeys(ids))


def _entries(source, kind, item, message, detected):
    """One entry per channel."""
    return [{"channel": channel, "source": source.id, "source_name": source.name, "article": item["id"],
             "kind": kind, "detected": detected, "title": item["title"], "url": item["url"], "message": message}
            for channel in _channels(source, kind)]


def _warn_unset(source):
    if source.unset_channels:
        logger.warning(f"{source.id}: no channel ID for {', '.join(source.unset_channels)}; skipping those.")


def build_tracker_entries(diff, sources, repo_url, detected):
    entries = []
    for source_id, entry in diff["sources"].items():
        if not (entry["added"] or entry["updated"]):
            continue
        source = sources[source_id]
        _warn_unset(source)
        commit_url = f"{repo_url}/commit/{entry['commit']}" if repo_url and entry.get("commit") else None
        for kind in ("added", "updated"):
            for item in entry[kind]:
                summary = discord.summary_url(repo_url, entry.get("commit"), source_id, item["id"])
                archived = discord.archive_url(repo_url, source_id, item["id"])
                history = discord.history_url(repo_url, source_id, item["id"])
                message = discord.build_item_message(kind, item, commit_url, repo_url,
                                                     summary=summary, archived=archived, history=history)
                entries += _entries(source, kind, item, message, detected)
    return entries


def build_archive_entries(diff, sources, repo_url, detected):
    entries = []
    for source_id, entry in diff["sources"].items():
        edits = [c for c in entry["articles"] if c["kind"] == "text"]
        if not edits:
            continue
        source = sources[source_id]
        _warn_unset(source)
        for change in edits:
            commit_url = f"{repo_url}/commit/{change['commit']}" if repo_url and change.get("commit") else None
            message = discord.build_edit_message(change, repo_url, source_id, commit_url)
            entries += _entries(source, "edited", change, message, detected)
    return entries


def write(path, workflow, entries, run_url):
    """Writes nothing when empty, so no artifact is uploaded."""
    if not entries:
        logger.info("Nothing for the outbox.")
        return
    run_id = os.environ.get("GITHUB_RUN_ID")
    outbox = {"version": OUTBOX_VERSION, "workflow": workflow, "run_id": int(run_id) if run_id else None,
              "run_url": run_url, "created": now_iso(), "entries": entries}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(outbox, f, indent=2, ensure_ascii=False)
    logger.success(f"Outbox: {len(entries)} entr{'y' if len(entries) == 1 else 'ies'}.")
