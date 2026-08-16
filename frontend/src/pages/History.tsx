import { Link, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type MediaQuery } from '@/lib/api'
import { useToast } from '@/lib/app-context'
import { HISTORY_SORTS, useBrowseFilters } from '@/lib/browse-filters'
import type { HistoryPage, WatchEvent } from '@/lib/types'
import { cn, compactNumber, displaySubtitle, formatDateTime } from '@/lib/utils'
import { BrowseFilters } from '@/components/BrowseFilters'
import { Pagination, usePageParam } from '@/components/Pagination'
import { Artwork } from '@/components/Poster'
import { EmptyState, ErrorState, PageHeader, Segmented } from '@/components/ui'
import { ClockIcon, XIcon } from '@/components/Icons'

const PAGE_SIZE = 50

const SOURCE_LABELS: Record<WatchEvent['source'], string> = {
  plex_history: 'Plex',
  plex_webhook: 'Plex (live)',
  plex_session: 'Plex session',
  manual: 'Logged here',
  import: 'Imported',
}

/**
 * The type split, as one control — and it keeps its own parameter name.
 *
 * The watchlist's equivalent is `?kind=`, whose values are `movie|show|anime`.
 * These are `movie|episode|anime`: a history row is a *play*, and you watch an
 * episode, not a series. One parameter name carrying two vocabularies is worse
 * than two names carrying one each — a shared `?kind=show` would arrive here
 * meaning nothing, and there would be no honest way to say so.
 *
 * It is also the name History has always written, so every bookmarked
 * `?filter=anime` keeps working rather than quietly widening to everything.
 */
const FILTERS = [
  { value: 'all', label: 'Everything' },
  { value: 'movie', label: 'Movies' },
  { value: 'episode', label: 'Episodes' },
  { value: 'anime', label: 'Anime' },
] as const

type Filter = (typeof FILTERS)[number]['value']

/** Group events by calendar day so the timeline reads as a diary. */
function groupByDay(events: WatchEvent[]): Array<[string, WatchEvent[]]> {
  const groups = new Map<string, WatchEvent[]>()
  for (const event of events) {
    const key = new Date(event.watched_at).toDateString()
    const bucket = groups.get(key)
    if (bucket) bucket.push(event)
    else groups.set(key, [event])
  }
  return [...groups.entries()]
}

function dayLabel(dateString: string): string {
  const date = new Date(dateString)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)

  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

export function History() {
  // In the URL, like every other browse surface. Kept in component state, the
  // filter and page were lost on reload and ignored by the back button, so a
  // link to "my anime history, page 3" could not exist. The page number is
  // read and written by the same helper the grids use, so `?page=` means one
  // thing across the app.
  const [params] = useSearchParams()
  const requestedFilter = params.get('filter')
  const filter: Filter = FILTERS.some((option) => option.value === requestedFilter)
    ? (requestedFilter as Filter)
    : 'all'
  const { page, setPage } = usePageParam()
  const queryClient = useQueryClient()
  const { notify } = useToast()

  const filters = useBrowseFilters({
    // Its own shelf of saved views: this page omits `status`, sorts on plays
    // rather than titles, and its `since`/`until` window belongs to nothing
    // else.
    id: 'history',
    sorts: HISTORY_SORTS,
    defaultSort: 'watched_at',
    /**
     * Home videos stay visible here. The grids hide them because a phone
     * recording is not a title in the sense those pages mean — but a play of
     * one is real history, and quietly dropping rows out of a diary is how a
     * user comes to believe Tally lost them. The shared default is `exclude`,
     * so this page has to say otherwise rather than inherit it.
     */
    defaults: { personal: 'all' },
    /**
     * `status` and `unwatched` mean nothing on a page where every row is a
     * play: "unwatched" returns nothing at all and a watch status returns
     * nearly everything. `watched` is the item-level "last watched between",
     * which would sit beside `window`'s "watched between" saying almost the
     * same thing about a different set of rows — the play window is the one
     * this page is about, so it is the one that stays.
     */
    omit: ['status', 'watched'],
  })

  const setFilter = (next: Filter) =>
    filters.update('filter', next === 'all' ? null : next)

  const query: MediaQuery = {
    ...filters.query,
    media_type: filter === 'movie' || filter === 'episode' ? filter : undefined,
    // `anime_only` rather than the shared `anime` tri-state: it is the
    // parameter this endpoint has always taken, and it is kept as an alias, so
    // it is the one spelling that is right both before and after the API grows
    // the full filter set.
    anime_only: filter === 'anime' || undefined,
    offset: page * PAGE_SIZE,
    limit: PAGE_SIZE,
  }

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['history', query],
    queryFn: () => api.history.list(query),
    placeholderData: keepPreviousData,
  })

  // The same two lists the grids offer, over everything: History shows films,
  // episodes and anime together, so narrowing either list to one of them would
  // hide genres the page can actually display.
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
    mutationFn: (eventId: number) => api.history.remove(eventId),
    // Take the row out immediately; waiting for the round trip made the button
    // look inert. Restored from the snapshot if the delete fails.
    onMutate: async (eventId: number) => {
      await queryClient.cancelQueries({ queryKey: ['history', query] })
      const previous = queryClient.getQueryData<HistoryPage>(['history', query])
      queryClient.setQueryData<HistoryPage>(['history', query], (old) =>
        old
          ? {
              ...old,
              events: old.events.filter((event) => event.id !== eventId),
              total: Math.max(0, old.total - 1),
            }
          : old,
      )
      return { previous }
    },
    onSuccess: () => notify('Removed from history', 'info'),
    onError: (error: Error, _eventId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['history', query], context.previous)
      }
      notify(error.message, 'error')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['history'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
      queryClient.invalidateQueries({ queryKey: ['media'] })
    },
  })

  const total = data?.total ?? 0
  const pageCount = Math.ceil(total / PAGE_SIZE)
  const events = data?.events ?? []
  // The day headings are only true while the list is in time order. Sorted by
  // title, consecutive rows come from unrelated dates, and grouping them would
  // print a heading per row and call each one a day's viewing.
  const byDay = filters.values.sort === 'watched_at'
  const grouped = byDay ? groupByDay(events) : []
  // `filter` is this page's own parameter rather than one of the shared ones,
  // so it is the one thing `filters.active` cannot know about.
  const narrowed = filters.active || filter !== 'all' || Boolean(filters.values.q)

  return (
    <div>
      <PageHeader
        title="History"
        subtitle={isLoading ? 'Loading…' : `${compactNumber(total)} plays recorded`}
        actions={
          <Segmented
            label="Filter history"
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((option) => ({ ...option }))}
          />
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

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="skeleton h-16 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : total === 0 ? (
        // An empty page means two different things: nothing watched at all, or
        // nothing matching the filters. Telling someone with 4,000 plays and a
        // narrow date window to go and run a sync would be daft.
        narrowed ? (
          <EmptyState
            icon={<ClockIcon />}
            title="No plays match those filters"
            description="Try widening them, or clear them to see everything you have watched."
            action={
              <button type="button" onClick={filters.clear} className="btn-outline mt-2">
                Clear filters
              </button>
            }
          />
        ) : (
          <EmptyState
            icon={<ClockIcon />}
            title="No watch history yet"
            description="Sync with Plex to import what you have already watched, or mark something watched from its page."
          />
        )
      ) : byDay ? (
        <div className="space-y-8">
          {grouped.map(([day, plays]) => (
            <section key={day}>
              <h2 className="sticky top-16 z-10 -mx-1 mb-2 bg-canvas/90 px-1 py-1.5 text-sm font-semibold text-muted backdrop-blur">
                {dayLabel(day)}
                <span className="ml-2 font-normal text-muted/70">
                  {plays.length} {plays.length === 1 ? 'play' : 'plays'}
                </span>
              </h2>
              <ul className="space-y-2">
                {plays.map((event) => (
                  <HistoryRow
                    key={event.id}
                    event={event}
                    onRemove={() => remove.mutate(event.id)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="space-y-2">
          {events.map((event) => (
            <HistoryRow
              key={event.id}
              event={event}
              onRemove={() => remove.mutate(event.id)}
            />
          ))}
        </ul>
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

function HistoryRow({ event, onRemove }: { event: WatchEvent; onRemove: () => void }) {
  const card = event.item
  const title = card?.show_title ?? card?.title ?? 'Unknown title'
  const subtitle = card ? displaySubtitle(card) : null

  return (
    <li className="group card flex items-center gap-3 p-2.5 transition-colors hover:bg-raised/60">
      <Link to={card ? `/item/${card.id}` : '#'} className="shrink-0">
        <Artwork
          src={card?.poster_url ?? null}
          title={title}
          showTitle={false}
          className="h-14 w-10 rounded-md bg-raised"
        />
      </Link>

      <div className="min-w-0 flex-1">
        <Link
          to={card ? `/item/${card.id}` : '#'}
          className="line-clamp-1 text-sm font-medium text-ink hover:text-accent"
        >
          {title}
        </Link>
        <p className="line-clamp-1 text-xs text-muted">{subtitle ?? '—'}</p>
      </div>

      <div className="hidden shrink-0 text-right sm:block">
        <p className="text-xs text-subtle">{formatDateTime(event.watched_at)}</p>
        <p className="text-[11px] text-muted">
          {SOURCE_LABELS[event.source]}
          {event.player ? ` · ${event.player}` : ''}
        </p>
      </div>

      {card?.is_anime && (
        <span className="hidden rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent md:inline">
          Anime
        </span>
      )}

      <button
        type="button"
        onClick={onRemove}
        className={cn(
          'grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted',
          'transition-all hover:bg-danger/10 hover:text-danger',
          // Always visible and tappable where there is no hover to reveal it
          // with. Above lg it fades in on hover, but `opacity-0` alone still
          // hit-tests: on a touch screen that left an invisible delete button
          // permanently armed at the end of every row.
          'lg:pointer-events-none lg:opacity-0',
          'lg:group-hover:pointer-events-auto lg:group-hover:opacity-100',
          'lg:focus-visible:pointer-events-auto lg:focus-visible:opacity-100',
        )}
        title="Remove from history"
        aria-label={`Remove ${title} from history`}
      >
        <XIcon className="text-sm" />
      </button>
    </li>
  )
}
