import re

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
    return re.sub(r"[^\w\- ]", "", text.strip().lower()).replace(" ", "-")


def _fix_anchors(soup):
    """Point in-page links at GitHub's heading anchors. Blizzard's ids (item1) don't exist in Markdown."""
    targets, seen = {}, {}
    for heading in soup.find_all(re.compile(r"^h[1-6]$")):
        slug = _slug(heading.get_text())
        n = seen.get(slug, 0)
        seen[slug] = n + 1
        if heading.get("id"):
            targets[heading["id"]] = slug if n == 0 else f"{slug}-{n}"
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
    lines = [f"# {item['title']}", "", f"- URL: {item['url']}"]
    if item["image"]:
        lines.append(f"![]({item['image']})")
    lines += ["", f"> {item['summary']}", "", "---", "", text]
    return "\n".join(lines)
