"""The filter and sort surface shared by the media grid, watchlist and history.

Every page that browses `media_items` offers the same controls, so the query
building lives here once. Writing it twice is how the two drift: a filter added
to one page silently does nothing on the other.

`MediaFilters` is a FastAPI dependency — declaring it on an endpoint gives that
endpoint the whole documented query-parameter set. `sort` and `order` are
deliberately *not* part of it, because each page has its own valid sorts and its
own sensible default: the grid opens on recently added, the watchlist opens on
recently watchlisted, history opens on most recently played.

The conditions are also exposed as plain functions and methods, not only through
`apply_filters`, so a caller that is aggregating rather than paging a page — the
stats endpoints, which have no sort and no pagination — can reuse the *same*
definitions without inheriting the ordering machinery. Nothing under
`routers/stats.py` consumes them yet; that wiring is a separate change. Two of
these carry an obligation on the caller, and both are traps:

* anything in `state_conditions()` reads the joined `user_media_states` row, so
  the caller must join it (scoped to the user) whenever `needs_state_join()`
  says so, and
* nothing here joins anything on the caller's behalf. `item_conditions()` is
  self-contained precisely so it cannot go wrong — every clause that reaches
  outside `media_items` (director, on-Plex, a parent show's facets) is written
  as a correlated EXISTS rather than a join, which also means a title with two
  directors or two Plex mappings still comes back once.
"""
# No `from __future__ import annotations` here on purpose: FastAPI resolves this
# class's __init__ annotations at import time to build the query parameters, and
# stringised annotations leave it with unresolvable forward references.
from collections.abc import Callable
from datetime import datetime
from typing import Any, Literal

from fastapi import Query
from sqlalchemy import String, and_, cast, func, or_, select
from sqlalchemy.orm import aliased
from sqlalchemy.sql import Select

from .models import (
    CreditKind,
    MediaCredit,
    MediaItem,
    MediaType,
    Person,
    PlexMapping,
    UserMediaState,
    WatchStatus,
)

AnimeFilter = Literal["all", "only", "exclude"]
PersonalFilter = Literal["all", "only", "exclude"]
SortOrder = Literal["asc", "desc"]

# Sorts every browse page understands. The watchlist and history each add one of
# their own, injected through `apply_filters(sort_columns=...)`. They live here
# together so the three stay visibly siblings — a sort added to one page is
# meant to be an obvious omission from the others.
SortField = Literal["title", "year", "added", "watched", "rating", "release"]
WatchlistSortField = Literal[
    "watchlist_added", "title", "year", "added", "watched", "rating", "release"
]
# History has no "added" or "your rating" sort worth offering — every row there
# is a play — and `watched_at` is the event's own timestamp, not the rollup's
# `last_watched_at`. See `routers/history.py` for why those two never merge.
HistorySortField = Literal["watched_at", "title", "year", "release"]

# How much of a title counts as finished. Anything past it is history rather
# than "still watching", and both places that decide have to use this number:
# the Continue Watching shelf (`routers/library.continue_watching`) and the
# `in_progress` filter below. Two copies of it is two answers to one question.
NEARLY_FINISHED_PERCENT = 95

#: The parent show, for a facet that only the show carries. See `facet_source`.
facet_parent = aliased(MediaItem, name="facet_parent")


def like_escape(value: str) -> str:
    r"""Escape the three characters LIKE gives a meaning to.

    `%` and `_` are wildcards and `\` is the escape character itself, so a
    value carrying any of them matches more rows than it names. No real genre
    does — but every free-text filter added here inherits this pattern, and a
    `studio` or `q` containing `%` silently widening the grid is the kind of
    bug nobody reports because it looks like the data.

    Callers must pass ``escape="\\"`` to `ilike` for this to take effect.
    """
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def unwatched_condition():
    """"Never played by this user", for a query that LEFT JOINs `UserMediaState`.

    A row with no state at all has never been touched, so the null case is part
    of the answer and not an oversight. Shared so that anything else offering
    "unwatched" — the recommendations shelf, for one — cannot quietly disagree
    with the browse filter about what the word means.
    """
    return or_(UserMediaState.id.is_(None), UserMediaState.view_count == 0)


def in_progress_condition():
    """"Started and not finished", for a query that LEFT JOINs `UserMediaState`.

    The same definition the Continue Watching shelf uses, and deliberately the
    only one: some playback recorded, and not so close to the end that the item
    really belongs in history. `NEARLY_FINISHED_PERCENT` is the shared cut-off.

    A row with playback but no known duration cannot be measured against that
    cut-off, so it stays — `progress_percent` returns None there and the shelf
    reads that as 0%. Written as `progress * 100 < duration * 95` rather than a
    division so SQLite never divides by zero.

    What this does *not* borrow from the shelf is the On Deck staleness window
    or its movie/episode restriction. Those describe what belongs on that
    shelf, not what "in progress" means; a browse filter that silently dropped
    everything you paused four months ago would be lying about the library.
    """
    return and_(
        UserMediaState.progress_ms.is_not(None),
        UserMediaState.progress_ms > 0,
        or_(
            UserMediaState.duration_ms.is_(None),
            UserMediaState.duration_ms == 0,
            UserMediaState.progress_ms * 100
            < UserMediaState.duration_ms * NEARLY_FINISHED_PERCENT,
        ),
    )


def on_plex_condition(on_plex: bool):
    """"Is (or is not) held on some Plex server this account can see".

    A correlated EXISTS rather than a join: an item mapped on two servers must
    not come back twice, and a caller that is counting rather than paging would
    count it twice too. Module-level so a query with no ordering and no
    pagination — the stats aggregates — can apply the browse filter's own
    definition instead of writing a second one.
    """
    mapped = select(PlexMapping.id).where(PlexMapping.media_item_id == MediaItem.id)
    return mapped.exists() if on_plex else ~mapped.exists()


def facet_source(build: Callable[[Any], Any]):
    """Read a facet from the item, or from its show when the item has none.

    Genre, studio, content rating, network and release status are only ever
    populated for MOVIE and SHOW rows: enrichment is skipped for episodes by
    design (`media_repo`, and the note in CLAUDE.md), and Plex's own episode
    payload rarely carries them. So a facet filter applied to an episode row
    matched *nothing* — silently, because an empty result set looks like an
    honest answer. The episodes of a Crime series are Crime.

    `build` is called with the entity to read the column from, so the caller
    writes its predicate once and gets it applied to both:

        facet_source(lambda src: src.studio == "A24")

    The parent side is a correlated EXISTS on `MediaItem.show_id`, so this is
    safe to drop into any query that already has `MediaItem` in it — no join to
    remember, and no chance of a row coming back twice. Seasons inherit through
    the same column, since `show_id` is denormalised onto them as well.

    Exported under this name because the stats aggregates need the identical
    rule: "which genre was this episode" has to have one answer across the app.
    """
    from_parent = select(facet_parent.id).where(
        facet_parent.id == MediaItem.show_id, build(facet_parent)
    )
    return or_(build(MediaItem), from_parent.exists())


class MediaFilters:
    """Query parameters shared by `/api/media`, `/api/watchlist` and `/api/history`."""

    def __init__(
        self,
        q: str | None = None,
        media_type: MediaType | None = None,
        anime: AnimeFilter = "all",
        # Home videos are off by default. A phone recording played once through
        # Plex is not a title in the sense these pages mean, and it is the same
        # judgement `default_types` already makes about seasons and episodes:
        # kept out of the flat list, not deleted, and one parameter away.
        # `exclude` rather than a hidden hard-coded clause precisely so a
        # misclassified film is recoverable without a database change.
        personal: PersonalFilter = "exclude",
        watch_status: WatchStatus | None = None,
        genre: str | None = None,
        year: int | None = None,
        # The three facets a detail page links out on. Each is an exact match
        # on the value that page displayed, so the chip and the filter bar
        # describe the same set of rows.
        content_rating: str | None = None,
        studio: str | None = None,
        # By name, not by person id, so the URL says who — matching how `genre`
        # and `studio` read. Two directors sharing a name would widen the grid
        # slightly; an opaque id in every link is the worse trade.
        director: str | None = None,
        # Show-level facets. Like genre/studio/content rating these are only
        # populated for movies and shows, so they resolve through `facet_source`
        # and an episode answers with its series'.
        network: str | None = None,
        release_status: str | None = None,
        anime_format: str | None = None,
        unwatched: bool = False,
        favorites: bool = False,
        on_plex: bool | None = None,
        # Your own rating, on Plex's 0-10 scale. Both bounds are inclusive, so
        # min_rating=8 is "8 and up" and min=max=10 is "only tens". Every
        # min_/max_ pair below is inclusive for the same reason: a user typing
        # a bound means "and this one too".
        min_rating: float | None = Query(None, ge=0, le=10),
        max_rating: float | None = Query(None, ge=0, le=10),
        # A range, unlike the exact `year` a detail-page chip links out on.
        min_year: int | None = None,
        max_year: int | None = None,
        min_runtime: int | None = Query(None, ge=0),
        max_runtime: int | None = Query(None, ge=0),
        # The crowd's score, not yours — `min_rating` is yours. Same 0-10 scale.
        min_community: float | None = Query(None, ge=0, le=10),
        max_community: float | None = Query(None, ge=0, le=10),
        # When the row reached *your library* (`MediaItem.created_at`).
        added_after: datetime | None = None,
        added_before: datetime | None = None,
        # When you last played it (`UserMediaState.last_watched_at`). Named
        # after the question rather than `since`/`until`, which History already
        # uses for `WatchEvent.watched_at` — a different table answering a
        # different question. Never merge the two pairs.
        watched_after: datetime | None = None,
        watched_before: datetime | None = None,
        min_watch_count: int | None = Query(None, ge=0),
        max_watch_count: int | None = Query(None, ge=0),
        has_notes: bool = False,
        in_progress: bool = False,
    ) -> None:
        self.q = q
        self.media_type = media_type
        self.anime = anime
        self.personal = personal
        self.watch_status = watch_status
        self.genre = genre
        self.year = year
        self.content_rating = content_rating
        self.studio = studio
        self.director = director
        self.network = network
        self.release_status = release_status
        self.anime_format = anime_format
        self.unwatched = unwatched
        self.favorites = favorites
        self.on_plex = on_plex
        self.min_rating = min_rating
        self.max_rating = max_rating
        self.min_year = min_year
        self.max_year = max_year
        self.min_runtime = min_runtime
        self.max_runtime = max_runtime
        self.min_community = min_community
        self.max_community = max_community
        self.added_after = added_after
        self.added_before = added_before
        self.watched_after = watched_after
        self.watched_before = watched_before
        self.min_watch_count = min_watch_count
        self.max_watch_count = max_watch_count
        self.has_notes = has_notes
        self.in_progress = in_progress

    @property
    def rated(self) -> bool:
        return self.min_rating is not None or self.max_rating is not None

    def needs_state_join(self, sort: str = "") -> bool:
        """Whether the per-user state row has to be joined in.

        Every filter that reads `user_media_states` has to be listed here, and
        two of the sorts read from it as well. Miss one and the query names a
        table it never joined — which is a 500, not a wrong answer, so it shows
        up immediately, but only on the request that happens to use it.

        `sort` defaults to empty for a caller that has no ordering at all.
        """
        return bool(
            self.watch_status
            or self.unwatched
            or self.favorites
            or self.rated
            or self.watched_after is not None
            or self.watched_before is not None
            or self.min_watch_count is not None
            or self.max_watch_count is not None
            or self.has_notes
            or self.in_progress
            or sort in ("watched", "rating")
        )

    def item_conditions(self, *, default_types: bool = True) -> list:
        """Everything that can be decided without the per-user state row.

        Self-contained: correlated EXISTS clauses reach the parent show, the
        credits and the Plex mappings, so a caller can drop this list onto any
        query that has `MediaItem` in it — ordered or not, paged or not —
        without joining anything first.
        """
        conditions = []
        if self.media_type is not None:
            conditions.append(MediaItem.media_type == self.media_type)
        elif default_types:
            # Seasons and episodes are reached through a show, never listed flat.
            conditions.append(
                MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW])
            )

        if self.anime == "only":
            conditions.append(MediaItem.is_anime.is_(True))
        elif self.anime == "exclude":
            conditions.append(MediaItem.is_anime.is_(False))

        if self.personal == "only":
            conditions.append(MediaItem.is_personal_media.is_(True))
        elif self.personal == "exclude":
            conditions.append(MediaItem.is_personal_media.is_(False))

        if self.q:
            pattern = f"%{like_escape(self.q.strip())}%"
            conditions.append(
                or_(
                    MediaItem.title.ilike(pattern, escape="\\"),
                    MediaItem.original_title.ilike(pattern, escape="\\"),
                    MediaItem.sort_title.ilike(pattern, escape="\\"),
                )
            )
        if self.genre:
            # genres is a JSON array; a LIKE on its text form is the portable
            # filter for SQLite and is fast enough at self-hosted library sizes.
            pattern = f'%"{like_escape(self.genre)}"%'
            conditions.append(
                facet_source(
                    lambda src: cast(src.genres, String).ilike(pattern, escape="\\")
                )
            )
        # The item's *own* year, not its show's — unlike the facets above, an
        # episode has one and it is the year that episode aired. Resolving it
        # through the series would file a 2019 episode under 1989.
        if self.year:
            conditions.append(MediaItem.year == self.year)
        if self.min_year is not None:
            conditions.append(MediaItem.year >= self.min_year)
        if self.max_year is not None:
            conditions.append(MediaItem.year <= self.max_year)
        if self.min_runtime is not None:
            conditions.append(MediaItem.runtime_minutes >= self.min_runtime)
        if self.max_runtime is not None:
            conditions.append(MediaItem.runtime_minutes <= self.max_runtime)
        if self.min_community is not None:
            conditions.append(MediaItem.community_rating >= self.min_community)
        if self.max_community is not None:
            conditions.append(MediaItem.community_rating <= self.max_community)
        if self.added_after is not None:
            conditions.append(MediaItem.created_at >= self.added_after)
        if self.added_before is not None:
            conditions.append(MediaItem.created_at <= self.added_before)
        # `facet_source` calls its builder immediately, so closing over `self`
        # here is evaluated now, not later.
        if self.content_rating:
            conditions.append(
                facet_source(lambda src: src.content_rating == self.content_rating)
            )
        if self.studio:
            conditions.append(facet_source(lambda src: src.studio == self.studio))
        if self.network:
            conditions.append(facet_source(lambda src: src.network == self.network))
        if self.release_status:
            conditions.append(
                facet_source(lambda src: src.release_status == self.release_status)
            )
        if self.anime_format:
            conditions.append(
                facet_source(lambda src: src.anime_format == self.anime_format)
            )
        if self.on_plex is not None:
            conditions.append(on_plex_condition(self.on_plex))
        if self.director:
            # A correlated EXISTS rather than a join, for the same reason
            # `on_plex` uses one: a title with two directors must not come back
            # twice — and it would, on the pair of rows a join produces.
            directed = (
                select(MediaCredit.id)
                .join(Person, Person.id == MediaCredit.person_id)
                .where(
                    MediaCredit.media_item_id == MediaItem.id,
                    MediaCredit.kind == CreditKind.DIRECTOR,
                    Person.name == self.director,
                )
            )
            conditions.append(directed.exists())
        return conditions

    def state_conditions(self) -> list:
        """Filters that read from the joined `user_media_states` row.

        Every one of these is per-user, and the join that carries them is
        scoped to one `user_id` — so none of this can ever see another
        account's rating, notes or progress. Anything added here must be listed
        in `needs_state_join` too.
        """
        conditions = []
        if self.watch_status is not None:
            conditions.append(UserMediaState.status == self.watch_status)
        if self.unwatched:
            conditions.append(unwatched_condition())
        if self.in_progress:
            conditions.append(in_progress_condition())
        if self.favorites:
            conditions.append(UserMediaState.is_favorite.is_(True))
        if self.has_notes:
            # A row can hold an empty string once notes have been written and
            # cleared, and "" is not a note.
            conditions.append(
                and_(UserMediaState.notes.is_not(None), UserMediaState.notes != "")
            )
        if self.watched_after is not None:
            conditions.append(UserMediaState.last_watched_at >= self.watched_after)
        if self.watched_before is not None:
            conditions.append(UserMediaState.last_watched_at <= self.watched_before)
        # A row with no state at all has been played zero times, so read the
        # missing side of the LEFT JOIN as 0 rather than as NULL — otherwise
        # `max_watch_count=0` ("never played") would exclude exactly the rows
        # it is asking for.
        if self.min_watch_count is not None:
            conditions.append(
                func.coalesce(UserMediaState.view_count, 0) >= self.min_watch_count
            )
        if self.max_watch_count is not None:
            conditions.append(
                func.coalesce(UserMediaState.view_count, 0) <= self.max_watch_count
            )
        if self.min_rating is not None:
            conditions.append(UserMediaState.rating >= self.min_rating)
        if self.max_rating is not None:
            conditions.append(UserMediaState.rating <= self.max_rating)
        if self.rated:
            # The LEFT JOIN lets unrated rows through with a NULL rating, and
            # NULL comparisons are neither true nor false, so say it plainly.
            conditions.append(UserMediaState.rating.is_not(None))
        return conditions


def apply_filters(
    stmt: Select,
    count_stmt: Select,
    filters: MediaFilters,
    user_id: int,
    *,
    sort: str,
    order: SortOrder,
    sort_columns: dict | None = None,
    default_types: bool = True,
) -> tuple[Select, Select]:
    """Filter and order both the page query and its matching count query.

    `sort_columns` adds or overrides entries in the default map — the watchlist
    uses it for "added to watchlist", which is not a column on `media_items`.
    """
    conditions = filters.item_conditions(default_types=default_types)
    if conditions:
        stmt = stmt.where(and_(*conditions))
        count_stmt = count_stmt.where(and_(*conditions))

    needs_state = filters.needs_state_join(sort)
    if needs_state:
        join_on = and_(
            UserMediaState.media_item_id == MediaItem.id,
            UserMediaState.user_id == user_id,
        )
        # LEFT JOIN so "unwatched" can match rows with no state at all.
        stmt = stmt.outerjoin(UserMediaState, join_on)
        count_stmt = count_stmt.outerjoin(UserMediaState, join_on)

        extra = filters.state_conditions()
        if extra:
            stmt = stmt.where(and_(*extra))
            count_stmt = count_stmt.where(and_(*extra))

    # `watched` and `rating` read from the joined state row, and
    # `needs_state_join` returns True for exactly those two sorts — so the join
    # is always there when they are selected. There used to be an `else`
    # fallback on each (community rating, created_at) which read like a working
    # feature and could never run; worse, it promised the wrong thing, since a
    # user who sorts by "your rating" did not ask for the crowd's.
    columns = {
        "title": func.coalesce(MediaItem.sort_title, MediaItem.title),
        "year": MediaItem.year,
        "added": MediaItem.created_at,
        "release": MediaItem.first_aired,
        "watched": UserMediaState.last_watched_at,
        "rating": UserMediaState.rating,
        **(sort_columns or {}),
    }
    column = columns[sort]
    # `nulls_last()` in *both* directions. SQLite sorts NULL first ascending, so
    # `?sort=year&order=asc` used to open on every year-less row — and a thin
    # history row legitimately has no year, no first_aired and no rating, so
    # this was the top of the page on real data. A row that cannot answer the
    # question belongs at the end of the answer either way.
    ordered = column.desc().nulls_last() if order == "desc" else column.asc().nulls_last()
    return stmt.order_by(ordered), count_stmt
