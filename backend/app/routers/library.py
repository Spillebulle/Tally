"""Browsing, searching and per-item state changes."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import String, and_, cast, func, or_, select

from ..deps import CurrentUser, DbSession
from ..models import (
    MediaItem,
    MediaType,
    PlexMapping,
    UserMediaState,
    WatchStatus,
)
from ..schemas import (
    ContinueWatchingItem,
    FavoriteRequest,
    MediaCard,
    MediaItemDetail,
    NotesRequest,
    PaginatedMedia,
    RatingRequest,
    StatusRequest,
    UserStateOut,
)
from ..serializers import (
    episode_progress,
    progress_percent,
    show_titles_for,
    states_for,
    to_card,
    to_detail,
    watchlist_ids,
)
from ..services.sync_service import SyncService

router = APIRouter(prefix="/api/media", tags=["media"])

AnimeFilter = Literal["all", "only", "exclude"]
SortField = Literal["title", "year", "added", "watched", "rating", "release"]


@router.get("", response_model=PaginatedMedia)
async def list_media(
    db: DbSession,
    user: CurrentUser,
    q: str | None = None,
    media_type: MediaType | None = None,
    anime: AnimeFilter = "all",
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
    sort: SortField = "title",
    order: Literal["asc", "desc"] = "asc",
    offset: int = Query(0, ge=0),
    limit: int = Query(60, ge=1, le=200),
) -> PaginatedMedia:
    """Main browse endpoint. Seasons and episodes are excluded by default —
    they're reached through a show's detail page instead of the top-level grid."""
    conditions = []
    if media_type is not None:
        conditions.append(MediaItem.media_type == media_type)
    else:
        conditions.append(MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW]))

    if anime == "only":
        conditions.append(MediaItem.is_anime.is_(True))
    elif anime == "exclude":
        conditions.append(MediaItem.is_anime.is_(False))

    if q:
        pattern = f"%{q.strip()}%"
        conditions.append(
            or_(
                MediaItem.title.ilike(pattern),
                MediaItem.original_title.ilike(pattern),
                MediaItem.sort_title.ilike(pattern),
            )
        )
    if genre:
        # genres is a JSON array; a LIKE on its text form is the portable filter
        # for SQLite and is fast enough at self-hosted library sizes.
        conditions.append(cast(MediaItem.genres, String).ilike(f'%"{genre}"%'))
    if year:
        conditions.append(MediaItem.year == year)

    stmt = select(MediaItem).where(and_(*conditions))
    count_stmt = select(func.count(MediaItem.id)).where(and_(*conditions))

    rated = min_rating is not None or max_rating is not None
    needs_state_join = bool(
        watch_status or unwatched or favorites or rated or sort in ("watched", "rating")
    )
    if needs_state_join:
        join_on = and_(
            UserMediaState.media_item_id == MediaItem.id,
            UserMediaState.user_id == user.id,
        )
        # LEFT JOIN so "unwatched" can match rows with no state at all.
        stmt = stmt.outerjoin(UserMediaState, join_on)
        count_stmt = count_stmt.outerjoin(UserMediaState, join_on)

        extra = []
        if watch_status is not None:
            extra.append(UserMediaState.status == watch_status)
        if unwatched:
            extra.append(
                or_(
                    UserMediaState.id.is_(None),
                    UserMediaState.view_count == 0,
                )
            )
        if favorites:
            extra.append(UserMediaState.is_favorite.is_(True))
        if min_rating is not None:
            extra.append(UserMediaState.rating >= min_rating)
        if max_rating is not None:
            extra.append(UserMediaState.rating <= max_rating)
        if rated:
            # The LEFT JOIN above lets unrated rows through with a NULL rating,
            # and NULL comparisons are neither true nor false, so say it plainly.
            extra.append(UserMediaState.rating.is_not(None))
        if extra:
            stmt = stmt.where(and_(*extra))
            count_stmt = count_stmt.where(and_(*extra))

    if on_plex is not None:
        exists = select(PlexMapping.id).where(PlexMapping.media_item_id == MediaItem.id)
        clause = exists.exists() if on_plex else ~exists.exists()
        stmt = stmt.where(clause)
        count_stmt = count_stmt.where(clause)

    sort_columns = {
        "title": func.coalesce(MediaItem.sort_title, MediaItem.title),
        "year": MediaItem.year,
        "added": MediaItem.created_at,
        "release": MediaItem.first_aired,
        "watched": UserMediaState.last_watched_at if needs_state_join else MediaItem.created_at,
        "rating": UserMediaState.rating if needs_state_join else MediaItem.community_rating,
    }
    column = sort_columns[sort]
    stmt = stmt.order_by(column.desc().nulls_last() if order == "desc" else column.asc())

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


@router.get("/continue-watching", response_model=list[ContinueWatchingItem])
async def continue_watching(
    db: DbSession, user: CurrentUser, limit: int = Query(20, ge=1, le=50)
) -> list[ContinueWatchingItem]:
    """Partially-watched items plus the next unwatched episode of started shows."""
    result = await db.execute(
        select(UserMediaState, MediaItem)
        .join(MediaItem, MediaItem.id == UserMediaState.media_item_id)
        .where(
            UserMediaState.user_id == user.id,
            UserMediaState.progress_ms.is_not(None),
            UserMediaState.progress_ms > 0,
            MediaItem.media_type.in_([MediaType.MOVIE, MediaType.EPISODE]),
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

    result = await db.execute(
        select(MediaItem)
        .join(PlexMapping, PlexMapping.media_item_id == MediaItem.id)
        .where(and_(*conditions))
        .order_by(PlexMapping.added_at.desc().nulls_last())
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
                poster_url=item.poster_url,
                is_anime=item.is_anime,
                season_number=number,
                show_id=item.id,
                show_title=item.title,
            )
            for number in seasons.scalars()
        ]

    states = await states_for(db, user.id, [c.id for c in children])
    cards = []
    for child in children:
        watched = total = None
        if child.media_type == MediaType.SEASON:
            total = await db.scalar(
                select(func.count(MediaItem.id)).where(
                    MediaItem.parent_id == child.id,
                    MediaItem.media_type == MediaType.EPISODE,
                )
            )
            watched = await db.scalar(
                select(func.count(func.distinct(UserMediaState.media_item_id)))
                .join(MediaItem, MediaItem.id == UserMediaState.media_item_id)
                .where(
                    MediaItem.parent_id == child.id,
                    UserMediaState.user_id == user.id,
                    UserMediaState.view_count > 0,
                )
            )
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
