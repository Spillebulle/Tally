"""Anime classification.

There is no single authoritative "is this anime?" flag across Plex, TMDB and
TVDB, so Tally combines signals and scores them. The scoring is deliberately
conservative: a Western cartoon (Animation genre, English, US) must not be
misfiled as anime just because it is animated.

Signals, strongest first:

============================  ======  ==================================
Signal                        Score   Notes
============================  ======  ==================================
Library override              force   User said so in Settings
HAMA / AniDB / MAL guid       force   Only anime libraries use these
Library named "Anime"         force   The common self-hoster convention
Explicit "Anime" genre tag     6      TVDB and some Plex agents emit it
Animation + Japanese origin    5      The reliable TMDB combination
Anime-ish keyword (TMDB)       3      "anime", "shounen", "based on manga"
Japanese language + animated    3      Weaker form of the origin signal
Confident MAL title match       2      Corroborating, never decisive alone
============================  ======  ==================================

A total of 5 or more marks the item as anime.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from ..guids import ExternalIds
from .base import MetadataResult

log = logging.getLogger(__name__)

THRESHOLD = 5

_ANIME_GENRE_TOKENS = {"anime", "animé"}
_ANIMATION_TOKENS = {"animation", "animated", "anime"}
_JAPAN_COUNTRIES = {"jp", "japan"}
_ANIME_KEYWORDS = {
    "anime",
    "based on manga",
    "based on anime",
    "based on light novel",
    "shounen",
    "shonen",
    "shoujo",
    "seinen",
    "josei",
    "isekai",
    "mecha",
    "japanese animation",
}
_LIBRARY_NAME_RE = re.compile(r"\b(anime|アニメ)\b", re.IGNORECASE)


@dataclass(slots=True)
class AnimeVerdict:
    is_anime: bool
    source: str | None
    score: int

    @property
    def confident(self) -> bool:
        return self.score >= THRESHOLD


def library_looks_like_anime(library_title: str | None) -> bool:
    return bool(library_title and _LIBRARY_NAME_RE.search(library_title))


def classify(
    *,
    genres: list[str] | None = None,
    ids: ExternalIds | None = None,
    metadata: MetadataResult | None = None,
    library_title: str | None = None,
    library_override: bool | None = None,
    mal_matched: bool = False,
) -> AnimeVerdict:
    if library_override is not None:
        return AnimeVerdict(library_override, "library_override", 100 if library_override else 0)

    if ids and ids.anime_hinted:
        return AnimeVerdict(True, "plex_agent", 100)

    if library_looks_like_anime(library_title):
        return AnimeVerdict(True, "library_name", 100)

    all_genres = {g.strip().lower() for g in (genres or []) if g}
    if metadata:
        all_genres |= {g.strip().lower() for g in metadata.genres if g}

    score = 0
    reasons: list[str] = []

    if all_genres & _ANIME_GENRE_TOKENS:
        score += 6
        reasons.append("genre")

    is_animated = bool(all_genres & _ANIMATION_TOKENS)
    countries = {c.strip().lower() for c in (metadata.origin_countries if metadata else [])}
    language = (metadata.original_language if metadata else "") or ""
    is_japanese_origin = bool(countries & _JAPAN_COUNTRIES)
    is_japanese_language = language.lower() in ("ja", "jpn", "japanese")

    if is_animated and is_japanese_origin:
        score += 5
        reasons.append("animation+jp")
    elif is_animated and is_japanese_language:
        score += 3
        reasons.append("animation+ja-lang")

    if metadata and metadata.keywords:
        keywords = {k.strip().lower() for k in metadata.keywords}
        if keywords & _ANIME_KEYWORDS:
            score += 3
            reasons.append("keyword")

    if mal_matched:
        score += 2
        reasons.append("mal")

    return AnimeVerdict(score >= THRESHOLD, "+".join(reasons) or None, score)


def should_try_mal(
    *,
    genres: list[str] | None,
    ids: ExternalIds | None,
    metadata: MetadataResult | None,
    library_title: str | None,
    library_override: bool | None,
) -> bool:
    """Cheap pre-filter so we don't hit MAL for every Western title.

    Only worth a lookup when something already suggests anime: an anime library,
    an anime-specific agent, or an animated title with a Japanese connection.
    """
    if library_override is True or library_looks_like_anime(library_title):
        return True
    if ids and ids.anime_hinted:
        return True

    verdict = classify(
        genres=genres,
        ids=ids,
        metadata=metadata,
        library_title=library_title,
        library_override=library_override,
    )
    if verdict.is_anime:
        return True
    # Borderline: animated, but the origin signal is missing. MAL breaks the tie.
    all_genres = {g.strip().lower() for g in (genres or []) if g}
    if metadata:
        all_genres |= {g.strip().lower() for g in metadata.genres if g}
    return bool(all_genres & _ANIMATION_TOKENS) and verdict.score >= 3
