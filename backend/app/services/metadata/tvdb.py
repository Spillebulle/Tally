"""TheTVDB v4 provider — used to fill gaps TMDB leaves on TV series.

TVDB carries an explicit ``genre: Anime`` tag that TMDB lacks, so it also feeds
the anime classifier.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from ...config import get_settings
from .base import MetadataResult, ProviderClient

log = logging.getLogger(__name__)
settings = get_settings()

API = "https://api4.thetvdb.com/v4"


class TVDBClient(ProviderClient):
    name = "tvdb"

    def __init__(self) -> None:
        super().__init__(rate=8.0)
        self.api_key = settings.tvdb_api_key
        self._token: str | None = None
        self._token_expires = 0.0

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    async def _auth_token(self) -> str | None:
        """TVDB v4 issues a bearer token valid for ~30 days; cache it in memory."""
        if self._token and time.time() < self._token_expires:
            return self._token
        if not self.enabled:
            return None
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(f"{API}/login", json={"apikey": self.api_key})
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            log.warning("TVDB login failed: %s", exc)
            return None
        if resp.status_code >= 400:
            log.warning("TVDB login rejected: %s", resp.status_code)
            return None
        self._token = (resp.json().get("data") or {}).get("token")
        self._token_expires = time.time() + 60 * 60 * 24 * 20
        return self._token

    async def _call(self, path: str, params: dict | None = None) -> Any | None:
        token = await self._auth_token()
        if not token:
            return None
        data = await self._get(
            f"{API}{path}", params=params, headers={"Authorization": f"Bearer {token}"}
        )
        return (data or {}).get("data")

    async def series_extended(self, tvdb_id: int) -> MetadataResult | None:
        data = await self._call(f"/series/{tvdb_id}/extended", {"meta": "translations"})
        if not data:
            return None
        return self._to_result(data, is_show=True)

    async def movie_extended(self, tvdb_id: int) -> MetadataResult | None:
        data = await self._call(f"/movies/{tvdb_id}/extended")
        if not data:
            return None
        return self._to_result(data, is_show=False)

    async def search(
        self, title: str, *, year: int | None = None, is_show: bool = True
    ) -> dict[str, Any] | None:
        params: dict[str, Any] = {"query": title, "type": "series" if is_show else "movie"}
        if year:
            params["year"] = year
        results = await self._call("/search", params)
        return results[0] if results else None

    def _to_result(self, data: dict[str, Any], *, is_show: bool) -> MetadataResult:
        remote = {r.get("sourceName", "").lower(): r.get("id") for r in data.get("remoteIds") or []}
        genres = [g.get("name") for g in data.get("genres") or [] if g.get("name")]
        companies = data.get("companies") or []
        network = None
        if isinstance(companies, dict):
            networks = companies.get("network") or []
            network = networks[0].get("name") if networks else None
        elif companies:
            network = companies[0].get("name")

        first_aired = data.get("firstAired") or data.get("first_release_date")
        year = None
        if data.get("year"):
            try:
                year = int(data["year"])
            except (TypeError, ValueError):
                year = None
        elif first_aired and first_aired[:4].isdigit():
            year = int(first_aired[:4])

        imdb = remote.get("imdb")
        tmdb = remote.get("themoviedb") or remote.get("tmdb")

        return MetadataResult(
            title=data.get("name"),
            overview=(data.get("overview") or None),
            year=year,
            first_aired=first_aired or None,
            poster_url=data.get("image") or None,
            runtime_minutes=data.get("averageRuntime") or data.get("runtime"),
            genres=genres,
            network=network,
            release_status=(data.get("status") or {}).get("name", "").lower() or None,
            tvdb_id=data.get("id"),
            imdb_id=imdb if isinstance(imdb, str) and imdb.startswith("tt") else None,
            tmdb_id=int(tmdb) if str(tmdb or "").isdigit() else None,
            original_language=data.get("originalLanguage"),
            origin_countries=[data["originalCountry"]] if data.get("originalCountry") else [],
            source="tvdb",
        )

    async def resolve(
        self,
        *,
        title: str,
        year: int | None,
        is_show: bool,
        tvdb_id: int | None = None,
    ) -> MetadataResult | None:
        if not self.enabled:
            return None
        if tvdb_id:
            result = (
                await self.series_extended(tvdb_id)
                if is_show
                else await self.movie_extended(tvdb_id)
            )
            if result:
                return result
        if title:
            found = await self.search(title, year=year, is_show=is_show)
            if found and found.get("tvdb_id"):
                try:
                    found_id = int(found["tvdb_id"])
                except (TypeError, ValueError):
                    return None
                return (
                    await self.series_extended(found_id)
                    if is_show
                    else await self.movie_extended(found_id)
                )
        return None
