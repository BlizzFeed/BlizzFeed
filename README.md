# BlizzFeed

Watches the Blizzard news feeds (news.blizzard.com, en-gb) every ~5 minutes on GitHub Actions, started by an external trigger. When a new article appears, it saves it to the `data` branch and posts it to Discord with its title, summary, thumbnail, link and post time, plus a link to the commit that recorded it.

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

More Blizzard products can be added by putting another entry in `sources.yaml`.

## How it works
- Each run reads the newest articles from each feed and compares them with the saved state. The feed is sorted by last update, so it stops as soon as it reaches articles it already has. Usually that's one request per source.
- New articles are committed to the `data` branch (one commit per source) and announced on Discord. Articles with a changed title, summary, image or link are announced too, in orange. If only the date changed, the saved copy is updated without a post.
- The first run for a source saves the last 150 articles without posting anything, so old articles that get edited later aren't mistaken for new ones.
- If a source fails 3 runs in a row, Discord gets a "failing" message, and a "recovered" one when it works again.

## Files
- `sources.yaml`: the feeds to watch. Add an entry here to track another one.
- `main.py`: the steps (`--scrape`, `--commit`, `--notify`).
- `.github/workflows/tracker.yaml`: the workflow. It runs on a `repository_dispatch` event (`trigger-scraping`), a manual run, or a push to `source`. It has no cron of its own.

## Setup
1. Push to the `source` branch (the default) and create an empty `data` branch.
2. Add every `DISCORD_WEBHOOK_*` secret listed in the table above under Settings → Secrets and variables → Actions.
3. Run the workflow once manually, then have something send the `trigger-scraping` dispatch every 5 minutes.

## Credits
The idea and overall design (a scheduled Actions job, separate `source` and `data` branches, commit links in Discord messages) come from [Wumpus-Central/blog-tracker](https://github.com/Wumpus-Central/blog-tracker).
