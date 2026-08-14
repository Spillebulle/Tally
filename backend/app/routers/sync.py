"""Sync control, server/library management and app settings."""
from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, status
from sqlalchemy import select

from .. import __version__
from ..config import get_settings
from ..db import session_scope
from ..deps import AdminUser, CurrentUser, DbSession
from ..models import (
    MediaItem,
    MediaType,
    PlexLibrary,
    PlexServer,
    SyncRun,
    User,
    UserServerAccess,
)
from ..schemas import (
    LibraryOut,
    LibraryUpdate,
    ProvidersStatus,
    ServerOut,
    SettingsOut,
    SyncRequest,
    SyncRunOut,
)
from ..services.metadata import get_metadata_service
from ..services.metadata.anime import library_looks_like_anime
from ..services.sync_service import SyncService

log = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/api", tags=["sync"])

VERSION = __version__


async def _run_sync(user_id: int, full_history: bool, scan_libraries: bool) -> None:
    """Background sync with its own session — the request's is long gone."""
    async with session_scope() as db:
        user = await db.get(User, user_id)
        if user is None:
            return
        await SyncService(db).full_sync(
            user, full_history=full_history, scan_libraries=scan_libraries
        )


@router.post("/sync", response_model=dict, status_code=status.HTTP_202_ACCEPTED)
async def trigger_sync(
    payload: SyncRequest,
    background: BackgroundTasks,
    user: CurrentUser,
) -> dict:
    background.add_task(
        _run_sync, user.id, payload.full_history, payload.scan_libraries
    )
    return {
        "status": "started",
        "full_history": payload.full_history,
        "scan_libraries": payload.scan_libraries,
    }


@router.get("/sync/runs", response_model=list[SyncRunOut])
async def list_sync_runs(
    db: DbSession, user: CurrentUser, limit: int = Query(20, ge=1, le=100)
) -> list[SyncRunOut]:
    result = await db.execute(
        select(SyncRun)
        .where(SyncRun.user_id == user.id)
        .order_by(SyncRun.started_at.desc())
        .limit(limit)
    )
    return [SyncRunOut.model_validate(run) for run in result.scalars()]


@router.get("/sync/status", response_model=dict)
async def sync_status(db: DbSession, user: CurrentUser) -> dict:
    result = await db.execute(
        select(SyncRun)
        .where(SyncRun.user_id == user.id)
        .order_by(SyncRun.started_at.desc())
        .limit(1)
    )
    latest = result.scalar_one_or_none()
    return {
        "running": bool(latest and latest.finished_at is None),
        "last_run": SyncRunOut.model_validate(latest).model_dump() if latest else None,
        "last_full_sync_at": user.last_full_sync_at,
    }


# ---------------------------------------------------------------------------
# Servers
# ---------------------------------------------------------------------------


@router.get("/servers", response_model=list[ServerOut])
async def list_servers(db: DbSession, user: CurrentUser) -> list[ServerOut]:
    service = SyncService(db)
    servers = await service.servers_for(user)

    out: list[ServerOut] = []
    for server in servers:
        result = await db.execute(
            select(PlexLibrary)
            .where(PlexLibrary.server_id == server.id)
            .order_by(PlexLibrary.title)
        )
        payload = ServerOut.model_validate(server)
        payload.libraries = [
            LibraryOut.model_validate(library) for library in result.scalars()
        ]
        out.append(payload)
    return out


@router.post("/servers/discover", response_model=list[ServerOut])
async def discover_servers(db: DbSession, user: CurrentUser) -> list[ServerOut]:
    """Re-query plex.tv for servers this account can reach."""
    service = SyncService(db)
    servers = await service.discover_servers(user)
    if not servers:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "No Plex servers found. Check that your Plex account is linked.",
        )
    return await list_servers(db, user)


@router.post("/servers/{server_id}/test", response_model=dict)
async def test_server(server_id: int, db: DbSession, user: CurrentUser) -> dict:
    server = await db.get(PlexServer, server_id)
    if server is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")

    client = await SyncService(db).client_for(user, server)
    if client is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access token for this server")

    reachable = await client.ping()
    if reachable and client.working_url:
        server.base_url = client.working_url
        await db.commit()
    return {"reachable": reachable, "url": client.working_url}


@router.patch("/libraries/{library_id}", response_model=LibraryOut)
async def update_library(
    library_id: int, payload: LibraryUpdate, db: DbSession, user: CurrentUser
) -> LibraryOut:
    library = await db.get(PlexLibrary, library_id)
    if library is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Library not found")

    access = await db.execute(
        select(UserServerAccess).where(
            UserServerAccess.user_id == user.id,
            UserServerAccess.server_id == library.server_id,
        )
    )
    if access.scalar_one_or_none() is None and not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this server")

    if payload.enabled is not None:
        library.enabled = payload.enabled

    anime_changed = (
        payload.anime_override is not None
        and payload.anime_override != library.anime_override
    )
    if payload.anime_override is not None:
        library.anime_override = payload.anime_override
    await db.commit()

    if anime_changed:
        await _reclassify_library(db, library)
    await db.refresh(library)
    return LibraryOut.model_validate(library)


async def _reclassify_library(db: DbSession, library: PlexLibrary) -> None:
    """Re-apply the anime flag to everything in a library after an override change."""
    from ..models import PlexMapping

    result = await db.execute(
        select(MediaItem)
        .join(PlexMapping, PlexMapping.media_item_id == MediaItem.id)
        .where(PlexMapping.library_id == library.id)
    )
    shows_changed: list[int] = []
    target = library.anime_override
    if target is None:
        target = library_looks_like_anime(library.title)

    for item in result.scalars().unique():
        item.is_anime = bool(target)
        item.anime_source = "library_override"
        if item.media_type == MediaType.SHOW:
            shows_changed.append(item.id)
    await db.flush()

    # Children inherit from their show.
    for show_id in shows_changed:
        children = await db.execute(select(MediaItem).where(MediaItem.show_id == show_id))
        for child in children.scalars():
            child.is_anime = bool(target)
            child.anime_source = "library_override"
    await db.commit()


@router.post("/libraries/{library_id}/scan", status_code=status.HTTP_202_ACCEPTED)
async def scan_library(
    library_id: int, background: BackgroundTasks, db: DbSession, user: CurrentUser
) -> dict:
    library = await db.get(PlexLibrary, library_id)
    if library is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Library not found")

    async def run() -> None:
        async with session_scope() as scoped:
            scoped_user = await scoped.get(User, user.id)
            scoped_library = await scoped.get(PlexLibrary, library_id)
            if scoped_user is None or scoped_library is None:
                return
            server = await scoped.get(PlexServer, scoped_library.server_id)
            if server is None:
                return
            from ..services.sync_service import SyncStats

            await SyncService(scoped).sync_library_items(
                scoped_user, server, scoped_library, SyncStats()
            )

    background.add_task(run)
    return {"status": "started", "library": library.title}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


@router.get("/settings", response_model=SettingsOut)
async def get_app_settings(user: CurrentUser) -> SettingsOut:
    providers = get_metadata_service().providers_configured
    return SettingsOut(
        providers=ProvidersStatus(**providers),
        sync_interval_minutes=settings.sync_interval_minutes,
        webhook_url=f"{settings.public_url.rstrip('/')}/api/webhooks/plex",
        public_url=settings.public_url,
        version=VERSION,
    )


@router.post("/admin/reclassify-anime", status_code=status.HTTP_202_ACCEPTED)
async def reclassify_anime(background: BackgroundTasks, admin: AdminUser) -> dict:
    """Re-run anime detection across the whole library.

    Useful after adding a TMDB/TVDB key, which unlocks signals that weren't
    available during the original import.
    """

    async def run() -> None:
        async with session_scope() as db:
            from ..services.guids import ExternalIds
            from ..services.metadata import get_metadata_service as get_service

            service = get_service()
            result = await db.execute(
                select(MediaItem).where(
                    MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW])
                )
            )
            for item in result.scalars():
                ids = ExternalIds(
                    tmdb_id=item.tmdb_id,
                    tvdb_id=item.tvdb_id,
                    imdb_id=item.imdb_id,
                    mal_id=item.mal_id,
                )
                try:
                    enrichment = await service.enrich(
                        title=item.title,
                        year=item.year,
                        is_show=item.media_type == MediaType.SHOW,
                        ids=ids,
                        plex_genres=item.genres or [],
                    )
                except Exception:
                    continue
                item.is_anime = enrichment.anime.is_anime
                item.anime_source = enrichment.anime.source
                if enrichment.metadata.mal_id and not item.mal_id:
                    item.mal_id = enrichment.metadata.mal_id
                children = await db.execute(
                    select(MediaItem).where(MediaItem.show_id == item.id)
                )
                for child in children.scalars():
                    child.is_anime = item.is_anime
                    child.anime_source = item.anime_source
            await db.commit()

    background.add_task(run)
    return {"status": "started"}
