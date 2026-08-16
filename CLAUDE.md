# CLAUDE.md

Working notes for Tally. This covers what is *not* obvious from reading the
code — invariants that are easy to break, Plex API behaviour that is
undocumented, and environment quirks that cost time to rediscover.

User-facing setup, configuration and troubleshooting live in `README.md`; this
file does not repeat them.

---

## Orientation

Tally is a self-hosted watch tracker with two-way Plex sync. FastAPI + SQLAlchemy
+ SQLite on the backend, React + TypeScript + Tailwind on the frontend, shipped
as one Docker image where the API also serves the built SPA.

```
backend/app/
├── main.py            app wiring; mounts frontend/dist at app/static
├── config.py          pydantic-settings; get_settings() is lru_cached
├── models.py          the schema — read this first
├── db.py              engine, session, create_all + light migrations
├── security.py        JWT sessions, Fernet token encryption, bcrypt
├── serializers.py     ORM → API payloads (bulk helpers avoid N+1)
├── media_filters.py   browse filters + sorting, shared by grid and watchlist
├── merge_duplicates.py startup repair for items recorded under two identities
├── routers/           HTTP layer, thin
│   ├── images.py      artwork proxy — Plex art needs a token, URLs must not
│   └── api_keys.py    issue/revoke keys; auth for them lives in deps.py
└── services/
    ├── plex_tv.py     plex.tv cloud: OAuth PINs, resources, Discover watchlist
    ├── plex_server.py one Plex Media Server: libraries, history, sessions, writes
    ├── guids.py       Plex GUID → external ids; also the anime agent signal
    ├── titles.py      "is this the same title?" — one rule, providers + merge
    ├── media_repo.py  Plex metadata → canonical MediaItem rows
    ├── sync_service.py the two-way engine
    ├── webhooks.py    Plex Pass webhook ingestion
    ├── scheduler.py   APScheduler jobs
    ├── on_deck.py     how long something stays in Continue Watching
    └── metadata/      TMDB, TVDB, MAL/Jikan + anime classifier
frontend/src/
├── pages/             one file per screen
├── components/        Poster/Artwork, BrowseFilters, Charts, Layout, Icons, ui
└── lib/               api client, types, contexts, utils
```

---

## Invariants — break these and things corrupt quietly

### `guid_key` is the identity of everything

`MediaItem.guid_key` is the canonical dedup key. The entire model rests on it:
the same show on two servers, scanned by different agents, plus a watchlist entry
from Discover, must all collapse to one row.

`build_guid_key()` has a **preference order** (tmdb → tvdb → imdb → anidb → mal →
plex guid → title+year). Changing that order orphans every existing row: the next
sync computes different keys, finds nothing, and creates duplicates of the whole
library. If it ever must change, ship a migration that rewrites existing keys.

Seasons and episodes derive their key from their show's (`<show_key>/s2e5`) so
they stay grouped even when the episode carries no external id of its own.

**The identity of a source is only as good as the ids you asked it for.** This
already went wrong once, at scale. A library scan sends `includeGuids=1` and
gets `tmdb:movie:300671`; the Discover watchlist was fetched *without* it, so
the only id available was the `plex://` ratingKey and `build_guid_key` fell
through to `plex:<key>`. Same film, two keys, two rows — one per watchlist
entry, 447 duplicates on a real instance, and the phantom half had no
`PlexMapping` and therefore no artwork. Enrichment then gave both rows the same
tmdb id, which made it look like dedup had simply failed.

So: **always request guids**, and when a payload still has none,
`_existing_match` looks for the row that already exists rather than minting a
new identity. `merge_duplicates.py` cleans up what the old behaviour left
behind.

**It then happened a second time, in the history import.** `_ingest_history_entry`
fetched full metadata only when the entry had no `guid` at all — but a modern
Plex history row always has one, and it is the `plex://` form. Presence is not
resolution: `extract_ids` returns nothing but `plex_guid` from it, so the fetch
was skipped and `build_guid_key` fell through to `plex:<key>` all the same. 372
of 4796 rows on a live instance, each a duplicate of a film sitting next to it
with its poster intact. The test is now `extract_ids(entry).identifying` — does
this payload name the item to anything other than this one server — and that is
the test any future source has to pass before it is allowed to mint a row.

Two things follow, and both were missing:

* **A thin payload has no `year`, and without one nothing can ever identify the
  row.** History rows carry `originallyAvailableAt` but not `year`, so these
  rows could not be enriched into having artwork either. The air date answers
  it — but only onto `item.year`, **never into `build_guid_key`**, whose
  last-resort branch is title+year: filling it in beforehand re-keys every
  id-less row already stored and duplicates the lot.
* **Nothing revisits a row once it exists.** Enrichment hangs off an import, and
  a row no import touches — no longer in the library, not on the watchlist — is
  never looked at again by anything. `backfill_missing_metadata` is the only
  pass that goes back for them. It only ever adds; `merge_duplicates` stays the
  only pass allowed to delete.

**And a third time, in the same import, for the payloads with no `ratingKey`.**
Plex drops it from a history row whose metadata item it no longer holds — the
file was deleted, or replaced and rescanned under a new key — and returns the
stored snapshot of the play instead: a title, an air date, nothing else. With
no key, `find_by_rating_key` has nothing to look up and the re-fetch above has
nothing to ask for, so the `identifying` test never even ran. The snapshot went
straight to `upsert_from_plex`.

The test now gates the *mint*, not just the fetch: `existing_match_for_thin_payload`
runs first, and only when it finds nothing is a row created. That "nothing" is
the common answer and must stay allowed — a play of something since deleted
from Plex is history that should outlive the file, and on a live instance ~75
of the ~105 mapping-less rows are exactly that, correctly kept.

**A snapshot title is whatever the item was called that day, which may be the
filename.** A file still unmatched when it was played is snapshotted as
`The.Jungle.Book.2.2003.1080p.BluRay.H264.AAC-RARBG`, and Plex keeps that
string forever even after you fix the match. No provider matches it, so the row
never gets an id — and `merge_duplicates` pairs on an id, so the ghost sits
beside the real row permanently, blank tile and all. `services/release_names.py`
recovers a title from it, in `upsert_from_plex` for new rows and in
`enrich_existing` for the ones already stored.

That parser renames rows, so it is gated hard: a quality token (`1080p`,
`XviD`, `AC3`) has to be present, or the string has to contain no spaces at
all. `Blade Runner 2049`, `2001: A Space Odyssey`, `2 Fast 2 Furious` and
`S.W.A.T.` must all come back untouched — see `tests/test_release_names.py`,
where the refusals are the more important half. And like the recovered year, the
cleaned title goes **onto `item.title` only, never into `build_guid_key`**: the
history import re-upserts the same entry on every overlapping sync, so a cleaned
title in the key would mint a fresh duplicate on each one.

**And some of those filenames hide no title at all.** `2020-03-31 19.42.27` is
a phone recording played once through Plex; so is `IMG_4821`. It arrives typed
`movie`, so nothing downstream could tell it from a film nobody can identify —
and that is a row Tally retries *forever*, spending a TMDB call a week on a
question with no answer and taking a slot from the bounded
`METADATA_BACKFILL_BATCH` while it does. `looks_like_capture_filename`, in the
same module, recognises a camera's own naming scheme — a full date **with a
time on it**, or a known device prefix followed by a serial — and
`MediaItem.is_personal_media` records the verdict, which is what lets the
backfill's SQL drop the row rather than load it. `enrich_existing` is the only
thing that marks a row already stored; there is deliberately no startup repair,
because the backfill already reaches exactly these rows and one turn through it
is the entire cost.

The verdict is **re-evaluated on every import, never latched**: if Plex matches
the file later and hands back a real title, the row is a film again — otherwise
one misread would hide a film permanently. The gate is the mirror of the
release-name parser's: a bare date is a plausible film title, and `9-1-1`,
`Space 1999` and `Apollo 13` are titles, so the refusals are the tested half
again.

### A search result must name the thing that was searched for

Everything above is about not minting a row from a payload that cannot name
itself. The other half is what happens *next*: for a row that has no external
id, whatever the metadata providers answer with **becomes** its identity, and a
wrong answer there is worse than no answer at all.

TMDB and TVDB search are fuzzy and always reply. Ask for a title they do not
have and you get the most popular thing that shares a word, and `results[0]`
was taken on faith. Four wrong ids on a live instance, every one a *prefix*:

    "Anti-Social" → "Anti-Social Limited"   (a Canadian documentary)
    "Men"         → "Men in Black"
    "Society"     → "Dead Poets Society"
    "Thelma"      → "Thelma & Louise"

So `services/titles.py` holds one definition of "same title" — exact once
accents, case and punctuation are stripped, and **a prefix does not count** —
and both halves of the rule use it: the providers refuse a search hit that does
not match, and `merge_duplicates` refuses to fuse rows that do not.
`mal._titles_match` stays forgiving on purpose; a MAL hit only scores the anime
classifier, and `mal_id` merges nothing.

Three things make a wrong id worse than none, and they are why this is not
merely cosmetic:

* **It is permanent.** `backfill_missing_metadata` selects rows with *no* id at
  all, so attaching a wrong one removes the row from the only pass that would
  ever look again.
* **It poisons a merge group.** `merge_duplicates` pairs on the id, so the ghost
  can no longer collapse into the real row — and, before the group was
  partitioned by title, it also blocked pairs it had no business joining.
* **It is silent.** No id shows as a blank tile somebody eventually notices.

Only the *search* path is checked. A known id, or an id cross-referenced through
`/find`, is exact — the caller already knew which record it wanted — and Plex
titles legitimately differ from TMDB's ("Marvel's Daredevil"), so checking there
would throw away good matches for no safety.

The year gets the same suspicion. `search()` retries without it whenever the
year-filtered page held nothing that *names* the title, not merely when it came
back empty. A thin row's year can come from a release-name tag rather than from
the film, and TMDB's `year=` is a hard filter: it does not empty the page, it
removes the right film and leaves a wrong one behind. That is the whole
mechanism of the "Anti-Social" match.

**The rule has a cost, and it partly reverses release-name recovery.** A
recovered filename that misspells the film by one character is now refused:
item 52633 is the standing example, `Mars.Needs.Mom` against *Mars Needs Moms*,
and it went from tmdb 50321 with a poster to no id and a blank tile. (Four of
the five recovered rows still heal; that one does not.) Accepted anyway, the
same looseness admits "Alien" against "Aliens" and "The Jungle Book 2" against
"The Jungle Book 3" — the identical silent error, on films the library really
holds. A missing poster is visible; a wrong id is not. Refusals log at **INFO**
for exactly this reason: `docker logs tally | grep -i refus` is the only thing
that explains a blank tile.

Such a row then stays in `backfill_missing_metadata` forever, *because* no id
was attached — one search a week, indefinitely. That unbounded retry is the
intended shape, not an oversight: it is also the only way the row heals if TMDB
later gains the alternative title.

### Every timestamp column must be `UtcDateTime`

SQLite has no native timestamp type and hands back **naive** datetimes even from
`DateTime(timezone=True)`. Comparing one to `utcnow()` raises `TypeError`.

This already shipped as a bug once: it crashed `recompute_show_state` during
ordinary syncs. `models.UtcDateTime` normalises in both directions. Adding a
plain `DateTime` column reintroduces the whole bug class — always use
`UtcDateTime`.

It also coerces a bare `date` to midnight UTC on bind, so a sloppy
`column >= some_date` filter does not explode. Prefer passing real datetimes.

### Two-way sync needs a `plex_*` mirror per field

The conflict model works because each syncable field stores **both** the local
value and the last value observed on Plex:

```
neither changed → no-op
local changed   → push
Plex changed    → pull
both changed    → newer timestamp wins
```

Adding a syncable field without its `plex_*` baseline and timestamp means the
sync cannot tell which side moved, and it will ping-pong the value forever. See
`UserMediaState.rating` / `plex_rating` / `plex_rating_synced_at` for the shape.

**After pushing to Plex, write the pushed value into the `plex_*` baseline.**
Otherwise the next pass sees a local change again and re-pushes every time.

### Watchlist removals are tombstones, never deletes

`WatchlistEntry.active = False` with `removed_at` set. Deleting the row means the
next pull from Plex sees the item present remotely and absent locally, and
re-adds what the user just removed. Same reasoning applies to any future
"removed by the user" state.

Two corollaries, both learned the hard way:

**`plex_active` records what we last *told* Plex, not what Plex confirmed.**
`remove_from_watchlist` sets it False before the push, unconditionally. Left
True after a failed push, the next sync reads the tombstone as "gone from Plex
last time, present now" and *reactivates* the entry — undoing the removal
instead of retrying it. Watchlist-only titles have no `PlexMapping` and so no
guid to push with, which made the failure the common path, not the edge.

**"Absent from Plex" is only meaningful if the whole watchlist arrived.**
`get_watchlist` returns a `WatchlistFetch` carrying `complete`, and the pass
that mirrors removals is skipped entirely unless every page came back. It used
to return whatever pages it had managed to fetch, so a 500 on page two silently
tombstoned every entry after it. Anything else that mirrors deletions from a
remote list needs the same "did I see all of it?" guard.

### `WatchEvent.dedupe_key` makes history import idempotent

`plex:<machine_id>:<historyKey>` for imports, `manual:<uuid>` for manual logs,
`webhook:<machine_id>:<ratingKey>:<minute>` for webhooks. Without it, every
re-sync duplicates the entire watch history. It is uniquely constrained per user.

Webhooks carry no history key, hence the minute bucket — Plex will not scrobble
the same item twice inside one minute.

**The two key shapes can never match, so the history import has to reconcile
them.** A webhook and the periodic import describe the *same play* with
different keys, and `record_watch_state` increments `view_count` — so on a Plex
Pass instance every scrobble was counted twice and listed twice. The import
looks for a recent `PLEX_WEBHOOK` event for the same item within two minutes and
adopts it rather than inserting a second row. A duplicated event is not free;
only a *missed* one is.

### Plex tokens are per user, not per server

Ratings, watch state and history are **per-user** in Plex and only visible
through that user's own token. Reading everything through the server owner's
token would show every Tally account the owner's ratings.

`UserServerAccess` holds one token per (user, server) plus `plex_account_id`.
`PlexServer.access_token_encrypted` is the owner's, used only for library scans.

### Anime lives on the show; children inherit

Seasons and episodes copy `is_anime` / `anime_source` from their show. Anything
that reclassifies must cascade to children — see `_reclassify_library` and the
admin reclassify job.

### A token must never be stored in an artwork URL

`MediaItem` rows are **global** — one row serves every Tally account. Anything
written into `poster_url` / `backdrop_url` is handed to every user and ends up in
their browser history, so a URL carrying `X-Plex-Token` leaks that token across
accounts. `poster_url` is for **credential-free external URLs only** (TMDB and
friends). Everything from Plex is stored as a bare path and fetched per viewer by
`routers/images.py`:

| Source | Where the path lives | Token used |
|---|---|---|
| Plex Media Server | `PlexMapping.thumb_path` / `art_path` | that viewer's server token |
| Plex Discover | `MediaItem.discover_thumb_path` / `discover_art_path` | that viewer's plex.tv token |

Build payload URLs through `serializers.poster_for()` / `backdrop_for()` rather
than reading `item.poster_url` directly. They always return a URL, because
whether artwork exists is not knowable without a query per card — the proxy
answers 404 and the frontend `Artwork` component reveals the placeholder
underneath. That is why the placeholder is a *layer* and not an else-branch.

`PlexServerClient` therefore has `image_bytes()`, not an `image_url()`. Do not
reintroduce one.

The rule is about URLs **stored and handed to a browser**. A server-side request
from Tally to Plex may carry the token in its query, and `/photo/:/transcode`
requires it there: the transcoder resolves its `url=` parameter with a fetch of
its own, which does not inherit the outer request's headers. Header-only auth
gets the transcode refused.

Artwork also passes `record_failures=False` to `_request`. It is high-volume and
best-effort — dozens of requests per page — and must not be able to trip the
unreachable-server backoff and take the sync down with it. It still *honours* an
existing backoff, so a server that is genuinely down fails fast.

### `progress_current` and `progress_total` must be the same unit

A `SyncRun` has exactly one counter pair, shared by every phase. Whoever sets the
phase owns both numbers, and a step that later reports its own count must set its
own denominator with it — `_progress(n, total=…)`. Setting only the numerator
leaves the previous phase's total in place, which is how the library scan came to
report **"45233 of 2"**: the phase counted libraries, the scan counted items.

Anything that belongs to the phase rather than to the counter — which library of
how many — goes in the phase *text*.

`total=0` means "unknown" and renders as an indeterminate bar; that is why
`_progress` takes `total: int | None` and treats `None` (leave alone) as
different from `0` (clear it).

### The browse filters live in one place, on both sides

The media grid and the watchlist browse the same rows with the same controls.
The query building is shared in `media_filters.py` (`MediaFilters` is a FastAPI
dependency, so declaring it gives an endpoint the whole parameter set), and the
UI in `components/BrowseFilters.tsx`. Add a filter to those and both pages get
it; add it to one router and the pages silently disagree.

One filter is off by default: `personal="exclude"` keeps home videos out, the
same judgement `default_types` already makes about seasons and episodes. It is
a *parameter* rather than a hard-coded clause on purpose — a misclassified film
has to be recoverable without touching the database — and `Browse.tsx` sends
`all` for search and the all-titles grid, which promise everything and are
where a wrong guess is found. A row is never deleted for this; the watch event
is real history.

Each page still owns its own `sort`/`order`, because the valid sorts and the
sensible default differ — the watchlist has `watchlist_added` (when *you*
watchlisted it, `WatchlistEntry.added_at`) and opens on it, which is a different
date from `added` (when it reached your library, `MediaItem.created_at`). Keep
them distinct; collapsing them loses the only ordering that page actually wants.

`media_filters.py` must **not** get `from __future__ import annotations` —
FastAPI resolves `MediaFilters.__init__`'s annotations at import time to build
the query parameters, and stringised annotations leave it with unresolvable
forward references at request time.

### A button must react before the round trip, not after it

`POST /api/sync` creates the `SyncRun` row **in the request**, then hands the id
to the background task, which adopts it. Created inside the task instead, the
UI's follow-up refetch raced it, saw nothing running, fell back to the 30-second
poll, and the progress bar stayed hidden until the user reloaded — the button
looked broken. Anything else that kicks off background work should make its
state true before responding, the same way.

That is the server half of a standing rule: **every button shows a visible
reaction on click**. On the client that means a pending state (spinner, disabled,
changed label) or an optimistic update — never waiting on a poll. `SyncProgress`
takes an optional status precisely so the "clicked, nothing back yet" state can
render an indeterminate bar.

Because the row now exists up front, the endpoint also has to refuse a second
concurrent run, or a double click is two visible syncs over one library.

### Global rows need owner-level authority to write

`PlexServer` is one row shared by every account that can reach that server, and
`client_for` prefers its `manual_url` for **all** of them. So merely *having
access* is not authority to rewrite it: a shared-library user could point the
server at a host they control and collect each viewer's own token — which the
artwork transcode puts in the query string. Writing a global row takes
`owner_user_id == user.id or is_admin`; per-user preferences belong on
`UserServerAccess`.

### Anything anonymous must fail closed, on identity and on scope

Two endpoints take no credentials by necessity, and both used to guess:

* The **Plex PIN poll** matched an unlinked Plex identity to a local account by
  *username*. Plex usernames are freely changeable, so anyone could rename to
  the operator's and be handed their session. Attaching a Plex identity to an
  existing account now requires proof — `PlexPin.link_user_id`, recorded when
  the flow starts from an authenticated relink. Nothing else may link.
* The **webhook** matched `User.username` and fell back to "the first enabled
  server" for an unknown uuid. Both fallbacks are gone: it matches
  `plex_username` and a known `machine_identifier`, or it ignores the event.

The same rule applies inside sync. When `_resolve_account_id` cannot identify
the user, history import and session polling **skip** rather than dropping the
`accountID` filter — dropping it asks Plex for the whole server's history and
files every household member's plays under one account.

### API keys are hashed, not encrypted — and with SHA-256, not bcrypt

Plex tokens are Fernet-*encrypted* because Tally has to replay them to Plex. An
API key is only ever compared, so it is *hashed*: a leaked database yields no
working keys, and the plaintext exists solely in the copy the user saved.

SHA-256 rather than bcrypt is deliberate and the opposite of the password rule.
bcrypt is slow by design to make guessing a low-entropy human secret expensive;
an API key is 256 random bits, so there is nothing to guess, and bcrypt's cost
would be paid on every single API request for no security. Compare with
`hmac.compare_digest`, never `==`.

`ApiKey.prefix` is stored in the clear so a key can be found without scanning
every row. It is a *lookup hint only* — matching it is never authentication.

### The SPA catch-all must contain the path it is handed

`main.static_file_for()` resolves the candidate and refuses anything not
`is_relative_to(FRONTEND_ROOT)`. FastAPI hands the route an **already
percent-decoded** path and Starlette does not collapse `..`, so `%2e%2e%2f`
arrives as a real `../`. Without the check the route served any file the
process could read, unauthenticated — including `/data/.secret_key`, which
decrypts every stored Plex token.

The check lives at module level, not inline in the route, because the route
only exists when a built `static/index.html` does. A test through the HTTP
layer passes in a dev checkout without exercising anything.

### Never log a URL that can carry a secret

`httpx` logs full request URLs — query string included — at INFO, and two
things put secrets there on purpose: TMDB takes `?api_key=`, and the Plex
artwork transcode *requires* `X-Plex-Token` in the query. `main.py` therefore
pins the `httpx` logger to WARNING unless `LOG_LEVEL=DEBUG`. Users paste
`docker logs` into issues.

### Connections to Plex are pooled process-wide

`plex_server._pool()` returns one shared `httpx.AsyncClient` for the whole
process. A client per call is a connection per call is a DNS lookup per call,
and a history import makes hundreds of calls in seconds — enough to trip a
rate-limiting resolver (Pi-hole's default is 1000 queries/minute shared by every
container behind one bridge address). This is not hypothetical: a live instance
had its Plex server *and* plex.tv both stop resolving mid-sync, seconds apart,
right after a burst of ~700 metadata lookups.

Never build an `AsyncClient` per request in this module — or in `plex_tv.py`,
which pools the same way for the same reason: the incident took out plex.tv
resolution too, not just the media server. Tests get isolation from the autouse
`_isolate_plex_connection_pool` fixture, which closes **both** pools.

### Tokens are encrypted at rest

Plex auth tokens grant full account access, so they are Fernet-encrypted with a
key derived from `SECRET_KEY`. Rotating `SECRET_KEY` invalidates them by design;
`decrypt_secret` returns `None` rather than raising so the UI can prompt a
re-link. Never log a decrypted token.

---

## Plex API notes (mostly undocumented)

* **`X-Plex-Client-Identifier` must be stable across restarts.** Plex ties auth
  PINs and device entries to it. Persisted to `/data/.plex_client_id`; a
  regenerating id breaks sign-in in confusing ways.
* **OAuth PIN flow:** `POST /api/v2/pins?strong=true` → open
  `https://app.plex.tv/auth#?clientID=…&code=…&forwardUrl=…` → poll
  `GET /api/v2/pins/{id}` until `authToken` appears. The frontend polls; the
  callback page only closes the popup.
* **Server-side `accountID` ≠ plex.tv user id** for home/managed users. History
  endpoints filter on the server-side one. `1` is always the owner. Resolved via
  `/accounts` in `_resolve_account_id`.
* **Connection order matters.** plex.tv advertises several URIs per server; rank
  local HTTPS first, then remote direct, then **relay last** (bandwidth-capped).
  `PlexServerClient` caches the first URI that answers in `working_url`.
* **Incremental history** uses the `viewedAt>` query filter. Tally overlaps by a
  day because Plex can backdate entries when a client syncs late.
* **Writes are GETs** with `identifier=com.plexapp.plugins.library`:
  `/:/scrobble`, `/:/unscrobble`, `/:/rate?rating=0-10`, `/:/progress`.
  Ratings are 0–10; the Plex UI renders 5 stars. There is no "unrate" — send 0.
* **`/:/prefs` is owner-only.** Server settings come back as `Setting` elements
  keyed by `id`; a non-owner token gets a 403 with an HTML body, which
  `_get_json` quietly turns into `{}`. So "empty" means "not allowed to ask" as
  much as "nothing set" — treat a missing value as unknown, never as zero.
  `onDeckWindow` (weeks, default 16) is the Continue Watching cut-off; Plex reads
  0 as "switch On Deck off", Tally reads it as "no cut-off", because an empty
  shelf reads as a broken page. See `services/on_deck.py`.
* **Discover / watchlist is reverse-engineered.** `discover.provider.plex.tv`
  for `/library/sections/watchlist/all`, `/actions/addToWatchlist`,
  `/actions/removeFromWatchlist` (they want the bare ratingKey from a `plex://`
  guid). Stable in practice, widely used by self-hosted tooling, but **this is
  the piece most likely to break** if Plex changes something.
* **GUID shapes** vary by agent — see the module docstring in `guids.py`. The
  HAMA and AniDB forms are themselves an anime signal, because only anime
  libraries use those agents.
* **Webhooks need Plex Pass** and are strictly an optimisation; the periodic
  sync picks up everything they deliver. The endpoint is necessarily
  unauthenticated (Plex cannot send credentials), so it only ever matches
  already-linked accounts and known servers, and never creates users. It must
  never return 5xx — Plex retries and eventually disables the webhook.

---

## Anime classification

Multi-signal and **scored**, threshold 5 — see the table in
`services/metadata/anime.py`. The point of the scoring is that a single weak
signal must not decide.

The case it exists to get right: **animated + American + English is not anime**.
Any change must keep `test_western_animation_is_not_anime` and
`test_live_action_japanese_film_is_not_anime` passing.

`should_try_mal()` is a cost filter, not a classifier — MAL has nothing to say
about a Western film, and Jikan's rate limit is low. Do not call MAL for every
item during a library scan.

User overrides (`PlexLibrary.anime_override`, tri-state) always win.

---

## Frontend conventions

* **Never a raw hex in a component.** Colours are semantic Tailwind tokens
  (`bg-surface`, `text-muted`, `border-line`) mapping to CSS variables in
  `index.css`. Light is the base definition; `.dark` redefines only what changes.
* **Charts are hand-built SVG/CSS on purpose.** They hold fixed specs a charting
  library fights: ≤24px marks, 4px rounded data-ends square at the baseline, 2px
  surface gaps, hairline recessive gridlines, direct value labels, no legend for
  a single series.
* **The chart palette was validated, not chosen by eye** — colour-vision
  separation and contrast against both surfaces. If you change series colours,
  re-run the validator in the `dataviz` skill rather than eyeballing. Every chart
  also ships a `DataTable` fallback so nothing is gated behind colour or hover.
* **Never key or parse a local date through `toISOString()` / `new Date('YYYY-MM-DD')`.**
  Both convert via UTC, so they are off by one day (east of Greenwich) or one
  month (west) — which is exactly how the heatmap and the monthly axis were
  wrong for everyone outside UTC. Use `localDateKey()` and
  `parseLocalDateLabel()` in `lib/utils.ts`.
* **A failed request is not an empty list.** Check `isError` *before* the empty
  branch and render `ErrorState`; falling through told the user their library
  was empty and to run a sync, while hiding a 500.
* **`navigator.clipboard` does not exist over plain HTTP**, which is how
  self-hosted Tally is normally reached. Use `copyText()` and only claim success
  when it resolves — the API-key toast lied, and that key is unrecoverable.
* **Opacity is not a hit-test.** A control faded out with `opacity-0` is still
  tappable; pair it with `pointer-events-none`, and do not hide anything behind
  hover alone on touch.
* Dark mode is applied pre-paint by an inline script in `index.html` to avoid a
  light flash; `ThemeProvider` owns it afterwards.
* Status is never colour-alone — a dot always sits beside a written label.
* **Absolutely-positioned children need an explicit `left`/`right`.** The toggle
  knob rendered outside its track because `left` was `auto` and the static
  position was not where it looked like it should be.

---

## Testing and verification

```bash
cd backend && .venv/bin/python -m pytest -q
cd backend && .venv/bin/ruff check app tests
cd frontend && npx tsc --noEmit && npm run build
```

`tests/conftest.py` **must set env vars before importing anything from `app`** —
`get_settings()` is `lru_cache`d and reads `DATA_DIR` at import time. Hence the
`# noqa: E402` imports; do not "tidy" them to the top.

The test engine sets `PRAGMA foreign_keys=ON`, matching production. SQLite
leaves them off by default, and without it a missing existence check *passes* in
CI — writing a row that references nothing — then 500s in the real app. That is
precisely how `set_favorite` and `set_notes` kept their bug.

Each test gets a private file-backed SQLite database. In-memory would give every
connection its own empty schema.

### Verify by looking, not by assuming

Three real bugs were found only by rendering the UI and running the container,
none by tests:

* naive-vs-aware datetime crash — found by running the container
* Continue Watching listing a show twice — found by reading a screenshot
* toggle knob outside its track — found by reading a screenshot, then measuring
  the element's bounding box in the browser

So: **screenshot the pages after UI changes, and run the container after
Dockerfile changes.** Building is not running.

---

## Releasing

Version lives in `backend/app/__init__.py` and feeds the API and `/api/health`.
**Bump it to match the tag** — nothing enforces this.

Only `v*` tags publish. Pushing `main` does not build, deliberately: listening on
both a branch and its tag double-runs. Use `workflow_dispatch` to rebuild without
a new version.

```bash
# edit backend/app/__init__.py, commit, then:
git tag -a v0.1.0 -m "Tally v0.1.0

- notes become the GitHub Release body"
git push --follow-tags
```

The annotated tag's message becomes the Release body — write real notes there.

`ci.yml` (branches/PRs, never pushes an image) and `docker.yml` (tags only,
publishes) do not overlap. Keep it that way.

**GHCR paths must be lowercase** and this repo is `Spillebulle/Tally`.
`metadata-action` lowercases its own `images:` input, but anything interpolating
`github.repository` raw needs `${GITHUB_REPOSITORY,,}`.

The **frontend stage is pinned to `$BUILDPLATFORM`** — its output is static and
architecture-free, so building it under QEMU per target is pure waste and invites
npm optional-dependency (esbuild, rollup) problems on the emulated arch. The
Python stage stays on the target platform; those wheels carry native extensions.

Docker Hub needs `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` repo secrets. GHCR uses
the built-in `GITHUB_TOKEN`.

---

## Deliberate choices, so they are not "fixed" later

* **No Alembic.** `db.py` has a small idempotent `_run_light_migrations()` list
  for additive columns. A single-file SQLite database the user owns does not
  justify the dependency. If a destructive migration ever becomes necessary,
  revisit — but additive columns go in that list.
  Three steps are not additive: `_scrub_token_bearing_artwork()`, which clears
  the old token-carrying `poster_url` values so the proxy can take over;
  `_recover_release_name_titles()`, which replaces a filename Plex stored as a
  title and clears `metadata_updated_at` so the backfill re-asks under the real
  name instead of waiting out its weekly window; and `merge_duplicates.py`,
  which collapses items recorded twice. All three are idempotent, all three log
  what they did, and none may assume it runs exactly once. Anything else that
  has to *change* data needs the same treatment — a named function and a reason.

  Each exists because the import-path fix cannot reach what the import already
  produced: the history sync reads incrementally and never revisits a 2019 play,
  so nothing would run `upsert_from_plex` over those rows again.

  The merge deletes rows unattended, so it is deliberately timid: it needs a
  **matching external id and a matching normalised title**. The id alone is not
  proof — real data had two "Seven" (1995) rows carrying tmdb 807 and 966, so a
  wrong id can be attached, and fusing two unrelated films would take one's
  history with it. A missed merge leaves a visible duplicate; a wrong merge
  loses data silently. Prefer the visible mistake.

  The title check **partitions** the group, it does not veto it. A wrong id does
  not only invent a pair — it joins one, and vetoing then held the sound pair
  open too: two "Thelma & Louise" rows could not merge because a row titled
  "Thelma" had been enriched onto the same tmdb id, and two "Pokémon" rows
  because *Plex's own agent* gave a spin-off the parent series' id. Five live
  duplicates were stuck that way. Partitioning is no less careful — two rows
  still merge only on an exact normalised-title match — it just leaves the odd
  one out instead of letting it block the others.
* **`create_all()` at startup**, not a migration step.
* **bcrypt pinned to 4.0.1** — passlib 1.7.4 reads `bcrypt.__about__`, which
  bcrypt ≥ 4.1 removed. Unpinning brings back a traceback on every hash.
* **Library scans commit per page** so a long scan shows progress and a mid-scan
  failure does not discard everything.
* **Enrichment is skipped for episodes.** Only movies and shows get external
  metadata; enriching every episode would multiply API calls for little gain.
* **The scheduler runs in-process** via APScheduler with `max_instances=1`. A
  slow first sync must not queue overlapping runs. It also checks for an
  unfinished `SyncRun` per user first — `max_instances=1` only serialises the
  scheduler against itself, not against someone pressing Sync.
* **Interrupted `SyncRun` rows are closed at startup** (`db._close_interrupted_sync_runs`).
  A hard kill never reaches `full_sync`'s `finally`, and an open row is exactly
  what `trigger_sync` reads as "already running" — so without this the sync
  button stays dead forever, with no UI path to recover.
* **External providers get a circuit breaker**, like Plex does. Five consecutive
  transport failures pause that provider for five minutes; otherwise an outage
  costs the full retry budget on every item and a large scan never finishes.

---

## Environment quirks (Claude Code web sandbox)

These are about *this* sandbox, not about Tally. They are recorded because each
one cost time.

* **Pushing to GitHub is currently blocked.** `git push` and the GitHub API both
  return 403 — the GitHub App has read-only contents on this repo. Reads work.
  Do not burn turns retrying; report it and ask for write access to be granted at
  `https://claude.ai/admin-settings/claude-in-slack`.
* **Docker daemon is not running by default:** `(dockerd > /tmp/dockerd.log 2>&1 &)`
  then poll `docker info`.
* **Docker builds fail TLS verification** because the sandbox proxy MITMs HTTPS.
  Build with a *temporary* copy of the Dockerfile that trusts
  `/root/.ccr/ca-bundle.crt` (`PIP_CERT`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`,
  `NODE_EXTRA_CA_CERTS`). **Never commit that variant** — delete
  `Dockerfile.sandbox` and the copied `.crt` afterwards.
* **`binfmt_misc` is not mounted** in this microVM, so arm64 emulation fails with
  `exec format error` even after running `tonistiigi/binfmt`. Fix:
  `mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc` **first**, then
  install the handler, then build with `--platform linux/arm64`.
  The `docker-container` buildx driver does not inherit the proxy CA — the
  default `docker` driver does, and handles one platform at a time, which is
  enough to verify.
* **Playwright:** the installed package expects a browser build the image does
  not have. Launch with an explicit
  `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'` and
  `args: ['--no-sandbox']`. Scripts must live in `frontend/` to resolve the
  module. Do not run `playwright install`. Remove the package and any scratch
  scripts before committing.
* Put the demo database, seed script and screenshots in the session scratchpad
  directory, never in the repo.

### Previewing the UI with realistic data

There is no Plex server here, so the UI looks empty until seeded. The fastest
loop: write a seed script that inserts users, media, watch events and states
directly, point `DATA_DIR` at a scratch directory, build the frontend into
`backend/app/static`, run uvicorn, then drive it with Playwright.

Posters will render as deterministic placeholder gradients — that is
`posterFallbackGradient`, not a bug. Screenshots taken this way are fine for
spotting layout and logic problems, but they **misrepresent the product** and
should not be committed as documentation; real artwork needs a TMDB key or a
Plex server.
