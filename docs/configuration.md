# Configuration

Every setting Tally reads, what it defaults to, and when you would change it.

Settings are environment variables, read once when the container starts. Nothing
here can be changed from inside the interface, and a change takes effect on the
next restart.

## After your first sign-in

1. **Sign in with Plex.** A Plex window opens; approve the request. The first
   account to sign in becomes the administrator.
2. Tally asks plex.tv which servers you can reach and imports their libraries.
   The first sync of a large library takes a few minutes. It runs in the
   background, so you can browse while it works.
3. Open **Settings → Plex servers** and check your libraries were found. If
   the list is empty, press **Refresh** at the top of the pane to ask plex.tv
   again. Each library has an **Include** switch, a dropdown reading **Detect
   anime** / **Always anime** / **Never anime**, and a **Scan** button that
   reads that one library again.
4. Optionally add `TMDB_API_KEY` and restart. Artwork and descriptions improve
   from the next sync onwards.
5. If you added a key, an administrator can press **Re-detect anime** under
   **Settings → Library → Danger** so classification is redone with the
   signals the new key unlocks. What those signals are is in `anime.md`.

`PUBLIC_URL` is the one value you should set before anything else. Plex sends
your browser back to it after sign-in, so a wrong value is the setting that
breaks the login flow rather than something you notice later.

## Core

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | The address you actually type in the browser. Used for the Plex sign-in redirect and for the webhook address Tally hands you. Set it to something like `http://192.168.1.50:8080` or `https://tally.example.com`. |
| `DATA_DIR` | `/data` | Where the database, the secret key and the client id live. The image sets it, and there is no reason to move it inside a container. |
| `LOG_LEVEL` | `INFO` | `DEBUG` when something is not syncing and you want to see why. At `DEBUG` the HTTP client also logs full request URLs, which for TMDB and Plex artwork means keys and tokens in your logs, so turn it back down before pasting anything into an issue. |
| `TZ` | `UTC` | The container's clock zone, which is what timestamps in the log are written in. It does **not** decide which day a play is filed under: the interface sends your browser's zone with every statistics request, the API takes a `tz` parameter, and **Settings → Appearance → Time zone** sets the fallback for requests that carry neither. |
| `HOST` | `0.0.0.0` | The network address uvicorn binds to. The image sets it. |
| `PORT` | `8080` | Port uvicorn listens on. Map it with Docker rather than changing this. |
| `APP_NAME` | `Tally` | The name in the log line at startup and in `/api/health`. |

## Metadata providers

Tally works with none of these. It falls back to whatever artwork and
descriptions your Plex server already has, and uses Jikan for anime.
**Settings → Metadata** shows which of the four are active on your instance.

| Variable | Default | What it does |
|---|---|---|
| `TMDB_API_KEY` | none | Posters, backdrops and descriptions. A [free key](https://www.themoviedb.org/settings/api) is the single biggest visual improvement. Accepts a v3 key or a v4 bearer token. |
| `TVDB_API_KEY` | none | Extra series data, and the explicit *Anime* genre TMDB lacks. [Free key](https://thetvdb.com/api-information). |
| `MAL_CLIENT_ID` | none | The official MyAnimeList API. Leave it blank to use Jikan, the free MyAnimeList mirror, which needs no credentials. |
| `JIKAN_BASE_URL` | `https://api.jikan.moe/v4` | Point it at your own Jikan instance if you run one. |

Adding a key later is a restart, then a sync. Rows that already have no artwork
are retried once a week, so a large library fills in over several days rather
than in one burst.

## Sync

| Variable | Default | What it does |
|---|---|---|
| `SYNC_INTERVAL_MINUTES` | `30` | How often to run a full sync against Plex. Values below `5` are raised to `5` and the reason is logged. `0` does not switch syncing off, it would mean once a second, which is why it is clamped. |
| `SESSIONS_POLL_SECONDS` | `30` | How often to check for playback in progress. Values below `5` are raised to `5`. A poll takes about one second per linked server, so anything shorter only produces skipped runs. |

Neither can be set per account. What each account syncs can be: the three
switches under **Settings → Syncing → What syncs** turn ratings, the
watchlist and writing watch state back to Plex on and off for you alone. What
they do is in `sync.md`.

## Which day a play is counted on

This is a per-account setting, not an environment variable, and it lives under
**Settings → Appearance → Time zone**.

Every timestamp is stored in UTC. Which *day* an instant belongs to is a
question about the person watching, so it is answered by a zone:

1. the `tz` parameter on the request, if it carries one;
2. otherwise the zone saved under **Settings → Appearance → Time zone**;
3. otherwise UTC.

The interface sends your browser's zone with every statistics request, so what
you see in Tally is already in your own days whatever the setting says. The
setting is what everything *else* gets: a Grafana panel, a `curl`, anything
reading `/api/stats` or `/api/stats/series` without naming a zone. Left on
**Follow this device**, all of those are answered in UTC.

Every response says which zone it used in an `X-Tally-Timezone` header, so a
dashboard that looks a day out can be checked rather than guessed at.

## Security

| Variable | Default | What it does |
|---|---|---|
| `SECRET_KEY` | generated | Signs session cookies and derives the key that encrypts stored Plex tokens. Written to `/data/.secret_key` on first boot. Set it explicitly if you want sessions and stored tokens to survive rebuilding from an empty `/data`. Generate one with `openssl rand -base64 48`. |
| `SESSION_TTL_HOURS` | `720` | How long a sign-in lasts, 30 days by default. |
| `CORS_ORIGINS` | none | A comma-separated list of origins allowed to call the API from a browser. Leave it empty unless you are serving the interface from a different host than the API. |

Changing `SECRET_KEY` after first boot logs everyone out and makes every stored
Plex token undecryptable, so each account has to link Plex again. No history is
lost. What `/data/.secret_key` is worth keeping with a backup is in `backups.md`.

## File ownership

Handled by the container's entrypoint, before Tally itself starts.

| Variable | Default | What it does |
|---|---|---|
| `PUID` | `1000` | The user id to run as. Set it to whoever owns your `./data` directory (`id -u`). |
| `PGID` | `1000` | The group id to run as (`id -g`). |

The entrypoint takes ownership of `/data` as `PUID:PGID` and then drops to that
user, so a bind mount works without you chowning anything first. It only chowns
when the ownership is actually wrong, because recursing a large directory on
every restart is slow and fails outright on some network shares. If you pass a
`user:` override in compose instead, the entrypoint cannot fix ownership at all,
and refuses to start when `/data` is not writable by that user rather than
letting the app die on a permission error deep in startup. A permission error
on `/data` is in `troubleshooting.md`.

## Plex identity

You are unlikely to need these. They name Tally to Plex, and appear on the
authorised-devices list in your Plex account.

| Variable | Default | What it does |
|---|---|---|
| `PLEX_PRODUCT` | `Tally` | Product name sent to Plex. |
| `PLEX_DEVICE_NAME` | `Tally` | Device name sent to Plex. Change it if you run two instances and want to tell them apart. |
| `PLEX_PLATFORM` | `Web` | Platform sent to Plex. |
| `PLEX_CLIENT_IDENTIFIER` | generated | This install's identity to Plex. Written to `/data/.plex_client_id` on first boot and must stay stable, because Plex ties sign-in PINs and device entries to it. Leave it alone unless you are moving an install and want it to keep its place in the device list. |
