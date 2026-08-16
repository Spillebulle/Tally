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

UTC = dt.UTC


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
        ({"min_year": 2022}, 1),
        ({"max_year": 2021}, 0),
        ({"has_notes": True}, 0),
        ({"in_progress": True}, 0),
        ({"max_watch_count": 0}, 1),
    ):
        response = await authed_client.get("/api/watchlist", params=params)
        assert response.status_code == 200, response.text
        assert response.json()["total"] == expected, params


# ---------------------------------------------------------------------------
# Facets resolved through the parent show
# ---------------------------------------------------------------------------


async def _crime_series(db) -> tuple[MediaItem, MediaItem]:
    """A show carrying every facet, and one episode carrying none of them."""
    show = MediaItem(
        guid_key="tvdb:1",
        media_type=MediaType.SHOW,
        title="Bosch",
        genres=["Crime", "Drama"],
        studio="Fabrik",
        content_rating="TV-MA",
        network="Prime Video",
        release_status="ended",
        anime_format="TV",
    )
    db.add(show)
    await db.flush()
    episode = MediaItem(
        guid_key="tvdb:1/s1e1",
        media_type=MediaType.EPISODE,
        title="Tijuana Donkey Showcase",
        show_id=show.id,
        parent_id=show.id,
        season_number=1,
        episode_number=1,
    )
    db.add(episode)
    await db.commit()
    return show, episode


@pytest.mark.parametrize(
    ("param", "value"),
    [
        ("genre", "Crime"),
        ("studio", "Fabrik"),
        ("content_rating", "TV-MA"),
        ("network", "Prime Video"),
        ("release_status", "ended"),
        ("anime_format", "TV"),
    ],
)
async def test_an_episode_answers_with_its_shows_facets(authed_client, db, param, value):
    """Enrichment is skipped for episodes, so the episode row carries nothing.

    Filtering History or an episode grid on a genre therefore matched *nothing*
    — silently, because an empty result set looks like an honest answer. The
    episodes of a Crime series are Crime; `facet_source` says so once, for
    every facet, so the answer cannot differ between filters.
    """
    await _crime_series(db)

    assert await _titles(authed_client, media_type="episode", **{param: value}) == [
        "Tijuana Donkey Showcase"
    ]
    # The show still answers for itself, and a facet neither row carries still
    # matches nothing — the resolution widens the question, it does not blur it.
    assert await _titles(authed_client, media_type="show", **{param: value}) == ["Bosch"]
    assert await _titles(authed_client, media_type="episode", **{param: "Nonesuch"}) == []


async def test_the_shows_facets_do_not_leak_to_an_unrelated_episode(authed_client, db):
    """`facet_source` follows `show_id`, not "some show somewhere"."""
    await _crime_series(db)
    other = MediaItem(
        guid_key="tvdb:2",
        media_type=MediaType.SHOW,
        title="Detectorists",
        genres=["Comedy"],
    )
    db.add(other)
    await db.flush()
    db.add(
        MediaItem(
            guid_key="tvdb:2/s1e1",
            media_type=MediaType.EPISODE,
            title="Digging",
            show_id=other.id,
        )
    )
    await db.commit()

    assert await _titles(authed_client, media_type="episode", genre="Crime") == [
        "Tijuana Donkey Showcase"
    ]
    assert await _titles(authed_client, media_type="episode", genre="Comedy") == ["Digging"]


async def test_a_resolved_facet_still_returns_each_row_once(authed_client, db):
    """The parent lookup is a correlated EXISTS, so it cannot fan a row out."""
    show, _ = await _crime_series(db)
    db.add(
        MediaItem(
            guid_key="tvdb:1/s1e2",
            media_type=MediaType.EPISODE,
            title="Lost Light",
            show_id=show.id,
        )
    )
    await db.commit()

    response = await authed_client.get(
        "/api/media", params={"media_type": "episode", "genre": "Crime"}
    )
    assert response.json()["total"] == 2
    assert sorted(await _titles(authed_client, media_type="episode", genre="Crime")) == [
        "Lost Light",
        "Tijuana Donkey Showcase",
    ]


# ---------------------------------------------------------------------------
# Ranges over the item's own columns
# ---------------------------------------------------------------------------


async def test_year_runtime_and_community_ranges_are_inclusive(authed_client, db):
    """Both bounds include their own value, like `min_rating` already did."""
    db.add_all(
        [
            MediaItem(
                guid_key="tmdb:movie:1",
                media_type=MediaType.MOVIE,
                title="Short",
                year=1990,
                runtime_minutes=80,
                community_rating=5.0,
            ),
            MediaItem(
                guid_key="tmdb:movie:2",
                media_type=MediaType.MOVIE,
                title="Long",
                year=2010,
                runtime_minutes=180,
                community_rating=9.0,
            ),
            MediaItem(
                guid_key="plex:movie:3",
                media_type=MediaType.MOVIE,
                title="Unknown",
            ),
        ]
    )
    await db.commit()

    assert await _titles(authed_client, min_year=1990, max_year=1990) == ["Short"]
    assert sorted(await _titles(authed_client, min_year=1990)) == ["Long", "Short"]
    assert await _titles(authed_client, max_year=2009) == ["Short"]
    assert await _titles(authed_client, min_runtime=80, max_runtime=80) == ["Short"]
    assert await _titles(authed_client, min_runtime=100) == ["Long"]
    assert await _titles(authed_client, min_community=9, max_community=9) == ["Long"]
    assert await _titles(authed_client, max_community=5) == ["Short"]
    # A row that cannot answer is not an answer: NULL is neither in nor out of
    # a range, and must not be swept in by either bound.
    assert "Unknown" not in await _titles(authed_client, min_year=0)
    assert "Unknown" not in await _titles(authed_client, max_runtime=1000)


async def test_added_bounds_read_when_the_row_reached_the_library(authed_client, db):
    old = MediaItem(guid_key="tmdb:movie:1", media_type=MediaType.MOVIE, title="Old")
    new = MediaItem(guid_key="tmdb:movie:2", media_type=MediaType.MOVIE, title="New")
    db.add_all([old, new])
    await db.flush()
    old.created_at = dt.datetime(2020, 1, 1, tzinfo=UTC)
    new.created_at = dt.datetime(2024, 6, 1, tzinfo=UTC)
    await db.commit()

    assert await _titles(authed_client, added_after="2023-01-01T00:00:00") == ["New"]
    assert await _titles(authed_client, added_before="2023-01-01T00:00:00") == ["Old"]
    assert sorted(await _titles(authed_client, added_after="2020-01-01T00:00:00")) == [
        "New",
        "Old",
    ]


async def test_a_bad_range_bound_is_a_422_not_a_silent_widening(authed_client):
    """A URL is untrusted input; the bounds are declared, so FastAPI refuses."""
    for params in (
        {"min_community": 11},
        {"max_community": -1},
        {"min_runtime": -5},
        {"min_watch_count": -1},
        {"min_year": "soon"},
    ):
        response = await authed_client.get("/api/media", params=params)
        assert response.status_code == 422, params


# ---------------------------------------------------------------------------
# Filters that read the per-user state row
# ---------------------------------------------------------------------------


async def test_watched_bounds_read_the_rollup_not_the_event(authed_client, db):
    """`watched_after`/`watched_before` are `UserMediaState.last_watched_at`.

    Deliberately not named `since`/`until`: History already owns those two for
    `WatchEvent.watched_at`, which is a different table answering a different
    question.
    """
    user = await _owner(db)
    items = [
        MediaItem(guid_key=f"tmdb:movie:{n}", media_type=MediaType.MOVIE, title=title)
        for n, title in enumerate(["Recent", "Ancient", "Never"], start=1)
    ]
    db.add_all(items)
    await db.flush()
    db.add_all(
        [
            UserMediaState(
                user_id=user.id,
                media_item_id=items[0].id,
                view_count=1,
                last_watched_at=dt.datetime(2024, 5, 1, tzinfo=UTC),
            ),
            UserMediaState(
                user_id=user.id,
                media_item_id=items[1].id,
                view_count=1,
                last_watched_at=dt.datetime(2015, 5, 1, tzinfo=UTC),
            ),
        ]
    )
    await db.commit()

    assert await _titles(authed_client, watched_after="2020-01-01T00:00:00") == ["Recent"]
    assert await _titles(authed_client, watched_before="2020-01-01T00:00:00") == ["Ancient"]
    # Never played has no timestamp, so it answers neither bound.
    assert "Never" not in await _titles(authed_client, watched_after="1900-01-01T00:00:00")


async def test_watch_count_bounds_treat_a_missing_state_as_zero_plays(authed_client, db):
    """A row with no state row at all has been played zero times.

    Read as NULL instead, `max_watch_count=0` would exclude exactly the rows it
    is asking for — the ones nobody has ever touched.
    """
    user = await _owner(db)
    items = [
        MediaItem(guid_key=f"tmdb:movie:{n}", media_type=MediaType.MOVIE, title=title)
        for n, title in enumerate(["Once", "Rewatched", "Untouched"], start=1)
    ]
    db.add_all(items)
    await db.flush()
    db.add_all(
        [
            UserMediaState(user_id=user.id, media_item_id=items[0].id, view_count=1),
            UserMediaState(user_id=user.id, media_item_id=items[1].id, view_count=7),
        ]
    )
    await db.commit()

    assert await _titles(authed_client, min_watch_count=2) == ["Rewatched"]
    assert sorted(await _titles(authed_client, min_watch_count=1)) == ["Once", "Rewatched"]
    assert await _titles(authed_client, max_watch_count=0) == ["Untouched"]
    assert await _titles(authed_client, min_watch_count=1, max_watch_count=1) == ["Once"]


async def test_in_progress_shares_continue_watchings_definition(authed_client, db):
    """Started, and not so close to the end that it belongs in history.

    `NEARLY_FINISHED_PERCENT` is the one cut-off; `routers/library` applies the
    same number to the Continue Watching shelf. A second definition here would
    have the two shelves disagreeing about "still watching".
    """
    user = await _owner(db)
    items = [
        MediaItem(guid_key=f"tmdb:movie:{n}", media_type=MediaType.MOVIE, title=title)
        for n, title in enumerate(["Midway", "Credits", "Unstarted", "Unmeasured"], 1)
    ]
    db.add_all(items)
    await db.flush()
    db.add_all(
        [
            UserMediaState(
                user_id=user.id,
                media_item_id=items[0].id,
                progress_ms=30 * 60_000,
                duration_ms=100 * 60_000,
            ),
            # 98% in: finished, as far as anyone watching is concerned.
            UserMediaState(
                user_id=user.id,
                media_item_id=items[1].id,
                progress_ms=98 * 60_000,
                duration_ms=100 * 60_000,
            ),
            UserMediaState(user_id=user.id, media_item_id=items[2].id, progress_ms=0),
            # Playback recorded but no known length: unmeasurable against the
            # cut-off, so it stays, exactly as the shelf treats it.
            UserMediaState(
                user_id=user.id, media_item_id=items[3].id, progress_ms=5 * 60_000
            ),
        ]
    )
    await db.commit()

    assert sorted(await _titles(authed_client, in_progress=True)) == [
        "Midway",
        "Unmeasured",
    ]
    # False is "no opinion", the same shape `favorites` and `unwatched` use.
    assert len(await _titles(authed_client, in_progress=False)) == 4


async def test_has_notes_is_yours_alone(authed_client, db):
    """Notes are per-user, so another account's cannot change your result.

    The filter can only ever be evaluated inside the `user_id`-scoped join;
    written against `user_media_states` unscoped it would show you every title
    anyone in the household had annotated.
    """
    user = await _owner(db)
    other = User(username="housemate", password_hash="x")
    db.add(other)
    items = [
        MediaItem(guid_key=f"tmdb:movie:{n}", media_type=MediaType.MOVIE, title=title)
        for n, title in enumerate(["Mine", "Theirs", "Blank"], start=1)
    ]
    db.add_all(items)
    await db.flush()
    db.add_all(
        [
            UserMediaState(
                user_id=user.id, media_item_id=items[0].id, notes="rewatch in autumn"
            ),
            UserMediaState(user_id=other.id, media_item_id=items[1].id, notes="dreadful"),
            # An emptied note is not a note.
            UserMediaState(user_id=user.id, media_item_id=items[2].id, notes=""),
        ]
    )
    await db.commit()

    assert await _titles(authed_client, has_notes=True) == ["Mine"]
    assert len(await _titles(authed_client, has_notes=False)) == 3
