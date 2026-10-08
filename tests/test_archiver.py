import os

from modules.processors import archiver

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "article-24296142.html")
ITEM = {"title": "Hotfixes", "url": "https://news.blizzard.com/en-gb/article/1", "image": "https://x/i.jpg", "summary": "Card."}


def _fixture():
    with open(FIXTURE, encoding="utf-8") as f:
        return f.read()


def test_normalised_whitespace():
    text = archiver.to_markdown(_fixture())
    assert text.endswith("\n") and not text.endswith("\n\n")
    assert "\n\n\n" not in text
    assert all(line == line.rstrip() for line in text.splitlines())


def test_strips_script_and_style():
    text = archiver.to_markdown('<p>a</p><script>x()</script><style>p{}</style>')
    assert "x()" not in text and "p{}" not in text


def test_render_file_layout():
    out = archiver.render_file(ITEM, "Body.\n")
    assert out == (
        "# Hotfixes\n\n- URL: https://news.blizzard.com/en-gb/article/1\n![](https://x/i.jpg)\n\n"
        "> Card.\n\n---\n\nBody.\n"
    )


def _read(name):
    with open(os.path.join(os.path.dirname(__file__), "fixtures", name), encoding="utf-8") as f:
        return f.read()


def test_line_breaks_survive_whitespace_stripping():
    text = archiver.to_markdown(_read("article-24244888.html"))
    # a <br> must survive the trailing-whitespace strip, or the two lines merge into one paragraph
    assert "**Luminous Sporeglider Mount**  \n*This mount is earned" in text


def test_in_page_links_use_github_anchors():
    text = archiver.to_markdown(_read("article-24244888.html"))
    assert "[TRAVEL TO VAL AND NAIGTAL TO QUELL LEADERS OF THE VOID](#travel-to-val-and-naigtal-to-quell-leaders-of-the-void)" in text
    assert "[Back to Top](#table-of-contents)" in text
    assert "(#item1)" not in text and "(#item10)" not in text


def test_duplicate_headings_get_numbered_anchors():
    # identical headings under two tabs, so the tags themselves compare equal
    html = ('<a href="#a">x</a><a href="#b">y</a>'
            '<div id="a"><h3>Talents</h3></div><div id="b"><h3>Talents</h3></div>')
    text = archiver.to_markdown(html)
    assert "[x](#talents)" in text and "[y](#talents-1)" in text


def test_anchor_of_a_heading_split_over_lines():
    text = archiver.to_markdown('<a href="#x">jump</a><h2 id="x">Patch\nNotes</h2>')
    assert "[jump](#patch-notes)" in text


def test_iframe_variants():
    nocookie = archiver.to_markdown('<iframe src="https://www.youtube-nocookie.com/embed/ab_-12"></iframe>')
    assert "youtube/ab_-12?width=1280&height=720" in nocookie and "watch?v=ab_-12)" in nocookie
    other = archiver.to_markdown('<iframe src="https://player.vimeo.com/video/1"></iframe>')
    assert other.strip() == "[https://player.vimeo.com/video/1](https://player.vimeo.com/video/1)"


def test_tab_links_point_at_the_first_heading_of_each_pane():
    text = archiver.to_markdown(_read("article-24301515.html"))
    assert "- [Hunter](#taking-aim-at-the-hunter-class)" in text
    assert "- [Druid](#shifting-forms-with-the-druid-class)" in text


def test_line_breaks_use_trailing_spaces_and_one_ending_a_paragraph_is_dropped():
    text = archiver.to_markdown("<p>one<br/>\r\n\xa0</p><p>two<br/>three</p>")
    assert text == "one\n\ntwo  \nthree\n"
