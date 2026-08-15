"""Client for the plex.tv cloud APIs.

Covers three things Tally needs from Plex's cloud (as opposed to a user's own
Plex Media Server):

1. **OAuth via PIN** — the flow that lets a user "Sign in with Plex" without ever
   handing us their password.
2. **Resource discovery** — finding which Plex Media Servers an account can reach
   and the per-server access tokens for them.
3. **Discover / Watchlist** — the universal watchlist that lives on plex.tv, not
   on any one server.
"""
from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import httpx

from ..config import get_settings

log = logging.getLogger(__name__)
settings = get_settings()

PLEX_TV = "https://plex.tv"
DISCOVER = "https://discover.provider.plex.tv"
METADATA_PROVIDER = "https://metadata.provider.plex.tv"
AUTH_APP = "https://app.plex.tv/auth"


def plex_headers(token: str | None = None) -> dict[str, str]:
    """Identify Tally to Plex. These headers are required on every call."""
    headers = {
        "Accept": "application/json",
        "X-Plex-Product": settings.plex_product,
        "X-Plex-Version": "1.0.0",
        "X-Plex-Client-Identifier": settings.plex_client_identifier,
        "X-Plex-Platform": settings.plex_platform,
        "X-Plex-Device": settings.plex_device_name,
        "X-Plex-Device-Name": settings.plex_device_name,
        "X-Plex-Model": "hosted",
    }
    if token:
        headers["X-Plex-Token"] = token
    return headers


class PlexTVError(RuntimeError):
    """Anything that went wrong talking to plex.tv."""


class PlexAuthError(PlexTVError):
    """Plex rejected the credentials."""


class PlexUnreachableError(PlexTVError):
    """plex.tv could not be reached at all.

    Distinct from an auth failure: the request never got an answer. In a
    container this is almost always DNS or blocked egress rather than anything
    to do with the user's account, and the fix is completely different.
    """


@dataclass(slots=True)
class WatchlistFetch:
    """A watchlist read, and whether every page of it arrived.

    `complete` is False when a page errored partway through. Sync must not
    mirror removals from an incomplete read — the missing entries are missing
    because Discover broke, not because the user removed them.
    """

    items: list[dict[str, Any]]
    complete: bool


@dataclass(slots=True)
class PlexPinResponse:
    pin_id: str
    code: str
    expires_at: datetime
    auth_url: str


@dataclass(slots=True)
class PlexAccount:
    id: str
    username: str
    email: str | None
    thumb: str | None
    title: str | None
    auth_token: str


@dataclass(slots=True)
class PlexConnection:
    uri: str
    local: bool
    relay: bool
    protocol: str


@dataclass(slots=True)
class PlexResource:
    name: str
    client_identifier: str
    access_token: str
    owned: bool
    product: str
    provides: str
    platform: str | None = None
    version: str | None = None
    connections: list[PlexConnection] = field(default_factory=list)

    def ordered_uris(self) -> list[str]:
        """Best-to-worst connection order.

        Local HTTPS first (fast, no hairpin NAT), then remote direct, then relay
        last — Plex relay is bandwidth-capped and should only be a fallback.
        """
        def rank(c: PlexConnection) -> tuple[int, int]:
            return (
                2 if c.relay else (0 if c.local else 1),
                0 if c.protocol == "https" else 1,
            )

        return [c.uri for c in sorted(self.connections, key=rank)]


class PlexTVClient:
    def __init__(self, timeout: float = 20.0) -> None:
        self._timeout = timeout

    @asynccontextmanager
    async def _http(self) -> AsyncIterator[httpx.AsyncClient]:
        """An httpx client whose transport failures become PlexUnreachableError.

        Every call in this module leaves the machine, so a container with no
        egress or broken DNS fails on all of them. Left raw, httpx's ConnectError
        escapes to the catch-all handler and the user gets "Something went
        wrong" plus a wall of traceback that never mentions the network.
        """
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as raw:
                yield raw
        except httpx.RequestError as exc:
            # Covers DNS failure, refused connections, TLS errors and timeouts.
            raise PlexUnreachableError(
                f"Could not reach {PLEX_TV} ({exc.__class__.__name__}: {exc}). "
                "Check that the container has internet access and working DNS."
            ) from exc

    # -- OAuth PIN flow ---------------------------------------------------

    async def create_pin(self, state: str, forward_url: str) -> PlexPinResponse:
        """Ask Plex for a PIN and build the URL to send the browser to."""
        async with self._http() as client:
            resp = await client.post(
                f"{PLEX_TV}/api/v2/pins",
                headers=plex_headers(),
                params={"strong": "true"},
            )
        if resp.status_code >= 400:
            raise PlexAuthError(f"Plex rejected PIN request ({resp.status_code})")
        data = resp.json()

        params = {
            "clientID": settings.plex_client_identifier,
            "code": data["code"],
            "forwardUrl": forward_url,
            "context[device][product]": settings.plex_product,
            "context[device][deviceName]": settings.plex_device_name,
            "context[device][platform]": settings.plex_platform,
        }
        return PlexPinResponse(
            pin_id=str(data["id"]),
            code=data["code"],
            expires_at=datetime.now(UTC) + timedelta(seconds=data.get("expiresIn", 900)),
            auth_url=f"{AUTH_APP}#?{urlencode(params)}",
        )

    async def check_pin(self, pin_id: str) -> str | None:
        """Poll a PIN. Returns the auth token once the user has approved it."""
        async with self._http() as client:
            resp = await client.get(
                f"{PLEX_TV}/api/v2/pins/{pin_id}",
                headers=plex_headers(),
                params={"code": ""},
            )
        if resp.status_code == 404:
            raise PlexAuthError("PIN expired or was never issued")
        resp.raise_for_status()
        return resp.json().get("authToken") or None

    # -- Account ----------------------------------------------------------

    async def get_account(self, token: str) -> PlexAccount:
        async with self._http() as client:
            resp = await client.get(f"{PLEX_TV}/api/v2/user", headers=plex_headers(token))
        if resp.status_code == 401:
            raise PlexAuthError("Plex token is no longer valid")
        resp.raise_for_status()
        data = resp.json()
        return PlexAccount(
            id=str(data["id"]),
            username=data.get("username") or data.get("title") or f"plex-{data['id']}",
            email=data.get("email"),
            thumb=data.get("thumb"),
            title=data.get("title"),
            auth_token=token,
        )

    async def get_home_users(self, token: str) -> list[dict[str, Any]]:
        """Managed/home users on the account — used for multi-user setups."""
        async with self._http() as client:
            resp = await client.get(
                f"{PLEX_TV}/api/v2/home/users", headers=plex_headers(token)
            )
        if resp.status_code >= 400:
            return []
        data = resp.json()
        return data.get("users", data if isinstance(data, list) else [])

    # -- Servers ----------------------------------------------------------

    async def get_resources(self, token: str) -> list[PlexResource]:
        async with self._http() as client:
            resp = await client.get(
                f"{PLEX_TV}/api/v2/resources",
                headers=plex_headers(token),
                params={"includeHttps": 1, "includeRelay": 1, "includeIPv6": 1},
            )
        if resp.status_code == 401:
            raise PlexAuthError("Plex token is no longer valid")
        resp.raise_for_status()

        resources: list[PlexResource] = []
        for entry in resp.json():
            if "server" not in (entry.get("provides") or ""):
                continue
            if not entry.get("accessToken"):
                continue
            resources.append(
                PlexResource(
                    name=entry.get("name", "Plex Server"),
                    client_identifier=entry["clientIdentifier"],
                    access_token=entry["accessToken"],
                    owned=bool(entry.get("owned")),
                    product=entry.get("product", ""),
                    provides=entry.get("provides", ""),
                    platform=entry.get("platform"),
                    version=entry.get("productVersion"),
                    connections=[
                        PlexConnection(
                            uri=c["uri"],
                            local=bool(c.get("local")),
                            relay=bool(c.get("relay")),
                            protocol=c.get("protocol", "http"),
                        )
                        for c in entry.get("connections", [])
                        if c.get("uri")
                    ],
                )
            )
        return resources

    # -- Watchlist (Discover) --------------------------------------------

    async def get_watchlist(self, token: str) -> WatchlistFetch:
        """Fetch the account's universal watchlist, following pagination.

        Returns the items *and* whether the fetch actually completed. A caller
        that mirrors removals has to know the difference: a half-fetched list
        looks exactly like "the user deleted everything after page one".
        """
        items: list[dict[str, Any]] = []
        complete = True
        offset, page_size = 0, 100

        async with self._http() as client:
            while True:
                resp = await client.get(
                    f"{DISCOVER}/library/sections/watchlist/all",
                    headers=plex_headers(token),
                    params={
                        "X-Plex-Container-Start": offset,
                        "X-Plex-Container-Size": page_size,
                        "includeCollections": 0,
                        "includeExternalMedia": 1,
                        # Without this Discover identifies everything by its own
                        # ratingKey, which shares no identity with the tmdb id a
                        # library scan produces — so every watchlist entry became
                        # a second row for a film already in the library.
                        "includeGuids": 1,
                    },
                )
                if resp.status_code == 401:
                    raise PlexAuthError("Plex token is no longer valid")
                if resp.status_code >= 400:
                    log.warning(
                        "Watchlist fetch failed at offset %s: %s — treating the "
                        "result as incomplete",
                        offset,
                        resp.status_code,
                    )
                    complete = False
                    break

                container = resp.json().get("MediaContainer", {})
                batch = container.get("Metadata", []) or []
                items.extend(batch)

                total = container.get("totalSize", len(items))
                offset += page_size
                if len(batch) < page_size or offset >= total:
                    break
        return WatchlistFetch(items=items, complete=complete)

    async def add_to_watchlist(self, token: str, plex_guid: str) -> bool:
        return await self._watchlist_action(token, plex_guid, "addToWatchlist")

    async def remove_from_watchlist(self, token: str, plex_guid: str) -> bool:
        return await self._watchlist_action(token, plex_guid, "removeFromWatchlist")

    async def _watchlist_action(self, token: str, plex_guid: str, action: str) -> bool:
        # The API wants the bare ratingKey portion of a plex:// guid.
        rating_key = plex_guid.rsplit("/", 1)[-1] if plex_guid else ""
        if not rating_key:
            return False
        async with self._http() as client:
            resp = await client.put(
                f"{DISCOVER}/actions/{action}",
                headers=plex_headers(token),
                params={"ratingKey": rating_key},
            )
        if resp.status_code >= 400:
            log.warning("Watchlist %s failed for %s: %s", action, rating_key, resp.status_code)
            return False
        return True

    async def search_discover(
        self, token: str, query: str, limit: int = 20
    ) -> list[dict[str, Any]]:
        """Search Plex's global catalogue — lets users watchlist things they don't own."""
        async with self._http() as client:
            resp = await client.get(
                f"{DISCOVER}/library/search",
                headers=plex_headers(token),
                params={
                    "query": query,
                    "limit": limit,
                    "searchTypes": "movies,tv",
                    "includeMetadata": 1,
                },
            )
        if resp.status_code >= 400:
            return []

        results: list[dict[str, Any]] = []
        for hub in resp.json().get("MediaContainer", {}).get("SearchResult", []) or []:
            meta = hub.get("Metadata")
            if meta:
                results.append(meta)
        return results
