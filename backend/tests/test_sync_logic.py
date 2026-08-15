"""Two-way sync: which side wins, and does a removal stay removed."""
from datetime import date, timedelta

import pytest

from app.models import (
    MediaItem,
    MediaType,
    PlexLibrary,
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
        # Ratings are read from the paged section listings now, not one
        # metadata() call per item, so the fake has to serve them the same way.
        self.section_pages = 0

    async def metadata(self, rating_key: str):
        return self._metadata.get(rating_key)

    async def iter_section_items(self, section_key: str, item_type: int, **_kwargs):
        self.section_pages += 1
        yield list(self._metadata.values())

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
    library = PlexLibrary(
        server_id=server.id,
        section_key="1",
        title="Movies",
        section_type="movie",
        enabled=True,
    )
    item = MediaItem(guid_key="tmdb:movie:603", media_type=MediaType.MOVIE, title="The Matrix")
    db.add_all([library, item])
    await db.flush()

    db.add(
        PlexMapping(
            media_item_id=item.id,
            server_id=server.id,
            library_id=library.id,
            rating_key="42",
        )
    )
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


async def test_the_opening_phases_claim_no_progress(db):
    """A phase that has not measured anything must report an unknown total.

    Regression: the server loop counted servers, so the single-server case set
    "1 of 1" and painted a full bar before a single item had been read. Which
    server it is belongs in the phase text; the bar stays indeterminate until
    a step can count in its own unit.
    """
    from app.models import SyncRun
    from app.services.sync_service import SyncService

    user = User(username="sam", plex_user_id="1")
    db.add(user)
    await db.flush()
    run = SyncRun(user_id=user.id, kind="full")
    db.add(run)
    await db.flush()

    service = SyncService(db)
    service._run = run

    await service._set_phase("Looking for Plex servers")
    assert (run.progress_current, run.progress_total) == (0, 0)

    await service._set_phase("Reading libraries on BlarrowTV")
    assert (run.progress_current, run.progress_total) == (0, 0)


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

    await ps.close_pool()
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
    await ps.close_pool()


async def test_connections_are_pooled_across_calls_not_just_within_one(monkeypatch):
    """Regression: the DNS storm that took a live instance's sync down.

    A history import asks Plex about every entry it has not seen, which on a
    first run is hundreds of requests in seconds. A client per call is a
    connection per call is a DNS lookup per call — enough to trip a
    rate-limiting resolver, after which the Plex server *and* plex.tv both stop
    resolving mid-sync. Pooling within a single call was not enough.
    """
    from app.services import plex_server as ps

    ps.reset_failure_state()
    await ps.close_pool()
    built = 0

    class CountingClient:
        def __init__(self, *args, **kwargs) -> None:
            nonlocal built
            built += 1
            self.is_closed = False

        async def request(self, *args, **kwargs):
            class Resp:
                status_code = 200

            return Resp()

        async def aclose(self) -> None:
            self.is_closed = True

    monkeypatch.setattr(ps.httpx, "AsyncClient", CountingClient)
    client = ps.PlexServerClient("https://one.plex.direct:32400", "token")

    for _ in range(50):
        await client._request("GET", "/library/metadata/1")

    # Fifty calls, one connection pool — not fifty.
    assert built == 1

    # A second client instance shares it too: SyncService builds one of these
    # per (user, server), and the images proxy builds more per request.
    other = ps.PlexServerClient("https://one.plex.direct:32400", "token")
    await other._request("GET", "/library/metadata/2")
    assert built == 1

    await ps.close_pool()


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
        is_closed = False

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


async def test_full_sync_adopts_a_run_created_by_the_trigger(db):
    """The row the HTTP trigger created is the one that gets finished.

    It exists so the UI sees "running" straight away; if full_sync created its
    own anyway there would be two rows, and the one the UI is watching would
    never complete.
    """
    from sqlalchemy import func, select

    from app.models import SyncRun

    user = User(username="sam")
    db.add(user)
    await db.flush()

    run = SyncRun(user_id=user.id, kind="incremental", phase="Starting")
    db.add(run)
    await db.commit()

    finished = await SyncService(db).full_sync(user, run=run)

    assert finished.id == run.id
    assert await db.scalar(select(func.count(SyncRun.id))) == 1
    assert run.finished_at is not None
    # And the placeholder phase does not outlive the run.
    assert run.phase is None


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


async def test_a_transcoder_500_still_falls_back_to_the_raw_asset(monkeypatch):
    """Regression: the "random" missing posters.

    The photo transcoder is a subsystem with limits of its own, and a page that
    asks for forty posters at once exhausts them — at which point it refuses
    with a 5xx, not the 4xx the test above covers. `_request` turns a 5xx into
    an exception, so the raw-asset fallback that exists for exactly this was
    never reached: the browser got a placeholder for a picture the plain file
    handler would have served, and a different scatter of titles each reload.
    """
    from app.services import plex_server as ps

    ps.reset_failure_state()
    await ps.close_pool()
    tried: list[str] = []

    class Resp:
        def __init__(self, status: int, body: bytes = b"") -> None:
            self.status_code = status
            self.content = body
            self.headers = {"content-type": "image/jpeg"}

    class OverloadedTranscoder:
        is_closed = False

        def __init__(self, *args, **kwargs) -> None:
            pass

        async def request(self, method, url, **kwargs):
            tried.append(url)
            if "/photo/:/transcode" in url:
                return Resp(500)
            return Resp(200, b"jpeg")

    monkeypatch.setattr(ps.httpx, "AsyncClient", OverloadedTranscoder)
    client = ps.PlexServerClient("https://plex.example:32400", "token")

    assert await client.image_bytes("/library/metadata/1/thumb/9") == (
        b"jpeg",
        "image/jpeg",
    )
    assert [u.rsplit(":32400", 1)[1] for u in tried] == [
        "/photo/:/transcode",
        "/library/metadata/1/thumb/9",
    ]
    # And a server that answered — badly — is not a server that is unreachable.
    assert ps._failures == {}
    await ps.close_pool()


async def test_the_working_connection_uri_is_remembered_across_clients(monkeypatch):
    """One walk of the candidate list per server, not one per poster.

    A PlexServerClient is built per request by the artwork proxy, so keeping the
    answer only on the instance meant a grid of forty posters walked the
    candidate list forty times — paying a connect timeout on every dead URI
    before reaching the one that works, forty times over.
    """
    import httpx

    from app.services import plex_server as ps

    ps.reset_failure_state()
    await ps.close_pool()
    tried: list[str] = []

    class Flaky:
        is_closed = False

        def __init__(self, *args, **kwargs) -> None:
            pass

        async def request(self, method, url, **kwargs):
            tried.append(url)
            if url.startswith("https://dead"):
                raise httpx.ConnectError("no route to host")

            class Resp:
                status_code = 200

            return Resp()

    monkeypatch.setattr(ps.httpx, "AsyncClient", Flaky)
    monkeypatch.setattr(ps.asyncio, "sleep", lambda _delay: _async(None))

    def build():
        return ps.PlexServerClient(
            "https://dead.plex.direct:32400",
            "token",
            candidate_urls=[
                "https://dead.plex.direct:32400",
                "https://live.plex.direct:32400",
            ],
        )

    await build()._request("GET", "/identity")
    dead_attempts = len([u for u in tried if u.startswith("https://dead")])
    assert dead_attempts > 0

    for _ in range(5):
        await build()._request("GET", "/identity")

    # Five more requests, none of which went near the dead URI again.
    assert len([u for u in tried if u.startswith("https://dead")]) == dead_attempts
    assert len([u for u in tried if u.startswith("https://live")]) == 6
    await ps.close_pool()


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
        is_closed = False

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


class FakePlexTV:
    """Stands in for plex.tv Discover, with a controllable watchlist read."""

    def __init__(self, items=None, *, complete=True):
        from app.services.plex_tv import WatchlistFetch

        self._fetch = WatchlistFetch(items=list(items or []), complete=complete)
        self.removed: list[str] = []
        self.added: list[str] = []

    async def get_watchlist(self, token: str):
        return self._fetch

    async def remove_from_watchlist(self, token: str, guid: str) -> bool:
        self.removed.append(guid)
        return True

    async def add_to_watchlist(self, token: str, guid: str) -> bool:
        self.added.append(guid)
        return True


async def _watchlisted_user(db):
    user = User(
        username="sam",
        preferences={"sync_watchlist": True},
        plex_token_encrypted=encrypt_secret("plex-token"),
    )
    item = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Dune")
    db.add_all([user, item])
    await db.flush()
    return user, item


async def test_a_partial_discover_read_does_not_tombstone_the_watchlist(db):
    """Regression: a failed Discover page wiped the user's watchlist.

    `get_watchlist` returned the pages it had managed to fetch, and the push
    pass treated "absent from that list" as "the user removed it" — so a 500 on
    page two silently tombstoned every entry after it. Discover is the piece
    most likely to break, so this is the failure that matters most.
    """
    user, item = await _watchlisted_user(db)
    db.add(
        WatchlistEntry(
            user_id=user.id, media_item_id=item.id, active=True, plex_active=True
        )
    )
    await db.commit()

    service = SyncService(db)
    service.plex_tv = FakePlexTV(items=[], complete=False)
    stats = SyncStats()
    await service.sync_watchlist(user, stats)

    from sqlalchemy import select

    entry = (
        await db.execute(
            select(WatchlistEntry).where(WatchlistEntry.media_item_id == item.id)
        )
    ).scalar_one()

    assert entry.active is True, "an incomplete read removed a watchlist entry"
    assert stats.watchlist_removed_local == 0
    assert any("part" in message for message in stats.errors)


async def test_a_complete_discover_read_still_mirrors_removals(db):
    """The guard above must not disable the real removal path."""
    user, item = await _watchlisted_user(db)
    db.add(
        WatchlistEntry(
            user_id=user.id, media_item_id=item.id, active=True, plex_active=True
        )
    )
    await db.commit()

    service = SyncService(db)
    service.plex_tv = FakePlexTV(items=[], complete=True)
    stats = SyncStats()
    await service.sync_watchlist(user, stats)

    from sqlalchemy import select

    entry = (
        await db.execute(
            select(WatchlistEntry).where(WatchlistEntry.media_item_id == item.id)
        )
    ).scalar_one()

    assert entry.active is False
    assert entry.removed_at is not None
    assert stats.watchlist_removed_local == 1


async def test_a_local_removal_is_retried_not_reverted(db):
    """Regression: removing a watchlist-only title was undone by the next sync.

    `remove_from_watchlist` left `plex_active` True whenever it had no Discover
    guid to push with — the common case, since a watchlist-only title has no
    PlexMapping at all. The next sync then read the tombstone as "gone from
    Plex last time, present now" and reactivated it.
    """
    user, item = await _watchlisted_user(db)

    service = SyncService(db)
    service.plex_tv = FakePlexTV(items=[])
    await service.add_to_watchlist(user, item)
    await service.remove_from_watchlist(user, item)

    from sqlalchemy import select

    entry = (
        await db.execute(
            select(WatchlistEntry).where(WatchlistEntry.media_item_id == item.id)
        )
    ).scalar_one()
    assert entry.active is False
    assert entry.plex_active is False, "the removal was not recorded against Plex"

    # Now Plex still reports it — the removal never reached them. The sync must
    # retry the removal, not resurrect the entry.
    service.plex_tv = FakePlexTV(
        items=[{"guid": "plex://movie/abc", "ratingKey": "abc", "title": "Dune"}]
    )
    await service.sync_watchlist(user, SyncStats())

    await db.refresh(entry)
    assert entry.active is False, "a local removal was reverted by the next sync"


async def test_clearing_a_rating_is_pushed_and_not_reverted(db, monkeypatch):
    """Regression: a cleared rating was neither pushed nor defended.

    `local is None` is a change like any other, but both push branches guarded
    on `local is not None`. So a clear was never sent and never baselined — it
    re-evaluated every sync forever — and in the both-changed branch it fell
    through to the pull, writing Plex's old rating back over the user's
    deliberate clear.
    """
    user, server, item, fake = await _fixture_world(db, plex_user_rating=7.0)

    service = SyncService(db)
    monkeypatch.setattr(service, "client_for", lambda *_: _async(fake))

    now = utcnow()
    state = UserMediaState(
        user_id=user.id,
        media_item_id=item.id,
        rating=None,
        rating_updated_at=now,
        plex_rating=7.0,
        plex_rating_synced_at=now - timedelta(hours=2),
    )
    db.add(state)
    await db.commit()

    stats = SyncStats()
    await service.sync_ratings(user, server, stats)

    # Plex has no unrate, so a clear is sent as 0.
    assert fake.rated == [("42", 0.0)]
    assert stats.ratings_pushed == 1

    await db.refresh(state)
    assert state.rating is None, "the user's clear was reverted to Plex's value"
    # Baselined, so the next run is a no-op rather than pushing again.
    assert state.plex_rating is None


async def test_ratings_are_read_in_pages_not_one_request_per_item(db, monkeypatch):
    """sync_ratings used to make one metadata() call per library item per sync.

    On a 4,000-film library that was 4,000 HTTP round trips every sync
    interval — the traffic shape CLAUDE.md records as having taken a live
    instance's DNS down.
    """
    user, server, item, fake = await _fixture_world(db, plex_user_rating=6.0)
    calls: list[str] = []

    async def _track(rating_key: str):
        calls.append(rating_key)
        return fake._metadata.get(rating_key)

    monkeypatch.setattr(fake, "metadata", _track)

    service = SyncService(db)
    monkeypatch.setattr(service, "client_for", lambda *_: _async(fake))

    await service.sync_ratings(user, server, SyncStats())

    assert calls == [], "ratings still make a per-item metadata request"
    assert fake.section_pages > 0


class FakeHistoryClient(FakePlexClient):
    """A Plex client that serves one page of watch history."""

    def __init__(self, entries, metadata=None):
        super().__init__(metadata)
        self._entries = entries
        self.history_calls = 0

    async def iter_history(self, *, account_id=None, since=None, page_size=500):
        self.history_calls += 1
        yield list(self._entries)


async def test_importing_the_same_history_twice_adds_one_event(db, monkeypatch):
    """`dedupe_key` is what stops a re-sync duplicating the whole history.

    CLAUDE.md calls it load-bearing, but nothing exercised it — the key appears
    once in the whole suite, as fixture data.
    """
    from sqlalchemy import func, select

    from app.models import WatchEvent

    user, server, item, _ = await _fixture_world(db)
    entries = [
        {
            "ratingKey": "42",
            "historyKey": "/status/sessions/history/9",
            "viewedAt": int(utcnow().timestamp()),
            "duration": 8880000,
        }
    ]
    fake = FakeHistoryClient(entries, {"42": {"ratingKey": "42"}})

    service = SyncService(db)
    monkeypatch.setattr(service, "client_for", lambda *_: _async(fake))

    await service.sync_history(user, server, SyncStats())
    await service.sync_history(user, server, SyncStats())

    count = await db.scalar(
        select(func.count(WatchEvent.id)).where(WatchEvent.user_id == user.id)
    )
    assert count == 1, "re-importing the same history duplicated the event"


async def test_history_does_not_mint_a_second_identity_from_a_plex_guid(db, monkeypatch):
    """Regression: 372 of 4796 rows on a live instance, every one a blank tile.

    A modern Plex history row always carries a `guid`, and it is the `plex://`
    form — which names the item to this one server and to nothing else. The
    import took its presence as "the ids resolve, no need to ask for more",
    fell through `build_guid_key` to `plex:<key>`, and created a *second* row
    for a film the library already held as `tmdb:movie:603`. The duplicate
    carried only what a history row has — a title, an air date — so it had no
    artwork, nothing for enrichment to identify it by, and no external id for
    `merge_duplicates` to pair it up on. It stayed forever.
    """
    from sqlalchemy import func, select

    user, server, item, _ = await _fixture_world(db)
    before = await db.scalar(select(func.count(MediaItem.id)))

    entries = [
        {
            "ratingKey": "77",  # no mapping for this one yet
            "historyKey": "/status/sessions/history/12",
            "viewedAt": int(utcnow().timestamp()),
            "guid": "plex://movie/5d7768ba96b655001fdc0408",
            "title": "The Matrix",
            "type": "movie",
            "originallyAvailableAt": "1999-03-30",
        }
    ]
    # What the server says when actually asked, which is where the tmdb id is.
    full = {
        "77": {
            "ratingKey": "77",
            "type": "movie",
            "title": "The Matrix",
            "year": 1999,
            "guid": "plex://movie/5d7768ba96b655001fdc0408",
            "Guid": [{"id": "tmdb://603"}, {"id": "imdb://tt0133093"}],
            "thumb": "/library/metadata/77/thumb/1700",
        }
    }
    fake = FakeHistoryClient(entries, full)

    service = SyncService(db)
    monkeypatch.setattr(service, "client_for", lambda *_: _async(fake))
    await service.sync_history(user, server, SyncStats())

    # The play landed on the row that already existed, and nothing new was made.
    assert await db.scalar(select(func.count(MediaItem.id))) == before
    matrix = await db.scalar(
        select(MediaItem).where(MediaItem.guid_key == "tmdb:movie:603")
    )
    assert matrix is not None and matrix.id == item.id
    assert (
        await db.scalar(
            select(func.count(MediaItem.id)).where(
                MediaItem.guid_key.like("plex:%")
            )
        )
        == 0
    ), "a plex:// guid was treated as an identity of its own"


async def test_a_year_is_recovered_from_the_air_date_without_moving_the_key(db):
    """A thin payload has no `year`, and without one nothing can identify it.

    History rows carry `originallyAvailableAt` but not `year`, so rows built
    from one had no year — and a title with no year is not enough for a
    provider to match, which is why these rows could never be enriched into
    having artwork. The air date answers it.

    The guid_key must *not* move as a result: its last-resort branch is
    title+year, so feeding the recovered year into it would re-key every
    id-less row already stored and duplicate the lot.
    """
    from app.services.media_repo import MediaRepository

    server = PlexServer(
        machine_identifier="abc123",
        name="Home",
        base_url="http://plex:32400",
        access_token_encrypted=encrypt_secret("token") or "",
    )
    db.add(server)
    await db.flush()

    repo = MediaRepository(db, enrich=False)
    item = await repo.upsert_from_plex(
        {
            "ratingKey": "91",
            "type": "movie",
            "title": "101 Dalmatians",
            "originallyAvailableAt": "1996-11-16",
        },
        server=server,
    )
    await db.commit()

    assert item is not None
    assert item.year == 1996
    # The key is still the year-less one, so existing rows stay where they are.
    assert item.guid_key == "title:movie:101-dalmatians"


async def test_the_backfill_revisits_rows_that_nothing_else_looks_at(db, monkeypatch):
    """Regression: an artwork-less row was never enriched again, by anything.

    Enrichment hangs off an import: a library scan sees what Plex still holds,
    the watchlist pass sees the watchlist. A row created from a thin payload is
    in neither, so it kept its blank tile permanently. This pass is the only
    thing that goes back for them.
    """
    from sqlalchemy import func, select

    from app.services.sync_service import SyncService as Service

    # Exactly the shape found on the live instance: a title, an air date, and
    # nothing else. The year has to be recovered here too — these rows predate
    # the import-side fix and no import will ever touch them again.
    ghost = MediaItem(
        guid_key="title:movie:101-dalmatians",
        media_type=MediaType.MOVIE,
        title="101 Dalmatians",
        first_aired=date(1996, 11, 16),
    )
    # Already has artwork from a provider: must not be picked up again.
    settled = MediaItem(
        guid_key="tmdb:movie:603",
        media_type=MediaType.MOVIE,
        title="The Matrix",
        tmdb_id=603,
        poster_url="https://image.tmdb.org/t/p/w500/matrix.jpg",
    )
    db.add_all([ghost, settled])
    await db.commit()

    asked: list[tuple[str, int | None]] = []

    # Patched below `enrich_existing`, so the year recovery it does is real.
    async def fake_apply(self, item, *, ids, library, genres):
        asked.append((item.title, item.year))
        item.tmdb_id = 10113
        item.poster_url = "https://image.tmdb.org/t/p/w500/dalmatians.jpg"
        item.metadata_updated_at = utcnow()

    service = Service(db)
    monkeypatch.setattr(
        "app.services.media_repo.MediaRepository._apply_enrichment", fake_apply
    )

    stats = SyncStats()
    assert await service.backfill_missing_metadata(stats) == 1
    # 1996 came from first_aired: without it the provider has only a title, and
    # "101 Dalmatians" is more than one film.
    assert asked == [("101 Dalmatians", 1996)]
    assert stats.metadata_backfilled == 1

    await db.refresh(ghost)
    assert ghost.tmdb_id == 10113
    # Now that it has an external id, merge_duplicates can finally see it.
    assert (
        await db.scalar(
            select(func.count(MediaItem.id)).where(MediaItem.tmdb_id.is_not(None))
        )
        == 2
    )

    # Second run: it was just attempted, so it is not asked again immediately.
    asked.clear()
    assert await service.backfill_missing_metadata(SyncStats()) == 0
    assert asked == []


async def test_a_webhook_and_the_history_import_do_not_double_count(db, monkeypatch):
    """Regression: the same play was recorded twice, and counted twice.

    A webhook's dedupe key is a minute bucket; the history import's is
    `plex:<historyKey>`. Neither could ever match the other, so on a Plex Pass
    instance every scrobble produced two history rows and a view_count of 2.
    """
    from sqlalchemy import func, select

    from app.models import UserMediaState, WatchEvent, WatchSource

    user, server, item, _ = await _fixture_world(db)
    watched_at = utcnow()

    # The webhook got there first.
    service = SyncService(db)
    db.add(
        WatchEvent(
            user_id=user.id,
            media_item_id=item.id,
            watched_at=watched_at,
            source=WatchSource.PLEX_WEBHOOK,
            dedupe_key=f"webhook:{server.machine_identifier}:42:"
            f"{int(watched_at.timestamp() // 60)}",
            completed=True,
            server_id=server.id,
        )
    )
    await db.flush()
    await service.record_watch_state(user, item, watched_at)
    await db.commit()

    # Now the periodic import sees the same play.
    entries = [
        {
            "ratingKey": "42",
            "historyKey": "/status/sessions/history/9",
            "viewedAt": int(watched_at.timestamp()),
        }
    ]
    fake = FakeHistoryClient(entries, {"42": {"ratingKey": "42"}})
    monkeypatch.setattr(service, "client_for", lambda *_: _async(fake))

    await service.sync_history(user, server, SyncStats())

    count = await db.scalar(
        select(func.count(WatchEvent.id)).where(WatchEvent.user_id == user.id)
    )
    assert count == 1, "the same play was recorded as two events"

    state = (
        await db.execute(
            select(UserMediaState).where(
                UserMediaState.user_id == user.id,
                UserMediaState.media_item_id == item.id,
            )
        )
    ).scalar_one()
    assert state.view_count == 1, "the same play was counted twice"
