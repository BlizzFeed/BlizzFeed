from modules.processors import shop_differ as sd

T0 = "2026-10-09T10:00:00Z"
T1 = "2026-10-09T10:05:00Z"
LATER = "2026-10-10T11:00:00Z"
NEEDED = 3


def item(key="a", **fields):
    base = {"key": key, "kind": "item", "slug": key, "itemId": None, "destination": f"/product/{key}",
            "title": key.upper(), "description": "d", "image": "i.png",
            "sections": ["Mounts"], "badge": None, "price": {"fullAmount": "9.99", "discountAmount": None}}
    return {**base, **fields}


def banner(key="b", **fields):
    return {**item(key), "kind": "banner", "price": None, "headline": "H", "subHeadline": "S",
            "buttonText": "Buy", "productPageName": None, "destination": "/product/x", **fields}


STABLE = [item(f"z{n}") for n in range(8)]  # so one or two items leaving is under the suspicious-drop share


def page(*items):
    return {i["key"]: i for i in items}


def run(old, fetched, now=T1, confirm=lambda i: False):
    return sd.sweep(old, fetched, now, NEEDED, confirm)


def baseline(*items):
    return run(None, page(*items, *STABLE), now=T0)[0]


def types(changes):
    return [c["type"] for c in changes]


def missing_sweeps(state, sweeps, confirm=lambda i: False, others=()):
    """Sweeps in which every item but `others` is absent from the page."""
    changes = []
    for n in range(sweeps):
        state, new = run(state, page(*others, *STABLE), now=f"2026-10-09T10:{10 + n:02d}:00Z", confirm=confirm)
        changes += new
    return state, changes


def test_a_first_run_records_everything_and_reports_nothing():
    state, changes = run(None, page(item("a"), banner()))
    assert changes == [] and set(state["items"]) == {"a", "b"}


def test_an_unchanged_page_changes_nothing_in_the_state():
    state = baseline(item("a"), banner())
    again, changes = run(state, page(item("a"), banner(), *STABLE))
    assert changes == [] and again == state  # so no commit every sweep


def test_a_key_we_never_saw_is_new_and_one_we_saw_go_is_back():
    state = baseline(item("a"))
    state, changes = run(state, page(item("a"), item("c"), *STABLE))
    assert types(changes) == ["new"]
    state, _ = missing_sweeps(state, NEEDED, others=[item("a")])
    assert state["items"]["c"]["status"] == "gone"
    state, changes = run(state, page(item("a"), item("c"), *STABLE), now=LATER)
    assert types(changes) == ["back"] and state["items"]["c"]["status"] == "listed"


def test_price_sale_badge_and_details_changes():
    state = baseline(item("a"))
    sale = item("a", price={"fullAmount": "19.99", "discountAmount": "4.99"}, badge="New", title="Renamed")
    state, changes = run(state, page(sale, *STABLE))
    assert types(changes) == ["price", "sale_start", "badge", "details"]
    assert changes[2]["maybe_new"] is True and changes[3]["changed"] == ["title"]
    _, changes = run(state, page(item("a", price={"fullAmount": "19.99", "discountAmount": None}, badge="New",
                                 title="Renamed"), *STABLE))
    assert types(changes) == ["sale_end"]


def test_a_details_change_keeps_the_old_and_new_values():
    state = baseline(item("a"))
    _, changes = run(state, page(item("a", title="Renamed", sections=["Mounts", "Featured"]), *STABLE))
    assert changes[0]["from"] == {"title": "A", "sections": ["Mounts"]}
    assert changes[0]["to"] == {"title": "Renamed", "sections": ["Mounts", "Featured"]}


def test_a_banners_product_is_its_own_name_else_the_card_it_links_to():
    named = banner("n", productPageName="Forever", slug="forever")
    unnamed = banner("u", slug="card-slug", itemId=7)
    card = item("c", slug="card-slug", itemId=7, title="The Card")
    _, changes = run(baseline(item("a")), page(item("a"), named, unnamed, card, *STABLE))
    products = {c["key"]: c["product"] for c in changes if c["type"] == "banner"}
    assert products == {"n": "Forever", "u": "The Card"}


def test_banners_report_added_and_changed_never_price_or_details():
    state, changes = run(baseline(item("a")), page(item("a"), banner(), *STABLE))
    assert [(c["type"], c["what"]) for c in changes] == [("banner", "added")]
    _, changes = run(state, page(item("a"), banner(headline="Other", title="Other"), *STABLE))
    assert types(changes) == ["banner"] and changes[0]["changed"] == ["headline"]


def test_an_item_is_only_gone_after_enough_missed_sweeps():
    state = baseline(item("a"), item("b"))
    state, changes = missing_sweeps(state, NEEDED - 1, others=[item("b")])
    assert changes == [] and state["items"]["a"]["status"] == "missing"
    state, changes = missing_sweeps(state, 1, others=[item("b")])
    assert types(changes) == ["gone"]


def test_reappearing_before_then_resets_the_count_and_logs_nothing():
    state = baseline(item("a"), item("b"))
    state, _ = missing_sweeps(state, NEEDED - 1, others=[item("b")])
    state, changes = run(state, page(item("a"), item("b"), *STABLE))
    assert changes == [] and state["items"]["a"]["misses"] == 0


def test_a_priced_item_still_for_sale_is_unlisted_not_gone_and_rechecked_daily():
    asked = []

    def confirm(i):
        asked.append(i["key"])
        return True

    state = baseline(item("a"), item("b"))
    state, changes = missing_sweeps(state, NEEDED, confirm, others=[item("b")])
    assert types(changes) == ["unlisted"] and asked == ["a"]
    state, changes = run(state, page(item("b"), *STABLE), now="2026-10-09T20:00:00Z", confirm=confirm)
    assert changes == [] and asked == ["a"]  # checked less than a day ago
    state, changes = run(state, page(item("b"), *STABLE), now=LATER, confirm=lambda i: False)
    assert types(changes) == ["gone"]


def test_an_unlisted_item_that_returns_to_the_page_is_listed_again_silently():
    state = baseline(item("a"), item("b"))
    state, _ = missing_sweeps(state, NEEDED, lambda i: True, others=[item("b")])
    state, changes = run(state, page(item("a"), item("b"), *STABLE))
    assert changes == [] and state["items"]["a"]["status"] == "listed"


def test_free_items_and_banners_are_gone_without_asking_the_item_page():
    def confirm(i):
        raise AssertionError("asked")

    free = item("f", price={"fullAmount": None, "raw": 0})
    state = baseline(free, banner(), item("c"))
    _, changes = missing_sweeps(state, NEEDED, confirm, others=[item("c")])
    assert sorted(types(changes)) == ["gone", "gone"]


def test_a_failed_check_is_retried_next_sweep_instead_of_deciding():
    def broken(i):
        raise OSError("network")

    state = baseline(item("a"), item("b"))
    state, changes = missing_sweeps(state, NEEDED + 1, broken, others=[item("b")])
    assert changes == [] and state["items"]["a"]["status"] == "missing"
    _, changes = run(state, page(item("b"), *STABLE), confirm=lambda i: False)
    assert types(changes) == ["gone"]


def test_a_big_drop_is_held_once_and_believed_when_the_next_fetch_agrees():
    keep, drop = [item("k")], [item(f"d{n}") for n in range(3)]
    state = baseline(*keep, *drop)
    held, changes = run(state, page(*keep))
    assert changes == [] and held["suspect"] and held["items"] == state["items"]
    state, _ = run(held, page(*keep))
    assert state["suspect"] is False and state["items"]["d0"]["misses"] == 1


def test_a_big_drop_that_recovers_is_forgotten():
    state = baseline(item("k"), item("d"))
    held, _ = run(state, page(item("k")))
    state, changes = run(held, page(item("k"), item("d")))
    assert changes == [] and state["suspect"] is False and state["items"]["d"]["misses"] == 0


def test_a_product_only_item_that_gains_a_card_is_the_same_item():
    state = baseline(item("p:5", itemId=5, title="X"))
    state, changes = run(state, page(item("blt1", itemId=5, title="X"), *STABLE))
    assert changes == [] and "p:5" not in state["items"] and state["items"]["blt1"]["first_seen"] == T0
    state, changes = run(state, page(item("blt1", itemId=5, title="X", price={"fullAmount": "7.99", "discountAmount": None}), *STABLE))
    assert types(changes) == ["price"]


def test_a_new_shop_family_is_reported_once_and_the_first_check_reports_nothing():
    new, meta = sd.family_check({}, ["a", "b", "c"], ["a"], T0)
    assert new == []
    new, meta = sd.family_check(meta, ["a", "b", "c", "d"], ["a"], T1)
    assert new == ["d"]
    new, _ = sd.family_check(meta, ["a", "b", "c", "d"], ["a"], LATER)
    assert new == []
