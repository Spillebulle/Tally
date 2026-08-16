"""Collapse media items that are the same title recorded under two identities.

Tally used to give a watchlist entry a different `guid_key` from the library row
for the same film: a library scan asks Plex for guids and gets `tmdb:movie:603`,
while the Discover watchlist was fetched without them and fell back to the bare
`plex://` ratingKey. Both rows then picked up the *same* tmdb id from
enrichment, but by then their identities were fixed — so the grid showed
everything on your watchlist twice, and the phantom half had no Plex mapping and
therefore no artwork.

`upsert_from_discover` no longer produces those rows. This repairs the ones
already in the database.

It runs unattended on startup, so it is deliberately timid:

* **Only an external id merges two rows.** Same tmdb id, or same imdb id, and
  the same media type. Never a title, never a year — "101 Dalmatians" is two
  different films and no automatic pass should have to guess which.
* **A matching title is required on top of it**, because a wrong id does get
  attached. Rows sharing an id are partitioned by title and each partition is
  merged on its own, so one row carrying somebody else's id is left behind
  rather than blocking the pair it landed among.
* **The row Plex knows about wins**, because it is the one with mappings and
  artwork. Failing that, the older row wins.
* **Nothing is discarded.** History, ratings, watchlist entries and mappings are
  moved to the survivor first; where both rows hold a value the survivor's is
  kept and its gaps are filled from the loser.
* **Idempotent.** Once merged there is nothing left to match, so the next start
  is a no-op.
"""
from __future__ import annotations

import logging
from collections import defaultdict

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    MediaItem,
    PlexMapping,
    UserMediaState,
    WatchEvent,
    WatchlistEntry,
)
from .services.titles import normalise_title

log = logging.getLogger(__name__)

# Copied from loser to survivor only where the survivor has nothing. The
# survivor is the Plex-backed row, so its values are the more trustworthy ones.
_FILLABLE = (
    "overview",
    "tagline",
    "poster_url",
    "backdrop_url",
    "discover_thumb_path",
    "discover_art_path",
    "runtime_minutes",
    "content_rating",
    "studio",
    "network",
    "release_status",
    "first_aired",
    "community_rating",
    "year",
    "sort_title",
    "original_title",
    "tmdb_id",
    "tvdb_id",
    "imdb_id",
    "mal_id",
    "anilist_id",
    "anime_format",
)


async def _duplicate_groups(db: AsyncSession) -> list[list[int]]:
    """Item ids sharing one external id and media type, most specific first.

    tmdb first, then tvdb, then imdb over whatever is left — an item merged on
    one pass must not be gathered up again by a later one in the same run.

    tvdb earns its place because shows are frequently tvdb-keyed: a show whose
    duplicate pair carries no tmdb or imdb id was previously never collapsed,
    even though `tvdb_id` is already in `_FILLABLE`. The `_title_partitions`
    guard applies to every pass equally, so a wrong id alone still cannot fuse
    two unrelated rows.
    """
    groups: list[list[int]] = []
    claimed: set[int] = set()

    for column in (MediaItem.tmdb_id, MediaItem.tvdb_id, MediaItem.imdb_id):
        rows = await db.execute(
            select(MediaItem.media_type, column, func.group_concat(MediaItem.id))
            .where(column.is_not(None))
            .group_by(MediaItem.media_type, column)
            .having(func.count(MediaItem.id) > 1)
        )
        for _media_type, _value, ids in rows:
            members = [int(part) for part in str(ids).split(",") if part]
            members = [item_id for item_id in members if item_id not in claimed]
            if len(members) > 1:
                claimed.update(members)
                groups.append(members)
    return groups


def _title_partitions(items: list[MediaItem]) -> list[list[MediaItem]]:
    """Split rows sharing an external id into runs that agree on the title.

    A shared external id is *nearly* proof, but not quite: enrichment can attach
    the wrong tmdb id, and real data shows it happening — one instance had two
    rows for "Seven" (1995) carrying tmdb 807 and 966. If a wrong id can be
    assigned once it can be assigned twice, and two unrelated films fused
    together would silently take one's history with it. So the title has to
    agree as well.

    This used to veto the whole group when any member disagreed, and that was
    too blunt. A wrong id does not only create a pair — it *joins* a pair that
    was otherwise sound, and then blocked it. Five duplicates on a live instance
    were held open by a third row that had no business in the group at all: the
    two "Thelma & Louise" rows could not merge because a ghost titled "Thelma"
    had been enriched onto tmdb 1541; the two "Pokémon" rows could not merge
    because Plex's own agent had given "Pokémon: To Be a Pokémon Master" the
    parent series' tmdb id.

    Partitioning is no less careful than vetoing: two rows still only merge when
    their titles match exactly once normalised, and the odd one out is simply
    left alone instead of taking the others down with it. The remaining cost is
    a missed merge when the two sides spell it differently ("Se7en" and
    "Seven"), which leaves a visible duplicate — much the cheaper mistake.
    """
    buckets: dict[str, list[MediaItem]] = defaultdict(list)
    for item in sorted(items, key=lambda item: item.id):
        buckets[normalise_title(item.title)].append(item)
    return list(buckets.values())


async def _pick_survivor(db: AsyncSession, items: list[MediaItem]) -> MediaItem:
    """The row Plex knows about, else the oldest."""
    mapped = set(
        (
            await db.execute(
                select(PlexMapping.media_item_id).where(
                    PlexMapping.media_item_id.in_([item.id for item in items])
                )
            )
        )
        .scalars()
        .all()
    )
    on_plex = [item for item in items if item.id in mapped]
    return min(on_plex or items, key=lambda item: item.id)


async def _absorb_state(db: AsyncSession, survivor_id: int, loser_id: int) -> None:
    """Move per-user state across, merging rather than colliding.

    (user_id, media_item_id) is unique, so a user with a row against both items
    cannot simply be repointed.
    """
    rows = await db.execute(
        select(UserMediaState).where(
            UserMediaState.media_item_id.in_([survivor_id, loser_id])
        )
    )
    by_user: dict[int, dict[int, UserMediaState]] = defaultdict(dict)
    for state in rows.scalars():
        by_user[state.user_id][state.media_item_id] = state

    for states in by_user.values():
        loser = states.get(loser_id)
        if loser is None:
            continue
        keeper = states.get(survivor_id)
        if keeper is None:
            loser.media_item_id = survivor_id
            continue

        # Both sides have one. Keep the fuller answer for each field rather than
        # letting whichever row happened to survive erase a rating.
        keeper.view_count = max(keeper.view_count or 0, loser.view_count or 0)
        keeper.is_favorite = keeper.is_favorite or loser.is_favorite
        for field in ("rating", "notes", "progress_ms", "duration_ms", "status"):
            if getattr(keeper, field) is None:
                setattr(keeper, field, getattr(loser, field))
        for field in ("last_watched_at", "rating_updated_at"):
            mine, theirs = getattr(keeper, field), getattr(loser, field)
            if theirs and (mine is None or theirs > mine):
                setattr(keeper, field, theirs)
        await db.delete(loser)


async def _absorb_watchlist(db: AsyncSession, survivor_id: int, loser_id: int) -> None:
    """Same shape as state: unique per (user, item), so merge rather than move."""
    rows = await db.execute(
        select(WatchlistEntry).where(
            WatchlistEntry.media_item_id.in_([survivor_id, loser_id])
        )
    )
    by_user: dict[int, dict[int, WatchlistEntry]] = defaultdict(dict)
    for entry in rows.scalars():
        by_user[entry.user_id][entry.media_item_id] = entry

    for entries in by_user.values():
        loser = entries.get(loser_id)
        if loser is None:
            continue
        keeper = entries.get(survivor_id)
        if keeper is None:
            loser.media_item_id = survivor_id
            continue
        # An active entry beats a tombstone: the watchlist row is the one the
        # user actually put there, and it is usually the loser here.
        if loser.active and not keeper.active:
            keeper.active = True
            keeper.removed_at = None
            keeper.added_at = loser.added_at
            keeper.plex_active = keeper.plex_active or loser.plex_active
        await db.delete(loser)


async def merge_duplicate_media_items(db: AsyncSession) -> int:
    """Merge every unambiguous duplicate. Returns how many rows were removed."""
    groups = await _duplicate_groups(db)
    if not groups:
        return 0

    removed = 0
    for member_ids in groups:
        items = list(
            (
                await db.execute(select(MediaItem).where(MediaItem.id.in_(member_ids)))
            )
            .scalars()
            .all()
        )
        if len(items) < 2:
            continue

        for partition in _title_partitions(items):
            if len(partition) < 2:
                log.info(
                    "Not merging item %s (%r): shares an external id with %s but "
                    "not a title",
                    partition[0].id,
                    partition[0].title,
                    sorted(item.id for item in items if item.id != partition[0].id),
                )
                continue
            removed += await _merge_partition(db, partition)

    await db.commit()
    return removed


async def _merge_partition(db: AsyncSession, items: list[MediaItem]) -> int:
    """Fold every row in one agreed-title group into the best of them."""
    removed = 0
    survivor = await _pick_survivor(db, items)
    for loser in items:
        if loser.id == survivor.id:
            continue

        for field in _FILLABLE:
            if getattr(survivor, field, None) in (None, "") and (
                value := getattr(loser, field, None)
            ) not in (None, ""):
                setattr(survivor, field, value)
        if loser.genres and not survivor.genres:
            survivor.genres = loser.genres

        await _absorb_state(db, survivor.id, loser.id)
        await _absorb_watchlist(db, survivor.id, loser.id)

        # These have no per-user uniqueness against the item, so a bulk
        # repoint is safe. Children first: an episode whose show is about to
        # disappear would be cascaded away with it.
        for table, column in (
            (WatchEvent, WatchEvent.media_item_id),
            (PlexMapping, PlexMapping.media_item_id),
            (MediaItem, MediaItem.show_id),
            (MediaItem, MediaItem.parent_id),
        ):
            await db.execute(
                update(table).where(column == loser.id).values(
                    {column.key: survivor.id}
                )
            )

        log.info(
            "Merging duplicate %r: item %s absorbed into %s",
            survivor.title,
            loser.id,
            survivor.id,
        )
        await db.delete(loser)
        removed += 1

    return removed
