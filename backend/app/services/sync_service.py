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

from sqlalchemy import and_, case, exists, func, or_, select, update
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
from .credits import fetch_credits
from .guids import extract_ids
from .media_repo import (
    ARTWORK_RETRY_INTERVAL,
    METADATA_RESWEEP_MARK,
    MediaRepository,
)
from .metadata import get_metadata_service
from .metadata.anime import library_looks_like_anime
from .plex_server import (
    TYPE_EPISODE,
    TYPE_MOVIE,
    TYPE_SHOW,
    PlexServerClient,
    PlexServerError,
    _ts,
    player_identity,
)
from .plex_tv import PlexAuthError, PlexTVClient, PlexTVError

log = logging.getLogger(__name__)
settings = get_settings()

# Plex reports a "watched" scrobble at ~90% of runtime; mirror that so an item
# a user abandoned two minutes from the end still counts as watched.
COMPLETION_THRESHOLD = 0.9

# How many artwork-less rows one run tries to identify. Each is a provider
# call behind a rate limit, so a backlog drains over several syncs rather
# than turning a single one into an hour of TMDB traffic.
METADATA_BACKFILL_BATCH = 100

# How many titles one run fetches cast and crew for. Same shape and same reason
# as the constant above — one TMDB call each, behind the same rate limiter —
# and deliberately the same number, because a run does both.
CREDITS_BACKFILL_BATCH = 100


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
    metadata_backfilled: int = 0
    credits_fetched: int = 0
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
            "metadata_backfilled": self.metadata_backfilled,
            "credits_fetched": self.credits_fetched,
            "errors": self.errors[:50],
        }


def user_pref(user: User, key: str, default: bool = True) -> bool:
    return bool((user.preferences or {}).get(key, default))


def _duration_ms(value: Any) -> int | None:
    """A play's length in milliseconds, as Plex reported it.

    This is the only runtime a thin history row carries — those items have no
    `runtime_minutes` at all — and the stats runtime total reads it first, so
    a value Plex sent as a string must not be dropped on the floor.
    """
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _watch_context(
    entry: dict[str, Any], devices: dict[str, tuple[str | None, str | None]]
) -> tuple[str | None, str | None]:
    """`(device, player)` for a history row, per the rule in `plex_server`.

    A history row usually names the client only as `deviceID`, a server-local
    integer — so the server's own device table is the only thing that can turn
    it into words. Some rows do carry a `Player` block; that is Plex answering
    the question directly, so it is preferred over the lookup.

    What it never does is fall back to the id itself. `device` holds names, and
    a column holding names *and* integers is one a chart cannot group.
    """
    device, player = player_identity(entry.get("Player") or entry.get("Device"))
    device_id = entry.get("deviceID")
    if device_id is not None:
        named_device, named_player = devices.get(str(device_id), (None, None))
        device = device or named_device
        player = player or named_player
    return device, player


class SyncService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.plex_tv = PlexTVClient()
        self._clients: dict[tuple[int, int], PlexServerClient] = {}
        # The server's device table, per (user, server), fetched at most once
        # per SyncService — which is once per sync run. See `_device_directory`.
        self._devices: dict[tuple[int, int], dict[str, tuple[str | None, str | None]]] = {}
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
        except PlexTVError as exc:
            # DNS, blocked egress, or plex.tv itself having a bad day. None of
            # that says anything about the local Plex server, so returning []
            # lets full_sync fall back to the servers already known instead of
            # failing a run that would otherwise have worked entirely offline
            # from plex.tv.
            log.warning("Could not reach plex.tv for %s: %s", user.username, exc)
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
            # `name` and `title` are the identity fields on a server-side
            # account; `email` matches a home user whose server name differs.
            # This used to read `defaultAudioLanguage` — an audio setting, not
            # an identity — so the comparison never matched anything real.
            names = {
                str(account.get("name") or "").lower(),
                str(account.get("title") or "").lower(),
                str(account.get("email") or "").lower(),
            }
            names.discard("")
            if user.plex_username and user.plex_username.lower() in names:
                return int(account_id)
            if user.username.lower() in names:
                return int(account_id)
            if user.email and user.email.lower() in names:
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
        partial = False
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
                            # Roll back before carrying on. A failed flush — an
                            # IntegrityError on the unique guid_key, say —
                            # leaves the session needing one, and without it
                            # every later item raises PendingRollbackError,
                            # which this handler swallows, until the page commit
                            # raises it outside the PlexServerError guard and
                            # takes the whole run down with it.
                            await self.db.rollback()
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
                                await self.db.rollback()
                    # Commit per page so a long scan makes visible progress and a
                    # mid-scan failure doesn't discard everything.
                    await self.db.commit()
                    await self._progress(count)
                    # Between pages, never mid-page: a cancel should leave the
                    # pages already committed intact.
                    await self._checkpoint()
            except PlexServerError as exc:
                stats.errors.append(f"{library.title}: {exc}")
                partial = True
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

        # Only claim the library is fully scanned if it was. Recording the count
        # and timestamp after a mid-scan failure presents a partial scan as a
        # complete one, so the missing items look deliberately absent rather
        # than pending, and nothing prompts a rescan.
        if not partial:
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
        if account_id is None:
            # `iter_history` omits the accountID parameter entirely when this is
            # None, which asks Plex for *everyone's* history and files it all
            # under this user — other household members' plays, as permanent
            # WatchEvent rows. Failing closed loses nothing that can't be
            # recovered by resolving the id on a later run.
            log.warning(
                "No Plex account id resolved for %s on %s; skipping history "
                "import rather than importing the whole server's",
                user.username,
                server.name,
            )
            stats.errors.append(
                f"{server.name}: could not identify your Plex account, so watch "
                "history was not imported"
            )
            return

        since: datetime | None = None
        if not full and access and access.last_history_sync_at:
            # Overlap by a day: Plex can backdate entries when a client syncs late.
            since = access.last_history_sync_at - timedelta(days=1)

        repo = MediaRepository(self.db, enrich=False)
        started = utcnow()
        imported = 0

        # One fetch for the whole run, before the loop rather than inside it.
        devices = await self._device_directory(user, server, client)
        await self._rename_stored_device_ids(user, server, devices)

        try:
            async for page in client.iter_history(account_id=account_id, since=since):
                for entry in page:
                    if await self._ingest_history_entry(
                        user, server, entry, repo, client, devices=devices
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

    async def _device_directory(
        self, user: User, server: PlexServer, client: PlexServerClient
    ) -> dict[str, tuple[str | None, str | None]]:
        """`deviceID` -> (device name, player name), fetched once per run.

        A history row names its client as a bare integer, so every row would
        otherwise need its own lookup — hundreds of requests in seconds on top
        of the hundreds the import already makes, which is precisely the burst
        that took DNS resolution down for the whole container once already.
        One call answers for every row, and the answer is cached on the service
        instance, which lives exactly as long as the run.

        The failure is cached too. An empty directory is the common answer for
        a shared-library user — `/devices` may be owner-only — and re-asking a
        server that just said no, once per history row, is the same burst by
        another name.
        """
        cache_key = (user.id, server.id)
        if cache_key in self._devices:
            return self._devices[cache_key]

        directory: dict[str, tuple[str | None, str | None]] = {}
        try:
            for device in await client.devices():
                directory[device.id] = (device.name, device.platform)
        except Exception as exc:
            # Deliberately everything. A device name is cosmetic — it decorates
            # a play that is recorded correctly without it — and no cosmetic
            # lookup may be able to fail a history import. `devices()` already
            # declines to record a transport failure against the backoff, so
            # this catches the rest: a malformed body, an unexpected shape, a
            # client that has no such call.
            log.debug("Could not read the device list from %s: %s", server.name, exc)

        self._devices[cache_key] = directory
        return directory

    async def _rename_stored_device_ids(
        self,
        user: User,
        server: PlexServer,
        devices: dict[str, tuple[str | None, str | None]],
    ) -> None:
        """Turn the numeric `device` values already stored into names.

        Every play imported before this change holds `str(deviceID)` in
        `device` — a server-local integer sitting in the same column as
        "Living Room TV", which is what made a "where do you watch" chart
        unreadable. There is no migration for it: the history sync reads
        incrementally and never revisits a 2019 play, so nothing would rewrite
        those rows. This does, on the one path that already holds both the
        device table and the user's own token, at no extra network cost.

        Two guards keep it honest:

        * It runs **only** when the server actually answered with devices. An
          empty directory means "could not ask" as much as "no devices", and
          clearing names on the strength of a question that was never answered
          would destroy what a later owner-token run could have recovered.
        * An id the server no longer lists is cleared rather than kept. It is a
          foreign key into a table that has dropped it: no reader can resolve
          it, and left in place it goes on polluting the axis forever. The play
          itself — its time, item, duration and library — is untouched.

        It terminates: after one pass no numeric `device` remains for this
        (user, server), so later runs do one scan that finds nothing.
        """
        if not devices:
            return

        stored = await self.db.execute(
            select(WatchEvent.device)
            .where(
                WatchEvent.user_id == user.id,
                WatchEvent.server_id == server.id,
                WatchEvent.device.is_not(None),
            )
            .distinct()
        )
        numeric = [value for value in stored.scalars() if value and value.isdigit()]
        if not numeric:
            return

        renamed = 0
        cleared = 0
        for device_id in numeric:
            name, platform = devices.get(device_id, (None, None))
            await self.db.execute(
                update(WatchEvent)
                .where(
                    WatchEvent.user_id == user.id,
                    WatchEvent.server_id == server.id,
                    WatchEvent.device == device_id,
                )
                .values(
                    device=name,
                    # Never overwrite a player a webhook already named; these
                    # rows have none, but adoption means some might.
                    player=func.coalesce(WatchEvent.player, platform),
                )
            )
            if name:
                renamed += 1
            else:
                cleared += 1
        await self.db.commit()
        log.info(
            "Normalised stored device ids on %s: %d resolved to a name, %d "
            "cleared as unresolvable",
            server.name,
            renamed,
            cleared,
        )

    async def _ingest_history_entry(
        self,
        user: User,
        server: PlexServer,
        entry: dict[str, Any],
        repo: MediaRepository,
        client: PlexServerClient,
        *,
        devices: dict[str, tuple[str | None, str | None]] | None = None,
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
            #
            # The test used to be "does the entry have a guid at all", and a
            # modern Plex history row always does — the `plex://` form, which
            # names the item to this server and to nothing else. So the fetch
            # was skipped, `build_guid_key` fell through to `plex:<key>`, and a
            # film the library already held as `tmdb:movie:603` got a *second*
            # row carrying only what a history row has: a title and an air
            # date. No year, no ids, no artwork path, no way for enrichment to
            # identify it later, and no way for `merge_duplicates` to see it —
            # that pass needs an external id on both rows. On a real instance
            # this was 372 of 4796 rows, each one a duplicate with a permanent
            # placeholder where its poster should be.
            #
            # This is the same fault the Discover watchlist had, and it has the
            # same answer: always ask for guids before minting an identity.
            meta = entry
            if rating_key and not extract_ids(entry).identifying:
                try:
                    fetched = await client.metadata(rating_key)
                except PlexServerError:
                    fetched = None
                meta = fetched or entry

            # The `identifying` test decided whether to ask Plex for more. It
            # has to decide whether we may *create* something too, because the
            # answer can still be no afterwards — and for the rows that started
            # this, it never even ran. Plex drops `ratingKey` from a history row
            # whose metadata item it no longer holds, leaving a snapshot of the
            # play: a title, an air date, nothing else. With no key there is
            # nothing to re-fetch and nothing to look up a mapping by, so the
            # snapshot went straight to `upsert_from_plex` and became a second
            # row for a film still sitting in the library.
            #
            # Look for that row first. When there is none the mint is correct
            # and goes ahead: a play of something since deleted from Plex is
            # history that should outlive the file, and those rows are the
            # majority here.
            if not extract_ids(meta).identifying:
                item = await repo.existing_match_for_thin_payload(meta)
            if item is None:
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

        # The same play may already be here from a webhook. Webhooks carry no
        # history key, so their dedupe key is a minute bucket that can never
        # match the authoritative `plex:` one — which meant every scrobble on a
        # Plex Pass instance was recorded twice, showing two rows in the history
        # list and counting the view twice, since record_watch_state increments.
        # Adopt the webhook's row instead of adding a second.
        adopted = await self.db.execute(
            select(WatchEvent)
            .where(
                WatchEvent.user_id == user.id,
                WatchEvent.media_item_id == item.id,
                WatchEvent.source == WatchSource.PLEX_WEBHOOK,
                WatchEvent.watched_at >= viewed_at - timedelta(minutes=2),
                WatchEvent.watched_at <= viewed_at + timedelta(minutes=2),
            )
            .limit(1)
        )
        # Which library the play came from. The mapping is the only thing that
        # knows — a history row does not say — and it is resolved here, at the
        # one moment an event is written, rather than joined at read time:
        # WatchEvent -> MediaItem -> PlexMapping is one-to-many, so an item held
        # on two servers multiplies every play by two in a per-library total.
        #
        # None is the honest answer for a play whose item Plex no longer holds,
        # and for every row imported before this column existed. Those stay
        # NULL; there is no backfill, because the mapping a 2019 play went
        # through may not exist any more.
        library_id = (
            await repo.library_id_for(server.id, rating_key) if rating_key else None
        )
        device, player = _watch_context(entry, devices or {})

        if (event := adopted.scalar_one_or_none()) is not None:
            event.dedupe_key = dedupe_key
            event.source = WatchSource.PLEX_HISTORY
            event.watched_at = viewed_at
            event.duration_ms = event.duration_ms or _duration_ms(entry.get("duration"))
            event.server_id = event.server_id or server.id
            # A webhook names no library, so adopting its row is the only chance
            # that play has to gain one.
            event.library_id = event.library_id or library_id
            # Both writers speak the same vocabulary now, so an adopted row must
            # not end up holding whichever one happened to touch it last. The
            # history import's names come from the server's own device table and
            # are the better answer where it has one; the webhook's stand where
            # it does not, which is every row on a server that will not serve
            # `/devices`.
            event.device = device or event.device
            event.player = player or event.player
            await self.db.flush()
            return False

        self.db.add(
            WatchEvent(
                user_id=user.id,
                media_item_id=item.id,
                watched_at=viewed_at,
                source=WatchSource.PLEX_HISTORY,
                dedupe_key=dedupe_key,
                completed=True,
                duration_ms=_duration_ms(entry.get("duration")),
                server_id=server.id,
                library_id=library_id,
                # Names, never the id — see `_watch_context`. `device` used to
                # hold `str(deviceID)`, which is why the two writers could not
                # be grouped together.
                device=device,
                player=player,
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

    async def _section_ratings(
        self, client: PlexServerClient, server: PlexServer
    ) -> dict[str, float | None]:
        """Map ratingKey -> the viewer's rating, for every movie and show.

        Read through the paged section listings rather than per item. A missing
        key means "we did not see it"; a None value means "seen, and unrated",
        and the two must stay distinguishable or an unreadable library would
        look like the user had cleared every rating in it.
        """
        result = await self.db.execute(
            select(PlexLibrary).where(
                PlexLibrary.server_id == server.id,
                PlexLibrary.enabled.is_(True),
            )
        )
        ratings: dict[str, float | None] = {}
        for library in result.scalars():
            for item_type in (TYPE_MOVIE, TYPE_SHOW):
                async for page in client.iter_section_items(
                    library.section_key, item_type
                ):
                    for meta in page:
                        key = str(meta.get("ratingKey") or "")
                        if not key:
                            continue
                        raw = meta.get("userRating")
                        ratings[key] = float(raw) if raw not in (None, "") else None
        return ratings

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
        if not rows:
            return

        # One query for every state, not one per item.
        states_result = await self.db.execute(
            select(UserMediaState).where(
                UserMediaState.user_id == user.id,
                UserMediaState.media_item_id.in_([item.id for item, _ in rows]),
            )
        )
        states = {state.media_item_id: state for state in states_result.scalars()}

        # Ratings come from the section listings, which carry `userRating` on
        # every entry. This used to be one client.metadata() call per item per
        # sync — 4,000 HTTP round trips for a 4,000-film library, every sync
        # interval. That is the traffic shape that took a live instance's DNS
        # down after a few hundred lookups; paging a section is ~1/200th of it.
        try:
            remote_ratings = await self._section_ratings(client, server)
        except PlexServerError as exc:
            stats.errors.append(f"{server.name} ratings: {exc}")
            return

        for item, mapping in rows:
            state = states.get(item.id)

            if mapping.rating_key not in remote_ratings:
                # Not in any section we could read: no evidence either way, so
                # leave the pair alone rather than treating it as "unrated".
                continue
            remote = remote_ratings[mapping.rating_key]

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
                # `local is None` means the user cleared the rating, which is a
                # change like any other. Guarding on `is not None` meant a clear
                # was never pushed and never baselined, so it re-evaluated on
                # every sync forever. Plex has no unrate — 0 is the clear, the
                # same convention push_rating already uses.
                if await client.rate(mapping.rating_key, local if local is not None else 0.0):
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
                if prefer_local:
                    # Again, a cleared rating is a local value worth defending:
                    # falling through to the else branch here wrote Plex's old
                    # rating back over the user's deliberate clear.
                    if await client.rate(
                        mapping.rating_key, local if local is not None else 0.0
                    ):
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

            # Same reasoning as the history import: with no account id there is
            # nothing to attribute playback by, and skipping the filter would
            # put every other viewer's session into this user's Continue
            # Watching.
            if access is None or access.plex_account_id is None:
                continue

            repo = MediaRepository(self.db, enrich=False)
            for session in sessions:
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

    async def backfill_missing_metadata(self, stats: SyncStats) -> int:
        """Give rows that never got an identity another chance at one.

        Enrichment normally hangs off an import, so a row nothing imports any
        more is never revisited: a library scan only sees what Plex still holds,
        and the watchlist pass only sees the watchlist. A row created from a
        thin payload — a title, maybe an air date, no external id and no artwork
        — therefore keeps its blank tile forever. On a real instance that was
        372 of 4796 rows, most of them a duplicate of a title sitting next to
        them with its poster intact.

        Bounded per run, because each item is a provider call: a backlog drains
        over several syncs rather than turning one into an hour of TMDB traffic.
        Items are chosen oldest-attempt-first so the queue rotates instead of
        retrying the same hopeless titles every time.

        There is a second, narrower arm. A row that *does* have an id is out of
        scope for the first — nothing re-searches a row to take an id away — but
        it can still be missing everything the sink learned to keep later:
        language, origin country, and a studio or network the sticky sink left
        blank. `db._resweep_incomplete_metadata` marks those at startup by
        moving `metadata_updated_at` back to `METADATA_RESWEEP_MARK`, and this
        is what picks them up. It is the same bounded queue on purpose: the
        alternative was re-enriching a whole catalogue in one burst.

        This only ever *adds* what it learns. Collapsing the duplicate pair it
        exposes is `merge_duplicates`' job — that is the pass allowed to delete,
        and it stays the only one — but it is invoked from here, because this is
        the moment its work comes into existence. It can only pair rows on an
        external id, and until this pass attaches one there is nothing for it to
        see. Left to the startup call alone the heal would be half-finished: the
        artwork would come back and the phantom row would sit beside it, still
        claiming not to be on your server, until the next restart — which on a
        self-hosted box may be the next upgrade, weeks away.
        """
        cutoff = utcnow() - ARTWORK_RETRY_INTERVAL
        # No identity from any provider — `plex_guid` is not one, which is the
        # whole reason these rows exist.
        no_identity = and_(
            MediaItem.tmdb_id.is_(None),
            MediaItem.tvdb_id.is_(None),
            MediaItem.imdb_id.is_(None),
            MediaItem.mal_id.is_(None),
            MediaItem.anilist_id.is_(None),
        )
        never_identified = and_(
            no_identity,
            MediaItem.poster_url.is_(None),
            MediaItem.discover_thumb_path.is_(None),
            or_(
                MediaItem.metadata_updated_at.is_(None),
                MediaItem.metadata_updated_at < cutoff,
            ),
        )
        # The second arm: rows `db._resweep_incomplete_metadata` marked as
        # holding an answer older than the columns Tally now stores. It selects
        # on the mark and on nothing else, which is what makes it terminate —
        # one pass through the sink stamps `utcnow()` and the row is out for
        # good. Selecting on the missing columns themselves would not: TMDB
        # lists no `origin_country` and no `networks` for a film, so every movie
        # in the library would come back here every week, forever.
        resweep = and_(
            MediaItem.metadata_updated_at.is_not(None),
            MediaItem.metadata_updated_at <= METADATA_RESWEEP_MARK,
        )
        result = await self.db.execute(
            select(MediaItem)
            .where(
                MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW]),
                # A home video has no answer waiting at any provider, so it
                # would sit in this queue forever, costing a call a week and a
                # slot in a batch that is bounded on purpose. `enrich_existing`
                # is what marks the ones already stored, so each costs exactly
                # one more pass through here and then drops out.
                MediaItem.is_personal_media.is_(False),
                or_(never_identified, resweep),
            )
            # Artwork first. A blank tile is something a user sees and reports;
            # a missing `original_language` is not, and a resweep queued at
            # upgrade time is large enough to bury the handful of rows that have
            # no identity at all if the two shared one ordering.
            .order_by(
                case((no_identity, 0), else_=1),
                MediaItem.metadata_updated_at.asc().nulls_first(),
                MediaItem.id,
            )
            .limit(METADATA_BACKFILL_BATCH)
        )
        items = list(result.scalars())
        if not items:
            return 0

        repo = MediaRepository(self.db)
        identified = 0
        await self._progress(0, total=len(items))
        for index, item in enumerate(items, start=1):
            await self._checkpoint()
            # Counted as a win only when the row *gained* artwork. A resweep row
            # usually has a poster already, and letting those count would both
            # inflate the number and call the duplicate merge on every sync.
            had_artwork = bool(item.poster_url or item.discover_thumb_path)
            if await repo.enrich_existing(item) and not had_artwork:
                identified += 1
            await self._progress(index)
        await self.db.commit()

        log.info(
            "Backfilled metadata for %s of %s item(s) that had no artwork",
            identified,
            len(items),
        )
        stats.metadata_backfilled = identified

        if identified:
            await self._merge_duplicates_now()
        return identified

    async def backfill_credits(self, stats: SyncStats) -> int:
        """Fetch cast and crew for titles nobody has opened the detail page of.

        `services/credits.py` argues against fetching credits during a library
        scan, and that argument still holds — a call per row, inline, against a
        rate-limited provider, over tens of thousands of rows. This is not that.
        It is a separate phase that runs *after* the scan, so scan progress stays
        a count of the library rather than of provider calls, and it is capped at
        `CREDITS_BACKFILL_BATCH` per run like the metadata backfill beside it.

        The ordering is what makes the cap tolerable. Actor and director stats
        are about what you have *watched*, so watched titles come first, then
        what you have watchlisted, then the rest of the library. The few thousand
        rows those stats actually read are covered in the first few syncs and the
        long tail drains behind them, instead of the queue starting at whichever
        title happens to have the lowest id.

        Only rows with a `tmdb_id` are selected, and that is load-bearing rather
        than an optimisation: `credits.fetch_credits` deliberately does *not* stamp a row
        it cannot ask about, so an id-less row would be picked, cost nothing,
        stamp nothing, and be picked again on every future run — a permanent
        hundred-row blockage in front of the titles that can be answered.
        """
        service = get_metadata_service()
        if not service.tmdb.enabled:
            # Nothing to ask. Every row would come back unstamped (by design),
            # so this would be a hundred pointless selects a sync, forever.
            return 0

        # "Relevance" for a global row, since credits are stored per item and
        # not per user: watched by anybody here, then watchlisted by anybody,
        # then everything else. A show's own state carries its watched-episode
        # count (see `recompute_show_state`), so a series that is being watched
        # an episode at a time sorts with the films.
        watched = exists(
            select(UserMediaState.id).where(
                UserMediaState.media_item_id == MediaItem.id,
                UserMediaState.view_count > 0,
            )
        )
        watchlisted = exists(
            select(WatchlistEntry.id).where(
                WatchlistEntry.media_item_id == MediaItem.id,
                WatchlistEntry.active.is_(True),
            )
        )
        result = await self.db.execute(
            select(MediaItem)
            .where(
                # Same scope as enrichment, and for the same reason: a season or
                # an episode is reached through its show.
                MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW]),
                MediaItem.tmdb_id.is_not(None),
                # "Nobody has asked yet" — the one state this pass exists to
                # clear. `credits_updated_at` is set either way afterwards, so a
                # title TMDB has no cast for leaves the queue too.
                MediaItem.credits_updated_at.is_(None),
            )
            .order_by(
                case((watched, 0), (watchlisted, 1), else_=2),
                MediaItem.id,
            )
            .limit(CREDITS_BACKFILL_BATCH)
        )
        items = list(result.scalars())
        if not items:
            return 0

        fetched = 0
        await self._progress(0, total=len(items))
        for index, item in enumerate(items, start=1):
            await self._checkpoint()
            if service.tmdb.paused:
                # The provider's circuit breaker is open. Stopping matters more
                # here than on the detail page: `fetch_credits` stamps a row
                # whose answer was "nothing", and a refused call looks exactly
                # like one — so carrying on would mark a hundred titles as
                # having no cast and never ask about them again.
                log.info("Stopping the credits backfill: TMDB is in cooldown")
                break
            if await fetch_credits(self.db, item, metadata_service=service):
                fetched += 1
            await self._progress(index)

        log.info("Fetched credits for %s of %s title(s)", fetched, len(items))
        stats.credits_fetched = fetched
        return fetched

    async def _merge_duplicates_now(self) -> None:
        """Collapse pairs the backfill has just made visible.

        Nothing about how timid that pass is changes: it still needs a matching
        external id *and* a matching normalised title, and it is still
        idempotent, so calling it here rather than only at startup does not make
        it any more willing to delete — it only stops the answer waiting for a
        restart.

        A failure here must not fail the sync. The artwork this run recovered is
        already committed and is the larger half of the win; an uncollapsed
        duplicate is visible and can be merged on the next pass, which is the
        trade `merge_duplicates` is written around.
        """
        from ..merge_duplicates import merge_duplicate_media_items

        try:
            merged = await merge_duplicate_media_items(self.db)
        except Exception:
            log.exception("Could not merge duplicates after the metadata backfill")
            await self.db.rollback()
            return
        if merged:
            log.info("Merged %s duplicate row(s) the backfill made matchable", merged)

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
                # Which server this is goes in the text, like the library scan
                # below. As a counter it was "1 of 1" on the common one-server
                # setup — a full bar before any work had been done.
                await self._set_phase(
                    f"Reading libraries on {server.name}"
                    + (f" ({index} of {len(servers)})" if len(servers) > 1 else "")
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

            await self._checkpoint()
            await self._set_phase("Filling in missing artwork")
            await self.backfill_missing_metadata(stats)

            await self._checkpoint()
            # After the scan, never inside it: the scan's counter is a count of
            # library items, and a credits call per row would both slow it down
            # and make its progress mean something else.
            await self._set_phase("Fetching cast and crew")
            await self.backfill_credits(stats)

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
            try:
                await self.db.commit()
            except Exception:
                # The session may be poisoned by whatever failed above, in
                # which case this commit raises too and the run is never marked
                # finished — leaving a row that blocks every future sync. Roll
                # back and write the terminal status on a clean session.
                log.exception("Could not record the outcome of the sync run")
                await self.db.rollback()
                run.finished_at = utcnow()
                run.status = SyncStatus.FAILED
                try:
                    await self.db.commit()
                except Exception:
                    log.exception("Sync run %s left unfinished", run.id)
            self._run = None
        return run

    async def has_unfinished_run(self, user: User) -> bool:
        """Whether a sync is already in flight for this user."""
        result = await self.db.execute(
            select(SyncRun.id).where(
                SyncRun.user_id == user.id, SyncRun.finished_at.is_(None)
            )
        )
        return result.scalars().first() is not None


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
            # max_instances=1 only serialises the scheduler against itself. A
            # user pressing Sync mid-job would otherwise get a second run over
            # the same libraries on a different session — duplicated Plex
            # traffic, and cross-session races on the unique guid_key.
            if await service.has_unfinished_run(user):
                log.info(
                    "Skipping scheduled sync for %s: one is already running",
                    user.username,
                )
                continue
            await service.full_sync(user, full_history=full_history)
        except Exception:
            log.exception("Scheduled sync failed for %s", user.username)
        # Be a polite neighbour to the Plex server between accounts.
        await asyncio.sleep(1)
