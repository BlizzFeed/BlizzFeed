from modules.notifiers import shop_messages as m

NOW = "2026-10-10T10:00:00+00:00"


def item(amount, discount=None):
    return {"status": "listed", "price": {"fullAmount": amount, "discountAmount": discount}}


def event(kind, **extra):
    change = {"type": kind, "title": "T", "destination": "/x", "seen": NOW, **extra}
    return {"type": kind, "family": "f", "key": "c-1", "slug": "s", "changes": {"eu": change}}


def states(eu, us):
    return {("eu", "f"): {"items": {"c-1": eu}}, ("us", "f"): {"items": {"c-1": us}}}


def test_new_shows_each_regions_price_and_a_shared_currency_once():
    assert m._price_text(event("new"), states(item("€25.00"), item("$25.00"))) == "**€25.00** / **$25.00**"
    assert m._price_text(event("new"), states(item("500 Coins"), item("500 Coins"))) == "**500 Coins**"


def test_new_in_one_region_shows_only_that_price():
    assert m._price_text(event("new"), {("eu", "f"): {"items": {"c-1": item("€25.00")}}}) == "**€25.00**"


def test_price_change_lists_each_changed_region():
    e = event("price", **{"from": "€59.99", "to": "€49.99"})
    e["changes"]["us"] = {**e["changes"]["eu"], "from": "$59.99", "to": "$49.99"}
    assert m._price_text(e, {}) == "€59.99 → **€49.99** / $59.99 → **$49.99**"


def test_details_post_shows_old_and_new_text_and_before_after_images():
    change = {"changed": ["title", "image"], "from": {"title": "A", "image": "//x/a.png"},
              "to": {"title": "B", "image": "//x/b.png"}}
    e = event("details", **change)
    assert m._detail_lines(e["changes"]["eu"]) == ["- A", "+ B", "+ Image changed"]
    parts = m.build_single(e, {}, None, None, None, NOW, "shop")["components"][0]["components"]
    gallery = next(c for c in parts if c["type"] == 12)
    assert [i["description"] for i in gallery["items"]] == ["Before", "After"]


def test_details_digest_shows_one_diff_block_per_kind_of_change_with_unique_ids():
    def moved(key, old, new):
        e = event("details", changed=["sections"], **{"from": {"sections": old}, "to": {"sections": new}})
        return {**e, "key": key}
    events = [moved("a", [], ["Featured"]), moved("b", [], ["Featured"]), moved("c", ["Featured"], [])]
    post = {"type": "details", "events": events}
    parts = m.build_digest(post, {}, None, None, None, NOW, "shop")["components"][0]["components"]
    blocks = [c for c in parts if c["type"] == 10 and c["content"].startswith("```diff")]
    assert [b["content"].split("\n")[1:-1] for b in blocks] == [["- ", "+ Featured"], ["- Featured", "+ "]]
    assert len({b["id"] for b in blocks}) == 2


def test_digest_gallery_shows_shared_art_once_and_only_from_the_listed_items():
    def new(key):
        return {**event("new"), "key": key}
    keys = [f"k{i}" for i in range(14)]
    items = {k: {**item("1"), "image": "//x/shared.png" if i < 2 else f"//x/{i}.png"} for i, k in enumerate(keys)}
    post = {"type": "new", "events": [new(k) for k in keys]}
    parts = m.build_digest(post, {("eu", "f"): {"items": items}}, None, None, None, NOW, "feed")["components"][0]["components"]
    urls = [i["media"]["url"] for i in next(c for c in parts if c["type"] == 12)["items"]]
    assert urls == ["https://x/shared.png"] + [f"https://x/{i}.png" for i in range(2, 12)][:9]


def test_a_removed_banner_has_no_price_to_show():
    e = event("gone")
    assert m._price_text(e, {}) is None
    assert m.build_single(e, {}, None, None, None, NOW, "shop")
