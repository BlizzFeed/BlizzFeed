import argparse
import json
import os
import sys
import time

from loguru import logger

from modules.core import gitops, health
from modules.core.config import load_sources
from modules.notifiers import discord
from modules.processors import differ
from modules.providers import html as html_provider, json_api as json_provider

PROVIDERS = {"html": html_provider.fetch, "json": json_provider.fetch}
MAX_FETCH_ATTEMPTS = 3

DATA_DIR = os.environ.get("OUTPUT_DIR", "data")
DIFF_FILE = os.environ.get("DIFF_FILE", "diff.json")
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


def scrape():
    state = health.load(DATA_DIR)
    diff = {"sources": {}, "alerts": []}

    for source in load_sources(SOURCES_FILE):
        old_state = differ.load_state(DATA_DIR, source.id)
        baseline = old_state is None
        known = None if baseline else {i["id"]: i["date"] for i in old_state}
        try:
            items = fetch_with_retry(source, known)
        except Exception as e:
            logger.error(f"[{source.id}] failed: {e}")
            alert = health.record_failure(state, source, str(e))
        else:
            alert = health.record_success(state, source)
            added, updated, quiet = differ.compute(old_state, items)
            differ.write_source(DATA_DIR, source.id, differ.merge(old_state, items),
                                added + updated + quiet)
            # A baseline writes everything but announces nothing.
            diff["sources"][source.id] = {"baseline": baseline,
                                          "added": [] if baseline else added,
                                          "updated": updated}
            logger.success(f"[{source.id}] {len(items)} items, +{len(added)} new, {len(updated)} updated, "
                           f"{len(quiet)} quiet{' (baseline, no notifications)' if baseline else ''}")
        if alert:
            diff["alerts"].append(alert)

    health.save(DATA_DIR, state)
    write_diff(diff)


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


def notify():
    sources = {s.id: s for s in load_sources(SOURCES_FILE)}
    repo = os.environ.get("GITHUB_REPOSITORY")
    repo_url = f"https://github.com/{repo}" if repo else None
    failures = discord.send_all(read_diff(), sources, repo_url, os.environ.get("ACTIONS_RUN_URL"))
    if failures:
        logger.error(f"{failures} Discord send(s) failed.")
        sys.exit(1)
    logger.success("Notify complete.")


def main():
    logger.remove()
    logger.add(sys.stderr, level="INFO",
               format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{message}</cyan>")
    parser = argparse.ArgumentParser(description="Page tracker: scrape -> commit -> notify")
    parser.add_argument("--scrape", action="store_true", help="fetch sources, write files + diff.json")
    parser.add_argument("--commit", action="store_true", help="commit per source, push, record SHAs in diff.json")
    parser.add_argument("--notify", action="store_true", help="send Discord messages from diff.json")
    args = parser.parse_args()
    if not (args.scrape or args.commit or args.notify):
        parser.print_help()
    if args.scrape:
        scrape()
    if args.commit:
        commit()
    if args.notify:
        notify()


if __name__ == "__main__":
    main()
