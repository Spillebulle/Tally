"""The external metadata providers.

None of `tmdb.py`, `tvdb.py`, `mal.py` or `base.py` had any coverage at all,
even though `respx` has been a pinned dev dependency the whole time. These
cover the shared plumbing in `base.py` — the parts whose failure modes are
silent — plus the MAL title match that decides whether something is anime.
"""
import httpx
import respx

from app.services.metadata.base import ProviderClient
from app.services.metadata.mal import _titles_match
from app.services.metadata.tmdb import TMDBClient
from app.services.metadata.tvdb import TVDBClient
from app.services.titles import title_agrees

# No module-level asyncio mark: `asyncio_mode = auto` already handles the async
# tests, and marking the synchronous ones only produces warnings.


class Provider(ProviderClient):
    name = "test-provider"


@respx.mock
async def test_a_404_is_cached_and_not_re_requested():
    """Regression: the negative cache never hit.

    A 404 was stored as `None`, but the read guard was `is not None` — so a
    cached miss was indistinguishable from no entry and every 404 was
    re-requested for the life of the process. The weekly artwork retry sweeps
    thousands of titles the providers genuinely do not have.
    """
    route = respx.get("https://example.test/thing").mock(
        return_value=httpx.Response(404)
    )
    provider = Provider()

    assert await provider._get("https://example.test/thing") is None
    assert await provider._get("https://example.test/thing") is None
    assert await provider._get("https://example.test/thing") is None

    assert route.call_count == 1, "a cached 404 was requested again"


@respx.mock
async def test_a_successful_response_is_cached_too():
    route = respx.get("https://example.test/ok").mock(
        return_value=httpx.Response(200, json={"hello": "world"})
    )
    provider = Provider()

    assert await provider._get("https://example.test/ok") == {"hello": "world"}
    assert await provider._get("https://example.test/ok") == {"hello": "world"}
    assert route.call_count == 1


@respx.mock
async def test_transport_failures_do_not_sleep_after_the_final_attempt(monkeypatch):
    """The last backoff had nothing to wait for — it was pure delay.

    Three attempts meant three sleeps, the third of which was followed only by
    falling out of the loop. Across a large scan against a dead provider that
    added hours on its own.
    """
    respx.get("https://example.test/dead").mock(side_effect=httpx.ConnectError("no dns"))

    slept: list[float] = []

    async def _record(seconds):
        slept.append(seconds)

    monkeypatch.setattr("app.services.metadata.base.asyncio.sleep", _record)

    provider = Provider()
    assert await provider._get("https://example.test/dead") is None

    # The rate limiter sleeps too, in fractions of a second; the retry backoff
    # starts at 1.5s. Only the latter is under test.
    backoffs = [seconds for seconds in slept if seconds >= 1.0]
    # Three attempts, but only the gaps *between* them are waited on.
    assert backoffs == [1.5, 3.0], f"unexpected backoff pattern: {backoffs}"


@respx.mock
async def test_repeated_failures_trip_a_breaker_and_stop_calling(monkeypatch):
    """A provider outage must not cost the full retry budget on every item.

    Unlike plex_server, this had no backoff at all: 3 attempts x 20s timeout,
    per item, for a whole library.
    """
    route = respx.get("https://example.test/down").mock(
        side_effect=httpx.ConnectError("no dns")
    )

    async def _no_sleep(_seconds):
        return None

    monkeypatch.setattr("app.services.metadata.base.asyncio.sleep", _no_sleep)

    provider = Provider()
    # Distinct URLs so the response cache cannot be what stops the requests.
    for n in range(5):
        await provider._get("https://example.test/down", params={"n": n})
    calls_before = route.call_count

    for n in range(5, 10):
        await provider._get("https://example.test/down", params={"n": n})

    assert route.call_count == calls_before, "the breaker did not stop the calls"


@respx.mock
async def test_a_date_form_retry_after_does_not_raise(monkeypatch):
    """`float(Retry-After)` raised on the HTTP-date form the RFC permits.

    The exception escaped `_get`, losing that provider's whole contribution for
    the item.
    """
    respx.get("https://example.test/limited").mock(
        return_value=httpx.Response(
            429, headers={"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}
        )
    )

    async def _no_sleep(_seconds):
        return None

    monkeypatch.setattr("app.services.metadata.base.asyncio.sleep", _no_sleep)

    provider = Provider()
    assert await provider._get("https://example.test/limited") is None


def test_a_mal_search_hit_with_an_unrelated_title_is_rejected():
    """MAL is worth +2 and the anime keyword +3, so together they hit the
    threshold of 5. Taking results[0] from a fuzzy search on faith let one junk
    hit decide that a Western cartoon was anime.
    """
    assert not _titles_match("Avatar The Last Airbender", ["Cowboy Bebop"])
    assert not _titles_match("RWBY", ["Rurouni Kenshin"])


def test_a_mal_search_hit_with_a_real_title_is_accepted():
    """The check has to stay forgiving: MAL titles are romanised, and carry
    subtitles and season suffixes that Plex does not.
    """
    assert _titles_match("Cowboy Bebop", ["Cowboy Bebop"])
    assert _titles_match("Attack on Titan Season 2", ["Attack on Titan"])
    assert _titles_match("Fullmetal Alchemist", ["Fullmetal Alchemist: Brotherhood"])
    assert _titles_match("Your Name.", ["Kimi no Na wa.", "Your Name"])


# --- the id-bearing providers, which get equality instead ------------------
#
# Every wrong tmdb id found on a live instance was a *prefix* match from a
# title search: a short title asked for, a longer better-known film handed
# back. The forgiveness that is right for MAL is exactly the bug here.


def test_a_longer_title_that_merely_starts_the_same_is_not_agreement():
    """The four real wrong matches this instance has stored, as a list.

    Each is `results[0]` from a TMDB search for the short name, and each was
    written onto a row that had no other identity — so the row then dropped out
    of `backfill_missing_metadata`, which only looks at rows with no id at all,
    and nothing ever reconsidered it.
    """
    assert not title_agrees("Anti-Social", ["Anti-Social Limited"])
    assert not title_agrees("Men", ["Men in Black"])
    assert not title_agrees("Society", ["Dead Poets Society"])
    assert not title_agrees("Thelma", ["Thelma & Louise"])


def test_the_same_title_spelled_differently_is_agreement():
    assert title_agrees("WALL·E", ["WALL-E"])
    assert title_agrees("Amelie", [None, "Amélie"])
    assert title_agrees("Spider-Man: Into the Spider-Verse", ["Spider Man Into the Spider Verse"])


def test_a_near_miss_is_refused_and_that_is_the_chosen_trade():
    """The cost of exact equality, written down so it is not a surprise.

    Release-name recovery produces five rows on the live instance. Four still
    heal — their filenames spell the film correctly — and one does not: item
    52633's file is named `Mars.Needs.Mom`, singular, while the film is *Mars
    Needs Moms*. Before the search gate that row was given tmdb 50321 and a
    poster (though never a merge, since the real row is not there). It now gets
    neither, and keeps a blank tile until somebody looks.

    That is deliberate. A single character is not a signal: it separates a typo
    from a sequel with nothing to tell them apart. Any rule loose enough to
    accept "Mars Needs Mom" against "Mars Needs Moms" also accepts "Alien"
    against "Aliens", and "The Jungle Book 2" against "The Jungle Book 3" —
    which is the same silent wrong-id error this gate exists to stop, on films
    the library actually holds. A missing poster is visible and recoverable; a
    wrong id is neither.

    Such a row also stays in `backfill_missing_metadata` forever, precisely
    because no id was attached — it retries weekly, indefinitely, and that
    unbounded retry is the intended shape. It costs one search a week and it is
    the only way the row can ever heal if TMDB gains the alternative title.
    """
    assert not title_agrees("Mars Needs Mom", ["Mars Needs Moms"])

    for recovered in (
        "The Jungle Book 2",
        "The Simpsons Movie",
        "Unfriended",
        "Sleeping Beauty",
    ):
        assert title_agrees(recovered, [recovered]), recovered

    # The near-misses that must stay refused for the same reason, on titles
    # that are genuinely different films rather than typos.
    assert not title_agrees("Alien", ["Aliens"])
    assert not title_agrees("The Jungle Book 2", ["The Jungle Book 3"])


def test_a_row_with_no_title_agrees_with_nothing():
    """No title is no evidence, and no evidence must not read as a match."""
    assert not title_agrees("", ["Anything"])
    assert not title_agrees(None, ["Anything"])
    assert not title_agrees("Anything", [None, ""])


def _tmdb() -> TMDBClient:
    client = TMDBClient()
    client.api_key = "test-key"
    return client


@respx.mock
async def test_tmdb_drops_a_year_that_filtered_the_right_film_out():
    """The live case: a 2019 play of "Anti-Social" (2015) matched to a
    documentary called "Anti-Social Limited".

    Plex snapshotted the play under the filename, so the year Tally had came
    from a release tag — 2014 — not from the film. TMDB's `year=` is a hard
    filter, so it removed the film actually wanted and left one that merely
    starts with the same two words, and `results[0]` took it. The retry without
    the year already existed but only fired on an *empty* page, which this
    never was.
    """
    limited = {"id": 981278, "title": "Anti-Social Limited", "original_title": "Anti-Social Limited"}
    real = {"id": 330206, "title": "Anti-Social", "original_title": "Anti-Social"}

    def _search(request):
        if request.url.params.get("year"):
            return httpx.Response(200, json={"results": [limited]})
        # Deliberately the more popular wrong hit first: the search has to look
        # past a disagreeing result, not stop at it.
        return httpx.Response(200, json={"results": [limited, real]})

    respx.get("https://api.themoviedb.org/3/search/movie").mock(side_effect=_search)
    wrong = respx.get("https://api.themoviedb.org/3/movie/981278").mock(
        return_value=httpx.Response(200, json={"id": 981278, "title": "Anti-Social Limited"})
    )
    respx.get("https://api.themoviedb.org/3/movie/330206").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": 330206,
                "title": "Anti-Social",
                "release_date": "2015-05-01",
                "runtime": 99,
            },
        )
    )

    result = await _tmdb().resolve(title="Anti-Social", year=2014, is_show=False)

    assert result is not None
    assert result.tmdb_id == 330206, "the wrong film's id was attached"
    assert wrong.call_count == 0, "the mismatched hit was fetched anyway"


@respx.mock
async def test_tmdb_returns_nothing_rather_than_a_wrong_id():
    """No id beats a wrong one. A row with none stays in the backfill queue and
    keeps its blank tile, which is visible; a row with the wrong one leaves the
    queue forever and also poisons its `merge_duplicates` group.
    """
    respx.get("https://api.themoviedb.org/3/search/movie").mock(
        return_value=httpx.Response(
            200,
            json={"results": [{"id": 607, "title": "Men in Black", "original_title": "Men in Black"}]},
        )
    )
    details = respx.get("https://api.themoviedb.org/3/movie/607").mock(
        return_value=httpx.Response(200, json={"id": 607, "title": "Men in Black"})
    )

    assert await _tmdb().resolve(title="Men", year=2022, is_show=False) is None
    assert details.call_count == 0


@respx.mock
async def test_tmdb_does_not_title_check_a_lookup_by_id():
    """Plex's own title is often not TMDB's — "Marvel's Daredevil" — and when
    the caller already has the id there is nothing being guessed at. Checking
    here would throw away good matches for no safety.
    """
    search = respx.get("https://api.themoviedb.org/3/search/tv").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    respx.get("https://api.themoviedb.org/3/tv/61889").mock(
        return_value=httpx.Response(
            200, json={"id": 61889, "name": "Daredevil", "first_air_date": "2015-04-10"}
        )
    )

    result = await _tmdb().resolve(
        title="Marvel's Daredevil", year=2015, is_show=True, tmdb_id=61889
    )

    assert result is not None and result.tmdb_id == 61889
    assert search.call_count == 0


@respx.mock
async def test_tvdb_refuses_a_search_hit_that_names_another_show():
    """`merge_duplicates` groups on `tvdb_id` too, so a wrong one here is just
    as able to invent a pair or block a real one.
    """
    respx.post("https://api4.thetvdb.com/v4/login").mock(
        return_value=httpx.Response(200, json={"data": {"token": "t"}})
    )
    respx.get("https://api4.thetvdb.com/v4/search").mock(
        return_value=httpx.Response(
            200, json={"data": [{"name": "Thelma & Louise", "tvdb_id": "1541"}]}
        )
    )
    extended = respx.get("https://api4.thetvdb.com/v4/movies/1541/extended").mock(
        return_value=httpx.Response(200, json={"data": {"id": 1541, "name": "Thelma & Louise"}})
    )

    client = TVDBClient()
    client.api_key = "test-key"
    assert await client.resolve(title="Thelma", year=2017, is_show=False) is None
    assert extended.call_count == 0


@respx.mock
async def test_tvdb_accepts_a_hit_that_matches_an_alias():
    """TVDB carries the regional names a series is released under, and Plex may
    well be using one of them.
    """
    respx.post("https://api4.thetvdb.com/v4/login").mock(
        return_value=httpx.Response(200, json={"data": {"token": "t"}})
    )
    respx.get("https://api4.thetvdb.com/v4/search").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    {
                        "name": "Kamisama Kiss",
                        "aliases": ["Kamisama Hajimemashita"],
                        "tvdb_id": "265334",
                    }
                ]
            },
        )
    )
    respx.get("https://api4.thetvdb.com/v4/series/265334/extended").mock(
        return_value=httpx.Response(
            200, json={"data": {"id": 265334, "name": "Kamisama Kiss", "year": "2012"}}
        )
    )

    client = TVDBClient()
    client.api_key = "test-key"
    result = await client.resolve(title="Kamisama Hajimemashita", year=2012, is_show=True)

    assert result is not None and result.tvdb_id == 265334
