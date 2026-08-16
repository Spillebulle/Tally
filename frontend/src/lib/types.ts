export type MediaType = 'movie' | 'show' | 'season' | 'episode'

export type WatchStatus =
  | 'plan_to_watch'
  | 'watching'
  | 'completed'
  | 'on_hold'
  | 'dropped'

export type AnimeFilter = 'all' | 'only' | 'exclude'
/** Home videos: kept out of the grids by default, never deleted. */
export type PersonalFilter = 'all' | 'only' | 'exclude'

export interface User {
  id: number
  username: string
  display_name: string | null
  email: string | null
  avatar_url: string | null
  plex_username: string | null
  is_admin: boolean
  is_active: boolean
  has_plex_link: boolean
  preferences: Record<string, unknown>
  created_at: string
  last_full_sync_at: string | null
}

export interface MediaCard {
  id: number
  media_type: MediaType
  title: string
  year: number | null
  poster_url: string | null
  is_anime: boolean
  /** A home video, recognised from the name the camera gave the file. */
  is_personal_media: boolean
  season_number: number | null
  episode_number: number | null
  show_id: number | null
  show_title: string | null
  status: WatchStatus | null
  rating: number | null
  progress_percent: number | null
  last_watched_at: string | null
  watched_episodes: number | null
  total_episodes: number | null
  on_watchlist: boolean
}

export interface UserState {
  status: WatchStatus | null
  rating: number | null
  view_count: number
  last_watched_at: string | null
  progress_ms: number | null
  duration_ms: number | null
  is_favorite: boolean
  notes: string | null
}

/**
 * The detail payload (`MediaItemDetail` in schemas.py).
 *
 * Deliberately *not* `extends MediaCard`. A card carries the viewer's own
 * status, rating, progress and last-watched date flattened onto it; the detail
 * endpoint does not send those at the top level — they live under `state`.
 * Inheriting them typed them as present and non-null, so passing a MediaDetail
 * to anything expecting a card type-checked and then rendered wrong.
 */
export interface MediaDetail
  extends Omit<
    MediaCard,
    'status' | 'rating' | 'progress_percent' | 'last_watched_at'
  > {
  overview: string | null
  tagline: string | null
  backdrop_url: string | null
  runtime_minutes: number | null
  content_rating: string | null
  studio: string | null
  network: string | null
  genres: string[]
  release_status: string | null
  first_aired: string | null
  community_rating: number | null
  tmdb_id: number | null
  tvdb_id: number | null
  imdb_id: string | null
  mal_id: number | null
  anime_format: string | null
  child_count: number | null
  leaf_count: number | null
  state: UserState | null
  available_on_plex: boolean
}

/** One credited person on a title (`CreditOut` in schemas.py). */
export interface Credit {
  person_id: number
  name: string
  /** Who they played. Null for a director. */
  character: string | null
  /** A TMDB URL — credential-free, so the browser fetches it directly. */
  profile_url: string | null
}

export interface MediaCredits {
  cast: Credit[]
  directors: Credit[]
}

export interface Paginated<T> {
  items: T[]
  total: number
  offset: number
  limit: number
}

export interface ContinueWatchingItem {
  item: MediaCard
  next_episode: MediaCard | null
  show: MediaCard | null
  progress_percent: number
  resumed_at: string | null
}

export interface WatchEvent {
  id: number
  media_item_id: number
  watched_at: string
  source: 'plex_history' | 'plex_webhook' | 'plex_session' | 'manual' | 'import'
  completed: boolean
  device: string | null
  player: string | null
  item: MediaCard | null
}

export interface HistoryPage {
  events: WatchEvent[]
  total: number
  offset: number
  limit: number
}

export interface WatchlistEntry {
  id: number
  media_item_id: number
  /** When *Tally* first recorded the entry, which for a Plex-sourced one is
   * when the sync first saw it rather than when it was watchlisted. */
  added_at: string
  /** Plex's own `watchlistedAt`. Null when Discover did not send one. */
  plex_added_at: string | null
  source: string
  synced_with_plex: boolean
  item: MediaCard | null
}

/** How much of the API a key may reach. Fixed when the key is issued. */
export type ApiKeyScope = 'full' | 'read_only' | 'stats'

export interface ApiKey {
  id: number
  name: string
  /** The visible half. The rest only ever existed in your copy. */
  prefix: string
  scope: ApiKeyScope
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

/** Only the create call returns `key`, and only once. */
export interface ApiKeyCreated extends ApiKey {
  key: string
}

export interface PaginatedWatchlist {
  entries: WatchlistEntry[]
  total: number
  offset: number
  limit: number
}

export interface StatCount {
  label: string
  value: number
}

/** The named windows `/api/stats` resolves server-side. */
export type StatsPreset = '7d' | '30d' | '90d' | 'ytd' | '12m' | 'last_year' | 'all'
export type StatsGranularity = 'day' | 'week' | 'month'

/**
 * Films, television, or both — one scope over the whole stats surface.
 *
 * Deliberately not the browse grids' `media_type`, which names a single row
 * type: a watch history is mostly episodes, so "television" has to mean shows,
 * seasons and episodes together. A `Literal` on the API, so a stale URL is a
 * 422 rather than a page that quietly answers a different question.
 */
export type StatsMediaScope = 'all' | 'movies' | 'shows'

/**
 * The window the numbers actually cover, as the server resolved it.
 *
 * `since`/`until` are the real UTC bounds and the window is half-open;
 * `start_day`/`end_day` are the *inclusive* local dates to label it with, which
 * is not the same thing. `timezone` is the zone that was in force — it reports
 * the fallback to UTC rather than hiding it.
 */
export interface StatsRange {
  preset: StatsPreset | null
  since: string
  until: string
  start_day: string
  end_day: string
  days: number
  timezone: string
  granularity: StatsGranularity
}

export interface StatsTotals {
  total_movies_watched: number
  total_episodes_watched: number
  total_shows_watched: number
  total_anime_watched: number
  total_runtime_minutes: number
  watch_events: number
  average_rating: number | null
}

export interface StatsComparison {
  range: StatsRange
  totals: StatsTotals
  /**
   * Percent movement per metric, keyed by the field names on `StatsTotals`. A
   * metric is *absent* when the earlier window held nothing of it: "up from
   * nothing" has no percentage, and the tile shows the raw pair instead.
   */
  pct_change: Record<string, number | undefined>
}

/**
 * One slot of a time-shape profile: a weekday, an hour or a month.
 *
 * `index` is the machine-readable slot — 0-6 **Monday first** for a weekday,
 * 0-23 for an hour, 1-12 for a month — and `label` is display only. Sort and
 * key on `index`; the label can be shortened or localised without anything
 * else moving.
 *
 * **An hour is when a play finished, near enough.** Plex stamps `viewedAt` at
 * the scrobble, around 90% of the way through, so a film started at 20:00
 * lands in the 21:00 bucket. Any chart of these says "finish", never "start".
 */
export interface TimeBucket {
  index: number
  label: string
  plays: number
  minutes: number
}

/**
 * The 7×24 weekday-by-hour grid, as a matrix rather than 168 objects.
 *
 * `plays[weekday][hour]`; `weekdays` and `hours` label the rows and columns in
 * the order they are in. `max_plays` is the largest cell, so a chart scales its
 * ramp without a pass over the matrix.
 */
export interface PunchCard {
  weekdays: string[]
  hours: number[]
  plays: number[][]
  max_plays: number
}

/** One period bucket split into first-time plays and rewatches. */
export interface RewatchSplit {
  label: string
  first: number
  rewatch: number
}

/** One row of the most-rewatched ranking. Play counts are **all-time**. */
export interface RewatchedItem {
  media_item_id: number
  title: string
  /** Set for an episode, so a row reading "Episode 4" is legible alone. */
  show_title: string | null
  year: number | null
  media_type: MediaType
  poster_url: string
  plays: number
  first_watched: string
  last_watched: string
}

/**
 * First-time watches against rewatches.
 *
 * Everything but `most_rewatched` is scoped to the window; that list is
 * all-time by definition, which is what `ranked_over` says out loud. A play is
 * a rewatch because of what came before it in the *whole* history, not because
 * of what happens to sit inside the window on screen.
 *
 * `by_bucket` is index-aligned with `activity_by_day`, so the two can be
 * chunked and drawn on one axis.
 */
export interface RewatchStats {
  plays: number
  first_watches: number
  rewatches: number
  /** A fraction, not a percentage — the UI decides how to render it. */
  rewatch_ratio: number
  by_bucket: RewatchSplit[]
  most_rewatched: RewatchedItem[]
  ranked_over: 'all_time'
}

/**
 * One sitting: plays with no gap longer than `SessionStats.gap_minutes`.
 *
 * `started_at` and `ended_at` are both **scrobble** instants, so `started_at`
 * is when the first play of the sitting *finished* — Plex records no start time
 * anywhere. A one-play sitting therefore has `started_at === ended_at`. Never
 * draw these as a timeline; they are a count and a length, not a span.
 */
export interface WatchSession {
  started_at: string
  ended_at: string
  /** The local day the sitting started on, in the zone the range names. */
  day: string
  plays: number
  minutes: number
  title: string
  /** Set only when every play in the sitting came from one series. */
  show_title: string | null
}

/**
 * Sittings, worked out by splitting the window's plays on long gaps.
 *
 * A judgement with no right answer, so `gap_minutes` — the threshold that
 * produced these numbers — is part of the payload and has to be stated on
 * screen rather than left implied.
 */
export interface SessionStats {
  gap_minutes: number
  sessions: number
  plays: number
  average_plays: number
  average_minutes: number
  /** The sitting with the most minutes, and the one with the most plays. */
  longest: WatchSession | null
  biggest_binge: WatchSession | null
  /** Plays-per-sitting histogram, labelled "1" … "5", "6+". */
  by_size: StatCount[]
}

export interface Stats extends StatsTotals {
  range: StatsRange
  previous: StatsComparison | null
  /** The same window one calendar year earlier. Only with `compare=true`. */
  previous_year: StatsComparison | null
  current_streak_days: number
  longest_streak_days: number
  top_genres: StatCount[]
  activity_by_day: StatCount[]
  activity_by_month: StatCount[]
  by_type: StatCount[]
  rating_distribution: StatCount[]
  by_weekday: TimeBucket[]
  by_hour: TimeBucket[]
  punch_card: PunchCard
  rewatch: RewatchStats
  /**
   * Sittings over the same window. On this response rather than its own
   * endpoint: it reads the same rows the totals came from.
   */
  sessions: SessionStats
}

/** One calendar year of history: totals plus its twelve month counts. */
export interface YearProfile {
  year: number
  plays: number
  minutes: number
  /** Twelve play counts, January first. */
  months: number[]
}

/**
 * The month-of-year profile, over **all** history rather than a window.
 *
 * Its own endpoint because it is the one aggregation with nothing bounding it,
 * which is also why the page gives it its own loading, error and empty states
 * rather than folding it into the main query's.
 */
export interface Seasonality {
  timezone: string
  plays: number
  minutes: number
  first_play: string | null
  last_play: string | null
  months: TimeBucket[]
  years: YearProfile[]
}

// --- the five depth blocks, one endpoint each ------------------------------
//
// Deliberately not folded into `Stats`. Each is a section of the stats page
// that can be fetched when it is drawn, and two of them — `ShowCompletion` and
// `Coverage` — answer a question no window applies to at all, which is why
// they carry `scope: 'all_time'` on the wire rather than a `range`. A page
// that puts a date picker above a section the picker does not affect is
// lying, so those two say "all time" in their own headings.

/**
 * How far through one show this viewer is, and where they stopped.
 *
 * `episodes_total` is Plex's `leaf_count` **and nothing else**, which is why it
 * and `percent_complete` are both nullable: counting the episode rows Tally
 * holds would report every history-only show as 100% complete. A show with no
 * known total is never called completed and never called abandoned.
 *
 * `total_is_stale` means the total came back smaller than the number of
 * distinct episodes actually watched — a library not rescanned since the season
 * aired. `percent_complete` is null there too, rather than 130% or a clamped
 * 100% that would hide the fact that the number is wrong.
 */
export interface ShowProgress {
  media_item_id: number
  title: string
  year: number | null
  poster_url: string
  status: WatchStatus | null
  episodes_watched: number
  episodes_total: number | null
  percent_complete: number | null
  total_is_stale: boolean
  last_watched_at: string
  /** The drop-off point — the most recent episode watched, not the newest one. */
  last_season: number | null
  last_episode: number | null
  last_episode_title: string | null
  abandoned: boolean
}

/**
 * Show completion and drop-off, over the viewer's **whole** history.
 *
 * `abandoned_under_percent` and `abandoned_after_days` are the thresholds that
 * produced `abandoned`, echoed because they are a judgement rather than a fact
 * and the page has to be able to state them.
 */
export interface ShowCompletion {
  scope: 'all_time'
  /**
   * Whether season 0 counted. False by default and app-wide — a viewer who has
   * watched every episode of a series should read as finished, not as 88% and
   * permanently "still going". The block offers the other answer as a toggle.
   */
  includes_specials: boolean
  abandoned_under_percent: number
  abandoned_after_days: number
  shows_started: number
  shows_completed: number
  shows_in_progress: number
  shows_abandoned: number
  /** Counted apart: nothing about their completion is known. */
  shows_unknown_total: number
  in_progress: ShowProgress[]
  abandoned: ShowProgress[]
}

/** A watchlist entry still waiting to be played. Oldest first. */
export interface WatchlistWaiting {
  media_item_id: number
  title: string
  year: number | null
  media_type: MediaType
  poster_url: string
  /** Plex's `watchlistedAt` where Discover gave one, else Tally's own date. */
  added_at: string
  /** Which of the two `added_at` is, so the row can say rather than imply. */
  added_on_plex: boolean
  days_waiting: number
}

/**
 * Does watchlisting something mean you watch it?
 *
 * The window bounds `added_at` here — which entries are being asked about —
 * not the plays. That is the only bound that makes the question answerable, and
 * it is why the section says so out loud rather than inheriting the page's
 * "watched in this range" reading of the same control.
 */
export interface WatchlistConversion {
  range: StatsRange
  tail_days: number
  added: number
  /**
   * How many of `added` carry Plex's own watchlist date. Short of `added`, the
   * rest are dated from when Tally first saw them — a real difference on a
   * fresh install, where every imported entry shares one instant.
   */
  plex_dated: number
  converted: number
  /** A fraction, not a percentage. */
  conversion_rate: number
  /** Median, not mean: one title watchlisted in 2019 drags an average away. */
  median_days_to_watch: number | null
  still_waiting: number
  waiting_past_tail: number
  /** Removed from the watchlist without ever having been played. */
  churned: number
  removed: number
  waiting: WatchlistWaiting[]
}

export interface CoverageSlice {
  label: string
  owned: number
  watched: number
  /** watched / owned as a fraction. Never null — a slice owns something. */
  percent: number
}

/**
 * How much of the shelf has actually been watched. All-time by construction.
 *
 * `includes_personal` reports whether home videos are in the inventory, and it
 * deliberately differs from the watch blocks: everywhere else on the stats page
 * a play is a play and home videos count, but this is a library inventory and a
 * phone recording is not a title you have failed to get round to.
 */
export interface Coverage {
  scope: 'all_time'
  includes_personal: boolean
  owned: number
  watched: number
  unwatched: number
  percent: number
  by_type: CoverageSlice[]
  by_genre: CoverageSlice[]
  by_decade: CoverageSlice[]
}

export interface RatingSlice {
  label: string
  count: number
  average: number
  /** The crowd over the same slice; absent when none of it carries a score. */
  community_average: number | null
}

/** A title you and the crowd disagree about. `difference` is yours minus theirs. */
export interface ContrarianItem {
  media_item_id: number
  title: string
  year: number | null
  media_type: MediaType
  poster_url: string
  rating: number
  community_rating: number
  difference: number
}

/**
 * Your ratings against the crowd's, and how they break down.
 *
 * Only titles carrying **both** a rating and a community score can be compared,
 * so `rated_with_community` is the denominator of every agreement number here
 * and is shown next to `rated` rather than left to be inferred.
 */
export interface RatingDepth {
  range: StatsRange
  rated: number
  rated_with_community: number
  average_rating: number | null
  average_community: number | null
  /** Mean signed difference: positive means you are the kinder of the two. */
  average_difference: number | null
  average_absolute_difference: number | null
  /** Share of comparable titles within one point either way, 0–1. */
  agreement_within_one: number | null
  kinder_than_crowd: number
  harsher_than_crowd: number
  you_rate_higher: ContrarianItem[]
  you_rate_lower: ContrarianItem[]
  by_genre: RatingSlice[]
  by_decade: RatingSlice[]
  by_runtime: RatingSlice[]
  /** Rated titles with no runtime recorded, so they are in no runtime bucket. */
  runtime_unknown: number
}

/** One row of a title ranking. `episodes` is distinct episodes in the window. */
export interface RankedTitle {
  media_item_id: number
  title: string
  year: number | null
  media_type: MediaType
  poster_url: string
  plays: number
  minutes: number
  episodes: number | null
  episodes_total: number | null
}

/** One row of a facet ranking — a studio, a network, a decade, a source. */
export interface RankedFacet {
  label: string
  plays: number
  minutes: number
  /** Distinct titles behind the row, so "300 plays" reads as one show. */
  titles: number
}

/**
 * The leaderboards: what you watched most of, and where it came from.
 *
 * Facets resolve through the parent show, because enrichment skips episodes —
 * except `decades`, which uses the item's own year so a 2019 episode is not
 * filed under 1989.
 */
export interface Rankings {
  range: StatsRange
  limit: number
  top_shows: RankedTitle[]
  top_films: RankedTitle[]
  top_by_runtime: RankedTitle[]
  studios: RankedFacet[]
  networks: RankedFacet[]
  decades: RankedFacet[]
  content_ratings: RankedFacet[]
  /** How the play reached Tally, not what was played. A diagnostic as much as a stat. */
  by_source: RankedFacet[]
}

export interface Library {
  id: number
  title: string
  section_type: string
  section_key: string
  anime_override: boolean | null
  enabled: boolean
  item_count: number
  last_synced_at: string | null
}

export interface Server {
  id: number
  name: string
  machine_identifier: string
  base_url: string
  /** User-pinned address. When set, discovery is skipped entirely. */
  manual_url: string | null
  owned: boolean
  version: string | null
  platform: string | null
  enabled: boolean
  last_seen_at: string | null
  libraries: Library[]
}

/**
 * A library the `library_id` browse filter can name, from `/api/media/places`.
 *
 * Deliberately not `Library`: that one is the settings view of a library —
 * scan state, item counts, the anime override — and the picker needs its
 * server's name instead, because "Movies" is what half the libraries on a
 * two-server household are called.
 */
export interface LibraryOption {
  id: number
  title: string
  section_type: string
  server_id: number
  server_name: string
}

export interface ServerOption {
  id: number
  name: string
}

/** Where the browse filters may look: only what this account can see. */
export interface BrowsePlaces {
  servers: ServerOption[]
  libraries: LibraryOption[]
}

export interface SyncRun {
  id: number
  kind: string
  status: string
  started_at: string
  finished_at: string | null
  stats: Record<string, unknown>
  error: string | null
}

export interface SyncStatus {
  running: boolean
  last_run: SyncRun | null
  last_full_sync_at: string | null
  run_id: number | null
  /** What the run is doing right now, e.g. "Scanning Films on Basement". */
  phase: string | null
  /** Progress within the current phase. total of 0 means indeterminate. */
  progress_current: number
  progress_total: number
  cancel_requested: boolean
}

export interface AppSettings {
  providers: { tmdb: boolean; tvdb: boolean; mal: boolean; jikan: boolean }
  sync_interval_minutes: number
  webhook_url: string
  public_url: string
  version: string
  /** What Plex reports as its own On Deck window. Null until a sync has read it. */
  plex_on_deck_weeks: number | null
  /** The window actually in force, in weeks. 0 means nothing is ever aged out. */
  continue_watching_weeks: number
}

export interface AppVersion {
  version: string
  github_url: string
  dockerhub_url: string
}

export interface AuthStatus {
  setup_required: boolean
  plex_enabled: boolean
  app_name: string
}

export interface PlexAuthStart {
  auth_url: string
  state: string
  pin_id: string
  expires_at: string
}

export interface PlexAuthPoll {
  status: 'pending' | 'authenticated' | 'expired'
  user: User | null
}

/**
 * Which browse surface a saved view belongs to.
 *
 * The *filter surface*, not the route: every Browse mode — movies, shows,
 * anime, search, all titles — offers one set of filters and one set of sorts,
 * while the watchlist and History each have their own. A view saved on Movies
 * therefore applies on Anime too, and applying one never navigates: it sets the
 * query on the grid you are looking at.
 */
export type SavedViewPage = 'media' | 'watchlist' | 'history'

/**
 * A browse query somebody wants back later.
 *
 * `query` is the raw query string, stored verbatim and never parsed on the
 * server. Recalling it hands the string back to `useBrowseFilters`, which
 * validates every parameter exactly as it does for a hand-edited URL — so a
 * view saved before a filter was renamed degrades to the page defaults instead
 * of erroring.
 */
export interface SavedView {
  id: number
  page: SavedViewPage
  name: string
  query: string
  created_at: string
  updated_at: string
}
