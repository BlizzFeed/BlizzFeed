from bs4 import BeautifulSoup

from modules.providers import http


class ArticleGone(Exception):
    """The article page is a 404 or 410: removed, or never public."""


class BodyNotFound(Exception):
    """The page loaded but the body selector matched nothing, or matched an empty element."""


def article_url(locale, article_id):
    """Blizzard redirects this slug-less URL to the full one, for every game's articles."""
    return f"https://news.blizzard.com/{locale}/article/{article_id}"


def fetch_body(locale, article_id, selector):
    """Returns the article body as an HTML string."""
    try:
        response = http.get(article_url(locale, article_id))
    except http.requests.HTTPError as e:
        if e.response is not None and e.response.status_code in (404, 410):
            raise ArticleGone(article_id) from e
        raise
    body = BeautifulSoup(response.text, "html.parser").select_one(selector)
    if body is None or not body.get_text(strip=True):
        raise BodyNotFound(f"{article_id}: '{selector}' matched nothing usable")
    return str(body)
