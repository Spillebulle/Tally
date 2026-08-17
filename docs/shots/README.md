# Preview harness

A repeatable way to look at the Tally UI without a real Plex server. It seeds a
realistic-looking SQLite database, boots the backend against it, builds the
frontend, and screenshots every page in both themes with a headless browser.
Use it after any UI change instead of trusting that a build succeeded. A
build is not a render.

## The two commands

From a fresh checkout, once:

```sh
cd frontend && npm i --no-save playwright && npx playwright install chromium
```

`--no-save` matters: this must never land in `frontend/package.json`, or it
ships inside the Docker image. `playwright` and the downloaded browser stay
local to this machine only.

Then, from the repo root, any time:

```sh
backend/.venv/Scripts/python.exe docs/shots/shots.py --out <scratch>/shots
```

This does everything: builds the frontend, copies it to
`backend/app/static` (exactly where `main.py` serves it from, see the
Dockerfile, which does the same `COPY`), seeds a fresh scratch database,
starts the backend against it, waits for it to answer, logs in, and
screenshots every page in dark and light.

Point `--out` at your scratch directory, never at a path inside the repo.

Useful flags:

| Flag | What it does |
|---|---|
| `--theme dark\|light\|both` | Default `both`. |
| `--pages dashboard item ...` | Default is all pages; give a subset to go faster. |
| `--port` | Default `8931`. |
| `--width` / `--height` | Viewport size for the screenshots. Default `1440x900`. |
| `--no-build` | Skip `npm run build` and reuse whatever is already in `backend/app/static`. |
| `--no-seed` | Skip seeding and reuse whatever is already in `--data-dir`. |
| `--data-dir` | Where the scratch database lives. Default `<out>/_data`. |

To seed a database on its own (e.g. for `npm run dev` instead of the built
SPA):

```sh
backend/.venv/Scripts/python.exe docs/shots/seed.py --data-dir <scratch>/data --fresh
```

then point `DATA_DIR` at that directory when you start the backend yourself.
Login is `ulrik` / `preview`.

## What comes out

```
<out>/
├── server.log            backend stdout+stderr for this run
├── console.txt           browser console errors/warnings, one line each
├── dark/
│   ├── dashboard.png             full page
│   ├── dashboard.viewport.png    just the viewport, no scrolling
│   ├── movies.png / .viewport.png
│   ├── shows.png / .viewport.png
│   ├── anime.png / .viewport.png
│   ├── watchlist.png / .viewport.png
│   ├── history.png / .viewport.png
│   ├── stats.png / .viewport.png
│   ├── settings.png / .viewport.png
│   ├── item.png / .viewport.png      a real seeded item's detail page
│   └── login.png / .viewport.png     logged out
└── light/
    └── (the same set)
```

`console.txt` filters out the one kind of noise that is expected and not a
finding: every poster and backdrop 404s against `/api/images/...`, because
there is no Plex server here (see below). Anything else that lands in that
file is worth reading.

## No artwork, on purpose

The seeded library has no `PlexMapping.thumb_path`/`art_path` and no TMDB key,
so nothing has real artwork. Posters render as the deterministic placeholder
gradient the frontend already falls back to for a missing image
(`posterFallbackGradient`). That is the intended behaviour of the real app,
not a gap in the seed data, and it is a fine way to check layout, density and
colour. It is not a fine way to check what the app looks like with real
posters; for that you need a TMDB key or an actual Plex server.

The seeded `PlexServer` row points at `http://127.0.0.1:1`, an address
nothing listens on, deliberately: it fails instantly instead of sitting
through a real connection timeout the way a stale private LAN address would.
Settings still has a real-looking server card, library list and sync toggles
to screenshot. The row exists so the UI has something to render, not so it
can actually be reached.

## How it works

- `seed.py` builds rows straight through `backend/app/models.py` with
  SQLAlchemy (never raw SQL), so the shape of the data can never drift from
  the schema. It imports `app.*`, so it needs the backend's own virtualenv.
  One user, ~150 movies and ~45 shows (with seasons and episodes, and a tenth
  or so of the library anime), watch states across the whole status range,
  several hundred watch events spread over 18 months with a shape (more
  evenings, more weekends, a couple of binge days, a multi-week gap), a
  watchlist with both active and removed entries, and enough Plex
  infrastructure (server, libraries, server access, a finished sync run) for
  Settings and the sync widgets to have something real to show. It is
  deterministic (same seed, same library), so screenshots are diffable
  between runs.
- `capture.mjs` is the Node half. Playwright lives in `frontend/node_modules`,
  not as a `docs/shots` dependency of its own, so it is resolved with
  `createRequire` pointed at `frontend/package.json` rather than relying on
  Node's normal upward node_modules search. `docs/shots` is a sibling of
  `frontend`, not a descendant, so that search would never find it. It signs
  in once per theme via `context.request.post` (not by clicking through the
  login form), so the login screenshot itself is taken logged out, before that
  call.
- `shots.py` is the orchestrator: build, seed, start the backend, wait for
  `/api/health`, hand off to `capture.mjs`, then shut the backend down. It
  refuses to start if its port is already in use rather than silently
  reusing whatever is answering there. A leaked process from an earlier run
  answering the health check instead of the one just started is a real
  failure mode, not a hypothetical one, and it fails quietly if you let it.
  Shutdown itself verifies the port is actually free afterwards, and falls
  back to `taskkill /T /F` on Windows if a plain `kill()` was not enough. On
  Windows it also places the backend in a Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`start_backend`, via `ctypes`), so
  the backend dies with this script even if `shots.py` itself is force-killed
  and `finally: stop_backend(...)` never runs. On macOS and Linux it starts
  the backend in its own process group instead, so a normal shutdown can
  signal the whole group; see "Recovering from a force-kill" below for what
  that does and does not cover.

## Recovering from a force-kill

A clean exit of `shots.py`, whether it finishes normally, hits an exception
or is sent `SIGTERM`/Ctrl-C, always stops the backend with it.

**On Windows**, a hard kill of `shots.py` (Task Manager's "End task", a CI
timeout that terminates it outright) still clears the backend: the Job
Object above is torn down by Windows as part of closing this script's own
handles, which kills anything still running inside it. Creating that Job
Object can itself fail, rarely (for example if `shots.py` is already
confined to an outer job that does not allow nesting). `shots.py` logs a
warning when that happens rather than pretending it worked.

**On macOS and Linux**, a hard kill of `shots.py` (`kill -9`, a CI timeout
that sends `SIGKILL`) can leave `uvicorn` running. POSIX has no equivalent of
Windows' kill-on-job-close: nothing survives the `SIGKILL` to signal the
process group. If the next run then refuses to start with "port already in
use", find and stop the leftover process yourself:

```sh
lsof -ti :8931 | xargs kill -9
```

(use whatever port you passed to `--port`, default `8931`). That refusal is
deliberate, not a bug: see the `shots.py` bullet above for why silently
reusing a leaked process is worse.
