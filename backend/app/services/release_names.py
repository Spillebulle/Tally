"""Reading a filename Plex handed us as a title.

Two questions, both about the same string and both answered here: is there a
real title hiding inside it (`parse_release_name`), and is it a title at all
(`looks_like_capture_filename`).

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

The second question is the one no recovery can answer. Some of these strings
are not a title *in principle*: a phone recording called ``2020-03-31
19.42.27``, or ``IMG_4821`` off a camera, is a home video played once through
Plex and picked up by the history import. There is no film behind it and never
will be, so every enrichment pass spends a provider call on it, gets nothing,
and leaves it exactly as it was — forever, and at the cost of a slot in a
bounded batch. `looks_like_capture_filename` is how that loop is broken, and it
is gated the same way: it recognises a *camera's* naming scheme — a full date
with a time on it, or a known device prefix followed by a serial — and refuses
everything else, so ``1917``, ``2012``, ``9-1-1``, ``Space: 1999`` and
``Apollo 13`` are all ordinary titles as far as it is concerned.
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


# --------------------------------------------------------------------------
# "This is not a title at all"
# --------------------------------------------------------------------------

# Containers a personal-media library keeps the extension on. Photo extensions
# are deliberately absent: Tally never sees a still, and every one added is
# another string that can be stripped off a real title.
_EXTENSION_RE = re.compile(r"\.(mp4|mov|m4v|avi|mkv|3gp|mts|wmv)$", re.IGNORECASE)

# The " (1)" a second copy of the same file picks up.
_COPY_SUFFIX_RE = re.compile(r"\s*[(\[]\d{1,2}[)\]]$")

# A full date with a time on it, however the device punctuated it:
# "2020-03-31 19.42.27", "20200331_194227", "2021_11_05 08-30-00".
# The time is required. A bare date is a plausible thing to call a film — a
# documentary, an anniversary — and the whole point of this check is that it
# only ever answers when it is sure.
_CAPTURE_TIMESTAMP_RE = re.compile(
    r"""^
    (?P<year>19\d{2}|20\d{2}) [-_.]? (?P<month>\d{2}) [-_.]? (?P<day>\d{2})
    [-_.\sTt]{1,3}
    (?P<hour>\d{2}) [-_.:]? (?P<minute>\d{2}) (?:[-_.:]? (?P<second>\d{2}))?
    $""",
    re.VERBOSE,
)

# Device prefixes, and only ones a camera or a phone actually writes. A prefix
# not on this list is a word, and a word in front of a number is a title:
# "Space 1999", "Rocky 4", "THX 1138".
_CAPTURE_PREFIXES = frozenset(
    {"img", "vid", "mov", "mvi", "dsc", "dscn", "dscf", "pxl", "gopr", "gopro",
     "dji", "pano", "burst", "cimg", "gh", "gx"}
)

# <prefix><serial>, with the groups a device puts between the parts:
# "IMG_4821", "DSC00123", "PXL_20211105_083000", "VID_20200331_194227".
_CAPTURE_PREFIX_RE = re.compile(
    r"^(?P<prefix>[A-Za-z]{2,5})[-_ ]?\d{3,}(?:[-_ ]\d{2,})*$"
)


def _is_capture_timestamp(value: str) -> bool:
    match = _CAPTURE_TIMESTAMP_RE.match(value)
    if match is None:
        return False
    # A shape that parses is not yet a timestamp: "11-11-11 22-22-22" would,
    # and so would any six-then-six digit string a title happens to contain.
    # Only a real date and a real clock time get through.
    month, day = int(match["month"]), int(match["day"])
    hour, minute = int(match["hour"]), int(match["minute"])
    second = int(match["second"] or 0)
    return (
        1 <= month <= 12
        and 1 <= day <= 31
        and hour <= 23
        and minute <= 59
        and second <= 59
    )


def looks_like_capture_filename(value: str) -> bool:
    """Whether this is a camera's name for a file rather than anybody's title.

    ``True`` means "no provider will ever match this, so stop asking" — a
    home video, not a film. It is the same bargain as `parse_release_name`
    struck the other way round: a missed one costs a wasted provider call a
    week, a wrong one declares somebody's film to be a home video, so the
    default answer is ``False`` and it takes a device's own naming scheme to
    change it.
    """
    if not value:
        return False
    stripped = _COPY_SUFFIX_RE.sub("", _EXTENSION_RE.sub("", value.strip())).strip()
    if not stripped:
        return False
    if _is_capture_timestamp(stripped):
        return True
    match = _CAPTURE_PREFIX_RE.match(stripped)
    return match is not None and match["prefix"].lower() in _CAPTURE_PREFIXES
