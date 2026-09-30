import os
import time
from datetime import datetime, timezone
from urllib.parse import quote

import requests
from loguru import logger
from urllib3.exceptions import NewConnectionError

from modules.core.config import AVATAR_PROXY

SEND_DELAY_SECONDS = 2
POST_ATTEMPTS = 3
COLORS = {"added": 0x57F287, "updated": 0xFAA61A, "down": 0xED4245, "recovered": 0x57F287, "log": 0x5865F2}
LOG_USERNAME = "BlizzFeed Log"
LOG_AVATAR_SVG = (
    "https://blz-contentstack-images.akamaized.net/v3/"
    "assets/blt286175c11a6b3f4c/blta8332c202f63da84/60f74b93ef929764f0bb4e96/nexus-color.svg"
)
LOG_AVATAR = AVATAR_PROXY + quote(LOG_AVATAR_SVG, safe="")  # Discord doesn't show SVG avatars
LOG_TEXT_BUDGET = 3000  # Discord allows 4000 characters of text per message; the rest is header and footer
IS_COMPONENTS_V2 = 1 << 15  # message flag: content/embeds are disabled, components only
DIVIDER = {"type": 14, "divider": True, "spacing": 1}


def _trim(text, limit):
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _discord_time(iso, relative_only=False):
    """'<t:ts:f> (<t:ts:R>)' renders in each reader's local time, e.g.
    'September 29, 2026 10:31 PM (1 minute ago)'. relative_only keeps just the '1 minute ago',
    with the full date on hover. Falls back to the raw text."""
    try:
        ts = int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return iso
    return f"<t:{ts}:R>" if relative_only else f"<t:{ts}:f> (<t:{ts}:R>)"


def _code_block(text):
    """Fenced block for log-like text; a ``` inside it would close the block early."""
    return f"```\n{text.replace('```', chr(39) * 3)}\n```"


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
        desc = f"Failing since {_discord_time(alert['since'], relative_only=True)}.\n{_code_block(alert['error'])}"
        if run_url:
            desc += f"\n[Run logs]({run_url})"
    else:
        title = f"{name} - source recovered"
        desc = f"Back to normal (was failing since {_discord_time(alert['since'], relative_only=True)})."
    return {"flags": IS_COMPONENTS_V2, "components": [{
        "type": 17, "accent_color": COLORS[alert["kind"]],
        "components": [_text(_trim(f"## {title}\n{desc}", 3000))]}]}


def _log_entry(name, entry, repo_url, recovered_since):
    """One source's part of the log: a counts line (linked to its commit), then a line per announced item."""
    commit = entry.get("commit")
    title = f"[{name}]({repo_url}/commit/{commit})" if repo_url and commit else name
    if entry["baseline"]:
        parts = [f"🆕 baseline, {entry['items']} items stored, no notifications"]
    else:
        parts = []
        if entry["added"]:
            parts.append(f"+{len(entry['added'])} new")
        if entry["updated"]:
            parts.append(f"{len(entry['updated'])} updated")
        if entry["quiet"]:
            parts.append(f"{entry['quiet']} quiet" + ("" if parts else " (date/url only, nothing announced)"))
    if recovered_since:
        parts.append(f"✅ recovered (was failing since {_discord_time(recovered_since, relative_only=True)})")
    lines = [f"**{title}** · {', '.join(parts)}"]
    for emoji, action in (("🟢", "added"), ("🟠", "updated")):
        for item in entry[action]:
            label = _trim(item["title"], 100).replace("[", "(").replace("]", ")")
            lines.append(f"- {emoji} [{label}]({item['url']})")
    return "\n".join(lines)


def build_log_message(diff, sources, repo_url, run_url):
    """Dev/debug summary of a run, or None when nothing changed. A source that is failing
    gets its own red container; one that recovered is listed with the changes."""
    recovered = {a["source"]: a["since"] for a in diff["alerts"] if a["kind"] == "recovered"}
    blocks = []
    for source_id, entry in diff["sources"].items():
        if entry["baseline"] or entry["added"] or entry["updated"] or entry["quiet"] or source_id in recovered:
            source = sources.get(source_id)
            blocks.append(_log_entry(source.name if source else source_id, entry, repo_url,
                                     recovered.get(source_id)))
    down = [a for a in diff["alerts"] if a["kind"] == "down"]
    if not blocks and not down:
        return None

    containers = []
    if blocks:
        shown, used = [], 0
        for block in blocks:
            if shown and used + len(block) > LOG_TEXT_BUDGET:
                break
            shown.append(_trim(block, LOG_TEXT_BUDGET))
            used += len(block) + 2
        if len(shown) < len(blocks):
            shown.append(f"-# …and {len(blocks) - len(shown)} more")
        total = len(diff["sources"])
        now = _discord_time(datetime.now(timezone.utc).isoformat())
        inner = [_text(f"## Changes detected\n-# {now} · {len(blocks)} of {total} sources changed"),
                 DIVIDER, _text("\n\n".join(shown))]
        if total > len(blocks):
            inner += [DIVIDER, _text(f"-# Unchanged: {total - len(blocks)} source{'s' if total - len(blocks) != 1 else ''}")]
        if run_url:
            inner.append({"type": 1, "components": [_link_button("View run", run_url)]})
        containers.append({"type": 17, "accent_color": COLORS["log"], "components": inner})
    for alert in down:
        source = sources.get(alert["source"])
        containers += build_alert_message(source.name if source else alert["source"], alert, run_url)["components"]
    return {"flags": IS_COMPONENTS_V2, "username": LOG_USERNAME, "avatar_url": LOG_AVATAR,
            "components": containers}


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


def send_log(diff, sources, repo_url, run_url):
    """Post the run summary to DISCORD_WEBHOOK_LOG. Skipped when it isn't set, and it never fails the run."""
    url = os.environ.get("DISCORD_WEBHOOK_LOG")
    if not url:
        logger.info("DISCORD_WEBHOOK_LOG isn't set; skipping the run log.")
        return
    message = build_log_message(diff, sources, repo_url, run_url)
    if message and post(url, message):
        logger.info("Posted the run log.")


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
