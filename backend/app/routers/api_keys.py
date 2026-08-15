"""API key management.

A key acts as its owning user, with the same access that user's session has —
including admin endpoints if they are an admin. There are no per-key scopes:
this is a self-hosted tracker with a handful of accounts, and a scope model
nobody configures is complexity pretending to be security. Revoke and re-issue
is the intended way to change what a key can do.

The plaintext is returned exactly once, from the create call. Only its hash is
stored, so it cannot be recovered or re-displayed — losing it means issuing a
new one.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import func, select

from ..deps import CurrentUser, DbSession
from ..models import ApiKey, utcnow
from ..schemas import ApiKeyCreate, ApiKeyCreated, ApiKeyOut
from ..security import generate_api_key

router = APIRouter(prefix="/api/keys", tags=["api-keys"])

# Enough to integrate with, few enough that a runaway script is obvious.
MAX_KEYS_PER_USER = 20


@router.get("", response_model=list[ApiKeyOut])
async def list_keys(db: DbSession, user: CurrentUser) -> list[ApiKeyOut]:
    """Every key this account has issued, revoked ones included."""
    result = await db.execute(
        select(ApiKey)
        .where(ApiKey.user_id == user.id)
        .order_by(ApiKey.revoked_at.is_not(None), ApiKey.created_at.desc())
    )
    return [ApiKeyOut.model_validate(key) for key in result.scalars()]


@router.post("", response_model=ApiKeyCreated, status_code=status.HTTP_201_CREATED)
async def create_key(
    payload: ApiKeyCreate, db: DbSession, user: CurrentUser
) -> ApiKeyCreated:
    """Issue a key. The response carries the only copy of it that will exist."""
    live = await db.scalar(
        select(func.count(ApiKey.id)).where(
            ApiKey.user_id == user.id, ApiKey.revoked_at.is_(None)
        )
    )
    if (live or 0) >= MAX_KEYS_PER_USER:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"You already have {MAX_KEYS_PER_USER} active keys. "
            "Revoke one before creating another.",
        )

    raw, prefix, key_hash = generate_api_key()
    key = ApiKey(
        user_id=user.id,
        name=payload.name.strip() or "API key",
        prefix=prefix,
        key_hash=key_hash,
    )
    db.add(key)
    await db.commit()
    await db.refresh(key)

    out = ApiKeyCreated.model_validate(key)
    out.key = raw
    return out


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_key(key_id: int, db: DbSession, user: CurrentUser) -> Response:
    """Revoke a key. Kept as a row so its last use stays visible."""
    key = await db.get(ApiKey, key_id)
    if key is None or key.user_id != user.id:
        # Same answer either way: whether a key id exists is not the caller's
        # business unless it is theirs.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Key not found")
    if key.revoked_at is None:
        key.revoked_at = utcnow()
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
