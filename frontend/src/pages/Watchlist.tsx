import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type MediaQuery } from '@/lib/api'
import { useToast } from '@/lib/app-context'
import type { MediaCard, PaginatedWatchlist } from '@/lib/types'
import { namesOf, useBrowseFilters, WATCHLIST_SORTS } from '@/lib/browse-filters'
import { BrowseFilters } from '@/components/BrowseFilters'
import { Pagination, usePageParam } from '@/components/Pagination'
import { Artwork, Poster, PosterSkeleton } from '@/components/Poster'
import { EmptyState, ErrorState, PageHeader, Segmented, Spinner } from '@/components/ui'
import { BookmarkIcon, PlusIcon, SearchIcon } from '@/components/Icons'

const PAGE_SIZE = 60

/** The type split, as one control. "Anime" is a flag, the others are a type. */
const KINDS = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Films' },
  { value: 'show', label: 'Series' },
  { value: 'anime', label: 'Anime' },
] as const

type Kind = (typeof KINDS)[number]['value']

export function Watchlist() {
  const [params] = useSearchParams()
  const [searchOpen, setSearchOpen] = useState(false)
  const queryClient = useQueryClient()
  const { notify } = useToast()

  // "Recently watchlisted" is the one people mean on this page, so it leads.
  // Oldest first: a watchlist is a queue, and the thing you added first is the
  // one you have been meaning to watch longest.
  const filters = useBrowseFilters({
    // Its own shelf of saved views: `watchlist_added` is a sort no other page
    // offers, so its views would be stale everywhere else.
    id: 'watchlist',
    sorts: WATCHLIST_SORTS,
    defaultSort: 'watchlist_added',
    defaultOrder: 'asc',
    // See Browse: `since`/`until` are History's, and mean nothing here.
    omit: ['window'],
  })
  // Checked, not cast — an unknown kind would reach the API as a `media_type`
  // it does not accept, and answer 422 instead of showing the watchlist.
  const requestedKind = params.get('kind')
  const kind: Kind = KINDS.some((option) => option.value === requestedKind)
    ? (requestedKind as Kind)
    : 'all'
  // In the URL beside the filters — see the note in BrowseFilters. Changing a
  // filter drops it, so nothing has to reset the offset here.
  const { page, setPage } = usePageParam()

  const query: MediaQuery = {
    ...filters.query,
    media_type: kind === 'movie' || kind === 'show' ? kind : undefined,
    anime: kind === 'anime' ? 'only' : undefined,
    offset: page * PAGE_SIZE,
    limit: PAGE_SIZE,
  }

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['watchlist', query],
    queryFn: () => api.watchlist.list(query),
    placeholderData: keepPreviousData,
  })

  const genres = useQuery({
    queryKey: ['genres', 'all'],
    queryFn: () => api.media.genres('all'),
  })

  const contentRatings = useQuery({
    queryKey: ['content-ratings', 'all'],
    queryFn: () => api.media.contentRatings('all'),
  })

  const places = useQuery({ queryKey: ['places'], queryFn: () => api.media.places() })

  const remove = useMutation({
    mutationFn: (mediaItemId: number) => api.watchlist.remove(mediaItemId),
    // Removal also has to reach Plex, so the round trip is long enough to feel
    // broken. Drop the row straight away and put it back if the write fails.
    onMutate: async (mediaItemId: number) => {
      await queryClient.cancelQueries({ queryKey: ['watchlist', query] })
      const previous = queryClient.getQueryData<PaginatedWatchlist>(['watchlist', query])
      queryClient.setQueryData<PaginatedWatchlist>(['watchlist', query], (old) =>
        old
          ? {
              ...old,
              entries: old.entries.filter(
                (entry) => entry.media_item_id !== mediaItemId,
              ),
              total: Math.max(0, old.total - 1),
            }
          : old,
      )
      return { previous }
    },
    onSuccess: () => notify('Removed from watchlist — also removed on Plex', 'info'),
    onError: (error: Error, _mediaItemId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['watchlist', query], context.previous)
      }
      notify(error.message, 'error')
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['watchlist'] }),
  })

  const entries = data?.entries ?? []
  // Several genres read as "in Crime, Drama" — the same phrasing one does.
  const genre = namesOf(filters.values.genre)
  const total = data?.total ?? 0
  const pageCount = Math.ceil(total / PAGE_SIZE)
  const syncedCount = entries.filter((entry) => entry.synced_with_plex).length
  // `kind` is this page's own parameter rather than one of the shared filters,
  // so it is the one thing `filters.active` cannot know about.
  const narrowed = filters.active || kind !== 'all' || Boolean(filters.values.q)

  return (
    <div>
      <PageHeader
        title="Watchlist"
        subtitle={
          isLoading
            ? 'Loading…'
            : `${total} ${total === 1 ? 'title' : 'titles'}${
                genre ? ` in ${genre}` : ''
              } · ${syncedCount} of ${entries.length} shown in sync with Plex`
        }
        actions={
          <>
            <Segmented
              label="Filter watchlist"
              value={kind}
              onChange={(value) =>
                filters.update('kind', value === 'all' ? null : value)
              }
              options={KINDS.map((option) => ({ ...option }))}
            />
            <button
              type="button"
              onClick={() => setSearchOpen((value) => !value)}
              className="btn-primary"
            >
              <PlusIcon /> Add a title
            </button>
          </>
        }
      />

      {searchOpen && <DiscoverSearch onClose={() => setSearchOpen(false)} />}

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

      {isLoading ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }, (_, index) => (
            <PosterSkeleton key={index} />
          ))}
        </div>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : entries.length === 0 ? (
        // An empty page means two different things now: nothing watchlisted at
        // all, or nothing matching the filters. Telling the user to go add
        // something when they have 200 titles and a narrow filter would be daft.
        narrowed ? (
          <EmptyState
            icon={<BookmarkIcon />}
            title="Nothing on your watchlist matches"
            description="Try widening the filters, or clear them to see everything you have saved."
            action={
              <button type="button" onClick={filters.clear} className="btn-outline mt-2">
                Clear filters
              </button>
            }
          />
        ) : (
          <EmptyState
            icon={<BookmarkIcon />}
            title="Your watchlist is empty"
            description="Anything you add here shows up on your Plex watchlist too — and anything you add in Plex appears here after the next sync."
            action={
              <button type="button" onClick={() => setSearchOpen(true)} className="btn-primary mt-2">
                <PlusIcon /> Find something to watch
              </button>
            }
          />
        )
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
          {entries.map((entry) =>
            entry.item ? (
              <div key={entry.id} className="group/entry relative">
                <Poster card={entry.item} showProgress={false} />
                <button
                  type="button"
                  onClick={() => remove.mutate(entry.media_item_id)}
                  className="absolute right-2 top-2 z-10 grid h-7 w-7 place-items-center rounded-full
                             bg-black/70 text-white backdrop-blur-sm transition-opacity
                             hover:bg-danger
                             lg:pointer-events-none lg:opacity-0
                             lg:group-hover/entry:pointer-events-auto
                             lg:group-hover/entry:opacity-100
                             lg:focus-visible:pointer-events-auto
                             lg:focus-visible:opacity-100"
                  title="Remove from watchlist"
                  aria-label={`Remove ${entry.item.title} from watchlist`}
                >
                  ×
                </button>
                {!entry.synced_with_plex && (
                  <p className="mt-1 text-[10px] text-muted" title="Not yet mirrored to Plex">
                    Pending Plex sync
                  </p>
                )}
              </div>
            ) : null,
          )}
        </div>
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

/** Searches Plex Discover, so users can watchlist titles they don't own. */
function DiscoverSearch({ onClose }: { onClose: () => void }) {
  const [term, setTerm] = useState('')
  const [submitted, setSubmitted] = useState('')
  const queryClient = useQueryClient()
  const { notify } = useToast()

  const {
    data,
    isFetching,
    isError: searchFailed,
    error: searchError,
  } = useQuery({
    queryKey: ['discover', submitted],
    queryFn: () => api.watchlist.searchDiscover(submitted),
    enabled: submitted.length > 1,
  })

  const add = useMutation({
    mutationFn: (card: MediaCard) => api.watchlist.add(card.id),
    onSuccess: (_result, card) => {
      notify(`“${card.title}” added to your Plex watchlist`, 'success')
      queryClient.invalidateQueries({ queryKey: ['watchlist'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  return (
    <div className="card mb-6 animate-fade-up p-4">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setSubmitted(term.trim())
        }}
        className="flex gap-2"
      >
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-muted" />
          <input
            autoFocus
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search Plex for a film or series…"
            aria-label="Search Plex Discover"
            className="input pl-9"
          />
        </div>
        <button type="submit" className="btn-primary" disabled={term.trim().length < 2}>
          Search
        </button>
        <button type="button" onClick={onClose} className="btn-ghost">
          Close
        </button>
      </form>

      {isFetching && (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted">
          <Spinner /> Searching Plex…
        </p>
      )}

      {data && data.length > 0 && (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {data.map((card) => (
            <li
              key={card.id}
              className="flex items-center gap-3 rounded-xl border border-line p-2"
            >
              <Artwork
                src={card.poster_url}
                title={card.title}
                showTitle={false}
                className="h-16 w-11 shrink-0 rounded-md bg-raised"
              />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 text-sm font-medium text-ink">{card.title}</p>
                <p className="text-xs text-muted">
                  {card.year ?? '—'} · {card.media_type === 'show' ? 'Series' : 'Film'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => add.mutate(card)}
                disabled={add.isPending || card.on_watchlist}
                className="btn-outline h-8 shrink-0 gap-1.5 px-2.5 text-xs"
              >
                {/* Adding pushes to Plex's watchlist, so show the wait. */}
                {add.isPending && add.variables.id === card.id ? <Spinner /> : null}
                {card.on_watchlist ? 'Added' : 'Add'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The error was never read, and "nothing found" required `data` to be
          truthy — so a 401 "Link a Plex account first" cleared the spinner and
          left the panel completely blank, which reads as broken rather than as
          unauthorised. */}
      {searchFailed && !isFetching && (
        <p className="mt-4 text-sm text-danger">
          {searchError instanceof Error
            ? searchError.message
            : 'Discover search failed.'}
        </p>
      )}

      {data && data.length === 0 && submitted && !isFetching && (
        <p className="mt-4 text-sm text-muted">
          Nothing found for “{submitted}”. Plex Discover search needs a linked Plex account.
        </p>
      )}
    </div>
  )
}
