"""The anime classifier must separate anime from Western animation."""
from app.services.guids import ExternalIds
from app.services.metadata.anime import classify, library_looks_like_anime, should_try_mal
from app.services.metadata.base import MetadataResult


def test_library_named_anime_is_decisive():
    verdict = classify(genres=["Drama"], library_title="Anime")
    assert verdict.is_anime
    assert verdict.source == "library_name"


def test_explicit_override_beats_every_other_signal():
    # A user who says "this library is not anime" must be obeyed even when the
    # content looks like anime.
    verdict = classify(
        genres=["Animation", "Anime"],
        library_title="Anime Movies",
        library_override=False,
    )
    assert not verdict.is_anime


def test_anime_agent_guid_is_decisive():
    ids = ExternalIds()
    ids.agents.add("hama")
    verdict = classify(genres=[], ids=ids)
    assert verdict.is_anime
    assert verdict.source == "plex_agent"


def test_japanese_animation_is_detected_without_an_anime_library():
    verdict = classify(
        genres=["Animation", "Adventure"],
        metadata=MetadataResult(
            genres=["Animation"], origin_countries=["JP"], original_language="ja"
        ),
    )
    assert verdict.is_anime


def test_western_animation_is_not_anime():
    # The case the classifier exists to get right: animated, but not Japanese.
    verdict = classify(
        genres=["Animation", "Family", "Comedy"],
        metadata=MetadataResult(
            genres=["Animation", "Family"],
            origin_countries=["US"],
            original_language="en",
        ),
    )
    assert not verdict.is_anime


def test_live_action_japanese_film_is_not_anime():
    verdict = classify(
        genres=["Drama", "Thriller"],
        metadata=MetadataResult(
            genres=["Drama"], origin_countries=["JP"], original_language="ja"
        ),
    )
    assert not verdict.is_anime


def test_explicit_anime_genre_tag_is_enough():
    verdict = classify(genres=["Anime", "Action"])
    assert verdict.is_anime


def test_keywords_alone_do_not_cross_the_threshold():
    # A single weak signal should not be decisive; that is what the score is for.
    verdict = classify(
        genres=["Drama"],
        metadata=MetadataResult(keywords=["based on manga"], origin_countries=["JP"]),
    )
    assert not verdict.is_anime
    assert verdict.score < 5


def test_mal_lookup_is_skipped_for_obviously_western_titles():
    assert not should_try_mal(
        genres=["Drama", "Crime"],
        ids=None,
        metadata=MetadataResult(origin_countries=["US"], original_language="en"),
        library_title="Movies",
        library_override=None,
    )


def test_mal_lookup_runs_for_borderline_animation():
    assert should_try_mal(
        genres=["Animation"],
        ids=None,
        metadata=MetadataResult(
            genres=["Animation"], origin_countries=["JP"], original_language="ja"
        ),
        library_title="Movies",
        library_override=None,
    )


def test_library_name_matcher():
    assert library_looks_like_anime("Anime")
    assert library_looks_like_anime("Anime Movies")
    assert library_looks_like_anime("My anime shows")
    assert not library_looks_like_anime("Animation")
    assert not library_looks_like_anime("Movies")
    assert not library_looks_like_anime(None)
