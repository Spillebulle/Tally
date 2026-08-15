"""Shared FastAPI dependencies."""
from __future__ import annotations

from datetime import timedelta
from typing import Annotated

from fastapi import Cookie, Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .models import ApiKey, User, utcnow
from .security import (
    API_KEY_PREFIX,
    api_key_prefix,
    decode_access_token,
    verify_api_key,
)

SESSION_COOKIE = "tally_session"

DbSession = Annotated[AsyncSession, Depends(get_session)]


async def get_current_user(
    db: DbSession,
    tally_session: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
    x_api_key: Annotated[str | None, Header()] = None,
) -> User:
    """Resolve the caller from a session cookie, a bearer token, or an API key.

    Keys are accepted in `X-API-Key` or as a bearer token — they are
    distinguishable from a session JWT by their prefix, so one Authorization
    header can carry either without ambiguity.
    """
    bearer = None
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization.split(" ", 1)[1].strip()

    presented_key = x_api_key or (
        bearer if bearer and bearer.startswith(API_KEY_PREFIX) else None
    )
    if presented_key:
        return await _user_for_api_key(db, presented_key)

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


async def _user_for_api_key(db: AsyncSession, presented: str) -> User:
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
