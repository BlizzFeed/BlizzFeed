import json
import os
from datetime import datetime, timedelta

LEDGER_FILE = "posted.json"
EDIT_WINDOW = timedelta(minutes=30)  # a one-sided post is edited when the other region follows within this
DIGEST_AT = 3  # changes of one type, per game and destination in a run
MAX_POSTS = 5  # per game and destination in a run; the rest fold into one post
NEW_TYPES = ("new", "back")
UPDATE_TYPES = ("price", "sale_start", "badge")
ORDER = NEW_TYPES + UPDATE_TYPES + ("sale_end", "gone", "banner", "details")  # unlisted is logged only
REGIONS = ("eu", "us")
# Tier channels of a game's feed per type
FEED_TIERS = {**{t: ("all", "new") for t in NEW_TYPES}, **{t: ("all", "updated") for t in UPDATE_TYPES}}


def load_ledger(shop_dir):
    path = os.path.join(shop_dir, LEDGER_FILE)
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_ledger(shop_dir, ledger):
    with open(os.path.join(shop_dir, LEDGER_FILE), "w", encoding="utf-8", newline="\n") as f:
        json.dump(ledger, f, indent=2, ensure_ascii=False)
        f.write("\n")


def ref(event):
    """How the bot finds an earlier post to edit."""
    return f"{event['family']}:{event['type']}:{event['key']}"


def _event(region, family, change):
    return {"type": change["type"], "family": family, "key": change["key"], "slug": change["slug"],
            "seen": change["seen"], "changes": {region: change}}


def _partner(event, others):
    """The same change in the other region: by key, else by slug when unambiguous (Diablo II's keys differ)."""
    same = [o for o in others if o["family"] == event["family"] and o["type"] == event["type"]
            and not set(o["changes"]) & set(event["changes"])]
    for o in same:
        if o["key"] == event["key"]:
            return o
    clash = [e for e in same if e["slug"] and e["slug"] == event["slug"]]
    return clash[0] if len(clash) == 1 and event["slug"] else None


def resolve(ledger, fresh, now):
    """(events, ledger) from fresh [(region, family, change)]. An event whose other region is in the ledger
    gets "was", the regions already posted, so its post is edited."""
    cutoff = datetime.fromisoformat(now) - EDIT_WINDOW
    ledger = [e for e in ledger if datetime.fromisoformat(e["at"]) > cutoff]
    events = []
    for region, family, change in fresh:
        event = _event(region, family, change)
        if match := _partner(event, events):
            match["changes"][region] = change
        else:
            events.append(event)
    for event in events:
        if match := _partner(event, ledger):
            ledger.remove(match)
            event["was"] = sorted(match["changes"])
            event["changes"] = {**match["changes"], **event["changes"]}
    return events, ledger


def remember(ledger, posts, now):
    """Adds the one-sided events posted on their own to the ledger."""
    known = {ref(e) for e in ledger}
    for post in posts:
        for event in post["events"]:
            if (post["kind"] == "single" and not post["edit"] and len(event["changes"]) == 1
                    and ref(event) not in known):
                ledger.append({**{k: v for k, v in event.items() if k != "was"}, "at": now})
                known.add(ref(event))
    return ledger


def _feed_source(sources, region):
    """A family's sources are [EU feed, US feed]; most have only the EU one."""
    index = REGIONS.index(region)
    return sources[index] if index < len(sources) else None


def audiences(event, sources, regions=None):
    """[("feed", source id) or ("shop", None)]: a feed gets the events its region saw, the shop channel all."""
    if event["type"] == "unlisted":
        return []
    out = []
    if event["type"] in FEED_TIERS:
        for region in REGIONS:
            if region in (regions or event["changes"]) and (feed := _feed_source(sources, region)):
                out.append(("feed", feed))
    return list(dict.fromkeys(out)) + [("shop", None)]


def plan(events, families):
    """The posts of a run: {destination, game (the family's first feed), kind (single, digest or more), type,
    edit, events}. Edits go to destinations the event was already posted to; the rest are digested and capped."""
    groups, posts = {}, []
    for event in events:
        sources = families[event["family"]]["sources"]
        before = audiences(event, sources, event["was"]) if "was" in event else []
        for destination in audiences(event, sources):
            if destination in before:
                posts.append({"destination": destination, "game": sources[0], "kind": "single",
                              "type": event["type"], "edit": True, "events": [event]})
            else:
                groups.setdefault((destination, sources[0]), []).append(event)
    for (destination, game), members in groups.items():
        by_type = {t: [e for e in members if e["type"] == t] for t in ORDER}
        built = []
        for kind, same in by_type.items():
            if len(same) >= DIGEST_AT:
                built.append({"kind": "digest", "type": kind, "events": same})
            else:
                built += [{"kind": "single", "type": kind, "events": [e]} for e in same]
        if len(built) > MAX_POSTS:
            rest = [e for p in built[MAX_POSTS - 1:] for e in p["events"]]
            built = built[:MAX_POSTS - 1] + [{"kind": "more", "type": None, "events": rest}]
        posts += [{"destination": destination, "game": game, "edit": False, **p} for p in built]
    return posts
