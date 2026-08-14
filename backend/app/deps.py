"""Shared FastAPI dependencies."""
from __future__ import annotations

from typing import Annotated

from fastapi import Cookie, Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .models import User
from .security import decode_access_token

SESSION_COOKIE = "tally_session"

DbSession = Annotated[AsyncSession, Depends(get_session)]


async def get_current_user(
    db: DbSession,
    tally_session: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    token = tally_session
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()

    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")

    user_id = decode_access_token(token)
    if user_id is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired session")

    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account is inactive")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def get_admin_user(user: CurrentUser) -> User:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Administrator access required")
    return user


AdminUser = Annotated[User, Depends(get_admin_user)]
