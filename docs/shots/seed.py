"""Seed a realistic Tally SQLite database for the UI preview harness.

Builds rows straight through the app's own SQLAlchemy models (never raw SQL) so
the shape of the data always matches ``backend/app/models.py``. Run it with the
backend's own virtualenv, since it imports ``app.*``:

    backend/.venv/Scripts/python.exe docs/shots/seed.py --data-dir <dir> --fresh

Deterministic: same ``--seed`` (default fixed) always produces the same
library, so two runs are diffable. No Plex server exists here, so nothing gets
a ``thumb_path``/``art_path`` and every poster renders as the deterministic
placeholder gradient the frontend already falls back to — that is expected,
not a bug (see docs/shots/README.md).
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import uuid
from datetime import date, datetime, timedelta, UTC
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
BACKEND_DIR = REPO_ROOT / "backend"


# ---------------------------------------------------------------------------
# Curated real titles. Categories drive genres/rating/studio programmatically
# rather than hand-tagging every field on every one of ~195 titles.
# ---------------------------------------------------------------------------

# (title, year, category)
MOVIES: list[tuple[str, int, str]] = [
    ("The Godfather", 1972, "crime"),
    ("The Godfather Part II", 1974, "crime"),
    ("The Shawshank Redemption", 1994, "drama"),
    ("Pulp Fiction", 1994, "crime"),
    ("Fight Club", 1999, "drama"),
    ("The Dark Knight", 2008, "action"),
    ("Inception", 2010, "scifi"),
    ("Interstellar", 2014, "scifi"),
    ("The Matrix", 1999, "scifi"),
    ("Forrest Gump", 1994, "drama"),
    ("Goodfellas", 1990, "crime"),
    ("Se7en", 1995, "thriller"),
    ("The Silence of the Lambs", 1991, "thriller"),
    ("Schindler's List", 1993, "war"),
    ("Saving Private Ryan", 1998, "war"),
    ("Gladiator", 2000, "action"),
    ("The Departed", 2006, "crime"),
    ("No Country for Old Men", 2007, "thriller"),
    ("There Will Be Blood", 2007, "drama"),
    ("Whiplash", 2014, "drama"),
    ("La La Land", 2016, "romance"),
    ("Parasite", 2019, "thriller"),
    ("Get Out", 2017, "horror"),
    ("Hereditary", 2018, "horror"),
    ("The Shining", 1980, "horror"),
    ("Alien", 1979, "horror"),
    ("Aliens", 1986, "action"),
    ("Blade Runner", 1982, "scifi"),
    ("Blade Runner 2049", 2017, "scifi"),
    ("Mad Max: Fury Road", 2015, "action"),
    ("John Wick", 2014, "action"),
    ("Die Hard", 1988, "action"),
    ("Terminator 2: Judgment Day", 1991, "action"),
    ("Jurassic Park", 1993, "action"),
    ("Back to the Future", 1985, "scifi"),
    ("E.T. the Extra-Terrestrial", 1982, "family"),
    ("Raiders of the Lost Ark", 1981, "action"),
    ("Star Wars", 1977, "scifi"),
    ("The Empire Strikes Back", 1980, "scifi"),
    ("Return of the Jedi", 1983, "scifi"),
    ("The Lord of the Rings: The Fellowship of the Ring", 2001, "fantasy"),
    ("The Lord of the Rings: The Two Towers", 2002, "fantasy"),
    ("The Lord of the Rings: The Return of the King", 2003, "fantasy"),
    ("Harry Potter and the Sorcerer's Stone", 2001, "fantasy"),
    ("Harry Potter and the Prisoner of Azkaban", 2004, "fantasy"),
    ("The Prestige", 2006, "thriller"),
    ("Memento", 2000, "thriller"),
    ("Eternal Sunshine of the Spotless Mind", 2004, "romance"),
    ("Amélie", 2001, "romance"),
    ("City of God", 2002, "crime"),
    ("Oldboy", 2003, "thriller"),
    ("Casablanca", 1942, "romance"),
    ("Citizen Kane", 1941, "drama"),
    ("Vertigo", 1958, "thriller"),
    ("Psycho", 1960, "horror"),
    ("North by Northwest", 1959, "thriller"),
    ("2001: A Space Odyssey", 1968, "scifi"),
    ("Apocalypse Now", 1979, "war"),
    ("Taxi Driver", 1976, "drama"),
    ("Rocky", 1976, "drama"),
    ("Jaws", 1975, "thriller"),
    ("The Exorcist", 1973, "horror"),
    ("One Flew Over the Cuckoo's Nest", 1975, "drama"),
    ("Annie Hall", 1977, "comedy"),
    ("Some Like It Hot", 1959, "comedy"),
    ("Singin' in the Rain", 1952, "musical"),
    ("The Wizard of Oz", 1939, "family"),
    ("Gone with the Wind", 1939, "romance"),
    ("Life Is Beautiful", 1997, "drama"),
    ("Cinema Paradiso", 1988, "drama"),
    ("Amadeus", 1984, "drama"),
    ("Braveheart", 1995, "action"),
    ("Titanic", 1997, "romance"),
    ("Avatar", 2009, "scifi"),
    ("Avengers: Endgame", 2019, "action"),
    ("Iron Man", 2008, "action"),
    ("Black Panther", 2018, "action"),
    ("Spider-Man: Into the Spider-Verse", 2018, "animation"),
    ("Toy Story", 1995, "animation"),
    ("Finding Nemo", 2003, "animation"),
    ("Up", 2009, "animation"),
    ("Wall-E", 2008, "animation"),
    ("Coco", 2017, "animation"),
    ("Inside Out", 2015, "animation"),
    ("Shrek", 2001, "animation"),
    ("The Incredibles", 2004, "animation"),
    ("Ratatouille", 2007, "animation"),
    ("Zootopia", 2016, "animation"),
    ("Monsters, Inc.", 2001, "animation"),
    ("How to Train Your Dragon", 2010, "animation"),
    ("The Lion King", 1994, "animation"),
    ("Beauty and the Beast", 1991, "animation"),
    ("Aladdin", 1992, "animation"),
    ("Snow White and the Seven Dwarfs", 1937, "animation"),
    ("Fantasia", 1940, "animation"),
    ("The Social Network", 2010, "drama"),
    ("Moneyball", 2011, "drama"),
    ("The Big Short", 2015, "comedy"),
    ("The Wolf of Wall Street", 2013, "comedy"),
    ("American Beauty", 1999, "drama"),
    ("Requiem for a Dream", 2000, "drama"),
    ("Trainspotting", 1996, "drama"),
    ("Snatch", 2000, "crime"),
    ("Lock, Stock and Two Smoking Barrels", 1998, "crime"),
    ("In Bruges", 2008, "crime"),
    ("Kill Bill: Volume 1", 2003, "action"),
    ("Kill Bill: Volume 2", 2004, "action"),
    ("Reservoir Dogs", 1992, "crime"),
    ("Django Unchained", 2012, "western"),
    ("Inglourious Basterds", 2009, "war"),
    ("Once Upon a Time in Hollywood", 2019, "drama"),
    ("The Hateful Eight", 2015, "western"),
    ("No Time to Die", 2021, "action"),
    ("Skyfall", 2012, "action"),
    ("Casino Royale", 2006, "action"),
    ("Mission: Impossible - Fallout", 2018, "action"),
    ("The Bourne Identity", 2002, "action"),
    ("Edge of Tomorrow", 2014, "scifi"),
    ("Arrival", 2016, "scifi"),
    ("Ex Machina", 2014, "scifi"),
    ("Her", 2013, "romance"),
    ("Children of Men", 2006, "scifi"),
    ("Gravity", 2013, "scifi"),
    ("The Martian", 2015, "scifi"),
    ("Dune", 2021, "scifi"),
    ("Dune: Part Two", 2024, "scifi"),
    ("Everything Everywhere All at Once", 2022, "scifi"),
    ("The Grand Budapest Hotel", 2014, "comedy"),
    ("Knives Out", 2019, "mystery"),
    ("Glass Onion", 2022, "mystery"),
    ("Superbad", 2007, "comedy"),
    ("Bridesmaids", 2011, "comedy"),
    ("Anchorman: The Legend of Ron Burgundy", 2004, "comedy"),
    ("The Hangover", 2009, "comedy"),
    ("Deadpool", 2016, "comedy"),
    ("Twin Peaks: Fire Walk with Me", 1992, "mystery"),
    ("The Truman Show", 1998, "drama"),
    ("Good Will Hunting", 1997, "drama"),
    # Anime films (~19 of these, to land the library at roughly a tenth anime).
    ("Spirited Away", 2001, "anime"),
    ("My Neighbor Totoro", 1988, "anime"),
    ("Princess Mononoke", 1997, "anime"),
    ("Howl's Moving Castle", 2004, "anime"),
    ("Grave of the Fireflies", 1988, "anime"),
    ("Akira", 1988, "anime"),
    ("Your Name.", 2016, "anime"),
    ("A Silent Voice", 2016, "anime"),
    ("Weathering with You", 2019, "anime"),
    ("Ponyo", 2008, "anime"),
    ("The Wind Rises", 2013, "anime"),
    ("Perfect Blue", 1997, "anime"),
    ("Paprika", 2006, "anime"),
    ("Ghost in the Shell", 1995, "anime"),
    ("Wolf Children", 2012, "anime"),
    ("The Tale of the Princess Kaguya", 2013, "anime"),
    ("Jujutsu Kaisen 0", 2021, "anime"),
    ("Demon Slayer: Mugen Train", 2020, "anime"),
    ("Suzume", 2022, "anime"),
]

# (title, start_year, end_year_or_None, category, network)
SHOWS: list[tuple[str, int, int | None, str, str]] = [
    ("Breaking Bad", 2008, 2013, "crime", "AMC"),
    ("Better Call Saul", 2015, 2022, "drama", "AMC"),
    ("The Wire", 2002, 2008, "crime", "HBO"),
    ("The Sopranos", 1999, 2007, "crime", "HBO"),
    ("Game of Thrones", 2011, 2019, "fantasy", "HBO"),
    ("House of the Dragon", 2022, None, "fantasy", "HBO"),
    ("Succession", 2018, 2023, "drama", "HBO"),
    ("The Last of Us", 2023, None, "drama", "HBO"),
    ("Chernobyl", 2019, 2019, "drama", "HBO"),
    ("True Detective", 2014, None, "crime", "HBO"),
    ("Stranger Things", 2016, None, "horror", "Netflix"),
    ("The Crown", 2016, 2023, "drama", "Netflix"),
    ("Ozark", 2017, 2022, "crime", "Netflix"),
    ("Narcos", 2015, 2017, "crime", "Netflix"),
    ("Mindhunter", 2017, 2019, "crime", "Netflix"),
    ("Black Mirror", 2011, None, "scifi", "Netflix"),
    ("The Witcher", 2019, None, "fantasy", "Netflix"),
    ("Dark", 2017, 2020, "scifi", "Netflix"),
    ("Money Heist", 2017, 2021, "crime", "Netflix"),
    ("Squid Game", 2021, None, "thriller", "Netflix"),
    ("Friends", 1994, 2004, "comedy", "NBC"),
    ("Seinfeld", 1989, 1998, "comedy", "NBC"),
    ("The Office", 2005, 2013, "comedy", "NBC"),
    ("Parks and Recreation", 2009, 2015, "comedy", "NBC"),
    ("Community", 2009, 2015, "comedy", "NBC"),
    ("Brooklyn Nine-Nine", 2013, 2021, "comedy", "NBC"),
    ("It's Always Sunny in Philadelphia", 2005, None, "comedy", "FXX"),
    ("Arrested Development", 2003, 2019, "comedy", "Fox"),
    ("Curb Your Enthusiasm", 2000, 2024, "comedy", "HBO"),
    ("Fargo", 2014, None, "crime", "FX"),
    ("American Horror Story", 2011, None, "horror", "FX"),
    ("The X-Files", 1993, 2018, "scifi", "Fox"),
    ("Lost", 2004, 2010, "mystery", "ABC"),
    ("Twin Peaks", 1990, 1991, "mystery", "ABC"),
    ("Battlestar Galactica", 2004, 2009, "scifi", "Sci-Fi Channel"),
    ("Firefly", 2002, 2002, "scifi", "Fox"),
    ("Doctor Who", 2005, None, "scifi", "BBC"),
    ("Sherlock", 2010, 2017, "crime", "BBC"),
    ("Peaky Blinders", 2013, 2022, "crime", "BBC"),
    ("Downton Abbey", 2010, 2015, "drama", "ITV"),
    # Anime series.
    ("Attack on Titan", 2013, 2023, "anime", "MBS"),
    ("Fullmetal Alchemist: Brotherhood", 2009, 2010, "anime", "MBS"),
    ("Death Note", 2006, 2007, "anime", "NTV"),
    ("Cowboy Bebop", 1998, 1999, "anime", "TV Tokyo"),
    ("One Piece", 1999, None, "anime", "Fuji TV"),
]

GENRE_MAP: dict[str, list[str]] = {
    "crime": ["Crime", "Drama"],
    "drama": ["Drama"],
    "action": ["Action", "Adventure"],
    "scifi": ["Science Fiction"],
    "thriller": ["Thriller"],
    "horror": ["Horror"],
    "comedy": ["Comedy"],
    "romance": ["Romance"],
    "fantasy": ["Fantasy", "Adventure"],
    "war": ["War", "Drama"],
    "family": ["Family"],
    "animation": ["Animation", "Family"],
    "anime": ["Animation"],
    "mystery": ["Mystery", "Thriller"],
    "western": ["Western"],
    "musical": ["Music", "Comedy"],
    "adventure": ["Adventure", "Fantasy"],
}

OVERVIEW_TEMPLATES: dict[str, list[str]] = {
    "crime": [
        "A tale of loyalty, betrayal and consequence in the criminal underworld.",
        "A careful, patient account of how one bad decision compounds into a dozen more.",
    ],
    "drama": [
        "A quietly devastating look at what people owe each other, carried by performances that linger.",
        "An unhurried study of an ordinary life pushed somewhere it never expected to go.",
    ],
    "action": [
        "A relentless, high-stakes chase where every choice comes at a cost.",
        "A propulsive set of set pieces built around a hero running out of time.",
    ],
    "scifi": [
        "A speculative journey that stays grounded by very human stakes.",
        "A big idea taken seriously, followed all the way to its uncomfortable end.",
    ],
    "thriller": [
        "A tightly wound mystery that keeps its true shape hidden until the end.",
        "A slow-burn plot where nobody is quite telling the truth.",
    ],
    "horror": [
        "A slow, creeping dread that turns the familiar into something wrong.",
        "A patient, unsettling film that trusts silence more than jump scares.",
    ],
    "comedy": [
        "A sharp, warm-hearted comedy about getting it all wrong in the right way.",
        "A fast, quotable comedy that never quite lets its characters win cleanly.",
    ],
    "romance": [
        "Two people, bad timing, and the long way round to getting it right.",
        "A love story told mostly in the small moments between the big ones.",
    ],
    "fantasy": [
        "A sweeping journey through a world built on old magic and older grudges.",
        "A quest that costs its characters more than any of them expected.",
    ],
    "war": [
        "A ground-level account of what a war actually costs the people inside it.",
        "A story that keeps its distance from heroics and stays close to the cost.",
    ],
    "family": [
        "An adventure built for sharing, with a little more heart than it lets on.",
        "A gentle, funny story that never talks down to the people watching it.",
    ],
    "animation": [
        "A vividly imagined world where the animation carries as much of the story as the script.",
        "A colourful, inventive film that earns its emotional swings honestly.",
    ],
    "anime": [
        "A story told with the particular patience and visual invention of Japanese animation.",
        "A quietly ambitious film that trusts its images to do the talking.",
    ],
    "mystery": [
        "A puzzle assembled in plain sight, one wrong assumption at a time.",
        "A whodunnit that plays fair with the clues and still gets you.",
    ],
    "western": [
        "A dust-blown reckoning between men who have run out of other options.",
        "A story about the last stretch of a frontier that is closing fast.",
    ],
    "musical": [
        "A story that keeps breaking into song, and is better for it.",
    ],
    "adventure": [
        "A voyage into uncharted territory, with a crew worth following anywhere.",
        "A restless, wide-open story that keeps finding new horizons.",
    ],
}

EPISODE_TITLES = [
    "The Beginning", "Old Wounds", "New Rules", "Point of No Return",
    "Something Borrowed", "The Long Way Home", "What Remains",
    "A Different Kind of Quiet", "The Reckoning", "Between the Lines",
    "Signal Lost", "The Weight of It", "Small Mercies", "Nothing Personal",
    "The Last Good Day", "Aftershocks", "What the Fire Left",
    "The Other Side", "Close Enough", "Borrowed Time", "The Long Game",
    "Coming Up for Air", "The Quiet Part", "A Matter of Time",
    "Loose Ends", "The Turn", "Half Measures", "Cold Open", "Fault Lines",
    "The Long Way Round", "Static", "Undertow", "The Hard Part", "Recon",
    "Aftermath", "The Setup", "Payback", "Home Stretch",
    "The Waiting Room", "Crosswinds", "Dead Reckoning", "First Light",
]

ANIME_STUDIOS = [
    "Studio Ghibli", "Madhouse", "Kyoto Animation", "Toei Animation",
    "Production I.G", "CoMix Wave Films", "MAPPA", "Bones",
]
ANIMATION_STUDIOS = [
    "Pixar Animation Studios", "Walt Disney Animation Studios",
    "DreamWorks Animation", "Illumination", "Blue Sky Studios",
]
GENERAL_STUDIOS = [
    "Warner Bros. Pictures", "Universal Pictures", "Paramount Pictures",
    "20th Century Studios", "Columbia Pictures", "Walt Disney Pictures",
    "New Line Cinema", "Lionsgate", "A24", "Metro-Goldwyn-Mayer",
    "Focus Features", "Miramax", "DreamWorks Pictures",
]

COUNTRY_LANG_OVERRIDES: dict[str, tuple[str, str]] = {
    "Amélie": ("FR", "fr"),
    "City of God": ("BR", "pt"),
    "Oldboy": ("KR", "ko"),
    "Parasite": ("KR", "ko"),
    "Life Is Beautiful": ("IT", "it"),
    "Cinema Paradiso": ("IT", "it"),
    "Trainspotting": ("GB", "en"),
    "Snatch": ("GB", "en"),
    "Lock, Stock and Two Smoking Barrels": ("GB", "en"),
    "In Bruges": ("GB", "en"),
    "Dark": ("DE", "de"),
    "Money Heist": ("ES", "es"),
    "Squid Game": ("KR", "ko"),
    "Doctor Who": ("GB", "en"),
    "Sherlock": ("GB", "en"),
    "Peaky Blinders": ("GB", "en"),
    "Downton Abbey": ("GB", "en"),
}

# Real season counts, so a flagship show's episodes label as e.g. "S05E01"
# rather than a plausible-looking but wrong number a rng.randint would produce
# (Breaking Bad seeded with 7 seasons once; it has 5). One Piece is still
# airing, so its count is TheTVDB's season 22 as of this writing rather than a
# fixed total.
FLAGSHIP_SEASON_COUNTS = {
    "Breaking Bad": 5,
    "Friends": 10,
    "Seinfeld": 9,
    "The Office": 9,
    "One Piece": 22,
    "Attack on Titan": 4,
    "Game of Thrones": 8,
    "The X-Files": 11,
}
FLAGSHIP_SHOWS = set(FLAGSHIP_SEASON_COUNTS)

DEVICES = [
    ("Chrome", "Plex Web"),
    ("Apple TV", "Plex for Apple TV"),
    ("Living Room TV", "Plex for LG"),
    ("iPhone", "Plex for iOS"),
    ("iPad", "Plex for iOS"),
    ("Roku Ultra", "Plex for Roku"),
    ("Samsung TV", "Plex for Samsung"),
]


def country_lang(title: str, category: str) -> tuple[str, str]:
    if title in COUNTRY_LANG_OVERRIDES:
        return COUNTRY_LANG_OVERRIDES[title]
    if category == "anime":
        return ("JP", "ja")
    return ("US", "en")


def movie_studio(category: str, rng: random.Random) -> str:
    if category == "anime":
        return rng.choice(ANIME_STUDIOS)
    if category == "animation":
        return rng.choice(ANIMATION_STUDIOS)
    return rng.choice(GENERAL_STUDIOS)


def movie_rating(category: str, rng: random.Random) -> str:
    if category in ("family", "animation"):
        return rng.choice(["G", "PG", "PG"])
    if category in ("horror", "crime", "war"):
        return rng.choice(["R", "R", "NC-17"])
    if category == "anime":
        return rng.choice(["PG-13", "R"])
    return rng.choice(["PG-13", "PG-13", "R"])


def show_rating(category: str, rng: random.Random) -> str:
    if category == "family":
        return "TV-PG"
    if category in ("crime", "drama", "horror", "thriller", "mystery"):
        return rng.choice(["TV-MA", "TV-14"])
    if category == "comedy":
        return rng.choice(["TV-14", "TV-PG"])
    if category == "anime":
        return rng.choice(["TV-14", "TV-MA"])
    return "TV-14"


def weighted_hour(rng: random.Random) -> int:
    buckets = list(range(24))
    weights = []
    for h in buckets:
        if 18 <= h <= 23:
            weights.append(8)
        elif 12 <= h <= 17:
            weights.append(4)
        elif 7 <= h <= 11:
            weights.append(3)
        else:
            weights.append(1)
    return rng.choices(buckets, weights=weights, k=1)[0]


def pick_datetime(
    rng: random.Random, date_from: date, date_to: date, gap: tuple[date, date]
) -> datetime:
    """A UTC datetime somewhere in the window, biased to weekends and evenings.

    Avoids ``gap`` entirely (the "user was away" stretch) via rejection
    sampling, which is also how the weekday bias is applied — cheap because the
    window is only ~18 months.
    """
    total_days = (date_to - date_from).days
    weekday_weight = {0: 1.0, 1: 1.0, 2: 1.0, 3: 1.05, 4: 1.3, 5: 1.8, 6: 1.6}
    for _ in range(200):
        offset = rng.randint(0, total_days)
        d = date_from + timedelta(days=offset)
        if gap[0] <= d <= gap[1]:
            continue
        if rng.random() > weekday_weight[d.weekday()] / 1.8:
            continue
        hour = weighted_hour(rng)
        minute = rng.randint(0, 59)
        return datetime(d.year, d.month, d.day, hour, minute, tzinfo=UTC)
    # Fallback: should not happen with a window this size, but never loop forever.
    d = date_from + timedelta(days=rng.randint(0, total_days))
    return datetime(d.year, d.month, d.day, 20, 0, tzinfo=UTC)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, help="Where to build tally.db")
    parser.add_argument("--fresh", action="store_true", help="Delete any existing database first")
    parser.add_argument("--seed", type=int, default=20260817, help="RNG seed, for reproducible output")
    args = parser.parse_args()

    data_dir = Path(args.data_dir).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    db_path = data_dir / "tally.db"

    if args.fresh:
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(db_path) + suffix)
            if p.exists():
                p.unlink()

    # `get_settings()` is lru_cached and reads DATA_DIR at import time (see
    # CLAUDE.md) — every env var the app cares about must be set before the
    # first `from app...` import, not just before `get_settings()` is called.
    sys.path.insert(0, str(BACKEND_DIR))
    os.environ["DATA_DIR"] = str(data_dir)
    os.environ.setdefault("PUBLIC_URL", "http://127.0.0.1:8931")
    os.environ.setdefault("LOG_LEVEL", "WARNING")

    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from app.models import (
        Base,
        MediaItem,
        MediaType,
        PlexLibrary,
        PlexMapping,
        PlexServer,
        SyncRun,
        SyncStatus,
        User,
        UserMediaState,
        UserServerAccess,
        WatchEvent,
        WatchlistEntry,
        WatchSource,
        WatchStatus,
        utcnow,
    )
    from app.security import encrypt_secret, hash_password
    from app.services.guids import ExternalIds, build_guid_key

    rng = random.Random(args.seed)

    engine = create_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(engine)

    now = utcnow()
    today = now.date()
    window_from = today - timedelta(days=548)  # ~18 months
    gap_start = window_from + timedelta(days=rng.randint(80, 380))
    gap = (gap_start, gap_start + timedelta(days=rng.randint(14, 24)))

    with Session(engine) as session:
        # --- User -----------------------------------------------------
        user = User(
            username="ulrik",
            display_name="Ulrik",
            password_hash=hash_password("preview"),
            # A fake but *present* Plex identity: Settings' server card renders
            # off `has_plex_link` (derived from `plex_user_id`), not off the
            # PlexServer/UserServerAccess rows alone, so leaving this unset
            # shows "No Plex account linked" regardless of what else is seeded.
            plex_user_id="preview-plex-account-1",
            plex_username="ulrik",
            plex_token_encrypted=encrypt_secret("preview-plex-tv-token"),
            is_admin=True,
            is_active=True,
            preferences={
                "sync_ratings": True,
                "sync_watchlist": True,
                "sync_history": True,
                "separate_anime": True,
                "default_view": "dashboard",
                "theme": "system",
                "timezone": "Europe/Oslo",
                "continue_watching_weeks": 16,
            },
            created_at=now - timedelta(days=600),
            last_login_at=now - timedelta(hours=2),
            last_full_sync_at=now - timedelta(hours=6),
        )
        session.add(user)
        session.flush()

        # --- Plex server, libraries, access, sync run ------------------
        # The scheduler's periodic sync fires within seconds of the backend
        # starting (APScheduler's IntervalTrigger fires an immediate first run
        # unless told otherwise) and will happily try to reach whatever
        # UserServerAccess + an enabled PlexServer point it at. A private LAN
        # address like 192.168.1.50 can sit there unanswered for a real
        # TCP-level timeout before Tally's own circuit breaker gives up, which
        # is dead time and log noise this harness has no business paying for —
        # there is no Plex server here, by design (see README.md). Loopback on
        # a port nothing listens on refuses the connection immediately instead,
        # so `full_sync`'s library/history/watchlist phases fail fast rather
        # than hang, while the row still looks like a normal, enabled server so
        # Settings has something real to show.
        server = PlexServer(
            machine_identifier="preview-mediaserver-0001",
            name="Home Theatre",
            base_url="http://127.0.0.1:1",
            candidate_urls=["http://127.0.0.1:1"],
            access_token_encrypted=encrypt_secret("preview-owner-token"),
            owned=True,
            version="1.40.1.8227",
            platform="Linux",
            on_deck_window_weeks=16,
            owner_user_id=user.id,
            enabled=True,
            last_seen_at=now - timedelta(minutes=10),
            created_at=now - timedelta(days=600),
        )
        session.add(server)
        session.flush()

        libraries = {
            "movies": PlexLibrary(
                server_id=server.id, section_key="1", section_uuid=str(uuid.uuid4()),
                title="Movies", section_type="movie", anime_override=None,
                item_count=0, last_synced_at=now - timedelta(hours=6),
            ),
            "anime_movies": PlexLibrary(
                server_id=server.id, section_key="2", section_uuid=str(uuid.uuid4()),
                title="Anime Movies", section_type="movie", anime_override=True,
                item_count=0, last_synced_at=now - timedelta(hours=6),
            ),
            "shows": PlexLibrary(
                server_id=server.id, section_key="3", section_uuid=str(uuid.uuid4()),
                title="TV Shows", section_type="show", anime_override=None,
                item_count=0, last_synced_at=now - timedelta(hours=6),
            ),
            "anime": PlexLibrary(
                server_id=server.id, section_key="4", section_uuid=str(uuid.uuid4()),
                title="Anime", section_type="show", anime_override=True,
                item_count=0, last_synced_at=now - timedelta(hours=6),
            ),
        }
        for lib in libraries.values():
            session.add(lib)
        session.flush()

        session.add(
            UserServerAccess(
                user_id=user.id,
                server_id=server.id,
                access_token_encrypted=encrypt_secret("preview-user-token"),
                plex_account_id=1,
                owned=True,
                enabled=True,
                last_history_sync_at=now - timedelta(hours=6),
                created_at=now - timedelta(days=600),
            )
        )

        session.add(
            SyncRun(
                user_id=user.id,
                kind="full",
                status=SyncStatus.SUCCESS,
                started_at=now - timedelta(hours=6, minutes=4),
                finished_at=now - timedelta(hours=6),
                stats={"items_synced": 0, "history_imported": 0, "watchlist_synced": 0},
                messages=["Library scan complete", "History import complete", "Watchlist synced"],
                phase=None,
                progress_current=1,
                progress_total=1,
                cancel_requested=False,
            )
        )

        # --- Movies ------------------------------------------------------
        rating_key_counter = 1
        movie_rows: list[MediaItem] = []
        for title, year, category in MOVIES:
            country, language = country_lang(title, category)
            is_anime = category == "anime"
            item = MediaItem(
                guid_key=build_guid_key(MediaType.MOVIE.value, ExternalIds(), title=title, year=year),
                media_type=MediaType.MOVIE,
                title=title,
                year=year,
                overview=rng.choice(OVERVIEW_TEMPLATES[category]),
                runtime_minutes=rng.randint(88, 168),
                content_rating=movie_rating(category, rng),
                studio=movie_studio(category, rng),
                genres=GENRE_MAP[category],
                release_status="released",
                first_aired=date(year, rng.randint(1, 12), rng.randint(1, 28)),
                community_rating=round(rng.uniform(5.5, 9.3), 1),
                original_language=language,
                origin_countries=[country],
                is_anime=is_anime,
                anime_source="library" if is_anime else None,
                created_at=now - timedelta(days=rng.randint(0, 900)),
            )
            session.add(item)
            movie_rows.append(item)
        session.flush()

        for item in movie_rows:
            lib = libraries["anime_movies"] if item.is_anime else libraries["movies"]
            lib.item_count += 1
            rating_key_counter += 1
            session.add(
                PlexMapping(
                    media_item_id=item.id,
                    server_id=server.id,
                    library_id=lib.id,
                    rating_key=str(rating_key_counter),
                    guid=f"plex://movie/{uuid.uuid4().hex[:24]}",
                    added_at=item.created_at,
                    updated_at=item.created_at,
                )
            )

        # --- Shows, seasons, episodes -------------------------------------
        show_rows: list[MediaItem] = []
        show_episode_ids: dict[int, list[int]] = {}
        for title, start_year, end_year, category, network in SHOWS:
            country, language = country_lang(title, category)
            is_anime = category == "anime"
            ended = end_year is not None
            release_status = "ended" if ended else rng.choice(["airing", "airing", "ended"])
            show_created = now - timedelta(days=rng.randint(0, 900))
            show = MediaItem(
                guid_key=build_guid_key(MediaType.SHOW.value, ExternalIds(), title=title, year=start_year),
                media_type=MediaType.SHOW,
                title=title,
                year=start_year,
                overview=rng.choice(OVERVIEW_TEMPLATES[category]),
                content_rating=show_rating(category, rng),
                network=network,
                genres=GENRE_MAP[category],
                release_status=release_status,
                first_aired=date(start_year, rng.randint(1, 12), rng.randint(1, 28)),
                community_rating=round(rng.uniform(6.0, 9.4), 1),
                original_language=language,
                origin_countries=[country],
                is_anime=is_anime,
                anime_source="library" if is_anime else None,
                created_at=show_created,
            )
            session.add(show)
            session.flush()
            show_rows.append(show)

            lib = libraries["anime"] if is_anime else libraries["shows"]
            lib.item_count += 1
            rating_key_counter += 1
            session.add(
                PlexMapping(
                    media_item_id=show.id,
                    server_id=server.id,
                    library_id=lib.id,
                    rating_key=str(rating_key_counter),
                    guid=f"plex://show/{uuid.uuid4().hex[:24]}",
                    added_at=show_created,
                    updated_at=show_created,
                )
            )

            if title in FLAGSHIP_SHOWS:
                n_seasons = FLAGSHIP_SEASON_COUNTS[title]
                eps_range = (10, 22)
            else:
                n_seasons = rng.randint(1, 4)
                eps_range = (6, 14)
            episode_runtime = rng.randint(20, 60)

            episode_ids: list[int] = []
            leaf_count = 0
            for season_number in range(1, n_seasons + 1):
                season_year = min(start_year + season_number - 1, end_year or (start_year + season_number - 1))
                season = MediaItem(
                    guid_key=build_guid_key(
                        MediaType.SEASON.value, ExternalIds(),
                        show_key=show.guid_key, season_number=season_number,
                    ),
                    media_type=MediaType.SEASON,
                    title=f"Season {season_number}",
                    year=season_year,
                    show_id=show.id,
                    parent_id=show.id,
                    season_number=season_number,
                    is_anime=is_anime,
                    anime_source=show.anime_source,
                    created_at=show_created,
                )
                session.add(season)
                session.flush()

                n_episodes = rng.randint(*eps_range)
                leaf_count += n_episodes
                for episode_number in range(1, n_episodes + 1):
                    episode = MediaItem(
                        guid_key=build_guid_key(
                            MediaType.EPISODE.value, ExternalIds(),
                            show_key=show.guid_key, season_number=season_number,
                            episode_number=episode_number,
                        ),
                        media_type=MediaType.EPISODE,
                        title=rng.choice(EPISODE_TITLES),
                        year=season_year,
                        show_id=show.id,
                        parent_id=season.id,
                        season_number=season_number,
                        episode_number=episode_number,
                        runtime_minutes=episode_runtime + rng.randint(-4, 4),
                        is_anime=is_anime,
                        anime_source=show.anime_source,
                        created_at=show_created,
                    )
                    session.add(episode)
                    session.flush()
                    episode_ids.append(episode.id)

            show.child_count = n_seasons
            show.leaf_count = leaf_count
            show_episode_ids[show.id] = episode_ids

        session.flush()

        # --- User media states + watch events ------------------------------
        # (status, weight)
        STATUS_WEIGHTS: list[tuple[WatchStatus | None, int]] = [
            (WatchStatus.COMPLETED, 35),
            (WatchStatus.WATCHING, 5),
            (WatchStatus.PLAN_TO_WATCH, 15),
            (WatchStatus.ON_HOLD, 3),
            (WatchStatus.DROPPED, 7),
            (None, 35),
        ]
        statuses = [s for s, _ in STATUS_WEIGHTS]
        weights = [w for _, w in STATUS_WEIGHTS]

        events: list[WatchEvent] = []
        dedupe_counter = 0

        def next_dedupe_key() -> str:
            nonlocal dedupe_counter
            dedupe_counter += 1
            return f"plex:{server.machine_identifier}:{dedupe_counter}"

        def device_pair() -> tuple[str, str]:
            return rng.choice(DEVICES)

        def add_event(
            media_item_id: int,
            watched_at: datetime,
            duration_ms: int | None,
            *,
            library_id: int | None,
            completed: bool = True,
        ) -> WatchEvent:
            device, player = device_pair()
            progress = duration_ms if (completed or duration_ms is None) else int(duration_ms * rng.uniform(0.2, 0.8))
            ev = WatchEvent(
                user_id=user.id,
                media_item_id=media_item_id,
                watched_at=watched_at,
                source=WatchSource.PLEX_HISTORY,
                dedupe_key=next_dedupe_key(),
                progress_ms=progress,
                duration_ms=duration_ms,
                completed=completed,
                device=device,
                player=player,
                server_id=server.id,
                library_id=library_id if rng.random() < 0.75 else None,
                created_at=watched_at,
            )
            session.add(ev)
            events.append(ev)
            return ev

        movie_lib_ids = {False: libraries["movies"].id, True: libraries["anime_movies"].id}
        show_lib_ids = {False: libraries["shows"].id, True: libraries["anime"].id}

        watching_movie_ids: list[int] = []
        watching_show_ids: list[int] = []
        watchlist_candidates: list[tuple[int, MediaType]] = []
        notes_budget = 6
        featured_movie: MediaItem | None = None

        for item in movie_rows:
            status = rng.choices(statuses, weights=weights, k=1)[0]
            if item.title == "Blade Runner 2049":
                status = WatchStatus.COMPLETED
                featured_movie = item

            if status is None:
                watchlist_candidates.append((item.id, MediaType.MOVIE))
                continue
            if status == WatchStatus.PLAN_TO_WATCH:
                watchlist_candidates.append((item.id, MediaType.MOVIE))

            duration_ms = (item.runtime_minutes or 100) * 60_000
            watched = status in (
                WatchStatus.COMPLETED, WatchStatus.WATCHING,
                WatchStatus.ON_HOLD, WatchStatus.DROPPED,
            )
            view_count = 0
            last_watched_at = None
            progress_ms = None

            if watched:
                n_views = 2 if (item is featured_movie or rng.random() < 0.08) else 1
                lib_id = movie_lib_ids[item.is_anime]
                for _ in range(n_views):
                    watched_at = pick_datetime(rng, window_from, today, gap)
                    add_event(item.id, watched_at, duration_ms, library_id=lib_id, completed=True)
                    view_count += 1
                    if last_watched_at is None or watched_at > last_watched_at:
                        last_watched_at = watched_at
                if status == WatchStatus.WATCHING:
                    progress_ms = int(duration_ms * rng.uniform(0.15, 0.75))
                    watching_movie_ids.append(item.id)

            rating = None
            rating_updated_at = None
            if watched and rng.random() < 0.33:
                rating = rng.choice([5.0, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0])
                rating_updated_at = last_watched_at or now

            is_favorite = watched and rng.random() < 0.12
            notes = None
            if item is featured_movie:
                rating = 9.0
                is_favorite = True
                notes = "Rewatched for the cinematography. Holds up perfectly on a second viewing."
            elif watched and notes_budget > 0 and rng.random() < 0.05:
                notes = "Worth a rewatch some time."
                notes_budget -= 1

            state = UserMediaState(
                user_id=user.id,
                media_item_id=item.id,
                status=status,
                view_count=view_count,
                last_watched_at=last_watched_at,
                progress_ms=progress_ms,
                duration_ms=duration_ms if progress_ms else None,
                rating=rating,
                rating_updated_at=rating_updated_at,
                is_favorite=is_favorite,
                notes=notes,
                created_at=item.created_at,
            )
            session.add(state)

        # Shows: assign a status to the show itself, then mark a subset of its
        # episodes watched to match (all for completed, a prefix for the rest).
        recent_watch_budget = 3  # shows kept "fresh" for Continue Watching
        for show in show_rows:
            status = rng.choices(statuses, weights=weights, k=1)[0]
            episode_ids = show_episode_ids[show.id]

            if status is None:
                watchlist_candidates.append((show.id, MediaType.SHOW))
                continue
            if status == WatchStatus.PLAN_TO_WATCH:
                watchlist_candidates.append((show.id, MediaType.SHOW))
                watched_episode_ids: list[int] = []
            elif status == WatchStatus.COMPLETED:
                watched_episode_ids = list(episode_ids)
            else:
                # watching / on_hold / dropped: a believable prefix, never all.
                cut = max(1, int(len(episode_ids) * rng.uniform(0.2, 0.7)))
                watched_episode_ids = episode_ids[:cut]

            lib_id = show_lib_ids[show.is_anime]
            last_watched_at = None
            for ep_id in watched_episode_ids:
                ep = session.get(MediaItem, ep_id)
                duration_ms = (ep.runtime_minutes or 25) * 60_000
                watched_at = pick_datetime(rng, window_from, today, gap)
                add_event(ep_id, watched_at, duration_ms, library_id=lib_id, completed=True)
                ep_state = UserMediaState(
                    user_id=user.id,
                    media_item_id=ep_id,
                    status=WatchStatus.COMPLETED,
                    view_count=1,
                    last_watched_at=watched_at,
                    created_at=watched_at,
                )
                session.add(ep_state)
                if last_watched_at is None or watched_at > last_watched_at:
                    last_watched_at = watched_at

            if status == WatchStatus.WATCHING and watched_episode_ids and recent_watch_budget > 0:
                watching_show_ids.append(show.id)
                recent_watch_budget -= 1

            rating = None
            if watched_episode_ids and rng.random() < 0.33:
                rating = rng.choice([6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0])

            is_favorite = bool(watched_episode_ids) and rng.random() < 0.12
            notes = None
            if watched_episode_ids and notes_budget > 0 and rng.random() < 0.06:
                notes = "Second season dips a little but worth sticking with."
                notes_budget -= 1

            show_state = UserMediaState(
                user_id=user.id,
                media_item_id=show.id,
                status=status,
                view_count=len(watched_episode_ids),
                last_watched_at=last_watched_at,
                rating=rating,
                rating_updated_at=last_watched_at,
                is_favorite=is_favorite,
                notes=notes,
                created_at=show.created_at,
            )
            session.add(show_state)
            session.flush()

        session.flush()

        # --- Binge days: force a cluster of episode-events from one already
        # watched show onto a single date each, a few minutes apart. -----------
        big_shows = [s for s in show_rows if len(show_episode_ids[s.id]) >= 8]
        rng.shuffle(big_shows)
        for show in big_shows[:2]:
            eps = show_episode_ids[show.id][: rng.randint(6, 9)]
            binge_dt = pick_datetime(rng, window_from, today, gap)
            start_hour = rng.choice([13, 19])
            base = datetime(binge_dt.year, binge_dt.month, binge_dt.day, start_hour, 0, tzinfo=UTC)
            lib_id = show_lib_ids[show.is_anime]
            for i, ep_id in enumerate(eps):
                ep = session.get(MediaItem, ep_id)
                duration_ms = (ep.runtime_minutes or 25) * 60_000
                watched_at = base + timedelta(minutes=i * rng.randint(24, 48))
                add_event(ep_id, watched_at, duration_ms, library_id=lib_id, completed=True)

        # --- Freshness pass: keep a couple of "watching" items inside the
        # Continue Watching window regardless of where random sampling put them.
        recent_pool = list(watching_movie_ids) + list(watching_show_ids)
        for media_item_id in recent_pool:
            recent_at = now - timedelta(
                days=rng.randint(1, 18), hours=rng.randint(0, 23), minutes=rng.randint(0, 59)
            )
            state = (
                session.query(UserMediaState)
                .filter_by(user_id=user.id, media_item_id=media_item_id)
                .one_or_none()
            )
            if state is not None:
                state.last_watched_at = recent_at
            # Only the show's own UserMediaState.last_watched_at matters for
            # the "up next" query in routers/library.py — it orders and filters
            # on that column, never on individual episode timestamps. The
            # already-watched episodes' own rows are left alone.

        # --- Watchlist -------------------------------------------------------
        rng.shuffle(watchlist_candidates)
        chosen = watchlist_candidates[:15]
        for i, (media_item_id, _kind) in enumerate(chosen):
            added_at = now - timedelta(days=rng.randint(5, 340))
            plex_added_at = added_at - timedelta(hours=rng.randint(0, 6)) if rng.random() < 0.6 else None
            active = i < 10
            entry = WatchlistEntry(
                user_id=user.id,
                media_item_id=media_item_id,
                active=active,
                added_at=added_at,
                plex_added_at=plex_added_at,
                removed_at=(added_at + timedelta(days=rng.randint(1, 60))) if not active else None,
                source="plex" if plex_added_at else "tally",
                plex_active=active,
                plex_synced_at=now - timedelta(hours=6),
            )
            session.add(entry)

        session.commit()

        seed_info = {
            "username": "ulrik",
            "password": "preview",
            "sample_item_id": featured_movie.id if featured_movie else movie_rows[0].id,
            "sample_show_id": show_rows[0].id,
            "movie_count": len(movie_rows),
            "show_count": len(show_rows),
            "event_count": len(events),
        }

    (data_dir / "seed-info.json").write_text(json.dumps(seed_info, indent=2))
    print(f"Seeded {db_path}")
    print(json.dumps(seed_info, indent=2))


if __name__ == "__main__":
    main()
