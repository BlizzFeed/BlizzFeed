from modules.notifiers import discord as d
from modules.processors import shop_differ

SHOP_URL = "https://shop.battle.net"  # the plain host sends each reader to their own region
STATUS = {"new": "🟢 **New in the shop**", "back": "🔁 **Back in the shop**", "price": "💵 **Price changed**",
          "sale_start": "🏷️ **Now on sale**", "sale_end": "⌛ **Sale ended**", "gone": "🔴 **Removed from the shop**",
          "banner": "🖼️ **New banner**", "details": "📝 **Details changed**"}
DIGEST = {"new": "{n} new items in the shop", "back": "{n} items back in the shop", "price": "{n} price changes",
          "sale_start": "{n} items now on sale", "sale_end": "{n} sales ended", "badge": "{n} badge changes",
          "gone": "{n} items removed from the shop", "banner": "{n} banner changes",
          "details": "{n} items with changed details", None: "{n} more changes"}
COLOR = {"new": "added", "back": "added", "gone": "down", "banner": "log", "details": "log"}  # the rest is orange
MAX_LINES, MAX_IMAGES = 12, 4


def _url(destination):
    destination = destination or ""
    return SHOP_URL + destination if destination.startswith("/") else destination  # the Gear cards link off-site


def _image(url):
    url = url or ""
    return "https:" + url if url.startswith("//") else url


def _shown(price):
    """The price as the shop writes it ("From €49.99"), or None for free and "Learn More" cards."""
    if not price or not price.get("fullAmount"):
        return None
    label = price.get("labelFormat") or "{0}"
    return label.replace("{0}", price["fullAmount"]) if "{0}" in label else price["fullAmount"]


def _sale(price):
    off = f" ({price['discountPercentage']}%)" if price.get("discountPercentage") else ""
    return f"~~{price['fullAmount']}~~ **{price['discountAmount']}**{off}"


def _join(texts):
    return " / ".join(dict.fromkeys(texts))  # the same in-game currency in both regions shows once


def _item(states, event, region):
    state = states.get((region, event["family"]))
    return state["items"].get(event["key"]) if state else None


def _art_item(states, event):
    return next((i for r in event["changes"] if (i := _item(states, event, r))), None) or {}


def _listed(states, event):
    items = (_item(states, event, region) for region in ("eu", "us"))
    return [i for i in items if i and i["status"] == "listed"]


def _price_text(event, states):
    kind, changes = event["type"], list(event["changes"].values())
    if kind in ("new", "back"):
        return _join(f"**{p}**" for i in _listed(states, event) if (p := _shown(i["price"])))
    if kind == "sale_start":
        return _join(_sale(i["price"]) for i in _listed(states, event) if i["price"].get("discountAmount"))
    if kind == "sale_end":
        text = _join(f"**{p}**" for i in _listed(states, event) if (p := _shown(i["price"])))
        return f"back to {text}" if text else None
    if kind == "price":
        return _join(f"{c['from'] or '–'} → **{c['to'] or '–'}**" for c in changes)
    if kind == "gone":
        text = _join(f"**{p}**" for c in changes if (p := _shown(c.get("price"))))  # a banner has no price
        return f"was {text}" if text else None
    if kind == "banner":
        return changes[0].get("button")
    return None


def _status(event):
    change = next(iter(event["changes"].values()))
    if event["type"] != "badge":
        return STATUS[event["type"]]
    if change["to"] == "New":
        return "✨ **Marked as new in the shop**"
    return f"✨ **{change['to']}**" if change["to"] else "✨ **Badge removed**"


def _detail_lines(change):
    lines = []
    for field in change["changed"]:
        if field == "image":
            lines.append("+ Image changed")
            continue
        old, new = (change[side][field] for side in ("from", "to"))
        old, new = (", ".join(v) if isinstance(v, list) else v or "" for v in (old, new))
        lines += [f"- {d._trim(old, 100)}", f"+ {d._trim(new, 100)}"]
    return lines


def _color(kind):
    return d.COLORS[COLOR.get(kind, "updated")]


def _footer(verb, now, repo_url):
    link = f" · [BlizzFeed]({repo_url})" if repo_url else ""
    return d._text(f"-# {verb} {d._discord_time(now)}{link}")


def _payload(kind, inner):
    return {"flags": d.IS_COMPONENTS_V2, "components": [{"type": 17, "accent_color": _color(kind), "components": inner}]}


def _buttons(shop_url, repo_url, commit, history, channel):
    row = [d._link_button("Shop", shop_url)] if shop_url else []
    if channel == "shop" and repo_url:
        if commit:
            row.append(d._link_button("Shop Changes", f"{repo_url}/commit/{commit}"))
        row.append(d._link_button("History", f"{repo_url}/commits/shop/{history}"))
    return {"type": 1, "components": row}


def build_single(event, states, logo, repo_url, commit, now, channel):
    region, change = next(iter(event["changes"].items()))
    kind = event["type"]
    item = _art_item(states, event)
    title = (change["title"] or event["key"]).strip()
    text = f"## {d._trim(title, 256)}\n{_status(event)}"
    if price := _price_text(event, states) if kind != "badge" else None:
        text += f" · {price}"
    note = item.get("subHeadline") if kind == "banner" else None if kind == "details" else item.get("description")
    if note:
        text += f"\n{d._trim(note, 200)}"
    inner = d._top(d._text(text), logo, title)
    art = [{"media": {"url": _image(item.get("image"))}}] if item.get("image") else []
    if kind == "details":
        if block := d._diff_block(_detail_lines(change)):
            inner.append(block)
        if "image" in change["changed"]:
            inner.append(d._text("**Before** (left)  ·  **After** (right)"))
            art = [{"media": {"url": _image(change["from"]["image"])}, "description": "Before"},
                   {"media": {"url": _image(change["to"]["image"])}, "description": "After"}]
    if art:
        inner.append({"type": 12, "items": art})
    shop_url = None if kind == "gone" else _url(change["destination"])
    history = f"{region}/{event['family']}/items/{shop_differ.card_name(event['key'])}.md"
    inner += [d.DIVIDER, _buttons(shop_url, repo_url, commit, history, channel), d.DIVIDER,
              _footer("Updated" if kind == "details" else "Posted", now, repo_url)]
    return _payload(kind, inner)


def _line(event, states, emoji=False):
    change = next(iter(event["changes"].values()))
    title = d._trim((change["title"] or event["key"]).strip(), 60).replace("[", "(").replace("]", ")")
    line = f"- {d.SHOP_EMOJI[event['type']]} " if emoji else "- "
    line += f"[{title}]({_url(change['destination'])})" if change["destination"] else title
    if event["type"] in ("new", "back", "sale_start", "price") and (price := _price_text(event, states)):
        line += f" · {price}"
    return line


def _details_body(events, states):
    """A details digest: one diff block per kind of change, each followed by the items it applies to."""
    groups = {}
    for event in events[:MAX_LINES]:
        change = next(iter(event["changes"].values()))
        groups.setdefault(tuple(_detail_lines(change)), []).append(_line(event, states))
    body = []
    for n, (lines, items) in enumerate(groups.items()):
        block = d._diff_block(list(lines))
        body += [{**block, "id": block["id"] + n}, d._text("\n".join(items))]  # every id must be unique
    if len(events) > MAX_LINES:
        body.append(d._text(f"-# …and {len(events) - MAX_LINES} more"))
    return body


def build_digest(post, states, logo, repo_url, commit, now, channel):
    events, kind = post["events"], post["type"]
    heading = DIGEST[kind].format(n=len(events))
    if kind == "details":
        inner = d._top(d._text(f"## {heading}"), logo, heading) + _details_body(events, states)
    else:
        lines = [_line(e, states, emoji=kind is None) for e in events]  # no type means a mix, folded past the cap
        shown = lines[:MAX_LINES]
        if len(lines) > MAX_LINES:
            shown.append(f"-# …and {len(lines) - MAX_LINES} more")
        inner = d._top(d._text(f"## {heading}\n" + "\n".join(shown)), logo, heading)
    images = [{"media": {"url": _image(i["image"])}} for e in events if (i := _art_item(states, e)).get("image")]
    if images:
        inner.append({"type": 12, "items": images[:MAX_IMAGES]})
    family = events[0]["family"]
    inner += [d.DIVIDER, _buttons(f"{SHOP_URL}/family/{family}", repo_url, commit, f"eu/{family}/changes.jsonl", channel),
              d.DIVIDER, _footer("Posted", now, repo_url)]
    return _payload(kind, inner)
