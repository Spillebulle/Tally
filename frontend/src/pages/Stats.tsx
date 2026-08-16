import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { compactNumber, formatWatchTime, parseLocalDateLabel } from '@/lib/utils'
import { useUrlParams } from '@/lib/url-state'
import {
  ActivityHeatmap,
  BarList,
  ChartCard,
  ColumnChart,
  DataTable,
  StatTile,
} from '@/components/Charts'
import { EmptyState, ErrorState, PageHeader, Segmented } from '@/components/ui'
import { ChartIcon, ClockIcon, FilmIcon, SparkIcon, StarIcon, TvIcon } from '@/components/Icons'

const RANGES = ['90', '365', '1825'] as const
type Range = (typeof RANGES)[number]

const RANGE_LABELS: Record<Range, string> = {
  '90': 'Last 90 days',
  '365': 'Last year',
  '1825': 'All time',
}

const SCOPES = ['all', 'anime'] as const
type Scope = (typeof SCOPES)[number]

/**
 * The stats query, in the URL.
 *
 * It used to be `useState`, which made this the one screen whose view could not
 * be linked, bookmarked or returned to — the rest of the app keeps its whole
 * query in the query string for exactly that reason.
 *
 * Not `useBrowseFilters`: that one owns a page number and a sort whitelist and
 * shapes its output for `/api/media`, none of which this page has. Both sit on
 * the same primitive instead, which is where the three URL rules live — the
 * defaults never reach the URL, a value the API would reject falls back rather
 * than becoming a 422, and picking a range replaces rather than pushes.
 *
 * `range` is validated against the three offered values and not merely parsed:
 * `days` is declared `ge=7, le=3650` on the API, so `?range=99999` or
 * `?range=banana` would be an error card where the charts should be.
 */
function useStatsFilters() {
  const { values, set, reset, active } = useUrlParams({
    range: { key: 'range', allowed: RANGES, fallback: '365' as Range },
    scope: { key: 'scope', allowed: SCOPES, fallback: 'all' as Scope },
  })
  return {
    range: values.range,
    scope: values.scope,
    setRange: (value: Range) => set('range', value),
    setScope: (value: Scope) => set('scope', value),
    reset,
    active,
  }
}

export function Stats() {
  const navigate = useNavigate()
  const { range, scope, setRange, setScope, reset, active } = useStatsFilters()

  const { data, isLoading, isError, error, refetch } = useQuery({
    // Deliberately a different key shape from Dashboard's `['stats', 365]`: that
    // one asks a fixed question and this one asks whatever the URL says, so the
    // two do not share a cache entry. Every invalidation is by the `['stats']`
    // prefix, which reaches both.
    queryKey: ['stats', range, scope],
    queryFn: () => api.stats.get(Number(range), scope === 'anime'),
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
    <>
      <Segmented
        label="Scope"
        value={scope}
        onChange={setScope}
        options={[
          { value: 'all', label: 'Everything' },
          { value: 'anime', label: 'Anime only' },
        ]}
      />
      <Segmented
        label="Time range"
        value={range}
        onChange={setRange}
        options={RANGES.map((value) => ({ value, label: RANGE_LABELS[value] }))}
      />
    </>
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
        {/* No controls when there is genuinely nothing: a range picker over an
            empty history is a dead control on the one page that has to explain
            itself instead. */}
        <PageHeader title="Stats" actions={noHistoryAnywhere ? undefined : controls} />
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stats"
        subtitle={`${compactNumber(data.watch_events)} plays · ${formatWatchTime(data.total_runtime_minutes)} watched`}
        actions={controls}
      />

      {/* Hero figure — exactly one per view. */}
      <div className="card overflow-hidden p-6">
        <p className="label">Total time watched · {RANGE_LABELS[range].toLowerCase()}</p>
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
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="Films"
          value={compactNumber(data.total_movies_watched)}
          icon={<FilmIcon />}
        />
        <StatTile
          label="Episodes"
          value={compactNumber(data.total_episodes_watched)}
          icon={<TvIcon />}
        />
        {/* No hint: five tiles across leaves ~140px of text, and a hint that
            truncates to "Shows you have watche…" says less than nothing. */}
        <StatTile
          label="Series"
          value={compactNumber(data.total_shows_watched)}
          icon={<TvIcon />}
        />
        <StatTile
          label="Anime plays"
          value={compactNumber(data.total_anime_watched)}
          hint={`${Math.round((data.total_anime_watched / Math.max(1, data.watch_events)) * 100)}% of your plays`}
          icon={<SparkIcon />}
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
        />
      </div>

      <ChartCard
        title="Watch activity"
        description="Plays per day. Darker means a heavier viewing day."
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
        <ActivityHeatmap data={data.activity_by_day} />
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
            onSelect={(entry) => navigate(`/browse?genre=${encodeURIComponent(entry.label)}`)}
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
              navigate(`/browse?min_rating=${entry.label}&max_rating=${entry.label}`)
            }
          />
        </ChartCard>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Plays by month"
          description="The last twelve months of viewing."
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
          title="What you watch"
          description="Plays by kind. Anime overlaps the other two rather than sitting beside them."
          table={<DataTable caption="Plays by kind" rows={data.by_type} valueHeader="Plays" />}
        >
          <BarList data={data.by_type} emptyMessage="Nothing watched in this range" />
        </ChartCard>
      </div>

      <section className="card p-5">
        <h2 className="text-base font-semibold tracking-tight text-ink">Streaks</h2>
        <p className="mt-0.5 text-xs text-muted">Consecutive days with something watched.</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <StatTile
            label="Current streak"
            value={`${data.current_streak_days} ${data.current_streak_days === 1 ? 'day' : 'days'}`}
            icon={<ClockIcon />}
            accent={data.current_streak_days > 0}
          />
          <StatTile
            label="Longest streak"
            value={`${data.longest_streak_days} ${data.longest_streak_days === 1 ? 'day' : 'days'}`}
            icon={<ChartIcon />}
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
