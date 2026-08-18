"""Resolving an IANA timezone name to a `tzinfo`, safely.

Every timestamp Tally stores is UTC (see `models.UtcDateTime`), which is the
only sane thing to store — but nobody watches television in UTC. "How many
films did I watch on Tuesday?" is a question about the viewer's own midnight,
and answering it in UTC moves a late-night play into the next day for everyone
east of Greenwich and into the previous one for everyone west of it. The
frontend already parses the day labels as *local* dates, so the backend has to
bucket in the same zone or the two silently disagree.

The name reaching `resolve()` is untrusted — it arrives as a query parameter,
or out of a JSON preferences blob somebody may have edited — so it is shape
checked before `ZoneInfo` sees it and an unusable value falls back to UTC
rather than raising. A stats page that renders in the wrong zone is a nuisance;
one that 500s is a broken page.
"""
from __future__ import annotations

import re
from datetime import UTC, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# IANA names are `Area/Location`, optionally with a third component, plus the
# legacy single-word ones (`UTC`, `GMT`) and the `Etc/GMT+5` family. Anything
# else — a path traversal, a null byte, an absolute path — never reaches
# ZoneInfo, which resolves keys against the filesystem.
_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){0,2}")
_MAX_LENGTH = 64


def is_valid(name: str | None) -> bool:
    """True if `name` names a timezone this process can actually load."""
    if not name:
        return False
    return _load(name) is not None


def resolve(name: str | None) -> tzinfo:
    """The zone `name` asks for, or UTC if it asks for nothing usable."""
    if not name:
        return UTC
    return _load(name) or UTC


def _load(name: str) -> tzinfo | None:
    if len(name) > _MAX_LENGTH or not _NAME.fullmatch(name):
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        # ZoneInfoNotFoundError: no such zone in the tzdata this image carries.
        # ValueError: a key ZoneInfo itself refuses, e.g. one containing "..".
        return None


def zone_for(preferences: dict | None, tz: str | None) -> tuple[tzinfo, str]:
    """The zone in force for one request, and the name to report it under.

    `?tz=` beats the stored preference, and an unloadable name falls back to UTC
    rather than 500ing — so the response has to say which zone it *actually*
    used, or a silent fallback looks like correct data in the wrong hours.

    It takes the preferences blob rather than the `User` row so this module
    stays free of the models, and so a caller with no user at all can still ask.
    """
    name = tz or (preferences or {}).get("timezone")
    zone = resolve(name)
    return zone, "UTC" if zone is UTC else str(name)
