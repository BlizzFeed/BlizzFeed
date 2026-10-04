import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from types import SimpleNamespace

from loguru import logger

from modules.core import gitops, health
from modules.core.config import load_archive_config, load_sources
from modules.notifiers import discord, outbox
from modules.processors import archiver, differ
from modules.providers import article

DATA_DIR = os.environ.get("DATA_DIR", "data")
ARCHIVE_DIR = os.environ.get("ARCHIVE_DIR", "archive")
DIFF_FILE = os.environ.get("ARCHIVE_DIFF_FILE", "archive-diff.json")
OUTBOX_FILE = os.environ.get("OUTBOX_FILE", "outbox.json")
SOURCES_FILE = os.environ.get("SOURCES_FILE", os.path.join(os.path.dirname(__file__), "sources.yaml"))

COMMIT_VERBS = {"archived": "archived", "text": "text edited:", "card": "summary changed:",
                "reformatted": "reformatted:"}


def read_diff():
    with open(DIFF_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def write_diff(diff):
    with open(DIFF_FILE, "w", encoding="utf-8") as f:
        json.dump(diff, f, indent=2, ensure_ascii=False)


def archive_one(source, item, index, cfg, reformat):
    """Fetch and save one article. Returns its change entry, or None when nothing changed.

    Raises ArticleGone for a 404 or 410, and anything else for a failed fetch. Never writes a bad file.
    """
    text = archiver.to_markdown(article.fetch_body(source.locale, item["id"], cfg["body_selector"]))
    content = archiver.render_file(item, text)
    old = archiver.read_article(ARCHIVE_DIR, source.id, item["id"])
    kind = archiver.classify(old, content)
    if kind is None:
        return None
    if kind == "text" and reformat:
        kind = "reformatted"  # most likely our converter changed, not the article, so it isn't posted
    archiver.write_article(ARCHIVE_DIR, source.id, item["id"], content)
    entry = {"id": item["id"], "title": item["title"], "kind": kind, "url": item["url"],
             "summary": item["summary"], "image": item["image"], "path": archiver.article_path(source.id, item["id"])}
    if kind == "text":
        entry["added"], entry["changed"], entry["removed"] = archiver.line_changes(
            archiver.split_file(old)[1], archiver.split_file(content)[1])
        # The date didn't move, so only the window sweep could have found this edit.
        entry["silent"] = index.get(item["id"]) == item["date"]
    return entry


def fetch(backfill=False, only_source=None):
    """backfill: only articles the archive has never seen, and stop at the first failed fetch."""
    cfg = load_archive_config(SOURCES_FILE)
    now = datetime.now(timezone.utc)
    archive_state = archiver.load_archive_state(ARCHIVE_DIR)
    # A new converter version re-checks the whole window at once, so no old-format file is left to
    # show up as an edit later.
    reformat = not backfill and archive_state.get("converter") != archiver.CONVERTER_VERSION
    sweep = not backfill and (reformat or archiver.sweep_due(archive_state, cfg["sweep_minutes"], now))

    sources = load_sources(SOURCES_FILE)
    if only_source:
        sources = [s for s in sources if s.id == only_source]
        if not sources:
            sys.exit(f"Unknown source: {only_source}")
    indexes, candidates = {}, []
    for source in sources:
        items = differ.load_state(DATA_DIR, source.id)
        if items is None:
            continue
        indexes[source.id] = archiver.load_index(ARCHIVE_DIR, source.id)
        if backfill:
            candidates += [(source, item, "backfill") for item in archiver.plan_backfill(items, indexes[source.id])]
        else:
            candidates += [(source, item, reason)
                           for item, reason in archiver.plan(items, indexes[source.id], now, cfg, sweep)]
    selected = archiver.select(candidates, cfg["max_fetches"])
    logger.info(f"{len(candidates)} article(s) due, fetching {len(selected)}"
                f"{' (window sweep included)' if sweep else ''}")

    # Old pages can have other markup, so in a backfill an unreadable body is skipped like a 404/410.
    skip = (article.ArticleGone, article.BodyNotFound) if backfill else article.ArticleGone
    diff = {"sweep": sweep, "sources": {}, "alerts": []}
    for n, (source, item, reason) in enumerate(selected):
        if n:
            time.sleep(cfg["fetch_delay_seconds"])
        entry = diff["sources"].setdefault(source.id, {"articles": [], "gone": [], "failed": 0})
        try:
            change = archive_one(source, item, indexes[source.id], cfg, reformat)
        except skip as e:
            logger.warning(f"[{source.id}] {item['id']} can't be archived ({type(e).__name__}), skipping it")
            entry["gone"].append(item["id"])
        except Exception as e:
            logger.error(f"[{source.id}] {item['id']} failed: {e}")
            entry["failed"] += 1
            entry.setdefault("error", str(e))
            if backfill:
                break
            continue  # left out of the index, so the next run tries it again
        else:
            if change:
                entry["articles"].append(change)
                logger.success(f"[{source.id}] {change['kind']}: {item['title']}")
        indexes[source.id][item["id"]] = item["date"]

    health_state = health.load(ARCHIVE_DIR)
    for source_id, entry in diff["sources"].items():
        archiver.save_index(ARCHIVE_DIR, source_id, indexes[source_id])
        # The alert threshold is the archive's own, not the feed's.
        shim = SimpleNamespace(id=source_id, failures_before_alert=cfg["failures_before_alert"])
        alert = (health.record_failure(health_state, shim, entry["error"]) if entry["failed"]
                 else health.record_success(health_state, shim))
        if alert:
            diff["alerts"].append(alert)
    if sweep:
        archive_state["last_sweep"] = archiver.now_iso(now)
    # Only once everything due was fetched; otherwise the next run carries on reformatting.
    if not backfill and len(selected) == len(candidates) and not any(e["failed"] for e in diff["sources"].values()):
        archive_state["converter"] = archiver.CONVERTER_VERSION
    archiver.save_archive_state(ARCHIVE_DIR, archive_state)
    health.save(ARCHIVE_DIR, health_state)
    write_diff(diff)


def commit():
    """One commit per changed article, one for the run's state files, then a single push."""
    diff = read_diff()
    for source_id, entry in diff["sources"].items():
        for change in entry["articles"]:
            message = f"{source_id}: {COMMIT_VERBS[change['kind']]} {change['title']}"
            change["commit"] = gitops.commit_paths(ARCHIVE_DIR, [change["path"]], message)
    state_paths = [f"{source_id}/index.json" for source_id in diff["sources"]]
    gitops.commit_paths(ARCHIVE_DIR, state_paths + [archiver.ARCHIVE_STATE_FILE, health.HEALTH_FILE],
                        "archive state")
    gitops.push(ARCHIVE_DIR)  # a no-op when nothing was committed
    write_diff(diff)


def write_outbox():
    sources = {s.id: s for s in load_sources(SOURCES_FILE)}
    repo = os.environ.get("GITHUB_REPOSITORY")
    repo_url = f"https://github.com/{repo}" if repo else None
    entries = outbox.build_archive_entries(read_diff(), sources, repo_url, outbox.now_iso())
    outbox.write(OUTBOX_FILE, "archive", entries, os.environ.get("ACTIONS_RUN_URL"))


def notify():
    sources = {s.id: s for s in load_sources(SOURCES_FILE)}
    repo = os.environ.get("GITHUB_REPOSITORY")
    repo_url = f"https://github.com/{repo}" if repo else None
    diff, run_url = read_diff(), os.environ.get("ACTIONS_RUN_URL")
    discord.send_archive_log(diff, sources, repo_url, run_url, os.environ.get("LOG_MESSAGE"))
    logger.success("Notify complete.")


def main():
    logger.remove()
    logger.add(sys.stderr, level="INFO",
               format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{message}</cyan>")
    parser = argparse.ArgumentParser(description="Article archive: fetch -> commit -> notify")
    parser.add_argument("--fetch", action="store_true", help="fetch due articles, write files + archive-diff.json")
    parser.add_argument("--commit", action="store_true", help="commit per article, push, record SHAs in archive-diff.json")
    parser.add_argument("--outbox", action="store_true", help="write outbox.json from archive-diff.json, for the bot")
    parser.add_argument("--notify", action="store_true", help="post the run summary to the log channel")
    parser.add_argument("--backfill", action="store_true", help="with --fetch: only articles never archived, newest first")
    parser.add_argument("--source", help="with --fetch: only this source id")
    args = parser.parse_args()
    if not (args.fetch or args.commit or args.outbox or args.notify):
        parser.print_help()
    if args.fetch:
        fetch(args.backfill, args.source)
    if args.commit:
        commit()
    if args.outbox:
        write_outbox()
    if args.notify:
        notify()


if __name__ == "__main__":
    main()
