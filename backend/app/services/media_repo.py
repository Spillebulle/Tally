"""Turning Plex metadata into canonical ``MediaItem`` rows.

The tricky part is identity. The same show can appear on two servers, be scanned
by different agents, and also show up on the plex.tv watchlist with only a
``plex://`` guid. All of those must resolve to one row, which is what
``guid_key`` (see ``guids.build_guid_key``) is for.
"""
from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import MediaItem, MediaType, PlexLibrary, PlexMapping, PlexServer, utcnow
from .guids import ExternalIds, build_guid_key, extract_ids
from .metadata import MetadataService, get_metadata_service
from .metadata.anime import library_looks_like_anime
from .plex_server import PlexServerClient

log = logging.getLogger(__name__)

_PLEX_TYPE_TO_MEDIA = {
    "movie": MediaType.MOVIE,
    "show": MediaType.SHOW,
    "season": MediaType.SEASON,
    "episode": MediaType.EPISODE,
    "clip": MediaType.MOVIE,
}


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    text = str(value)[:10]
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _plex_genres(meta: dict[str, Any]) -> list[str]:
    return [g["tag"] for g in meta.get("Genre") or [] if isinstance(g, dict) and g.get("tag")]


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class MediaRepository:
    def __init__(
        self,
        db: AsyncSession,
        *,
        metadata_service: MetadataService | None = None,
        enrich: bool = True,
    ) -> None:
        self.db = db
        self.metadata = metadata_service or get_metadata_service()
        self.enrich = enrich
        # Within one sync run the same show is referenced by hundreds of
        # episodes; cache the resolved rows to avoid re-querying per episode.
        self._by_guid_key: dict[str, MediaItem] = {}
        self._by_rating_key: dict[tuple[int, str], MediaItem] = {}

    # -- lookups ----------------------------------------------------------

    async def find_by_guid_key(self, guid_key: str) -> MediaItem | None:
        if cached := self._by_guid_key.get(guid_key):
            return cached
        result = await self.db.execute(
            select(MediaItem).where(MediaItem.guid_key == guid_key)
        )
        item = result.scalar_one_or_none()
        if item:
            self._by_guid_key[guid_key] = item
        return item

    async def find_by_rating_key(self, server_id: int, rating_key: str) -> MediaItem | None:
        cache_key = (server_id, str(rating_key))
        if cached := self._by_rating_key.get(cache_key):
            return cached
        result = await self.db.execute(
            select(MediaItem)
            .join(PlexMapping, PlexMapping.media_item_id == MediaItem.id)
            .where(
                PlexMapping.server_id == server_id,
                PlexMapping.rating_key == str(rating_key),
            )
        )
        item = result.scalar_one_or_none()
        if item:
            self._by_rating_key[cache_key] = item
        return item

    # -- upsert -----------------------------------------------------------

    async def upsert_from_plex(
        self,
        meta: dict[str, Any],
        *,
        server: PlexServer,
        library: PlexLibrary | None = None,
        client: PlexServerClient | None = None,
        enrich: bool | None = None,
    ) -> MediaItem | None:
        plex_type = (meta.get("type") or "").lower()
        media_type = _PLEX_TYPE_TO_MEDIA.get(plex_type)
        if media_type is None:
            return None

        ids = extract_ids(meta)
        title = meta.get("title") or meta.get("grandparentTitle") or "Untitled"
        year = _int_or_none(meta.get("year"))

        # Episodes and seasons need their show resolved first so the hierarchy
        # and the derived guid_key are correct.
        show: MediaItem | None = None
        season_number = _int_or_none(meta.get("parentIndex"))
        episode_number = _int_or_none(meta.get("index"))

        if media_type in (MediaType.SEASON, MediaType.EPISODE):
            show = await self._resolve_show(meta, server=server, library=library, client=client)
            if show is None:
                log.debug("Skipping %s %r: parent show unresolved", plex_type, title)
                return None
            if media_type == MediaType.SEASON:
                season_number = _int_or_none(meta.get("index"))
                episode_number = None

        guid_key = build_guid_key(
            media_type.value,
            ids,
            title=title,
            year=year,
            show_key=show.guid_key if show else None,
            season_number=season_number,
            episode_number=episode_number,
        )

        item = await self.find_by_guid_key(guid_key)
        created = item is None
        if item is None:
            item = MediaItem(guid_key=guid_key, media_type=media_type, title=title)
            self.db.add(item)

        # --- core fields (Plex is authoritative for structure) ------------
        item.title = title
        item.sort_title = meta.get("titleSort") or item.sort_title
        item.original_title = meta.get("originalTitle") or item.original_title
        if year:
            item.year = year
        if summary := meta.get("summary"):
            item.overview = item.overview or summary
        if tagline := meta.get("tagline"):
            item.tagline = item.tagline or tagline
        if duration := _int_or_none(meta.get("duration")):
            item.runtime_minutes = item.runtime_minutes or max(1, duration // 60000)
        item.content_rating = meta.get("contentRating") or item.content_rating
        item.studio = meta.get("studio") or item.studio
        if genres := _plex_genres(meta):
            item.genres = sorted({*(item.genres or []), *genres})
        item.first_aired = item.first_aired or _parse_date(meta.get("originallyAvailableAt"))
        item.child_count = _int_or_none(meta.get("childCount")) or item.child_count
        item.leaf_count = _int_or_none(meta.get("leafCount")) or item.leaf_count

        for attr, value in (
            ("tmdb_id", ids.tmdb_id),
            ("tvdb_id", ids.tvdb_id),
            ("imdb_id", ids.imdb_id),
            ("mal_id", ids.mal_id),
            ("anilist_id", ids.anilist_id),
        ):
            if value and not getattr(item, attr):
                setattr(item, attr, value)

        if show is not None:
            item.show_id = show.id
            item.season_number = season_number
            item.episode_number = episode_number
            # Anime-ness is a property of the series; children inherit it.
            item.is_anime = show.is_anime
            item.anime_source = show.anime_source
            if media_type == MediaType.EPISODE:
                season = await self._ensure_season(show, season_number, meta)
                item.parent_id = season.id if season else show.id
            else:
                item.parent_id = show.id

        # Plex artwork is a good fallback but requires a token, so external
        # provider art is preferred when available.
        if client is not None:
            thumb = meta.get("thumb") or meta.get("parentThumb") or meta.get("grandparentThumb")
            if not item.poster_url and thumb:
                item.poster_url = client.image_url(thumb)
            art = meta.get("art") or meta.get("grandparentArt")
            if not item.backdrop_url and art:
                item.backdrop_url = client.image_url(art, width=1280, height=720)

        await self.db.flush()
        self._by_guid_key[guid_key] = item

        # --- external enrichment -----------------------------------------
        should_enrich = self.enrich if enrich is None else enrich
        if should_enrich and media_type in (MediaType.MOVIE, MediaType.SHOW):
            needs_refresh = created or item.metadata_updated_at is None
            if needs_refresh:
                await self._apply_enrichment(item, ids=ids, library=library, genres=genres)
        elif created and media_type == MediaType.SHOW and library is not None:
            item.is_anime = library_looks_like_anime(library.title)

        await self._link_mapping(item, meta, server=server, library=library, ids=ids)
        return item

    async def _apply_enrichment(
        self,
        item: MediaItem,
        *,
        ids: ExternalIds,
        library: PlexLibrary | None,
        genres: list[str],
    ) -> None:
        try:
            result = await self.metadata.enrich(
                title=item.title,
                year=item.year,
                is_show=item.media_type == MediaType.SHOW,
                ids=ids,
                plex_genres=genres,
                library_title=library.title if library else None,
                library_override=library.anime_override if library else None,
            )
        except Exception as exc:
            log.warning("Enrichment failed for %r: %s", item.title, exc)
            return

        meta = result.metadata
        # External providers win on descriptions and artwork; Plex wins on the
        # title the user actually sees in their library.
        item.overview = meta.overview or item.overview
        item.tagline = meta.tagline or item.tagline
        item.poster_url = meta.poster_url or item.poster_url
        item.backdrop_url = meta.backdrop_url or item.backdrop_url
        item.original_title = item.original_title or meta.original_title
        item.runtime_minutes = item.runtime_minutes or meta.runtime_minutes
        item.network = item.network or meta.network
        item.studio = item.studio or meta.studio
        item.content_rating = item.content_rating or meta.content_rating
        item.community_rating = meta.community_rating or item.community_rating
        item.release_status = meta.release_status or item.release_status
        item.first_aired = item.first_aired or _parse_date(meta.first_aired)
        item.year = item.year or meta.year
        if meta.genres:
            item.genres = sorted({*(item.genres or []), *meta.genres})

        item.tmdb_id = item.tmdb_id or meta.tmdb_id
        item.tvdb_id = item.tvdb_id or meta.tvdb_id
        item.imdb_id = item.imdb_id or meta.imdb_id
        item.mal_id = item.mal_id or meta.mal_id
        item.anilist_id = item.anilist_id or meta.anilist_id

        item.is_anime = result.anime.is_anime
        item.anime_source = result.anime.source
        item.anime_format = meta.anime_format or item.anime_format
        item.metadata_updated_at = utcnow()
        await self.db.flush()

    # -- hierarchy --------------------------------------------------------

    async def _resolve_show(
        self,
        meta: dict[str, Any],
        *,
        server: PlexServer,
        library: PlexLibrary | None,
        client: PlexServerClient | None,
    ) -> MediaItem | None:
        """Find (or create) the show an episode/season belongs to."""
        show_rating_key = meta.get("grandparentRatingKey")
        if meta.get("type") == "season":
            show_rating_key = meta.get("parentRatingKey")

        if show_rating_key:
            if found := await self.find_by_rating_key(server.id, str(show_rating_key)):
                return found

        # The show hasn't been imported yet (episode-first history sync). Build
        # it from the denormalised fields Plex puts on the child.
        show_title = meta.get("grandparentTitle") or meta.get("parentTitle")
        if meta.get("type") == "season":
            show_title = meta.get("parentTitle")
        if not show_title:
            return None

        show_guid = meta.get("grandparentGuid") or meta.get("parentGuid")
        show_ids = ExternalIds()
        if show_guid:
            from .guids import parse_guid

            parse_guid(str(show_guid), show_ids)

        if client is not None and show_rating_key and not show_ids.tmdb_id:
            # One extra call gets us the real guids, worth it for correct dedup.
            try:
                full = await client.metadata(str(show_rating_key))
            except Exception:
                full = None
            if full:
                return await self.upsert_from_plex(
                    full, server=server, library=library, client=client
                )

        guid_key = build_guid_key("show", show_ids, title=show_title)
        show = await self.find_by_guid_key(guid_key)
        if show is None:
            show = MediaItem(
                guid_key=guid_key,
                media_type=MediaType.SHOW,
                title=show_title,
                tmdb_id=show_ids.tmdb_id,
                tvdb_id=show_ids.tvdb_id,
                imdb_id=show_ids.imdb_id,
                is_anime=library_looks_like_anime(library.title if library else None),
            )
            self.db.add(show)
            await self.db.flush()
            self._by_guid_key[guid_key] = show

        if show_rating_key:
            self._by_rating_key[(server.id, str(show_rating_key))] = show
        return show

    async def _ensure_season(
        self, show: MediaItem, season_number: int | None, meta: dict[str, Any]
    ) -> MediaItem | None:
        if season_number is None:
            return None
        guid_key = build_guid_key(
            "season", ExternalIds(), show_key=show.guid_key, season_number=season_number
        )
        season = await self.find_by_guid_key(guid_key)
        if season is None:
            season = MediaItem(
                guid_key=guid_key,
                media_type=MediaType.SEASON,
                title=meta.get("parentTitle") or f"Season {season_number}",
                show_id=show.id,
                parent_id=show.id,
                season_number=season_number,
                is_anime=show.is_anime,
                anime_source=show.anime_source,
            )
            self.db.add(season)
            await self.db.flush()
            self._by_guid_key[guid_key] = season
        return season

    # -- mapping ----------------------------------------------------------

    async def _link_mapping(
        self,
        item: MediaItem,
        meta: dict[str, Any],
        *,
        server: PlexServer,
        library: PlexLibrary | None,
        ids: ExternalIds,
    ) -> PlexMapping | None:
        rating_key = meta.get("ratingKey")
        if not rating_key:
            return None
        rating_key = str(rating_key)

        result = await self.db.execute(
            select(PlexMapping).where(
                PlexMapping.server_id == server.id,
                PlexMapping.rating_key == rating_key,
            )
        )
        mapping = result.scalar_one_or_none()
        if mapping is None:
            mapping = PlexMapping(
                server_id=server.id, rating_key=rating_key, media_item_id=item.id
            )
            self.db.add(mapping)
        mapping.media_item_id = item.id
        mapping.library_id = library.id if library else mapping.library_id
        mapping.guid = meta.get("guid") or mapping.guid
        mapping.plex_guid = ids.plex_guid or mapping.plex_guid
        mapping.thumb_path = meta.get("thumb") or mapping.thumb_path
        mapping.art_path = meta.get("art") or mapping.art_path

        from .plex_server import _ts

        mapping.added_at = _ts(meta.get("addedAt")) or mapping.added_at
        mapping.updated_at = _ts(meta.get("updatedAt")) or mapping.updated_at

        await self.db.flush()
        self._by_rating_key[(server.id, rating_key)] = item
        return mapping

    # -- watchlist / discover ---------------------------------------------

    async def upsert_from_discover(self, meta: dict[str, Any]) -> MediaItem | None:
        """Create a canonical item from a plex.tv Discover payload.

        Watchlist entries can reference titles that exist on no server at all, so
        this path has no ``PlexMapping`` and relies purely on guids.
        """
        plex_type = (meta.get("type") or "").lower()
        media_type = _PLEX_TYPE_TO_MEDIA.get(plex_type)
        if media_type not in (MediaType.MOVIE, MediaType.SHOW):
            return None

        ids = extract_ids(meta)
        title = meta.get("title") or "Untitled"
        year = _int_or_none(meta.get("year"))
        guid_key = build_guid_key(media_type.value, ids, title=title, year=year)

        item = await self.find_by_guid_key(guid_key)
        created = item is None
        if item is None:
            item = MediaItem(guid_key=guid_key, media_type=media_type, title=title)
            self.db.add(item)

        item.title = title
        item.year = item.year or year
        item.overview = item.overview or meta.get("summary")
        item.tmdb_id = item.tmdb_id or ids.tmdb_id
        item.tvdb_id = item.tvdb_id or ids.tvdb_id
        item.imdb_id = item.imdb_id or ids.imdb_id
        if genres := _plex_genres(meta):
            item.genres = sorted({*(item.genres or []), *genres})
        # Discover artwork is served from plex.tv and needs no server token.
        if not item.poster_url and meta.get("thumb"):
            thumb = str(meta["thumb"])
            item.poster_url = thumb if thumb.startswith("http") else None

        await self.db.flush()
        self._by_guid_key[guid_key] = item

        if self.enrich and (created or item.metadata_updated_at is None):
            await self._apply_enrichment(item, ids=ids, library=None, genres=item.genres or [])
        return item

    def plex_guid_for(self, meta: dict[str, Any]) -> str | None:
        return extract_ids(meta).plex_guid
