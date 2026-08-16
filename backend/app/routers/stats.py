"""Aggregate viewing statistics.

Two things here are easy to get subtly wrong, and both were wrong before.

**Days belong to the viewer, not to the database.** Every timestamp is stored
UTC (`models.UtcDateTime`) and must stay that way, but a day boundary is a
local thing: a film started at 23:30 in Oslo belongs to that evening, not to
the next morning. So the window bounds are computed as *local midnight* and
converted to UTC for the `watched_at >= :since` comparison — which keeps
`ix_watch_events_user_time` doing the work — while the day, month and streak
buckets are assigned in Python from `watched_at.astimezone(tz)`. Bucketing in
SQL would mean `strftime(..., '+02:00')`, a fixed offset that is wrong for half
of every year.

**One window, applied to everything.** Each number on the page has to answer
the same question over the same span, or the page compares things that were
never comparable. Ratings and show counts used to opt out of the window
silently.

Home videos (`MediaItem.is_personal_media`) *are* counted in the watch numbers.
The browse grids hide them by default, but a play is a play and the hours are
real; only the library inventory on `/summary` leaves them out, because that
counter is about the shelf rather than about the viewing.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta, tzinfo

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import and_, func, select, union

from ..deps import CurrentUser, DbSession
from ..models import MediaItem, MediaType, User, UserMediaState, WatchEvent, utcnow
from ..schemas import (
    StatCount,
    StatsComparison,
    StatsGranularity,
    StatsOut,
    StatsPreset,
    StatsRange,
    StatsTotals,
)
from ..timezones import resolve as resolve_timezone

router = APIRouter(prefix="/api/stats", tags=["stats"])

# Fallbacks for items whose runtime we never learned, so totals stay plausible.
DEFAULT_EPISODE_MINUTES = 24
DEFAULT_MOVIE_MINUTES = 110

# What `GET /api/stats` covers when the caller names no window at all. Kept at
# the value the `days` parameter used to default to.
DEFAULT_DAYS = 365


def _streaks(days: set[date], today: date) -> tuple[int, int]:
    """Current and longest consecutive-day watching streaks.

    `today` is the viewer's own today, not the server's — a streak that ends at
    midnight in one timezone has not ended in another.
    """
    if not days:
        return 0, 0
    unique = sorted(days)

    longest = run = 1
    for previous, current in zip(unique, unique[1:], strict=False):
        run = run + 1 if (current - previous).days == 1 else 1
        longest = max(longest, run)

    # A streak stays "current" if it includes today or yesterday; requiring
    # today would reset every streak at midnight.
    if unique[-1] < today - timedelta(days=1):
        return 0, longest

    current_streak = 1
    for previous, following in zip(reversed(unique[:-1]), reversed(unique[1:]), strict=False):
        if (following - previous).days == 1:
            current_streak += 1
        else:
            break
    return current_streak, longest


# --- window resolution ----------------------------------------------------


def _midnight(day: date, tz: tzinfo) -> datetime:
    """Local midnight on `day`, as the UTC instant to compare rows against."""
    return datetime.combine(day, time.min, tzinfo=tz).astimezone(UTC)


def _as_utc(value: datetime, tz: tzinfo) -> datetime:
    """A caller-supplied bound in UTC.

    A naive value is read as the viewer's local time, not as UTC: the whole
    endpoint is timezone-aware, and `?since=2026-01-01` obviously means their
    new year. (`routers/history.py` takes the same parameters but has no
    timezone of its own, so it reads a naive one as UTC — the column does.)
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=tz)
    return value.astimezone(UTC)


def _months_back(day: date, months: int) -> date:
    """The first of the month `months` before the month `day` falls in."""
    index = day.year * 12 + (day.month - 1) - months
    return date(index // 12, index % 12 + 1, 1)


async def _resolve_range(
    db: DbSession,
    user: User,
    tz: tzinfo,
    tz_name: str,
    preset: StatsPreset | None,
    since: datetime | None,
    until: datetime | None,
    days: int | None,
    granularity: StatsGranularity,
) -> StatsRange:
    """Turn whichever of the three ways to ask into one concrete window."""
    now = utcnow()
    today = now.astimezone(tz).date()
    end = now

    if preset == "ytd":
        start_day = date(today.year, 1, 1)
    elif preset == "12m":
        # Whole months, so the monthly chart gets exactly twelve bars.
        start_day = _months_back(today, 11)
    elif preset == "last_year":
        start_day = date(today.year - 1, 1, 1)
        end = _midnight(date(today.year, 1, 1), tz)
    elif preset == "all":
        earliest = await db.scalar(
            select(func.min(WatchEvent.watched_at)).where(WatchEvent.user_id == user.id)
        )
        start_day = earliest.astimezone(tz).date() if earliest else today
    elif preset is not None:
        start_day = today - timedelta(days=int(preset.removesuffix("d")))
    else:
        # `days` is the shipped frontend's and existing API clients' spelling of
        # the same thing, so it stays a working alias rather than a deprecation.
        start_day = today - timedelta(days=days if days is not None else DEFAULT_DAYS)

    start = _midnight(start_day, tz)

    # An explicit bound wins over anything a preset worked out.
    if since is not None:
        start = _as_utc(since, tz)
    if until is not None:
        end = _as_utc(until, tz)
    if end <= start:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "`until` must be later than `since`"
        )

    return _range(start, end, tz, tz_name, granularity, preset)


def _range(
    start: datetime,
    end: datetime,
    tz: tzinfo,
    tz_name: str,
    granularity: StatsGranularity,
    preset: StatsPreset | None = None,
) -> StatsRange:
    start_day = start.astimezone(tz).date()
    # The window is half-open, so the last day it covers is the one the instant
    # *before* `until` falls in — otherwise a window ending at midnight would
    # claim a day it holds nothing of.
    end_day = (end - timedelta(microseconds=1)).astimezone(tz).date()
    return StatsRange(
        preset=preset,
        since=start,
        until=end,
        start_day=start_day,
        end_day=end_day,
        days=(end_day - start_day).days + 1,
        timezone=tz_name,
        granularity=granularity,
    )


def _preceding(window: StatsRange, tz: tzinfo) -> StatsRange:
    """The window of equal length ending where this one starts."""
    span = window.until - window.since
    return _range(
        window.since - span,
        window.since,
        tz,
        window.timezone,
        window.granularity,
    )


# --- aggregation ----------------------------------------------------------


@dataclass
class _Aggregate:
    events: int = 0
    movies: int = 0
    episodes: int = 0
    anime: int = 0
    runtime: int = 0
    shows: set[int] = field(default_factory=set)
    genres: Counter[str] = field(default_factory=Counter)
    by_day: Counter[date] = field(default_factory=Counter)
    ratings: list[float] = field(default_factory=list)


def _minutes(duration_ms: int | None, runtime: int | None, media_type: MediaType) -> int:
    """How long one play was, best evidence first.

    `WatchEvent.duration_ms` is what Plex reported for the item at the time it
    was played, and it is the only runtime a thin history-minted row has —
    those carry no `runtime_minutes` at all, so without this they fell all the
    way through to the flat default.
    """
    if duration_ms and duration_ms > 0:
        return round(duration_ms / 60_000)
    if runtime:
        return runtime
    if media_type == MediaType.MOVIE:
        return DEFAULT_MOVIE_MINUTES
    if media_type == MediaType.EPISODE:
        return DEFAULT_EPISODE_MINUTES
    return 0


async def _aggregate(
    db: DbSession,
    user: User,
    window: StatsRange,
    anime_only: bool,
    tz: tzinfo,
) -> _Aggregate:
    conditions = [
        WatchEvent.user_id == user.id,
        WatchEvent.watched_at >= window.since,
        WatchEvent.watched_at < window.until,
    ]
    if anime_only:
        conditions.append(MediaItem.is_anime.is_(True))

    rows = (
        await db.execute(
            select(
                WatchEvent.watched_at,
                WatchEvent.duration_ms,
                MediaItem.id,
                MediaItem.media_type,
                MediaItem.runtime_minutes,
                MediaItem.genres,
                MediaItem.is_anime,
                MediaItem.show_id,
            )
            .join(MediaItem, MediaItem.id == WatchEvent.media_item_id)
            .where(and_(*conditions))
        )
    ).all()

    agg = _Aggregate(events=len(rows))
    for watched_at, duration_ms, item_id, media_type, runtime, genres, is_anime, show_id in rows:
        day = watched_at.astimezone(tz).date()
        agg.by_day[day] += 1
        agg.runtime += _minutes(duration_ms, runtime, media_type)

        if media_type == MediaType.MOVIE:
            agg.movies += 1
        elif media_type == MediaType.EPISODE:
            agg.episodes += 1
            if show_id:
                agg.shows.add(show_id)
        elif media_type == MediaType.SHOW:
            # Rare, but a whole show can be marked watched directly, and that
            # is still "a show you watched in this window".
            agg.shows.add(item_id)

        if is_anime:
            agg.anime += 1
        for genre in genres or []:
            agg.genres[genre] += 1

    agg.ratings = await _ratings_for_window(db, user, conditions)
    return agg


async def _ratings_for_window(db: DbSession, user: User, conditions: list) -> list[float]:
    """Ratings on what was watched in this window.

    Scoping ratings by *when the rating was made* looks more natural and is
    not: `rating_updated_at` is stamped when a rating is first pulled from
    Plex, so a fresh install would file a decade of ratings under "this week".
    What was watched, on the other hand, is exactly what the rest of the page
    is already about — and it means `anime_only` scopes the ratings too, for
    free, off the same conditions.

    An episode's rating lives on its show, so the shows episodes belong to are
    part of the subject set; without them a television-heavy window would show
    an empty ratings chart.
    """
    watched = select(WatchEvent.media_item_id.label("id")).join(
        MediaItem, MediaItem.id == WatchEvent.media_item_id
    ).where(and_(*conditions))
    parents = (
        select(MediaItem.show_id.label("id"))
        .join(WatchEvent, MediaItem.id == WatchEvent.media_item_id)
        .where(and_(*conditions, MediaItem.show_id.is_not(None)))
    )
    # A subquery rather than an IN of ids read back into Python: a long window
    # holds thousands of items and SQLite caps bound parameters per statement.
    subjects = union(watched, parents).subquery()

    rows = await db.execute(
        select(UserMediaState.rating).where(
            UserMediaState.user_id == user.id,
            UserMediaState.rating.is_not(None),
            UserMediaState.media_item_id.in_(select(subjects.c.id)),
        )
    )
    return [float(value) for value in rows.scalars()]


def _totals(agg: _Aggregate) -> StatsTotals:
    average = round(sum(agg.ratings) / len(agg.ratings), 2) if agg.ratings else None
    return StatsTotals(
        total_movies_watched=agg.movies,
        total_episodes_watched=agg.episodes,
        total_shows_watched=len(agg.shows),
        total_anime_watched=agg.anime,
        total_runtime_minutes=agg.runtime,
        watch_events=agg.events,
        average_rating=average,
    )


def _pct_change(current: StatsTotals, previous: StatsTotals) -> dict[str, float]:
    """Percent movement per metric, omitting the ones with no baseline."""
    changes: dict[str, float] = {}
    for name in StatsTotals.model_fields:
        before = getattr(previous, name)
        after = getattr(current, name)
        if not before or after is None:
            # Zero (or no rating) has no percentage to grow by; the tile shows
            # the raw pair instead of inventing an infinity.
            continue
        changes[name] = round((after - before) / before * 100, 1)
    return changes


# --- series ---------------------------------------------------------------


def _bucket(day: date, granularity: StatsGranularity) -> str:
    if granularity == "month":
        return day.strftime("%Y-%m")
    if granularity == "week":
        return (day - timedelta(days=day.weekday())).isoformat()
    return day.isoformat()


def _series(
    by_day: Counter[date],
    window: StatsRange,
    granularity: StatsGranularity,
) -> list[StatCount]:
    """One entry per bucket across the whole window, gaps included.

    Zero days are real information — a chart that skips them draws a busy week
    and a quiet one the same width. There is deliberately no cap on the number
    of points: the series used to be silently truncated to 180 days however
    long a range was asked for, so the chart and the tiles above it described
    different spans. A very long range asks for `granularity` instead.
    """
    buckets: dict[str, int] = {}
    cursor = window.start_day
    while cursor <= window.end_day:
        label = _bucket(cursor, granularity)
        buckets[label] = buckets.get(label, 0) + by_day.get(cursor, 0)
        cursor += timedelta(days=1)
    return [StatCount(label=label, value=value) for label, value in buckets.items()]


# --- endpoints ------------------------------------------------------------


@router.get("", response_model=StatsOut)
async def get_stats(
    db: DbSession,
    user: CurrentUser,
    preset: StatsPreset | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    days: int | None = Query(None, ge=1, le=3650),
    compare: bool = False,
    granularity: StatsGranularity = "day",
    anime_only: bool = False,
    tz: str | None = None,
) -> StatsOut:
    tz_name = tz or (user.preferences or {}).get("timezone")
    zone = resolve_timezone(tz_name)
    # Report the zone actually in force. An unloadable name falls back to UTC
    # rather than 500ing, and saying so is the only way anyone would notice.
    resolved_name = "UTC" if zone is UTC else str(tz_name)

    window = await _resolve_range(
        db, user, zone, resolved_name, preset, since, until, days, granularity
    )
    agg = await _aggregate(db, user, window, anime_only, zone)
    totals = _totals(agg)

    previous = None
    if compare:
        earlier = _preceding(window, zone)
        earlier_totals = _totals(await _aggregate(db, user, earlier, anime_only, zone))
        previous = StatsComparison(
            range=earlier,
            totals=earlier_totals,
            pct_change=_pct_change(totals, earlier_totals),
        )

    distribution: Counter[str] = Counter()
    for value in agg.ratings:
        # Bucket to whole points on Plex's own 0-10 scale. This used to halve the
        # value into five star buckets, which merged 7 and 8 into one bar and
        # made the chart disagree with the rating shown on the item itself.
        distribution[str(int(round(value)))] += 1

    today = utcnow().astimezone(zone).date()
    current_streak, longest_streak = _streaks(set(agg.by_day), today)

    return StatsOut(
        **totals.model_dump(),
        range=window,
        previous=previous,
        current_streak_days=current_streak,
        longest_streak_days=longest_streak,
        top_genres=[
            StatCount(label=name, value=count) for name, count in agg.genres.most_common(12)
        ],
        activity_by_day=_series(agg.by_day, window, granularity),
        activity_by_month=_series(agg.by_day, window, "month"),
        by_type=[
            StatCount(label="Movies", value=agg.movies),
            StatCount(label="Episodes", value=agg.episodes),
            StatCount(label="Anime", value=agg.anime),
        ],
        rating_distribution=[
            StatCount(label=str(score), value=distribution.get(str(score), 0))
            for score in range(1, 11)
        ],
    )


@router.get("/summary")
async def summary(db: DbSession, user: CurrentUser) -> dict:
    """Small counters for the dashboard header."""

    async def count(*conditions) -> int:
        return int(await db.scalar(select(func.count(MediaItem.id)).where(*conditions)) or 0)

    # Home videos are excluded here and nowhere else on this page. This is an
    # inventory of the library, and the browse grids that inventory describes
    # hide them by default, so counting them made the header disagree with the
    # grid it sits above. The watch numbers keep them: those hours were really
    # watched.
    library = MediaItem.is_personal_media.is_(False)

    library_movies = await count(library, MediaItem.media_type == MediaType.MOVIE)
    library_shows = await count(library, MediaItem.media_type == MediaType.SHOW)
    library_anime = await count(
        library,
        MediaItem.is_anime.is_(True),
        MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW]),
    )
    watched_events = int(
        await db.scalar(
            select(func.count(WatchEvent.id)).where(WatchEvent.user_id == user.id)
        )
        or 0
    )
    return {
        "library_movies": library_movies,
        "library_shows": library_shows,
        "library_anime": library_anime,
        "watch_events": watched_events,
    }
