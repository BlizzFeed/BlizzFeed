# BlizzFeed

Watches the Blizzard news feeds (news.blizzard.com, en-gb) every ~5 minutes on GitHub Actions, started by an external trigger. When a new article appears, it saves it to the `data` branch and posts it to Discord with its title, summary, thumbnail, link and post time, plus a link to the commit that recorded it.

## Sources
| Source | Webhook secret |
| --- | --- |
| World of Warcraft News | `DISCORD_WEBHOOK_WOW` |
| Heroes of the Storm News | `DISCORD_WEBHOOK_HOTS` |
| Hearthstone News | `DISCORD_WEBHOOK_HEARTHSTONE` |

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
2. Add the secrets `DISCORD_WEBHOOK_WOW`, `DISCORD_WEBHOOK_HOTS` and `DISCORD_WEBHOOK_HEARTHSTONE` under Settings → Secrets and variables → Actions.
3. Run the workflow once manually, then have something send the `trigger-scraping` dispatch every 5 minutes.

## Credits
The idea and overall design (a scheduled Actions job, separate `source` and `data` branches, commit links in Discord messages) come from [Wumpus-Central/blog-tracker](https://github.com/Wumpus-Central/blog-tracker).
