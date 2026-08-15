"""Parsing of Plex GUIDs into external database ids.

Plex identifies items with GUIDs whose shape depends on which metadata agent
scanned the library:

* Modern Plex Movie/TV agents  -> ``plex://movie/5d776be7…`` plus a ``Guid`` array
  of ``tmdb://603``, ``imdb://tt0133093``, ``tvdb://81189``.
* Legacy agents                -> ``com.plexapp.agents.themoviedb://603?lang=en``
* HAMA (the community anime agent) -> ``com.plexapp.agents.hama://anidb-1234/1/2``

The HAMA and AniDB forms matter beyond ids: their presence is a strong signal
that an item is anime.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

_LEGACY_AGENTS = {
    "themoviedb": "tmdb",
    "tmdb": "tmdb",
    "thetvdb": "tvdb",
    "tvdb": "tvdb",
    "imdb": "imdb",
    "hama": "hama",
    "anidb": "anidb",
    "myanimelist": "mal",
    "mal": "mal",
    "anilist": "anilist",
}

_PLEX_GUID_RE = re.compile(r"^plex://(movie|show|season|episode)/([0-9a-f]+)", re.I)
_LEGACY_RE = re.compile(r"^com\.plexapp\.agents\.([a-z]+)://([^?]+)", re.I)
_SIMPLE_RE = re.compile(r"^([a-z]+)://([^?]+)", re.I)


@dataclass(slots=True)
class ExternalIds:
    tmdb_id: int | None = None
    tvdb_id: int | None = None
    imdb_id: str | None = None
    mal_id: int | None = None
    anilist_id: int | None = None
    anidb_id: int | None = None
    plex_guid: str | None = None
    # Agents seen while parsing; "hama"/"anidb" imply an anime library.
    agents: set[str] = field(default_factory=set)

    @property
    def identifying(self) -> bool:
        """Whether these ids can name the item to anything but this Plex server.

        `plex_guid` deliberately does not count. It is a per-item Plex key, so
        it produces a `plex:…` guid_key that no other source — a library scan
        asking for guids, an enrichment lookup, another server — will ever
        arrive at for the same title. Treating it as an identity is how a film
        already held as `tmdb:movie:603` acquires a second, artwork-less row.
        """
        return bool(
            self.tmdb_id
            or self.tvdb_id
            or self.imdb_id
            or self.mal_id
            or self.anilist_id
            or self.anidb_id
        )

    @property
    def anime_hinted(self) -> bool:
        return bool(
            self.anidb_id
            or self.mal_id
            or self.anilist_id
            or {"hama", "anidb", "mal", "anilist"} & self.agents
        )

    def merge(self, other: ExternalIds) -> ExternalIds:
        """Fill in blanks from ``other`` without overwriting what we have."""
        self.tmdb_id = self.tmdb_id or other.tmdb_id
        self.tvdb_id = self.tvdb_id or other.tvdb_id
        self.imdb_id = self.imdb_id or other.imdb_id
        self.mal_id = self.mal_id or other.mal_id
        self.anilist_id = self.anilist_id or other.anilist_id
        self.anidb_id = self.anidb_id or other.anidb_id
        self.plex_guid = self.plex_guid or other.plex_guid
        self.agents |= other.agents
        return self


def _as_int(value: str) -> int | None:
    match = re.match(r"^\d+", value.strip())
    return int(match.group()) if match else None


def _assign(ids: ExternalIds, source: str, raw: str) -> None:
    source = source.lower()
    ids.agents.add(source)
    # Legacy agents append season/episode: "81189/1/2". Ids are the first segment.
    head = raw.split("/", 1)[0].split("?", 1)[0]

    if source == "hama":
        # e.g. "anidb-1234", "tvdb-81189"
        provider, _, value = head.partition("-")
        if value:
            _assign(ids, _LEGACY_AGENTS.get(provider.lower(), provider.lower()), value)
        return

    if source == "tmdb":
        ids.tmdb_id = ids.tmdb_id or _as_int(head)
    elif source == "tvdb":
        ids.tvdb_id = ids.tvdb_id or _as_int(head)
    elif source == "imdb":
        if head.startswith("tt"):
            ids.imdb_id = ids.imdb_id or head
    elif source == "anidb":
        ids.anidb_id = ids.anidb_id or _as_int(head)
    elif source == "mal":
        ids.mal_id = ids.mal_id or _as_int(head)
    elif source == "anilist":
        ids.anilist_id = ids.anilist_id or _as_int(head)


def parse_guid(guid: str, ids: ExternalIds | None = None) -> ExternalIds:
    ids = ids or ExternalIds()
    if not guid:
        return ids

    if (m := _PLEX_GUID_RE.match(guid)):
        ids.plex_guid = guid.split("?", 1)[0]
        ids.agents.add("plex")
        return ids

    if (m := _LEGACY_RE.match(guid)):
        agent = _LEGACY_AGENTS.get(m.group(1).lower(), m.group(1).lower())
        _assign(ids, agent, m.group(2))
        return ids

    if (m := _SIMPLE_RE.match(guid)):
        agent = _LEGACY_AGENTS.get(m.group(1).lower(), m.group(1).lower())
        _assign(ids, agent, m.group(2))
    return ids


def extract_ids(meta: dict[str, Any]) -> ExternalIds:
    """Pull every external id out of one Plex metadata object."""
    ids = ExternalIds()
    if primary := meta.get("guid"):
        parse_guid(str(primary), ids)
    for entry in meta.get("Guid") or []:
        if isinstance(entry, dict) and entry.get("id"):
            parse_guid(str(entry["id"]), ids)
        elif isinstance(entry, str):
            parse_guid(entry, ids)
    return ids


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value or "")
    ascii_only = normalized.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_only.lower()).strip("-") or "unknown"


def build_guid_key(
    media_type: str,
    ids: ExternalIds,
    *,
    title: str = "",
    year: int | None = None,
    show_key: str | None = None,
    season_number: int | None = None,
    episode_number: int | None = None,
) -> str:
    """Produce the stable dedup key for a canonical media item.

    Preference order matters: two Plex servers scanning the same show with
    different agents must land on the same key. Episodes and seasons hang off
    their show's key so they stay grouped even when the episode itself has no
    external id of its own.
    """
    if media_type in ("season", "episode") and show_key:
        if media_type == "season":
            return f"{show_key}/s{season_number if season_number is not None else 0}"
        return (
            f"{show_key}/s{season_number if season_number is not None else 0}"
            f"e{episode_number if episode_number is not None else 0}"
        )

    if media_type in ("movie", "show"):
        if ids.tmdb_id:
            return f"tmdb:{media_type}:{ids.tmdb_id}"
        if ids.tvdb_id:
            return f"tvdb:{media_type}:{ids.tvdb_id}"
        if ids.imdb_id:
            return f"imdb:{media_type}:{ids.imdb_id}"
        if ids.anidb_id:
            return f"anidb:{media_type}:{ids.anidb_id}"
        if ids.mal_id:
            return f"mal:{media_type}:{ids.mal_id}"
        if ids.plex_guid:
            return f"plex:{ids.plex_guid.rsplit('/', 1)[-1]}"

    parts = [media_type, slugify(title)]
    if year:
        parts.append(str(year))
    if season_number is not None:
        parts.append(f"s{season_number}")
    if episode_number is not None:
        parts.append(f"e{episode_number}")
    return "title:" + ":".join(parts)
