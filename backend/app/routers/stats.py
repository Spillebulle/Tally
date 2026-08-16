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

**The page is browsable with the same filters as the grids.** `MediaFilters` is
declared here as a dependency, so "stats for horror films I rated 8 and up" is
the same parameter set that narrows `/api/media`, `/api/watchlist` and
`/api/history` — and a filter added there arrives here without a second
implementation to keep in step. Two adjustments are made on the parsed object,
both of them the ones `routers/history.py` makes: `default_types=False`, because
episodes are most of a watch history, and `personal="all"`, because home videos
are real hours.

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
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, func, select, union
from sqlalchemy.orm import aliased
from sqlalchemy.sql import Select

from ..deps import CurrentUser, DbSession
from ..media_filters import MediaFilters
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


# --- the browse filters ---------------------------------------------------


def _stats_filters(filters: MediaFilters, anime_only: bool) -> MediaFilters:
    """The shared browse filters, adjusted for a page that counts plays.

    Both adjustments are the ones `routers/history.py` makes, for the same
    reasons — the two endpoints describe watch history rather than a shelf, so
    they have to agree about what belongs in it:

    * **`personal="all"`, set unconditionally.** `MediaFilters` excludes home
      videos by default, which is right for a library grid and wrong for a
      count of hours actually watched: the play really happened, and CLAUDE.md
      is explicit that a row is never dropped for this. The dependency's own
      default cannot be overridden per-router without restating its whole
      signature, so it is set on the parsed object instead — which leaves
      `personal` a valid parameter here (a stale link must not 422) but an inert
      one.
    * **`anime_only=true` maps to `anime="only"`.** Deprecated, and kept because
      the shipped `Stats.tsx` still sends it; dropping it in the same change
      that migrates the frontend would leave neither half able to work alone.

    `default_types=False` is the third adjustment and lives in `_scope`, because
    it is an argument to `item_conditions` rather than a value on the object.
    """
    filters.personal = "all"
    if anime_only:
        filters.anime = "only"
    return filters


def _scope(stmt: Select, filters: MediaFilters, user: User) -> Select:
    """Join what the browse filters read, and apply them.

    `stmt` must already have `watch_events` as its leftmost FROM; this adds the
    `media_items` join every stats query wants anyway, plus the per-user
    `user_media_states` row when — and only when — a filter reads from it.

    Three things about this are load-bearing:

    * **`default_types=False`.** The shared default restricts the flat grids to
      movies and shows. Episodes are most of a watch history, so inheriting it
      would silently empty the page for anyone who mainly watches television.
    * **The state join cannot fan a play out into two rows.**
      `user_media_states` is uniquely constrained on `(user_id, media_item_id)`
      and the ON clause pins both, so it matches at most one row per event —
      which is what lets `count()` and `sum()` stay honest through it. It is an
      OUTER join because an item with no state row at all has still been
      watched, and `unwatched_condition` reads that null side on purpose.
    * **Every filter here is item-level.** Nothing in `MediaFilters` narrows
      individual `WatchEvent` rows; the only event-level predicates in this
      module are the window bounds and the user, and both are applied by the
      caller. `_ranked_events` depends on that distinction — see its docstring.
    """
    stmt = stmt.join(MediaItem, MediaItem.id == WatchEvent.media_item_id)
    if filters.needs_state_join():
        stmt = stmt.outerjoin(
            UserMediaState,
            and_(
                UserMediaState.media_item_id == MediaItem.id,
                UserMediaState.user_id == user.id,
            ),
        )
        if state := filters.state_conditions():
            stmt = stmt.where(and_(*state))
    if items := filters.item_conditions(default_types=False):
        stmt = stmt.where(and_(*items))
    return stmt


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
    filters: MediaFilters,
    tz: tzinfo,
) -> _Aggregate:
    # The only event-level predicates on the page: whose plays, and when. Held
    # apart from the filters because `_ratings_for_window` needs the same pair
    # and `_ranked_events` must *not* have them.
    conditions = [
        WatchEvent.user_id == user.id,
        WatchEvent.watched_at >= window.since,
        WatchEvent.watched_at < window.until,
    ]

    rows = (
        await db.execute(
            _scope(
                select(
                    WatchEvent.watched_at,
                    WatchEvent.duration_ms,
                    MediaItem.id,
                    MediaItem.media_type,
                    MediaItem.runtime_minutes,
                    MediaItem.genres,
                    MediaItem.is_anime,
                    MediaItem.show_id,
                ),
                filters,
                user,
            ).where(and_(*conditions))
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

    agg.ratings = await _ratings_for_window(db, user, filters, conditions)
    return agg


async def _ratings_for_window(
    db: DbSession, user: User, filters: MediaFilters, conditions: list
) -> list[float]:
    """Ratings on what was watched in this window.

    Scoping ratings by *when the rating was made* looks more natural and is
    not: `rating_updated_at` is stamped when a rating is first pulled from
    Plex, so a fresh install would file a decade of ratings under "this week".
    What was watched, on the other hand, is exactly what the rest of the page
    is already about — and it means the browse filters scope the ratings too,
    for free, off the same subject set.

    An episode's rating lives on its show, so the shows episodes belong to are
    part of the subject set; without them a television-heavy window would show
    an empty ratings chart.

    **The subject halves must never correlate to the outer query**, hence the
    explicit `correlate(None)`. A state filter makes both halves join
    `user_media_states`, and the outer query selects *from* that same table:
    the moment those two facts meet in a place SQLAlchemy auto-correlates,
    it drops the table from the inner FROM and silently turns a self-contained
    subquery into a correlated one — a different, wrong question that still
    returns plausible numbers. Today the union lands in a FROM clause, where
    nothing is auto-correlated, so this compiles to the same SQL either way.
    It is written down because flattening the union into a bare
    `.in_(watched)` — the obvious tidy-up — moves it into the WHERE clause,
    where it very much is.
    """
    watched = (
        _scope(select(WatchEvent.media_item_id.label("id")), filters, user)
        .where(and_(*conditions))
        .correlate(None)
    )
    parents = (
        _scope(select(MediaItem.show_id.label("id")).select_from(WatchEvent), filters, user)
        .where(and_(*conditions, MediaItem.show_id.is_not(None)))
        .correlate(None)
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
    filters: MediaFilters,
    tz: tzinfo,
    current: StatsTotals,
) -> StatsComparison:
    earlier_totals = _totals(await _aggregate(db, user, earlier, filters, tz))
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


def _ranked_events(user: User, filters: MediaFilters):
    """Every play this user has recorded, numbered per item, oldest first.

    The ranking is deliberately unfiltered by time: a play is a rewatch because
    of what came before it in the user's history, not because of what happens
    to be inside the window on screen. The caller filters the *result* by
    window; ranking a pre-filtered set is the mistake this exists to avoid.

    **The rule for what may go inside this subquery: a predicate may select
    whole items, never a subset of one item's plays.** The ranking partitions
    by `media_item_id`, so removing an item entirely removes a whole partition
    and cannot renumber another one. Remove *some* of an item's rows and every
    surviving row shifts down — a second viewing becomes rank 1 and is reported
    as a first watch, silently, with a plausible number in every tile beside it.

    Every filter in `MediaFilters` passes that test, including the ones that do
    not look like it at first:

    * **Item-level** — genre, studio, year, media type, anime, personal,
      content rating, director, network, on-Plex, runtime, community rating,
      release status, anime format. These read `media_items` (or a correlated
      EXISTS off it), one value per item.
    * **State-level** — your rating, watch status, favourites, notes, in
      progress, watch counts, and `watched_after`/`watched_before`. These read
      the joined `user_media_states` row, which is uniquely constrained on
      `(user_id, media_item_id)`: one row per item, and the join is pinned to
      this user, so the predicate's value is a property of the *item*, the same
      for all of that item's plays. The two to think twice about are
      `watched_after`/`watched_before` — they name a time and so read like
      event filters, but they compare `UserMediaState.last_watched_at`, the
      per-item rollup of when you last touched the title at all, not
      `WatchEvent.watched_at`. If they are ever redefined to mean "plays in
      this range", they must move outside this subquery.

    So anything added to `MediaFilters` later has to be checked against the same
    question, and anything that could filter individual `WatchEvent` rows —
    a source, a completed flag, a duration bound, another time window — belongs
    to the caller, applied to the *result* of this ranking.

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
    return _scope(ranked, filters, user).where(WatchEvent.user_id == user.id).subquery()


async def _rewatch(
    db: DbSession,
    user: User,
    window: StatsRange,
    filters: MediaFilters,
    tz: tzinfo,
) -> RewatchStats:
    ranked = _ranked_events(user, filters)
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
        most_rewatched=await _most_rewatched(db, user, filters),
    )


async def _most_rewatched(
    db: DbSession, user: User, filters: MediaFilters
) -> list[RewatchedItem]:
    """What this user comes back to, over their whole history.

    All-time on purpose, and not a `_ranked_events` consumer: "how often have I
    watched this" is a plain count per item, and grouping is cheaper than
    numbering every row only to throw the numbers away.

    `count(WatchEvent.id)` stays honest through the state join for the reason
    `routers/history.py` relies on as well: `(user_id, media_item_id)` is
    unique and the ON clause pins both, so at most one state row can match a
    play and nothing fans out.
    """
    show = aliased(MediaItem)
    plays = func.count(WatchEvent.id)

    rows = (
        await db.execute(
            _scope(
                select(
                    MediaItem,
                    show.title,
                    plays,
                    func.min(WatchEvent.watched_at),
                    func.max(WatchEvent.watched_at),
                ).select_from(WatchEvent),
                filters,
                user,
            )
            .outerjoin(show, show.id == MediaItem.show_id)
            .where(WatchEvent.user_id == user.id)
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
    filters: Annotated[MediaFilters, Depends()],
    preset: StatsPreset | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    days: int | None = Query(None, ge=1, le=3650),
    compare: bool = False,
    granularity: StatsGranularity = "day",
    # Deprecated: superseded by the shared `anime` tri-state, and kept because
    # the shipped `Stats.tsx` still sends it. See `_stats_filters`.
    anime_only: bool = False,
    tz: str | None = None,
) -> StatsOut:
    """Everything on the stats page, over one window, in one timezone.

    Narrowable by the whole shared browse filter set — `?genre=Horror` and
    `?min_rating=8` mean here exactly what they mean on `/api/media` — with the
    two deliberate differences `_stats_filters` and `_scope` document: episodes
    are included, and home videos count.

    `since`/`until` bound this page's window, `WatchEvent.watched_at`. They are
    *not* the shared `watched_after`/`watched_before`, which read
    `UserMediaState.last_watched_at` — the rollup of when you last touched the
    title at all. Both work, and they answer different questions.

    One combination is degenerate rather than broken: `unwatched=true` asks for
    plays of things this user has never played, and on real data returns
    nothing, because every play updates the rollup that filter reads. It is
    left functional rather than rejected, the same way History leaves it —
    a filter the UI simply does not offer here is not worth a 422 on a shared
    link — and it keeps `unwatched_condition`'s own meaning rather than a
    stats-only redefinition: a play whose `UserMediaState` row is missing
    entirely still counts, because a missing row *is* "never played".
    """
    filters = _stats_filters(filters, anime_only)
    zone, resolved_name = _zone_for(user, tz)
    window = await _resolve_range(
        db, user, zone, resolved_name, preset, since, until, days, granularity
    )
    agg = await _aggregate(db, user, window, filters, zone)
    totals = _totals(agg)

    previous = previous_year = None
    if compare:
        # Two extra aggregations, which is why they are behind the flag: the
        # window before this one, and the same window a year ago. "Down on last
        # month" and "down on last December" are different questions and a
        # seasonal library answers them differently.
        previous = await _comparison(db, user, _preceding(window, zone), filters, zone, totals)
        previous_year = await _comparison(
            db, user, _same_window_last_year(window, zone), filters, zone, totals
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
        rewatch=await _rewatch(db, user, window, filters, zone),
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
    filters: Annotated[MediaFilters, Depends()],
    # Deprecated alias for `anime=only`, exactly as on `GET /api/stats`.
    anime_only: bool = False,
    tz: str | None = None,
) -> SeasonalityOut:
    """The month-of-year profile — "do I watch more in winter?" — over all history.

    Separate from `GET /api/stats` because it is the one aggregation with no
    window to bound it: it reads every play the user has ever recorded. That is
    a few thousand rows on a real instance and cheap enough to ask for, but not
    cheap enough to attach to a page that reloads whenever a filter chip moves.

    Takes the same browse filters as `GET /api/stats`, so the two agree about
    what is being counted when a chip is set. `unwatched=true` is degenerate
    here for the same reason and returns an empty profile.

    Only four columns come back per row — the instant, the length and enough of
    the item to price it — because nothing here needs to know *what* was
    watched. The months are bucketed from `watched_at.astimezone(tz)` like
    everything else; a January play at 00:30 in Auckland is still December in
    UTC.
    """
    filters = _stats_filters(filters, anime_only)
    zone, resolved_name = _zone_for(user, tz)

    rows = (
        await db.execute(
            _scope(
                select(
                    WatchEvent.watched_at,
                    WatchEvent.duration_ms,
                    MediaItem.media_type,
                    MediaItem.runtime_minutes,
                ),
                filters,
                user,
            )
            .where(WatchEvent.user_id == user.id)
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
