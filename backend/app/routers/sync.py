"""Sync control, server/library management and app settings."""
from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

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
    ServerUpdate,
    SettingsOut,
    SyncRequest,
    SyncRunOut,
    VersionOut,
)
from ..services import on_deck
from ..services.metadata import get_metadata_service
from ..services.plex_server import reset_failure_state
from ..services.sync_service import SyncService

log = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/api", tags=["sync"])

VERSION = __version__


async def _run_sync(
    user_id: int, run_id: int, full_history: bool, scan_libraries: bool
) -> None:
    """Background sync with its own session — the request's is long gone."""
    async with session_scope() as db:
        user = await db.get(User, user_id)
        run = await db.get(SyncRun, run_id)
        if user is None or run is None:
            return
        await SyncService(db).full_sync(
            user, full_history=full_history, scan_libraries=scan_libraries, run=run
        )


@router.post("/sync", response_model=dict, status_code=status.HTTP_202_ACCEPTED)
async def trigger_sync(
    payload: SyncRequest,
    background: BackgroundTasks,
    db: DbSession,
    user: CurrentUser,
) -> dict:
    """Start a sync, and make it *visibly* started before returning.

    The SyncRun row is created here rather than inside the background task, so
    the status endpoint reports "running" as soon as this responds. Created in
    the task instead, the UI's refetch raced it, saw nothing running, dropped
    back to the slow poll, and the progress bar stayed hidden until the user
    reloaded the page.
    """
    existing = await db.scalar(
        select(SyncRun)
        .where(SyncRun.user_id == user.id, SyncRun.finished_at.is_(None))
        .order_by(SyncRun.started_at.desc())
        .limit(1)
    )
    if existing is not None:
        # Already going. Report that rather than starting a second one — now
        # that the row exists up front, a double click would otherwise be two
        # visible runs competing over the same library.
        return {
            "status": "already_running",
            "run_id": existing.id,
            "full_history": existing.kind == "full",
            "scan_libraries": payload.scan_libraries,
        }

    run = SyncRun(
        user_id=user.id, kind="full" if payload.full_history else "incremental"
    )
    run.phase = "Starting"
    db.add(run)
    await db.commit()

    background.add_task(
        _run_sync, user.id, run.id, payload.full_history, payload.scan_libraries
    )
    return {
        "status": "started",
        "run_id": run.id,
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
    running = bool(latest and latest.finished_at is None)
    return {
        "running": running,
        "last_run": SyncRunOut.model_validate(latest).model_dump() if latest else None,
        "last_full_sync_at": user.last_full_sync_at,
        # Only meaningful while running; the UI shows these on hover.
        "run_id": latest.id if latest else None,
        "phase": latest.phase if latest else None,
        "progress_current": latest.progress_current if running else 0,
        "progress_total": latest.progress_total if running else 0,
        "cancel_requested": bool(latest and latest.cancel_requested) if running else False,
    }


@router.post("/sync/cancel", response_model=dict)
async def cancel_sync(db: DbSession, user: CurrentUser) -> dict:
    """Ask the running sync to stop at its next checkpoint.

    Cooperative rather than immediate: the sync finishes the unit of work it is
    in and stops at the next boundary, so nothing is left half-written. That
    can take a few seconds on a slow server.
    """
    result = await db.execute(
        select(SyncRun)
        .where(SyncRun.user_id == user.id, SyncRun.finished_at.is_(None))
        .order_by(SyncRun.started_at.desc())
        .limit(1)
    )
    run = result.scalar_one_or_none()
    if run is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "No sync is running")

    run.cancel_requested = True
    await db.commit()
    return {"cancelling": True, "run_id": run.id}


# ---------------------------------------------------------------------------
# Servers
# ---------------------------------------------------------------------------


@router.get("/servers", response_model=list[ServerOut])
async def list_servers(db: DbSession, user: CurrentUser) -> list[ServerOut]:
    # ServerOut carries `libraries`, so pydantic reads that relationship while
    # validating. It has to be eager-loaded: a lazy load here raises
    # MissingGreenlet under asyncio, which is what made server discovery return
    # a 500. Loading it up front also replaces the previous query-per-server.
    servers = await SyncService(db).servers_for(user, with_libraries=True)
    return [ServerOut.model_validate(server) for server in servers]


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


async def _require_server_access(
    db: AsyncSession, user: User, server_id: int
) -> None:
    """Refuse unless the user can reach this server at all."""
    access = await db.execute(
        select(UserServerAccess).where(
            UserServerAccess.user_id == user.id,
            UserServerAccess.server_id == server_id,
        )
    )
    if access.scalar_one_or_none() is None and not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this server")


@router.patch("/servers/{server_id}", response_model=ServerOut)
async def update_server(
    server_id: int, payload: ServerUpdate, db: DbSession, user: CurrentUser
) -> ServerOut:
    """Pin a connection address, or clear it to resume auto-detection."""
    server = await db.get(PlexServer, server_id)
    if server is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")

    # A PlexServer row is global — one row serves every Tally account, and
    # `client_for` prefers `manual_url` for *every* user of that server. Merely
    # having access is therefore not enough authority to rewrite it: a shared
    # library friend could point the server at a host they control and collect
    # each viewer's own Plex token, which the artwork transcode puts in the
    # query string. Only the owner (or an admin) may move the address.
    if server.owner_user_id != user.id and not user.is_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the owner of this server can change its address",
        )

    fields = payload.model_dump(exclude_unset=True)
    if "manual_url" in fields:
        url = (fields["manual_url"] or "").strip().rstrip("/")
        if url and not url.startswith(("http://", "https://")):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "The address must start with http:// or https://",
            )
        server.manual_url = url or None
        # Point the server at the new address immediately rather than waiting
        # for a probe, and drop any cooldown recorded against the old one so
        # the user's next test is not answered from the backoff.
        if url:
            server.base_url = url
        reset_failure_state()
    if "enabled" in fields and fields["enabled"] is not None:
        server.enabled = fields["enabled"]

    await db.commit()
    await db.refresh(server, ["libraries"])
    return ServerOut.model_validate(server)


@router.post("/servers/{server_id}/test", response_model=dict)
async def test_server(server_id: int, db: DbSession, user: CurrentUser) -> dict:
    server = await db.get(PlexServer, server_id)
    if server is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")

    client = await SyncService(db).client_for(user, server)
    if client is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access token for this server")

    # Pressing Test is an explicit "try again now", so clear any backoff first.
    # Answering a deliberate user action out of the cooldown cache would report
    # a stale failure and look like the button is broken.
    reset_failure_state()
    reachable = await client.ping()
    if reachable and client.working_url:
        server.base_url = client.working_url
        await db.commit()
    return {"reachable": reachable, "url": client.working_url}


@router.patch("/libraries/{library_id}", response_model=LibraryOut)
async def update_library(
    library_id: int,
    payload: LibraryUpdate,
    background: BackgroundTasks,
    db: DbSession,
    user: CurrentUser,
) -> LibraryOut:
    library = await db.get(PlexLibrary, library_id)
    if library is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Library not found")

    await _require_server_access(db, user, library.server_id)

    # exclude_unset, not `is not None`: anime_override is tri-state and null
    # *is* a value — it means "go back to auto-detecting". Treating null as
    # "field omitted" made cycling the chip to auto silently do nothing, so it
    # snapped back to its previous value on the next read.
    fields = payload.model_dump(exclude_unset=True)

    if "enabled" in fields and fields["enabled"] is not None:
        library.enabled = fields["enabled"]

    anime_changed = (
        "anime_override" in fields
        and fields["anime_override"] != library.anime_override
    )
    if "anime_override" in fields:
        library.anime_override = fields["anime_override"]
    await db.commit()

    if anime_changed:
        # Reclassification rewrites every item in the library, so it must not
        # block the response: the override itself is already saved, and holding
        # the request open for it made the UI look frozen for seconds with no
        # indication anything was happening.
        background.add_task(_reclassify_library_task, library_id)
    await db.refresh(library)
    return LibraryOut.model_validate(library)


async def _reclassify_library_task(library_id: int) -> None:
    """Background wrapper — the request's session is gone by the time this runs.

    Nothing awaits the result, so an exception here has nowhere to surface.
    Log it rather than letting it escape as an unhandled task error; the
    override itself is already saved either way.
    """
    try:
        async with session_scope() as scoped:
            library = await scoped.get(PlexLibrary, library_id)
            if library is not None:
                await _reclassify_library(scoped, library)
    except Exception:
        log.exception("Reclassifying library %s failed", library_id)


async def _reclassify_library(db: AsyncSession, library: PlexLibrary) -> None:
    """Re-apply the anime flag to everything in a library after an override change.

    An explicit override is a blanket statement, so it is written straight
    across. Returning to *auto* is not: it means "work it out again", and
    stamping `library_looks_like_anime(title)` over every row instead threw away
    per-item detection — a handful of correctly-detected anime films in a
    "Movies" library were all forced to False, with an `anime_source` claiming
    an override that no longer existed. Cycling the chip yes -> no -> auto to
    undo a mistake destroyed exactly what the user was trying to restore.
    """
    from ..models import PlexMapping

    # Kept as a subquery rather than a list of ids: a large library would blow
    # past SQLite's bound-parameter limit, and this avoids loading every row
    # into memory just to write it straight back.
    mapped_items = select(PlexMapping.media_item_id).where(
        PlexMapping.library_id == library.id
    )

    if library.anime_override is not None:
        values = {
            "is_anime": bool(library.anime_override),
            "anime_source": "library_override",
        }
        await db.execute(
            update(MediaItem).where(MediaItem.id.in_(mapped_items)).values(**values)
        )
        # Seasons and episodes inherit from their show. One statement, where
        # this used to run a separate query for every single show.
        await db.execute(
            update(MediaItem).where(MediaItem.show_id.in_(mapped_items)).values(**values)
        )
        await db.commit()
        return

    # Back to auto: re-run the classifier per item, using what each item already
    # knows. This is metadata Tally has locally, so it costs no API calls.
    #
    # "What each item knows" has to mean *all* of it. This built an `ExternalIds`
    # by hand and passed no `metadata` at all, so the classifier scored on the
    # Plex genre list alone — no origin country, no original language, no TMDB
    # keywords, and no `anilist_id` to force on. Everything except a title
    # tagged with a literal "Anime" genre therefore came back not-anime, and the
    # verdict was written straight across the library. Setting the chip to
    # "auto" was a way to erase anime detection, not to redo it.
    # `stored_signals` is the single reader of those columns.
    from ..services.media_repo import stored_signals
    from ..services.metadata.anime import classify

    result = await db.execute(
        select(MediaItem).where(
            MediaItem.id.in_(mapped_items),
            MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW]),
        )
    )
    for item in result.scalars():
        ids, signals = stored_signals(item)
        verdict = classify(
            genres=item.genres or [],
            ids=ids,
            metadata=signals,
            library_title=library.title,
            library_override=None,
            mal_matched=item.mal_id is not None,
        )
        item.is_anime = verdict.is_anime
        item.anime_source = verdict.source
        await db.execute(
            update(MediaItem)
            .where(MediaItem.show_id == item.id)
            .values(is_anime=verdict.is_anime, anime_source=verdict.source)
        )
    await db.commit()


@router.post("/libraries/{library_id}/scan", status_code=status.HTTP_202_ACCEPTED)
async def scan_library(
    library_id: int, background: BackgroundTasks, db: DbSession, user: CurrentUser
) -> dict:
    library = await db.get(PlexLibrary, library_id)
    if library is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Library not found")
    # Without this, any account could queue a scan of any library and read the
    # title back out of the response — disclosing library names from servers it
    # cannot otherwise see. `update_library` next door has always checked.
    await _require_server_access(db, user, library.server_id)

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


# Where this build came from. Properties of the project rather than of the
# deployment, so they are constants — there is nothing here an operator would
# want to point somewhere else.
GITHUB_URL = "https://github.com/Spillebulle/Tally"
DOCKERHUB_URL = "https://hub.docker.com/r/spillebulle/tally"


@router.get("/version", response_model=VersionOut)
async def app_version() -> VersionOut:
    """Version and project links, for the footer.

    Public, like `/api/health`: the footer renders before anything is signed in,
    and none of this is private — the version is already in the health payload.
    """
    return VersionOut(
        version=VERSION,
        github_url=GITHUB_URL,
        dockerhub_url=DOCKERHUB_URL,
    )


@router.get("/settings", response_model=SettingsOut)
async def get_app_settings(db: DbSession, user: CurrentUser) -> SettingsOut:
    providers = get_metadata_service().providers_configured
    return SettingsOut(
        providers=ProvidersStatus(**providers),
        sync_interval_minutes=settings.sync_interval_minutes,
        webhook_url=f"{settings.public_url.rstrip('/')}/api/webhooks/plex",
        public_url=settings.public_url,
        version=VERSION,
        plex_on_deck_weeks=await on_deck.plex_weeks(db, user),
        continue_watching_weeks=await on_deck.effective_weeks(db, user),
    )


@router.post("/admin/reclassify-anime", status_code=status.HTTP_202_ACCEPTED)
async def reclassify_anime(background: BackgroundTasks, admin: AdminUser) -> dict:
    """Re-run anime detection across the whole library.

    Useful after adding a TMDB/TVDB key, which unlocks signals that weren't
    available during the original import.
    """

    async def run() -> None:
        async with session_scope() as db:
            from ..models import PlexMapping
            from ..services.media_repo import stored_signals
            from ..services.metadata import get_metadata_service as get_service

            service = get_service()
            # Which library each item came from, so the user's override and the
            # library name still count. Without them this re-ran a *weaker*
            # classification than the original import and wrote the result over
            # the top: a user who marked their Anime library "yes", added a TMDB
            # key and pressed Re-detect — the exact sequence the README
            # recommends — had every title whose TMDB record lacks a JP origin
            # silently reclassified as not-anime. Overrides always win.
            library_result = await db.execute(
                select(PlexMapping.media_item_id, PlexLibrary.title, PlexLibrary.anime_override)
                .join(PlexLibrary, PlexLibrary.id == PlexMapping.library_id)
            )
            libraries_by_item = {
                item_id: (lib_title, override)
                for item_id, lib_title, override in library_result
            }

            result = await db.execute(
                select(MediaItem).where(
                    MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW])
                )
            )
            for item in result.scalars():
                # The row's own language, origin country and keywords go in as
                # well as its ids. Without them this pass depended entirely on
                # TMDB answering *again*, and wrote a verdict scored on nothing
                # whenever it did not — an unset key, a rate limit, an open
                # circuit breaker — over one scored on a real answer.
                ids, signals = stored_signals(item)
                library_title, library_override = libraries_by_item.get(
                    item.id, (None, None)
                )
                try:
                    enrichment = await service.enrich(
                        title=item.title,
                        year=item.year,
                        is_show=item.media_type == MediaType.SHOW,
                        ids=ids,
                        plex_genres=item.genres or [],
                        library_title=library_title,
                        library_override=library_override,
                        known=signals,
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
