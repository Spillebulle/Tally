"""Deciding whether two strings name the same title.

One definition, used by everything that has to answer that question, because
the two callers are the two halves of the same rule:

* `merge_duplicates` will not fuse two rows that share an external id unless
  they also agree on the title, since a wrong id does get attached.
* The metadata providers will not *attach* an external id from a title search
  unless the result agrees with the title they searched for, which is the point
  upstream where those wrong ids come from.

The comparison is **exact once normalised** — accents, case, punctuation and
spacing removed, and nothing else. In particular a prefix does not count, and
that is the whole design:

    "Men"         is a prefix of "Men in Black"
    "Society"     is a suffix of "Dead Poets Society"
    "Thelma"      is a prefix of "Thelma & Louise"
    "Anti-Social" is a prefix of "Anti-Social Limited"

Every one of those is a real wrong match this instance has stored, each time
because a search was asked for a short title and handed back a longer film that
merely starts with it. `mal._titles_match` *does* allow a prefix, deliberately
and correctly: MAL titles are romanised and carry subtitles Plex does not, and
a MAL hit is only ever corroborating evidence for the anime classifier. A TMDB
or TVDB hit becomes the row's identity, so it gets equality.

The cost of the strictness is a missed match when the two sides genuinely spell
it differently ("Se7en" against "Seven"), which leaves an item without artwork
until somebody looks. That is the visible mistake, and it is the one to prefer:
a wrong id is silent, it survives every later pass, and it takes the row out of
`backfill_missing_metadata` — which only looks at rows with no id at all — so
nothing ever reconsiders it.
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def normalise_title(value: str | None) -> str:
    """Case, accents and punctuation removed — "Wall·E" and "wall-e" agree.

    Deliberately not `slugify`, which keeps separators because it is building a
    stable key. Here the question is only "is this the same title spelled
    differently", and Plex, TMDB and TVDB differ on punctuation constantly.
    """
    ascii_only = (
        unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode()
    )
    return _NON_ALNUM.sub("", ascii_only.lower())


def title_agrees(wanted: str | None, candidates: Iterable[str | None]) -> bool:
    """Whether any of ``candidates`` is the same title as ``wanted``.

    An empty ``wanted`` is never agreement: a row with no title has nothing to
    check a search result against, so there is no evidence either way and the
    answer has to be no.
    """
    key = normalise_title(wanted)
    if not key:
        return False
    return any(key == normalise_title(candidate) for candidate in candidates)
