"""The Plex webhook receiver.

This endpoint cannot be authenticated — Plex sends no credentials — so every
field in the payload is attacker-supplied. Two rules matter and neither was
covered before: it must never answer 5xx (Plex retries, then disables the
webhook), and it must only ever touch accounts and servers that are already
linked.
"""
import json

import pytest
from sqlalchemy import select

from app.models import (
    MediaItem,
    MediaType,
    PlexMapping,
    PlexServer,
    User,
    WatchEvent,
)
from app.security import encrypt_secret

pytestmark = pytest.mark.asyncio


async def _server_and_item(db, *, machine_id="known-machine"):
    server = PlexServer(
        machine_identifier=machine_id,
        name="Home",
        base_url="http://plex:32400",
        access_token_encrypted=encrypt_secret("token") or "",
        enabled=True,
    )
    item = MediaItem(guid_key="tmdb:movie:9", media_type=MediaType.MOVIE, title="Heat")
    db.add_all([server, item])
    await db.flush()
    db.add(PlexMapping(media_item_id=item.id, server_id=server.id, rating_key="55"))
    await db.commit()
    return server, item


def _payload(**over):
    body = {
        "event": "media.scrobble",
        "Account": {"title": "sam"},
        "Server": {"uuid": "known-machine"},
        "Metadata": {"ratingKey": "55", "type": "movie", "title": "Heat"},
    }
    body.update(over)
    return {"payload": json.dumps(body)}


@pytest.mark.parametrize(
    "body",
    [
        {"payload": "not json at all"},
        {"payload": json.dumps([1, 2, 3])},
        {"payload": json.dumps({"event": "media.scrobble"})},
        {"payload": json.dumps({})},
        {"nothing": "useful"},
    ],
)
async def test_webhook_never_answers_5xx(client, body):
    """Plex disables a webhook that keeps failing, so garbage must not 500."""
    response = await client.post("/api/webhooks/plex", data=body)
    assert response.status_code < 500, response.text


async def test_a_forged_payload_cannot_reach_a_local_account(client, db):
    """Regression: matching `User.username` let anyone write to any account.

    `_resolve_user` fell back to the local username, so a payload naming an
    account with no Plex link at all — needing nothing but a guessable name —
    recorded watch events against it.
    """
    await _server_and_item(db)
    db.add(User(username="sam", plex_username=None))
    await db.commit()

    response = await client.post("/api/webhooks/plex", data=_payload())
    assert response.status_code == 200
    assert response.json()["status"] == "ignored"

    events = (await db.execute(select(WatchEvent))).scalars().all()
    assert events == [], "a forged webhook wrote into a local-only account"


async def test_an_unknown_server_is_ignored_not_guessed(client, db):
    """Regression: an unrecognised uuid fell back to the first enabled server.

    That attributed a forged event to an arbitrary real server and wrote
    PlexMapping rows pointing one server's rating keys at another.
    """
    await _server_and_item(db)
    db.add(User(username="sam", plex_username="sam"))
    await db.commit()

    for server_block in ({"uuid": "some-other-machine"}, {}, None):
        payload = _payload(Server=server_block) if server_block is not None else _payload()
        if server_block is None:
            body = json.loads(payload["payload"])
            del body["Server"]
            payload = {"payload": json.dumps(body)}

        response = await client.post("/api/webhooks/plex", data=payload)
        assert response.status_code == 200
        assert response.json()["status"] == "ignored", response.text

    events = (await db.execute(select(WatchEvent))).scalars().all()
    assert events == []
