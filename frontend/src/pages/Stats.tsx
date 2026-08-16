import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type StatsQuery } from '@/lib/api'
import type { StatCount, StatsPreset, StatsRange, StatsTotals } from '@/lib/types'
import { compactNumber, formatWatchTime, parseLocalDateLabel } from '@/lib/utils'
import { useUrlParams } from '@/lib/url-state'
import {
  browseLink,
  bucketWindow,
  endOfDay,
  historyLink,
  localInstant,
  startOfDay,
} from '@/lib/drill-links'
import {
  ActivityHeatmap,
  BarList,
  ChartCard,
  ChartLegend,
  ColumnChart,
  DataTable,
  StatTile,
  type StatDelta,
} from '@/components/Charts'
import { EmptyState, ErrorState, PageHeader, Segmented } from '@/components/ui'
import { ChartIcon, ClockIcon, FilmIcon, SparkIcon, StarIcon, TvIcon } from '@/components/Icons'

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

// ---------------------------------------------------------------------------
// Series shaping
// ---------------------------------------------------------------------------

/** A chunk of the day series, carrying the raw bounds a drill needs. */
interface PeriodBucket extends StatCount {
  from: string
  to: string
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
  const size = Math.max(1, Math.ceil(days.length / count))
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

/** "12 – 24 Aug 2026", or one date when the span is a single day. */
const spanLabel = (bucket: PeriodBucket) =>
  bucket.from === bucket.to
    ? formatDay(bucket.from)
    : `${formatDay(bucket.from, false)} – ${formatDay(bucket.to)}`

const describeBucket = (bucket: PeriodBucket) =>
  `${spanLabel(bucket)}: ${bucket.value} ${bucket.value === 1 ? 'play' : 'plays'}`

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
  const busiest = [...data.activity_by_day]
    .filter((day) => day.value > 0)
    .sort((left, right) => right.value - left.value || (left.label < right.label ? 1 : -1))
    .slice(0, 6)
    .map((day) => ({ label: formatDay(day.label), value: day.value, day: day.label }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stats"
        subtitle={`${compactNumber(data.watch_events)} plays · ${formatWatchTime(data.total_runtime_minutes)} watched`}
      />

      {controls}

      {/* Hero figure — exactly one per view. */}
      <div className="card overflow-hidden p-6">
        <p className="label">Total time watched</p>
        <p className="mt-2 text-5xl font-semibold tracking-tight text-ink">
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
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
        {/* No hint: five tiles across leaves ~140px of text, and a hint that
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
          label="Average rating"
          value={
            data.average_rating != null
              ? `${data.average_rating.toFixed(1)} / 10`
              : '—'
          }
          hint="Everything you rated"
          icon={<StarIcon filled />}
          delta={deltaFor('average_rating', (value) => value.toFixed(1))}
        />
      </div>

      <ChartCard
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
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">
              Busiest days
            </h3>
            <BarList
              data={busiest}
              emptyMessage="Nothing watched in this range"
              onSelect={(entry) => navigate(historyLink(bucketWindow(entry.day)))}
            />
          </div>
        )}
      </ChartCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
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

        <ChartCard
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
              `${entry.value} ${entry.value === 1 ? 'title' : 'titles'} rated ${entry.label}/10`
            }
            onSelect={(entry) =>
              navigate(
                browseLink({ min_rating: Number(entry.label), max_rating: Number(entry.label) }),
              )
            }
          />
        </ChartCard>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {comparisonReady ? (
          /*
            The one chart on this page with two series, and therefore the one
            that gets a legend: a heading can name a single series but it cannot
            tell two apart. The columns align by *offset into the window* rather
            than by label — the whole point is that the second window is a
            different stretch of calendar.
          */
          <ChartCard
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
                `${monthName(entry.label, true)}: ${entry.value} ${entry.value === 1 ? 'play' : 'plays'}`
              }
              emptyMessage="Not enough history yet"
              onSelect={(entry) => navigate(historyLink(bucketWindow(entry.label)))}
            />
          </ChartCard>
        )}

        {/*
          `by_type` as bars rather than a donut, and this is not a toss-up: the
          three slices are not disjoint. An anime episode is counted in both
          "Episodes" and "Anime", so the parts do not sum to the whole and a
          pie or a donut would assert a share of a total that does not exist.
          Bars claim nothing beyond "these three counts, side by side", which is
          the only true reading — and they stay one series, so still no legend.
        */}
        <ChartCard
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

      <section className="card p-5">
        <h2 className="text-base font-semibold tracking-tight text-ink">Streaks</h2>
        <p className="mt-0.5 text-xs text-muted">Consecutive days with something watched.</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <StatTile
            label="Current streak"
            value={`${data.current_streak_days} ${data.current_streak_days === 1 ? 'day' : 'days'}`}
            hint={currentRun ? spanLabel(currentRun) : undefined}
            icon={<ClockIcon />}
            accent={data.current_streak_days > 0}
            to={currentRun ? runLink(currentRun) : undefined}
            toLabel={currentRun ? `Current streak of ${currentRun.value} days — see those plays` : undefined}
          />
          <StatTile
            label="Longest streak"
            value={`${data.longest_streak_days} ${data.longest_streak_days === 1 ? 'day' : 'days'}`}
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
      </section>
    </div>
  )
}
