"""Client for a Plex Media Server (PMS).

Everything here speaks to a user's own server rather than plex.tv. The client
handles connection failover: plex.tv advertises several URIs per server (local,
remote, relay) and only some will be reachable from inside a Docker container,
so we try them in order and remember the one that worked.
"""
from __future__ import annotations

import asyncio
import logging
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


def _ts(value: Any) -> datetime | None:
    """Plex hands out unix seconds; normalise to aware UTC datetimes."""
    if value in (None, "", 0):
        return None
    try:
        return datetime.fromtimestamp(int(value), tz=UTC)
    except (ValueError, OSError, TypeError):
        return None


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
        self, method: str, path: str, *, params: dict | None = None, retries: int = 1
    ) -> httpx.Response | None:
        params = {**(params or {})}
        urls = [self.working_url] if self.working_url else list(self.candidates)
        if self.working_url and self.working_url in self.candidates:
            # Keep the rest as fallbacks in case the cached URI has gone away.
            urls += [u for u in self.candidates if u != self.working_url]

        last_error: Exception | None = None
        for url in urls:
            if not url:
                continue
            for attempt in range(retries + 1):
                try:
                    async with httpx.AsyncClient(
                        timeout=self._timeout, verify=False, follow_redirects=True
                    ) as client:
                        resp = await client.request(
                            method,
                            f"{url}{path}",
                            headers=plex_headers(self.token),
                            params=params,
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
                    last_error = PlexServerError(f"Server error {resp.status_code}")
                    break  # try the next URI rather than hammering a sick server

                self.working_url = url
                return resp

        raise PlexUnreachable(
            f"No reachable connection for Plex server (tried {len(urls)}): {last_error}"
        )

    async def _get_json(self, path: str, params: dict | None = None) -> dict[str, Any]:
        resp = await self._request("GET", path, params=params)
        if resp is None:
            return {}
        try:
            return resp.json()
        except ValueError:
            return {}

    async def _container(self, path: str, params: dict | None = None) -> dict[str, Any]:
        return (await self._get_json(path, params)).get("MediaContainer", {}) or {}

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

    # -- libraries --------------------------------------------------------

    async def sections(self) -> list[dict[str, Any]]:
        return (await self._container("/library/sections")).get("Directory", []) or []

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
            }
            if account_id is not None:
                params["accountID"] = account_id
            if since is not None:
                params["viewedAt>"] = int(since.timestamp())

            container = await self._container("/status/sessions/history/all", params)
            batch = container.get("Metadata", []) or []
            if not batch:
                return
            yield batch

            offset += len(batch)
            total = container.get("totalSize") or 0
            if len(batch) < page_size or (total and offset >= total):
                return

    async def sessions(self) -> list[PlexSession]:
        container = await self._container("/status/sessions")
        out: list[PlexSession] = []
        for meta in container.get("Metadata", []) or []:
            user = (meta.get("User") or {})
            player = (meta.get("Player") or {})
            account_id = user.get("id")
            out.append(
                PlexSession(
                    rating_key=str(meta.get("ratingKey")),
                    account_id=int(account_id) if account_id is not None else None,
                    user_title=user.get("title"),
                    state=player.get("state", "unknown"),
                    view_offset_ms=int(meta.get("viewOffset") or 0),
                    duration_ms=int(meta.get("duration") or 0),
                    player=player.get("product") or player.get("platform"),
                    device=player.get("device") or player.get("title"),
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

    def image_url(self, path: str | None, *, width: int = 400, height: int = 600) -> str | None:
        """Build a transcoded image URL so we serve right-sized posters."""
        if not path:
            return None
        base = self.working_url or self.base_url
        if not base:
            return None
        from urllib.parse import quote, urlencode

        query = urlencode(
            {
                "width": width,
                "height": height,
                "minSize": 1,
                "upscale": 1,
                "url": path,
                "X-Plex-Token": self.token,
            },
            quote_via=quote,
        )
        return f"{base}/photo/:/transcode?{query}"


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
