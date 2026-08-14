import { useState } from 'react'
import { Link } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useToast } from '@/lib/app-context'
import type { WatchEvent } from '@/lib/types'
import {
  cn,
  compactNumber,
  displaySubtitle,
  formatDateTime,
  posterFallbackGradient,
} from '@/lib/utils'
import { EmptyState, PageHeader, Segmented } from '@/components/ui'
import { ClockIcon, XIcon } from '@/components/Icons'

const PAGE_SIZE = 50

const SOURCE_LABELS: Record<WatchEvent['source'], string> = {
  plex_history: 'Plex',
  plex_webhook: 'Plex (live)',
  plex_session: 'Plex session',
  manual: 'Logged here',
  import: 'Imported',
}

type Filter = 'all' | 'movie' | 'episode' | 'anime'

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
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(0)
  const queryClient = useQueryClient()
  const { notify } = useToast()

  const query = {
    media_type: filter === 'movie' || filter === 'episode' ? filter : undefined,
    anime_only: filter === 'anime' || undefined,
    offset: page * PAGE_SIZE,
    limit: PAGE_SIZE,
  }

  const { data, isLoading } = useQuery({
    queryKey: ['history', query],
    queryFn: () => api.history.list(query),
    placeholderData: keepPreviousData,
  })

  const remove = useMutation({
    mutationFn: (eventId: number) => api.history.remove(eventId),
    onSuccess: () => {
      notify('Removed from history', 'info')
      queryClient.invalidateQueries({ queryKey: ['history'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
      queryClient.invalidateQueries({ queryKey: ['media'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const total = data?.total ?? 0
  const pageCount = Math.ceil(total / PAGE_SIZE)
  const grouped = groupByDay(data?.events ?? [])

  return (
    <div>
      <PageHeader
        title="History"
        subtitle={isLoading ? 'Loading…' : `${compactNumber(total)} plays recorded`}
        actions={
          <Segmented
            label="Filter history"
            value={filter}
            onChange={(value) => {
              setFilter(value)
              setPage(0)
            }}
            options={[
              { value: 'all', label: 'Everything' },
              { value: 'movie', label: 'Movies' },
              { value: 'episode', label: 'Episodes' },
              { value: 'anime', label: 'Anime' },
            ]}
          />
        }
      />

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="skeleton h-16 rounded-xl" />
          ))}
        </div>
      ) : total === 0 ? (
        <EmptyState
          icon={<ClockIcon />}
          title="No watch history yet"
          description="Sync with Plex to import what you have already watched, or mark something watched from its page."
        />
      ) : (
        <div className="space-y-8">
          {grouped.map(([day, events]) => (
            <section key={day}>
              <h2 className="sticky top-16 z-10 -mx-1 mb-2 bg-canvas/90 px-1 py-1.5 text-sm font-semibold text-muted backdrop-blur">
                {dayLabel(day)}
                <span className="ml-2 font-normal text-muted/70">
                  {events.length} {events.length === 1 ? 'play' : 'plays'}
                </span>
              </h2>
              <ul className="space-y-2">
                {events.map((event) => (
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
      )}

      {pageCount > 1 && (
        <nav className="mt-10 flex items-center justify-center gap-2" aria-label="Pagination">
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

function HistoryRow({ event, onRemove }: { event: WatchEvent; onRemove: () => void }) {
  const card = event.item
  const title = card?.show_title ?? card?.title ?? 'Unknown title'
  const subtitle = card ? displaySubtitle(card) : null

  return (
    <li className="group card flex items-center gap-3 p-2.5 transition-colors hover:bg-raised/60">
      <Link
        to={card ? `/item/${card.id}` : '#'}
        className="h-14 w-10 shrink-0 overflow-hidden rounded-md bg-raised"
        style={card?.poster_url ? undefined : { background: posterFallbackGradient(title) }}
      >
        {card?.poster_url && (
          <img src={card.poster_url} alt="" loading="lazy" className="h-full w-full object-cover" />
        )}
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
          'grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted opacity-0',
          'transition-all hover:bg-danger/10 hover:text-danger',
          'group-hover:opacity-100 focus-visible:opacity-100',
        )}
        title="Remove from history"
        aria-label={`Remove ${title} from history`}
      >
        <XIcon className="text-sm" />
      </button>
    </li>
  )
}
