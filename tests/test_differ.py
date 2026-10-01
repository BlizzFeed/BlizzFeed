from modules.processors import differ

OLD = {"id": "1", "title": "Old", "summary": "S", "image": "i.png", "date": "d", "url": "u"}


def test_changed_fields_lists_only_what_differs():
    new = {**OLD, "title": "New", "image": "j.png", "date": "d2"}
    assert differ.changed_fields(OLD, new) == ["title", "image"]


def test_a_date_only_change_is_quiet_not_updated():
    added, updated, quiet = differ.compute([OLD], [{**OLD, "date": "d2"}])
    assert (added, updated, len(quiet)) == ([], [], 1)
