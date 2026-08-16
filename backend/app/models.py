"""SQLAlchemy ORM models.

Design notes
------------
* ``MediaItem`` is the *canonical* record for a movie/show/season/episode. It is
  deduplicated across Plex servers via ``guid_key`` so that the same show on two
  servers (or a show you have on Plex and also added to your watchlist from
  Discover) collapses into one row.
* ``PlexMapping`` is the many-to-one join from a specific server's ``ratingKey``
  back to that canonical item.
* Two-way sync needs to know *which side changed*. Every syncable user field
  therefore stores both the local value and the last value we observed on Plex
  (``plex_*``), plus timestamps. If local changed since the last sync and Plex
  did not, we push; if Plex changed and local did not, we pull; if both changed
  the newer timestamp wins.
"""
from __future__ import annotations

import enum
from datetime import UTC, date, datetime, time

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator


def utcnow() -> datetime:
    return datetime.now(UTC)


class UtcDateTime(TypeDecorator):
    """A timestamp that is always timezone-aware UTC on the way in and out.

    SQLite has no native timestamp type and hands back naive ``datetime``
    objects regardless of ``DateTime(timezone=True)``. Comparing one of those to
    ``utcnow()`` raises ``TypeError``, which would otherwise blow up any sync
    that compares a stored time to the current one. Normalising here means no
    caller has to remember.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | date | None, dialect):
        if value is None:
            return None
        if not isinstance(value, datetime):
            # A bare date used as a bound comparison means "from midnight".
            value = datetime.combine(value, time.min)
        if value.tzinfo is None:
            # Naive input is assumed UTC: everything Tally writes is UTC.
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    def process_result_value(self, value: datetime | None, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


class Base(DeclarativeBase):
    pass


class MediaType(str, enum.Enum):
    MOVIE = "movie"
    SHOW = "show"
    SEASON = "season"
    EPISODE = "episode"


class WatchStatus(str, enum.Enum):
    PLAN_TO_WATCH = "plan_to_watch"
    WATCHING = "watching"
    COMPLETED = "completed"
    ON_HOLD = "on_hold"
    DROPPED = "dropped"


class WatchSource(str, enum.Enum):
    PLEX_HISTORY = "plex_history"
    PLEX_WEBHOOK = "plex_webhook"
    PLEX_SESSION = "plex_session"
    MANUAL = "manual"
    IMPORT = "import"


class CreditKind(str, enum.Enum):
    CAST = "cast"
    DIRECTOR = "director"


class SyncStatus(str, enum.Enum):
    RUNNING = "running"
    SUCCESS = "success"
    PARTIAL = "partial"
    FAILED = "failed"
    CANCELLED = "cancelled"


# ---------------------------------------------------------------------------
# Users & servers
# ---------------------------------------------------------------------------


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String(255), default=None)
    display_name: Mapped[str | None] = mapped_column(String(128), default=None)
    avatar_url: Mapped[str | None] = mapped_column(Text, default=None)

    # Plex identity. Null for local-only accounts.
    plex_user_id: Mapped[str | None] = mapped_column(
        String(64), unique=True, index=True, default=None
    )
    plex_username: Mapped[str | None] = mapped_column(String(128), default=None)
    # Fernet-encrypted plex.tv auth token.
    plex_token_encrypted: Mapped[str | None] = mapped_column(Text, default=None)
    # Plex home users have a different id on the *server* than on plex.tv;
    # history endpoints key off this one.
    plex_account_id: Mapped[int | None] = mapped_column(Integer, default=None)

    password_hash: Mapped[str | None] = mapped_column(Text, default=None)

    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Per-user toggles: sync_ratings, sync_watchlist, sync_history, anime_split…
    preferences: Mapped[dict] = mapped_column(JSON, default=dict)

    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None
    )
    last_full_sync_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None
    )

    states: Mapped[list[UserMediaState]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class PlexServer(Base):
    __tablename__ = "plex_servers"

    id: Mapped[int] = mapped_column(primary_key=True)
    machine_identifier: Mapped[str] = mapped_column(
        String(128), unique=True, index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    base_url: Mapped[str] = mapped_column(Text)
    # Alternate connection URIs discovered from plex.tv, tried in order when the
    # primary base_url is unreachable.
    candidate_urls: Mapped[list] = mapped_column(JSON, default=list)
    # Set by the user to pin one address and skip discovery entirely. Plex
    # advertises a URI for every address it can see, which for a Plex server
    # running in Docker includes each of its host's bridge gateways — addresses
    # nothing outside that host can reach. Probing them costs a DNS lookup
    # apiece, so someone who knows the right address can say so directly.
    manual_url: Mapped[str | None] = mapped_column(Text, default=None)
    access_token_encrypted: Mapped[str] = mapped_column(Text)
    owned: Mapped[bool] = mapped_column(Boolean, default=True)
    version: Mapped[str | None] = mapped_column(String(64), default=None)
    platform: Mapped[str | None] = mapped_column(String(64), default=None)

    # Mirror of the server's own "Weeks to consider for On Deck and Continue
    # Watching" (`onDeckWindow`), so Tally's Continue Watching ages items out
    # the way Plex does. None means the server never told us — only the owner's
    # token may read `/:/prefs`.
    on_deck_window_weeks: Mapped[int | None] = mapped_column(Integer, default=None)

    owner_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), default=None
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None
    )
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)

    # order_by keeps the eager-loaded list stable for the API, which used to
    # sort libraries in the router with its own query.
    libraries: Mapped[list[PlexLibrary]] = relationship(
        back_populates="server",
        cascade="all, delete-orphan",
        order_by="PlexLibrary.title",
    )


class UserServerAccess(Base):
    """Per-user access token for a given Plex server.

    Ratings, watch state and history are *per user* in Plex and are only visible
    through that user's own token. Sharing one token across Tally accounts would
    report the server owner's ratings to everybody, so each linked user keeps
    their own token (issued by plex.tv/api/v2/resources) plus the server-side
    ``accountID`` that history endpoints filter on.
    """

    __tablename__ = "user_server_access"
    __table_args__ = (UniqueConstraint("user_id", "server_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    server_id: Mapped[int] = mapped_column(
        ForeignKey("plex_servers.id", ondelete="CASCADE"), index=True
    )
    access_token_encrypted: Mapped[str] = mapped_column(Text)
    plex_account_id: Mapped[int | None] = mapped_column(Integer, default=None)
    owned: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_history_sync_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None
    )
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class PlexLibrary(Base):
    __tablename__ = "plex_libraries"
    __table_args__ = (UniqueConstraint("server_id", "section_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    server_id: Mapped[int] = mapped_column(
        ForeignKey("plex_servers.id", ondelete="CASCADE"), index=True
    )
    section_key: Mapped[str] = mapped_column(String(32))
    section_uuid: Mapped[str | None] = mapped_column(String(64), default=None)
    title: Mapped[str] = mapped_column(String(255))
    # "movie" or "show" as reported by Plex.
    section_type: Mapped[str] = mapped_column(String(32))

    # Tri-state anime override: True/False force it, None means "auto-detect".
    anime_override: Mapped[bool | None] = mapped_column(Boolean, default=None)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    item_count: Mapped[int] = mapped_column(Integer, default=0)
    last_synced_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None
    )

    server: Mapped[PlexServer] = relationship(back_populates="libraries")


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------


class MediaItem(Base):
    __tablename__ = "media_items"
    __table_args__ = (
        Index("ix_media_items_show_season_ep", "show_id", "season_number", "episode_number"),
        Index("ix_media_items_type_anime", "media_type", "is_anime"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # Canonical dedup key, e.g. "tmdb:movie:603" / "tvdb:81189" / "title:akira:1988".
    guid_key: Mapped[str] = mapped_column(String(255), unique=True, index=True)

    media_type: Mapped[MediaType] = mapped_column(Enum(MediaType), index=True)
    title: Mapped[str] = mapped_column(String(512), index=True)
    sort_title: Mapped[str | None] = mapped_column(String(512), default=None)
    original_title: Mapped[str | None] = mapped_column(String(512), default=None)
    year: Mapped[int | None] = mapped_column(Integer, default=None, index=True)

    overview: Mapped[str | None] = mapped_column(Text, default=None)
    tagline: Mapped[str | None] = mapped_column(Text, default=None)
    poster_url: Mapped[str | None] = mapped_column(Text, default=None)
    backdrop_url: Mapped[str | None] = mapped_column(Text, default=None)
    # Artwork on Plex Discover is a path relative to the host that served the
    # payload, and fetching it needs the viewer's own plex.tv token. The token
    # must never be baked into a URL: a MediaItem row is shared by every Tally
    # account, so the path is stored bare and `routers/images.py` proxies it.
    discover_thumb_path: Mapped[str | None] = mapped_column(Text, default=None)
    discover_art_path: Mapped[str | None] = mapped_column(Text, default=None)

    runtime_minutes: Mapped[int | None] = mapped_column(Integer, default=None)
    content_rating: Mapped[str | None] = mapped_column(String(32), default=None)
    studio: Mapped[str | None] = mapped_column(String(255), default=None)
    network: Mapped[str | None] = mapped_column(String(255), default=None)
    genres: Mapped[list] = mapped_column(JSON, default=list)
    # airing / ended / released / upcoming
    release_status: Mapped[str | None] = mapped_column(String(32), default=None)
    first_aired: Mapped[date | None] = mapped_column(Date, default=None)
    community_rating: Mapped[float | None] = mapped_column(Float, default=None)

    # External ids
    tmdb_id: Mapped[int | None] = mapped_column(Integer, default=None, index=True)
    tvdb_id: Mapped[int | None] = mapped_column(Integer, default=None, index=True)
    imdb_id: Mapped[str | None] = mapped_column(String(32), default=None, index=True)
    mal_id: Mapped[int | None] = mapped_column(Integer, default=None, index=True)
    anilist_id: Mapped[int | None] = mapped_column(Integer, default=None)

    # A home video. Plex types one as a movie and the history import has only
    # its filename to go on, so without this it is indistinguishable from a
    # film nobody can identify: enrichment retries it weekly forever and the
    # browse grids list it among the films. Set from the title's shape by
    # `services/release_names.looks_like_capture_filename`, and re-evaluated on
    # every import, so a file Plex later matches properly stops being one.
    is_personal_media: Mapped[bool] = mapped_column(Boolean, default=False)

    is_anime: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    # Which signal decided it: "library", "mal", "tmdb_keyword", "genre", "manual"…
    anime_source: Mapped[str | None] = mapped_column(String(64), default=None)
    anime_format: Mapped[str | None] = mapped_column(String(32), default=None)  # TV/Movie/OVA/ONA

    # Hierarchy: episode -> season -> show. ``show_id`` is denormalised onto
    # episodes so the common "all episodes of show X" query is a single index hit.
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("media_items.id", ondelete="CASCADE"), default=None, index=True
    )
    show_id: Mapped[int | None] = mapped_column(
        ForeignKey("media_items.id", ondelete="CASCADE"), default=None, index=True
    )
    season_number: Mapped[int | None] = mapped_column(Integer, default=None)
    episode_number: Mapped[int | None] = mapped_column(Integer, default=None)
    child_count: Mapped[int | None] = mapped_column(Integer, default=None)
    leaf_count: Mapped[int | None] = mapped_column(Integer, default=None)

    metadata_updated_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None
    )
    # When the cast and crew were last fetched. This is the only thing that
    # tells "nobody has ever asked" apart from "the provider was asked and had
    # nothing", and both look like an empty credit list — without it every
    # render of every credit-less title would go back out to TMDB.
    credits_updated_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None
    )
    # Indexed: this is the `added` sort in media_filters, and every other
    # sortable column here already is.
    created_at: Mapped[datetime] = mapped_column(
        UtcDateTime, default=utcnow, index=True
    )

    mappings: Mapped[list[PlexMapping]] = relationship(
        back_populates="item", cascade="all, delete-orphan"
    )


class PlexMapping(Base):
    __tablename__ = "plex_mappings"
    __table_args__ = (UniqueConstraint("server_id", "rating_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    media_item_id: Mapped[int] = mapped_column(
        ForeignKey("media_items.id", ondelete="CASCADE"), index=True
    )
    server_id: Mapped[int] = mapped_column(
        ForeignKey("plex_servers.id", ondelete="CASCADE"), index=True
    )
    library_id: Mapped[int | None] = mapped_column(
        ForeignKey("plex_libraries.id", ondelete="SET NULL"), default=None
    )
    rating_key: Mapped[str] = mapped_column(String(64), index=True)
    guid: Mapped[str | None] = mapped_column(Text, default=None)
    # plex.tv Discover guid (``plex://show/5d9c…``) — the key the watchlist API wants.
    plex_guid: Mapped[str | None] = mapped_column(String(128), default=None, index=True)
    thumb_path: Mapped[str | None] = mapped_column(Text, default=None)
    art_path: Mapped[str | None] = mapped_column(Text, default=None)
    # Indexed: orders "recently added" on the dashboard.
    added_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None, index=True
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None
    )

    item: Mapped[MediaItem] = relationship(back_populates="mappings")


class Person(Base):
    """Somebody credited on a title — an actor, or a director.

    Global, exactly like ``MediaItem``: one row serves every Tally account, and
    it is keyed on the TMDB person id because that is where credits come from
    (see ``services/credits.py`` for why not Plex).

    ``profile_url`` may hold a URL, unlike ``MediaItem.poster_url``'s Plex
    counterparts, because a TMDB image needs no credentials. Anything that ever
    starts sourcing portraits from Plex must store a bare path and proxy it —
    a URL carrying ``X-Plex-Token`` on a shared row leaks that token to every
    account.
    """

    __tablename__ = "people"

    id: Mapped[int] = mapped_column(primary_key=True)
    tmdb_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    # Indexed because the `director` browse filter matches on it.
    name: Mapped[str] = mapped_column(String(255), index=True)
    profile_url: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class MediaCredit(Base):
    """One person's credit on one title.

    Derived data, cached from TMDB: it is safe to delete and re-fetch, which is
    how a refresh works. Nothing a user typed lives here.
    """

    __tablename__ = "media_credits"
    __table_args__ = (
        UniqueConstraint("media_item_id", "person_id", "kind"),
        Index("ix_media_credits_kind_person", "kind", "person_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    media_item_id: Mapped[int] = mapped_column(
        ForeignKey("media_items.id", ondelete="CASCADE"), index=True
    )
    person_id: Mapped[int] = mapped_column(
        ForeignKey("people.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[CreditKind] = mapped_column(Enum(CreditKind))
    # Who they played. Null for a director, and for a cast entry the provider
    # left blank.
    character: Mapped[str | None] = mapped_column(String(255), default=None)
    # Billing order, so the leads come first rather than whatever order the
    # rows happened to be written in.
    ordering: Mapped[int] = mapped_column(Integer, default=0)

    person: Mapped[Person] = relationship()


# ---------------------------------------------------------------------------
# User activity
# ---------------------------------------------------------------------------


class WatchEvent(Base):
    """Append-only log of "this was watched at this time"."""

    __tablename__ = "watch_events"
    __table_args__ = (
        UniqueConstraint("user_id", "dedupe_key", name="uq_watch_event_dedupe"),
        Index("ix_watch_events_user_time", "user_id", "watched_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    media_item_id: Mapped[int] = mapped_column(
        ForeignKey("media_items.id", ondelete="CASCADE"), index=True
    )
    watched_at: Mapped[datetime] = mapped_column(UtcDateTime, index=True)
    source: Mapped[WatchSource] = mapped_column(Enum(WatchSource))
    # Stable identity for idempotent re-imports: "plex:<server>:<historyKey>" or
    # "manual:<uuid>". Without it a re-sync would duplicate the whole history.
    dedupe_key: Mapped[str] = mapped_column(String(255))

    progress_ms: Mapped[int | None] = mapped_column(Integer, default=None)
    duration_ms: Mapped[int | None] = mapped_column(Integer, default=None)
    completed: Mapped[bool] = mapped_column(Boolean, default=True)
    device: Mapped[str | None] = mapped_column(String(255), default=None)
    player: Mapped[str | None] = mapped_column(String(255), default=None)
    server_id: Mapped[int | None] = mapped_column(
        ForeignKey("plex_servers.id", ondelete="SET NULL"), default=None
    )
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class UserMediaState(Base):
    """Per-user rollup: status, rating, progress. One row per (user, item)."""

    __tablename__ = "user_media_states"
    __table_args__ = (
        UniqueConstraint("user_id", "media_item_id"),
        Index("ix_ums_user_status", "user_id", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    media_item_id: Mapped[int] = mapped_column(
        ForeignKey("media_items.id", ondelete="CASCADE"), index=True
    )

    status: Mapped[WatchStatus | None] = mapped_column(
        Enum(WatchStatus), default=None, index=True
    )
    view_count: Mapped[int] = mapped_column(Integer, default=0)
    last_watched_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None, index=True
    )
    # In-progress playback offset, mirrors Plex's viewOffset.
    progress_ms: Mapped[int | None] = mapped_column(Integer, default=None)
    duration_ms: Mapped[int | None] = mapped_column(Integer, default=None)

    # --- Rating, tracked on both sides for conflict resolution ------------
    rating: Mapped[float | None] = mapped_column(Float, default=None)  # 0-10
    rating_updated_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None
    )
    plex_rating: Mapped[float | None] = mapped_column(Float, default=None)
    plex_rating_synced_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None
    )

    is_favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str | None] = mapped_column(Text, default=None)

    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime, default=utcnow, onupdate=utcnow
    )

    user: Mapped[User] = relationship(back_populates="states")
    item: Mapped[MediaItem] = relationship()


class WatchlistEntry(Base):
    """Watchlist membership, mirrored against the Plex Discover watchlist."""

    __tablename__ = "watchlist_entries"
    __table_args__ = (UniqueConstraint("user_id", "media_item_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    media_item_id: Mapped[int] = mapped_column(
        ForeignKey("media_items.id", ondelete="CASCADE"), index=True
    )

    # False == tombstone. Removals must persist, otherwise the next pull from
    # Plex would happily re-add something the user deleted locally.
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    added_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    removed_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None
    )
    source: Mapped[str] = mapped_column(String(32), default="tally")
    # Last membership state we observed on Plex, for change detection.
    plex_active: Mapped[bool | None] = mapped_column(Boolean, default=None)
    plex_synced_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None
    )
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime, default=utcnow, onupdate=utcnow
    )

    item: Mapped[MediaItem] = relationship()


# ---------------------------------------------------------------------------
# Plumbing
# ---------------------------------------------------------------------------


class SyncRun(Base):
    __tablename__ = "sync_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), default=None, index=True
    )
    kind: Mapped[str] = mapped_column(String(64))
    status: Mapped[SyncStatus] = mapped_column(Enum(SyncStatus), default=SyncStatus.RUNNING)
    started_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime, default=None
    )
    stats: Mapped[dict] = mapped_column(JSON, default=dict)
    messages: Mapped[list] = mapped_column(JSON, default=list)
    error: Mapped[str | None] = mapped_column(Text, default=None)

    # What the run is doing right now, so the UI can say more than "syncing".
    phase: Mapped[str | None] = mapped_column(String(255), default=None)
    # Units of the current phase, not of the run as a whole — a sync does not
    # know its total work up front, so a single overall percentage would be a
    # lie. Zero total means "no meaningful bar, show it as indeterminate".
    progress_current: Mapped[int] = mapped_column(Integer, default=0)
    progress_total: Mapped[int] = mapped_column(Integer, default=0)
    # Set by the cancel endpoint. The sync checks it between units of work and
    # stops at the next boundary rather than being killed mid-write.
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)


class PlexPin(Base):
    """Short-lived record for an in-flight Plex OAuth PIN exchange."""

    __tablename__ = "plex_pins"

    id: Mapped[int] = mapped_column(primary_key=True)
    pin_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    code: Mapped[str] = mapped_column(String(32))
    # Random token handed to the browser so only the initiating client can
    # redeem this PIN.
    state: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)
    # Set when the flow was started by an already-signed-in account, i.e. a
    # relink. It is the *only* thing that may attach a Plex identity to an
    # existing user: the poll endpoint is anonymous, so without proof of a
    # session recorded here, matching on username alone would let anyone with
    # a matching plex.tv name take over a local account.
    link_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), default=None
    )



class ApiKey(Base):
    """A long-lived credential that acts as its owning user.

    Only the hash is stored, so a leaked database does not hand over working
    keys, and the plaintext is shown exactly once at creation. Revocation is a
    timestamp rather than a delete, so `last_used_at` survives to answer "was
    this key being used before I killed it?".
    """

    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    # The visible half, stored plainly so a key can be looked up without
    # scanning every row — and so the UI can tell two keys apart.
    prefix: Mapped[str] = mapped_column(String(32), index=True)
    key_hash: Mapped[str] = mapped_column(String(64))

    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    revoked_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime, default=utcnow, onupdate=utcnow
    )
