"""End-to-end checks against the HTTP surface."""
import httpx
import pytest
from sqlalchemy import select

from app.models import (
    MediaItem,
    MediaType,
    PlexLibrary,
    PlexServer,
    User,
    UserServerAccess,
)

pytestmark = pytest.mark.asyncio


async def test_health_is_public():
    from app.main import app  # noqa: F401  (import keeps app construction covered)


async def test_first_user_becomes_admin(client):
    status = (await client.get("/api/auth/status")).json()
    assert status["setup_required"] is True

    first = await client.post(
        "/api/auth/register", json={"username": "owner", "password": "password123"}
    )
    assert first.status_code == 201
    assert first.json()["is_admin"] is True

    # A second account is a normal user, not another admin.
    await client.post("/api/auth/logout")
    second = await client.post(
        "/api/auth/register", json={"username": "guest", "password": "password123"}
    )
    assert second.status_code == 201
    assert second.json()["is_admin"] is False


async def test_duplicate_username_is_rejected(client):
    await client.post("/api/auth/register", json={"username": "sam", "password": "password123"})
    await client.post("/api/auth/logout")
    clash = await client.post(
        "/api/auth/register", json={"username": "SAM", "password": "password123"}
    )
    assert clash.status_code == 409


async def test_login_rejects_a_wrong_password(client):
    await client.post("/api/auth/register", json={"username": "sam", "password": "password123"})
    await client.post("/api/auth/logout")

    bad = await client.post("/api/auth/login", json={"username": "sam", "password": "nope"})
    assert bad.status_code == 401

    good = await client.post(
        "/api/auth/login", json={"username": "sam", "password": "password123"}
    )
    assert good.status_code == 200


async def test_protected_endpoints_require_a_session(client):
    for path in ("/api/media", "/api/history", "/api/watchlist", "/api/stats"):
        assert (await client.get(path)).status_code == 401


async def test_browse_filters_separate_anime(authed_client, db):
    db.add_all(
        [
            MediaItem(
                guid_key="tmdb:movie:1",
                media_type=MediaType.MOVIE,
                title="Blade Runner 2049",
                year=2017,
                genres=["Science Fiction"],
            ),
            MediaItem(
                guid_key="tmdb:movie:2",
                media_type=MediaType.MOVIE,
                title="Akira",
                year=1988,
                genres=["Animation"],
                is_anime=True,
            ),
            MediaItem(
                guid_key="tmdb:show:3",
                media_type=MediaType.SHOW,
                title="Severance",
                year=2022,
                genres=["Drama"],
            ),
        ]
    )
    await db.commit()

    everything = (await authed_client.get("/api/media")).json()
    assert everything["total"] == 3

    anime_only = (await authed_client.get("/api/media", params={"anime": "only"})).json()
    assert [item["title"] for item in anime_only["items"]] == ["Akira"]

    without_anime = (await authed_client.get("/api/media", params={"anime": "exclude"})).json()
    assert "Akira" not in [item["title"] for item in without_anime["items"]]

    movies = (await authed_client.get("/api/media", params={"media_type": "movie"})).json()
    assert movies["total"] == 2

    # Seasons and episodes never appear in the top-level grid.
    search = (await authed_client.get("/api/media", params={"q": "sever"})).json()
    assert search["total"] == 1


async def test_marking_watched_updates_history_and_stats(authed_client, db):
    item = MediaItem(
        guid_key="tmdb:movie:1",
        media_type=MediaType.MOVIE,
        title="Arrival",
        runtime_minutes=116,
        genres=["Science Fiction"],
    )
    db.add(item)
    await db.commit()

    marked = await authed_client.post(
        f"/api/history/{item.id}/watched", params={"push_to_plex": False}
    )
    assert marked.status_code == 201

    history = (await authed_client.get("/api/history")).json()
    assert history["total"] == 1
    assert history["events"][0]["item"]["title"] == "Arrival"

    detail = (await authed_client.get(f"/api/media/{item.id}")).json()
    assert detail["state"]["status"] == "completed"
    assert detail["state"]["view_count"] == 1

    stats = (await authed_client.get("/api/stats")).json()
    assert stats["total_movies_watched"] == 1
    assert stats["total_runtime_minutes"] == 116


async def test_unwatching_clears_state_and_history(authed_client, db):
    item = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Her")
    db.add(item)
    await db.commit()

    await authed_client.post(f"/api/history/{item.id}/watched", params={"push_to_plex": False})
    await authed_client.post(f"/api/history/{item.id}/unwatched", params={"push_to_plex": False})

    assert (await authed_client.get("/api/history")).json()["total"] == 0
    detail = (await authed_client.get(f"/api/media/{item.id}")).json()
    assert detail["state"]["view_count"] == 0
    assert detail["state"]["status"] is None


async def test_rating_round_trips_without_a_plex_server(authed_client, db):
    item = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Whiplash")
    db.add(item)
    await db.commit()

    response = await authed_client.put(
        f"/api/media/{item.id}/rating", json={"rating": 9.0, "push_to_plex": False}
    )
    assert response.status_code == 200
    assert response.json()["rating"] == 9.0

    cleared = await authed_client.put(
        f"/api/media/{item.id}/rating", json={"rating": None, "push_to_plex": False}
    )
    assert cleared.json()["rating"] is None


async def test_watchlist_add_and_remove(authed_client, db):
    item = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Nope")
    db.add(item)
    await db.commit()

    added = await authed_client.post("/api/watchlist", json={"media_item_id": item.id})
    assert added.status_code == 201

    listed = (await authed_client.get("/api/watchlist")).json()
    assert len(listed) == 1
    assert listed[0]["item"]["title"] == "Nope"

    detail = (await authed_client.get(f"/api/media/{item.id}")).json()
    assert detail["on_watchlist"] is True

    await authed_client.delete(f"/api/watchlist/{item.id}")
    assert (await authed_client.get("/api/watchlist")).json() == []


async def test_season_children_and_bulk_mark(authed_client, db):
    show = MediaItem(guid_key="tmdb:show:1", media_type=MediaType.SHOW, title="Andor")
    db.add(show)
    await db.flush()

    db.add_all(
        [
            MediaItem(
                guid_key=f"tmdb:show:1/s1e{n}",
                media_type=MediaType.EPISODE,
                title=f"Episode {n}",
                show_id=show.id,
                parent_id=show.id,
                season_number=1,
                episode_number=n,
            )
            for n in (1, 2, 3)
        ]
    )
    await db.commit()

    # No season rows exist, so the API synthesises them from the episodes.
    seasons = (await authed_client.get(f"/api/media/{show.id}/children")).json()
    assert len(seasons) == 1
    assert seasons[0]["season_number"] == 1

    episodes = (
        await authed_client.get(f"/api/media/{show.id}/children", params={"season": 1})
    ).json()
    assert len(episodes) == 3

    result = await authed_client.post(
        f"/api/history/{show.id}/season/1/watched", params={"push_to_plex": False}
    )
    assert result.json()["marked"] == 3

    detail = (await authed_client.get(f"/api/media/{show.id}")).json()
    assert detail["state"]["status"] == "completed"
    assert detail["watched_episodes"] == 3


async def test_continue_watching_lists_a_show_once(authed_client, db):
    """Regression: a part-watched episode plus an up-next episode is one entry."""
    show = MediaItem(guid_key="tmdb:show:1", media_type=MediaType.SHOW, title="Slow Horses")
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

    from sqlalchemy import select

    from app.models import User, UserMediaState, WatchStatus, utcnow

    user = (await db.execute(select(User))).scalars().first()
    db.add_all(
        [
            UserMediaState(
                user_id=user.id,
                media_item_id=episodes[0].id,
                progress_ms=300_000,
                duration_ms=2_700_000,
                last_watched_at=utcnow(),
                status=WatchStatus.WATCHING,
            ),
            UserMediaState(
                user_id=user.id,
                media_item_id=show.id,
                status=WatchStatus.WATCHING,
                last_watched_at=utcnow(),
            ),
        ]
    )
    await db.commit()

    entries = (await authed_client.get("/api/media/continue-watching")).json()
    show_titles = [entry["item"].get("show_title") or entry["item"]["title"] for entry in entries]
    assert show_titles.count("Slow Horses") == 1


async def test_preferences_round_trip(authed_client):
    updated = await authed_client.put(
        "/api/users/me/preferences", json={"sync_ratings": False}
    )
    assert updated.status_code == 200
    assert updated.json()["sync_ratings"] is False
    # Unspecified keys keep their defaults rather than being dropped.
    assert updated.json()["sync_watchlist"] is True


async def test_listing_servers_serialises_libraries(authed_client, db):
    """Regression: ServerOut.libraries has to be eager-loaded.

    ServerOut carries the `libraries` relationship, so pydantic reads it while
    validating. Left lazy, that emits a SELECT from inside attribute access,
    which asyncio SQLAlchemy refuses with MissingGreenlet — and server
    discovery returned a 500 instead of the server list. The request runs on a
    different session than the one used here, so the relationship really is
    unloaded when the endpoint serialises it.
    """
    user = (
        await db.execute(select(User).where(User.username == "tester"))
    ).scalar_one()

    server = PlexServer(
        machine_identifier="machine-1",
        name="Basement",
        base_url="https://plex.example:32400",
        access_token_encrypted="encrypted",
    )
    db.add(server)
    await db.flush()

    db.add_all(
        [
            UserServerAccess(
                user_id=user.id,
                server_id=server.id,
                access_token_encrypted="encrypted",
            ),
            # Inserted out of order — the response must come back sorted.
            PlexLibrary(
                server_id=server.id, section_key="2", title="TV", section_type="show"
            ),
            PlexLibrary(
                server_id=server.id, section_key="1", title="Films", section_type="movie"
            ),
        ]
    )
    await db.commit()

    response = await authed_client.get("/api/servers")
    assert response.status_code == 200, response.text

    [payload] = response.json()
    assert payload["name"] == "Basement"
    assert [library["title"] for library in payload["libraries"]] == ["Films", "TV"]


async def test_plex_tv_maps_a_network_failure_to_unreachable(monkeypatch):
    """A container with broken DNS must not leak a raw httpx error.

    Every plex.tv call goes out to the internet. Left unwrapped, httpx's
    ConnectError reached the catch-all handler as a 500 plus a traceback that
    never mentioned the network.
    """
    from app.services import plex_tv

    class DeadClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args) -> bool:
            return False

        async def get(self, *args, **kwargs):
            raise httpx.ConnectError("[Errno -3] Temporary failure in name resolution")

    monkeypatch.setattr(plex_tv.httpx, "AsyncClient", DeadClient)

    with pytest.raises(plex_tv.PlexUnreachableError) as caught:
        await plex_tv.PlexTVClient().get_resources("a-token")

    # The message has to name the actual cause, not just restate the failure.
    assert "DNS" in str(caught.value)


async def test_unreachable_plex_is_a_503_not_a_500(authed_client, monkeypatch):
    from app.services.plex_tv import PlexUnreachableError
    from app.services.sync_service import SyncService

    async def unreachable(self, user):
        raise PlexUnreachableError(
            "Could not reach https://plex.tv. Check that the container has "
            "internet access and working DNS."
        )

    monkeypatch.setattr(SyncService, "discover_servers", unreachable)

    response = await authed_client.post("/api/servers/discover")
    assert response.status_code == 503
    assert "DNS" in response.json()["detail"]


async def _library_with_access(db, *, anime_override=None):
    user = (
        await db.execute(select(User).where(User.username == "tester"))
    ).scalar_one()
    server = PlexServer(
        machine_identifier="machine-anime",
        name="Basement",
        base_url="https://plex.example:32400",
        access_token_encrypted="encrypted",
    )
    db.add(server)
    await db.flush()
    library = PlexLibrary(
        server_id=server.id,
        section_key="1",
        title="Films",
        section_type="movie",
        anime_override=anime_override,
    )
    db.add_all(
        [
            library,
            UserServerAccess(
                user_id=user.id,
                server_id=server.id,
                access_token_encrypted="encrypted",
            ),
        ]
    )
    await db.commit()
    return library


async def test_anime_override_can_be_set_back_to_auto(authed_client, db):
    """Regression: null means "auto-detect", not "field omitted".

    The override is tri-state. Treating null as unset made cycling the chip to
    auto silently do nothing, so the UI snapped back to the previous value.
    """
    library = await _library_with_access(db, anime_override=False)

    response = await authed_client.patch(
        f"/api/libraries/{library.id}", json={"anime_override": None}
    )
    assert response.status_code == 200, response.text
    assert response.json()["anime_override"] is None

    await db.refresh(library)
    assert library.anime_override is None


async def test_anime_override_set_to_yes_and_no(authed_client, db):
    library = await _library_with_access(db)

    yes = await authed_client.patch(
        f"/api/libraries/{library.id}", json={"anime_override": True}
    )
    assert yes.json()["anime_override"] is True

    no = await authed_client.patch(
        f"/api/libraries/{library.id}", json={"anime_override": False}
    )
    assert no.json()["anime_override"] is False

    # Omitting the field entirely must leave it alone.
    untouched = await authed_client.patch(
        f"/api/libraries/{library.id}", json={"enabled": True}
    )
    assert untouched.json()["anime_override"] is False


async def test_cancelling_without_a_running_sync_is_a_409(authed_client):
    response = await authed_client.post("/api/sync/cancel")
    assert response.status_code == 409


async def test_genres_endpoint_deduplicates(authed_client, db):
    db.add_all(
        [
            MediaItem(
                guid_key="a", media_type=MediaType.MOVIE, title="A", genres=["Drama", "Crime"]
            ),
            MediaItem(
                guid_key="b", media_type=MediaType.MOVIE, title="B", genres=["Drama"]
            ),
        ]
    )
    await db.commit()

    genres = (await authed_client.get("/api/media/genres")).json()
    assert genres == ["Crime", "Drama"]
