"""Metadata enrichment: combine TMDB, TVDB and MAL into one view of a title."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from ..guids import ExternalIds
from .anime import AnimeVerdict, classify, library_looks_like_anime, should_try_mal
from .base import MetadataResult
from .mal import MALClient
from .tmdb import TMDBClient
from .tvdb import TVDBClient

log = logging.getLogger(__name__)


@dataclass(slots=True)
class Enrichment:
    metadata: MetadataResult
    anime: AnimeVerdict


class MetadataService:
    """Facade over the individual providers.

    Provider order is TMDB -> TVDB -> MAL. TMDB has the best artwork coverage;
    TVDB fills TV-specific gaps and contributes its explicit Anime genre; MAL is
    consulted only for titles that already look like anime, both to save calls
    and because MAL has nothing to say about a Western film.
    """

    def __init__(self) -> None:
        self.tmdb = TMDBClient()
        self.tvdb = TVDBClient()
        self.mal = MALClient()

    @property
    def providers_configured(self) -> dict[str, bool]:
        return {
            "tmdb": self.tmdb.enabled,
            "tvdb": self.tvdb.enabled,
            "mal": self.mal.official,
            "jikan": not self.mal.official,
        }

    async def enrich(
        self,
        *,
        title: str,
        year: int | None,
        is_show: bool,
        ids: ExternalIds | None = None,
        plex_genres: list[str] | None = None,
        library_title: str | None = None,
        library_override: bool | None = None,
        known: MetadataResult | None = None,
    ) -> Enrichment:
        """Ask the providers about a title and score whether it is anime.

        ``known`` is what the caller already holds about this row — see
        `media_repo.stored_signals`. It is merged in *after* the providers, so
        it only ever fills blanks and never overwrites a fresh answer, and it is
        merged *before* the classifier runs. That ordering is the point: a
        re-classification made while TMDB is unconfigured, rate-limited or
        behind an open circuit breaker otherwise scores the item on nothing at
        all and writes that verdict over a good one. Passing what is already
        stored makes the pass unable to come back knowing *less* than it did.
        """
        ids = ids or ExternalIds()
        combined = MetadataResult()

        tmdb_result = None
        try:
            tmdb_result = await self.tmdb.resolve(
                title=title,
                year=year,
                is_show=is_show,
                tmdb_id=ids.tmdb_id,
                imdb_id=ids.imdb_id,
                tvdb_id=ids.tvdb_id,
            )
        except Exception as exc:
            log.debug("TMDB enrichment failed for %r: %s", title, exc)
        if tmdb_result:
            combined.merge(tmdb_result)

        # TVDB is worth a call when TMDB missed, or for shows where its genre
        # list adds the Anime tag TMDB never provides.
        needs_tvdb = self.tvdb.enabled and (
            tmdb_result is None or (is_show and not combined.tvdb_id)
        )
        if needs_tvdb:
            try:
                tvdb_result = await self.tvdb.resolve(
                    title=title,
                    year=year,
                    is_show=is_show,
                    tvdb_id=ids.tvdb_id or combined.tvdb_id,
                )
                if tvdb_result:
                    combined.merge(tvdb_result)
            except Exception as exc:
                log.debug("TVDB enrichment failed for %r: %s", title, exc)

        if known is not None:
            combined.merge(known)

        mal_matched = False
        if should_try_mal(
            genres=plex_genres,
            ids=ids,
            metadata=combined,
            library_title=library_title,
            library_override=library_override,
        ):
            mal_result = await self.mal.resolve(
                title=title, year=year, mal_id=ids.mal_id
            )
            if mal_result:
                mal_matched = True
                # MAL wins on synopsis quality for anime but its artwork is
                # lower-res than TMDB's, so merge (existing values survive).
                combined.merge(mal_result)

        verdict = classify(
            genres=plex_genres,
            ids=ids,
            metadata=combined,
            library_title=library_title,
            library_override=library_override,
            mal_matched=mal_matched,
        )

        # Carry ids discovered by any provider back onto the result.
        combined.tmdb_id = combined.tmdb_id or ids.tmdb_id
        combined.tvdb_id = combined.tvdb_id or ids.tvdb_id
        combined.imdb_id = combined.imdb_id or ids.imdb_id
        combined.mal_id = combined.mal_id or ids.mal_id
        combined.anilist_id = combined.anilist_id or ids.anilist_id

        return Enrichment(metadata=combined, anime=verdict)


_service: MetadataService | None = None


def get_metadata_service() -> MetadataService:
    global _service
    if _service is None:
        _service = MetadataService()
    return _service


__all__ = [
    "Enrichment",
    "MetadataResult",
    "MetadataService",
    "classify",
    "get_metadata_service",
    "library_looks_like_anime",
]
