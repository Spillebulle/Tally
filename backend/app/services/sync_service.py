"""Two-way synchronisation between Tally and Plex.

Conflict model
--------------
Tally keeps, for every syncable user field, both the local value and the last
value observed on Plex. That lets each sync classify a field into one of four
cases:

* neither side changed -> nothing to do
* only local changed   -> push to Plex
* only Plex changed    -> pull into Tally
* both changed         -> newest timestamp wins

Watchlist removals are tombstoned rather than deleted, otherwise the next pull
would cheerfully re-add everything the user just removed.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import (
    MediaItem,
    MediaType,
    PlexLibrary,
    PlexMapping,
    PlexServer,
    SyncRun,
    SyncStatus,
    User,
    UserMediaState,
    UserServerAccess,
    WatchEvent,
    WatchlistEntry,
    WatchSource,
    WatchStatus,
    utcnow,
)
from ..security import decrypt_secret, encrypt_secret
from .media_repo import MediaRepository
from .metadata.anime import library_looks_like_anime
from .plex_server import (
    TYPE_EPISODE,
    TYPE_MOVIE,
    TYPE_SHOW,
    PlexServerClient,
    PlexServerError,
    _ts,
)
from .plex_tv import PlexAuthError, PlexTVClient

log = logging.getLogger(__name__)
settings = get_settings()

# Plex reports a "watched" scrobble at ~90% of runtime; mirror that so an item
# a user abandoned two minutes from the end still counts as watched.
COMPLETION_THRESHOLD = 0.9


@dataclass
class SyncStats:
    servers: int = 0
    libraries: int = 0
    items_created: int = 0
    items_updated: int = 0
    history_events: int = 0
    ratings_pushed: int = 0
    ratings_pulled: int = 0
    watchlist_pushed: int = 0
    watchlist_pulled: int = 0
    watchlist_removed_local: int = 0
    watchlist_removed_remote: int = 0
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "servers": self.servers,
            "libraries": self.libraries,
            "items_created": self.items_created,
            "items_updated": self.items_updated,
            "history_events": self.history_events,
            "ratings_pushed": self.ratings_pushed,
            "ratings_pulled": self.ratings_pulled,
            "watchlist_pushed": self.watchlist_pushed,
            "watchlist_pulled": self.watchlist_pulled,
            "watchlist_removed_local": self.watchlist_removed_local,
            "watchlist_removed_remote": self.watchlist_removed_remote,
            "errors": self.errors[:50],
        }


def user_pref(user: User, key: str, default: bool = True) -> bool:
    return bool((user.preferences or {}).get(key, default))


class SyncService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.plex_tv = PlexTVClient()
        self._clients: dict[tuple[int, int], PlexServerClient] = {}

    # ------------------------------------------------------------------
    # Server discovery
    # ------------------------------------------------------------------

    async def discover_servers(self, user: User) -> list[PlexServer]:
        """Refresh the server list and per-user tokens from plex.tv."""
        token = decrypt_secret(user.plex_token_encrypted)
        if not token:
            return []

        try:
            resources = await self.plex_tv.get_resources(token)
        except PlexAuthError:
            log.warning("Plex token for %s is no longer valid", user.username)
            return []

        servers: list[PlexServer] = []
        for resource in resources:
            result = await self.db.execute(
                select(PlexServer).where(
                    PlexServer.machine_identifier == resource.client_identifier
                )
            )
            server = result.scalar_one_or_none()
            uris = resource.ordered_uris()
            if not uris:
                continue

            if server is None:
                server = PlexServer(
                    machine_identifier=resource.client_identifier,
                    name=resource.name,
                    base_url=uris[0],
                    access_token_encrypted=encrypt_secret(resource.access_token) or "",
                    owned=resource.owned,
                    owner_user_id=user.id if resource.owned else None,
                )
                self.db.add(server)
            else:
                server.name = resource.name
                if resource.owned:
                    # Only the owner's token can drive library scans.
                    server.access_token_encrypted = encrypt_secret(resource.access_token) or ""
                    server.owner_user_id = server.owner_user_id or user.id
                    server.owned = True
            server.candidate_urls = uris
            server.base_url = server.base_url or uris[0]
            server.version = resource.version
            server.platform = resource.platform
            server.last_seen_at = utcnow()
            await self.db.flush()

            await self._upsert_access(user, server, resource.access_token, resource.owned)
            servers.append(server)

        await self.db.commit()
        return servers

    async def _upsert_access(
        self, user: User, server: PlexServer, token: str, owned: bool
    ) -> UserServerAccess:
        result = await self.db.execute(
            select(UserServerAccess).where(
                UserServerAccess.user_id == user.id,
                UserServerAccess.server_id == server.id,
            )
        )
        access = result.scalar_one_or_none()
        if access is None:
            access = UserServerAccess(user_id=user.id, server_id=server.id)
            self.db.add(access)
        access.access_token_encrypted = encrypt_secret(token) or ""
        access.owned = owned
        await self.db.flush()

        if access.plex_account_id is None:
            access.plex_account_id = await self._resolve_account_id(user, server, token)
        return access

    async def _resolve_account_id(
        self, user: User, server: PlexServer, token: str
    ) -> int | None:
        """Map a plex.tv user to the numeric accountID the server uses.

        History endpoints filter on the server-side id, which differs from the
        plex.tv id for home/managed users.
        """
        client = PlexServerClient(server.base_url, token, candidate_urls=server.candidate_urls)
        try:
            accounts = await client.accounts()
        except PlexServerError:
            return None

        for account in accounts:
            account_id = account.get("id")
            if account_id is None:
                continue
            names = {
                str(account.get("name") or "").lower(),
                str(account.get("defaultAudioLanguage") or "").lower(),
            }
            if user.plex_username and user.plex_username.lower() in names:
                return int(account_id)
            if user.username.lower() in names:
                return int(account_id)
        # accountID 1 is always the server owner.
        if server.owner_user_id == user.id:
            return 1
        return None

    async def client_for(
        self, user: User, server: PlexServer
    ) -> PlexServerClient | None:
        cache_key = (user.id, server.id)
        if cached := self._clients.get(cache_key):
            return cached

        result = await self.db.execute(
            select(UserServerAccess).where(
                UserServerAccess.user_id == user.id,
                UserServerAccess.server_id == server.id,
                UserServerAccess.enabled.is_(True),
            )
        )
        access = result.scalar_one_or_none()
        token = decrypt_secret(access.access_token_encrypted) if access else None
        if not token and server.owner_user_id == user.id:
            token = decrypt_secret(server.access_token_encrypted)
        if not token:
            return None

        client = PlexServerClient(
            server.base_url, token, candidate_urls=server.candidate_urls
        )
        self._clients[cache_key] = client
        return client

    async def servers_for(self, user: User) -> list[PlexServer]:
        result = await self.db.execute(
            select(PlexServer)
            .join(UserServerAccess, UserServerAccess.server_id == PlexServer.id)
            .where(
                UserServerAccess.user_id == user.id,
                UserServerAccess.enabled.is_(True),
                PlexServer.enabled.is_(True),
            )
        )
        return list(result.scalars().unique())

    # ------------------------------------------------------------------
    # Libraries
    # ------------------------------------------------------------------

    async def sync_libraries(
        self, user: User, server: PlexServer, stats: SyncStats
    ) -> list[PlexLibrary]:
        client = await self.client_for(user, server)
        if client is None:
            return []
        try:
            sections = await client.sections()
        except PlexServerError as exc:
            stats.errors.append(f"{server.name}: {exc}")
            return []

        libraries: list[PlexLibrary] = []
        for section in sections:
            section_type = section.get("type")
            if section_type not in ("movie", "show"):
                continue  # music/photos aren't Tally's business

            result = await self.db.execute(
                select(PlexLibrary).where(
                    PlexLibrary.server_id == server.id,
                    PlexLibrary.section_key == str(section["key"]),
                )
            )
            library = result.scalar_one_or_none()
            if library is None:
                library = PlexLibrary(
                    server_id=server.id,
                    section_key=str(section["key"]),
                    title=section.get("title", "Library"),
                    section_type=section_type,
                )
                self.db.add(library)
                # Seed the anime flag from the library name on first sight; the
                # user can override it later in Settings.
                if library_looks_like_anime(library.title):
                    library.anime_override = True
            library.title = section.get("title", library.title)
            library.section_uuid = section.get("uuid") or library.section_uuid
            library.section_type = section_type
            libraries.append(library)

        await self.db.commit()
        stats.libraries += len(libraries)
        return libraries

    async def sync_library_items(
        self,
        user: User,
        server: PlexServer,
        library: PlexLibrary,
        stats: SyncStats,
        *,
        include_episodes: bool = True,
        enrich: bool = True,
    ) -> None:
        client = await self.client_for(user, server)
        if client is None:
            return

        repo = MediaRepository(self.db, enrich=enrich)
        types = [TYPE_MOVIE] if library.section_type == "movie" else [TYPE_SHOW]
        if library.section_type == "show" and include_episodes:
            types.append(TYPE_EPISODE)

        count = 0
        for item_type in types:
            try:
                async for page in client.iter_section_items(library.section_key, item_type):
                    for meta in page:
                        try:
                            item = await repo.upsert_from_plex(
                                meta, server=server, library=library, client=client
                            )
                        except Exception as exc:
                            log.warning(
                                "Failed to import %r: %s", meta.get("title"), exc
                            )
                            continue
                        if item is not None:
                            count += 1
                    # Commit per page so a long scan makes visible progress and a
                    # mid-scan failure doesn't discard everything.
                    await self.db.commit()
            except PlexServerError as exc:
                stats.errors.append(f"{library.title}: {exc}")
                break

        library.item_count = count
        library.last_synced_at = utcnow()
        await self.db.commit()
        stats.items_updated += count

    # ------------------------------------------------------------------
    # History
    # ------------------------------------------------------------------

    async def sync_history(
        self,
        user: User,
        server: PlexServer,
        stats: SyncStats,
        *,
        full: bool = False,
    ) -> None:
        client = await self.client_for(user, server)
        if client is None:
            return

        result = await self.db.execute(
            select(UserServerAccess).where(
                UserServerAccess.user_id == user.id,
                UserServerAccess.server_id == server.id,
            )
        )
        access = result.scalar_one_or_none()
        account_id = access.plex_account_id if access else None

        since: datetime | None = None
        if not full and access and access.last_history_sync_at:
            # Overlap by a day: Plex can backdate entries when a client syncs late.
            since = access.last_history_sync_at - timedelta(days=1)

        repo = MediaRepository(self.db, enrich=False)
        started = utcnow()
        imported = 0

        try:
            async for page in client.iter_history(account_id=account_id, since=since):
                for entry in page:
                    if await self._ingest_history_entry(
                        user, server, entry, repo, client
                    ):
                        imported += 1
                await self.db.commit()
        except PlexServerError as exc:
            stats.errors.append(f"{server.name} history: {exc}")
            await self.db.commit()
            return

        if access is not None:
            access.last_history_sync_at = started
        await self.db.commit()
        stats.history_events += imported

    async def _ingest_history_entry(
        self,
        user: User,
        server: PlexServer,
        entry: dict[str, Any],
        repo: MediaRepository,
        client: PlexServerClient,
    ) -> bool:
        viewed_at = _ts(entry.get("viewedAt"))
        if viewed_at is None:
            return False

        rating_key = str(entry.get("ratingKey") or "")
        item = None
        if rating_key:
            item = await repo.find_by_rating_key(server.id, rating_key)
        if item is None:
            # History rows are thin; fetch full metadata so guids resolve.
            meta = entry
            if rating_key and not entry.get("guid"):
                try:
                    fetched = await client.metadata(rating_key)
                except PlexServerError:
                    fetched = None
                meta = fetched or entry
            item = await repo.upsert_from_plex(meta, server=server, client=client)
        if item is None:
            return False

        history_key = entry.get("historyKey") or f"{rating_key}:{int(viewed_at.timestamp())}"
        dedupe_key = f"plex:{server.machine_identifier}:{history_key}"

        exists = await self.db.execute(
            select(WatchEvent.id).where(
                WatchEvent.user_id == user.id, WatchEvent.dedupe_key == dedupe_key
            )
        )
        if exists.scalar_one_or_none() is not None:
            return False

        self.db.add(
            WatchEvent(
                user_id=user.id,
                media_item_id=item.id,
                watched_at=viewed_at,
                source=WatchSource.PLEX_HISTORY,
                dedupe_key=dedupe_key,
                completed=True,
                duration_ms=entry.get("duration"),
                server_id=server.id,
                device=entry.get("deviceID") and str(entry.get("deviceID")) or None,
            )
        )
        await self.db.flush()
        await self.record_watch_state(user, item, viewed_at)
        return True

    async def record_watch_state(
        self, user: User, item: MediaItem, watched_at: datetime
    ) -> UserMediaState:
        """Update the per-user rollup after a watch, cascading up the hierarchy."""
        state = await self.get_or_create_state(user.id, item.id)
        state.view_count = (state.view_count or 0) + 1
        if state.last_watched_at is None or watched_at > state.last_watched_at:
            state.last_watched_at = watched_at
        state.progress_ms = None
        if item.media_type in (MediaType.MOVIE, MediaType.EPISODE):
            state.status = WatchStatus.COMPLETED
        await self.db.flush()

        if item.media_type == MediaType.EPISODE and item.show_id:
            await self.recompute_show_state(user, item.show_id, watched_at)
        return state

    async def get_or_create_state(self, user_id: int, item_id: int) -> UserMediaState:
        result = await self.db.execute(
            select(UserMediaState).where(
                UserMediaState.user_id == user_id,
                UserMediaState.media_item_id == item_id,
            )
        )
        state = result.scalar_one_or_none()
        if state is None:
            state = UserMediaState(user_id=user_id, media_item_id=item_id)
            self.db.add(state)
            await self.db.flush()
        return state

    async def recompute_show_state(
        self, user: User, show_id: int, watched_at: datetime | None = None
    ) -> UserMediaState:
        """Derive a show's status from how many of its episodes are watched."""
        total = await self.db.scalar(
            select(func.count(MediaItem.id)).where(
                MediaItem.show_id == show_id,
                MediaItem.media_type == MediaType.EPISODE,
            )
        )
        watched = await self.db.scalar(
            select(func.count(func.distinct(UserMediaState.media_item_id)))
            .join(MediaItem, MediaItem.id == UserMediaState.media_item_id)
            .where(
                MediaItem.show_id == show_id,
                MediaItem.media_type == MediaType.EPISODE,
                UserMediaState.user_id == user.id,
                UserMediaState.view_count > 0,
            )
        )
        state = await self.get_or_create_state(user.id, show_id)
        total, watched = int(total or 0), int(watched or 0)

        if total and watched >= total:
            state.status = WatchStatus.COMPLETED
        elif watched:
            # Don't silently resurrect something the user explicitly dropped or
            # parked — those statuses are deliberate choices.
            if state.status not in (WatchStatus.DROPPED, WatchStatus.ON_HOLD):
                state.status = WatchStatus.WATCHING
        state.view_count = watched
        if watched_at and (state.last_watched_at is None or watched_at > state.last_watched_at):
            state.last_watched_at = watched_at
        await self.db.flush()
        return state

    # ------------------------------------------------------------------
    # Ratings (two-way)
    # ------------------------------------------------------------------

    async def sync_ratings(
        self, user: User, server: PlexServer, stats: SyncStats
    ) -> None:
        if not user_pref(user, "sync_ratings"):
            return
        client = await self.client_for(user, server)
        if client is None:
            return

        # Only movies and shows carry user ratings worth syncing; episode-level
        # ratings exist in Plex but are rarely used and would triple the traffic.
        result = await self.db.execute(
            select(MediaItem, PlexMapping)
            .join(PlexMapping, PlexMapping.media_item_id == MediaItem.id)
            .where(
                PlexMapping.server_id == server.id,
                MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW]),
            )
        )
        rows = result.all()

        for item, mapping in rows:
            state_result = await self.db.execute(
                select(UserMediaState).where(
                    UserMediaState.user_id == user.id,
                    UserMediaState.media_item_id == item.id,
                )
            )
            state = state_result.scalar_one_or_none()

            try:
                meta = await client.metadata(mapping.rating_key)
            except PlexServerError:
                continue
            if meta is None:
                continue

            remote_raw = meta.get("userRating")
            remote = float(remote_raw) if remote_raw not in (None, "") else None

            if state is None:
                if remote is None:
                    continue
                state = await self.get_or_create_state(user.id, item.id)

            local = state.rating
            baseline = state.plex_rating

            local_changed = local != baseline
            remote_changed = remote != baseline

            if not local_changed and not remote_changed:
                continue

            if local_changed and not remote_changed:
                if local is not None and await client.rate(mapping.rating_key, local):
                    state.plex_rating = local
                    state.plex_rating_synced_at = utcnow()
                    stats.ratings_pushed += 1
            elif remote_changed and not local_changed:
                state.rating = remote
                state.rating_updated_at = utcnow()
                state.plex_rating = remote
                state.plex_rating_synced_at = utcnow()
                stats.ratings_pulled += 1
            else:
                # Both moved since the last sync — newest write wins. Without a
                # local timestamp we can't argue, so defer to Plex.
                local_time = state.rating_updated_at
                remote_time = state.plex_rating_synced_at
                prefer_local = bool(
                    local_time and (remote_time is None or local_time > remote_time)
                )
                if prefer_local and local is not None:
                    if await client.rate(mapping.rating_key, local):
                        state.plex_rating = local
                        state.plex_rating_synced_at = utcnow()
                        stats.ratings_pushed += 1
                else:
                    state.rating = remote
                    state.rating_updated_at = utcnow()
                    state.plex_rating = remote
                    state.plex_rating_synced_at = utcnow()
                    stats.ratings_pulled += 1

            await self.db.flush()
        await self.db.commit()

    async def push_rating(self, user: User, item: MediaItem, rating: float | None) -> bool:
        """Send a rating the user just set in Tally straight to Plex."""
        if not user_pref(user, "sync_ratings"):
            return False
        pushed = False
        for server in await self.servers_for(user):
            client = await self.client_for(user, server)
            if client is None:
                continue
            result = await self.db.execute(
                select(PlexMapping).where(
                    PlexMapping.server_id == server.id,
                    PlexMapping.media_item_id == item.id,
                )
            )
            mapping = result.scalar_one_or_none()
            if mapping is None:
                continue
            try:
                # Plex has no "unrate"; 0 clears the rating in its UI too.
                if await client.rate(mapping.rating_key, rating if rating is not None else 0.0):
                    pushed = True
            except PlexServerError as exc:
                log.warning("Rating push failed for %s: %s", item.title, exc)
        return pushed

    async def push_watched(
        self, user: User, item: MediaItem, *, watched: bool
    ) -> bool:
        """Mirror a manual watch/unwatch into Plex."""
        if not user_pref(user, "sync_history"):
            return False
        pushed = False
        for server in await self.servers_for(user):
            client = await self.client_for(user, server)
            if client is None:
                continue
            result = await self.db.execute(
                select(PlexMapping).where(
                    PlexMapping.server_id == server.id,
                    PlexMapping.media_item_id == item.id,
                )
            )
            mapping = result.scalar_one_or_none()
            if mapping is None:
                continue
            try:
                ok = (
                    await client.scrobble(mapping.rating_key)
                    if watched
                    else await client.unscrobble(mapping.rating_key)
                )
                pushed = pushed or ok
            except PlexServerError as exc:
                log.warning("Scrobble failed for %s: %s", item.title, exc)
        return pushed

    # ------------------------------------------------------------------
    # Watchlist (two-way)
    # ------------------------------------------------------------------

    async def sync_watchlist(self, user: User, stats: SyncStats) -> None:
        if not user_pref(user, "sync_watchlist"):
            return
        token = decrypt_secret(user.plex_token_encrypted)
        if not token:
            return

        try:
            remote_items = await self.plex_tv.get_watchlist(token)
        except PlexAuthError:
            stats.errors.append("Plex token expired; watchlist not synced")
            return

        repo = MediaRepository(self.db, enrich=True)
        remote_by_item: dict[int, str] = {}

        for meta in remote_items:
            item = await repo.upsert_from_discover(meta)
            if item is None:
                continue
            plex_guid = repo.plex_guid_for(meta) or str(meta.get("guid") or "")
            remote_by_item[item.id] = plex_guid
            await self._remember_plex_guid(item, plex_guid)
        await self.db.commit()

        result = await self.db.execute(
            select(WatchlistEntry).where(WatchlistEntry.user_id == user.id)
        )
        local_entries = {entry.media_item_id: entry for entry in result.scalars()}

        # --- pull: on Plex, not (actively) here ---------------------------
        for item_id, plex_guid in remote_by_item.items():
            entry = local_entries.get(item_id)
            if entry is None:
                self.db.add(
                    WatchlistEntry(
                        user_id=user.id,
                        media_item_id=item_id,
                        active=True,
                        source="plex",
                        plex_active=True,
                        plex_synced_at=utcnow(),
                    )
                )
                stats.watchlist_pulled += 1
            elif not entry.active:
                if entry.plex_active is False or entry.plex_active is None:
                    # Removed locally after we last saw it on Plex -> push the removal.
                    if await self.plex_tv.remove_from_watchlist(token, plex_guid):
                        entry.plex_active = False
                        entry.plex_synced_at = utcnow()
                        stats.watchlist_removed_remote += 1
                else:
                    # It was already gone from Plex's view last time and is back
                    # now, so Plex is the newer writer: reactivate locally.
                    entry.active = True
                    entry.removed_at = None
                    entry.plex_active = True
                    entry.plex_synced_at = utcnow()
                    stats.watchlist_pulled += 1
            else:
                entry.plex_active = True
                entry.plex_synced_at = utcnow()

        # --- push: active here, absent on Plex ---------------------------
        for item_id, entry in local_entries.items():
            if item_id in remote_by_item:
                continue
            if entry.active:
                if entry.plex_active:
                    # We saw it on Plex before and it's gone now -> removed there.
                    entry.active = False
                    entry.removed_at = utcnow()
                    entry.plex_active = False
                    entry.plex_synced_at = utcnow()
                    stats.watchlist_removed_local += 1
                else:
                    plex_guid = await self._plex_guid_for_item(item_id)
                    if plex_guid and await self.plex_tv.add_to_watchlist(token, plex_guid):
                        entry.plex_active = True
                        entry.plex_synced_at = utcnow()
                        stats.watchlist_pushed += 1
            else:
                entry.plex_active = False
                entry.plex_synced_at = utcnow()

        await self.db.commit()

    async def _remember_plex_guid(self, item: MediaItem, plex_guid: str | None) -> None:
        """Stash a Discover guid so we can later add/remove this item remotely."""
        if not plex_guid or not plex_guid.startswith("plex://"):
            return
        result = await self.db.execute(
            select(PlexMapping).where(
                PlexMapping.media_item_id == item.id,
                PlexMapping.plex_guid == plex_guid,
            )
        )
        if result.scalar_one_or_none() is not None:
            return
        result = await self.db.execute(
            select(PlexMapping).where(PlexMapping.media_item_id == item.id)
        )
        for mapping in result.scalars():
            if not mapping.plex_guid:
                mapping.plex_guid = plex_guid
                await self.db.flush()
                return

    async def _plex_guid_for_item(self, item_id: int) -> str | None:
        result = await self.db.execute(
            select(PlexMapping.plex_guid).where(
                PlexMapping.media_item_id == item_id,
                PlexMapping.plex_guid.is_not(None),
            )
        )
        return result.scalars().first()

    async def add_to_watchlist(self, user: User, item: MediaItem) -> WatchlistEntry:
        result = await self.db.execute(
            select(WatchlistEntry).where(
                WatchlistEntry.user_id == user.id,
                WatchlistEntry.media_item_id == item.id,
            )
        )
        entry = result.scalar_one_or_none()
        if entry is None:
            entry = WatchlistEntry(user_id=user.id, media_item_id=item.id)
            self.db.add(entry)
        entry.active = True
        entry.removed_at = None
        entry.added_at = entry.added_at or utcnow()
        await self.db.flush()

        token = decrypt_secret(user.plex_token_encrypted)
        if token and user_pref(user, "sync_watchlist"):
            plex_guid = await self._plex_guid_for_item(item.id)
            if plex_guid and await self.plex_tv.add_to_watchlist(token, plex_guid):
                entry.plex_active = True
                entry.plex_synced_at = utcnow()
        await self.db.commit()
        return entry

    async def remove_from_watchlist(self, user: User, item: MediaItem) -> None:
        result = await self.db.execute(
            select(WatchlistEntry).where(
                WatchlistEntry.user_id == user.id,
                WatchlistEntry.media_item_id == item.id,
            )
        )
        entry = result.scalar_one_or_none()
        if entry is None:
            return
        entry.active = False
        entry.removed_at = utcnow()

        token = decrypt_secret(user.plex_token_encrypted)
        if token and user_pref(user, "sync_watchlist"):
            plex_guid = await self._plex_guid_for_item(item.id)
            if plex_guid and await self.plex_tv.remove_from_watchlist(token, plex_guid):
                entry.plex_active = False
                entry.plex_synced_at = utcnow()
        await self.db.commit()

    # ------------------------------------------------------------------
    # Now playing
    # ------------------------------------------------------------------

    async def poll_sessions(self, user: User) -> int:
        """Record in-progress playback so "Continue watching" stays live."""
        updated = 0
        for server in await self.servers_for(user):
            client = await self.client_for(user, server)
            if client is None:
                continue
            result = await self.db.execute(
                select(UserServerAccess).where(
                    UserServerAccess.user_id == user.id,
                    UserServerAccess.server_id == server.id,
                )
            )
            access = result.scalar_one_or_none()

            try:
                sessions = await client.sessions()
            except PlexServerError:
                continue

            repo = MediaRepository(self.db, enrich=False)
            for session in sessions:
                if access and access.plex_account_id is not None:
                    if session.account_id != access.plex_account_id:
                        continue
                item = await repo.find_by_rating_key(server.id, session.rating_key)
                if item is None:
                    try:
                        meta = await client.metadata(session.rating_key)
                    except PlexServerError:
                        continue
                    if meta is None:
                        continue
                    item = await repo.upsert_from_plex(meta, server=server, client=client)
                if item is None:
                    continue

                state = await self.get_or_create_state(user.id, item.id)
                state.progress_ms = session.view_offset_ms
                state.duration_ms = session.duration_ms or state.duration_ms
                state.last_watched_at = utcnow()
                if state.status != WatchStatus.COMPLETED:
                    state.status = WatchStatus.WATCHING
                if item.media_type == MediaType.EPISODE and item.show_id:
                    show_state = await self.get_or_create_state(user.id, item.show_id)
                    if show_state.status not in (
                        WatchStatus.COMPLETED,
                        WatchStatus.DROPPED,
                    ):
                        show_state.status = WatchStatus.WATCHING
                    show_state.last_watched_at = utcnow()
                updated += 1
            await self.db.commit()
        return updated

    # ------------------------------------------------------------------
    # Orchestration
    # ------------------------------------------------------------------

    async def full_sync(
        self, user: User, *, full_history: bool = False, scan_libraries: bool = True
    ) -> SyncRun:
        run = SyncRun(user_id=user.id, kind="full" if full_history else "incremental")
        self.db.add(run)
        await self.db.commit()

        stats = SyncStats()
        try:
            servers = await self.discover_servers(user)
            if not servers:
                servers = await self.servers_for(user)
            stats.servers = len(servers)

            for server in servers:
                libraries = await self.sync_libraries(user, server, stats)
                if scan_libraries:
                    for library in libraries:
                        if library.enabled:
                            await self.sync_library_items(user, server, library, stats)
                await self.sync_history(user, server, stats, full=full_history)
                await self.sync_ratings(user, server, stats)

            await self.sync_watchlist(user, stats)
            await self.poll_sessions(user)

            user.last_full_sync_at = utcnow()
            run.status = SyncStatus.PARTIAL if stats.errors else SyncStatus.SUCCESS
        except Exception as exc:
            log.exception("Sync failed for %s", user.username)
            run.status = SyncStatus.FAILED
            run.error = str(exc)
            stats.errors.append(str(exc))
        finally:
            run.finished_at = utcnow()
            run.stats = stats.as_dict()
            await self.db.commit()
        return run


async def sync_all_users(db: AsyncSession, *, full_history: bool = False) -> None:
    """Background entry point: sync every linked account, one at a time."""
    result = await db.execute(
        select(User).where(
            User.is_active.is_(True), User.plex_token_encrypted.is_not(None)
        )
    )
    users = list(result.scalars())
    for user in users:
        service = SyncService(db)
        try:
            await service.full_sync(user, full_history=full_history)
        except Exception:
            log.exception("Scheduled sync failed for %s", user.username)
        # Be a polite neighbour to the Plex server between accounts.
        await asyncio.sleep(1)
