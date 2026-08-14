"""Plex webhook ingestion.

Plex Pass accounts can POST playback events to Tally, which makes tracking
near-instant instead of waiting for the next poll. Webhooks are strictly an
optimisation: everything they deliver is also picked up by the periodic history
sync, so a missed or duplicated event is harmless.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (
    MediaType,
    PlexServer,
    User,
    UserServerAccess,
    WatchEvent,
    WatchSource,
    WatchStatus,
    utcnow,
)
from .media_repo import MediaRepository
from .plex_server import PlexServerError
from .sync_service import SyncService

log = logging.getLogger(__name__)

HANDLED_EVENTS = {
    "media.scrobble",  # watched through to the end
    "media.play",
    "media.resume",
    "media.pause",
    "media.stop",
    "media.rate",
}


async def _resolve_user(db: AsyncSession, payload: dict[str, Any]) -> User | None:
    """Match the webhook's Account block to a Tally user."""
    account = payload.get("Account") or {}
    plex_user_id = account.get("id")
    title = account.get("title")

    if plex_user_id is not None:
        result = await db.execute(
            select(User).where(User.plex_user_id == str(plex_user_id))
        )
        if user := result.scalar_one_or_none():
            return user
        # Home users report the server-side accountID here rather than the
        # plex.tv id, so fall back to the access mapping.
        result = await db.execute(
            select(User)
            .join(UserServerAccess, UserServerAccess.user_id == User.id)
            .where(UserServerAccess.plex_account_id == int(plex_user_id))
        )
        if user := result.scalars().first():
            return user

    if title:
        result = await db.execute(select(User).where(User.plex_username == title))
        if user := result.scalar_one_or_none():
            return user
        result = await db.execute(select(User).where(User.username == title))
        if user := result.scalar_one_or_none():
            return user
    return None


async def _resolve_server(db: AsyncSession, payload: dict[str, Any]) -> PlexServer | None:
    server_info = payload.get("Server") or {}
    identifier = server_info.get("uuid")
    if identifier:
        result = await db.execute(
            select(PlexServer).where(PlexServer.machine_identifier == identifier)
        )
        if server := result.scalar_one_or_none():
            return server
    result = await db.execute(select(PlexServer).where(PlexServer.enabled.is_(True)))
    return result.scalars().first()


async def handle_webhook(db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
    event = payload.get("event")
    if event not in HANDLED_EVENTS:
        return {"status": "ignored", "reason": f"unhandled event {event!r}"}

    metadata = payload.get("Metadata") or {}
    if not metadata:
        return {"status": "ignored", "reason": "no metadata"}

    user = await _resolve_user(db, payload)
    if user is None:
        return {"status": "ignored", "reason": "no matching Tally user"}

    server = await _resolve_server(db, payload)
    if server is None:
        return {"status": "ignored", "reason": "no known server"}

    service = SyncService(db)
    client = await service.client_for(user, server)
    repo = MediaRepository(db, enrich=False)

    rating_key = str(metadata.get("ratingKey") or "")
    item = await repo.find_by_rating_key(server.id, rating_key) if rating_key else None
    if item is None:
        full = metadata
        if client is not None and rating_key and not metadata.get("Guid"):
            try:
                full = await client.metadata(rating_key) or metadata
            except PlexServerError:
                full = metadata
        item = await repo.upsert_from_plex(full, server=server, client=client)
    if item is None:
        return {"status": "ignored", "reason": "could not resolve media item"}

    now = utcnow()

    if event == "media.scrobble":
        # Webhooks carry no history key, so dedupe on the minute — Plex will not
        # scrobble the same item twice within one.
        dedupe_key = f"webhook:{server.machine_identifier}:{rating_key}:{int(now.timestamp() // 60)}"
        exists = await db.execute(
            select(WatchEvent.id).where(
                WatchEvent.user_id == user.id, WatchEvent.dedupe_key == dedupe_key
            )
        )
        if exists.scalar_one_or_none() is None:
            db.add(
                WatchEvent(
                    user_id=user.id,
                    media_item_id=item.id,
                    watched_at=now,
                    source=WatchSource.PLEX_WEBHOOK,
                    dedupe_key=dedupe_key,
                    completed=True,
                    server_id=server.id,
                    player=(payload.get("Player") or {}).get("title"),
                    device=(payload.get("Player") or {}).get("product"),
                )
            )
            await db.flush()
            await service.record_watch_state(user, item, now)
        await db.commit()
        return {"status": "ok", "action": "scrobbled", "item": item.title}

    if event in ("media.play", "media.resume", "media.pause", "media.stop"):
        state = await service.get_or_create_state(user.id, item.id)
        offset = metadata.get("viewOffset")
        if offset is not None:
            state.progress_ms = int(offset)
        duration = metadata.get("duration")
        if duration:
            state.duration_ms = int(duration)
        state.last_watched_at = now
        if state.status != WatchStatus.COMPLETED:
            state.status = WatchStatus.WATCHING
        if item.media_type == MediaType.EPISODE and item.show_id:
            show_state = await service.get_or_create_state(user.id, item.show_id)
            if show_state.status not in (WatchStatus.COMPLETED, WatchStatus.DROPPED):
                show_state.status = WatchStatus.WATCHING
            show_state.last_watched_at = now
        await db.commit()
        return {"status": "ok", "action": event, "item": item.title}

    if event == "media.rate":
        rating = metadata.get("userRating")
        if rating is None:
            return {"status": "ignored", "reason": "rate event without a rating"}
        state = await service.get_or_create_state(user.id, item.id)
        state.rating = float(rating)
        state.rating_updated_at = now
        # Record it as the Plex baseline too: this value *came from* Plex, so the
        # next sync must not mistake it for a local edit and push it back.
        state.plex_rating = float(rating)
        state.plex_rating_synced_at = now
        await db.commit()
        return {"status": "ok", "action": "rated", "item": item.title}

    return {"status": "ignored", "reason": f"unhandled event {event!r}"}


def parse_timestamp(value: Any) -> datetime | None:
    if value in (None, "", 0):
        return None
    try:
        return datetime.fromtimestamp(int(value), tz=UTC)
    except (TypeError, ValueError, OSError):
        return None
