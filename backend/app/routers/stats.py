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

**A rewatch is a rewatch against the whole history, never against the window.**
The first-vs-rewatch split ranks each item's plays with a window function over
*every* play the user has recorded, then filters that ranking down to the
window. Ranking inside the window instead would call March's viewing of
something first seen in 2019 a first watch — plausible, wrong, and invisible.
`ix_watch_events_user_item_time` is `(user_id, media_item_id, watched_at)`,
exactly the partition and order that ranking asks for, so SQLite reads the rows
in order rather than sorting them.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta, tzinfo

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import and_, func, select, union
from sqlalchemy.orm import aliased

from ..deps import CurrentUser, DbSession
from ..models import MediaItem, MediaType, User, UserMediaState, WatchEvent, utcnow
from ..schemas import (
    PunchCard,
    RewatchedItem,
    RewatchSplit,
    RewatchStats,
    SeasonalityOut,
    StatCount,
    StatsComparison,
    StatsGranularity,
    StatsOut,
    StatsPreset,
    StatsRange,
    StatsTotals,
    TimeBucket,
    YearProfile,
)
from ..serializers import poster_for
from ..timezones import resolve as resolve_timezone

router = APIRouter(prefix="/api/stats", tags=["stats"])

# Fallbacks for items whose runtime we never learned, so totals stay plausible.
DEFAULT_EPISODE_MINUTES = 24
DEFAULT_MOVIE_MINUTES = 110

# What `GET /api/stats` covers when the caller names no window at all. Kept at
# the value the `days` parameter used to default to.
DEFAULT_DAYS = 365

# Monday first, matching `date.weekday()`, which is what the buckets are keyed
# on. Sunday-first is a display choice and belongs to the frontend, which gets
# the index alongside the name precisely so it can reorder without guessing.
WEEKDAYS = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)
MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)

# How many rows the most-rewatched ranking returns. It is a list to read, not a
# dataset, and it is computed over all of history — which is exactly why it has
# to be capped in SQL rather than trimmed after the fact.
REWATCH_RANKING_LIMIT = 12


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


def _a_year_earlier(moment: datetime, tz: tzinfo) -> datetime:
    """The same local wall-clock time, one calendar year back.

    Shifting by 365 days is the wrong shape for this: a leap year makes it slide
    by a day, and a window that starts at local midnight would stop doing so
    whenever a summer-time change falls between the two. Moving the local
    calendar year and re-resolving through the zone keeps "1 March, midnight"
    meaning midnight on both sides.
    """
    local = moment.astimezone(tz)
    try:
        shifted = local.replace(year=local.year - 1)
    except ValueError:
        # 29 February has no counterpart in a common year; the 28th is the last
        # day of the same month, which is the least surprising neighbour.
        shifted = local.replace(year=local.year - 1, day=28)
    return shifted.astimezone(UTC)


def _same_window_last_year(window: StatsRange, tz: tzinfo) -> StatsRange:
    return _range(
        _a_year_earlier(window.since, tz),
        _a_year_earlier(window.until, tz),
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
    # Time shape, all keyed off the *local* clock: weekday 0-6 Monday first,
    # hour 0-23, and the (weekday, hour) pair for the punch card. Counting
    # minutes as well as plays matters — a Sunday of films and a Tuesday of
    # sitcom episodes are the same number of plays and nothing like the same
    # evening.
    by_weekday: Counter[int] = field(default_factory=Counter)
    weekday_minutes: Counter[int] = field(default_factory=Counter)
    by_hour: Counter[int] = field(default_factory=Counter)
    hour_minutes: Counter[int] = field(default_factory=Counter)
    by_weekday_hour: Counter[tuple[int, int]] = field(default_factory=Counter)


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
        # One conversion, reused by every bucket below. `astimezone` is the only
        # thing that knows about summer time; a fixed offset here would be
        # wrong for half of every year, and SQL cannot do it at all.
        local = watched_at.astimezone(tz)
        minutes = _minutes(duration_ms, runtime, media_type)
        agg.by_day[local.date()] += 1
        agg.runtime += minutes

        agg.by_weekday[local.weekday()] += 1
        agg.weekday_minutes[local.weekday()] += minutes
        agg.by_hour[local.hour] += 1
        agg.hour_minutes[local.hour] += minutes
        agg.by_weekday_hour[(local.weekday(), local.hour)] += 1

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


async def _comparison(
    db: DbSession,
    user: User,
    earlier: StatsRange,
    anime_only: bool,
    tz: tzinfo,
    current: StatsTotals,
) -> StatsComparison:
    earlier_totals = _totals(await _aggregate(db, user, earlier, anime_only, tz))
    return StatsComparison(
        range=earlier,
        totals=earlier_totals,
        pct_change=_pct_change(current, earlier_totals),
    )


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


def _bucket_labels(window: StatsRange, granularity: StatsGranularity) -> list[str]:
    """Every bucket label in the window, in order, gaps included."""
    labels: list[str] = []
    seen: set[str] = set()
    cursor = window.start_day
    while cursor <= window.end_day:
        label = _bucket(cursor, granularity)
        if label not in seen:
            seen.add(label)
            labels.append(label)
        cursor += timedelta(days=1)
    return labels


# --- time shape -----------------------------------------------------------


def _profile(
    plays: Counter[int],
    minutes: Counter[int],
    names: tuple[str, ...],
    offset: int = 0,
) -> list[TimeBucket]:
    """A fixed-length profile: every slot present, empty ones at zero.

    Absent slots are information — "never on a Monday" is a finding — and a
    chart that omits them draws seven bars one week and five the next.
    """
    return [
        TimeBucket(
            index=index + offset,
            label=name,
            plays=plays.get(index + offset, 0),
            minutes=minutes.get(index + offset, 0),
        )
        for index, name in enumerate(names)
    ]


def _punch_card(grid: Counter[tuple[int, int]]) -> PunchCard:
    matrix = [[grid.get((weekday, hour), 0) for hour in range(24)] for weekday in range(7)]
    return PunchCard(
        weekdays=list(WEEKDAYS),
        hours=list(range(24)),
        plays=matrix,
        max_plays=max((cell for row in matrix for cell in row), default=0),
    )


# --- first watch vs rewatch -----------------------------------------------


def _ranked_events(user: User, anime_only: bool):
    """Every play this user has recorded, numbered per item, oldest first.

    The ranking is deliberately unfiltered by time: a play is a rewatch because
    of what came before it in the user's history, not because of what happens
    to be inside the window on screen. The caller filters the *result* by
    window; ranking a pre-filtered set is the mistake this exists to avoid.

    `anime_only` is safe to apply here because it selects whole items, and the
    ranking partitions by item — dropping an item cannot renumber another one.

    Ties break on `id`, so a re-run cannot swap which of two plays stamped with
    the same instant counts as the first.
    """
    ranked = select(
        WatchEvent.watched_at.label("watched_at"),
        func.row_number()
        .over(
            partition_by=WatchEvent.media_item_id,
            order_by=(WatchEvent.watched_at, WatchEvent.id),
        )
        .label("rank"),
    )
    if anime_only:
        ranked = ranked.join(MediaItem, MediaItem.id == WatchEvent.media_item_id).where(
            MediaItem.is_anime.is_(True)
        )
    return ranked.where(WatchEvent.user_id == user.id).subquery()


async def _rewatch(
    db: DbSession,
    user: User,
    window: StatsRange,
    anime_only: bool,
    tz: tzinfo,
) -> RewatchStats:
    ranked = _ranked_events(user, anime_only)
    rows = (
        await db.execute(
            select(ranked.c.watched_at, ranked.c.rank).where(
                ranked.c.watched_at >= window.since,
                ranked.c.watched_at < window.until,
            )
        )
    ).all()

    firsts: Counter[str] = Counter()
    repeats: Counter[str] = Counter()
    for watched_at, rank in rows:
        label = _bucket(watched_at.astimezone(tz).date(), window.granularity)
        (firsts if rank == 1 else repeats)[label] += 1

    first_watches = sum(firsts.values())
    rewatches = sum(repeats.values())
    plays = first_watches + rewatches
    return RewatchStats(
        plays=plays,
        first_watches=first_watches,
        rewatches=rewatches,
        rewatch_ratio=round(rewatches / plays, 4) if plays else 0.0,
        by_bucket=[
            RewatchSplit(label=label, first=firsts.get(label, 0), rewatch=repeats.get(label, 0))
            for label in _bucket_labels(window, window.granularity)
        ],
        most_rewatched=await _most_rewatched(db, user, anime_only),
    )


async def _most_rewatched(db: DbSession, user: User, anime_only: bool) -> list[RewatchedItem]:
    """What this user comes back to, over their whole history.

    All-time on purpose, and not a `_ranked_events` consumer: "how often have I
    watched this" is a plain count per item, and grouping is cheaper than
    numbering every row only to throw the numbers away.
    """
    show = aliased(MediaItem)
    plays = func.count(WatchEvent.id)
    conditions = [WatchEvent.user_id == user.id]
    if anime_only:
        conditions.append(MediaItem.is_anime.is_(True))

    rows = (
        await db.execute(
            select(
                MediaItem,
                show.title,
                plays,
                func.min(WatchEvent.watched_at),
                func.max(WatchEvent.watched_at),
            )
            .select_from(WatchEvent)
            .join(MediaItem, MediaItem.id == WatchEvent.media_item_id)
            .outerjoin(show, show.id == MediaItem.show_id)
            .where(and_(*conditions))
            .group_by(MediaItem.id)
            .having(plays > 1)
            # Most-played first; the newest of a tie first, because a thing
            # watched five times last year is a better answer than a thing
            # watched five times in 2019.
            .order_by(plays.desc(), func.max(WatchEvent.watched_at).desc())
            .limit(REWATCH_RANKING_LIMIT)
        )
    ).all()

    return [
        RewatchedItem(
            media_item_id=item.id,
            title=item.title,
            show_title=show_title,
            year=item.year,
            media_type=item.media_type,
            # Never `item.poster_url` directly: Plex artwork is a bare path that
            # only the image proxy can turn into something a browser may fetch.
            poster_url=poster_for(item),
            plays=count,
            first_watched=first,
            last_watched=last,
        )
        for item, show_title, count, first, last in rows
    ]


# --- endpoints ------------------------------------------------------------


def _zone_for(user: User, tz: str | None) -> tuple[tzinfo, str]:
    """The zone in force, and the name to report it under.

    `?tz=` beats the stored preference, and an unloadable name falls back to
    UTC rather than 500ing — so the response has to say which zone it actually
    used, or a silent fallback looks like correct data in the wrong hours.
    """
    tz_name = tz or (user.preferences or {}).get("timezone")
    zone = resolve_timezone(tz_name)
    return zone, "UTC" if zone is UTC else str(tz_name)


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
    zone, resolved_name = _zone_for(user, tz)
    window = await _resolve_range(
        db, user, zone, resolved_name, preset, since, until, days, granularity
    )
    agg = await _aggregate(db, user, window, anime_only, zone)
    totals = _totals(agg)

    previous = previous_year = None
    if compare:
        # Two extra aggregations, which is why they are behind the flag: the
        # window before this one, and the same window a year ago. "Down on last
        # month" and "down on last December" are different questions and a
        # seasonal library answers them differently.
        previous = await _comparison(db, user, _preceding(window, zone), anime_only, zone, totals)
        previous_year = await _comparison(
            db, user, _same_window_last_year(window, zone), anime_only, zone, totals
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
        previous_year=previous_year,
        by_weekday=_profile(agg.by_weekday, agg.weekday_minutes, WEEKDAYS),
        by_hour=_profile(
            agg.by_hour, agg.hour_minutes, tuple(f"{hour:02d}" for hour in range(24))
        ),
        punch_card=_punch_card(agg.by_weekday_hour),
        rewatch=await _rewatch(db, user, window, anime_only, zone),
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


@router.get("/seasonality", response_model=SeasonalityOut)
async def seasonality(
    db: DbSession,
    user: CurrentUser,
    anime_only: bool = False,
    tz: str | None = None,
) -> SeasonalityOut:
    """The month-of-year profile — "do I watch more in winter?" — over all history.

    Separate from `GET /api/stats` because it is the one aggregation with no
    window to bound it: it reads every play the user has ever recorded. That is
    a few thousand rows on a real instance and cheap enough to ask for, but not
    cheap enough to attach to a page that reloads whenever a filter chip moves.

    Only two columns come back per row — the instant and the length — because
    nothing here needs to know *what* was watched. The months are bucketed from
    `watched_at.astimezone(tz)` like everything else; a January play at 00:30
    in Auckland is still December in UTC.
    """
    zone, resolved_name = _zone_for(user, tz)

    conditions = [WatchEvent.user_id == user.id]
    if anime_only:
        conditions.append(MediaItem.is_anime.is_(True))

    rows = (
        await db.execute(
            select(
                WatchEvent.watched_at,
                WatchEvent.duration_ms,
                MediaItem.media_type,
                MediaItem.runtime_minutes,
            )
            .join(MediaItem, MediaItem.id == WatchEvent.media_item_id)
            .where(and_(*conditions))
            .order_by(WatchEvent.watched_at)
        )
    ).all()

    month_plays: Counter[int] = Counter()
    month_minutes: Counter[int] = Counter()
    year_plays: Counter[int] = Counter()
    year_minutes: Counter[int] = Counter()
    year_months: Counter[tuple[int, int]] = Counter()
    total_minutes = 0

    for watched_at, duration_ms, media_type, runtime in rows:
        local = watched_at.astimezone(zone)
        minutes = _minutes(duration_ms, runtime, media_type)
        total_minutes += minutes
        month_plays[local.month] += 1
        month_minutes[local.month] += minutes
        year_plays[local.year] += 1
        year_minutes[local.year] += minutes
        year_months[(local.year, local.month)] += 1

    # Every year between the first play and the last, so a fallow year draws as
    # an empty column rather than vanishing and making the axis lie.
    span = range(min(year_plays), max(year_plays) + 1) if year_plays else range(0)
    years = [
        YearProfile(
            year=year,
            plays=year_plays[year],
            minutes=year_minutes[year],
            months=[year_months.get((year, month), 0) for month in range(1, 13)],
        )
        for year in span
    ]

    return SeasonalityOut(
        timezone=resolved_name,
        plays=len(rows),
        minutes=total_minutes,
        first_play=rows[0][0] if rows else None,
        last_play=rows[-1][0] if rows else None,
        months=_profile(month_plays, month_minutes, MONTHS, offset=1),
        years=years,
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
