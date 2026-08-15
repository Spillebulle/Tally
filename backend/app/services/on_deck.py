"""How long something stays in Continue Watching.

Plex ages items out of On Deck / Continue Watching after a configurable number
of weeks — Settings → Library → "Weeks to consider for On Deck and Continue
Watching", the `onDeckWindow` preference, 16 weeks out of the box. Without it a
show abandoned three years ago sits at the top of the shelf forever.

Tally mirrors the server's value so the two agree, and lets the user override it
per account. `PlexServer.on_deck_window_weeks` is refreshed by the library pass
of each sync; only the owner's token may read `/:/prefs`, so it stays None on a
shared server until the owner syncs.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import PlexServer, User, UserServerAccess, utcnow

# Plex's own default, used when no server has told us its setting.
DEFAULT_WEEKS = 16

PREFERENCE_KEY = "continue_watching_weeks"


async def plex_weeks(db: AsyncSession, user: User) -> int | None:
    """The `onDeckWindow` this user's Plex servers reported, or None.

    With more than one server the most generous window wins — a short window on
    a second server should not hide what the main one still lists.
    """
    return await db.scalar(
        select(func.max(PlexServer.on_deck_window_weeks))
        .join(UserServerAccess, UserServerAccess.server_id == PlexServer.id)
        .where(
            UserServerAccess.user_id == user.id,
            UserServerAccess.enabled.is_(True),
            PlexServer.enabled.is_(True),
        )
    )


async def effective_weeks(db: AsyncSession, user: User) -> int:
    """Window in force for this user. 0 means nothing is ever aged out.

    The account preference wins; None there means "follow Plex". Plex reads 0 as
    "switch On Deck off entirely", but an empty shelf reads as a broken page
    here, so Tally treats 0 as "no cutoff" on both paths and says so in Settings.
    """
    weeks = (user.preferences or {}).get(PREFERENCE_KEY)
    if weeks is None:
        weeks = await plex_weeks(db, user)
    try:
        weeks = int(weeks)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_WEEKS
    return max(weeks, 0)


async def cutoff(db: AsyncSession, user: User) -> datetime | None:
    """Oldest `last_watched_at` still allowed in Continue Watching."""
    weeks = await effective_weeks(db, user)
    if weeks <= 0:
        return None
    return utcnow() - timedelta(weeks=weeks)
