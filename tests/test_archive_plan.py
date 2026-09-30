from datetime import datetime, timezone

from modules.processors import archiver

NOW = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)
CFG = {"window_days": 7, "baseline_days": 30, "max_fetches": 60}


def item(article_id, date):
    return {"id": article_id, "date": date, "title": "T", "url": "u", "image": "", "summary": "s"}


def ids(plan):
    return [(i["id"], reason) for i, reason in plan]


def test_changed_date_is_fetched_whatever_its_age():
    items = [item("old", "2020-01-01T00:00:00Z")]
    assert ids(archiver.plan(items, {"old": "2019-12-31T00:00:00Z"}, NOW, CFG, sweep=False)) == [("old", "changed")]


def test_unchanged_date_is_skipped_without_a_sweep():
    items = [item("a", "2026-09-29T00:00:00Z")]
    assert archiver.plan(items, {"a": "2026-09-29T00:00:00Z"}, NOW, CFG, sweep=False) == []


def test_unindexed_article_only_within_baseline_days():
    items = [item("new", "2026-09-10T00:00:00Z"), item("ancient", "2026-08-01T00:00:00Z")]
    assert ids(archiver.plan(items, {}, NOW, CFG, sweep=False)) == [("new", "changed")]


def test_sweep_adds_recent_unchanged_articles_once():
    items = [item("recent", "2026-09-28T00:00:00Z"), item("stale", "2026-09-01T00:00:00Z"),
             item("edited", "2026-09-29T00:00:00Z")]
    index = {"recent": "2026-09-28T00:00:00Z", "stale": "2026-09-01T00:00:00Z", "edited": "2026-09-20T00:00:00Z"}
    assert ids(archiver.plan(items, index, NOW, CFG, sweep=True)) == [("edited", "changed"), ("recent", "sweep")]


def test_select_puts_changed_first_newest_first_and_caps():
    candidates = [("s", item("sweep-new", "2026-09-29T00:00:00Z"), "sweep"),
                  ("s", item("changed-old", "2026-09-01T00:00:00Z"), "changed"),
                  ("s", item("changed-new", "2026-09-28T00:00:00Z"), "changed")]
    assert [c[1]["id"] for c in archiver.select(candidates, 2)] == ["changed-new", "changed-old"]


def test_sweep_due():
    assert archiver.sweep_due({}, 55, NOW)
    assert not archiver.sweep_due({"last_sweep": "2026-09-30T11:30:00Z"}, 55, NOW)
    assert archiver.sweep_due({"last_sweep": "2026-09-30T11:05:00Z"}, 55, NOW)


def test_classify_and_line_changes():
    old = archiver.render_file(item("1", "d"), "a\nb\nc\n")
    same_text_new_card = archiver.render_file({**item("1", "d"), "title": "Other"}, "a\nb\nc\n")
    edited = archiver.render_file(item("1", "d"), "a\nB\nc\nd\n")
    assert archiver.classify(None, old) == "archived"
    assert archiver.classify(old, old) is None
    assert archiver.classify(old, same_text_new_card) == "card"
    assert archiver.classify(old, edited) == "text"
    assert archiver.line_changes(archiver.split_file(old)[1], archiver.split_file(edited)[1]) == (2, 1)


def test_summary_newlines_cannot_break_the_card_split():
    content = archiver.render_file({**item("1", "d"), "summary": "one\n\n---\n\ntwo"}, "Body.\n")
    assert archiver.split_file(content)[1] == "Body.\n"
