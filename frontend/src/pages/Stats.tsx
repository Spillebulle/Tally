/**
 * The stats page: one scrolling dashboard, not a set of tabs.
 *
 * Deliberate, and the page holds roughly three times what it used to. Tabs
 * would hide exactly the comparisons this page exists to enable — "I watch on
 * Saturday nights *and* my rewatch share climbed in the same months" is one
 * finding across two figures, and it cannot be made behind a tab. Everything is
 * fed by one query anyway, so a tab would hide content already fetched, and
 * every other page in this app is a single scroll.
 *
 * What that costs is navigability, so each section is a `<section id>` with its
 * own heading: `#activity`, `#composition`, `#ratings`, `#rewatch`,
 * `#seasonality`, `#records`. A link can target one, and a screen reader's
 * heading list is the outline.
 *
 * Two requests, not one. `/api/stats/seasonality` walks every play ever
 * recorded and is not bounded by the window, so it is fetched separately and
 * gets its own loading, error and empty states — folding it into the main
 * query's would make a slow all-time aggregation gate the windowed page above
 * it, and a failure of one report blank out the other seven.
 */
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type SeasonalityQuery, type StatsQuery } from '@/lib/api'
import type {
  RewatchSplit,
  StatCount,
  StatsPreset,
  StatsRange,
  StatsTotals,
} from '@/lib/types'
import { compactNumber, formatWatchTime, parseLocalDateLabel } from '@/lib/utils'
import { useUrlParams } from '@/lib/url-state'
import {
  browseLink,
  bucketWindow,
  endOfDay,
  historyLink,
  itemLink,
  localInstant,
  monthWindow,
  startOfDay,
  yearWindow,
} from '@/lib/drill-links'
import {
  ActivityHeatmap,
  BarList,
  ChartCard,
  ChartLegend,
  ColumnChart,
  DataTable,
  MatrixChart,
  MatrixTable,
  RankedList,
  StackedColumnChart,
  StatTile,
  type StatDelta,
  type StackedEntry,
} from '@/components/Charts'
import { EmptyState, ErrorState, PageHeader, Segmented, Spinner } from '@/components/ui'
import {
  ChartIcon,
  ClockIcon,
  FilmIcon,
  PlayIcon,
  RefreshIcon,
  SparkIcon,
  StarIcon,
  TvIcon,
} from '@/components/Icons'

// ---------------------------------------------------------------------------
// The query, in the URL
// ---------------------------------------------------------------------------

/**
 * The windows this page offers.
 *
 * A subset of the API's presets, plus `custom`. `last_year` is deliberately not
 * offered: the comparison control answers "how does this compare with a year
 * ago" better than a bare window does, and an eighth segment costs a row on a
 * phone. It is therefore also not *accepted* — a value this page cannot render
 * as a selected segment has no business surviving a reload.
 */
const PRESETS = ['7d', '30d', '90d', '12m', 'ytd', 'all', 'custom'] as const
type Preset = (typeof PRESETS)[number]

const PRESET_LABELS: Record<Preset, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '12m': '12 months',
  ytd: 'This year',
  all: 'All time',
  custom: 'Custom',
}

const SCOPES = ['all', 'anime'] as const
type Scope = (typeof SCOPES)[number]

const COMPARISONS = ['off', 'previous', 'year'] as const
type Comparison = (typeof COMPARISONS)[number]

/** On the control and in the legend, where the space is a segment wide. */
const COMPARISON_LABELS: Record<Comparison, string> = {
  off: 'No comparison',
  previous: 'Previous period',
  year: 'Last year',
}

/** In prose, where it can say what it actually means. */
const COMPARISON_PHRASES: Record<Comparison, string> = {
  off: '',
  previous: 'the period immediately before',
  year: 'the same period a year earlier',
}

/** The earliest date the custom picker will accept. */
const EARLIEST_YEAR = 1970

/**
 * A calendar date from the query string, or `null`.
 *
 * `<input type="date">` produces `YYYY-MM-DD` and nothing else, but the URL is
 * not written only by the input: it is typed, truncated, bookmarked and edited
 * by hand. `?from=banana`, `?from=2026-02-31` and `?from=0007-01-01` are each a
 * 422 from the API and an error card where the charts should be, so each has to
 * read back as "unset" instead.
 *
 * The rollover check is the one that is easy to miss — `new Date(2026, 1, 31)`
 * does not fail, it answers 3 March, so a date that never existed would sail
 * through a mere shape test and silently move the window.
 */
function parseDateParam(raw: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const [year, month, day] = raw.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  if (year < EARLIEST_YEAR || year > new Date().getFullYear() + 1) return null
  return raw
}

function useStatsFilters() {
  const { values, set, setMany, reset, active } = useUrlParams({
    preset: { key: 'preset', allowed: PRESETS, fallback: '12m' as Preset },
    scope: { key: 'scope', allowed: SCOPES, fallback: 'all' as Scope },
    compare: { key: 'compare', allowed: COMPARISONS, fallback: 'off' as Comparison },
    // Only meaningful together, and only while `preset` is `custom`.
    from: { key: 'from', parse: parseDateParam, fallback: '' },
    to: { key: 'to', parse: parseDateParam, fallback: '' },
  })
  return { ...values, set, setMany, reset, active }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

interface LocalWindow {
  since: Date
  until: Date
}

/**
 * The custom window, or why there isn't one.
 *
 * Both halves are local: `<input type="date">` hands back a *calendar* date,
 * and a calendar date is not an instant until a timezone is applied. The start
 * is local midnight and the end is local **end of day** — get the second one
 * wrong and the last day of every custom range silently disappears, which is
 * the kind of bug nobody reports because every number still looks plausible.
 */
function customWindow(from: string, to: string): LocalWindow | { error: string } {
  if (!from || !to) return { error: 'Pick a start and an end date to chart a custom range.' }
  const since = startOfDay(parseLocalDateLabel(from))
  const until = endOfDay(parseLocalDateLabel(to))
  if (until <= since) return { error: 'The end date is before the start date.' }
  return { since, until }
}

/** The inclusive local window a resolved range covers, for a history drill. */
function windowOf(range: StatsRange): LocalWindow {
  return {
    since: startOfDay(parseLocalDateLabel(range.start_day)),
    until: endOfDay(parseLocalDateLabel(range.end_day)),
  }
}

/** The same window, one calendar year earlier. */
function ayearEarlier(range: StatsRange): LocalWindow {
  const shift = (label: string) => {
    const date = parseLocalDateLabel(label)
    date.setFullYear(date.getFullYear() - 1)
    return date
  }
  return { since: startOfDay(shift(range.start_day)), until: endOfDay(shift(range.end_day)) }
}

const formatDay = (label: string, withYear = true) =>
  parseLocalDateLabel(label).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  })

const describeRange = (range: StatsRange) =>
  `${formatDay(range.start_day)} – ${formatDay(range.end_day)}`

const plural = (count: number, unit: string) => `${count} ${count === 1 ? unit : `${unit}s`}`

// ---------------------------------------------------------------------------
// Series shaping
// ---------------------------------------------------------------------------

/** A chunk of the day series, carrying the raw bounds a drill needs. */
interface PeriodBucket extends StatCount {
  from: string
  to: string
}

/** The same chunk, split into first watches and rewatches. */
interface SplitBucket extends PeriodBucket, StackedEntry {}

/**
 * How the day series is cut into chunks: the size, and the slice boundaries.
 *
 * Shared by the plain series and the first-vs-rewatch split so the two are
 * chunked identically. `rewatch.by_bucket` is index-aligned with
 * `activity_by_day` — that alignment is the whole contract — and it survives
 * only if both are folded on the same boundaries.
 */
function chunkSize(length: number, count: number): number {
  return Math.max(1, Math.ceil(length / count))
}

/**
 * The day series folded into at most `count` equal chunks.
 *
 * Equal chunks rather than calendar months, because the comparison chart draws
 * two windows side by side and the columns have to line up by *offset into the
 * window*: a 90-day range has no months to speak of, and "the third month of a
 * year" and "the third month of the year before" are not the same number of
 * days anyway. One rule that works for every range beats two that each work for
 * half of them.
 */
function chunkSeries(days: StatCount[], count: number): PeriodBucket[] {
  if (days.length === 0) return []
  const size = chunkSize(days.length, count)
  const buckets: PeriodBucket[] = []
  for (let index = 0; index < days.length; index += size) {
    const slice = days.slice(index, index + size)
    buckets.push({
      label: slice[0].label,
      value: slice.reduce((sum, day) => sum + day.value, 0),
      from: slice[0].label,
      to: slice[slice.length - 1].label,
    })
  }
  return buckets
}

/**
 * The first-vs-rewatch split, folded onto the same chunks as the day series.
 *
 * Indexed against `days` rather than against its own labels: the two arrays are
 * index-aligned by the API and a split bucket's label is the same bucket key,
 * so walking them together is the only reading that cannot drift. A missing
 * entry counts as zero rather than shortening the chunk, so a truncated
 * response draws a smaller bar instead of silently misaligning the axis.
 */
function chunkSplit(
  days: StatCount[],
  splits: RewatchSplit[],
  count: number,
): SplitBucket[] {
  if (days.length === 0) return []
  const size = chunkSize(days.length, count)
  const buckets: SplitBucket[] = []
  for (let index = 0; index < days.length; index += size) {
    const slice = days.slice(index, index + size)
    let first = 0
    let rewatch = 0
    for (let offset = 0; offset < slice.length; offset += 1) {
      const split = splits[index + offset]
      first += split?.first ?? 0
      rewatch += split?.rewatch ?? 0
    }
    buckets.push({
      label: slice[0].label,
      value: first + rewatch,
      first,
      rewatch,
      from: slice[0].label,
      to: slice[slice.length - 1].label,
    })
  }
  return buckets
}

/** "12 – 24 Aug 2026", or one date when the span is a single day. */
const spanLabel = (bucket: PeriodBucket) =>
  bucket.from === bucket.to
    ? formatDay(bucket.from)
    : `${formatDay(bucket.from, false)} – ${formatDay(bucket.to)}`

const describeBucket = (bucket: PeriodBucket) =>
  `${spanLabel(bucket)}: ${plural(bucket.value, 'play')}`

/**
 * Axis labels for the chunked series: the month is written once, where it
 * changes, and every other column carries only its day number. Twelve columns
 * of "12 Jan" is a wall of text on a phone; twelve of "12" is an axis.
 */
function chunkAxisLabels(buckets: PeriodBucket[]): Map<string, string> {
  const labels = new Map<string, string>()
  let lastMonth = ''
  for (const bucket of buckets) {
    const date = parseLocalDateLabel(bucket.from)
    const month = date.toLocaleDateString(undefined, { month: 'short' })
    labels.set(bucket.label, month === lastMonth ? String(date.getDate()) : month)
    lastMonth = month
  }
  return labels
}

/**
 * The runs of consecutive watched days in the series, longest and latest.
 *
 * The series carries every day in the window including the zeros, so a run of
 * entries with a value *is* a run of consecutive dates. Recomputed here only to
 * find the window each streak covers — the lengths themselves stay the
 * server's, and a card only becomes a link when the run found here is the same
 * length as the number printed on it. A drill that quietly points at a
 * different stretch of days than the figure above it is worse than no drill.
 */
function streakRuns(series: StatCount[]): { last: PeriodBucket | null; longest: PeriodBucket | null } {
  let last: PeriodBucket | null = null
  let longest: PeriodBucket | null = null
  let run: StatCount[] = []

  const close = () => {
    if (run.length === 0) return
    const bucket: PeriodBucket = {
      label: run[0].label,
      value: run.length,
      from: run[0].label,
      to: run[run.length - 1].label,
    }
    last = bucket
    if (!longest || bucket.value > longest.value) longest = bucket
    run = []
  }

  for (const day of series) {
    if (day.value > 0) run.push(day)
    else close()
  }
  close()
  return { last, longest }
}

/** The busiest slot of a fixed-length profile, or null when it is all zeroes. */
function peakOf<T extends { plays: number }>(buckets: T[]): T | null {
  const best = buckets.reduce<T | null>(
    (winner, bucket) => (winner && winner.plays >= bucket.plays ? winner : bucket),
    null,
  )
  return best && best.plays > 0 ? best : null
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

/**
 * One band of the dashboard, with a heading a link can target.
 *
 * `scroll-mt` so an anchor jump leaves the heading visible rather than tucked
 * under the top of the viewport, and `aria-labelledby` so the section is named
 * in a landmark list rather than being an anonymous region.
 */
function Section({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-6 space-y-4">
      <div className="min-w-0">
        <h2 id={`${id}-heading`} className="text-lg font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {children}
    </section>
  )
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function Stats() {
  const navigate = useNavigate()
  const { preset, scope, compare, from, to, set, setMany, reset, active } = useStatsFilters()

  // The zone the viewer is actually in. The API resolves `tz` → the stored
  // preference → UTC and reports back which it used, so a day boundary is the
  // viewer's own rather than the container's.
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

  const custom = preset === 'custom' ? customWindow(from, to) : null
  const customError = custom && 'error' in custom ? custom.error : null
  const customRange = custom && 'since' in custom ? custom : null
  // A custom range that does not resolve asks the page's default question.
  // Falling back is the whole point of validating on read: a bad or truncated
  // URL still renders charts, rather than a 422 and an error card.
  const apiPreset: StatsPreset = preset === 'custom' ? '12m' : preset

  const query: StatsQuery = {
    // A half-finished custom range asks the default question rather than a
    // rejected one: the point of validating on read is that a bad URL still
    // renders a page.
    ...(customRange
      ? { since: localInstant(customRange.since), until: localInstant(customRange.until) }
      : { preset: apiPreset }),
    anime_only: scope === 'anime',
    // The API works out the preceding window itself, timezone and all, and
    // hands back both its bounds and the percent movement. Re-deriving "the 90
    // days before these 90 days" on the client would be a second opinion on a
    // calculation that has to agree.
    ...(compare === 'previous' ? { compare: true } : {}),
    tz: timezone,
  }

  const { data, isLoading, isError, error, refetch } = useQuery({
    // Deliberately a different key shape from Dashboard's `['stats', 365]`: that
    // one asks a fixed question and this one asks whatever the URL says, so the
    // two do not share a cache entry. Every invalidation is by the `['stats']`
    // prefix, which reaches both.
    queryKey: ['stats', query],
    queryFn: () => api.stats.query(query),
  })

  // The window being compared against, as the server would resolve it: its own
  // answer for "the previous period", ours only for the year shift, which is a
  // calendar operation on the local dates it already gave us.
  const earlierWindow: LocalWindow | null =
    !data || compare === 'off'
      ? null
      : compare === 'year'
        ? ayearEarlier(data.range)
        : data.previous
          ? {
              since: startOfDay(parseLocalDateLabel(data.previous.range.start_day)),
              until: endOfDay(parseLocalDateLabel(data.previous.range.end_day)),
            }
          : null

  // A second pass over the earlier window. `compare=true` returns its totals
  // but not its series, and a two-series chart needs the series.
  const earlierQuery: StatsQuery | null = earlierWindow
    ? {
        since: localInstant(earlierWindow.since),
        until: localInstant(earlierWindow.until),
        anime_only: scope === 'anime',
        tz: timezone,
      }
    : null

  const earlier = useQuery({
    queryKey: ['stats', earlierQuery],
    queryFn: () => api.stats.query(earlierQuery as StatsQuery),
    enabled: earlierQuery !== null,
  })

  // All of history, unbounded by the window — its own request, and therefore
  // its own states further down the page. Only the scope and the zone can
  // change the answer, so only those are in the key.
  const seasonalityQuery: SeasonalityQuery = {
    anime_only: scope === 'anime',
    tz: timezone,
  }
  const seasonality = useQuery({
    queryKey: ['stats', 'seasonality', seasonalityQuery],
    queryFn: () => api.stats.seasonality(seasonalityQuery),
  })

  // Whether there is *any* history, independent of this page's range and scope.
  // Without it an empty chart set cannot tell "you have watched nothing" from
  // "nothing in the last 90 days", and would tell the user to run a sync over a
  // library that is already imported.
  const summary = useQuery({ queryKey: ['summary'], queryFn: api.stats.summary })

  // The controls ride along with the empty state too. "Try a wider time range"
  // is not advice if the range picker only exists once there is something to
  // chart — the one view that needs the control most had it hidden.
  const controls = (
    <div className="mb-6 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Time range"
          value={preset}
          onChange={(value) =>
            // One navigation, not two. Leaving `custom` drops the dates with the
            // same write, so the back button never lands on a custom range with
            // half its bounds missing; entering it seeds them from the window
            // already on screen, so the fields are never blank on arrival.
            setMany(
              value === 'custom'
                ? {
                    preset: value,
                    from: from || data?.range.start_day || '',
                    to: to || data?.range.end_day || '',
                  }
                : { preset: value, from: '', to: '' },
            )
          }
          options={PRESETS.map((value) => ({ value, label: PRESET_LABELS[value] }))}
        />
        <Segmented
          label="Scope"
          value={scope}
          onChange={(value) => set('scope', value)}
          options={[
            { value: 'all', label: 'Everything' },
            { value: 'anime', label: 'Anime only' },
          ]}
        />
        <Segmented
          label="Compare with"
          value={compare}
          onChange={(value) => set('compare', value)}
          options={COMPARISONS.map((value) => ({ value, label: COMPARISON_LABELS[value] }))}
        />
      </div>

      {/* Revealed by the Custom segment rather than sitting there permanently:
          two date fields cost a row on every visit to answer a question almost
          nobody is asking, and the presets cover the rest in one tap. */}
      {preset === 'custom' && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-raised p-3">
          <label className="text-xs font-medium text-muted">
            <span className="mb-1 block uppercase tracking-wider">From</span>
            <input
              type="date"
              className="input w-auto"
              value={from}
              min={`${EARLIEST_YEAR}-01-01`}
              max={to || undefined}
              onChange={(event) => set('from', event.target.value)}
            />
          </label>
          <label className="text-xs font-medium text-muted">
            <span className="mb-1 block uppercase tracking-wider">To</span>
            <input
              type="date"
              className="input w-auto"
              value={to}
              min={from || `${EARLIEST_YEAR}-01-01`}
              onChange={(event) => set('to', event.target.value)}
            />
          </label>
          {customError && (
            <p role="status" className="pb-2 text-xs text-warn">
              {customError} Showing the last 12 months meanwhile.
            </p>
          )}
        </div>
      )}
    </div>
  )

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="skeleton h-10 w-64 rounded-xl" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="skeleton h-24 rounded-2xl" />
          ))}
        </div>
        <div className="skeleton h-56 rounded-2xl" />
      </div>
    )
  }

  // Before the empty branch: a failed request is not an empty history, and
  // telling the user they have watched nothing hides the actual problem.
  if (isError) {
    return (
      <div>
        <PageHeader title="Stats" />
        {controls}
        <ErrorState error={error} onRetry={() => void refetch()} />
      </div>
    )
  }

  if (!data || data.watch_events === 0) {
    // "Nothing at all" is only claimable when the unfiltered count actually
    // came back and was zero. While it is loading or failed, the narrower
    // message is the one that is always true.
    const noHistoryAnywhere = summary.data?.watch_events === 0
    return (
      <div>
        <PageHeader title="Stats" />
        {/* No controls when there is genuinely nothing: a range picker over an
            empty history is a dead control on the one page that has to explain
            itself instead. */}
        {!noHistoryAnywhere && controls}
        <EmptyState
          icon={<ChartIcon />}
          title={
            noHistoryAnywhere
              ? 'Nothing to chart yet'
              : scope === 'anime'
                ? 'No anime plays in this range'
                : 'Nothing watched in this range'
          }
          description={
            noHistoryAnywhere
              ? 'Once Tally has some watch history — imported from Plex or logged here — your habits will show up on this page.'
              : 'Try a wider time range, or clear the filters to chart everything.'
          }
          action={
            !noHistoryAnywhere && active ? (
              <button type="button" onClick={reset} className="btn-outline mt-2">
                Clear filters
              </button>
            ) : undefined
          }
        />
      </div>
    )
  }

  const range = data.range
  // Every mark counted in plays drills to the same window it was counted over.
  const windowDrill = windowOf(range)

  // The bucket keeps its raw `2026-08` key — that is the entry `onSelect` hands
  // back, and formatting it away here is what made a time drill impossible.
  const monthly = data.activity_by_month.slice(-12)
  // Parsed as a local date: `new Date('2026-08-01')` is UTC midnight by spec,
  // which formats as the previous month anywhere west of Greenwich.
  const monthName = (label: string, withYear = false) =>
    parseLocalDateLabel(label).toLocaleDateString(undefined, {
      month: 'short',
      ...(withYear ? { year: 'numeric' } : {}),
    })

  // --- comparison ---------------------------------------------------------

  const earlierTotals: StatsTotals | null =
    compare === 'off'
      ? null
      : compare === 'previous' && data.previous
        ? data.previous.totals
        : (earlier.data ?? null)

  const earlierLabel = COMPARISON_LABELS[compare]
  const earlierRange: StatsRange | null =
    compare === 'off'
      ? null
      : compare === 'previous' && data.previous
        ? data.previous.range
        : (earlier.data?.range ?? null)

  /**
   * Movement on one metric. The server's own percentage is preferred where it
   * has one — it omits the metrics whose earlier value was zero, because "up
   * from nothing" is not a percentage, and that omission is information the
   * client should not paper over with an Infinity.
   */
  const deltaFor = (
    field: keyof StatsTotals,
    format: (value: number) => string,
  ): StatDelta | undefined => {
    if (!earlierTotals || !earlierRange) return undefined
    const before = earlierTotals[field]
    const after = data[field]
    if (before == null || after == null) return undefined
    const served = compare === 'previous' ? data.previous?.pct_change[field] : undefined
    const pct = served ?? (before ? Math.round(((after - before) / before) * 1000) / 10 : null)
    return {
      pct,
      previous: format(before),
      against: compare === 'year' ? 'a year earlier' : 'in the period before',
    }
  }

  const buckets = Math.min(12, Math.max(1, range.days))
  const currentBuckets = chunkSeries(data.activity_by_day, buckets)
  const earlierBuckets = earlier.data ? chunkSeries(earlier.data.activity_by_day, buckets) : []
  const axisLabels = chunkAxisLabels(currentBuckets)
  const comparisonReady = compare !== 'off' && earlierBuckets.length > 0

  // Enough points to show a shape, few enough that a 72px sparkline is not
  // mush. Chunked with the same rule as the charts, so the tile and the figure
  // beside it describe the same window in the same divisions.
  const trend = chunkSeries(data.activity_by_day, 24).map((bucket) => bucket.value)

  // --- time shape ---------------------------------------------------------

  const weekdays = data.by_weekday
  const hours = data.by_hour
  const punch = data.punch_card
  const peakDay = peakOf(weekdays)
  const peakHour = peakOf(hours)

  // The busiest cell of the punch card, stated in words — the matrix is a
  // shape, and its headline should not be something you have to squint for.
  let peakCell: { weekday: string; hour: number; plays: number } | null = null
  punch.plays.forEach((row, weekday) =>
    row.forEach((plays, hour) => {
      if (plays > 0 && (!peakCell || plays > peakCell.plays)) {
        peakCell = { weekday: punch.weekdays[weekday], hour, plays }
      }
    }),
  )
  const peak = peakCell as { weekday: string; hour: number; plays: number } | null

  const shortDay = (name: string) => name.slice(0, 3)
  const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`

  // --- rewatch ------------------------------------------------------------

  const rewatch = data.rewatch
  const splitBuckets = chunkSplit(data.activity_by_day, rewatch.by_bucket, buckets)

  // --- streaks ------------------------------------------------------------

  const runs = streakRuns(data.activity_by_day)
  const currentRun =
    runs.last && runs.last.value === data.current_streak_days ? runs.last : null
  const longestRun =
    runs.longest && runs.longest.value === data.longest_streak_days ? runs.longest : null
  const runLink = (run: PeriodBucket) =>
    historyLink({
      since: startOfDay(parseLocalDateLabel(run.from)),
      until: endOfDay(parseLocalDateLabel(run.to)),
    })

  // --- busiest days -------------------------------------------------------

  /**
   * The heatmap's numbers as a ranked list of real buttons.
   *
   * Not decoration and not a duplicate: a heatmap cell is 13px square, so the
   * chart above is a shape, not a control. This is the same information with a
   * hit target a thumb can find and a tab stop a keyboard can reach — and the
   * raw date rides along on the entry so the drill has the bucket rather than
   * the formatted label.
   */
  const busiestDays = [...data.activity_by_day]
    .filter((day) => day.value > 0)
    .sort((left, right) => right.value - left.value || (left.label < right.label ? 1 : -1))
  const busiest = busiestDays
    .slice(0, 6)
    .map((day) => ({ label: formatDay(day.label), value: day.value, day: day.label }))
  const busiestDay = busiestDays[0] ?? null

  // --- seasonality --------------------------------------------------------

  const season = seasonality.data
  const seasonYears = season?.years ?? []
  const monthNames = season?.months.map((month) => month.label) ?? []

  return (
    <div className="space-y-10">
      <div>
        <PageHeader
          title="Stats"
          subtitle={`${compactNumber(data.watch_events)} plays · ${formatWatchTime(data.total_runtime_minutes)} watched`}
        />
        {controls}
      </div>

      {/*
        The hero figure — exactly one on the page. Everything below it is a
        comparison or a breakdown; this is the single number the page is about,
        and a second one at this size would make neither of them the answer.
      */}
      <div className="card overflow-hidden p-6">
        <p className="label">Total time watched</p>
        <p className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          {formatWatchTime(data.total_runtime_minutes)}
        </p>
        <p className="mt-2 text-sm text-muted">
          Across {compactNumber(data.total_movies_watched)} film
          {data.total_movies_watched === 1 ? '' : 's'} and{' '}
          {compactNumber(data.total_episodes_watched)} episode
          {data.total_episodes_watched === 1 ? '' : 's'} from{' '}
          {compactNumber(data.total_shows_watched)} series.
        </p>
        {/* The window the server actually resolved, and the zone it used — a
            fallback to UTC is otherwise invisible and every date on the page
            would be quietly someone else's day. */}
        <p className="mt-3 text-xs text-muted">
          {describeRange(range)} · {range.days} days · times in {range.timezone}
        </p>
      </div>

      {/*
        Eight tiles, two rows of four, and eight is the cap rather than a count
        that happened. A tile is a headline: past eight the row stops being a
        summary and becomes a table with big type, and the ninth thing always
        reads better as a chart further down.
      */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Plays"
          value={compactNumber(data.watch_events)}
          icon={<PlayIcon />}
          delta={deltaFor('watch_events', compactNumber)}
          trend={trend}
        />
        <StatTile
          label="Films"
          value={compactNumber(data.total_movies_watched)}
          icon={<FilmIcon />}
          delta={deltaFor('total_movies_watched', compactNumber)}
        />
        <StatTile
          label="Episodes"
          value={compactNumber(data.total_episodes_watched)}
          icon={<TvIcon />}
          delta={deltaFor('total_episodes_watched', compactNumber)}
        />
        {/* No hint: four tiles across leaves ~180px of text, and a hint that
            truncates to "Shows you have watche…" says less than nothing. */}
        <StatTile
          label="Series"
          value={compactNumber(data.total_shows_watched)}
          icon={<TvIcon />}
          delta={deltaFor('total_shows_watched', compactNumber)}
        />
        <StatTile
          label="Anime plays"
          value={compactNumber(data.total_anime_watched)}
          hint={`${Math.round((data.total_anime_watched / Math.max(1, data.watch_events)) * 100)}% of your plays`}
          icon={<SparkIcon />}
          delta={deltaFor('total_anime_watched', compactNumber)}
        />
        <StatTile
          label="Rewatches"
          value={compactNumber(rewatch.rewatches)}
          hint={`${Math.round(rewatch.rewatch_ratio * 100)}% of your plays`}
          icon={<RefreshIcon />}
        />
        <StatTile
          label="Average rating"
          value={data.average_rating != null ? `${data.average_rating.toFixed(1)} / 10` : '—'}
          hint="Everything you rated"
          icon={<StarIcon filled />}
          delta={deltaFor('average_rating', (value) => value.toFixed(1))}
        />
        <StatTile
          label="Busiest day"
          value={peakDay ? peakDay.label : '—'}
          hint={peakDay ? plural(peakDay.plays, 'play') : 'Nothing watched yet'}
          icon={<ClockIcon />}
        />
      </div>

      <Section
        id="activity"
        title="Activity"
        description="When the plays happened — by date, and by the clock."
      >
        <ChartCard
          headingLevel={3}
          title="Watch activity"
          description="Plays per day. Darker means a heavier viewing day. Pick a day to see what you watched."
          // The heatmap was the one chart with no table fallback, and its cells
          // carry only mouse handlers — so its numbers were unreachable by
          // keyboard, screen reader or touch. Every chart ships one.
          table={
            <DataTable
              caption="Plays by day"
              rows={data.activity_by_day.filter((entry) => entry.value > 0)}
              valueHeader="Plays"
            />
          }
        >
          <ActivityHeatmap
            data={data.activity_by_day}
            onSelect={(dateKey) => navigate(historyLink(bucketWindow(dateKey)))}
          />
          {busiest.length > 0 && (
            <div className="mt-5 border-t border-line pt-4">
              <h4 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">
                Busiest days
              </h4>
              <BarList
                data={busiest}
                emptyMessage="Nothing watched in this range"
                onSelect={(entry) => navigate(historyLink(bucketWindow(entry.day)))}
              />
            </div>
          )}
        </ChartCard>

        {comparisonReady ? (
          /*
            Two series in one frame, and therefore a legend: a heading can name
            a single series but it cannot tell two apart. The columns align by
            *offset into the window* rather than by label — the whole point is
            that the second window is a different stretch of calendar.
          */
          <ChartCard
            headingLevel={3}
            title="Then and now"
            description={`Plays per period, this window against ${COMPARISON_PHRASES[compare]}${
              earlierRange ? ` (${describeRange(earlierRange)})` : ''
            }. Pick a column to list those plays.`}
            legend={
              <ChartLegend
                series={[
                  { label: 'This window', className: 'bg-series-1' },
                  { label: earlierLabel, className: 'bg-series-2' },
                ]}
              />
            }
            table={
              <DataTable
                caption="Plays per period, compared"
                rows={currentBuckets.map((bucket) => ({
                  label: spanLabel(bucket),
                  value: bucket.value,
                }))}
                valueHeader="This window"
                compare={{
                  header: earlierLabel,
                  rows: earlierBuckets,
                  rowLabel: (row) => formatDay(row.label),
                }}
              />
            }
          >
            <ColumnChart
              data={currentBuckets}
              compare={{ data: earlierBuckets, describe: describeBucket }}
              formatLabel={(label) => axisLabels.get(label) ?? label}
              describe={describeBucket}
              emptyMessage="Nothing watched in either window"
              onSelect={(entry) =>
                navigate(
                  historyLink({
                    since: startOfDay(parseLocalDateLabel(entry.from)),
                    until: endOfDay(parseLocalDateLabel(entry.to)),
                  }),
                )
              }
            />
          </ChartCard>
        ) : (
          <ChartCard
            headingLevel={3}
            title="Plays by month"
            description="Pick a month to see what you watched in it."
            table={
              <DataTable
                caption="Plays by month"
                rows={monthly.map((entry) => ({
                  label: monthName(entry.label, true),
                  value: entry.value,
                }))}
                valueHeader="Plays"
              />
            }
          >
            <ColumnChart
              data={monthly}
              formatLabel={(label) => monthName(label)}
              describe={(entry) =>
                `${monthName(entry.label, true)}: ${plural(entry.value, 'play')}`
              }
              emptyMessage="Not enough history yet"
              onSelect={(entry) => navigate(historyLink(bucketWindow(entry.label)))}
            />
          </ChartCard>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {/*
            The two marginals of the punch card below, and worth drawing
            separately: a matrix is read as a shape and these are read as
            numbers. Neither drills — a weekday and an hour are recurring
            buckets, and `/history` takes one contiguous window. See the note in
            `lib/drill-links.ts` for what it would take to change that.
          */}
          <ChartCard
            headingLevel={3}
            title="Days of the week"
            description="Plays by weekday, in your own timezone."
            table={
              <DataTable
                caption="Plays by weekday"
                rows={weekdays.map((day) => ({ label: day.label, value: day.plays }))}
                valueHeader="Plays"
              />
            }
          >
            <ColumnChart
              data={weekdays.map((day) => ({ label: day.label, value: day.plays }))}
              formatLabel={shortDay}
              describe={(entry) => `${entry.label}: ${plural(entry.value, 'play')}`}
              emptyMessage="Nothing watched in this range"
            />
          </ChartCard>

          <ChartCard
            headingLevel={3}
            title="Time of day"
            description="Plays by hour. Plex stamps a play when it finishes, so a long film lands in the hour it ended."
            table={
              <DataTable
                caption="Plays by hour"
                rows={hours.map((hour) => ({
                  label: hourLabel(hour.index),
                  value: hour.plays,
                }))}
                valueHeader="Plays"
              />
            }
          >
            {/*
              Twenty-four columns, compressed to fit rather than scrolled, and
              that was measured rather than assumed. Given a `min-w` and a
              scroller this chart was *worse*: a fixed-height frame shows the
              scroller's left edge, the quiet small hours, while the evening
              peak that sets the scale sat off-screen to the right — so on a
              phone the card read as almost empty. A profile has to be seen
              whole to be a profile. Thin columns are the right trade; the
              punch card below it is where the same data gets room.
            */}
            <ColumnChart
              data={hours.map((hour) => ({
                label: hourLabel(hour.index),
                value: hour.plays,
              }))}
              // Every third hour, or the axis is 24 overlapping numbers.
              formatLabel={(label) =>
                Number(label.slice(0, 2)) % 3 === 0 ? label.slice(0, 2) : ''
              }
              // Measured: 24 caps ate a third of the frame's height and left
              // the bars a stub. The numbers stay in the tooltip, the
              // accessible name and the table.
              showValues={false}
              describe={(entry) => `${entry.label}: ${plural(entry.value, 'play')}`}
              emptyMessage="Nothing watched in this range"
            />
          </ChartCard>
        </div>

        <ChartCard
          headingLevel={3}
          title="When you watch"
          description={
            peak
              ? `Weekday against hour. Your busiest hour is ${peak.weekday} at ${hourLabel(peak.hour)}, with ${plural(peak.plays, 'play')}.`
              : 'Weekday against hour, in your own timezone.'
          }
          table={
            <MatrixTable
              caption="Plays by weekday and hour"
              rowHeader="Day"
              rows={punch.weekdays}
              columns={punch.hours.map((hour) => String(hour).padStart(2, '0'))}
              values={punch.plays}
            />
          }
        >
          <MatrixChart
            rows={punch.weekdays.map(shortDay)}
            columns={punch.hours.map((hour) => String(hour).padStart(2, '0'))}
            values={punch.plays}
            max={punch.max_plays}
            columnLabelEvery={3}
            emptyMessage="Nothing watched in this range"
            describe={(row, column, value) =>
              `${punch.weekdays[row]} at ${hourLabel(punch.hours[column])}: ${
                value === 0 ? 'nothing watched' : plural(value, 'play')
              }`
            }
          />
        </ChartCard>
      </Section>

      <Section
        id="composition"
        title="Composition"
        description="What the plays were made of."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <ChartCard
            headingLevel={3}
            title="Most-watched genres"
            description="Counted per play, so a binged series weighs more than a single film. Pick one to browse it."
            table={<DataTable caption="Plays by genre" rows={data.top_genres} valueHeader="Plays" />}
          >
            <BarList
              data={data.top_genres}
              emptyMessage="No genre data yet"
              onSelect={(entry) => navigate(browseLink({ genre: entry.label }))}
            />
          </ChartCard>

          {/*
            `by_type` as bars rather than a donut, and this is not a toss-up: the
            three slices are not disjoint. An anime episode is counted in both
            "Episodes" and "Anime", so the parts do not sum to the whole and a
            pie or a donut would assert a share of a total that does not exist.
            Bars claim nothing beyond "these three counts, side by side", which is
            the only true reading — and they stay one series, so still no legend.
          */}
          <ChartCard
            headingLevel={3}
            title="What you watch"
            description="Plays by kind. Anime overlaps the other two rather than sitting beside them. Pick one to list those plays."
            table={<DataTable caption="Plays by kind" rows={data.by_type} valueHeader="Plays" />}
          >
            <BarList
              data={data.by_type}
              emptyMessage="Nothing watched in this range"
              // By position, not by the server's display label: the three buckets
              // are Movies, Episodes and Anime in that order, and History's own
              // filter takes exactly those three words.
              onSelect={(_entry, index) =>
                navigate(
                  historyLink({
                    ...windowDrill,
                    filter: (['movie', 'episode', 'anime'] as const)[index],
                  }),
                )
              }
            />
          </ChartCard>
        </div>
      </Section>

      <Section id="ratings" title="Ratings" description="What you thought of it.">
        <ChartCard
          headingLevel={3}
          title="How you rate things"
          description="Your own ratings out of 10, synced both ways with Plex. Pick a bar to see those titles."
          table={
            <DataTable
              caption="Titles by rating out of 10"
              rows={data.rating_distribution}
              valueHeader="Titles"
            />
          }
        >
          <ColumnChart
            data={data.rating_distribution}
            formatLabel={(label) => label}
            emptyMessage="You have not rated anything yet"
            describe={(entry) =>
              `${plural(entry.value, 'title')} rated ${entry.label}/10`
            }
            onSelect={(entry) =>
              navigate(
                browseLink({ min_rating: Number(entry.label), max_rating: Number(entry.label) }),
              )
            }
          />
        </ChartCard>
      </Section>

      <Section
        id="rewatch"
        title="Rewatching"
        description="A play counts as a rewatch when it is not the first time you have watched that title — measured against your whole history, never just this window."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="First watches"
            value={compactNumber(rewatch.first_watches)}
            hint="New to you in this window"
          />
          <StatTile
            label="Rewatches"
            value={compactNumber(rewatch.rewatches)}
            hint="Something you had seen before"
          />
          <StatTile
            label="Rewatch share"
            value={`${Math.round(rewatch.rewatch_ratio * 100)}%`}
            hint={`Of ${plural(rewatch.plays, 'play')}`}
            accent={rewatch.rewatch_ratio >= 0.5}
          />
        </div>

        <ChartCard
          headingLevel={3}
          title="First watches and rewatches"
          description="Stacked, because every play is one or the other — the column's height is the period's plays. Pick a column to list them."
          legend={
            <ChartLegend
              series={[
                { label: 'First watch', className: 'bg-series-1' },
                { label: 'Rewatch', className: 'bg-series-2' },
              ]}
            />
          }
          table={
            <DataTable
              caption="First watches and rewatches per period"
              rows={splitBuckets.map((bucket) => ({
                label: spanLabel(bucket),
                value: bucket.first,
              }))}
              valueHeader="First watches"
              compare={{
                header: 'Rewatches',
                rows: splitBuckets.map((bucket) => ({
                  label: spanLabel(bucket),
                  value: bucket.rewatch,
                })),
              }}
            />
          }
        >
          <StackedColumnChart
            data={splitBuckets}
            formatLabel={(label) => axisLabels.get(label) ?? label}
            describe={(bucket) =>
              `${spanLabel(bucket)}: ${bucket.first} first, ${bucket.rewatch} rewatched`
            }
            emptyMessage="Nothing watched in this range"
            onSelect={(bucket) =>
              navigate(
                historyLink({
                  since: startOfDay(parseLocalDateLabel(bucket.from)),
                  until: endOfDay(parseLocalDateLabel(bucket.to)),
                }),
              )
            }
          />
        </ChartCard>

        <ChartCard
          headingLevel={3}
          title="What you come back to"
          // All-time by definition — `ranked_over` says so on the wire — and it
          // has to be said here too, or it reads as a ranking of this window and
          // quietly contradicts the chart above it.
          description="Counted over your whole history, not this window. Pick a title to open it."
          table={
            <DataTable
              caption="Most rewatched titles"
              rows={rewatch.most_rewatched.map((item) => ({
                label: item.show_title ? `${item.show_title} — ${item.title}` : item.title,
                value: item.plays,
              }))}
              valueHeader="Plays"
            />
          }
        >
          <RankedList
            unit="play"
            emptyMessage="Nothing watched more than once yet"
            rows={rewatch.most_rewatched.map((item) => ({
              key: item.media_item_id,
              title: item.show_title ?? item.title,
              subtitle: item.show_title
                ? item.title
                : item.year
                  ? String(item.year)
                  : null,
              posterUrl: item.poster_url,
              value: item.plays,
              // A real instant off the wire, not a `YYYY-MM-DD` label, so
              // `new Date` is the right reader here — it converts the instant
              // into the viewer's own year. The banned form is
              // `new Date('2026-08-16')`, which is UTC midnight by spec.
              meta: `since ${new Date(item.first_watched).getFullYear()}`,
              to: itemLink(item.media_item_id),
            }))}
          />
        </ChartCard>
      </Section>

      <Section
        id="seasonality"
        title="Seasonality"
        description="Every play you have ever recorded, by month of the year. Not bounded by the range above — this one is all-time."
      >
        {/*
          Its own three states, because it is its own request. A shared spinner
          would hold back eight sections for one, and a shared error card would
          blank them out for it.
        */}
        {seasonality.isLoading ? (
          <div className="card flex items-center justify-center gap-3 p-10 text-sm text-muted">
            <Spinner className="text-base" />
            Reading your whole history…
          </div>
        ) : seasonality.isError ? (
          <ErrorState
            error={seasonality.error}
            title="Could not load seasonality"
            onRetry={() => void seasonality.refetch()}
          />
        ) : !season || season.plays === 0 ? (
          <EmptyState
            icon={<ChartIcon />}
            title="No seasonality yet"
            description="This one reads your whole history. Once there are plays across a few months, the pattern shows up here."
          />
        ) : (
          <>
            <ChartCard
              headingLevel={3}
              title="Month of the year"
              description={`Every ${monthNames[0] ?? 'January'} you have on record added together, and so on. ${compactNumber(season.plays)} plays, times in ${season.timezone}.`}
              table={
                <DataTable
                  caption="Plays by month of the year"
                  rows={season.months.map((month) => ({
                    label: month.label,
                    value: month.plays,
                  }))}
                  valueHeader="Plays"
                />
              }
            >
              {/* No drill: "every March there has ever been" is a recurring
                  bucket, and `/history` takes one contiguous window. The cells
                  of the grid below name a single month of a single year, which
                  is a window, so those do drill. */}
              <ColumnChart
                data={season.months.map((month) => ({
                  label: month.label,
                  value: month.plays,
                }))}
                formatLabel={(label) => label.slice(0, 3)}
                describe={(entry) =>
                  `${entry.label}, all years: ${plural(entry.value, 'play')}`
                }
                emptyMessage="Not enough history yet"
              />
            </ChartCard>

            <ChartCard
              headingLevel={3}
              title="Year by month"
              description="One row per year, so a fallow stretch reads as a gap rather than vanishing. Pick a square to list that month."
              table={
                <MatrixTable
                  caption="Plays by year and month"
                  rowHeader="Year"
                  rows={seasonYears.map((year) => String(year.year))}
                  columns={monthNames.map((name) => name.slice(0, 3))}
                  values={seasonYears.map((year) => year.months)}
                />
              }
            >
              <MatrixChart
                rows={seasonYears.map((year) => String(year.year))}
                // Three letters, not one: J, J and J are three different months
                // and so are M and M, so a single initial is not a label.
                columns={monthNames.map((name) => name.slice(0, 3))}
                values={seasonYears.map((year) => year.months)}
                cell={24}
                emptyMessage="Not enough history yet"
                describe={(row, column, value) =>
                  `${monthNames[column] ?? ''} ${seasonYears[row]?.year}: ${
                    value === 0 ? 'nothing watched' : plural(value, 'play')
                  }`
                }
                onSelect={(row, column) =>
                  navigate(historyLink(monthWindow(seasonYears[row].year, column + 1)))
                }
              />

              <div className="mt-5 border-t border-line pt-4">
                <h4 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">
                  Plays per year
                </h4>
                {/* The row headings of a matrix are not buttons, so the year
                    drill lives here, on real ones — the same pairing the
                    calendar heatmap makes with its busiest-days list. */}
                <BarList
                  data={seasonYears.map((year) => ({
                    label: String(year.year),
                    value: year.plays,
                  }))}
                  emptyMessage="Not enough history yet"
                  onSelect={(entry) => navigate(historyLink(yearWindow(Number(entry.label))))}
                />
              </div>
            </ChartCard>
          </>
        )}
      </Section>

      <Section
        id="records"
        title="Streaks and records"
        description="The extremes of this window."
      >
        <div className="card p-5">
          <h3 className="text-base font-semibold tracking-tight text-ink">Streaks</h3>
          <p className="mt-0.5 text-xs text-muted">Consecutive days with something watched.</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <StatTile
              label="Current streak"
              value={plural(data.current_streak_days, 'day')}
              hint={currentRun ? spanLabel(currentRun) : undefined}
              icon={<ClockIcon />}
              accent={data.current_streak_days > 0}
              to={currentRun ? runLink(currentRun) : undefined}
              toLabel={currentRun ? `Current streak of ${currentRun.value} days — see those plays` : undefined}
            />
            <StatTile
              label="Longest streak"
              value={plural(data.longest_streak_days, 'day')}
              hint={longestRun ? spanLabel(longestRun) : undefined}
              icon={<ChartIcon />}
              to={longestRun ? runLink(longestRun) : undefined}
              toLabel={longestRun ? `Longest streak of ${longestRun.value} days — see those plays` : undefined}
            />
          </div>
          <p className="mt-4 text-sm text-muted">
            {data.current_streak_days === 0
              ? 'No active streak — watch something today to start one.'
              : data.current_streak_days >= data.longest_streak_days
                ? 'This is your longest streak so far.'
                : `${data.longest_streak_days - data.current_streak_days} more days to beat your record.`}
          </p>
        </div>

        <div className="card p-5">
          <h3 className="text-base font-semibold tracking-tight text-ink">Records</h3>
          <p className="mt-0.5 text-xs text-muted">
            The single busiest day, and the hour you most often finish on.
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <StatTile
              label="Heaviest day"
              value={busiestDay ? plural(busiestDay.value, 'play') : '—'}
              hint={busiestDay ? formatDay(busiestDay.label) : 'Nothing watched yet'}
              icon={<ChartIcon />}
              to={busiestDay ? historyLink(bucketWindow(busiestDay.label)) : undefined}
              toLabel={
                busiestDay
                  ? `${formatDay(busiestDay.label)}, your heaviest day — see those plays`
                  : undefined
              }
            />
            {/* No link on either of these: an hour is a recurring bucket and
                `/history` has no parameter that can say one. */}
            <StatTile
              label="Peak hour"
              value={peakHour ? hourLabel(peakHour.index) : '—'}
              hint={peakHour ? plural(peakHour.plays, 'play') : 'Nothing watched yet'}
              icon={<ClockIcon />}
            />
            <StatTile
              label="Peak slot"
              value={peak ? `${shortDay(peak.weekday)} ${hourLabel(peak.hour)}` : '—'}
              hint={peak ? plural(peak.plays, 'play') : 'Nothing watched yet'}
              icon={<SparkIcon />}
            />
          </div>
        </div>
      </Section>
    </div>
  )
}
