import { useSearchParams } from 'react-router-dom'
import type { WatchStatus } from '@/lib/types'
import { cn, STATUS_LABELS } from '@/lib/utils'

/**
 * The filter bar shared by the media grids and the watchlist.
 *
 * Both browse the same rows and offer the same controls, so this lives in one
 * place — the backend shares its query building for the same reason. A page
 * supplies its own sort list, because "added" means something different once
 * you are looking at a watchlist.
 */

export type SortOption = { value: string; label: string }

/** Sorts every browse page offers. */
export const SORTS: readonly SortOption[] = [
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'added', label: 'Recently added' },
  { value: 'watched', label: 'Recently watched' },
  { value: 'rating', label: 'Your rating' },
]

/** The watchlist leads with when you watchlisted it, then the rest. */
export const WATCHLIST_SORTS: readonly SortOption[] = [
  { value: 'watchlist_added', label: 'Recently watchlisted' },
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'added', label: 'Added to library' },
  { value: 'watched', label: 'Recently watched' },
  { value: 'rating', label: 'Your rating' },
]

export const STATUS_FILTERS: Array<{
  value: WatchStatus | 'all' | 'unwatched'
  label: string
}> = [
  { value: 'all', label: 'All' },
  { value: 'watching', label: STATUS_LABELS.watching },
  { value: 'completed', label: STATUS_LABELS.completed },
  { value: 'unwatched', label: 'Unwatched' },
  { value: 'plan_to_watch', label: STATUS_LABELS.plan_to_watch },
  { value: 'on_hold', label: STATUS_LABELS.on_hold },
  { value: 'dropped', label: STATUS_LABELS.dropped },
]

/**
 * Rating shortcuts, on Plex's 0–10 scale.
 *
 * `min` alone is "this and above"; `min === max` pins an exact score, which is
 * what clicking a bar on the stats page sends.
 */
const RATING_FILTERS: Array<{ label: string; min?: number; max?: number }> = [
  { label: 'Any' },
  { label: '10 only', min: 10, max: 10 },
  { label: '9+', min: 9 },
  { label: '8+', min: 8 },
  { label: '7+', min: 7 },
  { label: '5+', min: 5 },
]

/**
 * The shortcut list, plus an entry describing the active filter when it is not
 * one of them.
 *
 * Clicking a bar on the stats page can pin any exact score, and a select that
 * showed "Any rating" while the grid was filtered to 7s would be lying about
 * the state of the page.
 */
export function ratingOptions(min?: number, max?: number) {
  const known = RATING_FILTERS.some(
    (option) => option.min === min && option.max === max,
  )
  if (known || (min == null && max == null)) return RATING_FILTERS

  const label =
    min != null && min === max
      ? `${min} only`
      : min != null && max != null
        ? `${min}–${max}`
        : min != null
          ? `${min}+`
          : `up to ${max}`
  return [...RATING_FILTERS, { label, min, max }]
}

const numberParam = (raw: string | null): number | undefined => {
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** The subset of a media query these controls own. */
export interface FilterQuery {
  q?: string
  genre?: string
  watch_status?: WatchStatus
  unwatched?: true
  min_rating?: number
  max_rating?: number
  sort: string
  order: 'asc' | 'desc'
}

export interface BrowseFilterState {
  search: string
  genre: string
  sort: string
  order: 'asc' | 'desc'
  statusFilter: WatchStatus | 'all' | 'unwatched'
  minRating?: number
  maxRating?: number
  /** True when something is narrowing the results, so "Clear" is worth showing. */
  active: boolean
  update: (key: string, value: string | null) => void
  setRating: (min?: number, max?: number) => void
  clear: () => void
  /** The filter half of the request, ready to merge into a page's own query. */
  query: FilterQuery
}

/**
 * Filter state, held in the URL so a filtered view can be linked and survives a
 * reload. `defaultSort` differs per page.
 *
 * `defaultOrder` overrides the general direction rule below, and applies only
 * while the page is still on its own default sort — the watchlist opens oldest
 * first because it is a queue, but if you switch it to Year you want the same
 * newest-first that Year means everywhere else.
 */
export function useBrowseFilters(
  defaultSort: string,
  defaultOrder?: 'asc' | 'desc',
): BrowseFilterState {
  const [params, setParams] = useSearchParams()

  const search = params.get('q') ?? ''
  const genre = params.get('genre') ?? ''
  const sort = params.get('sort') ?? defaultSort
  // Titles read A–Z; everything else is a recency or a score, where the
  // interesting end is the top.
  const fallbackOrder =
    sort === defaultSort && defaultOrder
      ? defaultOrder
      : sort === 'title'
        ? 'asc'
        : 'desc'
  const order = (params.get('order') ?? fallbackOrder) as 'asc' | 'desc'
  const statusFilter = (params.get('status') ?? 'all') as
    | WatchStatus
    | 'all'
    | 'unwatched'
  const minRating = numberParam(params.get('min_rating'))
  const maxRating = numberParam(params.get('max_rating'))

  const update = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const setRating = (min?: number, max?: number) => {
    const next = new URLSearchParams(params)
    if (min == null) next.delete('min_rating')
    else next.set('min_rating', String(min))
    if (max == null) next.delete('max_rating')
    else next.set('max_rating', String(max))
    setParams(next, { replace: true })
  }

  const query: FilterQuery = {
    q: search || undefined,
    genre: genre || undefined,
    watch_status:
      statusFilter !== 'all' && statusFilter !== 'unwatched' ? statusFilter : undefined,
    unwatched: statusFilter === 'unwatched' || undefined,
    min_rating: minRating,
    max_rating: maxRating,
    sort,
    order,
  }

  return {
    search,
    genre,
    sort,
    order,
    statusFilter,
    minRating,
    maxRating,
    active: Boolean(genre) || statusFilter !== 'all' || minRating != null || maxRating != null,
    update,
    setRating,
    // A search term is navigation, not a filter — clearing the filters should
    // not also throw away what the user searched for.
    clear: () => setParams(search ? { q: search } : {}, { replace: true }),
    query,
  }
}

export function BrowseFilters({
  state,
  genres,
  sorts = SORTS,
  busy,
}: {
  state: BrowseFilterState
  genres: string[]
  sorts?: readonly SortOption[]
  /** Shows a quiet "Updating…" while a refetch is in flight. */
  busy?: boolean
}) {
  const ratingChoices = ratingOptions(state.minRating, state.maxRating)

  return (
    <div className="mb-6 space-y-3">
      <div className="scroll-x scrollbar-none flex gap-2 pb-1">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            onClick={() =>
              state.update('status', filter.value === 'all' ? null : filter.value)
            }
            className={cn(
              'chip shrink-0',
              state.statusFilter === filter.value && 'chip-active',
            )}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Filter by genre"
          value={state.genre}
          onChange={(event) => state.update('genre', event.target.value || null)}
          className="input h-9 w-auto min-w-[9rem] py-0 text-sm"
        >
          <option value="">All genres</option>
          {/* The active genre, even before the list has loaded. Without it the
              select renders with nothing selected while a genre filter is in
              force — the control saying one thing and the grid another, which
              is what the rating options below go out of their way to avoid. */}
          {state.genre && !genres.includes(state.genre) && (
            <option value={state.genre}>{state.genre}</option>
          )}
          {genres.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter by your rating"
          value={ratingChoices.findIndex(
            (option) => option.min === state.minRating && option.max === state.maxRating,
          )}
          onChange={(event) => {
            const choice = ratingChoices[Number(event.target.value)]
            state.setRating(choice?.min, choice?.max)
          }}
          className="input h-9 w-auto py-0 text-sm"
        >
          {ratingChoices.map((option, index) => (
            <option key={option.label} value={index}>
              {option.label === 'Any' ? 'Any rating' : `Rated ${option.label}`}
            </option>
          ))}
        </select>

        <select
          aria-label="Sort by"
          value={state.sort}
          onChange={(event) => state.update('sort', event.target.value)}
          className="input h-9 w-auto py-0 text-sm"
        >
          {sorts.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => state.update('order', state.order === 'asc' ? 'desc' : 'asc')}
          className="btn-outline h-9 px-3 text-sm"
          title={state.order === 'asc' ? 'Ascending' : 'Descending'}
        >
          {state.order === 'asc' ? '↑' : '↓'}
        </button>

        {state.active && (
          <button
            type="button"
            onClick={state.clear}
            className="text-sm text-muted hover:text-danger"
          >
            Clear filters
          </button>
        )}

        {busy && <span className="ml-auto text-xs text-muted">Updating…</span>}
      </div>
    </div>
  )
}
