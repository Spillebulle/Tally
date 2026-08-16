"""Cast and crew for one title: fetched on demand, then cached in the database.

Why TMDB and not Plex
---------------------
Both know who is in a film. Only TMDB's answer can live on a ``MediaItem``.

A TMDB portrait is an ``image.tmdb.org`` URL that needs no credentials, so it
can be stored and handed straight to a browser. A Plex ``Role`` carries a path
on one particular server, fetchable only with *that viewer's* token — and a
``MediaItem`` row is shared by every Tally account, so storing anything
token-bearing on it leaks the token to all of them. Serving Plex portraits
instead would mean a second artwork proxy and a per-server person mapping, and
it would still return nothing for a watchlist-only title, which has no
``PlexMapping`` at all. Plex credits are also per-server and per-agent, so two
servers holding the same film could disagree about a row that is deliberately
one row for everybody.

The cost of the choice is that an install with no TMDB key gets no cast. That is
the same trade artwork already makes, and it fails visibly (an absent section)
rather than quietly.

When they are fetched
---------------------
On the first request for that item's detail page — never during a library scan.
A scan walks tens of thousands of rows, and a credits call per row would be a
second full pass over the library against a provider that rate-limits; the
reason enrichment already skips episodes. A detail view is one person looking at
one title, and the answer is stored, so a title costs one call ever.

``MediaItem.credits_updated_at`` is what makes "ever" true. Without it, "TMDB
had nothing for this" and "nobody has ever asked" are the same empty list, and
every render of every credit-less title would go back out to TMDB.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import CreditKind, MediaCredit, MediaItem, MediaType, Person, utcnow
from .metadata import MetadataService, get_metadata_service
from .metadata.base import CreditPerson, CreditsResult

log = logging.getLogger(__name__)

# Credits barely change once a title is out, so this is about repairing a bad
# answer rather than tracking a live one — a re-cut cast list, or a fetch made
# while TMDB was rate-limiting.
REFRESH_INTERVAL = timedelta(days=30)

# One in-flight fetch per item. Two browser tabs opening the same detail page
# would otherwise both call TMDB and then both try to insert the same `people`
# row, and the second insert loses to the unique constraint.
_fetches: dict[int, asyncio.Lock] = {}


@asynccontextmanager
async def _one_fetch_at_a_time(item_id: int) -> AsyncIterator[None]:
    if len(_fetches) > 512:
        # Bounded. A lock only matters while a fetch is in flight, so dropping
        # the idle ones cannot strand anybody who is waiting on one.
        for key, idle in [(k, v) for k, v in _fetches.items() if not v.locked()]:
            if _fetches.get(key) is idle:
                _fetches.pop(key, None)
    lock = _fetches.setdefault(item_id, asyncio.Lock())
    async with lock:
        yield


def _is_due(fetched_at) -> bool:
    return fetched_at is None or fetched_at < utcnow() - REFRESH_INTERVAL


async def credits_for(
    db: AsyncSession,
    item: MediaItem,
    *,
    metadata_service: MetadataService | None = None,
) -> list[tuple[MediaCredit, Person]]:
    """Every stored credit for an item, fetching them first if they are due."""
    if item.media_type not in (MediaType.MOVIE, MediaType.SHOW):
        # Seasons and episodes are reached through their show, and enriching
        # them individually is exactly the cost this design avoids.
        return []

    if _is_due(item.credits_updated_at):
        async with _one_fetch_at_a_time(item.id):
            # Re-read rather than trust the in-memory row: whoever held the lock
            # first has a different session, so this object is stale by now.
            stamped = await db.scalar(
                select(MediaItem.credits_updated_at).where(MediaItem.id == item.id)
            )
            if _is_due(stamped):
                await _fetch(db, item, metadata_service or get_metadata_service())

    return await stored_credits(db, item.id)


async def stored_credits(
    db: AsyncSession, item_id: int
) -> list[tuple[MediaCredit, Person]]:
    rows = await db.execute(
        select(MediaCredit, Person)
        .join(Person, Person.id == MediaCredit.person_id)
        .where(MediaCredit.media_item_id == item_id)
        .order_by(MediaCredit.ordering.asc(), MediaCredit.id.asc())
    )
    return list(rows.all())


async def _fetch(
    db: AsyncSession, item: MediaItem, service: MetadataService
) -> None:
    if not service.tmdb.enabled or not item.tmdb_id:
        # Nothing to ask, so nothing is spent and nothing is stamped: an item
        # that picks up a tmdb id from a later enrichment — or an install that
        # gains a TMDB key — should work the moment it does, not a month later.
        return

    try:
        result = await service.tmdb.credits(
            item.tmdb_id, is_show=item.media_type == MediaType.SHOW
        )
    except Exception as exc:
        # Leave the stamp alone so the next view tries again; the provider's own
        # circuit breaker is what stops an outage costing a call per render.
        log.warning("Could not fetch credits for %r: %s", item.title, exc)
        return

    # Stamped even when the answer was nothing. A title TMDB has no credits for
    # is the case this exists to stop re-asking about.
    item.credits_updated_at = utcnow()
    if result is not None:
        await _replace(db, item, result)
    await db.commit()


async def _replace(db: AsyncSession, item: MediaItem, result: CreditsResult) -> None:
    people = await _upsert_people(db, [*result.cast, *result.directors])

    # Derived data, so replacing it wholesale is safe — nothing a user typed
    # lives on these rows. Deleting first is also what keeps a re-fetch from
    # colliding with the (item, person, kind) constraint.
    await db.execute(delete(MediaCredit).where(MediaCredit.media_item_id == item.id))
    await db.flush()

    for kind, credits in (
        (CreditKind.CAST, result.cast),
        (CreditKind.DIRECTOR, result.directors),
    ):
        for credit in credits:
            person = people.get(credit.provider_id)
            if person is None:
                continue
            db.add(
                MediaCredit(
                    media_item_id=item.id,
                    person_id=person.id,
                    kind=kind,
                    character=credit.character,
                    ordering=credit.ordering,
                )
            )
    await db.flush()


async def _upsert_people(
    db: AsyncSession, credits: Iterable[CreditPerson]
) -> dict[int, Person]:
    """Resolve provider person ids to `people` rows, creating what is missing."""
    wanted: dict[int, CreditPerson] = {}
    for credit in credits:
        # First mention wins the name; later ones only fill in a portrait.
        existing = wanted.get(credit.provider_id)
        if existing is None:
            wanted[credit.provider_id] = credit
        elif credit.profile_url and not existing.profile_url:
            existing.profile_url = credit.profile_url
    if not wanted:
        return {}

    rows = await db.execute(select(Person).where(Person.tmdb_id.in_(wanted)))
    found = {person.tmdb_id: person for person in rows.scalars()}

    for tmdb_id, credit in wanted.items():
        person = found.get(tmdb_id)
        if person is None:
            person = Person(
                tmdb_id=tmdb_id, name=credit.name, profile_url=credit.profile_url
            )
            db.add(person)
            found[tmdb_id] = person
        else:
            person.name = credit.name or person.name
            person.profile_url = credit.profile_url or person.profile_url
    await db.flush()
    return found
