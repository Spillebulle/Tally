"""The `.umbertheme` format, the library on disk, and the endpoints over it.

The format is an *interchange* format — a theme made in Umber has to open here
and one made here has to open in Umber — so the tests that matter are the ones
that would let the two drift apart, and most of them are refusals. A refusal is
the half that rots quietly: nothing looks wrong when a reader starts accepting
`#RRGGBBAA`, or when a name stops being cut, until a file crosses to another app
and means something else there.

`test_a_written_file_satisfies_the_reader_rules` is the one that proves the point
of the whole exercise, and it is deliberately written as an independent reader
rather than as `decode(encode(t))`: a round trip through one implementation only
proves it agrees with itself.
"""
import pytest

from app.services import theme_library
from app.services.themes import (
    BUILTINS,
    HEADER,
    KEYS,
    NAME_MAX,
    Theme,
    ThemeFormatError,
    bound_name,
    builtin_theme,
    decode,
    encode,
    mix,
    parse_colour,
    resolve,
    slugify,
    unique_slug,
)

# No `pytestmark = pytest.mark.asyncio` here: `asyncio_mode = auto` already
# covers the async tests, and the mark on a module with synchronous ones in it
# warns on every single one of them.


@pytest.fixture(autouse=True)
def library(tmp_path, monkeypatch):
    """A private theme directory per test.

    `conftest` points DATA_DIR at one directory for the whole session and
    `get_settings()` is `lru_cache`d, so the real library root is shared — and
    user ids restart at 1 in every test's private database, which would make
    every test's user 1 the same user on disk.
    """
    root = tmp_path / "themes"
    monkeypatch.setattr(theme_library, "library_root", lambda: root)
    return root


def sample(**colours: str) -> str:
    """A theme file with `colours` written into it and nothing else."""
    lines = [HEADER, "name = Sample", "base = graphite"]
    lines += [f"{key} = {value}" for key, value in colours.items()]
    return "\n".join(lines) + "\n"


# --- the header: what is and is not a theme file --------------------------


def test_a_file_without_the_header_is_refused():
    # Not "a theme of entirely default colours" — a sentence. Anything else
    # imports a shopping list as a working theme.
    with pytest.raises(ThemeFormatError) as exc:
        decode("backdrop = #000000\n")
    assert HEADER in str(exc.value)


def test_the_header_is_matched_case_insensitively_and_past_a_bom():
    for first in ("Umber theme", "UMBER THEME", "umber theme", "﻿Umber theme"):
        result = decode(f"{first}\nbackdrop = #010203\n")
        assert result.theme.colours["backdrop"] == "#010203"


def test_windows_line_endings_are_read():
    text = "﻿Umber theme\r\nname = CRLF\r\n\r\nbackdrop = #010203\r\n"
    result = decode(text)
    assert result.theme.name == "CRLF"
    assert result.theme.colours["backdrop"] == "#010203"
    assert result.skipped == 0


# --- colours ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("written", "expected"),
    [
        ("#AABBCC", "#AABBCC"),
        ("aabbcc", "#AABBCC"),
        ("#abc", "#AABBCC"),
        ("  #AaBbCc  ", "#AABBCC"),
    ],
)
def test_the_three_accepted_spellings(written, expected):
    assert parse_colour(written) == expected


@pytest.mark.parametrize(
    "written",
    [
        "#AABBCCDD",  # no alpha, ever
        "#AABBC",
        "abc",  # the short form is only accepted with its hash
        "rgb(1,2,3)",
        "red",
        "#GGHHII",
        "",
        "0x112233",
    ],
)
def test_anything_else_is_refused_rather_than_guessed(written):
    assert parse_colour(written) is None


def test_an_alpha_colour_costs_exactly_that_one_colour():
    result = decode(sample(backdrop="#11223344", window="#010203"))
    assert result.skipped == 1
    # The base's value stands for the refused line — not black, and not the
    # neighbouring line's colour.
    assert result.theme.colours["backdrop"] == BUILTINS["graphite"].colours["backdrop"]
    assert result.theme.colours["window"] == "#010203"


# --- what counts as a skipped line -----------------------------------------


def test_an_unknown_key_costs_one_line_and_nothing_else():
    text = sample(backdrop="#010203")
    text += "somethingnewer = #FFFFFF\n"
    result = decode(text)
    assert result.skipped == 1
    assert result.theme.colours["backdrop"] == "#010203"
    assert len(result.theme.colours) == len(KEYS)


def test_blank_lines_comments_and_prose_are_not_counted():
    text = f"{HEADER}\n\n# a comment\nname = Quiet\n\nbackdrop = #010203\nprose\n"
    result = decode(text)
    # §3.2 lists a blank line, a `#` line and a line with no `=` together as
    # ordinary grammar rather than as damage, so counting them would put a
    # number in front of the user for a file that lost nothing.
    assert result.skipped == 0
    assert result.theme.name == "Quiet"


def test_the_skip_count_survives_a_realistic_foreign_file():
    text = (
        "﻿UMBER THEME\r\n"
        "# made in Umber\r\n"
        "\r\n"
        "name = Foreign\r\n"
        "base = paper\r\n"
        "backdrop = #fff\r\n"
        "accent = 3987e5\r\n"
        "novel_token = #123456\r\n"
    )
    result = decode(text)
    assert result.skipped == 1  # the key this build does not have, and only it
    assert result.theme.base == "paper"
    assert result.theme.colours["backdrop"] == "#FFFFFF"
    assert result.theme.colours["accent"] == "#3987E5"
    assert result.theme.colours["window"] == BUILTINS["paper"].colours["window"]


# --- base ------------------------------------------------------------------


def test_base_is_read_before_the_colours_whatever_the_order():
    # `base` last, after a colour the file does not carry. Read in one pass, the
    # absent tokens would have fallen back to graphite.
    text = f"{HEADER}\naccent = #010203\nbase = paper\n"
    result = decode(text)
    assert result.theme.colours["window"] == BUILTINS["paper"].colours["window"]
    assert result.theme.colours["accent"] == "#010203"


def test_an_unknown_base_falls_back_to_graphite_without_being_rewritten():
    result = decode(f"{HEADER}\nbase = photoslop\n")
    assert result.theme.colours["window"] == BUILTINS["graphite"].colours["window"]
    assert result.theme.dark is True
    # The word is kept as written, so a file that named a preset this build
    # lacks still names it when it goes back to the app that has it.
    assert result.theme.base == "photoslop"
    assert result.skipped == 0
    assert "base = photoslop" in encode(result.theme)


def test_a_theme_is_dark_because_its_base_is():
    # Paper edited black is still a light theme: §3.2 states the lightness
    # rather than measuring it, so an edit cannot change what the authored
    # derivation was.
    theme = decode(f"{HEADER}\nbase = paper\nbackdrop = #000000\nwindow = #000000\n").theme
    assert theme.dark is False
    assert resolve(theme)["--accent-ink"] == theme.colours["popover"]


# --- names -----------------------------------------------------------------


def test_a_long_name_is_cut_to_sixty_four():
    name = "x" * 300
    assert len(decode(f"{HEADER}\nname = {name}\n").theme.name) == NAME_MAX


def test_control_characters_become_spaces():
    assert bound_name("Night\tOwl\x07") == "Night Owl"


def test_a_nameless_theme_falls_back_to_the_stem_then_to_untitled():
    text = f"{HEADER}\nname = \x00\x01\n"
    assert decode(text, stem="midnight").theme.name == "midnight"
    assert decode(text).theme.name == "Untitled theme"
    assert decode(HEADER).theme.name == "Untitled theme"


# --- ids -------------------------------------------------------------------


def test_the_slug_rules():
    assert slugify("Night Owl") == "night-owl"
    assert slugify("  ✳︎ !! ✳︎  ") == "theme"
    assert slugify("Café noir") == "cafe-noir"  # accents folded, not dropped
    assert len(slugify("y" * 90)) == 48


def test_a_name_already_taken_gets_a_number():
    assert unique_slug("Night Owl", {"night-owl"}) == "night-owl-2"
    assert unique_slug("Night Owl", {"night-owl", "night-owl-2"}) == "night-owl-3"


# --- the round trip --------------------------------------------------------


def test_encode_decode_round_trip():
    original = Theme(
        id="night-owl",
        name="Night Owl",
        base="paper",
        colours={**BUILTINS["paper"].colours, "accent": "#FF0088", "link_6": "#001122"},
    )
    again = decode(encode(original), theme_id="night-owl")
    assert again.skipped == 0
    assert again.theme == original


def test_a_written_file_satisfies_the_reader_rules():
    """§3.2's reader rules, checked without using the decoder.

    A round trip through one implementation only proves it agrees with itself.
    This reads the bytes the way Umber's reader would: the header line, then
    every one of the twenty-seven keys in the documented order, each present
    exactly once, each `#RRGGBB` and no alpha.
    """
    text = encode(builtin_theme("graphite"))
    lines = text.split("\n")
    assert text.endswith("\n")
    assert lines.pop() == ""  # a trailing newline and nothing after it

    assert lines[0] == HEADER
    body = lines[1:]
    # Nothing decorative: no blank lines and no comments, so no reader that
    # counts what it skipped can report a file Tally wrote as damaged.
    assert all(line and not line.startswith("#") for line in body)

    pairs = [line.split(" = ") for line in body]
    assert all(len(pair) == 2 for pair in pairs)
    keys = [key for key, _ in pairs]
    assert keys[:2] == ["name", "base"]
    assert keys[2:] == list(KEYS)  # every key, in file order, exactly once

    for _key, value in pairs[2:]:
        assert len(value) == 7 and value[0] == "#"
        assert all(ch in "0123456789ABCDEF" for ch in value[1:])


# --- derivation ------------------------------------------------------------


def test_the_five_derived_values_and_nothing_else():
    table = resolve(builtin_theme("graphite"))
    assert len(table) == len(KEYS) + 5
    for name in ("--line-soft", "--line-dashed", "--placeholder", "--field", "--accent-ink"):
        assert table[name].startswith("#")
    # `color-mix` over other custom properties resolves where it is used, so
    # these must not be sent: a copy here would be a stale one.
    for name in ("--accent-tint", "--accent-ring", "--grid", "--good", "--critical"):
        assert name not in table


def test_field_and_accent_ink_follow_the_base():
    dark = builtin_theme("graphite")
    light = builtin_theme("paper")
    assert resolve(dark)["--field"] == dark.colours["dock"]
    assert resolve(dark)["--accent-ink"] == dark.colours["window"]
    assert resolve(light)["--field"] == light.colours["popover"]
    assert resolve(light)["--accent-ink"] == light.colours["popover"]


def test_the_mixes_land_on_the_authored_tokens():
    """The derivation reproduces `tokens.css`'s own hand-picked values.

    Not exactly — §3.2 says a built-in that disagrees with a rule stays as
    written — but close enough to be the same design, which is the claim the
    rules make. Oklab is what gets it there; the same mixes in sRGB land two to
    four steps further out per channel.
    """
    graphite = BUILTINS["graphite"].colours
    assert mix(graphite["border"], graphite["window"], 0.40) == "#1D1F22"  # authored #1E2023
    assert mix(graphite["border"], graphite["text_dim"], 0.30) == "#404246"  # authored #3A3D42
    assert mix(graphite["text_dim"], graphite["window"], 0.30) == "#5E6165"  # authored #5B5E63


# --- the library on disk ---------------------------------------------------


def test_creating_writes_one_file_named_for_the_slug(library):
    theme = theme_library.create(1, "Night Owl", "graphite", BUILTINS["graphite"].colours)
    assert theme.id == "night-owl"
    assert (library / "1" / "night-owl.umbertheme").is_file()
    # Nothing shipped is ever written there.
    assert sorted(p.name for p in (library / "1").iterdir()) == ["night-owl.umbertheme"]


def test_a_second_theme_of_the_same_name_gets_a_number(library):
    first = theme_library.create(1, "Night Owl", "graphite", {})
    second = theme_library.create(1, "Night Owl", "graphite", {"accent": "#FF0000"})
    assert (first.id, second.id) == ("night-owl", "night-owl-2")
    # The first one is still there, unchanged — a repeat name never replaces a
    # theme somebody built.
    assert theme_library.load(1, "night-owl").colours["accent"] != "#FF0000"


def test_a_rename_leaves_the_id_alone(library):
    theme = theme_library.create(1, "Night Owl", "graphite", {})
    theme_library.write(1, theme_library.apply_edits(theme, name="Dawn Chorus"))
    # The id is what `preferences["theme_id"]` points at; re-deriving it from
    # the new name would orphan the selection.
    assert theme_library.load(1, "night-owl").name == "Dawn Chorus"
    assert not (library / "1" / "dawn-chorus.umbertheme").exists()


def test_a_write_leaves_no_temporary_file_behind(library):
    theme_library.create(1, "Night Owl", "graphite", {})
    assert [p.name for p in (library / "1").iterdir()] == ["night-owl.umbertheme"]


def test_the_library_is_read_back_capped(library):
    directory = library / "1"
    directory.mkdir(parents=True)
    for n in range(theme_library.MAX_THEMES + 5):
        (directory / f"theme-{n:04d}.umbertheme").write_text(encode(builtin_theme("paper")))
    assert len(theme_library.list_ids(1)) == theme_library.MAX_THEMES


def test_a_built_in_is_never_written_to_the_library(library):
    with pytest.raises(theme_library.ThemeLibraryError):
        theme_library.write(1, Theme(id="graphite", name="Graphite", base="graphite"))
    with pytest.raises(theme_library.ThemeLibraryError):
        theme_library.delete(1, "paper")
    assert not (library / "1").exists()


@pytest.mark.parametrize(
    "theme_id",
    ["../secret", "..", "a/b", "night owl", "Night-Owl", "", "." * 3, "x" * 49, "-lead"],
)
def test_an_id_that_is_not_a_slug_names_no_file(theme_id):
    assert theme_library.resolve_path(1, theme_id) is None


def test_one_account_cannot_see_anothers_themes(library):
    theme_library.create(1, "Night Owl", "graphite", {})
    assert theme_library.load(2, "night-owl") is None
    assert theme_library.list_ids(2) == []


def test_importing_a_hand_trimmed_file_still_yields_all_twenty_seven(library):
    data = f"{HEADER}\nname = Six Colours\nbase = paper\naccent = #FF0088\n".encode()
    theme, skipped = theme_library.import_bytes(1, data, "six.umbertheme")
    assert skipped == 0
    assert len(theme.colours) == len(KEYS)
    assert theme.colours["accent"] == "#FF0088"
    assert theme.colours["chrome"] == BUILTINS["paper"].colours["chrome"]


def test_an_oversized_upload_is_refused_before_it_is_parsed(library):
    with pytest.raises(ThemeFormatError):
        theme_library.import_bytes(1, b"x" * (theme_library.MAX_UPLOAD_BYTES + 1))


def test_an_upload_that_is_not_utf8_is_refused_as_not_a_theme(library):
    # A decoding traceback about byte 0x8b at offset 1 tells the user nothing;
    # the header check answers with what the file is instead.
    with pytest.raises(ThemeFormatError) as exc:
        theme_library.import_bytes(1, b"\x1f\x8b\x08\x00garbage")
    assert HEADER in str(exc.value)


def test_the_editor_refuses_a_key_or_a_colour_it_does_not_know(library):
    theme = theme_library.create(1, "Night Owl", "graphite", {})
    with pytest.raises(theme_library.ThemeLibraryError):
        theme_library.apply_edits(theme, colours={"backdrop": "#11223344"})
    with pytest.raises(theme_library.ThemeLibraryError):
        theme_library.apply_edits(theme, colours={"nonsense": "#112233"})


# --- the endpoints ---------------------------------------------------------


async def test_the_library_lists_the_built_ins_first(authed_client):
    response = await authed_client.get("/api/themes")
    assert response.status_code == 200
    rows = response.json()
    assert [row["id"] for row in rows] == ["graphite", "paper"]
    assert [row["is_builtin"] for row in rows] == [True, True]
    assert [row["dark"] for row in rows] == [True, False]


async def test_copy_edit_export_and_delete(authed_client):
    created = await authed_client.post(
        "/api/themes", json={"name": "Night Owl", "source_id": "graphite"}
    )
    assert created.status_code == 201, created.text
    theme = created.json()
    assert theme["id"] == "night-owl"
    assert theme["base"] == "graphite"
    assert len(theme["colours"]) == len(KEYS)

    patched = await authed_client.patch(
        "/api/themes/night-owl", json={"name": "Dawn", "colours": {"accent": "#ff0088"}}
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["name"] == "Dawn"
    assert patched.json()["colours"]["accent"] == "#FF0088"

    resolved = await authed_client.get("/api/themes/night-owl/resolved")
    assert resolved.json()["--accent"] == "#FF0088"
    assert resolved.json()["--accent-ink"] == theme["colours"]["window"]

    exported = await authed_client.get("/api/themes/night-owl/export")
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("text/plain")
    assert "night-owl.umbertheme" in exported.headers["content-disposition"]
    assert exported.text.splitlines()[0] == HEADER
    assert "accent = #FF0088" in exported.text

    assert (await authed_client.delete("/api/themes/night-owl")).status_code == 204
    assert (await authed_client.get("/api/themes/night-owl")).status_code == 404


async def test_a_built_in_refuses_a_write_with_a_sentence(authed_client):
    patched = await authed_client.patch("/api/themes/graphite", json={"name": "Mine"})
    assert patched.status_code == 409
    assert "cannot be changed" in patched.json()["detail"]

    deleted = await authed_client.delete("/api/themes/paper")
    assert deleted.status_code == 409
    assert deleted.json()["detail"]


async def test_import_answers_with_the_skipped_line_count(authed_client):
    text = (
        f"{HEADER}\r\n# from Umber\r\n\r\nname = Foreign\r\nbase = paper\r\n"
        "backdrop = #fff\r\nnovel_token = #123456\r\naccent = #11223344\r\n"
    )
    response = await authed_client.post(
        "/api/themes/import",
        files={"file": ("foreign.umbertheme", text.encode(), "text/plain")},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["skipped_lines"] == 2
    assert body["theme"]["name"] == "Foreign"
    assert body["theme"]["base"] == "paper"
    assert body["theme"]["colours"]["backdrop"] == "#FFFFFF"


async def test_importing_something_that_is_not_a_theme_is_refused(authed_client):
    response = await authed_client.post(
        "/api/themes/import",
        files={"file": ("notes.txt", b"eggs\nmilk\n", "text/plain")},
    )
    assert response.status_code == 400
    assert HEADER in response.json()["detail"]


async def test_an_id_cannot_escape_the_users_directory(authed_client):
    """No spelling of a traversal gets a theme out of this router.

    A path that still contains a separator once percent-decoded cannot match
    `/{theme_id}` at all and falls through to the SPA catch-all, which has the
    same containment check on it (`main.static_file_for`) and answers with
    `index.html`. One that *can* match arrives here as an id, and an id that is
    not a slug names no file. Both are checked, because which of the two a given
    spelling takes is Starlette's business and could change.
    """
    for path in (
        "/api/themes/..%2f..%2fsecret",
        "/api/themes/%2e%2e%2f%2e%2e%2fsecret",
        "/api/themes/%2e%2e",
        "/api/themes/..%5C..%5Csecret",
    ):
        response = await authed_client.get(path)
        if response.headers.get("content-type", "").startswith("application/json"):
            # Either this router's "no such theme" or the framework's own 404.
            # Never a theme: a theme would be a 200 with a JSON body, and that
            # is the one thing this loop rules out.
            assert response.status_code == 404
        else:
            # The SPA shell, which every unmatched path gets and which
            # `static_file_for` has already refused to escape with. Asserted
            # this way round rather than on `text/html`, because the catch-all
            # only exists when a built frontend does — and a test that changes
            # its mind about what it proves depending on whether `npm run
            # build` has been run is a test that proves nothing in CI.
            assert response.status_code == 200


async def test_one_account_cannot_reach_anothers_theme(authed_client, bare_client):
    await authed_client.post("/api/themes", json={"name": "Night Owl"})
    registered = await bare_client.post(
        "/api/auth/register", json={"username": "other", "password": "password123"}
    )
    assert registered.status_code == 201, registered.text
    assert (await bare_client.get("/api/themes/night-owl")).status_code == 404
    assert (await bare_client.delete("/api/themes/night-owl")).status_code == 404
    assert [row["id"] for row in (await bare_client.get("/api/themes")).json()] == [
        "graphite",
        "paper",
    ]


async def test_selecting_a_theme_the_account_does_not_have_is_refused(authed_client):
    refused = await authed_client.put(
        "/api/users/me/preferences", json={"theme_id": "night-owl"}
    )
    # The same answer as an unloadable timezone: a preference that quietly means
    # something else is worse than one that fails.
    assert refused.status_code == 422

    await authed_client.post("/api/themes", json={"name": "Night Owl"})
    accepted = await authed_client.put(
        "/api/users/me/preferences", json={"theme_id": "night-owl"}
    )
    assert accepted.status_code == 200
    assert accepted.json()["theme_id"] == "night-owl"


async def test_deleting_the_selected_theme_lets_go_of_it(authed_client):
    await authed_client.post("/api/themes", json={"name": "Night Owl"})
    await authed_client.put("/api/users/me/preferences", json={"theme_id": "night-owl"})
    assert (await authed_client.delete("/api/themes/night-owl")).status_code == 204
    preferences = await authed_client.get("/api/users/me/preferences")
    assert preferences.json()["theme_id"] is None
