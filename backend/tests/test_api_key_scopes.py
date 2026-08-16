"""What an API key may do, and what it may not.

A key is the credential that leaves the machine — into Grafana, Home Assistant,
a cron script — and in at least one of those places anybody who can edit a
dashboard can proxy arbitrary requests through it. So the interesting assertions
here are the *refusals*: a key that cannot write must not write, and a key
scoped to statistics must not be able to read the library or the user list.

The other half is the upgrade path. Every key issued before scopes existed acted
as its owner with no limit, and must keep doing so — a security feature that
silently revokes working credentials is an outage.
"""
import pytest
from sqlalchemy import select, text

from app.models import ApiKey, ApiKeyScope

pytestmark = pytest.mark.asyncio


async def _issue(client, name: str, scope: str | None = None) -> str:
    payload: dict = {"name": name}
    if scope is not None:
        payload["scope"] = scope
    created = await client.post("/api/keys", json=payload)
    assert created.status_code == 201, created.text
    return created.json()["key"]


async def test_a_key_defaults_to_full_access(authed_client, bare_client):
    """Omitting the scope keeps the historical behaviour, for old clients."""
    raw = await _issue(authed_client, "no scope named")

    listed = (await authed_client.get("/api/keys")).json()
    assert listed[0]["scope"] == "full"

    headers = {"X-API-Key": raw}
    assert (await bare_client.get("/api/media", headers=headers)).status_code == 200
    # A write, and an admin-only read: everything a session of this user can do.
    written = await bare_client.put(
        "/api/users/me/preferences", json={"sync_ratings": False}, headers=headers
    )
    assert written.status_code == 200
    assert (await bare_client.get("/api/users", headers=headers)).status_code == 200


async def test_a_read_only_key_reads_but_never_writes(authed_client, bare_client):
    raw = await _issue(authed_client, "grafana", "read_only")
    headers = {"X-API-Key": raw}

    assert (await bare_client.get("/api/media", headers=headers)).status_code == 200
    assert (await bare_client.get("/api/stats", headers=headers)).status_code == 200
    assert (await bare_client.get("/api/keys", headers=headers)).status_code == 200

    # Every state-changing method is refused, whatever the endpoint would have
    # done — including issuing a *new* key, which is how a narrow key would
    # otherwise mint a wide one.
    assert (
        await bare_client.put(
            "/api/users/me/preferences", json={"sync_ratings": False}, headers=headers
        )
    ).status_code == 403
    assert (
        await bare_client.post("/api/keys", json={"name": "escalate"}, headers=headers)
    ).status_code == 403
    assert (await bare_client.post("/api/sync", headers=headers)).status_code == 403
    assert (await bare_client.delete("/api/keys/1", headers=headers)).status_code == 403

    # Refused, not merely unauthenticated: the caller is known, the request is
    # not allowed. And nothing happened — the preference is untouched.
    prefs = await bare_client.get("/api/users/me/preferences", headers=headers)
    assert prefs.status_code == 200
    assert prefs.json()["sync_ratings"] is True


async def test_a_stats_key_reaches_statistics_and_nothing_else(
    authed_client, bare_client
):
    raw = await _issue(authed_client, "dashboard", "stats")
    headers = {"X-API-Key": raw}

    assert (await bare_client.get("/api/stats", headers=headers)).status_code == 200
    assert (
        await bare_client.get("/api/stats/summary", headers=headers)
    ).status_code == 200
    assert (await bare_client.get("/api/version", headers=headers)).status_code == 200
    assert (await bare_client.get("/api/health", headers=headers)).status_code == 200

    # The library, the user list and the keys themselves are all off-limits —
    # the path allowlist, not the method, is doing the work here.
    for path in ("/api/media", "/api/users", "/api/keys", "/api/history"):
        response = await bare_client.get(path, headers=headers)
        assert response.status_code == 403, path


async def test_the_stats_allowlist_matches_paths_not_prefixes():
    """A path that merely starts with the same letters is not below it.

    Checked directly rather than over HTTP: an unrouted path is a 404 before any
    dependency runs, so the request would never reach the rule being tested.
    """
    from fastapi import HTTPException
    from starlette.requests import Request

    from app.deps import _enforce_key_scope

    def request_for(path: str, method: str = "GET") -> Request:
        return Request(
            {
                "type": "http",
                "method": method,
                "path": path,
                "raw_path": path.encode(),
                "query_string": b"",
                "headers": [],
                "scheme": "http",
                "server": ("testserver", 80),
            }
        )

    stats = ApiKeyScope.STATS.value
    _enforce_key_scope(stats, request_for("/api/stats"))
    _enforce_key_scope(stats, request_for("/api/stats/summary"))
    _enforce_key_scope(stats, request_for("/metrics"))

    for path in ("/api/statsomething", "/api/stats-export", "/metricsx", "/api"):
        with pytest.raises(HTTPException) as refused:
            _enforce_key_scope(stats, request_for(path))
        assert refused.value.status_code == 403, path

    # A read-only key is bounded by method alone, not by path.
    _enforce_key_scope(ApiKeyScope.READ_ONLY.value, request_for("/api/media"))
    for method in ("POST", "PUT", "PATCH", "DELETE"):
        with pytest.raises(HTTPException):
            _enforce_key_scope(
                ApiKeyScope.READ_ONLY.value, request_for("/api/media", method)
            )

    # And a full key is bounded by neither.
    _enforce_key_scope(ApiKeyScope.FULL.value, request_for("/api/users", "DELETE"))

    # A missing value is not a free pass either.
    with pytest.raises(HTTPException):
        _enforce_key_scope(None, request_for("/api/stats"))


async def test_a_key_is_never_read_from_the_query_string(authed_client, bare_client):
    """Uvicorn logs query strings at INFO, and users paste logs into issues."""
    raw = await _issue(authed_client, "url key")

    for query in (f"?api_key={raw}", f"?token={raw}", f"?X-API-Key={raw}"):
        response = await bare_client.get(f"/api/media{query}")
        assert response.status_code == 401, query


async def test_an_unrecognised_scope_is_refused_rather_than_guessed(
    authed_client, bare_client, db
):
    """Fail closed: a hand-edited row must not resolve to the nearest thing."""
    raw = await _issue(authed_client, "tampered")

    await db.execute(text("UPDATE api_keys SET scope = 'superuser'"))
    await db.commit()

    headers = {"X-API-Key": raw}
    assert (await bare_client.get("/api/media", headers=headers)).status_code == 403
    assert (await bare_client.get("/api/stats", headers=headers)).status_code == 403


async def test_a_revoked_key_is_still_rejected_before_its_scope_matters(
    authed_client, bare_client
):
    raw = await _issue(authed_client, "revoke me", "read_only")
    key_id = (await authed_client.get("/api/keys")).json()[0]["id"]
    assert (await authed_client.delete(f"/api/keys/{key_id}")).status_code == 204

    # 401, not 403: the key is not a credential at all any more.
    assert (
        await bare_client.get("/api/media", headers={"X-API-Key": raw})
    ).status_code == 401


async def test_light_migrations_default_existing_keys_to_full_and_are_idempotent(
    authed_client, bare_client, db, engine, monkeypatch
):
    """An upgraded database must end up where a fresh one starts.

    The column is added with `DEFAULT 'full'`, so a key issued before scopes
    existed keeps the access it was issued with. Dropping the column here is the
    closest a test can get to yesterday's schema — after the migration the row
    must read `full` regardless of what it held before.
    """
    from app import db as db_module

    raw = await _issue(authed_client, "issued before scopes", "stats")
    monkeypatch.setattr(db_module, "engine", engine)

    async with engine.begin() as conn:
        await conn.execute(text("ALTER TABLE api_keys DROP COLUMN scope"))
        await conn.execute(text("DROP INDEX IF EXISTS ix_watch_events_user_item_time"))

    await db_module._run_light_migrations()

    stored = (await db.execute(select(ApiKey))).scalars().one()
    assert stored.scope == ApiKeyScope.FULL.value

    # And it behaves as a full key: a write goes through.
    written = await bare_client.put(
        "/api/users/me/preferences",
        json={"sync_ratings": False},
        headers={"X-API-Key": raw},
    )
    assert written.status_code == 200

    async def shape() -> tuple[list, list]:
        async with engine.begin() as conn:
            columns = list(await conn.execute(text("PRAGMA table_info(api_keys)")))
            indexes = list(await conn.execute(text("PRAGMA index_list(watch_events)")))
        return [row[1] for row in columns], sorted(row[1] for row in indexes)

    before = await shape()
    assert "scope" in before[0]
    assert "ix_watch_events_user_item_time" in before[1]

    # Running the whole thing again changes nothing and raises nothing. Every
    # step has to survive that: `init_db` runs it on every boot.
    await db_module._run_light_migrations()
    await db_module._run_light_migrations()
    assert await shape() == before
