import { useEffect, useState, type InputHTMLAttributes } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { PersonalFilter, WatchStatus } from '@/lib/types'
import { cn, STATUS_LABELS } from '@/lib/utils'
import { SearchIcon } from './Icons'
import { Segmented } from './ui'

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
 *
 * ## One table, everything derived from it
 *
 * Each filter is defined exactly once, in `filterTable()`. Everything else —
 * the values read out of the URL, the request payload, whether "Clear filters"
 * appears, what `clear()` removes, the chips, and the controls themselves —
 * is *derived* from that table rather than restated beside it.
 *
 * This is not tidiness. "Is any filter active" used to be a hand-written chain
 * of ORs, and it decided two things at once: whether the user is offered a way
 * to clear the filters, and whether an empty grid says "nothing matched those
 * filters" or "nothing here yet, run a sync". Forgetting to add a new filter to
 * that chain therefore produced a narrowed grid, no way to widen it, and a
 * message insisting the library was empty — a silent, compounding bug that got
 * likelier with every filter added. Derived state cannot fall out of step.
 *
 * Adding a filter means appending one entry to the table. If it needs a kind of
 * control that does not exist yet, add a `control.kind` and one branch in
 * `BrowseFilters`; nothing else in this file, and nothing in the pages.
 */

export type SortOption = { value: string; label: string }

/**
 * Sorts every browse page offers.
 *
 * "Added" is `MediaItem.created_at` — when *Tally* first recorded the title —
 * which is not the same date as the dashboard's "Recently added to Plex"
 * shelf, and that shelf orders by `max(PlexMapping.added_at)`, the date the
 * file appeared on the server. Both are useful; labelling either one plain
 * "recently added" makes them look like the same thing disagreeing.
 */
export const SORTS: readonly SortOption[] = [
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'release', label: 'Release date' },
  { value: 'added', label: 'Added to Tally' },
  { value: 'watched', label: 'Recently watched' },
  { value: 'rating', label: 'Your rating' },
]

/** The watchlist leads with when you watchlisted it, then the rest. */
export const WATCHLIST_SORTS: readonly SortOption[] = [
  { value: 'watchlist_added', label: 'Recently watchlisted' },
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'release', label: 'Release date' },
  { value: 'added', label: 'Added to Tally' },
  { value: 'watched', label: 'Recently watched' },
  { value: 'rating', label: 'Your rating' },
]

export type StatusValue = WatchStatus | 'all' | 'unwatched'

export const STATUS_FILTERS: Array<{ value: StatusValue; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'watching', label: STATUS_LABELS.watching },
  { value: 'completed', label: STATUS_LABELS.completed },
  { value: 'unwatched', label: 'Unwatched' },
  { value: 'plan_to_watch', label: STATUS_LABELS.plan_to_watch },
  { value: 'on_hold', label: STATUS_LABELS.on_hold },
  { value: 'dropped', label: STATUS_LABELS.dropped },
]

/** Your own rating, as a pair of inclusive bounds. */
export type RatingValue = { min?: number; max?: number }

/**
 * Rating shortcuts, on Plex's 0–10 scale.
 *
 * `min` alone is "this and above"; `min === max` pins an exact score, which is
 * what clicking a bar on the stats page sends.
 */
const RATING_CHOICES: Array<FilterChoice<RatingValue>> = [
  { value: {}, label: 'Any rating' },
  { value: { min: 10, max: 10 }, label: 'Rated 10 only' },
  { value: { min: 9 }, label: 'Rated 9+' },
  { value: { min: 8 }, label: 'Rated 8+' },
  { value: { min: 7 }, label: 'Rated 7+' },
  { value: { min: 5 }, label: 'Rated 5+' },
]

/** Presence on a Plex server. Tri-state, so "not on Plex" is reachable. */
export type PlexPresence = 'all' | 'true' | 'false'

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
  year?: number
  favorites?: true
  on_plex?: boolean
  personal?: PersonalFilter
  sort: string
  order: 'asc' | 'desc'
}

/** Every filter, and the type of the value it holds. */
export interface FilterValues {
  q: string
  status: StatusValue
  genre: string
  content_rating: string
  studio: string
  director: string
  rating: RatingValue
  year: number | null
  favorites: boolean
  on_plex: PlexPresence
  personal: PersonalFilter
  sort: string
  order: 'asc' | 'desc'
}

export type FilterKey = keyof FilterValues

/** One choice a select or segmented control offers. */
export interface FilterChoice<V> {
  value: V
  label: string
}

/** Whatever the page fetched for the selects that offer real library values. */
export interface FilterLists {
  genres: string[]
  contentRatings: string[]
}

/** The rest of the query, for the two filters whose default depends on it. */
export interface FilterCtx {
  params: URLSearchParams
}

/**
 * How a filter renders.
 *
 * `none` is not "no control" in the sense of unreachable — those filters are
 * arrived at by clicking a facet on an item page and appear as a removable
 * chip. A library holds a dozen certificates but hundreds of studios and
 * thousands of directors, and a select is not a way to find one name in a
 * thousand.
 */
export type FilterControl =
  | { kind: 'search'; placeholder: string }
  | { kind: 'chips' }
  | { kind: 'select'; lists?: keyof FilterLists }
  | { kind: 'segmented'; caption: string }
  | { kind: 'toggle'; on: string }
  | { kind: 'number'; placeholder: string; min?: number; max?: number }
  | { kind: 'none' }

/**
 * One filter, defined once.
 *
 * `read` and `write` are inverses over the query string, and `write` is what
 * makes "a default never survives into the URL" automatic: it answers `null`
 * for a value equal to this page's own default, and `null` means *remove this
 * parameter*. Everything derived from the table — `active`, the request, the
 * chips — asks `write` rather than keeping its own opinion.
 */
export interface FilterDef<V> {
  key: FilterKey
  /** The query parameters this filter owns. Rating owns two. */
  params: readonly string[]
  /** Names it on a chip and in the control's accessible label. */
  label: string
  /**
   * What this filter is for, which decides two behaviours nothing else can
   * infer:
   *
   * - `filter` narrows the grid, so it counts towards "Clear filters" and
   *   towards the empty state saying "nothing matched those filters".
   * - `view` changes the ordering, not the set. Clear resets it, but a sort is
   *   not something a user needs rescuing from.
   * - `search` is navigation rather than a filter: Clear keeps it, so it can
   *   never be the reason Clear is offered.
   */
  role: 'filter' | 'view' | 'search'
  /** Untrusted input: anything unrecognised falls back to the page default. */
  read: (ctx: FilterCtx) => V
  /** The URL form. A parameter mapped to `null` is removed. */
  write: (value: V, ctx: FilterCtx) => Record<string, string | null>
  /** The filter's contribution to the request. */
  toQuery: (value: V) => Partial<FilterQuery>
  control: FilterControl
  /** The choices a select or segmented control offers. */
  choices?: (lists: FilterLists) => Array<FilterChoice<V>>
  /**
   * Names a value that is not among `choices`.
   *
   * Clicking a bar on the stats page can pin any exact score, and a genre
   * filter can be in force before the genre list has finished loading. A
   * control offering one option while the grid is filtered by another is a
   * control that lies, so the odd value out is appended to the list rather
   * than leaving the control showing "Any".
   */
  describe?: (value: V) => string
  /** Chip text, for a filter with no control of its own. */
  chip?: (value: V) => string | null
}

/**
 * The table with its value types erased.
 *
 * Each definition below is checked against its own value type where it is
 * written; iterating a heterogeneous collection of them is what needs the
 * escape hatch, and it is confined to this alias.
 */
type AnyFilterDef = FilterDef<any>

export type FilterTable = { [K in FilterKey]: FilterDef<FilterValues[K]> }

/** What a page brings to the table: its sorts, and any default of its own. */
export interface FilterPage {
  /** The sorts this page offers — the dropdown's options and the whitelist. */
  sorts: readonly SortOption[]
  defaultSort: string
  /**
   * Overrides the general direction rule, and applies only while the page is
   * still on its own default sort — the watchlist opens oldest first because it
   * is a queue, but switching it to Year should mean the same newest-first that
   * Year means everywhere else.
   */
  defaultOrder?: 'asc' | 'desc'
  /**
   * Starting values that differ from the shared ones.
   *
   * Search and the all-titles grid promise everything, so they start with home
   * videos shown; the grids that name a category leave them out. A page default
   * is still a default — it never appears in the URL.
   */
  defaults?: Partial<FilterValues>
}

/** A plain string parameter: present or not. */
function textFilter(
  key: FilterKey,
  label: string,
  control: FilterControl,
  extra: Partial<FilterDef<string>> = {},
): FilterDef<string> {
  return {
    key,
    params: [key],
    label,
    role: 'filter',
    read: ({ params }) => params.get(key) ?? '',
    write: (value) => ({ [key]: value.trim() || null }),
    toQuery: (value) => (value ? ({ [key]: value } as Partial<FilterQuery>) : {}),
    control,
    describe: (value) => value,
    ...extra,
  }
}

/**
 * A rating bound from the URL, or nothing.
 *
 * The bounds are declared `ge=0, le=10` on the API, so a value outside that
 * range is not a narrower filter — it is a 422 and an error card where the
 * grid should be. Anything unreadable or out of range means "no bound", which
 * is the one answer that always shows the user something.
 */
const ratingBound = (raw: string | null): number | undefined => {
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 10) return undefined
  return value
}

/** The sort in force, checked against what this page actually offers. */
const readSort = (params: URLSearchParams, page: FilterPage): string => {
  const raw = params.get('sort')
  return page.sorts.some((option) => option.value === raw)
    ? (raw as string)
    : page.defaultSort
}

/** Titles read A–Z; everything else is a recency or a score, top end first. */
const directionFor = (sort: string, page: FilterPage): 'asc' | 'desc' =>
  sort === page.defaultSort && page.defaultOrder
    ? page.defaultOrder
    : sort === 'title'
      ? 'asc'
      : 'desc'

/**
 * Every filter the browse pages share, built for one page's defaults.
 *
 * Order matters twice: it is the order the controls appear in, and `sort` must
 * come before `order`, whose own default is a function of the current sort.
 */
export function filterTable(page: FilterPage): FilterTable {
  const fallback = <K extends FilterKey>(key: K, shared: FilterValues[K]) =>
    (page.defaults?.[key] ?? shared) as FilterValues[K]

  const personalDefault = fallback('personal', 'exclude')

  return {
    q: {
      key: 'q',
      params: ['q'],
      label: 'Search',
      // Navigation, not a filter: clearing the filters must not also throw
      // away what the user searched for.
      role: 'search',
      read: ({ params }) => params.get('q') ?? '',
      write: (value) => ({ q: value.trim() || null }),
      toQuery: (value) => (value ? { q: value } : {}),
      control: { kind: 'search', placeholder: 'Search these titles…' },
    },

    status: {
      key: 'status',
      params: ['status'],
      label: 'Status',
      role: 'filter',
      read: ({ params }) => {
        const raw = params.get('status')
        return STATUS_FILTERS.some((option) => option.value === raw)
          ? (raw as StatusValue)
          : 'all'
      },
      write: (value) => ({ status: value === 'all' ? null : value }),
      toQuery: (value) =>
        value === 'all'
          ? {}
          : value === 'unwatched'
            ? { unwatched: true }
            : { watch_status: value },
      control: { kind: 'chips' },
      choices: () => STATUS_FILTERS,
    },

    genre: textFilter(
      'genre',
      'Genre',
      { kind: 'select', lists: 'genres' },
      {
        choices: (lists) => [
          { value: '', label: 'All genres' },
          ...lists.genres.map((name) => ({ value: name, label: name })),
        ],
      },
    ),

    content_rating: textFilter(
      'content_rating',
      'Rated',
      { kind: 'select', lists: 'contentRatings' },
      {
        choices: (lists) => [
          { value: '', label: 'Any certificate' },
          ...lists.contentRatings.map((name) => ({ value: name, label: name })),
        ],
      },
    ),

    // Reached by clicking the value on an item page. Named in a chip so
    // whatever is narrowing the grid is still visible and still undoable.
    studio: textFilter('studio', 'Studio', { kind: 'none' }, {
      chip: (value) => value || null,
    }),
    director: textFilter('director', 'Director', { kind: 'none' }, {
      chip: (value) => value || null,
    }),

    rating: {
      key: 'rating',
      params: ['min_rating', 'max_rating'],
      label: 'Your rating',
      role: 'filter',
      read: ({ params }) => ({
        min: ratingBound(params.get('min_rating')),
        max: ratingBound(params.get('max_rating')),
      }),
      write: ({ min, max }) => ({
        min_rating: min == null ? null : String(min),
        max_rating: max == null ? null : String(max),
      }),
      toQuery: ({ min, max }) => ({ min_rating: min, max_rating: max }),
      control: { kind: 'select' },
      choices: () => RATING_CHOICES,
      describe: ({ min, max }) =>
        min != null && min === max
          ? `Rated ${min} only`
          : min != null && max != null
            ? `Rated ${min}–${max}`
            : min != null
              ? `Rated ${min}+`
              : `Rated up to ${max}`,
    },

    year: {
      key: 'year',
      params: ['year'],
      label: 'Year',
      role: 'filter',
      read: ({ params }) => {
        const value = Number(params.get('year'))
        // A URL is typed and truncated by hand. Anything that is not a real
        // year is no filter at all, which is the answer that still shows
        // something rather than a 422.
        if (!Number.isInteger(value) || value < 1870 || value > 2999) return null
        return value
      },
      write: (value) => ({ year: value == null ? null : String(value) }),
      toQuery: (value) => (value == null ? {} : { year: value }),
      control: { kind: 'number', placeholder: 'Year', min: 1870, max: 2999 },
    },

    favorites: {
      key: 'favorites',
      params: ['favorites'],
      label: 'Favourites',
      role: 'filter',
      read: ({ params }) => params.get('favorites') === 'true',
      write: (value) => ({ favorites: value ? 'true' : null }),
      toQuery: (value) => (value ? { favorites: true } : {}),
      control: { kind: 'toggle', on: '★ Favourites' },
    },

    on_plex: {
      key: 'on_plex',
      params: ['on_plex'],
      label: 'Availability',
      role: 'filter',
      read: ({ params }) => {
        const raw = params.get('on_plex')
        return raw === 'true' || raw === 'false' ? raw : 'all'
      },
      write: (value) => ({ on_plex: value === 'all' ? null : value }),
      toQuery: (value) => (value === 'all' ? {} : { on_plex: value === 'true' }),
      control: { kind: 'segmented', caption: 'On Plex' },
      choices: () => [
        { value: 'all', label: 'Any' },
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' },
      ],
    },

    personal: {
      key: 'personal',
      params: ['personal'],
      label: 'Home videos',
      role: 'filter',
      read: ({ params }) => {
        const raw = params.get('personal')
        return raw === 'all' || raw === 'only' || raw === 'exclude'
          ? raw
          : personalDefault
      },
      write: (value) => ({ personal: value === personalDefault ? null : value }),
      // Always sent, default included: the API's own default is `exclude`, and
      // a page that shows everything has to say so rather than rely on it.
      toQuery: (value) => ({ personal: value }),
      control: { kind: 'segmented', caption: 'Home videos' },
      choices: () => [
        { value: 'exclude', label: 'Hidden' },
        { value: 'all', label: 'Shown' },
        { value: 'only', label: 'Only' },
      ],
    },

    sort: {
      key: 'sort',
      params: ['sort'],
      label: 'Sort by',
      role: 'view',
      read: ({ params }) => {
        // `sort` is a Literal on the API, so a stale or mistyped value is a 422
        // and an error card where the grid should be.
        const raw = params.get('sort')
        return page.sorts.some((option) => option.value === raw)
          ? (raw as string)
          : page.defaultSort
      },
      write: (value) => ({ sort: value === page.defaultSort ? null : value }),
      toQuery: (value) => ({ sort: value }),
      control: { kind: 'select' },
      choices: () => page.sorts.map((option) => ({ ...option })),
      describe: (value) => value,
    },

    order: {
      key: 'order',
      params: ['order'],
      label: 'Direction',
      role: 'view',
      read: ({ params }) => {
        const raw = params.get('order')
        if (raw === 'asc' || raw === 'desc') return raw
        return directionFor(readSort(params, page), page)
      },
      // The natural direction for the *current* sort is the default, so it is
      // the one that never reaches the URL. Which is why this entry comes after
      // `sort` — re-canonicalising reads the sort that was just written.
      write: (value, { params }) => ({
        order: value === directionFor(readSort(params, page), page) ? null : value,
      }),
      toQuery: (value) => ({ order: value }),
      control: { kind: 'none' },
    },
  }
}

/** Writes one filter's value into a query string, removing what it defaults to. */
function applyWrite(
  next: URLSearchParams,
  def: AnyFilterDef,
  value: unknown,
  ctx: FilterCtx,
) {
  for (const [param, written] of Object.entries(def.write(value, ctx))) {
    if (written === null || written === '') next.delete(param)
    else next.set(param, written)
  }
}

/** Does this filter put anything in the URL — i.e. is it narrowing the grid? */
const isSet = (def: AnyFilterDef, value: unknown, ctx: FilterCtx): boolean =>
  Object.values(def.write(value, ctx)).some((written) => written !== null && written !== '')

/** A stable identity for a value, so a select can match one without `===`. */
const identity = (def: AnyFilterDef, value: unknown, ctx: FilterCtx): string =>
  JSON.stringify(def.write(value, ctx))

/**
 * The choices a control offers, plus the active value when it is not one of
 * them. See `FilterDef.describe` for why that matters.
 */
export function choicesFor(
  def: AnyFilterDef,
  value: unknown,
  lists: FilterLists,
  ctx: FilterCtx,
): Array<FilterChoice<unknown>> {
  const base = def.choices?.(lists) ?? []
  if (!isSet(def, value, ctx)) return base
  const here = identity(def, value, ctx)
  if (base.some((choice) => identity(def, choice.value, ctx) === here)) return base
  return [...base, { value, label: def.describe?.(value) ?? String(value) }]
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

export interface BrowseFilterState extends PageState {
  /** Every filter's current value, keyed as the table defines it. */
  values: FilterValues
  /** The table this page is running. The controls render from it. */
  table: FilterTable
  /** The sorts this page offers — the dropdown's options and the whitelist. */
  sorts: readonly SortOption[]
  /** True when something is narrowing the results, so "Clear" is worth showing. */
  active: boolean
  /** Sets one filter, by key. */
  set: <K extends FilterKey>(key: K, value: FilterValues[K]) => void
  /** Sets a parameter this table does not own — a page's own `kind`, say. */
  update: (key: string, value: string | null) => void
  clear: () => void
  /** The filter half of the request, ready to merge into a page's own query. */
  query: FilterQuery
}

/**
 * Filter state, held in the URL so a filtered view can be linked and survives a
 * reload. The page passes the sorts it offers, which of them it opens on, and
 * any starting value of its own.
 *
 * Every value is checked against what the API will actually accept, because a
 * URL is not trustworthy input — it is typed, truncated, edited by hand and
 * kept in bookmarks long after the page that wrote it changed. `sort`, `order`,
 * `status`, `personal` and the rating bounds are all constrained on the
 * backend, so one stale or mistyped word is a 422, and a 422 is an error card
 * where the grid should be. Anything unrecognised falls back to the page
 * default — see each `read` in the table.
 */
export function useBrowseFilters(page: FilterPage): BrowseFilterState {
  const [params, setParams] = useSearchParams()
  const { page: pageNumber, setPage } = usePageParam()

  const table = filterTable(page)
  const defs = Object.values(table) as AnyFilterDef[]
  const ctx: FilterCtx = { params }

  const values = Object.fromEntries(
    defs.map((def) => [def.key, def.read(ctx)]),
  ) as FilterValues

  /**
   * Writes a patch and normalises the whole query around it.
   *
   * A default never survives into the URL: picking the sort the page already
   * opens on says nothing, and a link that spells out every default reads as
   * noise rather than as a view someone chose. Every filter is re-canonicalised
   * on every write, so this holds for a parameter nobody touched as well as for
   * the one that changed. The page number goes too — narrowing the results
   * renumbers them, so "page 4" of the old filter is not a place that still
   * exists.
   *
   * `replace`, so refining a view does not cost a back step each time.
   */
  const commit = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key)
      else next.set(key, value)
    }
    const after: FilterCtx = { params: next }
    for (const def of defs) applyWrite(next, def, def.read(after), after)
    next.delete('page')
    setParams(next, { replace: true })
  }

  return {
    values,
    table,
    sorts: page.sorts,
    page: pageNumber,
    setPage,
    active: defs.some((def) => def.role === 'filter' && isSet(def, values[def.key], ctx)),
    set: (key, value) => commit(table[key].write(value, ctx)),
    update: (key, value) => commit({ [key]: value }),
    clear: () => {
      const kept = new URLSearchParams()
      for (const def of defs) {
        if (def.role !== 'search') continue
        applyWrite(kept, def, values[def.key], ctx)
      }
      setParams(kept, { replace: true })
    },
    query: Object.assign(
      {},
      ...defs.map((def) => def.toQuery(values[def.key])),
    ) as FilterQuery,
  }
}

/**
 * A text or number input that reaches the URL a beat after you stop typing.
 *
 * Filtering replaces rather than pushes, so keystrokes cost no history
 * entries — but they would each cost a request, and a grid that reflows on
 * every letter is hard to read. The local draft is what makes typing feel
 * immediate; the URL is still the only place the value actually lives, so a
 * change from anywhere else (Clear, a link, the back button) resets the draft.
 */
function DraftInput({
  value,
  onCommit,
  className,
  ...rest
}: {
  value: string
  onCommit: (value: string) => void
  className?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value)

  useEffect(() => setDraft(value), [value])

  useEffect(() => {
    if (draft === value) return
    const timer = setTimeout(() => onCommit(draft), 250)
    return () => clearTimeout(timer)
    // `onCommit` closes over the current query and is rebuilt every render, so
    // it stays out of the dependency list — in it, the timer would restart on
    // every render and never fire.
  }, [draft, value])

  return (
    <input
      {...rest}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      className={className}
    />
  )
}

/** A select over a filter's choices, rendered by index so any value type works. */
function ChoiceSelect({
  def,
  value,
  lists,
  ctx,
  onPick,
  className,
}: {
  def: AnyFilterDef
  value: unknown
  lists: FilterLists
  ctx: FilterCtx
  onPick: (value: unknown) => void
  className?: string
}) {
  const choices = choicesFor(def, value, lists, ctx)
  const here = identity(def, value, ctx)
  const selected = choices.findIndex((choice) => identity(def, choice.value, ctx) === here)

  return (
    <select
      aria-label={def.label}
      value={selected < 0 ? 0 : selected}
      onChange={(event) => onPick(choices[Number(event.target.value)]?.value)}
      className={className}
    >
      {choices.map((choice, index) => (
        <option key={choice.label} value={index}>
          {choice.label}
        </option>
      ))}
    </select>
  )
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
  const [params] = useSearchParams()
  const ctx: FilterCtx = { params }
  const lists: FilterLists = { genres, contentRatings }
  const defs = Object.values(state.table) as AnyFilterDef[]
  const set = (def: AnyFilterDef, value: unknown) =>
    state.set(def.key, value as never)

  // Chips only for the filters with no control of their own — a chip beside a
  // select that already shows the same value is just saying it twice.
  const chips = defs.flatMap((def) => {
    const text = def.chip?.(state.values[def.key])
    return text ? [{ def, text }] : []
  })
  const statusDef = state.table.status
  const inline = defs.filter(
    (def) => def.control.kind !== 'none' && def.control.kind !== 'chips',
  )

  return (
    <div className="mb-6 space-y-3">
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map(({ def, text }) => (
            <button
              key={def.key}
              type="button"
              onClick={() => set(def, '')}
              className="chip chip-active"
              aria-label={`Remove the ${def.label.toLowerCase()} filter`}
            >
              <span className="font-normal opacity-70">{def.label}</span>
              {text}
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
            onClick={() => set(statusDef, filter.value)}
            className={cn(
              'chip shrink-0',
              state.values.status === filter.value && 'chip-active',
            )}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {inline.map((def) => {
          const value = state.values[def.key]

          switch (def.control.kind) {
            case 'search':
              return (
                <div key={def.key} className="relative w-full sm:w-56">
                  <SearchIcon
                    className="pointer-events-none absolute left-3 top-1/2
                               -translate-y-1/2 text-base text-muted"
                  />
                  <DraftInput
                    type="search"
                    value={value as string}
                    onCommit={(next) => set(def, next)}
                    placeholder={def.control.placeholder}
                    aria-label={def.label}
                    className="input h-9 py-0 pl-9 text-sm"
                  />
                </div>
              )

            case 'number':
              return (
                <DraftInput
                  key={def.key}
                  type="number"
                  inputMode="numeric"
                  min={def.control.min}
                  max={def.control.max}
                  value={value == null ? '' : String(value)}
                  onCommit={(next) => {
                    // Half a year is neither a filter nor a request to clear
                    // one. Committing it would write nothing to the URL, the
                    // draft would be reset from the URL, and "19…" would erase
                    // itself under the user mid-number. Only an empty box
                    // clears the filter.
                    const parsed = Number(next)
                    const control = def.control as Extract<
                      FilterControl,
                      { kind: 'number' }
                    >
                    if (next === '') set(def, null)
                    else if (
                      Number.isInteger(parsed) &&
                      parsed >= (control.min ?? -Infinity) &&
                      parsed <= (control.max ?? Infinity)
                    ) {
                      set(def, parsed)
                    }
                  }}
                  placeholder={def.control.placeholder}
                  aria-label={def.label}
                  className="input h-9 w-24 py-0 text-sm"
                />
              )

            case 'toggle':
              return (
                <button
                  key={def.key}
                  type="button"
                  aria-pressed={Boolean(value)}
                  onClick={() => set(def, !value)}
                  className={cn('chip shrink-0', Boolean(value) && 'chip-active')}
                >
                  {def.control.on}
                </button>
              )

            case 'segmented':
              return (
                <span key={def.key} className="inline-flex items-center gap-2">
                  <span className="text-xs text-muted">{def.control.caption}</span>
                  <Segmented
                    label={def.label}
                    value={String(value)}
                    onChange={(next) => set(def, next)}
                    options={(def.choices?.(lists) ?? []).map((choice) => ({
                      value: String(choice.value),
                      label: choice.label,
                    }))}
                  />
                </span>
              )

            case 'select':
              // A select whose choices come from the library is only worth
              // showing once there are some — or when one is already in force,
              // which is the case that must never render an empty control.
              if (
                def.control.lists &&
                lists[def.control.lists].length === 0 &&
                !isSet(def, value, ctx)
              ) {
                return null
              }
              return (
                <ChoiceSelect
                  key={def.key}
                  def={def}
                  value={value}
                  lists={lists}
                  ctx={ctx}
                  onPick={(next) => set(def, next)}
                  className="input h-9 w-auto min-w-[7rem] py-0 text-sm"
                />
              )

            default:
              return null
          }
        })}

        <button
          type="button"
          onClick={() =>
            state.set('order', state.values.order === 'asc' ? 'desc' : 'asc')
          }
          className="btn-outline h-9 px-3 text-sm"
          title={state.values.order === 'asc' ? 'Ascending' : 'Descending'}
        >
          {state.values.order === 'asc' ? '↑' : '↓'}
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
