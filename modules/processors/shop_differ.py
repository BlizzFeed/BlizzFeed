import json
import os
from datetime import datetime, timedelta

SUSPECT_DROP = 0.25  # a fetch losing more than this share of the listed items is held for a second look
META_FILE = "meta.json"
UNLISTED_RECHECK = timedelta(hours=24)
DETAIL_FIELDS = ("title", "description", "image", "sections")
BANNER_FIELDS = ("headline", "subHeadline", "buttonText", "destination")


def family_dir(region, family):
    return f"{region}/{family}"


def state_path(shop_dir, region, family):
    return os.path.join(shop_dir, family_dir(region, family), "state.json")


def load_state(shop_dir, region, family):
    path = state_path(shop_dir, region, family)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def family_check(meta, slugs, tracked, now):
    """(families to report, new meta). The first check reports nothing."""
    reported = set(meta.get("reported", []))
    new = sorted(set(slugs) - set(tracked) - reported) if "last_family_check" in meta else []
    return new, {"last_family_check": now, "reported": sorted(reported | set(slugs) - set(tracked))}


def card_name(key):
    return key.replace(":", "-").replace(",", "_")


def _priced(item):
    return item["kind"] == "item" and bool((item.get("price") or {}).get("fullAmount"))


def _differing(prev, item, fields):
    """The fields that differ, with their old and new values."""
    changed = [k for k in fields if prev.get(k) != item.get(k)]
    return {"changed": changed, "from": {k: prev.get(k) for k in changed}, "to": {k: item.get(k) for k in changed}}


def _product(banner, fetched):
    """A banner's product name: its own, else the title of the item card it links to."""
    if banner.get("productPageName"):
        return banner["productPageName"]
    for item in fetched.values():
        if item["kind"] == "item" and ((item["itemId"] and item["itemId"] == banner["itemId"])
                                       or (item["slug"] and item["slug"] == banner["slug"])):
            return item["title"]
    return None


def _compare(prev, item):
    """(type, extra) for each way the fetched item differs from the saved one."""
    if item["kind"] == "banner":
        differing = _differing(prev, item, BANNER_FIELDS)
        return [("banner", {"what": "changed", **differing})] if differing["changed"] else []
    changes = []
    old, new = prev.get("price") or {}, item.get("price") or {}
    # A sale that ends by making its price the list price costs buyers nothing, so posts skip the price change.
    ended = old.get("discountAmount") and not new.get("discountAmount")
    kept = {"sale_kept": True} if ended and old["discountAmount"] == new.get("fullAmount") else {}
    if old.get("fullAmount") != new.get("fullAmount"):
        changes.append(("price", {"from": old.get("fullAmount"), "to": new.get("fullAmount"), **kept}))
    if bool(old.get("discountAmount")) != bool(new.get("discountAmount")):
        changes.append(("sale_start" if new.get("discountAmount") else "sale_end", kept))
    if prev.get("badge") != item.get("badge"):
        changes.append(("badge", {"from": prev.get("badge"), "to": item.get("badge"),
                                  "maybe_new": item.get("badge") == "New"}))
    differing = _differing(prev, item, DETAIL_FIELDS)
    if differing["changed"]:
        changes.append(("details", differing))
    return changes


def sweep(old, fetched, now, misses_needed, confirm):
    """Returns (new state, changes). old is None on a family's first run, which reports nothing.
    confirm(item) is True when the item's own page still shows a price."""
    if old is None:
        return {"items": {k: {**i, "first_seen": now, "status": "listed", "misses": 0}
                          for k, i in fetched.items()}, "suspect": False}, []

    items = {k: dict(i) for k, i in old["items"].items()}
    listed = [k for k, i in items.items() if i["status"] == "listed"]
    vanished = [k for k in listed if k not in fetched]
    if len(vanished) > SUSPECT_DROP * len(listed) and not old.get("suspect"):
        return {**old, "suspect": True}, []  # believed if the next fetch agrees

    for key, item in fetched.items():  # a product-only item that gained a card keeps its history under the new key
        if key not in items and item["kind"] == "item" and item["itemId"]:
            old = next((k for k, i in items.items() if k not in fetched and i["kind"] == "item"
                        and i["status"] != "gone" and i["itemId"] == item["itemId"]), None)
            if old:
                items[key] = items.pop(old)

    changes = []

    def log(kind, item, **extra):
        record = {"type": kind, "key": item["key"], "kind": item["kind"], "slug": item["slug"],
                  "title": item["title"], "destination": item["destination"], "seen": now}
        if item["kind"] == "banner":
            record.update(button=item["buttonText"], product=_product(item, fetched))
        else:
            record["price"] = item["price"]
        changes.append({**record, **extra})

    for key, item in fetched.items():
        prev = items.get(key)
        if prev is None or prev["status"] == "gone":
            if item["kind"] == "banner":
                log("banner", item, what="added" if prev is None else "back")
            else:
                log("new" if prev is None else "back", item)
        else:
            for kind, extra in _compare(prev, item):
                log(kind, item, **extra)
        items[key] = {**item, "first_seen": prev["first_seen"] if prev else now, "status": "listed", "misses": 0}

    for key, item in items.items():
        if key in fetched or item["status"] == "gone":
            continue
        if item["status"] == "unlisted":
            if datetime.fromisoformat(now) - datetime.fromisoformat(item["checked"]) < UNLISTED_RECHECK:
                continue
        else:
            item["status"], item["misses"] = "missing", item["misses"] + 1
            if item["misses"] < misses_needed:
                continue
        # Banners and price-less items can't be confirmed by their page
        if _priced(item):
            try:
                still_for_sale = confirm(item)
            except Exception:
                continue  # can't tell; the next sweep asks again
            if still_for_sale:
                if item["status"] != "unlisted":
                    item["status"] = "unlisted"
                    log("unlisted", item)
                item["checked"] = now
                continue
        item["status"], item["gone_since"] = "gone", now
        log("gone", item)
    return {"items": items, "suspect": False}, changes


def render_markdown(item):
    price = item.get("price") or {}
    lines = [f"# {item['title']}", "", f"- Key: {item['key']}", f"- Status: {item['status']}",
             f"- Sections: {', '.join(item['sections'])}", f"- First seen: {item['first_seen']}"]
    if item.get("badge"):
        lines.append(f"- Badge: {item['badge']}")
    if price.get("fullAmount"):
        lines.append(f"- Price: {price['fullAmount']}")
    if price.get("discountAmount"):
        lines.append(f"- On sale: {price['discountAmount']}")
    if item.get("image"):
        lines.append(f"![]({'https:' * item['image'].startswith('//')}{item['image']})")
    lines += ["", item.get("description") or item.get("subHeadline") or "", ""]
    return "\n".join(lines)


def write_family(shop_dir, region, family, state, changes, baseline):
    """state.json, a card for each changed item (every item on a baseline) and the change log."""
    root = os.path.join(shop_dir, family_dir(region, family))
    os.makedirs(os.path.join(root, "items"), exist_ok=True)
    touched = state["items"].keys() if baseline else {c["key"] for c in changes}
    for key in touched:
        with open(os.path.join(root, "items", f"{card_name(key)}.md"), "w", encoding="utf-8", newline="\n") as f:
            f.write(render_markdown(state["items"][key]))
    if changes:
        with open(os.path.join(root, "changes.jsonl"), "a", encoding="utf-8", newline="\n") as f:
            for change in changes:
                f.write(json.dumps(change, ensure_ascii=False) + "\n")
    with open(state_path(shop_dir, region, family), "w", encoding="utf-8", newline="\n") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
        f.write("\n")
