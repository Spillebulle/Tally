"""The duplicate merge deletes rows unattended on startup, so it is pinned hard."""
import pytest
from sqlalchemy import func, select

from app.merge_duplicates import merge_duplicate_media_items
from app.models import (
    MediaItem,
    MediaType,
    PlexMapping,
    PlexServer,
    User,
    UserMediaState,
    WatchEvent,
    WatchlistEntry,
    WatchSource,
    utcnow,
)
from app.security import encrypt_secret

pytestmark = pytest.mark.asyncio


async def _server(db) -> PlexServer:
    server = PlexServer(
        machine_identifier="m1",
        name="Basement",
        base_url="https://plex.example:32400",
        access_token_encrypted=encrypt_secret("token") or "",
    )
    db.add(server)
    await db.flush()
    return server


async def test_the_plex_backed_row_survives_and_absorbs_everything(db):
    """The real case: a watchlist phantom collapsing into the library row."""
    user = User(username="sam")
    server = await _server(db)
    db.add(user)
    await db.flush()

    library_row = MediaItem(
        guid_key="tmdb:movie:300671",
        media_type=MediaType.MOVIE,
        title="13 Hours",
        year=2016,
        tmdb_id=300671,
        poster_url=None,
    )
    phantom = MediaItem(
        guid_key="plex:5d776be1",
        media_type=MediaType.MOVIE,
        title="13 Hours",
        year=2016,
        tmdb_id=300671,
        poster_url="https://image.tmdb.org/t/p/w500/x.jpg",
        overview="From enrichment.",
    )
    db.add_all([library_row, phantom])
    await db.flush()

    # Only the library row is on Plex; only the phantom carries the user's data.
    db.add_all(
        [
            PlexMapping(
                media_item_id=library_row.id, server_id=server.id, rating_key="42"
            ),
            UserMediaState(
                user_id=user.id, media_item_id=phantom.id, rating=9.0, view_count=2
            ),
            WatchlistEntry(
                user_id=user.id,
                media_item_id=phantom.id,
                added_at=utcnow(),
                source="plex",
                active=True,
            ),
            WatchEvent(
                user_id=user.id,
                media_item_id=phantom.id,
                watched_at=utcnow(),
                source=WatchSource.MANUAL,
                dedupe_key="manual:abc",
            ),
        ]
    )
    await db.commit()

    assert await merge_duplicate_media_items(db) == 1

    # The Plex-backed row is the one that lives, because it has the mapping.
    remaining = (await db.execute(select(MediaItem))).scalars().all()
    assert [item.id for item in remaining] == [library_row.id]

    # Nothing the user did was lost.
    state = (await db.execute(select(UserMediaState))).scalars().one()
    assert state.media_item_id == library_row.id
    assert state.rating == 9.0
    assert (await db.execute(select(WatchEvent))).scalars().one().media_item_id == (
        library_row.id
    )
    assert (await db.execute(select(WatchlistEntry))).scalars().one().media_item_id == (
        library_row.id
    )
    # And gaps in the survivor were filled from the row that had them.
    await db.refresh(library_row)
    assert library_row.poster_url == "https://image.tmdb.org/t/p/w500/x.jpg"
    assert library_row.overview == "From enrichment."


async def test_a_user_with_state_on_both_rows_is_merged_not_crashed(db):
    """(user, item) is unique, so the loser's row cannot simply be repointed."""
    user = User(username="sam")
    db.add(user)
    await db.flush()

    keeper = MediaItem(
        guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Heat", tmdb_id=1
    )
    loser = MediaItem(
        guid_key="plex:abc", media_type=MediaType.MOVIE, title="Heat", tmdb_id=1
    )
    db.add_all([keeper, loser])
    await db.flush()
    db.add_all(
        [
            # Watched here, rated there.
            UserMediaState(
                user_id=user.id,
                media_item_id=keeper.id,
                view_count=1,
                last_watched_at=utcnow(),
            ),
            UserMediaState(
                user_id=user.id, media_item_id=loser.id, rating=8.0, is_favorite=True
            ),
        ]
    )
    await db.commit()

    assert await merge_duplicate_media_items(db) == 1

    state = (await db.execute(select(UserMediaState))).scalars().one()
    assert state.media_item_id == keeper.id
    # Both halves survive the merge.
    assert state.rating == 8.0
    assert state.view_count == 1
    assert state.is_favorite is True


async def test_only_an_external_id_merges_rows(db):
    """Never on title. "101 Dalmatians" is two films and guessing is worse."""
    db.add_all(
        [
            MediaItem(
                guid_key="a",
                media_type=MediaType.MOVIE,
                title="101 Dalmatians",
                year=1961,
            ),
            MediaItem(
                guid_key="b",
                media_type=MediaType.MOVIE,
                title="101 Dalmatians",
                year=1996,
            ),
            # Same title, same year, no ids at all — still not merged.
            MediaItem(guid_key="c", media_type=MediaType.MOVIE, title="Untitled"),
            MediaItem(guid_key="d", media_type=MediaType.MOVIE, title="Untitled"),
            # Same tmdb id but different media types are different things.
            MediaItem(
                guid_key="e", media_type=MediaType.MOVIE, title="Fargo", tmdb_id=275
            ),
            MediaItem(
                guid_key="f", media_type=MediaType.SHOW, title="Fargo", tmdb_id=275
            ),
        ]
    )
    await db.commit()

    assert await merge_duplicate_media_items(db) == 0
    assert await db.scalar(select(func.count(MediaItem.id))) == 6


async def test_a_shared_id_with_different_titles_is_not_merged(db):
    """Enrichment can attach the wrong tmdb id, so the id alone is not proof.

    Fusing two unrelated films would silently take one's history with it, which
    is far worse than leaving a duplicate on screen.
    """
    db.add_all(
        [
            MediaItem(
                guid_key="tmdb:movie:807",
                media_type=MediaType.MOVIE,
                title="Se7en",
                tmdb_id=807,
            ),
            MediaItem(
                guid_key="plex:other",
                media_type=MediaType.MOVIE,
                title="Something Else Entirely",
                tmdb_id=807,
            ),
        ]
    )
    await db.commit()

    assert await merge_duplicate_media_items(db) == 0
    assert await db.scalar(select(func.count(MediaItem.id))) == 2


async def test_punctuation_and_case_do_not_block_a_merge(db):
    """The title check normalises, so it does not fail on cosmetics."""
    db.add_all(
        [
            MediaItem(
                guid_key="tmdb:movie:11",
                media_type=MediaType.MOVIE,
                title="Wall·E",
                tmdb_id=11,
            ),
            MediaItem(
                guid_key="plex:walle",
                media_type=MediaType.MOVIE,
                title="wall-e",
                tmdb_id=11,
            ),
        ]
    )
    await db.commit()

    assert await merge_duplicate_media_items(db) == 1


async def test_the_merge_is_idempotent(db):
    db.add_all(
        [
            MediaItem(
                guid_key="tmdb:movie:9",
                media_type=MediaType.MOVIE,
                title="Dune",
                tmdb_id=9,
            ),
            MediaItem(
                guid_key="plex:xyz", media_type=MediaType.MOVIE, title="Dune", tmdb_id=9
            ),
        ]
    )
    await db.commit()

    assert await merge_duplicate_media_items(db) == 1
    # Nothing left to match, so a second start does nothing.
    assert await merge_duplicate_media_items(db) == 0
    assert await db.scalar(select(func.count(MediaItem.id))) == 1


async def test_children_are_repointed_before_their_parent_disappears(db):
    """Episodes cascade-delete with their show, so they must move first."""
    keeper = MediaItem(
        guid_key="tmdb:show:1", media_type=MediaType.SHOW, title="Severance", tmdb_id=1
    )
    loser = MediaItem(
        guid_key="plex:show", media_type=MediaType.SHOW, title="Severance", tmdb_id=1
    )
    db.add_all([keeper, loser])
    await db.flush()

    episode = MediaItem(
        guid_key="plex:show/s1e1",
        media_type=MediaType.EPISODE,
        title="Good News About Hell",
        show_id=loser.id,
        parent_id=loser.id,
        season_number=1,
        episode_number=1,
    )
    db.add(episode)
    await db.commit()

    assert await merge_duplicate_media_items(db) == 1

    survivors = {item.id for item in (await db.execute(select(MediaItem))).scalars()}
    assert survivors == {keeper.id, episode.id}
    await db.refresh(episode)
    assert episode.show_id == keeper.id
    assert episode.parent_id == keeper.id


async def test_an_active_watchlist_entry_beats_a_tombstone(db):
    """The entry the user actually created is usually on the phantom row."""
    user = User(username="sam")
    db.add(user)
    await db.flush()

    keeper = MediaItem(
        guid_key="tmdb:movie:5", media_type=MediaType.MOVIE, title="Nope", tmdb_id=5
    )
    loser = MediaItem(
        guid_key="plex:nope", media_type=MediaType.MOVIE, title="Nope", tmdb_id=5
    )
    db.add_all([keeper, loser])
    await db.flush()
    db.add_all(
        [
            WatchlistEntry(
                user_id=user.id,
                media_item_id=keeper.id,
                added_at=utcnow(),
                source="manual",
                active=False,
                removed_at=utcnow(),
            ),
            WatchlistEntry(
                user_id=user.id,
                media_item_id=loser.id,
                added_at=utcnow(),
                source="plex",
                active=True,
            ),
        ]
    )
    await db.commit()

    assert await merge_duplicate_media_items(db) == 1

    entry = (await db.execute(select(WatchlistEntry))).scalars().one()
    assert entry.media_item_id == keeper.id
    assert entry.active is True
    assert entry.removed_at is None
