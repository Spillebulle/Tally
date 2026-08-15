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
    # Delegates to the users router's serializer so the two agree. They had
    # drifted: this one returned the raw preferences column, so /api/auth/me
    # omitted default_view, theme and continue_watching_weeks entirely while
    # /api/users/me merged the defaults in. The frontend reads both.
    from .users import _to_out as user_to_out

    return user_to_out(user)


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


async def _unused_username(db: DbSession, preferred: str) -> str:
    """A username not already taken, since `User.username` is unique.

    A Plex account whose name collides with an existing local account now gets
    a distinct account rather than being merged into it — merging on a name is
    exactly the takeover this flow used to allow. Suffixing keeps sign-in
    working instead of failing on the unique constraint.
    """
    result = await db.execute(
        select(User.username).where(func.lower(User.username) == preferred.lower())
    )
    if result.scalar_one_or_none() is None:
        return preferred
    for suffix in range(2, 100):
        candidate = f"{preferred}{suffix}"
        result = await db.execute(
            select(User.username).where(func.lower(User.username) == candidate.lower())
        )
        if result.scalar_one_or_none() is None:
            return candidate
    return f"{preferred}-{secrets.token_hex(4)}"


# ---------------------------------------------------------------------------
# Plex OAuth
# ---------------------------------------------------------------------------


@router.post("/plex/start", response_model=PlexAuthStart)
async def plex_start(db: DbSession) -> PlexAuthStart:
    """Begin the Plex PIN flow and return the URL to open."""
    return await _start_pin(db, link_user=None)


async def _start_pin(db: DbSession, *, link_user: User | None) -> PlexAuthStart:
    client = PlexTVClient()
    state = secrets.token_urlsafe(24)
    forward_url = f"{settings.public_url.rstrip('/')}/auth/callback?state={state}"

    try:
        pin = await client.create_pin(state, forward_url)
    except PlexAuthError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    db.add(
        PlexPin(
            pin_id=pin.pin_id,
            code=pin.code,
            state=state,
            expires_at=pin.expires_at,
            link_user_id=link_user.id if link_user else None,
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

    if user is None and pin.link_user_id is not None:
        # A relink: the flow was started from an authenticated session, so we
        # have proof this account asked to be attached to this Plex identity.
        #
        # This used to match on username instead, from an endpoint that needs
        # no credentials at all — so on a reachable instance anyone could set
        # their plex.tv username to the operator's, run the PIN flow, and be
        # handed a session for that account. Plex usernames are freely
        # changeable, which made it trivial.
        user = await db.get(User, pin.link_user_id)

    first_user = await _is_first_user(db)
    if user is None:
        username = await _unused_username(db, account.username)
        user = User(
            username=username,
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
    """Refresh an expired Plex token for the signed-in account.

    The signed-in account is recorded on the PIN, which is what lets the
    anonymous poll attach the resulting Plex identity to it. Delegating to
    `plex_start` dropped that, so a relink could hand the session to whichever
    account the poll happened to match.
    """
    return await _start_pin(db, link_user=user)


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
async def logout() -> Response:
    # The deletion has to be set on the response that is actually returned.
    # Writing it to an injected `response` and then returning a fresh Response
    # threw the header away — FastAPI only merges the injected one when the
    # handler does not return a Response itself — so logout answered 204 with
    # no Set-Cookie and the session stayed valid for its full 30 days.
    resp = Response(status_code=status.HTTP_204_NO_CONTENT)
    # Mirror the attributes the cookie was set with, or the browser treats this
    # as a different cookie and leaves the original in place.
    resp.delete_cookie(
        SESSION_COOKIE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.public_url.startswith("https://"),
    )
    return resp


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
