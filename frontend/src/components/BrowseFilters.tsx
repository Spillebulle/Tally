import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { WatchStatus } from '@/lib/types'
import { cn, STATUS_LABELS } from '@/lib/utils'

/**
 * The browse query — where it lives, and the controls that write it.
 *
 * Every page that browses keeps its *whole* query in the URL: the filters, the
 * sort, the direction and the page number. That is what makes the back button
 * work. Coming back from a title used to land on page one of an unfiltered
 * grid, because the page number was component state and component state does
 * not survive a navigation; the URL does, and it can be shared and bookmarked
 * besides.
 *
 * The grid and the watchlist browse the same rows and offer the same controls,
 * so this lives in one place — the backend shares its query building for the
 * same reason. A page supplies its own sort list, because "added" means
 * something different once you are looking at a watchlist.
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

/**
 * A rating bound from the URL, or nothing.
 *
 * The bounds are declared `ge=0, le=10` on the API, so a value outside that
 * range is not a narrower filter — it is a 422 and an error card where the
 * grid should be. Anything unreadable or out of range means "no bound", which
 * is the one answer that always shows the user something.
 */
const numberParam = (raw: string | null): number | undefined => {
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 10) return undefined
  return value
}

/**
 * `?page=3` is the third page — 1-based as written, because that is what the
 * label beside it says and what anyone reading the URL will assume.
 *
 * Anything else reads as the first page. A URL is typed, truncated and pasted
 * by hand, so `page=banana` and `page=-4` have to mean something harmless
 * rather than becoming a nonsense offset in a request.
 */
const pageParam = (raw: string | null): number => {
  const value = Number(raw)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value) - 1)
}

export interface PageState {
  /** Zero-based, because that is what an offset wants. */
  page: number
  setPage: (page: number, options?: { replace?: boolean }) => void
}

/**
 * The page number, held in the URL.
 *
 * Paging *pushes* a history entry: stepping back from page three to page two
 * is exactly what the back button is for. Everything else on the filter bar
 * replaces instead — a filter is a refinement of the view you are already on,
 * and one entry per keystroke or per chip would bury whatever you want to go
 * back to.
 */
export function usePageParam(): PageState {
  const [params, setParams] = useSearchParams()
  return {
    page: pageParam(params.get('page')),
    setPage: (page, options) => {
      const next = new URLSearchParams(params)
      if (page <= 0) next.delete('page')
      else next.set('page', String(page + 1))
      setParams(next, { replace: options?.replace ?? false })
    },
  }
}

/**
 * Facets a detail page links out on.
 *
 * Only `content_rating` gets a picker: a library holds a dozen certificates but
 * hundreds of studios and thousands of directors, and a select is not a way to
 * find one name in a thousand. The other two are arrived at by clicking one on
 * an item page, and appear here as a removable chip instead — so whatever is
 * narrowing the grid is still named in the bar, and can still be undone,
 * without a control nobody could use.
 */
const FACETS = [
  { key: 'content_rating', label: 'Rated', picker: true },
  { key: 'studio', label: 'Studio', picker: false },
  { key: 'director', label: 'Director', picker: false },
] as const

type FacetKey = (typeof FACETS)[number]['key']

/** The subset of a media query these controls own. */
export interface FilterQuery {
  q?: string
  genre?: string
  content_rating?: string
  studio?: string
  director?: string
  watch_status?: WatchStatus
  unwatched?: true
  min_rating?: number
  max_rating?: number
  sort: string
  order: 'asc' | 'desc'
}

export interface BrowseFilterState extends PageState {
  search: string
  genre: string
  /** The active facet values, keyed as they appear in the URL. */
  facets: Record<FacetKey, string>
  sort: string
  order: 'asc' | 'desc'
  /** The sorts this page offers — the dropdown's options and the whitelist. */
  sorts: readonly SortOption[]
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
 * reload. The page passes the sorts it offers and which of them it opens on.
 *
 * Every value is checked against what the API will actually accept, because a
 * URL is not trustworthy input — it is typed, truncated, edited by hand and
 * kept in bookmarks long after the page that wrote it changed. `sort`,
 * `order` and `status` are all declared as literals on the backend, so one
 * stale or mistyped word is a 422, and a 422 is an error card where the grid
 * should be. Anything unrecognised falls back to this page's default.
 *
 * `defaultOrder` overrides the general direction rule below, and applies only
 * while the page is still on its own default sort — the watchlist opens oldest
 * first because it is a queue, but if you switch it to Year you want the same
 * newest-first that Year means everywhere else.
 */
export function useBrowseFilters(
  sorts: readonly SortOption[],
  defaultSort: string,
  defaultOrder?: 'asc' | 'desc',
): BrowseFilterState {
  const [params, setParams] = useSearchParams()
  const { page, setPage } = usePageParam()

  const search = params.get('q') ?? ''
  const genre = params.get('genre') ?? ''
  const facets = Object.fromEntries(
    FACETS.map((facet) => [facet.key, params.get(facet.key) ?? '']),
  ) as Record<FacetKey, string>
  // A URL is untrusted input and `sort` is a Literal on the API, so a stale or
  // mistyped value is a 422 and an error card where the grid should be.
  const requestedSort = params.get('sort')
  const sort = sorts.some((option) => option.value === requestedSort)
    ? (requestedSort as string)
    : defaultSort
  // Titles read A–Z; everything else is a recency or a score, where the
  // interesting end is the top.
  const orderFor = (forSort: string): 'asc' | 'desc' =>
    forSort === defaultSort && defaultOrder
      ? defaultOrder
      : forSort === 'title'
        ? 'asc'
        : 'desc'
  const requestedOrder = params.get('order')
  const order =
    requestedOrder === 'asc' || requestedOrder === 'desc'
      ? requestedOrder
      : orderFor(sort)
  const requestedStatus = params.get('status')
  const statusFilter = STATUS_FILTERS.some(
    (filter) => filter.value === requestedStatus,
  )
    ? (requestedStatus as WatchStatus | 'all' | 'unwatched')
    : 'all'
  const minRating = numberParam(params.get('min_rating'))
  const maxRating = numberParam(params.get('max_rating'))

  /**
   * Writes one parameter and normalises the rest of the query around it.
   *
   * A default never survives into the URL: picking the sort the page already
   * opens on says nothing, and a link that spells out every default reads as
   * noise rather than as a view someone chose. The page number goes too —
   * narrowing the results renumbers them, so "page 4" of the old filter is not
   * a place that still exists.
   *
   * `replace`, so refining a view does not cost a back step each time.
   */
  const update = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (next.get('sort') === defaultSort) next.delete('sort')
    if (next.get('order') === orderFor(next.get('sort') ?? defaultSort)) {
      next.delete('order')
    }
    next.delete('page')
    setParams(next, { replace: true })
  }

  const setRating = (min?: number, max?: number) => {
    const next = new URLSearchParams(params)
    if (min == null) next.delete('min_rating')
    else next.set('min_rating', String(min))
    if (max == null) next.delete('max_rating')
    else next.set('max_rating', String(max))
    next.delete('page')
    setParams(next, { replace: true })
  }

  const query: FilterQuery = {
    q: search || undefined,
    genre: genre || undefined,
    content_rating: facets.content_rating || undefined,
    studio: facets.studio || undefined,
    director: facets.director || undefined,
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
    facets,
    sort,
    order,
    sorts,
    statusFilter,
    minRating,
    maxRating,
    page,
    setPage,
    active:
      Boolean(genre) ||
      FACETS.some((facet) => facets[facet.key]) ||
      statusFilter !== 'all' ||
      minRating != null ||
      maxRating != null,
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
  contentRatings = [],
  busy,
}: {
  state: BrowseFilterState
  genres: string[]
  /** Certificates present in the library, for the "Rated" select. */
  contentRatings?: string[]
  /** Shows a quiet "Updating…" while a refetch is in flight. */
  busy?: boolean
}) {
  // The sort list comes through the state, not as a second prop: it is both
  // this dropdown's options and the whitelist `useBrowseFilters` validates
  // `?sort=` against, and two copies of it would be two chances to disagree.
  const sorts = state.sorts
  const ratingChoices = ratingOptions(state.minRating, state.maxRating)
  // Chips only for the facets with no control of their own — a chip beside a
  // select that already shows the same value is just saying it twice.
  const activeFacets = FACETS.filter(
    (facet) => !facet.picker && state.facets[facet.key],
  )

  return (
    <div className="mb-6 space-y-3">
      {activeFacets.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {activeFacets.map((facet) => (
            <button
              key={facet.key}
              type="button"
              onClick={() => state.update(facet.key, null)}
              className="chip chip-active"
              aria-label={`Remove the ${facet.label.toLowerCase()} filter`}
            >
              <span className="font-normal opacity-70">{facet.label}</span>
              {state.facets[facet.key]}
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}

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

        {/* Only rendered where a page has fetched the list — the same reason
            the genre select above carries its active value: a control offering
            one option and a grid filtered by another is a control that lies. */}
        {(contentRatings.length > 0 || state.facets.content_rating) && (
          <select
            aria-label="Filter by content rating"
            value={state.facets.content_rating}
            onChange={(event) =>
              state.update('content_rating', event.target.value || null)
            }
            className="input h-9 w-auto py-0 text-sm"
          >
            <option value="">Any certificate</option>
            {state.facets.content_rating &&
              !contentRatings.includes(state.facets.content_rating) && (
                <option value={state.facets.content_rating}>
                  {state.facets.content_rating}
                </option>
              )}
            {contentRatings.map((rating) => (
              <option key={rating} value={rating}>
                {rating}
              </option>
            ))}
          </select>
        )}

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

/**
 * The page stepper, shared by every paged list.
 *
 * It also owns the out-of-range case, which is why it is mounted even when
 * there is nothing to step through. A page number in the URL can outlive the
 * results it described — a link kept from last month, a row deleted, a library
 * that shrank — and an offset past the end answers with an empty grid under a
 * "Page 9 of 3" label. Stepping back to the last real page *replaces* the
 * entry, so pressing Back does not walk straight into it again.
 *
 * `ready` gates that, and is not optional: while the first request is in
 * flight the total is zero and every page looks out of range, so clamping then
 * would throw the page away a moment before its own results arrived.
 */
export function Pagination({
  page,
  pageCount,
  onPage,
  ready,
}: {
  page: number
  pageCount: number
  onPage: PageState['setPage']
  ready: boolean
}) {
  const last = Math.max(0, pageCount - 1)

  // `onPage` closes over the current query and is rebuilt every render, so it
  // stays out of the dependency list — in it, this would re-run constantly.
  // The condition is the guard, and it stops being true the moment it acts.
  useEffect(() => {
    if (ready && page > last) onPage(last, { replace: true })
  }, [ready, page, last])

  if (pageCount <= 1) return null

  return (
    <nav className="mt-10 flex items-center justify-center gap-2" aria-label="Pagination">
      <button
        type="button"
        onClick={() => onPage(Math.max(0, page - 1))}
        disabled={page === 0}
        className="btn-outline h-9 px-3 text-sm"
      >
        Previous
      </button>
      <span className="px-3 text-sm tabular-nums text-muted">
        Page {page + 1} of {pageCount}
      </span>
      <button
        type="button"
        onClick={() => onPage(Math.min(last, page + 1))}
        disabled={page >= last}
        className="btn-outline h-9 px-3 text-sm"
      >
        Next
      </button>
    </nav>
  )
}
