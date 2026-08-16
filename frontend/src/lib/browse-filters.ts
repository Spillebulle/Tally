import { useSearchParams } from 'react-router-dom'
import type {
  LibraryOption,
  PersonalFilter,
  SavedViewPage,
  ServerOption,
  WatchStatus,
} from './types'
import { localDateKey, parseLocalDateLabel, STATUS_LABELS } from './utils'

/**
 * The browse query — where it lives, and what each filter means.
 *
 * Every page that browses keeps its *whole* query in the URL: the filters, the
 * sort, the direction and the page number. That is what makes the back button
 * work. Coming back from a title used to land on page one of an unfiltered
 * grid, because the page number was component state and component state does
 * not survive a navigation; the URL does, and it can be shared and bookmarked
 * besides.
 *
 * The grid, the watchlist and the history timeline browse the same rows with
 * the same controls, so this lives in one place — the backend shares its query
 * building for the same reason. A page supplies its own sort list, its own
 * defaults, and the filters it wants left out.
 *
 * ## One table, everything derived from it
 *
 * Each filter is defined exactly once, in `filterTable()`. Everything else —
 * the values read out of the URL, the request payload, whether "Clear all"
 * appears, what `clear()` removes, the chips, which disclosure group a control
 * lands in, and the controls themselves — is *derived* from that table rather
 * than restated beside it.
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
 *
 * A facet that takes several values is one entry too — `multiFilter` — and it
 * buys the repeated parameter, the parallel `_not`, the any/all toggle where
 * AND means something, a chip per value with its own ×, and the chip group. The
 * URL carries one occurrence per value (`?genre=Crime&genre=Drama`), which is
 * backwards compatible by construction: a single occurrence parses exactly as
 * the single value it always did, so every bookmark and every facet link keeps
 * working.
 *
 * ## Saved views come free
 *
 * Because the whole query lives in the URL, "save this view" is storing the
 * query string and "recall it" is setting it back — `savedQuery` and
 * `applyView` below, both of which go through the same `normalise` every other
 * write does. There is no serialisation format, and a view saved before a
 * filter was renamed loses that parameter and falls back to the page default
 * rather than erroring, because the `read` that guards a hand-edited URL is the
 * only thing that ever interprets one. The server stores the string and does
 * not parse it; a second validator there could disagree with this one.
 *
 * The rendering half lives in `components/BrowseFilters.tsx`; the page stepper,
 * which History uses without any of this, lives in `components/Pagination.tsx`.
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

/**
 * History sorts. Fewer, because a play is not a title: "your rating" and
 * "added to Tally" order the library, not the diary, and the API's
 * `HistorySortField` accepts exactly these four.
 */
export const HISTORY_SORTS: readonly SortOption[] = [
  { value: 'watched_at', label: 'Recently watched' },
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'release', label: 'Release date' },
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

/** A pair of inclusive numeric bounds. Either half may be absent. */
export type RangeValue = { min?: number; max?: number }

/**
 * A facet that takes several values, and can refuse some.
 *
 * The URL carries one occurrence per value — `?genre=Crime&genre=Drama` — with
 * a parallel `?genre_not=` for exclusions and `?genre_mode=all` for AND.
 *
 * Repeated keys rather than a comma-separated list, because studio names
 * contain commas ("Warner Bros., Inc."), and rather than a `-Horror` prefix
 * operator, because values legitimately start with one. The real reason,
 * though, is that a single occurrence parses exactly as the single value it
 * always did: every bookmark, every facet link on an item page and every stats
 * drill keeps working without being touched.
 */
export interface MultiValue {
  include: string[]
  exclude: string[]
  /**
   * AND across `include` rather than OR.
   *
   * Only offered where a row can hold several values at once. A title has one
   * studio, one certificate and one network, so "all" over those can only ever
   * return nothing — a control that can only produce a wrong answer.
   */
  all: boolean
}

/** The values a multi filter is narrowing on, for a page title or a subtitle. */
export const namesOf = (value: MultiValue): string =>
  value.include.join(', ')

/** How far a free-text search reaches. `title` unless the user widens it. */
export type SearchScope = 'title' | 'all'

/**
 * A pair of inclusive day bounds, each a **local** `YYYY-MM-DD`.
 *
 * The URL holds days, not instants, because that is what a person picked and
 * what `<input type="date">` speaks. The request carries instants — see
 * `dateRangeFilter`, which turns the start into local midnight and the end into
 * local end-of-day.
 */
export type DateRangeValue = { from?: string; to?: string }

/** Presence on a Plex server. Tri-state, so "not on Plex" is reachable. */
export type PlexPresence = 'all' | 'true' | 'false'

/** The subset of a media/history query these controls own. */
export interface FilterQuery {
  q?: string
  /** `all` widens the search from titles to overviews and your own notes. */
  q_scope?: SearchScope
  /**
   * The repeatable facets. Each is sent as one parameter per value — the API
   * takes `?genre=Crime&genre=Drama` — which is why `api.ts` appends per
   * element rather than stringifying the array to "a,b".
   */
  genre?: string[]
  genre_not?: string[]
  genre_mode?: 'all'
  content_rating?: string[]
  content_rating_not?: string[]
  studio?: string[]
  studio_not?: string[]
  network?: string[]
  network_not?: string[]
  anime_format?: string[]
  anime_format_not?: string[]
  library_id?: string[]
  server_id?: string[]
  director?: string
  actor?: string
  release_status?: string
  watch_status?: WatchStatus
  unwatched?: true
  has_notes?: true
  in_progress?: true
  min_rating?: number
  max_rating?: number
  min_community?: number
  max_community?: number
  min_year?: number
  max_year?: number
  min_runtime?: number
  max_runtime?: number
  min_watch_count?: number
  max_watch_count?: number
  added_after?: string
  added_before?: string
  watched_after?: string
  watched_before?: string
  /** History only: the window of plays themselves, not of titles. */
  since?: string
  until?: string
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
  q_scope: SearchScope
  status: StatusValue
  genre: MultiValue
  content_rating: MultiValue
  studio: MultiValue
  network: MultiValue
  anime_format: MultiValue
  libraries: MultiValue
  servers: MultiValue
  director: string
  actor: string
  release_status: string
  rating: RangeValue
  community: RangeValue
  years: RangeValue
  runtime: RangeValue
  watch_count: RangeValue
  added: DateRangeValue
  watched: DateRangeValue
  window: DateRangeValue
  year: number | null
  favorites: boolean
  has_notes: boolean
  in_progress: boolean
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

/** Whatever the page fetched for the controls that offer real library values. */
export interface FilterLists {
  genres: string[]
  contentRatings: string[]
  /** From `/api/media/places` — only the servers this account can see. */
  libraries: LibraryOption[]
  servers: ServerOption[]
}

/** An empty set of lists, for a caller that has not fetched them (or any). */
export const NO_LISTS: FilterLists = {
  genres: [],
  contentRatings: [],
  libraries: [],
  servers: [],
}

/** The rest of the query, for the filters whose default depends on it. */
export interface FilterCtx {
  params: URLSearchParams
}

/** A query string with nothing in it, for asking a filter what its default is. */
const NO_PARAMS: FilterCtx = { params: new URLSearchParams() }

/**
 * Which panel a control belongs to, once there are too many to sit flat.
 *
 * A filter with no group stays on the bar itself: status, genre, sort, order
 * and search are the ones people reach for constantly, and burying those behind
 * a disclosure would cost a click on every visit to save one on a rare one.
 */
export type FilterGroup = 'title' | 'you' | 'library'

export const FILTER_GROUPS: Array<{ id: FilterGroup; label: string; hint: string }> = [
  { id: 'title', label: 'Title', hint: 'What the thing is' },
  { id: 'you', label: 'You', hint: 'What you did with it' },
  { id: 'library', label: 'Library', hint: 'Where it lives' },
]

/**
 * How a filter renders.
 *
 * `none` is not "no control" in the sense of unreachable — those filters are
 * arrived at by clicking a facet on an item page and appear as a removable
 * chip. A library holds a dozen certificates but hundreds of studios,
 * networks and directors; a select is not a way to find one name in a
 * thousand, and a free-text box would be worse, because the backend matches
 * these exactly and a near-miss spelling answers with an empty grid rather
 * than with "no such studio".
 */
export type FilterControl =
  | { kind: 'search'; placeholder: string }
  | { kind: 'chips' }
  | { kind: 'select'; lists?: keyof FilterLists }
  | {
      /**
       * A chip per value, cycling off → include → exclude → off.
       *
       * A `<select multiple>` is unusable — it needs a modifier key nobody
       * discovers, it drops the whole selection on a stray click, and it cannot
       * say "not this" at all. Chips are the vocabulary this app already has,
       * and they hold three states legibly.
       */
      kind: 'multi'
      /**
       * Hide the control below this many options, unless one is already set.
       *
       * A picker offering one library is a control that cannot change the
       * answer. Two is the point at which it becomes a choice.
       */
      minOptions?: number
      /** Offer the any/all toggle. Set by `multiFilter` from the same flag. */
      andable?: boolean
    }
  | { kind: 'segmented'; caption: string }
  | { kind: 'toggle'; on: string }
  | { kind: 'daterange'; caption: string }
  | { kind: 'none' }

/** One chip in the row: what it says, and what removing it leaves behind. */
export interface FilterChipDef<V> {
  text: string
  /** The value to write when the × is pressed. */
  next: V
}

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
  /** The query parameters this filter owns. A range owns two. */
  params: readonly string[]
  /** Names it on a chip and in the control's accessible label. */
  label: string
  /**
   * What this filter is for, which decides two behaviours nothing else can
   * infer:
   *
   * - `filter` narrows the grid, so it counts towards "Clear all", earns a
   *   chip, and makes the empty state say "nothing matched those filters".
   * - `view` changes the ordering, not the set. Clear resets it, but a sort is
   *   not something a user needs rescuing from.
   * - `search` is navigation rather than a filter: Clear keeps it, so it can
   *   never be the reason Clear is offered.
   */
  role: 'filter' | 'view' | 'search'
  /** Which disclosure group holds the control. Absent means "on the bar". */
  group?: FilterGroup
  /** Untrusted input: anything unrecognised falls back to the page default. */
  read: (ctx: FilterCtx) => V
  /**
   * The URL form. A parameter mapped to `null` is removed; an array is written
   * as one occurrence per element, which is how the multi-value facets keep
   * `?genre=Crime&genre=Drama` rather than inventing a separator.
   */
  write: (value: V, ctx: FilterCtx) => Record<string, string | string[] | null>
  /** The filter's contribution to the request. */
  toQuery: (value: V) => Partial<FilterQuery>
  control: FilterControl
  /** The choices a select or segmented control offers. */
  choices?: (lists: FilterLists) => Array<FilterChoice<V>>
  /**
   * The values a *multi* control offers, one chip each.
   *
   * Separate from `choices`, which offers whole values: a chip stands for one
   * element of the value, not for the value.
   */
  options?: (lists: FilterLists) => Array<FilterChoice<string>>
  /**
   * The chips this filter contributes, when one value is not one chip.
   *
   * Each carries the value its × writes, so removing one genre from three
   * leaves the other two rather than clearing the filter.
   */
  chips?: (value: V, lists: FilterLists) => Array<FilterChipDef<V>>
  /**
   * Renders only when the rest of the query makes it mean something.
   *
   * "Search in titles / everything" over an empty search box is a control with
   * no subject. Table-driven, so the rendering half still knows nothing about
   * what any particular filter means.
   */
  showWhen?: (values: FilterValues) => boolean
  /**
   * Names a value that is not among `choices`.
   *
   * Clicking a bar on the stats page can pin any exact score, a drill-down from
   * a chart can pin any date window, and a genre filter can be in force before
   * the genre list has finished loading. A control offering one option while
   * the grid is filtered by another is a control that lies, so the odd value
   * out is appended to the list rather than leaving the control showing "Any".
   * It is also what a chip says when no preset names the value.
   */
  describe?: (value: V) => string
  /** Chip text, when the value needs saying differently from `describe`. */
  chip?: (value: V) => string | null
  /**
   * The chip text already names the filter, so drop the label in front of it.
   *
   * "Favourites ★ Favourites" is what happens without this — true of every
   * on/off filter, whose whole value is the word it is labelled with.
   */
  chipBare?: boolean
}

/**
 * The table with its value types erased.
 *
 * Each definition below is checked against its own value type where it is
 * written; iterating a heterogeneous collection of them is what needs the
 * escape hatch, and it is confined to this alias.
 */
export type AnyFilterDef = FilterDef<any>

export type FilterTable = { [K in FilterKey]: FilterDef<FilterValues[K]> }

/** What a page brings to the table: its sorts, its defaults, its omissions. */
export interface FilterPage {
  /**
   * Which browse surface this is, for the saved views.
   *
   * The *filter surface*, not the route: all five Browse modes share one set of
   * filters and one set of sorts, so they share one shelf of views, while the
   * watchlist and History each have their own. Required rather than optional,
   * so a browse page added later cannot silently inherit another page's views —
   * a view naming `watchlist_added` would be a stale sort on the grid.
   */
  id: SavedViewPage
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
  /**
   * Filters this page does not have. Omitted means *absent*, not hidden: the
   * parameter is never read, never written and never sent, so a stale one in
   * the URL cannot quietly narrow a page that offers no way to see it.
   *
   * History omits `status`, because everything there has a play — "unwatched"
   * returns nothing and a watch status returns almost everything. The grids
   * omit `window`, whose `since`/`until` filter plays rather than titles.
   */
  omit?: readonly FilterKey[]
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
 * A facet that takes several values, refuses some, and optionally ANDs them.
 *
 * One entry buys the whole set: the repeated parameter, the parallel `_not`,
 * the `_mode` toggle where AND means something, a chip per value with its own
 * ×, the chip group that offers the library's real values, and the request.
 * The URL is the only place any of it lives.
 */
function multiFilter(
  key: FilterKey,
  /** The query parameter, which is not always the key: `libraries` → `library_id`. */
  param: string,
  label: string,
  extra: {
    group?: FilterGroup
    control?: FilterControl
    /** Offer the any/all toggle. Only true where a row can hold several values. */
    andable?: boolean
    options?: (lists: FilterLists) => Array<FilterChoice<string>>
    /** Untrusted input: a value this rejects is dropped, not sent. */
    valid?: (raw: string) => boolean
  } = {},
): FilterDef<MultiValue> {
  const { andable, options, valid } = extra
  const notParam = `${param}_not`
  const modeParam = `${param}_mode`
  const labelFor = (value: string, lists: FilterLists) =>
    options?.(lists).find((choice) => choice.value === value)?.label ?? value

  /** Trim, drop the empties a hand-edited URL leaves, and de-duplicate. */
  const clean = (raw: string[]): string[] => {
    const out: string[] = []
    for (const entry of raw) {
      const value = entry.trim()
      if (!value || out.includes(value)) continue
      if (valid && !valid(value)) continue
      out.push(value)
    }
    return out
  }

  return {
    key,
    params: andable ? [param, notParam, modeParam] : [param, notParam],
    label,
    role: 'filter',
    group: extra.group,
    read: ({ params }) => {
      const include = clean(params.getAll(param))
      return {
        include,
        exclude: clean(params.getAll(notParam)),
        // "All" of one value is the same set as "any" of it, so the mode is
        // not a filter yet — and a default must never survive into the URL.
        all:
          Boolean(andable) && include.length > 1 && params.get(modeParam) === 'all',
      }
    },
    write: ({ include, exclude, all }) => ({
      [param]: include,
      [notParam]: exclude,
      ...(andable
        ? { [modeParam]: all && include.length > 1 ? 'all' : null }
        : {}),
    }),
    toQuery: ({ include, exclude, all }) =>
      ({
        [param]: include.length ? include : undefined,
        [notParam]: exclude.length ? exclude : undefined,
        ...(andable && all && include.length > 1 ? { [modeParam]: 'all' } : {}),
      }) as Partial<FilterQuery>,
    // `andable` is declared once, here, and the control carries it so the
    // rendering half can offer the toggle without knowing which filter it is.
    control:
      extra.control?.kind === 'multi'
        ? { ...extra.control, andable: Boolean(andable) }
        : (extra.control ?? { kind: 'none' }),
    options,
    chips: (value, lists) => [
      ...value.include.map((name) => ({
        text: labelFor(name, lists),
        next: { ...value, include: value.include.filter((v) => v !== name) },
      })),
      ...value.exclude.map((name) => ({
        // Reads as "Genre not Horror" once the chip's label is in front of it.
        text: `not ${labelFor(name, lists)}`,
        next: { ...value, exclude: value.exclude.filter((v) => v !== name) },
      })),
    ],
    describe: (value) => value.include.join(', '),
  }
}

/** A boolean parameter, written only when true. */
function boolFilter(
  key: FilterKey,
  label: string,
  on: string,
  extra: Partial<FilterDef<boolean>> = {},
): FilterDef<boolean> {
  return {
    key,
    params: [key],
    label,
    role: 'filter',
    read: ({ params }) => params.get(key) === 'true',
    write: (value) => ({ [key]: value ? 'true' : null }),
    toQuery: (value) => (value ? ({ [key]: true } as Partial<FilterQuery>) : {}),
    control: { kind: 'toggle', on },
    describe: () => on,
    chipBare: true,
    ...extra,
  }
}

/**
 * One end of a numeric range, read from the URL.
 *
 * Every one of these bounds is declared with `ge`/`le` on the API, so a value
 * outside the range is not a narrower filter — it is a 422 and an error card
 * where the grid should be. Anything unreadable or out of range means "no
 * bound", which is the one answer that always shows the user something.
 */
const numericBound = (
  raw: string | null,
  min: number,
  max: number,
  integer: boolean,
): number | undefined => {
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) return undefined
  if (integer && !Number.isInteger(value)) return undefined
  return value
}

/** The default phrasing for a range, e.g. "90–120 min", "8/10 and up". */
const describeRange =
  (unit = '') =>
  ({ min, max }: RangeValue): string => {
    if (min != null && max != null) {
      return min === max ? `${min}${unit}` : `${min}–${max}${unit}`
    }
    if (min != null) return `${min}${unit} and up`
    return `up to ${max}${unit}`
  }

/**
 * A pair of `min_*` / `max_*` parameters behind one select of presets.
 *
 * Two raw number boxes are the obvious shape and the wrong one: nobody wants to
 * type 1990 and 1999 to mean "the nineties", and half-typed numbers fight the
 * debounce. Presets cover what people actually ask for, and `describe` keeps
 * the control honest when a link pins something the presets do not offer.
 */
function rangeFilter(
  key: FilterKey,
  paramNames: readonly [string, string],
  label: string,
  bounds: { min: number; max: number; integer?: boolean },
  anyLabel: string,
  presets: Array<FilterChoice<RangeValue>>,
  extra: Partial<FilterDef<RangeValue>> = {},
): FilterDef<RangeValue> {
  const [lo, hi] = paramNames
  const integer = bounds.integer ?? true
  return {
    key,
    params: paramNames,
    label,
    role: 'filter',
    read: ({ params }) => ({
      min: numericBound(params.get(lo), bounds.min, bounds.max, integer),
      max: numericBound(params.get(hi), bounds.min, bounds.max, integer),
    }),
    write: ({ min, max }) => ({
      [lo]: min == null ? null : String(min),
      [hi]: max == null ? null : String(max),
    }),
    toQuery: ({ min, max }) => ({ [lo]: min, [hi]: max }) as Partial<FilterQuery>,
    control: { kind: 'select' },
    choices: () => [{ value: {}, label: anyLabel }, ...presets],
    describe: describeRange(),
    ...extra,
  }
}

/**
 * A day the URL named, as a local `YYYY-MM-DD`, or nothing.
 *
 * Accepts a bare day (what these controls write) and a full instant (what a
 * chart drill-down may hand over), because a URL is untrusted input and both
 * shapes are plausible arrivals. An instant is resolved in the *viewer's* zone
 * — `?since=2026-08-14T22:00:00Z` is the 15th in Oslo, and the chip has to say
 * the day the reader is looking at.
 *
 * Never `new Date('YYYY-MM-DD')`: that is parsed as UTC midnight by spec, so it
 * formats as the previous day for everyone west of Greenwich.
 */
const dayBound = (raw: string | null): string | undefined => {
  if (!raw) return undefined
  if (raw.includes('T')) {
    const instant = new Date(raw)
    return Number.isNaN(instant.getTime()) ? undefined : localDateKey(instant)
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) return undefined
  const key = match[0]
  // Round-trip check: "2026-02-31" would roll forward to 3 March, which is not
  // the day the URL named, and a filter must never mean something the user did
  // not write.
  return localDateKey(parseLocalDateLabel(key)) === key ? key : undefined
}

/**
 * The instants a day range means, built in the viewer's own zone.
 *
 * The start is local midnight and the end is local end-of-day, so "14–20 Aug"
 * contains every play on the 20th rather than stopping at its first second.
 * `toISOString` here converts a Date that was *built* locally into the instant
 * it denotes, which is exactly what it is for — the banned use is deriving a
 * local day key from it, which `localDateKey` does instead.
 */
const startOfDay = (key: string): string => parseLocalDateLabel(key).toISOString()
const endOfDay = (key: string): string => {
  const date = parseLocalDateLabel(key)
  date.setHours(23, 59, 59, 999)
  return date.toISOString()
}

/** How a day range reads in a chip: "14–20 Aug 2026", "from 1 Jan 2026". */
const describeDays = ({ from, to }: DateRangeValue): string => {
  const day = (key: string, opts: Intl.DateTimeFormatOptions) =>
    parseLocalDateLabel(key).toLocaleDateString(undefined, opts)
  const full: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }
  if (from && to) {
    if (from === to) return day(from, full)
    // Same month: say the month and year once. "14–20 Aug 2026" is what a
    // person would write, and it is what a chart's week drill-down produces.
    if (from.slice(0, 7) === to.slice(0, 7)) {
      return `${day(from, { day: 'numeric' })}–${day(to, full)}`
    }
    return `${day(from, full)} – ${day(to, full)}`
  }
  if (from) return `from ${day(from, full)}`
  return `until ${day(to as string, full)}`
}

/** A pair of date parameters behind two native date inputs. */
function dateRangeFilter(
  key: FilterKey,
  paramNames: readonly [string, string],
  label: string,
  caption: string,
  group: FilterGroup,
): FilterDef<DateRangeValue> {
  const [after, before] = paramNames
  return {
    key,
    params: paramNames,
    label,
    role: 'filter',
    group,
    read: ({ params }) => ({
      from: dayBound(params.get(after)),
      to: dayBound(params.get(before)),
    }),
    write: ({ from, to }) => ({ [after]: from ?? null, [before]: to ?? null }),
    toQuery: ({ from, to }) =>
      ({
        [after]: from ? startOfDay(from) : undefined,
        [before]: to ? endOfDay(to) : undefined,
      }) as Partial<FilterQuery>,
    control: { kind: 'daterange', caption },
    describe: describeDays,
  }
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

    /**
     * How far the search reaches: titles, or titles plus overviews and your
     * own notes.
     *
     * `title` stays the default deliberately — an ordinary search that starts
     * matching plot summaries returns half the library for "murder". It is
     * part of the search rather than a filter, so "Clear all" keeps it, and it
     * only appears once there is a search term for it to widen.
     */
    q_scope: {
      key: 'q_scope',
      params: ['q_scope'],
      label: 'Search in',
      role: 'search',
      read: ({ params }) => (params.get('q_scope') === 'all' ? 'all' : 'title'),
      write: (value) => ({ q_scope: value === 'all' ? 'all' : null }),
      toQuery: (value) => (value === 'all' ? { q_scope: 'all' } : {}),
      control: { kind: 'segmented', caption: 'Search in' },
      choices: () => [
        { value: 'title', label: 'Titles' },
        { value: 'all', label: 'Everything' },
      ],
      showWhen: (values) => Boolean(values.q),
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

    /**
     * The one facet where "all of these" is a real question — a title carries
     * several genres, so Crime *and* Drama names a smaller set than either.
     *
     * It stays on the bar rather than behind the disclosure, in its own
     * horizontally-scrolling row like the status chips: it is the filter people
     * reach for constantly, and the chips put the selected ones first so the
     * active state is visible without scrolling.
     */
    genre: multiFilter('genre', 'genre', 'Genre', {
      control: { kind: 'multi' },
      andable: true,
      options: (lists) => lists.genres.map((name) => ({ value: name, label: name })),
    }),

    content_rating: multiFilter('content_rating', 'content_rating', 'Certificate', {
      group: 'title',
      control: { kind: 'multi' },
      options: (lists) =>
        lists.contentRatings.map((name) => ({ value: name, label: name })),
    }),

    // Reached by clicking the value on an item page: a library holds a dozen
    // certificates but hundreds of studios and networks, and a chip group is
    // not a way to find one name in a thousand. Each value still gets a chip,
    // so whatever is narrowing the grid is visible and undoable — and they
    // carry a group anyway, so a control that ever becomes offerable lands in
    // the right panel without a second edit.
    studio: multiFilter('studio', 'studio', 'Studio', { group: 'title' }),
    network: multiFilter('network', 'network', 'Network', { group: 'title' }),

    director: textFilter('director', 'Director', { kind: 'none' }, {
      group: 'title',
      chip: (value) => value || null,
    }),
    /**
     * The other half of a credit list, and the same shape as `director`.
     *
     * Sparse today on purpose rather than by oversight: credits are fetched
     * when somebody opens a detail page, so only titles that have been looked
     * at carry any. What is recorded matches exactly; what is missing has
     * simply never been fetched.
     */
    actor: textFilter('actor', 'Actor', { kind: 'none' }, {
      group: 'title',
      chip: (value) => value || null,
    }),

    release_status: textFilter(
      'release_status',
      'Release status',
      { kind: 'select' },
      {
        group: 'title',
        // Stored lower-cased by the providers (`tmdb.py`, `tvdb.py`), so the
        // value is the provider's word and only the label is presentable.
        choices: () => [
          { value: '', label: 'Any status' },
          { value: 'released', label: 'Released' },
          { value: 'returning series', label: 'Returning' },
          { value: 'ended', label: 'Ended' },
          { value: 'canceled', label: 'Cancelled' },
          { value: 'in production', label: 'In production' },
          { value: 'planned', label: 'Planned' },
        ],
      },
    ),

    anime_format: multiFilter('anime_format', 'anime_format', 'Format', {
      group: 'title',
      control: { kind: 'multi' },
      // Upper-cased on the way in — see `media_repo.upsert_from_plex`, which
      // is why the value is shouted and only the label is presentable.
      options: () => [
        { value: 'TV', label: 'TV series' },
        { value: 'MOVIE', label: 'Film' },
        { value: 'OVA', label: 'OVA' },
        { value: 'ONA', label: 'ONA' },
        { value: 'SPECIAL', label: 'Special' },
        { value: 'MUSIC', label: 'Music' },
      ],
    }),

    /**
     * Where the file lives.
     *
     * Both offer only what this account can see — `/api/media/places` scopes
     * itself through `UserServerAccess` — and both hide themselves below two
     * options, because a picker offering the only library there is cannot
     * change the answer.
     */
    libraries: multiFilter('libraries', 'library_id', 'Library', {
      group: 'library',
      control: { kind: 'multi', minOptions: 2 },
      valid: (raw) => /^\d+$/.test(raw),
      options: (lists) =>
        lists.libraries.map((library) => ({
          value: String(library.id),
          // A two-server household calls half its libraries "Movies".
          label:
            lists.servers.length > 1
              ? `${library.title} · ${library.server_name}`
              : library.title,
        })),
    }),

    servers: multiFilter('servers', 'server_id', 'Server', {
      group: 'library',
      control: { kind: 'multi', minOptions: 2 },
      valid: (raw) => /^\d+$/.test(raw),
      options: (lists) =>
        lists.servers.map((server) => ({
          value: String(server.id),
          label: server.name,
        })),
    }),

    /**
     * Your own rating, on Plex's 0–10 scale.
     *
     * `min` alone is "this and above"; `min === max` pins an exact score, which
     * is what clicking a bar on the stats page sends.
     */
    rating: rangeFilter(
      'rating',
      ['min_rating', 'max_rating'],
      'Your rating',
      { min: 0, max: 10, integer: false },
      'Any rating',
      [
        { value: { min: 10, max: 10 }, label: 'Rated 10 only' },
        { value: { min: 9 }, label: 'Rated 9+' },
        { value: { min: 8 }, label: 'Rated 8+' },
        { value: { min: 7 }, label: 'Rated 7+' },
        { value: { min: 5 }, label: 'Rated 5+' },
      ],
      {
        group: 'you',
        describe: ({ min, max }) =>
          min != null && min === max
            ? `Rated ${min} only`
            : min != null && max != null
              ? `Rated ${min}–${max}`
              : min != null
                ? `Rated ${min}+`
                : `Rated up to ${max}`,
      },
    ),

    /** The crowd's score, which is a different question from your own. */
    community: rangeFilter(
      'community',
      ['min_community', 'max_community'],
      'Community score',
      { min: 0, max: 10, integer: false },
      'Any score',
      [
        { value: { min: 9 }, label: '9+ community' },
        { value: { min: 8 }, label: '8+ community' },
        { value: { min: 7 }, label: '7+ community' },
        { value: { min: 6 }, label: '6+ community' },
        { value: { max: 6 }, label: 'Under 6' },
      ],
      { group: 'title', describe: describeRange('/10') },
    ),

    /**
     * Decades, not two number boxes.
     *
     * The URL contract stays `min_year` / `max_year`, so any range is
     * expressible and a link can pin one the presets do not offer — `describe`
     * then names it rather than letting the select show "Any year" over a
     * filtered grid.
     */
    years: rangeFilter(
      'years',
      ['min_year', 'max_year'],
      'Decade',
      { min: 1870, max: 2999 },
      'Any year',
      [
        { value: { min: 2020, max: 2029 }, label: '2020s' },
        { value: { min: 2010, max: 2019 }, label: '2010s' },
        { value: { min: 2000, max: 2009 }, label: '2000s' },
        { value: { min: 1990, max: 1999 }, label: '1990s' },
        { value: { min: 1980, max: 1989 }, label: '1980s' },
        { value: { min: 1970, max: 1979 }, label: '1970s' },
        { value: { max: 1969 }, label: 'Before 1970' },
      ],
      { group: 'title' },
    ),

    runtime: rangeFilter(
      'runtime',
      ['min_runtime', 'max_runtime'],
      'Runtime',
      { min: 0, max: 10000 },
      'Any length',
      [
        { value: { max: 30 }, label: '30 min or less' },
        { value: { max: 60 }, label: '60 min or less' },
        { value: { min: 60, max: 90 }, label: '60–90 min' },
        { value: { min: 90, max: 120 }, label: '90–120 min' },
        { value: { min: 120 }, label: 'Over 2 hours' },
        { value: { min: 180 }, label: 'Over 3 hours' },
      ],
      { group: 'title', describe: describeRange(' min') },
    ),

    watch_count: rangeFilter(
      'watch_count',
      ['min_watch_count', 'max_watch_count'],
      'Times watched',
      { min: 0, max: 9999 },
      'Any number of plays',
      [
        { value: { min: 1, max: 1 }, label: 'Watched once' },
        { value: { min: 2 }, label: 'Rewatched (2+)' },
        { value: { min: 3 }, label: 'Watched 3+' },
        { value: { min: 5 }, label: 'Watched 5+' },
      ],
      {
        group: 'you',
        describe: ({ min, max }) =>
          min != null && min === max
            ? `${min} play${min === 1 ? '' : 's'}`
            : min != null && max != null
              ? `${min}–${max} plays`
              : min != null
                ? `${min}+ plays`
                : `up to ${max} plays`,
      },
    ),

    added: dateRangeFilter(
      'added',
      ['added_after', 'added_before'],
      'Added',
      'Added between',
      'library',
    ),

    watched: dateRangeFilter(
      'watched',
      ['watched_after', 'watched_before'],
      'Last watched',
      'Watched between',
      'you',
    ),

    /**
     * History's own window, over the plays rather than over the titles.
     *
     * This is the receiving half of a chart drill-down: a mark on the stats
     * page links to `/history?since=…&until=…`, and without a control the
     * arriving link is a narrowed page with nothing saying why. The grids omit
     * it — `since`/`until` mean nothing to `/api/media`.
     */
    window: dateRangeFilter('window', ['since', 'until'], 'Watched', 'Watched between', 'you'),

    year: {
      key: 'year',
      params: ['year'],
      label: 'Year',
      role: 'filter',
      group: 'title',
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
      // No control of its own: the decade select covers browsing by period, and
      // an exact year is something you *arrive* at from a link or a bookmark.
      // Two year controls side by side would only raise the question of which
      // one wins.
      control: { kind: 'none' },
      chip: (value) => (value == null ? null : String(value)),
    },

    favorites: boolFilter('favorites', 'Favourites', '★ Favourites', { group: 'you' }),

    has_notes: boolFilter('has_notes', 'Notes', 'Has notes', { group: 'you' }),

    in_progress: boolFilter('in_progress', 'Progress', 'In progress', { group: 'you' }),

    on_plex: {
      key: 'on_plex',
      params: ['on_plex'],
      label: 'On Plex',
      role: 'filter',
      group: 'library',
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
      group: 'library',
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

/** Whether one written parameter says anything. An empty list says nothing. */
const wrote = (written: string | string[] | null): boolean =>
  Array.isArray(written) ? written.length > 0 : written !== null && written !== ''

/** Writes one filter's value into a query string, removing what it defaults to. */
function applyWrite(
  next: URLSearchParams,
  def: AnyFilterDef,
  value: unknown,
  ctx: FilterCtx,
) {
  for (const [param, written] of Object.entries(def.write(value, ctx))) {
    // Delete first in every case: `set` replaces one occurrence, and a facet
    // that was carrying three values has three to clear before appending.
    next.delete(param)
    if (Array.isArray(written)) for (const entry of written) next.append(param, entry)
    else if (written !== null && written !== '') next.set(param, written)
  }
}

/** Does this filter put anything in the URL — i.e. is it narrowing the grid? */
export const isSet = (def: AnyFilterDef, value: unknown, ctx: FilterCtx): boolean =>
  Object.values(def.write(value, ctx)).some(wrote)

/** A stable identity for a value, so a select can match one without `===`. */
export const identity = (def: AnyFilterDef, value: unknown, ctx: FilterCtx): string =>
  JSON.stringify(def.write(value, ctx))

/**
 * The value this filter has when the URL says nothing — which is exactly what
 * "clear this one" has to write, and it is derived rather than restated so a
 * new filter cannot arrive with a chip whose × does nothing.
 */
export const defaultValueOf = (def: AnyFilterDef): unknown => def.read(NO_PARAMS)

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

/** What a chip says: the preset's own words when there is one, else `describe`. */
export function chipTextFor(
  def: AnyFilterDef,
  value: unknown,
  lists: FilterLists,
  ctx: FilterCtx,
): string | null {
  const own = def.chip?.(value)
  if (own) return own
  const here = identity(def, value, ctx)
  const preset = def
    .choices?.(lists)
    .find((choice) => identity(def, choice.value, ctx) === here)
  if (preset) return preset.label
  return def.describe?.(value) ?? String(value)
}

/**
 * The chips one filter contributes, and what removing each one leaves.
 *
 * Usually one chip clearing the whole filter. A multi-value facet gives one per
 * value instead, because "Genre Crime, Drama, Thriller ×" can only be undone
 * all at once — and the chip row is the only place a value the control has
 * scrolled out of view can be removed.
 */
export function chipsFor(
  def: AnyFilterDef,
  value: unknown,
  lists: FilterLists,
  ctx: FilterCtx,
): Array<FilterChipDef<unknown>> {
  if (def.chips) return def.chips(value, lists)
  const text = chipTextFor(def, value, lists, ctx)
  return text ? [{ text, next: defaultValueOf(def) }] : []
}

export interface BrowseFilterState {
  /** Every filter's current value, keyed as the table defines it. */
  values: FilterValues
  /** The filters this page actually has, in bar order. Omissions are gone. */
  defs: AnyFilterDef[]
  /** Which browse surface this is — the shelf a saved view is filed under. */
  pageId: SavedViewPage
  /** The sorts this page offers — the dropdown's options and the whitelist. */
  sorts: readonly SortOption[]
  /** True when something is narrowing the results, so "Clear" is worth showing. */
  active: boolean
  /** How many of the *grouped* filters are set — the disclosure's count badge. */
  advancedCount: number
  /** Sets one filter, by key. */
  set: <K extends FilterKey>(key: K, value: FilterValues[K]) => void
  /** Sets a parameter this table does not own — a page's own `kind`, say. */
  update: (key: string, value: string | null) => void
  clear: () => void
  /**
   * The current query, canonicalised — what "save this view" stores.
   *
   * Canonicalised rather than `params.toString()` raw, because a query can
   * arrive from somewhere that spells out a default (a stats drill-down, an old
   * bookmark) and two spellings of the same view must compare equal, or the
   * list cannot say which view is applied. `page` is dropped: a view is a set
   * of filters, not a position in the results.
   */
  savedQuery: string
  /**
   * Recall a saved view: replace the whole query with this one.
   *
   * It goes through the same normalisation every other write does, so a view
   * saved before a filter was renamed simply loses that parameter and falls
   * back to the page default — there is no second validator to disagree with
   * the first. It **pushes** rather than replaces; see the note on `commit`.
   */
  applyView: (query: string) => void
  /** The filter half of the request, ready to merge into a page's own query. */
  query: FilterQuery
}

/**
 * Filter state, held in the URL so a filtered view can be linked and survives a
 * reload. The page passes the sorts it offers, which of them it opens on, any
 * starting value of its own, and any filter it does not have.
 *
 * Every value is checked against what the API will actually accept, because a
 * URL is not trustworthy input — it is typed, truncated, edited by hand and
 * kept in bookmarks long after the page that wrote it changed. `sort`, `order`,
 * `status`, `personal` and every numeric bound are constrained on the backend,
 * so one stale or mistyped word is a 422, and a 422 is an error card where the
 * grid should be. Anything unrecognised falls back to the page default — see
 * each `read` in the table.
 */
export function useBrowseFilters(page: FilterPage): BrowseFilterState {
  const [params, setParams] = useSearchParams()

  const table = filterTable(page)
  const omitted = new Set<FilterKey>(page.omit ?? [])
  const all = Object.values(table) as AnyFilterDef[]
  const defs = all.filter((def) => !omitted.has(def.key))
  const ctx: FilterCtx = { params }

  // An omitted filter reads its default rather than the URL, so a stale
  // parameter cannot narrow a page that gives no way to see or clear it.
  const values = Object.fromEntries(
    all.map((def) => [def.key, omitted.has(def.key) ? defaultValueOf(def) : def.read(ctx)]),
  ) as FilterValues

  /**
   * Re-canonicalises a whole query string.
   *
   * A default never survives into the URL: picking the sort the page already
   * opens on says nothing, and a link that spells out every default reads as
   * noise rather than as a view someone chose. Every filter is re-canonicalised
   * on every write, so this holds for a parameter nobody touched as well as for
   * the one that changed. The page number goes too — narrowing the results
   * renumbers them, so "page 4" of the old filter is not a place that still
   * exists.
   *
   * The one place a parameter's meaning is decided, and therefore the one place
   * a stale value is dropped. A recalled saved view goes through it too, which
   * is why recalling one needs no validation of its own.
   */
  const normalise = (next: URLSearchParams): URLSearchParams => {
    const after: FilterCtx = { params: next }
    for (const def of defs) applyWrite(next, def, def.read(after), after)
    // An omitted filter's parameters are not this page's to keep.
    for (const def of all) {
      if (omitted.has(def.key)) for (const param of def.params) next.delete(param)
    }
    next.delete('page')
    return next
  }

  /**
   * Writes a patch and normalises the whole query around it.
   *
   * `replace`, so refining a view does not cost a back step each time.
   */
  const commit = (patch: Record<string, string | string[] | null>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(patch)) {
      next.delete(key)
      if (Array.isArray(value)) for (const entry of value) next.append(key, entry)
      else if (value !== null && value !== '') next.set(key, value)
    }
    setParams(normalise(next), { replace: true })
  }

  return {
    values,
    defs,
    pageId: page.id,
    sorts: page.sorts,
    active: defs.some(
      (def) => def.role === 'filter' && isSet(def, values[def.key], ctx),
    ),
    advancedCount: defs.filter(
      (def) => def.group && def.role === 'filter' && isSet(def, values[def.key], ctx),
    ).length,
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

    savedQuery: normalise(new URLSearchParams(params)).toString(),

    /**
     * Applying a saved view **pushes**, where changing a filter replaces.
     *
     * The rule those two obey is the same one: a history entry is worth one
     * back step, so refining a view in place must not cost one per chip or per
     * keystroke, and moving somewhere else must. A saved view is the second
     * kind. It discards the entire current query in one deliberate act rather
     * than narrowing it, so without a history entry the view the user was
     * looking at is gone with no way back — the exact loss `page` was moved
     * into the URL to prevent. Paging pushes for that reason and this is the
     * same shape of move, only larger.
     */
    applyView: (query: string) =>
      setParams(normalise(new URLSearchParams(query)), { replace: false }),

    query: Object.assign(
      {},
      ...defs.map((def) => def.toQuery(values[def.key])),
    ) as FilterQuery,
  }
}
