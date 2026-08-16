"""Browsing, searching and per-item state changes."""
from __future__ import annotations

import operator
from functools import reduce
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import String, and_, case, cast, func, or_, select, true

from ..deps import CurrentUser, DbSession
from ..media_filters import (
    AnimeFilter,
    MediaFilters,
    SortField,
    SortOrder,
    apply_filters,
    unwatched_condition,
)
from ..models import (
    CreditKind,
    MediaItem,
    MediaType,
    PlexMapping,
    UserMediaState,
    WatchStatus,
)
from ..schemas import (
    ContinueWatchingItem,
    CreditOut,
    FavoriteRequest,
    MediaCard,
    MediaCreditsOut,
    MediaItemDetail,
    NotesRequest,
    PaginatedMedia,
    RatingRequest,
    StatusRequest,
    UserStateOut,
)
from ..serializers import (
    episode_progress,
    poster_for,
    progress_percent,
    show_titles_for,
    states_for,
    to_card,
    to_detail,
    watchlist_ids,
)
from ..services import on_deck
from ..services.credits import credits_for
from ..services.sync_service import SyncService

router = APIRouter(prefix="/api/media", tags=["media"])


@router.get("", response_model=PaginatedMedia)
async def list_media(
    db: DbSession,
    user: CurrentUser,
    filters: Annotated[MediaFilters, Depends()],
    sort: SortField = "title",
    order: SortOrder = "asc",
    offset: int = Query(0, ge=0),
    limit: int = Query(60, ge=1, le=200),
) -> PaginatedMedia:
    """Main browse endpoint. Seasons and episodes are excluded by default —
    they're reached through a show's detail page instead of the top-level grid."""
    stmt, count_stmt = apply_filters(
        select(MediaItem),
        select(func.count(MediaItem.id)),
        filters,
        user.id,
        sort=sort,
        order=order,
    )

    total = int(await db.scalar(count_stmt) or 0)
    result = await db.execute(stmt.offset(offset).limit(limit))
    items = list(result.scalars().unique())

    ids = [item.id for item in items]
    states = await states_for(db, user.id, ids)
    listed = await watchlist_ids(db, user.id, ids)

    cards = [
        to_card(item, states.get(item.id), on_watchlist=item.id in listed)
        for item in items
    ]
    return PaginatedMedia(items=cards, total=total, offset=offset, limit=limit)


@router.get("/genres", response_model=list[str])
async def list_genres(db: DbSession, user: CurrentUser, anime: AnimeFilter = "all") -> list[str]:
    conditions = [MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW])]
    if anime == "only":
        conditions.append(MediaItem.is_anime.is_(True))
    elif anime == "exclude":
        conditions.append(MediaItem.is_anime.is_(False))

    result = await db.execute(select(MediaItem.genres).where(and_(*conditions)))
    genres: set[str] = set()
    for row in result.scalars():
        genres.update(row or [])
    return sorted(genres)


@router.get("/content-ratings", response_model=list[str])
async def list_content_ratings(
    db: DbSession, user: CurrentUser, anime: AnimeFilter = "all"
) -> list[str]:
    """Every certificate actually present, so the filter can offer a real list.

    Deliberately not a fixed set of ratings: Plex reports whatever the agent
    wrote, which is `PG-13` on one library and `gb/15` on the next, and a
    hard-coded list would silently drop half of them.
    """
    conditions = [
        MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW]),
        MediaItem.content_rating.is_not(None),
        MediaItem.content_rating != "",
    ]
    if anime == "only":
        conditions.append(MediaItem.is_anime.is_(True))
    elif anime == "exclude":
        conditions.append(MediaItem.is_anime.is_(False))

    result = await db.execute(
        select(MediaItem.content_rating).where(and_(*conditions)).distinct()
    )
    return sorted(rating for rating in result.scalars() if rating)


@router.get("/continue-watching", response_model=list[ContinueWatchingItem])
async def continue_watching(
    db: DbSession, user: CurrentUser, limit: int = Query(20, ge=1, le=50)
) -> list[ContinueWatchingItem]:
    """Partially-watched items plus the next unwatched episode of started shows.

    Anything last touched before the On Deck window falls off, the way it does
    on Plex — see `services/on_deck.py`.
    """
    stale_before = await on_deck.cutoff(db, user)
    # A row with no timestamp at all cannot be judged stale, so it stays.
    fresh_enough = (
        true()
        if stale_before is None
        else or_(
            UserMediaState.last_watched_at.is_(None),
            UserMediaState.last_watched_at >= stale_before,
        )
    )

    result = await db.execute(
        select(UserMediaState, MediaItem)
        .join(MediaItem, MediaItem.id == UserMediaState.media_item_id)
        .where(
            UserMediaState.user_id == user.id,
            UserMediaState.progress_ms.is_not(None),
            UserMediaState.progress_ms > 0,
            MediaItem.media_type.in_([MediaType.MOVIE, MediaType.EPISODE]),
            fresh_enough,
        )
        .order_by(UserMediaState.last_watched_at.desc().nulls_last())
        .limit(limit)
    )
    rows = result.all()
    show_ids = [item.show_id for _, item in rows if item.show_id]
    show_titles = await show_titles_for(db, show_ids)

    out: list[ContinueWatchingItem] = []
    # Shows already represented by a part-watched episode. Adding an "up next"
    # card for them too would list the same series twice.
    covered_show_ids: set[int] = set()

    for state, item in rows:
        percent = progress_percent(state) or 0.0
        # Anything essentially finished belongs in history, not here.
        if percent >= 95:
            continue
        if item.show_id:
            covered_show_ids.add(item.show_id)
        out.append(
            ContinueWatchingItem(
                item=to_card(item, state, show_title=show_titles.get(item.show_id or 0)),
                progress_percent=percent,
                resumed_at=state.last_watched_at,
            )
        )

    # Shows being watched but with nothing mid-episode: surface "up next".
    remaining = limit - len(out)
    if remaining > 0:
        result = await db.execute(
            select(UserMediaState, MediaItem)
            .join(MediaItem, MediaItem.id == UserMediaState.media_item_id)
            .where(
                UserMediaState.user_id == user.id,
                UserMediaState.status == WatchStatus.WATCHING,
                MediaItem.media_type == MediaType.SHOW,
                fresh_enough,
            )
            .order_by(UserMediaState.last_watched_at.desc().nulls_last())
            .limit(remaining * 3)
        )
        for show_state, show in result.all():
            if len(out) >= limit:
                break
            if show.id in covered_show_ids:
                continue
            next_episode = await _next_unwatched_episode(db, user.id, show.id)
            if next_episode is None:
                continue
            watched, total = await episode_progress(db, user.id, show.id)
            out.append(
                ContinueWatchingItem(
                    item=to_card(
                        show,
                        show_state,
                        watched_episodes=watched,
                        total_episodes=total,
                    ),
                    next_episode=to_card(next_episode, None, show_title=show.title),
                    show=to_card(show, show_state),
                    progress_percent=round(watched / total * 100, 1) if total else 0.0,
                    resumed_at=show_state.last_watched_at,
                )
            )
    return out


async def _next_unwatched_episode(
    db: DbSession, user_id: int, show_id: int
) -> MediaItem | None:
    result = await db.execute(
        select(MediaItem)
        .outerjoin(
            UserMediaState,
            and_(
                UserMediaState.media_item_id == MediaItem.id,
                UserMediaState.user_id == user_id,
            ),
        )
        .where(
            MediaItem.show_id == show_id,
            MediaItem.media_type == MediaType.EPISODE,
            or_(UserMediaState.id.is_(None), UserMediaState.view_count == 0),
            # Specials (season 0) are skippable and shouldn't block "up next".
            func.coalesce(MediaItem.season_number, 1) > 0,
        )
        .order_by(MediaItem.season_number.asc(), MediaItem.episode_number.asc())
        .limit(1)
    )
    return result.scalars().first()


@router.get("/recently-watched", response_model=list[MediaCard])
async def recently_watched(
    db: DbSession, user: CurrentUser, limit: int = Query(20, ge=1, le=50)
) -> list[MediaCard]:
    result = await db.execute(
        select(UserMediaState, MediaItem)
        .join(MediaItem, MediaItem.id == UserMediaState.media_item_id)
        .where(
            UserMediaState.user_id == user.id,
            UserMediaState.last_watched_at.is_not(None),
            MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW]),
        )
        .order_by(UserMediaState.last_watched_at.desc())
        .limit(limit)
    )
    rows = result.all()
    return [to_card(item, state) for state, item in rows]


@router.get("/recently-added", response_model=list[MediaCard])
async def recently_added(
    db: DbSession,
    user: CurrentUser,
    anime: AnimeFilter = "all",
    limit: int = Query(20, ge=1, le=50),
) -> list[MediaCard]:
    conditions = [MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW])]
    if anime == "only":
        conditions.append(MediaItem.is_anime.is_(True))
    elif anime == "exclude":
        conditions.append(MediaItem.is_anime.is_(False))

    # Group rather than join-and-dedupe. An item mapped on two servers appeared
    # twice in the joined rows, LIMIT counted both, and `.unique()` then removed
    # the duplicate client-side — so the row ended up short of `limit`, and
    # "recently added" quietly returned fewer cards than asked for.
    result = await db.execute(
        select(MediaItem)
        .join(PlexMapping, PlexMapping.media_item_id == MediaItem.id)
        .where(and_(*conditions))
        .group_by(MediaItem.id)
        .order_by(func.max(PlexMapping.added_at).desc().nulls_last())
        .limit(limit)
    )
    items = list(result.scalars().unique())
    states = await states_for(db, user.id, [i.id for i in items])
    return [to_card(item, states.get(item.id)) for item in items]


@router.get("/{item_id}", response_model=MediaItemDetail)
async def get_item(item_id: int, db: DbSession, user: CurrentUser) -> MediaItemDetail:
    item = await db.get(MediaItem, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return await to_detail(db, item, user.id)


@router.get("/{item_id}/credits", response_model=MediaCreditsOut)
async def get_credits(item_id: int, db: DbSession, user: CurrentUser) -> MediaCreditsOut:
    """Who is in it, and who directed it.

    A GET that may write, like the artwork proxy: credits are fetched the first
    time somebody looks at a title rather than during a library scan, because a
    scan walks tens of thousands of rows and this would be a second full pass
    over the library against a rate-limited provider. See `services/credits.py`.
    """
    item = await db.get(MediaItem, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    payload = MediaCreditsOut()
    for credit, person in await credits_for(db, item):
        entry = CreditOut(
            person_id=person.id,
            name=person.name,
            character=credit.character,
            profile_url=person.profile_url,
        )
        if credit.kind == CreditKind.DIRECTOR:
            payload.directors.append(entry)
        else:
            payload.cast.append(entry)
    return payload


@router.get("/{item_id}/children", response_model=list[MediaCard])
async def get_children(
    item_id: int, db: DbSession, user: CurrentUser, season: int | None = None
) -> list[MediaCard]:
    """Seasons of a show, or episodes when ``season`` is given."""
    item = await db.get(MediaItem, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    if season is None:
        stmt = (
            select(MediaItem)
            .where(
                MediaItem.show_id == item.id,
                MediaItem.media_type == MediaType.SEASON,
            )
            .order_by(MediaItem.season_number.asc())
        )
    else:
        stmt = (
            select(MediaItem)
            .where(
                MediaItem.show_id == item.id,
                MediaItem.media_type == MediaType.EPISODE,
                MediaItem.season_number == season,
            )
            .order_by(MediaItem.episode_number.asc())
        )

    result = await db.execute(stmt)
    children = list(result.scalars().unique())

    # A library scanned episodes-only has no season rows; synthesise the list
    # from the distinct season numbers on its episodes.
    if season is None and not children:
        seasons = await db.execute(
            select(MediaItem.season_number)
            .where(
                MediaItem.show_id == item.id,
                MediaItem.media_type == MediaType.EPISODE,
                MediaItem.season_number.is_not(None),
            )
            .distinct()
            .order_by(MediaItem.season_number.asc())
        )
        return [
            MediaCard(
                id=-(number or 0),  # negative: synthetic, not a real row
                media_type=MediaType.SEASON,
                title=f"Season {number}" if number else "Specials",
                year=None,
                poster_url=poster_for(item),
                is_anime=item.is_anime,
                season_number=number,
                show_id=item.id,
                show_title=item.title,
            )
            for number in seasons.scalars()
        ]

    states = await states_for(db, user.id, [c.id for c in children])

    # Episode counts for every season at once. This was two `db.scalar` calls
    # per season row, so a show with 10 seasons cost 20 extra round trips to
    # render one page.
    season_ids = [c.id for c in children if c.media_type == MediaType.SEASON]
    totals: dict[int, int] = {}
    watched_counts: dict[int, int] = {}
    if season_ids:
        total_rows = await db.execute(
            select(MediaItem.parent_id, func.count(MediaItem.id))
            .where(
                MediaItem.parent_id.in_(season_ids),
                MediaItem.media_type == MediaType.EPISODE,
            )
            .group_by(MediaItem.parent_id)
        )
        totals = {parent_id: int(count) for parent_id, count in total_rows}

        watched_rows = await db.execute(
            select(
                MediaItem.parent_id,
                func.count(func.distinct(UserMediaState.media_item_id)),
            )
            .join(UserMediaState, UserMediaState.media_item_id == MediaItem.id)
            .where(
                MediaItem.parent_id.in_(season_ids),
                UserMediaState.user_id == user.id,
                UserMediaState.view_count > 0,
            )
            .group_by(MediaItem.parent_id)
        )
        watched_counts = {parent_id: int(count) for parent_id, count in watched_rows}

    cards = []
    for child in children:
        watched = total = None
        if child.media_type == MediaType.SEASON:
            total = totals.get(child.id, 0)
            watched = watched_counts.get(child.id, 0)
        cards.append(
            to_card(
                child,
                states.get(child.id),
                show_title=item.title,
                watched_episodes=int(watched) if watched is not None else None,
                total_episodes=int(total) if total is not None else None,
            )
        )
    return cards


@router.get("/{item_id}/recommendations", response_model=list[MediaCard])
async def get_recommendations(
    item_id: int,
    db: DbSession,
    user: CurrentUser,
    limit: int = Query(12, ge=1, le=40),
) -> list[MediaCard]:
    """Unwatched movies and shows that share the most genres with this one.

    The ordering is two-level on purpose. The number of shared genres is the
    primary key and the community rating only breaks ties inside it; sorting by
    rating alone over everything that shares a single genre returns the same
    dozen acclaimed titles on every page in the library, which is no use for
    finding something new. Measured against a real 4,500-item library, the pure
    rating sort answered "The Godfather" with a romcom and a school drama,
    while this ordering answers it with Breaking Bad, The Wire and GoodFellas.

    An unrated candidate sorts *below* every rated one at the same overlap
    (`nulls_last`) rather than above them — a missing rating is an unknown, and
    the point of the tiebreak is to lead with what people liked.

    Genres are all Tally stores; there are no keywords or cast to match on, so
    two titles that share a vocabulary are as close as this can get.
    """
    item = await db.get(MediaItem, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    # A season or an episode carries no genres of its own — the show holds them,
    # and the show is what a viewer on that page is actually exploring around.
    source = item
    if item.show_id and item.media_type in (MediaType.SEASON, MediaType.EPISODE):
        source = await db.get(MediaItem, item.show_id) or item

    genres = [g for g in (source.genres or []) if isinstance(g, str) and g]
    if not genres:
        return []

    # Same LIKE-on-the-JSON-text match the genre filter uses, once per genre.
    matches = [cast(MediaItem.genres, String).ilike(f'%"{genre}"%') for genre in genres]
    shared = reduce(operator.add, (case((match, 1), else_=0) for match in matches))

    join_on = and_(
        UserMediaState.media_item_id == MediaItem.id,
        UserMediaState.user_id == user.id,
    )
    result = await db.execute(
        select(MediaItem)
        # LEFT JOIN, so an item with no state row at all counts as unwatched.
        .outerjoin(UserMediaState, join_on)
        .where(
            MediaItem.id.not_in([item.id, source.id]),
            # Seasons and episodes are reached through a show, never listed flat.
            MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW]),
            unwatched_condition(),
            # Bounds the sort input to rows that can score at all.
            or_(*matches),
            # …and half of the candidate's own genres have to be ones we matched
            # on. Without this a title tagged with six genres matches everything:
            # a two-genre Crime/Drama query pulled in a six-genre action-mystery
            # anime ahead of Once Upon a Time in America. It is a filter rather
            # than another sort key so the two levels above stay legible.
            shared * 2 >= func.json_array_length(MediaItem.genres),
        )
        .order_by(
            shared.desc(),
            MediaItem.community_rating.desc().nulls_last(),
            # Stable: without it, equally-rated rows shuffle between requests.
            MediaItem.id.asc(),
        )
        .limit(limit)
    )
    items = list(result.scalars().unique())

    ids = [i.id for i in items]
    states = await states_for(db, user.id, ids)
    listed = await watchlist_ids(db, user.id, ids)
    return [
        to_card(i, states.get(i.id), on_watchlist=i.id in listed) for i in items
    ]


# ---------------------------------------------------------------------------
# Per-item user state
# ---------------------------------------------------------------------------


@router.put("/{item_id}/rating", response_model=UserStateOut)
async def set_rating(
    item_id: int, payload: RatingRequest, db: DbSession, user: CurrentUser
) -> UserStateOut:
    item = await db.get(MediaItem, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    service = SyncService(db)
    state = await service.get_or_create_state(user.id, item.id)
    from ..models import utcnow

    state.rating = payload.rating
    state.rating_updated_at = utcnow()
    await db.commit()

    if payload.push_to_plex:
        if await service.push_rating(user, item, payload.rating):
            # Record the pushed value as the Plex baseline so the next two-way
            # pass sees the sides as agreeing.
            state.plex_rating = payload.rating
            state.plex_rating_synced_at = utcnow()
            await db.commit()

    await db.refresh(state)
    return UserStateOut.model_validate(state)


@router.put("/{item_id}/status", response_model=UserStateOut)
async def set_status(
    item_id: int, payload: StatusRequest, db: DbSession, user: CurrentUser
) -> UserStateOut:
    item = await db.get(MediaItem, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    service = SyncService(db)
    state = await service.get_or_create_state(user.id, item.id)
    state.status = payload.status
    await db.commit()
    await db.refresh(state)
    return UserStateOut.model_validate(state)


@router.put("/{item_id}/favorite", response_model=UserStateOut)
async def set_favorite(
    item_id: int, payload: FavoriteRequest, db: DbSession, user: CurrentUser
) -> UserStateOut:
    # Same guard as set_rating and set_status. Without it an unknown id reached
    # the insert and tripped the foreign key, answering 500 where 404 is the
    # honest reply.
    if await db.get(MediaItem, item_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    service = SyncService(db)
    state = await service.get_or_create_state(user.id, item_id)
    state.is_favorite = payload.is_favorite
    await db.commit()
    await db.refresh(state)
    return UserStateOut.model_validate(state)


@router.put("/{item_id}/notes", response_model=UserStateOut)
async def set_notes(
    item_id: int, payload: NotesRequest, db: DbSession, user: CurrentUser
) -> UserStateOut:
    if await db.get(MediaItem, item_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    service = SyncService(db)
    state = await service.get_or_create_state(user.id, item_id)
    state.notes = payload.notes
    await db.commit()
    await db.refresh(state)
    return UserStateOut.model_validate(state)


@router.delete("/{item_id}/state", status_code=status.HTTP_204_NO_CONTENT)
async def clear_state(item_id: int, db: DbSession, user: CurrentUser) -> Response:
    result = await db.execute(
        select(UserMediaState).where(
            UserMediaState.user_id == user.id,
            UserMediaState.media_item_id == item_id,
        )
    )
    if state := result.scalar_one_or_none():
        await db.delete(state)
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
