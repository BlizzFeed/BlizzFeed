import time
import requests

USER_AGENT = "BlizzFeed/1.0 (+https://github.com/BlizzWatch/BlizzFeed; news change tracker)"
DEFAULT_RETRY_SECONDS = 5
MAX_RETRY_SECONDS = 30


def _retry_delay(response):
    """Seconds to wait after a 429. Retry-After can also be a date, which we don't parse."""
    try:
        return min(max(int(response.headers["Retry-After"]), 0), MAX_RETRY_SECONDS)
    except (KeyError, ValueError):
        return DEFAULT_RETRY_SECONDS


def get(url, headers=None, params=None):
    """GET with our User-Agent. On 429, waits for Retry-After (max 30s) and tries once more."""
    headers = {"User-Agent": USER_AGENT, "Accept-Language": "en", **(headers or {})}
    response = requests.get(url, headers=headers, params=params, timeout=20)
    if response.status_code == 429:
        time.sleep(_retry_delay(response))
        response = requests.get(url, headers=headers, params=params, timeout=20)
    response.raise_for_status()
    return response
