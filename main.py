import argparse
import json
import os
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

from loguru import logger

from modules.core import gitops, health
from modules.core.config import load_shop_config, load_sources
from modules.notifiers import discord, outbox
from modules.processors import differ, shop_differ, shop_posts
from modules.providers import html as html_provider, json_api as json_provider, shop

PROVIDERS = {"html": html_provider.fetch, "json": json_provider.fetch}
MAX_FETCH_ATTEMPTS = 3
MAX_DEEPEN_PAGES = 20
FETCH_WORKERS = 4  # sources fetched at once; kept small to not get in trouble with Blizzard

DATA_DIR = os.environ.get("OUTPUT_DIR", "data")
DIFF_FILE = os.environ.get("DIFF_FILE", "diff.json")
OUTBOX_FILE = os.environ.get("OUTBOX_FILE", "outbox.json")
SHOP_DIR = os.environ.get("SHOP_DIR", "shop")
SHOP_DIFF_FILE = os.environ.get("SHOP_DIFF_FILE", "shop-diff.json")
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
                                          "quiet": len(quiet),
                                          "shop_links": len(differ.new_shop_links(old_state, items))}
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


def shop_targets(region, family):
    """The shop config, regions and families, narrowed by --region and --family."""
    config = load_shop_config(SOURCES_FILE)
    regions = {r: base for r, base in config["regions"].items() if region in (None, r)}
    families = [f for f in config["families"] if family in (None, f)]
    if not regions or not families:
        sys.exit(f"Nothing to fetch: regions {list(config['regions'])}, families {list(config['families'])}")
    return config, regions, families


def shop_dry_run(region, family):
    """Print what each shop page lists, by section. Saves nothing."""
    config, regions, families = shop_targets(region, family)
    for name, base in regions.items():
        session = shop.open_session()
        for slug in families:
            items = shop.parse_items(shop.fetch_family(session, base, slug))
            sections = {}
            for item in items.values():
                for section in item["sections"]:
                    sections.setdefault(section, []).append(item)
            print(f"\n== {name} / {slug}: {len(items)} items ==")
            for section, members in sections.items():
                print(f"  {section} ({len(members)})")
                for item in members:
                    print(f"    - {shop.describe(item)}")
            time.sleep(config["fetch_delay_seconds"])


def shop_sweep(region, family):
    """Fetch the shop pages, write the changes under SHOP_DIR and list them in shop-diff.json."""
    config, regions, families = shop_targets(region, family)
    state = health.load(SHOP_DIR)
    diff = {"families": {}, "alerts": []}
    now = outbox.now_iso()
    for name, base in regions.items():
        session = shop.open_session()
        for n, slug in enumerate(families):
            if n:
                time.sleep(config["fetch_delay_seconds"])
            label = shop_differ.family_dir(name, slug)
            watched = SimpleNamespace(id=label, failures_before_alert=config["failures_before_alert"])
            try:
                items = shop.parse_items(shop.fetch_family(session, base, slug))
                if not items:
                    raise RuntimeError("no items (page changed?)")
            except Exception as e:
                logger.error(f"[{label}] failed: {e}")
                if alert := health.record_failure(state, watched, str(e)):
                    diff["alerts"].append(alert)
                continue
            if alert := health.record_success(state, watched):
                diff["alerts"].append(alert)
            old = shop_differ.load_state(SHOP_DIR, name, slug)
            new, changes = shop_differ.sweep(old, items, now, config["gone_after_misses"],
                                             lambda item: shop.item_on_sale(session, base, slug, item))
            shop_differ.write_family(SHOP_DIR, name, slug, new, changes, baseline=old is None)
            diff["families"][label] = {"baseline": old is None, "items": len(items), "changes": changes}
            logger.success(f"[{label}] {len(items)} items, {len(changes)} change(s)"
                           f"{' (baseline, nothing reported)' if old is None else ''}")
    health.save(SHOP_DIR, state)
    with open(SHOP_DIFF_FILE, "w", encoding="utf-8") as f:
        json.dump(diff, f, indent=2, ensure_ascii=False)


def shop_notify():
    config = load_shop_config(SOURCES_FILE)
    repo = os.environ.get("GITHUB_REPOSITORY")
    repo_url = f"https://github.com/{repo}" if repo else None
    with open(SHOP_DIFF_FILE, "r", encoding="utf-8") as f:
        diff = json.load(f)
    discord.send_shop_log(diff, config["families"], config["regions"], repo_url, os.environ.get("ACTIONS_RUN_URL"))
    logger.success("Notify complete.")


def shop_commit():
    """One commit per changed family, then a single push. Records each SHA in shop-diff.json."""
    with open(SHOP_DIFF_FILE, "r", encoding="utf-8") as f:
        diff = json.load(f)
    for label, entry in diff["families"].items():
        counts = Counter(c["type"].replace("_", " ") for c in entry["changes"])
        message = f"{label}: " + ("baseline" if entry["baseline"] else
                                  ", ".join(f"{n} {kind}" for kind, n in counts.items()) or "state")
        entry["commit"] = gitops.commit_paths(SHOP_DIR, [label], message)
    gitops.commit_paths(SHOP_DIR, [health.HEALTH_FILE], "health state")
    gitops.push(SHOP_DIR)
    with open(SHOP_DIFF_FILE, "w", encoding="utf-8") as f:
        json.dump(diff, f, indent=2, ensure_ascii=False)


def shop_outbox():
    """The shop run's posts for the bot, and the ledger of recent posts that lets the other region edit them."""
    config = load_shop_config(SOURCES_FILE)
    sources = {s.id: s for s in load_sources(SOURCES_FILE)}
    repo = os.environ.get("GITHUB_REPOSITORY")
    repo_url = f"https://github.com/{repo}" if repo else None
    with open(SHOP_DIFF_FILE, "r", encoding="utf-8") as f:
        diff = json.load(f)
    now = outbox.now_iso()
    fresh = [(*label.split("/"), {**change, "commit": entry.get("commit")})
             for label, entry in diff["families"].items() for change in entry["changes"]]
    events, ledger = shop_posts.resolve(shop_posts.load_ledger(SHOP_DIR), fresh, now)
    posts = shop_posts.plan(events, config["families"])
    states = {(r, f): shop_differ.load_state(SHOP_DIR, r, f)
              for r in config["regions"] for f in {e["family"] for e in events}} if posts else {}
    entries = outbox.build_shop_entries(posts, states, sources, config["channel"], repo_url, now)
    outbox.write(OUTBOX_FILE, "shop", entries, os.environ.get("ACTIONS_RUN_URL"))
    shop_posts.save_ledger(SHOP_DIR, shop_posts.remember(ledger, posts, now))
    gitops.commit_paths(SHOP_DIR, [shop_posts.LEDGER_FILE], "posted ledger")
    gitops.push(SHOP_DIR)


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
    parser.add_argument("--shop", action="store_true", help="Battle.net Shop tracking: fetch, write changes + shop-diff.json")
    parser.add_argument("--dry-run", action="store_true", help="with --shop: print what the shop lists, save nothing")
    parser.add_argument("--shop-commit", action="store_true", help="commit the shop run per family, push, record SHAs in shop-diff.json")
    parser.add_argument("--shop-outbox", action="store_true", help="write outbox.json from shop-diff.json, for the bot")
    parser.add_argument("--shop-notify", action="store_true", help="post the shop run summary to the log channel")
    parser.add_argument("--region", help="with --shop: only this region (eu or us)")
    parser.add_argument("--family", help="with --shop: only this shop family slug")
    parser.add_argument("--notify", action="store_true", help="post the run summary to the log channel")
    args = parser.parse_args()
    if not (args.scrape or args.deepen or args.commit or args.outbox or args.notify or args.shop or args.shop_commit or args.shop_outbox or args.shop_notify):
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
    if args.shop:
        (shop_dry_run if args.dry_run else shop_sweep)(args.region, args.family)
    if args.shop_commit:
        shop_commit()
    if args.shop_outbox:
        shop_outbox()
    if args.shop_notify:
        shop_notify()


if __name__ == "__main__":
    main()
