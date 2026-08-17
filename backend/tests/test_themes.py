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
import re
from pathlib import Path

import pytest

from app.services import theme_library
from app.services.themes import (
    BUILTINS,
    CSS_NAMES,
    GRAPHITE,
    GRAPHITE_DERIVED,
    HEADER,
    KEYS,
    NAME_MAX,
    PAPER,
    PAPER_DERIVED,
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
    theme_library.write(1, theme_library.apply_edits(1, theme, name="Dawn Chorus"))
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
        theme_library.apply_edits(1, theme, colours={"backdrop": "#11223344"})
    with pytest.raises(theme_library.ThemeLibraryError):
        theme_library.apply_edits(1, theme, colours={"nonsense": "#112233"})


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


# --- pinning the tables that must never drift ------------------------------


def test_every_key_maps_to_a_css_property():
    """`CSS_NAMES` is complete, and spelled the way `tokens.css` spells it.

    Four families of the twenty-seven are deliberately not their CSS names —
    `border`, `popover_border`, `warning_*` and `link_*` — and §3.2 says the
    *file* key is the stored word and may never change. A typo on either side
    of that mapping sets a custom property nothing reads, so the colour
    silently stays at the base's value on a theme somebody edited: no error, no
    blank tile, just an edit that did not take.
    """
    assert set(CSS_NAMES) == set(KEYS)
    assert len(set(CSS_NAMES.values())) == len(KEYS)  # no two keys share a property
    assert all(name.startswith("--") for name in CSS_NAMES.values())
    # The ones that are not their own names, written out so a rename has to
    # break a test that says why rather than one that says "expected 27".
    assert CSS_NAMES["border"] == "--line"
    assert CSS_NAMES["popover_border"] == "--line-popover"
    assert CSS_NAMES["warning"] == "--caution"
    assert CSS_NAMES["warning_bg"] == "--caution-bg"
    assert CSS_NAMES["warning_border"] == "--caution-line"
    assert [CSS_NAMES[f"link_{n}"] for n in range(1, 7)] == [
        f"--series-{n}" for n in range(1, 7)
    ]

    css = _stylesheet("tokens.css") + _stylesheet("theme-tally.css")
    for name in CSS_NAMES.values():
        assert f"{name}:" in css, f"{name} is not declared in the stylesheets"


def _stylesheet(name: str) -> str:
    path = Path(__file__).resolve().parents[2] / "frontend" / "src" / name
    assert path.is_file(), f"{path} is missing"
    return path.read_text(encoding="utf-8")


def _authored_hexes(css: str) -> tuple[dict[str, str], dict[str, str]]:
    """Every `--token` in a stylesheet that states a hex, dark half and light.

    A value that *is* a hex, or an OKLCH value with the hex written in the
    comment beside it — which is how `tokens.css` records what its recipe comes
    out as. The two halves split at the first `prefers-color-scheme: light`.
    """
    dark_half, _, light_half = css.partition("@media (prefers-color-scheme: light)")
    halves = []
    for half in (dark_half, light_half):
        found: dict[str, str] = {}
        for line in half.splitlines():
            declarations = re.findall(r"--([a-z0-9-]+):\s*([^;]*);", line)
            comment = re.search(r"/\*(.*?)\*/", line)
            for token, value in declarations:
                hex_in_value = re.search(r"#([0-9A-Fa-f]{6})\b", value)
                if hex_in_value:
                    found[f"--{token}"] = f"#{hex_in_value.group(1).upper()}"
                elif len(declarations) == 1 and comment:
                    in_comment = re.search(r"#([0-9A-Fa-f]{6})\b", comment.group(1))
                    if in_comment:
                        found[f"--{token}"] = f"#{in_comment.group(1).upper()}"
        halves.append(found)
    return halves[0], halves[1]


def test_the_built_ins_still_match_the_stylesheets():
    """`GRAPHITE` and `PAPER` against `tokens.css` and `theme-tally.css`.

    The built-ins are compiled in as hexes but *authored* in OKLCH in the
    stylesheets, and this branch already carries one "re-sync the house tokens"
    commit. The next one would move the interface and leave the two built-in
    tables — which is what a copied theme starts from, and what every theme file
    falls back to — a version behind, with nothing to notice.

    `accent`, `accent_dim`, `link_1` and `link_3` are read from
    `theme-tally.css` instead: Tally pins its own blue and swaps two series, so
    the house file's values for those four are Umber's and not what Tally
    renders.
    """
    house_dark, house_light = _authored_hexes(_stylesheet("tokens.css"))
    tally_dark, tally_light = _authored_hexes(_stylesheet("theme-tally.css"))

    overridden = {"accent", "accent_dim", "link_1", "link_3"}
    checked = 0
    for table, house, tally in (
        (GRAPHITE, house_dark, tally_dark),
        (PAPER, house_light, tally_light),
    ):
        for key, colour in table.items():
            source = tally if key in overridden else house
            authored = source.get(CSS_NAMES[key])
            if authored is None:
                continue
            assert authored == colour, f"{key}: stylesheet {authored}, table {colour}"
            checked += 1
    # A parser that quietly matched nothing would pass every assertion above.
    assert checked >= 30, f"only {checked} tokens were actually compared"


def test_the_authored_derived_values_still_match_tokens_css():
    """The three mixes `tokens.css` states literally, for the dark theme.

    These are the values `resolve()` hands back for a built-in instead of
    deriving them, so a drift here is a built-in rendering with a colour nobody
    chose — exactly what §3.2's "the built-in is right" sentence forbids.
    """
    house_dark, _ = _authored_hexes(_stylesheet("tokens.css"))
    for name in ("--line-soft", "--line-dashed", "--placeholder"):
        assert GRAPHITE_DERIVED[name] == house_dark[name]
    # The two that are aliases rather than mixes.
    assert GRAPHITE_DERIVED["--field"] == GRAPHITE["dock"]
    assert GRAPHITE_DERIVED["--accent-ink"] == GRAPHITE["window"]
    assert PAPER_DERIVED["--field"] == PAPER["popover"]
    assert PAPER_DERIVED["--accent-ink"] == PAPER["popover"]


def test_a_built_in_resolves_to_its_authored_values_and_a_copy_derives():
    graphite = resolve(builtin_theme("graphite"))
    assert graphite["--line-dashed"] == "#3A3D42"  # authored, not the derived #404246

    # A theme somebody copied is not a built-in, and §3.2 blesses deriving it.
    copied = Theme(id="mine", name="Mine", base="graphite", colours=dict(GRAPHITE))
    assert resolve(copied)["--line-dashed"] == mix(
        GRAPHITE["border"], GRAPHITE["text_dim"], 0.30
    )
    assert resolve(copied)["--line-dashed"] != graphite["--line-dashed"]


# --- agreeing with the reference implementation ----------------------------


def test_keys_and_base_values_are_matched_case_sensitively():
    """§3.2 makes the *header* case-insensitive and says nothing else is.

    `themelib.rs` matches a token id and a base id with `==`. A tolerant reader
    here would apply an `ACCENT = #FF0000` that Umber counts as unread, and read
    `base = PAPER` as a light theme where Umber reads a dark one — the same
    file, two interfaces, and two different values for the one number §3.2
    requires be shown to the user.
    """
    result = decode(HEADER + "\nACCENT = #FF0000\nbase = PAPER\n")
    assert result.skipped == 1
    assert result.theme.colours["accent"] == BUILTINS["graphite"].colours["accent"]
    assert result.theme.colours["window"] == BUILTINS["graphite"].colours["window"]
    assert result.theme.dark is True


def test_a_unicode_separator_in_a_name_is_not_a_line_break():
    """U+2028 is not a control character, so a name may legally contain one.

    Rust's `str::lines()` does not break on it; `str.splitlines()` does, which
    made Tally read the rest of such a name as a setting — a name and an
    injected accent, with nothing counted as skipped.
    """
    separator = "\u2028"  # LINE SEPARATOR: not a control character
    result = decode(HEADER + "\nname = A" + separator + "accent = #FF0000\n")
    assert result.theme.name == "A" + separator + "accent = #FF0000"
    assert result.theme.colours["accent"] == BUILTINS["graphite"].colours["accent"]
    assert result.skipped == 0


def test_only_control_characters_become_spaces():
    """A control character breaks the line format; a space-like one does not.

    `is_control` in the reference is Unicode category Cc and nothing else, so a
    non-breaking space, a zero-width space and the directional marks are kept.
    An earlier version asked `str.isprintable()`, which is false for all three —
    so a name Umber keeps came back from Tally with its characters replaced, and
    the name changed on a round trip between the two apps.
    """
    assert bound_name("Night\tOwl\x07") == "Night Owl"
    # A non-breaking space, a zero-width space, a left-to-right mark and a
    # line separator. None is category Cc; all four are false for
    # `str.isprintable()`.
    for kept in ("\u00a0", "\u200b", "\u200e", "\u2028"):
        assert bound_name("A" + kept + "B") == "A" + kept + "B"


# --- a name already in the library gets a number ---------------------------


def test_a_repeat_name_is_numbered_rather_than_duplicated(library):
    first = theme_library.create(1, "Night Owl", "graphite", {})
    second = theme_library.create(1, "Night Owl", "graphite", {})
    # Compared case-insensitively, so "night owl" does not slip past "Night Owl".
    third = theme_library.create(1, "night owl", "graphite", {})
    assert [first.name, second.name, third.name] == [
        "Night Owl",
        "Night Owl 2",
        "night owl 3",
    ]
    names = [theme.name for theme in theme_library.list_themes(1)]
    assert len(names) == len({name.lower() for name in names})


def test_a_built_in_label_is_taken_too(library):
    """Two cards both called Graphite are two cards you can only tell apart by
    which one has a Delete on it."""
    copy = theme_library.create(1, "Graphite", "graphite", {})
    assert copy.name == "Graphite 2"
    assert [theme.name for theme in theme_library.list_themes(1)] == [
        "Graphite",
        "Paper",
        "Graphite 2",
    ]


def test_a_rename_onto_a_taken_name_is_numbered_but_a_no_op_rename_is_not(library):
    theme_library.create(1, "Night Owl", "graphite", {})
    other = theme_library.create(1, "Dawn", "graphite", {})

    renamed = theme_library.apply_edits(1, other, name="Night Owl")
    assert renamed.name == "Night Owl 2"
    theme_library.write(1, renamed)

    # Re-committing the name a theme already has must not number it — otherwise
    # saving the editor twice turns "Mine" into "Mine 2".
    again = theme_library.apply_edits(1, renamed, name="Night Owl 2")
    assert again.name == "Night Owl 2"

    # And a colour edit does not touch the name at all.
    coloured = theme_library.apply_edits(1, again, colours={"accent": "#FF0088"})
    assert coloured.name == "Night Owl 2"


def test_a_numbered_name_still_fits_the_bound(library):
    theme_library.create(1, "z" * 64, "graphite", {})
    second = theme_library.create(1, "z" * 64, "graphite", {})
    assert len(second.name) <= NAME_MAX
    assert second.name.endswith(" 2")


def test_an_import_of_a_name_already_held_is_numbered(library):
    data = (HEADER + "\nname = Night Owl\nbase = paper\n").encode()
    first, _ = theme_library.import_bytes(1, data, "night-owl.umbertheme")
    second, _ = theme_library.import_bytes(1, data, "night-owl.umbertheme")
    assert [first.name, second.name] == ["Night Owl", "Night Owl 2"]
    # The id is freed separately, and by the other rule.
    assert [first.id, second.id] == ["night-owl", "night-owl-2"]


async def test_the_endpoints_never_show_one_name_twice(authed_client):
    await authed_client.post("/api/themes", json={"name": "Night Owl"})
    await authed_client.post("/api/themes", json={"name": "Night Owl"})
    copied = await authed_client.post("/api/themes", json={"name": "Graphite"})
    assert copied.json()["name"] == "Graphite 2"

    listed = (await authed_client.get("/api/themes")).json()
    names = [row["name"] for row in listed]
    assert names == ["Graphite", "Paper", "Graphite 2", "Night Owl", "Night Owl 2"]

    # A rename onto a name somebody else holds is numbered past every one of
    # them, including the numbered ones.
    clash = await authed_client.patch(
        "/api/themes/graphite-2", json={"name": "Night Owl"}
    )
    assert clash.json()["name"] == "Night Owl 3"

    # And the theme that already holds "Night Owl 2" may re-commit "Night Owl"
    # and keep the name it has, rather than climbing to 4 every time the editor
    # is saved: `free_name` compares against every *other* theme.
    settled = await authed_client.patch(
        "/api/themes/night-owl-2", json={"name": "Night Owl"}
    )
    assert settled.json()["name"] == "Night Owl 2"

    final = [row["name"] for row in (await authed_client.get("/api/themes")).json()]
    assert len(final) == len(set(final))


# --- a base this build does not know ---------------------------------------
#
# §3.2's fallback is a **reader** rule: "an id the reader does not know falls
# back to `graphite`" governs which table fills the absent tokens, not what the
# file says. Umber ships `photoslop`, `shitstudio`, `krita` and `mediabog` and
# Tally ships none of them, so this is the ordinary case for a file that came
# from Umber — and rewriting the word would mean a theme that crossed to Tally
# and back lost the preset it was authored against, silently and permanently.


def test_an_unknown_base_survives_the_whole_library_round_trip(library):
    """Stored as written, resolved at read time — at every step, not just one.

    The encoder was tested for this from the start; the *library* was not, and
    an import that quietly re-based a file would be invisible until somebody
    opened their theme in the app that understands the preset.
    """
    data = (HEADER + "\nname = Bog Standard\nbase = mediabog\naccent = #FF0088\n").encode()
    imported, skipped = theme_library.import_bytes(1, data, "bog.umbertheme")
    assert skipped == 0  # an unknown base is a fallback, not a lost line
    assert imported.base == "mediabog"

    # On disk, in the file somebody can hand back to Umber.
    stored = (library / "1" / "bog-standard.umbertheme").read_text(encoding="utf-8")
    assert "base = mediabog" in stored

    # Read back, listed, and encoded again.
    reloaded = theme_library.load(1, "bog-standard")
    assert reloaded.base == "mediabog"
    assert [t.base for t in theme_library.list_themes(1)] == [
        "graphite",
        "paper",
        "mediabog",
    ]
    assert "base = mediabog" in encode(reloaded)

    # And everywhere the base is *used*, it resolves to Graphite's — the table
    # the absent tokens came from, and the darkness the client stamps a class
    # from. An unknown base must be Graphite's answer, never an undefined one.
    assert reloaded.dark is True
    assert reloaded.colours["window"] == BUILTINS["graphite"].colours["window"]
    assert reloaded.colours["accent"] == "#FF0088"
    assert resolve(reloaded)["--field"] == BUILTINS["graphite"].colours["dock"]
    assert resolve(reloaded)["--accent-ink"] == BUILTINS["graphite"].colours["window"]


def test_an_unknown_base_keeps_its_case_as_well_as_its_word(library):
    """`base` is not case-folded, so the word goes back exactly as it came.

    Lower-casing it here would be a quieter version of the same loss: the app
    that owns the preset matches its ids with `==`.
    """
    data = (HEADER + "\nname = Bog\nbase = MediaBog\n").encode()
    imported, _ = theme_library.import_bytes(1, data, "bog.umbertheme")
    assert imported.base == "MediaBog"
    assert theme_library.load(1, imported.id).base == "MediaBog"
    assert imported.dark is True


def test_an_absent_base_is_written_out_as_graphite(library):
    """The one case where the word really is replaced, and it has to be.

    A file that names no base has nothing to preserve, and §3.2 says every key
    is written on the way out — so the fallback becomes the file's answer.
    """
    imported, _ = theme_library.import_bytes(1, (HEADER + "\nname = Bare\n").encode())
    assert imported.base == "graphite"
    assert "base = graphite" in encode(imported)


async def test_an_unknown_base_survives_the_endpoints(authed_client):
    text = HEADER + "\nname = Bog Standard\nbase = mediabog\naccent = #FF0088\n"
    imported = await authed_client.post(
        "/api/themes/import",
        files={"file": ("bog.umbertheme", text.encode(), "text/plain")},
    )
    assert imported.status_code == 200, imported.text
    assert imported.json()["theme"]["base"] == "mediabog"
    # The client stamps its theme class from this, so it has to be Graphite's
    # answer rather than absent.
    assert imported.json()["theme"]["dark"] is True

    listed = (await authed_client.get("/api/themes")).json()
    assert [row["base"] for row in listed] == ["graphite", "paper", "mediabog"]

    detail = (await authed_client.get("/api/themes/bog-standard")).json()
    assert detail["base"] == "mediabog"
    assert detail["colours"]["window"] == BUILTINS["graphite"].colours["window"]

    exported = await authed_client.get("/api/themes/bog-standard/export")
    assert "base = mediabog" in exported.text

    # And a copy of it carries the base too. `POST` is the one endpoint that
    # chooses a base rather than being handed one, so it is the one that could
    # quietly substitute a built-in.
    copied = await authed_client.post(
        "/api/themes", json={"name": "Bog Copy", "source_id": "bog-standard"}
    )
    assert copied.json()["base"] == "mediabog"
    assert copied.json()["dark"] is True
    assert copied.json()["colours"]["accent"] == "#FF0088"
