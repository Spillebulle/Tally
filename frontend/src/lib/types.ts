export type MediaType = 'movie' | 'show' | 'season' | 'episode'

export type WatchStatus =
  | 'plan_to_watch'
  | 'watching'
  | 'completed'
  | 'on_hold'
  | 'dropped'

export type AnimeFilter = 'all' | 'only' | 'exclude'

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

export interface MediaDetail extends MediaCard {
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

export interface StatCount {
  label: string
  value: number
}

export interface Stats {
  total_movies_watched: number
  total_episodes_watched: number
  total_shows_watched: number
  total_anime_watched: number
  total_runtime_minutes: number
  watch_events: number
  average_rating: number | null
  current_streak_days: number
  longest_streak_days: number
  top_genres: StatCount[]
  activity_by_day: StatCount[]
  activity_by_month: StatCount[]
  by_type: StatCount[]
  rating_distribution: StatCount[]
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
}

export interface AppSettings {
  providers: { tmdb: boolean; tvdb: boolean; mal: boolean; jikan: boolean }
  sync_interval_minutes: number
  webhook_url: string
  public_url: string
  version: string
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
