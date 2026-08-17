"""The theme library on disk: `$DATA_DIR/themes/<user_id>/<id>.umbertheme`.

STYLE-GUIDE §3.2 puts the files "under the user's data directory". On a desktop
that is per user by definition; Tally is hosted, so `docs/themes.md` settles it
as one directory per account. A household Tally has several accounts and a
shared directory would let one of them delete another's work — the same
reasoning that keeps `UserServerAccess` per user while `PlexServer` is global.

A **directory of files**, not an index: a write touches one small file rather
than a table holding every theme, and the files are ordinary files somebody can
hand to somebody else. The filesystem keeps ids unique, so there is no second
table to keep in step.

Two rules from §3.2 that are easy to lose and expensive to get wrong:

* **Nothing shipped lives here.** Graphite and Paper are compiled in
  (`themes.BUILTINS`) and are never written to the library directory. Anything
  the user decides about a shipped item cannot be written where the shipped item
  is, or an update replaces it wholesale and the choice vanishes silently.
* **The id is never re-derived from the name.** Renaming a theme leaves the file
  exactly where it is, because the id is what `User.preferences["theme_id"]`
  points at and a rename must not orphan it. `unique_slug` runs when a theme is
  *created*, and never again.

Every id that reaches here may have come off the wire, so `resolve_path` is the
one door: it shape-checks the id and then confirms the resolved path really is
inside that user's directory. That is the same containment bug — and the same
fix — as `main.static_file_for`, where a percent-decoded `../` once served
`/data/.secret_key` to anybody who asked.
"""
from __future__ import annotations

import logging
import os
import re
import tempfile
from pathlib import Path

from ..config import get_settings
from .themes import (
    BUILTINS,
    EXTENSION,
    KEY_SET,
    SLUG_MAX,
    DecodeResult,
    Theme,
    ThemeFormatError,
    base_colours,
    builtin_theme,
    decode,
    encode,
    parse_colour,
    unique_name,
    unique_slug,
)

log = logging.getLogger(__name__)

#: How many themes are read back from one user's directory. Umber's cap, and
#: far past what anybody makes by hand — it exists so a directory somebody has
#: dropped ten thousand files into cannot turn the theme picker into a stall.
MAX_THEMES = 128

#: What is read from an uploaded file. Twenty-nine lines of `key = #RRGGBB` is
#: about a kilobyte; anything past this is not a theme and there is no reason to
#: hold it in memory to find that out.
MAX_UPLOAD_BYTES = 64 * 1024

#: An id is a slug and only a slug. Checked before the path is built, so a name
#: with a separator, a null byte or a `..` in it never reaches `Path`.
_ID = re.compile(rf"[a-z0-9][a-z0-9-]{{0,{SLUG_MAX - 1}}}")


class ThemeLibraryError(RuntimeError):
    """Something the caller asked for cannot be done to the library."""


def library_root() -> Path:
    """`$DATA_DIR/themes`. A function, not a constant: `get_settings()` is
    `lru_cache`d and reads `DATA_DIR` at import time, so a module-level Path
    would freeze whatever the first import saw."""
    return get_settings().data_dir / "themes"


def user_dir(user_id: int) -> Path:
    return library_root() / str(int(user_id))


def is_valid_id(theme_id: str) -> bool:
    return bool(theme_id) and _ID.fullmatch(theme_id) is not None


def resolve_path(user_id: int, theme_id: str) -> Path | None:
    """The file `theme_id` names inside this user's directory, or None.

    `theme_id` is attacker-controlled. The regex would be enough on its own —
    it admits no separator and no dot — but the containment check is kept as
    well, because it is the property that actually matters and a future edit to
    the pattern cannot quietly remove it.
    """
    if not is_valid_id(theme_id):
        return None
    root = user_dir(user_id).resolve()
    candidate = (root / f"{theme_id}{EXTENSION}").resolve()
    if not candidate.is_relative_to(root):
        return None
    return candidate


# --- reading --------------------------------------------------------------


def list_ids(user_id: int) -> list[str]:
    """The ids in this user's directory, sorted, capped at `MAX_THEMES`."""
    directory = user_dir(user_id)
    if not directory.is_dir():
        return []
    ids = sorted(
        path.stem
        for path in directory.glob(f"*{EXTENSION}")
        if path.is_file() and is_valid_id(path.stem)
    )
    if len(ids) > MAX_THEMES:
        log.warning(
            "User %s has %s theme files; reading back the first %s",
            user_id,
            len(ids),
            MAX_THEMES,
        )
    return ids[:MAX_THEMES]


def load(user_id: int, theme_id: str) -> Theme | None:
    """One theme — built-in or the user's own — or None.

    Built-ins answer first and are never looked for on disk, so a file somebody
    has managed to call `graphite.umbertheme` cannot shadow the shipped one.
    """
    shipped = builtin_theme(theme_id)
    if shipped is not None:
        return shipped
    path = resolve_path(user_id, theme_id)
    if path is None or not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        log.warning("Could not read theme %s for user %s", theme_id, user_id)
        return None
    try:
        return decode(text, theme_id=theme_id, stem=theme_id).theme
    except ThemeFormatError:
        # A file in the library that is not a theme is not an error the user
        # can act on from a list — it is simply not listed.
        log.warning("Theme file %s is not a theme file", path.name)
        return None


def list_themes(user_id: int) -> list[Theme]:
    """The built-ins, then the user's own by id.

    The built-ins lead because they are what an account starts with and what a
    "New theme" copies from, and because their order is fixed while a user's is
    alphabetical.
    """
    themes = [builtin_theme(builtin_id) for builtin_id in BUILTINS]
    for theme_id in list_ids(user_id):
        theme = load(user_id, theme_id)
        if theme is not None:
            themes.append(theme)
    return [theme for theme in themes if theme is not None]


# --- writing --------------------------------------------------------------


def write(user_id: int, theme: Theme) -> Theme:
    """Write a theme to the library, atomically.

    Temp file in the same directory, then `os.replace`, which is atomic on both
    POSIX and Windows: a reader either sees the previous file or the new one,
    never a half-written table. Writing in place would put an interrupted save
    and a corrupt theme in the same category.
    """
    if theme.builtin or theme.id in BUILTINS:
        raise ThemeLibraryError(f"“{theme.id}” is a built-in theme and cannot be written")
    path = resolve_path(user_id, theme.id)
    if path is None:
        raise ThemeLibraryError(f"“{theme.id}” is not a usable theme id")
    path.parent.mkdir(parents=True, exist_ok=True)

    handle, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{theme.id}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(encode(theme))
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return theme


def free_name(user_id: int, desired: str, *, excluding: str | None = None) -> str:
    """A display name nothing else in this account's library is called.

    §3.2: "A name already in the library **gets a number** rather than replacing
    a theme somebody built." That is about the name a person reads — the id has
    its own bullet immediately before it — and `themelib.rs::free_name` reads it
    the same way, comparing against the built-in labels as well as the user's
    own themes. Without it, `create` twice under one name gives two cards called
    "Night Owl", and a copy named "Graphite" gives a library listing
    `['Graphite', 'Paper', 'Graphite']` where one of the two is read-only and
    the interface has no way to say which.

    `excluding` is the id of the theme being renamed, so re-committing the name
    a theme already has is not a rename to "Night Owl 2".
    """
    taken = [
        theme.name
        for theme in list_themes(user_id)
        if excluding is None or theme.id != excluding
    ]
    return unique_name(desired, taken)


def create(user_id: int, name: str, base: str, colours: dict[str, str]) -> Theme:
    """Add a theme to the library under a fresh id.

    The id is derived from the name **here and only here**. A name already in
    the library gets a number rather than replacing a theme somebody built.

    `colours` may be partial; the base fills the rest, so a `Theme` in hand
    always carries all twenty-seven whether it came from a file, from a copy or
    from here. The editor and the resolver then never have to ask what an absent
    key means.
    """
    taken = set(list_ids(user_id)) | set(BUILTINS)
    if len(taken) - len(BUILTINS) >= MAX_THEMES:
        raise ThemeLibraryError(
            f"You already have {MAX_THEMES} themes. Delete one before making another."
        )
    # The name is freed as well as the id, and they are two different
    # questions: the id keeps two *files* apart, the name keeps two *cards*
    # apart. Numbering one and not the other is what left a library able to
    # show the same name twice.
    freed = free_name(user_id, name)
    theme = Theme(
        id=unique_slug(freed, taken),
        name=freed,
        base=base,
        colours={**base_colours(base), **colours},
    )
    return write(user_id, theme)


def delete(user_id: int, theme_id: str) -> bool:
    """Remove a theme file. False if there was nothing to remove."""
    if theme_id in BUILTINS:
        raise ThemeLibraryError(f"“{theme_id}” is a built-in theme and cannot be deleted")
    path = resolve_path(user_id, theme_id)
    if path is None or not path.is_file():
        return False
    path.unlink()
    return True


def import_bytes(user_id: int, data: bytes, filename: str | None = None) -> tuple[Theme, int]:
    """Bring an uploaded file into the library. Returns the theme and the
    number of lines that could not be read.

    Decoded with `errors="replace"` rather than strictly: a file that is not
    UTF-8 is refused by the header check a moment later with a sentence about
    what it is, which is a better answer than a decoding traceback about byte
    0x8b at offset 1.
    """
    if len(data) > MAX_UPLOAD_BYTES:
        raise ThemeFormatError(
            f"That file is larger than {MAX_UPLOAD_BYTES // 1024} KB, so it is not a theme file."
        )
    text = data.decode("utf-8", errors="replace")
    stem = Path(filename).stem if filename else None
    result: DecodeResult = decode(text, stem=stem)
    theme = create(user_id, result.theme.name, result.theme.base, result.theme.colours)
    return theme, result.skipped


def apply_edits(
    user_id: int,
    theme: Theme,
    *,
    name: str | None = None,
    colours: dict[str, str] | None = None,
) -> Theme:
    """A theme with a new name and/or some new colours, validated.

    The id is untouched on purpose — see the module docstring. An unknown key or
    an unparseable colour is refused here rather than skipped: this is somebody
    typing into the editor, not somebody else's file arriving from a newer
    build, and the tolerance §3.2 asks for is for the second case only.

    A **rename** is numbered against every other theme, the same as a copy. A
    colour edit is not: `free_name` is asked only when a name was actually sent,
    or saving a swatch would number the theme every time one of its colours
    changed — which is why `themelib.rs` keeps `rename` a separate method from
    `save` rather than freeing the name on every write.
    """
    if name is not None:
        theme.name = free_name(user_id, name, excluding=theme.id)
    for key, value in (colours or {}).items():
        if key not in KEY_SET:
            raise ThemeLibraryError(f"“{key}” is not one of the theme's colours")
        parsed = parse_colour(value)
        if parsed is None:
            raise ThemeLibraryError(
                f"“{value}” is not a colour. Use #RRGGBB, RRGGBB or #RGB, with no alpha."
            )
        theme.colours[key] = parsed
    return theme
