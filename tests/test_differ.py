from modules.processors import differ

OLD = {"id": "1", "title": "Old", "summary": "S", "image": "i.png", "date": "d", "url": "u"}


def test_changed_fields_lists_only_what_differs():
    new = {**OLD, "title": "New", "image": "j.png", "date": "d2"}
    assert differ.changed_fields(OLD, new) == ["title", "image"]


def test_a_date_only_change_is_quiet_not_updated():
    added, updated, quiet = differ.compute([OLD], [{**OLD, "date": "d2"}])
    assert (added, updated, len(quiet)) == ([], [], 1)


def test_new_shop_links_are_an_added_or_changed_link_but_not_a_first_run():
    old = [{**OLD, "shop_url": "a"}, {**OLD, "id": "2"}]
    items = [{**OLD, "shop_url": "a"}, {**OLD, "id": "2", "shop_url": "b"}, {**OLD, "id": "3", "shop_url": "c"},
             {**OLD, "id": "4"}]
    assert [i["id"] for i in differ.new_shop_links(old, items)] == ["2", "3"]
    assert differ.new_shop_links(None, items) == []


def test_a_saved_shop_link_survives_a_feed_card_without_one_but_a_card_link_wins():
    old = [{**OLD, "shop_url": "saved"}, {**OLD, "id": "2", "shop_url": "saved"}, {**OLD, "id": "3"}]
    items = [{**OLD}, {**OLD, "id": "2", "shop_url": "card"}, {**OLD, "id": "3"}, {**OLD, "id": "4"}]
    differ.keep_shop_urls(old, items)
    assert [i.get("shop_url") for i in items] == ["saved", "card", None, None]
    assert differ.compute(old, [{**OLD, "shop_url": "saved"}]) == ([], [], [])
