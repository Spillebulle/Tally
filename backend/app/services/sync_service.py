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
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

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
from .plex_tv import PlexAuthError, PlexTVClient, PlexTVError

log = logging.getLogger(__name__)
settings = get_settings()

# Plex reports a "watched" scrobble at ~90% of runtime; mirror that so an item
# a user abandoned two minutes from the end still counts as watched.
COMPLETION_THRESHOLD = 0.9


class SyncCancelled(Exception):
    """Raised at a checkpoint when the user asked for the run to stop."""


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
        # Set for the duration of full_sync so the steps below can report where
        # they are and notice a cancel request. None when a step is called on
        # its own, e.g. the session poller.
        self._run: SyncRun | None = None

    # ------------------------------------------------------------------
    # Progress and cancellation
    # ------------------------------------------------------------------

    async def _set_phase(
        self, phase: str, *, current: int = 0, total: int = 0
    ) -> None:
        """Record what the run is doing, for the progress UI."""
        if self._run is None:
            return
        self._run.phase = phase
        self._run.progress_current = current
        self._run.progress_total = total
        await self.db.commit()

    async def _progress(self, current: int, total: int | None = None) -> None:
        """Update the counter within the current phase.

        ``total=None`` leaves the denominator alone, which is what the per-page
        updates want. Passing 0 explicitly clears it — that is how a phase says
        "I do not know how much work I have", and it has to be distinguishable
        from "don't touch it" or a stale total from the previous phase survives.
        """
        if self._run is None:
            return
        self._run.progress_current = current
        if total is not None:
            self._run.progress_total = total
        await self.db.commit()

    async def _checkpoint(self) -> None:
        """Stop here if the user pressed cancel.

        Called between units of work rather than inside them, so a cancelled run
        leaves committed, consistent data instead of a half-written page.
        """
        if self._run is None:
            return
        await self.db.refresh(self._run, ["cancel_requested"])
        if self._run.cancel_requested:
            raise SyncCancelled

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

        if server.manual_url:
            # An explicit address means exactly that: do not fall back to the
            # discovered list, or the useless candidates the user overrode are
            # probed anyway the moment their address has a hiccup.
            client = PlexServerClient(
                server.manual_url, token, candidate_urls=[server.manual_url]
            )
        else:
            client = PlexServerClient(
                server.base_url, token, candidate_urls=server.candidate_urls
            )
        self._clients[cache_key] = client
        return client

    async def servers_for(
        self, user: User, *, with_libraries: bool = False
    ) -> list[PlexServer]:
        """Servers this user can reach.

        Pass `with_libraries=True` when the result will be serialised. Reading
        `server.libraries` on a lazily-loaded instance raises MissingGreenlet
        under asyncio — SQLAlchemy cannot emit the follow-up SELECT from inside
        attribute access — so anything that touches the relationship has to say
        so up front. The sync engine does not, and stays on the cheaper query.
        """
        stmt = (
            select(PlexServer)
            .join(UserServerAccess, UserServerAccess.server_id == PlexServer.id)
            .where(
                UserServerAccess.user_id == user.id,
                UserServerAccess.enabled.is_(True),
                PlexServer.enabled.is_(True),
            )
        )
        if with_libraries:
            stmt = stmt.options(selectinload(PlexServer.libraries))
        result = await self.db.execute(stmt)
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

        # Cheap, and it only changes when the owner edits it in Plex, so riding
        # along with the library pass is enough. Non-owners get None back and
        # leave whatever the owner's sync recorded alone.
        try:
            window = await client.on_deck_window_weeks()
        except PlexServerError:
            window = None
        if window is not None:
            server.on_deck_window_weeks = window

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

        # The progress counter for this phase counts *items*, so its total has to
        # be an item count too. Whoever set the phase was counting libraries, and
        # leaving that total in place reported nonsense like "45233 of 2".
        # A show library is walked twice (shows, then episodes) and `count` spans
        # both, so the denominator is the sum. Zero means the server did not say,
        # which the UI renders as an indeterminate bar rather than a bad number.
        item_total = 0
        for item_type in types:
            try:
                item_total += await client.section_total(library.section_key, item_type)
            except PlexServerError:
                item_total = 0
                break
        await self._progress(0, total=item_total)

        count = 0
        shows_touched: set[int] = set()
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
                            # Carry Plex's own watched flag across, not just the
                            # history events — see apply_plex_watch_state.
                            try:
                                if (
                                    await self.apply_plex_watch_state(user, item, meta)
                                    and item.media_type == MediaType.EPISODE
                                    and item.show_id
                                ):
                                    shows_touched.add(item.show_id)
                            except Exception as exc:
                                log.warning(
                                    "Failed to apply watch state for %r: %s",
                                    meta.get("title"),
                                    exc,
                                )
                    # Commit per page so a long scan makes visible progress and a
                    # mid-scan failure doesn't discard everything.
                    await self.db.commit()
                    await self._progress(count)
                    # Between pages, never mid-page: a cancel should leave the
                    # pages already committed intact.
                    await self._checkpoint()
            except PlexServerError as exc:
                stats.errors.append(f"{library.title}: {exc}")
                break

        # A show's status is derived from its episodes, so refresh any show that
        # just gained watched episodes from Plex.
        for show_id in shows_touched:
            try:
                await self.recompute_show_state(user, show_id)
            except Exception as exc:
                log.warning("Failed to recompute show %s: %s", show_id, exc)
        if shows_touched:
            await self.db.commit()

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

    async def apply_plex_watch_state(
        self, user: User, item: MediaItem, meta: dict[str, Any]
    ) -> bool:
        """Mirror Plex's own watched flag and resume position onto an item.

        History alone is not enough. Plex only keeps a finite history, it does
        not record anything for an item marked watched by hand, and a user who
        stops an episode a minute from the end never generates a "watched"
        event — but Plex still shows it as watched, because it scrobbles at
        roughly 90% of runtime. Reading viewCount and viewOffset off the item
        itself is what makes Tally agree with what Plex displays.

        Returns True when the item counts as watched.
        """
        view_count = int(meta.get("viewCount") or 0)
        offset_ms = int(meta.get("viewOffset") or 0)
        duration_ms = int(meta.get("duration") or 0)

        progressed = bool(duration_ms) and offset_ms / duration_ms >= COMPLETION_THRESHOLD
        watched = view_count > 0 or progressed
        if not watched and offset_ms <= 0:
            # Untouched on Plex. Leave any local state alone — the user may have
            # marked it watched in Tally and that is not Plex's to undo here.
            return False

        state = await self.get_or_create_state(user.id, item.id)
        if duration_ms:
            state.duration_ms = duration_ms

        if watched:
            # Plex counts a 90%-complete item as watched but keeps the offset,
            # so clear the resume position rather than leaving it half-finished.
            state.view_count = max(state.view_count, view_count or 1)
            state.progress_ms = None
            state.status = WatchStatus.COMPLETED
            if last_viewed := meta.get("lastViewedAt"):
                seen_at = datetime.fromtimestamp(int(last_viewed), tz=UTC)
                if state.last_watched_at is None or state.last_watched_at < seen_at:
                    state.last_watched_at = seen_at
        else:
            state.progress_ms = offset_ms
            if state.status is None:
                state.status = WatchStatus.WATCHING
        return watched

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
            fetched = await self.plex_tv.get_watchlist(token)
        except PlexAuthError:
            stats.errors.append("Plex token expired; watchlist not synced")
            return
        except PlexTVError as exc:
            # Discover is reverse-engineered and the likeliest thing here to
            # break. A failure to read it says nothing about the user's
            # watchlist, so leave every local entry exactly as it is.
            stats.errors.append(f"Watchlist not synced: {exc}")
            return

        repo = MediaRepository(self.db, enrich=True)
        remote_by_item: dict[int, str] = {}

        for meta in fetched.items:
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
        # "Absent on Plex" is only meaningful if the whole watchlist arrived.
        # On a partial fetch every entry past the failing page looks absent,
        # and this loop would tombstone the lot — silent, unrecoverable data
        # loss on the user's side of a two-way sync.
        if not fetched.complete:
            stats.errors.append(
                "Watchlist only partly readable from Plex; removals were not "
                "mirrored this run"
            )
            await self.db.commit()
            return

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
        # Record the removal against the Plex baseline immediately, before we
        # know whether the push lands. `plex_active` means "what we last told
        # Plex", not "what Plex confirmed": left True on a failed push, the next
        # sync reads the tombstone as "gone last time, present now" and
        # reactivates the entry — undoing the removal instead of retrying it.
        # Items watchlisted only on Discover have no PlexMapping and so no
        # guid at all, which made that the common path rather than the edge.
        entry.plex_active = False
        entry.plex_synced_at = utcnow()

        token = decrypt_secret(user.plex_token_encrypted)
        if token and user_pref(user, "sync_watchlist"):
            plex_guid = await self._plex_guid_for_item(item.id)
            if plex_guid:
                await self.plex_tv.remove_from_watchlist(token, plex_guid)
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
        self,
        user: User,
        *,
        full_history: bool = False,
        scan_libraries: bool = True,
        run: SyncRun | None = None,
    ) -> SyncRun:
        """Run one sync end to end.

        `run` lets the caller create the SyncRun row *before* this starts. The
        HTTP trigger does that so /api/sync/status reports "running" the instant
        the button's request returns — creating it here instead meant the UI
        raced a background task and showed nothing until the next poll.
        """
        if run is None:
            run = SyncRun(
                user_id=user.id, kind="full" if full_history else "incremental"
            )
            self.db.add(run)
            await self.db.commit()
        self._run = run

        stats = SyncStats()
        try:
            await self._set_phase("Looking for Plex servers")
            servers = await self.discover_servers(user)
            if not servers:
                servers = await self.servers_for(user)
            stats.servers = len(servers)

            for index, server in enumerate(servers, start=1):
                await self._checkpoint()
                await self._set_phase(
                    f"Reading libraries on {server.name}",
                    current=index,
                    total=len(servers),
                )
                libraries = await self.sync_libraries(user, server, stats)

                if scan_libraries:
                    enabled = [library for library in libraries if library.enabled]
                    for position, library in enumerate(enabled, start=1):
                        await self._checkpoint()
                        # Which library this is goes in the text, not in the
                        # counter: the counter belongs to sync_library_items,
                        # which counts items. Two units, one pair of numbers,
                        # is what produced "45233 of 2".
                        await self._set_phase(
                            f"Scanning {library.title} on {server.name}"
                            + (f" ({position} of {len(enabled)})" if len(enabled) > 1 else "")
                        )
                        await self.sync_library_items(user, server, library, stats)

                await self._checkpoint()
                await self._set_phase(f"Importing history from {server.name}")
                await self.sync_history(user, server, stats, full=full_history)

                await self._checkpoint()
                await self._set_phase(f"Syncing ratings on {server.name}")
                await self.sync_ratings(user, server, stats)

            await self._checkpoint()
            await self._set_phase("Syncing your watchlist")
            await self.sync_watchlist(user, stats)

            await self._set_phase("Checking what is playing now")
            await self.poll_sessions(user)

            user.last_full_sync_at = utcnow()
            run.status = SyncStatus.PARTIAL if stats.errors else SyncStatus.SUCCESS
        except SyncCancelled:
            log.info("Sync cancelled for %s", user.username)
            run.status = SyncStatus.CANCELLED
            # Not an error: everything committed before the checkpoint stands.
            run.phase = "Cancelled"
        except Exception as exc:
            log.exception("Sync failed for %s", user.username)
            run.status = SyncStatus.FAILED
            run.error = str(exc)
            stats.errors.append(str(exc))
        finally:
            run.finished_at = utcnow()
            run.stats = stats.as_dict()
            if run.status != SyncStatus.CANCELLED:
                run.phase = None
            run.progress_current = 0
            run.progress_total = 0
            await self.db.commit()
            self._run = None
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
