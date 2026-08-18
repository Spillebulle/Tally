# Grafana

Drawing Tally's numbers in Grafana, through the time-series endpoint built for
it.

## Issue the key first

Under **Settings → API keys**, create a key with **Stats only** access. A
`stats` key is read-only *and* limited to `/api/stats`, `/metrics`,
`/api/health` and `/api/version`, so it cannot list your library, your users or
your other keys. The scopes are in `../api.md`.

That narrowing is the whole point: **anyone who can edit a Grafana panel can
make any request the stored key can make.** A dashboard is not a viewer, it is a
proxy. Give it the smallest scope that draws the graph.

Send the key as a header, `X-API-Key` or `Authorization: Bearer`, and **never as
a URL parameter**. Tally does not accept one there, deliberately: uvicorn's
access log prints the query string at `INFO`, and `docker logs tally` is what
people paste into bug reports.

## `GET /api/stats/series`

One metric over time, as flat rows.

| Parameter | Values | |
|---|---|---|
| `metric` | `plays`, `minutes`, `distinct_titles`, `distinct_shows`, `ratings_given`, `avg_rating` | default `plays` |
| `from`, `to` | ISO 8601 | Grafana writes these with `${__from:date:iso}` and `${__to:date:iso}` |
| `preset` | `7d`, `30d`, `90d`, `ytd`, `12m`, `last_year`, `all` | instead of `from`/`to` |
| `days` | 1 to 3650 | instead of `from`/`to` |
| `interval` | `hour`, `day`, `week`, `month` | default `day` |
| `group_by` | `none`, `media_type`, `genre`, `anime`, `source`, `device`, `user` | default `none` |
| `tz` | an IANA name, for example `Europe/Oslo` | falls back to your saved timezone, then UTC |
| `format` | `json`, `csv` | default `json` |
| `user_id` | an account id | administrators only |

A naive `from` or `to` is read as local time in the resolved zone, exactly as on
`GET /api/stats`. The response carries an `X-Tally-Timezone` header naming the
zone that was actually used, so a `tz` that failed to load is visible rather
than silent.

Every filter the browse pages take also narrows a series: `?genre=Horror`,
`?min_rating=8`, `?library_id=3`, `?anime=only`. The whole set is in `/api/docs`
on your own instance.

## The answer

A **bare JSON array** with three fixed columns, so one datasource query works
for every metric:

```json
[
  {"ts": "2026-08-14T00:00:00+02:00", "series": "movie", "value": 2},
  {"ts": "2026-08-15T00:00:00+02:00", "series": "episode", "value": 6}
]
```

* `ts` always carries its UTC offset. Buckets are local days, so a film started
  at 23:30 belongs to that evening.
* With `group_by=none`, `series` is the metric's own name, so the shape never
  varies between a grouped answer and an ungrouped one.
* **Empty buckets are filled only when `group_by=none`.** With a group-by, only
  the buckets that hold something are emitted, because filling every series by
  every bucket is a cross-product: a year of daily data across forty genres is
  fifteen thousand rows of mostly zero. In the panel, turn on **Connect null
  values**, or use a bar chart.
* `avg_rating` fills empty buckets with `null`, not `0`. Nobody rating is not a
  rating of zero.
* The genre series count a play once per genre, so they do not sum to `plays`.
* `distinct_*` counts are distinct *within a bucket*, so daily figures do not
  sum to the monthly one.
* `ratings_given` and `avg_rating` are timestamped by when the rating was
  recorded, which for ratings pulled from Plex is the day Tally first saw them.

`format=csv` returns the same rows as RFC 4180 CSV with a header line.

### When it refuses

Four cases answer with an error rather than a plausible but wrong series:

| Request | Answer |
|---|---|
| More than 5000 buckets, for example `interval=hour` over ten years | `422`, with the numbers in it. Ask for a coarser `interval`. |
| `ratings_given` or `avg_rating` grouped by `source` or `device` | `422`. Those describe a play, and a rating has no column to answer them from. |
| `group_by=user`, or any `user_id`, from a non-administrator | `403`, never a quiet fallback to your own numbers. |
| `group_by=user` together with a filter that reads your own ratings, notes or progress | `422`. Those would be applied to one account and reported against everyone's. |

## The Infinity datasource

Install **Infinity** (`yesoreyeram-infinity-datasource`), then provision it:

```yaml
# /etc/grafana/provisioning/datasources/tally.yaml
apiVersion: 1
datasources:
  - name: Tally
    type: yesoreyeram-infinity-datasource
    uid: tally
    jsonData:
      auth_method: apiKey
      apiKeyKey: X-API-Key
      apiKeyType: header
      # Infinity refuses any URL not listed here. See the warning below.
      allowedHosts:
        - https://tally.example.com
    secureJsonData:
      apiKeyValue: tally_your_key_here
```

> **If you configure authentication without an Allowed Hosts entry, Infinity
> silently refuses to run the query.** No error, no data, just an empty panel.
> This is the single most common reason a Tally dashboard looks broken.

## One worked panel

Plays per day, split by media type:

* **Type** `JSON`, **Parser** `Backend`, **Source** `URL`, **Format** `Table`
* **URL**
  `https://tally.example.com/api/stats/series?metric=plays&interval=day&group_by=media_type&from=${__from:date:iso}&to=${__to:date:iso}&tz=Europe/Oslo`
* **Columns**, the three mappings, which never change with the metric:

  | Selector | Title | Format |
  |---|---|---|
  | `ts` | Time | Timestamp |
  | `series` | Series | String |
  | `value` | Value | Number |

Leave the root selector **empty**: the response is already an array at the root.
In the panel's *Transform* tab, add **Partition by values** on `series` to get
one line per media type.

## A dashboard to start from

There is one at [`../grafana/tally-overview.json`](../grafana/tally-overview.json).
Import it, pick your Tally datasource when prompted, and edit freely. It is an
example to take apart, not a supported artifact, and it will not be kept in step
with future releases.

## Not supported

* **The SimpleJSON datasource** (`/search`, `/query`, `/annotations`). That
  plugin reached end of life in June 2024 and Grafana points people at Infinity.
* **Pointing a SQLite datasource straight at `/data/tally.db`.** It works, and
  it bypasses authentication, scopes and the per-user boundary entirely: every
  account's ratings, notes and history, to anyone who can edit a panel.

Live gauges for alerting rather than graphing are a separate endpoint, in
`prometheus.md`.
