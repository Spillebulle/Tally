import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type MediaQuery } from '@/lib/api'
import { useToast } from '@/lib/app-context'
import type { AnimeFilter, MediaCard, WatchStatus } from '@/lib/types'
import { cn, compactNumber, STATUS_LABELS } from '@/lib/utils'
import { PosterGrid } from '@/components/Poster'
import { EmptyState, PageHeader, Segmented } from '@/components/ui'
import { FilmIcon, SearchIcon } from '@/components/Icons'

export type BrowseMode = 'movies' | 'shows' | 'anime' | 'search'

const SORTS = [
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'added', label: 'Recently added' },
  { value: 'watched', label: 'Recently watched' },
  { value: 'rating', label: 'Your rating' },
] as const

const STATUS_FILTERS: Array<{ value: WatchStatus | 'all' | 'unwatched'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'watching', label: STATUS_LABELS.watching },
  { value: 'completed', label: STATUS_LABELS.completed },
  { value: 'unwatched', label: 'Unwatched' },
  { value: 'plan_to_watch', label: STATUS_LABELS.plan_to_watch },
  { value: 'on_hold', label: STATUS_LABELS.on_hold },
  { value: 'dropped', label: STATUS_LABELS.dropped },
]

const PAGE_SIZE = 60

/**
 * Rating shortcuts, on Plex's 0–10 scale.
 *
 * `min` alone is "this and above"; `min === max` pins an exact score, which is
 * what clicking a bar on the stats page sends.
 */
const RATING_FILTERS: Array<{ label: string; min?: number; max?: number }> = [
  { label: 'Any' },
  { label: '10 only', min: 10, max: 10 },
  { label: '9+', min: 9 },
  { label: '8+', min: 8 },
  { label: '7+', min: 7 },
  { label: '5+', min: 5 },
]

/**
 * The shortcut list, plus an entry describing the active filter when it is not
 * one of them.
 *
 * Clicking a bar on the stats page can pin any exact score, and a select that
 * showed "Any rating" while the grid was filtered to 7s would be lying about
 * the state of the page.
 */
function ratingOptions(min?: number, max?: number) {
  const known = RATING_FILTERS.some(
    (option) => option.min === min && option.max === max,
  )
  if (known || (min == null && max == null)) return RATING_FILTERS

  const label =
    min != null && min === max
      ? `${min} only`
      : min != null && max != null
        ? `${min}–${max}`
        : min != null
          ? `${min}+`
          : `up to ${max}`
  return [...RATING_FILTERS, { label, min, max }]
}

const numberParam = (raw: string | null): number | undefined => {
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

interface BrowseProps {
  mode: BrowseMode
}

export function Browse({ mode }: BrowseProps) {
  const [params, setParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { notify } = useToast()

  const search = params.get('q') ?? ''
  const genre = params.get('genre') ?? ''
  const sort = params.get('sort') ?? (mode === 'search' ? 'title' : 'added')
  const order = params.get('order') ?? (sort === 'title' ? 'asc' : 'desc')
  const statusFilter = (params.get('status') ?? 'all') as WatchStatus | 'all' | 'unwatched'
  const animeKind = (params.get('kind') ?? 'all') as 'all' | 'movie' | 'show'
  const minRating = numberParam(params.get('min_rating'))
  const maxRating = numberParam(params.get('max_rating'))

  const [page, setPage] = useState(0)

  // Any filter change invalidates the current offset.
  useEffect(() => {
    setPage(0)
  }, [search, genre, sort, order, statusFilter, animeKind, minRating, maxRating, mode])

  const animeFilter: AnimeFilter = useMemo(() => {
    if (mode === 'anime') return 'only'
    if (mode === 'search') return 'all'
    // Anime lives in its own section, so the plain Movies/Shows grids exclude
    // it rather than showing everything twice.
    return 'exclude'
  }, [mode])

  const mediaType = useMemo(() => {
    if (mode === 'movies') return 'movie'
    if (mode === 'shows') return 'show'
    if (mode === 'anime' && animeKind !== 'all') return animeKind
    return undefined
  }, [mode, animeKind])

  const query: MediaQuery = {
    q: search || undefined,
    media_type: mediaType,
    anime: animeFilter,
    genre: genre || undefined,
    watch_status:
      statusFilter !== 'all' && statusFilter !== 'unwatched' ? statusFilter : undefined,
    unwatched: statusFilter === 'unwatched' || undefined,
    min_rating: minRating,
    max_rating: maxRating,
    sort,
    order,
    offset: page * PAGE_SIZE,
    limit: PAGE_SIZE,
  }

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['media', query],
    queryFn: () => api.media.list(query),
    placeholderData: keepPreviousData,
  })

  const genres = useQuery({
    queryKey: ['genres', animeFilter],
    queryFn: () => api.media.genres(animeFilter),
  })

  const ratingChoices = ratingOptions(minRating, maxRating)

  const markWatched = useMutation({
    mutationFn: (card: MediaCard) => api.history.markWatched(card.id),
    onSuccess: (_result, card) => {
      notify(`Logged “${card.title}” as watched`, 'success')
      queryClient.invalidateQueries({ queryKey: ['media'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const update = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const titles: Record<BrowseMode, string> = {
    movies: 'Movies',
    shows: 'TV shows',
    anime: 'Anime',
    search: search ? `Results for “${search}”` : 'Search',
  }

  const total = data?.total ?? 0
  const pageCount = Math.ceil(total / PAGE_SIZE)

  return (
    <div>
      <PageHeader
        title={titles[mode]}
        subtitle={
          isLoading
            ? 'Loading…'
            : `${compactNumber(total)} ${total === 1 ? 'title' : 'titles'}${
                genre ? ` in ${genre}` : ''
              }`
        }
        actions={
          mode === 'anime' && (
            <Segmented
              label="Anime type"
              value={animeKind}
              onChange={(value) => update('kind', value === 'all' ? null : value)}
              options={[
                { value: 'all', label: 'All' },
                { value: 'show', label: 'Series' },
                { value: 'movie', label: 'Films' },
              ]}
            />
          )
        }
      />

      {/* Filters live in one row above the grid. */}
      <div className="mb-6 space-y-3">
        <div className="scroll-x scrollbar-none flex gap-2 pb-1">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => update('status', filter.value === 'all' ? null : filter.value)}
              className={cn('chip shrink-0', statusFilter === filter.value && 'chip-active')}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filter by genre"
            value={genre}
            onChange={(event) => update('genre', event.target.value || null)}
            className="input h-9 w-auto min-w-[9rem] py-0 text-sm"
          >
            <option value="">All genres</option>
            {genres.data?.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by your rating"
            value={ratingChoices.findIndex(
              (option) => option.min === minRating && option.max === maxRating,
            )}
            onChange={(event) => {
              const choice = ratingChoices[Number(event.target.value)]
              const next = new URLSearchParams(params)
              if (choice?.min == null) next.delete('min_rating')
              else next.set('min_rating', String(choice.min))
              if (choice?.max == null) next.delete('max_rating')
              else next.set('max_rating', String(choice.max))
              setParams(next, { replace: true })
            }}
            className="input h-9 w-auto py-0 text-sm"
          >
            {ratingChoices.map((option, index) => (
              <option key={option.label} value={index}>
                {option.label === 'Any' ? 'Any rating' : `Rated ${option.label}`}
              </option>
            ))}
          </select>

          <select
            aria-label="Sort by"
            value={sort}
            onChange={(event) => update('sort', event.target.value)}
            className="input h-9 w-auto py-0 text-sm"
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => update('order', order === 'asc' ? 'desc' : 'asc')}
            className="btn-outline h-9 px-3 text-sm"
            title={order === 'asc' ? 'Ascending' : 'Descending'}
          >
            {order === 'asc' ? '↑' : '↓'}
          </button>

          {(genre || statusFilter !== 'all' || minRating != null || maxRating != null) && (
            <button
              type="button"
              onClick={() => setParams(search ? { q: search } : {}, { replace: true })}
              className="text-sm text-muted hover:text-danger"
            >
              Clear filters
            </button>
          )}

          {isFetching && !isLoading && (
            <span className="ml-auto text-xs text-muted">Updating…</span>
          )}
        </div>
      </div>

      {!isLoading && total === 0 ? (
        <EmptyState
          icon={mode === 'search' ? <SearchIcon /> : <FilmIcon />}
          title={search ? 'Nothing matched that search' : 'Nothing here yet'}
          description={
            search
              ? 'Try a shorter search, or check the spelling.'
              : 'Run a Plex sync from Settings to import your library.'
          }
        />
      ) : (
        <PosterGrid
          cards={data?.items ?? []}
          loading={isLoading}
          skeletonCount={PAGE_SIZE / 3}
          onQuickWatch={(card) => markWatched.mutate(card)}
          quickWatchPendingId={markWatched.isPending ? markWatched.variables.id : null}
        />
      )}

      {pageCount > 1 && (
        <nav
          className="mt-10 flex items-center justify-center gap-2"
          aria-label="Pagination"
        >
          <button
            type="button"
            onClick={() => setPage((value) => Math.max(0, value - 1))}
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
            onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
            disabled={page >= pageCount - 1}
            className="btn-outline h-9 px-3 text-sm"
          >
            Next
          </button>
        </nav>
      )}
    </div>
  )
}
