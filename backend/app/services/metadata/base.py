"""Shared plumbing for external metadata providers."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

log = logging.getLogger(__name__)


@dataclass(slots=True)
class MetadataResult:
    """Provider-agnostic view of what an external database knows about a title."""

    title: str | None = None
    original_title: str | None = None
    overview: str | None = None
    tagline: str | None = None
    year: int | None = None
    first_aired: str | None = None
    poster_url: str | None = None
    backdrop_url: str | None = None
    runtime_minutes: int | None = None
    genres: list[str] = field(default_factory=list)
    studio: str | None = None
    network: str | None = None
    content_rating: str | None = None
    community_rating: float | None = None
    release_status: str | None = None
    tmdb_id: int | None = None
    tvdb_id: int | None = None
    imdb_id: str | None = None
    mal_id: int | None = None
    anilist_id: int | None = None
    origin_countries: list[str] = field(default_factory=list)
    original_language: str | None = None
    keywords: list[str] = field(default_factory=list)
    anime_format: str | None = None
    source: str | None = None

    def merge(self, other: MetadataResult) -> MetadataResult:
        """Overlay ``other`` onto self, keeping values already present."""
        for slot in self.__slots__:
            current = getattr(self, slot)
            incoming = getattr(other, slot)
            if isinstance(current, list):
                merged = list(dict.fromkeys([*current, *incoming]))
                setattr(self, slot, merged)
            elif current in (None, "") and incoming not in (None, ""):
                setattr(self, slot, incoming)
        return self


@dataclass(slots=True)
class CreditPerson:
    """One credited person, as a provider describes them."""

    provider_id: int
    name: str
    profile_url: str | None = None
    # Who they played. Always None for a director.
    character: str | None = None
    # Billing order: lower is more prominent.
    ordering: int = 0


@dataclass(slots=True)
class CreditsResult:
    cast: list[CreditPerson] = field(default_factory=list)
    directors: list[CreditPerson] = field(default_factory=list)


class RateLimiter:
    """Simple token-bucket so we stay inside provider rate limits.

    Jikan in particular will 429 aggressively; a shared limiter per provider is
    cheaper than retry storms.
    """

    def __init__(self, rate: float, per_seconds: float = 1.0) -> None:
        self._min_interval = per_seconds / rate if rate > 0 else 0.0
        self._last = 0.0
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        if self._min_interval <= 0:
            return
        async with self._lock:
            now = time.monotonic()
            wait = self._min_interval - (now - self._last)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last = time.monotonic()


# Distinguishes "cached, and the answer was nothing" from "not cached". A plain
# None could not: the read guard treated it as a miss, so every 404 was
# re-requested for the life of the process — exactly what the negative cache
# was written to prevent, and the weekly artwork retry sweeps thousands of
# titles the providers genuinely do not have.
_MISS = object()

# After this many consecutive transport failures, stop calling the provider for
# a while. Without it a provider outage during a large scan costs 3 attempts x
# 20s timeout plus backoff *per item*, and the sync simply never finishes.
_BREAKER_THRESHOLD = 5
_BREAKER_COOLDOWN = 300.0


def _retry_after_seconds(raw: str | None, default: float = 2.0) -> float:
    """Parse Retry-After, which the RFC allows to be an HTTP date.

    `float(raw)` raised ValueError on the date form — which CDNs in front of
    Jikan do send — and the exception escaped `_get`, losing that provider's
    whole contribution for the item.
    """
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return default
    if when is None:
        return default
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, (when - datetime.now(UTC)).total_seconds())


class ProviderClient:
    """Base class handling retries, rate limiting and a small response cache."""

    name = "provider"

    def __init__(self, *, rate: float = 5.0, timeout: float = 20.0) -> None:
        self._limiter = RateLimiter(rate)
        self._timeout = timeout
        self._cache: dict[str, tuple[float, Any]] = {}
        self._cache_ttl = 60 * 60 * 6
        self._consecutive_failures = 0
        self._breaker_until = 0.0

    @property
    def enabled(self) -> bool:
        return True

    @property
    def paused(self) -> bool:
        """Whether the circuit breaker is currently refusing calls.

        `_get` already fails fast while it is open, but a *bulk* caller needs to
        know the difference between "the provider answered nothing" and "we did
        not ask", because it may be about to record the former. The credits
        backfill stops on this rather than stamping a hundred titles as having
        no cast during an outage.
        """
        return time.monotonic() < self._breaker_until

    def _cache_get(self, key: str) -> Any:
        hit = self._cache.get(key)
        if not hit:
            return _MISS
        expires, value = hit
        if expires < time.time():
            self._cache.pop(key, None)
            return _MISS
        return value

    def _cache_put(self, key: str, value: Any) -> None:
        # Bounded so a long library scan can't grow this without limit.
        if len(self._cache) > 4000:
            self._cache.clear()
        self._cache[key] = (time.time() + self._cache_ttl, value)

    async def _get(
        self,
        url: str,
        *,
        params: dict | None = None,
        headers: dict | None = None,
        attempts: int = 3,
    ) -> Any | None:
        cache_key = f"{url}?{sorted((params or {}).items())}"
        if (cached := self._cache_get(cache_key)) is not _MISS:
            return cached

        if time.monotonic() < self._breaker_until:
            # Provider is in cooldown after repeated transport failures. Fail
            # fast rather than spending the full retry budget again per item.
            return None

        # One client for all attempts. Building it inside the loop gave every
        # retry its own connection, and so its own DNS lookup, turning a
        # provider outage into three lookups per item across a whole library
        # scan.
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            for attempt in range(attempts):
                await self._limiter.acquire()
                try:
                    resp = await client.get(url, params=params, headers=headers)
                except (httpx.TransportError, httpx.TimeoutException) as exc:
                    log.debug("%s request failed (%s): %s", self.name, url, exc)
                    if attempt == attempts - 1:
                        # Don't sleep after the final attempt — nothing follows
                        # it, so that backoff was pure delay. Across a large
                        # scan with a dead provider it added hours.
                        break
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue

                self._note_success()

                if resp.status_code == 429:
                    retry_after = _retry_after_seconds(resp.headers.get("Retry-After"))
                    if attempt == attempts - 1:
                        break
                    await asyncio.sleep(min(retry_after, 10))
                    continue
                if resp.status_code == 404:
                    self._cache_put(cache_key, None)
                    return None
                if resp.status_code >= 400:
                    log.debug(
                        "%s returned %s for %s", self.name, resp.status_code, url
                    )
                    return None

                try:
                    data = resp.json()
                except ValueError:
                    return None
                self._cache_put(cache_key, data)
                return data

        self._note_failure()
        return None

    def _note_success(self) -> None:
        self._consecutive_failures = 0
        self._breaker_until = 0.0

    def _note_failure(self) -> None:
        self._consecutive_failures += 1
        if self._consecutive_failures >= _BREAKER_THRESHOLD:
            self._breaker_until = time.monotonic() + _BREAKER_COOLDOWN
            log.warning(
                "%s failed %s times in a row; pausing calls to it for %.0fs",
                self.name,
                self._consecutive_failures,
                _BREAKER_COOLDOWN,
            )
            self._consecutive_failures = 0
