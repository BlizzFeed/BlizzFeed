import time
from datetime import datetime, timezone

import requests
from loguru import logger
from urllib3.exceptions import NewConnectionError

SEND_DELAY_SECONDS = 2
POST_ATTEMPTS = 3
COLORS = {"added": 0x57F287, "updated": 0xFAA61A, "down": 0xED4245, "recovered": 0x57F287}
IS_COMPONENTS_V2 = 1 << 15  # message flag: content/embeds are disabled, components only
DIVIDER = {"type": 14, "divider": True, "spacing": 1}


def _trim(text, limit):
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _discord_time(iso):
    """'<t:ts:f> (<t:ts:R>)' renders in each reader's local time, e.g.
    'September 29, 2026 10:31 PM (1 minute ago)'. Falls back to the raw text."""
    try:
        ts = int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return iso
    return f"<t:{ts}:f> (<t:{ts}:R>)"


def _text(content):
    return {"type": 10, "content": content}


def _link_button(label, url):
    return {"type": 2, "style": 5, "label": label, "url": url}


def build_item_message(name, action, item, commit_url, repo_url, role_id=None):
    """Container > Section(text + thumbnail), link buttons, Posted subtext."""
    title = _trim(item["title"], 256)
    label = f"-# {name}\n" if name else ""
    text = _text(_trim(f"{label}## {title}\n{_trim(item['summary'], 600)}", 3000))

    if item["image"]:
        inner = [{"type": 9, "components": [text],
                  "accessory": {"type": 11, "media": {"url": item["image"]}, "description": title[:1024]}}]
    else:
        inner = [text]
    updated = action == "updated"
    buttons = [_link_button(label, url)
               for label, url in (("Read Article", item["url"]),
                                  ("Battle.net Shop", item.get("shop_url")),
                                  ("View Changes" if updated else "View Commit", commit_url)) if url]
    if buttons:
        inner += [DIVIDER, {"type": 1, "components": buttons}]
    # An update keeps the article's original date, so it's stamped with when we noticed the change.
    when = datetime.now(timezone.utc).isoformat() if updated else item["date"]
    posted = f"{'Updated' if updated else 'Posted'} {_discord_time(when)} · " if when else ""
    site = f"[BlizzFeed]({repo_url})" if repo_url else "BlizzFeed"
    inner += [DIVIDER, _text(f"-# {posted}{site}")]

    message = {"flags": IS_COMPONENTS_V2,
               "components": [{"type": 17, "accent_color": COLORS[action], "components": inner}]}
    if role_id:
        message["components"].insert(0, _text(f"<@&{role_id}>"))
        message["allowed_mentions"] = {"roles": [str(role_id)]}
    return message


def build_alert_message(name, alert, run_url):
    if alert["kind"] == "down":
        title = f"{name} - source failing"
        desc = f"Failing since {alert['since']}.\n`{alert['error']}`"
        if run_url:
            desc += f"\n[Run logs]({run_url})"
    else:
        title = f"{name} - source recovered"
        desc = f"Back to normal (was failing since {alert['since']})."
    return {"flags": IS_COMPONENTS_V2, "components": [{
        "type": 17, "accent_color": COLORS[alert["kind"]],
        "components": [_text(_trim(f"## {title}\n{desc}", 3000))]}]}


def _retry_delay(response):
    """Seconds to wait after a 429, from Discord's JSON body. Falls back to 2 if it isn't readable."""
    try:
        return min(max(float(response.json()["retry_after"]), 0), 30)
    except (ValueError, KeyError, TypeError):
        return 2


def _never_sent(error):
    """True when the request can't have reached Discord, so retrying can't post twice.
    A read timeout or a reset mid-response may already have been accepted, so those aren't retried."""
    if isinstance(error, requests.ConnectTimeout):
        return True
    return (isinstance(error, requests.ConnectionError) and error.args
            and isinstance(getattr(error.args[0], "reason", None), NewConnectionError))


def post(webhook_url, payload):
    """POST a message. Retries a 429 (after Discord's retry_after), a 5xx and a failed connect
    (with backoff). Any other 4xx or error fails at once."""
    for attempt in range(1, POST_ATTEMPTS + 1):
        try:
            response = requests.post(webhook_url, params={"with_components": "true"},
                                     json=payload, timeout=10)
        except requests.RequestException as e:
            if _never_sent(e) and attempt < POST_ATTEMPTS:
                logger.warning(f"Discord connect failed (attempt {attempt}/{POST_ATTEMPTS}): {e}")
                time.sleep(2 ** attempt)
                continue
            logger.error(f"Discord request failed: {e}")
            return False
        if response.status_code in (200, 204):
            return True
        if response.status_code == 429:
            time.sleep(_retry_delay(response))
        elif response.status_code >= 500 and attempt < POST_ATTEMPTS:
            logger.warning(f"Discord returned {response.status_code} (attempt {attempt}/{POST_ATTEMPTS})")
            time.sleep(2 ** attempt)
        else:
            logger.error(f"Discord returned {response.status_code}: {response.text[:200]}")
            return False
    return False


def _set_poster(message, source):
    """Post as the game: its title as the name and its logo as the avatar."""
    if source.username:
        message["username"] = source.username
    if source.avatar_url:
        message["avatar_url"] = source.avatar_url


def send_all(diff, sources, repo_url, run_url):
    """sources: {source_id: Source}. Returns the number of failed sends."""
    failures, pinged = 0, set()
    for source_id, entry in diff["sources"].items():
        if not (entry["added"] or entry["updated"]):
            continue
        source = sources[source_id]
        for label in source.missing_labels:
            logger.warning(f"{source_id}: secret DISCORD_WEBHOOK_{label} isn't set; skipping that channel.")
        if not source.channels:
            logger.warning(f"No webhook configured for {source_id}; skipping.")
            continue
        commit_url = f"{repo_url}/commit/{entry['commit']}" if repo_url and entry.get("commit") else None
        for action in ("added", "updated"):
            for item in entry[action]:
                for channel in source.channels:
                    # Each channel pings its role once per run, on its first message.
                    role = None if channel["url"] in pinged else channel["role"]
                    pinged.add(channel["url"])
                    # A source that posts under the game's name doesn't need it repeated in the message.
                    label = None if source.username else source.name
                    message = build_item_message(label, action, item, commit_url, repo_url, role)
                    _set_poster(message, source)
                    if not post(channel["url"], message):
                        failures += 1
                    time.sleep(SEND_DELAY_SECONDS)

    for alert in diff["alerts"]:
        source = sources.get(alert["source"])
        if source and source.channels:
            message = build_alert_message(source.name, alert, run_url)
            _set_poster(message, source)
            if not post(source.channels[0]["url"], message):
                failures += 1
    return failures
