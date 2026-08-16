"""Recovering a real title from a filename Plex handed us as one.

Plex's watch history stores a *snapshot* of each play, taken on the day it
happened. A file that was still unmatched that day is snapshotted under its
filename, and Plex keeps that string forever — so a 2019 play comes back today
as ``The.Jungle.Book.2.2003.1080p.BluRay.H264.AAC-RARBG`` even though the
library has had the film properly matched for years.

The import has no choice but to take that string as a title, and it is then the
only thing enrichment has to work with. No provider matches on it, so the row
never gets an external id — and `merge_duplicates` pairs rows on an id, so it
can never collapse the ghost against the real one. On a live instance that was
five permanent duplicates, each a blank tile sitting beside a properly postered
twin.

This turns a release name back into something a provider can answer, and it is
deliberately narrow. `parse_release_name` returns ``None`` unless the string
could not plausibly be a real title:

* a **quality token** is present (``1080p``, ``BluRay``, ``XviD``, ``AC3`` …),
  which no film is called; or
* the string contains **no spaces at all**, which is what dot-separated release
  names look like and what real titles almost never do.

Either way there must also be a year or a quality token *after* the first
token to cut at, so ``S.W.A.T.``, ``2 Fast 2 Furious``, ``Blade Runner 2049``
and ``2001: A Space Odyssey`` are all left exactly as they are. A missed
recovery leaves a visible oddity; a wrong one renames somebody's library.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Tokens that appear in release names and in no film title. Deliberately only
# resolutions, sources, codecs and audio formats: words like "extended",
# "limited" or "proper" are also release tags, but they are real title words
# too and using them as the signal would rename real films.
_QUALITY_TOKENS = frozenset(
    {
        # resolution
        "480p", "576p", "720p", "1080p", "1440p", "2160p", "4k", "8k",
        # source
        "bluray", "blu-ray", "brrip", "bdrip", "bdremux", "dvdrip", "dvdscr",
        "dvd5", "dvd9", "hdtv", "pdtv", "webrip", "web-dl", "webdl", "hdrip",
        "remux", "vhsrip", "hdcam", "telesync",
        # video codec
        "x264", "x265", "h264", "h265", "hevc", "xvid", "divx", "avc",
        # audio
        "aac", "ac3", "eac3", "dts", "dtshd", "truehd", "flac", "dd5", "ddp5",
    }
)

# 1900-2099. Anything outside that is not a release year and is more likely to
# be part of a title ("2312", "1408").
_YEAR_RE = re.compile(r"^(?:19|20)\d{2}$")

# Release names separate words with dots or underscores; some use spaces.
_SPLIT_RE = re.compile(r"[.\s_]+")


@dataclass(frozen=True, slots=True)
class ReleaseName:
    """What a release name was hiding: a title, and sometimes a year."""

    title: str
    year: int | None


def _is_quality(token: str) -> bool:
    lowered = token.lower()
    if lowered in _QUALITY_TOKENS:
        return True
    # Release groups are glued to the last tag with a hyphen — "AAC-RARBG",
    # "AC3-FLAWL3SS" — so the tag itself is the part before it. Checked
    # separately rather than splitting on "-", which would break "blu-ray".
    head = lowered.split("-", 1)[0]
    return head != lowered and head in _QUALITY_TOKENS


def _is_year(token: str) -> bool:
    return bool(_YEAR_RE.match(token))


def parse_release_name(value: str) -> ReleaseName | None:
    """The title and year hiding inside a release name, or ``None``.

    ``None`` means "this is already a title, leave it alone", and that is the
    answer for everything the gate is not certain about.
    """
    if not value:
        return None

    tokens = [token for token in _SPLIT_RE.split(value.strip()) if token]
    if len(tokens) < 2:
        return None

    has_quality = any(_is_quality(token) for token in tokens)
    # Without a quality tag the only other tell is the shape: a dot-separated
    # name has no spaces. "Winnie the Pooh 2011" and "Blade Runner 2049" have
    # spaces and no tag, so neither is touched — and neither should be, since
    # the second one's "year" is part of the name.
    if not has_quality and " " in value.strip():
        return None

    # Cut at the first year or quality tag, which is where the title ends.
    # Never at index 0: "1917" and "2001: A Space Odyssey" open with one.
    cut = next(
        (
            index
            for index, token in enumerate(tokens)
            if index > 0 and (_is_year(token) or _is_quality(token))
        ),
        None,
    )
    if cut is None:
        return None

    title = " ".join(tokens[:cut]).strip(" -_")
    if not title:
        return None

    year = int(tokens[cut]) if _is_year(tokens[cut]) else None
    if title == value:
        # Nothing was actually recovered; say so rather than reporting a
        # change that is not one.
        return None
    return ReleaseName(title=title, year=year)
