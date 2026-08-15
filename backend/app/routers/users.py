"""User management and preferences."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import func, select

from ..deps import AdminUser, CurrentUser, DbSession
from ..models import User
from ..schemas import UserOut, UserPreferences, UserUpdate

router = APIRouter(prefix="/api/users", tags=["users"])

DEFAULT_PREFERENCES = {
    "sync_ratings": True,
    "sync_watchlist": True,
    "sync_history": True,
    "separate_anime": True,
    "default_view": "grid",
    "theme": "system",
    # Weeks before something drops off Continue Watching. None follows the Plex
    # server's own `onDeckWindow`; 0 keeps everything forever.
    "continue_watching_weeks": None,
}


def _to_out(user: User) -> UserOut:
    payload = UserOut.model_validate(user)
    payload.has_plex_link = bool(user.plex_token_encrypted)
    payload.preferences = {**DEFAULT_PREFERENCES, **(user.preferences or {})}
    return payload


@router.get("", response_model=list[UserOut])
async def list_users(db: DbSession, admin: AdminUser) -> list[UserOut]:
    result = await db.execute(select(User).order_by(User.created_at))
    return [_to_out(user) for user in result.scalars()]


@router.get("/me/preferences", response_model=dict)
async def get_preferences(user: CurrentUser) -> dict:
    return {**DEFAULT_PREFERENCES, **(user.preferences or {})}


@router.put("/me/preferences", response_model=dict)
async def update_preferences(
    payload: UserPreferences, db: DbSession, user: CurrentUser
) -> dict:
    # exclude_unset, not exclude_none: `continue_watching_weeks: null` means
    # "follow Plex" and has to survive the round trip. Omitted fields are still
    # left alone, so this stays a partial update.
    updates = payload.model_dump(exclude_unset=True)
    # Reassign rather than mutate: SQLAlchemy won't flag an in-place JSON edit.
    user.preferences = {**DEFAULT_PREFERENCES, **(user.preferences or {}), **updates}
    await db.commit()
    return user.preferences


@router.patch("/me", response_model=UserOut)
async def update_me(payload: UserUpdate, db: DbSession, user: CurrentUser) -> UserOut:
    if payload.display_name is not None:
        user.display_name = payload.display_name
    if payload.email is not None:
        user.email = payload.email
    await db.commit()
    await db.refresh(user)
    return _to_out(user)


@router.patch("/{user_id}", response_model=UserOut)
async def update_user(
    user_id: int, payload: UserUpdate, db: DbSession, admin: AdminUser
) -> UserOut:
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    if payload.is_admin is False and target.id == admin.id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "You cannot remove your own admin access"
        )
    if payload.is_active is False and target.id == admin.id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "You cannot deactivate your own account"
        )

    for field in ("display_name", "email", "is_active", "is_admin"):
        value = getattr(payload, field)
        if value is not None:
            setattr(target, field, value)
    await db.commit()
    await db.refresh(target)
    return _to_out(target)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(user_id: int, db: DbSession, admin: AdminUser) -> Response:
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    if target.id == admin.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot delete your own account")

    remaining_admins = await db.scalar(
        select(func.count(User.id)).where(User.is_admin.is_(True), User.id != target.id)
    )
    if target.is_admin and not remaining_admins:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Cannot delete the last administrator"
        )

    await db.delete(target)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/me/plex-link", status_code=status.HTTP_204_NO_CONTENT)
async def unlink_plex(db: DbSession, user: CurrentUser) -> Response:
    """Drop the stored Plex token. History already imported is kept."""
    if not user.password_hash:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Set a password first, otherwise you would be locked out",
        )
    user.plex_token_encrypted = None
    user.plex_user_id = None
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
