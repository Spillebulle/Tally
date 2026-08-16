"""What counts towards finishing a series.

One definition, because there are three places that compute "how far through
this show am I" and they sit on different screens: `serializers.episode_progress`
(the item page and Continue Watching), `sync_service.recompute_show_state` (the
`COMPLETED` status, and therefore the badge on a card), and
`routers/stats._show_completion` (the Series progress block). Two of those
disagreeing is not a cosmetic problem — one screen says a series is finished and
another says 94%, and neither is obviously the wrong one.

**Specials do not count.** Season 0 is where Plex files a Christmas episode, a
recap, a behind-the-scenes reel and the six webisodes nobody has ever seen.
Counting them means a viewer who watched every episode of a show is told they
are at 88% and the series never leaves "still going". They stay tracked,
browsable and playable exactly as before — this changes what *completion* is
measured against, nothing else — and every caller takes an
`include_specials` flag so the Series progress block can offer the other answer.

Two details are easy to get wrong:

* **An episode with no season number is not a special.** Plex leaves `parentIndex`
  off some rows, and `NULL = 0` is NULL in SQL — a `season_number != 0` filter
  would drop those rows from the numerator *and* the denominator, silently. So
  the comparison goes through `coalesce(season_number, 1)`, which is the same
  reading `library._next_unwatched_episode` already makes when it decides what
  "up next" is.

* **The denominator has a second source.** `MediaItem.leaf_count` is Plex's own
  episode count for the show and it counts specials, so subtracting season-0
  plays from the numerator alone would understate every series that has any.
  `specials_held` counts the season-0 episode rows Tally holds and
  `countable_total` takes them off — guarded, so a `leaf_count` that clearly
  did not include them (it is not larger than the specials we hold) is left
  alone rather than driven negative. A show Tally holds no episode rows for —
  history-only, no longer on any server — has no specials to subtract and its
  total is unchanged, which is the honest answer rather than a guess.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import MediaItem, MediaType

#: Plex files specials under season 0. There is no other marker for them.
SPECIALS_SEASON = 0


def _season_of(model: Any):
    """The season number of an episode row, with "unplaced" read as season 1.

    See the module docstring: `NULL != 0` is NULL, so an unplaced episode would
    be dropped by a naive comparison instead of counted.
    """
    return func.coalesce(model.season_number, SPECIALS_SEASON + 1)


def specials_condition(model: Any = MediaItem):
    """True for a special. Takes an alias so a joined query can use it too."""
    return _season_of(model) == SPECIALS_SEASON


def episode_conditions(model: Any = MediaItem, *, include_specials: bool = False) -> list:
    """What an episode row must satisfy to count towards completion."""
    conditions = [model.media_type == MediaType.EPISODE]
    if not include_specials:
        conditions.append(_season_of(model) != SPECIALS_SEASON)
    return conditions


async def specials_held(
    db: AsyncSession, show_ids: Iterable[int]
) -> dict[int, int]:
    """How many season-0 episodes Tally holds, per show.

    One grouped query for every show a caller is about, never one per show —
    the Series progress block asks about the whole watched catalogue at once.
    Shows with no specials are simply absent from the answer.
    """
    ids = [show_id for show_id in show_ids if show_id]
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(MediaItem.show_id, func.count(MediaItem.id))
            .where(
                MediaItem.show_id.in_(ids),
                MediaItem.media_type == MediaType.EPISODE,
                specials_condition(),
            )
            .group_by(MediaItem.show_id)
        )
    ).all()
    return {show_id: int(count) for show_id, count in rows}


def countable_total(
    leaf_count: int | None, specials: int, *, include_specials: bool = False
) -> int | None:
    """Plex's episode total for a show, less the specials it includes.

    Returns None for "no usable total", which is what `ShowProgress` already
    reports as an unknown percentage rather than as a clamped 100%.
    """
    if not leaf_count:
        return None
    if include_specials or not specials:
        return leaf_count
    # Guarded rather than assumed: if Plex's total is not larger than the
    # specials we hold, it plainly did not include them and there is nothing to
    # take off. Subtracting anyway would invent a smaller denominator and
    # report a series as more finished than it is.
    if leaf_count > specials:
        return leaf_count - specials
    return leaf_count
