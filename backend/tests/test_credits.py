"""Cast, crew, and the facets they make clickable.

The expensive mistake this guards against is a credits call per item during a
library scan, or — the subtler version — a credits call on every render of a
detail page. Both are covered here by counting provider calls rather than by
checking the payload.
"""
from sqlalchemy import select

from app.models import (
    CreditKind,
    MediaCredit,
    MediaItem,
    MediaType,
    Person,
)
from app.services.metadata.base import CreditPerson, CreditsResult
from app.services.metadata.tmdb import TMDBClient

# No module-level asyncio mark: `asyncio_mode = auto` covers the async tests,
# and marking the synchronous parsing ones only produces warnings.


class StubTMDB:
    """Stands in for the real client, counting what it is asked."""

    enabled = True

    def __init__(self, result: CreditsResult | None) -> None:
        self.result = result
        self.calls: list[tuple[int, bool]] = []

    async def credits(self, tmdb_id: int, *, is_show: bool) -> CreditsResult | None:
        self.calls.append((tmdb_id, is_show))
        return self.result


class StubService:
    def __init__(self, tmdb: StubTMDB) -> None:
        self.tmdb = tmdb


def use_stub(monkeypatch, result: CreditsResult | None) -> StubTMDB:
    tmdb = StubTMDB(result)
    monkeypatch.setattr(
        "app.services.credits.get_metadata_service", lambda: StubService(tmdb)
    )
    return tmdb


CREDITS = CreditsResult(
    cast=[
        CreditPerson(
            provider_id=11,
            name="Sigourney Weaver",
            profile_url="https://image.tmdb.org/t/p/w185/ripley.jpg",
            character="Ellen Ripley",
            ordering=0,
        ),
        CreditPerson(provider_id=12, name="Tom Skerritt", character="Dallas", ordering=1),
    ],
    directors=[CreditPerson(provider_id=99, name="Ridley Scott")],
)


async def _movie(db, **overrides) -> MediaItem:
    item = MediaItem(
        guid_key=overrides.pop("guid_key", "tmdb:movie:348"),
        media_type=MediaType.MOVIE,
        title=overrides.pop("title", "Alien"),
        year=1979,
        tmdb_id=overrides.pop("tmdb_id", 348),
        **overrides,
    )
    db.add(item)
    await db.commit()
    return item


async def test_credits_are_fetched_once_and_then_served_from_the_database(
    authed_client, db, monkeypatch
):
    tmdb = use_stub(monkeypatch, CREDITS)
    item = await _movie(db)

    first = await authed_client.get(f"/api/media/{item.id}/credits")
    assert first.status_code == 200, first.text
    payload = first.json()
    assert [person["name"] for person in payload["cast"]] == [
        "Sigourney Weaver",
        "Tom Skerritt",
    ]
    assert payload["cast"][0]["character"] == "Ellen Ripley"
    assert payload["cast"][0]["profile_url"] == (
        "https://image.tmdb.org/t/p/w185/ripley.jpg"
    )
    assert [person["name"] for person in payload["directors"]] == ["Ridley Scott"]

    # The second view is the one that matters: a detail page is reloaded far
    # more often than a library is scanned.
    second = await authed_client.get(f"/api/media/{item.id}/credits")
    assert second.json() == payload
    assert tmdb.calls == [(348, False)], "credits were fetched again on a second view"


async def test_an_empty_answer_is_remembered_rather_than_re_asked(
    authed_client, db, monkeypatch
):
    """"TMDB has nothing for this" and "nobody has ever asked" look identical.

    Both are an empty credit list, so without the stamp every render of every
    credit-less title would go back out to the provider.
    """
    tmdb = use_stub(monkeypatch, CreditsResult())
    item = await _movie(db)

    for _ in range(3):
        response = await authed_client.get(f"/api/media/{item.id}/credits")
        assert response.json() == {"cast": [], "directors": []}

    assert len(tmdb.calls) == 1, "an empty answer was not remembered"


async def test_a_transport_failure_is_not_remembered_as_an_answer(
    authed_client, db, monkeypatch
):
    class Exploding(StubTMDB):
        async def credits(self, tmdb_id: int, *, is_show: bool):
            self.calls.append((tmdb_id, is_show))
            raise RuntimeError("provider is down")

    tmdb = Exploding(None)
    monkeypatch.setattr(
        "app.services.credits.get_metadata_service", lambda: StubService(tmdb)
    )
    item = await _movie(db)

    assert (await authed_client.get(f"/api/media/{item.id}/credits")).json() == {
        "cast": [],
        "directors": [],
    }
    await authed_client.get(f"/api/media/{item.id}/credits")
    assert len(tmdb.calls) == 2, "a failed fetch was recorded as an answer"


async def test_episodes_are_never_asked_about(authed_client, db, monkeypatch):
    """Enrichment skips episodes, and credits have to skip them for the same
    reason: a 45,000-episode library would be 45,000 provider calls."""
    tmdb = use_stub(monkeypatch, CREDITS)
    show = MediaItem(
        guid_key="tmdb:show:1", media_type=MediaType.SHOW, title="Severance", tmdb_id=1
    )
    db.add(show)
    await db.commit()
    episode = MediaItem(
        guid_key="tmdb:show:1/s1e1",
        media_type=MediaType.EPISODE,
        title="Good News About Hell",
        show_id=show.id,
        tmdb_id=1,
    )
    db.add(episode)
    await db.commit()

    response = await authed_client.get(f"/api/media/{episode.id}/credits")
    assert response.json() == {"cast": [], "directors": []}
    assert tmdb.calls == []


async def test_a_refetch_replaces_rather_than_duplicates(db, monkeypatch):
    """The (item, person, kind) constraint means a re-fetch has to clear first."""
    from app.services.credits import credits_for

    item = await _movie(db)
    service = StubService(StubTMDB(CREDITS))

    await credits_for(db, item, metadata_service=service)
    item.credits_updated_at = None
    await db.commit()
    await credits_for(db, item, metadata_service=service)

    rows = (
        await db.execute(
            select(MediaCredit).where(MediaCredit.media_item_id == item.id)
        )
    ).scalars().all()
    assert len(rows) == 3
    people = (await db.execute(select(Person))).scalars().all()
    assert len(people) == 3


# --- the browse facets -----------------------------------------------------


async def _library(db) -> dict[str, MediaItem]:
    alien = MediaItem(
        guid_key="tmdb:movie:348",
        media_type=MediaType.MOVIE,
        title="Alien",
        year=1979,
        content_rating="R",
        studio="20th Century Fox",
    )
    blade = MediaItem(
        guid_key="tmdb:movie:78",
        media_type=MediaType.MOVIE,
        title="Blade Runner",
        year=1982,
        content_rating="R",
        studio="Warner Bros.",
    )
    arrival = MediaItem(
        guid_key="tmdb:movie:329865",
        media_type=MediaType.MOVIE,
        title="Arrival",
        year=2016,
        content_rating="PG-13",
        studio="Paramount",
    )
    db.add_all([alien, blade, arrival])
    await db.commit()

    scott = Person(tmdb_id=578, name="Ridley Scott")
    villeneuve = Person(tmdb_id=137427, name="Denis Villeneuve")
    db.add_all([scott, villeneuve])
    await db.commit()
    db.add_all(
        [
            MediaCredit(
                media_item_id=alien.id, person_id=scott.id, kind=CreditKind.DIRECTOR
            ),
            MediaCredit(
                media_item_id=blade.id, person_id=scott.id, kind=CreditKind.DIRECTOR
            ),
            MediaCredit(
                media_item_id=arrival.id,
                person_id=villeneuve.id,
                kind=CreditKind.DIRECTOR,
            ),
            # A cast credit for the same person must not answer a director
            # filter, or "directed by" would mean "was anywhere near".
            MediaCredit(
                media_item_id=arrival.id, person_id=scott.id, kind=CreditKind.CAST
            ),
        ]
    )
    await db.commit()
    return {"alien": alien, "blade": blade, "arrival": arrival}


async def test_the_director_facet_narrows_the_grid(authed_client, db):
    await _library(db)

    directed = await authed_client.get(
        "/api/media", params={"director": "Ridley Scott"}
    )
    titles = [item["title"] for item in directed.json()["items"]]
    assert sorted(titles) == ["Alien", "Blade Runner"]
    assert directed.json()["total"] == 2

    assert (
        await authed_client.get("/api/media", params={"director": "Nobody At All"})
    ).json()["total"] == 0


async def test_the_content_rating_and_studio_facets_narrow_the_grid(authed_client, db):
    await _library(db)

    rated = await authed_client.get("/api/media", params={"content_rating": "R"})
    assert sorted(item["title"] for item in rated.json()["items"]) == [
        "Alien",
        "Blade Runner",
    ]

    studio = await authed_client.get("/api/media", params={"studio": "Paramount"})
    assert [item["title"] for item in studio.json()["items"]] == ["Arrival"]

    # Both at once, because the filter bar can hold both at once.
    together = await authed_client.get(
        "/api/media", params={"content_rating": "R", "studio": "Paramount"}
    )
    assert together.json()["total"] == 0


async def test_the_watchlist_offers_the_same_facets(authed_client, db):
    """The grid and the watchlist share one filter surface; a facet added to one
    router and not the other is how the two pages silently disagree."""
    items = await _library(db)
    from app.models import WatchlistEntry

    db.add_all(
        [
            WatchlistEntry(user_id=1, media_item_id=items["alien"].id),
            WatchlistEntry(user_id=1, media_item_id=items["arrival"].id),
        ]
    )
    await db.commit()

    listed = await authed_client.get(
        "/api/watchlist", params={"director": "Ridley Scott"}
    )
    assert [entry["item"]["title"] for entry in listed.json()["entries"]] == ["Alien"]


async def test_content_ratings_lists_what_is_actually_there(authed_client, db):
    await _library(db)
    ratings = await authed_client.get("/api/media/content-ratings")
    assert ratings.json() == ["PG-13", "R"]


# --- the TMDB payload shapes ----------------------------------------------


def _client() -> TMDBClient:
    client = TMDBClient()
    client.api_key = "test-key"
    return client


def test_a_film_credits_payload_is_read():
    parsed = _client()._cast(
        [
            {"id": 2, "name": "Tom Skerritt", "character": "Dallas", "order": 1},
            {
                "id": 1,
                "name": "Sigourney Weaver",
                "character": "Ripley",
                "order": 0,
                "profile_path": "/a.jpg",
            },
        ]
    )
    assert [person.name for person in parsed] == ["Sigourney Weaver", "Tom Skerritt"]
    assert parsed[0].profile_url == "https://image.tmdb.org/t/p/w185/a.jpg"


def test_one_actor_playing_two_parts_stays_one_credit():
    """`media_credits` holds one row per (item, person, kind), so two rows for
    the same person would collide — and dropping one would lose a part."""
    parsed = _client()._cast(
        [
            {"id": 1, "name": "Peter Sellers", "character": "Group Capt. Mandrake", "order": 0},
            {"id": 1, "name": "Peter Sellers", "character": "Dr. Strangelove", "order": 1},
        ]
    )
    assert len(parsed) == 1
    assert parsed[0].character == "Group Capt. Mandrake / Dr. Strangelove"


def test_the_series_credits_shape_is_read_too():
    """`aggregate_credits` nests the character and job in lists, so the film
    parser reading `character`/`job` came back with nothing at all for shows."""
    client = _client()
    cast = client._cast(
        [
            {
                "id": 7,
                "name": "Adam Scott",
                "roles": [{"character": "Mark Scout", "episode_count": 19}],
                "order": 0,
            }
        ]
    )
    assert cast[0].character == "Mark Scout"

    directors = client._directors(
        [
            {
                "id": 8,
                "name": "Ben Stiller",
                "jobs": [{"job": "Director", "episode_count": 15}],
            },
            {
                "id": 9,
                "name": "Aoife McArdle",
                "jobs": [{"job": "Director", "episode_count": 3}],
            },
            {"id": 10, "name": "Someone Else", "jobs": [{"job": "Producer"}]},
        ]
    )
    # Ranked by how much of the run they directed, and a producer is not one.
    assert [person.name for person in directors] == ["Ben Stiller", "Aoife McArdle"]
    assert [person.ordering for person in directors] == [0, 1]


def test_only_the_director_job_counts_on_a_film():
    directors = _client()._directors(
        [
            {"id": 1, "name": "Ridley Scott", "job": "Director"},
            {"id": 2, "name": "Dan O'Bannon", "job": "Screenplay"},
        ]
    )
    assert [person.name for person in directors] == ["Ridley Scott"]
