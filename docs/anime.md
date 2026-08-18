# How anime is detected

Which signals Tally weighs to decide a title is anime, and how to overrule it.

There is no single reliable "is this anime?" flag across Plex, TMDB and TheTVDB,
so Tally combines signals and scores them. The scoring is deliberately
conservative, and the case it exists to get right is that **an animated Western
film is not anime for being animated**.

## The signals

Three signals are decisive on their own. Anything else has to add up.

| Signal | Weight | Why |
|---|---|---|
| Your library override | decisive | You said so. |
| A HAMA, AniDB or MyAnimeList metadata agent on the item | decisive | Only anime libraries use those agents. |
| A library named something like "Anime" | decisive | The common self-hosting convention, in Latin script or in katakana. |
| An explicit `Anime` genre tag | 6 | TheTVDB and some Plex agents emit it. |
| Animation **and** Japanese origin country | 5 | The reliable TMDB combination. |
| An anime-ish TMDB keyword (`shounen`, `based on manga`, `isekai`, and so on) | 3 | Suggestive, never conclusive. |
| Animation **and** Japanese original language | 3 | A weaker form of the origin signal, and only counted when the origin signal did not fire. |
| A confident MyAnimeList title match | 2 | Corroborating. Never enough on its own. |

**A total of 5 or more marks the item as anime.** So the genre tag alone decides
it, and animation plus a Japanese origin decides it, but a keyword plus a
MyAnimeList match (3 + 2) only just does, and an animated English-language film
made in the United States scores nothing at all.

MyAnimeList is only consulted when something already suggests anime: an anime
library, an anime-specific agent, or an animated title with some Japanese
connection. Looking every Western title up would be slow, and the free
MyAnimeList mirror's rate limit is low.

A season or an episode takes its answer from its series, so a show and its
episodes can never disagree.

## Overruling it

**Per library, which always wins.** Open **Settings → Plex servers**. Each
library has a dropdown reading **Detect anime**, **Always anime** or **Never
anime**. Set it and every title in that library follows, whatever the signals
say.

**Re-running detection.** An administrator can press **Re-detect anime** under
**Settings → Library → Danger**. Every library still set to **Detect
anime** is judged again, which can move titles between the anime section and the
film and show sections. A library you have set by hand keeps what you set. It is
worth doing after adding a TMDB or TheTVDB key, because those unlock signals
that were not available during the original import.

**Whether anime is separated at all** is a switch of its own, under **Settings →
Library → Anime**: "Keep anime in its own section". With it off, anime
appears in Films and Shows alongside everything else.

Which providers are active on your instance is shown under **Settings →
Metadata**, and the keys that switch them on are in `configuration.md`.
