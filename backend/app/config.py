"""Application configuration, loaded from environment variables."""
from __future__ import annotations

import secrets
import uuid
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # --- Core -------------------------------------------------------------
    app_name: str = "Tally"
    data_dir: Path = Path("/data")
    log_level: str = "INFO"
    # Public URL Tally is reachable at. Needed so the Plex OAuth flow knows
    # where to send the browser back to after the user signs in.
    public_url: str = "http://localhost:8080"

    # --- Security ---------------------------------------------------------
    # Signs session JWTs *and* derives the key that encrypts stored Plex
    # tokens at rest. Generated on first boot if unset (see `_ensure_secret`).
    secret_key: str = ""
    session_ttl_hours: int = 24 * 30

    # --- Plex -------------------------------------------------------------
    # Stable per-install identifier. Plex ties auth PINs and device entries to
    # this, so it must survive restarts (persisted alongside the secret key).
    plex_client_identifier: str = ""
    plex_product: str = "Tally"
    plex_device_name: str = "Tally"
    plex_platform: str = "Web"

    # --- Metadata providers ----------------------------------------------
    tmdb_api_key: str = ""
    tvdb_api_key: str = ""
    mal_client_id: str = ""
    # Jikan is the unauthenticated MyAnimeList mirror; used when no MAL client
    # id is configured so anime enrichment works out of the box.
    jikan_base_url: str = "https://api.jikan.moe/v4"

    # --- Sync -------------------------------------------------------------
    sync_interval_minutes: int = 30
    sessions_poll_seconds: int = 30
    # Guard against a misconfigured server nuking history on both sides.
    sync_deletion_safety_limit: int = 200

    # --- Server -----------------------------------------------------------
    host: str = "0.0.0.0"
    port: int = 8080
    cors_origins: list[str] = Field(default_factory=list)

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @property
    def db_path(self) -> Path:
        return self.data_dir / "tally.db"

    @property
    def database_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.db_path}"

    @property
    def images_dir(self) -> Path:
        return self.data_dir / "images"


def _persisted(path: Path, generate) -> str:
    """Read a generated-once value from disk, creating it on first call."""
    if path.exists():
        value = path.read_text().strip()
        if value:
            return value
    value = generate()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)
    path.chmod(0o600)
    return value


class DataDirectoryError(RuntimeError):
    """The data directory exists but Tally cannot write to it."""


def _prepare_data_dir(settings: Settings) -> None:
    """Create the data directory, with an actionable error if we cannot.

    A bind-mounted volume owned by the wrong user is the single most common
    setup mistake, and a bare PermissionError traceback tells the user nothing
    about how to fix it.
    """
    try:
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        settings.images_dir.mkdir(parents=True, exist_ok=True)
    except PermissionError as exc:
        raise DataDirectoryError(
            f"Cannot write to the data directory {settings.data_dir}.\n"
            "If you are running in Docker, the mounted volume is owned by a "
            "different user than the container.\n"
            "Fix it with either:\n"
            "  - PUID/PGID environment variables matching the directory's owner "
            "(run `id -u` and `id -g` on the host), or\n"
            f"  - `sudo chown -R 1000:1000 ./data` on the host."
        ) from exc


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    _prepare_data_dir(settings)

    if not settings.secret_key:
        settings.secret_key = _persisted(
            settings.data_dir / ".secret_key", lambda: secrets.token_urlsafe(48)
        )
    if not settings.plex_client_identifier:
        settings.plex_client_identifier = _persisted(
            settings.data_dir / ".plex_client_id", lambda: str(uuid.uuid4())
        )
    return settings
