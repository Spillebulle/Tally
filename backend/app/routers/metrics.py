"""Prometheus exposition, hand-rolled.

**No `prometheus_client`.** The library brings a process-global registry, a set
of default collectors nobody asked for (Python GC stats on a media tracker), and
a multiprocess mode with a directory of shared files behind it — all to render
about ten lines of text whose format is a paragraph of specification. The format
is stable, the escaping rules are three characters long, and the whole renderer
below fits on one screen. That trade does not come out in the library's favour.

**Every metric is declared a gauge, including the ones whose names end in
`_total`.** Tally's totals can go *down*: `DELETE /api/history/{id}` removes a
play, a merge collapses two items into one, a library disappears when a server
is unlinked. Prometheus reads any decrease in a counter as a process restart and
extrapolates across it, so `rate()` and `increase()` over a decrementing counter
do not merely lag — they over-report, silently, and only on the scrapes that
straddle the deletion. A gauge makes no such assumption. Use `delta()` or
`deriv()` if you want a rate out of these.

**Cardinality is bounded on purpose.** `media_type` has four values and a
household has a handful of users; a title does not, and one label per film would
put tens of thousands of series into somebody's Prometheus for no question
anybody asks of it. Never label by title, genre, studio or device here — that is
what `GET /api/stats/series` is for, where the caller chooses the cut and pays
for it once.

**The snapshot is cached for ten seconds.** A 15-second scrape interval is
normal and two Prometheus servers scraping one Tally is not unusual; without a
cache that is an aggregation over the whole watch history every few seconds,
forever. The cache holds the *numbers* — computed for every account — rather
than the rendered text, so it is one module-level slot rather than one entry per
caller, and the per-caller decision (whose series may this key see?) happens
afterwards, on data already in memory.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import datetime

from fastapi import APIRouter, Response
from sqlalchemy import func, select

from .. import __version__
from ..deps import CurrentUser, DbSession
from ..models import (
    MediaItem,
    MediaType,
    SyncRun,
    SyncStatus,
    User,
    WatchEvent,
    WatchlistEntry,
    utcnow,
)
from ..timezones import resolve as resolve_timezone
from .stats import _minutes, _streaks

router = APIRouter(tags=["stats"])

CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

# How long a computed snapshot stays good for. Comfortably under the shortest
# scrape interval anybody uses, so consecutive scrapes of a *different* Tally
# metric still see fresh numbers, and comfortably above the cost of the
# aggregation itself.
CACHE_SECONDS = 10.0


@dataclass
class _UserFacts:
    """Everything scoped to one account."""

    label: str
    events: int = 0
    minutes_by_type: dict[str, int] = field(default_factory=dict)
    events_by_type: dict[str, int] = field(default_factory=dict)
    watchlist: int = 0
    current_streak: int = 0
    longest_streak: int = 0
    last_sync: datetime | None = None
    sync_running: bool = False


@dataclass
class _Snapshot:
    """One pass over the database, for every account at once."""

    library: dict[str, int] = field(default_factory=dict)
    users: dict[int, _UserFacts] = field(default_factory=dict)


_cache: tuple[float, _Snapshot] | None = None
_cache_lock = asyncio.Lock()
_computations = 0


def reset_cache() -> None:
    """Drop the cached snapshot. For tests, which must not inherit one."""
    global _cache, _computations
    _cache = None
    _computations = 0


def computations() -> int:
    """How many times the snapshot has actually been built. For tests."""
    return _computations


# --- exposition -----------------------------------------------------------


def escape_label(value: str) -> str:
    """The three escapes the text format defines, in the order that matters.

    Backslash first: doing it last would re-escape the backslashes the other two
    rules just introduced.
    """
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _metric(name: str, labels: dict[str, str], value: float) -> str:
    if labels:
        rendered = ",".join(
            f'{key}="{escape_label(str(val))}"' for key, val in labels.items()
        )
        name = f"{name}{{{rendered}}}"
    # Integers render without a decimal point; Prometheus accepts both, and the
    # bare form is what a human reading `curl /metrics` expects.
    if isinstance(value, int) or float(value).is_integer():
        return f"{name} {int(value)}"
    return f"{name} {value}"


class _Exposition:
    """Accumulates lines, emitting each metric's HELP and TYPE exactly once.

    **A family's samples have to be contiguous.** The text format allows one
    HELP/TYPE pair per metric name and expects every sample for that name to
    follow it in one block; reopening a family later is a duplicate-declaration
    error to a strict parser and, to a lenient one, a silently dropped series.
    It is an easy shape to write by accident — a loop over media types that
    emits two different metrics per turn interleaves them — so the guard below
    turns it into a 500 in testing rather than a scrape that half works.
    """

    def __init__(self) -> None:
        self.lines: list[str] = []
        self.declared: set[str] = set()
        self.current: str | None = None

    def add(self, name: str, help_text: str, labels: dict[str, str], value: float) -> None:
        if name != self.current:
            if name in self.declared:
                raise RuntimeError(
                    f"{name} was reopened after another metric; the exposition "
                    "format needs every family's samples in one block"
                )
            self.declared.add(name)
            self.current = name
            self.lines.append(f"# HELP {name} {help_text}")
            # Always a gauge — see the module docstring. Anything here can fall.
            self.lines.append(f"# TYPE {name} gauge")
        self.lines.append(_metric(name, labels, value))

    def render(self) -> str:
        # A trailing newline is required; a body ending mid-line is a parse
        # error in some clients and a silent last-sample loss in others.
        return "\n".join(self.lines) + "\n"


# --- the snapshot ---------------------------------------------------------


async def _build(db: DbSession) -> _Snapshot:
    global _computations
    _computations += 1
    snapshot = _Snapshot()

    for media_type, count in (
        await db.execute(
            select(MediaItem.media_type, func.count()).group_by(MediaItem.media_type)
        )
    ).all():
        snapshot.library[media_type.value if media_type else "unknown"] = count

    people = list((await db.execute(select(User))).scalars())
    for person in people:
        snapshot.users[person.id] = _UserFacts(
            label=person.display_name or person.username,
            last_sync=person.last_full_sync_at,
        )

    # One pass over the plays, for everybody. The columns are the same ones the
    # stats aggregate reads, and `_minutes` is the same "how long was this"
    # rule — two answers to that question, on one dashboard, is the bug.
    rows = (
        await db.execute(
            select(
                WatchEvent.user_id,
                WatchEvent.watched_at,
                WatchEvent.duration_ms,
                MediaItem.media_type,
                MediaItem.runtime_minutes,
            ).join(MediaItem, MediaItem.id == WatchEvent.media_item_id)
        )
    ).all()

    days: dict[int, set] = {}
    zones = {
        person.id: resolve_timezone((person.preferences or {}).get("timezone"))
        for person in people
    }
    for user_id, watched_at, duration_ms, media_type, runtime in rows:
        facts = snapshot.users.get(user_id)
        if facts is None:  # pragma: no cover - a play whose account was deleted
            continue
        kind = media_type.value if media_type else "unknown"
        facts.events += 1
        facts.events_by_type[kind] = facts.events_by_type.get(kind, 0) + 1
        facts.minutes_by_type[kind] = facts.minutes_by_type.get(kind, 0) + _minutes(
            duration_ms, runtime, media_type
        )
        # A streak is counted in the viewer's own days, not the container's.
        days.setdefault(user_id, set()).add(watched_at.astimezone(zones[user_id]).date())

    for user_id, watched_days in days.items():
        today = utcnow().astimezone(zones[user_id]).date()
        current, longest = _streaks(watched_days, today)
        snapshot.users[user_id].current_streak = current
        snapshot.users[user_id].longest_streak = longest

    for user_id, count in (
        await db.execute(
            select(WatchlistEntry.user_id, func.count())
            .where(WatchlistEntry.active.is_(True))
            .group_by(WatchlistEntry.user_id)
        )
    ).all():
        if facts := snapshot.users.get(user_id):
            facts.watchlist = count

    for user_id in (
        await db.execute(
            select(SyncRun.user_id).where(SyncRun.status == SyncStatus.RUNNING)
        )
    ).scalars():
        if facts := snapshot.users.get(user_id):
            facts.sync_running = True

    return snapshot


async def _snapshot(db: DbSession) -> _Snapshot:
    """The cached snapshot, rebuilt at most once every `CACHE_SECONDS`.

    The lock is not paranoia: two Prometheus servers on the same interval land
    together often enough, and without it a cold cache is aggregated twice for
    one expiry. Re-checked inside the lock so the second caller takes what the
    first just built.
    """
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[0] < CACHE_SECONDS:
        return _cache[1]

    async with _cache_lock:
        now = time.monotonic()
        if _cache is not None and now - _cache[0] < CACHE_SECONDS:
            return _cache[1]
        snapshot = await _build(db)
        _cache = (now, snapshot)
        return snapshot


# --- the endpoint ---------------------------------------------------------


@router.get("/metrics", response_class=Response)
async def metrics(db: DbSession, user: CurrentUser) -> Response:
    """Live gauges for Prometheus, in the 0.0.4 text format.

    Reachable with a `stats`-scoped API key, which is what a scrape config
    should hold — see the Dashboards section of the README. Send it as a header;
    it is never read from the query string, because uvicorn logs query strings
    at INFO and those logs end up in issue reports.

    A non-administrator sees only their own per-user series. An administrator
    sees one series per account, labelled by display name or username — never by
    email address.
    """
    snapshot = await _snapshot(db)
    visible = (
        snapshot.users
        if user.is_admin
        else {user.id: snapshot.users[user.id]}
        if user.id in snapshot.users
        else {}
    )

    out = _Exposition()
    out.add(
        "tally_build_info",
        "Tally version, as a constant 1 labelled with the build.",
        {"version": __version__},
        1,
    )

    for media_type in MediaType:
        out.add(
            "tally_library_items",
            "Media items known to this install, by type. Global, not per user.",
            {"media_type": media_type.value},
            snapshot.library.get(media_type.value, 0),
        )

    # One loop per metric family, not one loop per account: every sample for a
    # name has to sit in one block. See `_Exposition`.
    people = list(visible.values())

    for name, help_text, read in (
        (
            "tally_watch_events_total",
            "Plays recorded. A gauge: deleting a history row lowers it.",
            lambda facts: facts.events,
        ),
        (
            "tally_watchlist_items",
            "Active watchlist entries. Removals are tombstoned, not counted.",
            lambda facts: facts.watchlist,
        ),
        (
            "tally_current_streak_days",
            "Consecutive days watched, ending today or yesterday.",
            lambda facts: facts.current_streak,
        ),
        (
            "tally_longest_streak_days",
            "Longest run of consecutive days ever watched.",
            lambda facts: facts.longest_streak,
        ),
        (
            "tally_sync_running",
            "1 while a sync is in progress for this account, 0 otherwise.",
            lambda facts: 1 if facts.sync_running else 0,
        ),
    ):
        for facts in people:
            out.add(name, help_text, {"user": facts.label}, read(facts))

    for name, help_text, table in (
        (
            "tally_watch_events_by_type_total",
            "Plays recorded, by media type. A gauge; see tally_watch_events_total.",
            "events_by_type",
        ),
        (
            "tally_watch_minutes_total",
            "Minutes watched, by media type. A gauge; deletions lower it.",
            "minutes_by_type",
        ),
    ):
        for facts in people:
            for media_type in MediaType:
                out.add(
                    name,
                    help_text,
                    {"user": facts.label, "media_type": media_type.value},
                    getattr(facts, table).get(media_type.value, 0),
                )

    for facts in people:
        # Omitted rather than zeroed when an account has never synced: 1970 on a
        # `time() - tally_last_sync_timestamp_seconds` panel reads as a
        # 56-year-old sync rather than as no sync at all.
        if facts.last_sync is not None:
            out.add(
                "tally_last_sync_timestamp_seconds",
                "Unix time of the last completed full sync for this account.",
                {"user": facts.label},
                facts.last_sync.timestamp(),
            )

    return Response(content=out.render(), media_type=CONTENT_TYPE)
