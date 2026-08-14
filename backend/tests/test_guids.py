"""GUID parsing decides item identity and feeds anime detection."""
from app.services.guids import build_guid_key, extract_ids, parse_guid


def test_parses_modern_plex_guid_array():
    meta = {
        "guid": "plex://movie/5d776be7ad5437001f79c6f8",
        "Guid": [
            {"id": "imdb://tt0133093"},
            {"id": "tmdb://603"},
            {"id": "tvdb://12345"},
        ],
    }
    ids = extract_ids(meta)
    assert ids.tmdb_id == 603
    assert ids.imdb_id == "tt0133093"
    assert ids.tvdb_id == 12345
    assert ids.plex_guid == "plex://movie/5d776be7ad5437001f79c6f8"
    assert not ids.anime_hinted


def test_parses_legacy_agent_guids():
    ids = extract_ids({"guid": "com.plexapp.agents.themoviedb://603?lang=en"})
    assert ids.tmdb_id == 603

    ids = extract_ids({"guid": "com.plexapp.agents.thetvdb://81189/1/2?lang=en"})
    # The season/episode suffix must not be swallowed into the series id.
    assert ids.tvdb_id == 81189


def test_hama_agent_flags_anime_and_unwraps_inner_provider():
    ids = extract_ids({"guid": "com.plexapp.agents.hama://anidb-1234/1/2?lang=en"})
    assert ids.anidb_id == 1234
    assert ids.anime_hinted

    ids = extract_ids({"guid": "com.plexapp.agents.hama://tvdb-81189"})
    assert ids.tvdb_id == 81189
    # HAMA is only used by anime libraries, so its presence is itself the signal.
    assert ids.anime_hinted


def test_unknown_guid_is_survivable():
    ids = parse_guid("something-nonsensical")
    assert ids.tmdb_id is None
    assert ids.imdb_id is None


def test_guid_key_prefers_tmdb_so_servers_agree():
    a = extract_ids({"Guid": [{"id": "tmdb://603"}, {"id": "imdb://tt0133093"}]})
    b = extract_ids({"Guid": [{"id": "imdb://tt0133093"}, {"id": "tmdb://603"}]})
    assert build_guid_key("movie", a) == build_guid_key("movie", b) == "tmdb:movie:603"


def test_guid_key_falls_back_to_title_and_year():
    ids = extract_ids({})
    key = build_guid_key("movie", ids, title="Akira", year=1988)
    assert key == "title:movie:akira:1988"


def test_episode_keys_hang_off_their_show():
    ids = extract_ids({})
    show_key = "tmdb:show:1396"
    season = build_guid_key("season", ids, show_key=show_key, season_number=2)
    episode = build_guid_key(
        "episode", ids, show_key=show_key, season_number=2, episode_number=5
    )
    assert season == "tmdb:show:1396/s2"
    assert episode == "tmdb:show:1396/s2e5"
