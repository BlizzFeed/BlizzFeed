import pytest
import requests

from modules.providers import article

SELECTOR = "article.Content section.blog"


class FakeResponse:
    def __init__(self, status=200, text=""):
        self.status_code, self.text = status, text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(response=self)


def fake_get(response):
    """Like http.get, which raises on an error status."""
    def get(url, **kwargs):
        response.raise_for_status()
        return response
    return get


@pytest.mark.parametrize("body", ["<p>Hi</p>", '<iframe src="https://v/1"></iframe>', '<img src="https://i/1.png"/>'])
def test_returns_body_html(monkeypatch, body):
    page = f'<article class="Content"><section class="blog">{body}</section></article>'
    monkeypatch.setattr(article.http, "get", fake_get(FakeResponse(text=page)))
    assert article.fetch_body("en-gb", "1", SELECTOR) == f'<section class="blog">{body}</section>'


@pytest.mark.parametrize("status", [404, 410])
def test_gone(monkeypatch, status):
    monkeypatch.setattr(article.http, "get", fake_get(FakeResponse(status)))
    with pytest.raises(article.ArticleGone):
        article.fetch_body("en-gb", "1", SELECTOR)


def test_server_error_is_not_gone(monkeypatch):
    monkeypatch.setattr(article.http, "get", fake_get(FakeResponse(500)))
    with pytest.raises(requests.HTTPError):
        article.fetch_body("en-gb", "1", SELECTOR)


@pytest.mark.parametrize("page", ["<p>no body</p>", '<article class="Content"><section class="blog"> </section></article>'])
def test_missing_or_empty_body(monkeypatch, page):
    monkeypatch.setattr(article.http, "get", fake_get(FakeResponse(text=page)))
    with pytest.raises(article.BodyNotFound):
        article.fetch_body("en-gb", "1", SELECTOR)
