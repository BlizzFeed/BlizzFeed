import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from loguru import logger

from modules.core import gitops, health
from modules.core.config import load_sources
from modules.notifiers import discord, outbox
from modules.processors import differ
from modules.providers import html as html_provider, json_api as json_provider

PROVIDERS = {"html": html_provider.fetch, "json": json_provider.fetch}
MAX_FETCH_ATTEMPTS = 3
MAX_DEEPEN_PAGES = 20
FETCH_WORKERS = 4  # sources fetched at once; kept small to not get in trouble with Blizzard

DATA_DIR = os.environ.get("OUTPUT_DIR", "data")
DIFF_FILE = os.environ.get("DIFF_FILE", "diff.json")
OUTBOX_FILE = os.environ.get("OUTBOX_FILE", "outbox.json")
SOURCES_FILE = os.environ.get("SOURCES_FILE", os.path.join(os.path.dirname(__file__), "sources.yaml"))


def fetch_with_retry(source, known):
    for attempt in range(1, MAX_FETCH_ATTEMPTS + 1):
        try:
            items = PROVIDERS[source.type](source, known)
            if items or source.raw.get("allow_empty"):
                return items
            raise RuntimeError("fetch returned no items (markup or API changed?)")
        except Exception as e:
            logger.warning(f"[{source.id}] attempt {attempt}/{MAX_FETCH_ATTEMPTS} failed: {e}")
            if attempt == MAX_FETCH_ATTEMPTS:
                raise
            time.sleep(2 ** (attempt - 1))


def read_diff():
    with open(DIFF_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def write_diff(diff):
    with open(DIFF_FILE, "w", encoding="utf-8") as f:
        json.dump(diff, f, indent=2, ensure_ascii=False)


def fetch_source(source, old_state):
    """(items, None) on success, (None, error) on failure, so one source can't stop the others."""
    known = None if old_state is None else {i["id"]: i["date"] for i in old_state}
    try:
        return fetch_with_retry(source, known), None
    except Exception as e:
        return None, e


def with_changes(old_state, item):
    """An updated item for diff.json, with the fields that changed and the title and image it had before.
    awaits_text: the date moved too, so the archive run this one starts re-checks the article text.
    The state file keeps the plain item."""
    prev = next(i for i in old_state if i["id"] == item["id"])
    return {**item, "changed": differ.changed_fields(prev, item), "previous_title": prev["title"],
            "previous_image": prev.get("image", ""), "awaits_text": prev["date"] != item["date"]}


def scrape():
    state = health.load(DATA_DIR)
    diff = {"sources": {}, "alerts": []}

    # Fetch a few sources at once, then handle the results in sources.yaml order as before.
    sources = load_sources(SOURCES_FILE)
    old_states = [differ.load_state(DATA_DIR, source.id) for source in sources]
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        results = list(pool.map(fetch_source, sources, old_states))

    for source, old_state, (items, error) in zip(sources, old_states, results):
        baseline = old_state is None
        if error is not None:
            logger.error(f"[{source.id}] failed: {error}")
            alert = health.record_failure(state, source, str(error))
        else:
            alert = health.record_success(state, source)
            added, updated, quiet = differ.compute(old_state, items)
            differ.write_source(DATA_DIR, source.id, differ.merge(old_state, items),
                                added + updated + quiet)
            # A baseline writes everything but announces nothing. Quiet items are saved but never announced.
            diff["sources"][source.id] = {"baseline": baseline,
                                          "items": len(items),
                                          "added": [] if baseline else added,
                                          "updated": [with_changes(old_state, item) for item in updated],
                                          "quiet": len(quiet)}
            logger.success(f"[{source.id}] {len(items)} items, +{len(added)} new, {len(updated)} updated, "
                           f"{len(quiet)} quiet{' (baseline, no notifications)' if baseline else ''}")
        if alert:
            diff["alerts"].append(alert)

    health.save(DATA_DIR, state)
    write_diff(diff)


def deepen(source_id, from_page, pages):
    """Store older articles from deeper feed pages, announcing nothing. One pass, no retries."""
    if from_page < 0 or not 1 <= pages <= MAX_DEEPEN_PAGES:
        sys.exit(f"--from-page must be 0 or more, and --pages 1 to {MAX_DEEPEN_PAGES}")
    source = next((s for s in load_sources(SOURCES_FILE) if s.id == source_id), None)
    if source is None:
        sys.exit(f"Unknown source: {source_id}")
    old_state = differ.load_state(DATA_DIR, source.id)
    if old_state is None:
        sys.exit(f"{source.id} has no saved state yet; let the tracker run first")
    known = {i["id"] for i in old_state}
    older = [i for i in json_provider.fetch(source, start=from_page, pages=pages) if i["id"] not in known]
    differ.write_source(DATA_DIR, source.id, differ.merge(old_state, older), older)
    # A baseline, so nothing is announced.
    write_diff({"sources": {source.id: {"baseline": True, "items": len(older), "added": [], "updated": [],
                                        "quiet": 0}}, "alerts": []})
    logger.success(f"[{source.id}] {len(older)} older items stored. Next: --from-page {from_page + pages}")


def commit():
    """One commit per changed source, then a single push. Records each SHA in diff.json."""
    diff = read_diff()
    for source_id, entry in diff["sources"].items():
        message = (f"{source_id}: baseline" if entry["baseline"]
                   else f"{source_id}: {len(entry['added'])} new, {len(entry['updated'])} updated")
        entry["commit"] = gitops.commit_paths(DATA_DIR, [source_id], message)
    gitops.commit_paths(DATA_DIR, [health.HEALTH_FILE], "health state")
    gitops.push(DATA_DIR)  # a no-op when nothing was committed
    write_diff(diff)


def write_outbox():
    sources = {s.id: s for s in load_sources(SOURCES_FILE)}
    repo = os.environ.get("GITHUB_REPOSITORY")
    repo_url = f"https://github.com/{repo}" if repo else None
    entries = outbox.build_tracker_entries(read_diff(), sources, repo_url, outbox.now_iso())
    outbox.write(OUTBOX_FILE, "tracker", entries, os.environ.get("ACTIONS_RUN_URL"))


def notify():
    sources = {s.id: s for s in load_sources(SOURCES_FILE)}
    repo = os.environ.get("GITHUB_REPOSITORY")
    repo_url = f"https://github.com/{repo}" if repo else None
    diff, run_url = read_diff(), os.environ.get("ACTIONS_RUN_URL")
    message_id = discord.send_log(diff, sources, repo_url, run_url)
    if message_id and os.environ.get("GITHUB_OUTPUT"):  # for the archive run the workflow starts next
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"log_message={message_id}\n")
    logger.success("Notify complete.")


def main():
    logger.remove()
    logger.add(sys.stderr, level="INFO",
               format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{message}</cyan>")
    parser = argparse.ArgumentParser(description="Page tracker: scrape -> commit -> notify")
    parser.add_argument("--scrape", action="store_true", help="fetch sources, write files + diff.json")
    parser.add_argument("--deepen", action="store_true",
                        help="store older articles from deeper feed pages, announcing nothing")
    parser.add_argument("--source", help="with --deepen: the source id")
    parser.add_argument("--from-page", type=int, default=10, help="with --deepen: first page to read")
    parser.add_argument("--pages", type=int, default=10, help="with --deepen: how many pages to read")
    parser.add_argument("--commit", action="store_true", help="commit per source, push, record SHAs in diff.json")
    parser.add_argument("--outbox", action="store_true", help="write outbox.json from diff.json, for the bot")
    parser.add_argument("--notify", action="store_true", help="post the run summary to the log channel")
    args = parser.parse_args()
    if not (args.scrape or args.deepen or args.commit or args.outbox or args.notify):
        parser.print_help()
    if args.scrape:
        scrape()
    if args.deepen:
        deepen(args.source, args.from_page, args.pages)
    if args.commit:
        commit()
    if args.outbox:
        write_outbox()
    if args.notify:
        notify()


if __name__ == "__main__":
    main()
