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

# One poll queries every linked server over the network, so it takes a second or
# more in practice. Scheduling them closer together than this cannot work: with
# max_instances=1 the extra runs are skipped, and APScheduler logs a warning for
# every skip, which floods the log while polling no more often than it manages
# anyway.
MIN_SESSIONS_POLL_SECONDS = 5

# APScheduler's IntervalTrigger silently rewrites a zero interval to one second,
# so SYNC_INTERVAL_MINUTES=0 scheduled a full multi-user Plex sync every second
# rather than the "off" it reads as. Clamp it the way the sessions poll is.
MIN_SYNC_INTERVAL_MINUTES = 5


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
        user_ids = [user.id for user in result.scalars()]

    # A session per user, not one shared across all of them: an exception
    # mid-poll leaves the session needing a rollback, and every later user in
    # the same tick then failed too — silently, because this was logged at
    # debug. One user's unreachable server should not stop everyone else's
    # Continue Watching from updating.
    for user_id in user_ids:
        try:
            async with session_scope() as db:
                user = await db.get(User, user_id)
                if user is not None:
                    await SyncService(db).poll_sessions(user)
        except Exception as exc:
            log.warning("Session poll failed for user %s: %s", user_id, exc)


def start_scheduler() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is not None:
        return _scheduler

    poll_seconds = settings.sessions_poll_seconds
    if poll_seconds < MIN_SESSIONS_POLL_SECONDS:
        log.warning(
            "SESSIONS_POLL_SECONDS=%s is below the %s second minimum — using %s. "
            "A poll takes about a second per linked server, so a shorter "
            "interval only produces skipped runs and load on Plex.",
            poll_seconds,
            MIN_SESSIONS_POLL_SECONDS,
            MIN_SESSIONS_POLL_SECONDS,
        )
        poll_seconds = MIN_SESSIONS_POLL_SECONDS

    sync_minutes = settings.sync_interval_minutes
    if sync_minutes < MIN_SYNC_INTERVAL_MINUTES:
        log.warning(
            "SYNC_INTERVAL_MINUTES=%s is below the %s minute minimum — using %s. "
            "Zero in particular does not disable the sync: APScheduler reads it "
            "as a one-second interval.",
            sync_minutes,
            MIN_SYNC_INTERVAL_MINUTES,
            MIN_SYNC_INTERVAL_MINUTES,
        )
        sync_minutes = MIN_SYNC_INTERVAL_MINUTES

    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        _periodic_sync,
        IntervalTrigger(minutes=sync_minutes),
        id="periodic_sync",
        # A slow first sync must not queue up a backlog of overlapping runs.
        max_instances=1,
        coalesce=True,
        misfire_grace_time=300,
    )
    scheduler.add_job(
        _poll_sessions,
        IntervalTrigger(seconds=poll_seconds),
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
        poll_seconds,
    )
    return scheduler


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
