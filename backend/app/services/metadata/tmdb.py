"""The Movie Database provider — the primary source of posters and descriptions."""
from __future__ import annotations

import logging
from typing import Any

from ...config import get_settings
from ..titles import title_agrees
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
        """The best hit that actually *names* what was asked for, or nothing.

        This used to be `results[0]`, and TMDB's search always returns
        something: ask it for a title it does not have and it hands back the
        most popular thing that shares a word. For an item that arrived with an
        external id that hardly mattered — `resolve` never gets here. For an
        item that arrived with nothing but a title, the answer *becomes* the
        row's identity, and a wrong one is permanent: `backfill_missing_metadata`
        only revisits rows with no id at all, so attaching the wrong one takes
        the row out of the only pass that would ever look again.

        See `test_metadata_providers.py` for the case this was written for.
        """
        kind = "tv" if is_show else "movie"
        params: dict[str, Any] = {"query": title, "include_adult": "false"}
        year_field = "first_air_date_year" if is_show else "year"
        if year:
            params[year_field] = year

        data = await self._call(f"/search/{kind}", params)
        match = self._agreeing_result(title, data, is_show=is_show)
        if match is None and year:
            # Plex years and TMDB release years disagree often enough (festival
            # vs wide release) that a yearless retry is worth one extra call.
            #
            # The retry now fires when the year-filtered page held nothing that
            # *names* the title, not merely when it was empty — which is a
            # different and much more common failure. A history snapshot's year
            # can come from a release-name tag rather than from the film, and a
            # `year=` TMDB does not agree with does not empty the page: it
            # filters the right film out and leaves a wrong one behind. That is
            # exactly how a 2019 play of "Anti-Social" (2015) was searched for
            # as year 2014 and matched to "Anti-Social Limited", an unrelated
            # Canadian documentary that happens to start with the same words.
            data = await self._call(
                f"/search/{kind}", {"query": title, "include_adult": "false"}
            )
            match = self._agreeing_result(title, data, is_show=is_show)
        return match

    def _agreeing_result(
        self, wanted: str, data: Any, *, is_show: bool
    ) -> dict[str, Any] | None:
        """First result whose own name matches the title we searched for.

        Scanning past a disagreeing hit rather than stopping at it is the point:
        TMDB orders by popularity, so the film actually asked for is often
        sitting behind a better-known one that merely shares a word.

        The comparison is exact once normalised (`services/titles.py`), against
        both the localised and the original name. A prefix deliberately does not
        count — every wrong id this instance has stored was a prefix match.
        """
        results = (data or {}).get("results") or []
        name = "name" if is_show else "title"
        original = "original_name" if is_show else "original_title"
        for result in results:
            if title_agrees(wanted, (result.get(name), result.get(original))):
                return result
        if results:
            # INFO, not debug: this is the only trace that a row was left
            # without an id and without artwork *on purpose*. `LOG_LEVEL`
            # defaults to INFO, so at debug nobody would ever see it and a
            # blank tile would have no explanation anywhere.
            log.info(
                "TMDB search for %r found nothing by that name (best was %r); "
                "refusing rather than attaching a wrong id",
                wanted,
                results[0].get(name),
            )
        return None

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
        """Best-effort lookup: known id first, then cross-reference, then search.

        Only the last of those three is title-checked, and only it needs to be.
        A known id and an id cross-reference are exact — the caller already knew
        which record it wanted, usually because Plex's agent said so — and Plex
        titles legitimately differ from TMDB's ("Marvel's Daredevil"), so
        checking there would throw away good matches for nothing. A search is
        the one path that *guesses*, so it is the one that has to be sure.
        """
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
