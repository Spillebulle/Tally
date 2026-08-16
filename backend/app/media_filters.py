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
definitions without inheriting the ordering machinery. `routers/stats.py`
does exactly that, in its own `_scope`. Two of
these carry an obligation on the caller, and both are traps:

* anything in `state_conditions()` reads the joined `user_media_states` row, so
  the caller must join it (scoped to the user) whenever `needs_state_join()`
  says so, and
* nothing here joins anything on the caller's behalf. `item_conditions()` is
  self-contained precisely so it cannot go wrong — every clause that reaches
  outside `media_items` (credits, on-Plex, a library, a parent show's facets) is
  written as a correlated EXISTS rather than a join, which also means a title
  with two directors, forty actors or two Plex mappings still comes back once.

A join would not merely duplicate rows in the page: `apply_filters` puts the
same clauses on `count_stmt`, so the total would be inflated too and the pager
would offer pages that render empty.

Two things are worth knowing before adding to this:

* **Repeated keys, not commas.** The facets in `MULTI_FACETS` take
  `?genre=Crime&genre=Drama`, with `?genre_not=` for exclusion and
  `?genre_mode=all` for AND. A single occurrence parses exactly as the single
  value it always did, so nothing that already links here changes meaning.
* **A search that reaches your notes reaches per-user data.** `q_scope=all`
  therefore moves the whole `q` clause into `state_conditions()`, where the
  join has pinned `user_id`. See `searches_notes`.
"""
# No `from __future__ import annotations` here on purpose: FastAPI resolves this
# class's __init__ annotations at import time to build the query parameters, and
# stringised annotations leave it with unresolvable forward references.
from collections.abc import Callable
from datetime import datetime
from typing import Any, Literal

from fastapi import Query
from sqlalchemy import String, and_, case, cast, func, or_, select
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

#: How several values of one facet combine. "any" is the default and is the only
#: answer that can be right for a facet a row holds once — a title has one
#: studio, one certificate, one network, so `all` there is the empty set by
#: construction. Only `genre` offers the choice; see `MULTI_FACETS`.
MatchMode = Literal["any", "all"]

#: How far a free-text `q` reaches. `title` is the default on purpose: an
#: ordinary search should not start matching plot summaries, where a word like
#: "murder" is in half the library.
SearchScope = Literal["title", "all"]

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
#: The item *or* its show, for the negative case. See `facet_absent`.
facet_holder = aliased(MediaItem, name="facet_holder")

# Facets stored as a JSON array rather than a scalar, and therefore "absent"
# when empty rather than when NULL. See `facet_value`.
_LIST_FACETS = frozenset({"genres"})


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


def facet_value(column: str):
    """The same rule as `facet_source`, in value form rather than predicate form.

    `facet_source` answers "does this item, or its series, have studio X"; this
    answers "which studio was this play". The stats aggregates need the second
    to group by, and a ranking that read the column straight off the played row
    would file every episode under "no studio" and quietly leave television out
    of the leaderboard.

    These two live side by side because **they are one rule**: if the parent is
    ever resolved through something other than `show_id`, both have to follow.
    Split across modules they drifted once already — a filtered ranking would
    narrow on one definition and group on the other, and nothing would fail
    loudly.

    `year` is deliberately not resolved this way, here or in `facet_source`: an
    episode has its own air date, and reading it through the series would file
    a 2019 episode under 1989.
    """
    own = getattr(MediaItem, column)
    from_parent = (
        select(getattr(facet_parent, column))
        .where(facet_parent.id == MediaItem.show_id)
        .scalar_subquery()
    )
    if column in _LIST_FACETS:
        # `coalesce` is wrong for these and silently so. `MediaItem.genres` is
        # `default=list`, so an episode is stored holding `[]` rather than NULL
        # — and `coalesce([], <the show's genres>)` is `[]`, so the parent
        # branch never fires and every episode is filed under no genre at all.
        # That is not hypothetical: it is why "most-watched genres" counted
        # films only, long after the filter side had been resolved through the
        # show, and the aggregate looked healthy because an empty list is what
        # a genre-less row honestly returns. Emptiness, not nullness, is the
        # question for a list column.
        return case((func.json_array_length(own) > 0, own), else_=from_parent)
    return func.coalesce(own, from_parent)


def facet_absent(build: Callable[[Any], Any]):
    """The mirror of `facet_source`: neither the item nor its show matches.

    Deliberately *not* `~facet_source(...)`. SQL's `NOT` over a NULL comparison
    is NULL, and a row the WHERE cannot prove true is dropped — so
    `?studio_not=A24` would exclude every title with no studio recorded at all,
    which is the set most obviously not made by A24. The same trap in the other
    direction is `EXISTS (… != value)`, which a title with a second value
    satisfies; both are why exclusion is written as one `NOT EXISTS` over the
    rows that *would* have matched.

    One subquery covers the item and its show, so an episode is excluded by its
    series' facets exactly as `facet_source` includes it by them.
    """
    holder = select(facet_holder.id).where(
        or_(facet_holder.id == MediaItem.id, facet_holder.id == MediaItem.show_id),
        build(facet_holder),
    )
    return ~holder.exists()


def _genre_match(src: Any, value: str):
    """One genre, matched against the JSON array's text form.

    A LIKE on the serialised array is the portable filter for SQLite and is
    fast enough at self-hosted library sizes. The quotes around the value stop
    "Drama" matching "Docudrama"; `like_escape` stops a value carrying `%`
    widening the grid instead of narrowing it.
    """
    return cast(src.genres, String).ilike(f'%"{like_escape(value)}"%', escape="\\")


def _column_match(column: str) -> Callable[[Any, str], Any]:
    """One exact value of a plain column, read from whichever row carries it."""

    def match(src: Any, value: str):
        return getattr(src, column) == value

    return match


#: The facets that take **repeated** query parameters: `?genre=Crime&genre=Drama`.
#:
#: One occurrence parses exactly as the single value it always did, so every
#: bookmark, every facet link on an item page and every stats drill keeps
#: working untouched — the contract is backwards compatible by construction.
#: Comma-splitting would not be: studio names contain commas ("Warner Bros.,
#: Inc."), and a `-Horror` prefix operator collides with values that legitimately
#: start with one.
#:
#: Each entry says how *one* value matches *one* row; everything else — OR, AND,
#: exclusion, resolution through the parent show — is derived from that, so a
#: facet added here gets the whole set at once.
MULTI_FACETS: dict[str, Callable[[Any, str], Any]] = {
    "genre": _genre_match,
    "content_rating": _column_match("content_rating"),
    "studio": _column_match("studio"),
    "network": _column_match("network"),
    "anime_format": _column_match("anime_format"),
}


def _values(raw: list[str] | None) -> list[str]:
    """The values a repeated parameter really carries.

    A hand-edited URL leaves `?genre=&genre=Crime` behind, and an empty facet
    value is not a filter — matched literally it asks for rows whose studio is
    the empty string, which is a narrower grid nobody asked for.
    """
    return [value.strip() for value in (raw or []) if value and value.strip()]


def credited_condition(kind: CreditKind, name: str):
    """"Somebody by this name is credited on this title, in this role".

    A correlated EXISTS rather than a join, for the same reason `on_plex` uses
    one: a title with two directors — or forty actors — must not come back once
    per credit, and a caller that is counting rather than paging would count it
    that many times too.

    By name rather than by person id, so the URL says who. Two people sharing a
    name would widen the grid slightly; an opaque id in every link is the worse
    trade.
    """
    return (
        select(MediaCredit.id)
        .join(Person, Person.id == MediaCredit.person_id)
        .where(
            MediaCredit.media_item_id == MediaItem.id,
            MediaCredit.kind == kind,
            Person.name == name,
        )
        .exists()
    )


def mapped_condition(column: Any, ids: list[int]):
    """"Held in one of these libraries", or "on one of these servers".

    A correlated EXISTS again: an item mapped on two servers is one row, and a
    join would both double it in the page and inflate `count_stmt` — which is
    how a pager invents pages that render empty.

    The two filters are separate EXISTS clauses rather than one with both
    columns in it, so each answers its own question: picking a library and a
    server asks for a title in that library *and* on that server, not for one
    mapping that is both.
    """
    return (
        select(PlexMapping.id)
        .where(PlexMapping.media_item_id == MediaItem.id, column.in_(ids))
        .exists()
    )


class MediaFilters:
    """Query parameters shared by `/api/media`, `/api/watchlist` and `/api/history`."""

    def __init__(
        self,
        q: str | None = None,
        # How wide the free-text search reaches. `title` by default, so an
        # ordinary search does not start matching plot words.
        q_scope: SearchScope = "title",
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
        # Every facet below is **repeatable**: `?genre=Crime&genre=Drama` means
        # either, `?genre_not=Horror` means neither, and `?genre_mode=all` means
        # both. One occurrence parses as the single value it always did, so no
        # existing link changes meaning — see `MULTI_FACETS`.
        genre: list[str] | None = Query(None),
        genre_not: list[str] | None = Query(None),
        # Omitted means "any", so the default never lands in the URL. Offered
        # for genre alone: a title has one studio, one certificate and one
        # network, so "all" over those is the empty set by construction, and a
        # control that can only produce a wrong answer should not exist.
        genre_mode: MatchMode = "any",
        year: int | None = None,
        # The facets a detail page links out on. Each is an exact match on the
        # value that page displayed, so the chip and the filter bar describe the
        # same set of rows.
        content_rating: list[str] | None = Query(None),
        content_rating_not: list[str] | None = Query(None),
        studio: list[str] | None = Query(None),
        studio_not: list[str] | None = Query(None),
        # By name, not by person id, so the URL says who — matching how `genre`
        # and `studio` read. Two directors sharing a name would widen the grid
        # slightly; an opaque id in every link is the worse trade.
        director: str | None = None,
        # The same shape for the other half of a credit list. Sparse today —
        # credits are fetched when a detail page is viewed, so only titles
        # somebody has opened carry any — which is a coverage gap, not a
        # correctness one: what is recorded matches exactly.
        actor: str | None = None,
        # Show-level facets. Like genre/studio/content rating these are only
        # populated for movies and shows, so they resolve through `facet_source`
        # and an episode answers with its series'.
        network: list[str] | None = Query(None),
        network_not: list[str] | None = Query(None),
        release_status: str | None = None,
        anime_format: list[str] | None = Query(None),
        anime_format_not: list[str] | None = Query(None),
        # Where the file lives. Repeatable like the facets, and resolved through
        # `PlexMapping` with a correlated EXISTS so a title held on two servers
        # is still one row.
        library_id: list[int] | None = Query(None),
        server_id: list[int] | None = Query(None),
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
        self.q_scope = q_scope
        self.media_type = media_type
        self.anime = anime
        self.personal = personal
        self.watch_status = watch_status
        # Normalised once, here, so every reader — `item_conditions`, the stats
        # aggregates, a test — sees the same list and none of them has to know
        # that a hand-edited URL can carry `?genre=`.
        self.genre = _values(genre)
        self.genre_not = _values(genre_not)
        self.genre_mode = genre_mode
        self.year = year
        self.content_rating = _values(content_rating)
        self.content_rating_not = _values(content_rating_not)
        self.studio = _values(studio)
        self.studio_not = _values(studio_not)
        self.director = director
        self.actor = actor
        self.network = _values(network)
        self.network_not = _values(network_not)
        self.release_status = release_status
        self.anime_format = _values(anime_format)
        self.anime_format_not = _values(anime_format_not)
        self.library_id = library_id or []
        self.server_id = server_id or []
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

    @property
    def searches_notes(self) -> bool:
        """Whether `q` has to reach the viewer's own notes.

        Notes are per-user, so this is the one part of a text search that can
        only be evaluated inside the `user_id`-scoped join — which is why the
        whole `q` clause moves to `state_conditions` when the scope widens.
        Written as an OR across title, overview and notes, it cannot be split
        across the two lists, and evaluated anywhere else it would count one
        account's private notes into another account's results.
        """
        return bool(self.q) and self.q_scope == "all"

    def search_condition(self, *, notes: bool):
        """The free-text clause: titles always, overview and notes on request."""
        pattern = f"%{like_escape((self.q or '').strip())}%"
        parts = [
            MediaItem.title.ilike(pattern, escape="\\"),
            MediaItem.original_title.ilike(pattern, escape="\\"),
            MediaItem.sort_title.ilike(pattern, escape="\\"),
        ]
        if self.q_scope == "all":
            parts.append(MediaItem.overview.ilike(pattern, escape="\\"))
            if notes:
                parts.append(UserMediaState.notes.ilike(pattern, escape="\\"))
        return or_(*parts)

    def needs_state_join(self, sort: str = "") -> bool:
        """Whether the per-user state row has to be joined in.

        Every filter that reads `user_media_states` has to be listed here, and
        two of the sorts read from it as well. Miss one and the query names a
        table it never joined — which is a 500, not a wrong answer, so it shows
        up immediately, but only on the request that happens to use it.

        `sort` defaults to empty for a caller that has no ordering at all.
        """
        return bool(
            self.searches_notes
            or self.watch_status
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

        # A title-scoped search is decidable here; a widened one is not, because
        # it reaches the viewer's own notes. See `searches_notes`.
        if self.q and not self.searches_notes:
            conditions.append(self.search_condition(notes=False))

        # Every repeatable facet, from one table. `facet_source` resolves each
        # value through the parent show, so an episode still matches its
        # series'; `facet_absent` is its mirror for exclusion.
        for name, match in MULTI_FACETS.items():
            included = getattr(self, name)
            # Both `value` and `match` are bound as defaults: the lambda would
            # otherwise close over the loop variables and every clause would end
            # up asking about the last facet's last value.
            if included:
                wanted = [
                    facet_source(lambda src, value=value, match=match: match(src, value))
                    for value in included
                ]
                mode = getattr(self, f"{name}_mode", "any")
                conditions.append(and_(*wanted) if mode == "all" else or_(*wanted))
            for value in getattr(self, f"{name}_not"):
                conditions.append(
                    facet_absent(lambda src, value=value, match=match: match(src, value))
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
        if self.release_status:
            conditions.append(
                facet_source(lambda src: src.release_status == self.release_status)
            )
        if self.on_plex is not None:
            conditions.append(on_plex_condition(self.on_plex))
        if self.director:
            conditions.append(credited_condition(CreditKind.DIRECTOR, self.director))
        if self.actor:
            # `CAST` is what the model calls a cast credit; the *parameter* is
            # `actor`, because that is the word on the detail page and in the
            # link the user clicked.
            conditions.append(credited_condition(CreditKind.CAST, self.actor))
        if self.library_id:
            conditions.append(mapped_condition(PlexMapping.library_id, self.library_id))
        if self.server_id:
            conditions.append(mapped_condition(PlexMapping.server_id, self.server_id))
        return conditions

    def state_conditions(self) -> list:
        """Filters that read from the joined `user_media_states` row.

        Every one of these is per-user, and the join that carries them is
        scoped to one `user_id` — so none of this can ever see another
        account's rating, notes or progress. Anything added here must be listed
        in `needs_state_join` too.
        """
        conditions = []
        # `q_scope=all` searches your notes, and notes are yours: the clause can
        # only be written where the join has already pinned `user_id`, so it
        # lives here rather than in `item_conditions`.
        if self.searches_notes:
            conditions.append(self.search_condition(notes=True))
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
