"""Themes: the library, the editor and the file.

The format lives in `services/themes.py` and the directory in
`services/theme_library.py`; this module is only the wire. `docs/themes.md`
settles the three things STYLE-GUIDE §3.2 leaves to the app — the library is per
user, a theme's `base` decides whether it is dark, and parsing, encoding and
derivation all happen here on the server rather than a second time in the
browser.

Two rules the endpoints exist to keep:

* **A built-in is read-only.** `graphite` and `paper` are compiled in and are
  never written to the library directory, so a write to one answers 409 with a
  sentence rather than a silent no-op — §9 asks a setting that cannot be changed
  to say so.
* **Import reports what it lost.** The response carries the skipped-line count,
  so the interface can say "N line(s) could not be read, so those colours came
  from the theme it names as its base". §3.2 requires that; a 200 with no detail
  would swallow it.

The selected theme is `User.preferences["theme_id"]`, set through the ordinary
preferences endpoint in `users.py`, which refuses an id this account does not
have for the same reason it refuses an unloadable timezone: a preference that
quietly means something else is worse than one that fails.
"""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, Response, UploadFile, status
from fastapi.responses import PlainTextResponse

from ..deps import CurrentUser, DbSession
from ..models import User
from ..schemas import ThemeCreate, ThemeDetail, ThemeImported, ThemePatch, ThemeSummary
from ..services import theme_library as library
from ..services.themes import EXTENSION, Theme, ThemeFormatError, encode, resolve

router = APIRouter(prefix="/api/themes", tags=["themes"])


def _summary(theme: Theme) -> ThemeSummary:
    return ThemeSummary(
        id=theme.id,
        name=theme.name,
        base=theme.base,
        is_builtin=theme.builtin,
        # Sent alongside `base` because only the server knows which built-ins
        # are dark, and the client has to stamp `class="dark"` or `"light"` to
        # match — `tokens.css` carries a handful of values that are not among
        # the twenty-seven and differ by theme, the shadows most obviously.
        dark=theme.dark,
    )


def _detail(theme: Theme) -> ThemeDetail:
    return ThemeDetail(**_summary(theme).model_dump(), colours=dict(theme.colours))


def _load(user: User, theme_id: str) -> Theme:
    theme = library.load(user.id, theme_id)
    if theme is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such theme")
    return theme


def _writable(user: User, theme_id: str) -> Theme:
    theme = _load(user, theme_id)
    if theme.builtin:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"“{theme.name}” ships with Tally and cannot be changed. "
            "Copy it and edit the copy.",
        )
    return theme


@router.get("", response_model=list[ThemeSummary])
async def list_themes(user: CurrentUser) -> list[ThemeSummary]:
    """The built-ins, then this account's own themes."""
    return [_summary(theme) for theme in library.list_themes(user.id)]


@router.post("", response_model=ThemeDetail, status_code=status.HTTP_201_CREATED)
async def create_theme(payload: ThemeCreate, user: CurrentUser) -> ThemeDetail:
    """Copy a theme — built-in or not — under a new name.

    The only way to make one, which is what keeps every custom theme in a
    directory an update never reaches. A name already in the library gets a
    number rather than replacing a theme somebody built.
    """
    source = _load(user, payload.source_id)
    try:
        theme = library.create(user.id, payload.name, source.base, source.colours)
    except library.ThemeLibraryError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _detail(theme)


@router.post("/import", response_model=ThemeImported)
async def import_theme(
    user: CurrentUser, file: UploadFile = File(...)
) -> ThemeImported:
    """Upload a `.umbertheme`, and say how much of it could not be read.

    The *header* decides whether this is a theme, not the extension: import is
    handed whatever the file dialog returned, and a text file that is not a
    theme is refused with a sentence rather than read as a theme of entirely
    default colours.
    """
    data = await file.read(library.MAX_UPLOAD_BYTES + 1)
    try:
        theme, skipped = library.import_bytes(user.id, data, file.filename)
    except ThemeFormatError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except library.ThemeLibraryError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return ThemeImported(theme=_detail(theme), skipped_lines=skipped)


@router.get("/{theme_id}", response_model=ThemeDetail)
async def get_theme(theme_id: str, user: CurrentUser) -> ThemeDetail:
    """One theme as its twenty-seven stored keys, for the editor.

    Always all twenty-seven: whatever the file carried, the rest come from the
    base it names, so the editor never has to ask what an absent key means.
    """
    return _detail(_load(user, theme_id))


@router.get("/{theme_id}/resolved", response_model=dict[str, str])
async def resolved_theme(theme_id: str, user: CurrentUser) -> dict[str, str]:
    """The CSS custom properties to stamp on `document.documentElement`.

    The twenty-seven under their token names plus the five derived values that
    `tokens.css` states literally. Everything else in the stylesheet is a
    `color-mix` over these and resolves where it is used, so sending it would
    only create a second, stale copy of a value the stylesheet already has right.
    """
    return resolve(_load(user, theme_id))


@router.get("/{theme_id}/export")
async def export_theme(theme_id: str, user: CurrentUser) -> PlainTextResponse:
    """The file itself, for handing to somebody else — or to Umber.

    Re-encoded rather than served off disk, so an export is always complete and
    in §3.2's order even if the file in the library arrived hand-trimmed.
    """
    theme = _load(user, theme_id)
    return PlainTextResponse(
        encode(theme),
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{theme.id}{EXTENSION}"'
        },
    )


@router.patch("/{theme_id}", response_model=ThemeDetail)
async def update_theme(
    theme_id: str, payload: ThemePatch, user: CurrentUser
) -> ThemeDetail:
    """Rename a theme, write one or more of its colours, or both.

    A rename leaves the file where it is: the id is what
    `preferences["theme_id"]` points at, and re-deriving it from the new name
    would orphan the selection.
    """
    theme = _writable(user, theme_id)
    try:
        edited = library.apply_edits(
            user.id, theme, name=payload.name, colours=payload.colours
        )
        library.write(user.id, edited)
    except library.ThemeLibraryError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _detail(edited)


@router.delete("/{theme_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_theme(theme_id: str, db: DbSession, user: CurrentUser) -> Response:
    """Remove the file, and let go of it if it was the one selected.

    Clearing the preference is not tidiness: a `theme_id` pointing at a file
    that no longer exists is a page that renders in whatever the built-in
    preference last said, with a settings screen still claiming the deleted
    theme is in use.
    """
    _writable(user, theme_id)
    library.delete(user.id, theme_id)

    preferences = dict(user.preferences or {})
    if preferences.get("theme_id") == theme_id:
        preferences["theme_id"] = None
        user.preferences = preferences
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
