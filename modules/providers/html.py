import json
import re

from bs4 import BeautifulSoup

from modules.providers import http
from modules.providers.common import finish_item


def _extract(el, spec):
    if isinstance(spec, str):
        spec = {"selector": spec}
    target = el.select_one(spec["selector"]) if "selector" in spec else el
    if target is None:
        return ""
    value = target.get(spec["attr"], "") if "attr" in spec else target.get_text(" ", strip=True)
    if "json_key" in spec:
        try:
            value = str(json.loads(value).get(spec["json_key"], ""))
        except (ValueError, AttributeError):
            value = ""
    if "regex" in spec:
        m = re.search(spec["regex"], value)
        value = m.group(1) if m else ""
    return value


def fetch(source):
    soup = BeautifulSoup(http.get(source.url).text, "html.parser")
    prefix = source.raw.get("url_prefix")
    items = []
    for el in soup.select(source.raw["item_selector"]):
        raw = {name: _extract(el, spec) for name, spec in source.raw["fields"].items()}
        if prefix and raw.get("url", "").startswith("/"):
            raw["url"] = prefix.rstrip("/") + raw["url"]
        item = finish_item(raw, source.url)
        if item:
            items.append(item)
    return items
