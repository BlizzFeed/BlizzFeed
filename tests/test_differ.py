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
