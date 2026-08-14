"""Two-way sync: which side wins, and does a removal stay removed."""
from datetime import timedelta

import pytest

from app.models import (
    MediaItem,
    MediaType,
    PlexMapping,
    PlexServer,
    User,
    UserMediaState,
    UserServerAccess,
    WatchlistEntry,
    utcnow,
)
from app.security import encrypt_secret
from app.services.sync_service import SyncService, SyncStats

pytestmark = pytest.mark.asyncio


class FakePlexClient:
    """Stands in for a Plex Media Server, recording what was written to it."""

    def __init__(self, metadata: dict | None = None):
        self._metadata = metadata or {}
        self.rated: list[tuple[str, float]] = []
        self.scrobbled: list[str] = []
        self.unscrobbled: list[str] = []

    async def metadata(self, rating_key: str):
        return self._metadata.get(rating_key)

    async def rate(self, rating_key: str, rating: float) -> bool:
        self.rated.append((rating_key, rating))
        return True

    async def scrobble(self, rating_key: str) -> bool:
        self.scrobbled.append(rating_key)
        return True

    async def unscrobble(self, rating_key: str) -> bool:
        self.unscrobbled.append(rating_key)
        return True


async def _fixture_world(db, *, plex_user_rating=None):
    user = User(username="sam", plex_user_id="1", preferences={"sync_ratings": True})
    server = PlexServer(
        machine_identifier="abc123",
        name="Home",
        base_url="http://plex:32400",
        access_token_encrypted=encrypt_secret("token") or "",
    )
    db.add_all([user, server])
    await db.flush()

    db.add(
        UserServerAccess(
            user_id=user.id,
            server_id=server.id,
            access_token_encrypted=encrypt_secret("token") or "",
            plex_account_id=1,
        )
    )
    item = MediaItem(guid_key="tmdb:movie:603", media_type=MediaType.MOVIE, title="The Matrix")
    db.add(item)
    await db.flush()

    db.add(PlexMapping(media_item_id=item.id, server_id=server.id, rating_key="42"))
    await db.commit()

    metadata = {"42": {"ratingKey": "42", "userRating": plex_user_rating}}
    return user, server, item, FakePlexClient(metadata)


async def test_local_rating_change_is_pushed_to_plex(db, monkeypatch):
    user, server, item, fake = await _fixture_world(db, plex_user_rating=None)

    service = SyncService(db)
    monkeypatch.setattr(service, "client_for", lambda *_: _async(fake))

    # User rated it here; Plex has never seen a value.
    state = UserMediaState(
        user_id=user.id, media_item_id=item.id, rating=8.0, rating_updated_at=utcnow()
    )
    db.add(state)
    await db.commit()

    stats = SyncStats()
    await service.sync_ratings(user, server, stats)

    assert fake.rated == [("42", 8.0)]
    assert stats.ratings_pushed == 1
    await db.refresh(state)
    # The pushed value becomes the new baseline, so the next run is a no-op.
    assert state.plex_rating == 8.0


async def test_remote_rating_change_is_pulled_into_tally(db, monkeypatch):
    user, server, item, fake = await _fixture_world(db, plex_user_rating=6.0)

    service = SyncService(db)
    monkeypatch.setattr(service, "client_for", lambda *_: _async(fake))

    stats = SyncStats()
    await service.sync_ratings(user, server, stats)

    assert stats.ratings_pulled == 1
    assert not fake.rated
    state = await service.get_or_create_state(user.id, item.id)
    assert state.rating == 6.0


async def test_agreeing_sides_produce_no_writes(db, monkeypatch):
    user, server, item, fake = await _fixture_world(db, plex_user_rating=8.0)

    service = SyncService(db)
    monkeypatch.setattr(service, "client_for", lambda *_: _async(fake))

    now = utcnow()
    db.add(
        UserMediaState(
            user_id=user.id,
            media_item_id=item.id,
            rating=8.0,
            rating_updated_at=now,
            plex_rating=8.0,
            plex_rating_synced_at=now,
        )
    )
    await db.commit()

    stats = SyncStats()
    await service.sync_ratings(user, server, stats)

    assert not fake.rated
    assert stats.ratings_pushed == 0
    assert stats.ratings_pulled == 0


async def test_conflicting_changes_resolve_to_the_newer_write(db, monkeypatch):
    # Both sides moved away from a baseline of 5. The local edit is newer.
    user, server, item, fake = await _fixture_world(db, plex_user_rating=4.0)

    service = SyncService(db)
    monkeypatch.setattr(service, "client_for", lambda *_: _async(fake))

    now = utcnow()
    db.add(
        UserMediaState(
            user_id=user.id,
            media_item_id=item.id,
            rating=9.0,
            rating_updated_at=now,
            plex_rating=5.0,
            plex_rating_synced_at=now - timedelta(hours=2),
        )
    )
    await db.commit()

    stats = SyncStats()
    await service.sync_ratings(user, server, stats)

    assert fake.rated == [("42", 9.0)]
    assert stats.ratings_pushed == 1


async def test_show_status_follows_episode_completion(db):
    user = User(username="sam")
    db.add(user)
    await db.flush()

    show = MediaItem(guid_key="tmdb:show:1", media_type=MediaType.SHOW, title="Severance")
    db.add(show)
    await db.flush()

    episodes = [
        MediaItem(
            guid_key=f"tmdb:show:1/s1e{n}",
            media_type=MediaType.EPISODE,
            title=f"Episode {n}",
            show_id=show.id,
            season_number=1,
            episode_number=n,
        )
        for n in (1, 2, 3)
    ]
    db.add_all(episodes)
    await db.commit()

    service = SyncService(db)

    await service.record_watch_state(user, episodes[0], utcnow())
    await db.commit()
    state = await service.get_or_create_state(user.id, show.id)
    assert state.status.value == "watching"

    for episode in episodes[1:]:
        await service.record_watch_state(user, episode, utcnow())
    await db.commit()

    await db.refresh(state)
    assert state.status.value == "completed"


async def test_watchlist_removal_is_tombstoned_not_deleted(db):
    """A removal must survive the next pull, or Plex would re-add it forever."""
    user = User(username="sam", preferences={"sync_watchlist": False})
    item = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Nope")
    db.add_all([user, item])
    await db.flush()

    service = SyncService(db)
    await service.add_to_watchlist(user, item)
    await service.remove_from_watchlist(user, item)

    from sqlalchemy import select

    entry = (
        await db.execute(
            select(WatchlistEntry).where(
                WatchlistEntry.user_id == user.id,
                WatchlistEntry.media_item_id == item.id,
            )
        )
    ).scalar_one()

    assert entry.active is False
    assert entry.removed_at is not None


def _async(value):
    """Wrap a value in an awaitable so it can stand in for an async method."""
    async def _inner(*_args, **_kwargs):
        return value

    return _inner()
