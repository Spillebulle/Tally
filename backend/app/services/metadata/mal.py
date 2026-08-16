"""MyAnimeList provider.

Two backends, picked automatically:

* **Official MAL API v2** when ``MAL_CLIENT_ID`` is configured — higher limits and
  richer fields.
* **Jikan**, the unauthenticated MAL mirror, otherwise — so anime enrichment works
  with zero configuration.

Jikan's published limit is 3 req/s and 60 req/min; the limiter here is set well
below that because library scans issue long bursts.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from ...config import get_settings
from .base import MetadataResult, ProviderClient

log = logging.getLogger(__name__)
settings = get_settings()

MAL_API = "https://api.myanimelist.net/v2"

_MAL_FIELDS = (
    "id,title,alternative_titles,main_picture,start_date,end_date,synopsis,mean,"
    "status,genres,num_episodes,media_type,studios,rating,source"
)

# Season/part suffixes Plex keeps but MAL usually does not.
_NOISE = re.compile(
    r"\b(season\s*\d+|part\s*\d+|s\d{1,2}|\(\d{4}\)|final season|cour\s*\d+)\b",
    re.IGNORECASE,
)


def _clean_title(title: str) -> str:
    return re.sub(r"\s{2,}", " ", _NOISE.sub("", title or "")).strip(" -:·")


def _match_key(title: str) -> str:
    """Lowercase alphanumerics only, so punctuation and spacing stop mattering."""
    return re.sub(r"[^a-z0-9]+", "", _clean_title(title).lower())


def _titles_match(wanted: str, candidate_titles: list[str | None]) -> bool:
    """Whether a search hit is plausibly the thing we asked for.

    A MAL match is worth +2 in the anime classifier, and the anime keyword
    signal is worth +3 — so an unchecked hit alone reached the threshold of 5
    and could make a Western cartoon "anime". The search is a fuzzy one that
    always returns *something*, so taking results[0] on faith made the module
    docstring's "corroborating, never decisive alone" untrue.

    Deliberately forgiving: MAL titles are romanised and frequently carry a
    subtitle Plex does not, so one being a prefix of the other counts.

    That is the opposite of the rule TMDB and TVDB get (`services/titles.py`),
    and the difference is what the answer is used for. A MAL hit contributes a
    score to the anime classifier and a synopsis; the id it carries feeds no
    dedup pass. A TMDB or TVDB hit becomes the row's identity, and a prefix
    match is precisely how "Anti-Social" became "Anti-Social Limited" there. If
    `mal_id` ever starts merging rows, this has to become equality too.
    """
    key = _match_key(wanted)
    if not key:
        return False
    for candidate in candidate_titles:
        other = _match_key(candidate or "")
        if not other:
            continue
        if key == other or key.startswith(other) or other.startswith(key):
            return True
    return False


def _candidate_titles(entry: dict[str, Any]) -> list[str | None]:
    """Every name a search hit might be known by, across both backends."""
    alternatives = entry.get("alternative_titles") or {}
    synonyms = alternatives.get("synonyms") or []
    # Jikan v4 also carries a `titles` array of {type, title} pairs.
    titles = [
        entry_title.get("title")
        for entry_title in (entry.get("titles") or [])
        if isinstance(entry_title, dict)
    ]
    return [
        entry.get("title"),
        entry.get("title_english"),
        entry.get("title_japanese"),
        alternatives.get("en"),
        alternatives.get("ja"),
        *synonyms,
        *titles,
    ]


class MALClient(ProviderClient):
    name = "mal"

    def __init__(self) -> None:
        super().__init__(rate=1.0)
        self.client_id = settings.mal_client_id
        self.jikan = settings.jikan_base_url.rstrip("/")

    @property
    def enabled(self) -> bool:
        # Jikan needs no credentials, so this provider is always available.
        return True

    @property
    def official(self) -> bool:
        return bool(self.client_id)

    # -- official MAL v2 --------------------------------------------------

    async def _mal_search(self, title: str) -> dict[str, Any] | None:
        data = await self._get(
            f"{MAL_API}/anime",
            params={"q": title[:64], "limit": 5, "fields": "id,title"},
            headers={"X-MAL-CLIENT-ID": self.client_id},
        )
        nodes = [entry["node"] for entry in (data or {}).get("data", []) if entry.get("node")]
        for node in nodes:
            if _titles_match(title, _candidate_titles(node)):
                return node
        return None

    async def _mal_details(self, mal_id: int) -> dict[str, Any] | None:
        return await self._get(
            f"{MAL_API}/anime/{mal_id}",
            params={"fields": _MAL_FIELDS},
            headers={"X-MAL-CLIENT-ID": self.client_id},
        )

    def _from_mal(self, data: dict[str, Any]) -> MetadataResult:
        picture = data.get("main_picture") or {}
        start = data.get("start_date") or ""
        studios = data.get("studios") or []
        return MetadataResult(
            title=data.get("title"),
            original_title=(data.get("alternative_titles") or {}).get("ja"),
            overview=data.get("synopsis") or None,
            year=int(start[:4]) if start[:4].isdigit() else None,
            first_aired=start or None,
            poster_url=picture.get("large") or picture.get("medium"),
            genres=[g["name"] for g in data.get("genres") or [] if g.get("name")],
            studio=studios[0]["name"] if studios else None,
            community_rating=data.get("mean"),
            release_status=(data.get("status") or "").replace("_", " ") or None,
            content_rating=data.get("rating"),
            mal_id=data.get("id"),
            anime_format=(data.get("media_type") or "").upper() or None,
            source="mal",
        )

    # -- Jikan ------------------------------------------------------------

    async def _jikan_search(self, title: str, *, year: int | None) -> dict[str, Any] | None:
        params: dict[str, Any] = {"q": title[:64], "limit": 5, "sfw": "true"}
        if year:
            params["start_date"] = f"{year - 1}-01-01"
        data = await self._get(f"{self.jikan}/anime", params=params)
        results = (data or {}).get("data") or []
        if not results and year:
            data = await self._get(
                f"{self.jikan}/anime", params={"q": title[:64], "limit": 5, "sfw": "true"}
            )
            results = (data or {}).get("data") or []
        for entry in results:
            if _titles_match(title, _candidate_titles(entry)):
                return entry
        return None

    async def _jikan_details(self, mal_id: int) -> dict[str, Any] | None:
        data = await self._get(f"{self.jikan}/anime/{mal_id}/full")
        return (data or {}).get("data")

    def _from_jikan(self, data: dict[str, Any]) -> MetadataResult:
        images = (data.get("images") or {}).get("jpg") or {}
        aired = (data.get("aired") or {}).get("from") or ""
        studios = data.get("studios") or []
        genres = [g["name"] for g in data.get("genres") or [] if g.get("name")]
        genres += [g["name"] for g in data.get("themes") or [] if g.get("name")]
        return MetadataResult(
            title=data.get("title_english") or data.get("title"),
            original_title=data.get("title_japanese"),
            overview=data.get("synopsis") or None,
            year=data.get("year") or (int(aired[:4]) if aired[:4].isdigit() else None),
            first_aired=aired[:10] or None,
            poster_url=images.get("large_image_url") or images.get("image_url"),
            runtime_minutes=_parse_duration(data.get("duration")),
            genres=genres,
            studio=studios[0]["name"] if studios else None,
            community_rating=data.get("score"),
            release_status=(data.get("status") or "").lower() or None,
            content_rating=data.get("rating"),
            mal_id=data.get("mal_id"),
            anime_format=(data.get("type") or "").upper() or None,
            source="jikan",
        )

    # -- public -----------------------------------------------------------

    async def resolve(
        self, *, title: str, year: int | None = None, mal_id: int | None = None
    ) -> MetadataResult | None:
        try:
            if self.official:
                if mal_id is None:
                    found = await self._mal_search(_clean_title(title))
                    mal_id = found.get("id") if found else None
                if mal_id:
                    if details := await self._mal_details(mal_id):
                        return self._from_mal(details)
                return None

            if mal_id is None:
                found = await self._jikan_search(_clean_title(title), year=year)
                mal_id = found.get("mal_id") if found else None
                if found and mal_id:
                    # Search hits already carry everything we need; skip the
                    # extra /full call to stay inside Jikan's minute budget.
                    return self._from_jikan(found)
            if mal_id:
                if details := await self._jikan_details(mal_id):
                    return self._from_jikan(details)
        except Exception as exc:  # network/shape issues must not fail a sync
            log.debug("MAL lookup failed for %r: %s", title, exc)
        return None


def _parse_duration(value: str | None) -> int | None:
    """Turn Jikan's "24 min per ep" / "1 hr 52 min" into minutes."""
    if not value:
        return None
    hours = re.search(r"(\d+)\s*hr", value)
    minutes = re.search(r"(\d+)\s*min", value)
    total = (int(hours.group(1)) * 60 if hours else 0) + (int(minutes.group(1)) if minutes else 0)
    return total or None
