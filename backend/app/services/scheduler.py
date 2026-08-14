"""Background jobs: periodic sync and now-playing polling."""
from __future__ import annotations

import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy import select

from ..config import get_settings
from ..db import session_scope
from ..models import User
from .sync_service import SyncService, sync_all_users

log = logging.getLogger(__name__)
settings = get_settings()

_scheduler: AsyncIOScheduler | None = None


async def _periodic_sync() -> None:
    log.info("Starting scheduled sync")
    async with session_scope() as db:
        await sync_all_users(db, full_history=False)
    log.info("Scheduled sync finished")


async def _poll_sessions() -> None:
    """Cheap, frequent poll so Continue Watching reflects live playback.

    Runs even between full syncs because a 30-minute sync interval would make
    the dashboard feel stale while someone is mid-episode.
    """
    async with session_scope() as db:
        result = await db.execute(
            select(User).where(
                User.is_active.is_(True), User.plex_token_encrypted.is_not(None)
            )
        )
        for user in result.scalars():
            service = SyncService(db)
            try:
                await service.poll_sessions(user)
            except Exception as exc:
                log.debug("Session poll failed for %s: %s", user.username, exc)


def start_scheduler() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is not None:
        return _scheduler

    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        _periodic_sync,
        IntervalTrigger(minutes=settings.sync_interval_minutes),
        id="periodic_sync",
        # A slow first sync must not queue up a backlog of overlapping runs.
        max_instances=1,
        coalesce=True,
        misfire_grace_time=300,
    )
    scheduler.add_job(
        _poll_sessions,
        IntervalTrigger(seconds=settings.sessions_poll_seconds),
        id="poll_sessions",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=30,
    )
    scheduler.start()
    _scheduler = scheduler
    log.info(
        "Scheduler started (sync every %s min, sessions every %s s)",
        settings.sync_interval_minutes,
        settings.sessions_poll_seconds,
    )
    return scheduler


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
