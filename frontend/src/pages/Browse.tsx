import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type MediaQuery } from '@/lib/api'
import { useToast } from '@/lib/app-context'
import type { AnimeFilter, MediaCard, PersonalFilter } from '@/lib/types'
import { compactNumber } from '@/lib/utils'
import { certificateLabel } from '@/lib/certificates'
import { namesOf, SORTS, useBrowseFilters } from '@/lib/browse-filters'
import { BrowseFilters } from '@/components/BrowseFilters'
import { Pagination, usePageParam } from '@/components/Pagination'
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

  /**
   * A home video is not a film, a show or an anime, so the three grids that
   * name a category leave it out — the same call the backend makes about
   * seasons and episodes. Search and the all-titles grid promise everything and
   * have to keep the promise: it is where a misread one is found, and the only
   * thing stopping a wrong guess from hiding a film for good.
   *
   * A page *default*, not a fixed clause: the filter bar can still override it,
   * and like every other default it never reaches the URL until it is changed.
   */
  const personalDefault: PersonalFilter =
    mode === 'search' || mode === 'browse' ? 'all' : 'exclude'

  const filters = useBrowseFilters({
    // One shelf of saved views across all five modes: they share every filter
    // and every sort, so a view saved on Movies is a view that means something
    // on Search too. It sets the filters on whichever grid you are on.
    id: 'media',
    sorts: SORTS,
    defaultSort: mode === 'search' || mode === 'browse' ? 'title' : 'added',
    defaults: { personal: personalDefault },
    // `since`/`until` filter watch *events*, which /api/media knows nothing
    // about. Omitted rather than ignored, so a stray one from a History link
    // cannot sit in the URL looking like it does something.
    omit: ['window'],
  })
  // Checked, not cast: `?kind=` reaches the API as `media_type`, which is a
  // literal there, so a mistyped one would answer 422 rather than "all".
  const requestedKind = params.get('kind')
  const animeKind =
    requestedKind === 'movie' || requestedKind === 'show' ? requestedKind : 'all'

  // The offset lives in the URL beside the filters, so a filter change and the
  // reset to page one are one navigation rather than a render that fires a
  // query at the stale offset first — every filter write drops `page` for us.
  const { page, setPage } = usePageParam()

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

  const contentRatings = useQuery({
    queryKey: ['content-ratings', animeFilter],
    queryFn: () => api.media.contentRatings(animeFilter),
  })

  // Where the rows live. One request for the whole app — the answer does not
  // depend on which grid is asking — and the controls hide themselves when
  // there is only one server or one library to offer.
  const places = useQuery({ queryKey: ['places'], queryFn: () => api.media.places() })

  const markWatched = useMutation({
    mutationFn: (card: MediaCard) => api.history.markWatched(card.id),
    onSuccess: (_result, card) => {
      notify(`Logged “${card.title}” as watched`, 'success')
      queryClient.invalidateQueries({ queryKey: ['media'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const { q: search, rating, director, actor } = filters.values
  // The multi-value facets name the page by what they are narrowing to, which
  // is the values they include: "Crime, Drama" for two, nothing for none.
  const genre = namesOf(filters.values.genre)
  const studio = namesOf(filters.values.studio)
  // Written the way the board writes it — "Rated PG-13", not "Rated pg_13",
  // which is the agent's spelling of the same certificate.
  const contentRating = namesOf(filters.values.content_rating, certificateLabel)

  const rated =
    rating.min != null && rating.min === rating.max ? `Rated ${rating.min}/10` : null

  // A facet clicked on an item page is the reason this view exists, so it names
  // the page — the same courtesy the genre and rating arrivals already get.
  const facetTitle =
    (director && `Directed by ${director}`) ||
    (actor && `With ${actor}`) ||
    studio ||
    (contentRating && `Rated ${contentRating}`) ||
    null

  const titles: Record<BrowseMode, string> = {
    movies: 'Movies',
    shows: 'TV shows',
    anime: 'Anime',
    search: search ? `Results for “${search}”` : 'Search',
    // Name what was clicked, so arriving here from the stats page explains
    // itself rather than showing an unexplained subset of the library.
    browse: facetTitle ?? rated ?? (genre ? genre : 'All titles'),
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
        lists={{
          genres: genres.data ?? [],
          contentRatings: contentRatings.data ?? [],
          libraries: places.data?.libraries ?? [],
          servers: places.data?.servers ?? [],
        }}
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
        onPage={setPage}
        ready={!isLoading}
      />
    </div>
  )
}
