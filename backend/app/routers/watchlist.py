"""Watchlist endpoints, mirrored to the Plex Discover watchlist."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import select

from ..deps import CurrentUser, DbSession
from ..models import MediaItem, WatchlistEntry
from ..schemas import MediaCard, WatchlistAdd, WatchlistEntryOut
from ..security import decrypt_secret
from ..serializers import states_for, to_card
from ..services.media_repo import MediaRepository
from ..services.plex_tv import PlexAuthError, PlexTVClient
from ..services.sync_service import SyncService

router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])


@router.get("", response_model=list[WatchlistEntryOut])
async def list_watchlist(
    db: DbSession,
    user: CurrentUser,
    anime_only: bool = False,
    limit: int = Query(200, ge=1, le=500),
) -> list[WatchlistEntryOut]:
    stmt = (
        select(WatchlistEntry, MediaItem)
        .join(MediaItem, MediaItem.id == WatchlistEntry.media_item_id)
        .where(WatchlistEntry.user_id == user.id, WatchlistEntry.active.is_(True))
        .order_by(WatchlistEntry.added_at.desc())
        .limit(limit)
    )
    if anime_only:
        stmt = stmt.where(MediaItem.is_anime.is_(True))

    rows = (await db.execute(stmt)).all()
    states = await states_for(db, user.id, [item.id for _, item in rows])

    out = []
    for entry, item in rows:
        payload = WatchlistEntryOut.model_validate(entry)
        payload.synced_with_plex = bool(entry.plex_active)
        payload.item = to_card(item, states.get(item.id), on_watchlist=True)
        out.append(payload)
    return out


@router.post("", response_model=WatchlistEntryOut, status_code=status.HTTP_201_CREATED)
async def add_to_watchlist(
    payload: WatchlistAdd, db: DbSession, user: CurrentUser
) -> WatchlistEntryOut:
    item: MediaItem | None = None

    if payload.media_item_id is not None:
        item = await db.get(MediaItem, payload.media_item_id)
    elif payload.plex_guid:
        # Adding something Plex knows about but the user doesn't own yet.
        token = decrypt_secret(user.plex_token_encrypted)
        if not token:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Link a Plex account to add discovered titles"
            )
        item = await _item_from_discover(db, token, payload.plex_guid)

    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    entry = await SyncService(db).add_to_watchlist(user, item)
    out = WatchlistEntryOut.model_validate(entry)
    out.synced_with_plex = bool(entry.plex_active)
    out.item = to_card(item, on_watchlist=True)
    return out


async def _item_from_discover(db, token: str, plex_guid: str) -> MediaItem | None:
    """Resolve a Discover guid into a local canonical item."""
    client = PlexTVClient()
    try:
        entries = await client.get_watchlist(token)
    except PlexAuthError:
        return None

    repo = MediaRepository(db, enrich=True)
    for meta in entries:
        if repo.plex_guid_for(meta) == plex_guid or str(meta.get("guid")) == plex_guid:
            item = await repo.upsert_from_discover(meta)
            await db.commit()
            return item
    return None


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_from_watchlist(
    item_id: int, db: DbSession, user: CurrentUser
) -> Response:
    item = await db.get(MediaItem, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await SyncService(db).remove_from_watchlist(user, item)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/search", response_model=list[MediaCard])
async def search_plex_discover(
    q: str, db: DbSession, user: CurrentUser, limit: int = Query(20, ge=1, le=50)
) -> list[MediaCard]:
    """Search Plex's global catalogue so users can watchlist unowned titles."""
    token = decrypt_secret(user.plex_token_encrypted)
    if not token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Link a Plex account first")

    client = PlexTVClient()
    try:
        results = await client.search_discover(token, q, limit=limit)
    except PlexAuthError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc

    repo = MediaRepository(db, enrich=False)
    cards: list[MediaCard] = []
    for meta in results:
        item = await repo.upsert_from_discover(meta)
        if item is not None:
            cards.append(to_card(item))
    await db.commit()
    return cards
