from urllib.parse import urljoin

KEYS = ("id", "title", "url", "date", "summary", "image")


def finish_item(raw, base_url):
    """Normalise one scraped item. Returns None when it has no usable id/title."""
    item = {k: " ".join((raw.get(k) or "").split()) for k in KEYS}
    if not item["id"] or not item["title"]:
        return None
    for k in ("url", "image"):
        if item[k]:
            item[k] = urljoin(base_url, item[k])
    return item
