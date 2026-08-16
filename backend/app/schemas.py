"""Pydantic request/response models."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .models import MediaType, WatchSource, WatchStatus


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- auth -----------------------------------------------------------------


class PlexAuthStart(BaseModel):
    auth_url: str
    state: str
    pin_id: str
    expires_at: datetime


class PlexAuthPoll(BaseModel):
    status: Literal["pending", "authenticated", "expired"]
    user: UserOut | None = None


class LocalLogin(BaseModel):
    username: str
    password: str


class LocalRegister(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=8, max_length=256)
    display_name: str | None = None


class ChangePassword(BaseModel):
    current_password: str | None = None
    new_password: str = Field(min_length=8, max_length=256)


# --- users ----------------------------------------------------------------


class UserOut(ORMModel):
    id: int
    username: str
    display_name: str | None
    email: str | None
    avatar_url: str | None
    plex_username: str | None
    is_admin: bool
    is_active: bool
    has_plex_link: bool = False
    preferences: dict[str, Any] = {}
    created_at: datetime
    last_full_sync_at: datetime | None


class UserPreferences(BaseModel):
    sync_ratings: bool | None = None
    sync_watchlist: bool | None = None
    sync_history: bool | None = None
    separate_anime: bool | None = None
    default_view: str | None = None
    theme: str | None = None
    # None is a real value here — "follow the Plex server's onDeckWindow" — so
    # this endpoint keys off which fields were *sent*, not which are non-null.
    continue_watching_weeks: int | None = Field(None, ge=0, le=520)


class UserUpdate(BaseModel):
    display_name: str | None = None
    email: str | None = None
    is_active: bool | None = None
    is_admin: bool | None = None


# --- media ----------------------------------------------------------------


class MediaItemOut(ORMModel):
    id: int
    media_type: MediaType
    title: str
    year: int | None
    overview: str | None
    tagline: str | None
    poster_url: str | None
    backdrop_url: str | None
    runtime_minutes: int | None
    content_rating: str | None
    studio: str | None
    network: str | None
    genres: list[str] = []
    release_status: str | None
    first_aired: date | None
    community_rating: float | None
    tmdb_id: int | None
    tvdb_id: int | None
    imdb_id: str | None
    mal_id: int | None
    is_anime: bool
    anime_format: str | None
    season_number: int | None
    episode_number: int | None
    show_id: int | None
    child_count: int | None
    leaf_count: int | None


class UserStateOut(ORMModel):
    status: WatchStatus | None = None
    rating: float | None = None
    view_count: int = 0
    last_watched_at: datetime | None = None
    progress_ms: int | None = None
    duration_ms: int | None = None
    is_favorite: bool = False
    notes: str | None = None


class MediaItemDetail(MediaItemOut):
    state: UserStateOut | None = None
    on_watchlist: bool = False
    available_on_plex: bool = False
    show_title: str | None = None
    watched_episodes: int | None = None
    total_episodes: int | None = None


class MediaCard(ORMModel):
    """Trimmed payload for grids — keeps list responses small."""

    id: int
    media_type: MediaType
    title: str
    year: int | None
    poster_url: str | None
    is_anime: bool
    season_number: int | None = None
    episode_number: int | None = None
    show_id: int | None = None
    show_title: str | None = None
    status: WatchStatus | None = None
    rating: float | None = None
    progress_percent: float | None = None
    last_watched_at: datetime | None = None
    watched_episodes: int | None = None
    total_episodes: int | None = None
    on_watchlist: bool = False


class CreditOut(BaseModel):
    """One credited person on one title."""

    person_id: int
    name: str
    # Who they played. Null for a director.
    character: str | None = None
    # A TMDB URL, which needs no credentials — so unlike Plex artwork this is a
    # real URL the browser fetches itself rather than a proxied path.
    profile_url: str | None = None


class MediaCreditsOut(BaseModel):
    cast: list[CreditOut] = []
    directors: list[CreditOut] = []


class PaginatedMedia(BaseModel):
    items: list[MediaCard]
    total: int
    offset: int
    limit: int


class ContinueWatchingItem(BaseModel):
    item: MediaCard
    next_episode: MediaCard | None = None
    show: MediaCard | None = None
    progress_percent: float
    resumed_at: datetime | None = None


# --- history --------------------------------------------------------------


class WatchEventOut(ORMModel):
    id: int
    media_item_id: int
    watched_at: datetime
    source: WatchSource
    completed: bool
    device: str | None
    player: str | None
    item: MediaCard | None = None


class LogWatchRequest(BaseModel):
    media_item_id: int
    watched_at: datetime | None = None
    # Also mark it watched on Plex, not just in Tally.
    push_to_plex: bool = True


class HistoryPage(BaseModel):
    events: list[WatchEventOut]
    total: int
    offset: int
    limit: int


# --- ratings / state ------------------------------------------------------


class RatingRequest(BaseModel):
    # Plex's 0-10 scale, which Tally now also shows directly. Plex's own UI
    # renders it as five stars at half-star granularity; the number is the same.
    rating: float | None = Field(default=None, ge=0, le=10)
    push_to_plex: bool = True


class StatusRequest(BaseModel):
    status: WatchStatus | None = None


class FavoriteRequest(BaseModel):
    is_favorite: bool


class NotesRequest(BaseModel):
    notes: str | None = None


# --- watchlist ------------------------------------------------------------


class WatchlistEntryOut(ORMModel):
    id: int
    media_item_id: int
    added_at: datetime
    source: str
    synced_with_plex: bool = False
    item: MediaCard | None = None


class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)


class ApiKeyOut(ORMModel):
    id: int
    name: str
    # The visible half only. The rest exists nowhere but the owner's copy.
    prefix: str
    created_at: datetime
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None


class ApiKeyCreated(ApiKeyOut):
    """Carries the plaintext key. Returned by the create call and never again."""

    key: str = ""


class PaginatedWatchlist(BaseModel):
    """Same envelope as PaginatedMedia, but the rows carry watchlist metadata
    (when it was added, whether Plex has it yet) alongside the card."""

    entries: list[WatchlistEntryOut]
    total: int
    offset: int
    limit: int


class WatchlistAdd(BaseModel):
    media_item_id: int | None = None
    # Plex Discover ratingKey, for adding something not on any local server.
    plex_guid: str | None = None


# --- servers & settings ---------------------------------------------------


class LibraryOut(ORMModel):
    id: int
    title: str
    section_type: str
    section_key: str
    anime_override: bool | None
    enabled: bool
    item_count: int
    last_synced_at: datetime | None


class ServerUpdate(BaseModel):
    """Pin a connection address, or clear it to go back to auto-detection.

    An empty string clears it, so the UI can send the field as the user typed
    it rather than having to distinguish "" from null.
    """

    manual_url: str | None = None
    enabled: bool | None = None


class ServerOut(ORMModel):
    id: int
    name: str
    machine_identifier: str
    base_url: str
    manual_url: str | None = None
    owned: bool
    version: str | None
    platform: str | None
    enabled: bool
    last_seen_at: datetime | None
    reachable: bool | None = None
    on_deck_window_weeks: int | None = None
    libraries: list[LibraryOut] = []


class LibraryUpdate(BaseModel):
    enabled: bool | None = None
    anime_override: bool | None = None


class SyncRunOut(ORMModel):
    id: int
    kind: str
    status: str
    started_at: datetime
    finished_at: datetime | None
    stats: dict[str, Any] = {}
    error: str | None


class SyncRequest(BaseModel):
    full_history: bool = False
    scan_libraries: bool = True


class ProvidersStatus(BaseModel):
    tmdb: bool
    tvdb: bool
    mal: bool
    jikan: bool


class VersionOut(BaseModel):
    version: str
    github_url: str
    dockerhub_url: str


class SettingsOut(BaseModel):
    providers: ProvidersStatus
    sync_interval_minutes: int
    webhook_url: str
    public_url: str
    version: str
    # What Plex says its own Continue Watching window is, so Settings can name
    # the number behind "Follow Plex". None until a sync has read it.
    plex_on_deck_weeks: int | None = None
    # The window actually in force for this user, in weeks. 0 means no cutoff.
    continue_watching_weeks: int


# --- stats ----------------------------------------------------------------


class StatCount(BaseModel):
    label: str
    value: float


class StatsOut(BaseModel):
    total_movies_watched: int
    total_episodes_watched: int
    total_shows_watched: int
    total_anime_watched: int
    total_runtime_minutes: int
    watch_events: int
    average_rating: float | None
    current_streak_days: int
    longest_streak_days: int
    top_genres: list[StatCount]
    activity_by_day: list[StatCount]
    activity_by_month: list[StatCount]
    by_type: list[StatCount]
    rating_distribution: list[StatCount]


PlexAuthPoll.model_rebuild()
