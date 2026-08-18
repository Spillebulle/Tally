import { Link, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type HistoryCalendarQuery, type MediaQuery } from '@/lib/api'
import { useToast } from '@/lib/app-context'
import { dayWindow, HISTORY_SORTS, useBrowseFilters } from '@/lib/browse-filters'
import { CardSizeControl, cardSizeStyle, useCardSize } from '@/lib/card-size'
import type { HistoryCalendarDay, HistoryPage, WatchEvent } from '@/lib/types'
import {
  cn,
  compactNumber,
  displayArtwork,
  displaySubtitle,
  displayTitle,
  formatDateTime,
  localDateKey,
  parseLocalDateLabel,
} from '@/lib/utils'
import { BrowseFilters } from '@/components/BrowseFilters'
import { MonthCalendar, monthLabel } from '@/components/MonthCalendar'
import { Pagination, usePageParam } from '@/components/Pagination'
import { ArtMark, Artwork, POSTER_GRID, Poster, PosterSkeleton } from '@/components/Poster'
import { EmptyState, ErrorState, PageHeader, Segmented } from '@/components/ui'
import { CalendarDays, Clock, LayoutGrid, Rows3, X } from 'lucide-react'

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

/**
 * How the same plays are drawn. Three answers to three different questions.
 *
 * * **List** — what did I watch, most recent first. The densest, and the only
 *   one that shows where a play came from and what it was played on.
 * * **Posters** — the same diary, as artwork. A month of viewing is recognised
 *   at a glance in a way a column of titles never is.
 * * **Calendar** — *when*, and with what shape: the gaps, the runs, the Sunday
 *   that took six episodes. A list in date order hides all of that behind a
 *   scroll bar.
 *
 * In the URL, unlike the poster size beside it, and the difference is the usual
 * test: a view mode changes what is *fetched* (the calendar asks for a month,
 * not a page) and it carries a position with it — which month, which day is
 * open — so a link has to be able to say it and Back has to be able to undo it.
 * The card size changes neither, which is why it lives in `localStorage`.
 */
const VIEWS = [
  { value: 'list', label: 'List', icon: <Rows3 className="size-icon" aria-hidden="true" /> },
  {
    value: 'grid',
    label: 'Posters',
    icon: <LayoutGrid className="size-icon" aria-hidden="true" />,
  },
  {
    value: 'calendar',
    label: 'Calendar',
    icon: <CalendarDays className="size-icon" aria-hidden="true" />,
  },
] as const

type ViewMode = (typeof VIEWS)[number]['value']

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The month the reader is in, as `YYYY-MM`, in their own zone. */
const thisMonth = () => localDateKey(new Date()).slice(0, 7)

/**
 * The zone the browser is actually in.
 *
 * Sent with the calendar request rather than left to the stored preference,
 * because which day a play landed on is a question about where the reader is
 * *now*: a stored "Europe/Oslo" is the right default and the wrong answer for
 * the same person reading in Tokyo. The server still resolves it, and still
 * falls back to the preference and then to UTC.
 */
const browserZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

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

/**
 * The clock time a play happened, in the viewer's own zone.
 *
 * Inside a day group the date is the heading, so repeating it on every row
 * spends the column on something the reader already knows. Sorted any other
 * way there are no groups, and the row carries the whole stamp.
 */
function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
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
  // Every one of these is checked against what it may be, and falls back to the
  // page default: a URL is untrusted input, and `?month=2026-13` reaching the
  // API is a 422 and an error card where the calendar should be.
  const requestedView = params.get('view')
  const view: ViewMode = VIEWS.some((option) => option.value === requestedView)
    ? (requestedView as ViewMode)
    : 'list'
  const requestedMonth = params.get('month')
  const month = requestedMonth && MONTH.test(requestedMonth) ? requestedMonth : thisMonth()
  const requestedDay = params.get('day')
  // A day is only meaningful under the calendar that opened it. Left readable
  // in the other views, a stale `?day=` would narrow a diary with no control
  // anywhere saying so.
  const day =
    view === 'calendar' && requestedDay && DAY.test(requestedDay) ? requestedDay : null

  const { page, setPage } = usePageParam()
  const { size: cardSize, setSize: setCardSize } = useCardSize()
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
    /**
     * How the page is drawn, and where in it the reader is. None of the three
     * narrows anything, so "Clear all" must not take them: clearing the filters
     * from inside the calendar used to land the reader back in the list, in a
     * different month, which reads as the button having done something else.
     */
    keep: ['view', 'month', 'day'],
  })

  const setFilter = (next: Filter) =>
    filters.update('filter', next === 'all' ? null : next)

  // A default never survives into the URL, so leaving the calendar drops the
  // month and the day with it rather than leaving a position nothing can see.
  const setView = (next: ViewMode) =>
    filters.updateMany(
      next === 'calendar'
        ? { view: next }
        : { view: next === 'list' ? null : next, month: null, day: null },
    )

  // One write, not two: each starts from the URL as it is now, so a second call
  // would discard the first. Changing month closes the day open in the old one.
  const setMonth = (next: string) =>
    filters.updateMany({ month: next === thisMonth() ? null : next, day: null })

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

  // The calendar's day panel is the same list endpoint, narrowed to one date.
  // The window is *added* to the filters rather than replacing them, so a
  // filtered month opens a filtered day.
  const listQuery: MediaQuery = day ? { ...query, ...dayWindow(day), offset: 0 } : query

  const {
    data,
    isLoading: listLoading,
    isFetching: listFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['history', listQuery],
    queryFn: () => api.history.list(listQuery),
    placeholderData: keepPreviousData,
    // Under the calendar there is nothing to list until a day is picked.
    enabled: view !== 'calendar' || day !== null,
  })

  const calendarQuery: HistoryCalendarQuery = {
    ...query,
    month,
    tz: browserZone(),
    // A cell draws one picture, so one card is all it can use. The count and
    // the number of titles behind it come back whatever this is.
    per_day: 1,
    offset: undefined,
    limit: undefined,
  }
  const calendar = useQuery({
    queryKey: ['history-calendar', calendarQuery],
    queryFn: () => api.history.calendar(calendarQuery),
    placeholderData: keepPreviousData,
    enabled: view === 'calendar',
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
      await queryClient.cancelQueries({ queryKey: ['history', listQuery] })
      const previous = queryClient.getQueryData<HistoryPage>(['history', listQuery])
      queryClient.setQueryData<HistoryPage>(['history', listQuery], (old) =>
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
        queryClient.setQueryData(['history', listQuery], context.previous)
      }
      notify(error.message, 'error')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['history'] })
      // The month's counts are the same plays seen another way, so a removal
      // has to reach them too or the calendar keeps insisting on a play the
      // list no longer has.
      queryClient.invalidateQueries({ queryKey: ['history-calendar'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
      queryClient.invalidateQueries({ queryKey: ['media'] })
    },
  })

  /**
   * Is the month on screen the month that came back?
   *
   * `keepPreviousData` holds the old month's days while the new one is in
   * flight, which is what stops the grid blinking — but the heading, the cells
   * and the total all come from the URL, so for that moment they would be the
   * new month drawn from the old month's numbers. The payload echoes its own
   * `month` for exactly this: until the two agree, the grid is loading.
   */
  const shownMonth = calendar.data?.month === month ? calendar.data : null
  const monthReady = shownMonth !== null
  const total = data?.total ?? 0
  const pageCount = Math.ceil(total / PAGE_SIZE)
  const events = data?.events ?? []
  const isLoading = view === 'calendar' ? !monthReady : listLoading
  const isFetching = view === 'calendar' ? calendar.isFetching : listFetching
  // The day headings are only true while the list is in time order. Sorted by
  // title, consecutive rows come from unrelated dates, and grouping them would
  // print a heading per row and call each one a day's viewing.
  const byDay = filters.values.sort === 'watched_at'
  const grouped = byDay ? groupByDay(events) : []
  // `filter` is this page's own parameter rather than one of the shared ones,
  // so it is the one thing `filters.active` cannot know about.
  const narrowed = filters.active || filter !== 'all' || Boolean(filters.values.q)

  const removeRow = (event: WatchEvent) => remove.mutate(event.id)

  return (
    <div>
      <PageHeader
        title="History"
        subtitle={
          isLoading ? (
            'Loading…'
          ) : view === 'calendar' ? (
            <>
              <span className="figure">{compactNumber(shownMonth?.total ?? 0)}</span>{' '}
              plays in {monthLabel(month)}
            </>
          ) : (
            <>
              <span className="figure">{compactNumber(total)}</span> plays recorded
            </>
          )
        }
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
        // Both of these say how the plays are drawn rather than which plays
        // they are, which is what this slot is for. The poster size only
        // appears where there are posters to size.
        actions={
          <>
            {view === 'grid' && <CardSizeControl value={cardSize} onChange={setCardSize} />}
            <Segmented
              label="How history is shown"
              value={view}
              onChange={setView}
              options={VIEWS.map((option) => ({ ...option }))}
            />
          </>
        }
      />

      {view === 'calendar' ? (
        <CalendarView
          month={month}
          day={day}
          days={shownMonth?.days ?? []}
          loading={!monthReady}
          error={calendar.isError ? calendar.error : null}
          onRetry={() => void calendar.refetch()}
          onMonth={setMonth}
          onSelectDay={(dateKey) =>
            filters.updateMany({ day: dateKey === day ? null : dateKey })
          }
          dayEvents={events}
          dayTotal={total}
          dayLoading={listLoading}
          dayError={isError ? error : null}
          onRetryDay={() => void refetch()}
          onRemove={removeRow}
        />
      ) : isLoading ? (
        view === 'grid' ? (
          <div className={POSTER_GRID} style={cardSizeStyle(cardSize)}>
            {Array.from({ length: 12 }, (_, index) => (
              <PosterSkeleton key={index} />
            ))}
          </div>
        ) : (
          // The same geometry as the rows they stand in for: `h-row` each,
          // inside the same bordered list.
          <ul className="card overflow-hidden">
            {Array.from({ length: 12 }, (_, index) => (
              <li
                key={index}
                className="flex h-art-row items-center gap-2 border-b border-line-soft pr-2 last:border-b-0"
              >
                {/* The same geometry as the row it stands in for, picture and
                    all: a skeleton a rung shorter than its row is a page that
                    jumps when it loads. */}
                <span className="skeleton h-full w-auto shrink-0 rounded-art aspect-art" />
                <span className="skeleton h-2.5 w-40 rounded-tight" />
                <span className="skeleton ml-auto h-2.5 w-16 rounded-tight" />
              </li>
            ))}
          </ul>
        )
      ) : isError ? (
        // Before the empty branch, always: a 500 and an empty diary need
        // different reactions, and the empty one tells the user to run a sync.
        <div className="card">
          <ErrorState error={error} onRetry={() => void refetch()} />
        </div>
      ) : total === 0 ? (
        // An empty page means two different things: nothing watched at all, or
        // nothing matching the filters. Telling someone with 4,000 plays and a
        // narrow date window to go and run a sync would be daft.
        <div className="card">
          {narrowed ? (
            <EmptyState
              icon={<Clock size={24} />}
              title="No plays match those filters"
              description="Try widening them, or clear them to see everything you have watched."
              action={
                <button type="button" onClick={filters.clear} className="btn-secondary">
                  Clear filters
                </button>
              }
            />
          ) : (
            <EmptyState
              icon={<Clock size={24} />}
              title="No watch history yet"
              description="Sync with Plex to import what you have already watched, or mark something watched from its page."
            />
          )}
        </div>
      ) : byDay ? (
        <div className="flex flex-col gap-4">
          {grouped.map(([groupDay, plays]) => (
            <section key={groupDay}>
              {/* A group header inside a list is an eyebrow (§7.16). It sticks
                  under the 34px top bar, which is what `top-menubar` is: at a
                  hard-coded 64px it hung a whole bar's height too low. */}
              <h2 className="sticky top-menubar z-10 flex items-baseline gap-2 bg-window py-1.5">
                <span className="eyebrow">{dayLabel(groupDay)}</span>
                <span className="text-tiny text-dim">
                  <span className="figure">{plays.length}</span>{' '}
                  {plays.length === 1 ? 'play' : 'plays'}
                </span>
              </h2>
              {view === 'grid' ? (
                <PlayGrid plays={plays} size={cardSize} onRemove={removeRow} />
              ) : (
                <ul className="card overflow-hidden">
                  {plays.map((event) => (
                    <HistoryRow
                      key={event.id}
                      event={event}
                      showDate={false}
                      onRemove={() => removeRow(event)}
                    />
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      ) : view === 'grid' ? (
        <PlayGrid plays={events} size={cardSize} onRemove={removeRow} />
      ) : (
        <ul className="card overflow-hidden">
          {events.map((event) => (
            <HistoryRow
              key={event.id}
              event={event}
              showDate
              onRemove={() => removeRow(event)}
            />
          ))}
        </ul>
      )}

      {view !== 'calendar' && (
        <Pagination
          page={page}
          pageCount={pageCount}
          onPage={setPage}
          ready={!isLoading}
        />
      )}
    </div>
  )
}

/**
 * The month, and the day the reader has opened inside it.
 *
 * The day's plays land *under* the calendar rather than replacing it, and that
 * is the whole reason a day is a parameter of this view instead of a jump into
 * the list: the month stays on screen, so picking a second day is one click
 * rather than a click and a Back.
 */
function CalendarView({
  month,
  day,
  days,
  loading,
  error,
  onRetry,
  onMonth,
  onSelectDay,
  dayEvents,
  dayTotal,
  dayLoading,
  dayError,
  onRetryDay,
  onRemove,
}: {
  month: string
  day: string | null
  /** Only the days that have plays. */
  days: HistoryCalendarDay[]
  loading: boolean
  error: unknown
  onRetry: () => void
  onMonth: (month: string) => void
  onSelectDay: (dateKey: string) => void
  dayEvents: WatchEvent[]
  dayTotal: number
  dayLoading: boolean
  dayError: unknown
  onRetryDay: () => void
  onRemove: (event: WatchEvent) => void
}) {
  // A failed request is not an empty month: falling through would draw a
  // perfectly convincing calendar of nothing and hide a 500.
  if (error) {
    return (
      <div className="card">
        <ErrorState error={error} onRetry={onRetry} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <MonthCalendar
        month={month}
        days={days}
        loading={loading}
        selected={day}
        onSelectDay={onSelectDay}
        onMonth={onMonth}
      />

      {!loading && days.length === 0 && (
        <p className="text-control text-dim">Nothing watched in {monthLabel(month)}.</p>
      )}

      {day && (
        <section>
          <h2 className="mb-1 flex items-baseline gap-2">
            <span className="eyebrow">
              {parseLocalDateLabel(day).toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            </span>
            <span className="text-tiny text-dim">
              <span className="figure">{dayTotal}</span> {dayTotal === 1 ? 'play' : 'plays'}
            </span>
            <button
              type="button"
              onClick={() => onSelectDay(day)}
              className="btn-ghost ml-auto px-1.5"
              title="Close this day"
              aria-label="Close this day"
            >
              <X className="size-icon" aria-hidden="true" />
            </button>
          </h2>

          {dayError ? (
            <div className="card">
              <ErrorState error={dayError} onRetry={onRetryDay} />
            </div>
          ) : !dayLoading && dayEvents.length === 0 ? (
            // Only a hand-edited `?day=` reaches this - a cell with no plays is
            // not a button. Said in a sentence rather than left as an empty
            // bordered box, which reads as a list that failed to load.
            <p className="text-control text-dim">Nothing watched that day.</p>
          ) : (
            <ul className="card overflow-hidden">
              {dayLoading
                ? Array.from({ length: 3 }, (_, index) => (
                    <li
                      key={index}
                      className="flex h-art-row items-center gap-2 border-b border-line-soft pr-2 last:border-b-0"
                    >
                      <span className="skeleton h-full w-auto shrink-0 rounded-art aspect-art" />
                      <span className="skeleton h-2.5 w-40 rounded-tight" />
                    </li>
                  ))
                : dayEvents.map((event) => (
                    <HistoryRow
                      key={event.id}
                      event={event}
                      showDate={false}
                      onRemove={() => onRemove(event)}
                    />
                  ))}
            </ul>
          )}

          {/* One page of a day, which is a great many plays. Said out loud
              rather than silently truncated: a diary that drops rows is how a
              user comes to believe Tally lost them. */}
          {dayTotal > dayEvents.length && !dayLoading && (
            <p className="mt-1 text-tiny text-dim">
              Showing the first <span className="figure">{dayEvents.length}</span> of{' '}
              <span className="figure">{dayTotal}</span>.
            </p>
          )}
        </section>
      )}
    </div>
  )
}

/**
 * A day's plays as art cards — the diary with the pictures in it.
 *
 * One card per *play*, not per title, because this is still a log: watching the
 * same film twice in a day is two entries here and one row on any grid. The
 * time it happened is a mark on the artwork rather than a caption underneath,
 * for the reason `.art-card` has no caption strip at all (§7.21).
 */
function PlayGrid({
  plays,
  size,
  onRemove,
}: {
  plays: WatchEvent[]
  size: Parameters<typeof cardSizeStyle>[0]
  onRemove: (event: WatchEvent) => void
}) {
  return (
    <div className={POSTER_GRID} style={cardSizeStyle(size)}>
      {plays.map((event) =>
        event.item ? (
          <div key={event.id} className="group/play relative">
            <Poster
              card={event.item}
              // The bar is "how far through it you are", which is a fact about
              // the title and not about this play. On a log of finished plays
              // it would draw a progress bar under a film watched last March.
              showProgress={false}
              // Every card here is something you watched, so the tick says
              // nothing - and it sits in the corner this page puts its own
              // control in, which is how it was found: a green disc with a
              // remove button landing on top of it.
              showWatched={false}
              marks={<ArtMark>{timeOfDay(event.watched_at)}</ArtMark>}
            />
            <button
              type="button"
              onClick={() => onRemove(event)}
              // A mark over user content, so it takes the artwork inks on a
              // scrim rather than a theme token. Always visible where there is
              // no hover to reveal it with, and `pointer-events-none` beside
              // the fade, because opacity is not a hit test.
              className="absolute right-2 top-2 z-10 grid h-6 w-6 place-items-center rounded-full
                         bg-scrim-flat text-art backdrop-blur-sm transition-opacity
                         duration-open hover:bg-critical
                         lg:pointer-events-none lg:opacity-0
                         lg:group-hover/play:pointer-events-auto
                         lg:group-hover/play:opacity-100
                         lg:focus-visible:pointer-events-auto
                         lg:focus-visible:opacity-100"
              title="Remove from history"
              aria-label={`Remove ${displayTitle(event.item)} from history`}
            >
              <X className="size-icon" aria-hidden="true" />
            </button>
          </div>
        ) : null,
      )}
    </div>
  )
}

/**
 * One play, as a list row (§7.16): the name at control size, the trailing
 * figures right-aligned and monospaced, hairlines in `line-soft` between rows,
 * no zebra striping and no vertical rules.
 *
 * **The poster is at `--art-row`, and the row is sized by it.** This row used
 * to carry a 14 x 20 poster, which is three rungs below the bottom of the
 * ladder and, in §7.21's words about faces, a smudge doing no work — and the
 * lesson taken from removing it was "no picture", which was only half of it.
 * The rule is that a picture in a row gets the row's *rung*: `--art-row`, 48,
 * the one width on the ladder meant to sit inline in a list. Tally has no
 * landscape still to spend it on, so a portrait poster spends it on **height**
 * instead and comes out 32 x 48 — small, but a poster somebody who owns the
 * film recognises, which 14 x 20 never was.
 *
 * What it costs is honest and worth saying: the row goes from `h-row` (32) to
 * 48, so a page of fifty plays is half again as tall. Denser still is the same
 * list with `?view=…` on it — this is the middle of the three, not the
 * smallest.
 *
 * The picture is flush to the row's top and bottom edges rather than inset,
 * because an inset would need a vertical padding that is not on the fine grid
 * at either scale. Consecutive posters therefore form one column of artwork
 * with the hairlines crossing it.
 */
function HistoryRow({
  event,
  showDate,
  onRemove,
}: {
  event: WatchEvent
  /** The whole stamp, for a list with no day headings above it. */
  showDate: boolean
  onRemove: () => void
}) {
  const card = event.item
  const title = card?.show_title ?? card?.title ?? 'Unknown title'
  const subtitle = card ? displaySubtitle(card) : null
  const to = card ? `/item/${card.id}` : '#'

  return (
    <li className="group flex h-art-row items-center gap-2 border-b border-line-soft pr-2 text-control transition-colors duration-hover ease-ease last:border-b-0 hover:bg-control-hover">
      {/* Height off the ladder, width from `aspect-art` — never the other way
          round, because a poster stretched into a box of the wrong shape is
          the one thing 7.21 will not have. `shrink-0`, or a long title would
          squeeze the picture into a stripe. */}
      <Link to={to} className="h-full shrink-0" tabIndex={-1} aria-hidden="true">
        <Artwork
          src={card ? displayArtwork(card) : null}
          title={title}
          // The name is already in the row beside it, and at 32px wide the
          // placeholder could only ever show a letter and a half. The gradient
          // is still deterministic per title, so an artwork-less diary is a
          // column of stable colours rather than a column of grey.
          showTitle={false}
          className="h-full w-auto aspect-art"
        />
      </Link>

      <Link to={to} className="min-w-0 shrink truncate text-fg hover:text-strong">
        {title}
      </Link>

      {subtitle && (
        <span className="hidden min-w-0 flex-1 truncate text-tiny text-dim sm:block">
          {subtitle}
        </span>
      )}

      {/* One trailing cluster, always pushed right, with fixed widths inside
          it. Hung off the row directly, the figure lost its column whenever
          the row before it happened to carry an anime badge: the badge is
          hidden below `md`, so it took the `ml-auto` with it and the time
          landed against the title. */}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {card?.is_anime && <span className="badge hidden md:inline-flex">Anime</span>}

        <span className="hidden w-[10rem] truncate text-right text-tiny text-dim lg:block">
          {SOURCE_LABELS[event.source]}
          {event.player ? ` · ${event.player}` : ''}
        </span>

        {/* The figure column: right-aligned, monospaced and a fixed width, so
            a page of times lines up rather than shuffling by a digit. */}
        <span
          className={cn(
            'figure text-right text-tiny text-dim',
            showDate ? 'w-[5.5rem]' : 'w-[2.75rem]',
          )}
        >
          {showDate ? formatDateTime(event.watched_at) : timeOfDay(event.watched_at)}
        </span>

        <button
          type="button"
          onClick={onRemove}
          className={cn(
            'grid h-5 w-5 shrink-0 place-items-center rounded-tight text-muted',
            'transition-colors duration-hover ease-ease hover:text-critical',
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
          <X className="size-icon" aria-hidden="true" />
        </button>
      </span>
    </li>
  )
}
