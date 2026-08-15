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


async def test_discover_artwork_is_kept_as_a_path_not_dropped(db):
    """Regression: watchlist-only titles had no artwork, permanently.

    Discover returns `thumb` as a path relative to its own host, and the old
    code stored it only when it started with "http" — so every watchlist item
    got a null poster. Nothing revisits an item that no library scan can see,
    so it stayed null forever. The path is kept bare on purpose: the token
    needed to fetch it must not be baked into a URL shared by every account.
    """
    from app.services.media_repo import MediaRepository

    repo = MediaRepository(db, enrich=False)
    item = await repo.upsert_from_discover(
        {
            "type": "movie",
            "title": "Sinners",
            "year": 2025,
            "guid": "plex://movie/5d776be17a53e9001e732ab9",
            "thumb": "/library/metadata/5d776be17a53e9001e732ab9/thumb/1735",
            "art": "/library/metadata/5d776be17a53e9001e732ab9/art/1735",
        }
    )
    assert item is not None
    assert item.discover_thumb_path == "/library/metadata/5d776be17a53e9001e732ab9/thumb/1735"
    assert item.discover_art_path == "/library/metadata/5d776be17a53e9001e732ab9/art/1735"
    # Nothing token-bearing was stored as a plain URL.
    assert item.poster_url is None
    assert item.backdrop_url is None

    from app.serializers import backdrop_for, poster_for

    assert poster_for(item) == f"/api/images/{item.id}/poster"
    assert backdrop_for(item) == f"/api/images/{item.id}/backdrop"

    # An absolute URL still goes straight into the column — no proxy needed.
    absolute = await repo.upsert_from_discover(
        {
            "type": "movie",
            "title": "Heat",
            "year": 1995,
            "guid": "plex://movie/5d776b1b9ab5440020ec1c6a",
            "thumb": "https://image.tmdb.org/t/p/w500/heat.jpg",
        }
    )
    assert absolute is not None
    assert absolute.poster_url == "https://image.tmdb.org/t/p/w500/heat.jpg"
    assert absolute.discover_thumb_path is None
    assert poster_for(absolute) == "https://image.tmdb.org/t/p/w500/heat.jpg"


async def test_artwork_is_retried_but_not_on_every_sync(db):
    """An item with no artwork gets another try; one with artwork does not."""
    from datetime import timedelta

    from app.services.media_repo import ARTWORK_RETRY_INTERVAL, MediaRepository

    needs = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="A")
    fresh = MediaItem(guid_key="tmdb:movie:2", media_type=MediaType.MOVIE, title="B")
    done = MediaItem(
        guid_key="tmdb:movie:3",
        media_type=MediaType.MOVIE,
        title="C",
        poster_url="https://image.tmdb.org/t/p/w500/c.jpg",
    )
    stale = utcnow() - ARTWORK_RETRY_INTERVAL - timedelta(days=1)
    needs.metadata_updated_at = stale
    fresh.metadata_updated_at = utcnow()
    done.metadata_updated_at = stale
    db.add_all([needs, fresh, done])
    await db.flush()

    check = MediaRepository._needs_enrichment
    # No artwork and last asked long ago: worth another look.
    assert check(needs, False) is True
    # No artwork, but asked just now — don't hammer the providers.
    assert check(fresh, False) is False
    # Already has a poster: never re-fetched, however old the stamp.
    assert check(done, False) is False
    # Anything brand new is always enriched.
    assert check(fresh, True) is True


async def test_existing_token_bearing_artwork_urls_are_cleared(engine):
    """The migration has to remove already-stored token URLs, not just stop writing them.

    `poster_for` only proxies when the stored URL is empty, so an install that
    already has them would keep serving one user's token to everybody.
    """
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app import db as db_module

    leaky = "https://plex.example:32400/photo/:/transcode?url=%2Fx&X-Plex-Token=abc"
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all(
            [
                MediaItem(
                    guid_key="a",
                    media_type=MediaType.MOVIE,
                    title="Leaky",
                    poster_url=leaky,
                    backdrop_url=leaky,
                ),
                MediaItem(
                    guid_key="b",
                    media_type=MediaType.MOVIE,
                    title="Clean",
                    poster_url="https://image.tmdb.org/t/p/w500/c.jpg",
                ),
            ]
        )
        await session.commit()

    original_engine = db_module.engine
    db_module.engine = engine
    try:
        await db_module._scrub_token_bearing_artwork()
        # Idempotent: a second pass finds nothing left to do.
        await db_module._scrub_token_bearing_artwork()
    finally:
        db_module.engine = original_engine

    async with engine.begin() as conn:
        rows = {
            row[0]: row[1]
            for row in await conn.execute(
                text("SELECT guid_key, poster_url FROM media_items")
            )
        }
    assert rows["a"] is None
    # An external URL carries no credentials and is left exactly as it was.
    assert rows["b"] == "https://image.tmdb.org/t/p/w500/c.jpg"


async def test_scan_progress_counts_items_against_an_item_total(db):
    """Regression: the counter and its total have to be the same unit.

    The phase set current/total from the *library* position, then the scan
    overwrote current with the *item* count and left the old total — so a big
    TV library reported "45233 of 2" and pinned the bar at 100%.
    """
    from app.models import PlexLibrary, SyncRun
    from app.services.sync_service import SyncService

    user = User(username="sam", plex_user_id="1")
    server = PlexServer(
        machine_identifier="m1",
        name="BlarrowTV",
        base_url="https://plex.example:32400",
        access_token_encrypted=encrypt_secret("token"),
    )
    db.add_all([user, server])
    await db.flush()
    library = PlexLibrary(
        server_id=server.id, section_key="2", title="TV Shows", section_type="show"
    )
    run = SyncRun(user_id=user.id, kind="full")
    db.add_all([library, run])
    await db.flush()

    class CountingClient:
        """Shows then episodes, several pages each — the shape that broke."""

        totals = {2: 90, 4: 410}

        async def section_total(self, section_key, item_type):
            return self.totals[item_type]

        async def iter_section_items(self, section_key, item_type, page_size=200):
            done = 0
            while done < self.totals[item_type]:
                size = min(page_size, self.totals[item_type] - done)
                yield [
                    {"type": "clip", "title": f"t{item_type}-{done + n}"}
                    for n in range(size)
                ]
                done += size

    service = SyncService(db)
    service._run = run
    service._clients[(user.id, server.id)] = CountingClient()  # type: ignore[assignment]

    # Stand in for the phase having been set with a library count, which is
    # exactly the stale total the scan has to replace.
    await service._set_phase("Scanning TV Shows on BlarrowTV", current=1, total=2)

    await service.sync_library_items(user, server, library, SyncStats())

    # The denominator is the item count for both passes, never the library count.
    assert run.progress_total == 90 + 410
    # And the numerator counts the same thing, so the bar cannot exceed 100%.
    assert run.progress_current == 500


async def test_scan_progress_stays_indeterminate_when_the_total_is_unknown(db):
    """A server that will not say how much there is must not inherit a stale total."""
    from app.models import PlexLibrary, SyncRun
    from app.services.sync_service import SyncService

    user = User(username="sam", plex_user_id="1")
    server = PlexServer(
        machine_identifier="m1",
        name="BlarrowTV",
        base_url="https://plex.example:32400",
        access_token_encrypted=encrypt_secret("token"),
    )
    db.add_all([user, server])
    await db.flush()
    library = PlexLibrary(
        server_id=server.id, section_key="1", title="Films", section_type="movie"
    )
    run = SyncRun(user_id=user.id, kind="full")
    db.add_all([library, run])
    await db.flush()

    class SilentClient:
        async def section_total(self, section_key, item_type):
            return 0  # server did not report totalSize

        async def iter_section_items(self, section_key, item_type, page_size=200):
            yield [{"type": "clip", "title": "x"}]

    service = SyncService(db)
    service._run = run
    service._clients[(user.id, server.id)] = SilentClient()  # type: ignore[assignment]
    await service._set_phase("Scanning Films on BlarrowTV", current=1, total=2)

    await service.sync_library_items(user, server, library, SyncStats())

    # 0 is what the UI reads as "unknown" and renders as a sliding bar.
    assert run.progress_total == 0


async def test_a_failing_request_opens_only_one_connection(monkeypatch):
    """Regression: retries must not each build their own HTTP client.

    Every AsyncClient opens a fresh connection, and every connection costs a DNS
    lookup. Building one per attempt meant a single failing request fired one
    lookup per candidate URL per retry, which is enough to trip a rate-limiting
    resolver — and once tripped, every request failed and re-fired the whole
    fan-out.
    """
    import httpx

    from app.services import plex_server as ps

    # Failure state is module level, so it outlives a test unless cleared.
    ps.reset_failure_state()
    built = 0

    class CountingClient:
        def __init__(self, *args, **kwargs) -> None:
            nonlocal built
            built += 1
            self.attempts = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args) -> bool:
            return False

        async def request(self, *args, **kwargs):
            self.attempts += 1
            raise httpx.ConnectError("name resolution failed")

    monkeypatch.setattr(ps.httpx, "AsyncClient", CountingClient)
    monkeypatch.setattr(ps.asyncio, "sleep", lambda _delay: _async(None))

    client = ps.PlexServerClient(
        "https://one.plex.direct:32400",
        "token",
        candidate_urls=[
            "https://one.plex.direct:32400",
            "https://two.plex.direct:32400",
            "https://three.plex.direct:32400",
        ],
    )

    with pytest.raises(ps.PlexUnreachable):
        await client._request("GET", "/status/sessions")

    # Three candidates with one retry each is six attempts — but they must all
    # share a single pooled client rather than opening six connections.
    assert built == 1


async def test_an_unreachable_server_is_not_re_probed_every_poll(monkeypatch):
    """Regression: a downed server must back off, not re-walk every candidate.

    Plex advertises one connection URI per address it can see, and a Plex
    install running in Docker advertises every bridge gateway on its host — so
    a full walk is seven or eight hostnames, each costing an A and a AAAA
    lookup. Repeating that on a one-second poll is thousands of DNS queries a
    minute, which is enough to get a filtering resolver to throttle the whole
    container and keep the failure alive.
    """
    import httpx

    from app.services import plex_server as ps

    ps.reset_failure_state()
    requests = 0

    class DeadClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args) -> bool:
            return False

        async def request(self, *args, **kwargs):
            nonlocal requests
            requests += 1
            raise httpx.ConnectError("name resolution failed")

    monkeypatch.setattr(ps.httpx, "AsyncClient", DeadClient)
    monkeypatch.setattr(ps.asyncio, "sleep", lambda _delay: _async(None))

    def build():
        return ps.PlexServerClient(
            "https://192-168-0-2.hash.plex.direct:32400",
            "token",
            candidate_urls=[
                "https://192-168-0-2.hash.plex.direct:32400",
                "https://172-17-0-1.hash.plex.direct:32400",
                "https://172-18-0-1.hash.plex.direct:32400",
            ],
        )

    with pytest.raises(ps.PlexUnreachable):
        await build()._request("GET", "/status/sessions")
    after_first_walk = requests
    assert after_first_walk > 0

    # A fresh client, as the scheduler builds on every poll, must not repeat the
    # walk while the cooldown is active.
    for _ in range(5):
        with pytest.raises(ps.PlexUnreachable):
            await build()._request("GET", "/status/sessions")

    assert requests == after_first_walk

    # Once the cooldown lapses, it tries again rather than giving up forever.
    ps._failures.clear()
    with pytest.raises(ps.PlexUnreachable):
        await build()._request("GET", "/status/sessions")
    assert requests > after_first_walk


async def test_trailers_and_extras_are_not_real_playback():
    """Regression: a trailer must not count as watching the film.

    Plex reports extras with the parent film's title and artwork, so anything
    that trusts a session or history row without checking the type will mark
    the whole film watched off a two-minute trailer.
    """
    from app.services.plex_server import is_real_playback

    assert is_real_playback({"type": "movie"})
    assert is_real_playback({"type": "episode"})

    # Extras come back as clips...
    assert not is_real_playback({"type": "clip"})
    assert not is_real_playback({"type": "clip", "subtype": "trailer"})
    # ...and sometimes as a library type carrying an extra marker.
    assert not is_real_playback({"type": "movie", "extraType": 1})
    assert not is_real_playback({"type": "movie", "subtype": "behindTheScenes"})
    # Music and unknown types are not watch events either.
    assert not is_real_playback({"type": "track"})
    assert not is_real_playback({})


async def test_artwork_falls_back_to_the_raw_asset_when_transcoding_fails(monkeypatch):
    """The photo transcoder can refuse what the file handler serves happily."""
    from app.services.plex_server import PlexServerClient

    client = PlexServerClient("https://plex.example:32400", "token")
    tried: list[str] = []

    class Resp:
        def __init__(self, status, body=b""):
            self.status_code = status
            self.content = body
            self.headers = {"content-type": "image/jpeg"}

    async def request(self, method, path, *, params=None, retries=1, record_failures=True):
        tried.append(path)
        # Transcoding refused; the original asset is fine.
        return Resp(400) if path == "/photo/:/transcode" else Resp(200, b"jpeg")

    monkeypatch.setattr(PlexServerClient, "_request", request)
    assert await client.image_bytes("/library/metadata/1/thumb/9") == (
        b"jpeg",
        "image/jpeg",
    )
    assert tried == ["/photo/:/transcode", "/library/metadata/1/thumb/9"]


async def test_artwork_failures_do_not_trip_the_unreachable_backoff(monkeypatch):
    """Regression: a poster must not be able to declare the server dead.

    Dozens of artwork requests ride on the same connection as the sync. If a
    refused one recorded a failure, a page of missing posters could put the
    whole server into cooldown and stop syncing entirely.
    """
    import httpx

    from app.services import plex_server as module

    module.reset_failure_state()
    client = module.PlexServerClient("https://plex.example:32400", "token")

    class DeadClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def request(self, *args, **kwargs):
            raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(httpx, "AsyncClient", DeadClient)

    with pytest.raises(module.PlexUnreachable):
        await client.image_bytes("/library/metadata/1/thumb/9")
    # Nothing recorded, so the next real call still gets to try.
    assert module._failures == {}

    # An ordinary call does record it, which is what the backoff is for.
    with pytest.raises(module.PlexUnreachable):
        await client.identity()
    assert module._failures != {}
    module.reset_failure_state()


async def test_section_total_reads_totalsize_without_fetching_items(monkeypatch):
    """One cheap request for the denominator — and 0 when the server won't say."""
    from app.services.plex_server import PlexServerClient

    client = PlexServerClient("https://plex.example:32400", "token")
    seen: dict = {}

    async def container(path, params=None):
        seen.update(params or {})
        return {"size": 0, "totalSize": 44333}

    monkeypatch.setattr(client, "_container", container)
    assert await client.section_total("2", 4) == 44333
    # Asking for nothing is the point: the count comes back, the items do not.
    assert seen["X-Plex-Container-Size"] == 0
    assert seen["type"] == 4

    async def silent(path, params=None):
        return {"size": 0}

    monkeypatch.setattr(client, "_container", silent)
    assert await client.section_total("2", 4) == 0


async def test_on_deck_window_is_read_from_server_prefs(monkeypatch):
    """`/:/prefs` is the only place Plex publishes its Continue Watching window."""
    from app.services.plex_server import PlexServerClient

    client = PlexServerClient("https://plex.example:32400", "token")

    async def prefs(path, params=None):
        assert path == "/:/prefs"
        return {"Setting": [{"id": "onDeckWindow", "value": 4}, {"id": "lang"}]}

    monkeypatch.setattr(client, "_container", prefs)
    assert await client.on_deck_window_weeks() == 4

    # A shared user's token is refused, and _get_json turns that into nothing.
    async def denied(path, params=None):
        return {}

    monkeypatch.setattr(client, "_container", denied)
    assert await client.on_deck_window_weeks() is None


def _async(value):
    """Wrap a value in an awaitable so it can stand in for an async method."""
    async def _inner(*_args, **_kwargs):
        return value

    return _inner()
