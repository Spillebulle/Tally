<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/banner.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/banner-paper.png">
  <img src="docs/images/banner.png" alt="Tally: the mark, a blue rounded square with four tally strokes crossed by a fifth, beside the word TALLY" width="560">
</picture>

**A self-hosted watch tracker that keeps your films, series and anime in step
with Plex, in both directions.**

Reads your Plex history · talks to plex.tv, TMDB, TheTVDB and MyAnimeList ·
saves everything in one SQLite file you own

</div>

<p align="center">
  <img src="https://img.shields.io/github/license/Spillebulle/Tally?style=flat-square" alt="Licence">
  <img src="https://img.shields.io/github/actions/workflow/status/Spillebulle/Tally/docker.yml?style=flat-square" alt="Build">
  <img src="https://img.shields.io/github/v/release/Spillebulle/Tally?style=flat-square" alt="Release">
  <img src="https://img.shields.io/docker/pulls/spillebulle/tally?style=flat-square" alt="Docker pulls">
</p>

> Tally runs a real household library every day, and the sync, the stats and the
> API are stable. It is still a young project, so read
> [what is not there yet](#what-is-not-there-yet) before you rely on it.

## Install

```yaml
# docker-compose.yml
services:
  tally:
    image: ghcr.io/spillebulle/tally:latest
    ports: ["8080:8080"]
    volumes: ["./data:/data"]
    environment:
      PUBLIC_URL: http://192.168.1.50:8080
    restart: unless-stopped
```

```bash
docker compose up -d
```

Then open the address you set as `PUBLIC_URL` and press **Continue with Plex**.
The first account to sign in becomes the administrator.

| Where | Image |
|---|---|
| GitHub Container Registry | `ghcr.io/spillebulle/tally:0.3.0` |
| Docker Hub | `spillebulle/tally:0.3.0` |
| Build it yourself | `docker build -t tally .` |

Both registries serve the same image for `linux/amd64` and `linux/arm64`.
`:latest` moves with every release, so pin a version in production. You need
Docker, a Plex account, and about 200 MB of disk for a large library. No API
keys are required to start.

**`PUBLIC_URL` must be the address you actually type in the browser.** Plex
sends you back to it after sign-in, so a wrong value is the one setting that
breaks the login flow.

## Two-way sync

Tally imports your whole Plex history, then keeps ratings, watch state and your
watchlist matching in both directions. It stores the last value it saw on Plex
beside your own, which is what lets it tell which side changed rather than
guessing:

| Local | Plex | Result |
|---|---|---|
| unchanged | unchanged | nothing happens |
| changed | unchanged | pushed to Plex |
| unchanged | changed | pulled into Tally |
| changed | changed | the more recent change wins |

Removing something from your watchlist is remembered as a removal, so the next
pull from Plex does not put it back. How the engine decides is in
[`docs/sync.md`](docs/sync.md).

## Continue watching

The dashboard picks up mid-episode playback and the next unwatched episode of
anything you have started. Plex drops an item off On Deck after a while, and
Tally reads that window from your server so a show you abandoned three years ago
does not sit at the top forever. You can set your own window instead, or turn
the cut-off off entirely, and nothing is ever deleted either way.

## Anime, separated

Anime gets its own section, and "is it animated?" is not the question. Tally
scores your library layout, the metadata agent on the item, its genres, its
country of origin and a MyAnimeList lookup, so a Western animated film is not
filed as anime for being a cartoon. Your per-library override always wins.
The signals and their weights are in [`docs/anime.md`](docs/anime.md).

## Stats you can click

Activity by day and hour, streaks and binges, rewatches, show completion and
drop-off, watchlist conversion, and how your ratings compare with the crowd,
over any date range and against the period before it. Every bar, heatmap day,
decade and studio is a link into the plays behind it with the filters already
applied.

## Filters, and views worth keeping

Multi-select and exclusion on genres, ranges for year, runtime, rating and
dates, cast and crew, library and server, on the grid, the watchlist and your
history alike. The whole query lives in the URL, so a narrowed page is a link
you can send. Save a view and it comes back.

## Themes

Two themes ship, dark and light, and the interface can also follow the device.
Beyond that you can make your own: Tally reads and writes `.umbertheme` files,
the same flat table of colours my other applications use, so a theme made in one
opens in the others unchanged. Import, export and a swatch editor are under
**Settings → Appearance**, and the format is in [`docs/themes.md`](docs/themes.md).

## Multi-user

Each person signs in with their own Plex account and sees their own history,
ratings, watchlist and stats. Ratings and watch state are per-user in Plex too,
so Tally holds a token per person rather than reading everyone's data through
the server owner's account. The first account created is the administrator.

## What is not there yet

- **No mobile app.** The interface works on a phone, but it is a web page.
- **One Plex household.** Trakt, Jellyfin, Emby and Letterboxd are not imported
  or exported.
- **No editing of metadata.** Titles, artwork and genres come from Plex and the
  metadata providers; Tally does not let you correct them.
- **No notifications.** Nothing emails, pushes or posts to Discord.
- **The database is SQLite**, so Tally expects one instance at a time. There is
  no clustering and no Postgres option.

## Configuration

These are the ones that matter on day one. Every setting is an environment
variable, and the full list is in
[`docs/configuration.md`](docs/configuration.md).

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | The address you reach Tally on. Used for the Plex sign-in redirect and the webhook URL. |
| `TMDB_API_KEY` | none | Posters, backdrops and descriptions. A [free key](https://www.themoviedb.org/settings/api) is the single biggest visual improvement. |
| `PUID` / `PGID` | `1000` | The user and group to run as. Set them to whoever owns your `./data` directory. |
| `TZ` | `UTC` | Which day a late-night play belongs to. |

Tally works with no API keys at all, falling back to whatever artwork your Plex
server already has.

## Documentation

| Subject | Page |
|---|---|
| Every setting, with defaults | [`docs/configuration.md`](docs/configuration.md) |
| The HTTP API, and API keys | [`docs/api.md`](docs/api.md) |
| Grafana and Prometheus dashboards | [`docs/integrations/grafana.md`](docs/integrations/grafana.md), [`docs/integrations/prometheus.md`](docs/integrations/prometheus.md) |
| Live updates through a Plex webhook | [`docs/integrations/plex.md`](docs/integrations/plex.md) |
| How the sync decides who wins | [`docs/sync.md`](docs/sync.md) |
| How anime is detected | [`docs/anime.md`](docs/anime.md) |
| Theme files, and making your own | [`docs/themes.md`](docs/themes.md) |
| Backing up and restoring | [`docs/backups.md`](docs/backups.md) |
| When something is wrong | [`docs/troubleshooting.md`](docs/troubleshooting.md) |

Interactive API documentation, generated from the code and always current, is at
`/api/docs` on your own instance.

## Building from source

```bash
cd backend && python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
DATA_DIR=./data .venv/bin/uvicorn app.main:app --reload --port 8080   # API
cd frontend && npm install && npm run dev                             # UI on :5173
cd backend && .venv/bin/python -m pytest -q                           # tests
cd frontend && npm run check:design && npx tsc --noEmit && npm run build
```

## Licence

Apache 2.0, in [LICENSE](LICENSE). Tally bundles the
[Archivo](https://github.com/Omnibus-Type/Archivo) typeface under the SIL Open
Font Licence and [Lucide](https://lucide.dev) icons under the ISC licence.

Tally is not affiliated with Plex, TMDB, TheTVDB or MyAnimeList.
