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

**What is on `GET /api/stats` and what is not.** The default response is what a
page needs to draw its first screen, and it is already four aggregations; a
filter chip reloads all of it. Everything else is its own endpoint, on one of
two grounds, and `/api/stats/seasonality` was the first of them:

* **It has no window.** `/shows` (completion and drop-off) and `/coverage`
  (owned versus watched) answer questions about a library rather than about a
  fortnight. Accepting a window and applying it to half the numbers is exactly
  the failure the paragraph above describes; accepting it and ignoring it is
  worse. So they take none, and say `scope: "all_time"` in the payload.
* **It is a section nobody has scrolled to yet.** `/rankings` is nine lists and
  `/ratings` is four cross-tabulations and two rankings. Both share this page's
  window and filters exactly, and both can arrive after the tiles above them.

`sessions` is the one addition that stayed on the default response, because it
costs one query over rows the page is already about and the shape of an evening
is not separable from the count of plays in it.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta, tzinfo
from statistics import median
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, func, or_, select, union
from sqlalchemy.orm import aliased
from sqlalchemy.sql import Select

from ..deps import CurrentUser, DbSession
from ..media_filters import MediaFilters, facet_parent, on_plex_condition
from ..models import (
    MediaItem,
    MediaType,
    User,
    UserMediaState,
    WatchEvent,
    WatchlistEntry,
    WatchSource,
    WatchStatus,
    utcnow,
)
from ..schemas import (
    ContrarianItem,
    CoverageOut,
    CoverageSlice,
    PunchCard,
    RankedFacet,
    RankedTitle,
    RankingsOut,
    RatingDepthOut,
    RatingSlice,
    RewatchedItem,
    RewatchSplit,
    RewatchStats,
    SeasonalityOut,
    SessionStats,
    ShowCompletionOut,
    ShowProgress,
    StatCount,
    StatsComparison,
    StatsGranularity,
    StatsOut,
    StatsPreset,
    StatsRange,
    StatsTotals,
    TimeBucket,
    WatchlistConversionOut,
    WatchlistWaiting,
    WatchSession,
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

# What separates one sitting from the next. There is no start time recorded
# anywhere — Plex stamps `viewedAt` at the scrobble, around 90% of the way
# through playback — so the gap between two scrobbles is the only evidence a
# sitting ended. Consecutive episodes of a 45-minute drama land about 45
# minutes apart and back-to-back hour-long episodes about an hour apart; 90
# minutes sits above both and below any believable "picked it up again later".
#
# The cost is deliberate and visible: a double feature of two long films reads
# as two sittings, because two scrobbles two hours apart cannot be told from an
# evening film and a late-night one. Subtracting each play's own runtime to
# estimate idle time would fix that and break the common case, where
# `duration_ms` is missing and the fallback runtime is a flat 24 or 110
# minutes. The threshold is reported in the payload precisely because it is a
# judgement rather than a fact.
SESSION_GAP_MINUTES = 90

# The plays-per-sitting histogram's last bucket is open-ended; everything at or
# above this lands in it.
SESSION_SIZE_BUCKETS = 6

# When a show counts as abandoned rather than merely paused: less than this
# much of it watched, and untouched for this long. A judgement, echoed in the
# response so the UI can state it. An explicit `DROPPED` status always wins,
# and a show with no known episode count is never judged on a percentage it
# does not have.
ABANDONED_UNDER_PERCENT = 80.0
ABANDONED_AFTER_DAYS = 180

# How many rows each list-shaped block returns. Lists to read, not datasets.
SHOW_LIST_LIMIT = 12
WATCHLIST_WAITING_LIMIT = 12
CONTRARIAN_LIMIT = 10
COVERAGE_GENRE_LIMIT = 20
RATING_SLICE_LIMIT = 12
DEFAULT_RANKING_LIMIT = 12

# How long a watchlist entry may sit unplayed before it counts as the tail.
WATCHLIST_TAIL_DAYS = 90

# Runtime buckets for the ratings breakdown: label, lower bound inclusive,
# upper bound exclusive. Sized around what films actually are — the interesting
# question is whether you are kinder to a 95-minute film than to a three-hour
# one, and a uniform grid would put every film in one bar.
RUNTIME_BUCKETS: tuple[tuple[str, int, int | None], ...] = (
    ("Under 60 min", 0, 60),
    ("60-89 min", 60, 90),
    ("90-119 min", 90, 120),
    ("120-149 min", 120, 150),
    ("150 min and over", 150, None),
)

# `WatchSource` is an implementation detail of how a play reached Tally; these
# are what it is called on screen.
SOURCE_LABELS = {
    WatchSource.PLEX_HISTORY: "Plex history",
    WatchSource.PLEX_WEBHOOK: "Plex webhook",
    WatchSource.PLEX_SESSION: "Plex session",
    WatchSource.MANUAL: "Manual",
    WatchSource.IMPORT: "Import",
}


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
    earliest: datetime | None = None,
) -> StatsRange:
    """Turn whichever of the three ways to ask into one concrete window.

    `earliest` is what `preset="all"` should reach back to. It defaults to the
    user's first *play*, which is right for every block that counts plays and
    wrong for the watchlist, whose subject is when an entry was added — a user
    with no history at all would otherwise get "all" resolving to today and see
    none of their own watchlist.
    """
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
        if earliest is None:
            earliest = await db.scalar(
                select(func.min(WatchEvent.watched_at)).where(
                    WatchEvent.user_id == user.id
                )
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
    return _scope_items(
        stmt.join(MediaItem, MediaItem.id == WatchEvent.media_item_id), filters, user
    )


def _scope_items(
    stmt: Select, filters: MediaFilters, user: User, *, default_types: bool = False
) -> Select:
    """Apply the browse filters to a query whose subject is already `MediaItem`.

    `_scope` is the one to reach for: nearly everything here counts plays, and
    it adds the `watch_events` → `media_items` join before delegating to this.
    But three blocks have a different subject and no `watch_events` to join
    from — the watchlist conversion counts *entries*, and library coverage
    counts *titles* — so the filter application itself lives here, once, and
    both entry points share it. Two copies of "how the browse filters are
    applied" is how the pages come to disagree.

    The caller owns the FROM. All this adds is the per-user `user_media_states`
    outer join when a filter reads it, and the conditions themselves.

    `default_types` is False for anything counting plays — episodes are most of
    a watch history — and True for the library inventory, where the shared
    "movies and shows only" default is exactly right. See `CoverageOut`.
    """
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
    if items := filters.item_conditions(default_types=default_types):
        stmt = stmt.where(and_(*items))
    return stmt


def _facet(column: str):
    """Read a facet off the item, falling back to its show. A value, not a test.

    `media_filters.facet_source` is the same rule in predicate form — "does
    this item, or its series, have studio X" — and this is the reading half:
    "which studio was this play". Genre, studio, network and content rating are
    only ever populated for MOVIE and SHOW rows, because enrichment skips
    episodes by design, so a ranking that read them straight off the played row
    would file every episode under "no studio" and quietly leave television out
    of the leaderboard entirely.

    It is a correlated scalar subquery on `MediaItem.show_id`, deliberately the
    same shape and the same correlation as `facet_source`'s EXISTS: no join to
    remember, and no chance of a row coming back twice. **The two are one rule
    and must move together** — if `facet_source` ever resolves through
    something other than `show_id`, this has to follow, or a filtered ranking
    would narrow on one definition and group on another.

    `year` is not here on purpose. An episode has its own air date, and reading
    it through the series would file a 2019 episode under 1989.
    """
    return func.coalesce(
        getattr(MediaItem, column),
        select(getattr(facet_parent, column))
        .where(facet_parent.id == MediaItem.show_id)
        .scalar_subquery(),
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


def _watched_subjects(user: User, filters: MediaFilters, conditions: list):
    """What this window watched, plus the shows its episodes belong to.

    The subject set every rating question is asked over. Split out of
    `_ratings_for_window` so `/api/stats/ratings` asks about exactly the same
    titles the `average_rating` tile on the main page does — two definitions of
    "the ratings on this window" would be two answers to one question, side by
    side on the same screen.

    See `_ratings_for_window` for why `correlate(None)` is load-bearing.
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
    return union(watched, parents).subquery()


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
    subjects = _watched_subjects(user, filters, conditions)

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


# --- sittings and binges --------------------------------------------------


async def _sessions(
    db: DbSession,
    user: User,
    window: StatsRange,
    filters: MediaFilters,
    tz: tzinfo,
) -> SessionStats:
    """Split the window's plays into sittings, wherever the gap is long enough.

    Pure Python over rows already ordered by the index
    `ix_watch_events_user_time` covers. SQL could do this with a window
    function and a running sum, and would be harder to read for no gain: the
    window is bounded, the endpoint already walks every row in it once, and the
    threshold is a judgement that belongs somewhere a person can see it.

    One extra query rather than reusing `_aggregate`'s rows, because sittings
    need two columns the totals do not — the title, and the series title — and
    `_aggregate` runs three times when `compare=true`. Sittings are computed
    for the current window only.
    """
    show = aliased(MediaItem, name="session_show")
    rows = (
        await db.execute(
            _scope(
                select(
                    WatchEvent.watched_at,
                    WatchEvent.duration_ms,
                    MediaItem.media_type,
                    MediaItem.runtime_minutes,
                    MediaItem.title,
                    show.title,
                ).select_from(WatchEvent),
                filters,
                user,
            )
            .outerjoin(show, show.id == MediaItem.show_id)
            .where(
                WatchEvent.user_id == user.id,
                WatchEvent.watched_at >= window.since,
                WatchEvent.watched_at < window.until,
            )
            # Ties break on id so a re-run cannot reshuffle two plays stamped
            # at the same instant into different sittings.
            .order_by(WatchEvent.watched_at, WatchEvent.id)
        )
    ).all()

    gap = timedelta(minutes=SESSION_GAP_MINUTES)
    sittings: list[dict] = []
    for watched_at, duration_ms, media_type, runtime, title, show_title in rows:
        # A gap *equal* to the threshold is still one sitting; only a longer
        # one splits. Written as `>` rather than `>=` so the boundary belongs
        # to exactly one side of the answer.
        if not sittings or watched_at - sittings[-1]["ended_at"] > gap:
            sittings.append(
                {
                    "started_at": watched_at,
                    "ended_at": watched_at,
                    "plays": 0,
                    "minutes": 0,
                    "title": title,
                    "shows": set(),
                }
            )
        current = sittings[-1]
        current["ended_at"] = watched_at
        current["plays"] += 1
        current["minutes"] += _minutes(duration_ms, runtime, media_type)
        current["shows"].add(show_title)

    def _as_session(sitting: dict) -> WatchSession:
        shows = sitting["shows"]
        return WatchSession(
            started_at=sitting["started_at"],
            ended_at=sitting["ended_at"],
            day=sitting["started_at"].astimezone(tz).date(),
            plays=sitting["plays"],
            minutes=sitting["minutes"],
            title=sitting["title"],
            # One series and nothing else in the sitting: that is a binge and
            # can be labelled as one. A mixed evening gets no series name
            # rather than the first one that happened to be in it.
            show_title=next(iter(shows)) if len(shows) == 1 else None,
        )

    sizes: Counter[int] = Counter(
        min(sitting["plays"], SESSION_SIZE_BUCKETS) for sitting in sittings
    )
    by_size = [
        StatCount(
            label=f"{size}+" if size == SESSION_SIZE_BUCKETS else str(size),
            value=sizes.get(size, 0),
        )
        for size in range(1, SESSION_SIZE_BUCKETS + 1)
    ]

    plays = sum(sitting["plays"] for sitting in sittings)
    minutes = sum(sitting["minutes"] for sitting in sittings)
    return SessionStats(
        gap_minutes=SESSION_GAP_MINUTES,
        sessions=len(sittings),
        plays=plays,
        average_plays=round(plays / len(sittings), 2) if sittings else 0.0,
        average_minutes=round(minutes / len(sittings), 1) if sittings else 0.0,
        longest=_as_session(max(sittings, key=lambda s: s["minutes"])) if sittings else None,
        biggest_binge=(
            _as_session(max(sittings, key=lambda s: s["plays"])) if sittings else None
        ),
        by_size=by_size,
    )


# --- show completion and drop-off -----------------------------------------


async def _show_completion(
    db: DbSession, user: User, filters: MediaFilters
) -> ShowCompletionOut:
    """How far through each show, and which ones were walked away from.

    Two queries and no per-show round trip. The first groups every episode play
    by its series; the second picks the most recently played episode of each
    series with one window function, rather than the pair of lookups
    `serializers.episode_progress` would cost per show — twenty shows is forty
    round trips that way, which is the whole reason it is not used here.

    The show's own status is read through a second, aliased
    `user_media_states` join rather than a bulk `IN` lookup: it is unique on
    `(user_id, media_item_id)` and pinned to this user, so it cannot fan a
    group out, and it costs nothing beyond the query already being run.

    Only EPISODE plays count towards completion. A play recorded against the
    show row itself carries no episode number and would inflate a percentage
    it cannot locate.
    """
    show = aliased(MediaItem, name="completion_show")
    show_state = aliased(UserMediaState, name="completion_show_state")
    # Distinct episodes, not plays: rewatching the pilot four times is not 4%
    # of a series.
    episodes = func.count(func.distinct(WatchEvent.media_item_id))
    last = func.max(WatchEvent.watched_at)

    rows = (
        await db.execute(
            _scope(
                select(show, show_state.status, episodes, last).select_from(WatchEvent),
                filters,
                user,
            )
            .join(show, show.id == MediaItem.show_id)
            .outerjoin(
                show_state,
                and_(
                    show_state.media_item_id == show.id,
                    show_state.user_id == user.id,
                ),
            )
            .where(
                WatchEvent.user_id == user.id,
                MediaItem.media_type == MediaType.EPISODE,
            )
            # `status` is functionally dependent on the show, so grouping by it
            # adds no rows — it is named only so the statement is legal
            # anywhere, not just under SQLite's tolerance for bare columns.
            .group_by(show.id, show_state.status)
            .order_by(last.desc())
        )
    ).all()

    stopped = (
        _scope(
            select(
                MediaItem.show_id.label("show_id"),
                MediaItem.season_number.label("season_number"),
                MediaItem.episode_number.label("episode_number"),
                MediaItem.title.label("episode_title"),
                func.row_number()
                .over(
                    partition_by=MediaItem.show_id,
                    order_by=(WatchEvent.watched_at.desc(), WatchEvent.id.desc()),
                )
                .label("rank"),
            # Every column here reads `media_items`, so the leftmost FROM has
            # to be named explicitly or `_scope`'s join has nothing to hang
            # off — the ranking's ORDER BY is inside `over()` and does not put
            # `watch_events` in the FROM by itself.
            ).select_from(WatchEvent),
            filters,
            user,
        )
        .where(WatchEvent.user_id == user.id, MediaItem.media_type == MediaType.EPISODE)
        .subquery()
    )
    stops = {
        row.show_id: row
        for row in (await db.execute(select(stopped).where(stopped.c.rank == 1))).all()
    }

    stale_before = utcnow() - timedelta(days=ABANDONED_AFTER_DAYS)
    in_progress: list[ShowProgress] = []
    abandoned: list[ShowProgress] = []
    completed = unknown_total = 0

    for item, status_value, watched, last_watched in rows:
        total = item.leaf_count
        # `leaf_count` and nothing else. See `ShowProgress` for why counting the
        # episode rows Tally holds would report every history-only show at 100%.
        # A total smaller than what has demonstrably been watched is not a
        # total, so it answers "unknown" rather than a clamped 100% — which
        # would file the show under "completed" and hide the fact that the
        # number is wrong.
        stale_total = bool(total) and watched > total
        percent = None if not total or stale_total else round(watched / total * 100, 1)

        stop = stops.get(item.id)
        progress = ShowProgress(
            media_item_id=item.id,
            title=item.title,
            year=item.year,
            poster_url=poster_for(item),
            status=status_value,
            episodes_watched=watched,
            episodes_total=total or None,
            percent_complete=percent,
            total_is_stale=stale_total,
            last_watched_at=last_watched,
            last_season=stop.season_number if stop else None,
            last_episode=stop.episode_number if stop else None,
            last_episode_title=stop.episode_title if stop else None,
        )

        if status_value == WatchStatus.COMPLETED or (percent is not None and percent >= 100):
            completed += 1
            continue
        if percent is None:
            unknown_total += 1
        # An explicit "dropped" is the user saying so and needs no threshold.
        # The inferred half needs a percentage, which is exactly why a show
        # with no known episode count can never land here by accident.
        progress.abandoned = status_value == WatchStatus.DROPPED or (
            percent is not None
            and percent < ABANDONED_UNDER_PERCENT
            and last_watched < stale_before
        )
        (abandoned if progress.abandoned else in_progress).append(progress)

    return ShowCompletionOut(
        abandoned_under_percent=ABANDONED_UNDER_PERCENT,
        abandoned_after_days=ABANDONED_AFTER_DAYS,
        shows_started=len(rows),
        shows_completed=completed,
        shows_in_progress=len(in_progress),
        shows_abandoned=len(abandoned),
        shows_unknown_total=unknown_total,
        in_progress=in_progress[:SHOW_LIST_LIMIT],
        abandoned=abandoned[:SHOW_LIST_LIMIT],
    )


# --- watchlist conversion -------------------------------------------------


def _first_play_after(user: User, alias_name: str, *, after_add: bool):
    """When this watchlist entry was first played, as a correlated subquery.

    A watchlisted *show* is never played directly — its history is episode
    plays against episode rows — so this matches the entry's own item **or**
    anything whose `show_id` points at it. That is the same "a series answers
    for its episodes" relationship `_facet` and `media_filters.facet_source`
    read in the other direction.

    `after_add` is the difference between two questions the block asks
    separately: a play at or after `added_at` is a conversion, while *any* play
    ever is what stops a removal counting as churn.
    """
    played = aliased(MediaItem, name=alias_name)
    stmt = (
        select(func.min(WatchEvent.watched_at))
        .select_from(WatchEvent)
        .join(played, played.id == WatchEvent.media_item_id)
        .where(
            WatchEvent.user_id == user.id,
            or_(
                played.id == WatchlistEntry.media_item_id,
                played.show_id == WatchlistEntry.media_item_id,
            ),
        )
    )
    if after_add:
        stmt = stmt.where(WatchEvent.watched_at >= WatchlistEntry.added_at)
    return stmt.correlate(WatchlistEntry).scalar_subquery()


async def _watchlist_conversion(
    db: DbSession, user: User, window: StatsRange, filters: MediaFilters
) -> WatchlistConversionOut:
    """Added-then-watched, and everything that did not happen.

    One query. Watchlists are small — hundreds of rows on a large instance —
    so the two correlated subqueries that price each entry are cheaper than any
    scheme for avoiding them, and both ride `ix_watch_events_user_item_time`.
    """
    rows = (
        await db.execute(
            _scope_items(
                select(
                    MediaItem,
                    WatchlistEntry.added_at,
                    WatchlistEntry.active,
                    _first_play_after(user, "converted_play", after_add=True),
                    _first_play_after(user, "any_play", after_add=False),
                )
                .select_from(WatchlistEntry)
                .join(MediaItem, MediaItem.id == WatchlistEntry.media_item_id),
                filters,
                user,
            ).where(
                WatchlistEntry.user_id == user.id,
                WatchlistEntry.added_at >= window.since,
                WatchlistEntry.added_at < window.until,
            )
        )
    ).all()

    now = utcnow()
    waits: list[float] = []
    converted = still_waiting = past_tail = churned = removed = 0
    waiting: list[WatchlistWaiting] = []

    for item, added_at, active, converted_at, ever_at in rows:
        if converted_at is not None:
            converted += 1
            waits.append(round((converted_at - added_at).total_seconds() / 86400, 2))
        if not active:
            removed += 1
            # "Removed without ever being watched" — `ever_at`, not
            # `converted_at`. Something removed after a play that predated the
            # add was tidied up, not given up on.
            if ever_at is None:
                churned += 1
        elif converted_at is None:
            still_waiting += 1
            days = (now - added_at).days
            if days >= WATCHLIST_TAIL_DAYS:
                past_tail += 1
            waiting.append(
                WatchlistWaiting(
                    media_item_id=item.id,
                    title=item.title,
                    year=item.year,
                    media_type=item.media_type,
                    poster_url=poster_for(item),
                    added_at=added_at,
                    days_waiting=days,
                )
            )

    waiting.sort(key=lambda entry: entry.added_at)
    return WatchlistConversionOut(
        range=window,
        tail_days=WATCHLIST_TAIL_DAYS,
        added=len(rows),
        converted=converted,
        conversion_rate=round(converted / len(rows), 4) if rows else 0.0,
        median_days_to_watch=round(median(waits), 2) if waits else None,
        still_waiting=still_waiting,
        waiting_past_tail=past_tail,
        churned=churned,
        removed=removed,
        waiting=waiting[:WATCHLIST_WAITING_LIMIT],
    )


# --- library coverage -----------------------------------------------------


def _decade_label(year: int) -> str:
    return f"{year // 10 * 10}s"


def _slice(counts: dict[str, list[int]], label: str) -> CoverageSlice:
    owned, watched = counts[label]
    return CoverageSlice(
        label=label,
        owned=owned,
        watched=watched,
        percent=round(watched / owned, 4) if owned else 0.0,
    )


async def _coverage(
    db: DbSession, user: User, filters: MediaFilters
) -> CoverageOut:
    """Owned versus watched, sliced by type, genre and decade.

    Both halves are correlated EXISTS clauses, and that is the point.
    "Owned" is `on_plex_condition(True)` — the browse filters' own definition,
    so the endpoint and the grid agree — and a title held on two servers is one
    row through it, where a join to `plex_mappings` would count it twice. The
    same shape answers "watched", reaching an item's episodes through
    `show_id` so a series counts as watched on any episode play.

    One query, one row per owned title. A large library is a few thousand of
    those and three narrow columns apiece; genres are a JSON array that no
    portable `GROUP BY` reaches, so the slicing is done in Python off the same
    pass rather than in three more statements.
    """
    played = aliased(MediaItem, name="coverage_played")
    watched_clause = (
        select(WatchEvent.id)
        .select_from(WatchEvent)
        .join(played, played.id == WatchEvent.media_item_id)
        .where(
            WatchEvent.user_id == user.id,
            or_(played.id == MediaItem.id, played.show_id == MediaItem.id),
        )
        .exists()
    )

    rows = (
        await db.execute(
            _scope_items(
                select(
                    MediaItem.media_type,
                    MediaItem.year,
                    MediaItem.genres,
                    watched_clause.label("watched"),
                ).select_from(MediaItem),
                filters,
                user,
                default_types=True,
            ).where(on_plex_condition(True))
        )
    ).all()

    def _empty() -> list[int]:
        return [0, 0]

    types: dict[str, list[int]] = {}
    genres: dict[str, list[int]] = {}
    decades: dict[str, list[int]] = {}
    owned = watched_total = 0

    for media_type, year, item_genres, watched in rows:
        owned += 1
        seen = 1 if watched else 0
        watched_total += seen
        label = "Movies" if media_type == MediaType.MOVIE else "Shows"
        types.setdefault(label, _empty())
        types[label][0] += 1
        types[label][1] += seen
        for genre in item_genres or []:
            genres.setdefault(genre, _empty())
            genres[genre][0] += 1
            genres[genre][1] += seen
        # A year-less row is in no decade. Counted in the totals, absent from
        # the decade slice — inventing an "Unknown" decade would put it on the
        # same axis as the real ones.
        if year:
            key = _decade_label(year)
            decades.setdefault(key, _empty())
            decades[key][0] += 1
            decades[key][1] += seen

    top_genres = sorted(genres, key=lambda name: (-genres[name][0], name))
    return CoverageOut(
        includes_personal=filters.personal != "exclude",
        owned=owned,
        watched=watched_total,
        unwatched=owned - watched_total,
        percent=round(watched_total / owned, 4) if owned else 0.0,
        by_type=[_slice(types, label) for label in sorted(types)],
        by_genre=[_slice(genres, name) for name in top_genres[:COVERAGE_GENRE_LIMIT]],
        by_decade=[_slice(decades, key) for key in sorted(decades)],
    )


# --- rating depth ---------------------------------------------------------


def _accumulate(
    buckets: dict[str, list[float]], label: str, rating: float, crowd: float | None
) -> None:
    """Add one rated title to a slice: count, rating sum, crowd sum, crowd count.

    The crowd is counted separately because most libraries hold titles with a
    rating of yours and no `community_rating` at all — dividing the crowd's sum
    by the slice's count would report an average dragged towards zero by every
    title that simply had nothing to compare.
    """
    bucket = buckets.setdefault(label, [0.0, 0.0, 0.0, 0.0])
    bucket[0] += 1
    bucket[1] += float(rating)
    if crowd is not None:
        bucket[2] += float(crowd)
        bucket[3] += 1


def _rating_slices(buckets: dict[str, list[float]], limit: int) -> list[RatingSlice]:
    """Turn `{label: [count, rating sum, community sum, community count]}` into rows."""
    ordered = sorted(buckets, key=lambda label: (-buckets[label][0], label))
    return [
        RatingSlice(
            label=label,
            count=int(buckets[label][0]),
            average=round(buckets[label][1] / buckets[label][0], 2),
            community_average=(
                round(buckets[label][2] / buckets[label][3], 2)
                if buckets[label][3]
                else None
            ),
        )
        for label in ordered[:limit]
    ]


def _runtime_bucket(runtime: int | None) -> str | None:
    if not runtime:
        return None
    for label, low, high in RUNTIME_BUCKETS:
        if runtime >= low and (high is None or runtime < high):
            return label
    return None


async def _rating_depth(
    db: DbSession, user: User, window: StatsRange, filters: MediaFilters
) -> RatingDepthOut:
    """Your ratings against the crowd's, and how they break down.

    The parent show is joined for its genres only, and only as a fallback:
    enrichment skips episodes, so a rated episode carries none of its own. That
    is `_facet`'s rule again, written as a join here because the subject set is
    already one row per item and `show_id` cannot match twice.
    """
    conditions = [
        WatchEvent.user_id == user.id,
        WatchEvent.watched_at >= window.since,
        WatchEvent.watched_at < window.until,
    ]
    subjects = _watched_subjects(user, filters, conditions)
    parent = aliased(MediaItem, name="rating_parent")

    rows = (
        await db.execute(
            select(MediaItem, UserMediaState.rating, parent.genres)
            .join(UserMediaState, UserMediaState.media_item_id == MediaItem.id)
            .outerjoin(parent, parent.id == MediaItem.show_id)
            .where(
                UserMediaState.user_id == user.id,
                UserMediaState.rating.is_not(None),
                MediaItem.id.in_(select(subjects.c.id)),
            )
        )
    ).all()

    def _empty() -> list[float]:
        return [0.0, 0.0, 0.0, 0.0]

    genres: dict[str, list[float]] = {}
    decades: dict[str, list[float]] = {}
    runtimes: dict[str, list[float]] = {}
    contrarian: list[ContrarianItem] = []
    ratings: list[float] = []
    community: list[float] = []
    differences: list[float] = []
    runtime_unknown = 0

    for item, rating, parent_genres in rows:
        ratings.append(float(rating))
        crowd = item.community_rating
        if crowd is not None:
            community.append(float(crowd))
            difference = round(float(rating) - float(crowd), 2)
            differences.append(difference)
            contrarian.append(
                ContrarianItem(
                    media_item_id=item.id,
                    title=item.title,
                    year=item.year,
                    media_type=item.media_type,
                    poster_url=poster_for(item),
                    rating=float(rating),
                    community_rating=float(crowd),
                    difference=difference,
                )
            )

        for genre in item.genres or parent_genres or []:
            _accumulate(genres, genre, rating, crowd)
        if item.year:
            _accumulate(decades, _decade_label(item.year), rating, crowd)
        bucket = _runtime_bucket(item.runtime_minutes)
        if bucket is None:
            runtime_unknown += 1
        else:
            _accumulate(runtimes, bucket, rating, crowd)

    contrarian.sort(key=lambda row: row.difference)
    comparable = len(differences)
    return RatingDepthOut(
        range=window,
        rated=len(rows),
        rated_with_community=comparable,
        average_rating=round(sum(ratings) / len(ratings), 2) if ratings else None,
        average_community=round(sum(community) / len(community), 2) if community else None,
        average_difference=(
            round(sum(differences) / comparable, 2) if comparable else None
        ),
        average_absolute_difference=(
            round(sum(abs(value) for value in differences) / comparable, 2)
            if comparable
            else None
        ),
        agreement_within_one=(
            round(sum(1 for value in differences if abs(value) <= 1) / comparable, 4)
            if comparable
            else None
        ),
        kinder_than_crowd=sum(1 for value in differences if value > 0),
        harsher_than_crowd=sum(1 for value in differences if value < 0),
        you_rate_higher=list(reversed(contrarian[-CONTRARIAN_LIMIT:])),
        you_rate_lower=contrarian[:CONTRARIAN_LIMIT],
        by_genre=_rating_slices(genres, RATING_SLICE_LIMIT),
        by_decade=_rating_slices(decades, RATING_SLICE_LIMIT),
        by_runtime=_rating_slices(runtimes, len(RUNTIME_BUCKETS)),
        runtime_unknown=runtime_unknown,
    )


# --- ranked lists ---------------------------------------------------------


async def _rankings(
    db: DbSession,
    user: User,
    window: StatsRange,
    filters: MediaFilters,
    limit: int,
) -> RankingsOut:
    """Nine leaderboards from one pass over the window's plays.

    Two queries in total. The first reads one narrow row per play — never an
    ORM entity, which at a few thousand plays would be a few thousand
    identity-map inserts for columns nobody reads — and every grouping is
    derived from that pass in Python. The second fetches the handful of
    `MediaItem` rows the capped lists actually name, in one batched `IN`: at
    most three lists of `limit` each, so the query is bounded by the page
    rather than by the library, and `poster_for` gets a real row to work from
    instead of a URL assembled by hand.

    Episodes are rolled up into their series by `coalesce(show_id, id)`, so
    "titles by total runtime" says *The Wire*, not "Episode 4" forty times.
    """
    rows = (
        await db.execute(
            _scope(
                select(
                    WatchEvent.duration_ms,
                    WatchEvent.source,
                    MediaItem.id,
                    MediaItem.media_type,
                    MediaItem.runtime_minutes,
                    MediaItem.show_id,
                    MediaItem.year,
                    _facet("studio"),
                    _facet("network"),
                    _facet("content_rating"),
                ).select_from(WatchEvent),
                filters,
                user,
            ).where(
                WatchEvent.user_id == user.id,
                WatchEvent.watched_at >= window.since,
                WatchEvent.watched_at < window.until,
            )
        )
    ).all()

    titles: dict[int, dict] = {}
    facets: dict[str, dict[str, dict]] = {
        "studio": {},
        "network": {},
        "decade": {},
        "content_rating": {},
        "source": {},
    }

    for (
        duration_ms,
        source,
        item_id,
        media_type,
        runtime,
        show_id,
        year,
        studio,
        network,
        content_rating,
    ) in rows:
        minutes = _minutes(duration_ms, runtime, media_type)
        # A season or episode answers under its series; a movie, and a play
        # recorded against a show row directly, answer as themselves.
        key = show_id or item_id
        entry = titles.setdefault(
            key,
            {
                "plays": 0,
                "minutes": 0,
                "episodes": set(),
                "movie": show_id is None and media_type == MediaType.MOVIE,
            },
        )
        entry["plays"] += 1
        entry["minutes"] += minutes
        if media_type == MediaType.EPISODE:
            entry["episodes"].add(item_id)

        for group, label in (
            ("studio", studio),
            ("network", network),
            ("content_rating", content_rating),
            ("decade", _decade_label(year) if year else None),
            ("source", SOURCE_LABELS.get(source, str(source))),
        ):
            if not label:
                continue
            bucket = facets[group].setdefault(
                label, {"plays": 0, "minutes": 0, "titles": set()}
            )
            bucket["plays"] += 1
            bucket["minutes"] += minutes
            bucket["titles"].add(key)

    def _ranked(keys: list[int], sort_key) -> list[int]:
        return sorted(keys, key=sort_key)[:limit]

    shows = [key for key, entry in titles.items() if not entry["movie"]]
    films = [key for key, entry in titles.items() if entry["movie"]]
    top_shows = _ranked(
        shows, lambda key: (-len(titles[key]["episodes"]), -titles[key]["minutes"], key)
    )
    top_films = _ranked(
        films, lambda key: (-titles[key]["plays"], -titles[key]["minutes"], key)
    )
    top_runtime = _ranked(
        list(titles), lambda key: (-titles[key]["minutes"], -titles[key]["plays"], key)
    )

    wanted = sorted({*top_shows, *top_films, *top_runtime})
    items = {
        item.id: item
        for item in (
            await db.execute(select(MediaItem).where(MediaItem.id.in_(wanted)))
        ).scalars()
    }

    def _title_rows(keys: list[int]) -> list[RankedTitle]:
        ranked = []
        for key in keys:
            item = items.get(key)
            if item is None:
                # The grouping key is a `show_id` whose show row has since been
                # deleted. The plays are real but there is nothing to name them
                # with, so the row is left out rather than titled "Unknown".
                continue
            entry = titles[key]
            episodes = len(entry["episodes"])
            ranked.append(
                RankedTitle(
                    media_item_id=item.id,
                    title=item.title,
                    year=item.year,
                    media_type=item.media_type,
                    poster_url=poster_for(item),
                    plays=entry["plays"],
                    minutes=entry["minutes"],
                    episodes=episodes or None,
                    episodes_total=item.leaf_count,
                )
            )
        return ranked

    def _facet_rows(group: str) -> list[RankedFacet]:
        bucket = facets[group]
        ordered = sorted(bucket, key=lambda label: (-bucket[label]["minutes"], label))
        return [
            RankedFacet(
                label=label,
                plays=bucket[label]["plays"],
                minutes=bucket[label]["minutes"],
                titles=len(bucket[label]["titles"]),
            )
            for label in ordered[:limit]
        ]

    return RankingsOut(
        range=window,
        limit=limit,
        top_shows=_title_rows(top_shows),
        top_films=_title_rows(top_films),
        top_by_runtime=_title_rows(top_runtime),
        studios=_facet_rows("studio"),
        networks=_facet_rows("network"),
        decades=_facet_rows("decade"),
        content_ratings=_facet_rows("content_rating"),
        by_source=_facet_rows("source"),
    )


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
        sessions=await _sessions(db, user, window, filters, zone),
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


@router.get("/shows", response_model=ShowCompletionOut)
async def show_completion(
    db: DbSession,
    user: CurrentUser,
    filters: Annotated[MediaFilters, Depends()],
    anime_only: bool = False,
) -> ShowCompletionOut:
    """How far through each show you are, and which ones you walked away from.

    Its own endpoint and **unwindowed**, for the reason `ShowCompletionOut`
    sets out: completion is a fact about a viewer and a series, and the
    abandoned half is invisible inside any window short enough to be useful.
    It therefore takes no `preset`/`since`/`until`/`days`, rather than
    accepting them and quietly applying them to half the numbers — which is the
    exact failure the module docstring opens with.

    No `tz` either. Nothing here is bucketed by day; staleness is a duration,
    and a duration is the same length in every zone.

    The shared browse filters do apply, so "how far through my anime am I" is
    one request.
    """
    filters = _stats_filters(filters, anime_only)
    return await _show_completion(db, user, filters)


@router.get("/watchlist", response_model=WatchlistConversionOut)
async def watchlist_conversion(
    db: DbSession,
    user: CurrentUser,
    filters: Annotated[MediaFilters, Depends()],
    preset: StatsPreset | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    days: int | None = Query(None, ge=1, le=3650),
    anime_only: bool = False,
    tz: str | None = None,
) -> WatchlistConversionOut:
    """Does watchlisting something mean you watch it?

    The window bounds `WatchlistEntry.added_at`, not `WatchEvent.watched_at` —
    which entries are being asked about. It is the only bound that makes the
    question answerable, and it is why this is not on `GET /api/stats`, where
    the window means something else on every other number.

    `preset=all` reaches back to the earliest watchlist add rather than to the
    earliest play, so somebody who watchlists and never watches still sees
    their own list.

    `granularity` is not taken: nothing here is a series.
    """
    filters = _stats_filters(filters, anime_only)
    zone, resolved_name = _zone_for(user, tz)
    earliest = await db.scalar(
        select(func.min(WatchlistEntry.added_at)).where(WatchlistEntry.user_id == user.id)
    )
    window = await _resolve_range(
        db, user, zone, resolved_name, preset, since, until, days, "day", earliest
    )
    return await _watchlist_conversion(db, user, window, filters)


def _inventory_filters(filters: MediaFilters, anime_only: bool) -> MediaFilters:
    """The browse filters for a question about the shelf rather than the viewing.

    The deliberate difference from `_stats_filters`: **`personal` is left
    alone.** Everywhere else on this page home videos count, because a play is
    a play and the hours are real. Coverage is an inventory — the same question
    `/api/stats/summary` answers — and a phone recording is not a title you
    have failed to get round to, so the shared `exclude` default is exactly
    right here and stays a live parameter rather than an inert one. Somebody
    who wants their home videos counted asks for `personal=all` and gets it.

    `default_types` is left alone too, in `_scope_items`: a season is not a
    title on the shelf either.
    """
    if anime_only:
        filters.anime = "only"
    return filters


@router.get("/coverage", response_model=CoverageOut)
async def coverage(
    db: DbSession,
    user: CurrentUser,
    filters: Annotated[MediaFilters, Depends()],
    anime_only: bool = False,
) -> CoverageOut:
    """What fraction of the library has actually been watched.

    Unwindowed and its own endpoint: "have I seen this" is not a question about
    a fortnight, and the query walks every owned title rather than every play,
    which is a different and much longer list on a large library.

    `on_plex` is redundant here — the endpoint is about what is on Plex and
    applies that condition itself — so setting it to `false` returns nothing,
    honestly rather than confusingly.
    """
    filters = _inventory_filters(filters, anime_only)
    return await _coverage(db, user, filters)


@router.get("/ratings", response_model=RatingDepthOut)
async def rating_depth(
    db: DbSession,
    user: CurrentUser,
    filters: Annotated[MediaFilters, Depends()],
    preset: StatsPreset | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    days: int | None = Query(None, ge=1, le=3650),
    anime_only: bool = False,
    tz: str | None = None,
) -> RatingDepthOut:
    """Your ratings against `MediaItem.community_rating`.

    Windowed, on exactly the subject set `StatsOut.average_rating` uses — what
    was watched, plus the shows whose episodes were — so the tile on the main
    page and the breakdown here can never disagree. Split out because it is
    four cross-tabulations and two rankings that most loads of the page will
    never draw.
    """
    filters = _stats_filters(filters, anime_only)
    zone, resolved_name = _zone_for(user, tz)
    window = await _resolve_range(
        db, user, zone, resolved_name, preset, since, until, days, "day"
    )
    return await _rating_depth(db, user, window, filters)


@router.get("/rankings", response_model=RankingsOut)
async def rankings(
    db: DbSession,
    user: CurrentUser,
    filters: Annotated[MediaFilters, Depends()],
    preset: StatsPreset | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    days: int | None = Query(None, ge=1, le=3650),
    limit: int = Query(DEFAULT_RANKING_LIMIT, ge=1, le=50),
    anime_only: bool = False,
    tz: str | None = None,
) -> RankingsOut:
    """The leaderboards: top shows, films, studios, networks, decades, sources.

    Nine lists, and the clearest candidate for its own endpoint of anything
    added here: they share a window with `GET /api/stats` and nothing else, a
    page can draw its tiles before they arrive, and `limit` is a knob only this
    block has any use for.
    """
    filters = _stats_filters(filters, anime_only)
    zone, resolved_name = _zone_for(user, tz)
    window = await _resolve_range(
        db, user, zone, resolved_name, preset, since, until, days, "day"
    )
    return await _rankings(db, user, window, filters, limit)


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
