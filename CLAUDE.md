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
├── media_filters.py   browse filters + sorting, shared by grid, watchlist and History
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
├── components/        Poster/Artwork, BrowseFilters, Pagination, Charts, Layout, Icons, ui
└── lib/               api client, types, contexts, utils, browse-filters (the filter table)
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
from Plex is history that should outlive the file, and on a live instance 62 of
the 96 mapping-less rows are exactly that, holding 271 real plays. Dropping the
category to clear the two rows that are genuinely unidentifiable would be a
terrible trade; do not.

**Ask Plex what it thinks before guessing.** Two things were missing here for
longer than they should have been, and both are the same mistake — reaching for
a heuristic while Plex's own answer sat unused:

* **`iter_history` did not send `includeGuids=1`.** Every other call does. The
  thinnest payload Plex sends was the only one not asked to name itself, which
  is exactly backwards.
* **`PlexMapping.plex_guid` was written and never read.** `plex://movie/5d77…`
  is Plex's identity for the item, the library scan records it, the column is
  indexed — and `_existing_match` went straight to tmdb/tvdb/imdb and then to
  title+year. It now resolves `plex_guid` against `PlexMapping` **first**, so a
  payload that names nothing else still names its row exactly, with no title
  comparison and no year heuristic anywhere near the decision.

`ExternalIds.identifying` still excludes `plex_guid`, and that stays right: it
answers *may this payload mint an identity*, and a per-server key must never
become a `guid_key`. Recognising a row already held is the opposite question,
and the same value answers it well. Keep the two apart.

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
recovered filename that misspells the film by one character is now refused —
`Mars.Needs.Mom` against *Mars Needs Moms* is the standing example, and such a
row gets no id and a blank tile where the looser rule would have found tmdb
50321. Accepted anyway, the same looseness admits "Alien" against "Aliens" and
"The Jungle Book 2" against "The Jungle Book 3" — the identical silent error,
on films the library really holds. A missing poster is visible; a wrong id is
not. Refusals log at **INFO** for exactly this reason: `docker logs tally |
grep -i refus` is the only thing that explains a blank tile.

The cost lands on **future** imports, not on rows already enriched. Item 52633
on the live instance kept tmdb 50321 and its artwork, because the id was
attached before this rule shipped and `backfill_missing_metadata` only ever
selects rows with *no* id — nothing re-searches a row to take an id away. It
stays a visible duplicate of the properly matched row next to it, since the
titles still disagree by a letter, which is the trade working rather than
failing.

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

### A day belongs to the viewer, not to the database

Storage is UTC and stays UTC. But *which day a play happened on* is a question
about the person watching, and it has no answer until you know their zone. Get
that wrong and the error is invisible: every number is plausible, just filed
under the wrong date.

It was wrong in both directions at once. `stats.py` compared `date.today()` —
the **container's** local date — against `watched_at.date()`, which is **UTC**;
the two agree only when the container runs `TZ=UTC`, and drift by a day
otherwise. Meanwhile the frontend already parsed `activity_by_day` labels as
*local* days via `parseLocalDateLabel`, so the two halves of the app disagreed
about what a label meant. A 23:30 play in Oslo landed on tomorrow.

The rule now:

* **The zone is resolved, never assumed** — `?tz=` → `User.preferences["timezone"]`
  → UTC, through `timezones.resolve()`. The response reports the zone it
  actually used, so a fallback is visible rather than silent.
* **Filter in UTC, bucket in local.** Range bounds are built as local midnight
  and converted to UTC, so `WHERE watched_at >= :since` still uses
  `ix_watch_events_user_time`. Day, month, weekday, hour and streak buckets are
  assigned in Python from `watched_at.astimezone(tz)`.
* **Never bucket with a fixed offset in SQL.** `strftime('%H', watched_at,
  '+120 minutes')` is wrong for half the year, and SQLite cannot do IANA
  conversion at all. Python is also cheap here — the endpoint already walks
  every row in the window.
* **A zone name is untrusted input.** `ZoneInfo` resolves keys against the
  filesystem, so `timezones.resolve()` length- and shape-checks the name before
  `ZoneInfo` ever sees it. Setting the preference rejects an unloadable zone
  with a 422 rather than storing something that quietly means UTC.
* **`tzdata` is a real dependency, not belt-and-braces.** `zoneinfo` reads the
  *system* tz database and `python:3.12-slim` need not carry one; without the
  package every zone silently becomes UTC, which is indistinguishable from the
  user simply not having set one.

Half-open windows, `[since, until)`, so two adjacent ranges cannot both claim
the same play.

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

The media grid, the watchlist and History browse the same rows with the same
controls. The query building is shared in `media_filters.py` (`MediaFilters` is
a FastAPI dependency, so declaring it gives an endpoint the whole parameter
set); on the frontend it is split in three, and the split is the point:

* `lib/browse-filters.ts` — the **filter table**. One entry per filter, and
  everything else is *derived* from it: the values read out of the URL, the
  request payload, whether "Clear all" appears, what `clear()` removes, the
  chips, the disclosure's count badge, which group a control lands in. "Is any
  filter active" used to be a hand-written chain of ORs deciding both whether
  the user is offered a way to widen the view *and* whether an empty grid says
  "nothing matched" or "nothing here yet, run a sync" — so forgetting one
  filter produced a narrowed grid, no way to widen it, and a message insisting
  the library was empty. Derived state cannot fall out of step. **Adding a
  filter is one entry**; if you are editing four places, re-read the table.
* `components/BrowseFilters.tsx` — how a `control.kind` looks, and nothing
  about what a filter means. There are too many filters to sit flat, so five
  stay on the bar (status, genre, sort, order, search) and the rest live behind
  a "Filters" disclosure grouped by *Title* / *You* / *Library*. The panel
  pushes content down rather than floating — there is no popover primitive
  here — and opens by itself when the URL arrives with one of its filters set,
  or a shared link is a narrowed grid with nothing saying why.
* `components/Pagination.tsx` — `usePageParam` and the stepper, which History
  uses without any of the above.

Chips are the **reverse** of what they were: every active filter appears in the
chip row with its own ×, including ones a visible control also shows. Chips used
to be suppressed in exactly that case, on the sound argument that it says the
same thing twice — but once a control lives behind a disclosure the chip is the
only visible statement of what is narrowing the grid, and a chip row that lists
some filters and not others cannot be read as "this is the filter". If you
re-suppress them, hide the disclosure too.

A page declares what it does not have. `FilterPage.omit` makes a filter
*absent*, not hidden: its parameters are never read, written or sent, so a stale
one cannot narrow a page offering no way to see it. History omits `status`,
because everything there has a play: "unwatched" returns nothing and a status
returns nearly everything.

Add a filter to the table and to `MediaFilters` and every page gets it; add it
to one router and the pages silently disagree.

One filter is off by default: `personal="exclude"` keeps home videos out, the
same judgement `default_types` already makes about seasons and episodes. It is
a *parameter* rather than a hard-coded clause on purpose — a misclassified film
has to be recoverable without touching the database — and `Browse.tsx` sends
`all` for search and the all-titles grid, which promise everything and are
where a wrong guess is found. A row is never deleted for this; the watch event
is real history.

**History declares the same dependency, and needs two overrides to do it.**
`default_types=False`, because episodes are most of a watch log and the shared
default keeps the flat grids to movies and shows; and `personal="all"`, set on
the parsed object unconditionally, because a log of plays that really happened
must not be able to hide them. `since`/`until` stay on that router and are *not*
the shared `watched_after`/`watched_before`: the first pair reads
`WatchEvent.watched_at` — when this play happened — and the second reads
`UserMediaState.last_watched_at`, the rollup of when you last touched the title
at all. Two tables, two questions; never merge them.

**A facet an episode does not carry is read from its show.** Genre, studio,
content rating, network and release status are only ever populated for MOVIE and
SHOW — enrichment is skipped for episodes by design — so a facet filter over
episodes matched *nothing*, silently, because an empty page looks like an honest
answer. `facet_source()` is the one rule, a correlated EXISTS on
`MediaItem.show_id` so it needs no join and cannot double a row. `year` is
deliberately *not* resolved that way: an episode has its own, and reading it
through the series would file a 2019 episode under 1989.

Two conditions have to be registered as well as written. Anything reading
`user_media_states` must appear in `needs_state_join()`, or the query names a
table it never joined; and the join is scoped to one `user_id`, which is the
only reason `has_notes` cannot show you a housemate's annotations.

**A facet that takes several values takes them as repeated keys.**
`?genre=Crime&genre=Drama`, with `?genre_not=` for exclusion and
`?genre_mode=all` for AND — omitted means "any", so the default never lands in
the URL. Repeated keys are backwards compatible *by construction*: a single
occurrence parses exactly as the single value always did, so every bookmark,
every `facetLink` on an item page and every stats drill keeps working
untouched. Not a comma-separated list (studio names contain commas — "Warner
Bros., Inc.") and not a `-Horror` prefix operator (values legitimately start
with one). `MULTI_FACETS` says how *one* value matches *one* row and everything
else is derived from it; the frontend's `multiFilter` is the same trick, and
`api.ts` must `append` per element rather than stringifying the array.

The AND toggle is offered for **genre alone**. A title has one studio, one
certificate and one network, so "all" over those is the empty set by
construction — a control that can only produce a wrong answer.

Three things about the SQL, each of which was a real trap:

* **Exclusion is `NOT EXISTS`, never `NOT (col = value)`.** SQL's `NOT` over a
  NULL comparison is NULL, and a row the WHERE cannot prove true is dropped —
  so `?studio_not=A24` would also hide every film with no studio recorded, the
  ones most obviously not made by A24. `facet_absent()` is the mirror of
  `facet_source()` and covers the item and its show in one subquery. The same
  trap over a relation is `EXISTS (… != x)`, which any title with a *second*
  director satisfies.
* **Relations stay correlated EXISTS.** `actor` mirrors `director`, and
  `library_id` / `server_id` go through `PlexMapping` the way `on_plex` does. A
  join fans a row out, `count_stmt` counts the copies, and the pager then offers
  pages that render empty.
* **`q_scope=all` searches your own notes, so the whole `q` clause moves into
  `state_conditions()`.** It is one OR across title, overview and notes, so it
  cannot be split across the two lists — and evaluated outside the
  `user_id`-scoped join it would count a housemate's private notes into your
  result total. The default stays `title`: an ordinary search that starts
  matching plot words answers "murder" with half the library.

`/api/media/places` lists the servers and libraries the two "where does it
live" filters may name, scoped through `UserServerAccess` exactly as
`servers_for` scopes the sync — a picker over every row in `plex_servers` would
disclose the names of servers this account has no relationship with. It is
declared **above** `/api/media/{item_id}`, like `/genres`, or FastAPI parses
"places" as an item id.

Each page still owns its own `sort`/`order`, because the valid sorts and the
sensible default differ — the watchlist has `watchlist_added` (when *you*
watchlisted it, `WatchlistEntry.added_at`) and opens on it, which is a different
date from `added` (when it reached your library, `MediaItem.created_at`). Keep
them distinct; collapsing them loses the only ordering that page actually wants.

**The whole browse query lives in the URL** — filters, sort, order and the page
number — because that is the only place a navigation cannot lose it. The page
number was component state once, so returning from a title landed on page one
of an unfiltered grid. `useBrowseFilters` owns all of it; `usePageParam` and
`Pagination` are shared by the grids, the watchlist *and* History, so `?page=`
means one thing everywhere (1-based as written, 0-based as used).

Three rules keep it honest, and each was a bug first:

* **Paging pushes, filtering replaces.** Stepping back from page three to page
  two is what Back is for; one history entry per filter chip — or per
  keystroke — buries whatever the user actually wants to go back to.
* **A default never survives into the URL.** Picking the sort a page already
  opens on says nothing, and a link spelling out every default reads as noise.
  Changing a filter also drops `page`: narrowing renumbers the results, so
  "page 4" of the old filter is not a place that still exists.
* **A URL is untrusted input.** `sort`, `order`, `status`, `kind` and
  `media_type` are all `Literal`s on the API, so one stale or mistyped word is
  a 422 and an error card where the grid should be; the rating bounds are
  `ge=0, le=10` with the same result. Everything read from the query string is
  checked against what the API accepts and falls back to the page default. A
  page number past the end is clamped once the real total arrives — never
  before it, or the first render would throw the page away a moment ahead of
  its own results.

**A saved view is that URL, stored.** `SavedView` holds a name and the raw
query string, per user and per page, and nothing on the server parses it — the
whole feature is `savedQuery` (canonicalise the current query) and `applyView`
(hand a stored one back through the same `normalise`). That is why a view saved
before a filter was renamed degrades to the page defaults instead of erroring:
the `read` that guards a hand-edited URL is the only thing that ever interprets
one. A parser on the server would be a second validator that can disagree with
the first, which is the one failure this shape rules out.

Two consequences worth keeping:

* **Applying a view pushes; changing a filter replaces.** Same rule, opposite
  side: a saved view discards the entire current query in one deliberate act
  rather than narrowing it, so without a history entry the view the user was
  looking at is gone — the exact loss that moved `page` into the URL. Paging
  pushes for that reason and this is the same move, larger.
* **`page` is the filter *surface*, not the route.** All five Browse modes
  share one shelf of views because they share every filter and every sort; the
  watchlist and History have their own. `FilterPage.id` is required so a browse
  page added later cannot silently inherit another's.

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

**The interface follows `../Design-Principles/STYLE-GUIDE.md` and uses
`tokens.css`; the accent hue is 255. Never a raw hex in a component.** That one
line is the whole rule, and `docs/interface.md` is where Tally's own part of it
is settled: the Tailwind names, the painted controls that already exist, and the
traps. Read that before touching a component.

The shape of it, so the layout below is not a surprise:

```
src/tokens.css        the house ladder, a verbatim copy. Re-sync with cp; never edit here.
src/theme-tally.css   what Tally decides: --accent-h, the pinned accent, Plex yellow, heat ramp, the font.
tailwind.config.js    names for those tokens. No value of its own.
src/index.css         the painted controls, as component classes.
scripts/check-design.mjs   the rules tsc cannot see. `npm run check:design`.
```

Two things decide every size in the app, and both are stamped once:

* **Tally is at the web scale.** `<html class="web">` in `index.html`, which
  makes `tokens.css` swap one table of sizes for another (§6.5): 52px top bar,
  32px buttons and fields, 38px nav rows, 14px body, 18px icons, 280px sidebar.
  Nothing else changes - same colours, same hairlines, same shadows, same rules
  about the accent. **A component never reads the class**; it asks for
  `h-button`. A `.web .thing {}` rule is a token that is missing, and a
  `fontSize` or a `spacing` entry stating a *number* rather than a `var()`
  pins that one thing to the desktop table while everything round it grows.
  Mobile is not a third scale: a narrow viewport changes the shell, never a
  size.
* **Artwork is on a four-rung ladder** (§7.21): `w-art-tile` 120 beside text,
  `w-art-card` 180 for the browse card, `w-art-hero` 320 once on a detail page,
  `avatar` 36 for a face, shape from `aspect-art` / `aspect-wide`. The same
  kind of thing is one size across a page, so `.poster-grid` is the single
  definition of the card grid, and **which rung it uses is the reader's** -
  compact/standard/large are `--art-tile`/`--art-card`/`--art-hero`, three
  rungs rather than three numbers, remembered in `localStorage` and never in
  the URL because they change nothing about which rows you are looking at
  (`lib/card-size.tsx`). That control is on the browse toolbar through
  `BrowseFilters`' `actions` slot and **not** in the filter table: everything
  in that table is derived from, so a card size in there would put a chip
  reading "Large" in the filter row and claim the grid was narrowed. A picture that cannot have a rung **does not
  appear**: portrait art never goes in a text row, because a row with a picture
  is sized *by* the picture, which is why the History diary and the Stats
  leaderboards lost thumbnails that were three rungs under the ladder. The art
  card carries its label on the art and never in a caption strip, the label is
  visible by default and hidden only where a pointer can reveal it, and the
  placeholder names the item *underneath* the image so a library with no
  artwork is not a wall of anonymous gradients. `docs/interface.md` has the
  table.

Five more things are worth knowing before they cost an hour:

* **Tailwind fails silently.** `fontSize`, `borderRadius` and `boxShadow` are
  *replaced* rather than extended, so `text-sm`, `rounded-2xl` and `shadow-card`
  no longer exist — and an unknown utility generates **nothing** rather than an
  error, so a stale class does not break the build, it just stops styling the
  element. `check:design` greps for the retired names because nothing else can.
* **An opacity modifier on a token colour emits no CSS at all.**
  `bg-accent/25`, `border-critical/40`: the colour is a `var()` and Tailwind
  cannot compose alpha into it. Use a token that carries the alpha
  (`accent-tint`, `accent-ring`, `caution-bg`) or add one with `color-mix`.
  A `color-mix` over other variables resolves where it is *used*, so it only
  needs writing in the dark block and follows its inputs into the light theme.
* **Selection is a neutral `control` fill plus `text-strong` plus a small accent
  mark**, never an accent background. This is the rule the whole language rests
  on, and the one the old interface broke most.
* **A `1fr` grid track floors at its item's min-content, and `.panel` clips.**
  `truncate` only shrinks a *flex* item, so a nowrap string sets the whole
  column's minimum, the row grows past its track, and `overflow-hidden` eats
  the difference with no scrollbar to say so - the Continue watching row's
  mark-as-watched button was simply absent below about 420px. `min-w-0` on the
  grid item is the fix. Worth re-scanning for after any size change: anything
  wider than its nearest `overflow-x: hidden` ancestor is content nobody can
  reach.
* **There are three theme states, not two.** Dark is bare `:root`; forced light
  is `.light`; following the system is nothing stamped at all. A token written
  in only one of the two light blocks breaks the other state.

* **Charts are hand-built SVG/CSS on purpose.** They hold fixed specs a charting
  library fights: ≤24px marks, 2px rounded data-ends square at the baseline, 2px
  surface gaps, hairline gridlines and no vertical grid, no ticks, and no legend
  for a single series. The full statement is §8 of the guide.
* **A bar's frame is scaled to the data, not to a round number above it.**
  Rounding the ceiling up left a weekday peak of 104 in a frame scaled to 150,
  so a third of every chart was permanently empty. The maximum is the data's;
  the *gridlines* are the round numbers under it, chosen by scoring the
  candidate steps rather than taking the first that fits, because the obvious
  step family leaves two gridlines where five would fit.
* **Axis figures replace labels on the bars.** Both is two sets of the same
  numbers on one chart. The value stays in the tooltip, in the accessible name
  and in the `DataTable`, so nothing is lost by dropping the caps.
* **The chart palette was validated, not chosen by eye** — colour-vision
  separation and contrast against both surfaces. If you change series colours,
  re-run the validator in the `dataviz` skill rather than eyeballing. Every chart
  also ships a `DataTable` fallback so nothing is gated behind colour or hover.
* **A backdrop image joins the page over a long ramp** (§7.22): `.fade-backdrop`
  is transparent for its first 46% and reaches the ground only at the bottom
  edge, so at least the top 40% of the picture is untouched. The old ramp was
  solid by its bottom seventh, which paid the whole cost of loading a picture
  for almost none of the effect. Legibility is a separate job and a separate
  scrim under the text, never a steeper fade. The house token ramps to
  `--backdrop`; Tally's pages sit on `--window` (§6.2 - a page is a panel
  interior, the pit is for a canvas), so the stops are the house's and the
  colour is Tally's.
* **Text on artwork is `text-art` / `text-art-dim` on `bg-scrim-flat`**, and
  those are white and black in *both* themes. A picture supplies its own
  contrast, so a pale scrim over it erases the picture rather than the text.
  It is the one place the light theme does not lighten.
* **Zero is not the bottom of a ramp.** The heatmap's five steps are `heat-1..5`
  and a day with no plays is `control`, so "nothing happened" and "a little
  happened" cannot be read as the same thing.
* **Never key or parse a local date through `toISOString()` / `new Date('YYYY-MM-DD')`.**
  Both convert via UTC, so they are off by one day (east of Greenwich) or one
  month (west) — which is exactly how the heatmap and the monthly axis were
  wrong for everyone outside UTC. Use `localDateKey()` and
  `parseLocalDateLabel()` in `lib/utils.ts`. A **date filter** holds local days
  in the URL and converts once, on the way to the request: start bound is local
  midnight, end bound local **end of day**, so "14–20 Aug" contains every play
  on the 20th. `toISOString()` on a Date *built* locally is the right call
  there — it is deriving a day key from one that is banned.
* **A failed request is not an empty list.** Check `isError` *before* the empty
  branch and render `ErrorState`; falling through told the user their library
  was empty and to run a sync, while hiding a 500.
* **`navigator.clipboard` does not exist over plain HTTP**, which is how
  self-hosted Tally is normally reached. Use `copyText()` and only claim success
  when it resolves — the API-key toast lied, and that key is unrecoverable.
* **Opacity is not a hit-test.** A control faded out with `opacity-0` is still
  tappable; pair it with `pointer-events-none`, and do not hide anything behind
  hover alone on touch.
* The theme is applied pre-paint by an inline script in `index.html` to avoid a
  light flash; `ThemeProvider` owns it afterwards and the two have to agree,
  including that "system" stamps nothing.
* Status is never colour-alone — a dot always sits beside a written label.
* **Absolutely-positioned children need an explicit `left`/`right`.** The toggle
  knob rendered outside its track because `left` was `auto` and the static
  position was not where it looked like it should be.

---

## Themes are a file format, not a feature

A theme is a `.umbertheme` file, and the whole point of it is that the same file
opens in Umber and in anything else in the family. The format is §3.2 of the
style guide, Tally's own decisions are in `docs/themes.md`, and the rules below
are the ones that will be broken by accident.

* **Twenty-seven colours are stored; everything else is derived.** That is what
  makes a file portable, so a token that could be derived must not become a
  twenty-eighth key. Four file keys deliberately do not match the CSS names,
  because a stored word may never be reworded: `border`, `popover_border`,
  `warning*` and `link_1..6`.
* **Never send a variable that is a `color-mix` of other variables.** A CSS
  variable defined as a mix resolves where it is *used*, so `--accent-tint`,
  `--accent-ring`, `--grid`, `--heat-1..5`, `--scrim` and `--critical-line` all
  follow a custom theme on their own. Only five derived values are transmitted,
  and the client refuses any variable outside that set — a sent copy of a
  computed value is a stale copy, and the stylesheet already has it right.
* **A custom theme stamps its base's class.** `tokens.css` carries values that
  are not among the twenty-seven and differ by theme, the shadows most
  obviously, so applying colours without stamping `dark`/`light` gives a light
  theme the dark theme's shadows. Which bases are dark is the **server's** fact,
  sent as `dark` on the payload; a table of it in the client is a second thing
  to keep in step.
* **The server owns parsing, encoding and derivation**, because it owns the
  files. One decoder and one encoder, and the interchange format *is* the
  storage format, so a stored form and a shared form cannot drift.
* **Built-ins are compiled in and never written to the library.** The only way
  to make a theme is to copy one, which puts the copy where an update never
  reaches. A write to a built-in is a 409 with a sentence, not a silent no-op.
* **An unreadable line costs one colour and is counted.** The count is shown to
  the user, so only lines that name a setting and fail to deliver one are
  counted: blank lines, comments and lines without `=` are grammar and cost
  nothing. Reporting them would put "3 lines could not be read" in front of
  somebody whose file lost nothing.
* **Do not test the encoder with the decoder.** That proves only that they agree
  with each other. `test_a_written_file_satisfies_the_reader_rules` parses the
  bytes with an independent reader written from the guide, and that is the test
  the whole feature rests on.

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

`docs/shots/` is how you do the first one without a Plex server. It seeds a
deterministic library through the app's own models — 157 films, 45 series,
793 plays over eighteen months with weekday and evening weighting, a gap and
two binge days — serves the real build, and screenshots every page in both
themes with the console captured per page:

```sh
python docs/shots/shots.py --out <scratch>/shots
```

Posters render as the deterministic placeholder gradients, because there is no
Plex server and no TMDB key: that is `posterFallbackGradient`, not a bug, and
it is why these pictures are for **finding problems** and not for documentation.
The seeded Plex server points at a port that refuses instantly, because the
scheduler really does try to sync against whatever is seeded and a plausible
LAN address sits in a timeout instead.

It has already earned itself: the light theme's heatmap was drawing zero-play
days as solid black, because the ramp was renamed `--heat-0..4` to `--heat-1..5`
and a class naming a token that no longer exists generates nothing at all.
Nobody would have seen that in dark, which is where everybody looks first.

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
  Four steps are not additive: `_scrub_token_bearing_artwork()`, which clears
  the old token-carrying `poster_url` values so the proxy can take over;
  `_recover_release_name_titles()`, which replaces a filename Plex stored as a
  title and clears `metadata_updated_at` so the backfill re-asks under the real
  name instead of waiting out its weekly window; `_resweep_incomplete_metadata()`,
  which re-queues rows enriched before Tally stored language, country, studio or
  network; and `merge_duplicates.py`, which collapses items recorded twice. All
  four are idempotent, all four log what they did, and none may assume it runs
  exactly once. Anything else that has to *change* data needs the same treatment
  — a named function and a reason.

  **A resweep has to be reachable and it has to terminate**, and the third one
  is where both nearly went wrong. It backdates `metadata_updated_at` to a
  sentinel rather than nulling it, because `_needs_enrichment` reads NULL as
  "enrich now regardless of artwork" — nulling a library would make the *next
  library scan* re-enrich the whole catalogue inline, which is the burst the
  bounded backfill exists to avoid. And `backfill_missing_metadata` selected
  rows with *no* external id, while the resweep targets rows that *have* one:
  disjoint sets, so without a second arm gated on the sentinel it would have
  queued rows nothing ever revisits. Its predicate also asks for `studio` **and**
  `network` both missing, never "either": TMDB returns no network for a film, so
  "missing a network" is permanently true of every movie and the pass would
  re-queue the entire film library on every boot, forever. Any future resweep
  needs the same two questions asked out loud — *what picks these rows up*, and
  *what makes a row stop coming back*.

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
