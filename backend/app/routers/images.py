"""Artwork proxy for images that Plex will only hand over with a token.

External artwork (TMDB and friends) is a plain public URL the browser fetches
itself. Plex artwork is not, and it comes in two shapes:

* **Discover** — a path relative to `discover.provider.plex.tv`, needing a
  plex.tv account token.
* **A Plex Media Server** — a path under `/photo/:/transcode` on that server,
  needing that user's server token.

Neither token can go in the URL. A `MediaItem` row is shared by every Tally
account, so a token baked into `poster_url` would be handed to every other user
(and into their browser history, and any log in between) — and a plex.tv token
grants full account access. So paths are stored bare and this router fetches
them server-side with whichever token belongs to the account asking.

Proxying also makes artwork work wherever Tally is reachable. A stored URL was
whatever address answered during the sync, so a poster baked with a LAN address
simply failed to load from outside the network.

Paths are only ever read off the item or its mappings, never taken from the
caller, so this is not an open proxy.
"""
from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import and_, select

from ..deps import CurrentUser, DbSession
from ..models import MediaItem, PlexMapping, PlexServer, User, UserServerAccess
from ..security import decrypt_secret
from ..services.plex_server import PlexServerError
from ..services.plex_tv import DISCOVER, plex_headers
from ..services.sync_service import SyncService

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/images", tags=["images"])

# Artwork at a given path never changes — Plex puts a timestamp in the path, so
# new artwork is a new path. Private, because the response was fetched with the
# viewer's credentials and must not land in a shared cache.
CACHE_CONTROL = "private, max-age=604800"

POSTER = (400, 600)
BACKDROP = (1280, 720)

_TIMEOUT = 15.0


async def _from_plex_servers(
    db: DbSession, user: User, item_id: int, attr: str, size: tuple[int, int]
) -> tuple[bytes, str] | None:
    """Try each Plex server this user can reach that holds artwork for the item."""
    rows = await db.execute(
        select(PlexMapping, PlexServer)
        .join(PlexServer, PlexServer.id == PlexMapping.server_id)
        .join(
            UserServerAccess,
            and_(
                UserServerAccess.server_id == PlexServer.id,
                UserServerAccess.user_id == user.id,
                UserServerAccess.enabled.is_(True),
            ),
        )
        .where(
            PlexMapping.media_item_id == item_id,
            getattr(PlexMapping, attr).is_not(None),
            PlexServer.enabled.is_(True),
        )
    )

    service = SyncService(db)
    width, height = size
    for mapping, server in rows.all():
        client = await service.client_for(user, server)
        if client is None:
            continue
        try:
            fetched = await client.image_bytes(
                getattr(mapping, attr), width=width, height=height
            )
        except PlexServerError as exc:
            # An unreachable server is ordinary here — it must not turn a poster
            # into a 500. Try the next one, then fall through to Discover.
            log.debug("Artwork unavailable on %s: %s", server.name, exc)
            continue
        if fetched:
            return fetched
    return None


async def _from_discover(user: User, path: str) -> tuple[bytes, str] | None:
    token = decrypt_secret(user.plex_token_encrypted)
    if not token:
        return None

    url = f"{DISCOVER}{path if path.startswith('/') else '/' + path}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(url, headers=plex_headers(token))
    except httpx.HTTPError as exc:
        log.debug("Discover artwork fetch failed: %s", exc)
        return None
    if resp.status_code >= 400:
        log.debug("Discover refused artwork: %s", resp.status_code)
        return None
    return resp.content, resp.headers.get("content-type", "image/jpeg")


async def _serve(
    user: User,
    db: DbSession,
    item_id: int,
    *,
    mapping_attr: str,
    discover_attr: str,
    size: tuple[int, int],
) -> Response:
    item = await db.get(MediaItem, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown item")

    # A Plex server first: it is usually on the same network and does not need a
    # round trip to plex.tv. Discover covers what is on no server at all.
    fetched = await _from_plex_servers(db, user, item_id, mapping_attr, size)
    if fetched is None and (path := getattr(item, discover_attr)):
        fetched = await _from_discover(user, path)

    if fetched is None:
        # No artwork anywhere. The poster tile falls back to its gradient.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No artwork for this item")

    content, content_type = fetched
    return Response(
        content=content,
        media_type=content_type,
        headers={"Cache-Control": CACHE_CONTROL},
    )


@router.get("/{item_id}/poster")
async def poster(item_id: int, user: CurrentUser, db: DbSession) -> Response:
    return await _serve(
        user,
        db,
        item_id,
        mapping_attr="thumb_path",
        discover_attr="discover_thumb_path",
        size=POSTER,
    )


@router.get("/{item_id}/backdrop")
async def backdrop(item_id: int, user: CurrentUser, db: DbSession) -> Response:
    return await _serve(
        user,
        db,
        item_id,
        mapping_attr="art_path",
        discover_attr="discover_art_path",
        size=BACKDROP,
    )
