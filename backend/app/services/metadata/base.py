"""Shared plumbing for external metadata providers."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
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


class ProviderClient:
    """Base class handling retries, rate limiting and a small response cache."""

    name = "provider"

    def __init__(self, *, rate: float = 5.0, timeout: float = 20.0) -> None:
        self._limiter = RateLimiter(rate)
        self._timeout = timeout
        self._cache: dict[str, tuple[float, Any]] = {}
        self._cache_ttl = 60 * 60 * 6

    @property
    def enabled(self) -> bool:
        return True

    def _cache_get(self, key: str) -> Any | None:
        hit = self._cache.get(key)
        if not hit:
            return None
        expires, value = hit
        if expires < time.time():
            self._cache.pop(key, None)
            return None
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
        if (cached := self._cache_get(cache_key)) is not None:
            return cached

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
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue

                if resp.status_code == 429:
                    retry_after = float(resp.headers.get("Retry-After", 2))
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
        return None
