<div align="center">

# Tally

**Track every film, series and anime you watch — kept in step with Plex.**

A self-hosted watch tracker that imports your Plex history, follows what you are
watching now, and syncs ratings and your watchlist in *both* directions.

</div>

<p align="center">
  <img src="https://img.shields.io/github/license/Spillebulle/Tally?style=flat-square" alt="License">
  <img src="https://github.com/Spillebulle/Tally/actions/workflows/docker.yml/badge.svg" alt="Build">
  <img src="https://img.shields.io/docker/pulls/spillebulle/tally?style=flat-square" alt="Docker pulls">
  <img src="https://img.shields.io/github/v/release/Spillebulle/Tally?style=flat-square" alt="Release">
</p>

---

## What it does

| | |
|---|---|
| **Sign in with Plex** | OAuth through plex.tv. Tally never sees your password. |
| **Imports everything** | Your full watch history, libraries, ratings and watchlist. |
| **Two-way ratings** | Rate here, it appears in Plex. Rate in Plex, it appears here. |
| **Two-way watchlist** | Add or remove in either place; the other follows. |
| **Live "continue watching"** | Picks up mid-episode playback, and the next unwatched episode of anything you have started. |
| **Anime, separated** | Anime gets its own section, detected from your library layout, metadata agent, genres and MyAnimeList — not just "is it a cartoon". |
| **Multi-user** | Each account links its own Plex identity and sees its own history and ratings. |
| **Rich metadata** | Posters and descriptions from TMDB, TheTVDB and MyAnimeList. |
| **Stats** | Activity heatmap, genre breakdown, rating distribution, streaks. |

---

## Install

> **Set `PUBLIC_URL` to the address you actually type in the browser.** Plex sends
> your browser back to this URL after sign-in, so a wrong value breaks the login
> flow — e.g. `http://192.168.1.50:8080` or `https://tally.example.com`.

### Option 1 — docker compose (recommended)

```bash
git clone https://github.com/Spillebulle/Tally.git
cd Tally
cp .env.example .env      # optional, but read it
docker compose up -d
```

### Option 2 — GitHub Container Registry (GHCR)

```bash
docker run -d --name tally \
  -p 8080:8080 \
  -v tally-data:/data \
  -e PUBLIC_URL=http://localhost:8080 \
  -e TMDB_API_KEY=your_key_here \
  --restart unless-stopped \
  ghcr.io/spillebulle/tally:latest
```

### Option 3 — Docker Hub

```bash
docker run -d --name tally \
  -p 8080:8080 \
  -v tally-data:/data \
  -e PUBLIC_URL=http://localhost:8080 \
  -e TMDB_API_KEY=your_key_here \
  --restart unless-stopped \
  spillebulle/tally:latest
```

> Both registries serve the same image, built for `linux/amd64` and `linux/arm64`.
> Pin a version (e.g. `:0.0.1`) in production instead of `:latest`.

### Option 4 — build the image locally

```bash
git clone https://github.com/Spillebulle/Tally.git
cd Tally
docker build -t tally .
docker run -d --name tally -p 8080:8080 -v tally-data:/data \
  -e PUBLIC_URL=http://localhost:8080 tally
```

Then open <http://localhost:8080> and press **Continue with Plex**. The first
account to sign in becomes the administrator.

---

## First run

1. **Sign in with Plex.** A Plex window opens; approve the request.
2. Tally asks plex.tv which servers you can reach and imports their libraries.
   The first sync of a large library takes a few minutes — it runs in the
   background, so you can browse while it works.
3. Check **Settings → Plex servers** to confirm your libraries were found, and to
   mark which ones hold anime.
4. Optionally add a **TMDB key** (below) and press **Re-detect** under Settings →
   Anime so artwork and classification improve.

---

## Configuration

Everything is environment variables. Only `PUBLIC_URL` really matters.

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | The URL you reach Tally on. Used for the Plex sign-in redirect and the webhook URL. |
| `TMDB_API_KEY` | — | Posters, backdrops and descriptions. [Free key](https://www.themoviedb.org/settings/api); accepts a v3 key or a v4 bearer token. |
| `TVDB_API_KEY` | — | Extra series data, and the explicit *Anime* genre TMDB lacks. [Free key](https://thetvdb.com/api-information). |
| `MAL_CLIENT_ID` | — | Official MyAnimeList API. Leave blank to use Jikan, the free MAL mirror, which needs no credentials. |
| `SYNC_INTERVAL_MINUTES` | `30` | How often to run a full sync against Plex. |
| `SESSIONS_POLL_SECONDS` | `30` | How often to check for in-progress playback. Values below `5` are raised to `5`; a poll takes about a second per server, so anything shorter just produces skipped runs. |
| `SECRET_KEY` | generated | Signs sessions and encrypts stored Plex tokens. Written to `/data/.secret_key` on first boot. Set it explicitly if you rebuild from scratch and want sessions to survive. |
| `PUID` / `PGID` | `1000` | User and group the app runs as. Set these to the owner of your `./data` directory (`id -u`, `id -g`). |
| `LOG_LEVEL` | `INFO` | `DEBUG` when something is not syncing and you want to see why. |
| `TZ` | `UTC` | Timezone for logs and daily stats grouping. |

**Tally works with no API keys at all** — it falls back to whatever artwork and
descriptions your Plex server already has, and uses Jikan for anime. Adding a
TMDB key is the single biggest visual improvement.

---

## How syncing works

Tally runs a full sync every `SYNC_INTERVAL_MINUTES` and polls for active
playback every `SESSIONS_POLL_SECONDS`. You can also press the sync button in the
header at any time.

### Which side wins

For every syncable field Tally stores both your local value and the last value it
saw on Plex. That is what lets it tell *which side changed*:

| Local | Plex | Result |
|---|---|---|
| unchanged | unchanged | nothing happens |
| changed | unchanged | pushed to Plex |
| unchanged | changed | pulled into Tally |
| changed | changed | the more recent change wins |

Watchlist removals are **tombstoned** rather than deleted, so something you remove
stays removed instead of being re-added by the next pull from Plex.

### Live updates (optional, needs Plex Pass)

Plex can notify Tally the instant something is played instead of waiting for the
next sync:

1. Copy the webhook URL from **Settings → Live updates**.
2. Paste it into Plex → **Settings → Webhooks → Add Webhook**.

This is purely an optimisation — everything a webhook delivers is also picked up
by the periodic sync, so a missed webhook loses nothing.

---

## How anime is detected

There is no single reliable "is this anime?" flag across Plex, TMDB and TVDB, so
Tally combines signals and scores them. It is deliberately conservative: an
animated Western film must not be filed as anime just because it is animated.

| Signal | Weight |
|---|---|
| You set the library override in Settings | decisive |
| HAMA / AniDB / MAL metadata agent on the item | decisive |
| Library is named something like "Anime" | decisive |
| Explicit `Anime` genre tag | strong |
| Animation **and** Japanese origin | strong |
| Anime-ish TMDB keywords (`shounen`, `based on manga`, …) | moderate |
| A confident MyAnimeList title match | corroborating |

If it gets something wrong, open **Settings → Plex servers** and cycle the
library's *Anime* chip between `auto`, `yes` and `no`. Your override always wins.

---

## Multi-user

Each person signs in with their own Plex account and gets their own history,
ratings, watchlist and stats. Ratings and watch state are per-user in Plex too, so
Tally stores a separate Plex token per user rather than reading everything through
the server owner's account.

The first account created is the administrator. Admins can manage users under
Settings; everyone else only ever sees their own data.

---

## Backups

Everything lives in `/data`:

```
data/
├── tally.db          your history, ratings, watchlist
├── .secret_key       signs sessions, encrypts stored Plex tokens
└── .plex_client_id   this install's identity to Plex
```

Copy that directory and you have a complete backup. Keep `.secret_key` with it —
without it, stored Plex tokens cannot be decrypted and every user has to re-link
Plex (no history is lost).

---

## Troubleshooting

**Plex sign-in opens, but nothing happens after approving**
`PUBLIC_URL` does not match the address you are using. Fix it and restart.

**"Permission denied: /data"**
The mounted directory is owned by a different user than the container. Either set
`PUID`/`PGID` to the owner's ids (`id -u` / `id -g`), or
`sudo chown -R 1000:1000 ./data`.

**"Could not reach plex.tv" — or nothing syncs and the logs mention name resolution**

The container cannot resolve DNS. Check it directly:

```bash
docker exec tally getent hosts plex.tv
```

Empty output confirms it. `cat /etc/resolv.conf` inside the container shows which
resolver it is using.

If that resolver is a Pi-hole or AdGuard Home, this is the usual cause: every
container on the host shares one apparent source address (the Docker bridge
gateway, typically `172.17.0.1`), so they all count against a single client's
query budget. Pi-hole's default is 1000 queries per minute, and once tripped it
drops *every* query from that address until the window resets. Its log shows
`RATE_LIMIT  Client 172.17.0.1 has been rate-limited`.

Raise the limit in `/etc/pihole/pihole-FTL.conf` (`RATE_LIMIT=0/0` disables it),
then `pihole restartdns`. Ad-blocking DNS can also filter Plex domains outright —
check its query log for `plex.tv` and allow it if so.

Failing that, point the container at a public resolver, which skips your local
DNS for Tally only:

```yaml
services:
  tally:
    dns:
      - 1.1.1.1
```

**No servers found in Settings**
Press **Refresh**. If it still finds nothing, your Plex token may have expired —
sign out and back in. Check that the container can reach your Plex server; a
container on a custom bridge network cannot always reach a `localhost` address on
the host.

**Posters are missing or low quality**
Add a `TMDB_API_KEY` and restart, then run a full re-import from Settings.

**A show is in the wrong section**
Cycle the library's *Anime* override in Settings, or press **Re-detect** under
Settings → Anime to re-run classification over everything.

---

## Development

```bash
# Backend — http://localhost:8080
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
DATA_DIR=./data .venv/bin/uvicorn app.main:app --reload --port 8080

# Frontend — http://localhost:5173, proxies /api to :8080
cd frontend
npm install && npm run dev
```

```bash
cd backend && .venv/bin/python -m pytest      # tests
cd frontend && npm run lint                   # typecheck
```

Interactive API docs are at `/api/docs` while the backend is running.

### Releasing

Images are published only from `v*` tags — pushing `main` does not build. The
tag's annotation becomes the GitHub Release body, so write the notes there.

```bash
# 1. Bump the version in backend/app/__init__.py to match the tag
# 2. Commit, then tag with the release notes as the annotation
git tag -a v0.1.0 -m "Tally v0.1.0

- What changed
- And what else"
git push --follow-tags
```

That publishes to `ghcr.io/spillebulle/tally` and `docker.io/spillebulle/tally`
for amd64 and arm64, tagged `0.1.0`, `0.1`, the short SHA, and `latest`, then
opens a GitHub Release. Use **Actions → Build and publish container image → Run
workflow** to rebuild without cutting a new version.

Docker Hub publishing needs two repository secrets: `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN` (a Docker Hub access token). GHCR uses the built-in
`GITHUB_TOKEN` and needs no setup.

### Layout

```
backend/app/
├── main.py            FastAPI app, serves the built frontend
├── models.py          SQLAlchemy schema
├── routers/           HTTP endpoints
└── services/
    ├── plex_tv.py     plex.tv: OAuth, server discovery, watchlist
    ├── plex_server.py a Plex Media Server: libraries, history, scrobble
    ├── guids.py       Plex GUID parsing → external ids
    ├── media_repo.py  Plex metadata → canonical media items
    ├── sync_service.py the two-way sync engine
    └── metadata/      TMDB, TVDB, MAL + anime classification
frontend/src/
├── pages/             one file per screen
├── components/        posters, charts, layout, shared UI
└── lib/               API client, types, contexts
```

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Tally is not affiliated with Plex, TMDB, TheTVDB or MyAnimeList.
