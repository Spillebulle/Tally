"""Watch history: listing, manual logging, and un-watching."""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import and_, func, select

from ..deps import CurrentUser, DbSession
from ..models import (
    MediaItem,
    MediaType,
    UserMediaState,
    WatchEvent,
    WatchSource,
    WatchStatus,
    utcnow,
)
from ..schemas import HistoryPage, LogWatchRequest, WatchEventOut
from ..serializers import show_titles_for, states_for, to_card
from ..services.sync_service import SyncService

router = APIRouter(prefix="/api/history", tags=["history"])


def _runtime_ms(item: MediaItem) -> int | None:
    """The item's runtime in milliseconds, the unit `WatchEvent.duration_ms` uses."""
    return item.runtime_minutes * 60_000 if item.runtime_minutes else None


@router.get("", response_model=HistoryPage)
async def list_history(
    db: DbSession,
    user: CurrentUser,
    media_type: MediaType | None = None,
    anime_only: bool = False,
    since: datetime | None = None,
    until: datetime | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
) -> HistoryPage:
    conditions = [WatchEvent.user_id == user.id]
    if media_type is not None:
        conditions.append(MediaItem.media_type == media_type)
    if anime_only:
        conditions.append(MediaItem.is_anime.is_(True))
    if since is not None:
        conditions.append(WatchEvent.watched_at >= since)
    if until is not None:
        conditions.append(WatchEvent.watched_at <= until)

    base = select(WatchEvent).join(MediaItem, MediaItem.id == WatchEvent.media_item_id)
    total = int(
        await db.scalar(
            select(func.count(WatchEvent.id))
            .join(MediaItem, MediaItem.id == WatchEvent.media_item_id)
            .where(and_(*conditions))
        )
        or 0
    )

    result = await db.execute(
        base.where(and_(*conditions))
        .order_by(WatchEvent.watched_at.desc())
        .offset(offset)
        .limit(limit)
    )
    events = list(result.scalars().unique())

    item_ids = [e.media_item_id for e in events]
    items = {}
    if item_ids:
        rows = await db.execute(select(MediaItem).where(MediaItem.id.in_(item_ids)))
        items = {item.id: item for item in rows.scalars()}
    states = await states_for(db, user.id, item_ids)
    show_titles = await show_titles_for(
        db, [item.show_id for item in items.values() if item.show_id]
    )

    out = []
    for event in events:
        item = items.get(event.media_item_id)
        payload = WatchEventOut.model_validate(event)
        if item is not None:
            payload.item = to_card(
                item,
                states.get(item.id),
                show_title=show_titles.get(item.show_id or 0),
            )
        out.append(payload)

    return HistoryPage(events=out, total=total, offset=offset, limit=limit)


@router.post("", response_model=WatchEventOut, status_code=status.HTTP_201_CREATED)
async def log_watch(
    payload: LogWatchRequest, db: DbSession, user: CurrentUser
) -> WatchEventOut:
    """Manually record a watch — for things watched outside Plex."""
    item = await db.get(MediaItem, payload.media_item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    watched_at = payload.watched_at or utcnow()
    event = WatchEvent(
        user_id=user.id,
        media_item_id=item.id,
        watched_at=watched_at,
        source=WatchSource.MANUAL,
        dedupe_key=f"manual:{uuid.uuid4()}",
        completed=True,
        # Nothing measured this play, so record the item's own runtime: the
        # stats total reads `duration_ms` first, and a NULL here would make a
        # manual log the one kind of play that never carries its own length.
        duration_ms=_runtime_ms(item),
    )
    db.add(event)
    await db.flush()

    service = SyncService(db)
    await service.record_watch_state(user, item, watched_at)
    await db.commit()

    if payload.push_to_plex:
        await service.push_watched(user, item, watched=True)

    out = WatchEventOut.model_validate(event)
    out.item = to_card(item)
    return out


@router.post("/{item_id}/watched", response_model=WatchEventOut, status_code=status.HTTP_201_CREATED)
async def mark_watched(
    item_id: int, db: DbSession, user: CurrentUser, push_to_plex: bool = True
) -> WatchEventOut:
    return await log_watch(
        LogWatchRequest(media_item_id=item_id, push_to_plex=push_to_plex), db, user
    )


@router.post("/{item_id}/season/{season}/watched")
async def mark_season_watched(
    item_id: int,
    season: int,
    db: DbSession,
    user: CurrentUser,
    push_to_plex: bool = True,
) -> dict:
    """Mark every episode of one season as watched in a single action."""
    show = await db.get(MediaItem, item_id)
    if show is None or show.media_type != MediaType.SHOW:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Show not found")

    result = await db.execute(
        select(MediaItem).where(
            MediaItem.show_id == show.id,
            MediaItem.media_type == MediaType.EPISODE,
            MediaItem.season_number == season,
        )
    )
    episodes = list(result.scalars())
    service = SyncService(db)
    now = utcnow()
    logged = 0

    for episode in episodes:
        db.add(
            WatchEvent(
                user_id=user.id,
                media_item_id=episode.id,
                watched_at=now,
                source=WatchSource.MANUAL,
                dedupe_key=f"manual:{uuid.uuid4()}",
                completed=True,
                duration_ms=_runtime_ms(episode),
            )
        )
        await db.flush()
        await service.record_watch_state(user, episode, now)
        logged += 1
    await db.commit()

    if push_to_plex:
        for episode in episodes:
            await service.push_watched(user, episode, watched=True)

    return {"marked": logged, "season": season, "show": show.title}


@router.delete("/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_event(event_id: int, db: DbSession, user: CurrentUser) -> Response:
    event = await db.get(WatchEvent, event_id)
    if event is None or event.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    item_id = event.media_item_id
    await db.delete(event)
    await db.flush()

    # Recount from the surviving events rather than decrementing, so a deleted
    # duplicate can't drive the count negative.
    remaining = int(
        await db.scalar(
            select(func.count(WatchEvent.id)).where(
                WatchEvent.user_id == user.id, WatchEvent.media_item_id == item_id
            )
        )
        or 0
    )
    last = await db.scalar(
        select(func.max(WatchEvent.watched_at)).where(
            WatchEvent.user_id == user.id, WatchEvent.media_item_id == item_id
        )
    )

    result = await db.execute(
        select(UserMediaState).where(
            UserMediaState.user_id == user.id, UserMediaState.media_item_id == item_id
        )
    )
    if state := result.scalar_one_or_none():
        state.view_count = remaining
        state.last_watched_at = last
        if remaining == 0 and state.status == WatchStatus.COMPLETED:
            state.status = None

    item = await db.get(MediaItem, item_id)
    if item is not None and item.media_type == MediaType.EPISODE and item.show_id:
        await SyncService(db).recompute_show_state(user, item.show_id)

    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{item_id}/unwatched", status_code=status.HTTP_204_NO_CONTENT)
async def mark_unwatched(
    item_id: int, db: DbSession, user: CurrentUser, push_to_plex: bool = True
) -> Response:
    """Clear all watch history for an item, optionally on Plex too."""
    item = await db.get(MediaItem, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    result = await db.execute(
        select(WatchEvent).where(
            WatchEvent.user_id == user.id, WatchEvent.media_item_id == item_id
        )
    )
    for event in result.scalars():
        await db.delete(event)

    result = await db.execute(
        select(UserMediaState).where(
            UserMediaState.user_id == user.id, UserMediaState.media_item_id == item_id
        )
    )
    if state := result.scalar_one_or_none():
        state.view_count = 0
        state.last_watched_at = None
        state.progress_ms = None
        state.status = None
    await db.commit()

    if push_to_plex:
        await SyncService(db).push_watched(user, item, watched=False)

    if item.media_type == MediaType.EPISODE and item.show_id:
        await SyncService(db).recompute_show_state(user, item.show_id)
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
