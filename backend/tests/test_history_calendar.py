"""`GET /api/history/calendar` — a month of plays, bucketed by the viewer's day.

Everything here is one of two rules, and both have been got wrong elsewhere in
this codebase before:

* **A day belongs to the viewer, not to the database.** Storage is UTC; which
  day a play landed on has no answer until you know the zone. The window is
  filtered in UTC and bucketed in local, and the response names the zone it
  actually used so a fallback is visible rather than silent.
* **The calendar must agree with the list under it.** It declares the same
  `MediaFilters` and makes the same two overrides, so a filter that narrows one
  narrows the other.
"""
import datetime as dt
import uuid
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from app.models import MediaItem, MediaType, User, WatchEvent, WatchSource

pytestmark = pytest.mark.asyncio

UTC = dt.UTC


async def _owner(db) -> User:
    return (await db.execute(select(User).where(User.username == "tester"))).scalar_one()


def _play(user_id: int, item: MediaItem, when: dt.datetime) -> WatchEvent:
    return WatchEvent(
        user_id=user_id,
        media_item_id=item.id,
        watched_at=when,
        source=WatchSource.PLEX_HISTORY,
        dedupe_key=f"manual:{uuid.uuid4()}",
        completed=True,
    )


async def _calendar(client, **params) -> dict:
    response = await client.get("/api/history/calendar", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _by_date(payload: dict) -> dict[str, dict]:
    return {day["date"]: day for day in payload["days"]}


async def _library(db) -> dict:
    """A film, and a three-episode series — enough to collapse a binge."""
    film = MediaItem(
        guid_key="tmdb:movie:1",
        media_type=MediaType.MOVIE,
        title="Heat",
        year=1995,
        genres=["Crime"],
        poster_url="https://image.example/heat.jpg",
    )
    show = MediaItem(
        guid_key="tvdb:3",
        media_type=MediaType.SHOW,
        title="Monster",
        genres=["Horror"],
        poster_url="https://image.example/monster.jpg",
    )
    db.add_all([film, show])
    await db.flush()
    episodes = [
        MediaItem(
            guid_key=f"tvdb:3/s1e{n}",
            media_type=MediaType.EPISODE,
            title=f"Episode {n}",
            show_id=show.id,
            parent_id=show.id,
            poster_url=f"https://image.example/monster-s1e{n}.jpg",
        )
        for n in (1, 2, 3)
    ]
    db.add_all(episodes)
    await db.flush()
    await db.commit()
    return {"film": film, "show": show, "episodes": episodes}


async def test_a_binge_is_one_title_and_several_plays(authed_client, db):
    """Three episodes on a Tuesday is one poster, one title and three plays.

    A cell is a picture and a number. Drawing one tile per *play* would make an
    evening of television bury a month of films, and it is the series you
    recognise, not the third episode of it.
    """
    library = await _library(db)
    user = await _owner(db)
    day = dt.datetime(2024, 5, 14, 20, 0, tzinfo=UTC)
    for index, episode in enumerate(library["episodes"]):
        db.add(_play(user.id, episode, day + dt.timedelta(minutes=25 * index)))
    db.add(_play(user.id, library["film"], dt.datetime(2024, 5, 2, 21, 0, tzinfo=UTC)))
    await db.commit()

    payload = await _calendar(authed_client, month="2024-05")
    assert payload["total"] == 4
    days = _by_date(payload)
    assert sorted(days) == ["2024-05-02", "2024-05-14"]

    binge = days["2024-05-14"]
    assert (binge["count"], binge["titles"]) == (3, 1)
    # The representative is the *most recent* episode, so the cell's card is the
    # row the list under it opens with.
    assert [card["title"] for card in binge["items"]] == ["Episode 3"]
    assert binge["items"][0]["show_title"] == "Monster"


async def test_an_episode_card_carries_the_series_poster(authed_client, db):
    """An episode's own artwork on Plex is the still from that episode.

    A 16:9 frame in a portrait card is a centre-crop of somebody's face. The
    parent's poster is the picture a viewer recognises, and only the parent row
    knows it — `show_id` alone cannot name it, because the URL may be an
    external one rather than the proxy path.
    """
    library = await _library(db)
    user = await _owner(db)
    db.add(
        _play(user.id, library["episodes"][0], dt.datetime(2024, 5, 14, 20, tzinfo=UTC))
    )
    await db.commit()

    card = _by_date(await _calendar(authed_client, month="2024-05"))["2024-05-14"]["items"][0]
    assert card["poster_url"] == "https://image.example/monster-s1e1.jpg"
    assert card["show_poster_url"] == "https://image.example/monster.jpg"

    # And the list endpoint says the same thing, because the two views of one
    # play must not disagree about which picture it is.
    listed = await authed_client.get("/api/history")
    assert listed.json()["events"][0]["item"]["show_poster_url"] == (
        "https://image.example/monster.jpg"
    )


async def test_a_film_has_no_show_poster(authed_client, db):
    """Null where there is no parent, so a reader falls back to `poster_url`."""
    library = await _library(db)
    user = await _owner(db)
    db.add(_play(user.id, library["film"], dt.datetime(2024, 5, 2, 21, tzinfo=UTC)))
    await db.commit()

    card = _by_date(await _calendar(authed_client, month="2024-05"))["2024-05-02"]["items"][0]
    assert card["show_poster_url"] is None


async def test_the_day_is_the_viewers_day(authed_client, db):
    """A 00:30 play in Oslo belongs to that day, not to the UTC one before it.

    The same bug `routers/stats.py` documents: bucketing in UTC moves a
    late-night play into the neighbouring day, and every number still looks
    plausible.
    """
    library = await _library(db)
    user = await _owner(db)
    # 22:30 UTC on the 14th is 00:30 on the 15th in Oslo (CEST, +02:00).
    db.add(_play(user.id, library["film"], dt.datetime(2024, 5, 14, 22, 30, tzinfo=UTC)))
    await db.commit()

    assert sorted(_by_date(await _calendar(authed_client, month="2024-05"))) == [
        "2024-05-14"
    ]
    oslo = await _calendar(authed_client, month="2024-05", tz="Europe/Oslo")
    assert sorted(_by_date(oslo)) == ["2024-05-15"]
    assert oslo["timezone"] == "Europe/Oslo"


async def test_the_month_bounds_are_local_midnight(authed_client, db):
    """The window is built as local midnight and converted, not sliced in UTC.

    A play at 23:30 UTC on 30 April is already May in Oslo, so a May calendar
    has to contain it — and an April one must not, or the two months both claim
    the same play.
    """
    library = await _library(db)
    user = await _owner(db)
    db.add(_play(user.id, library["film"], dt.datetime(2024, 4, 30, 23, 30, tzinfo=UTC)))
    await db.commit()

    assert (await _calendar(authed_client, month="2024-05", tz="Europe/Oslo"))["total"] == 1
    assert (await _calendar(authed_client, month="2024-04", tz="Europe/Oslo"))["total"] == 0
    # And in UTC the same play is April's, which is the whole point.
    assert (await _calendar(authed_client, month="2024-04"))["total"] == 1


async def test_an_unloadable_zone_falls_back_and_says_so(authed_client, db):
    """A zone name is untrusted input, and a silent fallback looks like data.

    UTC rather than a 500 — a calendar in the wrong hours is a nuisance, a
    broken page is not — but the response has to name the zone it used.
    """
    await _library(db)
    payload = await _calendar(authed_client, month="2024-05", tz="Mars/Olympus")
    assert payload["timezone"] == "UTC"


async def test_the_month_is_validated(authed_client, db):
    """A URL is untrusted input: a 422 beats silently drawing January."""
    await _library(db)
    for bad in ("2024-13", "nonsense", "2024-1", "2024-05-14"):
        response = await authed_client.get("/api/history/calendar", params={"month": bad})
        assert response.status_code == 422, bad


async def test_no_month_is_the_month_the_viewer_is_in(authed_client, db):
    """Defaulted in the resolved zone, not in the container's."""
    await _library(db)
    payload = await _calendar(authed_client, tz="Pacific/Auckland")
    local = dt.datetime.now(UTC).astimezone(ZoneInfo("Pacific/Auckland"))
    assert payload["month"] == local.strftime("%Y-%m")


async def test_the_shared_filters_narrow_the_calendar_too(authed_client, db):
    """The same `MediaFilters` as the list, or the two views disagree.

    Including the facet that resolves through a parent: an episode carries no
    genre of its own, and history is mostly episodes.
    """
    library = await _library(db)
    user = await _owner(db)
    db.add(_play(user.id, library["film"], dt.datetime(2024, 5, 2, 21, tzinfo=UTC)))
    db.add(
        _play(user.id, library["episodes"][0], dt.datetime(2024, 5, 14, 20, tzinfo=UTC))
    )
    await db.commit()

    assert (await _calendar(authed_client, month="2024-05"))["total"] == 2
    assert (await _calendar(authed_client, month="2024-05", genre="Crime"))["total"] == 1
    # Resolved through the show, which is the case that silently matched nothing
    # before `facet_source`.
    horror = await _calendar(authed_client, month="2024-05", genre="Horror")
    assert [day["date"] for day in horror["days"]] == ["2024-05-14"]
    # Episodes are listed at all, which is `default_types=False`.
    assert (await _calendar(authed_client, month="2024-05", media_type="episode"))[
        "total"
    ] == 1


async def test_the_pages_window_intersects_the_month(authed_client, db):
    """`since`/`until` narrow the month rather than replacing it.

    A window the page is already showing must not quietly widen back out when
    the same filters are drawn as a calendar.
    """
    library = await _library(db)
    user = await _owner(db)
    db.add(_play(user.id, library["film"], dt.datetime(2024, 5, 2, 21, tzinfo=UTC)))
    db.add(
        _play(user.id, library["episodes"][0], dt.datetime(2024, 5, 14, 20, tzinfo=UTC))
    )
    await db.commit()

    narrowed = await _calendar(
        authed_client, month="2024-05", since="2024-05-10T00:00:00"
    )
    assert [day["date"] for day in narrowed["days"]] == ["2024-05-14"]
    # A window outside the month empties it rather than reaching past it.
    outside = await _calendar(authed_client, month="2024-05", since="2024-06-01T00:00:00")
    assert outside["total"] == 0


async def test_a_cell_names_only_as_many_titles_as_it_can_draw(authed_client, db):
    """`per_day` caps the cards; `count` and `titles` still count everything."""
    library = await _library(db)
    user = await _owner(db)
    day = dt.datetime(2024, 5, 14, 18, tzinfo=UTC)
    db.add(_play(user.id, library["film"], day))
    for index, episode in enumerate(library["episodes"]):
        db.add(_play(user.id, episode, day + dt.timedelta(hours=1 + index)))
    # A second film, so the day has three distinct titles.
    other = MediaItem(guid_key="tmdb:movie:9", media_type=MediaType.MOVIE, title="Ronin")
    db.add(other)
    await db.flush()
    db.add(_play(user.id, other, day + dt.timedelta(hours=5)))
    await db.commit()

    cell = _by_date(await _calendar(authed_client, month="2024-05", per_day=1))[
        "2024-05-14"
    ]
    assert (cell["count"], cell["titles"]) == (5, 3)
    assert len(cell["items"]) == 1
    # Newest first, so the cap keeps the most recent title rather than an
    # arbitrary one.
    assert cell["items"][0]["title"] == "Ronin"

    wider = _by_date(await _calendar(authed_client, month="2024-05", per_day=3))
    assert len(wider["2024-05-14"]["items"]) == 3
    # Untrusted input again: an out-of-range cap is a 422, not a month-sized cell.
    response = await authed_client.get("/api/history/calendar", params={"per_day": 99})
    assert response.status_code == 422


async def test_only_days_with_plays_are_sent(authed_client, db):
    """The empty cells are the client's to draw, not a payload of zeroes."""
    library = await _library(db)
    user = await _owner(db)
    db.add(_play(user.id, library["film"], dt.datetime(2024, 5, 2, 21, tzinfo=UTC)))
    await db.commit()

    payload = await _calendar(authed_client, month="2024-05")
    assert len(payload["days"]) == 1


async def test_the_calendar_needs_a_session(client, db):
    """Anonymous gets nothing — a watch log is per user, like the list."""
    response = await client.get("/api/history/calendar", params={"month": "2024-05"})
    assert response.status_code == 401
