"""The external API: `/api/stats/series` and `/metrics`.

Both exist to be read by something that is not the Tally UI — Grafana, a
Prometheus scrape, a spreadsheet — which changes what "correct" means. Nobody
reading a dashboard can tell a wrong answer from a right one, so the assertions
here are mostly about the shapes that fail *silently*:

* a timestamp with no offset on it, which Grafana re-guesses as the browser's
  zone and draws a day late;
* a series zero-filled into a cross-product, or not zero-filled where a line
  chart needed it;
* a CSV field holding a comma;
* a cross-user read that quietly answers with your own numbers instead of
  refusing.

The timezone tests use Europe/Oslo across the March transition, because a
bucketing bug is invisible except at a day boundary and doubly invisible
except at a boundary that moves.
"""
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.models import (
    ApiKeyScope,
    MediaItem,
    MediaType,
    SyncRun,
    SyncStatus,
    User,
    UserMediaState,
    WatchEvent,
    WatchlistEntry,
    WatchSource,
)
from app.routers import metrics as metrics_module
from app.routers.series import MAX_BUCKETS

pytestmark = pytest.mark.asyncio

OSLO = "Europe/Oslo"  # +01:00 in winter, +02:00 in summer; changes 29 March 2026


@pytest.fixture(autouse=True)
def _cold_metrics_cache():
    """The snapshot cache is module-level, so it would outlive a test database."""
    metrics_module.reset_cache()
    yield
    metrics_module.reset_cache()


# --- helpers --------------------------------------------------------------


async def _user(db, username: str = "tester") -> User:
    return (
        await db.execute(select(User).where(User.username == username))
    ).scalar_one()


def _movie(title: str, **kwargs) -> MediaItem:
    return MediaItem(
        guid_key=f"test:{uuid4()}", media_type=MediaType.MOVIE, title=title, **kwargs
    )


def _show(title: str, **kwargs) -> MediaItem:
    return MediaItem(
        guid_key=f"test:{uuid4()}", media_type=MediaType.SHOW, title=title, **kwargs
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


async def _log(db, user, item, when, **kwargs) -> WatchEvent:
    event = WatchEvent(
        user_id=user.id,
        media_item_id=item.id,
        watched_at=when,
        source=kwargs.pop("source", WatchSource.MANUAL),
        dedupe_key=f"test:{uuid4()}",
        completed=True,
        **kwargs,
    )
    db.add(event)
    await db.commit()
    return event


async def _series(client, **params):
    response = await client.get("/api/stats/series", params=params)
    assert response.status_code == 200, response.text
    return response.json()


# --- shape ----------------------------------------------------------------


async def test_the_payload_is_a_bare_array_with_three_fixed_columns(authed_client, db):
    """No envelope, and the same column names whatever is asked for.

    Infinity's default settings parse a root-level array; an envelope means a
    root selector every user has to configure, and a wrong one is an empty
    graph rather than an error. The names are fixed so one panel query serves
    every metric.
    """
    user = await _user(db)
    (film,) = await _add(db, _movie("Heat", runtime_minutes=170))
    await _log(db, user, film, datetime(2026, 5, 4, 20, 0, tzinfo=UTC))

    rows = await _series(
        authed_client, **{"from": "2026-05-01T00:00:00", "to": "2026-05-08T00:00:00"}
    )
    assert isinstance(rows, list)
    assert all(set(row) == {"ts", "series", "value"} for row in rows)
    # With no group-by the series column carries the metric's own name, so the
    # shape does not change between grouped and ungrouped answers.
    assert {row["series"] for row in rows} == {"plays"}


@pytest.mark.parametrize(
    ("metric", "expected"),
    [
        ("plays", 3),
        ("minutes", 170 + 24 + 24),
        ("distinct_titles", 2),  # the film, and the show its episodes belong to
        ("distinct_shows", 1),
    ],
)
async def test_every_event_metric_answers_over_the_same_window(
    authed_client, db, metric, expected
):
    user = await _user(db)
    film, show = await _add(db, _movie("Heat", runtime_minutes=170), _show("The Wire"))
    one, two = await _add(db, _episode(show, 1), _episode(show, 2))
    for item in (film, one, two):
        await _log(db, user, item, datetime(2026, 5, 4, 20, 0, tzinfo=UTC))

    rows = await _series(
        authed_client,
        metric=metric,
        **{"from": "2026-05-04T00:00:00Z", "to": "2026-05-05T00:00:00Z"},
    )
    assert [row["value"] for row in rows] == [expected]


async def test_ratings_are_timestamped_by_when_they_were_recorded(authed_client, db):
    """The rating metrics read `user_media_states`, not `watch_events`."""
    user = await _user(db)
    film, other = await _add(db, _movie("Heat"), _movie("Sicario"))
    db.add_all(
        [
            UserMediaState(
                user_id=user.id,
                media_item_id=film.id,
                rating=8.0,
                rating_updated_at=datetime(2026, 5, 4, 12, 0, tzinfo=UTC),
            ),
            UserMediaState(
                user_id=user.id,
                media_item_id=other.id,
                rating=6.0,
                rating_updated_at=datetime(2026, 5, 4, 13, 0, tzinfo=UTC),
            ),
        ]
    )
    await db.commit()

    window = {"from": "2026-05-04T00:00:00Z", "to": "2026-05-05T00:00:00Z"}
    assert [row["value"] for row in await _series(
        authed_client, metric="ratings_given", **window
    )] == [2]
    assert [row["value"] for row in await _series(
        authed_client, metric="avg_rating", **window
    )] == [7.0]


async def test_a_rating_cannot_be_grouped_by_a_property_of_a_play(authed_client):
    """422 rather than an empty graph: a rating has no device and no source."""
    for group_by in ("device", "source"):
        response = await authed_client.get(
            "/api/stats/series", params={"metric": "avg_rating", "group_by": group_by}
        )
        assert response.status_code == 422, group_by
        assert "property of a play" in response.json()["detail"]


@pytest.mark.parametrize(
    ("interval", "expected"),
    [("hour", 24), ("day", 1), ("week", 1), ("month", 1)],
)
async def test_each_interval_buckets_the_same_day_its_own_way(
    authed_client, db, interval, expected
):
    user = await _user(db)
    (film,) = await _add(db, _movie("Heat"))
    await _log(db, user, film, datetime(2026, 5, 4, 20, 0, tzinfo=UTC))

    rows = await _series(
        authed_client,
        interval=interval,
        tz="UTC",
        **{"from": "2026-05-04T00:00:00Z", "to": "2026-05-05T00:00:00Z"},
    )
    assert len(rows) == expected
    assert sum(row["value"] for row in rows) == 1


async def test_the_timestamp_carries_its_offset(authed_client, db):
    """A naive `ts` is re-guessed by Grafana and drawn in the wrong day."""
    user = await _user(db)
    (film,) = await _add(db, _movie("Heat"))
    await _log(db, user, film, datetime(2026, 5, 4, 20, 0, tzinfo=UTC))

    window = {"from": "2026-05-04T00:00:00", "to": "2026-05-05T00:00:00"}
    rows = await _series(authed_client, tz=OSLO, **window)
    assert rows[0]["ts"] == "2026-05-04T00:00:00+02:00"

    # The payload has no envelope to report the resolved zone in, and an
    # unloadable name falls back to UTC silently — so the header says which zone
    # actually answered.
    named = await authed_client.get(
        "/api/stats/series", params={"tz": OSLO, **window}
    )
    assert named.headers["X-Tally-Timezone"] == OSLO
    nonsense = await authed_client.get(
        "/api/stats/series", params={"tz": "Mars/Olympus_Mons", **window}
    )
    assert nonsense.headers["X-Tally-Timezone"] == "UTC"
    assert nonsense.json()[0]["ts"] == "2026-05-04T00:00:00+00:00"


# --- summer time ----------------------------------------------------------


async def test_day_buckets_change_offset_across_the_spring_transition(
    authed_client, db
):
    """29 March 2026 is when Oslo moves +01:00 → +02:00.

    The days either side of it are still local midnights, so the *offset* has
    to move with them. Bucketing with a fixed `+01:00` in SQL would label 30
    March as starting at 23:00 on the 29th, and every number after it would sit
    one bucket early for six months.
    """
    user = await _user(db)
    (film,) = await _add(db, _movie("Heat"))
    for day in (28, 29, 30):
        await _log(db, user, film, datetime(2026, 3, day, 12, 0, tzinfo=UTC))

    rows = await _series(
        authed_client,
        tz=OSLO,
        **{"from": "2026-03-28T00:00:00", "to": "2026-03-31T00:00:00"},
    )
    assert [row["ts"] for row in rows] == [
        "2026-03-28T00:00:00+01:00",
        "2026-03-29T00:00:00+01:00",
        "2026-03-30T00:00:00+02:00",
    ]
    assert [row["value"] for row in rows] == [1, 1, 1]


async def test_the_day_the_clocks_go_forward_is_twenty_three_hours_long(
    authed_client, db
):
    """02:00 local does not exist on 29 March, so no bucket may claim it."""
    user = await _user(db)
    (film,) = await _add(db, _movie("Heat"))
    # 01:30 UTC is 03:30 local — the first hour after the jump.
    await _log(db, user, film, datetime(2026, 3, 29, 1, 30, tzinfo=UTC))

    rows = await _series(
        authed_client,
        interval="hour",
        tz=OSLO,
        **{"from": "2026-03-29T00:00:00", "to": "2026-03-30T00:00:00"},
    )
    assert len(rows) == 23
    hours = [row["ts"][11:16] for row in rows]
    assert "02:00" not in hours
    assert hours[:3] == ["00:00", "01:00", "03:00"]

    played = [row for row in rows if row["value"]]
    assert len(played) == 1
    assert played[0]["ts"] == "2026-03-29T03:00:00+02:00"


# --- the cap --------------------------------------------------------------


async def test_an_unreasonable_bucket_count_is_refused_with_its_numbers(authed_client):
    response = await authed_client.get(
        "/api/stats/series", params={"interval": "hour", "days": 3650}
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert str(MAX_BUCKETS) in detail
    assert "hour" in detail

    # The same span at a coarser interval is fine — the cap is on the answer's
    # size, not on how far back somebody may look.
    assert (
        await authed_client.get(
            "/api/stats/series", params={"interval": "month", "days": 3650}
        )
    ).status_code == 200


# --- zero-fill ------------------------------------------------------------


async def test_an_ungrouped_series_fills_its_empty_buckets(authed_client, db):
    user = await _user(db)
    (film,) = await _add(db, _movie("Heat"))
    await _log(db, user, film, datetime(2026, 5, 4, 20, 0, tzinfo=UTC))

    rows = await _series(
        authed_client,
        tz="UTC",
        **{"from": "2026-05-01T00:00:00Z", "to": "2026-05-08T00:00:00Z"},
    )
    assert len(rows) == 7
    assert [row["value"] for row in rows] == [0, 0, 0, 1, 0, 0, 0]


async def test_a_grouped_series_emits_only_the_buckets_it_observed(authed_client, db):
    """Filling every series x bucket is a cross-product nobody asked for."""
    user = await _user(db)
    film, show = await _add(db, _movie("Heat"), _show("The Wire"))
    (one,) = await _add(db, _episode(show, 1))
    await _log(db, user, film, datetime(2026, 5, 4, 20, 0, tzinfo=UTC))
    await _log(db, user, one, datetime(2026, 5, 6, 20, 0, tzinfo=UTC))

    rows = await _series(
        authed_client,
        group_by="media_type",
        tz="UTC",
        **{"from": "2026-05-01T00:00:00Z", "to": "2026-05-08T00:00:00Z"},
    )
    # Two observed buckets, not 7 days x 2 types.
    assert rows == [
        {"ts": "2026-05-04T00:00:00+00:00", "series": "movie", "value": 1},
        {"ts": "2026-05-06T00:00:00+00:00", "series": "episode", "value": 1},
    ]


async def test_an_average_fills_with_null_rather_than_zero(authed_client, db):
    """0 is a rating somebody could have given; "nobody rated" is not a 0."""
    user = await _user(db)
    (film,) = await _add(db, _movie("Heat"))
    db.add(
        UserMediaState(
            user_id=user.id,
            media_item_id=film.id,
            rating=9.0,
            rating_updated_at=datetime(2026, 5, 4, 12, 0, tzinfo=UTC),
        )
    )
    await db.commit()

    rows = await _series(
        authed_client,
        metric="avg_rating",
        tz="UTC",
        **{"from": "2026-05-03T00:00:00Z", "to": "2026-05-06T00:00:00Z"},
    )
    assert [row["value"] for row in rows] == [None, 9.0, None]


async def test_a_genre_group_resolves_an_episode_through_its_show(authed_client, db):
    """Enrichment skips episodes, so the genre only ever lives on the series."""
    user = await _user(db)
    (show,) = await _add(db, _show("The Wire", genres=["Crime", "Drama"]))
    (one,) = await _add(db, _episode(show, 1))
    await _log(db, user, one, datetime(2026, 5, 4, 20, 0, tzinfo=UTC))

    rows = await _series(
        authed_client,
        group_by="genre",
        tz="UTC",
        **{"from": "2026-05-04T00:00:00Z", "to": "2026-05-05T00:00:00Z"},
    )
    # One play, counted once under each of its genres — so genres do not sum to
    # the play total, exactly as `top_genres` on the stats page does not.
    assert sorted(row["series"] for row in rows) == ["Crime", "Drama"]
    assert [row["value"] for row in rows] == [1, 1]


# --- CSV ------------------------------------------------------------------


async def test_csv_has_a_header_the_right_type_and_rfc_4180_quoting(authed_client, db):
    user = await _user(db)
    (film,) = await _add(db, _movie("Heat"))
    await _log(
        db,
        user,
        film,
        datetime(2026, 5, 4, 20, 0, tzinfo=UTC),
        device='Living Room, "TV"',
    )

    response = await authed_client.get(
        "/api/stats/series",
        params={
            "format": "csv",
            "group_by": "device",
            "tz": "UTC",
            "from": "2026-05-04T00:00:00Z",
            "to": "2026-05-05T00:00:00Z",
        },
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")

    body = response.text
    assert body.startswith("ts,series,value\r\n")
    # The comma forces quoting, and the embedded quotes are doubled — anything
    # else and one device name shifts every column after it.
    assert '"Living Room, ""TV"""' in body

    import csv
    import io

    rows = list(csv.reader(io.StringIO(body)))
    assert rows[0] == ["ts", "series", "value"]
    assert rows[1] == ["2026-05-04T00:00:00+00:00", 'Living Room, "TV"', "1"]


async def test_csv_writes_an_empty_field_for_a_null_average(authed_client):
    response = await authed_client.get(
        "/api/stats/series",
        params={
            "format": "csv",
            "metric": "avg_rating",
            "tz": "UTC",
            "from": "2026-05-04T00:00:00Z",
            "to": "2026-05-05T00:00:00Z",
        },
    )
    assert response.status_code == 200
    assert response.text.splitlines()[1] == "2026-05-04T00:00:00+00:00,avg_rating,"


# --- household ------------------------------------------------------------


async def test_a_non_admin_is_refused_both_ways_into_someone_elses_data(
    authed_client, bare_client, db
):
    """403, never a silent fallback to your own numbers.

    A panel answering plausibly with the wrong person's viewing is worse than a
    panel that says it is not allowed, because nobody checks the one that draws.
    """
    registered = await bare_client.post(
        "/api/auth/register", json={"username": "housemate", "password": "password123"}
    )
    assert registered.status_code == 201, registered.text
    assert registered.json()["is_admin"] is False

    admin = await _user(db)
    for params in ({"user_id": admin.id}, {"group_by": "user"}):
        response = await bare_client.get("/api/stats/series", params=params)
        assert response.status_code == 403, params
        assert "administrator" in response.json()["detail"].lower()

    # Their own data is still theirs.
    assert (await bare_client.get("/api/stats/series")).status_code == 200


async def test_an_admin_reads_across_the_household_only_when_asked(
    authed_client, bare_client, db
):
    assert (
        await bare_client.post(
            "/api/auth/register",
            json={"username": "housemate", "password": "password123"},
        )
    ).status_code == 201

    admin = await _user(db)
    housemate = await _user(db, "housemate")
    (film,) = await _add(db, _movie("Heat"))
    await _log(db, admin, film, datetime(2026, 5, 4, 20, 0, tzinfo=UTC))
    for _ in range(3):
        await _log(db, housemate, film, datetime(2026, 5, 4, 21, 0, tzinfo=UTC))

    window = {"from": "2026-05-04T00:00:00Z", "to": "2026-05-05T00:00:00Z", "tz": "UTC"}

    # The default is own data even for an administrator, so a cross-user read is
    # always deliberate.
    assert [row["value"] for row in await _series(authed_client, **window)] == [1]

    grouped = await _series(authed_client, group_by="user", **window)
    assert {row["series"]: row["value"] for row in grouped} == {
        "tester": 1,
        "housemate": 3,
    }

    targeted = await _series(authed_client, user_id=housemate.id, **window)
    assert [row["value"] for row in targeted] == [3]


async def test_a_household_series_is_labelled_by_name_and_never_by_email(
    authed_client, db
):
    user = await _user(db)
    user.email = "someone@example.com"
    user.display_name = "The Operator"
    await db.commit()

    rows = await _series(authed_client, group_by="user", days=7)
    assert rows == [] or all("@" not in row["series"] for row in rows)

    (film,) = await _add(db, _movie("Heat"))
    await _log(db, user, film, datetime.now(UTC) - timedelta(hours=1))
    rows = await _series(authed_client, group_by="user", days=7)
    assert [row["series"] for row in rows] == ["The Operator"]


async def test_a_state_filter_cannot_be_smeared_across_the_household(authed_client):
    """It would be applied to one account and reported against everyone's."""
    response = await authed_client.get(
        "/api/stats/series", params={"group_by": "user", "min_rating": 8}
    )
    assert response.status_code == 422
    assert "group_by=user" in response.json()["detail"]


# --- scopes ---------------------------------------------------------------


async def test_a_stats_key_reaches_the_external_endpoints_and_nothing_else(
    authed_client, bare_client
):
    created = await authed_client.post(
        "/api/keys", json={"name": "grafana", "scope": ApiKeyScope.STATS.value}
    )
    assert created.status_code == 201, created.text
    headers = {"X-API-Key": created.json()["key"]}

    assert (await bare_client.get("/metrics", headers=headers)).status_code == 200
    assert (
        await bare_client.get("/api/stats/series", headers=headers)
    ).status_code == 200

    # The library is still off-limits: the scope allowlist, not the method.
    assert (await bare_client.get("/api/media", headers=headers)).status_code == 403


async def test_the_external_endpoints_need_a_credential_at_all(bare_client):
    for path in ("/metrics", "/api/stats/series"):
        assert (await bare_client.get(path)).status_code == 401, path


# --- /metrics -------------------------------------------------------------


def _parse_exposition(body: str) -> tuple[dict[str, str], list[str]]:
    """Types by metric name, and the sample lines, checked as we go.

    The contiguity check is the one worth having: a loop that emits two metrics
    per turn interleaves their families, which reads fine to a human and is a
    duplicate declaration to a parser. That is exactly the shape this endpoint
    had before the families were pulled apart.
    """
    assert body.endswith("\n"), "the text format requires a trailing newline"
    types: dict[str, str] = {}
    samples: list[str] = []
    seen: list[str] = []
    for line in body.splitlines():
        assert line, "a blank line is not part of the format"
        if line.startswith("# TYPE "):
            _, _, name, kind = line.split(" ", 3)
            assert name not in types, f"{name} declared twice"
            types[name] = kind
        elif line.startswith("# HELP "):
            continue
        else:
            name = line.split("{")[0].split(" ")[0]
            assert name in types, f"{name} has a sample before its TYPE"
            if not seen or seen[-1] != name:
                assert name not in seen, f"{name} reopened after another metric"
                seen.append(name)
            # Every sample ends in a number.
            float(line.rsplit(" ", 1)[1])
            samples.append(line)
    return types, samples


async def test_metrics_parses_and_declares_everything_a_gauge(authed_client, db):
    """A counter that can go down makes `rate()` over-report; these can."""
    user = await _user(db)
    film, show = await _add(db, _movie("Heat", runtime_minutes=170), _show("The Wire"))
    await _log(db, user, film, datetime.now(UTC) - timedelta(hours=2))
    db.add_all(
        [
            WatchlistEntry(user_id=user.id, media_item_id=show.id, active=True),
            SyncRun(user_id=user.id, kind="full", status=SyncStatus.RUNNING),
        ]
    )
    await db.commit()

    response = await authed_client.get("/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/plain; version=0.0.4; charset=utf-8"

    types, samples = _parse_exposition(response.text)
    assert set(types.values()) == {"gauge"}

    expected = {
        "tally_build_info",
        "tally_library_items",
        "tally_watch_events_total",
        "tally_watch_events_by_type_total",
        "tally_watch_minutes_total",
        "tally_watchlist_items",
        "tally_current_streak_days",
        "tally_longest_streak_days",
        "tally_sync_running",
    }
    assert expected <= set(types)

    body = "\n".join(samples)
    assert 'tally_library_items{media_type="movie"} 1' in body
    assert 'tally_watch_events_total{user="tester"} 1' in body
    assert 'tally_watch_minutes_total{user="tester",media_type="movie"} 170' in body
    assert 'tally_watchlist_items{user="tester"} 1' in body
    assert 'tally_sync_running{user="tester"} 1' in body
    assert 'tally_current_streak_days{user="tester"} 1' in body

    # Never labelled by title — one series per film is a cardinality accident
    # that only shows up on somebody else's Prometheus.
    assert "Heat" not in response.text


async def test_metrics_never_names_a_user_by_email(authed_client, db):
    user = await _user(db)
    user.email = "operator@example.com"
    user.display_name = None
    await db.commit()

    body = (await authed_client.get("/metrics")).text
    assert "operator@example.com" not in body
    assert 'user="tester"' in body


async def test_a_label_value_is_escaped(authed_client, db):
    user = await _user(db)
    user.display_name = 'Back\\slash "quoted"\nnewline'
    await db.commit()

    body = (await authed_client.get("/metrics")).text
    assert 'user="Back\\\\slash \\"quoted\\"\\nnewline"' in body
    # And the rendered document still parses — an unescaped newline would have
    # split one sample into two unreadable lines.
    _parse_exposition(body)


async def test_a_non_admin_sees_only_their_own_series(authed_client, bare_client, db):
    assert (
        await bare_client.post(
            "/api/auth/register",
            json={"username": "housemate", "password": "password123"},
        )
    ).status_code == 201

    admin_body = (await authed_client.get("/metrics")).text
    assert 'user="tester"' in admin_body
    assert 'user="housemate"' in admin_body

    metrics_module.reset_cache()
    own_body = (await bare_client.get("/metrics")).text
    assert 'user="housemate"' in own_body
    assert 'user="tester"' not in own_body
    # The global library counters are still there — they are nobody's history.
    assert "tally_library_items" in own_body


async def test_the_snapshot_is_cached_rather_than_recomputed_per_scrape(
    authed_client, db
):
    """A 15-second scrape interval must not aggregate the history every time."""
    user = await _user(db)
    (film,) = await _add(db, _movie("Heat"))
    await _log(db, user, film, datetime.now(UTC) - timedelta(hours=2))

    first = await authed_client.get("/metrics")
    assert first.status_code == 200
    assert metrics_module.computations() == 1

    # A second play lands, and the cached scrape does not see it yet — which is
    # the point: freshness is traded for a bounded cost, within one interval.
    await _log(db, user, film, datetime.now(UTC) - timedelta(hours=1))
    second = await authed_client.get("/metrics")
    assert metrics_module.computations() == 1
    assert second.text == first.text

    # Expiring the cache is enough to pick it up; nothing else is stateful.
    metrics_module._cache = (
        metrics_module._cache[0] - metrics_module.CACHE_SECONDS - 1,
        metrics_module._cache[1],
    )
    third = await authed_client.get("/metrics")
    assert metrics_module.computations() == 2
    assert 'tally_watch_events_total{user="tester"} 2' in third.text
