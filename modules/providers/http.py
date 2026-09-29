import time
import requests

USER_AGENT = "BlizzFeed/1.0 (+https://github.com/BlizzWatch/BlizzFeed; news change tracker)"


def get(url, headers=None, params=None):
    """GET with our User-Agent. On 429, waits for Retry-After (max 30s) and tries once more."""
    headers = {"User-Agent": USER_AGENT, "Accept-Language": "en", **(headers or {})}
    response = requests.get(url, headers=headers, params=params, timeout=20)
    if response.status_code == 429:
        time.sleep(min(int(response.headers.get("Retry-After") or 5), 30))
        response = requests.get(url, headers=headers, params=params, timeout=20)
    response.raise_for_status()
    return response
