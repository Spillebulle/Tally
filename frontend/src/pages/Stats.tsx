import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { compactNumber, formatWatchTime } from '@/lib/utils'
import {
  ActivityHeatmap,
  BarList,
  ColumnChart,
  DataTable,
  StatTile,
} from '@/components/Charts'
import { EmptyState, PageHeader, Segmented } from '@/components/ui'
import { ChartIcon, ClockIcon, FilmIcon, SparkIcon, StarIcon, TvIcon } from '@/components/Icons'

type Range = '90' | '365' | '1825'

const RANGE_LABELS: Record<Range, string> = {
  '90': 'Last 90 days',
  '365': 'Last year',
  '1825': 'All time',
}

function ChartCard({
  title,
  description,
  children,
  table,
}: {
  title: string
  description?: string
  children: React.ReactNode
  table?: React.ReactNode
}) {
  return (
    <section className="card p-5">
      <div className="mb-4">
        {/* The heading names the single plotted series, so no legend box. */}
        <h2 className="text-base font-semibold tracking-tight text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      {children}
      {table}
    </section>
  )
}

export function Stats() {
  const [range, setRange] = useState<Range>('365')
  const [scope, setScope] = useState<'all' | 'anime'>('all')

  const { data, isLoading } = useQuery({
    queryKey: ['stats', range, scope],
    queryFn: () => api.stats.get(Number(range), scope === 'anime'),
  })

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

  if (!data || data.watch_events === 0) {
    return (
      <div>
        <PageHeader title="Stats" />
        <EmptyState
          icon={<ChartIcon />}
          title="Nothing to chart yet"
          description="Once Tally has some watch history — imported from Plex or logged here — your habits will show up on this page."
        />
      </div>
    )
  }

  const monthly = data.activity_by_month.slice(-12).map((entry) => ({
    label: new Date(`${entry.label}-01`).toLocaleDateString(undefined, { month: 'short' }),
    value: entry.value,
  }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stats"
        subtitle={`${compactNumber(data.watch_events)} plays · ${formatWatchTime(data.total_runtime_minutes)} watched`}
        actions={
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
              options={(Object.keys(RANGE_LABELS) as Range[]).map((value) => ({
                value,
                label: RANGE_LABELS[value],
              }))}
            />
          </>
        }
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
          {data.total_episodes_watched === 1 ? '' : 's'}.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
        <StatTile
          label="Anime plays"
          value={compactNumber(data.total_anime_watched)}
          hint={`${Math.round((data.total_anime_watched / Math.max(1, data.watch_events)) * 100)}% of everything you watch`}
          icon={<SparkIcon />}
        />
        <StatTile
          label="Average rating"
          value={data.average_rating != null ? `${(data.average_rating / 2).toFixed(1)} / 5` : '—'}
          hint="Across everything you have rated"
          icon={<StarIcon filled />}
        />
      </div>

      <ChartCard
        title="Watch activity"
        description="Plays per day. Darker means a heavier viewing day."
      >
        <ActivityHeatmap data={data.activity_by_day} />
      </ChartCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Most-watched genres"
          description="Counted per play, so a binged series weighs more than a single film."
          table={<DataTable caption="Plays by genre" rows={data.top_genres} valueHeader="Plays" />}
        >
          <BarList data={data.top_genres} emptyMessage="No genre data yet" />
        </ChartCard>

        <ChartCard
          title="How you rate things"
          description="Your own star ratings, synced both ways with Plex."
          table={
            <DataTable
              caption="Ratings by star value"
              rows={data.rating_distribution}
              valueHeader="Titles"
            />
          }
        >
          <ColumnChart
            data={data.rating_distribution}
            formatLabel={(label) => `${label}★`}
            emptyMessage="You have not rated anything yet"
          />
        </ChartCard>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Plays by month"
          description="The last twelve months of viewing."
          table={<DataTable caption="Plays by month" rows={monthly} valueHeader="Plays" />}
        >
          <ColumnChart data={monthly} emptyMessage="Not enough history yet" />
        </ChartCard>

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
    </div>
  )
}
