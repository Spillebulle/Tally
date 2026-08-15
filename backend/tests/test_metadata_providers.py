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
