import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type MediaQuery } from '@/lib/api'
import { useToast } from '@/lib/app-context'
import type { AnimeFilter, MediaCard } from '@/lib/types'
import { compactNumber } from '@/lib/utils'
import { BrowseFilters, useBrowseFilters } from '@/components/BrowseFilters'
import { PosterGrid } from '@/components/Poster'
import { EmptyState, PageHeader, Segmented } from '@/components/ui'
import { FilmIcon, SearchIcon } from '@/components/Icons'

export type BrowseMode = 'movies' | 'shows' | 'anime' | 'search'

const PAGE_SIZE = 60

interface BrowseProps {
  mode: BrowseMode
}

export function Browse({ mode }: BrowseProps) {
  const [params] = useSearchParams()
  const queryClient = useQueryClient()
  const { notify } = useToast()

  const filters = useBrowseFilters(mode === 'search' ? 'title' : 'added')
  const animeKind = (params.get('kind') ?? 'all') as 'all' | 'movie' | 'show'

  const [page, setPage] = useState(0)

  // Any filter change invalidates the current offset.
  useEffect(() => {
    setPage(0)
  }, [JSON.stringify(filters.query), animeKind, mode])

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
    ...filters.query,
    media_type: mediaType,
    anime: animeFilter,
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
