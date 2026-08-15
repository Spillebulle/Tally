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
import time

import httpx
from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select

from ..deps import CurrentUser, DbSession
from ..models import MediaItem, PlexMapping, PlexServer, User
from ..security import decrypt_secret
from ..services.media_repo import artwork_paths
from ..services.plex_server import PlexServerError
from ..services.plex_tv import DISCOVER, plex_headers
from ..services.sync_service import SyncService

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/images", tags=["images"])

# Artwork at a given path never changes — Plex puts a timestamp in the path, so
# new artwork is a new path. Private, because the response was fetched with the
# viewer's credentials and must not land in a shared cache.
CACHE_CONTROL = "private, max-age=604800"

# A 404 is the ordinary answer for an item nothing has artwork for, and every
# render of every page it appears on asks again — each one costing two requests
# to Plex before it can say no. Cache the "no" briefly: the tile shows its
# placeholder either way, and a sync that finds artwork is minutes from being
# believed rather than instantly.
MISSING_CACHE_CONTROL = "private, max-age=600"

POSTER = (400, 600)
BACKDROP = (1280, 720)

_TIMEOUT = 15.0

# Asking Plex where the artwork went costs a metadata request, so it is worth
# doing occasionally per mapping rather than on every render. Only items that
# actually failed to produce artwork ever get an entry here.
_REPAIR_INTERVAL_SECONDS = 900.0
_repair_attempts: dict[tuple[int, str], float] = {}


def reset_repair_state() -> None:
    """Forget which mappings have been re-asked. For tests."""
    _repair_attempts.clear()


def _due_a_repair(mapping_id: int, attr: str) -> bool:
    now = time.monotonic()
    last = _repair_attempts.get((mapping_id, attr))
    if last is not None and now - last < _REPAIR_INTERVAL_SECONDS:
        return False
    _repair_attempts[(mapping_id, attr)] = now
    return True


async def _from_plex_servers(
    db: DbSession, user: User, item_id: int, attr: str, size: tuple[int, int]
) -> tuple[tuple[bytes, str] | None, bool]:
    """Try each Plex server this user can reach that holds artwork for the item.

    Reachability is left entirely to `client_for`, which returns None unless the
    user has an access row *or* owns the server. Repeating the check here as a
    join was both redundant and stricter than the real rule: an owner whose
    UserServerAccess row is missing — the case `client_for` falls back for — got
    no artwork at all.
    """
    # Mappings with no stored path are included on purpose — see the repair below.
    rows = await db.execute(
        select(PlexMapping, PlexServer)
        .join(PlexServer, PlexServer.id == PlexMapping.server_id)
        .where(
            PlexMapping.media_item_id == item_id,
            PlexServer.enabled.is_(True),
        )
    )

    service = SyncService(db)
    width, height = size
    tried = False
    repaired = False
    for mapping, server in rows.all():
        client = await service.client_for(user, server)
        if client is None:
            continue
        tried = True

        path = getattr(mapping, attr)
        if path:
            try:
                fetched = await client.image_bytes(path, width=width, height=height)
            except PlexServerError as exc:
                # An unreachable server is ordinary here — it must not turn a
                # poster into a 500, and there is nothing to repair while it is
                # unreachable. Try the next one, then fall through to Discover.
                log.info("Artwork unavailable on %s: %s", server.name, exc)
                continue
            if fetched:
                return fetched, True

        # Either nothing is stored, or what is stored no longer resolves. Those
        # are the same repairable fault and were not treated as one:
        #
        # * Nothing stored — a library scan only records what its payload
        #   carried, and an item Plex had not finished generating artwork for
        #   keeps a null path until something rescans it.
        # * Stored but dead — a Plex artwork path carries a timestamp, so
        #   replacing a poster in Plex makes the old path 404 while the new one
        #   sits there unrecorded.
        #
        # Both leave a permanently blank tile for one particular title while
        # everything around it is fine, and both are answered by the same single
        # metadata call. Only the first was being asked.
        if not _due_a_repair(mapping.id, attr):
            continue
        try:
            meta = await client.metadata(mapping.rating_key)
        except PlexServerError as exc:
            log.info("Could not refresh artwork path on %s: %s", server.name, exc)
            continue
        if not meta:
            continue

        thumb, art = artwork_paths(meta)
        if thumb and thumb != mapping.thumb_path:
            mapping.thumb_path = thumb
            repaired = True
        if art and art != mapping.art_path:
            mapping.art_path = art
            repaired = True

        fresh = getattr(mapping, attr)
        if not fresh or fresh == path:
            continue
        log.info("Recovered %s for item %s from %s", attr, item_id, server.name)
        try:
            fetched = await client.image_bytes(fresh, width=width, height=height)
        except PlexServerError as exc:
            log.info("Artwork unavailable on %s: %s", server.name, exc)
            continue
        if fetched:
            await db.commit()
            return fetched, True

    if repaired:
        await db.commit()
    return None, tried


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
    fetched, tried_plex = await _from_plex_servers(db, user, item_id, mapping_attr, size)
    discover_path = getattr(item, discover_attr)
    if fetched is None and discover_path:
        fetched = await _from_discover(user, discover_path)

    if fetched is None:
        # No artwork. The tile falls back to its gradient either way, so the log
        # line is the only thing that distinguishes "Tally has no path stored
        # for this" from "every source Tally asked turned it down" — which need
        # completely different fixes.
        log.info(
            "No %s for %r (item %s): %s",
            mapping_attr,
            item.title,
            item_id,
            "no stored artwork path on any reachable server"
            if not tried_plex and not discover_path
            else "every source refused it",
        )
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "No artwork for this item",
            headers={"Cache-Control": MISSING_CACHE_CONTROL},
        )

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
