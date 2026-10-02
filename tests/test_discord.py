from types import SimpleNamespace

from modules.notifiers import discord

REPO = "https://github.com/BlizzFeed/BlizzFeed"
ITEM = {"id": "42", "title": "Hotfixes", "url": "https://news.blizzard.com/en-gb/article/42", "summary": "Card text.",
        "image": "https://x/i.png", "date": "2026-09-30T10:00:00Z", "shop_url": "https://shop.battle.net/p"}
CHANGE = {"id": "42", "title": "Hotfixes", "kind": "text", "url": ITEM["url"], "image": ITEM["image"],
          "added": 1, "changed": 2, "removed": 3, "commit": "abc123", "silent": False}


def buttons(message):
    container = message["components"][-1]
    row = next(c for c in container["components"] if c["type"] == 1)
    return {b["label"]: b["url"] for b in row["components"]}


def texts(message):
    out = []

    def walk(node):
        if node.get("type") == 10:
            out.append(node["content"])
        for child in node.get("components", []):
            walk(child)
        if "accessory" in node:
            walk(node["accessory"])
    for c in message["components"]:
        walk(c)
    return "\n".join(out)


def item_message(action):
    return discord.build_item_message(
        action, ITEM, f"{REPO}/commit/dat", REPO,
        discord.summary_url(REPO, "dat", "wow-news", "42"), discord.archive_url(REPO, "wow-news", "42"),
        discord.history_url(REPO, "wow-news", "42"))


def test_update_and_edit_messages_carry_the_ids_the_bot_merges_by():
    updated = {**ITEM, "changed": ["title"], "previous_title": "Old"}
    for message in (discord.build_item_message("updated", updated, f"{REPO}/commit/dat", REPO),
                    discord.build_edit_message(CHANGE, REPO, "wow-news", f"{REPO}/commit/arc")):
        ids = set()

        def walk(node):
            ids.add(node.get("id"))
            for child in node.get("components", []):
                walk(child)
        for c in message["components"]:
            walk(c)
        assert {discord.DIFF_ID, discord.BUTTONS_ID, discord.FOOTER_ID} <= ids


def test_new_article_buttons():
    assert buttons(item_message("added")) == {
        "Read Article": ITEM["url"], "Battle.net Shop": ITEM["shop_url"],
        "Summary": f"{REPO}/blob/dat/wow-news/items/42.md",
        "Archived Copy": f"{REPO}/blob/archive/wow-news/42.md",
        "History": f"{REPO}/commits/archive/wow-news/42.md"}


def test_updated_article_buttons():
    assert buttons(item_message("updated")) == {
        "Read Article": ITEM["url"], "Battle.net Shop": ITEM["shop_url"],
        "Summary Changes": f"{REPO}/commit/dat", "History": f"{REPO}/commits/archive/wow-news/42.md"}


def test_edit_message():
    message = discord.build_edit_message(CHANGE, REPO, "wow-news", f"{REPO}/commit/abc123")
    assert buttons(message) == {"Read Article": ITEM["url"], "Article Changes": f"{REPO}/commit/abc123",
                                "History": f"{REPO}/commits/archive/wow-news/42.md"}
    assert "+ 1 line added\n~ 2 lines changed\n- 3 lines removed" in texts(message)
    assert "allowed_mentions" not in message


def test_edit_message_leaves_out_zero_counts():
    message = discord.build_edit_message({**CHANGE, "added": 8, "changed": 0, "removed": 0}, REPO, "wow-news", None)
    assert "+ 8 lines added" in texts(message)
    assert "changed" not in texts(message) and "removed" not in texts(message)


def test_image_change_shows_before_and_after_instead_of_a_thumbnail():
    item = {**ITEM, "image": "https://x/new.png", "changed": ["image"], "previous_title": "Hotfixes",
            "previous_image": "https://x/old.png"}
    inner = discord.build_item_message("updated", item, None, REPO)["components"][0]["components"]
    gallery = next(c for c in inner if c["type"] == 12)
    assert [i["media"]["url"] for i in gallery["items"]] == ["https://x/old.png", "https://x/new.png"]
    assert not any("accessory" in c for c in inner)


def test_other_updates_keep_the_thumbnail():
    item = {**ITEM, "changed": ["summary"], "previous_image": "https://x/old.png"}
    inner = discord.build_item_message("updated", item, None, REPO)["components"][0]["components"]
    assert inner[0]["accessory"]["media"]["url"] == ITEM["image"]
    assert not any(c["type"] == 12 for c in inner)


def test_updated_card_lists_what_changed():
    item = {**ITEM, "title": "New", "changed": ["title", "image"], "previous_title": "Old"}
    body = texts(discord.build_item_message("updated", item, None, REPO))
    assert "- Old\n+ New\n+ Image changed" in body
    assert "Summary" not in body.split("```diff")[1]


def test_edit_message_without_image():
    message = discord.build_edit_message({**CHANGE, "image": ""}, REPO, "wow-news", None)
    assert "Article Changes" not in buttons(message)


def diff(articles, alerts=()):
    return {"sweep": True, "alerts": list(alerts),
            "sources": {"wow-news": {"articles": articles, "gone": [], "failed": 0}, "other": {"articles": [], "gone": [], "failed": 0}}}


SOURCES = {"wow-news": SimpleNamespace(id="wow-news", name="WoW"), "other": SimpleNamespace(id="other", name="Other")}


def test_archive_log_lists_changes_and_silent_edits():
    articles = [CHANGE, {**CHANGE, "id": "7", "title": "New", "kind": "archived", "commit": "def"},
                {**CHANGE, "id": "8", "title": "Quiet", "silent": True, "commit": "eee"}]
    body = texts(discord.build_archive_log_message(diff(articles), SOURCES, REPO, "https://run"))
    assert "1 of 2 sources changed" in body
    assert "2 text edited" in body and "1 archived" in body
    assert f"[Hotfixes]({REPO}/commit/abc123) +1 ~2 −3" in body
    assert "Quiet" in body and "silent edit (date unchanged)" in body


def test_archive_log_skipped_when_nothing_changed():
    assert discord.build_archive_log_message(diff([]), SOURCES, REPO, None) is None


def test_archive_alerts_go_to_log_with_archive_wording():
    down = {"source": "wow-news", "kind": "down", "error": "boom", "since": "2026-09-30T09:00:00Z"}
    body = texts(discord.build_archive_log_message(diff([], [down]), SOURCES, REPO, None))
    assert "WoW - archive failing" in body
    recovered = {"source": "wow-news", "kind": "recovered", "since": "2026-09-30T09:00:00Z"}
    body = texts(discord.build_archive_log_message(diff([], [recovered]), SOURCES, REPO, None))
    assert "recovered" in body


def test_long_archive_log_is_cut_between_lines_not_inside_a_link():
    articles = [{**CHANGE, "id": str(i), "title": f"A rather long article title number {i}", "kind": "archived",
                 "commit": f"{i:040d}"} for i in range(30)]
    body = texts(discord.build_archive_log_message(diff(articles), SOURCES, REPO, None))
    lines = [line for line in body.splitlines() if line.startswith("- ")]
    assert lines and all(line.endswith(")") for line in lines)
    assert f"-# …and {30 - len(lines)} more" in body


def tracker_log(extra_alerts=()):
    entry = {"baseline": False, "items": 5, "added": [{"title": "Patch", "url": "https://x/patch"}],
             "updated": [], "quiet": 0, "commit": "aaa"}
    return discord.build_log_message({"alerts": list(extra_alerts), "sources": {"wow-news": entry, "other": {**entry, "added": []}}},
                                     SOURCES, REPO, "https://run/data")


def read_back(message):
    """A fetched message: the same components, each with an id."""
    def add_ids(node, counter=iter(range(1, 1000))):
        if isinstance(node, list):
            return [add_ids(n) for n in node]
        if isinstance(node, dict):
            return {**{k: add_ids(v) for k, v in node.items()}, "id": next(counter)}
        return node
    return {"components": add_ids(message["components"])}


def button_urls(message):
    return [b["url"] for c in message["components"] for row in c["components"] if row["type"] == 1
            for b in row["components"]]


def test_archive_log_is_folded_into_the_tracker_post():
    archive = discord.build_archive_log_message(diff([{**CHANGE, "kind": "archived"}]), SOURCES, REPO, "https://run/archive")
    merged = discord.merge_archive_log(read_back(tracker_log()), archive)
    assert len(merged["components"]) == 1
    body = texts(merged)
    assert body.index("Patch") < body.index(f"{REPO}/commit/abc123") < body.index("Unchanged")
    assert button_urls(merged) == ["https://run/data", "https://run/archive"]
    assert not any("id" in c for c in merged["components"][0]["components"])


def test_archive_alerts_stay_their_own_container_when_folded():
    down = {"source": "wow-news", "kind": "down", "error": "boom", "since": "2026-09-30T09:00:00Z"}
    archive = discord.build_archive_log_message(diff([CHANGE], [down]), SOURCES, REPO, "https://run/archive")
    merged = discord.merge_archive_log(read_back(tracker_log()), archive)
    assert len(merged["components"]) == 2
    assert "archive failing" in texts({"components": merged["components"][1:]})


def test_archive_alerts_alone_are_added_below_the_tracker_post():
    down = {"source": "wow-news", "kind": "down", "error": "boom", "since": "2026-09-30T09:00:00Z"}
    archive = discord.build_archive_log_message(diff([], [down]), SOURCES, REPO, None)
    merged = discord.merge_archive_log(read_back(tracker_log()), archive)
    assert len(merged["components"]) == 2 and button_urls(merged) == ["https://run/data"]


def test_archive_log_is_not_folded_into_something_else():
    archive = discord.build_archive_log_message(diff([CHANGE]), SOURCES, REPO, "https://run/archive")
    folded = discord.merge_archive_log(read_back(tracker_log()), archive)
    assert discord.merge_archive_log(read_back(folded), archive) is None  # already has its archive part
    assert discord.merge_archive_log({"components": []}, archive) is None  # a message with nothing readable
    assert discord.merge_archive_log(read_back(archive), archive) is None  # not a tracker post


def test_archive_log_is_not_folded_when_the_post_would_get_too_long():
    long_run = {**CHANGE, "kind": "archived"}
    archive = discord.build_archive_log_message(diff([{**long_run, "id": str(i), "title": f"Article number {i}"} for i in range(30)]),
                                                SOURCES, REPO, "https://run/archive")
    tracker = tracker_log()
    tracker["components"][0]["components"][2]["content"] += "x" * 1500
    assert discord.merge_archive_log(read_back(tracker), archive) is None
