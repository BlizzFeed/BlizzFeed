import difflib
import json
import os
import re
from datetime import datetime, timedelta, timezone

from bs4 import BeautifulSoup
from markdownify import MarkdownConverter

YOUTUBE_ID = re.compile(r"(?:youtube\.com|youtube-nocookie\.com)/embed/([\w-]+)")
# 1280x720 is YouTube's largest thumbnail; GitHub shrinks it to fit the column. The service adds the play button.
YOUTUBE_THUMBNAIL = "https://markdown-videos-api.jorgenkh.no/youtube/{id}?width=1280&height=720"


class _Converter(MarkdownConverter):
    def convert_iframe(self, el, text, parent_tags):
        """Embedded YouTube video becomes a clickable thumbnail, any other video a plain link."""
        src = el.get("src")
        if not src:
            return ""
        m = YOUTUBE_ID.search(src)
        if m:
            video = m.group(1)
            return f"\n\n[![Video]({YOUTUBE_THUMBNAIL.format(id=video)})](https://www.youtube.com/watch?v={video})\n\n"
        return f"\n\n[{src}]({src})\n\n"


def _slug(text):
    """GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens."""
    return re.sub(r"[^\w\- ]", "", " ".join(text.split()).lower()).replace(" ", "-")


def _fix_anchors(soup):
    """Point in-page links at GitHub's heading anchors. Blizzard's ids (item1) don't exist in Markdown.

    An id on a section (a tab pane, say) points at the first heading inside it."""
    anchors, seen = {}, {}
    for heading in soup.find_all(re.compile(r"^h[1-6]$")):
        slug = _slug(heading.get_text())
        n = seen.get(slug, 0)
        seen[slug] = n + 1
        anchors[heading] = slug if n == 0 else f"{slug}-{n}"
    targets = {}
    for el in soup.find_all(id=True):
        heading = el if el in anchors else el.find(re.compile(r"^h[1-6]$"))
        if heading is not None:
            targets[el["id"]] = anchors[heading]
    for a in soup.find_all("a", href=True):
        m = re.fullmatch(r"(?:/news/\d+)?#(.+)", a["href"])
        if m and m.group(1) in targets:
            a["href"] = "#" + targets[m.group(1)]


def to_markdown(body_html):
    """Article body HTML to normalised Markdown, one block per line so diffs stay line-level."""
    soup = BeautifulSoup(body_html, "html.parser")
    for el in soup(["script", "style"]):
        el.decompose()
    _fix_anchors(soup)
    text = _Converter(heading_style="ATX", bullets="-", wrap=False, newline_style="backslash").convert_soup(soup)
    text = "\n".join(line.rstrip() for line in text.splitlines())
    text = re.sub(r"^(#+) \*\*(.+)\*\*$", r"\1 \2", text, flags=re.M)  # bold inside a heading adds nothing
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


def render_file(item, text):
    """The archived file: the card, then a separator, then the article text. lastUpdated is left out on purpose."""
    summary = " ".join(item["summary"].split())  # one line, so the separator below can't appear inside the card
    lines = [f"# {item['title']}", "", f"- URL: {item['url']}"]
    if item["image"]:
        lines.append(f"![]({item['image']})")
    lines += ["", f"> {summary}", "", "---", "", text]
    return "\n".join(lines)


CARD_TEXT_SEPARATOR = "\n\n---\n\n"
DATE_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def now_iso(now=None):
    return (now or datetime.now(timezone.utc)).strftime(DATE_FORMAT)


def _parse(date):
    return datetime.strptime(date, DATE_FORMAT).replace(tzinfo=timezone.utc)


def sweep_due(archive_state, sweep_minutes, now):
    """True when the window sweep hasn't run for sweep_minutes (or ever)."""
    last = archive_state.get("last_sweep")
    return last is None or now - _parse(last) >= timedelta(minutes=sweep_minutes)


def plan(items, index, now, cfg, sweep):
    """Articles of one source to fetch this run, as (item, reason) pairs.

    "changed": the feed date differs from the one the archive recorded, with no age limit. An article
    the archive has never seen counts too, if it was updated within baseline_days.
    "sweep": updated within window_days, to catch edits that don't bump the date. Only when sweep is True.
    """
    by_date = sorted(items, key=lambda i: i["date"], reverse=True)
    baseline_cutoff = now - timedelta(days=cfg["baseline_days"])
    window_cutoff = now - timedelta(days=cfg["window_days"])

    def changed(item):
        if item["id"] in index:
            return index[item["id"]] != item["date"]
        return _parse(item["date"]) >= baseline_cutoff

    chosen = [(i, "changed") for i in by_date if changed(i)]
    picked = {i["id"] for i, _ in chosen}
    if sweep:
        chosen += [(i, "sweep") for i in by_date
                   if i["id"] not in picked and _parse(i["date"]) >= window_cutoff]
    return chosen


def select(candidates, max_fetches):
    """Cap the run's (source, item, reason) candidates: changed before sweep, newest first within each.

    Whatever is cut carries over: a changed article's date still differs next run.
    """
    ordered = sorted(candidates, key=lambda c: c[1]["date"], reverse=True)
    ordered.sort(key=lambda c: c[2] != "changed")
    return ordered[:max_fetches]


def split_file(content):
    """(card, text) of an archived file."""
    card, _, text = content.partition(CARD_TEXT_SEPARATOR)
    return card, text


def line_changes(old_text, new_text):
    """(added, removed) line counts between two texts."""
    old, new = old_text.splitlines(), new_text.splitlines()
    added = removed = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if tag in ("replace", "delete"):
            removed += i2 - i1
        if tag in ("replace", "insert"):
            added += j2 - j1
    return added, removed


def classify(old_content, new_content):
    """How an article changed: archived (no old file), text, card, or None when identical."""
    if old_content is None:
        return "archived"
    if old_content == new_content:
        return None
    return "text" if split_file(old_content)[1] != split_file(new_content)[1] else "card"


def index_path(archive_dir, source_id):
    return os.path.join(archive_dir, source_id, "index.json")


def article_path(source_id, article_id):
    return f"{source_id}/{article_id}.md"


def _load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_json(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(value, f, indent=2, sort_keys=True, ensure_ascii=False)
        f.write("\n")


def load_index(archive_dir, source_id):
    return _load_json(index_path(archive_dir, source_id), {})


def save_index(archive_dir, source_id, index):
    _save_json(index_path(archive_dir, source_id), index)


ARCHIVE_STATE_FILE = "_archive.json"


def load_archive_state(archive_dir):
    return _load_json(os.path.join(archive_dir, ARCHIVE_STATE_FILE), {})


def save_archive_state(archive_dir, state):
    _save_json(os.path.join(archive_dir, ARCHIVE_STATE_FILE), state)


def read_article(archive_dir, source_id, article_id):
    path = os.path.join(archive_dir, article_path(source_id, article_id))
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8", newline="") as f:
        return f.read().replace("\r\n", "\n")


def write_article(archive_dir, source_id, article_id, content):
    path = os.path.join(archive_dir, article_path(source_id, article_id))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
