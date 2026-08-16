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
  added_at: string
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
