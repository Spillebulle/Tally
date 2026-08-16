"""The stats endpoints: windows, timezones, scoping and the runtime totals.

Everything on the stats page answers "over this window, in this timezone", and
almost every bug this suite pins down was one number quietly answering a
different question from the one next to it — ratings ignoring the window, the
day series truncated to half the range it was labelled with, a show counted
because it was ever finished rather than because it was watched.

The timezone tests deliberately use a zone well ahead of UTC and one well
behind it, because bucketing in UTC is only visibly wrong at the day boundary
and only in one direction at a time.
"""
from datetime import UTC, date, datetime, time, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from app.models import (
    MediaItem,
    MediaType,
    User,
    UserMediaState,
    WatchEvent,
    WatchSource,
    WatchStatus,
)

pytestmark = pytest.mark.asyncio

AUCKLAND = "Pacific/Auckland"  # UTC+12/+13 — a play at 23:30 UTC is tomorrow
LOS_ANGELES = "America/Los_Angeles"  # UTC-7/-8 — a play at 03:00 UTC is yesterday


# --- helpers --------------------------------------------------------------


async def _user(db, username: str = "tester") -> User:
    result = await db.execute(select(User).where(User.username == username))
    return result.scalar_one()


async def _second_user(db) -> User:
    user = User(username="other", display_name="Other", password_hash="x")
    db.add(user)
    await db.commit()
    return user


def _movie(title: str, **kwargs) -> MediaItem:
    return MediaItem(
        guid_key=f"test:{uuid4()}",
        media_type=MediaType.MOVIE,
        title=title,
        **kwargs,
    )


def _episode(show: MediaItem, number: int, **kwargs) -> MediaItem:
    return MediaItem(
        guid_key=f"test:{uuid4()}",
        media_type=MediaType.EPISODE,
        title=f"Episode {number}",
        show_id=show.id,
        season_number=1,
        episode_number=number,
        **kwargs,
    )


async def _add(db, *rows):
    db.add_all(rows)
    await db.commit()
    return rows


async def _log(db, user: User, item: MediaItem, when: datetime, **kwargs) -> WatchEvent:
    event = WatchEvent(
        user_id=user.id,
        media_item_id=item.id,
        watched_at=when,
        source=WatchSource.MANUAL,
        dedupe_key=f"test:{uuid4()}",
        completed=True,
        **kwargs,
    )
    db.add(event)
    await db.commit()
    return event


async def _rate(db, user: User, item: MediaItem, rating: float) -> UserMediaState:
    state = UserMediaState(user_id=user.id, media_item_id=item.id, rating=rating)
    db.add(state)
    await db.commit()
    return state


async def _stats(client, **params) -> dict:
    response = await client.get("/api/stats", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _day(series: list[dict], label: str) -> float:
    for point in series:
        if point["label"] == label:
            return point["value"]
    raise AssertionError(f"{label} is not in the series ({series[:3]} …)")


def _months_spanned(window: dict) -> int:
    """How many calendar months the resolved range touches, end included."""
    start = date.fromisoformat(window["start_day"])
    end = date.fromisoformat(window["end_day"])
    return (end.year - start.year) * 12 + end.month - start.month + 1


def _utc_at(days_ago: int, hour: int, minute: int = 0) -> datetime:
    """A fixed clock time on a past day, so the test never races midnight."""
    day = datetime.now(UTC).date() - timedelta(days=days_ago)
    return datetime.combine(day, time(hour, minute), tzinfo=UTC)


def _slot(buckets: list[dict], index: int) -> dict:
    """The bucket with this index, whatever order the list happens to be in."""
    for bucket in buckets:
        if bucket["index"] == index:
            return bucket
    raise AssertionError(f"no bucket {index} in {buckets}")


def _a_year_before(day: date) -> date:
    try:
        return day.replace(year=day.year - 1)
    except ValueError:  # 29 February
        return day.replace(year=day.year - 1, day=28)


async def _seasonality(client, **params) -> dict:
    response = await client.get("/api/stats/seasonality", params=params)
    assert response.status_code == 200, response.text
    return response.json()


# --- the empty case -------------------------------------------------------


async def test_empty_stats_are_zeros_over_the_whole_default_window(authed_client):
    stats = await _stats(authed_client)

    assert stats["watch_events"] == 0
    assert stats["total_movies_watched"] == 0
    assert stats["total_episodes_watched"] == 0
    assert stats["total_shows_watched"] == 0
    assert stats["total_runtime_minutes"] == 0
    assert stats["average_rating"] is None
    assert stats["current_streak_days"] == 0
    assert stats["longest_streak_days"] == 0
    assert stats["top_genres"] == []
    assert stats["previous"] is None
    # The day series is still drawn — an empty chart with a real axis, not an
    # absent one — and every rating bucket is present at zero.
    assert stats["range"]["days"] == 366
    assert len(stats["activity_by_day"]) == 366
    assert all(point["value"] == 0 for point in stats["activity_by_day"])
    assert [point["label"] for point in stats["rating_distribution"]] == [
        str(n) for n in range(1, 11)
    ]


# --- window boundaries ----------------------------------------------------


async def test_the_window_starts_at_local_midnight_and_excludes_what_precedes_it(
    authed_client, db
):
    user = await _user(db)
    (item,) = await _add(db, _movie("Solaris", runtime_minutes=10))

    start = datetime.combine(
        datetime.now(UTC).date() - timedelta(days=7), time.min, tzinfo=UTC
    )
    await _log(db, user, item, start)  # exactly on the boundary: included
    await _log(db, user, item, start - timedelta(seconds=1))  # one tick before: not

    stats = await _stats(authed_client, days=7, tz="UTC")
    assert stats["watch_events"] == 1
    assert stats["range"]["since"].startswith(start.date().isoformat())
    assert stats["range"]["start_day"] == start.date().isoformat()
    assert stats["range"]["end_day"] == datetime.now(UTC).date().isoformat()
    assert stats["range"]["days"] == 8


async def test_an_explicit_range_beats_a_preset_and_a_backwards_one_is_refused(
    authed_client, db
):
    user = await _user(db)
    (item,) = await _add(db, _movie("Stalker"))
    await _log(db, user, item, _utc_at(20, 12))
    await _log(db, user, item, _utc_at(2, 12))

    stats = await _stats(
        authed_client,
        preset="7d",
        since=(_utc_at(30, 0)).isoformat(),
        until=(_utc_at(10, 0)).isoformat(),
        tz="UTC",
    )
    # The preset would have held only the recent play; the explicit range holds
    # only the older one.
    assert stats["watch_events"] == 1
    assert stats["range"]["preset"] == "7d"
    assert stats["range"]["start_day"] == _utc_at(30, 0).date().isoformat()

    backwards = await authed_client.get(
        "/api/stats",
        params={"since": _utc_at(1, 0).isoformat(), "until": _utc_at(10, 0).isoformat()},
    )
    assert backwards.status_code == 422


@pytest.mark.parametrize(
    ("preset", "expected_start"),
    [
        ("7d", lambda today: today - timedelta(days=7)),
        ("30d", lambda today: today - timedelta(days=30)),
        ("ytd", lambda today: date(today.year, 1, 1)),
        ("last_year", lambda today: date(today.year - 1, 1, 1)),
    ],
)
async def test_presets_resolve_to_the_range_they_name(
    authed_client, preset, expected_start
):
    stats = await _stats(authed_client, preset=preset, tz="UTC")
    today = datetime.now(UTC).date()
    assert stats["range"]["preset"] == preset
    assert stats["range"]["start_day"] == expected_start(today).isoformat()


async def test_last_year_stops_at_new_year_and_ytd_starts_there(authed_client, db):
    user = await _user(db)
    (item,) = await _add(db, _movie("Late Spring"))
    today = datetime.now(UTC).date()
    new_year = datetime(today.year, 1, 1, tzinfo=UTC)

    await _log(db, user, item, new_year - timedelta(minutes=1))  # last year
    await _log(db, user, item, new_year)  # this year, to the minute

    last_year = await _stats(authed_client, preset="last_year", tz="UTC")
    assert last_year["watch_events"] == 1
    assert last_year["range"]["end_day"] == (new_year.date() - timedelta(days=1)).isoformat()

    ytd = await _stats(authed_client, preset="ytd", tz="UTC")
    assert ytd["watch_events"] == 1
    assert ytd["range"]["start_day"] == new_year.date().isoformat()


async def test_all_starts_at_the_first_play_ever_recorded(authed_client, db):
    user = await _user(db)
    (item,) = await _add(db, _movie("Metropolis"))
    first = datetime.now(UTC) - timedelta(days=900)
    await _log(db, user, item, first)
    await _log(db, user, item, datetime.now(UTC) - timedelta(hours=1))

    stats = await _stats(authed_client, preset="all", tz="UTC")
    assert stats["watch_events"] == 2
    assert stats["range"]["start_day"] == first.date().isoformat()


async def test_days_stays_a_working_alias_for_the_same_window(authed_client, db):
    """The shipped frontend and any API-key client still send `days=`."""
    user = await _user(db)
    (item,) = await _add(db, _movie("Chungking Express"))
    await _log(db, user, item, _utc_at(20, 12))

    thirty = await _stats(authed_client, days=30, tz="UTC")
    preset = await _stats(authed_client, preset="30d", tz="UTC")

    assert thirty["range"]["start_day"] == preset["range"]["start_day"]
    assert thirty["range"]["preset"] is None
    assert thirty["watch_events"] == 1
    assert (await _stats(authed_client, days=7, tz="UTC"))["watch_events"] == 0


# --- timezones ------------------------------------------------------------


async def test_a_late_night_play_belongs_to_the_local_day(authed_client, db):
    user = await _user(db)
    (item,) = await _add(db, _movie("Perfect Blue"))
    when = _utc_at(2, 23, 30)
    await _log(db, user, item, when)

    in_utc = await _stats(authed_client, days=7, tz="UTC")
    assert _day(in_utc["activity_by_day"], when.date().isoformat()) == 1

    # Auckland is half a day ahead, so 23:30 UTC is already tomorrow there.
    ahead = await _stats(authed_client, days=7, tz=AUCKLAND)
    assert _day(ahead["activity_by_day"], when.astimezone(ZoneInfo(AUCKLAND)).date().isoformat()) == 1
    assert _day(ahead["activity_by_day"], when.date().isoformat()) == 0


async def test_an_early_morning_play_belongs_to_the_previous_day_out_west(
    authed_client, db
):
    user = await _user(db)
    (item,) = await _add(db, _movie("Mulholland Drive"))
    when = _utc_at(2, 3, 0)
    await _log(db, user, item, when)

    behind = await _stats(authed_client, days=7, tz=LOS_ANGELES)
    local_day = when.astimezone(ZoneInfo(LOS_ANGELES)).date()
    assert local_day == when.date() - timedelta(days=1)
    assert _day(behind["activity_by_day"], local_day.isoformat()) == 1
    assert _day(behind["activity_by_day"], when.date().isoformat()) == 0


async def test_the_window_bound_itself_is_local_midnight(authed_client, db):
    """The range starts at the viewer's midnight, not at UTC's."""
    user = await _user(db)
    (item,) = await _add(db, _movie("Sans Soleil"))
    zone = ZoneInfo(AUCKLAND)
    today_local = datetime.now(UTC).astimezone(zone).date()
    start_local = datetime.combine(today_local - timedelta(days=7), time.min, tzinfo=zone)

    await _log(db, user, item, start_local.astimezone(UTC) - timedelta(minutes=30))
    await _log(db, user, item, start_local.astimezone(UTC) + timedelta(minutes=30))

    stats = await _stats(authed_client, days=7, tz=AUCKLAND)
    # Half an hour either side of local midnight, and only the later one is in.
    assert stats["watch_events"] == 1
    assert datetime.fromisoformat(stats["range"]["since"]) == start_local
    assert stats["range"]["start_day"] == (today_local - timedelta(days=7)).isoformat()


@pytest.mark.parametrize("name", ["Not/AZone", "../../etc/passwd", "x" * 200, "Mars/Base"])
async def test_an_unusable_timezone_falls_back_to_utc_rather_than_failing(
    authed_client, name
):
    stats = await _stats(authed_client, tz=name)
    assert stats["range"]["timezone"] == "UTC"


async def test_the_timezone_preference_is_used_and_the_parameter_overrides_it(
    authed_client, db
):
    saved = await authed_client.put(
        "/api/users/me/preferences", json={"timezone": AUCKLAND}
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["timezone"] == AUCKLAND

    assert (await _stats(authed_client))["range"]["timezone"] == AUCKLAND
    assert (await _stats(authed_client, tz="UTC"))["range"]["timezone"] == "UTC"


async def test_an_unknown_timezone_preference_is_refused_at_the_door(authed_client):
    rejected = await authed_client.put(
        "/api/users/me/preferences", json={"timezone": "Middle/Earth"}
    )
    assert rejected.status_code == 422
    # …and the default is still None, meaning UTC.
    assert (await authed_client.get("/api/users/me/preferences")).json()["timezone"] is None


# --- streaks --------------------------------------------------------------


async def test_a_streak_stays_current_through_yesterday_but_not_through_the_day_before(
    authed_client, db
):
    user = await _user(db)
    (item,) = await _add(db, _movie("Twin Peaks"))
    now = datetime.now(UTC)

    await _log(db, user, item, now - timedelta(days=2))
    await _log(db, user, item, now - timedelta(days=1))
    yesterday = await _stats(authed_client, days=30, tz="UTC")
    # Ends yesterday: still current, because requiring today would reset every
    # streak at midnight.
    assert yesterday["current_streak_days"] == 2
    assert yesterday["longest_streak_days"] == 2

    await _log(db, user, item, now - timedelta(minutes=5))
    today = await _stats(authed_client, days=30, tz="UTC")
    assert today["current_streak_days"] == 3


async def test_a_streak_that_ended_two_days_ago_is_over_but_still_the_longest(
    authed_client, db
):
    user = await _user(db)
    (item,) = await _add(db, _movie("Dekalog"))
    now = datetime.now(UTC)
    for days_ago in (4, 3, 2):
        await _log(db, user, item, now - timedelta(days=days_ago))

    stats = await _stats(authed_client, days=30, tz="UTC")
    assert stats["current_streak_days"] == 0
    assert stats["longest_streak_days"] == 3


async def test_two_plays_on_one_day_are_one_day_of_streak(authed_client, db):
    user = await _user(db)
    (item,) = await _add(db, _movie("Paprika"))
    now = datetime.now(UTC)
    await _log(db, user, item, now - timedelta(minutes=5))
    await _log(db, user, item, now - timedelta(minutes=90))

    stats = await _stats(authed_client, days=30, tz="UTC")
    assert stats["watch_events"] == 2
    assert stats["current_streak_days"] == 1
    assert stats["longest_streak_days"] == 1


# --- runtime --------------------------------------------------------------


async def test_runtime_prefers_the_length_the_play_itself_recorded(authed_client, db):
    user = await _user(db)
    (item,) = await _add(db, _movie("Andrei Rublev", runtime_minutes=205))
    await _log(db, user, item, _utc_at(1, 12), duration_ms=183 * 60_000)

    stats = await _stats(authed_client, days=7, tz="UTC")
    assert stats["total_runtime_minutes"] == 183


async def test_runtime_falls_back_to_the_item_then_to_a_default(authed_client, db):
    user = await _user(db)
    show, = await _add(db, MediaItem(guid_key=f"test:{uuid4()}", media_type=MediaType.SHOW, title="Show"))
    known, unknown, episode = await _add(
        db,
        _movie("Known", runtime_minutes=100),
        _movie("Unknown"),
        _episode(show, 1),
    )
    await _log(db, user, known, _utc_at(1, 12))
    await _log(db, user, unknown, _utc_at(1, 13))
    await _log(db, user, episode, _utc_at(1, 14))

    stats = await _stats(authed_client, days=7, tz="UTC")
    # 100 measured + the movie default + the episode default.
    assert stats["total_runtime_minutes"] == 100 + 110 + 24


async def test_a_manual_log_records_the_items_runtime_on_the_event(authed_client, db):
    (item,) = await _add(db, _movie("Arrival", runtime_minutes=116))
    await authed_client.post(f"/api/history/{item.id}/watched", params={"push_to_plex": False})

    event = (await db.execute(select(WatchEvent))).scalars().one()
    assert event.duration_ms == 116 * 60_000
    assert (await _stats(authed_client, days=7, tz="UTC"))["total_runtime_minutes"] == 116


# --- genres, types and shows ----------------------------------------------


async def test_genres_are_counted_once_per_play(authed_client, db):
    user = await _user(db)
    a, b = await _add(
        db,
        _movie("Alien", genres=["Science Fiction", "Horror"]),
        _movie("Aliens", genres=["Science Fiction"]),
    )
    await _log(db, user, a, _utc_at(1, 12))
    await _log(db, user, a, _utc_at(2, 12))
    await _log(db, user, b, _utc_at(3, 12))

    stats = await _stats(authed_client, days=7, tz="UTC")
    assert stats["top_genres"][0] == {"label": "Science Fiction", "value": 3}
    assert {"label": "Horror", "value": 2} in stats["top_genres"]


async def test_shows_watched_counts_this_window_not_everything_ever_finished(
    authed_client, db
):
    user = await _user(db)
    (finished,) = await _add(
        db, MediaItem(guid_key=f"test:{uuid4()}", media_type=MediaType.SHOW, title="Finished")
    )
    # Completed long ago, with nothing in the window. The old code took the
    # all-time count and the windowed one and returned whichever was larger,
    # which is two different questions with a max() between them.
    db.add(
        UserMediaState(
            user_id=user.id,
            media_item_id=finished.id,
            view_count=9,
            status=WatchStatus.COMPLETED,
        )
    )
    await db.commit()
    assert (await _stats(authed_client, days=7, tz="UTC"))["total_shows_watched"] == 0

    (episode,) = await _add(db, _episode(finished, 1))
    await _log(db, user, episode, _utc_at(1, 12))
    stats = await _stats(authed_client, days=7, tz="UTC")
    assert stats["total_shows_watched"] == 1
    assert stats["total_episodes_watched"] == 1


async def test_anime_only_scopes_every_number_on_the_page(authed_client, db):
    user = await _user(db)
    anime, western = await _add(
        db,
        _movie("Akira", is_anime=True, runtime_minutes=124, genres=["Animation"]),
        _movie("Heat", runtime_minutes=170, genres=["Crime"]),
    )
    await _log(db, user, anime, _utc_at(1, 12))
    await _log(db, user, western, _utc_at(1, 14))
    await _rate(db, user, anime, 9)
    await _rate(db, user, western, 4)

    stats = await _stats(authed_client, days=7, tz="UTC", anime_only=True)
    assert stats["watch_events"] == 1
    assert stats["total_anime_watched"] == 1
    assert stats["total_runtime_minutes"] == 124
    assert stats["average_rating"] == 9.0
    assert [g["label"] for g in stats["top_genres"]] == ["Animation"]


# --- ratings --------------------------------------------------------------


async def test_ratings_cover_what_was_watched_in_the_window(authed_client, db):
    user = await _user(db)
    watched, unwatched, old = await _add(
        db, _movie("Watched"), _movie("Never watched"), _movie("Watched long ago")
    )
    await _log(db, user, watched, _utc_at(1, 12))
    await _log(db, user, old, _utc_at(300, 12))
    await _rate(db, user, watched, 8)
    await _rate(db, user, unwatched, 2)
    await _rate(db, user, old, 4)

    week = await _stats(authed_client, days=7, tz="UTC")
    assert week["average_rating"] == 8.0
    assert _day(week["rating_distribution"], "8") == 1
    assert _day(week["rating_distribution"], "2") == 0
    assert _day(week["rating_distribution"], "4") == 0

    # Widen the window and the older play — and only it — joins in.
    year = await _stats(authed_client, days=365, tz="UTC")
    assert year["average_rating"] == 6.0


async def test_an_episodes_rating_is_the_shows(authed_client, db):
    user = await _user(db)
    (show,) = await _add(
        db, MediaItem(guid_key=f"test:{uuid4()}", media_type=MediaType.SHOW, title="Show")
    )
    (episode,) = await _add(db, _episode(show, 1))
    await _log(db, user, episode, _utc_at(1, 12))
    await _rate(db, user, show, 7)

    stats = await _stats(authed_client, days=7, tz="UTC")
    assert stats["average_rating"] == 7.0
    assert _day(stats["rating_distribution"], "7") == 1


# --- home videos ----------------------------------------------------------


async def test_home_videos_count_towards_watch_stats_but_not_the_library_counts(
    authed_client, db
):
    """Deliberate, and not an oversight — do not "fix" this into consistency.

    The browse grids hide personal media by default, so the library inventory
    on /summary hides it too or the header disagrees with the grid beneath it.
    The watch numbers keep it: those hours were really watched, the plays are
    real history, and quietly dropping them would change the totals a user has
    already seen. If the shared browse filters are ever wired into stats, the
    default there has to stay `personal="all"`.
    """
    user = await _user(db)
    film, home_video = await _add(
        db,
        _movie("Sicario", runtime_minutes=121),
        _movie("2020-03-31 19.42.27", runtime_minutes=3, is_personal_media=True),
    )
    await _log(db, user, film, _utc_at(1, 12))
    await _log(db, user, home_video, _utc_at(1, 13))

    stats = await _stats(authed_client, days=7, tz="UTC")
    assert stats["watch_events"] == 2
    assert stats["total_movies_watched"] == 2
    assert stats["total_runtime_minutes"] == 124

    summary = (await authed_client.get("/api/stats/summary")).json()
    assert summary["library_movies"] == 1  # the home video is not on the shelf
    assert summary["watch_events"] == 2  # but the play is still history


# --- per-user isolation ---------------------------------------------------


async def test_one_users_plays_never_appear_in_anothers_stats(authed_client, db):
    mine = await _user(db)
    theirs = await _second_user(db)
    a, b = await _add(db, _movie("Mine", runtime_minutes=90), _movie("Theirs", runtime_minutes=90))
    await _log(db, mine, a, _utc_at(1, 12))
    await _log(db, theirs, b, _utc_at(1, 12))
    await _log(db, theirs, b, _utc_at(2, 12))
    await _rate(db, theirs, b, 10)

    stats = await _stats(authed_client, days=7, tz="UTC")
    assert stats["watch_events"] == 1
    assert stats["total_runtime_minutes"] == 90
    assert stats["average_rating"] is None
    assert _day(stats["activity_by_day"], _utc_at(1, 12).date().isoformat()) == 1
    assert _day(stats["activity_by_day"], _utc_at(2, 12).date().isoformat()) == 0

    summary = (await authed_client.get("/api/stats/summary")).json()
    assert summary["watch_events"] == 1
    assert summary["library_movies"] == 2  # the library is shared; the history is not


# --- the day series -------------------------------------------------------


async def test_the_day_series_covers_the_whole_range_it_was_asked_for(authed_client):
    """It used to stop at 180 days however long a range the tiles described."""
    stats = await _stats(authed_client, days=365, tz="UTC")
    series = stats["activity_by_day"]
    assert len(series) == 366
    assert series[0]["label"] == stats["range"]["start_day"]
    assert series[-1]["label"] == stats["range"]["end_day"]


async def test_granularity_buckets_the_series_instead_of_capping_it(authed_client, db):
    user = await _user(db)
    (item,) = await _add(db, _movie("Sátántangó"))
    await _log(db, user, item, _utc_at(1, 12))
    await _log(db, user, item, _utc_at(2, 12))

    monthly = await _stats(authed_client, days=365, tz="UTC", granularity="month")
    assert monthly["range"]["granularity"] == "month"
    assert len(monthly["activity_by_day"]) == _months_spanned(monthly["range"])
    assert all(len(point["label"]) == len("2026-01") for point in monthly["activity_by_day"])
    assert sum(point["value"] for point in monthly["activity_by_day"]) == 2

    weekly = await _stats(authed_client, days=28, tz="UTC", granularity="week")
    assert len(weekly["activity_by_day"]) in (5, 6)  # 29 days spans five or six weeks
    assert all(
        date.fromisoformat(point["label"]).weekday() == 0
        for point in weekly["activity_by_day"]
    )
    assert sum(point["value"] for point in weekly["activity_by_day"]) == 2


async def test_the_monthly_series_fills_the_months_with_nothing_in_them(authed_client, db):
    user = await _user(db)
    (item,) = await _add(db, _movie("Ran"))
    await _log(db, user, item, _utc_at(1, 12))

    stats = await _stats(authed_client, days=365, tz="UTC")
    months = stats["activity_by_month"]
    assert len(months) == _months_spanned(stats["range"])
    assert len(months) >= 12
    assert sum(point["value"] for point in months) == 1
    assert months == sorted(months, key=lambda point: point["label"])


# --- comparison -----------------------------------------------------------


async def test_compare_aggregates_the_window_immediately_before_this_one(
    authed_client, db
):
    user = await _user(db)
    (item,) = await _add(db, _movie("Le Samouraï", runtime_minutes=105))
    await _log(db, user, item, _utc_at(1, 12))
    await _log(db, user, item, _utc_at(3, 12))
    await _log(db, user, item, _utc_at(12, 12))  # inside the preceding week

    stats = await _stats(authed_client, days=7, tz="UTC", compare=True)
    assert stats["watch_events"] == 2
    previous = stats["previous"]
    assert previous["totals"]["watch_events"] == 1
    assert previous["totals"]["total_runtime_minutes"] == 105
    # The two windows meet exactly, so no play can fall into both or neither.
    assert previous["range"]["until"] == stats["range"]["since"]
    assert previous["range"]["days"] == stats["range"]["days"]
    assert previous["pct_change"]["watch_events"] == 100.0
    assert previous["pct_change"]["total_runtime_minutes"] == 100.0


async def test_compare_omits_a_percentage_it_cannot_compute(authed_client, db):
    user = await _user(db)
    (item,) = await _add(db, _movie("Ikiru"))
    await _log(db, user, item, _utc_at(1, 12))

    stats = await _stats(authed_client, days=7, tz="UTC", compare=True)
    previous = stats["previous"]
    assert previous["totals"]["watch_events"] == 0
    # Growth from nothing has no percentage; the tile shows the raw pair.
    assert "watch_events" not in previous["pct_change"]
    assert "average_rating" not in previous["pct_change"]


async def test_compare_is_off_unless_asked_for(authed_client):
    assert (await _stats(authed_client, days=7))["previous"] is None
    assert (await _stats(authed_client, days=7))["previous_year"] is None


async def test_compare_also_returns_the_same_window_a_year_earlier(authed_client, db):
    """"Down on last month" and "down on last December" are different questions."""
    user = await _user(db)
    (item,) = await _add(db, _movie("Tokyo Godfathers", runtime_minutes=92))
    await _log(db, user, item, _utc_at(2, 12))
    await _log(db, user, item, _utc_at(3 + 365, 12))  # the same week, last year

    stats = await _stats(authed_client, days=7, tz="UTC", compare=True)
    last_year = stats["previous_year"]
    assert stats["watch_events"] == 1
    assert stats["previous"]["totals"]["watch_events"] == 0  # nothing last week
    assert last_year["totals"]["watch_events"] == 1
    assert last_year["totals"]["total_runtime_minutes"] == 92

    # A calendar year back, not 365 days back: the window must still start at a
    # local midnight on the same date, whatever leap years intervene.
    start = date.fromisoformat(stats["range"]["start_day"])
    assert last_year["range"]["start_day"] == _a_year_before(start).isoformat()


# --- time shape: weekday, hour and the punch card -------------------------


async def test_the_weekday_and_hour_belong_to_the_viewers_clock_ahead_of_utc(
    authed_client, db
):
    """23:30 UTC is already tomorrow lunchtime in Auckland."""
    user = await _user(db)
    (item,) = await _add(db, _movie("Late Autumn", runtime_minutes=128))
    when = _utc_at(2, 23, 30)
    await _log(db, user, item, when)

    local = when.astimezone(ZoneInfo(AUCKLAND))
    assert local.date() == when.date() + timedelta(days=1)  # the test has teeth

    ahead = await _stats(authed_client, days=7, tz=AUCKLAND)
    assert _slot(ahead["by_weekday"], local.weekday()) == {
        "index": local.weekday(),
        "label": local.strftime("%A"),
        "plays": 1,
        "minutes": 128,
    }
    assert _slot(ahead["by_weekday"], when.weekday())["plays"] == 0
    assert _slot(ahead["by_hour"], local.hour)["plays"] == 1
    assert _slot(ahead["by_hour"], 23)["plays"] == 0

    in_utc = await _stats(authed_client, days=7, tz="UTC")
    assert _slot(in_utc["by_weekday"], when.weekday())["plays"] == 1
    assert _slot(in_utc["by_hour"], 23)["plays"] == 1


async def test_the_weekday_and_hour_belong_to_the_viewers_clock_behind_utc(
    authed_client, db
):
    """03:00 UTC is still yesterday evening in Los Angeles."""
    user = await _user(db)
    (item,) = await _add(db, _movie("Zodiac", runtime_minutes=157))
    when = _utc_at(2, 3, 0)
    await _log(db, user, item, when)

    local = when.astimezone(ZoneInfo(LOS_ANGELES))
    assert local.date() == when.date() - timedelta(days=1)

    behind = await _stats(authed_client, days=7, tz=LOS_ANGELES)
    assert _slot(behind["by_weekday"], local.weekday())["plays"] == 1
    assert _slot(behind["by_weekday"], when.weekday())["plays"] == 0
    assert _slot(behind["by_hour"], local.hour)["plays"] == 1
    assert _slot(behind["by_hour"], 3)["plays"] == 0
    assert local.hour in (19, 20)  # PST or PDT, but never 03:00


async def test_the_weekday_profile_is_monday_first_and_always_seven_long(authed_client):
    stats = await _stats(authed_client, days=7, tz="UTC")
    assert [bucket["label"] for bucket in stats["by_weekday"]] == [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    ]
    assert [bucket["index"] for bucket in stats["by_weekday"]] == list(range(7))
    assert [bucket["index"] for bucket in stats["by_hour"]] == list(range(24))
    assert [bucket["label"] for bucket in stats["by_hour"]][:3] == ["00", "01", "02"]


async def test_minutes_are_counted_beside_plays_in_every_profile(authed_client, db):
    """Three sitcom episodes and one film are not the same evening."""
    user = await _user(db)
    (show,) = await _add(
        db, MediaItem(guid_key=f"test:{uuid4()}", media_type=MediaType.SHOW, title="Show")
    )
    film, episode = await _add(db, _movie("Heat", runtime_minutes=170), _episode(show, 1))
    await _log(db, user, film, _utc_at(1, 20))
    await _log(db, user, episode, _utc_at(1, 21))

    stats = await _stats(authed_client, days=7, tz="UTC")
    assert _slot(stats["by_hour"], 20)["minutes"] == 170
    assert _slot(stats["by_hour"], 21)["minutes"] == 24  # the episode default
    assert sum(bucket["minutes"] for bucket in stats["by_weekday"]) == 194
    assert sum(bucket["minutes"] for bucket in stats["by_weekday"]) == (
        stats["total_runtime_minutes"]
    )


async def test_the_punch_card_is_a_7x24_matrix_holding_exactly_the_plays(
    authed_client, db
):
    user = await _user(db)
    (item,) = await _add(db, _movie("Chungking Express"))
    for days_ago, hour in ((1, 21), (2, 21), (3, 9)):
        await _log(db, user, item, _utc_at(days_ago, hour))

    stats = await _stats(authed_client, days=7, tz="UTC")
    card = stats["punch_card"]
    assert len(card["plays"]) == 7
    assert all(len(row) == 24 for row in card["plays"])
    assert card["hours"] == list(range(24))
    assert card["weekdays"][0] == "Monday"

    total = sum(cell for row in card["plays"] for cell in row)
    assert total == stats["watch_events"] == 3
    assert card["max_plays"] == 1  # three different (weekday, hour) slots

    for days_ago, hour in ((1, 21), (2, 21), (3, 9)):
        when = _utc_at(days_ago, hour)
        assert card["plays"][when.weekday()][hour] == 1

    # And the flat profiles are the same numbers, seen along each axis.
    for index, bucket in enumerate(stats["by_weekday"]):
        assert bucket["plays"] == sum(card["plays"][index])
    for hour, bucket in enumerate(stats["by_hour"]):
        assert bucket["plays"] == sum(row[hour] for row in card["plays"])


async def test_the_punch_card_moves_with_the_timezone_too(authed_client, db):
    user = await _user(db)
    (item,) = await _add(db, _movie("In the Mood for Love"))
    when = _utc_at(2, 23, 30)
    await _log(db, user, item, when)

    in_utc = (await _stats(authed_client, days=7, tz="UTC"))["punch_card"]["plays"]
    ahead = (await _stats(authed_client, days=7, tz=AUCKLAND))["punch_card"]["plays"]
    local = when.astimezone(ZoneInfo(AUCKLAND))

    assert in_utc[when.weekday()][23] == 1
    assert ahead[when.weekday()][23] == 0
    assert ahead[local.weekday()][local.hour] == 1


async def test_the_time_shape_respects_the_window_and_anime_only(authed_client, db):
    user = await _user(db)
    anime, western = await _add(
        db,
        _movie("Akira", is_anime=True, runtime_minutes=124),
        _movie("Heat", runtime_minutes=170),
    )
    await _log(db, user, anime, _utc_at(1, 20))
    await _log(db, user, western, _utc_at(1, 20))
    await _log(db, user, anime, _utc_at(300, 20))  # outside a seven-day window

    week = await _stats(authed_client, days=7, tz="UTC")
    assert _slot(week["by_hour"], 20)["plays"] == 2

    anime_week = await _stats(authed_client, days=7, tz="UTC", anime_only=True)
    assert _slot(anime_week["by_hour"], 20)["plays"] == 1
    assert _slot(anime_week["by_hour"], 20)["minutes"] == 124
    assert anime_week["punch_card"]["max_plays"] == 1


# --- first watch vs rewatch -----------------------------------------------


async def test_a_play_is_a_rewatch_because_of_history_outside_the_window(
    authed_client, db
):
    """The easy mistake: ranking inside the window calls this a first watch."""
    user = await _user(db)
    (item,) = await _add(db, _movie("Solaris"))
    await _log(db, user, item, _utc_at(500, 12))  # years before the window
    await _log(db, user, item, _utc_at(2, 12))  # inside it

    rewatch = (await _stats(authed_client, days=7, tz="UTC"))["rewatch"]
    assert rewatch["plays"] == 1
    assert rewatch["first_watches"] == 0
    assert rewatch["rewatches"] == 1
    assert rewatch["rewatch_ratio"] == 1.0

    # Widen the window past the first play and it becomes one of each.
    wide = (await _stats(authed_client, days=600, tz="UTC"))["rewatch"]
    assert (wide["first_watches"], wide["rewatches"]) == (1, 1)
    assert wide["rewatch_ratio"] == 0.5


async def test_the_first_and_rewatch_counts_always_sum_to_the_plays(authed_client, db):
    user = await _user(db)
    seen_before, fresh = await _add(db, _movie("Alien"), _movie("Aliens"))
    await _log(db, user, seen_before, _utc_at(400, 12))
    await _log(db, user, seen_before, _utc_at(3, 12))
    await _log(db, user, seen_before, _utc_at(2, 12))
    await _log(db, user, fresh, _utc_at(1, 12))

    stats = await _stats(authed_client, days=7, tz="UTC")
    rewatch = stats["rewatch"]
    assert rewatch["plays"] == stats["watch_events"] == 3
    assert rewatch["first_watches"] + rewatch["rewatches"] == rewatch["plays"]
    assert (rewatch["first_watches"], rewatch["rewatches"]) == (1, 2)
    assert rewatch["rewatch_ratio"] == round(2 / 3, 4)

    per_bucket = sum(b["first"] + b["rewatch"] for b in rewatch["by_bucket"])
    assert per_bucket == rewatch["plays"]


async def test_the_rewatch_split_lines_up_with_the_activity_series(authed_client, db):
    user = await _user(db)
    (item,) = await _add(db, _movie("Ran"))
    await _log(db, user, item, _utc_at(400, 12))
    await _log(db, user, item, _utc_at(2, 12))

    for granularity in ("day", "week", "month"):
        stats = await _stats(
            authed_client, days=30, tz="UTC", granularity=granularity
        )
        labels = [point["label"] for point in stats["activity_by_day"]]
        assert [b["label"] for b in stats["rewatch"]["by_bucket"]] == labels
        for point, split in zip(
            stats["activity_by_day"], stats["rewatch"]["by_bucket"], strict=True
        ):
            assert point["value"] == split["first"] + split["rewatch"]

    day = _utc_at(2, 12).date().isoformat()
    split = next(
        b for b in (await _stats(authed_client, days=30, tz="UTC"))["rewatch"]["by_bucket"]
        if b["label"] == day
    )
    assert (split["first"], split["rewatch"]) == (0, 1)


async def test_the_rewatch_split_buckets_in_the_viewers_timezone(authed_client, db):
    user = await _user(db)
    (item,) = await _add(db, _movie("Perfect Blue"))
    await _log(db, user, item, _utc_at(400, 12))
    when = _utc_at(2, 23, 30)
    await _log(db, user, item, when)

    ahead = (await _stats(authed_client, days=30, tz=AUCKLAND))["rewatch"]["by_bucket"]
    local_day = when.astimezone(ZoneInfo(AUCKLAND)).date().isoformat()
    assert next(b for b in ahead if b["label"] == local_day)["rewatch"] == 1
    assert next(b for b in ahead if b["label"] == when.date().isoformat())["rewatch"] == 0


async def test_the_most_rewatched_ranking_counts_the_whole_history_not_the_window(
    authed_client, db
):
    """Nothing here was watched inside the window, and the ranking still knows."""
    user = await _user(db)
    often, once = await _add(db, _movie("The Thing"), _movie("Prince of Darkness"))
    for days_ago in (500, 400, 300):
        await _log(db, user, often, _utc_at(days_ago, 12))
    await _log(db, user, once, _utc_at(450, 12))

    stats = await _stats(authed_client, days=7, tz="UTC")
    assert stats["watch_events"] == 0  # the window itself is empty
    ranking = stats["rewatch"]["most_rewatched"]
    assert [row["title"] for row in ranking] == ["The Thing"]  # one play is not a rewatch
    row = ranking[0]
    assert row["plays"] == 3
    assert row["media_item_id"] == often.id
    assert row["first_watched"].startswith(_utc_at(500, 12).date().isoformat())
    assert row["last_watched"].startswith(_utc_at(300, 12).date().isoformat())
    assert row["poster_url"] == f"/api/images/{often.id}/poster"
    assert stats["rewatch"]["ranked_over"] == "all_time"


async def test_the_ranking_is_ordered_by_plays_and_names_an_episodes_show(
    authed_client, db
):
    user = await _user(db)
    (show,) = await _add(
        db, MediaItem(guid_key=f"test:{uuid4()}", media_type=MediaType.SHOW, title="Firefly")
    )
    film, episode = await _add(db, _movie("Serenity", year=2005), _episode(show, 4))
    for days_ago in (30, 20):
        await _log(db, user, film, _utc_at(days_ago, 12))
    for days_ago in (30, 20, 10, 5):
        await _log(db, user, episode, _utc_at(days_ago, 12))

    ranking = (await _stats(authed_client, days=365, tz="UTC"))["rewatch"]["most_rewatched"]
    assert [(row["title"], row["plays"]) for row in ranking] == [
        ("Episode 4", 4),
        ("Serenity", 2),
    ]
    assert ranking[0]["show_title"] == "Firefly"
    assert ranking[1]["show_title"] is None
    assert ranking[1]["year"] == 2005
    assert ranking[1]["media_type"] == "movie"


async def test_the_ranking_and_the_split_respect_anime_only(authed_client, db):
    user = await _user(db)
    anime, western = await _add(db, _movie("Akira", is_anime=True), _movie("Heat"))
    for days_ago in (5, 4):
        await _log(db, user, anime, _utc_at(days_ago, 12))
        await _log(db, user, western, _utc_at(days_ago, 13))

    rewatch = (await _stats(authed_client, days=7, tz="UTC", anime_only=True))["rewatch"]
    assert [row["title"] for row in rewatch["most_rewatched"]] == ["Akira"]
    assert (rewatch["first_watches"], rewatch["rewatches"]) == (1, 1)


async def test_one_users_rewatches_never_appear_in_anothers(authed_client, db):
    mine = await _user(db)
    theirs = await _second_user(db)
    (item,) = await _add(db, _movie("Groundhog Day"))
    # The same item, watched once by me and three times by them.
    await _log(db, mine, item, _utc_at(2, 12))
    for days_ago in (5, 4, 3):
        await _log(db, theirs, item, _utc_at(days_ago, 12))

    rewatch = (await _stats(authed_client, days=7, tz="UTC"))["rewatch"]
    assert rewatch["plays"] == 1
    # Their three plays neither make mine a rewatch nor put the film in my
    # ranking: the ranking is all-time, but it is still all of *my* time.
    assert (rewatch["first_watches"], rewatch["rewatches"]) == (1, 0)
    assert rewatch["most_rewatched"] == []


async def test_two_plays_stamped_at_the_same_instant_are_one_first_and_one_rewatch(
    authed_client, db
):
    """A tie has to break somewhere, and it must break the same way every time."""
    user = await _user(db)
    (item,) = await _add(db, _movie("Primer"))
    when = _utc_at(2, 12)
    await _log(db, user, item, when)
    await _log(db, user, item, when)

    rewatch = (await _stats(authed_client, days=7, tz="UTC"))["rewatch"]
    assert (rewatch["first_watches"], rewatch["rewatches"]) == (1, 1)


async def test_the_time_shape_and_rewatch_fields_are_present_and_empty_when_nothing_was_watched(
    authed_client,
):
    stats = await _stats(authed_client)
    assert [bucket["plays"] for bucket in stats["by_weekday"]] == [0] * 7
    assert [bucket["minutes"] for bucket in stats["by_hour"]] == [0] * 24
    assert stats["punch_card"]["plays"] == [[0] * 24 for _ in range(7)]
    assert stats["punch_card"]["max_plays"] == 0

    rewatch = stats["rewatch"]
    assert rewatch["plays"] == rewatch["first_watches"] == rewatch["rewatches"] == 0
    assert rewatch["rewatch_ratio"] == 0.0  # not a division by zero
    assert rewatch["most_rewatched"] == []
    # The split still draws a full axis, like the activity series above it.
    assert len(rewatch["by_bucket"]) == len(stats["activity_by_day"])
    assert all(b["first"] == b["rewatch"] == 0 for b in rewatch["by_bucket"])


# --- the shared browse filters --------------------------------------------
#
# `GET /api/stats` takes the same `MediaFilters` dependency as the grids, the
# watchlist and History, so "stats for horror films I rated 8 and up" is one
# request. Three of the four things that can go wrong here are silent — a
# number that is merely smaller than it should be looks exactly like a number
# that is correct — so each of these pins a specific way of being quietly wrong.


async def test_a_genre_filter_narrows_every_number_on_the_page(authed_client, db):
    user = await _user(db)
    horror, comedy = await _add(
        db,
        _movie("The Thing", genres=["Horror"], runtime_minutes=109),
        _movie("Airplane!", genres=["Comedy"], runtime_minutes=88),
    )
    await _log(db, user, horror, _utc_at(1, 20))
    await _log(db, user, comedy, _utc_at(1, 21))
    await _rate(db, user, horror, 10)
    await _rate(db, user, comedy, 6)

    everything = await _stats(authed_client, days=7, tz="UTC")
    assert everything["watch_events"] == 2
    assert everything["total_runtime_minutes"] == 197

    narrowed = await _stats(authed_client, days=7, tz="UTC", genre="Horror")
    assert narrowed["watch_events"] == 1
    assert narrowed["total_movies_watched"] == 1
    assert narrowed["total_runtime_minutes"] == 109
    # The ratings come off the same subject set, so they narrow with it.
    assert narrowed["average_rating"] == 10.0
    assert [g["label"] for g in narrowed["top_genres"]] == ["Horror"]
    assert _slot(narrowed["by_hour"], 20)["plays"] == 1
    assert _slot(narrowed["by_hour"], 21)["plays"] == 0
    assert narrowed["punch_card"]["max_plays"] == 1


async def test_episodes_are_counted_rather_than_dropped_by_the_shared_default(
    authed_client, db
):
    """`default_types` keeps the flat grids to movies and shows; a watch log is
    mostly episodes, so inheriting it would empty the page for a TV viewer."""
    user = await _user(db)
    (show,) = await _add(
        db, MediaItem(guid_key=f"test:{uuid4()}", media_type=MediaType.SHOW, title="Show")
    )
    (episode,) = await _add(db, _episode(show, 1))
    await _log(db, user, episode, _utc_at(1, 12))

    stats = await _stats(authed_client, days=7, tz="UTC")
    assert stats["watch_events"] == 1
    assert stats["total_episodes_watched"] == 1


async def test_an_episodes_play_is_counted_under_its_shows_genre(authed_client, db):
    """The whole point of `facet_source`: enrichment skips episodes, so an
    episode carries no genre of its own and a genre filter used to match
    nothing — silently, because an empty page looks like an honest answer."""
    user = await _user(db)
    crime, sitcom = await _add(
        db,
        MediaItem(
            guid_key=f"test:{uuid4()}",
            media_type=MediaType.SHOW,
            title="The Wire",
            genres=["Crime"],
        ),
        MediaItem(
            guid_key=f"test:{uuid4()}",
            media_type=MediaType.SHOW,
            title="Cheers",
            genres=["Comedy"],
        ),
    )
    crime_episode, sitcom_episode = await _add(db, _episode(crime, 1), _episode(sitcom, 1))
    assert not crime_episode.genres  # the episode itself knows nothing
    await _log(db, user, crime_episode, _utc_at(1, 12))
    await _log(db, user, sitcom_episode, _utc_at(1, 13))

    stats = await _stats(authed_client, days=7, tz="UTC", genre="Crime")
    assert stats["watch_events"] == 1
    assert stats["total_episodes_watched"] == 1
    assert stats["total_shows_watched"] == 1


async def test_a_state_filter_narrows_the_page_without_fanning_the_counts_out(
    authed_client, db
):
    """`min_rating` reads the per-user state row, so the query has to join it —
    and the `(user_id, media_item_id)` unique constraint is the only reason
    that join cannot turn one play into two."""
    user = await _user(db)
    loved, tolerated, unrated = await _add(
        db,
        _movie("Stalker", runtime_minutes=162),
        _movie("Battlefield Earth", runtime_minutes=118),
        _movie("Unrated", runtime_minutes=100),
    )
    await _rate(db, user, loved, 9)
    await _rate(db, user, tolerated, 3)
    for days_ago in (3, 2, 1):
        await _log(db, user, loved, _utc_at(days_ago, 20))
    await _log(db, user, tolerated, _utc_at(1, 21))
    await _log(db, user, unrated, _utc_at(1, 22))

    stats = await _stats(authed_client, days=7, tz="UTC", min_rating=8)
    # Three plays of one film, not six: the state row joins once per item.
    assert stats["watch_events"] == 3
    assert stats["total_movies_watched"] == 3
    assert stats["total_runtime_minutes"] == 162 * 3
    assert stats["average_rating"] == 9.0
    assert sum(bucket["plays"] for bucket in stats["by_weekday"]) == 3
    assert sum(cell for row in stats["punch_card"]["plays"] for cell in row) == 3
    # And the rewatch split counts the same three plays.
    assert stats["rewatch"]["plays"] == 3
    assert (stats["rewatch"]["first_watches"], stats["rewatch"]["rewatches"]) == (1, 2)


async def test_a_state_filter_reads_only_this_users_state(authed_client, db):
    user = await _user(db)
    theirs = await _second_user(db)
    (item,) = await _add(db, _movie("Solaris"))
    await _log(db, user, item, _utc_at(1, 12))
    await _rate(db, theirs, item, 10)  # their ten, not mine

    assert (await _stats(authed_client, days=7, tz="UTC", min_rating=8))["watch_events"] == 0
    assert (await _stats(authed_client, days=7, tz="UTC"))["watch_events"] == 1


async def test_anime_only_is_a_deprecated_alias_for_the_shared_tri_state(
    authed_client, db
):
    """The shipped Stats page still sends `anime_only=true`; both spellings have
    to describe the same set until it is migrated."""
    user = await _user(db)
    anime, western = await _add(
        db, _movie("Akira", is_anime=True, runtime_minutes=124), _movie("Heat")
    )
    await _log(db, user, anime, _utc_at(1, 12))
    await _log(db, user, western, _utc_at(1, 13))

    legacy = await _stats(authed_client, days=7, tz="UTC", anime_only=True)
    current = await _stats(authed_client, days=7, tz="UTC", anime="only")
    assert legacy["watch_events"] == current["watch_events"] == 1
    assert legacy["total_runtime_minutes"] == current["total_runtime_minutes"] == 124

    excluded = await _stats(authed_client, days=7, tz="UTC", anime="exclude")
    assert excluded["watch_events"] == 1
    assert excluded["total_anime_watched"] == 0


async def test_home_videos_count_whatever_personal_is_set_to(authed_client, db):
    """`personal` defaults to "exclude" on `MediaFilters` and is overridden here
    unconditionally, exactly as `routers/history.py` does it: a page counting
    hours really watched must not be able to hide plays that really happened.
    So the parameter stays valid — a stale link must not 422 — but inert."""
    user = await _user(db)
    film, home_video = await _add(
        db,
        _movie("Sicario", runtime_minutes=121),
        _movie("2020-03-31 19.42.27", runtime_minutes=3, is_personal_media=True),
    )
    await _log(db, user, film, _utc_at(1, 12))
    await _log(db, user, home_video, _utc_at(1, 13))

    for personal in (None, "all", "exclude", "only"):
        params = {"days": 7, "tz": "UTC"}
        if personal is not None:
            params["personal"] = personal
        stats = await _stats(authed_client, **params)
        assert stats["watch_events"] == 2, personal
        assert stats["total_runtime_minutes"] == 124, personal


async def test_a_narrowing_filter_never_turns_a_rewatch_into_a_first_watch(
    authed_client, db
):
    """The one that would be silent, and the reason `_ranked_events` documents
    what may go inside it.

    The ranking numbers each item's plays over the user's whole history. A
    filter that selected a *subset of one item's plays* would shift every
    surviving row down, so a second viewing would come back as rank 1 — a
    rewatch reported as a first watch, with a plausible number in every tile
    beside it. Every filter in `MediaFilters` selects whole items instead, so
    narrowing to the film's own genre must leave the split exactly as it was.
    """
    user = await _user(db)
    horror, comedy = await _add(
        db, _movie("Halloween", genres=["Horror"]), _movie("Airplane!", genres=["Comedy"])
    )
    await _log(db, user, horror, _utc_at(500, 12))  # years before the window
    await _log(db, user, horror, _utc_at(2, 12))  # inside it: a rewatch
    await _log(db, user, comedy, _utc_at(1, 12))  # inside it: a first watch

    unfiltered = (await _stats(authed_client, days=7, tz="UTC"))["rewatch"]
    assert (unfiltered["first_watches"], unfiltered["rewatches"]) == (1, 1)

    narrowed = (await _stats(authed_client, days=7, tz="UTC", genre="Horror"))["rewatch"]
    assert narrowed["plays"] == 1
    # Still a rewatch. Ranking the filtered set *within the window* would say
    # (1, 0) here, and nothing on the page would look wrong.
    assert (narrowed["first_watches"], narrowed["rewatches"]) == (0, 1)
    assert narrowed["rewatch_ratio"] == 1.0

    day = _utc_at(2, 12).date().isoformat()
    split = next(b for b in narrowed["by_bucket"] if b["label"] == day)
    assert (split["first"], split["rewatch"]) == (0, 1)


async def test_a_state_filter_leaves_the_rewatch_ranking_alone_too(authed_client, db):
    """`min_rating` reaches through a join, and the join is still per *item*:
    one state row per (user, item), so it cannot drop one play of a film and
    keep another."""
    user = await _user(db)
    (item,) = await _add(db, _movie("Groundhog Day"))
    await _rate(db, user, item, 9)
    await _log(db, user, item, _utc_at(400, 12))
    await _log(db, user, item, _utc_at(2, 12))

    rewatch = (await _stats(authed_client, days=7, tz="UTC", min_rating=8))["rewatch"]
    assert (rewatch["plays"], rewatch["first_watches"], rewatch["rewatches"]) == (1, 0, 1)
    assert [row["title"] for row in rewatch["most_rewatched"]] == ["Groundhog Day"]


async def test_the_most_rewatched_ranking_respects_the_filters(authed_client, db):
    user = await _user(db)
    horror, comedy = await _add(
        db, _movie("The Thing", genres=["Horror"]), _movie("Airplane!", genres=["Comedy"])
    )
    for days_ago in (30, 20, 10):
        await _log(db, user, horror, _utc_at(days_ago, 12))
        await _log(db, user, comedy, _utc_at(days_ago, 13))

    both = (await _stats(authed_client, days=7, tz="UTC"))["rewatch"]["most_rewatched"]
    assert sorted(row["title"] for row in both) == ["Airplane!", "The Thing"]

    only_horror = (await _stats(authed_client, days=7, tz="UTC", genre="Horror"))["rewatch"]
    assert [row["title"] for row in only_horror["most_rewatched"]] == ["The Thing"]
    assert only_horror["most_rewatched"][0]["plays"] == 3


async def test_filters_compose_and_apply_to_the_comparison_windows_as_well(
    authed_client, db
):
    user = await _user(db)
    horror, comedy = await _add(
        db,
        _movie("Suspiria", genres=["Horror"], runtime_minutes=98),
        _movie("Airplane!", genres=["Comedy"], runtime_minutes=88),
    )
    await _rate(db, user, horror, 9)
    await _log(db, user, horror, _utc_at(1, 12))
    await _log(db, user, comedy, _utc_at(1, 13))
    await _log(db, user, horror, _utc_at(10, 12))  # the preceding week
    await _log(db, user, comedy, _utc_at(10, 13))

    stats = await _stats(
        authed_client, days=7, tz="UTC", compare=True, genre="Horror", min_rating=8
    )
    assert stats["watch_events"] == 1
    assert stats["previous"]["totals"]["watch_events"] == 1
    assert stats["previous"]["totals"]["total_runtime_minutes"] == 98


async def test_an_unwatched_filter_is_degenerate_rather_than_broken(authed_client, db):
    """"Plays of things you have never played" is a contradiction, and on real
    data it returns nothing — every play updates the rollup this filter reads.

    Left working rather than rejected, and documented on the endpoint: a filter
    the Stats UI does not offer is not worth a 422 on a shared link. Note what
    it does *not* mean, though — `unwatched` reads `UserMediaState`, so a play
    whose rollup row is missing entirely still counts. That is the filter's own
    definition (`unwatched_condition` treats a missing row as never played) and
    not something stats may quietly redefine.
    """
    (logged,) = await _add(db, _movie("Solaris"))
    await authed_client.post(f"/api/history/{logged.id}/watched", params={"push_to_plex": False})
    assert (await _stats(authed_client, days=7, tz="UTC"))["watch_events"] == 1

    stats = await _stats(authed_client, days=7, tz="UTC", unwatched=True)
    assert stats["watch_events"] == 0
    assert stats["rewatch"]["plays"] == 0
    assert stats["rewatch"]["most_rewatched"] == []


async def test_a_filter_the_api_does_not_accept_is_a_422_not_a_wrong_answer(
    authed_client,
):
    rejected = await authed_client.get("/api/stats", params={"anime": "sometimes"})
    assert rejected.status_code == 422
    rejected = await authed_client.get("/api/stats", params={"min_rating": 99})
    assert rejected.status_code == 422


# --- seasonality ----------------------------------------------------------


async def test_seasonality_buckets_months_in_the_viewers_zone_across_all_history(
    authed_client, db
):
    user = await _user(db)
    (item,) = await _add(db, _movie("Winter Light", runtime_minutes=81))
    # New Year's Eve in UTC is already New Year's Day in Auckland.
    await _log(db, user, item, datetime(2024, 12, 31, 23, 30, tzinfo=UTC))

    in_utc = await _seasonality(authed_client, tz="UTC")
    assert in_utc["timezone"] == "UTC"
    assert in_utc["plays"] == 1
    assert in_utc["minutes"] == 81
    assert _slot(in_utc["months"], 12) == {
        "index": 12,
        "label": "December",
        "plays": 1,
        "minutes": 81,
    }
    assert [year["year"] for year in in_utc["years"]] == [2024]
    assert in_utc["years"][0]["months"] == [0] * 11 + [1]

    ahead = await _seasonality(authed_client, tz=AUCKLAND)
    assert _slot(ahead["months"], 1)["plays"] == 1
    assert _slot(ahead["months"], 12)["plays"] == 0
    assert [year["year"] for year in ahead["years"]] == [2025]
    assert ahead["years"][0]["months"] == [1] + [0] * 11


async def test_seasonality_ignores_the_stats_window_entirely(authed_client, db):
    """It is the one number here with no window — that is why it has its own path."""
    user = await _user(db)
    (item,) = await _add(db, _movie("Fanny and Alexander"))
    await _log(db, user, item, _utc_at(900, 12))
    await _log(db, user, item, _utc_at(2, 12))

    assert (await _stats(authed_client, days=7, tz="UTC"))["watch_events"] == 1
    profile = await _seasonality(authed_client, tz="UTC")
    assert profile["plays"] == 2
    assert sum(bucket["plays"] for bucket in profile["months"]) == 2
    assert profile["first_play"].startswith(_utc_at(900, 12).date().isoformat())
    assert profile["last_play"].startswith(_utc_at(2, 12).date().isoformat())


async def test_seasonality_fills_the_years_that_hold_nothing(authed_client, db):
    user = await _user(db)
    (item,) = await _add(db, _movie("Barry Lyndon"))
    await _log(db, user, item, datetime(2021, 3, 4, 12, tzinfo=UTC))
    await _log(db, user, item, datetime(2024, 7, 9, 12, tzinfo=UTC))

    profile = await _seasonality(authed_client, tz="UTC")
    assert [year["year"] for year in profile["years"]] == [2021, 2022, 2023, 2024]
    assert [year["plays"] for year in profile["years"]] == [1, 0, 0, 1]
    assert profile["years"][0]["months"][2] == 1  # March
    assert profile["years"][3]["months"][6] == 1  # July
    assert all(len(year["months"]) == 12 for year in profile["years"])


async def test_seasonality_is_empty_but_shaped_for_a_user_with_no_history(authed_client):
    profile = await _seasonality(authed_client, tz="UTC")
    assert profile["plays"] == 0
    assert profile["minutes"] == 0
    assert profile["first_play"] is None
    assert profile["last_play"] is None
    assert profile["years"] == []
    assert [bucket["label"] for bucket in profile["months"]][:2] == ["January", "February"]
    assert [bucket["plays"] for bucket in profile["months"]] == [0] * 12


async def test_seasonality_is_per_user_and_honours_anime_only(authed_client, db):
    mine = await _user(db)
    theirs = await _second_user(db)
    anime, western = await _add(
        db, _movie("Akira", is_anime=True, runtime_minutes=124), _movie("Heat")
    )
    await _log(db, mine, anime, datetime(2023, 5, 1, 12, tzinfo=UTC))
    await _log(db, mine, western, datetime(2023, 5, 2, 12, tzinfo=UTC))
    await _log(db, theirs, western, datetime(2023, 5, 3, 12, tzinfo=UTC))

    assert (await _seasonality(authed_client, tz="UTC"))["plays"] == 2
    anime_only = await _seasonality(authed_client, tz="UTC", anime_only=True)
    assert anime_only["plays"] == 1
    assert anime_only["minutes"] == 124


async def test_seasonality_falls_back_to_utc_for_an_unusable_zone(authed_client):
    assert (await _seasonality(authed_client, tz="Mars/Base"))["timezone"] == "UTC"


async def test_seasonality_takes_the_same_browse_filters(authed_client, db):
    """Both endpoints draw the same page, so a chip must mean one thing on it."""
    user = await _user(db)
    (crime_show,) = await _add(
        db,
        MediaItem(
            guid_key=f"test:{uuid4()}",
            media_type=MediaType.SHOW,
            title="The Wire",
            genres=["Crime"],
        ),
    )
    episode, comedy, home_video = await _add(
        db,
        _episode(crime_show, 1),
        _movie("Airplane!", genres=["Comedy"], runtime_minutes=88),
        _movie("IMG_4821", runtime_minutes=2, is_personal_media=True),
    )
    await _rate(db, user, comedy, 9)
    await _log(db, user, episode, datetime(2023, 5, 1, 12, tzinfo=UTC))
    await _log(db, user, comedy, datetime(2023, 5, 2, 12, tzinfo=UTC))
    await _log(db, user, home_video, datetime(2023, 5, 3, 12, tzinfo=UTC))

    # Episodes and home videos both counted, like the windowed endpoint.
    assert (await _seasonality(authed_client, tz="UTC"))["plays"] == 3

    # The episode answers with its show's genre — `facet_source` again.
    crime = await _seasonality(authed_client, tz="UTC", genre="Crime")
    assert crime["plays"] == 1
    assert _slot(crime["months"], 5)["minutes"] == 24  # the episode default

    rated = await _seasonality(authed_client, tz="UTC", min_rating=8)
    assert rated["plays"] == 1
    assert rated["minutes"] == 88
