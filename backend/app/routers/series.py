"""One generic time series, shaped for an external dashboard.

`GET /api/stats/series` exists because Grafana does not want the stats page. It
wants *one* query definition it can point at six different metrics, and it wants
the answer flat: a bare top-level JSON array of rows with fixed column names.

Every decision here follows from that.

**Bare array, not `{"data": […]}`.** The Infinity datasource parses a JSON array
at the document root with no configuration at all. An envelope means every user
has to type a root selector into every panel, and a wrong one fails as an empty
graph rather than as an error.

**Fixed column names — `ts`, `series`, `value` — whatever is being asked.** One
datasource query, three column mappings, and switching `metric=plays` to
`metric=minutes` needs no edit to the panel. With `group_by=none` the `series`
column carries the metric's own name rather than disappearing, so the shape
never varies between grouped and ungrouped answers either.

**`ts` carries its UTC offset.** `2026-08-14T00:00:00+02:00`, not
`2026-08-14T00:00:00`. Grafana re-guesses the zone of a naive timestamp — as the
browser's, or as UTC, depending on where in the pipeline it lands — and the
result is a bar chart whose days are silently shifted by one. Buckets are
assigned in Python from `watched_at.astimezone(tz)`, never by a fixed offset in
SQL, so a window spanning a summer-time change has one 23-hour day in it and the
labels stay honest on both sides. See `timezones.py` and `stats.py`.

**Zero-fill only without a group-by.** A dashboard reading a sparse series as a
line wants the empty days present, so `group_by=none` emits every bucket in the
window. With a group-by, filling every series × bucket is a cross-product — a
year of daily data across forty genres is fifteen thousand rows of mostly zero —
so only observed buckets are emitted, and the panel is expected to set *Connect
null values* or to draw bars. The README says so.

**The bucket count is capped.** `interval=hour` over ten years is 87,600 rows
nobody can read and a response nobody wants to hold in memory. It is a 422 with
the numbers in it, not a truncated answer, because a silently short series looks
like missing data.

**Two subjects, not one.** `plays`, `minutes`, `distinct_titles` and
`distinct_shows` count `WatchEvent` rows; `ratings_given` and `avg_rating` count
`UserMediaState` rows and are timestamped by `rating_updated_at`. That means the
rating metrics cannot be grouped by `source` or `device`, which are properties of
a play — asked for anyway, that is a 422 rather than an empty answer.
"""
from __future__ import annotations

import csv
import io
from datetime import UTC, datetime, time, timedelta, tzinfo
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy import and_, select

from ..deps import CurrentUser, DbSession
from ..media_filters import MediaFilters, facet_value
from ..models import (
    MediaItem,
    MediaType,
    User,
    UserMediaState,
    WatchEvent,
)
from ..schemas import StatsPreset, StatsRange
from .stats import (
    SOURCE_LABELS,
    _minutes,
    _resolve_range,
    _scope,
    _stats_filters,
    _zone_for,
)

router = APIRouter(prefix="/api/stats", tags=["stats"])

SeriesMetric = Literal[
    "plays",
    "minutes",
    "distinct_titles",
    "distinct_shows",
    "ratings_given",
    "avg_rating",
]
SeriesInterval = Literal["hour", "day", "week", "month"]
SeriesGroupBy = Literal[
    "none", "media_type", "genre", "anime", "source", "device", "user"
]
SeriesFormat = Literal["json", "csv"]

# What the two rating metrics read instead of `WatchEvent`.
_RATING_METRICS = frozenset({"ratings_given", "avg_rating"})

# Grouping dimensions that are properties of a *play*, so a rating series has no
# column to answer them from.
_EVENT_ONLY_GROUPS = frozenset({"source", "device"})

# A metric that averages must not be zero-filled: 0 is a rating somebody could
# have given, and a chart cannot tell "rated nobody" from "everyone hated it".
_AVERAGING_METRICS = frozenset({"avg_rating"})

# The most buckets one response may hold. Chosen to sit above anything a real
# dashboard asks for — two years of hourly data is 17,520 and is already
# unreadable — and below the point where the JSON stops fitting comfortably in
# a browser tab.
MAX_BUCKETS = 5000

# The column names never change with the metric, so one Infinity query
# definition serves every panel. Do not rename these.
COLUMNS = ("ts", "series", "value")

# `StatsRange.granularity` has no "hour", and nothing here reads it — the
# buckets are built from `interval` below. Mapped rather than defaulted so the
# window a caller gets back is at least the nearest true thing.
_RANGE_GRANULARITY: dict[str, Any] = {
    "hour": "day",
    "day": "day",
    "week": "week",
    "month": "month",
}

_UNGROUPED_LABELS = {
    "plays": "plays",
    "minutes": "minutes",
    "distinct_titles": "distinct_titles",
    "distinct_shows": "distinct_shows",
    "ratings_given": "ratings_given",
    "avg_rating": "avg_rating",
}

# What a row with nothing in the grouped column is called. A literal empty
# string would be a legal series name that renders as a blank legend entry.
UNKNOWN_LABEL = "unknown"


# --- buckets --------------------------------------------------------------


def _floor(moment: datetime, interval: SeriesInterval, tz: tzinfo) -> datetime:
    """The start of the local bucket `moment` falls in, offset attached.

    `astimezone` is the only thing here that knows about summer time, and it is
    applied before anything is truncated — so a play at 02:30 on the day a zone
    springs forward lands in the bucket its wall clock actually showed.
    """
    local = moment.astimezone(tz)
    if interval == "hour":
        return local.replace(minute=0, second=0, microsecond=0)
    if interval == "week":
        day = local.date() - timedelta(days=local.weekday())
    elif interval == "month":
        day = local.date().replace(day=1)
    else:
        day = local.date()
    return datetime.combine(day, time.min, tzinfo=tz)


def _next_bucket(bucket: datetime, interval: SeriesInterval, tz: tzinfo) -> datetime:
    """The bucket after this one.

    Days are stepped on the *local calendar* and re-resolved through the zone,
    never by adding 24 hours: the day a zone springs forward is 23 hours long,
    and stepping in absolute time would drift the labels by an hour and then
    skip or duplicate a day. Hours step in absolute time for the mirror-image
    reason — a local clock repeats 02:00 in autumn.
    """
    if interval == "hour":
        return (bucket.astimezone(UTC) + timedelta(hours=1)).astimezone(tz)
    day = bucket.date()
    if interval == "week":
        day += timedelta(days=7)
    elif interval == "month":
        day = (
            day.replace(year=day.year + 1, month=1, day=1)
            if day.month == 12
            else day.replace(month=day.month + 1, day=1)
        )
    else:
        day += timedelta(days=1)
    return datetime.combine(day, time.min, tzinfo=tz)


def _bucket_span(window: StatsRange, interval: SeriesInterval, tz: tzinfo) -> list[datetime]:
    """Every bucket the window covers, in order.

    Built by walking rather than by arithmetic, because the arithmetic is wrong
    across a summer-time change and across a month of any length but 30 days.
    Bounded by `MAX_BUCKETS` before the walk, so a decade of hours is a 422 and
    not a loop that runs a hundred thousand times.
    """
    buckets: list[datetime] = []
    cursor = _floor(window.since, interval, tz)
    while cursor < window.until:
        buckets.append(cursor)
        following = _next_bucket(cursor, interval, tz)
        if following <= cursor:  # pragma: no cover - defensive; zones do not do this
            break
        cursor = following
    return buckets


def _check_bucket_cap(window: StatsRange, interval: SeriesInterval) -> None:
    """Refuse a window that would not fit, before a single row is read.

    Estimated from the span rather than counted, because counting means walking
    the very sequence the cap exists to avoid. The estimate is generous by at
    most one bucket, which does not matter at this scale.
    """
    span = window.until - window.since
    per_bucket = {
        "hour": timedelta(hours=1),
        "day": timedelta(days=1),
        "week": timedelta(days=7),
        # Buckets are counted, not measured: the shortest month bounds the count.
        "month": timedelta(days=28),
    }[interval]
    estimate = int(span / per_bucket) + 1
    if estimate > MAX_BUCKETS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"That window is {estimate} `{interval}` buckets, and the limit is "
            f"{MAX_BUCKETS}. Ask for a shorter window or a coarser `interval`.",
        )


# --- grouping -------------------------------------------------------------


def _genres_of(raw: Any) -> list[str]:
    """The genre list off a row, defensively.

    What comes back is whatever was stored, which on a hand-edited row need not
    be a list of strings.
    """
    if isinstance(raw, list):
        return [str(value) for value in raw if value]
    if isinstance(raw, str) and raw:
        return [raw]
    return []


async def _genres_from_shows(db: DbSession, rows: list[Any]) -> dict[int, list[str]]:
    """Genres for the series of every played row that has none of its own.

    `facet_value("genres")` is the one rule for reading a facet through the
    parent show, and it is in the SELECT — but it cannot finish the job for
    *this* column. `MediaItem.genres` is declared `default=list`, so an episode
    is stored with `[]` rather than NULL, and `coalesce([], <show's genres>)`
    is `[]`: the coalesce never fires. Every other facet `facet_value` covers
    (`studio`, `network`, `content_rating`) defaults to None, which is why this
    surfaces here and nowhere else.

    So the SQL rule is left doing what it can and the empty case is finished in
    Python, through the same `show_id` relationship and nothing else — one
    batched lookup over the handful of series a window actually names, never a
    query per row. If `genres` ever loses its list default, this becomes dead
    weight rather than wrong.
    """
    wanted = {
        row.show_id
        for row in rows
        if row.show_id and not _genres_of(row.genres)
    }
    if not wanted:
        return {}
    found = (
        await db.execute(
            select(MediaItem.id, MediaItem.genres).where(MediaItem.id.in_(wanted))
        )
    ).all()
    return {show_id: _genres_of(genres) for show_id, genres in found}


def _labels_for(
    group_by: SeriesGroupBy,
    row: Any,
    names: dict[int, str],
    show_genres: dict[int, list[str]],
) -> list[str]:
    """Which series this row belongs to — plural, because genre fans out.

    A film tagged Crime and Drama is one play and counts once in each genre, the
    same way `top_genres` on the stats page counts it. So the genre series do not
    sum to the total, and the README says so.
    """
    if group_by == "none":
        return [""]
    if group_by == "media_type":
        return [row.media_type.value if row.media_type else UNKNOWN_LABEL]
    if group_by == "anime":
        return ["anime" if row.is_anime else "not anime"]
    if group_by == "genre":
        own = _genres_of(row.genres)
        if not own and getattr(row, "show_id", None):
            own = show_genres.get(row.show_id, [])
        return own or [UNKNOWN_LABEL]
    if group_by == "source":
        return [SOURCE_LABELS.get(row.source, str(row.source))]
    if group_by == "device":
        return [row.device or UNKNOWN_LABEL]
    # user — the label is a name, never the email. An address is a credential
    # people reuse, and a Grafana dashboard is the least private surface in the
    # house.
    return [names.get(row.user_id, UNKNOWN_LABEL)]


# --- household scope ------------------------------------------------------


async def _subjects(
    db: DbSession,
    caller: User,
    user_id: int | None,
    group_by: SeriesGroupBy,
) -> tuple[list[User], dict[int, str]]:
    """Whose data this request may read, and what to call them.

    Own data by default, for everybody including an administrator: a cross-user
    read has to be asked for in as many words, so it can never happen by
    accident on a dashboard somebody copied. Asking for one without the
    authority is a **403** and never a quiet fallback to your own numbers — a
    panel that answers with the wrong household member's viewing, plausibly, is
    worse than a panel that says it is not allowed.
    """
    if (user_id is not None or group_by == "user") and not caller.is_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Reading another account's history requires an administrator.",
        )

    if group_by == "user":
        people = list((await db.execute(select(User))).scalars())
    elif user_id is not None:
        target = await db.get(User, user_id)
        if target is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such user")
        people = [target]
    else:
        people = [caller]

    return people, {
        person.id: person.display_name or person.username for person in people
    }


# --- the two queries ------------------------------------------------------


async def _event_rows(
    db: DbSession,
    subjects: list[User],
    window: StatsRange,
    filters: MediaFilters,
    group_by: SeriesGroupBy,
) -> list[Any]:
    """One narrow row per play in the window.

    `_scope` joins `media_items` and applies the shared browse filters, so
    `?genre=Horror&min_rating=8` narrows a series exactly as it narrows the
    grid. Its per-user `user_media_states` join is pinned to a single account —
    which is right for every case but `group_by=user`, where there is no single
    account to pin it to. That combination is refused by the caller rather than
    answered against the wrong person's ratings.
    """
    ids = [person.id for person in subjects]
    stmt = _scope(
        select(
            WatchEvent.watched_at.label("watched_at"),
            WatchEvent.duration_ms.label("duration_ms"),
            WatchEvent.source.label("source"),
            WatchEvent.device.label("device"),
            WatchEvent.user_id.label("user_id"),
            MediaItem.id.label("item_id"),
            MediaItem.media_type.label("media_type"),
            MediaItem.runtime_minutes.label("runtime_minutes"),
            MediaItem.show_id.label("show_id"),
            MediaItem.is_anime.label("is_anime"),
            facet_value("genres").label("genres"),
        ).select_from(WatchEvent),
        filters,
        # Only read when a filter needs the state row, and `group_by=user` — the
        # one case where "which user" is ambiguous — never gets here.
        subjects[0],
    ).where(
        and_(
            WatchEvent.user_id.in_(ids),
            WatchEvent.watched_at >= window.since,
            WatchEvent.watched_at < window.until,
        )
    )
    return list((await db.execute(stmt)).all())


async def _rating_rows(
    db: DbSession,
    subjects: list[User],
    window: StatsRange,
    filters: MediaFilters,
) -> list[Any]:
    """One row per rating recorded in the window.

    Timestamped by `rating_updated_at`, which is the only date a rating has —
    and which is stamped when the rating is first *pulled from Plex*, so a fresh
    install files a decade of ratings under its first sync. That is a real
    caveat and it is documented rather than worked around; the alternative,
    scoping ratings by when the title was watched, is what `GET /api/stats`
    already does and is a different question.

    `UserMediaState` is the FROM here rather than an outer join, so the shared
    filters are applied directly: the item half unconditionally, and the state
    half against the row already pinned to the subject accounts.
    """
    ids = [person.id for person in subjects]
    stmt = (
        select(
            UserMediaState.rating_updated_at.label("watched_at"),
            UserMediaState.rating.label("rating"),
            UserMediaState.user_id.label("user_id"),
            MediaItem.media_type.label("media_type"),
            MediaItem.show_id.label("show_id"),
            MediaItem.is_anime.label("is_anime"),
            facet_value("genres").label("genres"),
        )
        .select_from(UserMediaState)
        .join(MediaItem, MediaItem.id == UserMediaState.media_item_id)
        .where(
            and_(
                UserMediaState.user_id.in_(ids),
                UserMediaState.rating.is_not(None),
                UserMediaState.rating_updated_at.is_not(None),
                UserMediaState.rating_updated_at >= window.since,
                UserMediaState.rating_updated_at < window.until,
            )
        )
    )
    if items := filters.item_conditions(default_types=False):
        stmt = stmt.where(and_(*items))
    if filters.needs_state_join() and (state := filters.state_conditions()):
        stmt = stmt.where(and_(*state))
    return list((await db.execute(stmt)).all())


# --- accumulation ---------------------------------------------------------


def _accumulate(
    rows: list[Any],
    metric: SeriesMetric,
    interval: SeriesInterval,
    group_by: SeriesGroupBy,
    tz: tzinfo,
    names: dict[int, str],
    show_genres: dict[int, list[str]],
) -> dict[tuple[datetime, str], Any]:
    """Fold the rows into one value per (bucket, series).

    The distinct metrics collect sets rather than counters, so they are counted
    *within* a bucket — which means the daily numbers do not sum to the monthly
    one. That is what "distinct" means and it is the number people want; the
    README says it out loud because a dashboard showing both invites the
    comparison.
    """
    totals: dict[tuple[datetime, str], Any] = {}

    for row in rows:
        bucket = _floor(row.watched_at, interval, tz)
        for label in _labels_for(group_by, row, names, show_genres):
            key = (bucket, label)
            if metric == "plays":
                totals[key] = totals.get(key, 0) + 1
            elif metric == "minutes":
                totals[key] = totals.get(key, 0) + _minutes(
                    row.duration_ms, row.runtime_minutes, row.media_type
                )
            elif metric == "distinct_titles":
                # An episode answers as its series, so forty episodes of one
                # show are one title watched, not forty.
                totals.setdefault(key, set()).add(row.show_id or row.item_id)
            elif metric == "distinct_shows":
                # A film is not a show and contributes nothing — deliberately
                # not an empty bucket, which would draw a `movie: 0` line on a
                # chart grouped by media type.
                if row.media_type == MediaType.EPISODE and row.show_id:
                    totals.setdefault(key, set()).add(row.show_id)
                elif row.media_type in (MediaType.SHOW, MediaType.SEASON):
                    totals.setdefault(key, set()).add(row.show_id or row.item_id)
            elif metric == "ratings_given":
                totals[key] = totals.get(key, 0) + 1
            else:  # avg_rating
                totals.setdefault(key, []).append(float(row.rating))

    if metric in ("distinct_titles", "distinct_shows"):
        return {key: len(value) for key, value in totals.items()}
    if metric == "avg_rating":
        return {
            key: round(sum(value) / len(value), 2)
            for key, value in totals.items()
            if value
        }
    return totals


def _rows_out(
    totals: dict[tuple[datetime, str], Any],
    metric: SeriesMetric,
    interval: SeriesInterval,
    group_by: SeriesGroupBy,
    window: StatsRange,
    tz: tzinfo,
) -> list[dict[str, Any]]:
    """The flat payload, sorted, and zero-filled when — and only when — it can be."""
    if group_by == "none":
        label = _UNGROUPED_LABELS[metric]
        empty = None if metric in _AVERAGING_METRICS else 0
        return [
            {
                "ts": bucket.isoformat(),
                "series": label,
                "value": totals.get((bucket, ""), empty),
            }
            for bucket in _bucket_span(window, interval, tz)
        ]

    return [
        {"ts": bucket.isoformat(), "series": label, "value": value}
        for (bucket, label), value in sorted(
            totals.items(), key=lambda item: (item[0][0], item[0][1])
        )
    ]


def _csv_of(rows: list[dict[str, Any]]) -> str:
    """RFC 4180: CRLF endings, a header row, and minimal quoting.

    `csv.writer` with the default `QUOTE_MINIMAL` is already the RFC's rule —
    quote only when the field holds a delimiter, a quote or a line break, and
    double an embedded quote. Hand-rolling it is how a device called
    `Living Room, TV` breaks somebody's spreadsheet.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(COLUMNS)
    for row in rows:
        writer.writerow(
            ["" if row[column] is None else row[column] for column in COLUMNS]
        )
    return buffer.getvalue()


# --- the endpoint ---------------------------------------------------------


@router.get("/series")
async def stats_series(
    db: DbSession,
    user: CurrentUser,
    filters: Annotated[MediaFilters, Depends()],
    metric: SeriesMetric = "plays",
    from_: Annotated[datetime | None, Query(alias="from")] = None,
    to: datetime | None = None,
    preset: StatsPreset | None = None,
    days: int | None = Query(None, ge=1, le=3650),
    interval: SeriesInterval = "day",
    group_by: SeriesGroupBy = "none",
    tz: str | None = None,
    format: SeriesFormat = "json",  # noqa: A002 - the name Grafana users expect
    user_id: int | None = None,
) -> Response:
    """One metric over time, as flat rows a dashboard can graph directly.

    Grafana writes the window with its own macros:
    `?from=${__from:date:iso}&to=${__to:date:iso}`. A naive `from`/`to` is read
    as the resolved timezone's local time, exactly as on `GET /api/stats`.

    Everything the browse filters offer narrows a series — `?genre=Horror`,
    `?min_rating=8`, `?library_id=3` — and the two adjustments the stats page
    makes are made here too: episodes are counted, and home videos are real
    hours.
    """
    filters = _stats_filters(filters, False)
    zone, resolved_name = _zone_for(user, tz)

    if metric in _RATING_METRICS and group_by in _EVENT_ONLY_GROUPS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"`{metric}` describes a rating, which has no `{group_by}` — that is "
            "a property of a play. Group by media_type, genre, anime or user.",
        )

    subjects, names = await _subjects(db, user, user_id, group_by)
    # Unconditional, not "only once a second account exists": a dashboard that
    # works on a one-person install and 422s the day a housemate registers is
    # worse than one that never accepted the combination.
    if group_by == "user" and filters.needs_state_join():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Filters that read your own ratings, notes or progress cannot be "
            "combined with `group_by=user` — they would be applied to one "
            "account and reported against everyone's.",
        )

    window = await _resolve_range(
        db,
        user,
        zone,
        resolved_name,
        preset,
        from_,
        to,
        days,
        _RANGE_GRANULARITY[interval],
    )
    _check_bucket_cap(window, interval)

    if metric in _RATING_METRICS:
        rows = await _rating_rows(db, subjects, window, filters)
    else:
        rows = await _event_rows(db, subjects, window, filters, group_by)

    # Only asked for when the answer needs it — one extra query, over the few
    # series a window names, and none at all for the other groupings.
    show_genres = await _genres_from_shows(db, rows) if group_by == "genre" else {}

    payload = _rows_out(
        _accumulate(rows, metric, interval, group_by, zone, names, show_genres),
        metric,
        interval,
        group_by,
        window,
        zone,
    )

    # The payload carries no envelope to report the zone in, and a `tz=` that
    # failed to load falls back to UTC silently. The offset on every `ts` says
    # so too, but only to somebody who already suspects it.
    headers = {"X-Tally-Timezone": resolved_name}

    if format == "csv":
        return Response(
            content=_csv_of(payload),
            media_type="text/csv; charset=utf-8",
            headers=headers,
        )
    return JSONResponse(content=payload, headers=headers)
