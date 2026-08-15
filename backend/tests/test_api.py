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
from app.security import encrypt_secret

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
    assert listed["total"] == 1
    assert listed["entries"][0]["item"]["title"] == "Nope"

    detail = (await authed_client.get(f"/api/media/{item.id}")).json()
    assert detail["on_watchlist"] is True

    await authed_client.delete(f"/api/watchlist/{item.id}")
    emptied = (await authed_client.get("/api/watchlist")).json()
    assert emptied["total"] == 0
    assert emptied["entries"] == []


async def test_watchlist_takes_the_same_filters_as_the_grid(authed_client, db):
    """The watchlist browses the same rows, so it offers the same controls."""
    from datetime import timedelta

    from app.models import User, UserMediaState, WatchlistEntry, utcnow

    user = (await db.execute(select(User))).scalars().first()
    items = [
        MediaItem(
            guid_key="tmdb:movie:1",
            media_type=MediaType.MOVIE,
            title="Akira",
            year=1988,
            genres=["Animation"],
            is_anime=True,
        ),
        MediaItem(
            guid_key="tmdb:movie:2",
            media_type=MediaType.MOVIE,
            title="Heat",
            year=1995,
            genres=["Crime"],
        ),
        MediaItem(
            guid_key="tmdb:show:3",
            media_type=MediaType.SHOW,
            title="Severance",
            year=2022,
            genres=["Drama"],
        ),
    ]
    db.add_all(items)
    await db.flush()

    # Watchlisted in this order, one day apart, so "added" has a real ordering.
    for offset, item in enumerate(items):
        db.add(
            WatchlistEntry(
                user_id=user.id,
                media_item_id=item.id,
                added_at=utcnow() - timedelta(days=len(items) - offset),
                source="manual",
                active=True,
            )
        )
    db.add(UserMediaState(user_id=user.id, media_item_id=items[1].id, rating=9.0))
    await db.commit()

    async def titles(query: str = "") -> list[str]:
        payload = (await authed_client.get(f"/api/watchlist{query}")).json()
        return [entry["item"]["title"] for entry in payload["entries"]]

    # Default: most recently added to the *watchlist* first.
    assert await titles() == ["Severance", "Heat", "Akira"]
    assert await titles("?sort=watchlist_added&order=asc") == [
        "Akira",
        "Heat",
        "Severance",
    ]

    # Every filter the grid has works here too.
    assert await titles("?sort=title&order=asc") == ["Akira", "Heat", "Severance"]
    assert await titles("?media_type=movie&sort=title&order=asc") == ["Akira", "Heat"]
    assert await titles("?anime=only") == ["Akira"]
    assert await titles("?anime=exclude&sort=title&order=asc") == ["Heat", "Severance"]
    assert await titles("?genre=Drama") == ["Severance"]
    assert await titles("?year=1995") == ["Heat"]
    assert await titles("?q=sever") == ["Severance"]
    assert await titles("?min_rating=8") == ["Heat"]
    assert await titles("?unwatched=true&sort=title&order=asc") == ["Akira", "Heat", "Severance"]

    # Paging reports the full match count, not the size of the page.
    page = (await authed_client.get("/api/watchlist?limit=1&sort=title&order=asc")).json()
    assert page["total"] == 3
    assert len(page["entries"]) == 1
    assert page["entries"][0]["item"]["title"] == "Akira"

    second = (
        await authed_client.get("/api/watchlist?limit=1&offset=1&sort=title&order=asc")
    ).json()
    assert second["entries"][0]["item"]["title"] == "Heat"


async def test_watchlist_sorts_are_independent_of_library_added(authed_client, db):
    """"Added" on this page means added to the watchlist, not to the library.

    They are genuinely different dates â€” something can sit in your library for a
    year before you decide to watchlist it â€” so the two sorts must not collapse
    into each other.
    """
    from datetime import timedelta

    from app.models import User, WatchlistEntry, utcnow

    user = (await db.execute(select(User))).scalars().first()
    old_file = MediaItem(
        guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Old file"
    )
    new_file = MediaItem(
        guid_key="tmdb:movie:2", media_type=MediaType.MOVIE, title="New file"
    )
    db.add_all([old_file, new_file])
    await db.flush()
    old_file.created_at = utcnow() - timedelta(days=400)
    new_file.created_at = utcnow()

    # Watchlisted in the opposite order to when the files appeared.
    db.add_all(
        [
            WatchlistEntry(
                user_id=user.id,
                media_item_id=old_file.id,
                added_at=utcnow(),
                source="manual",
                active=True,
            ),
            WatchlistEntry(
                user_id=user.id,
                media_item_id=new_file.id,
                added_at=utcnow() - timedelta(days=30),
                source="manual",
                active=True,
            ),
        ]
    )
    await db.commit()

    async def titles(query: str) -> list[str]:
        payload = (await authed_client.get(f"/api/watchlist?{query}")).json()
        return [entry["item"]["title"] for entry in payload["entries"]]

    assert await titles("sort=watchlist_added&order=desc") == ["Old file", "New file"]
    assert await titles("sort=added&order=desc") == ["New file", "Old file"]


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


async def test_continue_watching_ages_out_past_the_on_deck_window(authed_client, db):
    """Plex's onDeckWindow decides what is too old to still be "continuing"."""
    from datetime import timedelta

    from app.models import User, UserMediaState, utcnow

    user = (await db.execute(select(User))).scalars().first()

    server = PlexServer(
        machine_identifier="machine-1",
        name="Basement",
        base_url="https://plex.example:32400",
        access_token_encrypted="encrypted",
        on_deck_window_weeks=16,
    )
    db.add(server)
    await db.flush()
    db.add(
        UserServerAccess(
            user_id=user.id, server_id=server.id, access_token_encrypted="encrypted"
        )
    )

    recent = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Dune")
    abandoned = MediaItem(
        guid_key="tmdb:movie:2", media_type=MediaType.MOVIE, title="Tenet"
    )
    db.add_all([recent, abandoned])
    await db.flush()

    db.add_all(
        [
            UserMediaState(
                user_id=user.id,
                media_item_id=recent.id,
                progress_ms=600_000,
                duration_ms=9_000_000,
                last_watched_at=utcnow() - timedelta(days=3),
            ),
            UserMediaState(
                user_id=user.id,
                media_item_id=abandoned.id,
                progress_ms=600_000,
                duration_ms=9_000_000,
                last_watched_at=utcnow() - timedelta(days=3 * 365),
            ),
        ]
    )
    await db.commit()

    entries = (await authed_client.get("/api/media/continue-watching")).json()
    assert [entry["item"]["title"] for entry in entries] == ["Dune"]

    settings = (await authed_client.get("/api/settings")).json()
    assert settings["plex_on_deck_weeks"] == 16
    assert settings["continue_watching_weeks"] == 16

    # 0 means "never age anything out", and outranks what Plex reports.
    await authed_client.put(
        "/api/users/me/preferences", json={"continue_watching_weeks": 0}
    )
    kept = (await authed_client.get("/api/media/continue-watching")).json()
    assert {entry["item"]["title"] for entry in kept} == {"Dune", "Tenet"}

    # Back to null: following Plex again, so the old one drops off once more.
    await authed_client.put(
        "/api/users/me/preferences", json={"continue_watching_weeks": None}
    )
    followed = (await authed_client.get("/api/media/continue-watching")).json()
    assert [entry["item"]["title"] for entry in followed] == ["Dune"]


async def test_continue_watching_window_defaults_without_a_server(authed_client, db):
    """No server has reported a window, so Plex's own default of 16 weeks applies."""
    from datetime import timedelta

    from app.models import User, UserMediaState, utcnow

    user = (await db.execute(select(User))).scalars().first()
    item = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Heat")
    db.add(item)
    await db.flush()
    db.add(
        UserMediaState(
            user_id=user.id,
            media_item_id=item.id,
            progress_ms=600_000,
            duration_ms=9_000_000,
            last_watched_at=utcnow() - timedelta(weeks=30),
        )
    )
    await db.commit()

    assert (await authed_client.get("/api/media/continue-watching")).json() == []
    settings = (await authed_client.get("/api/settings")).json()
    assert settings["plex_on_deck_weeks"] is None
    assert settings["continue_watching_weeks"] == 16


async def test_artwork_proxy_only_serves_paths_stored_on_the_item(authed_client, db):
    """The proxy reads the path off the row, never from the caller."""
    import httpx as httpx_module

    from app.models import User

    bare = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Bare")
    arted = MediaItem(
        guid_key="tmdb:movie:2",
        media_type=MediaType.MOVIE,
        title="Arted",
        discover_thumb_path="/library/metadata/abc/thumb/1",
    )
    db.add_all([bare, arted])
    await db.commit()

    # Nothing stored, nothing served â€” the tile falls back to its gradient.
    assert (await authed_client.get(f"/api/images/{bare.id}/poster")).status_code == 404
    assert (await authed_client.get("/api/images/99999/poster")).status_code == 404

    # A path is stored, but this account has no Plex token to fetch it with.
    assert (await authed_client.get(f"/api/images/{arted.id}/poster")).status_code == 404

    user = (await db.execute(select(User))).scalars().first()
    user.plex_token_encrypted = encrypt_secret("plex-token")
    await db.commit()

    requested: dict = {}

    class FakeResponse:
        status_code = 200
        content = b"\xff\xd8\xff-jpeg-bytes"
        headers = {"content-type": "image/jpeg"}

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None):
            requested["url"] = url
            requested["token"] = (headers or {}).get("X-Plex-Token")
            return FakeResponse()

    original = httpx_module.AsyncClient
    httpx_module.AsyncClient = FakeClient  # type: ignore[misc]
    try:
        response = await authed_client.get(f"/api/images/{arted.id}/poster")
    finally:
        httpx_module.AsyncClient = original  # type: ignore[misc]

    assert response.status_code == 200
    assert response.content == b"\xff\xd8\xff-jpeg-bytes"
    assert response.headers["content-type"] == "image/jpeg"
    # Resolved against Discover, with the token in a header â€” never the URL.
    assert requested["url"] == (
        "https://discover.provider.plex.tv/library/metadata/abc/thumb/1"
    )
    assert requested["token"] == "plex-token"


async def test_artwork_on_a_plex_server_is_proxied_not_linked(authed_client, db):
    """Regression: a poster URL must never carry a Plex token.

    Tally used to store `â€¦/photo/:/transcode?â€¦&X-Plex-Token=â€¦` on the item. A
    MediaItem row is read by every account, so that handed one user's server
    token to all of them â€” and baked in whichever address answered during the
    sync, so posters broke when the library was opened from another network.
    """
    from app.models import PlexMapping
    from app.services import plex_server as plex_server_module

    user = (await db.execute(select(User))).scalars().first()
    server = PlexServer(
        machine_identifier="machine-1",
        name="Basement",
        base_url="https://plex.example:32400",
        access_token_encrypted=encrypt_secret("server-token"),
        owner_user_id=user.id,
    )
    item = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Dune")
    db.add_all([server, item])
    await db.flush()
    db.add_all(
        [
            UserServerAccess(
                user_id=user.id,
                server_id=server.id,
                access_token_encrypted=encrypt_secret("user-token"),
            ),
            PlexMapping(
                media_item_id=item.id,
                server_id=server.id,
                rating_key="1234",
                thumb_path="/library/metadata/1234/thumb/999",
            ),
        ]
    )
    await db.commit()

    # The grid points at Tally, not at the Plex server.
    listing = (await authed_client.get("/api/media")).json()
    card = next(entry for entry in listing["items"] if entry["title"] == "Dune")
    assert card["poster_url"] == f"/api/images/{item.id}/poster"

    seen: dict = {}

    async def fake_request(self, method, path, *, params=None, retries=1, record_failures=True):
        seen["path"] = path
        seen["params"] = params
        seen["token"] = self.token

        class Resp:
            status_code = 200
            content = b"jpeg-bytes"
            headers = {"content-type": "image/jpeg"}

        return Resp()

    original = plex_server_module.PlexServerClient._request
    plex_server_module.PlexServerClient._request = fake_request  # type: ignore[assignment]
    try:
        response = await authed_client.get(f"/api/images/{item.id}/poster")
    finally:
        plex_server_module.PlexServerClient._request = original  # type: ignore[assignment]

    assert response.status_code == 200
    assert response.content == b"jpeg-bytes"
    assert seen["path"] == "/photo/:/transcode"
    assert seen["params"]["url"] == "/library/metadata/1234/thumb/999"
    # Fetched with this user's own token, and not through a URL parameter.
    assert seen["token"] == "user-token"
    assert "X-Plex-Token" not in seen["params"]


async def test_the_owner_gets_artwork_without_an_access_row(authed_client, db):
    """Regression: the proxy must not be stricter than `client_for`.

    `client_for` falls back to the server's own token when the user owns it and
    has no UserServerAccess row. The proxy used to require that row as a join,
    so an owner in exactly that state got no artwork at all.
    """
    from app.models import PlexMapping
    from app.services import plex_server as plex_server_module

    user = (await db.execute(select(User))).scalars().first()
    server = PlexServer(
        machine_identifier="machine-1",
        name="Basement",
        base_url="https://plex.example:32400",
        access_token_encrypted=encrypt_secret("owner-token"),
        owner_user_id=user.id,
    )
    item = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Dune")
    db.add_all([server, item])
    await db.flush()
    # Deliberately no UserServerAccess row.
    db.add(
        PlexMapping(
            media_item_id=item.id,
            server_id=server.id,
            rating_key="1234",
            thumb_path="/library/metadata/1234/thumb/999",
        )
    )
    await db.commit()

    seen: dict = {}

    async def fake_request(self, method, path, *, params=None, retries=1, record_failures=True):
        seen["token"] = self.token

        class Resp:
            status_code = 200
            content = b"jpeg-bytes"
            headers = {"content-type": "image/jpeg"}

        return Resp()

    original = plex_server_module.PlexServerClient._request
    plex_server_module.PlexServerClient._request = fake_request  # type: ignore[assignment]
    try:
        response = await authed_client.get(f"/api/images/{item.id}/poster")
    finally:
        plex_server_module.PlexServerClient._request = original  # type: ignore[assignment]

    assert response.status_code == 200
    assert seen["token"] == "owner-token"


async def test_an_unreachable_server_does_not_500_a_poster(authed_client, db):
    from app.models import PlexMapping
    from app.services import plex_server as plex_server_module

    user = (await db.execute(select(User))).scalars().first()
    server = PlexServer(
        machine_identifier="machine-1",
        name="Basement",
        base_url="https://plex.example:32400",
        access_token_encrypted=encrypt_secret("server-token"),
        owner_user_id=user.id,
    )
    item = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Dune")
    db.add_all([server, item])
    await db.flush()
    db.add_all(
        [
            UserServerAccess(
                user_id=user.id,
                server_id=server.id,
                access_token_encrypted=encrypt_secret("user-token"),
            ),
            PlexMapping(
                media_item_id=item.id,
                server_id=server.id,
                rating_key="1234",
                thumb_path="/library/metadata/1234/thumb/999",
            ),
        ]
    )
    await db.commit()

    async def unreachable(self, method, path, *, params=None, retries=1, record_failures=True):
        raise plex_server_module.PlexUnreachable("no route to host")

    original = plex_server_module.PlexServerClient._request
    plex_server_module.PlexServerClient._request = unreachable  # type: ignore[assignment]
    try:
        response = await authed_client.get(f"/api/images/{item.id}/poster")
    finally:
        plex_server_module.PlexServerClient._request = original  # type: ignore[assignment]

    # 404, not 500: the tile shows its gradient instead of an error.
    assert response.status_code == 404


async def test_artwork_proxy_needs_a_session(client, db):
    item = MediaItem(
        guid_key="tmdb:movie:1",
        media_type=MediaType.MOVIE,
        title="Arted",
        discover_thumb_path="/library/metadata/abc/thumb/1",
    )
    db.add(item)
    await db.commit()
    assert (await client.get(f"/api/images/{item.id}/poster")).status_code == 401


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
    which asyncio SQLAlchemy refuses with MissingGreenlet â€” and server
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
            # Inserted out of order â€” the response must come back sorted.
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


async def test_media_can_be_filtered_by_your_rating(authed_client, db):
    """Ratings are 0-10, and both bounds are inclusive."""
    from app.models import UserMediaState

    user = (
        await db.execute(select(User).where(User.username == "tester"))
    ).scalar_one()

    items = [
        MediaItem(guid_key=f"tmdb:movie:{n}", media_type=MediaType.MOVIE, title=title)
        for n, title in enumerate(["Perfect", "Great", "Fine", "Unrated"], start=1)
    ]
    db.add_all(items)
    await db.flush()

    for item, score in zip(items, [10.0, 8.0, 5.0, None], strict=True):
        if score is not None:
            db.add(
                UserMediaState(user_id=user.id, media_item_id=item.id, rating=score)
            )
    await db.commit()

    async def titles(**params):
        response = await authed_client.get("/api/media", params=params)
        assert response.status_code == 200, response.text
        return sorted(card["title"] for card in response.json()["items"])

    assert await titles(min_rating=8) == ["Great", "Perfect"]
    assert await titles(min_rating=10) == ["Perfect"]
    assert await titles(max_rating=8) == ["Fine", "Great"]
    assert await titles(min_rating=8, max_rating=8) == ["Great"]
    # An unrated title must never satisfy a rating filter.
    assert "Unrated" not in await titles(min_rating=0)


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
