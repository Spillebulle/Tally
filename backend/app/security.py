"""Token signing, password hashing and at-rest encryption for Plex tokens."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

import jwt
from cryptography.fernet import Fernet, InvalidToken
from passlib.context import CryptContext

from .config import get_settings

settings = get_settings()

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

ALGORITHM = "HS256"


def _fernet() -> Fernet:
    """Derive the encryption key from the app secret.

    A Plex auth token grants full access to the user's Plex account, so it never
    touches the database in plaintext. Rotating ``SECRET_KEY`` invalidates stored
    tokens (users simply re-link Plex), which is the intended failure mode.
    """
    digest = hashlib.sha256(settings.secret_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str | None) -> str | None:
    if not value:
        return None
    return _fernet().encrypt(value.encode()).decode()


def decrypt_secret(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return _fernet().decrypt(value.encode()).decode()
    except InvalidToken:
        # Secret rotated, or the row predates encryption. Treat as "no token" so
        # the caller prompts for a re-link instead of crashing.
        return None


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    try:
        return pwd_context.verify(password, password_hash)
    except ValueError:
        return False


# --- API keys -------------------------------------------------------------
#
# Keys are hashed with SHA-256 rather than bcrypt. That is the opposite of the
# rule for passwords, and deliberately: bcrypt is slow *by design* to make
# guessing a low-entropy human secret expensive, and an API key is neither
# low-entropy nor human — it is 256 random bits, so there is nothing to guess.
# Paying bcrypt's cost on every API request would only buy latency.
#
# The prefix is stored in the clear so a key can be found without scanning
# every row, and so the UI can show which key is which.

API_KEY_PREFIX = "tally_"
_PREFIX_LENGTH = len(API_KEY_PREFIX) + 8


def generate_api_key() -> tuple[str, str, str]:
    """Return (full_key, lookup_prefix, hash). The full key is never stored."""
    key = API_KEY_PREFIX + secrets.token_urlsafe(32)
    return key, key[:_PREFIX_LENGTH], hash_api_key(key)


def api_key_prefix(key: str) -> str:
    return key[:_PREFIX_LENGTH]


def hash_api_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def verify_api_key(key: str, key_hash: str) -> bool:
    # Constant time: the comparison itself must not leak how much matched.
    return hmac.compare_digest(hash_api_key(key), key_hash)


def create_access_token(user_id: int, *, ttl_hours: int | None = None) -> str:
    expires = datetime.now(UTC) + timedelta(
        hours=ttl_hours or settings.session_ttl_hours
    )
    payload = {"sub": str(user_id), "exp": expires, "iat": datetime.now(UTC)}
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_access_token(token: str) -> int | None:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None
    sub = payload.get("sub")
    if sub is None:
        return None
    try:
        return int(sub)
    except (TypeError, ValueError):
        return None
