import type {
  AppSettings,
  AuthStatus,
  ContinueWatchingItem,
  HistoryPage,
  Library,
  MediaCard,
  MediaDetail,
  Paginated,
  PlexAuthPoll,
  PlexAuthStart,
  Server,
  Stats,
  SyncRun,
  SyncStatus,
  User,
  UserState,
  WatchEvent,
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

type Query = Record<string, string | number | boolean | null | undefined>

function withQuery(path: string, query?: Query): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
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
  media_type?: string
  anime?: string
  watch_status?: string
  genre?: string
  year?: number
  unwatched?: boolean
  favorites?: boolean
  on_plex?: boolean
  /** Your own rating, 0–10. Both bounds inclusive. */
  min_rating?: number
  max_rating?: number
  sort?: string
  order?: string
  offset?: number
  limit?: number
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
    detail: (id: number) => get<MediaDetail>(`/api/media/${id}`),
    children: (id: number, season?: number) =>
      get<MediaCard[]>(`/api/media/${id}/children`, { season }),
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
    list: (query: Query = {}) => get<HistoryPage>('/api/history', query),
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

  stats: {
    get: (days = 365, anime_only = false) =>
      get<Stats>('/api/stats', { days, anime_only }),
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
    get: () => get<AppSettings>('/api/settings'),
    preferences: () => get<Record<string, unknown>>('/api/users/me/preferences'),
    updatePreferences: (body: Record<string, unknown>) =>
      put<Record<string, unknown>>('/api/users/me/preferences', body),
    users: () => get<User[]>('/api/users'),
    reclassifyAnime: () => post<unknown>('/api/admin/reclassify-anime'),
  },
}
