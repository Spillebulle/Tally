"""Shared FastAPI dependencies."""
from __future__ import annotations

from datetime import timedelta
from typing import Annotated

from fastapi import Cookie, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .models import ApiKey, ApiKeyScope, User, utcnow
from .security import (
    API_KEY_PREFIX,
    api_key_prefix,
    decode_access_token,
    verify_api_key,
)

SESSION_COOKIE = "tally_session"

DbSession = Annotated[AsyncSession, Depends(get_session)]


async def get_current_user(
    request: Request,
    db: DbSession,
    tally_session: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
    x_api_key: Annotated[str | None, Header()] = None,
) -> User:
    """Resolve the caller from a session cookie, a bearer token, or an API key.

    Keys are accepted in `X-API-Key` or as a bearer token — they are
    distinguishable from a session JWT by their prefix, so one Authorization
    header can carry either without ambiguity. A key is never read from the
    query string: uvicorn's access log prints query strings at INFO, and users
    paste `docker logs` into issues.
    """
    bearer = None
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization.split(" ", 1)[1].strip()

    presented_key = x_api_key or (
        bearer if bearer and bearer.startswith(API_KEY_PREFIX) else None
    )
    if presented_key:
        return await _user_for_api_key(db, presented_key, request)

    token = tally_session or bearer
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")

    user_id = decode_access_token(token)
    if user_id is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired session")

    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account is inactive")
    return user


# Writing last_used_at on every request would mean a write per API call. Once a
# minute is enough to answer "is this key still in use?".
_LAST_USED_RESOLUTION = timedelta(minutes=1)

# Everything that cannot change state. HEAD and OPTIONS are here because a
# read-only client is entitled to ask what exists and what it may do.
_READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# What a `stats` key may reach, on top of being read-only. Each entry matches
# itself and anything below it — "/api/stats" covers "/api/stats/summary" but
# not a hypothetical "/api/statsomething".
_STATS_PATHS = ("/api/stats", "/metrics", "/api/health", "/api/version")


def _enforce_key_scope(scope: str | None, request: Request) -> None:
    """Refuse a request the key's scope does not cover.

    This lives here, in the one place a key is resolved, rather than in the
    routers: a scope checked per-endpoint is a scope that is missing from the
    endpoint somebody adds next month. An API key is what goes into Grafana or
    Home Assistant, where anyone who can edit a dashboard can proxy arbitrary
    requests through the stored credential — so "full access, always" is not a
    safe shape for it.

    Fails closed in both directions: an unrecognised scope (a hand-edited row, a
    value from a newer version after a downgrade) is refused outright rather
    than treated as the nearest thing, and a refusal is always a 403 — it never
    degrades into a narrower answer the caller might mistake for the whole
    truth.
    """
    if scope == ApiKeyScope.FULL.value:
        return

    if scope not in (ApiKeyScope.READ_ONLY.value, ApiKeyScope.STATS.value):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "This API key has an unrecognised scope"
        )

    if request.method.upper() not in _READ_METHODS:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "This API key is read-only"
        )

    if scope == ApiKeyScope.STATS.value:
        path = request.url.path
        if not any(path == p or path.startswith(f"{p}/") for p in _STATS_PATHS):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "This API key may only read statistics",
            )


async def _user_for_api_key(db: AsyncSession, presented: str, request: Request) -> User:
    result = await db.execute(
        select(ApiKey).where(
            ApiKey.prefix == api_key_prefix(presented),
            ApiKey.revoked_at.is_(None),
        )
    )
    # The prefix is not unique by construction, only in practice; comparing every
    # candidate keeps that an implementation detail rather than a correctness bug.
    for candidate in result.scalars():
        if not verify_api_key(presented, candidate.key_hash):
            continue

        _enforce_key_scope(candidate.scope, request)

        user = await db.get(User, candidate.user_id)
        if user is None or not user.is_active:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account is inactive")

        now = utcnow()
        if (
            candidate.last_used_at is None
            or now - candidate.last_used_at > _LAST_USED_RESOLUTION
        ):
            candidate.last_used_at = now
            await db.commit()
        return user

    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid API key")


CurrentUser = Annotated[User, Depends(get_current_user)]


async def get_admin_user(user: CurrentUser) -> User:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Administrator access required")
    return user


AdminUser = Annotated[User, Depends(get_admin_user)]
