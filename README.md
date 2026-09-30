# BlizzFeed

Watches the Blizzard news feeds (news.blizzard.com, en-gb) every minute on GitHub Actions, started by an external trigger. When a new article appears, it saves it to the `data` branch and posts it to Discord with its title, summary, thumbnail, link and post time, plus a link to the commit that recorded it.

## Sources
| Source | Webhook secret |
| --- | --- |
| World of Warcraft (EU) | `DISCORD_WEBHOOK_WOW` |
| World of Warcraft (US) | `DISCORD_WEBHOOK_WOW_US` |
| Heroes of the Storm | `DISCORD_WEBHOOK_HOTS` |
| Hearthstone | `DISCORD_WEBHOOK_HEARTHSTONE` |
| Diablo V | `DISCORD_WEBHOOK_DIABLO5` and `DISCORD_WEBHOOK_DIABLO` |
| Diablo IV | `DISCORD_WEBHOOK_DIABLO4` and `DISCORD_WEBHOOK_DIABLO` |
| Diablo Immortal | `DISCORD_WEBHOOK_DIABLOIMMORTAL` and `DISCORD_WEBHOOK_DIABLO` |
| Diablo II Resurrected | `DISCORD_WEBHOOK_DIABLO2` and `DISCORD_WEBHOOK_DIABLO` |
| Diablo III | `DISCORD_WEBHOOK_DIABLO3` and `DISCORD_WEBHOOK_DIABLO` |
| Overwatch | `DISCORD_WEBHOOK_OVERWATCH` |
| STARCRAFT | `DISCORD_WEBHOOK_STARCRAFT` |
| StarCraft Remastered | `DISCORD_WEBHOOK_STARCRAFTREMASTERED` |
| StarCraft II | `DISCORD_WEBHOOK_STARCRAFT2` |
| Warcraft III | `DISCORD_WEBHOOK_WARCRAFT3` |
| Warcraft Rumble | `DISCORD_WEBHOOK_WARCRAFTRUMBLE` |
| Blizzard (BlizzCon, company) | `DISCORD_WEBHOOK_BLIZZARD` |

World of Warcraft is also read from the en-us feed, which words some titles and dates differently, and posts to its own channel. Every other game uses the en-gb feed only.

Each Diablo game posts to its own channel and also to one shared Diablo channel (`DISCORD_WEBHOOK_DIABLO`). A source can list more than one webhook. The first is its own channel, and only that one gets the "source failing" alerts. Any secret you don't set is simply skipped.

To ping a role, add the webhook label and the role ID under `ping_roles` in `sources.yaml` (for example `DIABLO: "123456789"` for an @diablo in the shared channel). Each channel pings its role once per run, and channels without an entry never ping.

Optionally, `DISCORD_WEBHOOK_LOG` points at a private dev channel. After a run where something changed (new, updated, date/url-only, a baseline, or a source failing or recovering) it gets one summary message linking each source's commit. Runs with no changes post nothing, and a failed log post never fails the run. The archive posts its own summary there too.

More Blizzard products can be added by putting another entry in `sources.yaml`.

## How it works
- Each run reads the newest articles from each feed and compares them with the saved state. The feed is sorted by last update, so it stops as soon as it reaches articles it already has. Usually that's one request per source.
- New articles are committed to the `data` branch (one commit per source) and announced on Discord. Articles with a changed title, summary, image or link are announced too, in orange. If only the date changed, the saved copy is updated without a post.
- The first run for a source saves the last 150 articles without posting anything, so old articles that get edited later aren't mistaken for new ones.
- If a source fails 12 runs in a row (about 12 minutes), Discord gets a "failing" message, and a "recovered" one when it works again.

## Article archive
The feeds only carry the short version of each article: title, summary and thumbnail. Blizzard also edits the article text quietly (hotfix lists grow, patch notes get corrected), so the archive keeps the text too.

- Each article is saved as a Markdown file on the `archive` branch, with one commit per change. GitHub's diff then shows exactly what was edited.
- An article is saved again whenever its update date changes, however old it is. Once an hour, articles from the last 7 days are also re-checked in case an edit didn't change the date. The log channel notes when that happens.
- The first run for a source saves the last 30 days of articles without posting. The archive reads the article pages, not the feeds, at most 60 per run, and continues on the next run.
- When the text of an article changes, Discord gets an "Article text edited" post (purple) with the number of lines added and removed. It pings no role unless you add one under `archive` in `sources.yaml`. Changes to only the title, summary or image are saved without a post, since they're announced already.
- If the archive keeps failing for a source, the alert goes to `DISCORD_WEBHOOK_LOG` only, never to a game's channel.
- The archive runs whenever the tracker finds a change, and once an hour.

Discord posts have these buttons:

| Post | Buttons |
| --- | --- |
| New article (green) | Read Article, Battle.net Shop, Preview, History |
| Summary changed (orange) | Read Article, Battle.net Shop, View Changes, History |
| Article text edited (purple) | Read Article, Text Changes, History |

Preview shows the saved title, summary and thumbnail. View Changes and Text Changes show what changed, and History lists every saved version.

## Files
- `sources.yaml`: the feeds to watch, and the archive settings. Add an entry here to track another one.
- `main.py`: the tracker steps (`--scrape`, `--commit`, `--notify`).
- `archive.py`: the archive steps (`--fetch`, `--commit`, `--notify`).
- `.github/workflows/tracker.yaml`: the tracker workflow. It runs on a `workflow_dispatch` event, a manual run, or a push to `source`. It has no cron of its own.
- `.github/workflows/archive.yaml`: the archive workflow. It runs on a `workflow_dispatch` event or a manual run.
- `logos/`: the BlizzFeed logo, exported at the sizes Discord uses (server icon, emoji, sticker, app icon, role icon).
- `tests/`: run `pip install -r requirements-dev.txt`, then `pytest`.

## Setup
1. Push to the `source` branch (the default) and create empty `data` and `archive` branches.
2. Add every `DISCORD_WEBHOOK_*` secret listed in the table above under Settings → Secrets and variables → Actions.
3. Run `tracker.yaml` once manually, then have something send its `workflow_dispatch` every minute, and `archive.yaml`'s once an hour.
4. Run `archive.yaml` manually twice to save the first 30 days of articles. It posts nothing.

## Logos and trademarks
BlizzFeed is an unofficial fan project. It isn't affiliated with, endorsed by or sponsored by Blizzard Entertainment, Inc.

All game and company names, logos and icons are trademarks or registered trademarks of Blizzard Entertainment, Inc., and belong to their owners. That includes the icons used as webhook avatars and the BlizzFeed logo in `logos/`, which is a combination of parts of the World of Warcraft, Diablo IV, Overwatch 2 and StarCraft II icons. They're used here only to identify the news they belong to, and no ownership is claimed.

## Credits
The idea and overall design (a scheduled Actions job, separate `source` and `data` branches, commit links in Discord messages) come from [Wumpus-Central/blog-tracker](https://github.com/Wumpus-Central/blog-tracker).
