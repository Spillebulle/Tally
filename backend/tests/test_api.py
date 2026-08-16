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


async def test_a_home_video_is_kept_out_of_the_grid_but_not_out_of_reach(
    authed_client, db
):
    """The complaint this answers was "no media, no TMDB match, not on server".

    It is a phone recording that was played once through Plex, and the browse
    grids are lists of titles, which it is not. Kept out by a parameter rather
    than a hard-coded clause, though: a misread has to be recoverable without a
    database change, and the row itself is real history and is never deleted.
    """
    db.add_all(
        [
            MediaItem(
                guid_key="tmdb:movie:1",
                media_type=MediaType.MOVIE,
                title="Arrival",
                year=2016,
            ),
            MediaItem(
                guid_key="title:movie:2020-03-31-19-42-27",
                media_type=MediaType.MOVIE,
                title="2020-03-31 19.42.27",
                year=2020,
                is_personal_media=True,
            ),
        ]
    )
    await db.commit()

    default = (await authed_client.get("/api/media")).json()
    assert [item["title"] for item in default["items"]] == ["Arrival"]

    shown = (await authed_client.get("/api/media", params={"personal": "all"})).json()
    assert shown["total"] == 2
    home_video = next(
        item for item in shown["items"] if item["title"] == "2020-03-31 19.42.27"
    )
    # Flagged on the payload, so the tile can say what it is rather than looking
    # like a film whose artwork failed to load.
    assert home_video["is_personal_media"] is True

    only = (await authed_client.get("/api/media", params={"personal": "only"})).json()
    assert [item["title"] for item in only["items"]] == ["2020-03-31 19.42.27"]

    detail = (await authed_client.get(f"/api/media/{home_video['id']}")).json()
    assert detail["is_personal_media"] is True


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

    # Default: added to the *watchlist* — not to the library — oldest first,
    # because the page is a queue and the top of it should be what has been
    # waiting longest.
    assert await titles() == ["Akira", "Heat", "Severance"]
    assert await titles("?sort=watchlist_added&order=desc") == [
        "Severance",
        "Heat",
        "Akira",
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

    # With nothing asked for: watchlisted date, oldest first. A watchlist is a
    # queue, so the thing you have been meaning to watch longest leads. The
    # frontend defaults to the same pair, so the page and the API agree.
    assert await titles("") == ["New file", "Old file"]


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
    # Fetched with this user's own token, never the owner's.
    assert seen["token"] == "user-token"
    # The token rides in the query here because the transcoder's own inner fetch
    # needs it. That is a server-side request; what must never carry a token is
    # a URL stored on an item and served to a browser, which is asserted by the
    # card payload above pointing at /api/images rather than at Plex.
    assert seen["params"]["X-Plex-Token"] == "user-token"


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


async def test_a_missing_artwork_path_is_recovered_from_plex(authed_client, db):
    """Regression: a null thumb_path was a dead end with no way back.

    Library scans only store what their payload carried, so an item Plex had not
    finished generating artwork for kept a null path until something rescanned
    it — which for a large library may be never. Serving a poster is the moment
    we know for certain the row is wrong, so it is repaired there and kept.
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
    item = MediaItem(
        guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="101 Dalmatians"
    )
    db.add_all([server, item])
    await db.flush()
    mapping = PlexMapping(
        media_item_id=item.id,
        server_id=server.id,
        rating_key="52589",
        thumb_path=None,  # the state that produced a permanent blank tile
        art_path=None,
    )
    db.add(mapping)
    await db.commit()

    paths: list[str] = []

    async def fake_request(self, method, path, *, params=None, retries=1, record_failures=True):
        paths.append(path)

        class Resp:
            status_code = 200
            content = b"jpeg-bytes"
            headers = {"content-type": "image/jpeg"}

            @staticmethod
            def json():
                return {
                    "MediaContainer": {
                        "Metadata": [
                            {
                                "type": "movie",
                                "ratingKey": "52589",
                                "title": "101 Dalmatians",
                                "thumb": "/library/metadata/52589/thumb/1700",
                                "art": "/library/metadata/52589/art/1700",
                            }
                        ]
                    }
                }

        return Resp()

    original = plex_server_module.PlexServerClient._request
    plex_server_module.PlexServerClient._request = fake_request  # type: ignore[assignment]
    try:
        response = await authed_client.get(f"/api/images/{item.id}/poster")
    finally:
        plex_server_module.PlexServerClient._request = original  # type: ignore[assignment]

    assert response.status_code == 200
    assert response.content == b"jpeg-bytes"
    # It asked Plex for the metadata, then fetched the artwork it named.
    assert paths == ["/library/metadata/52589", "/photo/:/transcode"]

    # And the repair is persisted, so the next request costs one call, not two.
    await db.refresh(mapping)
    assert mapping.thumb_path == "/library/metadata/52589/thumb/1700"
    assert mapping.art_path == "/library/metadata/52589/art/1700"


async def test_a_stale_artwork_path_is_refreshed_rather_than_left_blank(
    authed_client, db
):
    """Regression: one title's poster gone for good after Plex replaced it.

    A Plex artwork path carries a timestamp — `/thumb/1699999999` — so changing
    a poster in Plex makes the stored path 404 while the new one sits there
    unrecorded. A *missing* path was already repaired on demand; a dead one was
    not, which left that one title showing a placeholder indefinitely while
    every title around it was fine. Both are the same fault and the same fix.
    """
    from app.models import PlexMapping
    from app.services import plex_server as plex_server_module

    stale = "/library/metadata/52589/thumb/1600"
    fresh = "/library/metadata/52589/thumb/1700"

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
    mapping = PlexMapping(
        media_item_id=item.id,
        server_id=server.id,
        rating_key="52589",
        thumb_path=stale,
    )
    db.add(mapping)
    await db.commit()

    calls: list[tuple[str, str | None]] = []

    async def fake_request(
        self, method, path, *, params=None, retries=1, record_failures=True
    ):
        wanted = (params or {}).get("url")
        calls.append((path, wanted))

        class Meta:
            status_code = 200

            @staticmethod
            def json():
                return {
                    "MediaContainer": {
                        "Metadata": [
                            {
                                "type": "movie",
                                "ratingKey": "52589",
                                "title": "Dune",
                                "thumb": fresh,
                                "art": "/library/metadata/52589/art/1700",
                            }
                        ]
                    }
                }

        class Jpeg:
            status_code = 200
            content = b"fresh-jpeg"
            headers = {"content-type": "image/jpeg"}

        if path == "/library/metadata/52589":
            return Meta
        if fresh in (path, wanted):
            return Jpeg
        return None  # the stale path is a 404 now

    original = plex_server_module.PlexServerClient._request
    plex_server_module.PlexServerClient._request = fake_request  # type: ignore[assignment]
    try:
        response = await authed_client.get(f"/api/images/{item.id}/poster")
    finally:
        plex_server_module.PlexServerClient._request = original  # type: ignore[assignment]

    assert response.status_code == 200
    assert response.content == b"fresh-jpeg"

    # It tried what it had first, and only asked Plex once that came back empty.
    assert calls[0] == ("/photo/:/transcode", stale)
    assert ("/library/metadata/52589", None) in calls

    # The repair is kept, so the next request costs one call rather than three.
    await db.refresh(mapping)
    assert mapping.thumb_path == fresh
    assert mapping.art_path == "/library/metadata/52589/art/1700"


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


async def test_triggering_a_sync_reports_running_immediately(authed_client, monkeypatch):
    """Regression: the progress bar stayed hidden until the page was reloaded.

    The SyncRun row used to be created inside the background task, so the UI's
    follow-up refetch raced it, saw nothing running, and dropped back to the
    slow poll. A button must never look like it did nothing.
    """
    from app.routers import sync as sync_router

    started: list[tuple] = []

    async def fake_run(user_id, run_id, full_history, scan_libraries):
        started.append((user_id, run_id, full_history, scan_libraries))

    monkeypatch.setattr(sync_router, "_run_sync", fake_run)

    triggered = await authed_client.post(
        "/api/sync", json={"full_history": False, "scan_libraries": True}
    )
    assert triggered.status_code == 202
    assert triggered.json()["status"] == "started"
    run_id = triggered.json()["run_id"]

    # The very next request already sees it, with no sleep and no reload.
    status_now = (await authed_client.get("/api/sync/status")).json()
    assert status_now["running"] is True
    assert status_now["run_id"] == run_id
    assert status_now["phase"] == "Starting"

    # A second click does not start a competing run.
    again = await authed_client.post(
        "/api/sync", json={"full_history": False, "scan_libraries": True}
    )
    assert again.json()["status"] == "already_running"
    assert again.json()["run_id"] == run_id

    runs = (await authed_client.get("/api/sync/runs")).json()
    assert len(runs) == 1
    # Only the first click scheduled work.
    assert len(started) == 1


async def test_api_key_lifecycle_and_authentication(authed_client, bare_client, db):
    """A key is shown once, works as its owner, and stops working when revoked."""
    from app.models import ApiKey

    created = await authed_client.post("/api/keys", json={"name": "Home Assistant"})
    assert created.status_code == 201
    body = created.json()
    raw = body["key"]
    assert raw.startswith("tally_")
    assert body["prefix"] == raw[:14]
    assert body["last_used_at"] is None

    # The plaintext exists nowhere on the server — only its hash.
    stored = (await db.execute(select(ApiKey))).scalars().one()
    assert stored.key_hash != raw
    assert raw not in stored.key_hash
    # And it is never handed out again.
    listed = (await authed_client.get("/api/keys")).json()
    assert len(listed) == 1
    assert "key" not in listed[0]

    # bare_client has no session cookie, so these exercise the key alone.
    assert (await bare_client.get("/api/media")).status_code == 401

    for headers in (
        {"X-API-Key": raw},
        {"Authorization": f"Bearer {raw}"},
    ):
        response = await bare_client.get("/api/media", headers=headers)
        assert response.status_code == 200, headers

    # Using it recorded that it was used, which is what makes a key auditable.
    await db.refresh(stored)
    assert stored.last_used_at is not None

    assert (
        await bare_client.get("/api/media", headers={"X-API-Key": raw + "x"})
    ).status_code == 401
    assert (
        await bare_client.get("/api/media", headers={"X-API-Key": "tally_nonsense"})
    ).status_code == 401

    revoked = await authed_client.delete(f"/api/keys/{body['id']}")
    assert revoked.status_code == 204
    assert (
        await bare_client.get("/api/media", headers={"X-API-Key": raw})
    ).status_code == 401

    # Revoked, not deleted: the record of its use survives.
    remaining = (await authed_client.get("/api/keys")).json()
    assert len(remaining) == 1
    assert remaining[0]["revoked_at"] is not None


async def test_an_api_key_cannot_be_revoked_by_another_account(authed_client, client, db):
    """Keys are per-account, and one account may not touch another's."""
    created = await authed_client.post("/api/keys", json={"name": "mine"})
    key_id = created.json()["id"]

    await client.post("/api/auth/logout")
    await client.post(
        "/api/auth/register", json={"username": "someone-else", "password": "password123"}
    )

    # 404 rather than 403: whether that id exists is not their business.
    assert (await client.delete(f"/api/keys/{key_id}")).status_code == 404
    # And it is not in their list.
    assert (await client.get("/api/keys")).json() == []


async def test_version_endpoint_is_public_and_matches_the_package(bare_client):
    """The footer renders before sign-in, so this must not need a session."""
    from app import __version__

    response = await bare_client.get("/api/version")
    assert response.status_code == 200

    body = response.json()
    # The one source of truth — a drifting copy here would be worse than none.
    assert body["version"] == __version__
    assert body["github_url"].startswith("https://github.com/")
    assert body["dockerhub_url"].startswith("https://hub.docker.com/")


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
        # `is_closed` because the client is pooled process-wide now: `_pool()`
        # reads it to decide whether the cached client is still usable.
        is_closed = False

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


async def test_logout_actually_clears_the_session(authed_client):
    """Logout used to answer 204 with no Set-Cookie at all.

    `delete_cookie` was written to an injected `response` while the handler
    returned a different `Response` object, so FastAPI discarded the header and
    the session stayed valid for its full 30 days — on a shared browser,
    "Sign out" did nothing.
    """
    assert (await authed_client.get("/api/auth/me")).status_code == 200

    response = await authed_client.post("/api/auth/logout")
    assert response.status_code == 204
    assert any(
        "session" in value.lower() for value in response.headers.get_list("set-cookie")
    ), "logout sent no Set-Cookie header"

    assert (await authed_client.get("/api/auth/me")).status_code == 401


async def test_spa_route_cannot_escape_the_static_directory(tmp_path, monkeypatch):
    """The SPA catch-all used to serve any file the process could read.

    `FRONTEND_DIR / full_path` had no containment check, and the path arrives
    already percent-decoded, so `%2e%2e%2f` became a real `../`. That exposed
    `/data/.secret_key` — which decrypts every stored Plex token — and the
    database itself, to anyone, unauthenticated.

    This drives the helper rather than the route: the route is only registered
    when a built `static/index.html` exists, which it does not in a checkout,
    so an HTTP-level test here would pass without proving anything.
    """
    from app import main

    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html>")
    (static / "assets" / "app.js").write_text("console.log(1)")
    secret = tmp_path / "secret_key"
    secret.write_text("SECRET=leaked")

    monkeypatch.setattr(main, "FRONTEND_DIR", static)
    monkeypatch.setattr(main, "FRONTEND_ROOT", static.resolve())

    # A real asset still resolves.
    assert main.static_file_for("assets/app.js") == (static / "assets" / "app.js").resolve()

    # Nothing outside the directory does, however it is spelled. FastAPI hands
    # the handler a decoded path, so these are what actually arrives.
    for escape in (
        "../secret_key",
        "../../secret_key",
        "assets/../../secret_key",
        "./../secret_key",
    ):
        assert main.static_file_for(escape) is None, escape

    # And an unknown in-bounds path falls through to the SPA rather than 404ing.
    assert main.static_file_for("watchlist") is None


async def _library_with_items(db, *, anime_override=None):
    """A library holding one show with an episode, plus a film, all mapped.

    The existing override tests assert only that the column round-trips — they
    would pass with `_reclassify_library_task` deleted entirely, because none
    of them creates a MediaItem. That is why two real reclassification bugs
    were invisible to CI.
    """
    from app.models import PlexMapping

    library = await _library_with_access(db, anime_override=anime_override)

    show = MediaItem(
        guid_key="tmdb:show:100",
        media_type=MediaType.SHOW,
        title="Cowboy Bebop",
        genres=["Animation"],
    )
    film = MediaItem(
        guid_key="tmdb:movie:200",
        media_type=MediaType.MOVIE,
        title="Heat",
        genres=["Crime"],
    )
    db.add_all([show, film])
    await db.flush()

    episode = MediaItem(
        guid_key="tmdb:show:100/s1e1",
        media_type=MediaType.EPISODE,
        title="Asteroid Blues",
        show_id=show.id,
    )
    db.add(episode)
    await db.flush()

    db.add_all(
        [
            PlexMapping(
                media_item_id=show.id,
                server_id=library.server_id,
                library_id=library.id,
                rating_key="1",
            ),
            PlexMapping(
                media_item_id=film.id,
                server_id=library.server_id,
                library_id=library.id,
                rating_key="2",
            ),
        ]
    )
    await db.commit()
    return library, show, episode, film


async def test_an_override_cascades_to_items_and_their_episodes(authed_client, db):
    """Setting the chip must reach the items, not just the library row.

    Driven through `_reclassify_library` rather than the endpoint: the endpoint
    hands this to a BackgroundTask that opens its own `session_scope()`, which
    is bound to the real engine rather than the test database, so nothing it
    writes would be visible here.
    """
    from app.routers.sync import _reclassify_library

    library, show, episode, film = await _library_with_items(db, anime_override=True)

    await _reclassify_library(db, library)

    for row in (show, episode, film):
        await db.refresh(row)
        assert row.is_anime is True, f"{row.title} did not inherit the override"
        assert row.anime_source == "library_override"


async def test_returning_to_auto_reclassifies_instead_of_flattening(authed_client, db):
    """Regression: clearing the override wrote one boolean over every item.

    `library_looks_like_anime(title)` was stamped across the whole library with
    an `anime_source` of "library_override" even though no override existed. A
    "Films" library holding a correctly-detected anime show had it forced to
    False — so cycling the chip yes -> no -> auto to undo a mistake destroyed
    exactly what the user was trying to restore.
    """
    from app.routers.sync import _reclassify_library

    library, show, episode, film = await _library_with_items(db, anime_override=True)

    # Starting point: the override applied to everything, including the film.
    await _reclassify_library(db, library)
    await db.refresh(show)
    await db.refresh(film)
    assert show.is_anime is True
    assert film.is_anime is True

    # The show carries a signal of its own that the classifier can find.
    show.genres = ["Animation", "Anime"]
    library.anime_override = None
    await db.commit()

    await _reclassify_library(db, library)

    await db.refresh(show)
    await db.refresh(episode)
    await db.refresh(film)

    # Re-classified per item rather than flattened: the anime show keeps its
    # flag, and the crime film loses the one the override gave it.
    assert show.is_anime is True, "auto discarded a genuine per-item classification"
    assert episode.is_anime is True, "the episode did not follow its show"
    assert film.is_anime is False
    # And nothing claims an override that no longer exists.
    assert show.anime_source != "library_override"


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/api/media/999999/favorite", {"is_favorite": True}),
        ("/api/media/999999/notes", {"notes": "hello"}),
        ("/api/media/999999/rating", {"rating": 5.0, "push_to_plex": False}),
        ("/api/media/999999/status", {"status": "completed"}),
    ],
)
async def test_writing_state_for_an_unknown_item_is_a_404(authed_client, path, payload):
    """favorite and notes lacked the existence check rating and status had.

    With `PRAGMA foreign_keys=ON` — which production sets and the test engine
    now does too — the insert tripped the foreign key and answered 500. Without
    the pragma it "worked", writing an orphan row, which is why the test suite
    never noticed.
    """
    response = await authed_client.put(path, json=payload)
    assert response.status_code == 404, response.text


async def _recommendation_fixture(db):
    """One source film plus a spread of candidates around it.

    Genre overlap with the source, community rating and watched state are varied
    independently so each ordering rule can be read off the result on its own.
    """
    from app.models import UserMediaState

    user = (
        await db.execute(select(User).where(User.username == "tester"))
    ).scalar_one()

    source = MediaItem(
        guid_key="tmdb:movie:source",
        media_type=MediaType.MOVIE,
        title="Source",
        genres=["Crime", "Drama"],
        community_rating=8.6,
    )
    # Two shared genres, middling rating.
    both = MediaItem(
        guid_key="tmdb:show:both",
        media_type=MediaType.SHOW,
        title="Both Genres",
        genres=["Crime", "Drama"],
        community_rating=7.0,
    )
    # Two shared genres, worse rating — same tier as `both`, below it.
    both_worse = MediaItem(
        guid_key="tmdb:movie:both-worse",
        media_type=MediaType.MOVIE,
        title="Both Genres Lower Rated",
        genres=["Crime", "Drama", "Mystery"],
        community_rating=6.0,
    )
    # Two shared genres and no rating at all: last in its tier, not first.
    both_unrated = MediaItem(
        guid_key="tmdb:movie:both-unrated",
        media_type=MediaType.MOVIE,
        title="Both Genres Unrated",
        genres=["Crime", "Drama"],
        community_rating=None,
    )
    # One shared genre but the highest rating in the library — a pure rating
    # sort would put this first, and it must not be.
    one_acclaimed = MediaItem(
        guid_key="tmdb:movie:one",
        media_type=MediaType.MOVIE,
        title="One Genre Acclaimed",
        genres=["Drama", "Romance"],
        community_rating=9.9,
    )
    # Both genres, top rating — but watched, so it is not a recommendation.
    watched = MediaItem(
        guid_key="tmdb:movie:watched",
        media_type=MediaType.MOVIE,
        title="Already Seen",
        genres=["Crime", "Drama"],
        community_rating=9.5,
    )
    # Both genres, top rating — but tagged with everything, so the shared pair
    # is a minority of what it is.
    diluted = MediaItem(
        guid_key="tmdb:show:diluted",
        media_type=MediaType.SHOW,
        title="Tagged With Everything",
        genres=["Crime", "Drama", "Action", "Comedy", "Horror", "Western"],
        community_rating=9.4,
    )
    # No shared genre at all.
    unrelated = MediaItem(
        guid_key="tmdb:movie:unrelated",
        media_type=MediaType.MOVIE,
        title="Unrelated",
        genres=["Western"],
        community_rating=9.8,
    )
    items = [
        source,
        both,
        both_worse,
        both_unrated,
        one_acclaimed,
        watched,
        diluted,
        unrelated,
    ]
    db.add_all(items)
    await db.flush()

    # An episode of `both`, to prove children never surface flat.
    db.add(
        MediaItem(
            guid_key="tmdb:show:both/s1e1",
            media_type=MediaType.EPISODE,
            title="Episode One",
            genres=["Crime", "Drama"],
            community_rating=9.7,
            show_id=both.id,
            season_number=1,
            episode_number=1,
        )
    )
    db.add(UserMediaState(user_id=user.id, media_item_id=watched.id, view_count=2))
    # A state row that exists but records no play still counts as unwatched.
    db.add(UserMediaState(user_id=user.id, media_item_id=both.id, view_count=0))
    await db.commit()
    return source


async def test_recommendations_rank_by_shared_genres_then_community_rating(
    authed_client, db
):
    """Overlap is the primary key; the rating only sorts inside a tier."""
    source = await _recommendation_fixture(db)

    response = await authed_client.get(f"/api/media/{source.id}/recommendations")
    assert response.status_code == 200, response.text
    titles = [card["title"] for card in response.json()]

    assert titles == [
        "Both Genres",
        "Both Genres Lower Rated",
        "Both Genres Unrated",
        "One Genre Acclaimed",
    ]


async def test_recommendations_skip_what_you_have_watched(authed_client, db):
    source = await _recommendation_fixture(db)

    response = await authed_client.get(f"/api/media/{source.id}/recommendations")
    titles = [card["title"] for card in response.json()]

    # Two shared genres and the second-highest rating in the fixture, so it
    # would lead the list if watched state were not applied.
    assert "Already Seen" not in titles
    # Nothing shared, and an episode, respectively.
    assert "Unrelated" not in titles
    assert "Episode One" not in titles
    # The item itself is never its own recommendation.
    assert "Source" not in titles


async def test_recommendations_ignore_a_title_tagged_with_everything(authed_client, db):
    """Two shared genres out of six is not a match, whatever the rating."""
    source = await _recommendation_fixture(db)

    response = await authed_client.get(f"/api/media/{source.id}/recommendations")
    assert "Tagged With Everything" not in [c["title"] for c in response.json()]


async def test_recommendations_for_an_episode_come_from_its_show(authed_client, db):
    """An episode has no genres worth matching on; the show it belongs to does."""
    from app.models import UserMediaState

    user = (
        await db.execute(select(User).where(User.username == "tester"))
    ).scalar_one()

    show = MediaItem(
        guid_key="tmdb:show:1",
        media_type=MediaType.SHOW,
        title="The Show",
        genres=["Crime", "Drama"],
    )
    neighbour = MediaItem(
        guid_key="tmdb:movie:1",
        media_type=MediaType.MOVIE,
        title="Neighbour",
        genres=["Crime", "Drama"],
        community_rating=8.0,
    )
    db.add_all([show, neighbour])
    await db.flush()
    episode = MediaItem(
        guid_key="tmdb:show:1/s1e1",
        media_type=MediaType.EPISODE,
        title="Pilot",
        genres=[],
        show_id=show.id,
        season_number=1,
        episode_number=1,
    )
    db.add(episode)
    await db.flush()
    db.add(UserMediaState(user_id=user.id, media_item_id=episode.id, view_count=1))
    await db.commit()

    response = await authed_client.get(f"/api/media/{episode.id}/recommendations")
    assert response.status_code == 200, response.text
    titles = [card["title"] for card in response.json()]
    assert titles == ["Neighbour"]
    # The show whose genres were borrowed is not a recommendation for its own
    # episode.
    assert "The Show" not in titles


async def test_recommendations_for_an_unknown_item_are_a_404(authed_client):
    response = await authed_client.get("/api/media/999999/recommendations")
    assert response.status_code == 404, response.text


async def test_recommendations_without_genres_are_empty_not_an_error(authed_client, db):
    """Nothing to match on is an honest empty list, not a rating-sorted grab bag."""
    item = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Bare")
    db.add_all(
        [
            item,
            MediaItem(
                guid_key="tmdb:movie:2",
                media_type=MediaType.MOVIE,
                title="Acclaimed",
                genres=["Drama"],
                community_rating=9.9,
            ),
        ]
    )
    await db.commit()

    response = await authed_client.get(f"/api/media/{item.id}/recommendations")
    assert response.status_code == 200, response.text
    assert response.json() == []
