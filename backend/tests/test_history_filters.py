"""History browses the same filter set as the grids — with three exceptions.

`/api/history` used to carry four ad-hoc parameters of its own, which is how a
filter comes to work on one page and silently do nothing on another. It now
declares `MediaFilters` like `/api/media` and `/api/watchlist` do.

Three things about that adoption are load-bearing, and each is a real bug if
somebody "tidies" it away:

* `default_types=False` — the shared default keeps the flat grids to movies and
  shows, and episodes are most of a watch history.
* `personal="all"` — the shared default excludes home videos, which is right
  for a library grid and wrong for a log of plays that really happened.
* `since`/`until` stay on the router, reading `WatchEvent.watched_at`, and are
  *not* the new `watched_after`/`watched_before`, which read the per-user
  rollup. Different tables, different questions.
"""
import datetime as dt
import uuid

import pytest
from sqlalchemy import select

from app.models import (
    MediaItem,
    MediaType,
    User,
    UserMediaState,
    WatchEvent,
    WatchSource,
)

pytestmark = pytest.mark.asyncio

UTC = dt.UTC


async def _owner(db) -> User:
    return (await db.execute(select(User).where(User.username == "tester"))).scalar_one()


async def _history(client, **params) -> list[str]:
    response = await client.get("/api/history", params=params)
    assert response.status_code == 200, response.text
    return [event["item"]["title"] for event in response.json()["events"]]


async def _total(client, **params) -> int:
    response = await client.get("/api/history", params=params)
    assert response.status_code == 200, response.text
    return response.json()["total"]


def _play(user_id: int, item: MediaItem, when: dt.datetime) -> WatchEvent:
    return WatchEvent(
        user_id=user_id,
        media_item_id=item.id,
        watched_at=when,
        source=WatchSource.PLEX_HISTORY,
        dedupe_key=f"manual:{uuid.uuid4()}",
        completed=True,
    )


async def _library(db) -> dict[str, MediaItem]:
    """One film, one home video, one anime episode of a Crime series."""
    user = await _owner(db)
    film = MediaItem(
        guid_key="tmdb:movie:1",
        media_type=MediaType.MOVIE,
        title="Heat",
        year=1995,
        genres=["Crime"],
        runtime_minutes=170,
        community_rating=8.3,
    )
    home = MediaItem(
        guid_key="plex:movie:2",
        media_type=MediaType.MOVIE,
        title="2020-03-31 19.42.27",
        is_personal_media=True,
    )
    show = MediaItem(
        guid_key="tvdb:3",
        media_type=MediaType.SHOW,
        title="Monster",
        genres=["Crime"],
        studio="Madhouse",
        network="NTV",
        is_anime=True,
    )
    db.add_all([film, home, show])
    await db.flush()
    episode = MediaItem(
        guid_key="tvdb:3/s1e1",
        media_type=MediaType.EPISODE,
        title="Herr Dr. Tenma",
        show_id=show.id,
        parent_id=show.id,
        year=2004,
        is_anime=True,
    )
    db.add(episode)
    await db.flush()

    db.add_all(
        [
            _play(user.id, film, dt.datetime(2024, 1, 1, tzinfo=UTC)),
            _play(user.id, home, dt.datetime(2024, 2, 1, tzinfo=UTC)),
            _play(user.id, episode, dt.datetime(2024, 3, 1, tzinfo=UTC)),
        ]
    )
    await db.commit()
    return {"film": film, "home": home, "show": show, "episode": episode}


async def test_history_lists_episodes(authed_client, db):
    """`default_types=False`, or television disappears from the watch log.

    `MediaFilters` defaults to movies and shows only, because seasons and
    episodes are reached through a show on the browse grids. Applied here it
    would empty the page for anyone who mainly watches television — and it is
    the single most likely thing to be left off when adopting the dependency.
    """
    await _library(db)
    assert "Herr Dr. Tenma" in await _history(authed_client)
    # And the shared parameter still narrows, so the default is not simply
    # "everything regardless".
    assert await _history(authed_client, media_type="episode") == ["Herr Dr. Tenma"]
    assert await _history(authed_client, media_type="movie") == [
        "2020-03-31 19.42.27",
        "Heat",
    ]


async def test_history_keeps_home_videos(authed_client, db):
    """`personal="all"`. The play happened; the row is never dropped for this.

    `MediaFilters` defaults to `personal="exclude"`, which is the right default
    for a library grid and the wrong one for a log. The dependency's default
    cannot be overridden per-router without restating the whole signature, so
    the router sets it on the parsed object — a line that looks removable and
    is not. This test is what fails if it goes.
    """
    await _library(db)
    assert "2020-03-31 19.42.27" in await _history(authed_client)
    assert await _total(authed_client) == 3

    # The grid, meanwhile, still hides it by default — the two pages disagree
    # on purpose, which is exactly why the override has to be explicit.
    grid = await authed_client.get("/api/media")
    assert "2020-03-31 19.42.27" not in [c["title"] for c in grid.json()["items"]]

    # The override is unconditional, so `personal` is inert on this page — a
    # log that could be asked to hide real plays is a log that will eventually
    # be asked to. Still a valid parameter (a 422 here would break links), just
    # one with nothing to say.
    assert await _total(authed_client, personal="exclude") == 3
    assert await _total(authed_client, personal="only") == 3
    assert (
        await authed_client.get("/api/history", params={"personal": "nonsense"})
    ).status_code == 422


async def test_anime_only_survives_as_a_deprecated_alias(authed_client, db):
    """The shipped frontend sends `?filter=anime` as `anime_only=true`.

    Removing it in the same change that migrates the frontend to the shared
    `anime` tri-state would leave neither half able to work on its own, so the
    old spelling maps onto the new one for one release.
    """
    await _library(db)
    assert await _history(authed_client, anime_only=True) == ["Herr Dr. Tenma"]
    assert await _history(authed_client, anime="only") == ["Herr Dr. Tenma"]
    # Absent means "no opinion", not "exclude".
    assert len(await _history(authed_client, anime_only=False)) == 3
    assert await _history(authed_client, anime="exclude") == [
        "2020-03-31 19.42.27",
        "Heat",
    ]


async def test_since_and_until_read_the_event_not_the_rollup(authed_client, db):
    """Two pairs of date bounds, and they are not interchangeable.

    `since`/`until` are `WatchEvent.watched_at` — when *this play* happened.
    `watched_after`/`watched_before` are `UserMediaState.last_watched_at` — the
    rollup of when you last touched the title at all. Merging them would answer
    a different question on every page that asked.
    """
    items = await _library(db)
    user = await _owner(db)
    # The film was played in January, but the rollup says it was last touched
    # in December — a rewatch Tally recorded without a new event row, which is
    # exactly where the two columns come apart.
    db.add(
        UserMediaState(
            user_id=user.id,
            media_item_id=items["film"].id,
            view_count=2,
            last_watched_at=dt.datetime(2024, 12, 25, tzinfo=UTC),
        )
    )
    await db.commit()

    assert await _history(authed_client, since="2024-02-15T00:00:00") == [
        "Herr Dr. Tenma"
    ]
    assert await _history(authed_client, until="2024-01-15T00:00:00") == ["Heat"]
    # The rollup bound picks the film out on a date no event of its own carries.
    assert await _history(authed_client, watched_after="2024-12-01T00:00:00") == ["Heat"]
    assert await _history(authed_client, since="2024-12-01T00:00:00") == []


async def test_history_gets_the_shared_filters_including_show_facets(authed_client, db):
    """A genre filter on an episode resolves through its show.

    History is mostly episodes, and episodes carry no genre of their own, so
    without `facet_source` this filter would match nothing on the one page it
    matters most.
    """
    await _library(db)

    assert await _history(authed_client, genre="Crime") == ["Herr Dr. Tenma", "Heat"]
    assert await _history(authed_client, studio="Madhouse") == ["Herr Dr. Tenma"]
    assert await _history(authed_client, network="NTV") == ["Herr Dr. Tenma"]
    assert await _history(authed_client, min_year=2000) == ["Herr Dr. Tenma"]
    assert await _history(authed_client, max_year=1999) == ["Heat"]
    assert await _history(authed_client, min_runtime=120) == ["Heat"]
    assert await _history(authed_client, min_community=8) == ["Heat"]
    assert await _history(authed_client, q="Tenma") == ["Herr Dr. Tenma"]


async def test_a_state_filter_does_not_fan_out_the_count(authed_client, db):
    """`count(WatchEvent.id)` stays honest through the per-user state join.

    The `(user_id, media_item_id)` unique constraint plus the user-scoped ON
    clause means at most one state row per event — but a join that ever gained
    a second one would silently multiply every number on the page.
    """
    items = await _library(db)
    user = await _owner(db)
    # A second play of the same film, so one state row now covers two events.
    db.add(_play(user.id, items["film"], dt.datetime(2024, 4, 1, tzinfo=UTC)))
    db.add(
        UserMediaState(
            user_id=user.id,
            media_item_id=items["film"].id,
            view_count=2,
            notes="one of the great heists",
        )
    )
    await db.commit()

    assert await _total(authed_client) == 4
    assert await _total(authed_client, has_notes=True) == 2
    assert await _history(authed_client, has_notes=True) == ["Heat", "Heat"]


async def test_history_sorts_are_its_own(authed_client, db):
    """`watched_at` is the default and the event's own column.

    It is deliberately not the shared `watched` sort, which reads the rollup —
    the same distinction `since` keeps from `watched_after`.
    """
    await _library(db)

    assert await _history(authed_client) == [
        "Herr Dr. Tenma",
        "2020-03-31 19.42.27",
        "Heat",
    ]
    assert await _history(authed_client, sort="watched_at", order="asc") == [
        "Heat",
        "2020-03-31 19.42.27",
        "Herr Dr. Tenma",
    ]
    assert await _history(authed_client, sort="title", order="asc") == [
        "2020-03-31 19.42.27",
        "Heat",
        "Herr Dr. Tenma",
    ]
    # Year-less rows go last in both directions, as everywhere else.
    assert await _history(authed_client, sort="year", order="desc") == [
        "Herr Dr. Tenma",
        "Heat",
        "2020-03-31 19.42.27",
    ]
    # An unknown sort is a 422, not a 500 or a silent fallback.
    assert (
        await authed_client.get("/api/history", params={"sort": "nonsense"})
    ).status_code == 422
