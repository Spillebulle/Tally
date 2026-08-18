# The HTTP API

How to call Tally from a script or another application, and what a key is
allowed to do.

Everything the interface does is a normal HTTP API under `/api`. Interactive
documentation, generated from the code and always current, is at `/api/docs` on
your own instance, with the raw schema at `/api/openapi.json`. That is the
authoritative endpoint list; this page covers the parts that are not in it.

## Getting a key

Create one under **Settings → API keys**. Give it a name that says what it
is for, pick its access, and press **Create**.

**The key is shown once.** Only a fingerprint of it is stored, so Tally cannot
show it to you again and losing it means issuing a new one. Copy it out of the
box before you dismiss it. A key acts as the account that created it, with
exactly that account's access, so treat it like a password. Revoking one takes
effect immediately, on every integration using it.

## Sending it

Either header works, and both are read on every endpoint under `/api`:

```bash
curl -H "X-API-Key: tally_…" https://tally.example.com/api/stats/summary
curl -H "Authorization: Bearer tally_…" https://tally.example.com/api/media?limit=5
```

**Never put a key in the query string.** Tally does not accept one there,
deliberately: uvicorn's access log prints query strings at `INFO`, and
`docker logs tally` is what people paste into bug reports.

## Access

Access is fixed when the key is issued. To change it, revoke the key and make
another.

| In Settings | In the API | What it may do |
|---|---|---|
| Full | `full` | Everything the account can do, including changing data, triggering syncs, and the administrator endpoints if the account is an administrator. |
| Read-only | `read_only` | `GET`, `HEAD` and `OPTIONS` only, anywhere the account can see. Every other method is refused, so nothing using the key can change or delete anything. |
| Stats only | `stats` | Read-only, and further limited to `/api/stats`, `/metrics`, `/api/health` and `/api/version`. It cannot list your library, your users or your other keys. |

A refusal is always `403` and never a narrower answer that might be mistaken for
the whole truth. An unrecognised scope, from a hand-edited row or a downgrade
from a newer version, is refused outright rather than treated as the nearest
thing.

**Give a dashboard the `stats` scope.** Anyone who can edit a Grafana panel can
make any request the stored key can make: a dashboard is not a viewer, it is a
proxy. Grafana's own setup is in `integrations/grafana.md` and Prometheus is in
`integrations/prometheus.md`.

## Some endpoints worth knowing

| Endpoint | What it is |
|---|---|
| `GET /api/media` | Browse and search, with the same filters and sorts as the interface. |
| `GET /api/media/continue-watching` | What you are part-way through. |
| `GET /api/media/{item_id}` | One title, with its ratings, progress and metadata. |
| `GET /api/watchlist` | Your watchlist, filterable and sortable. |
| `GET /api/history` | Your watch history. |
| `GET /api/history/calendar` | One month of it, bucketed by day. Takes the same filters, plus `month=YYYY-MM`, `tz` and `per_day`. Only days with plays come back, and the response names the time zone it used. |
| `POST /api/history/{item_id}/watched` | Log a title as watched. |
| `GET /api/stats` | Totals, genres, ratings and streaks over a date range. |
| `GET /api/stats/series` | One metric over time, as flat rows for a dashboard. |
| `GET /metrics` | Live gauges in the Prometheus text format. |
| `POST /api/sync` | Trigger a sync. With `{"full_history": true}` it reads the whole Plex history again. While a sync is already running it answers `{"status": "already_running"}` rather than starting a second one. |
| `GET /api/sync/status` | Progress of the running sync. |
| `GET /api/keys` | Your API keys, by name, access and prefix. Never the keys themselves. |
| `GET /api/health` | Liveness and version. Needs no credentials. |

Everything the browse pages filter on is a query parameter here, and the whole
set is in `/api/docs`. Values are checked rather than coerced, so a stale or
mistyped `sort`, `order` or `media_type` answers `422` instead of quietly
returning something else.

## What takes no credentials

Three endpoints, and the sign-in flow under `/api/auth` that exists to get you a
session in the first place.

| Endpoint | Why it is open |
|---|---|
| `GET /api/health` | Liveness, for a container health check or an uptime monitor. |
| `GET /api/version` | The footer renders before anything is signed in, and the version is already in the health payload. |
| `POST /api/webhooks/plex` | Plex offers no way to send credentials with a webhook. |

The webhook is written to be safe when hit by anyone. It only ever matches
events to accounts and servers that are **already linked**, never creates a user
or grants access, and never answers `5xx`, because Plex retries a failing
webhook and then disables it. Setting one up is in `integrations/plex.md`.
