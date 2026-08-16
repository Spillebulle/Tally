"""Client for a Plex Media Server (PMS).

Everything here speaks to a user's own server rather than plex.tv. The client
handles connection failover: plex.tv advertises several URIs per server (local,
remote, relay) and only some will be reachable from inside a Docker container,
so we try them in order and remember the one that worked.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

from .plex_tv import plex_headers

log = logging.getLogger(__name__)

# Plex library "type" numbers used across its API.
TYPE_MOVIE = 1
TYPE_SHOW = 2
TYPE_SEASON = 3
TYPE_EPISODE = 4


# The only Plex item types that represent watching something in the library.
# Trailers, behind-the-scenes featurettes and other extras come back as
# `clip` — often carrying the parent film's title and artwork — so anything
# that treats a session or history row as "the user watched this" has to
# filter on type first, or playing a two-minute trailer marks the film watched.
PLAYABLE_TYPES = frozenset({"movie", "episode"})


def is_real_playback(meta: dict[str, Any]) -> bool:
    """True when this Plex item is a library item rather than an extra."""
    if str(meta.get("type") or "").lower() not in PLAYABLE_TYPES:
        return False
    # Extras can also be reported with a library type but an extra marker set.
    return not meta.get("extraType") and not meta.get("subtype")


class PlexServerError(RuntimeError):
    pass


class PlexUnreachable(PlexServerError):
    pass


@dataclass(slots=True)
class PlexSession:
    rating_key: str
    account_id: int | None
    user_title: str | None
    state: str  # playing / paused / buffering
    view_offset_ms: int
    duration_ms: int
    player: str | None
    device: str | None
    session_key: str | None


# ---------------------------------------------------------------------------
# What "device" and "player" mean
# ---------------------------------------------------------------------------
#
# `WatchEvent.device` and `WatchEvent.player` are written by three paths that
# each see a different shape of Plex payload — the history import, the webhook,
# and (indirectly) the session poller — and they used to disagree about which
# column held what. The history import wrote `device=str(entry["deviceID"])`, a
# server-local integer, and never set `player` at all; the webhook wrote
# `device=Player.product` and `player=Player.title`, i.e. the opposite way round
# from `PlexSession`. Group by either column and the axis mixed "12345" with
# "Plex for Apple TV" with "Living Room TV".
#
# One meaning each, and both writers obey it:
#
#   device -> the *thing in the room*. The client's own name: "Living Room TV",
#             "Sam's iPhone", "SHIELD Android TV".
#   player -> the *app* it was played through: "Plex for Apple TV", "Plex Web".
#             Falls back to the platform ("Roku", "iOS") when Plex only names
#             that, which is all `/devices` offers.
#
# Neither column ever holds a numeric id again. A `deviceID` is a foreign key
# into one server's device table, meaningless to a reader and impossible to
# group with anything, so when it cannot be resolved to a name the column stays
# NULL — see `SyncService._device_directory`.
#
# Both are cosmetic. Nothing keys, dedupes or filters on them, so every path
# here degrades to None rather than failing.

# `WatchEvent.device` / `.player` are String(255).
_NAME_MAX = 255


def _name(value: Any) -> str | None:
    """A display name out of a Plex payload, or nothing."""
    if value is None:
        return None
    text = str(value).strip()
    return text[:_NAME_MAX] if text else None


def player_identity(block: Any) -> tuple[str | None, str | None]:
    """`(device, player)` out of a Plex `Player` block, per the rule above.

    Sessions carry `device`, `title`, `product` and `platform`; a webhook's
    `Player` carries only `title` (and `uuid`), which is why `title` is the
    device fallback rather than the player one — it names the client, not the
    app. Reading it as the app is exactly the swap this function exists to stop.

    Takes `Any` rather than a dict because one of its callers is the webhook,
    where the whole payload is attacker-supplied and a `"Player": []` would
    otherwise be an `AttributeError` — i.e. a 5xx, which is the one answer that
    makes Plex retry and then disable the webhook.
    """
    if not isinstance(block, dict):
        return None, None
    device = _name(block.get("device")) or _name(block.get("title"))
    player = _name(block.get("product")) or _name(block.get("platform"))
    return device, player


@dataclass(slots=True)
class PlexDevice:
    """One row of the server's own device list (`/devices`)."""

    id: str
    name: str | None
    platform: str | None


def _ts(value: Any) -> datetime | None:
    """Plex hands out unix seconds; normalise to aware UTC datetimes."""
    if value in (None, "", 0):
        return None
    try:
        return datetime.fromtimestamp(int(value), tz=UTC)
    except (ValueError, OSError, TypeError):
        return None


# Failure state lives at module level on purpose: SyncService builds a fresh
# PlexServerClient for every run, so anything stored on the instance is
# forgotten between polls — which is exactly how a server that is down ends up
# being re-probed at full rate forever.
_COOLDOWN_BASE_SECONDS = 30.0
_COOLDOWN_MAX_SECONDS = 300.0
_failures: dict[str, tuple[int, float]] = {}

# The URI that last answered, per server, shared by the whole process for the
# same reason the connection pool is.
#
# `working_url` on the instance only helps a client that makes several calls.
# The artwork proxy builds a *fresh* client per request, and a grid of posters
# is forty requests at once — so forty walks of the candidate list, every one of
# them starting at a URI that may not be the one that works. Plex advertises a
# URI per address it can see, so the walk is long, and each dead candidate costs
# a connect timeout before the next is tried. Remembering the answer across
# clients turns that back into one connection.
_working_urls: dict[str, str] = {}


def reset_failure_state() -> None:
    """Forget every recorded failure. For tests and for an explicit retry."""
    _failures.clear()
    _working_urls.clear()


# One HTTP client for the whole process, so connections stay alive *between*
# calls and not just within one.
#
# A client per call means a connection per call, and a connection per call means
# a DNS lookup per call. A history import asks Plex about every entry it has not
# seen before, which on a first run is hundreds of requests in a few seconds —
# enough to trip a rate-limiting resolver (Pi-hole's default is 1000 queries a
# minute, shared by every container behind the same bridge address). Once
# tripped, name resolution fails for *everything*: the observed symptom was the
# Plex server and plex.tv both becoming unresolvable mid-sync, seconds apart.
#
# Keep-alive turns those hundreds of lookups into one per host.
_pooled_client: httpx.AsyncClient | None = None


def _pool() -> httpx.AsyncClient:
    global _pooled_client
    if _pooled_client is None or _pooled_client.is_closed:
        _pooled_client = httpx.AsyncClient(
            # Plex servers routinely present self-signed certificates.
            verify=False,
            follow_redirects=True,
            limits=httpx.Limits(
                max_keepalive_connections=20,
                max_connections=40,
                # Comfortably longer than the gap between polls, so an idle
                # Tally does not re-resolve on every scheduled sync.
                keepalive_expiry=120.0,
            ),
        )
    return _pooled_client


async def close_pool() -> None:
    """Drop the shared client. Called on shutdown, and by tests for isolation."""
    global _pooled_client
    client, _pooled_client = _pooled_client, None
    if client is not None:
        with contextlib.suppress(Exception):
            await client.aclose()


class PlexServerClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        candidate_urls: list[str] | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.candidates = [u.rstrip("/") for u in (candidate_urls or []) if u]
        if self.base_url and self.base_url not in self.candidates:
            self.candidates.insert(0, self.base_url)
        self._timeout = timeout
        # Set once a URI answers, so subsequent calls skip the failover loop.
        self.working_url: str | None = None

    # -- transport --------------------------------------------------------

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        retries: int = 1,
        record_failures: bool = True,
    ) -> httpx.Response | None:
        """Make one call, walking the candidate URIs until one answers.

        `record_failures=False` still *honours* the backoff — a server that is
        down should fail fast, not re-walk every candidate — but does not add to
        it. High-volume, best-effort traffic like artwork uses that: dozens of
        poster requests per page must not be able to declare the server dead and
        take the sync down with them.
        """
        params = {**(params or {})}

        # A server advertises one URI per address it can see, and a Plex install
        # that is itself in Docker advertises every bridge gateway on its host —
        # seven or eight candidates is normal. Walking all of them costs a DNS
        # lookup each (two, counting the AAAA), so probing a server that is down
        # is expensive. Once a full walk has failed, wait before doing it again
        # instead of repeating it on every poll.
        key = self.candidates[0] if self.candidates else self.base_url
        count, retry_after = _failures.get(key, (0, 0.0))
        now = time.monotonic()
        if now < retry_after:
            raise PlexUnreachable(
                f"Plex server unreachable; not retrying for another "
                f"{retry_after - now:.0f}s ({count} consecutive failures)"
            )

        # Whichever URI last answered goes first, then the rest as fallbacks in
        # case it has gone away.
        remembered = self.working_url or _working_urls.get(key)
        urls = list(self.candidates) or [self.base_url]
        if remembered:
            urls = [remembered] + [u for u in urls if u != remembered]

        last_error: Exception | None = None
        # True once some URI has answered with a status we could read. "The
        # server said no" and "nothing was reachable" look the same to a caller
        # that only sees an exception, and they call for opposite responses:
        # one is worth a different request, the other is not worth any.
        answered = False

        # One pooled client for the whole process — see `_pool()`.
        client = _pool()
        for url in urls:
            if not url:
                continue
            for attempt in range(retries + 1):
                try:
                    resp = await client.request(
                        method,
                        f"{url}{path}",
                        headers=plex_headers(self.token),
                        params=params,
                        timeout=self._timeout,
                    )
                except (httpx.TransportError, httpx.TimeoutException) as exc:
                    last_error = exc
                    if attempt < retries:
                        await asyncio.sleep(0.5 * (attempt + 1))
                    continue

                if resp.status_code == 401:
                    raise PlexServerError("Server rejected the access token")
                if resp.status_code == 404:
                    return None
                if resp.status_code >= 500:
                    answered = True
                    last_error = PlexServerError(f"Server error {resp.status_code}")
                    break  # try the next URI rather than hammering a sick server

                self.working_url = url
                _working_urls[key] = url
                _failures.pop(key, None)
                return resp

        # Every candidate failed. Back off before the next full walk, doubling
        # each time, so a server that stays down costs one probe per cooldown
        # rather than one per poll.
        if record_failures:
            count += 1
            delay = min(
                _COOLDOWN_MAX_SECONDS, _COOLDOWN_BASE_SECONDS * 2 ** (count - 1)
            )
            _failures[key] = (count, time.monotonic() + delay)
            log.warning(
                "Plex server unreachable after trying %s connection URI(s); "
                "backing off for %.0fs. Last error: %s",
                len(urls),
                delay,
                last_error,
            )
        if answered:
            # Reached the server; it just answered badly. Not `PlexUnreachable`,
            # because a caller with a second thing to ask — the artwork proxy has
            # the untranscoded asset to fall back on — should still ask it.
            raise PlexServerError(f"Plex server returned an error: {last_error}")
        raise PlexUnreachable(
            f"No reachable connection for Plex server (tried {len(urls)}): {last_error}"
        )

    async def _get_json(
        self,
        path: str,
        params: dict | None = None,
        *,
        record_failures: bool = True,
    ) -> dict[str, Any]:
        resp = await self._request(
            "GET", path, params=params, record_failures=record_failures
        )
        if resp is None:
            return {}
        try:
            return resp.json()
        except ValueError:
            return {}

    async def _container(
        self,
        path: str,
        params: dict | None = None,
        *,
        record_failures: bool = True,
    ) -> dict[str, Any]:
        payload = await self._get_json(path, params, record_failures=record_failures)
        return payload.get("MediaContainer", {}) or {}

    # -- basics -----------------------------------------------------------

    async def identity(self) -> dict[str, Any]:
        return await self._container("/identity")

    async def ping(self) -> bool:
        try:
            await self.identity()
            return True
        except PlexServerError:
            return False

    async def accounts(self) -> list[dict[str, Any]]:
        """Server-side account list. Maps plex.tv users to server accountIDs."""
        return (await self._container("/accounts")).get("Account", []) or []

    async def devices(self) -> list[PlexDevice]:
        """The server's own device table — what a history row's `deviceID` names.

        A history row identifies the client as a bare integer and nothing else,
        so this is the only way to turn 12345 into "Living Room TV". One call
        answers for the whole history; callers must fetch it **once per run**
        and cache it (see `SyncService._device_directory`), never once per row —
        a history import is hundreds of requests in seconds already, and the
        incident recorded in CLAUDE.md is what happens when that number grows.

        Best-effort, in both directions. `record_failures=False` keeps a device
        list Plex will not serve — this may well be owner-only, and a non-owner
        token gets a 403 with an HTML body that `_get_json` turns into `{}` —
        from tripping the unreachable-server backoff and taking the sync with
        it. An empty list therefore means "could not ask" as much as "no
        devices", and both answers are handled the same way: no name, no harm.
        """
        container = await self._container("/devices", record_failures=False)
        out: list[PlexDevice] = []
        for entry in container.get("Device", []) or []:
            device_id = entry.get("id")
            if device_id is None:
                continue
            out.append(
                PlexDevice(
                    id=str(device_id),
                    name=_name(entry.get("name")),
                    platform=_name(entry.get("platform")),
                )
            )
        return out

    async def preferences(self) -> dict[str, Any]:
        """Server settings, keyed by their Plex id.

        Only the owner's token may read these. A shared user gets a 403 with an
        HTML body, which `_get_json` turns into an empty container — so an empty
        dict means "not allowed to ask" as much as "nothing set".
        """
        raw = (await self._container("/:/prefs")).get("Setting", []) or []
        return {entry["id"]: entry.get("value") for entry in raw if entry.get("id")}

    async def on_deck_window_weeks(self) -> int | None:
        """Plex's "Weeks to consider for On Deck and Continue Watching".

        This is the setting that makes a show you stopped watching two years ago
        fall off the Plex hub; Tally mirrors it so Continue Watching agrees with
        Plex. Defaults to 16 on the server side. `None` means the server did not
        tell us, usually because this is not the owner's token.
        """
        prefs = await self.preferences()
        value = prefs.get("onDeckWindow")
        if value is None:
            # Ids are stable but the casing is not documented anywhere.
            value = next(
                (v for k, v in prefs.items() if k.lower() == "ondeckwindow"), None
            )
        try:
            weeks = int(value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None
        return weeks if weeks >= 0 else None

    # -- libraries --------------------------------------------------------

    async def sections(self) -> list[dict[str, Any]]:
        return (await self._container("/library/sections")).get("Directory", []) or []

    async def section_total(self, section_key: str, item_type: int) -> int:
        """How many items of one type a section holds, without fetching any.

        Asking for a zero-length container still reports `totalSize`, so this is
        one cheap request. Returns 0 when the server does not say — the caller
        must treat that as "unknown", not as "empty".
        """
        container = await self._container(
            f"/library/sections/{section_key}/all",
            {
                "type": item_type,
                "X-Plex-Container-Start": 0,
                "X-Plex-Container-Size": 0,
            },
        )
        try:
            return max(0, int(container.get("totalSize")))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return 0

    async def iter_section_items(
        self, section_key: str, item_type: int, page_size: int = 200
    ):
        """Yield every item in a library section, one page at a time.

        Libraries can hold tens of thousands of episodes, so this is a generator
        rather than a list — the sync engine commits each page as it goes.
        """
        offset = 0
        while True:
            container = await self._container(
                f"/library/sections/{section_key}/all",
                {
                    "type": item_type,
                    "X-Plex-Container-Start": offset,
                    "X-Plex-Container-Size": page_size,
                    "includeGuids": 1,
                },
            )
            batch = container.get("Metadata", []) or []
            if not batch:
                return
            yield batch

            offset += len(batch)
            total = container.get("totalSize") or container.get("size") or 0
            if len(batch) < page_size or (total and offset >= total):
                return

    async def metadata(self, rating_key: str) -> dict[str, Any] | None:
        container = await self._container(
            f"/library/metadata/{rating_key}", {"includeGuids": 1}
        )
        items = container.get("Metadata", []) or []
        return items[0] if items else None

    async def children(self, rating_key: str) -> list[dict[str, Any]]:
        container = await self._container(
            f"/library/metadata/{rating_key}/children", {"includeGuids": 1}
        )
        return container.get("Metadata", []) or []

    # -- history & sessions ----------------------------------------------

    async def iter_history(
        self,
        *,
        account_id: int | None = None,
        since: datetime | None = None,
        page_size: int = 500,
    ):
        """Yield pages of watch history, newest first.

        ``since`` maps to Plex's ``viewedAt>`` filter so incremental syncs only
        pull what changed rather than the whole history every 30 minutes.
        """
        offset = 0
        while True:
            params: dict[str, Any] = {
                "sort": "viewedAt:desc",
                "X-Plex-Container-Start": offset,
                "X-Plex-Container-Size": page_size,
                # The one call that used to leave this off, which is exactly
                # backwards: a history row is the *thinnest* payload Plex sends
                # and the one most in need of naming itself. Everything else —
                # the section scan, the metadata re-fetch, the children fetch —
                # has always asked. See the guid_key section in CLAUDE.md: the
                # identity of a source is only as good as the ids you asked it
                # for, and this is the source that had been asked for none.
                "includeGuids": 1,
            }
            if account_id is not None:
                params["accountID"] = account_id
            if since is not None:
                params["viewedAt>"] = int(since.timestamp())

            container = await self._container("/status/sessions/history/all", params)
            raw = container.get("Metadata", []) or []
            if not raw:
                return
            # Drop trailers and extras before they reach the importer.
            batch = [meta for meta in raw if is_real_playback(meta)]
            if batch:
                yield batch

            # Page on the unfiltered count: `batch` may be shorter after extras
            # were dropped, and advancing by that would re-read rows forever.
            offset += len(raw)
            total = container.get("totalSize") or 0
            if len(raw) < page_size or (total and offset >= total):
                return

    async def sessions(self) -> list[PlexSession]:
        container = await self._container("/status/sessions")
        out: list[PlexSession] = []
        for meta in container.get("Metadata", []) or []:
            if not is_real_playback(meta):
                # A trailer or extra. Plex reports it with the parent film's
                # metadata, so counting it would mark the film as watched.
                continue
            user = (meta.get("User") or {})
            player = (meta.get("Player") or {})
            account_id = user.get("id")
            # One rule for both columns, shared with the history import and the
            # webhook — see `player_identity`.
            device_name, player_name = player_identity(player)
            out.append(
                PlexSession(
                    rating_key=str(meta.get("ratingKey")),
                    account_id=int(account_id) if account_id is not None else None,
                    user_title=user.get("title"),
                    state=player.get("state", "unknown"),
                    view_offset_ms=int(meta.get("viewOffset") or 0),
                    duration_ms=int(meta.get("duration") or 0),
                    player=player_name,
                    device=device_name,
                    session_key=str(meta.get("sessionKey")) if meta.get("sessionKey") else None,
                )
            )
        return out

    # -- writes -----------------------------------------------------------

    async def scrobble(self, rating_key: str) -> bool:
        """Mark as fully watched on the server."""
        resp = await self._request(
            "GET",
            "/:/scrobble",
            params={"key": rating_key, "identifier": "com.plexapp.plugins.library"},
        )
        return resp is not None and resp.status_code < 400

    async def unscrobble(self, rating_key: str) -> bool:
        resp = await self._request(
            "GET",
            "/:/unscrobble",
            params={"key": rating_key, "identifier": "com.plexapp.plugins.library"},
        )
        return resp is not None and resp.status_code < 400

    async def rate(self, rating_key: str, rating: float) -> bool:
        """Set a user rating. Plex uses a 0-10 scale (its UI shows 5 stars)."""
        resp = await self._request(
            "GET",
            "/:/rate",
            params={
                "key": rating_key,
                "identifier": "com.plexapp.plugins.library",
                "rating": max(0.0, min(10.0, rating)),
            },
        )
        return resp is not None and resp.status_code < 400

    async def set_progress(self, rating_key: str, offset_ms: int) -> bool:
        resp = await self._request(
            "GET",
            "/:/progress",
            params={
                "key": rating_key,
                "identifier": "com.plexapp.plugins.library",
                "time": offset_ms,
                "state": "stopped",
            },
        )
        return resp is not None and resp.status_code < 400

    # -- helpers ----------------------------------------------------------

    async def image_bytes(
        self, path: str | None, *, width: int = 400, height: int = 600
    ) -> tuple[bytes, str] | None:
        """Fetch a right-sized image, returning (bytes, content-type).

        This deliberately returns bytes rather than a URL. A URL to this server
        carries `X-Plex-Token`, and artwork URLs get stored on rows that every
        Tally account can read — see `routers/images.py`. Going through
        `_request` also means artwork inherits the connection failover instead
        of the browser hanging on a LAN address it cannot route to.

        Two failure modes are worth knowing about, because both look identical
        from the browser (a placeholder gradient):

        * The photo transcoder can refuse a request the server can perfectly
          well answer — it is a separate subsystem with its own limits. So a
          failed transcode falls back to the stored artwork at its original
          size, which is served by the ordinary file handler.
        * A stored path carries a timestamp (`/thumb/1699999999`). When the
          artwork is replaced in Plex the old path 404s until the next library
          scan refreshes it. That is why this logs the status: "no artwork" and
          "Plex said no" need telling apart, and silence made them the same.
        """
        if not path:
            return None

        attempts = (
            (
                "/photo/:/transcode",
                {
                    "width": width,
                    "height": height,
                    "minSize": 1,
                    "upscale": 1,
                    "url": path,
                    # The transcoder resolves `url` with a fetch of its own, and
                    # that inner request does not inherit the outer request's
                    # headers — so the token has to be in the query here or the
                    # transcode is refused. This is Tally talking to Plex
                    # server-side; the rule it looks like it breaks is about
                    # URLs *stored* and handed to browsers, which this is not.
                    "X-Plex-Token": self.token,
                },
            ),
            # The raw asset, untranscoded. Bigger, but it is the same picture.
            (path, None),
        )

        for endpoint, params in attempts:
            try:
                # record_failures=False: artwork is a passenger on this
                # connection, not a probe of it. A refused transcode must not
                # trip the unreachable-server backoff and take the sync down
                # with it.
                resp = await self._request(
                    "GET", endpoint, params=params, record_failures=False
                )
            except PlexUnreachable:
                # Nothing answered. The raw asset lives on the same server, so
                # a second walk of the same dead candidates would only cost
                # time — let the caller move on to another source.
                raise
            except PlexServerError as exc:
                # The transcoder answered with a 5xx, which is the *ordinary*
                # way it refuses: it is a subsystem with its own concurrency
                # limits, and a page asking for forty posters at once will
                # exhaust them while the plain file handler is perfectly happy.
                # This used to escape and skip the fallback below, which made a
                # busy transcoder look like missing artwork — a different
                # scatter of posters on every reload.
                log.info("Plex refused artwork %s via %s: %s", path, endpoint, exc)
                continue
            if resp is not None and resp.status_code < 400:
                return resp.content, resp.headers.get("content-type", "image/jpeg")
            if resp is not None:
                log.info(
                    "Plex refused artwork %s via %s: HTTP %s",
                    path,
                    endpoint,
                    resp.status_code,
                )
        return None


__all__ = [
    "PlexServerClient",
    "PlexServerError",
    "PlexSession",
    "PlexUnreachable",
    "TYPE_EPISODE",
    "TYPE_MOVIE",
    "TYPE_SEASON",
    "TYPE_SHOW",
    "_ts",
]
