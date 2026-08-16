import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type MediaQuery } from '@/lib/api'
import { useToast } from '@/lib/app-context'
import type { AnimeFilter, MediaCard } from '@/lib/types'
import { compactNumber } from '@/lib/utils'
import {
  BrowseFilters,
  Pagination,
  SORTS,
  useBrowseFilters,
} from '@/components/BrowseFilters'
import { PosterGrid } from '@/components/Poster'
import { EmptyState, ErrorState, PageHeader, Segmented } from '@/components/ui'
import { FilmIcon, SearchIcon } from '@/components/Icons'

/**
 * `browse` is everything at once — no media type, anime included. It exists for
 * arriving from somewhere with a filter already applied, which is what clicking
 * a bar on the stats page does: "titles rated 7" is not a Movies question or a
 * Shows question.
 */
export type BrowseMode = 'movies' | 'shows' | 'anime' | 'search' | 'browse'

const PAGE_SIZE = 60

interface BrowseProps {
  mode: BrowseMode
}

export function Browse({ mode }: BrowseProps) {
  const [params] = useSearchParams()
  const queryClient = useQueryClient()
  const { notify } = useToast()

  const filters = useBrowseFilters(
    SORTS,
    mode === 'search' || mode === 'browse' ? 'title' : 'added',
  )
  // Checked, not cast: `?kind=` reaches the API as `media_type`, which is a
  // literal there, so a mistyped one would answer 422 rather than "all".
  const requestedKind = params.get('kind')
  const animeKind =
    requestedKind === 'movie' || requestedKind === 'show' ? requestedKind : 'all'

  // The offset lives in the URL with the filters, so a filter change and the
  // reset to page one are one navigation rather than a render that fires a
  // query at the stale offset first. `update()` drops `page` for us.
  const page = filters.page

  const animeFilter: AnimeFilter = useMemo(() => {
    if (mode === 'anime') return 'only'
    if (mode === 'search' || mode === 'browse') return 'all'
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
    ...filters.query,
    media_type: mediaType,
    anime: animeFilter,
    offset: page * PAGE_SIZE,
    limit: PAGE_SIZE,
  }

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['media', query],
    queryFn: () => api.media.list(query),
    placeholderData: keepPreviousData,
  })

  const genres = useQuery({
    queryKey: ['genres', animeFilter],
    queryFn: () => api.media.genres(animeFilter),
  })

  const markWatched = useMutation({
    mutationFn: (card: MediaCard) => api.history.markWatched(card.id),
    onSuccess: (_result, card) => {
      notify(`Logged “${card.title}” as watched`, 'success')
      queryClient.invalidateQueries({ queryKey: ['media'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const search = filters.search

  const rated =
    filters.minRating != null && filters.minRating === filters.maxRating
      ? `Rated ${filters.minRating}/10`
      : null

  const titles: Record<BrowseMode, string> = {
    movies: 'Movies',
    shows: 'TV shows',
    anime: 'Anime',
    search: search ? `Results for “${search}”` : 'Search',
    // Name what was clicked, so arriving here from the stats page explains
    // itself rather than showing an unexplained subset of the library.
    browse: rated ?? (filters.genre ? filters.genre : 'All titles'),
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
                filters.genre ? ` in ${filters.genre}` : ''
              }`
        }
        actions={
          mode === 'anime' && (
            <Segmented
              label="Anime type"
              value={animeKind}
              onChange={(value) => filters.update('kind', value === 'all' ? null : value)}
              options={[
                { value: 'all', label: 'All' },
                { value: 'show', label: 'Series' },
                { value: 'movie', label: 'Films' },
              ]}
            />
          )
        }
      />

      <BrowseFilters
        state={filters}
        genres={genres.data ?? []}
        busy={isFetching && !isLoading}
      />

      {isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !isLoading && total === 0 ? (
        <EmptyState
          icon={mode === 'search' ? <SearchIcon /> : <FilmIcon />}
          title={
            search
              ? 'Nothing matched that search'
              : filters.active
                ? 'Nothing matched those filters'
                : 'Nothing here yet'
          }
          description={
            search
              ? 'Try a shorter search, or check the spelling.'
              : filters.active
                ? 'Try widening them, or clear them to see everything.'
                : 'Run a Plex sync from Settings to import your library.'
          }
          action={
            !search && filters.active ? (
              <button type="button" onClick={filters.clear} className="btn-outline mt-2">
                Clear filters
              </button>
            ) : undefined
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

      <Pagination
        page={page}
        pageCount={pageCount}
        onPage={filters.setPage}
        ready={!isLoading}
      />
    </div>
  )
}
