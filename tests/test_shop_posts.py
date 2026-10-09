from modules.processors import shop_posts as sp

FAMILIES = {"world-of-warcraft": {"sources": ["wow-news", "wow-news-us"]},
            "overwatch": {"sources": ["overwatch-news"]}}
NOW = "2026-10-10T10:00:00+00:00"


def change(kind="new", key="c-1", slug="thing"):
    return {"type": kind, "key": key, "slug": slug, "seen": NOW}


def fresh(region, family="overwatch", **kw):
    return (region, family, change(**kw))


def event(kind, regions, family="overwatch", key="c-1"):
    return {"type": kind, "family": family, "key": key, "slug": "s", "seen": NOW,
            "changes": {r: change(kind, key) for r in regions}}


def item_event(kind, key="c-1", **extra):
    return {"type": kind, "family": "overwatch", "key": key, "slug": "s", "seen": NOW,
            "changes": {"eu": {**change(kind, key), **extra}}}


def test_one_items_changes_in_a_run_are_one_post_per_destination():
    posts = sp.plan([item_event("sale_end"), item_event("price")], FAMILIES)
    shop = [p for p in posts if p["destination"] == ("shop", None)]
    assert len(shop) == 1 and [e["type"] for e in shop[0]["events"]] == ["price", "sale_end"]
    feed = [p for p in posts if p["destination"][0] == "feed"]
    assert [[e["type"] for e in p["events"]] for p in feed] == [["price"]]  # sale_end isn't a feed type


def test_a_sale_that_became_the_regular_price_goes_to_the_shop_channel_as_a_sale_end_only():
    posts = sp.plan([item_event("price", sale_kept=True), item_event("sale_end", sale_kept=True)], FAMILIES)
    assert [(p["destination"], [e["type"] for e in p["events"]]) for p in posts] == [(("shop", None), ["sale_end"])]


def test_same_sweep_in_both_regions_is_one_event():
    events, ledger = sp.resolve([], [fresh("eu"), fresh("us")], NOW)
    assert len(events) == 1 and set(events[0]["changes"]) == {"eu", "us"} and "was" not in events[0]


def test_other_region_arriving_later_edits_the_earlier_post():
    events, ledger = sp.resolve([], [fresh("eu")], NOW)
    posts = sp.plan(events, FAMILIES)
    ledger = sp.remember(ledger, posts, NOW)
    assert [e["changes"].keys() for e in ledger] == [{"eu"}]
    events, ledger = sp.resolve(ledger, [fresh("us")], "2026-10-10T10:10:00+00:00")
    assert ledger == [] and events[0]["was"] == ["eu"] and set(events[0]["changes"]) == {"eu", "us"}
    assert all(p["edit"] for p in sp.plan(events, FAMILIES))


def test_a_late_other_region_is_a_new_event():
    events, ledger = sp.resolve([], [fresh("eu")], NOW)
    ledger = sp.remember(ledger, sp.plan(events, FAMILIES), NOW)
    events, ledger = sp.resolve(ledger, [fresh("us")], "2026-10-10T11:00:00+00:00")
    assert "was" not in events[0] and set(events[0]["changes"]) == {"us"}


def test_wow_edits_the_eu_feed_and_posts_new_to_the_us_feed():
    events, ledger = sp.resolve([], [fresh("eu", "world-of-warcraft", kind="price")], NOW)
    ledger = sp.remember(ledger, sp.plan(events, FAMILIES), NOW)
    events, _ = sp.resolve(ledger, [fresh("us", "world-of-warcraft", kind="price")], NOW)
    posts = {p["destination"]: p["edit"] for p in sp.plan(events, FAMILIES)}
    assert posts == {("feed", "wow-news"): True, ("feed", "wow-news-us"): False, ("shop", None): True}


def test_different_keys_pair_by_unique_slug_only():
    events, _ = sp.resolve([], [fresh("eu", key="c-1", slug="a"), fresh("us", key="c-2", slug="a")], NOW)
    assert len(events) == 1
    events, _ = sp.resolve([], [fresh("eu", key="c-1", slug="a"), fresh("eu", key="c-3", slug="a"),
                                fresh("us", key="c-2", slug="a")], NOW)
    assert len(events) == 3  # the slug is shared, so it can't tell which one is meant


def test_other_types_and_families_do_not_pair():
    events, _ = sp.resolve([], [fresh("eu", kind="price"), fresh("us", kind="new"),
                                fresh("eu", family="world-of-warcraft"), fresh("us")], NOW)
    assert len(events) == 4


def test_digested_events_are_not_remembered_for_edits():
    events, ledger = sp.resolve([], [fresh("eu", key=f"c-{n}") for n in range(3)], NOW)
    assert sp.remember(ledger, sp.plan(events, FAMILIES), NOW) == []


def test_wow_posts_to_each_regions_feed_and_game_without_us_feed_does_not():
    both = event("price", ["eu", "us"], "world-of-warcraft")
    assert sp.audiences(both, FAMILIES["world-of-warcraft"]["sources"]) == [
        ("feed", "wow-news"), ("feed", "wow-news-us"), ("shop", None)]
    assert sp.audiences(event("new", ["us"]), FAMILIES["overwatch"]["sources"]) == [("shop", None)]


def test_shop_only_types_and_logged_only_types():
    sources = FAMILIES["overwatch"]["sources"]
    assert sp.audiences(event("gone", ["eu"]), sources) == [("shop", None)]
    assert sp.audiences(event("unlisted", ["eu"]), sources) == []


def test_three_of_a_type_make_a_digest_two_stay_single():
    events = [event("new", ["eu"], key=f"c-{n}") for n in range(3)] + \
             [event("price", ["eu"], key=f"c-{n}") for n in range(2)]
    posts = [p for p in sp.plan(events, FAMILIES) if p["destination"][0] == "feed"]
    assert [(p["kind"], p["type"], len(p["events"])) for p in posts] == [
        ("digest", "new", 3), ("single", "price", 1), ("single", "price", 1)]


def test_more_than_five_posts_fold_into_one():
    events = [event(kind, ["eu"], key=f"c-{n}") for n, kind in enumerate(
        ["new", "new", "back", "back", "price", "price", "badge", "badge"])]
    posts = [p for p in sp.plan(events, FAMILIES) if p["destination"][0] == "feed"]
    assert len(posts) == sp.MAX_POSTS
    assert posts[-1]["kind"] == "more" and len(posts[-1]["events"]) == 4
