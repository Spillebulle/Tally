"""The release-name parser renames rows, so what it refuses matters most."""
import pytest

from app.services.release_names import looks_like_capture_filename, parse_release_name

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


# A camera's own naming schemes. The first came off a live instance: a phone
# recording played once through Plex and filed under "movies" ever since.
CAPTURE_NAMES = [
    "2020-03-31 19.42.27",
    "2020-03-31 19-42-27",
    "2021_11_05 08.30.00",
    "20200331_194227",
    "2020-03-31T19:42:27",
    "2020-03-31 19.42",  # no seconds
    "2020-03-31 19.42.27.mp4",  # extension left on
    "2020-03-31 19.42.27 (1)",  # the second copy of the same file
    "IMG_4821",
    "IMG-4821",
    "img_4821",
    "DSC00123",
    "DSCF1234",
    "MVI_1234",
    "PXL_20211105_083000",
    "VID_20200331_194227",
    "GOPR0123",
    "DJI_0042",
]

# Real titles, and the near misses that make the gate worth having. A wasted
# provider call a week is the cost of a mistake here; declaring somebody's film
# to be a home video is the cost of the other one.
NOT_CAPTURE_NAMES = [
    "1917",
    "2012",
    "2020",  # a real documentary, and a bare date besides
    "2001: A Space Odyssey",
    "9-1-1",  # digits and hyphens, and a series people watch
    "11-11-11",  # a horror film, and not a date in any order
    "2020-03-31",  # a date with no time: could be a title, so it is one
    "2020-13-45 99.99.99",  # timestamp-shaped, but no such moment exists
    "Space 1999",
    "THX 1138",
    "Apollo 13",
    "Rocky 4",
    "Se7en",
    "Blade Runner 2049",
    "District 9",
    "The 400 Blows",
    "Movie 43",
    "Sleeping Beauty 1959 DVDRip XviD AC3-FLAWL3SS",  # a release name, not a camera
    "The.Jungle.Book.2.2003.1080p.BluRay.H264.AAC-RARBG",
    "IMG",
    "Image 4821",  # a word in front of a number is a title
    "",
]


@pytest.mark.parametrize("raw", CAPTURE_NAMES)
def test_a_camera_filename_is_recognised(raw):
    assert looks_like_capture_filename(raw), f"{raw!r} is a camera's name for a file"


@pytest.mark.parametrize("raw", NOT_CAPTURE_NAMES)
def test_a_real_title_is_never_called_a_home_video(raw):
    assert not looks_like_capture_filename(raw), f"{raw!r} is a title"
