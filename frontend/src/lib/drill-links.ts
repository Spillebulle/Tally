/**
 * Where a chart mark goes when you click it.
 *
 * Every number on the stats page is an aggregate of rows that still exist, so
 * every mark should be a way back to them. The rule that decides *which* way is
 * what the mark counts:
 *
 *   a mark counted in **plays** drills to History  — a day, a month, a streak,
 *                                                    a kind of thing watched
 *   a mark counted in **titles** drills to Browse  — a genre, a rating, a
 *                                                    certificate, a studio
 *
 * Three things this module exists to get right, because doing it inline got
 * each of them wrong at least once:
 *
 * 1. **Encode the value.** Genres and studios really do contain `&`, `/` and
 *    `+` ("Sci-Fi & Fantasy", "AC/DC Productions"). `URLSearchParams` is the
 *    only encoder that gets `+` right — `encodeURIComponent` leaves it, and a
 *    literal `+` in a query string decodes as a space.
 * 2. **Omit what the destination already defaults to.** A link that spells out
 *    every default reads as noise rather than as a view somebody chose, which
 *    is the same rule the pages themselves follow when they write their own
 *    URLs. The defaults are per-destination and are recorded below.
 * 3. **Never emit `page`.** These builders start from nothing rather than from
 *    the current query, so there is no page number to carry — but the reason
 *    matters: a drill lands on a different result set, and "page 4" of the
 *    grid you came from is not a place that still exists in the one you are
 *    going to.
 *
 * Leaving the stats page is *navigation*, not a refinement of it, so callers
 * push these (a plain `navigate(to)` or a `<Link to>`) rather than replacing.
 * Back has to lead to the chart you clicked.
 *
 * **Always `/browse`, never `/movies` or `/shows`.** Those two grids force
 * `anime=exclude` and `personal=exclude` as a page decision, so a drill into
 * one could land on a grid guaranteed not to contain the thing that was
 * clicked — an anime genre, a home video's rating. `/browse` is the mode that
 * exists for arriving with a filter already applied; see `Browse.tsx`.
 */

/** What `/browse` opens on. A value equal to one of these is left out. */
const BROWSE_DEFAULTS: Record<string, string> = {
  // `Browse.tsx` passes `personal: 'all'` for the `browse` and `search` modes.
  personal: 'all',
  status: 'all',
  sort: 'title',
  on_plex: 'all',
}

/** What `/history` opens on. */
const HISTORY_DEFAULTS: Record<string, string> = {
  filter: 'all',
}

type Param = string | number | boolean | null | undefined

function buildLink(path: string, values: Record<string, Param>, defaults: Record<string, string>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === '') continue
    const written = String(value)
    if (defaults[key] === written) continue
    params.append(key, written)
  }
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

// --- Browse: marks counted in titles --------------------------------------

/**
 * The filters `/browse` actually reads.
 *
 * Deliberately a closed list rather than a passthrough: a key the destination
 * ignores is a silent no-op, and a drill that quietly does nothing is worse
 * than one that is not offered — the user sees a grid and believes it is the
 * subset they clicked. Everything here is checked against `MediaFilters` on the
 * API and `filterTable()` on the page.
 */
export interface BrowseDrill {
  q?: string
  genre?: string
  content_rating?: string
  studio?: string
  director?: string
  status?: string
  min_rating?: number
  max_rating?: number
  year?: number
  favorites?: boolean
  on_plex?: boolean | 'all'
  personal?: 'all' | 'exclude' | 'only'
  sort?: string
}

export function browseLink(drill: BrowseDrill): string {
  return buildLink(
    '/browse',
    {
      ...drill,
      // The toggle is written as the string "true" and is absent when off,
      // never `favorites=false` — that is how the page reads it back.
      favorites: drill.favorites ? 'true' : undefined,
      on_plex: drill.on_plex === undefined ? undefined : String(drill.on_plex),
    },
    BROWSE_DEFAULTS,
  )
}

// --- History: marks counted in plays --------------------------------------

/** The one kind filter `/history` offers, matching the `by_type` buckets. */
export type HistoryKind = 'movie' | 'episode' | 'anime'

export interface HistoryDrill {
  /** Inclusive local start of the window. */
  since?: Date
  /** Inclusive local end of the window — end of day, not start of it. */
  until?: Date
  filter?: HistoryKind
}

export function historyLink(drill: HistoryDrill): string {
  return buildLink(
    '/history',
    {
      since: drill.since && localInstant(drill.since),
      until: drill.until && localInstant(drill.until),
      filter: drill.filter,
    },
    HISTORY_DEFAULTS,
  )
}

// --- local time, spelled out ----------------------------------------------

/**
 * A local wall-clock moment as an unambiguous instant: `2026-08-16T00:00:00+02:00`.
 *
 * Not `toISOString()`, which answers in UTC and would put a Norwegian midnight
 * on the previous day — the exact bug this repo has shipped twice. The offset
 * is written out instead, so the value names the same instant however it is
 * read: FastAPI parses it as timezone-aware and `models.UtcDateTime` converts
 * it once, on the way into the comparison.
 *
 * `URLSearchParams` percent-encodes the `+`, which is why every link here is
 * built through it rather than by concatenation.
 */
export function localInstant(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  // getTimezoneOffset() is minutes *behind* UTC, so its sign is inverted from
  // the one written in an ISO offset: Oslo in summer reports -120 for "+02:00".
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const absolute = Math.abs(offset)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  )
}

/** Local midnight at the start of a day. */
export function startOfDay(date: Date): Date {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  return start
}

/**
 * The last instant of a local day.
 *
 * The half of the pair that is easy to get wrong, and getting it wrong is
 * invisible: `/api/history` compares `watched_at <= until`, so an `until` of
 * the day's *midnight* silently drops everything actually watched that day and
 * the drill lands on an empty page for the busiest square on the chart.
 */
export function endOfDay(date: Date): Date {
  const end = new Date(date)
  end.setHours(23, 59, 59, 999)
  return end
}

/**
 * The local window a stats bucket label covers.
 *
 * The labels come back from the API as plain local dates — `2026-08-16` for a
 * day, `2026-08` for a month — and are parsed as local, never through
 * `new Date('2026-08-01')`, which is UTC midnight by spec and formats as July
 * anywhere west of Greenwich.
 */
export function bucketWindow(label: string): { since: Date; until: Date } {
  const [year, month, day] = label.split('-').map(Number)
  if (day) {
    const date = new Date(year, month - 1, day)
    return { since: startOfDay(date), until: endOfDay(date) }
  }
  // Day 0 of the following month is the last day of this one, leap years
  // included.
  return {
    since: startOfDay(new Date(year, month - 1, 1)),
    until: endOfDay(new Date(year, month, 0)),
  }
}
