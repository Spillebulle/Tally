"""The release-name parser renames rows, so what it refuses matters most."""
import pytest

from app.services.release_names import parse_release_name

# Every one of these came off a live instance, from watch history Plex had
# snapshotted while the file was still unmatched.
RECOVERED = [
    (
        "The.Jungle.Book.2.2003.1080p.BluRay.H264.AAC-RARBG",
        "The Jungle Book 2",
        2003,
    ),
    ("Mars.Needs.Mom.2011.1080p.BluRay.H264.AAC-RARBG", "Mars Needs Mom", 2011),
    ("The.Simpsons.Movie.2007.1080p.BluRay.H264.AAC-RARBG", "The Simpsons Movie", 2007),
    ("Unfriended.2014.1080p.BluRay.H264.AAC-RARBG", "Unfriended", 2014),
    ("Sleeping Beauty 1959 DVDRip XviD AC3-FLAWL3SS", "Sleeping Beauty", 1959),
    # No year in the name at all: the quality tag is still where the title ends.
    ("Some.Obscure.Short.1080p.WEB-DL", "Some Obscure Short", None),
]

# Left exactly as they are. A missed recovery is a visible oddity; a wrong one
# renames a film in somebody's library.
UNTOUCHED = [
    "2 Fast 2 Furious",  # digits everywhere, no year, no tag
    "Blade Runner 2049",  # the "year" is the title
    "2001: A Space Odyssey",  # ...and here it opens the title
    "1917",
    "Se7en",
    "S.W.A.T.",  # dot-separated, but nothing to cut at
    "Mr. Robot",
    "Winnie the Pooh 2011",  # spaces and no tag: not certain enough
    "Pokémon 3 The Movie: Spell of the Unown (2000)",
    "2020-03-31 19.42.27",  # a phone recording, and there is no title in it
    "The Matrix",
    "",
]


@pytest.mark.parametrize("raw,title,year", RECOVERED)
def test_a_release_name_gives_up_its_title(raw, title, year):
    parsed = parse_release_name(raw)
    assert parsed is not None, f"{raw!r} should have been recognised"
    assert parsed.title == title
    assert parsed.year == year


@pytest.mark.parametrize("raw", UNTOUCHED)
def test_a_real_title_is_never_rewritten(raw):
    assert parse_release_name(raw) is None, f"{raw!r} is a title, not a release name"
