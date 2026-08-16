"""The filter and sort surface shared by the media grid and the watchlist.

Both pages browse the same rows and offer the same controls, so the query
building lives here once. Writing it twice is how the two drift: a filter added
to one page silently does nothing on the other.

`MediaFilters` is a FastAPI dependency — declaring it on an endpoint gives that
endpoint the whole documented query-parameter set. `sort` and `order` are
deliberately *not* part of it, because each page has its own valid sorts and its
own sensible default: the grid opens on recently added, the watchlist opens on
recently watchlisted.
"""
# No `from __future__ import annotations` here on purpose: FastAPI resolves this
# class's __init__ annotations at import time to build the query parameters, and
# stringised annotations leave it with unresolvable forward references.
from typing import Literal

from fastapi import Query
from sqlalchemy import String, and_, cast, func, or_, select
from sqlalchemy.sql import Select

from .models import MediaItem, MediaType, PlexMapping, UserMediaState, WatchStatus

AnimeFilter = Literal["all", "only", "exclude"]
PersonalFilter = Literal["all", "only", "exclude"]
SortOrder = Literal["asc", "desc"]

# Sorts every browse page understands. The watchlist adds one of its own.
SortField = Literal["title", "year", "added", "watched", "rating", "release"]
WatchlistSortField = Literal[
    "watchlist_added", "title", "year", "added", "watched", "rating", "release"
]


def unwatched_condition():
    """"Never played by this user", for a query that LEFT JOINs `UserMediaState`.

    A row with no state at all has never been touched, so the null case is part
    of the answer and not an oversight. Shared so that anything else offering
    "unwatched" — the recommendations shelf, for one — cannot quietly disagree
    with the browse filter about what the word means.
    """
    return or_(UserMediaState.id.is_(None), UserMediaState.view_count == 0)


class MediaFilters:
    """Query parameters shared by `/api/media` and `/api/watchlist`."""

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
        unwatched: bool = False,
        favorites: bool = False,
        on_plex: bool | None = None,
        # Your own rating, on Plex's 0-10 scale. Both bounds are inclusive, so
        # min_rating=8 is "8 and up" and min=max=10 is "only tens".
        min_rating: float | None = Query(None, ge=0, le=10),
        max_rating: float | None = Query(None, ge=0, le=10),
    ) -> None:
        self.q = q
        self.media_type = media_type
        self.anime = anime
        self.personal = personal
        self.watch_status = watch_status
        self.genre = genre
        self.year = year
        self.unwatched = unwatched
        self.favorites = favorites
        self.on_plex = on_plex
        self.min_rating = min_rating
        self.max_rating = max_rating

    @property
    def rated(self) -> bool:
        return self.min_rating is not None or self.max_rating is not None

    def needs_state_join(self, sort: str) -> bool:
        """Whether the per-user state row has to be joined in.

        Both the state filters and two of the sorts read from it.
        """
        return bool(
            self.watch_status
            or self.unwatched
            or self.favorites
            or self.rated
            or sort in ("watched", "rating")
        )

    def item_conditions(self, *, default_types: bool = True) -> list:
        """Filters that read only from `media_items`."""
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
            pattern = f"%{self.q.strip()}%"
            conditions.append(
                or_(
                    MediaItem.title.ilike(pattern),
                    MediaItem.original_title.ilike(pattern),
                    MediaItem.sort_title.ilike(pattern),
                )
            )
        if self.genre:
            # genres is a JSON array; a LIKE on its text form is the portable
            # filter for SQLite and is fast enough at self-hosted library sizes.
            conditions.append(cast(MediaItem.genres, String).ilike(f'%"{self.genre}"%'))
        if self.year:
            conditions.append(MediaItem.year == self.year)
        return conditions

    def state_conditions(self) -> list:
        """Filters that read from the joined `user_media_states` row."""
        conditions = []
        if self.watch_status is not None:
            conditions.append(UserMediaState.status == self.watch_status)
        if self.unwatched:
            conditions.append(unwatched_condition())
        if self.favorites:
            conditions.append(UserMediaState.is_favorite.is_(True))
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

    if filters.on_plex is not None:
        # A correlated EXISTS rather than a join: an item mapped on two servers
        # must not come back twice.
        mapped = select(PlexMapping.id).where(PlexMapping.media_item_id == MediaItem.id)
        clause = mapped.exists() if filters.on_plex else ~mapped.exists()
        stmt = stmt.where(clause)
        count_stmt = count_stmt.where(clause)

    columns = {
        "title": func.coalesce(MediaItem.sort_title, MediaItem.title),
        "year": MediaItem.year,
        "added": MediaItem.created_at,
        "release": MediaItem.first_aired,
        "watched": UserMediaState.last_watched_at if needs_state else MediaItem.created_at,
        "rating": UserMediaState.rating if needs_state else MediaItem.community_rating,
        **(sort_columns or {}),
    }
    column = columns[sort]
    return (
        stmt.order_by(column.desc().nulls_last() if order == "desc" else column.asc()),
        count_stmt,
    )
