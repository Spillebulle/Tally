"""Authentication: Plex OAuth (primary) and local accounts (fallback)."""
from __future__ import annotations

import logging
import secrets
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import func, select

from ..config import get_settings
from ..deps import SESSION_COOKIE, CurrentUser, DbSession
from ..models import PlexPin, User, utcnow
from ..schemas import (
    ChangePassword,
    LocalLogin,
    LocalRegister,
    PlexAuthPoll,
    PlexAuthStart,
    UserOut,
)
from ..security import (
    create_access_token,
    encrypt_secret,
    hash_password,
    verify_password,
)
from ..services.plex_tv import PlexAuthError, PlexTVClient

log = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/api/auth", tags=["auth"])


def _to_out(user: User) -> UserOut:
    data = UserOut.model_validate(user)
    data.has_plex_link = bool(user.plex_token_encrypted)
    return data


def _set_session_cookie(response: Response, user: User) -> None:
    token = create_access_token(user.id)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=settings.session_ttl_hours * 3600,
        httponly=True,
        samesite="lax",
        # Only mark Secure when actually served over HTTPS, otherwise the cookie
        # is silently dropped on a plain-HTTP LAN deployment.
        secure=settings.public_url.startswith("https://"),
        path="/",
    )


async def _is_first_user(db) -> bool:
    count = await db.scalar(select(func.count(User.id)))
    return not count


# ---------------------------------------------------------------------------
# Plex OAuth
# ---------------------------------------------------------------------------


@router.post("/plex/start", response_model=PlexAuthStart)
async def plex_start(db: DbSession) -> PlexAuthStart:
    """Begin the Plex PIN flow and return the URL to open."""
    client = PlexTVClient()
    state = secrets.token_urlsafe(24)
    forward_url = f"{settings.public_url.rstrip('/')}/auth/callback?state={state}"

    try:
        pin = await client.create_pin(state, forward_url)
    except PlexAuthError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    db.add(
        PlexPin(
            pin_id=pin.pin_id, code=pin.code, state=state, expires_at=pin.expires_at
        )
    )
    await db.commit()

    return PlexAuthStart(
        auth_url=pin.auth_url,
        state=state,
        pin_id=pin.pin_id,
        expires_at=pin.expires_at,
    )


@router.post("/plex/poll", response_model=PlexAuthPoll)
async def plex_poll(state: str, response: Response, db: DbSession) -> PlexAuthPoll:
    """Poll a pending PIN; signs the user in once Plex reports approval."""
    result = await db.execute(select(PlexPin).where(PlexPin.state == state))
    pin = result.scalar_one_or_none()
    if pin is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown sign-in attempt")
    if pin.consumed:
        raise HTTPException(status.HTTP_409_CONFLICT, "This sign-in was already used")
    if pin.expires_at < utcnow():
        return PlexAuthPoll(status="expired")

    client = PlexTVClient()
    try:
        token = await client.check_pin(pin.pin_id)
    except PlexAuthError:
        return PlexAuthPoll(status="expired")
    if not token:
        return PlexAuthPoll(status="pending")

    try:
        account = await client.get_account(token)
    except PlexAuthError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    result = await db.execute(select(User).where(User.plex_user_id == account.id))
    user = result.scalar_one_or_none()

    if user is None:
        # Link to an existing local account with the same username rather than
        # creating a confusing duplicate.
        result = await db.execute(
            select(User).where(func.lower(User.username) == account.username.lower())
        )
        user = result.scalar_one_or_none()

    first_user = await _is_first_user(db)
    if user is None:
        user = User(
            username=account.username,
            display_name=account.title or account.username,
            email=account.email,
            plex_user_id=account.id,
            plex_username=account.username,
            avatar_url=account.thumb,
            # Whoever sets up the instance runs it.
            is_admin=first_user,
            preferences={
                "sync_ratings": True,
                "sync_watchlist": True,
                "sync_history": True,
                "separate_anime": True,
            },
        )
        db.add(user)
    else:
        user.plex_user_id = account.id
        user.plex_username = account.username
        user.email = user.email or account.email
        user.avatar_url = account.thumb or user.avatar_url

    user.plex_token_encrypted = encrypt_secret(token)
    user.last_login_at = utcnow()
    pin.consumed = True
    await db.commit()
    await db.refresh(user)

    _set_session_cookie(response, user)
    log.info("Plex sign-in for %s", user.username)
    return PlexAuthPoll(status="authenticated", user=_to_out(user))


@router.post("/plex/relink", response_model=PlexAuthStart)
async def plex_relink(db: DbSession, user: CurrentUser) -> PlexAuthStart:
    """Refresh an expired Plex token for the signed-in account."""
    return await plex_start(db)


# ---------------------------------------------------------------------------
# Local accounts
# ---------------------------------------------------------------------------


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def register(payload: LocalRegister, response: Response, db: DbSession) -> UserOut:
    result = await db.execute(
        select(User).where(func.lower(User.username) == payload.username.lower())
    )
    if result.scalar_one_or_none() is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "That username is taken")

    first_user = await _is_first_user(db)
    user = User(
        username=payload.username,
        display_name=payload.display_name or payload.username,
        password_hash=hash_password(payload.password),
        is_admin=first_user,
        preferences={
            "sync_ratings": True,
            "sync_watchlist": True,
            "sync_history": True,
            "separate_anime": True,
        },
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    _set_session_cookie(response, user)
    return _to_out(user)


@router.post("/login", response_model=UserOut)
async def login(payload: LocalLogin, response: Response, db: DbSession) -> UserOut:
    result = await db.execute(
        select(User).where(func.lower(User.username) == payload.username.lower())
    )
    user = result.scalar_one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect username or password")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account is disabled")

    user.last_login_at = utcnow()
    await db.commit()
    _set_session_cookie(response, user)
    return _to_out(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response) -> Response:
    response.delete_cookie(SESSION_COOKIE, path="/")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> UserOut:
    return _to_out(user)


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    payload: ChangePassword, user: CurrentUser, db: DbSession
) -> Response:
    if user.password_hash and not verify_password(
        payload.current_password or "", user.password_hash
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Current password is incorrect")
    user.password_hash = hash_password(payload.new_password)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/status")
async def auth_status(db: DbSession) -> dict:
    """Unauthenticated: lets the login screen know if this is a fresh install."""
    count = await db.scalar(select(func.count(User.id)))
    return {
        "setup_required": not count,
        "plex_enabled": True,
        "app_name": settings.app_name,
    }


async def cleanup_expired_pins(db) -> int:
    """Housekeeping for abandoned sign-in attempts."""
    cutoff = utcnow() - timedelta(hours=2)
    result = await db.execute(select(PlexPin).where(PlexPin.expires_at < cutoff))
    pins = list(result.scalars())
    for pin in pins:
        await db.delete(pin)
    await db.commit()
    return len(pins)
