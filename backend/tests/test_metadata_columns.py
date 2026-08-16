"""The three data-collection additions, and the one thing that can silently fail.

The additions themselves are cheap: a column, a model field, a line in the sink.
What is expensive to get wrong is the *pass that revisits existing rows*. A
repair that queues rows nothing ever looks at again is worse than no repair —
it logs a large number, claims the work is scheduled, and leaves the columns
empty for the life of the install. So the load-bearing test here is
`test_the_backfill_actually_picks_up_what_the_repair_queued`, which runs the two
against one database rather than asserting about either alone.
"""
import re
from datetime import timedelta

import pytest
from sqlalchemy import func, select, text

from app.db import _resweep_incomplete_metadata, _run_light_migrations
from app.models import (
    MediaItem,
    MediaType,
    PlexLibrary,
    PlexMapping,
    PlexServer,
    User,
    UserMediaState,
    UserServerAccess,
    WatchEvent,
    WatchlistEntry,
    utcnow,
)
from app.security import encrypt_secret
from app.services.media_repo import METADATA_RESWEEP_MARK
from app.services.sync_service import SyncService, SyncStats

pytestmark = pytest.mark.asyncio


# --- migrations ------------------------------------------------------------

# Every column this batch adds, and the table it belongs to. `_run_light_migrations`
# is a list of ALTERs guarded by a PRAGMA, so the failure mode is not "the column
# is missing" but "the second boot raises `duplicate column name` and the app
# never starts".
NEW_COLUMNS = [
    ("media_items", "original_language"),
    ("media_items", "origin_countries"),
    ("media_items", "keywords"),
    ("watch_events", "library_id"),
]


async def _columns(engine, table: str) -> set[str]:
    async with engine.begin() as conn:
        rows = await conn.execute(text(f"PRAGMA table_info({table})"))
        return {row[1] for row in rows}


async def test_the_new_columns_are_added_and_adding_them_twice_is_a_no_op(
    engine, monkeypatch
):
    """The upgrade path: a database that predates the columns, booted twice."""
    monkeypatch.setattr("app.db.engine", engine)

    # `create_all` in the fixture already made them, so take them back off to
    # get the shape a real upgrade starts from.
    async with engine.begin() as conn:
        for table, column in NEW_COLUMNS:
            if table == "watch_events":
                # SQLite refuses to DROP a column named in a foreign key, so
                # this one is rebuilt from its own stored DDL with the column
                # and its constraint cut out — which is exactly the table a
                # pre-upgrade database has.
                ddl = await conn.scalar(
                    text("SELECT sql FROM sqlite_master WHERE name = 'watch_events'")
                )
                rebuilt = re.sub(
                    r",\s*FOREIGN KEY\(library_id\) REFERENCES [^,\n]*", "", ddl
                )
                rebuilt = re.sub(r"\s*library_id INTEGER,", "", rebuilt)
                await conn.execute(text("DROP TABLE watch_events"))
                await conn.execute(text(rebuilt))
                continue
            await conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))
    for table, column in NEW_COLUMNS:
        assert column not in await _columns(engine, table)

    await _run_light_migrations()
    for table, column in NEW_COLUMNS:
        assert column in await _columns(engine, table), f"{table}.{column} not added"

    # The second boot. SQLite raises on a duplicate column, so a missing guard
    # here is a container that starts once and then never again.
    await _run_light_migrations()
    await _run_light_migrations()
    for table, column in NEW_COLUMNS:
        assert column in await _columns(engine, table)

    async with engine.begin() as conn:
        indexes = await conn.execute(text("PRAGMA index_list(watch_events)"))
        assert "ix_watch_events_library_id" in {row[1] for row in indexes}


# --- the repair pass -------------------------------------------------------


async def _row(db, **overrides) -> MediaItem:
    defaults = {
        "guid_key": f"tmdb:movie:{overrides.get('tmdb_id', 1)}",
        "media_type": MediaType.MOVIE,
        "title": "A Film",
        "tmdb_id": 1,
        "metadata_updated_at": utcnow(),
        "original_language": None,
        "origin_countries": None,
        "studio": None,
        "network": None,
    }
    defaults.update(overrides)
    item = MediaItem(**defaults)
    db.add(item)
    await db.commit()
    return item


async def test_the_repair_queues_only_rows_it_can_actually_help(
    engine, session_factory, monkeypatch
):
    monkeypatch.setattr("app.db.engine", engine)

    async with session_factory() as db:
        incomplete = await _row(db, tmdb_id=1, guid_key="tmdb:movie:1")
        complete = await _row(
            db,
            tmdb_id=2,
            guid_key="tmdb:movie:2",
            original_language="en",
            origin_countries=["US"],
            studio="Warner Bros.",
        )
        # No external id: this row belongs to the backfill's *other* arm, which
        # searches by title. Queueing it here would only re-ask a question that
        # pass already asks.
        no_id = await _row(
            db, tmdb_id=None, guid_key="title:movie:unknown", metadata_updated_at=None
        )
        # An episode is never enriched, so there is nothing to queue.
        episode = await _row(
            db,
            tmdb_id=4,
            guid_key="tmdb:show:4/s1e1",
            media_type=MediaType.EPISODE,
        )
        ids = (incomplete.id, complete.id, no_id.id, episode.id)

    await _resweep_incomplete_metadata()

    async with session_factory() as db:
        marked = {
            item.id: item.metadata_updated_at
            for item in (await db.execute(select(MediaItem))).scalars()
        }
    assert marked[ids[0]] == METADATA_RESWEEP_MARK
    assert marked[ids[1]] > METADATA_RESWEEP_MARK, "a complete row was queued"
    assert marked[ids[2]] is None, "an id-less row was pulled out of the other arm"
    assert marked[ids[3]] > METADATA_RESWEEP_MARK, "an episode was queued"


async def test_the_repair_is_safe_to_run_again(engine, session_factory, monkeypatch):
    """It runs on every boot, so "twice" is the normal case, not the edge."""
    monkeypatch.setattr("app.db.engine", engine)
    async with session_factory() as db:
        item = await _row(db)
        item_id = item.id

    await _resweep_incomplete_metadata()
    await _resweep_incomplete_metadata()
    await _resweep_incomplete_metadata()

    async with session_factory() as db:
        stamp = await db.scalar(
            select(MediaItem.metadata_updated_at).where(MediaItem.id == item_id)
        )
    assert stamp == METADATA_RESWEEP_MARK


async def test_a_row_missing_only_a_network_is_left_alone(
    engine, session_factory, monkeypatch
):
    """The obvious spelling of the selection never terminates.

    "Missing any of language, country, studio or network" reads well and is
    unusable: TMDB lists no `networks` for a film, so every movie in the library
    would be queued again on every boot and re-asked forever. A row with a studio
    and no network is complete *for a film*, and that is what is checked.
    """
    monkeypatch.setattr("app.db.engine", engine)
    async with session_factory() as db:
        item = await _row(
            db,
            original_language="en",
            origin_countries=["US"],
            studio="Paramount",
            network=None,
        )
        item_id = item.id

    await _resweep_incomplete_metadata()

    async with session_factory() as db:
        stamp = await db.scalar(
            select(MediaItem.metadata_updated_at).where(MediaItem.id == item_id)
        )
    assert stamp > METADATA_RESWEEP_MARK


async def test_the_backfill_actually_picks_up_what_the_repair_queued(
    engine, session_factory, monkeypatch
):
    """The one that matters.

    `backfill_missing_metadata` selects rows with *no* external id. The repair
    targets rows that *have* one, so before this the two did not overlap at all
    and the repair would have queued a whole library into a pass that could
    never see it — a large log line and no work. The second arm is what closes
    that gap, and this asserts the gap is closed rather than assuming it.
    """
    monkeypatch.setattr("app.db.engine", engine)
    async with session_factory() as db:
        item = await _row(
            db, poster_url="https://image.tmdb.org/t/p/w500/a.jpg", tmdb_id=603
        )
        item_id = item.id

    await _resweep_incomplete_metadata()

    asked: list[int] = []

    async def fake_apply(self, item, *, ids, library, genres):
        asked.append(item.id)
        item.original_language = "en"
        item.origin_countries = ["US"]
        item.studio = "Warner Bros."
        item.metadata_updated_at = utcnow()

    monkeypatch.setattr(
        "app.services.media_repo.MediaRepository._apply_enrichment", fake_apply
    )

    async with session_factory() as db:
        service = SyncService(db)
        await service.backfill_missing_metadata(SyncStats())
    assert asked == [item_id], "the repaired row was never revisited"

    async with session_factory() as db:
        item = await db.get(MediaItem, item_id)
        assert item.original_language == "en"
        assert item.origin_countries == ["US"]
        assert item.studio == "Warner Bros."

        # And it leaves for good: the mark is the only thing that selects it,
        # and a successful pass replaces the mark with a real timestamp.
        asked.clear()
        service = SyncService(db)
        await service.backfill_missing_metadata(SyncStats())
    assert asked == [], "the resweep arm re-asked a row it had already answered"


async def test_a_resweep_does_not_count_as_recovered_artwork(
    engine, session_factory, monkeypatch
):
    """`metadata_backfilled` means "rows that gained a poster".

    A resweep row usually has one already, so counting it would inflate the
    number and, worse, call the duplicate merge on every single sync.
    """
    monkeypatch.setattr("app.db.engine", engine)
    async with session_factory() as db:
        await _row(db, poster_url="https://image.tmdb.org/t/p/w500/a.jpg")

    await _resweep_incomplete_metadata()

    async def fake_apply(self, item, *, ids, library, genres):
        item.original_language = "en"
        item.metadata_updated_at = utcnow()

    monkeypatch.setattr(
        "app.services.media_repo.MediaRepository._apply_enrichment", fake_apply
    )
    async with session_factory() as db:
        stats = SyncStats()
        await SyncService(db).backfill_missing_metadata(stats)
    assert stats.metadata_backfilled == 0


# --- the enrichment sink ---------------------------------------------------


async def test_the_sink_keeps_language_country_and_keywords(db):
    from app.services.media_repo import MediaRepository
    from app.services.metadata import Enrichment
    from app.services.metadata.anime import AnimeVerdict
    from app.services.metadata.base import MetadataResult

    item = MediaItem(
        guid_key="tmdb:movie:129", media_type=MediaType.MOVIE, title="Spirited Away"
    )
    db.add(item)
    await db.commit()

    repo = MediaRepository(db)

    class Stub:
        async def enrich(self, **_kwargs):
            return Enrichment(
                metadata=MetadataResult(
                    original_language="ja",
                    origin_countries=["JP"],
                    keywords=["anime", "based on manga"],
                    studio="Studio Ghibli",
                ),
                anime=AnimeVerdict(True, "keyword", 9),
            )

    repo.metadata = Stub()
    from app.services.guids import ExternalIds

    await repo._apply_enrichment(item, ids=ExternalIds(), library=None, genres=[])

    assert item.original_language == "ja"
    assert item.origin_countries == ["JP"]
    assert item.keywords == ["anime", "based on manga"]
    assert item.studio == "Studio Ghibli"


async def test_a_provider_with_nothing_to_say_still_closes_the_question(db):
    """`[]` and NULL are different answers, and the repair selects on NULL.

    A film has no `origin_country` on TMDB at all, so leaving the column NULL
    after a successful lookup would put every movie in the library back in the
    queue on the next boot, and the one after that, indefinitely.
    """
    from app.services.guids import ExternalIds
    from app.services.media_repo import MediaRepository
    from app.services.metadata import Enrichment
    from app.services.metadata.anime import AnimeVerdict
    from app.services.metadata.base import MetadataResult

    item = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="A Film")
    db.add(item)
    await db.commit()

    repo = MediaRepository(db)

    class Stub:
        async def enrich(self, **_kwargs):
            return Enrichment(
                metadata=MetadataResult(original_language="en"),
                anime=AnimeVerdict(False, None, 0),
            )

    repo.metadata = Stub()
    await repo._apply_enrichment(item, ids=ExternalIds(), library=None, genres=[])

    assert item.origin_countries == []
    assert item.keywords == []


async def test_a_library_less_enrichment_cannot_un_anime_a_show(db):
    """The resweep walks the whole library through `enrich_existing`.

    That path passes no library, so the classifier cannot see either of the two
    forcing signals — the user's override, and a section named "Anime". Left
    alone it would return a negative verdict for a show whose only signal was
    the library name, and the resweep would quietly un-anime every series in it.
    """
    from app.services.guids import ExternalIds
    from app.services.media_repo import MediaRepository
    from app.services.metadata import Enrichment
    from app.services.metadata.anime import AnimeVerdict
    from app.services.metadata.base import MetadataResult

    show = MediaItem(
        guid_key="tvdb:81797",
        media_type=MediaType.SHOW,
        title="One Piece",
        is_anime=True,
        anime_source="library_name",
    )
    db.add(show)
    await db.commit()

    repo = MediaRepository(db)

    class Stub:
        async def enrich(self, **_kwargs):
            return Enrichment(
                metadata=MetadataResult(original_language="ja"),
                anime=AnimeVerdict(False, None, 0),
            )

    repo.metadata = Stub()
    await repo._apply_enrichment(show, ids=ExternalIds(), library=None, genres=[])

    assert show.is_anime is True
    assert show.anime_source == "library_name"


# --- watch_events.library_id ----------------------------------------------


class _HistoryClient:
    def __init__(self, entries, metadata=None):
        self._entries = entries
        self._metadata = metadata or {}

    async def iter_history(self, *, account_id=None, since=None, page_size=500):
        yield list(self._entries)

    async def metadata(self, rating_key: str):
        return self._metadata.get(rating_key)


def _async(value):
    """Wrap a value in an awaitable so it can stand in for an async method."""

    async def _inner(*_args, **_kwargs):
        return value

    return _inner()


async def _world(db):
    user = User(username="sam", plex_user_id="1")
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
        server_id=server.id, section_key="1", title="Films", section_type="movie"
    )
    item = MediaItem(
        guid_key="tmdb:movie:603", media_type=MediaType.MOVIE, title="The Matrix"
    )
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
    return user, server, library, item


async def test_a_play_records_the_library_it_came_from(db, monkeypatch):
    """Per-library stats would otherwise join through `plex_mappings`, which is
    one-to-many: an item held on two servers doubles every one of its plays."""
    user, server, library, item = await _world(db)
    fake = _HistoryClient(
        [
            {
                "ratingKey": "42",
                "historyKey": "/status/sessions/history/9",
                "viewedAt": int(utcnow().timestamp()),
            }
        ],
        {"42": {"ratingKey": "42", "type": "movie", "title": "The Matrix"}},
    )
    service = SyncService(db)
    monkeypatch.setattr(service, "client_for", lambda *_: _async(fake))

    await service.sync_history(user, server, SyncStats())

    event = await db.scalar(select(WatchEvent).where(WatchEvent.user_id == user.id))
    assert event is not None
    assert event.library_id == library.id


async def test_a_play_with_no_mapping_records_no_library(db, monkeypatch):
    """Plex drops `ratingKey` from a history row whose file it no longer holds.

    That play is real history and keeps its row; there is simply no library to
    name, and NULL says so. Inventing one would be a guess presented as a fact.
    """
    user, server, library, item = await _world(db)
    fake = _HistoryClient(
        [
            {
                "historyKey": "/status/sessions/history/11",
                "viewedAt": int(utcnow().timestamp()),
                "type": "movie",
                "title": "Some Film Since Deleted",
                "originallyAvailableAt": "1994-09-10",
            }
        ]
    )
    service = SyncService(db)
    monkeypatch.setattr(service, "client_for", lambda *_: _async(fake))

    await service.sync_history(user, server, SyncStats())

    event = await db.scalar(select(WatchEvent).where(WatchEvent.user_id == user.id))
    assert event is not None
    assert event.library_id is None


# --- the credits phase -----------------------------------------------------


class _StubTMDB:
    enabled = True
    paused = False

    def __init__(self, result=None):
        self.result = result
        self.calls: list[int] = []

    async def credits(self, tmdb_id: int, *, is_show: bool):
        self.calls.append(tmdb_id)
        return self.result


class _StubService:
    def __init__(self, tmdb):
        self.tmdb = tmdb


def _use_stub(monkeypatch, tmdb):
    service = _StubService(tmdb)
    monkeypatch.setattr(
        "app.services.sync_service.get_metadata_service", lambda: service
    )
    monkeypatch.setattr(
        "app.services.credits.get_metadata_service", lambda: service
    )
    return service


async def _titles(db, count: int) -> list[MediaItem]:
    items = [
        MediaItem(
            guid_key=f"tmdb:movie:{n}",
            media_type=MediaType.MOVIE,
            title=f"Film {n}",
            tmdb_id=n,
        )
        for n in range(1, count + 1)
    ]
    db.add_all(items)
    await db.commit()
    return items


async def test_the_credits_phase_is_capped_per_run(db, monkeypatch):
    """One call per title against a rate-limited provider, so a library drains
    over several syncs rather than turning one into an hour of TMDB traffic."""
    from app.services.metadata.base import CreditsResult
    from app.services.sync_service import CREDITS_BACKFILL_BATCH

    await _titles(db, CREDITS_BACKFILL_BATCH + 7)
    tmdb = _StubTMDB(CreditsResult())
    _use_stub(monkeypatch, tmdb)

    stats = SyncStats()
    fetched = await SyncService(db).backfill_credits(stats)

    assert fetched == CREDITS_BACKFILL_BATCH
    assert len(tmdb.calls) == CREDITS_BACKFILL_BATCH
    assert stats.credits_fetched == CREDITS_BACKFILL_BATCH

    # The rest are still there for the next run, and none is asked twice.
    tmdb.calls.clear()
    assert await SyncService(db).backfill_credits(SyncStats()) == 7
    assert len(tmdb.calls) == 7


async def test_watched_titles_are_asked_about_first(db, monkeypatch):
    """The stats these feed are about what you have watched. A queue ordered by
    id instead would spend its first few thousand calls on the long tail."""
    from app.services.metadata.base import CreditsResult

    items = await _titles(db, 3)
    user = User(username="sam")
    db.add(user)
    await db.flush()
    # Deliberately against the id order: the last row is the watched one, the
    # middle is watchlisted, the first is neither.
    db.add(
        UserMediaState(user_id=user.id, media_item_id=items[2].id, view_count=1)
    )
    db.add(
        WatchlistEntry(user_id=user.id, media_item_id=items[1].id, active=True)
    )
    await db.commit()

    tmdb = _StubTMDB(CreditsResult())
    _use_stub(monkeypatch, tmdb)
    await SyncService(db).backfill_credits(SyncStats())

    assert tmdb.calls == [items[2].tmdb_id, items[1].tmdb_id, items[0].tmdb_id]


async def test_an_empty_answer_still_leaves_the_queue(db, monkeypatch):
    """Otherwise the same hundred titles are re-asked on every sync, forever —
    the property `credits_updated_at` exists to hold."""
    from app.services.metadata.base import CreditsResult

    await _titles(db, 2)
    tmdb = _StubTMDB(CreditsResult())
    _use_stub(monkeypatch, tmdb)

    assert await SyncService(db).backfill_credits(SyncStats()) == 2
    stamped = await db.scalar(
        select(func.count(MediaItem.id)).where(
            MediaItem.credits_updated_at.is_not(None)
        )
    )
    assert stamped == 2

    tmdb.calls.clear()
    assert await SyncService(db).backfill_credits(SyncStats()) == 0
    assert tmdb.calls == []


async def test_episodes_and_id_less_rows_are_never_queued(db, monkeypatch):
    """An episode is reached through its show, and a row with no tmdb id cannot
    be stamped — it would block a hundred slots on every future run."""
    from app.services.metadata.base import CreditsResult

    db.add_all(
        [
            MediaItem(
                guid_key="tmdb:show:1/s1e1",
                media_type=MediaType.EPISODE,
                title="Pilot",
                tmdb_id=1,
            ),
            MediaItem(
                guid_key="title:movie:nameless",
                media_type=MediaType.MOVIE,
                title="Nameless",
            ),
        ]
    )
    await db.commit()

    tmdb = _StubTMDB(CreditsResult())
    _use_stub(monkeypatch, tmdb)

    assert await SyncService(db).backfill_credits(SyncStats()) == 0
    assert tmdb.calls == []


async def test_the_phase_stops_when_the_provider_is_in_cooldown(db, monkeypatch):
    """A refused call and an empty answer look identical from here, and one of
    them gets stamped. Carrying on would mark a hundred titles as having no
    cast and never ask about them again."""
    from app.services.metadata.base import CreditsResult

    await _titles(db, 5)
    tmdb = _StubTMDB(CreditsResult())
    tmdb.paused = True
    _use_stub(monkeypatch, tmdb)

    assert await SyncService(db).backfill_credits(SyncStats()) == 0
    assert tmdb.calls == []
    unstamped = await db.scalar(
        select(func.count(MediaItem.id)).where(MediaItem.credits_updated_at.is_(None))
    )
    assert unstamped == 5


async def test_nothing_is_asked_without_a_tmdb_key(db, monkeypatch):
    """`credits._fetch` deliberately does not stamp a row it could not ask
    about, so without this the phase would select the same hundred rows on every
    sync for the life of the install."""

    class Disabled(_StubTMDB):
        enabled = False

    tmdb = Disabled(None)
    _use_stub(monkeypatch, tmdb)
    await _titles(db, 3)

    assert await SyncService(db).backfill_credits(SyncStats()) == 0
    assert tmdb.calls == []


async def test_a_stored_answer_is_not_re_fetched_by_the_phase(db, monkeypatch):
    from app.services.metadata.base import CreditsResult

    items = await _titles(db, 2)
    items[0].credits_updated_at = utcnow() - timedelta(days=1)
    await db.commit()

    tmdb = _StubTMDB(CreditsResult())
    _use_stub(monkeypatch, tmdb)

    assert await SyncService(db).backfill_credits(SyncStats()) == 1
    assert tmdb.calls == [items[1].tmdb_id]
