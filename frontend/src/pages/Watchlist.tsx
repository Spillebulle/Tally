import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useToast } from '@/lib/app-context'
import type { MediaCard, WatchlistEntry } from '@/lib/types'
import { Poster, PosterSkeleton } from '@/components/Poster'
import { EmptyState, PageHeader, Segmented, Spinner } from '@/components/ui'
import { BookmarkIcon, PlusIcon, SearchIcon } from '@/components/Icons'

export function Watchlist() {
  const [filter, setFilter] = useState<'all' | 'anime'>('all')
  const [searchOpen, setSearchOpen] = useState(false)
  const queryClient = useQueryClient()
  const { notify } = useToast()

  const { data, isLoading } = useQuery({
    queryKey: ['watchlist', filter],
    queryFn: () => api.watchlist.list(filter === 'anime'),
  })

  const remove = useMutation({
    mutationFn: (mediaItemId: number) => api.watchlist.remove(mediaItemId),
    // Removal also has to reach Plex, so the round trip is long enough to feel
    // broken. Drop the row straight away and put it back if the write fails.
    onMutate: async (mediaItemId: number) => {
      await queryClient.cancelQueries({ queryKey: ['watchlist', filter] })
      const previous = queryClient.getQueryData<WatchlistEntry[]>(['watchlist', filter])
      queryClient.setQueryData<WatchlistEntry[]>(['watchlist', filter], (old) =>
        old?.filter((entry) => entry.media_item_id !== mediaItemId),
      )
      return { previous }
    },
    onSuccess: () => notify('Removed from watchlist — also removed on Plex', 'info'),
    onError: (error: Error, _mediaItemId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['watchlist', filter], context.previous)
      }
      notify(error.message, 'error')
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['watchlist'] }),
  })

  const entries = data ?? []
  const syncedCount = entries.filter((entry) => entry.synced_with_plex).length

  return (
    <div>
      <PageHeader
        title="Watchlist"
        subtitle={
          isLoading
            ? 'Loading…'
            : `${entries.length} ${entries.length === 1 ? 'title' : 'titles'} · ${syncedCount} in sync with Plex`
        }
        actions={
          <>
            <Segmented
              label="Filter watchlist"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'anime', label: 'Anime' },
              ]}
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

      {isLoading ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }, (_, index) => (
            <PosterSkeleton key={index} />
          ))}
        </div>
      ) : entries.length === 0 ? (
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
                             bg-black/70 text-white opacity-0 backdrop-blur-sm transition-opacity
                             hover:bg-danger group-hover/entry:opacity-100
                             focus-visible:opacity-100"
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
    </div>
  )
}

/** Searches Plex Discover, so users can watchlist titles they don't own. */
function DiscoverSearch({ onClose }: { onClose: () => void }) {
  const [term, setTerm] = useState('')
  const [submitted, setSubmitted] = useState('')
  const queryClient = useQueryClient()
  const { notify } = useToast()

  const { data, isFetching } = useQuery({
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
              <div className="h-16 w-11 shrink-0 overflow-hidden rounded-md bg-raised">
                {card.poster_url && (
                  <img src={card.poster_url} alt="" className="h-full w-full object-cover" />
                )}
              </div>
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

      {data && data.length === 0 && submitted && !isFetching && (
        <p className="mt-4 text-sm text-muted">
          Nothing found for “{submitted}”. Plex Discover search needs a linked Plex account.
        </p>
      )}
    </div>
  )
}
