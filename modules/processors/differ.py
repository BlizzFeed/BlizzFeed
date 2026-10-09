import json
import os

ANNOUNCED = ("title", "summary", "image")  # a change here posts "updated"
QUIET = ("date", "url", "shop_url")  # a change only here is saved without a message (a retitle changes the slug too)


def state_path(data_dir, source_id):
    return os.path.join(data_dir, source_id, "state.json")


def item_path(source_id, item_id):
    return f"{source_id}/items/{item_id}.md"


def load_state(data_dir, source_id):
    path = state_path(data_dir, source_id)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def changed_fields(prev, item):
    """Which of the announced fields (title, summary, image) differ from the saved item."""
    return [k for k in ANNOUNCED if prev.get(k, "") != item[k]]


def compute(old_state, items):
    """Append-only diff by id. Items missing from the fetch are never reported as removed.

    Returns (added, updated, quiet); quiet items only changed their date or url.
    """
    old = {i["id"]: i for i in (old_state or [])}
    added, updated, quiet = [], [], []
    for item in items:
        prev = old.get(item["id"])
        if prev is None:
            added.append(item)
        elif changed_fields(prev, item):
            updated.append(item)
        elif any(prev.get(k, "") != item.get(k, "") for k in QUIET):
            quiet.append(item)
    return added, updated, quiet


def new_shop_links(old_state, items):
    """Items with a shop link their saved copy lacked. None on a source's first run."""
    old = {i["id"]: i.get("shop_url") for i in old_state or []}
    return [i for i in items if old_state and i.get("shop_url") and i["shop_url"] != old.get(i["id"])]


def keep_shop_urls(old_state, items):
    """Keeps the saved shop link (found in the article text) when the feed's card has none. A card link wins."""
    saved = {i["id"]: i["shop_url"] for i in old_state or [] if i.get("shop_url")}
    for item in items:
        if not item.get("shop_url") and item["id"] in saved:
            item["shop_url"] = saved[item["id"]]


def merge(old_state, items):
    merged = {i["id"]: i for i in (old_state or [])}
    for item in items:
        merged[item["id"]] = item
    return sorted(merged.values(), key=lambda i: i["id"])


def render_markdown(item):
    lines = [f"# {item['title']}", "", f"- URL: {item['url']}", f"- Date: {item['date']}"]
    if item["image"]:
        lines.append(f"![]({item['image']})")  # an image, not a link, so GitHub's preview shows it
    lines += ["", item["summary"], ""]
    return "\n".join(lines)


def write_source(data_dir, source_id, merged, changed_items):
    os.makedirs(os.path.join(data_dir, source_id, "items"), exist_ok=True)
    for item in changed_items:
        with open(os.path.join(data_dir, item_path(source_id, item["id"])), "w",
                  encoding="utf-8", newline="\n") as f:
            f.write(render_markdown(item))
    with open(state_path(data_dir, source_id), "w", encoding="utf-8", newline="\n") as f:
        json.dump(merged, f, indent=2, ensure_ascii=False)
        f.write("\n")
