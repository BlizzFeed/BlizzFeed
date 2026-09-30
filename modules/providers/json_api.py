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


def _entries(source, offset):
    params = {source.raw["offset_param"]: offset} if "offset_param" in source.raw else None
    data = http.get(source.url, headers={"Accept": "application/json"}, params=params).json()
    for part in source.raw.get("items_path", "").split("."):
        if part:
            data = data[part]
    return data


def fetch(source, known=None):
    """known: {id: date} from the saved state, or None on a source's first run.

    The feed is sorted newest update first, so once a page ends on an article we
    already have with the same date, everything after it is old and the next page
    is skipped. A normal run is one request; `pages` caps it, `baseline_pages` on a first run.
    """
    pages = source.raw.get("pages", 1) if known is not None else source.raw.get("baseline_pages", 1)
    page_size = source.raw.get("page_size", 0)
    fields = source.raw["fields"]
    where = source.raw.get("where", {})
    items, seen = [], set()
    for page in range(pages):
        if page:
            time.sleep(PAGE_DELAY_SECONDS)
        entries = _entries(source, page * page_size)
        for entry in entries:
            if any(_path(entry, path) != str(value) for path, value in where.items()):
                continue
            raw = {name: _path(entry, spec) for name, spec in fields.items()}
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
