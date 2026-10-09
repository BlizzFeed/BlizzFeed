import json
import re
import time

import requests

from modules.providers import http

RSC_TYPE = "text/x-component"
# Cache ages and the server clock; left out so they never read as a change
IGNORED_KEYS = {"cacheMetaData"}
RECORD = re.compile(r"^([0-9a-f]+):(.*)$")
BANNER_SECTION = "Banner"
PRODUCT_PATH = re.compile(r"/product/([^/?#]+)")
ITEM_PATH = re.compile(r"/items/(\d+)")
UNTITLED_SECTION = "(untitled)"


class ShopFetchError(Exception):
    """The shop answered, but not with a family payload."""


def open_session():
    """One per region: a session made on eu. doesn't work on us."""
    session = requests.Session()
    session.headers.update({"User-Agent": http.USER_AGENT, "Accept-Language": "en", "RSC": "1"})
    return session


def _get(session, url):
    """http.get on a session."""
    response = session.get(url, timeout=20)
    if response.status_code == 429:
        time.sleep(http._retry_delay(response))
        response = session.get(url, timeout=20)
    response.raise_for_status()
    return response


def _payload(response):
    """The body as text. Decoded as UTF-8 here because requests guesses ISO-8859-1 without a charset."""
    if not response.headers.get("Content-Type", "").startswith(RSC_TYPE):
        raise ShopFetchError(f"unexpected content type {response.headers.get('Content-Type')!r} "
                             f"at {response.url}")
    return response.content.decode("utf-8")


def fetch_family(session, base, family):
    """The family page's data payload (the Next.js RSC stream)."""
    return _payload(_get(session, f"{base}/family/{family}"))


def item_page_url(base, family, item):
    """The item's own page."""
    if item.get("itemId"):
        return f"{base}/family/{family}/items/{item['itemId']}"
    return f"{base}/product/{item['slug']}"


def item_on_sale(session, base, family, item):
    """True if the item's page shows a price. Free and "Learn More" items have none, even while on sale."""
    payload = _payload(_get(session, item_page_url(base, family, item)))
    return any(o.get("fullAmount") for r in _records(payload) for o, _ in _walk(r))


def _records(payload):
    """The JSON records, one `<hex id>:<json>` per line. Other lines are skipped."""
    for line in payload.split("\n"):
        match = RECORD.match(line)
        if not match:
            continue
        try:
            yield json.loads(match.group(2))
        except ValueError:
            continue


def _walk(node, ancestors=()):
    """Every dict in the tree, with the dicts above it."""
    if isinstance(node, dict):
        yield node, ancestors
        for value in node.values():
            yield from _walk(value, ancestors + (node,))
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value, ancestors)


def _is_item(obj):
    return "cmsId" in obj and "productIds" in obj


def _clean(obj):
    """The object without IGNORED_KEYS."""
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items() if k not in IGNORED_KEYS}
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    return obj


def item_id(destination):
    """The ID in a /family/<f>/items/<id>/ link. For a bundle productIds is what it contains, not this."""
    match = ITEM_PATH.search(destination or "")
    return int(match.group(1)) if match else None


def item_key(obj):
    """cmsId, else p:<item ID>, else p:<productIds>, else s:<slug>."""
    if obj.get("cmsId"):
        return obj["cmsId"]
    if item_id(obj.get("destination")):
        return f"p:{item_id(obj['destination'])}"
    if obj.get("productIds"):
        return "p:" + ",".join(str(p) for p in obj["productIds"])
    return "s:" + (obj.get("slug") or "")


def _section(ancestors):
    """The title of the nearest enclosing section."""
    for ancestor in reversed(ancestors):
        if "title" in ancestor and not _is_item(ancestor):
            return ancestor["title"] or UNTITLED_SECTION
    return None


def _price(price):
    if not price:
        return None
    keys = ("fullAmount", "discountAmount", "discountPercentage", "currency", "raw", "labelFormat")
    cleaned = {k: price.get(k) for k in keys}
    for key in ("fullAmount", "discountAmount"):
        if cleaned[key]:
            cleaned[key] = cleaned[key].replace("$$", "$")  # the US shop doubles the dollar sign
    return cleaned


def _item(obj):
    return {
        "key": item_key(obj), "kind": "item", "cmsId": obj.get("cmsId"), "slug": obj.get("slug"),
        "title": obj.get("title"), "description": obj.get("description"),
        "categoryId": obj.get("categoryId"), "itemId": item_id(obj.get("destination")),
        "productIds": obj.get("productIds") or [],
        "subscriptionIds": obj.get("subscriptionIds") or [], "destination": obj.get("destination"),
        "image": (obj.get("image") or {}).get("url"), "sections": [],
        "badge": (obj.get("marketingBadge") or {}).get("text"), "price": _price(obj.get("price")),
        "expiresAtMs": obj.get("expiresAtMs"),
    }


def _banner(obj):
    """A header banner. It has no productIds, so the item walk doesn't find it."""
    cta = obj["callToAction"]
    destination = cta.get("destination")
    product = PRODUCT_PATH.search(destination or "")
    slug = product.group(1) if product else None
    return {
        "key": obj.get("cmsId") or "b:" + (destination or ""), "kind": "banner", "cmsId": obj.get("cmsId"),
        "slug": slug, "itemId": item_id(destination),
        "title": cta.get("headline") or cta.get("productPageName") or cta.get("subHeadline"),
        "headline": cta.get("headline"), "subHeadline": cta.get("subHeadline"),
        "buttonText": cta.get("buttonText"), "destination": destination,
        "image": (obj.get("backgroundImageDesktop") or {}).get("url"), "sections": [],
    }


def parse_items(payload):
    """Items and banners of a family payload by key. An item in several sections is one entry."""
    found = {}
    for record in _records(payload):
        for obj, ancestors in _walk(record):
            if _is_item(obj):
                item = _item(_clean(obj))
            elif isinstance(obj.get("callToAction"), dict) and "cmsId" in obj:
                item = _banner(_clean(obj))
            else:
                continue
            entry = found.setdefault(item["key"], item)
            section = BANNER_SECTION if item["kind"] == "banner" else _section(ancestors)
            if section and section not in entry["sections"]:
                entry["sections"].append(section)
    return found


def describe(item):
    """One line for the dry run."""
    price = item.get("price") or {}
    cost = f"{price['raw']} (sale)" if price.get("discountAmount") else price.get("raw", "-")
    badge = f" [{item['badge']}]" if item.get("badge") else ""
    return f"{item['title']}{badge}  {cost}  <{item['key']}>"
