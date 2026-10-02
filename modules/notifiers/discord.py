import os
import time
from datetime import datetime, timezone

import requests
from loguru import logger
from urllib3.exceptions import NewConnectionError

POST_ATTEMPTS = 3
COLORS = {"added": 0x57F287, "updated": 0xFAA61A, "down": 0xED4245, "recovered": 0x57F287, "log": 0x5865F2}
LOG_USERNAME = "BlizzFeed Log"
LOG_AVATAR = "https://raw.githubusercontent.com/BlizzFeed/BlizzFeed/source/logos/BlizzFeed_ServerIcon_512.png"
LOG_TEXT_BUDGET = 3000  # Discord allows 4000 characters of text per message; the rest is header and footer
IS_COMPONENTS_V2 = 1 << 15  # message flag: content/embeds are disabled, components only
DIVIDER = {"type": 14, "divider": True, "spacing": 1}
LOG_HEADING = "Changes detected"
ARCHIVE_LOG_HEADING = "Archive changes"
ARCHIVE_SECTION = "### 📦 Archive"
LOG_TOTAL_TEXT = 4000  # Discord's limit for the text of one message
# Component ids the bot looks for when it merges two posts (same numbers in the bot's merge.py)
DIFF_ID, BUTTONS_ID, FOOTER_ID = 100, 101, 102


def _trim(text, limit):
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _discord_time(iso, relative_only=False):
    """'<t:ts:s> (<t:ts:R>)' renders in each reader's local time, e.g.
    '09/29/2026 10:31 PM (1 minute ago)'. relative_only keeps just the '1 minute ago',
    with the full date on hover. Falls back to the raw text."""
    try:
        ts = int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return iso
    return f"<t:{ts}:R>" if relative_only else f"<t:{ts}:s> (<t:{ts}:R>)"


def _code_block(text):
    """Fenced block for log-like text; a ``` inside it would close the block early."""
    return f"```\n{text.replace('```', chr(39) * 3)}\n```"


def _text(content, id=None):
    return {"type": 10, "content": content} if id is None else {"type": 10, "id": id, "content": content}


def _link_button(label, url):
    return {"type": 2, "style": 5, "label": label, "url": url}


def history_url(repo_url, source_id, item_id):
    """The article's commit history on the archive branch. Built from the path alone, so it works
    before the file exists (GitHub answers 200 for a history of a path it hasn't seen)."""
    return f"{repo_url}/commits/archive/{source_id}/{item_id}.md" if repo_url else None


def preview_url(repo_url, commit, source_id, item_id):
    """The card's Markdown file at the commit that wrote it, which GitHub renders as a page."""
    return f"{repo_url}/blob/{commit}/{source_id}/items/{item_id}.md" if repo_url and commit else None


def _diff_block(lines):
    """A ```diff block, which Discord colours green for + and red for -. None when there's nothing to show."""
    if not lines:
        return None
    body = "\n".join(lines).replace("`", "'")  # a backtick in a title would end the block
    return _text(f"```diff\n{body}\n```", DIFF_ID)


def _card_diff_lines(item):
    """What changed on an updated card: the old and new title, and whether the summary or image changed."""
    changed = item.get("changed", [])
    lines = []
    if "title" in changed:
        lines += [f"- {_trim(item.get('previous_title', ''), 100)}", f"+ {_trim(item['title'], 100)}"]
    if "summary" in changed:
        lines.append("+ Summary changed")
    if "image" in changed:
        lines.append("+ Image changed")
    return lines


def _line_count_lines(change):
    """The + / ~ / - lines of an edited article's text, leaving out what is zero."""
    lines = []
    for sign, key, word in (("+", "added", "added"), ("~", "changed", "changed"), ("-", "removed", "removed")):
        n = change.get(key, 0)
        if n:
            lines.append(f"{sign} {n} line{'s' if n != 1 else ''} {word}")
    return lines


def build_item_message(action, item, commit_url, repo_url, preview=None, history=None):
    """Container > Section(text + thumbnail), link buttons, Posted subtext.

    A new article links its Preview, an updated one its card diff (Summary Changes). Both link the History.
    An updated one also lists what changed on the card, when we know."""
    title = _trim(item["title"], 256)
    text = _text(_trim(f"## {title}\n{_trim(item['summary'], 600)}", 3000))

    updated = action == "updated"
    before = item.get("previous_image") if updated and "image" in item.get("changed", []) else ""
    if item["image"] and not before:
        inner = [{"type": 9, "components": [text],
                  "accessory": {"type": 11, "media": {"url": item["image"]}, "description": title[:1024]}}]
    else:
        inner = [text]
    if updated and (block := _diff_block(_card_diff_lines(item))):
        inner.append(block)
    if before and item["image"]:
        # Old and new side by side instead of a thumbnail, which would only repeat the new one.
        inner += [_text("**Before** (left)  ·  **After** (right)"),
                  {"type": 12, "items": [{"media": {"url": before}, "description": "Before"},
                                         {"media": {"url": item["image"]}, "description": "After"}]}]
    buttons = [_link_button(label, url)
               for label, url in (("Read Article", item["url"]),
                                  ("Battle.net Shop", item.get("shop_url")),
                                  ("Summary Changes", commit_url) if updated else ("Preview", preview),
                                  ("History", history)) if url]
    if buttons:
        inner += [DIVIDER, {"type": 1, "id": BUTTONS_ID, "components": buttons}]
    # An update keeps the article's original date, so it's stamped with when we noticed the change.
    when = datetime.now(timezone.utc).isoformat() if updated else item["date"]
    posted = f"{'Updated' if updated else 'Posted'} {_discord_time(when)} · " if when else ""
    site = f"[BlizzFeed]({repo_url})" if repo_url else "BlizzFeed"
    inner += [DIVIDER, _text(f"-# {posted}{site}", FOOTER_ID)]

    message = {"flags": IS_COMPONENTS_V2,
               "components": [{"type": 17, "accent_color": COLORS[action], "components": inner}]}
    return message


def build_edit_message(change, repo_url, source_id, commit_url):
    """An article whose text was edited: title, summary, thumbnail, the line counts, and
    Read Article / Article Changes / History buttons. It looks like an update and has the same colour."""
    title = _trim(change["title"], 256)
    text = _text(_trim(f"## {title}\n{_trim(change.get('summary', ''), 600)}".rstrip(), 3000))
    if change.get("image"):
        inner = [{"type": 9, "components": [text],
                  "accessory": {"type": 11, "media": {"url": change["image"]}, "description": title[:1024]}}]
    else:
        inner = [text]
    if block := _diff_block(_line_count_lines(change)):
        inner.append(block)
    buttons = [_link_button(label, url)
               for label, url in (("Read Article", change.get("url")),
                                  ("Article Changes", commit_url),
                                  ("History", history_url(repo_url, source_id, change["id"]))) if url]
    if buttons:
        inner += [DIVIDER, {"type": 1, "id": BUTTONS_ID, "components": buttons}]
    site = f"[BlizzFeed]({repo_url})" if repo_url else "BlizzFeed"
    inner += [DIVIDER, _text(f"-# Updated {_discord_time(datetime.now(timezone.utc).isoformat())} · {site}", FOOTER_ID)]
    message = {"flags": IS_COMPONENTS_V2,
               "components": [{"type": 17, "accent_color": COLORS["updated"], "components": inner}]}
    return message


def build_alert_message(name, alert, run_url, what="source"):
    if alert["kind"] == "down":
        title = f"{name} - {what} failing"
        desc = f"Failing since {_discord_time(alert['since'], relative_only=True)}.\n{_code_block(alert['error'])}"
        if run_url:
            desc += f"\n[Run logs]({run_url})"
    else:
        title = f"{name} - {what} recovered"
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
        containers.append(_log_container(LOG_HEADING, blocks, len(diff["sources"]), run_url, "Data run"))
    for alert in down:
        source = sources.get(alert["source"])
        containers += build_alert_message(source.name if source else alert["source"], alert, run_url)["components"]
    return _log_payload(containers)


def _log_payload(containers):
    return {"flags": IS_COMPONENTS_V2, "username": LOG_USERNAME, "avatar_url": LOG_AVATAR,
            "components": containers}


def _fit_lines(block, limit):
    """Cut a block at a line end, so a link is never cut in half, and say how many lines were left out."""
    if len(block) <= limit:
        return block
    lines, kept, size = block.split("\n"), [], 0
    for line in lines:
        if kept and size + len(line) + 1 > limit - 30:  # room for the note
            break
        kept.append(line)
        size += len(line) + 1
    return "\n".join(kept + [f"-# …and {len(lines) - len(kept)} more"])


def _log_container(heading, blocks, total, run_url, run_label):
    """The blurple summary container: a block per changed source, trimmed to fit, then an unchanged count."""
    shown, used = [], 0
    for block in blocks:
        if shown and used + len(block) > LOG_TEXT_BUDGET:
            break
        shown.append(_fit_lines(block, LOG_TEXT_BUDGET))
        used += len(block) + 2
    if len(shown) < len(blocks):
        more = len(blocks) - len(shown)
        shown.append(f"-# …and {more} more source{'s' if more != 1 else ''}")
    now = _discord_time(datetime.now(timezone.utc).isoformat())
    inner = [_text(f"## {heading}\n-# {now} · {len(blocks)} of {total} sources changed"),
             DIVIDER, _text("\n\n".join(shown))]
    if total > len(blocks):
        inner += [DIVIDER, _text(f"-# Unchanged: {total - len(blocks)} source{'s' if total - len(blocks) != 1 else ''}")]
    if run_url:
        inner.append({"type": 1, "components": [_link_button(run_label, run_url)]})
    return {"type": 17, "accent_color": COLORS["log"], "components": inner}


ARCHIVE_EMOJI = {"archived": "📦", "text": "📝", "card": "🎴", "reformatted": "🔧"}
ARCHIVE_LABEL = {"archived": "archived", "text": "text edited", "card": "summary changed",
                 "reformatted": "reformatted"}


def _archive_log_entry(name, entry, repo_url, recovered_since):
    """One source's part of the archive log: a counts line, then a line per article linked to its commit."""
    counts = {}
    for change in entry["articles"]:
        counts[change["kind"]] = counts.get(change["kind"], 0) + 1
    parts = [f"{counts[kind]} {ARCHIVE_LABEL[kind]}" for kind in ARCHIVE_LABEL if kind in counts]
    if recovered_since:
        parts.append(f"✅ recovered (was failing since {_discord_time(recovered_since, relative_only=True)})")
    lines = [f"**{name}** · {', '.join(parts)}"]
    for change in entry["articles"]:
        label = _trim(change["title"], 100).replace("[", "(").replace("]", ")")
        detail = f" +{change['added']} ~{change['changed']} −{change['removed']}" if change["kind"] == "text" else ""
        # Only the window sweep finds these, so they show whether it's worth widening.
        detail += " · silent edit (date unchanged)" if change.get("silent") else ""
        commit = change.get("commit")
        link = f"[{label}]({repo_url}/commit/{commit})" if repo_url and commit else label
        lines.append(f"- {ARCHIVE_EMOJI[change['kind']]} {link}{detail}")
    return "\n".join(lines)


def build_archive_log_message(diff, sources, repo_url, run_url):
    """Summary of an archive run for the log channel, or None when nothing changed.
    Archive failures and recoveries only ever go here, never to a game's channels."""
    recovered = {a["source"]: a["since"] for a in diff["alerts"] if a["kind"] == "recovered"}
    blocks = []
    for source_id, entry in diff["sources"].items():
        if entry["articles"] or source_id in recovered:
            source = sources.get(source_id)
            blocks.append(_archive_log_entry(source.name if source else source_id, entry, repo_url,
                                             recovered.get(source_id)))
    down = [a for a in diff["alerts"] if a["kind"] == "down"]
    if not blocks and not down:
        return None
    containers = []
    if blocks:
        # diff only has the sources fetched this run, so count from all of them.
        containers.append(_log_container(ARCHIVE_LOG_HEADING, blocks, len(sources), run_url, "Archive run"))
    for alert in down:
        source = sources.get(alert["source"])
        containers += build_alert_message(source.name if source else alert["source"], alert, run_url,
                                          what="archive")["components"]
    return _log_payload(containers)


def _without_ids(node):
    """Discord adds ids to the components of a message it sends back; drop them so they can't clash with new parts."""
    if isinstance(node, list):
        return [_without_ids(n) for n in node]
    if isinstance(node, dict):
        return {k: _without_ids(v) for k, v in node.items() if k != "id"}
    return node


def _heading(container):
    first = next((c for c in container.get("components", []) if c.get("type") == 10), None)
    return first["content"].split("\n")[0] if first else None


def _text_length(node):
    if isinstance(node, list):
        return sum(_text_length(n) for n in node)
    if isinstance(node, dict):
        own = len(node["content"]) if node.get("type") == 10 else 0
        return own + _text_length(node.get("components", []))
    return 0


def merge_archive_log(existing, archive):
    """Fold an archive run's log into the tracker run's log post. None when that post isn't a run log,
    already has an archive section, or would get too long."""
    components = _without_ids(existing.get("components") or [])
    log = next((c for c in components if c.get("type") == 17 and _heading(c) == f"## {LOG_HEADING}"), None)
    if log is None or any(c.get("type") == 10 and c["content"].startswith(ARCHIVE_SECTION)
                          for c in log["components"]):
        return None
    inner = log["components"]
    archive_log = next((c for c in archive["components"] if _heading(c) == f"## {ARCHIVE_LOG_HEADING}"), None)
    if archive_log:
        # Before the unchanged count, or else before the buttons.
        at = next((i for i, c in enumerate(inner) if i >= 3 and c["type"] in (14, 1)), len(inner))
        inner[at:at] = [DIVIDER, _text(f"{ARCHIVE_SECTION}\n{archive_log['components'][2]['content']}")]
        buttons = next((c["components"] for c in archive_log["components"] if c["type"] == 1), [])
        if buttons:
            row = next((c for c in inner if c["type"] == 1), None)
            if row is None:
                row = {"type": 1, "components": []}
                inner.append(row)
            row["components"] += buttons
    merged = {"flags": IS_COMPONENTS_V2,
              "components": components + [c for c in archive["components"] if c is not archive_log]}
    return merged if _text_length(merged["components"]) <= LOG_TOTAL_TEXT else None


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


def _request(method, url, payload=None):
    """Send a request. Retries a 429 (after Discord's retry_after), a 5xx and a failed connect
    (with backoff). Any other 4xx or error fails at once. Returns the response, or None."""
    for attempt in range(1, POST_ATTEMPTS + 1):
        try:
            # wait: a POST answers with the new message.
            response = requests.request(method, url, params={"with_components": "true", "wait": "true"},
                                        json=payload, timeout=10)
        except requests.RequestException as e:
            if _never_sent(e) and attempt < POST_ATTEMPTS:
                logger.warning(f"Discord connect failed (attempt {attempt}/{POST_ATTEMPTS}): {e}")
                time.sleep(2 ** attempt)
                continue
            logger.error(f"Discord request failed: {e}")
            return None
        if response.status_code in (200, 204):
            return response
        if response.status_code == 429:
            time.sleep(_retry_delay(response))
        elif response.status_code >= 500 and attempt < POST_ATTEMPTS:
            logger.warning(f"Discord returned {response.status_code} (attempt {attempt}/{POST_ATTEMPTS})")
            time.sleep(2 ** attempt)
        else:
            logger.error(f"Discord returned {response.status_code}: {response.text[:200]}")
            return None
    return None


def _json(response):
    try:
        return response.json() if response is not None else None
    except ValueError:
        return None


def post(webhook_url, payload):
    """POST a message. Returns its id, or None."""
    message = _json(_request("POST", webhook_url, payload))
    return message.get("id") if message else None


def fetch_message(webhook_url, message_id):
    return _json(_request("GET", f"{webhook_url}/messages/{message_id}"))


def edit_message(webhook_url, message_id, payload):
    return _request("PATCH", f"{webhook_url}/messages/{message_id}", payload) is not None


def send_log(diff, sources, repo_url, run_url):
    """Post the run summary to DISCORD_WEBHOOK_LOG and return its message id. Skipped when it isn't set, and it never fails the run."""
    url = os.environ.get("DISCORD_WEBHOOK_LOG")
    if not url:
        logger.info("DISCORD_WEBHOOK_LOG isn't set; skipping the run log.")
        return None
    message = build_log_message(diff, sources, repo_url, run_url)
    message_id = post(url, message) if message else None
    if message_id:
        logger.info("Posted the run log.")
    return message_id


def send_archive_log(diff, sources, repo_url, run_url, log_message=None):
    """Post the archive summary (and any archive alerts) to DISCORD_WEBHOOK_LOG. With log_message, the
    tracker run's post, it is added to that post instead, or posted on its own if that fails. Never fails the run."""
    url = os.environ.get("DISCORD_WEBHOOK_LOG")
    if not url:
        logger.info("DISCORD_WEBHOOK_LOG isn't set; skipping the archive log.")
        return
    message = build_archive_log_message(diff, sources, repo_url, run_url)
    if not message:
        return
    if log_message:
        existing = fetch_message(url, log_message)
        merged = merge_archive_log(existing, message) if existing else None
        if merged and edit_message(url, log_message, merged):
            logger.info("Added the archive log to the run log.")
            return
        logger.warning("Couldn't add the archive log to the run log; posting it on its own.")
    if post(url, message):
        logger.info("Posted the archive log.")
