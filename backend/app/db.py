"""Database engine, session factory and schema bootstrap."""
from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from .config import get_settings
from .models import Base, utcnow

log = logging.getLogger(__name__)
settings = get_settings()

engine = create_async_engine(
    settings.database_url,
    echo=False,
    future=True,
    # SQLite + async: keep a modest pool, WAL makes concurrent readers cheap.
    pool_pre_ping=True,
)


@event.listens_for(engine.sync_engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record):  # pragma: no cover - driver hook
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA busy_timeout=10000")
    cur.close()


SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _run_light_migrations()
    await _close_interrupted_sync_runs()
    await _recover_release_name_titles()
    await _merge_duplicates()
    log.info("Database ready at %s", settings.db_path)


async def _close_interrupted_sync_runs() -> None:
    """Fail any sync that was still running when the process last stopped.

    A run is marked finished in `full_sync`'s `finally`, which a hard kill —
    `docker stop` past its timeout, an OOM, a power cut — never reaches. The
    row then stays `finished_at IS NULL` forever, and since that is exactly
    what `trigger_sync` treats as "already running", the user's sync button
    answers `already_running` for the rest of the install's life with no UI
    path to recover. Cancelling does not help either: it sets a flag that no
    worker is left to read.

    Nothing can be running yet at this point in startup, so every open row is
    by definition an orphan.
    """
    from sqlalchemy import select

    from .models import SyncRun, SyncStatus

    async with session_scope() as db:
        result = await db.execute(select(SyncRun).where(SyncRun.finished_at.is_(None)))
        orphans = list(result.scalars())
        for run in orphans:
            run.status = SyncStatus.FAILED
            run.finished_at = utcnow()
            run.error = run.error or "Interrupted by a restart"
            run.phase = None
    if orphans:
        log.warning(
            "Closed %s sync run(s) left open by an unclean shutdown", len(orphans)
        )


async def _recover_release_name_titles() -> None:
    """Give rows that Plex titled with a filename a real title.

    Plex snapshots watch history under whatever the item was called that day, so
    a file that was unmatched then is recorded forever as
    `The.Jungle.Book.2.2003.1080p.BluRay.H264.AAC-RARBG`. `upsert_from_plex`
    cleans that up now, but it will never run over the rows already stored: the
    history import reads incrementally and never revisits a 2019 play.

    `metadata_updated_at` is cleared along with the title, and that is the point
    of doing this at startup rather than leaving it to `enrich_existing`. The
    backfill only reconsiders a row once a week, so without this the rows would
    sit with their filenames until that window came round — and the whole reason
    they have no artwork is that nobody has ever asked a provider about them
    under a name it could recognise. Now something has changed, so the retry
    budget should start again.

    Idempotent: a recovered title is no longer a release name, so the second run
    finds nothing. Non-destructive in the way that matters — `guid_key` is not
    touched, so no row moves identity and nothing is deleted here.
    """
    from sqlalchemy import select

    from .models import MediaItem
    from .services.release_names import parse_release_name

    try:
        async with session_scope() as db:
            rows = list(
                await db.execute(select(MediaItem.id, MediaItem.title))
            )
            recovered = [
                (item_id, parsed)
                for item_id, title in rows
                if (parsed := parse_release_name(title or "")) is not None
            ]
            for item_id, parsed in recovered:
                item = await db.get(MediaItem, item_id)
                if item is None:
                    continue
                log.info(
                    "Recovering title for item %s: %r -> %r",
                    item.id,
                    item.title,
                    parsed.title,
                )
                item.title = parsed.title
                item.year = item.year or parsed.year
                item.metadata_updated_at = None
    except Exception:
        log.exception("Could not recover filename titles; continuing")
        return
    if recovered:
        log.info("Recovered a real title for %s item(s)", len(recovered))


async def _merge_duplicates() -> None:
    """Collapse items that the old watchlist import recorded twice.

    Needs a session rather than a raw connection, so it sits here instead of in
    `_run_light_migrations`. Failure must not stop the app booting: a duplicate
    row is a cosmetic problem, and refusing to start over one would be worse
    than living with it.
    """
    from .merge_duplicates import merge_duplicate_media_items

    try:
        async with session_scope() as db:
            removed = await merge_duplicate_media_items(db)
    except Exception:
        log.exception("Could not merge duplicate media items; continuing")
        return
    if removed:
        log.info("Merged %s duplicate media item(s) into their originals", removed)


async def _run_light_migrations() -> None:
    """Add columns introduced after a release without a full migration tool.

    Tally ships as a single-file SQLite database that users own; dragging in
    Alembic for a handful of additive columns costs more than it's worth. Each
    entry is idempotent — SQLite raises on a duplicate column and we skip it.

    `_scrub_token_bearing_artwork` is the one exception to "additive only" —
    it clears data rather than adding a column, for a reason set out there.
    """
    additions: list[tuple[str, str, str]] = [
        # (table, column, DDL type + default)
        ("plex_servers", "manual_url", "TEXT"),
        ("plex_servers", "on_deck_window_weeks", "INTEGER"),
        ("media_items", "discover_thumb_path", "TEXT"),
        ("media_items", "discover_art_path", "TEXT"),
        ("media_items", "is_personal_media", "BOOLEAN NOT NULL DEFAULT 0"),
        ("sync_runs", "phase", "VARCHAR(255)"),
        ("sync_runs", "progress_current", "INTEGER NOT NULL DEFAULT 0"),
        ("sync_runs", "progress_total", "INTEGER NOT NULL DEFAULT 0"),
        ("sync_runs", "cancel_requested", "BOOLEAN NOT NULL DEFAULT 0"),
        ("plex_pins", "link_user_id", "INTEGER"),
    ]
    async with engine.begin() as conn:
        for table, column, ddl in additions:
            result = await conn.execute(text(f"PRAGMA table_info({table})"))
            existing = {row[1] for row in result}
            if column not in existing:
                log.info("Migrating: adding %s.%s", table, column)
                await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))

    # Indexes added after a release. `create_all` only creates indexes
    # alongside a table it is creating, so an existing database never gets
    # them. `IF NOT EXISTS` makes each idempotent; the names match what
    # SQLAlchemy would have generated so it does not try to create them twice.
    indexes = [
        ("ix_media_items_created_at", "media_items", "created_at"),
        ("ix_plex_mappings_added_at", "plex_mappings", "added_at"),
    ]
    async with engine.begin() as conn:
        for name, table, column in indexes:
            await conn.execute(
                text(f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({column})")
            )

    await _scrub_token_bearing_artwork()


async def _scrub_token_bearing_artwork() -> None:
    """Drop artwork URLs that carry a Plex token.

    Tally used to store `…/photo/:/transcode?…&X-Plex-Token=…` in
    `media_items.poster_url`. A MediaItem row is read by every Tally account, so
    that handed one user's Plex token to all of them — and the URL was baked
    with whatever address answered during the sync, so it also broke whenever
    the library was opened from a different network.

    Artwork is proxied per viewer now (`routers/images.py`), which only engages
    when the stored URL is empty. These have to go, so this clears data rather
    than adding a column. Nothing is lost: the path itself lives on
    `plex_mappings`, and the affected items show their placeholder gradient
    until the next library scan — within one sync interval.

    Idempotent: once cleared, the UPDATE matches nothing.
    """
    async with engine.begin() as conn:
        result = await conn.execute(
            text(
                "UPDATE media_items SET poster_url = NULL, backdrop_url = NULL "
                "WHERE poster_url LIKE '%X-Plex-Token%' "
                "   OR backdrop_url LIKE '%X-Plex-Token%'"
            )
        )
        if result.rowcount:
            log.info(
                "Migrating: cleared token-bearing artwork URLs on %s item(s); "
                "they are served through /api/images from now on",
                result.rowcount,
            )


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency."""
    async with SessionLocal() as session:
        yield session


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """Standalone session for background jobs, committing on clean exit."""
    async with SessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
