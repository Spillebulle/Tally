import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useToast } from '@/lib/app-context'
import type { MediaCard, MediaDetail, WatchStatus } from '@/lib/types'
import { cn, formatDate, formatRuntime, relativeTime, STATUS_LABELS } from '@/lib/utils'
import { Artwork, PosterRail } from '@/components/Poster'
import {
  BookmarkIcon,
  CheckIcon,
  ChevronLeftIcon,
  HeartIcon,
  SparkIcon,
  XIcon,
} from '@/components/Icons'
import { ErrorState, Spinner, StarRating, StatusBadge } from '@/components/ui'

const STATUS_OPTIONS: WatchStatus[] = [
  'plan_to_watch',
  'watching',
  'completed',
  'on_hold',
  'dropped',
]

export function ItemDetail() {
  const { id } = useParams<{ id: string }>()
  const itemId = Number(id)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const [openSeason, setOpenSeason] = useState<number | null>(null)
  // React Router keeps this component mounted across /item/:id changes, so
  // without resetting, navigating from one show to another opened the new one
  // with the previous show's season expanded — and an empty episode list when
  // that show has fewer seasons.
  const [seasonForItem, setSeasonForItem] = useState(itemId)
  if (seasonForItem !== itemId) {
    setSeasonForItem(itemId)
    setOpenSeason(null)
  }

  const { data: item, isLoading } = useQuery({
    queryKey: ['item', itemId],
    queryFn: () => api.media.detail(itemId),
    enabled: Number.isFinite(itemId),
  })

  const seasons = useQuery({
    queryKey: ['children', itemId],
    queryFn: () => api.media.children(itemId),
    enabled: item?.media_type === 'show',
  })

  const episodes = useQuery({
    queryKey: ['children', itemId, openSeason],
    queryFn: () => api.media.children(itemId, openSeason ?? undefined),
    enabled: item?.media_type === 'show' && openSeason !== null,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['item', itemId] })
    queryClient.invalidateQueries({ queryKey: ['children', itemId] })
    queryClient.invalidateQueries({ queryKey: ['media'] })
    queryClient.invalidateQueries({ queryKey: ['stats'] })
    queryClient.invalidateQueries({ queryKey: ['history'] })
    queryClient.invalidateQueries({ queryKey: ['continue-watching'] })
    // Marking something watched takes it out of every recommendation shelf.
    queryClient.invalidateQueries({ queryKey: ['recommendations'] })
  }

  const rate = useMutation({
    mutationFn: (rating: number | null) => api.media.setRating(itemId, rating),
    onSuccess: (_data, rating) => {
      notify(rating === null ? 'Rating cleared' : 'Rating saved and pushed to Plex', 'success')
      invalidate()
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const setStatus = useMutation({
    mutationFn: (status: WatchStatus | null) => api.media.setStatus(itemId, status),
    onSuccess: invalidate,
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const toggleFavorite = useMutation({
    mutationFn: (value: boolean) => api.media.setFavorite(itemId, value),
    // Fill the heart on click rather than on the round trip. It is one small
    // boolean and the button has no other pending affordance, so without this
    // the click looked like it had missed. Rolled back if the write fails.
    onMutate: async (value: boolean) => {
      await queryClient.cancelQueries({ queryKey: ['item', itemId] })
      const previous = queryClient.getQueryData<MediaDetail>(['item', itemId])
      queryClient.setQueryData<MediaDetail>(['item', itemId], (old) =>
        old
          ? {
              ...old,
              state: old.state
                ? { ...old.state, is_favorite: value }
                : old.state,
            }
          : old,
      )
      return { previous }
    },
    onError: (error: Error, _value, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['item', itemId], context.previous)
      }
      notify(error.message, 'error')
    },
    onSettled: invalidate,
  })

  const markWatched = useMutation({
    mutationFn: (target: number) => api.history.markWatched(target),
    onSuccess: () => {
      notify('Marked as watched', 'success')
      invalidate()
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const markUnwatched = useMutation({
    mutationFn: (target: number) => api.history.markUnwatched(target),
    onSuccess: () => {
      notify('Cleared watch history for this item', 'info')
      invalidate()
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const markSeason = useMutation({
    mutationFn: (season: number) => api.history.markSeasonWatched(itemId, season),
    onSuccess: (result) => {
      notify(`Marked ${result.marked} episodes as watched`, 'success')
      invalidate()
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const watchlist = useMutation({
    mutationFn: async (add: boolean) => {
      if (add) await api.watchlist.add(itemId)
      else await api.watchlist.remove(itemId)
    },
    onSuccess: (_data, add) => {
      notify(add ? 'Added to your Plex watchlist' : 'Removed from your watchlist', 'success')
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['watchlist'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="skeleton h-[280px] rounded-2xl" />
        <div className="skeleton h-6 w-1/3 rounded" />
        <div className="skeleton h-24 rounded-xl" />
      </div>
    )
  }

  if (!item) {
    return (
      <div className="py-20 text-center">
        <p className="text-lg font-medium text-ink">That item could not be found.</p>
        <button type="button" onClick={() => navigate(-1)} className="btn-outline mt-4">
          Go back
        </button>
      </div>
    )
  }

  const watched = (item.state?.view_count ?? 0) > 0
  const progressPercent =
    item.state?.progress_ms && item.state.duration_ms
      ? Math.round((item.state.progress_ms / item.state.duration_ms) * 100)
      : null
  const episodeProgress =
    item.watched_episodes != null && item.total_episodes
      ? Math.round((item.watched_episodes / item.total_episodes) * 100)
      : null

  const facts: Array<[string, string]> = [
    item.first_aired ? ['Released', formatDate(item.first_aired)] : null,
    formatRuntime(item.runtime_minutes) ? ['Runtime', formatRuntime(item.runtime_minutes)!] : null,
    item.content_rating ? ['Rated', item.content_rating] : null,
    item.studio ? ['Studio', item.studio] : null,
    item.network ? ['Network', item.network] : null,
    item.release_status ? ['Status', item.release_status] : null,
    item.anime_format ? ['Format', item.anime_format] : null,
    item.state?.last_watched_at
      ? ['Last watched', relativeTime(item.state.last_watched_at)]
      : null,
    (item.state?.view_count ?? 0) > 1 ? ['Plays', String(item.state?.view_count)] : null,
  ].filter(Boolean) as Array<[string, string]>

  return (
    <div className="-mt-6 sm:-mt-8">
      {/* Backdrop hero */}
      <Artwork
        src={item.backdrop_url}
        title={item.title}
        showTitle={false}
        imgClassName="object-top"
        className="-mx-4 h-[220px] sm:-mx-6 sm:h-[320px]"
      >
        {/* Scrim so the title below stays readable over any artwork. */}
        <div className="absolute inset-0 bg-gradient-to-t from-canvas via-canvas/70 to-canvas/20" />

        <button
          type="button"
          onClick={() => navigate(-1)}
          className="absolute left-4 top-4 inline-flex items-center gap-1.5 rounded-xl
                     bg-black/40 px-3 py-1.5 text-sm text-white backdrop-blur-sm
                     transition-colors hover:bg-black/60 sm:left-6"
        >
          <ChevronLeftIcon /> Back
        </button>
      </Artwork>

      <div className="relative -mt-24 sm:-mt-32">
        <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
          {/* Poster */}
          <div className="w-32 shrink-0 sm:w-52">
            <Artwork
              src={item.poster_url}
              title={item.title}
              className="aspect-[2/3] rounded-2xl bg-raised shadow-lift ring-1 ring-line"
            />
          </div>

          {/* Headline block */}
          <div className="min-w-0 flex-1 pt-2 sm:pt-16">
            <div className="flex flex-wrap items-center gap-2">
              {item.is_anime && (
                <span className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
                  <SparkIcon className="text-[12px]" /> Anime
                </span>
              )}
              <StatusBadge status={item.state?.status ?? null} />
              {!item.available_on_plex && (
                <span className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted">
                  Not on your server
                </span>
              )}
            </div>

            <h1 className="mt-2 text-balance text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              {item.title}
            </h1>

            {item.media_type === 'episode' && item.show_title && (
              <Link
                to={`/item/${item.show_id}`}
                className="mt-1 inline-block text-sm text-muted hover:text-accent"
              >
                {item.show_title} · S{item.season_number}E{item.episode_number}
              </Link>
            )}

            {item.tagline && (
              <p className="mt-2 text-balance text-sm italic text-muted">{item.tagline}</p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              {item.year && <span>{item.year}</span>}
              {formatRuntime(item.runtime_minutes) && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{formatRuntime(item.runtime_minutes)}</span>
                </>
              )}
              {item.community_rating != null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{item.community_rating.toFixed(1)} community</span>
                </>
              )}
            </div>

            {item.genres.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {item.genres.slice(0, 8).map((genre) => (
                  <Link
                    key={genre}
                    // /browse, not /movies or /shows: those force
                    // `anime: 'exclude'`, so an anime title's own genre chip
                    // led to a grid guaranteed not to contain it.
                    to={`/browse?genre=${encodeURIComponent(genre)}`}
                    className="chip"
                  >
                    {genre}
                  </Link>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              {item.media_type !== 'show' && (
                <button
                  type="button"
                  onClick={() =>
                    watched ? markUnwatched.mutate(item.id) : markWatched.mutate(item.id)
                  }
                  disabled={markWatched.isPending || markUnwatched.isPending}
                  className={cn(watched ? 'btn-outline' : 'btn-primary')}
                >
                  {markWatched.isPending || markUnwatched.isPending ? (
                    <Spinner />
                  ) : watched ? (
                    <XIcon />
                  ) : (
                    <CheckIcon />
                  )}
                  {watched ? 'Mark unwatched' : 'Mark watched'}
                </button>
              )}

              <button
                type="button"
                onClick={() => watchlist.mutate(!item.on_watchlist)}
                disabled={watchlist.isPending}
                className="btn-outline"
              >
                {/* Adding writes through to the Plex watchlist, so this is a
                    real round trip and needs to say so. */}
                {watchlist.isPending ? (
                  <Spinner />
                ) : (
                  <BookmarkIcon className={item.on_watchlist ? 'text-accent' : undefined} />
                )}
                {item.on_watchlist ? 'On watchlist' : 'Add to watchlist'}
              </button>

              <button
                type="button"
                onClick={() => toggleFavorite.mutate(!item.state?.is_favorite)}
                className="btn-ghost h-10 w-10 rounded-xl p-0"
                title={item.state?.is_favorite ? 'Remove from favourites' : 'Add to favourites'}
                aria-label={item.state?.is_favorite ? 'Remove from favourites' : 'Add to favourites'}
              >
                <HeartIcon
                  filled={item.state?.is_favorite}
                  className={cn('text-lg', item.state?.is_favorite && 'text-danger')}
                />
              </button>
            </div>

            {/* Rating + status */}
            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
              <div>
                <p className="label mb-1.5">Your rating</p>
                <StarRating
                  rating={item.state?.rating ?? null}
                  onChange={(rating) => rate.mutate(rating)}
                />
              </div>
              <div>
                <label htmlFor="status" className="label mb-1.5 block">
                  Status
                </label>
                <select
                  id="status"
                  value={item.state?.status ?? ''}
                  onChange={(event) =>
                    setStatus.mutate((event.target.value || null) as WatchStatus | null)
                  }
                  className="input h-9 w-auto py-0 text-sm"
                >
                  <option value="">Not set</option>
                  {STATUS_OPTIONS.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABELS[status]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {(progressPercent != null || episodeProgress != null) && (
              <div className="mt-5 max-w-md">
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>
                    {episodeProgress != null
                      ? `${item.watched_episodes} of ${item.total_episodes} episodes`
                      : `${progressPercent}% watched`}
                  </span>
                  <span>{relativeTime(item.state?.last_watched_at)}</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-700 ease-spring"
                    style={{ width: `${episodeProgress ?? progressPercent ?? 0}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Overview + facts */}
        <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_18rem]">
          <div className="space-y-8">
            {item.overview && (
              <section>
                <h2 className="text-lg font-semibold tracking-tight text-ink">Overview</h2>
                <p className="mt-2 max-w-prose text-balance leading-relaxed text-subtle">
                  {item.overview}
                </p>
              </section>
            )}

            {item.media_type === 'show' && (
              <section>
                <h2 className="text-lg font-semibold tracking-tight text-ink">Seasons</h2>
                {seasons.isLoading ? (
                  <div className="mt-3 space-y-2">
                    {Array.from({ length: 3 }, (_, index) => (
                      <div key={index} className="skeleton h-14 rounded-xl" />
                    ))}
                  </div>
                ) : (seasons.data?.length ?? 0) === 0 ? (
                  <p className="mt-2 text-sm text-muted">
                    No seasons imported yet. Run a library scan from Settings.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {seasons.data?.map((season) => {
                      const number = season.season_number ?? 0
                      const isOpen = openSeason === number
                      const done =
                        season.watched_episodes != null &&
                        season.total_episodes != null &&
                        season.total_episodes > 0 &&
                        season.watched_episodes >= season.total_episodes
                      return (
                        <li key={`${season.id}-${number}`} className="card overflow-hidden">
                          <div className="flex items-center gap-3 p-3">
                            <button
                              type="button"
                              onClick={() => setOpenSeason(isOpen ? null : number)}
                              className="flex min-w-0 flex-1 items-center gap-3 text-left"
                              aria-expanded={isOpen}
                            >
                              <span
                                className={cn(
                                  'grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-semibold',
                                  done ? 'bg-good/15 text-good' : 'bg-raised text-subtle',
                                )}
                              >
                                {done ? <CheckIcon /> : number}
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-medium text-ink">
                                  {number === 0 ? 'Specials' : `Season ${number}`}
                                </span>
                                {season.total_episodes != null && (
                                  <span className="text-xs text-muted">
                                    {season.watched_episodes ?? 0} of {season.total_episodes} watched
                                  </span>
                                )}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => markSeason.mutate(number)}
                              disabled={markSeason.isPending}
                              className="btn-ghost h-8 px-2.5 text-xs"
                            >
                              Mark all watched
                            </button>
                          </div>

                          {isOpen && (
                            <div className="border-t border-line bg-raised/40">
                              {episodes.isLoading ? (
                                <p className="p-3 text-sm text-muted">Loading episodes…</p>
                              ) : (
                                <ul className="divide-y divide-line">
                                  {episodes.data?.map((episode) => (
                                    <EpisodeRow
                                      key={episode.id}
                                      episode={episode}
                                      onToggle={(target, isWatched) =>
                                        isWatched
                                          ? markUnwatched.mutate(target)
                                          : markWatched.mutate(target)
                                      }
                                      pending={
                                        (markWatched.isPending &&
                                          markWatched.variables === episode.id) ||
                                        (markUnwatched.isPending &&
                                          markUnwatched.variables === episode.id)
                                      }
                                    />
                                  ))}
                                </ul>
                              )}
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            )}
          </div>

          <aside className="space-y-6">
            {facts.length > 0 && (
              <div className="card p-4">
                <h3 className="label">Details</h3>
                <dl className="mt-3 space-y-2.5 text-sm">
                  {facts.map(([term, value]) => (
                    <div key={term} className="flex justify-between gap-4">
                      <dt className="text-muted">{term}</dt>
                      <dd className="truncate text-right capitalize text-ink">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            <ExternalLinks
              tmdbId={item.tmdb_id}
              tvdbId={item.tvdb_id}
              imdbId={item.imdb_id}
              malId={item.mal_id}
              isShow={item.media_type === 'show'}
            />
          </aside>
        </div>

        {(item.media_type === 'movie' || item.media_type === 'show') && (
          <Recommendations itemId={item.id} />
        )}
      </div>
    </div>
  )
}

/**
 * Unwatched titles that share the most genres with this one.
 *
 * Its own component so the shelf owns its request, and so the three states a
 * request has — loading, failed, genuinely nothing — stay visible next to each
 * other. An empty strip under a heading reads as broken; a failed request that
 * falls through to the empty branch reads as "you have watched everything".
 */
function Recommendations({ itemId }: { itemId: number }) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['recommendations', itemId],
    queryFn: () => api.media.recommendations(itemId),
  })

  if (isError) {
    return (
      <section className="mt-12">
        <h2 className="mb-3 text-lg font-semibold tracking-tight text-ink">More like this</h2>
        <ErrorState
          error={error}
          onRetry={() => refetch()}
          title="Could not load recommendations"
        />
      </section>
    )
  }

  if (!isLoading && (data?.length ?? 0) === 0) {
    return (
      <section className="mt-12">
        <h2 className="text-lg font-semibold tracking-tight text-ink">More like this</h2>
        <p className="mt-2 text-sm text-muted">
          Nothing unwatched shares enough genres with this one yet.
        </p>
      </section>
    )
  }

  return (
    <div className="mt-12">
      <PosterRail title="More like this" cards={data ?? []} loading={isLoading} />
    </div>
  )
}

function EpisodeRow({
  episode,
  onToggle,
  pending = false,
}: {
  episode: MediaCard
  onToggle: (id: number, watched: boolean) => void
  /** True while this row's own request is in flight. */
  pending?: boolean
}) {
  const watched = episode.status === 'completed'
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <button
        type="button"
        onClick={() => onToggle(episode.id, watched)}
        // The tick is derived from `episode.status`, which only changes after
        // the write *and* a refetch. With no pending state the box sat
        // unchanged for a second, so people clicked again — logging a
        // duplicate play. Every other write on this page already showed one.
        disabled={pending}
        className={cn(
          'grid h-6 w-6 shrink-0 place-items-center rounded-md border transition-colors',
          watched
            ? 'border-good bg-good text-white'
            : 'border-line text-transparent hover:border-accent',
          pending && 'opacity-60',
        )}
        aria-label={watched ? `Mark ${episode.title} unwatched` : `Mark ${episode.title} watched`}
        aria-pressed={watched}
        aria-busy={pending}
      >
        {pending ? (
          <Spinner className="text-[10px] text-muted" />
        ) : (
          <CheckIcon className="text-xs" />
        )}
      </button>
      <span className="w-10 shrink-0 text-xs tabular-nums text-muted">
        E{String(episode.episode_number ?? 0).padStart(2, '0')}
      </span>
      <Link
        to={`/item/${episode.id}`}
        className={cn(
          'min-w-0 flex-1 truncate text-sm hover:text-accent',
          watched ? 'text-muted' : 'text-ink',
        )}
      >
        {episode.title}
      </Link>
      {episode.progress_percent != null &&
        episode.progress_percent > 0 &&
        episode.progress_percent < 100 && (
          <span className="shrink-0 text-[11px] text-accent">
            {Math.round(episode.progress_percent)}%
          </span>
        )}
    </li>
  )
}

function ExternalLinks({
  tmdbId,
  tvdbId,
  imdbId,
  malId,
  isShow,
}: {
  tmdbId: number | null
  tvdbId: number | null
  imdbId: string | null
  malId: number | null
  isShow: boolean
}) {
  const links = [
    tmdbId && {
      label: 'TMDB',
      href: `https://www.themoviedb.org/${isShow ? 'tv' : 'movie'}/${tmdbId}`,
    },
    imdbId && { label: 'IMDb', href: `https://www.imdb.com/title/${imdbId}/` },
    tvdbId && { label: 'TheTVDB', href: `https://thetvdb.com/dereferrer/series/${tvdbId}` },
    malId && { label: 'MyAnimeList', href: `https://myanimelist.net/anime/${malId}` },
  ].filter(Boolean) as Array<{ label: string; href: string }>

  if (links.length === 0) return null

  return (
    <div className="card p-4">
      <h3 className="label">Elsewhere</h3>
      <ul className="mt-3 space-y-1.5">
        {links.map((link) => (
          <li key={link.label}>
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sm text-subtle underline-offset-2 hover:text-accent hover:underline"
            >
              {link.label} ↗
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
