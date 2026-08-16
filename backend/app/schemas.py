"""Pydantic request/response models."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .models import ApiKeyScope, MediaType, WatchSource, WatchStatus


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
    # IANA name ("Europe/Oslo"). None means UTC — see `app/timezones.py` and the
    # stats router, which bucket days in this zone. Validated in the router
    # rather than here, so an unloadable zone is a 422 and not a silent UTC.
    timezone: str | None = None
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
    is_personal_media: bool = False
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
    is_personal_media: bool = False
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
    # Anything unrecognised is a 422 rather than a quietly narrowed key: the
    # caller must know what they asked for. Omitting it keeps the historical
    # behaviour, so existing clients are unaffected.
    scope: ApiKeyScope = ApiKeyScope.FULL


class ApiKeyOut(ORMModel):
    id: int
    name: str
    # The visible half only. The rest exists nowhere but the owner's copy.
    prefix: str
    # A row written before scopes existed reads back as "full", which is what it
    # was issued with.
    scope: ApiKeyScope = ApiKeyScope.FULL
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


StatsPreset = Literal["7d", "30d", "90d", "ytd", "12m", "last_year", "all"]
StatsGranularity = Literal["day", "week", "month"]


class StatsRange(BaseModel):
    """The window the numbers actually cover, resolved server-side.

    The caller asks with a preset, or a `since`/`until` pair, or the legacy
    `days`; whichever it was, this says what that turned into — so the UI can
    label the page "1 Jan – 16 Aug 2026" without re-deriving a calculation that
    depends on the viewer's timezone, on which the two sides have to agree.

    `since`/`until` are the real UTC bounds of the query and the window is
    half-open, `since <= watched_at < until`, so two adjacent windows can never
    both claim the same play. `start_day`/`end_day` are the *inclusive* local
    dates for display, which is not the same thing: the last day's `until` is
    the following midnight.
    """

    preset: StatsPreset | None
    since: datetime
    until: datetime
    start_day: date
    end_day: date
    days: int
    timezone: str
    granularity: StatsGranularity


class StatsTotals(BaseModel):
    total_movies_watched: int
    total_episodes_watched: int
    total_shows_watched: int
    total_anime_watched: int
    total_runtime_minutes: int
    watch_events: int
    average_rating: float | None


class StatsComparison(BaseModel):
    """The same aggregation over the window immediately before this one."""

    range: StatsRange
    totals: StatsTotals
    # Percent change of the current window against the previous one, keyed by
    # the field names on StatsTotals. A metric is absent from the mapping when
    # the previous window was zero (or unrated), because "up from nothing" has
    # no percentage — the tile should show the raw pair instead.
    pct_change: dict[str, float]


class TimeBucket(BaseModel):
    """One slot of a time-shape profile: a weekday, an hour, or a month.

    `index` is the machine-readable slot — 0-6 with **Monday first** for a
    weekday, 0-23 for an hour, 1-12 for a month — and `label` is the name to
    print. The UI should sort and key on `index`; the label is display only, so
    it can be localised or shortened without anything else moving.

    **An hour is when a play *finished*, near enough.** Plex stamps `viewedAt`
    at the scrobble, which fires around 90% of the way through playback, so a
    two-hour film started at 20:00 lands in the 21:00 bucket. Tally cannot do
    better — the start time is not recorded anywhere — so a chart of these
    should say "when you finish watching", not "when you start".

    Every bucket is assigned from `watched_at.astimezone(tz)` in the timezone
    `StatsRange.timezone` names. Bucketing in UTC would move an evening play
    into the small hours of the next day for anyone east of Greenwich.
    """

    index: int
    label: str
    plays: int
    minutes: int


class PunchCard(BaseModel):
    """The 7x24 weekday-by-hour grid, as a matrix rather than 168 objects.

    `plays[weekday][hour]` — `weekdays` and `hours` give the axis labels in the
    order the rows and columns are in (Monday first, 0-23). `max_plays` is the
    largest cell, so a chart can scale its marks without a pass over the matrix.

    Same caveat as `TimeBucket`: the hour is the scrobble hour, not the start.
    """

    weekdays: list[str]
    hours: list[int]
    plays: list[list[int]]
    max_plays: int


class RewatchSplit(BaseModel):
    """One period bucket, split into first-time plays and rewatches.

    `label` matches the corresponding `activity_by_day` bucket exactly, so the
    two series can be drawn on one axis.
    """

    label: str
    first: int
    rewatch: int


class RewatchedItem(BaseModel):
    """One row of the most-rewatched ranking. Play counts are **all-time**."""

    media_item_id: int
    title: str
    # Set for an episode, so a row reading "Episode 4" is legible on its own.
    show_title: str | None = None
    year: int | None = None
    media_type: MediaType
    poster_url: str
    plays: int
    first_watched: datetime
    last_watched: datetime


class RewatchStats(BaseModel):
    """First-time watches versus rewatches.

    A play is a rewatch when it is not the earliest recorded play of that item
    **in the user's whole history** — not merely the earliest one inside the
    selected window. Ranking within the window would call March's viewing of
    something first seen in 2019 a first watch, which is exactly backwards.

    `plays`, `first_watches`, `rewatches`, `rewatch_ratio` and `by_bucket` are
    all scoped to the window (and to `anime_only`); `most_rewatched` is
    deliberately not, because "what do you come back to?" is a question about a
    library, not about a fortnight. It is capped, and says so via `ranked_over`.
    """

    plays: int
    first_watches: int
    rewatches: int
    # rewatches / plays, 0.0 when nothing was watched. A fraction, not a
    # percentage — the UI decides how to render it.
    rewatch_ratio: float
    by_bucket: list[RewatchSplit]
    most_rewatched: list[RewatchedItem]
    ranked_over: Literal["all_time"] = "all_time"


class StatsOut(StatsTotals):
    range: StatsRange
    previous: StatsComparison | None = None
    # The same window one calendar year earlier. Populated only with
    # `compare=true`, alongside `previous`, because it costs another
    # aggregation over another window.
    previous_year: StatsComparison | None = None
    current_streak_days: int
    longest_streak_days: int
    top_genres: list[StatCount]
    activity_by_day: list[StatCount]
    activity_by_month: list[StatCount]
    by_type: list[StatCount]
    rating_distribution: list[StatCount]
    by_weekday: list[TimeBucket]
    by_hour: list[TimeBucket]
    punch_card: PunchCard
    rewatch: RewatchStats


class YearProfile(BaseModel):
    """One calendar year of history: totals plus its twelve month counts.

    `months` is twelve play counts, January first — a flat list rather than
    labelled objects, so a year-by-month heatmap is one small array per year.
    """

    year: int
    plays: int
    minutes: int
    months: list[int]


class SeasonalityOut(BaseModel):
    """The month-of-year profile, over **all** history rather than a window.

    Its own endpoint on purpose: answering it means walking every play a user
    has ever recorded, which is the one aggregation here that grows without
    bound, and the stats page should not pay for it on every load. Timezone and
    `anime_only` still apply; there is no window to apply.
    """

    timezone: str
    plays: int
    minutes: int
    first_play: datetime | None = None
    last_play: datetime | None = None
    months: list[TimeBucket]
    years: list[YearProfile]


PlexAuthPoll.model_rebuild()
