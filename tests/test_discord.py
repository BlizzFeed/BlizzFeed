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
        discord.preview_url(REPO, "dat", "wow-news", "42"), discord.history_url(REPO, "wow-news", "42"))


def test_new_article_buttons():
    assert buttons(item_message("added")) == {
        "Read Article": ITEM["url"], "Battle.net Shop": ITEM["shop_url"],
        "Preview": f"{REPO}/blob/dat/wow-news/items/42.md",
        "History": f"{REPO}/commits/archive/wow-news/42.md"}


def test_updated_article_buttons():
    assert buttons(item_message("updated")) == {
        "Read Article": ITEM["url"], "Battle.net Shop": ITEM["shop_url"],
        "View Changes": f"{REPO}/commit/dat", "History": f"{REPO}/commits/archive/wow-news/42.md"}


def test_edit_message():
    message = discord.build_edit_message(CHANGE, REPO, "wow-news", f"{REPO}/commit/abc123")
    assert buttons(message) == {"Read Article": ITEM["url"], "Text Changes": f"{REPO}/commit/abc123",
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
    assert "Text Changes" not in buttons(message)


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
