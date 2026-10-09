# BlizzFeed

Watches the Blizzard news feeds (news.blizzard.com, en-gb) every minute on GitHub Actions, started by an external trigger. When a new article appears, it saves it to the `data` branch and builds the Discord post (title, summary, thumbnail, link and post time, plus a link to the commit that recorded it). The post goes into an `outbox` artifact, and BlizzFeedBot delivers it to Discord.

## Sources
| Source | Channel labels |
| --- | --- |
| World of Warcraft (EU) | `WOW` |
| World of Warcraft (US) | `WOW_US` |
| Heroes of the Storm | `HOTS` |
| Hearthstone | `HEARTHSTONE` |
| Diablo V | `DIABLO5` and `DIABLO` |
| Diablo IV | `DIABLO4` and `DIABLO` |
| Diablo Immortal | `DIABLOIMMORTAL` and `DIABLO` |
| Diablo II: Resurrected | `DIABLO2` and `DIABLO` |
| Diablo III | `DIABLO3` and `DIABLO` |
| Overwatch | `OVERWATCH` |
| STARCRAFT (2030) | `STARCRAFT` |
| StarCraft Remastered | `STARCRAFTREMASTERED` |
| StarCraft II | `STARCRAFT2` |
| Warcraft 3: Reforged | `WARCRAFT3` |
| Warcraft Rumble | `WARCRAFTRUMBLE` |
| Blizzard (BlizzCon, company) | `BLIZZARD` |

World of Warcraft is also read from the en-us feed, which words some titles and dates differently, and posts to its own channels. Every other game uses the en-gb feed only.

Each label has three Discord announcement channels, listed under `channels:` in `sources.yaml`:

| Channel | Gets |
| --- | --- |
| `all` | every new and updated post |
| `new` | new articles only |
| `updated` | updated articles and edited article text |

Servers can follow whichever of these they want. Each Diablo game posts to its own channels and also to the shared `DIABLO` ones. A source can list more than one label. A label or tier without a channel ID is skipped with a warning.

Optionally, `DISCORD_WEBHOOK_LOG` points at a private dev channel. After a run where something changed (new, updated, date/url-only, a baseline, or a source failing or recovering) it gets one summary message linking each source's commit. Runs with no changes post nothing, and a failed log post never fails the run. The archive run the tracker starts adds its summary to that same message, with a second run button; the hourly archive run posts its own. This is the only Discord webhook the workflows use.

Each source also has a `logo:` in `sources.yaml`, the game's icon as a PNG in `logos/games/`. A post's thumbnail is the article's image, or that logo when the article has none. When an update changes the image, the post shows the old and new images side by side and puts the logo beside the title.

More Blizzard products can be added by putting another entry in `sources.yaml`.

## How it works
- Each run reads the newest articles from each feed and compares them with the saved state. The feed is sorted by last update, so it stops as soon as it reaches articles it already has. Usually that's one request per source.
- New articles are committed to the `data` branch (one commit per source) and put in the outbox for the bot to announce. Articles with a changed title, summary, image or link are announced too, in orange. If only the date changed, the saved copy is updated without a post. When the date moved along with the change, the post gets a note ("Checking the article text for changes…") while the archive re-checks the text; the bot removes it once that's done.
- The first run for a source saves the last 150 articles without posting anything, so old articles that get edited later aren't mistaken for new ones.
- If a source fails 12 runs in a row (about 12 minutes), the log channel gets a "failing" message, and a "recovered" one when it works again.

## Article archive
The feeds only carry the short version of each article: title, summary and thumbnail. Blizzard also edits the article text quietly (hotfix lists grow, patch notes get corrected), so the archive keeps the text too.

- Each article is saved as a Markdown file on the `archive` branch, with one commit per change. GitHub's diff then shows exactly what was edited.
- An article is saved again whenever its update date changes, however old it is. Once an hour, articles from the last 7 days are also re-checked in case an edit didn't change the date. The log channel notes when that happens.
- The first run for a source saves the last 30 days of articles without posting. The archive reads the article pages, not the feeds, at most 60 per run, and continues on the next run.
- Older articles can be added by hand: run `archive.yaml` with `backfill` ticked (optionally with a `source` id). It saves up to 150 articles the archive hasn't seen (`backfill_max_fetches`, one a second: `backfill_delay_seconds`), newest first, from those the feeds already list, and posts nothing. Run it again for the next 150. It stops at the first failed fetch, and skips pages that are gone or have no readable body.
- The feeds list only the newest articles (a first run reads 10 pages of 15). To go further back, run `tracker.yaml` with `deepen` ticked, a `source`, a `from_page` (10 first, then 20, and so on) and `pages` (up to 20). It stores the older articles it finds on the `data` branch without announcing anything, and the archive backfill then saves their text. It reads feed pages one request at a time, and any failure ends the run.
- The log post of a backfill run lists counts per source and how many articles are left, not each article.
- When the text of an article changes, an "Updated" post (orange) with the number of lines added, changed and removed goes to the bot. Changes to only the title, summary or image are saved without a post, since they're announced already.
- If the archive keeps failing for a source, the alert goes to `DISCORD_WEBHOOK_LOG` only.
- The archive runs whenever the tracker finds a change, and once an hour.

## Battle.net Shop
Besides articles, BlizzFeed watches what the Battle.net Shop lists for each game and when it changes. There is no shop API, so it reads the shop's own pages.

- `shop.yaml` runs about every 5 minutes (the tracker starts it, it has no cron). It reads each game's shop page in both regions, EU (`en-gb`, euro) and US (`en-us`, dollar), 13 pages each, and compares them with the saved state on the `shop` branch.
- The first run for a page saves everything without posting. After that it records what is new, back, gone, changed in price, on sale or no longer on sale, given a badge, or changed in title, description, image or sections, plus header banners.
- An item only counts as gone after it has been missing for 3 sweeps and its own page shows no price. A fetch that fails, or that loses more than a quarter of a page's items at once, is held until the next one agrees.
- The `shop` branch keeps `<region>/<family>/state.json`, a Markdown card per item (so GitHub's history shows each change), and `changes.jsonl`, an append-only log of every change. `posted.json` lists recent posts.
- The log channel gets a summary of each run that had changes, an alert when a page keeps failing, and a note once a day when the shop's home page links to a family that isn't in `sources.yaml`. `SHOP_HEARTBEAT_URL` (optional secret) is pinged after each good run.

**What is posted.** A game's feed gets new and back items in its `all` and `new` channels, and price, sale and badge changes in its `all` and `updated` channels. The shop channel (`channel:` under `shop:`) gets every change, including removals, sales ending, banners and detail edits. WoW's EU changes go to the EU feed and its US changes to the US feed; other games have only an EU feed, so a US-only change for them goes to the shop channel alone.

- A change is posted when one region sees it, with the prices both regions have. If the other region's matching change arrives within 30 minutes, the bot edits the post instead of adding one.
- Three or more changes of one type for a game in one run become a single digest, and a game gets at most 5 posts per run, the rest folded into one.
- The shop entries are part of the same outbox (`kind: shop`, with a `ref` and `edit`).

## The outbox
After each run that has something to post, `main.py --outbox` and `archive.py --outbox` write `outbox.json`, and the workflow uploads it as an artifact named `outbox` (kept for 7 days). It holds one finished Discord message per channel, so the bot only has to deliver them. Runs with nothing to post upload nothing. An archive run also lists the articles it re-checked without finding a text edit (`checked`), so the bot can remove the text-check note, and the Battle.net Shop link it found in the text of an article whose feed card had none (`shops`, the first `shop.battle.net/.../items/...` link), so the bot can add the shop button; it uploads an outbox for those alone too. The bot polls the repo's artifacts, paces its posts so Discord's publish limit isn't hit, and merges repeated updates to the same article.

Discord posts have these buttons:

| Post | Buttons |
| --- | --- |
| New article (green) | Read Article, Battle.net Shop, Summary, Archived Copy, History |
| Card updated (orange) | Read Article, Battle.net Shop, Summary Changes, History |

Battle.net Shop is on the post when the feed's card has the link. When it doesn't, the archive run that follows reads the link from the article text and the bot adds the button to the post a minute or so later.
| Article text edited (orange) | Read Article, Article Changes, History |

Summary shows the saved title, summary and thumbnail, and Archived Copy the article's saved full text (it can take a minute to appear). Summary Changes and Article Changes show what changed, and History lists every saved version.

Both kinds of update look the same, with a diff block saying what changed: the old and new title and whether the summary or image changed for a card, or how many lines were added, changed and removed for the article text.

## Files
- `sources.yaml`: the feeds to watch, and the archive settings. Add an entry here to track another one.
- `main.py`: the tracker steps (`--scrape`, `--commit`, `--outbox`, `--notify`), and `--deepen`, a manual run that stores older articles. The shop steps are `--shop` (`--dry-run` prints what the shop lists), `--shop-commit`, `--shop-outbox` and `--shop-notify`.
- `archive.py`: the archive steps (`--fetch`, `--commit`, `--outbox`, `--notify`). `--notify` only posts the run summary to the log channel. `--fetch --backfill` is the manual backfill.
- `.github/workflows/tracker.yaml`: the tracker workflow. It runs on a `workflow_dispatch` event, a manual run, or a push to `source`. It has no cron of its own.
- `.github/workflows/shop.yaml`: the shop workflow, started by the tracker when the last run is 5 minutes old.
- `.github/workflows/archive.yaml`: the archive workflow. It runs on a `workflow_dispatch` event or a manual run.
- `logos/`: the BlizzFeed logo, exported at the sizes Discord (server, bot and app images, emoji, sticker) and GitHub (social preview, app logo) use, each with a dark background and a transparent `-nobg` version.
- `logos/games/`: each game's icon (Blizzard's, see Logos and trademarks), the thumbnail of a post whose article has no image.
- `tests/`: run `pip install -r requirements-dev.txt`, then `pytest`.

## Setup
1. Push to the `source` branch (the default) and create empty `data`, `archive` and `shop` branches.
2. In Discord, create the announcement channels (three per label, see Sources) and put their IDs under `channels:` in `sources.yaml`.
3. Optionally add the `DISCORD_WEBHOOK_LOG` secret under Settings → Secrets and variables → Actions.
4. Run `tracker.yaml` once manually, then have something send its `workflow_dispatch` every minute, and `archive.yaml`'s once an hour.
5. Run BlizzFeedBot so the outbox gets delivered. It needs a bot in the server and a GitHub App that can read this repo's Actions.
6. Run `archive.yaml` manually twice to save the first 30 days of articles. It posts nothing.

## Logos and trademarks
BlizzFeed is an unofficial fan project. It isn't affiliated with, endorsed by or sponsored by Blizzard Entertainment, Inc.

All game and company names, logos and icons are trademarks or registered trademarks of Blizzard Entertainment, Inc., and belong to their owners. That includes the game logos in `logos/games/`, which are Blizzard's own game icons, and the BlizzFeed logo in `logos/`, which is a combination of parts of the World of Warcraft, Diablo IV, Overwatch 2 and StarCraft II icons. They're used here only to identify the news they belong to, and no ownership is claimed.

## Credits
The idea and overall design (a scheduled Actions job, separate `source` and `data` branches, commit links in Discord messages) come from [Wumpus-Central/blog-tracker](https://github.com/Wumpus-Central/blog-tracker).
