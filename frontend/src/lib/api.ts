import type {
  AppSettings,
  AppVersion,
  AuthStatus,
  BrowsePlaces,
  ContinueWatchingItem,
  HistoryPage,
  Library,
  MediaCard,
  MediaCredits,
  MediaDetail,
  Paginated,
  PlexAuthPoll,
  PlexAuthStart,
  SavedView,
  SavedViewPage,
  Seasonality,
  Server,
  Stats,
  StatsGranularity,
  StatsPreset,
  SyncRun,
  SyncStatus,
  User,
  UserState,
  WatchEvent,
  ApiKey,
  ApiKeyCreated,
  ApiKeyScope,
  PaginatedWatchlist,
  WatchlistEntry,
  WatchStatus,
} from './types'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type QueryValue = string | number | boolean | null | undefined
type Query = Record<string, QueryValue | readonly QueryValue[]>

function withQuery(path: string, query?: Query): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    // A list is one occurrence per element — `?genre=Crime&genre=Drama` — which
    // is what the API's repeatable facets read. Stringified, it would arrive as
    // the single value "Crime,Drama" and match nothing; and a separator cannot
    // be chosen anyway, since studio names contain commas.
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== undefined && entry !== null && entry !== '') {
          params.append(key, String(entry))
        }
      }
    } else if (value !== undefined && value !== null && value !== '') {
      params.append(key, String(value))
    }
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

async function request<T>(
  path: string,
  options: RequestInit & { query?: Query } = {},
): Promise<T> {
  const { query, ...init } = options
  const response = await fetch(withQuery(path, query), {
    // Session lives in an httpOnly cookie, so every call must send credentials.
    credentials: 'include',
    headers:
      init.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json', ...init.headers }
        : init.headers,
    ...init,
  })

  if (response.status === 204) return undefined as T

  const text = await response.text()
  const data = text ? safeParse(text) : null

  if (!response.ok) {
    const detail =
      (data && typeof data === 'object' && 'detail' in data
        ? String((data as { detail: unknown }).detail)
        : null) ?? `Request failed (${response.status})`
    throw new ApiError(detail, response.status)
  }
  return data as T
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const get = <T,>(path: string, query?: Query) => request<T>(path, { query })
const post = <T,>(path: string, body?: unknown, query?: Query) =>
  request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    query,
  })
const put = <T,>(path: string, body?: unknown) =>
  request<T>(path, {
    method: 'PUT',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const patch = <T,>(path: string, body?: unknown) =>
  request<T>(path, {
    method: 'PATCH',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const del = <T,>(path: string, query?: Query) =>
  request<T>(path, { method: 'DELETE', query })

export interface MediaQuery extends Query {
  q?: string
  /** `all` widens the search to overviews and your own notes. Default `title`. */
  q_scope?: string
  media_type?: string
  anime?: string
  /** Defaults to `exclude` on the server: home videos are not titles. */
  personal?: string
  watch_status?: string
  /**
   * The repeatable facets: one parameter per value, plus a parallel `_not` for
   * exclusion. `genre_mode=all` is the only AND on offer — a title carries
   * several genres, but one studio, one certificate and one network.
   */
  genre?: string[]
  genre_not?: string[]
  genre_mode?: string
  content_rating?: string[]
  content_rating_not?: string[]
  studio?: string[]
  studio_not?: string[]
  network?: string[]
  network_not?: string[]
  anime_format?: string[]
  anime_format_not?: string[]
  /** Where the file lives, by id — see `api.media.places()` for the pickers. */
  library_id?: string[]
  server_id?: string[]
  /** Credits, by name. Exact matches, like the facets a detail page links on. */
  director?: string
  actor?: string
  release_status?: string
  year?: number
  unwatched?: boolean
  favorites?: boolean
  has_notes?: boolean
  in_progress?: boolean
  on_plex?: boolean
  /** Your own rating, 0–10. Both bounds inclusive. */
  min_rating?: number
  max_rating?: number
  /** The crowd's score, same scale. */
  min_community?: number
  max_community?: number
  min_year?: number
  max_year?: number
  /** Minutes. */
  min_runtime?: number
  max_runtime?: number
  min_watch_count?: number
  max_watch_count?: number
  /**
   * Date bounds, sent as instants. The controls hold local days and convert on
   * the way out — start of day and end of day in the viewer's own zone — so a
   * range that reads "14–20 Aug" contains every play on the 20th.
   */
  added_after?: string
  added_before?: string
  watched_after?: string
  watched_before?: string
  /** History only: the window over the plays themselves. */
  since?: string
  until?: string
  anime_only?: boolean
  sort?: string
  order?: string
  offset?: number
  limit?: number
}

/**
 * The window `/api/stats` should cover.
 *
 * Three ways to ask and the server resolves whichever it was into one `range`
 * block, so the page never re-derives a boundary that depends on the viewer's
 * timezone: a named `preset`, an explicit `since`/`until` pair (which wins over
 * a preset), or the legacy `days`. `tz` is the viewer's IANA zone — the server
 * resolves `tz` → the stored preference → UTC and reports which it used.
 */
export interface StatsQuery extends Query {
  preset?: StatsPreset
  since?: string
  until?: string
  days?: number
  /** Also aggregate the window immediately before this one. */
  compare?: boolean
  granularity?: StatsGranularity
  anime_only?: boolean
  tz?: string
}

/**
 * `/api/stats/seasonality` — all of history, so there is no window to name.
 *
 * The scope and the zone still apply, and they are the only two things that
 * can change the answer, which is why this is a separate query key from the
 * windowed one rather than a flag on it.
 */
export interface SeasonalityQuery extends Query {
  anime_only?: boolean
  tz?: string
}

export const api = {
  auth: {
    status: () => get<AuthStatus>('/api/auth/status'),
    me: () => get<User>('/api/auth/me'),
    plexStart: () => post<PlexAuthStart>('/api/auth/plex/start'),
    plexPoll: (state: string) =>
      post<PlexAuthPoll>('/api/auth/plex/poll', undefined, { state }),
    login: (username: string, password: string) =>
      post<User>('/api/auth/login', { username, password }),
    register: (username: string, password: string, display_name?: string) =>
      post<User>('/api/auth/register', { username, password, display_name }),
    logout: () => post<void>('/api/auth/logout'),
    changePassword: (new_password: string, current_password?: string) =>
      post<void>('/api/auth/password', { new_password, current_password }),
  },

  media: {
    list: (query: MediaQuery) => get<Paginated<MediaCard>>('/api/media', query),
    genres: (anime?: string) => get<string[]>('/api/media/genres', { anime }),
    contentRatings: (anime?: string) =>
      get<string[]>('/api/media/content-ratings', { anime }),
    // The servers and libraries this account can see, for the two "where does
    // it live" filters. Scoped on the server through `UserServerAccess`.
    places: () => get<BrowsePlaces>('/api/media/places'),
    detail: (id: number) => get<MediaDetail>(`/api/media/${id}`),
    credits: (id: number) => get<MediaCredits>(`/api/media/${id}/credits`),
    children: (id: number, season?: number) =>
      get<MediaCard[]>(`/api/media/${id}/children`, { season }),
    // Unwatched titles sharing the most genres, best-rated first within a tier.
    recommendations: (id: number, limit = 12) =>
      get<MediaCard[]>(`/api/media/${id}/recommendations`, { limit }),
    continueWatching: () =>
      get<ContinueWatchingItem[]>('/api/media/continue-watching'),
    recentlyWatched: (limit = 20) =>
      get<MediaCard[]>('/api/media/recently-watched', { limit }),
    recentlyAdded: (anime?: string, limit = 20) =>
      get<MediaCard[]>('/api/media/recently-added', { anime, limit }),
    setRating: (id: number, rating: number | null) =>
      put<UserState>(`/api/media/${id}/rating`, { rating, push_to_plex: true }),
    setStatus: (id: number, status: WatchStatus | null) =>
      put<UserState>(`/api/media/${id}/status`, { status }),
    setFavorite: (id: number, is_favorite: boolean) =>
      put<UserState>(`/api/media/${id}/favorite`, { is_favorite }),
    setNotes: (id: number, notes: string | null) =>
      put<UserState>(`/api/media/${id}/notes`, { notes }),
  },

  history: {
    // The same filter surface as /api/media, plus `since`/`until` over the
    // plays and its own `HistorySortField`.
    list: (query: MediaQuery = {}) => get<HistoryPage>('/api/history', query),
    markWatched: (id: number) =>
      post<WatchEvent>(`/api/history/${id}/watched`, undefined),
    markSeasonWatched: (showId: number, season: number) =>
      post<{ marked: number }>(
        `/api/history/${showId}/season/${season}/watched`,
        undefined,
      ),
    markUnwatched: (id: number) => post<void>(`/api/history/${id}/unwatched`),
    log: (media_item_id: number, watched_at?: string) =>
      post<WatchEvent>('/api/history', { media_item_id, watched_at }),
    remove: (eventId: number) => del<void>(`/api/history/${eventId}`),
  },

  watchlist: {
    // Same filter surface as /api/media, plus its own "watchlist_added" sort.
    list: (query: MediaQuery = {}) =>
      get<PaginatedWatchlist>('/api/watchlist', query),
    add: (media_item_id: number) =>
      post<WatchlistEntry>('/api/watchlist', { media_item_id }),
    addDiscovered: (plex_guid: string) =>
      post<WatchlistEntry>('/api/watchlist', { plex_guid }),
    remove: (mediaItemId: number) => del<void>(`/api/watchlist/${mediaItemId}`),
    searchDiscover: (q: string) =>
      get<MediaCard[]>('/api/watchlist/search', { q }),
  },

  /**
   * Saved browse views — a name and the raw query string, per page.
   *
   * `create` is an upsert on the name: saving twice under one name re-points it
   * rather than duplicating, so there is no "already exists" branch for the UI
   * to handle. Nothing here parses the query; the URL is the only place a
   * filter value is ever interpreted.
   */
  views: {
    list: (page: SavedViewPage) => get<SavedView[]>('/api/views', { page }),
    save: (page: SavedViewPage, name: string, query: string) =>
      post<SavedView>('/api/views', { page, name, query }),
    update: (id: number, body: { name?: string; query?: string }) =>
      patch<SavedView>(`/api/views/${id}`, body),
    remove: (id: number) => del<void>(`/api/views/${id}`),
  },

  apiKeys: {
    list: () => get<ApiKey[]>('/api/keys'),
    create: (name: string, scope: ApiKeyScope = 'full') =>
      post<ApiKeyCreated>('/api/keys', { name, scope }),
    revoke: (id: number) => del<void>(`/api/keys/${id}`),
  },

  stats: {
    get: (days = 365, anime_only = false) =>
      get<Stats>('/api/stats', { days, anime_only }),
    /**
     * The full window vocabulary: a named preset, or an explicit `since`/`until`
     * pair, plus the viewer's zone.
     *
     * Alongside `get` rather than replacing it — the dashboard asks a fixed
     * "last 365 days" question and has no window to describe, so widening its
     * call would only make it spell out a default.
     */
    query: (params: StatsQuery) => get<Stats>('/api/stats', { ...params }),
    /**
     * The month-of-year profile over all history.
     *
     * A second request rather than a block on the first: it walks every play
     * the user has ever recorded, and the stats page should not pay for that
     * every time a filter chip moves. It therefore also gets its own loading,
     * error and empty states on the page.
     */
    seasonality: (params: SeasonalityQuery = {}) =>
      get<Seasonality>('/api/stats/seasonality', { ...params }),
    summary: () =>
      get<{
        library_movies: number
        library_shows: number
        library_anime: number
        watch_events: number
      }>('/api/stats/summary'),
  },

  sync: {
    trigger: (full_history = false, scan_libraries = true) =>
      post<{ status: string }>('/api/sync', { full_history, scan_libraries }),
    status: () => get<SyncStatus>('/api/sync/status'),
    runs: () => get<SyncRun[]>('/api/sync/runs'),
    cancel: () => post<{ cancelling: boolean; run_id: number }>('/api/sync/cancel'),
  },

  servers: {
    list: () => get<Server[]>('/api/servers'),
    discover: () => post<Server[]>('/api/servers/discover'),
    test: (id: number) =>
      post<{ reachable: boolean; url: string | null }>(`/api/servers/${id}/test`),
    update: (id: number, body: { manual_url?: string | null; enabled?: boolean }) =>
      patch<Server>(`/api/servers/${id}`, body),
    updateLibrary: (
      id: number,
      body: { enabled?: boolean; anime_override?: boolean | null },
    ) => patch<Library>(`/api/libraries/${id}`, body),
    scanLibrary: (id: number) => post<unknown>(`/api/libraries/${id}/scan`),
  },

  settings: {
    version: () => get<AppVersion>('/api/version'),
    get: () => get<AppSettings>('/api/settings'),
    preferences: () => get<Record<string, unknown>>('/api/users/me/preferences'),
    updatePreferences: (body: Record<string, unknown>) =>
      put<Record<string, unknown>>('/api/users/me/preferences', body),
    users: () => get<User[]>('/api/users'),
    reclassifyAnime: () => post<unknown>('/api/admin/reclassify-anime'),
  },
}
