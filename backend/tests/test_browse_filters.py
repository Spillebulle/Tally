"""The shared browse surface: the sorts, and the filters the UI now exposes.

Every one of these goes through `/api/media` rather than calling
`apply_filters` directly, because the parameter set *is* the contract — a
filter that exists on `MediaFilters` but is spelled differently by the router
is exactly the drift this module is meant to prevent.
"""
import datetime as dt

import pytest
from sqlalchemy import select

from app.models import (
    MediaItem,
    MediaType,
    PlexMapping,
    PlexServer,
    User,
    UserMediaState,
)
from app.security import encrypt_secret

pytestmark = pytest.mark.asyncio


async def _titles(client, **params) -> list[str]:
    response = await client.get("/api/media", params=params)
    assert response.status_code == 200, response.text
    return [card["title"] for card in response.json()["items"]]


async def _owner(db) -> User:
    return (await db.execute(select(User).where(User.username == "tester"))).scalar_one()


async def test_ascending_sorts_put_the_unanswerable_rows_last(authed_client, db):
    """A row with no year cannot answer "which year", in either direction.

    SQLite sorts NULL first ascending, and `nulls_last()` was only applied to
    the descending branch — so `?sort=year&order=asc` opened on every year-less
    row. That is not a corner case: a thin history row legitimately has no year
    (see CLAUDE.md), so this was the top of the page on real data.
    """
    db.add_all(
        [
            MediaItem(
                guid_key="tmdb:movie:1",
                media_type=MediaType.MOVIE,
                title="Older",
                year=1980,
            ),
            MediaItem(
                guid_key="tmdb:movie:2",
                media_type=MediaType.MOVIE,
                title="Newer",
                year=2020,
            ),
            MediaItem(
                guid_key="plex:movie:3",
                media_type=MediaType.MOVIE,
                title="Undated",
            ),
        ]
    )
    await db.commit()

    assert await _titles(authed_client, sort="year", order="asc") == [
        "Older",
        "Newer",
        "Undated",
    ]
    assert await _titles(authed_client, sort="year", order="desc") == [
        "Newer",
        "Older",
        "Undated",
    ]


async def test_the_release_sort_is_reachable_and_orders_by_air_date(authed_client, db):
    """`release` was in `SortField` and offered by nothing in the UI."""
    db.add_all(
        [
            MediaItem(
                guid_key="tmdb:movie:1",
                media_type=MediaType.MOVIE,
                title="Spring",
                first_aired=dt.date(2021, 3, 1),
            ),
            MediaItem(
                guid_key="tmdb:movie:2",
                media_type=MediaType.MOVIE,
                title="Autumn",
                first_aired=dt.date(2021, 9, 1),
            ),
            MediaItem(
                guid_key="tmdb:movie:3",
                media_type=MediaType.MOVIE,
                title="Unreleased",
            ),
        ]
    )
    await db.commit()

    assert await _titles(authed_client, sort="release", order="asc") == [
        "Spring",
        "Autumn",
        "Unreleased",
    ]
    assert await _titles(authed_client, sort="release", order="desc") == [
        "Autumn",
        "Spring",
        "Unreleased",
    ]


async def test_sorting_by_your_rating_uses_your_rating(authed_client, db):
    """The `rating` sort reads the per-user row, never the community score.

    There used to be an `else MediaItem.community_rating` fallback here that
    could not run — `needs_state_join` returns True for this sort, so the join
    is always present. It read as a working feature and promised the wrong
    thing: somebody who sorts by "your rating" did not ask for the crowd's.
    """
    user = await _owner(db)
    items = [
        MediaItem(guid_key=f"tmdb:movie:{n}", media_type=MediaType.MOVIE, title=title)
        for n, title in enumerate(["Loved", "Liked", "Unrated"], start=1)
    ]
    db.add_all(items)
    await db.flush()
    # The community disagrees with the user, and the user wins.
    items[0].community_rating = 1.0
    items[1].community_rating = 10.0
    db.add_all(
        [
            UserMediaState(user_id=user.id, media_item_id=items[0].id, rating=9.0),
            UserMediaState(user_id=user.id, media_item_id=items[1].id, rating=6.0),
        ]
    )
    await db.commit()

    assert await _titles(authed_client, sort="rating", order="desc") == [
        "Loved",
        "Liked",
        "Unrated",
    ]
    # And unrated stays at the bottom going the other way, rather than leading.
    assert await _titles(authed_client, sort="rating", order="asc") == [
        "Liked",
        "Loved",
        "Unrated",
    ]


async def test_media_can_be_filtered_by_year(authed_client, db):
    db.add_all(
        [
            MediaItem(
                guid_key="tmdb:movie:1",
                media_type=MediaType.MOVIE,
                title="Arrival",
                year=2016,
            ),
            MediaItem(
                guid_key="tmdb:movie:2",
                media_type=MediaType.MOVIE,
                title="Dunkirk",
                year=2017,
            ),
        ]
    )
    await db.commit()

    assert await _titles(authed_client, year=2016) == ["Arrival"]
    assert await _titles(authed_client, year=1999) == []


async def test_media_can_be_filtered_by_favourites(authed_client, db):
    """`favorites` was implemented and reachable by nothing in the UI."""
    user = await _owner(db)
    items = [
        MediaItem(guid_key=f"tmdb:movie:{n}", media_type=MediaType.MOVIE, title=title)
        for n, title in enumerate(["Kept", "Ordinary"], start=1)
    ]
    db.add_all(items)
    await db.flush()
    db.add_all(
        [
            UserMediaState(user_id=user.id, media_item_id=items[0].id, is_favorite=True),
            UserMediaState(user_id=user.id, media_item_id=items[1].id, is_favorite=False),
        ]
    )
    await db.commit()

    assert await _titles(authed_client, favorites=True) == ["Kept"]
    assert sorted(await _titles(authed_client, favorites=False)) == ["Kept", "Ordinary"]


async def test_on_plex_is_a_tri_state(authed_client, db):
    """Absent means both; the two explicit values are the halves.

    "Not on Plex" is the interesting half: a title reaches Tally from the
    watchlist or from a play of a file since deleted, and those rows are
    otherwise impossible to pick out of the grid.
    """
    user = await _owner(db)
    server = PlexServer(
        machine_identifier="machine-1",
        name="Basement",
        base_url="https://plex.example:32400",
        access_token_encrypted=encrypt_secret("server-token"),
        owner_user_id=user.id,
    )
    held = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Held")
    absent = MediaItem(
        guid_key="tmdb:movie:2", media_type=MediaType.MOVIE, title="Gone"
    )
    db.add_all([server, held, absent])
    await db.flush()
    # Two mappings for one item: an EXISTS rather than a join, so it must not
    # come back twice.
    db.add_all(
        [
            PlexMapping(media_item_id=held.id, server_id=server.id, rating_key="1"),
            PlexMapping(media_item_id=held.id, server_id=server.id, rating_key="2"),
        ]
    )
    await db.commit()

    assert await _titles(authed_client, on_plex=True) == ["Held"]
    assert await _titles(authed_client, on_plex=False) == ["Gone"]
    assert sorted(await _titles(authed_client)) == ["Gone", "Held"]


async def test_a_genre_of_wildcards_matches_nothing(authed_client, db):
    """The genre filter is a LIKE, so its wildcards have to be escaped.

    No real genre contains `%` or `_`, but every free-text filter added to this
    module inherits the pattern, and an unescaped one silently widens the grid
    instead of narrowing it — which looks like the data, not like a bug.
    """
    db.add_all(
        [
            MediaItem(
                guid_key="tmdb:movie:1",
                media_type=MediaType.MOVIE,
                title="Heat",
                genres=["Crime"],
            ),
            MediaItem(
                guid_key="tmdb:movie:2",
                media_type=MediaType.MOVIE,
                title="Up",
                genres=["Drama"],
            ),
        ]
    )
    await db.commit()

    assert await _titles(authed_client, genre="Crime") == ["Heat"]
    assert await _titles(authed_client, genre="%") == []
    assert await _titles(authed_client, genre="Crim_") == []
    # A search term is a LIKE too, and gets the same treatment.
    assert await _titles(authed_client, q="%") == []
    assert await _titles(authed_client, q="Hea") == ["Heat"]


async def test_the_watchlist_offers_the_same_filters_as_the_grid(authed_client, db):
    """Both pages declare `MediaFilters`, so a new parameter reaches both.

    The two used to be written out separately, which is how a filter ends up
    working on one page and silently doing nothing on the other.
    """
    item = MediaItem(
        guid_key="tmdb:movie:1",
        media_type=MediaType.MOVIE,
        title="Nope",
        year=2022,
        genres=["Horror"],
    )
    db.add(item)
    await db.commit()

    await authed_client.post("/api/watchlist", json={"media_item_id": item.id})

    for params, expected in (
        ({"year": 2022}, 1),
        ({"year": 1999}, 0),
        ({"genre": "Horror"}, 1),
        ({"genre": "%"}, 0),
        ({"on_plex": False}, 1),
        ({"on_plex": True}, 0),
        ({"favorites": True}, 0),
        ({"sort": "release", "order": "asc"}, 1),
    ):
        response = await authed_client.get("/api/watchlist", params=params)
        assert response.status_code == 200, response.text
        assert response.json()["total"] == expected, params
