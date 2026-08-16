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


def test_a_mal_match_alone_does_not_make_a_western_cartoon_anime():
    """MAL is +2 and the anime keyword is +3, which together reach the
    threshold of 5. The module docstring calls the MAL signal "corroborating,
    never decisive alone" — but with an unverified search hit it *was*
    decisive, because Jikan's fuzzy search always returns something.

    The guard is now in `_titles_match` (see test_metadata_providers), so this
    pins the scoring side: an American, English, animated title carrying the
    `anime` keyword must not tip over on a MAL match alone.
    """
    western = MetadataResult(
        genres=["Animation", "Action"],
        origin_countries=["US"],
        original_language="en",
        keywords=["anime", "based on manga"],
    )

    without_mal = classify(genres=["Animation"], metadata=western, mal_matched=False)
    with_mal = classify(genres=["Animation"], metadata=western, mal_matched=True)

    assert not without_mal.is_anime
    assert with_mal.score == without_mal.score + 2
    # The scoring intentionally lets these two combine — the protection is that
    # `mal_matched` is only True for a title that actually matched. Assert the
    # weights, so a future re-weighting that makes MAL decisive on its own is a
    # deliberate change and not an accident.
    assert without_mal.score == 3, "keyword weight changed; re-check the MAL total"


def test_stored_signals_reconstruct_what_the_classifier_needs():
    """A row carries every signal the classifier scores on; nothing read them.

    `origin_countries`, `original_language` and `keywords` are columns on
    `MediaItem`, and every offline reclassification path passed `metadata=None`
    — so the same title that scored 5+ during import scored 0 the moment it was
    re-examined, and the verdict was written back over the good one.
    """
    from app.models import MediaItem, MediaType
    from app.services.media_repo import stored_signals

    item = MediaItem(
        guid_key="tmdb:show:1",
        media_type=MediaType.SHOW,
        title="Cowboy Bebop",
        genres=["Animation", "Action"],
        origin_countries=["JP"],
        original_language="ja",
        keywords=["based on manga"],
    )
    ids, signals = stored_signals(item)

    verdict = classify(genres=item.genres, ids=ids, metadata=signals)
    assert verdict.is_anime, "the stored signals did not reach the threshold"

    # And the same row with nothing passed is exactly the failure being fixed.
    assert not classify(genres=item.genres).is_anime


def test_stored_signals_recover_the_forcing_agents():
    """`anime_hinted` is a forcing signal, and two of its four inputs were lost.

    There is no `anidb_id` column — a HAMA-scanned row's only trace of its agent
    is the `anidb:` prefix `build_guid_key` wrote — and `anilist_id`, which does
    have a column, was simply left out of every hand-built `ExternalIds`.
    """
    from app.models import MediaItem, MediaType
    from app.services.media_repo import stored_signals

    hama = MediaItem(
        guid_key="anidb:show:1234", media_type=MediaType.SHOW, title="Monster"
    )
    ids, signals = stored_signals(hama)
    assert ids.anidb_id == 1234
    assert classify(genres=[], ids=ids, metadata=signals).source == "plex_agent"

    listed = MediaItem(
        guid_key="tmdb:show:2",
        media_type=MediaType.SHOW,
        title="Steins;Gate",
        anilist_id=9253,
    )
    assert stored_signals(listed)[0].anime_hinted

    # A plain title stays plain: the prefix match is anchored, so a `tmdb:` key
    # cannot pick up an agent it never had.
    plain = MediaItem(guid_key="tmdb:movie:603", media_type=MediaType.MOVIE, title="Heat")
    assert not stored_signals(plain)[0].anime_hinted


def test_stored_signals_do_not_make_western_animation_anime():
    """The reconstruction must not smuggle in a signal of its own."""
    from app.models import MediaItem, MediaType
    from app.services.media_repo import stored_signals

    item = MediaItem(
        guid_key="tmdb:movie:9",
        media_type=MediaType.MOVIE,
        title="The Incredibles",
        genres=["Animation", "Family"],
        origin_countries=["US"],
        original_language="en",
        keywords=["superhero"],
    )
    ids, signals = stored_signals(item)
    assert not classify(genres=item.genres, ids=ids, metadata=signals).is_anime


def test_a_japanese_animated_film_still_classifies_without_mal():
    """The classifier must not have become so cautious it misses real anime."""
    verdict = classify(
        genres=["Animation"],
        metadata=MetadataResult(
            genres=["Animation"],
            origin_countries=["JP"],
            original_language="ja",
        ),
    )
    assert verdict.is_anime
