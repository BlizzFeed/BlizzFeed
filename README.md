# BlizzFeed

Watches Blizzard news pages every ~5 minutes on GitHub Actions. When a new article appears, it saves it to the `data` branch and posts it to Discord with its title, summary, thumbnail, link and post time, plus a link to the commit that recorded it.

## Sources
| Source | Type | Webhook secret |
| --- | --- | --- |
| World of Warcraft News (EU) | html | `DISCORD_WEBHOOK_WOW` |
| World of Warcraft News (US) | html | `DISCORD_WEBHOOK_WOW` |
| Heroes of the Storm News | json | `DISCORD_WEBHOOK_HOTS` |

More Blizzard products can be added by putting another entry in `sources.yaml`.

## How it works
- Each run reads the article list on each page and compares it with the saved state.
- New articles are committed to the `data` branch (one commit per source) and announced on Discord. Edited articles are announced too, in orange.
- The first run for a source only saves what's there, without posting anything.
- If a source fails 3 runs in a row, Discord gets a "failing" message, and a "recovered" one when it works again.

## Files
- `sources.yaml`: the pages to watch. Add a page here to track it.
- `main.py`: the steps (`--scrape`, `--commit`, `--notify`).
- `.github/workflows/tracker.yaml`: the schedule.

## Setup
1. Push to the `source` branch (the default) and create an empty `data` branch.
2. Add the secrets `DISCORD_WEBHOOK_WOW` and `DISCORD_WEBHOOK_HOTS` under Settings → Secrets and variables → Actions.
3. Run the workflow once manually, then let the schedule take over.

## Credits
The idea and overall design (a scheduled Actions job, separate `source` and `data` branches, commit links in Discord messages) come from [Wumpus-Central/blog-tracker](https://github.com/Wumpus-Central/blog-tracker).
