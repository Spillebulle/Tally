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
 * own heading: `#activity`, `#sessions`, `#composition`, `#rankings`,
 * `#ratings`, `#rewatch`, `#records`, `#watchlist`, `#shows`, `#coverage`,
 * `#seasonality`. A link can target one, and a screen reader's heading list is
 * the outline.
 *
 * ## Six requests, and why they are six
 *
 * `/api/stats` answers the window in one aggregation. The other five — shows,
 * coverage, ratings, rankings, watchlist — are separate endpoints *on purpose*:
 * folding them in would make a page that already runs four aggregations run
 * eleven, on every filter chip. So the page does what the API's own docstring
 * asks for and fetches each **when its section is drawn**:
 *
 *  - Each has its own loading, error and empty state. A failed `/rankings` must
 *    not blank the page or claim the user has watched nothing. `#seasonality`
 *    set that precedent and the four new blocks follow it exactly.
 *  - Each is gated on an `IntersectionObserver` that latches once, 600px ahead
 *    of the viewport, so the sections nobody scrolls to are never paid for. The
 *    gate opens **immediately** when the URL's hash names that section, which
 *    is what keeps a shared link to `#rankings` working — without that, a page
 *    that never scrolls never draws the thing the link pointed at. No observer
 *    at all (an old browser, a test runner) means every section loads eagerly,
 *    which is the safe direction to fail in.
 *  - A pending block reserves its height, so the sections below it do not all
 *    fall inside one observer margin and defeat the whole arrangement.
 *
 * ## What the window does and does not reach
 *
 * `/shows` and `/coverage` take **no window at all** — completion and inventory
 * are facts about a viewer and a library, not about a fortnight. A date range
 * sitting above a section it does not affect is a lie, so those two say "all
 * time" in their own headings and are grouped at the foot of the page with
 * `#seasonality`, which is unwindowed for the same reason. `/watchlist` is
 * windowed on `added_at` rather than on the plays, which is a third meaning of
 * the same control and is stated in the section itself.
 */
import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  api,
  type RankingsQuery,
  type SeasonalityQuery,
  type StatsQuery,
  type UnwindowedStatsQuery,
} from '@/lib/api'
import type {
  ContrarianItem,
  RankedFacet,
  RankedTitle,
  RatingSlice,
  RewatchSplit,
  ShowProgress,
  StatCount,
  StatsPreset,
  StatsRange,
  StatsTotals,
  WatchSession,
} from '@/lib/types'
import {
  compactNumber,
  formatDate,
  formatRuntime,
  formatWatchTime,
  parseLocalDateLabel,
} from '@/lib/utils'
import { useUrlParams } from '@/lib/url-state'
import {
  browseLink,
  bucketWindow,
  decadeBounds,
  endOfDay,
  historyLink,
  itemLink,
  localInstant,
  monthWindow,
  runtimeBounds,
  startOfDay,
  yearWindow,
  type HistoryDrill,
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
  type RankedRow,
  type StatDelta,
  type StackedEntry,
} from '@/components/Charts'
import { EmptyState, ErrorState, PageHeader, Segmented, Spinner } from '@/components/ui'
import {
  BookmarkIcon,
  ChartIcon,
  CheckIcon,
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
 * How many rows each leaderboard asks for.
 *
 * The API takes 1–50 and defaults to 12. Twelve is a list somebody reads; fifty
 * is a dataset, and this page already has eleven sections without turning one
 * of them into a table.
 */
const RANKING_LIMIT = 12

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

/** A 0–1 fraction as a whole percentage. The API sends fractions throughout. */
const percentLabel = (fraction: number) => `${Math.round(fraction * 100)}%`

/**
 * A rating difference with its sign kept.
 *
 * "+1.2" and "-1.2" are opposite findings and the leading `+` is the only thing
 * that says which, so it is written rather than left to the reader.
 */
const signedRating = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}`

/** "S02E05", or null when the payload does not place the episode. */
function episodeCode(season: number | null, episode: number | null): string | null {
  if (season == null || episode == null) return null
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
}

/**
 * A sitting's own window: first scrobble to last.
 *
 * Exact rather than "the day it started on" — a sitting that runs past midnight
 * would lose its tail to a day window, and both ends are real instants off the
 * wire, so there is no calendar arithmetic to get wrong here.
 */
const sessionWindow = (sitting: WatchSession) => ({
  since: new Date(sitting.started_at),
  until: new Date(sitting.ended_at),
})

// ---------------------------------------------------------------------------
// Rows for the ranked lists
// ---------------------------------------------------------------------------

/**
 * One leaderboard row, ranked on whichever number that board is about.
 *
 * `value` is what the bar scales on and `valueLabel` is what is printed, which
 * is the only way a board of hours can rank on minutes and still read "14h".
 * Every one of these goes to the item's own page: a row that *is* a title has
 * a better destination than any filtered view of it.
 */
function titleRow(item: RankedTitle, board: 'episodes' | 'plays' | 'minutes'): RankedRow {
  const shared = {
    key: item.media_item_id,
    title: item.title,
    subtitle: item.year ? String(item.year) : null,
    posterUrl: item.poster_url,
    to: itemLink(item.media_item_id),
  }
  if (board === 'minutes') {
    return {
      ...shared,
      value: item.minutes,
      valueLabel: formatRuntime(item.minutes) ?? '0m',
      meta: plural(item.plays, 'play'),
    }
  }
  if (board === 'episodes') {
    const episodes = item.episodes ?? item.plays
    return {
      ...shared,
      value: episodes,
      // Plex's `leaf_count`, and null when Plex never said — "of 62" is only
      // printable when there is a 62.
      meta: item.episodes_total ? `of ${item.episodes_total}` : formatRuntime(item.minutes),
    }
  }
  return { ...shared, value: item.plays, meta: formatRuntime(item.minutes) }
}

/**
 * A title you and the crowd disagree about.
 *
 * Ranked on the *size* of the gap so both lists share one shape, and labelled
 * with the signed difference so the direction is never carried by which list it
 * is in alone.
 */
const contrarianRow = (item: ContrarianItem): RankedRow => ({
  key: item.media_item_id,
  title: item.title,
  subtitle: item.year ? String(item.year) : null,
  posterUrl: item.poster_url,
  value: Math.abs(item.difference),
  valueLabel: signedRating(item.difference),
  meta: `you ${item.rating} · crowd ${item.community_rating}`,
  to: itemLink(item.media_item_id),
})

/**
 * A facet ranking row, in the shape the bar list reads.
 *
 * The bar scales on **plays**, which is what the ranking is about, and the
 * count of distinct titles rides along in `meta`: "300 plays" is one binged
 * series or thirty films and the bar alone cannot tell them apart.
 */
interface FacetEntry extends StatCount {
  titles: number
  minutes: number
}

/**
 * What qualifies an average-rating bar: how many titles it is over, and what
 * the crowd said about the same slice.
 *
 * The crowd's figure is absent when nothing in the slice carries a community
 * score, and it is left out rather than written as a zero — "the crowd rates
 * this genre 0.0" is a different and false claim.
 */
const ratingMeta = (slice: RatingSlice) =>
  `${plural(slice.count, 'title')}${
    slice.community_average != null ? ` · crowd ${slice.community_average.toFixed(1)}` : ''
  }`

const facetEntries = (rows: RankedFacet[]): FacetEntry[] =>
  rows.map((row) => ({
    label: row.label,
    value: row.plays,
    titles: row.titles,
    minutes: row.minutes,
  }))

function FacetCard({
  title,
  description,
  caption,
  rows,
  onSelect,
  empty,
}: {
  title: string
  description: string
  caption: string
  rows: FacetEntry[]
  onSelect?: (entry: FacetEntry) => void
  empty: string
}) {
  return (
    <ChartCard
      headingLevel={3}
      title={title}
      description={description}
      table={<DataTable caption={caption} rows={rows} valueHeader="Plays" />}
    >
      <BarList
        data={rows}
        emptyMessage={empty}
        onSelect={onSelect && ((entry) => onSelect(entry))}
        meta={(entry) =>
          `${plural(entry.titles, 'title')} · ${formatRuntime(entry.minutes) ?? '—'}`
        }
      />
    </ChartCard>
  )
}

/**
 * How far through a show, as a row.
 *
 * Ranked on episodes watched rather than on percentage, because the percentage
 * is *nullable* — a show whose episode count Plex never gave has none, and a
 * list that sorted on it would have to invent a number for those rows or drop
 * them. The percentage is printed beside the count when it exists and named as
 * missing when it does not.
 */
const progressRow = (show: ShowProgress): RankedRow => ({
  key: show.media_item_id,
  title: show.title,
  subtitle: (() => {
    const code = episodeCode(show.last_season, show.last_episode)
    if (!code) return show.year ? String(show.year) : null
    return show.last_episode_title ? `${code} · ${show.last_episode_title}` : code
  })(),
  posterUrl: show.poster_url,
  value: show.episodes_watched,
  valueLabel:
    show.percent_complete != null
      ? `${Math.round(show.percent_complete)}%`
      : plural(show.episodes_watched, 'ep'),
  // Kept short deliberately: the meta column is `shrink-0`, so a long one eats
  // the title beside it — measured at 375px, "episode count looks stale" cut a
  // series name down to two words. What the two phrases *mean* is spelled out
  // once under the tiles rather than on every row.
  meta:
    show.percent_complete != null
      ? `${show.episodes_watched} of ${show.episodes_total}`
      : show.total_is_stale
        ? 'total looks stale'
        : 'total unknown',
  to: itemLink(show.media_item_id),
})

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
  scope,
  innerRef,
  children,
}: {
  id: string
  title: string
  description?: string
  /**
   * What window this section covers, when it is not the page's.
   *
   * A badge rather than a sentence buried in the description, because the
   * control that appears to govern it is at the top of the page and out of
   * sight by the time these sections are on screen. `/shows` and `/coverage`
   * take no window at all; the watchlist block takes one over a different
   * column. Each has to say so where it is read.
   */
  scope?: string
  innerRef?: (node: HTMLElement | null) => void
  children: React.ReactNode
}) {
  return (
    <section
      id={id}
      ref={innerRef}
      aria-labelledby={`${id}-heading`}
      className="scroll-mt-6 space-y-4"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id={`${id}-heading`} className="text-lg font-semibold tracking-tight text-ink">
            {title}
          </h2>
          {scope && (
            <span className="rounded-full border border-line px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-muted">
              {scope}
            </span>
          )}
        </div>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/**
 * Whether a section has come near enough the viewport to be worth fetching.
 *
 * Latched: once true it never goes back, so scrolling past a section and back
 * does not re-mount its queries. Three ways to open the gate, and the last two
 * are the ones that matter:
 *
 *  - the observer fires, 600px before the section reaches the screen;
 *  - the URL's hash names this section, which is checked *before* the first
 *    render — a shared link to `#rankings` must not depend on somebody
 *    scrolling, and nothing scrolls a page whose content has not arrived;
 *  - there is no `IntersectionObserver`, in which case everything loads at
 *    once, because a section that never loads is a worse failure than a
 *    request that was not needed.
 *
 * The node arrives through a callback ref rather than a `useRef`, because the
 * sections do not exist on the first render — the page is still a skeleton —
 * and an effect keyed on a mutable ref would never see them appear.
 */
function useDrawn(id: string, hash: string) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [drawn, setDrawn] = useState(
    () => hash === `#${id}` || typeof IntersectionObserver === 'undefined',
  )

  useEffect(() => {
    if (hash === `#${id}`) setDrawn(true)
  }, [hash, id])

  useEffect(() => {
    if (drawn || !node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setDrawn(true)
      },
      // Ahead of the viewport, so the request is in flight by the time the
      // section is read rather than starting when it is already being looked at.
      { rootMargin: '600px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [drawn, node])

  return { ref: setNode, drawn }
}

/** What one lazily-fetched block is doing, in the shape `Block` reads. */
interface BlockState {
  drawn: boolean
  /**
   * Nothing has arrived yet — react-query's `isPending`, deliberately, not
   * `isLoading`.
   *
   * `isLoading` is false for a query whose `enabled` has only just flipped
   * true, because the fetch starts in an effect one tick later. That single
   * frame of "not loading, no data" is enough to flash the empty state, which
   * on this page reads as "you have watched nothing" over data that is on its
   * way.
   */
  pending: boolean
  isError: boolean
  error: unknown
  refetch: () => void
}

/** The pair of objects a lazy block is made of, as one state. */
const blockState = (
  section: { drawn: boolean },
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown },
): BlockState => ({
  drawn: section.drawn,
  pending: query.isPending,
  isError: query.isError,
  error: query.error,
  refetch: () => void query.refetch(),
})

/**
 * The four states of a section that fetches its own data.
 *
 * One component rather than four copies of the same ternary, and the order is
 * the rule this codebase keeps getting bitten by: **`isError` before the empty
 * branch**. Falling through told users their library was empty while hiding a
 * 500, on a page where five blocks can now fail independently.
 *
 * "Not drawn yet" renders a reserved-height skeleton rather than nothing, for
 * two reasons: the page does not jump when the answer lands, and the blocks
 * below stay far enough apart that one observer margin does not open all of
 * them at once.
 */
function Block({
  state,
  ready,
  empty,
  errorTitle,
  loadingText = 'Loading…',
  children,
}: {
  state: BlockState
  /** False while the payload is missing or says there is nothing to draw. */
  ready: boolean
  empty: { title: string; description: string; action?: React.ReactNode }
  errorTitle: string
  loadingText?: string
  children: React.ReactNode
}) {
  if (!state.drawn || state.pending) {
    return (
      <div
        className="card flex min-h-[14rem] items-center justify-center gap-3 p-10 text-sm text-muted"
        role="status"
      >
        {state.drawn && <Spinner className="text-base" />}
        {state.drawn ? loadingText : ''}
      </div>
    )
  }
  if (state.isError) {
    return <ErrorState error={state.error} title={errorTitle} onRetry={state.refetch} />
  }
  if (!ready) {
    return (
      <EmptyState
        icon={<ChartIcon />}
        title={empty.title}
        description={empty.description}
        action={empty.action}
      />
    )
  }
  return <>{children}</>
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function Stats() {
  const navigate = useNavigate()
  // Read through the router rather than off `window`, so the value is the one
  // the app itself navigated to and not a stale read from before hydration.
  const { hash } = useLocation()
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

  /**
   * The window every windowed request shares.
   *
   * Held apart from `query` because `compare` belongs to the main aggregation
   * alone — the depth endpoints take no such flag, and passing one would put a
   * parameter in a cache key that cannot change the answer.
   */
  const windowQuery: StatsQuery = {
    // A half-finished custom range asks the default question rather than a
    // rejected one: the point of validating on read is that a bad URL still
    // renders a page.
    ...(customRange
      ? { since: localInstant(customRange.since), until: localInstant(customRange.until) }
      : { preset: apiPreset }),
    anime_only: scope === 'anime',
    tz: timezone,
  }

  const query: StatsQuery = {
    ...windowQuery,
    // The API works out the preceding window itself, timezone and all, and
    // hands back both its bounds and the percent movement. Re-deriving "the 90
    // days before these 90 days" on the client would be a second opinion on a
    // calculation that has to agree.
    ...(compare === 'previous' ? { compare: true } : {}),
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

  // --- the five depth blocks, each fetched when its section is drawn -------
  //
  // `enabled` is the whole arrangement: five more aggregations on mount is
  // exactly the cost the API split these out to avoid, and most loads of this
  // page never reach the foot of it.

  const rankingsQuery: RankingsQuery = { ...windowQuery, limit: RANKING_LIMIT }
  const rankingsSection = useDrawn('rankings', hash)
  const rankings = useQuery({
    queryKey: ['stats', 'rankings', rankingsQuery],
    queryFn: () => api.stats.rankings(rankingsQuery),
    enabled: rankingsSection.drawn,
  })

  const ratingsSection = useDrawn('ratings', hash)
  const ratingDepth = useQuery({
    queryKey: ['stats', 'rating-depth', windowQuery],
    queryFn: () => api.stats.ratings(windowQuery),
    enabled: ratingsSection.drawn,
  })

  const watchlistSection = useDrawn('watchlist', hash)
  const conversion = useQuery({
    queryKey: ['stats', 'watchlist-conversion', windowQuery],
    queryFn: () => api.stats.watchlistConversion(windowQuery),
    enabled: watchlistSection.drawn,
  })

  // The two that take no window at all, so only the scope is in the key —
  // changing the date range must not refetch them, because it cannot change
  // what they say.
  const unwindowed: UnwindowedStatsQuery = { anime_only: scope === 'anime' }

  const showsSection = useDrawn('shows', hash)
  const completion = useQuery({
    queryKey: ['stats', 'show-completion', unwindowed],
    queryFn: () => api.stats.shows(unwindowed),
    enabled: showsSection.drawn,
  })

  const coverageSection = useDrawn('coverage', hash)
  const coverage = useQuery({
    queryKey: ['stats', 'coverage', unwindowed],
    queryFn: () => api.stats.coverage(unwindowed),
    enabled: coverageSection.drawn,
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

  // --- sittings -----------------------------------------------------------

  const sessions = data.sessions

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

  // --- the lazily-fetched blocks ------------------------------------------
  //
  // Each is `undefined` until its section has been drawn and its request has
  // answered; `Block` renders the state and only then the children, so every
  // reader below is inside a `&&` on the same value.

  const board = rankings.data
  const depth = ratingDepth.data
  const watchlist = conversion.data
  const shows = completion.data
  const shelf = coverage.data

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

      {/*
        Sittings ride on the main response rather than an endpoint of their own
        — they are derived from the same rows the totals came from — so this
        section needs no `Block` and no states beyond the page's.
      */}
      <Section
        id="sessions"
        title="Sittings"
        description={`A run of plays with no gap longer than ${sessions.gap_minutes} minutes counts as one sitting. There is no start time recorded anywhere, so the gap between two scrobbles is the only evidence a sitting ended.`}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Sittings"
            value={compactNumber(sessions.sessions)}
            hint={`From ${plural(sessions.plays, 'play')}`}
            icon={<PlayIcon />}
          />
          <StatTile
            label="Plays per sitting"
            value={sessions.average_plays.toFixed(1)}
            hint="On average"
            icon={<TvIcon />}
          />
          <StatTile
            label="Time per sitting"
            value={formatWatchTime(Math.round(sessions.average_minutes))}
            hint="On average"
            icon={<ClockIcon />}
          />
        </div>

        <ChartCard
          headingLevel={3}
          title="Plays in a sitting"
          // No drill: this counts *sittings*, and nothing downstream knows what
          // a sitting is — the threshold is a judgement made server-side. The
          // two sittings named below do drill, because each one is a window.
          description="How many sittings were one episode, and how many were six. Counted in sittings, so these bars are not clickable — the two below are."
          table={
            <DataTable
              caption="Sittings by number of plays"
              rows={sessions.by_size}
              valueHeader="Sittings"
            />
          }
        >
          <ColumnChart
            data={sessions.by_size}
            formatLabel={(label) => label}
            describe={(entry) =>
              `${plural(entry.value, 'sitting')} of ${entry.label} ${
                entry.label === '1' ? 'play' : 'plays'
              }`
            }
            emptyMessage="Nothing watched in this range"
          />
        </ChartCard>

        {(sessions.longest || sessions.biggest_binge) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {sessions.longest && (
              <StatTile
                label="Longest sitting"
                value={formatWatchTime(sessions.longest.minutes)}
                hint={`${formatDay(sessions.longest.day)} · ${
                  sessions.longest.show_title ?? sessions.longest.title
                }`}
                icon={<ClockIcon />}
                to={historyLink(sessionWindow(sessions.longest))}
                toLabel={`Longest sitting, ${formatWatchTime(sessions.longest.minutes)} on ${formatDay(sessions.longest.day)} — see those plays`}
              />
            )}
            {sessions.biggest_binge && (
              <StatTile
                label="Biggest binge"
                value={plural(sessions.biggest_binge.plays, 'play')}
                hint={`${formatDay(sessions.biggest_binge.day)} · ${
                  sessions.biggest_binge.show_title ?? sessions.biggest_binge.title
                }`}
                icon={<SparkIcon />}
                accent={sessions.biggest_binge.plays >= 4}
                to={historyLink(sessionWindow(sessions.biggest_binge))}
                toLabel={`Biggest binge, ${plural(sessions.biggest_binge.plays, 'play')} on ${formatDay(sessions.biggest_binge.day)} — see those plays`}
              />
            )}
          </div>
        )}
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
              onSelect={(entry) => navigate(browseLink({ genre: [entry.label] }))}
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

      <Section
        id="rankings"
        title="Leaderboards"
        description="What you watched most of in this range, and where it came from."
        innerRef={rankingsSection.ref}
      >
        <Block
          state={blockState(rankingsSection, rankings)}
          ready={Boolean(board && board.top_by_runtime.length > 0)}
          errorTitle="Could not load the leaderboards"
          loadingText="Ranking this window…"
          empty={{
            title: 'Nothing to rank yet',
            description: 'Once there are plays in this range, the titles and studios behind them are ranked here.',
          }}
        >
          {board && (
            <div className="space-y-6">
              <div className="grid gap-6 lg:grid-cols-2">
                <ChartCard
                  headingLevel={3}
                  title="Most-watched series"
                  description="By distinct episodes played in this range — a rewatched episode counts once. Pick one to open it."
                  table={
                    <DataTable
                      caption="Series by episodes watched"
                      rows={board.top_shows.map((item) => ({
                        label: item.title,
                        value: item.episodes ?? item.plays,
                      }))}
                      valueHeader="Episodes"
                    />
                  }
                >
                  <RankedList
                    unit="episode"
                    rows={board.top_shows.map((item) => titleRow(item, 'episodes'))}
                    emptyMessage="No episodes watched in this range"
                  />
                </ChartCard>

                <ChartCard
                  headingLevel={3}
                  title="Most-played films"
                  description="By plays, so a film watched twice in this range outranks one watched once. Pick one to open it."
                  table={
                    <DataTable
                      caption="Films by plays"
                      rows={board.top_films.map((item) => ({
                        label: item.title,
                        value: item.plays,
                      }))}
                      valueHeader="Plays"
                    />
                  }
                >
                  <RankedList
                    unit="play"
                    rows={board.top_films.map((item) => titleRow(item, 'plays'))}
                    emptyMessage="No films watched in this range"
                  />
                </ChartCard>
              </div>

              <ChartCard
                headingLevel={3}
                title="Where the hours went"
                description="Films and series by total time, with episodes rolled up into their series. Pick one to open it."
                table={
                  <DataTable
                    caption="Titles by minutes watched"
                    rows={board.top_by_runtime.map((item) => ({
                      label: item.title,
                      value: item.minutes,
                    }))}
                    valueHeader="Minutes"
                  />
                }
              >
                <RankedList
                  unit="minute"
                  rows={board.top_by_runtime.map((item) => titleRow(item, 'minutes'))}
                  emptyMessage="Nothing watched in this range"
                />
              </ChartCard>

              {/*
                Facets counted in *plays over this window*, so they drill to
                History with the window and the facet together — which is
                exactly the set that was counted. `/browse` would answer with
                every title that studio ever made, watched or not.
              */}
              <div className="grid gap-6 lg:grid-cols-2">
                <FacetCard
                  title="Studios"
                  description="Plays by studio, read through the series for an episode. Pick one to list those plays."
                  caption="Plays by studio"
                  rows={facetEntries(board.studios)}
                  empty="No studio recorded on anything in this range"
                  onSelect={(entry) =>
                    navigate(historyLink({ ...windowDrill, studio: [entry.label] }))
                  }
                />
                <FacetCard
                  title="Networks"
                  description="Plays by network. Pick one to list those plays."
                  caption="Plays by network"
                  rows={facetEntries(board.networks)}
                  empty="No network recorded on anything in this range"
                  onSelect={(entry) =>
                    navigate(historyLink({ ...windowDrill, network: [entry.label] }))
                  }
                />
                <FacetCard
                  title="Release decades"
                  description="Plays by when the title came out — an episode's own year, not its series'. Pick one to list those plays."
                  caption="Plays by release decade"
                  rows={facetEntries(board.decades)}
                  empty="No release year recorded on anything in this range"
                  // Only when every label parses. The API sends "1990s" and not
                  // its bounds, so an unrecognised label has no link to give and
                  // a list where one row silently does nothing is worse than a
                  // list of none.
                  onSelect={
                    board.decades.every((row) => decadeBounds(row.label))
                      ? (entry) =>
                          navigate(
                            historyLink({
                              ...windowDrill,
                              ...(decadeBounds(entry.label) as HistoryDrill),
                            }),
                          )
                      : undefined
                  }
                />
                <FacetCard
                  title="Certificates"
                  description="Plays by content rating. Pick one to list those plays."
                  caption="Plays by certificate"
                  rows={facetEntries(board.content_ratings)}
                  empty="No certificate recorded on anything in this range"
                  onSelect={(entry) =>
                    navigate(
                      historyLink({ ...windowDrill, content_rating: [entry.label] }),
                    )
                  }
                />
                {/* No drill: neither destination filters on how a play reached
                    Tally, and this is a diagnostic more than a statistic — a
                    Plex Pass instance sees webhook and history rows for plays
                    the sync has since reconciled into one. */}
                <FacetCard
                  title="How the plays arrived"
                  description="Which route recorded each play. Not a filter anywhere, so these rows do not lead off the page."
                  caption="Plays by source"
                  rows={facetEntries(board.by_source)}
                  empty="Nothing watched in this range"
                />
              </div>
            </div>
          )}
        </Block>
      </Section>

      <Section id="ratings" title="Ratings" description="What you thought of it." innerRef={ratingsSection.ref}>
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

        {/*
          Everything below comes from `/api/stats/ratings`, which is its own
          request and therefore its own three states. The distribution above is
          on the main response and stays readable whatever this one does.
        */}
        <Block
          state={blockState(ratingsSection, ratingDepth)}
          ready={Boolean(depth && depth.rated > 0)}
          errorTitle="Could not load the rating breakdown"
          loadingText="Comparing your ratings…"
          empty={{
            title: 'Nothing rated in this range',
            description:
              'Rate something — here or in Plex, the two sync both ways — and this compares your scores with the crowd’s.',
          }}
        >
          {depth && (
            <div className="space-y-6">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile
                  label="Your average"
                  value={depth.average_rating != null ? depth.average_rating.toFixed(1) : '—'}
                  hint={`Across ${plural(depth.rated, 'title')}`}
                  icon={<StarIcon filled />}
                />
                <StatTile
                  label="The crowd"
                  value={
                    depth.average_community != null
                      ? depth.average_community.toFixed(1)
                      : '—'
                  }
                  // The denominator of every agreement number here, so it is
                  // printed rather than left to be inferred from two counts.
                  hint={`${compactNumber(depth.rated_with_community)} comparable`}
                  icon={<StarIcon />}
                />
                <StatTile
                  label="You versus them"
                  value={
                    depth.average_difference != null
                      ? signedRating(depth.average_difference)
                      : '—'
                  }
                  hint={
                    depth.average_absolute_difference != null
                      ? `${depth.average_absolute_difference.toFixed(1)} apart either way`
                      : 'Nothing comparable'
                  }
                  icon={<ChartIcon />}
                />
                <StatTile
                  label="Agreement"
                  value={
                    depth.agreement_within_one != null
                      ? percentLabel(depth.agreement_within_one)
                      : '—'
                  }
                  hint="Within 1 point"
                  icon={<CheckIcon />}
                />
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                {/*
                  Ranked on the size of the gap, labelled with its direction.
                  Both lists go to the title itself: a row that *is* one film
                  has a better destination than a grid filtered down to it.
                */}
                <ChartCard
                  headingLevel={3}
                  title="You rate higher"
                  description="Where you are kinder than the crowd. Pick a title to open it."
                  table={
                    <DataTable
                      caption="Titles you rate above the crowd"
                      rows={depth.you_rate_higher.map((item) => ({
                        label: item.title,
                        value: item.difference,
                      }))}
                      valueHeader="Difference"
                    />
                  }
                >
                  <RankedList
                    unit="point"
                    rows={depth.you_rate_higher.map(contrarianRow)}
                    emptyMessage="Nothing you scored above the crowd"
                  />
                </ChartCard>

                <ChartCard
                  headingLevel={3}
                  title="You rate lower"
                  description="Where you are harsher than the crowd. Pick a title to open it."
                  table={
                    <DataTable
                      caption="Titles you rate below the crowd"
                      rows={depth.you_rate_lower.map((item) => ({
                        label: item.title,
                        value: item.difference,
                      }))}
                      valueHeader="Difference"
                    />
                  }
                >
                  <RankedList
                    unit="point"
                    rows={depth.you_rate_lower.map(contrarianRow)}
                    emptyMessage="Nothing you scored below the crowd"
                  />
                </ChartCard>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                {/*
                  These bars are your *average score* in a slice, not a count,
                  so the crowd's average for the same slice rides in the meta
                  line rather than as a second series — two bars of averages in
                  one frame invites reading the pair as a total.

                  The drill is honest but wider than the bar: it lands on every
                  title you have rated in that slice, not only the ones watched
                  in this window, because "rated during a window" is not a
                  question `/browse` can be asked. The description says so.
                */}
                <ChartCard
                  headingLevel={3}
                  title="Your rating by genre"
                  description="Your average score out of 10, with the crowd's beside it. Pick one to browse everything you have rated in that genre."
                  table={
                    <DataTable
                      caption="Average rating by genre"
                      rows={depth.by_genre.map((slice) => ({
                        label: slice.label,
                        value: slice.average,
                      }))}
                      valueHeader="Your average"
                    />
                  }
                >
                  <BarList
                    data={depth.by_genre.map((slice) => ({
                      label: slice.label,
                      value: slice.average,
                      slice,
                    }))}
                    emptyMessage="Nothing rated in this range"
                    // Ratings are 0-10 everywhere in Tally, so the bar is a
                    // score and not a ranking.
                    scaleTo={10}
                    meta={(entry) => ratingMeta(entry.slice)}
                    onSelect={(entry) =>
                      navigate(
                        // `min_rating: 0` is "has a rating of yours at all" —
                        // the API compares against `UserMediaState.rating`, and
                        // an unrated title has no row to satisfy it.
                        browseLink({
                          genre: [entry.label],
                          min_rating: 0,
                          sort: 'rating',
                        }),
                      )
                    }
                  />
                </ChartCard>

                <ChartCard
                  headingLevel={3}
                  title="Your rating by decade"
                  description="Whether you are kinder to older films. Pick one to browse what you rated from it."
                  table={
                    <DataTable
                      caption="Average rating by release decade"
                      rows={depth.by_decade.map((slice) => ({
                        label: slice.label,
                        value: slice.average,
                      }))}
                      valueHeader="Your average"
                    />
                  }
                >
                  <BarList
                    data={depth.by_decade.map((slice) => ({
                      label: slice.label,
                      value: slice.average,
                      slice,
                    }))}
                    emptyMessage="Nothing rated in this range"
                    // Ratings are 0-10 everywhere in Tally, so the bar is a
                    // score and not a ranking.
                    scaleTo={10}
                    meta={(entry) => ratingMeta(entry.slice)}
                    onSelect={
                      depth.by_decade.every((slice) => decadeBounds(slice.label))
                        ? (entry) =>
                            navigate(
                              browseLink({
                                ...decadeBounds(entry.label)!,
                                min_rating: 0,
                                sort: 'rating',
                              }),
                            )
                        : undefined
                    }
                  />
                </ChartCard>
              </div>

              <ChartCard
                headingLevel={3}
                title="Your rating by length"
                description={
                  depth.runtime_unknown > 0
                    ? `Whether a three-hour film has to earn it. ${plural(depth.runtime_unknown, 'rated title')} have no runtime recorded and are in no bucket. Pick one to browse it.`
                    : 'Whether a three-hour film has to earn it. Pick one to browse it.'
                }
                table={
                  <DataTable
                    caption="Average rating by runtime"
                    rows={depth.by_runtime.map((slice) => ({
                      label: slice.label,
                      value: slice.average,
                    }))}
                    valueHeader="Your average"
                  />
                }
              >
                <BarList
                  data={depth.by_runtime.map((slice) => ({
                    label: slice.label,
                    value: slice.average,
                    slice,
                  }))}
                  emptyMessage="Nothing rated in this range"
                  scaleTo={10}
                  meta={(entry) => ratingMeta(entry.slice)}
                  // The bucket labels are the server's and carry no bounds, so
                  // the map in `drill-links` is the only thing that can turn one
                  // into a filter — and a label it does not know takes the whole
                  // list out of the tab order rather than leaving a dead row.
                  onSelect={
                    depth.by_runtime.every((slice) => runtimeBounds(slice.label))
                      ? (entry) =>
                          navigate(
                            browseLink({
                              ...runtimeBounds(entry.label)!,
                              min_rating: 0,
                              sort: 'rating',
                            }),
                          )
                      : undefined
                  }
                />
              </ChartCard>
            </div>
          )}
        </Block>
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

      <Section
        id="watchlist"
        title="Watchlist conversion"
        scope="Added in this range"
        description="Does watchlisting something mean you watch it? The range above bounds when an entry was added here — not when it was played, which is the only bound that makes the question answerable."
        innerRef={watchlistSection.ref}
      >
        <Block
          state={blockState(watchlistSection, conversion)}
          ready={Boolean(watchlist && watchlist.added > 0)}
          errorTitle="Could not load watchlist conversion"
          loadingText="Following your watchlist…"
          empty={{
            title: 'Nothing watchlisted in this range',
            description:
              'Add something to your watchlist — here or in Plex Discover — and this follows how long it takes you to get to it.',
            action: (
              <Link to="/watchlist" className="btn-outline mt-2">
                Open your watchlist
              </Link>
            ),
          }}
        >
          {watchlist && (
            <div className="space-y-6">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile
                  label="Added"
                  value={compactNumber(watchlist.added)}
                  hint="In this range"
                  icon={<BookmarkIcon />}
                />
                <StatTile
                  label="Watched since"
                  value={compactNumber(watchlist.converted)}
                  // A play *before* the add is not a conversion, and saying so
                  // is the difference between this number and "how many of
                  // these have I seen".
                  hint={`${percentLabel(watchlist.conversion_rate)} of them`}
                  icon={<CheckIcon />}
                  accent={watchlist.conversion_rate >= 0.5}
                />
                <StatTile
                  label="Median wait"
                  value={
                    watchlist.median_days_to_watch != null
                      ? plural(Math.round(watchlist.median_days_to_watch), 'day')
                      : '—'
                  }
                  // Median rather than mean: one title watchlisted in 2019 and
                  // played last week drags an average past anything useful.
                  hint="Add to first play"
                  icon={<ClockIcon />}
                />
                <StatTile
                  label="Still waiting"
                  value={compactNumber(watchlist.still_waiting)}
                  hint={`${watchlist.waiting_past_tail} past ${plural(watchlist.tail_days, 'day')}`}
                  icon={<TvIcon />}
                />
              </div>

              <ChartCard
                headingLevel={3}
                title="Waiting the longest"
                description={
                  watchlist.churned > 0
                    ? `Oldest first. ${plural(watchlist.removed, 'entry')} added in this range have since been removed, ${watchlist.churned} of them never played at all. Pick a title to open it.`
                    : 'Oldest first — the entries that have been on the list longest without a play. Pick a title to open it.'
                }
                table={
                  <DataTable
                    caption="Watchlist entries waiting the longest"
                    rows={watchlist.waiting.map((entry) => ({
                      label: entry.title,
                      value: entry.days_waiting,
                    }))}
                    valueHeader="Days waiting"
                  />
                }
              >
                <RankedList
                  unit="day"
                  emptyMessage="Nothing is waiting — everything added in this range has been played"
                  rows={watchlist.waiting.map((entry) => ({
                    key: entry.media_item_id,
                    title: entry.title,
                    subtitle: entry.year ? String(entry.year) : null,
                    posterUrl: entry.poster_url,
                    value: entry.days_waiting,
                    valueLabel: plural(entry.days_waiting, 'day'),
                    // A real instant off the wire, so `new Date` is the right
                    // reader — the banned form is `new Date('2026-08-16')`.
                    meta: `added ${formatDate(entry.added_at)}`,
                    to: itemLink(entry.media_item_id),
                  }))}
                />
                <div className="mt-4 border-t border-line pt-3">
                  <Link
                    to="/watchlist"
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    See the whole watchlist →
                  </Link>
                </div>
              </ChartCard>
            </div>
          )}
        </Block>
      </Section>

      <Section
        id="shows"
        title="Series progress"
        scope="All time"
        description="How far through each series you are, and the ones you walked away from. Deliberately not bounded by the range above: being 40% through a series is a fact about you and that series, and scoping it to a fortnight would report something you finished last year as barely started."
        innerRef={showsSection.ref}
      >
        <Block
          state={blockState(showsSection, completion)}
          ready={Boolean(shows && shows.shows_started > 0)}
          errorTitle="Could not load series progress"
          loadingText="Reading every episode you have watched…"
          empty={{
            title: 'No series started yet',
            description:
              'Once you have watched an episode of something, how far through it you are shows up here.',
          }}
        >
          {shows && (
            <div className="space-y-6">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile
                  label="Series started"
                  value={compactNumber(shows.shows_started)}
                  hint="One episode or more"
                  icon={<TvIcon />}
                />
                <StatTile
                  label="Finished"
                  value={compactNumber(shows.shows_completed)}
                  hint="Every episode played"
                  icon={<CheckIcon />}
                />
                <StatTile
                  label="Part-way through"
                  value={compactNumber(shows.shows_in_progress)}
                  // Four tiles across leaves about 180px of hint. The long form
                  // — "with no episode count from Plex" — truncates to nothing
                  // useful, so the count is terse here and the fact it counts
                  // is spelled out under the tiles.
                  hint={
                    shows.shows_unknown_total > 0
                      ? `${shows.shows_unknown_total} totals unknown`
                      : 'Still going'
                  }
                  icon={<PlayIcon />}
                />
                <StatTile
                  label="Given up on"
                  value={compactNumber(shows.shows_abandoned)}
                  // The thresholds are a judgement, not a fact, so the tile
                  // states them rather than presenting the count as one.
                  hint={`Under ${Math.round(shows.abandoned_under_percent)}%, ${shows.abandoned_after_days}d idle`}
                  icon={<ClockIcon />}
                />
              </div>

              {shows.shows_unknown_total > 0 && (
                <p className="text-xs text-muted">
                  {shows.shows_unknown_total} of these have no episode count from Plex, so
                  how far through them you are is unknown rather than estimated —
                  counting the episode rows Tally happens to hold would report every one of
                  them as finished.
                </p>
              )}

              <div className="grid gap-6 lg:grid-cols-2">
                <ChartCard
                  headingLevel={3}
                  title="Still going"
                  description="Most recently watched first, with where you stopped. Pick one to open it."
                  table={
                    <DataTable
                      caption="Series in progress, by episodes watched"
                      rows={shows.in_progress.map((show) => ({
                        label: show.title,
                        value: show.episodes_watched,
                      }))}
                      valueHeader="Episodes watched"
                    />
                  }
                >
                  <RankedList
                    unit="episode"
                    rows={shows.in_progress.map(progressRow)}
                    emptyMessage="Nothing part-way through"
                  />
                </ChartCard>

                <ChartCard
                  headingLevel={3}
                  title="Walked away from"
                  description={`Dropped outright, or under ${Math.round(shows.abandoned_under_percent)}% and untouched for ${shows.abandoned_after_days} days. Pick one to pick it back up.`}
                  table={
                    <DataTable
                      caption="Abandoned series, by episodes watched"
                      rows={shows.abandoned.map((show) => ({
                        label: show.title,
                        value: show.episodes_watched,
                      }))}
                      valueHeader="Episodes watched"
                    />
                  }
                >
                  <RankedList
                    unit="episode"
                    rows={shows.abandoned.map(progressRow)}
                    emptyMessage="Nothing abandoned — you finish what you start"
                  />
                </ChartCard>
              </div>
            </div>
          )}
        </Block>
      </Section>

      <Section
        id="coverage"
        title="Library coverage"
        scope="All time"
        description="How much of what you own you have actually watched. An inventory rather than a viewing habit, so the range above does not apply to it."
        innerRef={coverageSection.ref}
      >
        <Block
          state={blockState(coverageSection, coverage)}
          ready={Boolean(shelf && shelf.owned > 0)}
          errorTitle="Could not load library coverage"
          loadingText="Counting the shelf…"
          empty={{
            title: 'Nothing on the shelf yet',
            description:
              'Once a Plex library has been scanned, how much of it you have seen shows up here.',
          }}
        >
          {shelf && (
            <div className="space-y-6">
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile
                  label="On the shelf"
                  value={compactNumber(shelf.owned)}
                  hint="Films and series on Plex"
                  icon={<FilmIcon />}
                />
                <StatTile
                  label="Watched"
                  value={compactNumber(shelf.watched)}
                  hint={`${percentLabel(shelf.percent)} of the shelf`}
                  icon={<CheckIcon />}
                  accent={shelf.percent >= 0.5}
                />
                <StatTile
                  label="Not yet watched"
                  value={compactNumber(shelf.unwatched)}
                  hint={`${percentLabel(1 - shelf.percent)} still to go`}
                  icon={<BookmarkIcon />}
                />
              </div>

              {/*
                Stated rather than left in a tile hint that truncates, because
                it is the one place on this page where home videos are treated
                differently from everywhere else — every watch figure above
                counts them, since those hours were really watched.
              */}
              <p className="text-xs text-muted">
                {shelf.includes_personal
                  ? 'Home videos are counted in this inventory. Every other figure on this page counts them too, because a play is a play.'
                  : 'Home videos are left out of this inventory — the one figure on this page that does leave them out, because a phone recording is not a title you have failed to get round to. Every watch figure above still counts them.'}
              </p>

              <div className="grid gap-6 lg:grid-cols-2">
                {/* No drill: `/browse` has no media-type parameter of its own —
                    the Films and Series grids are separate pages that force
                    their own scope, and sending somebody there would change
                    more than the one thing they clicked. */}
                <ChartCard
                  headingLevel={3}
                  title="By kind"
                  description="What share of your films, and of your series, you have watched."
                  table={
                    <DataTable
                      caption="Coverage by kind, percent watched"
                      rows={shelf.by_type.map((slice) => ({
                        label: slice.label,
                        value: Math.round(slice.percent * 100),
                      }))}
                      valueHeader="Percent watched"
                    />
                  }
                >
                  <BarList
                    data={shelf.by_type.map((slice) => ({
                      label: slice.label,
                      value: Math.round(slice.percent * 100),
                      slice,
                    }))}
                    unit="%"
                    // A percentage has a ceiling, so the track is 0-100 rather
                    // than "relative to the biggest slice".
                    scaleTo={100}
                    emptyMessage="Nothing on the shelf"
                    meta={(entry) =>
                      `${entry.slice.watched.toLocaleString()} of ${entry.slice.owned.toLocaleString()} watched`
                    }
                  />
                </ChartCard>

                <ChartCard
                  headingLevel={3}
                  title="By genre"
                  description="The twenty genres you own most of. Pick one to browse what you have not seen in it."
                  table={
                    <DataTable
                      caption="Coverage by genre, percent watched"
                      rows={shelf.by_genre.map((slice) => ({
                        label: slice.label,
                        value: Math.round(slice.percent * 100),
                      }))}
                      valueHeader="Percent watched"
                    />
                  }
                >
                  <BarList
                    data={shelf.by_genre.map((slice) => ({
                      label: slice.label,
                      value: Math.round(slice.percent * 100),
                      slice,
                    }))}
                    unit="%"
                    // A percentage has a ceiling, so the track is 0-100 rather
                    // than "relative to the biggest slice".
                    scaleTo={100}
                    emptyMessage="No genres recorded yet"
                    meta={(entry) =>
                      `${entry.slice.watched.toLocaleString()} of ${entry.slice.owned.toLocaleString()} watched`
                    }
                    // Straight at the remainder: owned, in this genre, unwatched
                    // — and carrying the same home-video decision the inventory
                    // above was counted with, or the grid would disagree with
                    // the bar that opened it.
                    onSelect={(entry) =>
                      navigate(
                        browseLink({
                          genre: [entry.label],
                          status: 'unwatched',
                          on_plex: true,
                          personal: shelf.includes_personal ? 'all' : 'exclude',
                        }),
                      )
                    }
                  />
                </ChartCard>
              </div>

              <ChartCard
                headingLevel={3}
                title="By release decade"
                description="Where the gaps are. Pick a decade to browse what you own from it and have not watched."
                table={
                  <DataTable
                    caption="Coverage by release decade, percent watched"
                    rows={shelf.by_decade.map((slice) => ({
                      label: slice.label,
                      value: Math.round(slice.percent * 100),
                    }))}
                    valueHeader="Percent watched"
                  />
                }
              >
                <BarList
                  data={shelf.by_decade.map((slice) => ({
                    label: slice.label,
                    value: Math.round(slice.percent * 100),
                    slice,
                  }))}
                  unit="%"
                  scaleTo={100}
                  emptyMessage="No release years recorded yet"
                  meta={(entry) =>
                    `${entry.slice.watched.toLocaleString()} of ${entry.slice.owned.toLocaleString()} watched`
                  }
                  onSelect={
                    shelf.by_decade.every((slice) => decadeBounds(slice.label))
                      ? (entry) =>
                          navigate(
                            browseLink({
                              ...decadeBounds(entry.label)!,
                              status: 'unwatched',
                              on_plex: true,
                              personal: shelf.includes_personal ? 'all' : 'exclude',
                            }),
                          )
                      : undefined
                  }
                />
              </ChartCard>
            </div>
          )}
        </Block>
      </Section>

      <Section
        id="seasonality"
        title="Seasonality"
        scope="All time"
        description="Every play you have ever recorded, by month of the year. Not bounded by the range above."
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
    </div>
  )
}
