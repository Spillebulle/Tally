"""Saved browse views.

The design is deliberately thin: a view is a name and the raw query string, and
nothing on the server parses the string. So the tests that matter are not about
filters at all — they are about *whose* view it is. A saved view can name
`favorites`, a rating band or a library id, and one account must never be able
to read, rename or delete another's.

The rest is the shape of the endpoint under pressure: what a repeat name does,
what the cap does, and what happens to the rows when the user they belong to is
deleted (the suite runs with `PRAGMA foreign_keys=ON`, matching production, so
the cascade is a real cascade here rather than a decoration on the model).
"""
import pytest
from sqlalchemy import select

from app.models import SavedView, User
from app.routers.saved_views import MAX_VIEWS_PER_USER

pytestmark = pytest.mark.asyncio


async def _save(client, name: str, query: str, page: str = "media"):
    return await client.post(
        "/api/views", json={"page": page, "name": name, "query": query}
    )


async def _second_user(bare_client):
    """A second authenticated account, sharing the same database."""
    response = await bare_client.post(
        "/api/auth/register", json={"username": "other", "password": "password123"}
    )
    assert response.status_code == 201, response.text
    return bare_client


# --- the round trip -------------------------------------------------------


async def test_a_view_stores_the_query_string_verbatim(authed_client):
    """No parsing, no re-emitting: what went in is what comes back.

    This is the whole design. The query is validated on the way *in* to the
    browse page by `useBrowseFilters`, which is also what guards a hand-edited
    URL; re-deriving it here would be a second opinion that could disagree.
    """
    raw = "status=completed&genre=Crime&genre=Drama&genre_mode=all&min_rating=8&sort=year"
    created = await _save(authed_client, "Best crime", raw)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["query"] == raw
    assert body["name"] == "Best crime"
    assert body["page"] == "media"

    listed = (await authed_client.get("/api/views", params={"page": "media"})).json()
    assert [view["query"] for view in listed] == [raw]


async def test_a_leading_question_mark_is_not_part_of_the_query(authed_client):
    """`location.search` carries the `?`; a hand-written call may not.

    Both have to store the same thing, or two identical views compare unequal
    and the UI cannot tell which one is currently applied.
    """
    await _save(authed_client, "With prefix", "?favorites=true")
    listed = (await authed_client.get("/api/views")).json()
    assert listed[0]["query"] == "favorites=true"


async def test_views_are_listed_per_page(authed_client):
    """A watchlist view has no business appearing on History's bar."""
    await _save(authed_client, "Queue", "sort=year", page="watchlist")
    await _save(authed_client, "Recent", "since=2026-01-01", page="history")

    watchlist = (await authed_client.get("/api/views", params={"page": "watchlist"})).json()
    assert [view["name"] for view in watchlist] == ["Queue"]

    history = (await authed_client.get("/api/views", params={"page": "history"})).json()
    assert [view["name"] for view in history] == ["Recent"]

    # Omitting the page is "everything", for a caller that wants the lot.
    assert len((await authed_client.get("/api/views")).json()) == 2


async def test_an_unknown_page_is_refused(authed_client):
    """`page` is a Literal, so a typo is a 422 rather than an unreachable row."""
    assert (await _save(authed_client, "Nowhere", "q=x", page="stats")).status_code == 422


# --- saving twice under one name ------------------------------------------


async def test_saving_the_same_name_again_updates_it(authed_client):
    """The name is the identity: a repeat save re-points it, it does not clone.

    200 rather than 201 says which happened, so the UI can say "Updated" instead
    of claiming a new view every time.
    """
    first = await _save(authed_client, "Rewatch pile", "min_watch_count=2")
    assert first.status_code == 201

    second = await _save(authed_client, "Rewatch pile", "min_watch_count=3&sort=year")
    assert second.status_code == 200, second.text
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["query"] == "min_watch_count=3&sort=year"

    listed = (await authed_client.get("/api/views")).json()
    assert len(listed) == 1


async def test_the_same_name_on_a_different_page_is_a_different_view(authed_client):
    """Uniqueness is per (user, page, name) — the pages are separate surfaces."""
    a = await _save(authed_client, "Favourites", "favorites=true", page="media")
    b = await _save(authed_client, "Favourites", "favorites=true", page="watchlist")
    assert a.status_code == 201
    assert b.status_code == 201
    assert a.json()["id"] != b.json()["id"]


async def test_a_name_is_trimmed_and_cannot_be_blank(authed_client):
    padded = await _save(authed_client, "  Padded  ", "q=a")
    assert padded.json()["name"] == "Padded"
    # Whitespace passes the pydantic length check, so the router has its own say.
    assert (await _save(authed_client, "   ", "q=a")).status_code == 400
    assert (await _save(authed_client, "", "q=a")).status_code == 422


# --- rename and re-point --------------------------------------------------


async def test_a_view_can_be_renamed_and_re_pointed(authed_client):
    view = (await _save(authed_client, "Old name", "q=a")).json()

    renamed = await authed_client.patch(
        f"/api/views/{view['id']}", json={"name": "New name"}
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "New name"
    # A field that was not sent does not change.
    assert renamed.json()["query"] == "q=a"

    repointed = await authed_client.patch(
        f"/api/views/{view['id']}", json={"query": "q=b&favorites=true"}
    )
    assert repointed.json()["query"] == "q=b&favorites=true"
    assert repointed.json()["name"] == "New name"


async def test_renaming_onto_an_existing_name_is_refused(authed_client):
    """Unlike a save, a rename cannot merge — so it says so instead of guessing."""
    await _save(authed_client, "Keep me", "q=a")
    other = (await _save(authed_client, "Rename me", "q=b")).json()

    clash = await authed_client.patch(
        f"/api/views/{other['id']}", json={"name": "Keep me"}
    )
    assert clash.status_code == 409

    # And the row is untouched by the refusal.
    listed = (await authed_client.get("/api/views")).json()
    assert sorted(view["name"] for view in listed) == ["Keep me", "Rename me"]


async def test_renaming_a_view_to_its_own_name_is_allowed(authed_client):
    """Otherwise re-saving the name it already has would collide with itself."""
    view = (await _save(authed_client, "Same", "q=a")).json()
    same = await authed_client.patch(f"/api/views/{view['id']}", json={"name": "Same"})
    assert same.status_code == 200


async def test_a_view_can_be_deleted(authed_client):
    view = (await _save(authed_client, "Temporary", "q=a")).json()
    assert (await authed_client.delete(f"/api/views/{view['id']}")).status_code == 204
    assert (await authed_client.get("/api/views")).json() == []
    # And deleting it again is a 404, not a 500.
    assert (await authed_client.delete(f"/api/views/{view['id']}")).status_code == 404


# --- whose view is it -----------------------------------------------------


async def test_one_user_never_sees_anothers_views(authed_client, bare_client):
    await _save(authed_client, "Mine", "favorites=true")
    other = await _second_user(bare_client)
    await _save(other, "Theirs", "min_rating=9")

    assert [v["name"] for v in (await authed_client.get("/api/views")).json()] == ["Mine"]
    assert [v["name"] for v in (await other.get("/api/views")).json()] == ["Theirs"]


async def test_two_users_may_each_have_a_view_called_the_same_thing(
    authed_client, bare_client
):
    """The constraint is (user, page, name) — one account's names are its own."""
    assert (await _save(authed_client, "Weeknight", "max_runtime=90")).status_code == 201
    other = await _second_user(bare_client)
    assert (await _save(other, "Weeknight", "max_runtime=60")).status_code == 201


async def test_another_users_view_cannot_be_read_renamed_or_deleted(
    authed_client, bare_client
):
    """Every verb, not just the list — and the answer is 404, never 403.

    Whether an id exists is not the caller's business unless it is theirs.
    """
    mine = (await _save(authed_client, "Private", "favorites=true&library_id=7")).json()
    other = await _second_user(bare_client)

    assert (await other.patch(f"/api/views/{mine['id']}", json={"name": "Hijacked"})).status_code == 404
    assert (
        await other.patch(f"/api/views/{mine['id']}", json={"query": "q=whatever"})
    ).status_code == 404
    assert (await other.delete(f"/api/views/{mine['id']}")).status_code == 404

    # Untouched by all of that.
    still = (await authed_client.get("/api/views")).json()
    assert still[0]["name"] == "Private"
    assert still[0]["query"] == "favorites=true&library_id=7"


async def test_saving_a_view_requires_a_session(bare_client):
    assert (await bare_client.get("/api/views")).status_code == 401
    assert (await _save(bare_client, "Anonymous", "q=a")).status_code == 401


# --- bounds ---------------------------------------------------------------


async def test_the_number_of_views_per_user_is_capped(authed_client):
    """An authenticated write endpoint with no bound is a write endpoint."""
    for index in range(MAX_VIEWS_PER_USER):
        assert (await _save(authed_client, f"View {index}", f"q={index}")).status_code == 201

    refused = await _save(authed_client, "One too many", "q=x")
    assert refused.status_code == 400
    assert str(MAX_VIEWS_PER_USER) in refused.json()["detail"]

    # The cap counts rows, so *updating* one of the existing names still works —
    # otherwise a full shelf could not be edited at all.
    assert (await _save(authed_client, "View 0", "q=changed")).status_code == 200


async def test_the_cap_is_per_user(authed_client, bare_client):
    for index in range(MAX_VIEWS_PER_USER):
        await _save(authed_client, f"View {index}", f"q={index}")
    other = await _second_user(bare_client)
    assert (await _save(other, "Room to spare", "q=a")).status_code == 201


async def test_an_oversized_query_is_refused(authed_client):
    """Not free storage: the string is bounded at something a proxy would pass."""
    assert (await _save(authed_client, "Huge", "q=" + "x" * 4000)).status_code == 422


# --- lifetime -------------------------------------------------------------


async def test_deleting_a_user_takes_their_views_with_them(authed_client, db):
    """Real cascade, exercised with foreign keys on as production has them."""
    await _save(authed_client, "Doomed", "q=a")
    await _save(authed_client, "Also doomed", "q=b", page="history")

    user = (await db.execute(select(User).where(User.username == "tester"))).scalar_one()
    assert (await db.execute(select(SavedView))).scalars().all() != []

    await db.delete(user)
    await db.commit()

    assert (await db.execute(select(SavedView))).scalars().all() == []
