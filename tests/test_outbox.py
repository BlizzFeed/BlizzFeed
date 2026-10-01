from modules.core.config import Source
from modules.notifiers import outbox

REPO = "https://github.com/BlizzFeed/BlizzFeed"
IDS = {"DIABLO4": {"all": "d4", "new": "d4n", "updated": "d4u"},
       "DIABLO": {"all": "d", "new": "dn", "updated": "du"}}
ITEM = {"id": "42", "title": "Hotfixes", "url": "https://x/42", "summary": "s", "image": None, "date": "2026-09-30T10:00:00Z"}


def source(labels, ids=IDS):
    return {"d4": Source({"id": "d4", "name": "Diablo IV News", "type": "json", "url": "https://x/en-gb/f",
                          "channels": labels}, {}, {}, ids)}


def channels(entries):
    return sorted(e["channel"] for e in entries)


def tracker_diff(added=(), updated=()):
    return {"sources": {"d4": {"added": list(added), "updated": list(updated), "quiet": 0}}}


def test_new_article_goes_to_all_and_new_of_every_label():
    entries = outbox.build_tracker_entries(tracker_diff(added=[ITEM]), source(["DIABLO4", "DIABLO"]), REPO, "t")
    assert channels(entries) == ["d", "d4", "d4n", "dn"]


def test_updated_and_edited_go_to_all_and_updated():
    sources = source(["DIABLO4", "DIABLO"])
    updated = outbox.build_tracker_entries(tracker_diff(updated=[ITEM]), sources, REPO, "t")
    edited = outbox.build_archive_entries(
        {"sources": {"d4": {"articles": [{**ITEM, "kind": "text", "added": 1, "removed": 1}]}}}, sources, REPO, "t")
    assert channels(updated) == channels(edited) == ["d", "d4", "d4u", "du"]
    assert {e["kind"] for e in edited} == {"edited"}


def test_missing_ids_are_skipped_and_other_archive_kinds_are_not_posted():
    sources = source(["DIABLO4", "WOW"], {"DIABLO4": {"all": "d4"}})
    entries = outbox.build_tracker_entries(tracker_diff(added=[ITEM]), sources, REPO, "t")
    assert channels(entries) == ["d4"]
    card = {"sources": {"d4": {"articles": [{**ITEM, "kind": "card"}]}}}
    assert outbox.build_archive_entries(card, sources, REPO, "t") == []


def test_messages_are_bot_safe():
    entries = outbox.build_tracker_entries(tracker_diff(added=[ITEM]), source(["DIABLO4"]), REPO, "t")
    assert not {"username", "avatar_url", "allowed_mentions"} & entries[0]["message"].keys()
