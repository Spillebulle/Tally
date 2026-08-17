"""Pydantic request/response models."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .models import ApiKeyScope, MediaType, WatchSource, WatchStatus
from .services.themes import SLUG_MAX as THEME_ID_MAX


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
    # A custom theme's id, or None for a built-in. Validated in the router,
    # which is the only place that can see whether this account has that file.
    theme_id: str | None = Field(None, max_length=THEME_ID_MAX)
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


class LibraryOption(BaseModel):
    """One library the `library_id` browse filter can name.

    Carries its server's name as well as its own: "Movies" is what half the
    libraries on a two-server household are called, and a picker listing it
    twice with no way to tell them apart is a picker that cannot be used.
    """

    id: int
    title: str
    section_type: str
    server_id: int
    server_name: str


class ServerOption(BaseModel):
    id: int
    name: str


class BrowsePlacesOut(BaseModel):
    """Where the browse filters may look: the servers and libraries you can see.

    Servers are listed in their own right rather than derived from the
    libraries, so one that has never been scanned still appears.
    """

    servers: list[ServerOption] = []
    libraries: list[LibraryOption] = []


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
    # When Tally first recorded the entry — for a Plex-sourced one that is when
    # the sync first saw it, not when the user watchlisted it.
    added_at: datetime
    # Plex's own answer, from Discover's `watchlistedAt`. Null when Discover did
    # not send one, which is the only reason `added_at` is still here.
    plex_added_at: datetime | None = None
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

#: Films, television, or both — the whole stats surface at once.
#:
#: Deliberately **not** `MediaFilters.media_type`, which names one row type. A
#: watch history is mostly episodes, so "television" has to mean shows, seasons
#: *and* episodes together; asking for `media_type=show` would count only the
#: rare play recorded against a series row and report a television-only viewer
#: as having watched almost nothing. A `Literal` so a stale URL is a 422 rather
#: than a silently wrong page.
StatsMediaScope = Literal["all", "movies", "shows"]


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
    all scoped to the window (and to the browse filters); `most_rewatched` is
    deliberately not, because "what do you come back to?" is a question about a
    library, not about a fortnight. It is capped, and says so via `ranked_over`.

    The filters narrow which *items* are ranked, never which of an item's plays
    are — so a rewatch stays a rewatch when the grid is narrowed to its genre.
    `routers/stats._ranked_events` holds the rule and the reasoning.
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


class WatchSession(BaseModel):
    """One sitting: plays with no gap longer than the threshold between them.

    `started_at` and `ended_at` are both **scrobble** instants, so `started_at`
    is when the *first* play of the sitting finished, not when it began — Plex
    records no start time anywhere. A one-play sitting therefore has
    `started_at == ended_at` and a `minutes` that came from the runtime rather
    than from the clock. Do not draw these as a timeline; they are a count and
    a length, not a span.

    `day` is the local day the sitting started on, in the zone
    `StatsRange.timezone` names.
    """

    started_at: datetime
    ended_at: datetime
    day: date
    plays: int
    minutes: int
    # The title of the first play, and — when every play in the sitting came
    # from one series — that series. Both are given so the UI can label a binge
    # by its show and a mixed evening by whatever started it.
    title: str
    show_title: str | None = None


class SessionStats(BaseModel):
    """Sittings, worked out by splitting the window's plays on long gaps.

    A judgement call with no right answer, so the threshold it used is part of
    the payload: `gap_minutes`. Everything here is scoped to the window and to
    the browse filters, which means a filtered page describes the sittings *of
    that filter* — narrowing to one genre splits an evening that mixed two.

    `by_size` is the plays-per-sitting histogram, labelled "1" … "5", "6+".
    """

    gap_minutes: int
    sessions: int
    plays: int
    # Plays and minutes per sitting. Zero when there were no sittings, rather
    # than null, because a chart axis of "0 episodes a sitting" reads correctly
    # and a null does not.
    average_plays: float
    average_minutes: float
    # The sitting with the most minutes, and the one with the most plays. They
    # are usually different: an evening of two films is long, an evening of six
    # episodes is a binge.
    longest: WatchSession | None = None
    biggest_binge: WatchSession | None = None
    by_size: list[StatCount]


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
    # Sittings over the same window. One extra query rather than its own
    # endpoint: it reads the same rows the totals above already came from, and
    # a page that has the plays but not the shape of the evening is missing
    # half of what the plays mean.
    sessions: SessionStats


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
    bound, and the stats page should not pay for it on every load. The timezone
    and the shared browse filters still apply; there is no window to apply.
    """

    timezone: str
    plays: int
    minutes: int
    first_play: datetime | None = None
    last_play: datetime | None = None
    months: list[TimeBucket]
    years: list[YearProfile]


# --- stats: shows, watchlist, coverage, ratings, rankings -----------------
#
# Five blocks that used to be one temptation: bolting them onto `GET
# /api/stats` would have made a page that already runs four aggregations run
# eleven, on every filter chip. Each of these is a section of the page that can
# be fetched when it is drawn, and three of them answer a question no window
# applies to — `/api/stats/seasonality` set that precedent first.


class ShowProgress(BaseModel):
    """How far through one show this user is, and where they stopped.

    `episodes_total` is **Plex's own `leaf_count` and nothing else**, which is
    why it is nullable and why `percent_complete` is nullable with it. The
    tempting fallback — count the episode rows Tally holds — is worse than no
    answer: a show reached only through the history import has exactly the
    episodes that were played as rows, so that count would report every such
    show as 100% complete. A show with no known episode count is reported as
    unknown, is never counted as completed, and is never called abandoned on a
    percentage it does not have.

    `total_is_stale` says `leaf_count` is smaller than the number of distinct
    episodes actually watched, which happens when a library has not been
    rescanned since the season aired, and when specials Tally holds are not in
    Plex's count. A total smaller than what has demonstrably been watched is
    not a total: `percent_complete` is null there too, rather than 130% or a
    clamped 100% that would file the show under "completed" and hide the fact
    that the number is wrong. `episodes_total` still reports what Plex said, so
    the UI can show the flag next to it.

    `last_season` / `last_episode` / `last_episode_title` are the most recently
    watched episode — the drop-off point — not the newest episode that exists.
    """

    media_item_id: int
    title: str
    year: int | None = None
    poster_url: str
    status: WatchStatus | None = None
    episodes_watched: int
    episodes_total: int | None = None
    percent_complete: float | None = None
    total_is_stale: bool = False
    last_watched_at: datetime
    last_season: int | None = None
    last_episode: int | None = None
    last_episode_title: str | None = None
    abandoned: bool = False


class ShowCompletionOut(BaseModel):
    """Show completion and drop-off, over the user's **whole** history.

    Deliberately not windowed, and its own endpoint partly for that reason.
    "You are 40% through The Wire" is a fact about a viewer and a series, not
    about a fortnight: scoping the numerator to the window would report a show
    finished last year as 4% complete because two episodes were rewatched this
    month, and scoping the *subject* to the window would hide every abandoned
    show, which is the half of this block that matters. `RewatchStats.
    most_rewatched` and `SeasonalityOut` opt out of the window for the same
    kind of reason, and say so the same way.

    The browse filters do apply, so "how far through my anime am I" is one
    request.

    `abandoned_under_percent` and `abandoned_after_days` are the thresholds
    that produced `abandoned`, echoed because they are a judgement rather than
    a fact and the UI has to be able to state them.

    `includes_specials` is the third such judgement and the one that moves a
    number people already know: season 0 does **not** count towards completion
    by default, so somebody who has watched every episode of a series reads as
    finished rather than as 88% and permanently "still going". It is echoed for
    the same reason as the thresholds — the block has to be able to say which
    question it answered — and `completion.py` holds the definition, shared with
    the item page and the sync so the three cannot drift.
    """

    scope: Literal["all_time"] = "all_time"
    includes_specials: bool = False
    abandoned_under_percent: float
    abandoned_after_days: int
    shows_started: int
    shows_completed: int
    shows_in_progress: int
    shows_abandoned: int
    # Shows whose episode count Plex never told us, or told us wrongly. They
    # are still listed under `in_progress` — they are shows you are part-way
    # through — but they are counted apart as well, because nothing about their
    # completion is known and a percentage chart that included them would be
    # inventing it.
    shows_unknown_total: int
    in_progress: list[ShowProgress]
    abandoned: list[ShowProgress]


class WatchlistWaiting(BaseModel):
    """A watchlist entry still waiting to be played. Oldest first."""

    media_item_id: int
    title: str
    year: int | None = None
    media_type: MediaType
    poster_url: str
    # The date this row is actually counted from: Plex's `watchlistedAt` when
    # Discover gave one, otherwise when Tally first saw the entry.
    added_at: datetime
    # Which of the two `added_at` is, so the UI can say. A row dated by Tally is
    # not wrong, it is answering a slightly different question, and a page that
    # does not distinguish them tells somebody they watchlisted a film on the
    # day they installed Tally.
    added_on_plex: bool = False
    days_waiting: int


class WatchlistConversionOut(BaseModel):
    """Does watchlisting something mean you watch it?

    The window bounds **when the entry was added** here — which entries are
    being asked about — rather than `WatchEvent.watched_at`. That is the only
    bound that makes the question answerable: an entry added outside the window
    has no conversion to report inside it.

    "When it was added" is `models.watchlist_added_at()`: Plex's own
    `watchlistedAt` where Discover sent one, and otherwise when Tally first saw
    the entry. The distinction is not cosmetic — a first sync stamps every
    imported entry with the same instant, so on `added_at` alone a watchlist
    built over five years reads as five hundred titles added the afternoon
    somebody installed Tally, every one of them converting or waiting from that
    date. `plex_dated` says how many of the entries counted here carry Plex's
    date, so a page can report the mix rather than implying all of them do.

    **A play before the add is not a conversion.** `converted` counts entries
    with a play at or after `added_at`; something you had already seen and
    watchlisted to rewatch is not the watchlist doing its job. `churned`, on
    the other hand, uses "never played at all, ever" — an entry removed after
    a play that predated it was not abandoned, it was tidied up.

    A watchlisted *show* converts on any episode play, not only on a play
    against the show row, which is the only form a show's history ever takes.
    """

    range: StatsRange
    tail_days: int
    added: int
    # How many of `added` carry Plex's own watchlist date. Anything short of
    # `added` means the rest are dated from when Tally first saw them.
    plex_dated: int = 0
    converted: int
    # converted / added, a fraction rather than a percentage. 0.0 when nothing
    # was added in the window.
    conversion_rate: float
    # Days from add to first play, over the converted entries only. Median
    # rather than mean: one title watchlisted in 2019 and played last week
    # drags an average past anything useful.
    median_days_to_watch: float | None = None
    still_waiting: int
    waiting_past_tail: int
    # Removed from the watchlist without ever having been played.
    churned: int
    removed: int
    waiting: list[WatchlistWaiting]


class CoverageSlice(BaseModel):
    label: str
    owned: int
    watched: int
    # watched / owned as a fraction. Never null: a slice only exists because it
    # owns something.
    percent: float


class CoverageOut(BaseModel):
    """How much of the shelf has actually been watched.

    "Owned" is a correlated EXISTS on `PlexMapping`, never a join — an item
    held on two servers is one title, and a join would count it twice. Only
    movies and shows are counted; an episode is not a title on the shelf.

    **This is the one stats block where `personal` keeps its shared default.**
    Everywhere else on `/api/stats` home videos count, because a play is a play
    and the hours are real. This is a library inventory instead — the same
    question `/api/stats/summary` answers — and a phone recording is not a
    title you have failed to get round to. So `personal` stays a live
    parameter here, `exclude` by default and `all` if you ask, rather than the
    inert one it is on the watch blocks. `includes_personal` reports which it
    was.

    All-time, and unwindowed for the same reason as `ShowCompletionOut`: "have
    I seen this" is not a question about a fortnight.

    Decades come from `MediaItem.year` directly. Genres resolve through the
    parent show when the item carries none, the same rule
    `media_filters.facet_source` applies — but no episode reaches this block
    anyway, so in practice they are the title's own.
    """

    scope: Literal["all_time"] = "all_time"
    includes_personal: bool
    owned: int
    watched: int
    unwatched: int
    percent: float
    by_type: list[CoverageSlice]
    by_genre: list[CoverageSlice]
    by_decade: list[CoverageSlice]


class RatingSlice(BaseModel):
    label: str
    count: int
    average: float
    # The crowd's average over the same slice, absent when none of the titles
    # in it carry a `community_rating`.
    community_average: float | None = None


class ContrarianItem(BaseModel):
    """A title you and the crowd disagree about. `difference` is yours minus theirs."""

    media_item_id: int
    title: str
    year: int | None = None
    media_type: MediaType
    poster_url: str
    rating: float
    community_rating: float
    difference: float


class RatingDepthOut(BaseModel):
    """Your ratings against `MediaItem.community_rating`, and how they break down.

    The subject set is what was *watched* in the window — items and the shows
    their episodes belong to — exactly as `StatsOut.average_rating` computes
    it, and for the same reason: `rating_updated_at` is stamped when a rating
    is first pulled from Plex, so scoping by when the rating was made would
    file a decade of ratings under the week of a fresh install.

    Only titles carrying **both** a rating and a `community_rating` can be
    compared, so `rated_with_community` is the denominator of every agreement
    number here and is reported next to `rated` rather than left to be
    inferred.

    `you_rate_higher` and `you_rate_lower` are named after what they contain
    rather than "underrated"/"overrated", which reverse depending on who is
    speaking.
    """

    range: StatsRange
    rated: int
    rated_with_community: int
    average_rating: float | None = None
    average_community: float | None = None
    # Mean signed difference (yours - theirs): positive means you are the
    # kinder of the two. The absolute one says how far apart you are at all,
    # which a signed mean near zero can hide completely.
    average_difference: float | None = None
    average_absolute_difference: float | None = None
    # Share of comparable titles within one point either way, 0-1.
    agreement_within_one: float | None = None
    kinder_than_crowd: int
    harsher_than_crowd: int
    you_rate_higher: list[ContrarianItem]
    you_rate_lower: list[ContrarianItem]
    by_genre: list[RatingSlice]
    by_decade: list[RatingSlice]
    by_runtime: list[RatingSlice]
    # Rated titles with no runtime recorded, so they are in no runtime bucket.
    runtime_unknown: int


class RankedTitle(BaseModel):
    """One row of a title ranking.

    For a show, `media_item_id` is the show and `episodes` is how many distinct
    episodes were played in the window — `episodes_total` is Plex's
    `leaf_count`, nullable for the reasons `ShowProgress` documents.
    """

    media_item_id: int
    title: str
    year: int | None = None
    media_type: MediaType
    poster_url: str
    plays: int
    minutes: int
    episodes: int | None = None
    episodes_total: int | None = None


class RankedFacet(BaseModel):
    """One row of a facet ranking — a studio, a network, a decade, a source."""

    label: str
    plays: int
    minutes: int
    # Distinct titles behind the row, so "300 plays" is legible as one show
    # rather than as thirty films.
    titles: int


class RankingsOut(BaseModel):
    """The leaderboards: what you watched most of, and where it came from.

    Its own endpoint because it is nine lists. It walks the window's plays once
    in Python and derives all nine from that pass, so the whole thing is two
    queries — the plays, and one batched lookup of the show rows the groupings
    point at.

    **Facets resolve through the parent show.** An episode carries no studio,
    network or content rating of its own — enrichment skips episodes by design
    — so each is read from the item or, failing that, from its series, which is
    the rule `media_filters.facet_source` applies to the filters. `decades` is
    the deliberate exception and uses the item's own year: an episode has one,
    and reading it through the series would file a 2019 episode under 1989.

    `by_source` splits `WatchEvent.source` — how the play reached Tally, not
    what was played. A Plex Pass instance sees webhook and history rows for
    plays the sync has reconciled into one, so this is a diagnostic as much as
    a statistic.
    """

    range: StatsRange
    limit: int
    # By distinct episodes watched in the window.
    top_shows: list[RankedTitle]
    # Films by plays in the window — a film played twice is a rewatch, and this
    # is where they surface.
    top_films: list[RankedTitle]
    # Films and shows by minutes, episodes rolled up into their series. Where
    # the hours actually went.
    top_by_runtime: list[RankedTitle]
    studios: list[RankedFacet]
    networks: list[RankedFacet]
    decades: list[RankedFacet]
    content_ratings: list[RankedFacet]
    by_source: list[RankedFacet]


# --- saved views ----------------------------------------------------------


SavedViewPage = Literal["media", "watchlist", "history"]

# Long enough for a query with several multi-value facets in it; short enough
# that this cannot be used as free storage. A browse URL that exceeds it is
# already past what most proxies will forward.
MAX_QUERY_LENGTH = 2000


class SavedViewIn(BaseModel):
    """Save the current browse query under a name.

    `query` is the raw query string, exactly as the URL holds it. It is never
    parsed here — see `models.SavedView` — so the only checks are on length and
    on the name, and the leading `?` is tolerated because that is what
    `location.search` hands over.
    """

    page: SavedViewPage
    name: str = Field(min_length=1, max_length=80)
    query: str = Field(max_length=MAX_QUERY_LENGTH)


class SavedViewPatch(BaseModel):
    """Rename a view, re-point it at the current query, or both.

    Both optional and neither defaulted to the current value: a field that was
    not sent is a field that does not change, which is what lets the rename
    control and the "update to what I am looking at now" control share one
    endpoint without either clobbering the other.
    """

    name: str | None = Field(None, min_length=1, max_length=80)
    query: str | None = Field(None, max_length=MAX_QUERY_LENGTH)


class SavedViewOut(ORMModel):
    id: int
    page: SavedViewPage
    name: str
    query: str
    created_at: datetime
    updated_at: datetime


# --- themes ---------------------------------------------------------------
#
# The wire shapes for `routers/themes.py`. Deliberately thin: the format is
# STYLE-GUIDE §3.2 and lives in `services/themes.py`, and a second definition of
# it here — a model per colour key, say — would be a second thing to keep in
# step with a file format that may never change.


#: What a name may *arrive* as. The format's own bound is 64 characters and it
#: is applied by cutting, not by refusing — §3.2 holds a name "to the same bound
#: in both directions", so a long one is trimmed rather than rejected. This is
#: only here to stop a megabyte of text being carried around to be cut to 64.
THEME_NAME_INPUT_MAX = 512


class ThemeSummary(BaseModel):
    """A row in the theme picker."""

    id: str
    name: str
    base: str
    #: Compiled in, read-only, and not in the library directory. Spelled the
    #: way the User flags are (`is_admin`, `is_active`), because a bare
    #: `builtin` reads as a noun in a payload full of them.
    is_builtin: bool
    #: Whether the base is a dark theme. The client stamps `class="dark"` or
    #: `"light"` to match, because `tokens.css` carries values that are not
    #: among the twenty-seven and still differ by theme.
    dark: bool


class ThemeDetail(ThemeSummary):
    """A theme with its twenty-seven stored keys, for the editor."""

    colours: dict[str, str]


class ThemeCreate(BaseModel):
    """Copy `source_id` under a new name — the only way to make a theme.

    `source_id` defaults to the family's dark built-in so a bare "new theme"
    still means something; the interface sends whatever is currently applied.
    """

    name: str = Field(min_length=1, max_length=THEME_NAME_INPUT_MAX)
    source_id: str = Field("graphite", max_length=THEME_ID_MAX)


class ThemePatch(BaseModel):
    """Rename, write some colours, or both. An absent field does not change.

    `colours` is a partial table: only the keys sent are written, so the editor
    can save one swatch without shipping the other twenty-six back.
    """

    name: str | None = Field(None, min_length=1, max_length=THEME_NAME_INPUT_MAX)
    colours: dict[str, str] | None = None


class ThemeImported(BaseModel):
    """The imported theme, and how much of the file could not be read.

    `skipped_lines` is the whole reason this is not just `ThemeDetail`: §3.2 says an
    import that loses something must say so, and a 200 with no detail would
    swallow it.
    """

    theme: ThemeDetail
    #: Named for what it counts rather than for what happened to it, because
    #: the interface has to put the number in a sentence.
    skipped_lines: int


PlexAuthPoll.model_rebuild()
