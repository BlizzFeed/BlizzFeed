import json
import os
from datetime import datetime, timezone

from loguru import logger

from modules.notifiers import discord, shop_messages
from modules.processors import shop_posts

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
    """One entry per channel. awaits_text: the message has the text-check note, which the bot removes when the
    archive run reports the article checked or edited."""
    entry = {"source": source.id, "source_name": source.name, "article": item["id"], "kind": kind,
             "detected": detected, "title": item["title"], "url": item["url"], "message": message}
    if item.get("awaits_text"):
        entry["awaits_text"] = True
    return [{"channel": channel, **entry} for channel in _channels(source, kind)]


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
                                                     summary=summary, archived=archived, history=history,
                                                     logo=source.logo)
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
            message = discord.build_edit_message(change, repo_url, source_id, commit_url, logo=source.logo)
            entries += _entries(source, "edited", change, message, detected)
    return entries


def build_archive_checked(diff):
    """The articles whose text this archive run re-checked without finding an edit, so the bot can remove the
    text-check note from their updated posts."""
    return [{"source": source_id, "article": article}
            for source_id, entry in diff["sources"].items() for article in entry.get("checked", [])]


def build_archive_shops(diff):
    """The shop links found in the text of articles whose feed card had none, for the bot to add the button."""
    return [{"source": source_id, "article": shop["id"], "url": shop["url"]}
            for source_id, entry in diff["sources"].items() for shop in entry.get("shops", [])]


def build_shop_entries(posts, states, sources, shop_channel, repo_url, detected):
    """An edit entry replaces the earlier post with the same ref."""
    entries = []
    for post in posts:
        kind, source_id = post["destination"]
        source = sources[post["game"]]
        events = post["events"]
        changes = list(events[0]["changes"].values())
        commit = changes[-1].get("commit")
        if post["kind"] == "single":
            message = shop_messages.build_single(events[0], states, source.logo, repo_url, commit, detected, kind)
            title = changes[0]["title"] or events[0]["key"]
        else:
            message = shop_messages.build_digest(post, states, source.logo, repo_url, commit, detected, kind)
            title = shop_messages.DIGEST[post["type"]].format(n=len(events))
        if kind == "feed":
            feed = sources[source_id]
            tiers = shop_posts.FEED_TIERS.get(post["type"], ("all",))  # a mix of types only goes to "all"
            channels = [c for tier in tiers for c in feed.tier_channels[tier]]
            name = feed.name
        else:
            channels, name = [shop_channel] if shop_channel else [], "Battle.net Shop"
        ref = shop_posts.ref(events[0]) if post["kind"] == "single" else None
        entry = {"source": source_id or "shop", "source_name": name, "article": ref or title, "kind": "shop",
                 "detected": detected, "title": title, "url": shop_messages.SHOP_URL, "message": message,
                 "ref": ref, "edit": post["edit"]}
        entries += [{"channel": channel, **entry} for channel in dict.fromkeys(channels)]
    return entries


def write(path, workflow, entries, run_url, checked=(), shops=()):
    """Writes nothing when empty, so no artifact is uploaded."""
    if not entries and not checked and not shops:
        logger.info("Nothing for the outbox.")
        return
    run_id = os.environ.get("GITHUB_RUN_ID")
    outbox = {"version": OUTBOX_VERSION, "workflow": workflow, "run_id": int(run_id) if run_id else None,
              "run_url": run_url, "created": now_iso(), "entries": entries}
    if checked:
        outbox["checked"] = list(checked)
    if shops:
        outbox["shops"] = list(shops)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(outbox, f, indent=2, ensure_ascii=False)
    logger.success(f"Outbox: {len(entries)} entr{'y' if len(entries) == 1 else 'ies'}"
                   f"{f', {len(checked)} checked' if checked else ''}{f', {len(shops)} shop link(s)' if shops else ''}.")
