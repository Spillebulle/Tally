"""`WatchEvent.device` and `.player` mean the same thing whoever writes them.

The two columns are already exposed to the UI, and the disagreement between
their writers was invisible until something grouped by them: the history import
wrote `device=str(entry["deviceID"])` — a server-local integer — and never set
`player` at all, while the webhook wrote `device=Player.product` and
`player=Player.title`, the opposite way round from the session poller. A "where
do you watch" chart mixed "12345" with "Plex for Apple TV" with "Living Room
TV" on one axis.

The rule, written down in `plex_server.player_identity`: `device` is the client
in the room, `player` is the app it was played through, and neither ever holds
a number.
"""
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.models import (
    MediaItem,
    MediaType,
    PlexLibrary,
    PlexMapping,
    PlexServer,
    User,
    UserServerAccess,
    WatchEvent,
    WatchSource,
    utcnow,
)
from app.security import encrypt_secret
from app.services.plex_server import PlexDevice, PlexServerError
from app.services.sync_service import SyncService, SyncStats
from app.services.webhooks import handle_webhook

pytestmark = pytest.mark.asyncio


def _async(value):
    """Wrap a value in an awaitable so it can stand in for an async method."""

    async def _inner(*_args, **_kwargs):
        return value

    return _inner()


class FakeHistoryClient:
    """A Plex server that serves one page of history and a device list."""

    def __init__(self, entries, devices=None, *, devices_error=None):
        self._entries = entries
        self._devices = devices or []
        self._devices_error = devices_error
        self.device_calls = 0
        self.history_calls = 0

    async def iter_history(self, *, account_id=None, since=None, page_size=500):
        self.history_calls += 1
        yield list(self._entries)

    async def devices(self):
        self.device_calls += 1
        if self._devices_error is not None:
            raise self._devices_error
        return list(self._devices)

    async def metadata(self, rating_key: str):
        return {"ratingKey": rating_key}


async def _world(db):
    user = User(username="sam", plex_user_id="1", plex_username="sam")
    server = PlexServer(
        machine_identifier="abc123",
        name="Home",
        base_url="http://plex:32400",
        access_token_encrypted=encrypt_secret("token") or "",
        enabled=True,
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
    return user, server, item, library


def _entry(*, history_key="h1", device_id=7, viewed_at=None, duration=8880000):
    entry = {
        "ratingKey": "42",
        "historyKey": history_key,
        "type": "movie",
        "viewedAt": int((viewed_at or utcnow()).timestamp()),
        "duration": duration,
    }
    if device_id is not None:
        entry["deviceID"] = device_id
    return entry


def _webhook_payload(player: dict | None):
    payload = {
        "event": "media.scrobble",
        "Account": {"id": "1"},
        "Server": {"uuid": "abc123"},
        "Metadata": {
            "ratingKey": "42",
            "type": "movie",
            "title": "The Matrix",
            "duration": 8880000,
        },
    }
    if player is not None:
        payload["Player"] = player
    return payload


APPLE_TV = PlexDevice(id="7", name="Living Room TV", platform="Apple TV")


async def _import(db, user, server, fake, monkeypatch, *, service=None):
    service = service or SyncService(db)
    monkeypatch.setattr(service, "client_for", lambda *_: _async(fake))
    await service.sync_history(user, server, SyncStats())
    return service


async def _events(db, user):
    result = await db.execute(
        select(WatchEvent)
        .where(WatchEvent.user_id == user.id)
        .order_by(WatchEvent.watched_at)
    )
    return result.scalars().all()


async def test_both_writers_describe_the_same_play_the_same_way(db, monkeypatch):
    """The webhook and the history import must fill the same column with the
    same kind of value. They did not: one wrote the app where the other wrote
    an integer, and the column meant to hold the client held neither."""
    user, server, item, _ = await _world(db)

    await handle_webhook(
        db,
        _webhook_payload({"title": "Living Room TV", "product": "Plex for Apple TV"}),
    )

    # A different play, ten minutes earlier, so it is not adopted into the
    # webhook's row — two separate events written by the two writers.
    earlier = utcnow() - timedelta(minutes=10)
    fake = FakeHistoryClient([_entry(viewed_at=earlier)], [APPLE_TV])
    await _import(db, user, server, fake, monkeypatch)

    events = await _events(db, user)
    assert len(events) == 2
    history, webhook = events[0], events[1]
    assert history.source == WatchSource.PLEX_HISTORY
    assert webhook.source == WatchSource.PLEX_WEBHOOK

    # The client is in `device` for both, and it is a name in both.
    assert history.device == "Living Room TV"
    assert webhook.device == "Living Room TV"
    for event in events:
        assert not (event.device or "").isdigit(), "a device id is not a device name"

    # The app is in `player` for both. Plex only tells the history import the
    # platform, which is the documented fallback — still an app-ish answer, and
    # never the client name.
    assert webhook.player == "Plex for Apple TV"
    assert history.player == "Apple TV"


async def test_the_webhook_no_longer_files_the_client_as_the_app(db):
    """This is a *swap* of what the webhook used to store, so say it out loud."""
    user, _server, _item, _library = await _world(db)

    await handle_webhook(db, _webhook_payload({"title": "Living Room TV"}))

    (event,) = await _events(db, user)
    assert event.device == "Living Room TV"  # was `player` before
    assert event.player is None  # this payload names no app at all


@pytest.mark.parametrize("block", [[], "Living Room TV", 7, {}, None])
async def test_a_malformed_player_block_is_not_a_5xx(db, block):
    """The webhook payload is attacker-supplied, and 5xx is the one answer that
    makes Plex retry and then disable the webhook."""
    user, _server, _item, _library = await _world(db)

    result = await handle_webhook(db, _webhook_payload(block))

    assert result["status"] == "ok"
    (event,) = await _events(db, user)
    assert event.device is None
    assert event.player is None


async def test_the_webhook_records_which_library_the_play_came_from(db):
    """The other field the two writers disagreed about.

    A webhook row only gained a `library_id` if the history import later
    adopted it, so a scrobble of something the import never reached was missing
    from every per-library total.
    """
    user, _server, _item, library = await _world(db)

    await handle_webhook(db, _webhook_payload({"title": "Living Room TV"}))

    (event,) = await _events(db, user)
    assert event.library_id == library.id


async def test_the_device_list_is_fetched_once_per_run(db, monkeypatch):
    """One call for the whole import, not one per row.

    A history import is already hundreds of requests in a few seconds, and
    CLAUDE.md records what happened the last time that number grew: a
    rate-limiting resolver stopped answering and both the Plex server and
    plex.tv became unresolvable mid-sync.
    """
    user, server, _item, _library = await _world(db)
    entries = [_entry(history_key=f"h{n}", viewed_at=utcnow() - timedelta(hours=n))
               for n in range(1, 51)]
    fake = FakeHistoryClient(entries, [APPLE_TV])

    service = await _import(db, user, server, fake, monkeypatch)
    assert len(await _events(db, user)) == 50
    assert fake.device_calls == 1, "the device list was fetched per history row"

    # And it stays cached for the rest of the run.
    await service.sync_history(user, server, SyncStats())
    assert fake.device_calls == 1


async def test_a_failing_device_list_does_not_fail_the_import(db, monkeypatch):
    """A missing device name is cosmetic; a broken history import is not."""
    user, server, _item, _library = await _world(db)
    fake = FakeHistoryClient(
        [_entry()], devices_error=PlexServerError("no soup for you")
    )

    await _import(db, user, server, fake, monkeypatch)

    (event,) = await _events(db, user)
    assert event.device is None
    assert event.player is None
    assert event.duration_ms == 8880000, "the play itself is recorded either way"


async def test_the_failed_lookup_is_not_retried_per_row(db, monkeypatch):
    """Re-asking a server that just said no, once per row, is the same burst."""
    user, server, _item, _library = await _world(db)
    entries = [_entry(history_key=f"h{n}", viewed_at=utcnow() - timedelta(hours=n))
               for n in range(1, 11)]
    fake = FakeHistoryClient(entries, devices_error=PlexServerError("nope"))

    await _import(db, user, server, fake, monkeypatch)
    assert fake.device_calls == 1


async def test_an_unknown_device_id_leaves_the_column_empty(db, monkeypatch):
    """Never the id itself. A column holding names *and* integers cannot be
    grouped, which is the whole bug."""
    user, server, _item, _library = await _world(db)
    fake = FakeHistoryClient([_entry(device_id=99)], [APPLE_TV])

    await _import(db, user, server, fake, monkeypatch)

    (event,) = await _events(db, user)
    assert event.device is None
    assert event.device != "99"


async def test_a_history_row_that_names_its_own_player_is_believed(db, monkeypatch):
    """Ask Plex what it thinks before reaching for a lookup."""
    user, server, _item, _library = await _world(db)
    entry = _entry(device_id=7)
    entry["Player"] = {"title": "Kitchen iPad", "product": "Plex for iOS"}
    fake = FakeHistoryClient([entry], [APPLE_TV])

    await _import(db, user, server, fake, monkeypatch)

    (event,) = await _events(db, user)
    assert event.device == "Kitchen iPad"
    assert event.player == "Plex for iOS"


async def test_an_adopted_webhook_row_ends_up_normalised(db, monkeypatch):
    """The subtle one.

    The import adopts a recent webhook row for the same play rather than
    inserting a second — so the surviving row must hold the normalised values,
    not whichever writer happened to touch it last.
    """
    user, server, _item, _library = await _world(db)
    await handle_webhook(db, _webhook_payload({"title": "Living Room TV"}))

    now = utcnow()
    fake = FakeHistoryClient(
        [_entry(viewed_at=now)],
        [PlexDevice(id="7", name="Den TV", platform="Apple TV")],
    )
    await _import(db, user, server, fake, monkeypatch)

    (event,) = await _events(db, user)
    assert event.source == WatchSource.PLEX_HISTORY, "the webhook row was adopted"
    # The server's own device table is the better answer where it has one.
    assert event.device == "Den TV"
    assert event.player == "Apple TV"


async def test_an_adopted_row_keeps_the_webhook_name_when_plex_will_not_say(
    db, monkeypatch
):
    """Adoption must not *lose* a name, either."""
    user, server, _item, _library = await _world(db)
    await handle_webhook(
        db, _webhook_payload({"title": "Living Room TV", "product": "Plex for Apple TV"})
    )

    fake = FakeHistoryClient(
        [_entry(viewed_at=utcnow())], devices_error=PlexServerError("403")
    )
    await _import(db, user, server, fake, monkeypatch)

    (event,) = await _events(db, user)
    assert event.source == WatchSource.PLEX_HISTORY
    assert event.device == "Living Room TV"
    assert event.player == "Plex for Apple TV"


async def test_device_ids_already_stored_are_resolved_to_names(db, monkeypatch):
    """Every row imported before this change holds `str(deviceID)`.

    Nothing else would ever revisit them — the history sync reads incrementally
    and never returns to a 2019 play — so the import repairs them itself, using
    the device table it has already fetched.
    """
    user, server, item, library = await _world(db)
    db.add_all(
        [
            WatchEvent(
                user_id=user.id,
                media_item_id=item.id,
                watched_at=utcnow() - timedelta(days=400),
                source=WatchSource.PLEX_HISTORY,
                dedupe_key="plex:abc123:old-known",
                completed=True,
                server_id=server.id,
                library_id=library.id,
                device="7",
            ),
            WatchEvent(
                user_id=user.id,
                media_item_id=item.id,
                watched_at=utcnow() - timedelta(days=399),
                source=WatchSource.PLEX_HISTORY,
                dedupe_key="plex:abc123:old-unknown",
                completed=True,
                server_id=server.id,
                library_id=library.id,
                device="99",
            ),
        ]
    )
    await db.commit()

    fake = FakeHistoryClient([], [APPLE_TV])
    await _import(db, user, server, fake, monkeypatch)

    known = await db.scalar(
        select(WatchEvent).where(WatchEvent.dedupe_key == "plex:abc123:old-known")
    )
    unknown = await db.scalar(
        select(WatchEvent).where(WatchEvent.dedupe_key == "plex:abc123:old-unknown")
    )
    assert known.device == "Living Room TV"
    assert known.player == "Apple TV"
    # An id the server no longer lists names nothing to anybody.
    assert unknown.device is None


async def test_stored_device_ids_survive_a_server_that_will_not_answer(
    db, monkeypatch
):
    """"Could not ask" is not "no such device".

    Clearing a name on the strength of a question that was never answered would
    destroy what a later owner-token run could have recovered.
    """
    user, server, item, library = await _world(db)
    db.add(
        WatchEvent(
            user_id=user.id,
            media_item_id=item.id,
            watched_at=utcnow() - timedelta(days=400),
            source=WatchSource.PLEX_HISTORY,
            dedupe_key="plex:abc123:old",
            completed=True,
            server_id=server.id,
            library_id=library.id,
            device="7",
        )
    )
    await db.commit()

    fake = FakeHistoryClient([], devices_error=PlexServerError("403"))
    await _import(db, user, server, fake, monkeypatch)

    stored = await db.scalar(
        select(WatchEvent).where(WatchEvent.dedupe_key == "plex:abc123:old")
    )
    assert stored.device == "7"
