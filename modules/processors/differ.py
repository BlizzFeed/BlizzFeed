import json
import os

ANNOUNCED = ("title", "summary", "image")  # a change here posts "updated"
QUIET = ("date", "url")  # a change only here is saved without a message (a retitle changes the slug too)


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
        elif any(prev.get(k, "") != item[k] for k in ANNOUNCED):
            updated.append(item)
        elif any(prev.get(k, "") != item[k] for k in QUIET):
            quiet.append(item)
    return added, updated, quiet


def merge(old_state, items):
    merged = {i["id"]: i for i in (old_state or [])}
    for item in items:
        merged[item["id"]] = item
    return sorted(merged.values(), key=lambda i: i["id"])


def render_markdown(item):
    lines = [f"# {item['title']}", "", f"- URL: {item['url']}", f"- Date: {item['date']}"]
    if item["image"]:
        lines.append(f"- Image: {item['image']}")
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
