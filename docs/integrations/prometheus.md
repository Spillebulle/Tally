# Prometheus

Scraping Tally's live gauges, and the one thing about them that will catch you
out.

`GET /metrics` returns the Prometheus text exposition format, version 0.0.4. It
needs credentials like everything else, and a **Stats only** key is what a
scrape config should hold: read-only, and limited to the statistics, metrics,
health and version endpoints. Issuing one is in `../api.md`.

## Scrape config

```yaml
# prometheus.yml
scrape_configs:
  - job_name: tally
    scrape_interval: 60s
    metrics_path: /metrics
    scheme: https
    authorization:
      type: Bearer
      credentials: tally_your_key_here
      # or, to keep the key out of this file:
      # credentials_file: /etc/prometheus/tally.key
    static_configs:
      - targets: ["tally.example.com"]
```

## What it exports

| Metric | Labels | What it is |
|---|---|---|
| `tally_build_info` | `version` | A constant 1, labelled with the running version. |
| `tally_library_items` | `media_type` | Items known to this install, by `movie`, `show`, `season` or `episode`. Global, not per account. |
| `tally_watch_events_total` | `user` | Plays recorded. |
| `tally_watch_events_by_type_total` | `user`, `media_type` | The same, split by type. |
| `tally_watch_minutes_total` | `user`, `media_type` | Minutes watched, by type. |
| `tally_watchlist_items` | `user` | Active watchlist entries. Removals are tombstoned, not counted. |
| `tally_current_streak_days` | `user` | Consecutive days watched, ending today or yesterday. |
| `tally_longest_streak_days` | `user` | Longest run of consecutive days ever watched. |
| `tally_sync_running` | `user` | 1 while a sync is in progress for that account, 0 otherwise. |
| `tally_last_sync_timestamp_seconds` | `user` | Unix time of the last completed full sync. **Absent** for an account that has never synced, rather than 0: a `time() - …` panel would otherwise report a 56-year-old sync instead of no sync. |

## Everything is a gauge, including the names ending in `_total`

Tally's totals can go **down**. Deleting a history row removes a play, a merge
collapses two items into one, and a library disappears when a server is
unlinked. Prometheus reads any fall in a counter as a process restart and
extrapolates across it, so `rate()` and `increase()` over these do not merely
lag, they over-report, silently, and only on the scrapes that straddle the
deletion.

Use `delta()` or `deriv()` if you want a rate out of them.

## Labels, and what is deliberately not one

The `user` label carries the display name or the username, never the email
address. A `stats` key belonging to an ordinary account sees only that account's
series; one belonging to an administrator sees the whole household.

**Nothing is labelled by title, genre, studio or device.** One label per film
would put tens of thousands of series into your Prometheus for a question nobody
asks of it. Those cuts are what `GET /api/stats/series` is for, where the caller
chooses the cut and pays for it once. That endpoint is in `grafana.md`.

## Caching

The snapshot is computed for every account at once and cached for about ten
seconds, so a fast scrape interval, or two Prometheus servers on the same one,
does not re-aggregate the whole watch history every time. A scrape can therefore
be up to ten seconds stale, which is well inside any sensible scrape interval.
