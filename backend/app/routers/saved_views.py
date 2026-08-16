"""Saved browse views — a named query string, per user, per page.

The whole browse query already lives in the URL: the filters, the sort, the
direction and the page number, all written by `useBrowseFilters` and all
re-validated by it on the way back in. So "save this view" is nothing more than
storing that string, and "recall it" is setting it back. There is no
serialisation format to invent, and a view saved before a filter was renamed
degrades to the page defaults for free, because the same `read` that guards a
hand-edited URL guards a recalled one.

Nothing here parses the query. If this module ever grows a filter parser, it has
become a second validation path that can disagree with the first — which is the
one failure this design exists to rule out.

Everything is scoped to the owning user, on every verb. A view can name
`favorites`, a rating band, or a library id: values that are meaningless or
misleading to another account, and in the last case the name of a server they
may have no relationship with. `_owned` is the single lookup, so no endpoint can
forget.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from ..deps import CurrentUser, DbSession
from ..models import SavedView, User, utcnow
from ..schemas import SavedViewIn, SavedViewOut, SavedViewPage, SavedViewPatch

router = APIRouter(prefix="/api/views", tags=["saved-views"])

# A filter bar is not a bookmarks manager. Enough for every grid to carry a
# handful of real working views, few enough that a runaway script is obvious —
# the same judgement `api_keys.MAX_KEYS_PER_USER` makes, and the reason this
# authenticated write endpoint is bounded at all.
MAX_VIEWS_PER_USER = 30


def _clean_query(raw: str) -> str:
    """The query string as the URL holds it, without a leading `?`.

    `location.search` includes the `?` and a hand-written call may not, so both
    spellings have to store the same thing — otherwise two identical views
    compare unequal and the UI cannot tell which one is already applied. This is
    the only shaping the string gets: it is not parsed, re-ordered or
    re-emitted.
    """
    return raw.lstrip("?").strip()


async def _owned(db: DbSession, user: User, view_id: int) -> SavedView:
    """The caller's view, or a 404.

    Same answer for "no such view" and "somebody else's view": whether an id
    exists is not the caller's business unless it is theirs.
    """
    view = await db.get(SavedView, view_id)
    if view is None or view.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "View not found")
    return view


@router.get("", response_model=list[SavedViewOut])
async def list_views(
    db: DbSession,
    user: CurrentUser,
    page: SavedViewPage | None = Query(
        None, description="Only this page's views. Omit for every page's."
    ),
) -> list[SavedViewOut]:
    """This account's saved views, oldest first within a page.

    Stable ordering on purpose: a list that reshuffles when one entry is renamed
    makes the row under the pointer a different row than the one clicked.
    """
    stmt = select(SavedView).where(SavedView.user_id == user.id)
    if page is not None:
        stmt = stmt.where(SavedView.page == page)
    result = await db.execute(stmt.order_by(SavedView.page, SavedView.created_at))
    return [SavedViewOut.model_validate(view) for view in result.scalars()]


@router.post("", response_model=SavedViewOut)
async def save_view(
    payload: SavedViewIn, db: DbSession, user: CurrentUser, response: Response
) -> SavedViewOut:
    """Save the current query, or re-point an existing name at it.

    **A repeat name updates rather than duplicating or refusing.** The name is
    the identity of a view, so saving "Rewatch pile" a second time means "make
    that name mean what I am looking at now" — which is what somebody typing the
    same name again is asking for, and it is also the only spelling where the
    UI's one control does not need a second, differently-shaped failure path
    just to get there. A 409 would be defensible, but it would answer a
    deliberate act with an error and leave the user to delete the old view by
    hand.

    The status code says which happened — 201 created, 200 updated — so the
    caller can word its confirmation honestly rather than claiming a new view
    every time.
    """
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A view needs a name")

    existing = await db.scalar(
        select(SavedView).where(
            SavedView.user_id == user.id,
            SavedView.page == payload.page,
            SavedView.name == name,
        )
    )
    if existing is not None:
        existing.query = _clean_query(payload.query)
        existing.updated_at = utcnow()
        await db.commit()
        await db.refresh(existing)
        response.status_code = status.HTTP_200_OK
        return SavedViewOut.model_validate(existing)

    held = await db.scalar(
        select(func.count(SavedView.id)).where(SavedView.user_id == user.id)
    )
    if (held or 0) >= MAX_VIEWS_PER_USER:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"You already have {MAX_VIEWS_PER_USER} saved views. "
            "Delete one before saving another.",
        )

    view = SavedView(
        user_id=user.id,
        page=payload.page,
        name=name,
        query=_clean_query(payload.query),
    )
    db.add(view)
    try:
        await db.commit()
    except IntegrityError:
        # Two saves of the same name racing each other. The constraint is the
        # authority, not the SELECT above.
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "A view with that name was just saved"
        ) from None
    await db.refresh(view)
    response.status_code = status.HTTP_201_CREATED
    return SavedViewOut.model_validate(view)


@router.patch("/{view_id}", response_model=SavedViewOut)
async def update_view(
    view_id: int, payload: SavedViewPatch, db: DbSession, user: CurrentUser
) -> SavedViewOut:
    """Rename a view, re-point it at a query, or both.

    A rename onto a name already in use *is* a 409, unlike a save: two rows
    cannot merge, and silently overwriting the other view would destroy
    something the user never mentioned.
    """
    view = await _owned(db, user, view_id)

    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A view needs a name")
        if name != view.name:
            clash = await db.scalar(
                select(SavedView.id).where(
                    SavedView.user_id == user.id,
                    SavedView.page == view.page,
                    SavedView.name == name,
                )
            )
            if clash is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT, f"You already have a view called “{name}”"
                )
        view.name = name

    if payload.query is not None:
        view.query = _clean_query(payload.query)

    view.updated_at = utcnow()
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "A view with that name already exists"
        ) from None
    await db.refresh(view)
    return SavedViewOut.model_validate(view)


@router.delete("/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_view(view_id: int, db: DbSession, user: CurrentUser) -> Response:
    """Delete a view. Nothing else references one, so it really is a delete."""
    view = await _owned(db, user, view_id)
    await db.delete(view)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
