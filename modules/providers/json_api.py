from modules.providers import http
from modules.providers.common import finish_item


def _path(obj, dotted):
    for part in dotted.split("."):
        if not isinstance(obj, dict):
            return ""
        obj = obj.get(part)
    return "" if obj is None else str(obj)


def fetch(source):
    data = http.get(source.url, headers={"Accept": "application/json"}).json()
    for part in source.raw.get("items_path", "").split("."):
        if part:
            data = data[part]
    fields = source.raw["fields"]
    items = []
    for entry in data:
        raw = {name: _path(entry, spec) for name, spec in fields.items()}
        item = finish_item(raw, source.url)
        if item:
            items.append(item)
    return items
