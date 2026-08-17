import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { Check, ChevronRight, Clock, Tv } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth, useToast } from '@/lib/app-context'
import type { ContinueWatchingItem, MediaCard, StatCount } from '@/lib/types'
import {
  compactNumber,
  displaySubtitle,
  episodeCode,
  formatDateTime,
  relativeTime,
} from '@/lib/utils'
import { Artwork, Poster, PosterSkeleton } from '@/components/Poster'
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  ProgressBar,
  Skeleton,
  Spinner,
  Tile,
} from '@/components/ui'

/*
 * The first screen. §10 asks a page to say which modules it is made of, and in
 * the order they appear these are: a page header; an empty state (§7.19) when
 * there is nothing yet to show; a tile grid of six figures (§7.14) with one
 * sparkline (§8); a panel (§7.5) of picture rows for Continue watching; three
 * panels holding rails of poster cards (§7.15); and a panel of genre links.
 *
 * One module here departs from its spec, so it is named rather than left to be
 * discovered: the Continue watching row is 76px tall with a 40 × 60 poster,
 * where §7.16's picture row is 26px with a 40 × 20 thumbnail. A poster is 2:3
 * and cropping it to a 20px strip throws away the artwork that identifies the
 * title, and the row answers three questions rather than one - what it is, how
 * far in, and when it was last played - each of which is a line. Everything
 * else about it is the row spec: `control-hover` on hover, no separators, the
 * trailing figures in `text-dim`.
 *
 * Nothing here draws its own chrome. `Tile`, `Panel`, `Poster` and the two
 * states are the house primitives, and this file only composes them.
 */

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 5) return 'Still up'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/**
 * A figure for a tile, or `null` for "not known".
 *
 * §7.14 says an *unknown* value is an en dash, never a "0" for "no data". It
 * does not say the reverse, and the difference matters here: once `stats.data`
 * has arrived, all six of these counters are numbers computed over a known
 * window, so a zero among them is the answer rather than the absence of one.
 * Drawing a dash there had the page assert 604 plays and a longest streak of
 * 27 days while claiming not to know the current streak it had just been told.
 * So only `null` is unknown, and a real 0 prints as `0`.
 */
function figure(value: number | null | undefined): string | null {
  return value == null ? null : compactNumber(value)
}

/** A number inside a sentence is still a figure, so it is still mono. */
function Num({ children }: { children: React.ReactNode }) {
  return <span className="figure">{children}</span>
}

/**
 * Fold a daily series into a fixed number of buckets.
 *
 * A year of days is 365 points in 48px, which draws as noise rather than as a
 * shape. Roughly a fortnight per bucket says "rising" or "spiky" and claims
 * nothing more precise, which is all a sparkline is allowed to say.
 */
function fold(series: StatCount[], buckets = 24): number[] {
  if (series.length < 2) return []
  const size = Math.ceil(series.length / buckets)
  const out: number[] = []
  for (let index = 0; index < series.length; index += size) {
    const slice = series.slice(index, index + size)
    const sum = slice.reduce((total, point) => total + point.value, 0)
    // Read as a rate, not as a sum, because the last slice is nearly always
    // short: 366 days at 16 to a bucket is 22 full buckets and a last one of
    // 14. A plain sum then dips by the ratio of the two widths - 14/16, or
    // 12% - at precisely the point §8 asks for an endpoint dot, so the one
    // marked value on the chart would be the one artefact in it. Scaling the
    // short slice up to the full width removes that without dropping the most
    // recent fortnight, which is the half of the shape anybody is reading it
    // for. A full slice is unaffected: sum / size * size is the sum.
    out.push((sum / slice.length) * size)
  }
  return out
}

/**
 * §8's sparkline: 48 by 16, the accent line at 1.25px, its area at 14% and an
 * endpoint dot. No axes, no labels, no scale of its own.
 *
 * `aria-hidden`, because it is redundant by construction: the figure above it
 * and the line below it carry every number. A series that is flat at zero is
 * drawn as nothing at all, rather than as a line implying data that is not
 * there.
 */
function Sparkline({ points }: { points: number[] }) {
  const max = Math.max(...points, 0)
  if (points.length < 2 || max <= 0) return null

  const width = 48
  const height = 16
  // Inset by the dot's radius at every edge, so neither the endpoint dot nor a
  // flat maximum is clipped by the viewBox.
  const inset = 1.5
  const step = (width - inset * 2) / (points.length - 1)
  const x = (index: number) => inset + index * step
  const y = (value: number) => height - inset - (value / max) * (height - inset * 2)
  const line = points
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(value).toFixed(2)}`)
    .join(' ')

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={`${line} L${x(points.length - 1).toFixed(2)},${height} L${x(0).toFixed(2)},${height} Z`}
        className="fill-accent"
        // The area alpha is a token, and an opacity modifier on a token colour
        // emits no CSS at all. See docs/interface.md.
        style={{ fillOpacity: 'var(--area-alpha)' }}
      />
      <path
        d={line}
        fill="none"
        className="stroke-accent"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={x(points.length - 1)}
        cy={y(points[points.length - 1])}
        r={1.5}
        className="fill-accent"
      />
    </svg>
  )
}

/* ── Continue watching ───────────────────────────────────────────────────── */

/**
 * One thing the viewer is partway through: the artwork, what it is, how far in
 * and a mark-as-watched.
 *
 * A row rather than the old hero card. Six of them are the point of the screen,
 * and rows put six on the fold where cards put three.
 */
function ContinueRow({
  entry,
  onMarkWatched,
  marking,
}: {
  entry: ContinueWatchingItem
  onMarkWatched: (card: MediaCard) => void
  /** True while this row's mark-as-watched is in flight. */
  marking: boolean
}) {
  const target = entry.next_episode ?? entry.item
  const poster = entry.item.poster_url ?? entry.show?.poster_url ?? null
  const series = entry.show?.title ?? entry.item.show_title ?? null
  const code = episodeCode(target)

  /*
   * The heading names the episode, not only the series.
   *
   * One show can hold three part-watched episodes at once, and the API returns
   * all three: `routers/library.continue_watching` stops an "up next" card
   * duplicating a part-watched episode, but nothing dedupes part-watched
   * episodes of the same show against each other. Reported as a backend defect
   * rather than worked around here, because a row per part-watched episode may
   * well be the right answer - what was not right is that with the series title
   * alone, three of them read as one title printed three times with three
   * identical posters, told apart only by an 11px line underneath. The episode
   * code goes on the heading line, where the eye lands first, and it is a
   * figure, so it is mono.
   */
  const heading = series ?? target.title
  // When the heading is the series, the second line is the episode's own name;
  // otherwise it is the ordinary subtitle, which for a film is its year. An
  // episode Plex gave us with no series title at all gets neither, rather than
  // its code and title a second time.
  const name = code ? (series ? target.title : null) : displaySubtitle(target)
  const sub = name && entry.next_episode ? `Up next · ${name}` : name

  // The rail reads the resume position in both shapes; the label beside it says
  // which question it is answering, exactly as it did before. Only the numbers
  // are mono: a whole phrase set in the figure face reads as a code.
  const progressLabel = entry.next_episode ? (
    <>
      <Num>{entry.item.watched_episodes ?? 0}</Num>/
      <Num>{entry.item.total_episodes ?? '?'}</Num> episodes
    </>
  ) : (
    <>
      <Num>{Math.round(entry.progress_percent)}%</Num> watched
    </>
  )

  return (
    <div
      className="group/row flex items-center gap-3 rounded-ctl p-2 transition-colors
                 duration-hover ease-ease hover:bg-control-hover"
    >
      <Link to={`/item/${target.id}`} tabIndex={-1} aria-hidden="true" className="shrink-0">
        <Artwork
          src={poster}
          title={heading}
          showTitle={false}
          className="h-[60px] w-10 rounded-tight"
        />
      </Link>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {/* No hover colour of its own: the title is already `text-strong`, so
              there is nowhere for it to go, and the row's `control-hover` fill
              is the affordance. It must not be the accent - §2.4 keeps that for
              selection and the primary, and `hover:text-strong` from a weaker
              rest colour is the convention everywhere else in the app. */}
          <Link
            to={`/item/${target.id}`}
            className="flex min-w-0 flex-1 items-baseline gap-1.5 text-body font-semibold
                       text-strong"
          >
            <span className="truncate">{heading}</span>
            {code && <span className="figure shrink-0 font-normal text-muted">{code}</span>}
          </Link>
          {/* A time is a figure, so it is mono and tabular. */}
          <span
            className="figure shrink-0 text-tiny text-dim"
            title={
              entry.resumed_at
                ? `Last played ${formatDateTime(entry.resumed_at)}`
                : 'No play recorded.'
            }
          >
            {relativeTime(entry.resumed_at)}
          </span>
        </div>

        <div className="mt-0.5 flex items-center gap-2">
          {/* The badge sits beside the subtitle, not at the row's far edge:
              flex-1 on the text would push it half a card away from the thing
              it labels. */}
          <span className="truncate text-small text-muted">{sub}</span>
          {entry.item.is_anime && <span className="badge shrink-0">Anime</span>}
        </div>

        {/* The rail is a fixed 120px rather than the row's whole width: a rail
            that runs the length of the card reads as a slider, and it pushes
            the reading of it half a screen away from what it measures. */}
        <div className="mt-1.5 flex items-center gap-2">
          <ProgressBar className="w-[120px] shrink-0" fraction={entry.progress_percent / 100} />
          <span className="truncate text-tiny text-dim">{progressLabel}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => onMarkWatched(target)}
        disabled={marking}
        className="btn-icon shrink-0"
        title={marking ? 'Marking as watched.' : 'Mark as watched'}
        aria-label={
          marking ? `Marking ${target.title} as watched` : `Mark ${target.title} as watched`
        }
      >
        {marking ? <Spinner className="text-body" /> : <Check size={16} />}
      </button>
    </div>
  )
}

/** Keep the fold useful: the rest of the dashboard should stay reachable. */
const CONTINUE_LIMIT = 6

/*
 * Two floors, the same shape as `PosterGrid`.
 *
 * §7.14 puts a tile's minimum at 180px so a figure is never cramped, and that
 * is what runs above `sm`. On a 390px phone it would mean one tile per row and
 * six rows of scrolling before Continue watching, so the small floor is 170:
 * two columns of 177px, which a figure and two short lines read at perfectly
 * well. The number is a legibility floor rather than a magic constant, and
 * auto-fit reflows on its own from there.
 */
const TILE_GRID =
  'grid gap-3 grid-cols-[repeat(auto-fit,minmax(170px,1fr))] ' +
  'sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]'

/* ── Poster rails ────────────────────────────────────────────────────────── */

/**
 * A panel holding a horizontally scrolling row of poster cards.
 *
 * Composed here rather than taken from `PosterRail`, and the reason has changed
 * since this was written: it was that `PosterRail` had no error branch, and it
 * now has `error` / `onRetry`, so that is no longer it. What remains is the
 * chrome. `PosterRail` is a bare `<section>` with an `h2` above it, which is
 * right on an item page where the rail is one part of a longer document; every
 * section of this page is a §7.5 module with a panel header, a count beside the
 * title and its commands right-aligned in that header, and a rail rendered as a
 * plain heading in the middle of them reads as a different kind of thing. The
 * card sizes are the shared ones (140/150), so that is not a difference any
 * more either.
 *
 * If `PosterRail` ever takes a "render me as a panel" shape, this goes.
 */
function RailPanel({
  title,
  query,
  commands,
  onQuickWatch,
  quickWatchPendingId = null,
}: {
  title: string
  query: UseQueryResult<MediaCard[]>
  commands?: React.ReactNode
  onQuickWatch?: (card: MediaCard) => void
  quickWatchPendingId?: number | null
}) {
  const cards = query.data ?? []

  if (query.isError) {
    // The commands stay. "All history" and "Browse anime" are the way off this
    // panel and into the page that holds the same thing, which is exactly what
    // somebody looking at a failed rail wants; dropping them took the escape
    // hatch away at the only moment it was needed.
    return (
      <Panel title={title} commands={commands}>
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      </Panel>
    )
  }

  // Nothing to show and nothing on the way: the panel says nothing at all
  // rather than standing there empty, which is how this page has always
  // behaved.
  if (!query.isLoading && cards.length === 0) return null

  return (
    <Panel
      title={title}
      count={query.isLoading ? undefined : cards.length}
      commands={commands}
    >
      {/* The padding is room for the keyboard focus ring, not spacing:
          `scroll-x` clips on both axes (see index.css), and a ring on a flush
          tile would be cut on every edge. Each padding is taken straight back
          as a negative margin, so nothing moves. */}
      <div className="scroll-x scrollbar-none -mx-1 -my-1 flex gap-3 px-1 py-1">
        {(query.isLoading ? Array.from({ length: 8 }) : cards).map((card, index) => (
          <div
            key={query.isLoading ? index : (card as MediaCard).id}
            className="w-[140px] shrink-0 sm:w-[150px]"
          >
            {query.isLoading ? (
              <PosterSkeleton />
            ) : (
              <Poster
                card={card as MediaCard}
                onQuickWatch={onQuickWatch}
                quickWatchPending={quickWatchPendingId === (card as MediaCard).id}
              />
            )}
          </div>
        ))}
      </div>
    </Panel>
  )
}

/** A panel head command that goes somewhere else on the page. */
function GoTo({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="btn-ghost px-2">
      {children}
      <ChevronRight size={16} aria-hidden="true" />
    </Link>
  )
}

/* ── The page ────────────────────────────────────────────────────────────── */

export function Dashboard() {
  const { user } = useAuth()
  const { notify } = useToast()
  const queryClient = useQueryClient()
  const [showAllContinue, setShowAllContinue] = useState(false)

  const continueWatching = useQuery({
    queryKey: ['continue-watching'],
    queryFn: api.media.continueWatching,
    refetchInterval: 60_000,
  })
  const recentlyWatched = useQuery({
    queryKey: ['recently-watched'],
    queryFn: () => api.media.recentlyWatched(20),
  })
  const recentlyAdded = useQuery({
    queryKey: ['recently-added'],
    queryFn: () => api.media.recentlyAdded(undefined, 20),
  })
  const recentAnime = useQuery({
    queryKey: ['recently-added', 'anime'],
    queryFn: () => api.media.recentlyAdded('only', 20),
  })
  const stats = useQuery({ queryKey: ['stats', 365], queryFn: () => api.stats.get(365) })
  const summary = useQuery({ queryKey: ['summary'], queryFn: api.stats.summary })

  const markWatched = useMutation({
    mutationFn: (card: MediaCard) => api.history.markWatched(card.id),
    onSuccess: (_data, card) => {
      notify(`Logged “${card.title}” as watched`, 'success')
      queryClient.invalidateQueries({ queryKey: ['continue-watching'] })
      queryClient.invalidateQueries({ queryKey: ['recently-watched'] })
      queryClient.invalidateQueries({ queryKey: ['history'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })
  const markingId = markWatched.isPending ? markWatched.variables.id : null

  const visibleContinue = showAllContinue
    ? (continueWatching.data ?? [])
    : (continueWatching.data ?? []).slice(0, CONTINUE_LIMIT)

  // Only a *successful* summary can say the library is empty. A failed one
  // says nothing, so a 500 cannot tell the user to go and set up Plex again.
  const libraryEmpty =
    summary.isSuccess &&
    summary.data.library_movies === 0 &&
    summary.data.library_shows === 0

  const name = user?.display_name || user?.username || ''
  const hours = stats.data ? Math.round(stats.data.total_runtime_minutes / 60) : 0
  const plays = fold(stats.data?.activity_by_day ?? [])
  const events = stats.data?.watch_events ?? 0

  /*
   * The window is stated once, in the header, and not again under every figure.
   *
   * §7.14 asks a tile's second line for a unit or a comparison. Four of the six
   * said "in the past 12 months" instead, beneath a header that had just said
   * "over the past year": seven statements of one window on the screen that
   * goes at the top of the README, and the loudest repeated ink on it. These
   * two derive a comparison from the same response, so nothing here waits on a
   * second query or changes meaning when one arrives.
   */
  const perWeek = events / 52
  const perWeekLabel =
    perWeek === 0 ? '0' : perWeek >= 10 ? String(Math.round(perWeek)) : perWeek.toFixed(1)
  const share = (part: number) => (events > 0 ? Math.round((part / events) * 100) : 0)

  // The header states the window and the two figures the page is really about.
  const subtitle = stats.isError ? (
    'Your viewing figures could not be loaded.'
  ) : !stats.data ? (
    'Reading your viewing history.'
  ) : stats.data.watch_events === 0 ? (
    'Nothing has been logged over the past year.'
  ) : (
    <>
      <Num>{compactNumber(stats.data.watch_events)}</Num> plays and{' '}
      <Num>{compactNumber(hours)}</Num> hours over the past year.
    </>
  )

  return (
    <div className="space-y-3">
      <PageHeader
        title={`${greeting()}${name ? `, ${name.split(' ')[0]}` : ''}`}
        subtitle={subtitle}
      />

      {libraryEmpty && (
        <div className="card">
          <EmptyState
            icon={<Tv size={24} />}
            title="Your library is empty"
            description="Connect your Plex server and run a first sync to import everything you have watched."
            action={
              <Link to="/settings" className="btn-primary">
                Set up Plex
              </Link>
            }
          />
        </div>
      )}

      {/* A library with plays in it has none of these two cards; a library
          without them has one. Either way it comes before the figures rather
          than after three poster rails: it is the sentence that explains why
          every figure below it reads 0, and it was last on the page and off the
          fold, while the empty-library card two branches up was first. */}
      {!libraryEmpty && !stats.isLoading && stats.data?.watch_events === 0 && (
        <div className="card">
          <EmptyState
            icon={<Clock size={24} />}
            title="Nothing logged yet"
            description="Once you watch something on Plex, or mark it watched here, it will show up in your history and stats."
          />
        </div>
      )}

      {/* At a glance. Six figures, reflowing from 180px (§7.14). */}
      {stats.isError ? (
        <div className="card">
          <ErrorState
            error={stats.error}
            title="Could not load your figures"
            onRetry={() => stats.refetch()}
          />
        </div>
      ) : (
        <div className={TILE_GRID}>
          {/* The skeleton is the height a tile actually renders at: 12px of
              padding twice, a 10px eyebrow, 6px, the 24px figure, 4px and an
              11px line. It was 82, so the page jumped 6px per tile row the
              moment the figures landed. */}
          {stats.isLoading || !stats.data
            ? Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-[88px] rounded-card" />
              ))
            : [
                {
                  eyebrow: 'Plays logged',
                  value: figure(stats.data.watch_events),
                  detail: (
                    <>
                      About <Num>{perWeekLabel}</Num> a week.
                    </>
                  ),
                  spark: <Sparkline points={plays} />,
                },
                {
                  eyebrow: 'Screen time',
                  value: figure(hours),
                  detail: 'Hours.',
                },
                {
                  eyebrow: 'Films',
                  value: figure(stats.data.total_movies_watched),
                  detail:
                    events > 0 ? (
                      <>
                        <Num>{share(stats.data.total_movies_watched)}%</Num> of your plays.
                      </>
                    ) : (
                      'Plays of a film.'
                    ),
                },
                {
                  eyebrow: 'Episodes',
                  value: figure(stats.data.total_episodes_watched),
                  detail: (
                    <>
                      Across <Num>{stats.data.total_shows_watched}</Num> shows.
                    </>
                  ),
                },
                {
                  // The caption is drawn from the same response as the figure.
                  // It used to count anime *titles in the library*, from the
                  // summary query: a second metric under the first, in a second
                  // unit, over no window at all, and it read "Over the past 12
                  // months." until that query returned and then changed its
                  // meaning under the reader.
                  eyebrow: 'Anime plays',
                  value: figure(stats.data.total_anime_watched),
                  detail:
                    events > 0 ? (
                      <>
                        <Num>{share(stats.data.total_anime_watched)}%</Num> of your plays.
                      </>
                    ) : (
                      'Plays of an anime title.'
                    ),
                },
                {
                  eyebrow: 'Current streak',
                  value: figure(stats.data.current_streak_days),
                  detail: stats.data.longest_streak_days > 0 ? (
                    <>
                      Days in a row. Longest is <Num>{stats.data.longest_streak_days}</Num>.
                    </>
                  ) : (
                    'Days in a row.'
                  ),
                },
              ].map((tile) => (
                <Tile
                  key={tile.eyebrow}
                  eyebrow={tile.eyebrow}
                  value={tile.value}
                  detail={tile.detail}
                  spark={tile.spark}
                />
              ))}
        </div>
      )}

      {/* Continue watching. Hidden entirely when there is nothing part-watched,
          which is the behaviour this panel has always had. */}
      {continueWatching.isError ? (
        <Panel title="Continue watching">
          <ErrorState
            error={continueWatching.error}
            onRetry={() => continueWatching.refetch()}
          />
        </Panel>
      ) : continueWatching.isLoading || (continueWatching.data?.length ?? 0) > 0 ? (
        <Panel
          title="Continue watching"
          count={continueWatching.isLoading ? undefined : continueWatching.data?.length}
          commands={
            (continueWatching.data?.length ?? 0) > CONTINUE_LIMIT && (
              <button
                type="button"
                onClick={() => setShowAllContinue((value) => !value)}
                className="btn-ghost px-2"
              >
                {showAllContinue ? (
                  'Show fewer'
                ) : (
                  <>
                    Show all <Num>{continueWatching.data?.length}</Num>
                  </>
                )}
              </button>
            )
          }
          bodyClassName="p-1.5"
        >
          <div className="grid gap-0.5 sm:grid-cols-2 xl:grid-cols-3">
            {continueWatching.isLoading
              ? Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="h-[76px]" />
                ))
              : visibleContinue.map((entry) => (
                  <ContinueRow
                    key={`${entry.item.id}-${entry.next_episode?.id ?? 'self'}`}
                    entry={entry}
                    onMarkWatched={(card) => markWatched.mutate(card)}
                    marking={markingId === (entry.next_episode ?? entry.item).id}
                  />
                ))}
          </div>
        </Panel>
      ) : null}

      <RailPanel
        title="Recently watched"
        query={recentlyWatched}
        commands={<GoTo to="/history">All history</GoTo>}
      />

      <RailPanel
        title="Recently added to Plex"
        query={recentlyAdded}
        onQuickWatch={(card) => markWatched.mutate(card)}
        quickWatchPendingId={markingId}
      />

      <RailPanel
        title="New anime"
        query={recentAnime}
        commands={<GoTo to="/anime">Browse anime</GoTo>}
        onQuickWatch={(card) => markWatched.mutate(card)}
        quickWatchPendingId={markingId}
      />

      {stats.data && stats.data.top_genres.length > 0 && (
        <Panel
          title="What you gravitate to"
          commands={<GoTo to="/stats">Full stats</GoTo>}
        >
          {/* Buttons (§7.6), not chips. Each one opens a filtered grid, and
              `.chip` says of itself in index.css that a chip is a read-only
              figure which never opens anything - so a chip that is the page's
              only route into a genre teaches the wrong thing about every other
              chip in the app. `btn-outline` is the quiet control on a panel
              body, and the count rides along inside it as a figure. */}
          <div className="flex flex-wrap gap-2">
            {stats.data.top_genres.slice(0, 10).map((genre) => (
              <Link
                key={genre.label}
                // /browse: the counts behind these include shows and episodes,
                // and /movies would also drop anime entirely.
                to={`/browse?genre=${encodeURIComponent(genre.label)}`}
                className="btn-outline gap-1.5 px-2"
              >
                {genre.label}
                <span className="figure text-dim">{genre.value}</span>
              </Link>
            ))}
          </div>
        </Panel>
      )}
    </div>
  )
}
