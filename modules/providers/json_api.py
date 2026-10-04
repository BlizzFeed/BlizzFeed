import re
import time

from modules.providers import http
from modules.providers.common import finish_item

PAGE_DELAY_SECONDS = 1


def _path(obj, dotted):
    for part in dotted.split("."):
        if not isinstance(obj, dict):
            return ""
        obj = obj.get(part)
    return "" if obj is None else str(obj)


def _matches(entry, where):
    """True when each dotted path equals its value, or one of its values when given a list."""
    for path, wanted in where.items():
        options = wanted if isinstance(wanted, list) else [wanted]
        if _path(entry, path) not in [str(value) for value in options]:
            return False
    return True


def _shop_url(entry, path):
    """The first shopLinks call to action with a url, from the list at `path`. "" if none."""
    obj = entry
    for part in path.split("."):
        obj = obj.get(part) if isinstance(obj, dict) else None
    for action in obj if isinstance(obj, list) else []:
        if isinstance(action, dict) and action.get("type") == "shopLinks" and action.get("url"):
            return str(action["url"])
    return ""


def _fill(template, entry):
    """Replace each {dotted.path} with its value. Returns "" if any of them is empty."""
    values = {path: _path(entry, path) for path in re.findall(r"\{([^}]+)\}", template)}
    if not all(values.values()):
        return ""
    return re.sub(r"\{([^}]+)\}", lambda m: values[m.group(1)], template)


def _entries(source, offset):
    params = {source.raw["offset_param"]: offset} if "offset_param" in source.raw else None
    data = http.get(source.url, headers={"Accept": "application/json"}, params=params).json()
    for part in source.raw.get("items_path", "").split("."):
        if part:
            data = data[part]
    return data


def fetch(source, known=None, start=0, pages=None):
    """known: {id: date} from the saved state, or None on a source's first run.

    The feed is sorted newest update first, so once a page ends on an article we
    already have with the same date, everything after it is old and the next page
    is skipped. A normal run is one request; `pages` caps it, `baseline_pages` on a first run.
    start and pages pick the range of pages instead (main.deepen).
    """
    pages = pages or (source.raw.get("pages", 1) if known is not None else source.raw.get("baseline_pages", 1))
    page_size = source.raw.get("page_size", 0)
    fields = source.raw["fields"]
    where = source.raw.get("where", {})
    url_template = source.raw.get("url_template")
    shop_path = source.raw.get("shop_path")
    items, seen = [], set()
    for page in range(start, start + pages):
        if page > start:
            time.sleep(PAGE_DELAY_SECONDS)
        entries = _entries(source, page * page_size)
        for entry in entries:
            if not _matches(entry, where):
                continue
            raw = {name: _path(entry, spec) for name, spec in fields.items()}
            if url_template:
                raw["url"] = _fill(url_template, entry) or raw.get("url", "")
            if shop_path:
                raw["shop_url"] = _shop_url(entry, shop_path)
            item = finish_item(raw, source.url)
            # A post published between two page requests shifts the list, so skip repeats.
            if item and item["id"] not in seen:
                seen.add(item["id"])
                items.append(item)
        if "offset_param" not in source.raw or len(entries) < page_size:
            break
        if known is not None and items and known.get(items[-1]["id"]) == items[-1]["date"]:
            break
    return items
