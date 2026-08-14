import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth, useToast } from '@/lib/app-context'
import type { ContinueWatchingItem, MediaCard } from '@/lib/types'
import {
  cn,
  compactNumber,
  displaySubtitle,
  formatWatchTime,
  posterFallbackGradient,
  relativeTime,
} from '@/lib/utils'
import { PosterRail } from '@/components/Poster'
import { StatTile } from '@/components/Charts'
import { EmptyState, Spinner } from '@/components/ui'
import {
  ChartIcon,
  CheckIcon,
  ClockIcon,
  FilmIcon,
  PlayIcon,
  SparkIcon,
  TvIcon,
} from '@/components/Icons'

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 5) return 'Still up'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/** Wide hero card for something the user is partway through. */
function ContinueCard({
  entry,
  onMarkWatched,
  markingId = null,
}: {
  entry: ContinueWatchingItem
  onMarkWatched: (card: MediaCard) => void
  /** Item whose mark-as-watched is in flight, if any. */
  markingId?: number | null
}) {
  const target = entry.next_episode ?? entry.item
  const poster = entry.item.poster_url ?? entry.show?.poster_url
  const heading = entry.show?.title ?? entry.item.show_title ?? entry.item.title
  const sub = entry.next_episode
    ? `Up next · ${displaySubtitle(entry.next_episode)}`
    : displaySubtitle(entry.item)

  return (
    <article
      className="group card flex gap-4 overflow-hidden p-3 transition-all duration-300
                 ease-spring hover:-translate-y-0.5 hover:shadow-lift"
    >
      <Link
        to={`/item/${target.id}`}
        className="relative h-[132px] w-[88px] shrink-0 overflow-hidden rounded-lg bg-raised"
        style={poster ? undefined : { background: posterFallbackGradient(heading) }}
      >
        {poster && (
          <img src={poster} alt="" loading="lazy" className="h-full w-full object-cover" />
        )}
        <span
          className="absolute inset-0 grid place-items-center bg-black/45 opacity-0
                     transition-opacity group-hover:opacity-100"
        >
          <PlayIcon className="text-2xl text-white" />
        </span>
      </Link>

      <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
        <div className="min-w-0">
          <Link
            to={`/item/${target.id}`}
            className="line-clamp-1 font-medium text-ink hover:text-accent"
          >
            {heading}
          </Link>
          <p className="mt-0.5 line-clamp-1 text-sm text-muted">{sub}</p>
          {entry.item.is_anime && (
            <span className="mt-2 inline-flex items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
              <SparkIcon className="text-[11px]" />
              Anime
            </span>
          )}
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
            <span>
              {entry.next_episode
                ? `${entry.item.watched_episodes ?? 0}/${entry.item.total_episodes ?? '?'} episodes`
                : `${Math.round(entry.progress_percent)}% watched`}
            </span>
            <span>{relativeTime(entry.resumed_at)}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-700 ease-spring"
                style={{ width: `${Math.max(2, Math.min(100, entry.progress_percent))}%` }}
              />
            </div>
            <button
              type="button"
              onClick={() => onMarkWatched(target)}
              disabled={markingId === target.id}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted
                         transition-colors hover:bg-raised hover:text-good"
              title={markingId === target.id ? 'Marking as watched…' : 'Mark as watched'}
              aria-label={
                markingId === target.id
                  ? `Marking ${target.title} as watched`
                  : `Mark ${target.title} as watched`
              }
            >
              {markingId === target.id ? (
                <Spinner className="text-base" />
              ) : (
                <CheckIcon className="text-base" />
              )}
            </button>
          </div>
        </div>
      </div>
    </article>
  )
}

/** Keep the fold useful: the rest of the dashboard should stay reachable. */
const CONTINUE_LIMIT = 6

export function Dashboard() {
  const { user } = useAuth()
  const { notify } = useToast()
  const queryClient = useQueryClient()
  const [showAllContinue, setShowAllContinue] = useState(false)

  const continueWatching = useQuery({
    queryKey: ['continue-watching'],
    queryFn: api.media.continueWatching,
    refetchInterval: 60_000,
  })
  const recentlyWatched = useQuery({
    queryKey: ['recently-watched'],
    queryFn: () => api.media.recentlyWatched(20),
  })
  const recentlyAdded = useQuery({
    queryKey: ['recently-added'],
    queryFn: () => api.media.recentlyAdded(undefined, 20),
  })
  const recentAnime = useQuery({
    queryKey: ['recently-added', 'anime'],
    queryFn: () => api.media.recentlyAdded('only', 20),
  })
  const stats = useQuery({ queryKey: ['stats', 365], queryFn: () => api.stats.get(365) })
  const summary = useQuery({ queryKey: ['summary'], queryFn: api.stats.summary })

  const markWatched = useMutation({
    mutationFn: (card: MediaCard) => api.history.markWatched(card.id),
    onSuccess: (_data, card) => {
      notify(`Logged “${card.title}” as watched`, 'success')
      queryClient.invalidateQueries({ queryKey: ['continue-watching'] })
      queryClient.invalidateQueries({ queryKey: ['recently-watched'] })
      queryClient.invalidateQueries({ queryKey: ['history'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const visibleContinue = showAllContinue
    ? (continueWatching.data ?? [])
    : (continueWatching.data ?? []).slice(0, CONTINUE_LIMIT)

  const libraryEmpty =
    summary.isSuccess &&
    summary.data.library_movies === 0 &&
    summary.data.library_shows === 0

  const name = user?.display_name || user?.username || ''

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">
          {greeting()}
          {name ? `, ${name.split(' ')[0]}` : ''}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {stats.data
            ? `${compactNumber(stats.data.watch_events)} plays logged over the past year · ${formatWatchTime(stats.data.total_runtime_minutes)} of screen time`
            : 'Loading your viewing history…'}
        </p>
      </div>

      {libraryEmpty && (
        <EmptyState
          icon={<TvIcon />}
          title="Your library is empty"
          description="Connect your Plex server and run a first sync to import everything you have watched."
          action={
            <Link to="/settings" className="btn-primary mt-2">
              Set up Plex
            </Link>
          }
        />
      )}

      {/* Continue watching */}
      {(continueWatching.isLoading || (continueWatching.data?.length ?? 0) > 0) && (
        <section className="animate-fade-up">
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2 className="text-lg font-semibold tracking-tight text-ink">
              Continue watching
            </h2>
            {(continueWatching.data?.length ?? 0) > CONTINUE_LIMIT && (
              <button
                type="button"
                onClick={() => setShowAllContinue((value) => !value)}
                className="text-sm text-muted hover:text-accent"
              >
                {showAllContinue
                  ? 'Show fewer'
                  : `Show all ${continueWatching.data?.length}`}
              </button>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {continueWatching.isLoading
              ? Array.from({ length: 3 }, (_, index) => (
                  <div key={index} className="skeleton h-[156px] rounded-2xl" />
                ))
              : visibleContinue.map((entry) => (
                  <ContinueCard
                    key={`${entry.item.id}-${entry.next_episode?.id ?? 'self'}`}
                    entry={entry}
                    onMarkWatched={(card) => markWatched.mutate(card)}
                    markingId={markWatched.isPending ? markWatched.variables.id : null}
                  />
                ))}
          </div>
        </section>
      )}

      {/* At-a-glance figures */}
      {stats.data && (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Movies watched"
            value={compactNumber(stats.data.total_movies_watched)}
            hint="Past 12 months"
            icon={<FilmIcon />}
          />
          <StatTile
            label="Episodes watched"
            value={compactNumber(stats.data.total_episodes_watched)}
            hint="Past 12 months"
            icon={<TvIcon />}
          />
          <StatTile
            label="Anime plays"
            value={compactNumber(stats.data.total_anime_watched)}
            hint={`${summary.data?.library_anime ?? 0} titles in your library`}
            icon={<SparkIcon />}
          />
          <StatTile
            label="Current streak"
            value={`${stats.data.current_streak_days} ${stats.data.current_streak_days === 1 ? 'day' : 'days'}`}
            hint={`Longest: ${stats.data.longest_streak_days} days`}
            icon={<ClockIcon />}
            accent={stats.data.current_streak_days > 0}
          />
        </section>
      )}

      <PosterRail
        title="Recently watched"
        cards={recentlyWatched.data ?? []}
        loading={recentlyWatched.isLoading}
        action={
          <Link to="/history" className="text-sm text-muted hover:text-accent">
            All history →
          </Link>
        }
      />

      <PosterRail
        title="Recently added to Plex"
        cards={recentlyAdded.data ?? []}
        loading={recentlyAdded.isLoading}
        onQuickWatch={(card) => markWatched.mutate(card)}
        quickWatchPendingId={markWatched.isPending ? markWatched.variables.id : null}
      />

      <PosterRail
        title="New anime"
        cards={recentAnime.data ?? []}
        loading={recentAnime.isLoading}
        action={
          <Link to="/anime" className="text-sm text-muted hover:text-accent">
            Browse anime →
          </Link>
        }
        onQuickWatch={(card) => markWatched.mutate(card)}
        quickWatchPendingId={markWatched.isPending ? markWatched.variables.id : null}
      />

      {stats.data && stats.data.top_genres.length > 0 && (
        <section className="animate-fade-up">
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2 className="text-lg font-semibold tracking-tight text-ink">
              What you gravitate to
            </h2>
            <Link to="/stats" className="text-sm text-muted hover:text-accent">
              Full stats →
            </Link>
          </div>
          <div className="flex flex-wrap gap-2">
            {stats.data.top_genres.slice(0, 10).map((genre, index) => (
              <Link
                key={genre.label}
                to={`/movies?genre=${encodeURIComponent(genre.label)}`}
                className={cn('chip', index === 0 && 'chip-active')}
              >
                {genre.label}
                <span className="tabular-nums text-muted">{genre.value}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {!libraryEmpty && !stats.isLoading && stats.data?.watch_events === 0 && (
        <EmptyState
          icon={<ChartIcon />}
          title="Nothing logged yet"
          description="Once you watch something on Plex — or mark it watched here — it will show up in your history and stats."
        />
      )}
    </div>
  )
}
