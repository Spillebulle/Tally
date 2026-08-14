"""Helpers that turn ORM rows into API payloads."""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    MediaItem,
    MediaType,
    PlexMapping,
    UserMediaState,
    WatchlistEntry,
)
from .schemas import MediaCard, MediaItemDetail, UserStateOut


def progress_percent(state: UserMediaState | None) -> float | None:
    if state is None or not state.progress_ms or not state.duration_ms:
        return None
    return round(min(100.0, state.progress_ms / state.duration_ms * 100), 1)


def to_card(
    item: MediaItem,
    state: UserMediaState | None = None,
    *,
    show_title: str | None = None,
    on_watchlist: bool = False,
    watched_episodes: int | None = None,
    total_episodes: int | None = None,
) -> MediaCard:
    return MediaCard(
        id=item.id,
        media_type=item.media_type,
        title=item.title,
        year=item.year,
        poster_url=item.poster_url,
        is_anime=item.is_anime,
        season_number=item.season_number,
        episode_number=item.episode_number,
        show_id=item.show_id,
        show_title=show_title,
        status=state.status if state else None,
        rating=state.rating if state else None,
        progress_percent=progress_percent(state),
        last_watched_at=state.last_watched_at if state else None,
        watched_episodes=watched_episodes,
        total_episodes=total_episodes if total_episodes is not None else item.leaf_count,
        on_watchlist=on_watchlist,
    )


async def episode_progress(
    db: AsyncSession, user_id: int, show_id: int
) -> tuple[int, int]:
    """Return (watched, total) episode counts for a show."""
    total = await db.scalar(
        select(func.count(MediaItem.id)).where(
            MediaItem.show_id == show_id, MediaItem.media_type == MediaType.EPISODE
        )
    )
    watched = await db.scalar(
        select(func.count(func.distinct(UserMediaState.media_item_id)))
        .join(MediaItem, MediaItem.id == UserMediaState.media_item_id)
        .where(
            MediaItem.show_id == show_id,
            MediaItem.media_type == MediaType.EPISODE,
            UserMediaState.user_id == user_id,
            UserMediaState.view_count > 0,
        )
    )
    return int(watched or 0), int(total or 0)


async def to_detail(
    db: AsyncSession, item: MediaItem, user_id: int
) -> MediaItemDetail:
    state = (
        await db.execute(
            select(UserMediaState).where(
                UserMediaState.user_id == user_id,
                UserMediaState.media_item_id == item.id,
            )
        )
    ).scalar_one_or_none()

    on_watchlist = (
        await db.execute(
            select(WatchlistEntry.id).where(
                WatchlistEntry.user_id == user_id,
                WatchlistEntry.media_item_id == item.id,
                WatchlistEntry.active.is_(True),
            )
        )
    ).scalar_one_or_none() is not None

    available = (
        await db.execute(
            select(PlexMapping.id).where(PlexMapping.media_item_id == item.id).limit(1)
        )
    ).scalar_one_or_none() is not None

    show_title = None
    if item.show_id:
        show_title = await db.scalar(
            select(MediaItem.title).where(MediaItem.id == item.show_id)
        )

    watched_episodes = total_episodes = None
    if item.media_type == MediaType.SHOW:
        watched_episodes, total_episodes = await episode_progress(db, user_id, item.id)

    detail = MediaItemDetail.model_validate(item)
    detail.state = UserStateOut.model_validate(state) if state else None
    detail.on_watchlist = on_watchlist
    detail.available_on_plex = available
    detail.show_title = show_title
    detail.watched_episodes = watched_episodes
    detail.total_episodes = total_episodes if total_episodes is not None else item.leaf_count
    return detail


async def watchlist_ids(db: AsyncSession, user_id: int, item_ids: list[int]) -> set[int]:
    """Bulk watchlist lookup so grids don't issue one query per card."""
    if not item_ids:
        return set()
    result = await db.execute(
        select(WatchlistEntry.media_item_id).where(
            WatchlistEntry.user_id == user_id,
            WatchlistEntry.active.is_(True),
            WatchlistEntry.media_item_id.in_(item_ids),
        )
    )
    return set(result.scalars())


async def states_for(
    db: AsyncSession, user_id: int, item_ids: list[int]
) -> dict[int, UserMediaState]:
    if not item_ids:
        return {}
    result = await db.execute(
        select(UserMediaState).where(
            UserMediaState.user_id == user_id,
            UserMediaState.media_item_id.in_(item_ids),
        )
    )
    return {state.media_item_id: state for state in result.scalars()}


async def show_titles_for(db: AsyncSession, show_ids: list[int]) -> dict[int, str]:
    ids = [i for i in show_ids if i]
    if not ids:
        return {}
    result = await db.execute(
        select(MediaItem.id, MediaItem.title).where(MediaItem.id.in_(ids))
    )
    return {row[0]: row[1] for row in result}
