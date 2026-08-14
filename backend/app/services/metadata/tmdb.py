"""The Movie Database provider — the primary source of posters and descriptions."""
from __future__ import annotations

import logging
from typing import Any

from ...config import get_settings
from .base import MetadataResult, ProviderClient

log = logging.getLogger(__name__)
settings = get_settings()

API = "https://api.themoviedb.org/3"
IMG = "https://image.tmdb.org/t/p"


class TMDBClient(ProviderClient):
    name = "tmdb"

    def __init__(self) -> None:
        # TMDB's documented ceiling is ~50 req/s; 20 leaves headroom.
        super().__init__(rate=20.0)
        self.api_key = settings.tmdb_api_key

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _auth(self) -> tuple[dict, dict]:
        """TMDB accepts either a v3 key as a query param or a v4 bearer token."""
        if self.api_key.startswith("ey") and self.api_key.count(".") == 2:
            return {}, {"Authorization": f"Bearer {self.api_key}"}
        return {"api_key": self.api_key}, {}

    async def _call(self, path: str, params: dict | None = None) -> Any | None:
        if not self.enabled:
            return None
        auth_params, headers = self._auth()
        return await self._get(
            f"{API}{path}",
            params={**auth_params, **(params or {})},
            headers=headers or None,
        )

    @staticmethod
    def image(path: str | None, size: str = "w500") -> str | None:
        return f"{IMG}/{size}{path}" if path else None

    # -- lookups ----------------------------------------------------------

    async def find_by_external_id(
        self, external_id: str, source: str
    ) -> dict[str, Any] | None:
        """Resolve an IMDb or TVDB id to a TMDB record."""
        data = await self._call(
            f"/find/{external_id}", {"external_source": source}
        )
        if not data:
            return None
        for key, kind in (("movie_results", "movie"), ("tv_results", "tv")):
            if data.get(key):
                result = dict(data[key][0])
                result["_tmdb_type"] = kind
                return result
        return None

    async def search(
        self, title: str, *, year: int | None = None, is_show: bool = False
    ) -> dict[str, Any] | None:
        kind = "tv" if is_show else "movie"
        params: dict[str, Any] = {"query": title, "include_adult": "false"}
        if year:
            params["first_air_date_year" if is_show else "year"] = year

        data = await self._call(f"/search/{kind}", params)
        results = (data or {}).get("results") or []
        if not results and year:
            # Plex years and TMDB release years disagree often enough (festival
            # vs wide release) that a yearless retry is worth one extra call.
            data = await self._call(f"/search/{kind}", {"query": title})
            results = (data or {}).get("results") or []
        return results[0] if results else None

    async def details(self, tmdb_id: int, *, is_show: bool) -> MetadataResult | None:
        kind = "tv" if is_show else "movie"
        data = await self._call(
            f"/{kind}/{tmdb_id}",
            {"append_to_response": "external_ids,keywords,content_ratings,release_dates"},
        )
        if not data:
            return None
        return self._to_result(data, is_show=is_show)

    def _to_result(self, data: dict[str, Any], *, is_show: bool) -> MetadataResult:
        external = data.get("external_ids") or {}

        raw_keywords = data.get("keywords") or {}
        keyword_list = raw_keywords.get("results") or raw_keywords.get("keywords") or []
        keywords = [k.get("name", "").lower() for k in keyword_list if k.get("name")]

        date_str = data.get("first_air_date") if is_show else data.get("release_date")
        year = int(date_str[:4]) if date_str and len(date_str) >= 4 and date_str[:4].isdigit() else None

        runtime = data.get("runtime")
        if is_show:
            episode_runtimes = data.get("episode_run_time") or []
            runtime = episode_runtimes[0] if episode_runtimes else None

        networks = data.get("networks") or []
        companies = data.get("production_companies") or []

        return MetadataResult(
            title=data.get("name") if is_show else data.get("title"),
            original_title=data.get("original_name") if is_show else data.get("original_title"),
            overview=data.get("overview") or None,
            tagline=data.get("tagline") or None,
            year=year,
            first_aired=date_str or None,
            poster_url=self.image(data.get("poster_path"), "w500"),
            backdrop_url=self.image(data.get("backdrop_path"), "w1280"),
            runtime_minutes=runtime,
            genres=[g["name"] for g in data.get("genres") or [] if g.get("name")],
            studio=companies[0]["name"] if companies else None,
            network=networks[0]["name"] if networks else None,
            community_rating=data.get("vote_average") or None,
            release_status=(data.get("status") or "").lower() or None,
            tmdb_id=data.get("id"),
            tvdb_id=external.get("tvdb_id"),
            imdb_id=external.get("imdb_id"),
            origin_countries=data.get("origin_country") or [],
            original_language=data.get("original_language"),
            keywords=keywords,
            source="tmdb",
        )

    async def resolve(
        self,
        *,
        title: str,
        year: int | None,
        is_show: bool,
        tmdb_id: int | None = None,
        imdb_id: str | None = None,
        tvdb_id: int | None = None,
    ) -> MetadataResult | None:
        """Best-effort lookup: known id first, then cross-reference, then search."""
        if not self.enabled:
            return None

        if tmdb_id:
            if result := await self.details(tmdb_id, is_show=is_show):
                return result

        for external_id, source in ((imdb_id, "imdb_id"), (tvdb_id, "tvdb_id")):
            if not external_id:
                continue
            found = await self.find_by_external_id(str(external_id), source)
            if found:
                return await self.details(found["id"], is_show=found["_tmdb_type"] == "tv")

        if title:
            found = await self.search(title, year=year, is_show=is_show)
            if found:
                return await self.details(found["id"], is_show=is_show)
        return None
