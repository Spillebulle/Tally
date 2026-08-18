import { Link } from 'react-router-dom'
import { Check, Sparkles } from 'lucide-react'
import type { MediaCard } from '@/lib/types'
import {
  cn,
  displayArtwork,
  displaySubtitle,
  displayTitle,
  posterFallbackGradient,
} from '@/lib/utils'
import { cardSizeStyle, type CardSize } from '@/lib/card-size'
import { ErrorState, Spinner } from './ui'

/**
 * Artwork with its placeholder underneath, rather than instead of it.
 *
 * Artwork that needs a Plex token is proxied through Tally, so whether an image
 * actually exists is only known once the request comes back. Layering means a
 * 404 simply reveals the placeholder, and there is no second code path to keep
 * in step with the first. `children` render above the artwork.
 *
 * The box carries `.art` — a `control` block at the picture's own size, so the
 * layout does not move when the image lands and a title with no artwork is a
 * block the size of its siblings rather than a gap (§7.21). Size and shape come
 * from the caller, off the ladder: `w-art-tile aspect-art`, and so on.
 *
 * Everything drawn over the artwork is a mark over user content, so it takes
 * the artwork inks (`text-art`, `text-art-dim` on a black scrim) rather than a
 * theme token. That is the one place the light theme does not lighten: a
 * picture supplies its own contrast (§2.6, §7.21).
 */
export function Artwork({
  src,
  title,
  className,
  imgClassName,
  showTitle = true,
  children,
}: {
  src: string | null
  title: string
  className?: string
  imgClassName?: string
  showTitle?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className={cn('art', className)} style={{ background: posterFallbackGradient(title) }}>
      {/* The name of the thing, on the placeholder and *under* the picture, so
          it is covered the instant artwork arrives and is never a second copy
          of a title the artwork already carries. §7.21 asks a missing picture
          to be a block with the item's name or initials in it, never a gap,
          and on a fresh instance with no TMDB key and no Plex artwork that is
          every card on the page.

          Centred rather than along the bottom, because the bottom is where the
          art card's own label goes; `.art-placeholder` steps aside when that
          label appears, so an artwork-less card is never captioned twice. */}
      {showTitle && (
        <div className="art-placeholder absolute inset-0 grid place-items-center p-3 text-center">
          <span className="line-clamp-4 text-control font-semibold text-art-dim">{title}</span>
        </div>
      )}
      {src && (
        <img
          // Keyed by src so a failed load cannot outlive the URL that failed.
          // The failure used to be recorded by setting `display: none` on the
          // DOM node, which nothing reset — and since `poster_for()` always
          // returns a URL, a 404 is the *normal* path for an artwork-less item.
          // React then reused that same hidden <img> for the next item, hiding
          // a poster that existed.
          key={src}
          src={src}
          alt=""
          // Lazy, because a wall of these is hundreds of posters and each Plex
          // one costs the proxy a fetch. That part works: the requests go out.
          loading="lazy"
          // But NOT `decoding="async"`, which is what "some posters stay blank
          // until I hover one" turned out to be. It tells the browser it may
          // show a frame without waiting for the image to be decoded, and pick
          // it up afterwards. Paging swaps a whole screen of tiles in and the
          // page then falls idle, so "afterwards" never arrives: the poster is
          // loaded — `complete`, real `naturalWidth` — and simply never drawn.
          // Measured on the live library it hit the lowest rows of the window
          // on 7 of 20 page changes. Anything that forces a redraw reveals them
          // at once, which is why hovering a tile or rolling the wheel one pixel
          // looked like it was going and fetching the image. Leaving the decode
          // to the browser's own default costs nothing here — neither way does
          // a page change produce a single long task — so it must not come back
          // as an optimisation.
          className={cn('absolute inset-0 h-full w-full object-cover', imgClassName)}
          onError={(event) => {
            event.currentTarget.style.display = 'none'
          }}
        />
      )}
      {children}
    </div>
  )
}

/**
 * A mark in a corner of a piece of artwork: watched, anime, home video.
 *
 * §7.21 allows exactly this much on a resting art card — state that has to be
 * legible without hovering, as a small mark on a `--scrim-flat` disc or pill,
 * in a semantic colour or the artwork ink. It is deliberately not `.badge`,
 * which is a theme-coloured chip built for a `chrome` surface and vanishes on
 * a bright poster.
 */
export function ArtMark({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      className="pointer-events-none inline-flex items-center gap-1 rounded-tight
                 bg-scrim-flat px-1.5 py-0.5 text-eyebrow font-semibold uppercase
                 text-art backdrop-blur-sm"
      title={title}
    >
      {children}
    </span>
  )
}

interface PosterProps {
  card: MediaCard
  showProgress?: boolean
  /**
   * The watched tick in the top-right corner.
   *
   * Off where every card on the page is watched by definition - a log of plays
   * - because a mark that is always on says nothing and it sits exactly where
   * the page's own corner control does. Two things in one corner is one thing
   * covering another.
   */
  showWatched?: boolean
  onQuickWatch?: (card: MediaCard) => void
  /** True while this card's quick-watch is in flight. */
  quickWatchPending?: boolean
  /** Draws the 2px accent border of a picked card (§7.15). */
  selected?: boolean
  /**
   * Extra `ArtMark`s for the top-left cluster.
   *
   * A prop rather than a sibling drawn over the card, because §7.21 puts state
   * that has to read at rest in a corner *of the artwork*, and a caller
   * stacking its own mark outside the card can only put it where something
   * else already is - or, as the watchlist did, in a caption line underneath,
   * which is the one thing an art card does not have.
   */
  marks?: React.ReactNode
  className?: string
}

/**
 * The art card (§7.21): where the picture is the item, the card **is** the
 * picture.
 *
 * At rest it is artwork and nothing else — no plate, no border, no caption
 * strip beneath. The strip is what made a grid of posters read as a grid of
 * boxes: every card ended up taller than the thing it existed to show, and on
 * a card with no artwork the title was set twice, once over the placeholder
 * gradient and once underneath it.
 *
 * The label lives on the artwork instead — the title and one figure, two lines
 * and never three — and it is **visible by default**, hidden only where a
 * pointer can actually reveal it. The name of a thing is never information you
 * can get only by hovering, so a touch screen and `prefers-reduced-motion`
 * both keep it, and keyboard focus does exactly what hover does. All of that
 * lives in `.art-label` in index.css rather than here: a component asks for
 * the class and never asks which input the viewer has.
 *
 * Size is the caller's, off the ladder, and one rung per page.
 */
export function Poster({
  card,
  showProgress = true,
  showWatched = true,
  onQuickWatch,
  quickWatchPending = false,
  selected = false,
  marks,
  className,
}: PosterProps) {
  const title = displayTitle(card)
  const subtitle = displaySubtitle(card)
  const progress = card.progress_percent
  const episodeProgress =
    card.watched_episodes != null && card.total_episodes
      ? (card.watched_episodes / card.total_episodes) * 100
      : null
  const isComplete = card.status === 'completed'
  const isShow = card.media_type === 'show'

  // One bar on the artwork's bottom edge, not two bars in two places. A film's
  // is how far into it you are; a series' is how much of it you have seen.
  // Both are state that has to read at rest, so neither waits for a pointer.
  const bar =
    progress != null && progress > 0 && progress < 100
      ? progress
      : isShow && episodeProgress != null && episodeProgress > 0 && episodeProgress < 100
        ? episodeProgress
        : null

  // The one figure under the title: how far through a series you are, or the
  // year. Never both, because the label is two lines.
  const figure =
    isShow && card.watched_episodes != null && card.total_episodes
      ? `${card.watched_episodes}/${card.total_episodes} episodes`
      : subtitle

  return (
    <Link
      to={`/item/${card.id}`}
      aria-label={subtitle ? `${title}, ${subtitle}` : title}
      className={cn(
        'art-card aspect-art w-full',
        // §7.15's picked card: 2px accent, on the artwork's own corner radius.
        // Inset, because a ring outside the box would be clipped by the rail.
        selected && 'ring-2 ring-inset ring-accent',
        className,
      )}
    >
      <Artwork
        // The series' poster for an episode, where the endpoint sent one: the
        // card already says the series' *name*, and an episode still cropped to
        // portrait is a face cut in half. See `displayArtwork`.
        src={displayArtwork(card)}
        title={title}
        className="absolute inset-0 rounded-none"
      >
        {/* Marks that have to be legible at rest, so they are not in the label
            and do not wait for a pointer. */}
        <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap gap-1.5">
          {card.is_anime && (
            <ArtMark>
              <Sparkles size={11} aria-hidden="true" />
              Anime
            </ArtMark>
          )}
          {/* Says what a blank tile is. These only reach a grid through search,
              and without this one looks like a film whose artwork failed to
              load — which is how it got reported as a bug. */}
          {card.is_personal_media && <ArtMark>Home video</ArtMark>}
          {marks}
        </div>

        {isComplete && showWatched && (
          <span
            className="pointer-events-none absolute right-2 top-2 grid h-5 w-5 place-items-center
                       rounded-full bg-good text-art"
            title="Watched"
          >
            <Check size={12} strokeWidth={3} aria-hidden="true" />
          </span>
        )}
      </Artwork>

      {/* `.art-label` decides when the label shows; this decides what it says. */}
      <span className="art-label">
        <span className="flex items-end gap-2">
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-control font-semibold text-art">{title}</span>
            {figure && (
              <span className="mt-0.5 block truncate text-tiny text-art-dim">{figure}</span>
            )}
          </span>

          {onQuickWatch && !isComplete && (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault()
                onQuickWatch(card)
              }}
              disabled={quickWatchPending}
              className="pointer-events-auto grid h-6 w-6 shrink-0 place-items-center
                         rounded-full bg-scrim-flat text-art transition-opacity
                         duration-hover hover:opacity-80 disabled:opacity-70"
              title={quickWatchPending ? 'Marking as watched.' : 'Mark as watched'}
              aria-label={
                quickWatchPending ? `Marking ${title} as watched` : `Mark ${title} as watched`
              }
            >
              {/* Marking pushes a scrobble to Plex, so it is a round trip.
                  Without this the tile just sat there looking ignored. */}
              {quickWatchPending ? (
                <Spinner className="text-body" />
              ) : (
                <Check size={14} aria-hidden="true" />
              )}
            </button>
          )}
        </span>
      </span>

      {showProgress && bar != null && (
        <span className="absolute inset-x-0 bottom-0 h-[3px] bg-scrim-flat">
          <span className="block h-full bg-accent" style={{ width: `${Math.min(100, bar)}%` }} />
        </span>
      )}
    </Link>
  )
}

/** The card's geometry with nothing in it. No caption strip to stand in for. */
export function PosterSkeleton() {
  return <div className="art skeleton aspect-art w-full" />
}

/**
 * The card grid, named once, because the watchlist lays its own cards out (each
 * wrapped so the remove control has somewhere to sit) and a second copy of the
 * numbers is a second grid that drifts off the ladder - which is exactly what
 * happened: the watchlist was still on 150/220 while the browse pages moved to
 * `--art-card`, and the same posters were two sizes on two pages.
 *
 * The reflow rule and the floor live in `.poster-grid` in index.css. The size
 * itself is the reader's, through `cardSizeStyle` - so a page that offers no
 * choice simply does not set `--card-floor` and gets `--art-card`.
 */
export const POSTER_GRID = 'poster-grid'

interface PosterGridProps {
  cards: MediaCard[]
  loading?: boolean
  skeletonCount?: number
  onQuickWatch?: (card: MediaCard) => void
  /** Card whose quick-watch is currently in flight, if any. */
  quickWatchPendingId?: number | null
  /** The reader's chosen rung. Omitted leaves the grid at `--art-card`. */
  size?: CardSize
}

export function PosterGrid({
  cards,
  loading,
  skeletonCount = 12,
  onQuickWatch,
  quickWatchPendingId = null,
  size,
}: PosterGridProps) {
  return (
    <div className={POSTER_GRID} style={size ? cardSizeStyle(size) : undefined}>
      {loading
        ? Array.from({ length: skeletonCount }, (_, index) => <PosterSkeleton key={index} />)
        : cards.map((card) => (
            <Poster
              key={card.id}
              card={card}
              onQuickWatch={onQuickWatch}
              quickWatchPending={quickWatchPendingId === card.id}
            />
          ))}
    </div>
  )
}

interface PosterRailProps {
  title: string
  cards: MediaCard[]
  loading?: boolean
  /**
   * The request failed.
   *
   * A rail takes `cards={data ?? []}`, so without this a 500 renders as an
   * empty rail, which then hides itself: the page silently loses a section and
   * says the library is empty. That is the standing "a failed request is not
   * an empty list" rule, and the rail has to answer it itself, because the
   * empty case is the one it swallows.
   *
   * **No caller passes it yet**, so the bug above is still reachable through
   * this component rather than fixed by it. `ItemDetail`'s "More like this"
   * hands over `cards={data ?? []}` and nothing else; `Dashboard` guards
   * `isError` before it composes its own panelled rail, which is why the two
   * pages disagree. The prop is the shape the guard should move into — not a
   * fix that has landed, and not to be described as one.
   */
  error?: unknown
  /** Retry the failed request. */
  onRetry?: () => void
  action?: React.ReactNode
  onQuickWatch?: (card: MediaCard) => void
  quickWatchPendingId?: number | null
}

/** Horizontally scrolling rail — used for dashboard sections. */
export function PosterRail({
  title,
  cards,
  loading,
  error,
  onRetry,
  action,
  onQuickWatch,
  quickWatchPendingId = null,
}: PosterRailProps) {
  // Checked before the empty branch, always: an error that falls through to
  // "nothing here" is the bug this exists to stop.
  if (error) {
    return (
      <section>
        <div className="mb-2 flex items-baseline justify-between gap-4">
          <h2 className="text-heading font-semibold text-strong">{title}</h2>
          {action}
        </div>
        <div className="card">
          <ErrorState error={error} onRetry={onRetry} />
        </div>
      </section>
    )
  }

  if (!loading && cards.length === 0) return null

  return (
    <section>
      {/* Below the rail, not on the cards: the section title, the count and any
          "show all" (§7.21). The cards carry nothing else. */}
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <h2 className="text-heading font-semibold text-strong">{title}</h2>
        {action}
      </div>
      {/* The padding is room for the focus ring and for the card's 3px lift,
          not spacing: `scroll-x` clips on both axes (see index.css), so a flush
          tile would be cut along every edge the moment it rose. Each padding is
          taken straight back as a negative margin, so nothing moves and the
          rail still starts flush with the heading above it. */}
      <div className="scroll-x scrollbar-none -mx-1 -my-2 flex gap-3 px-1 py-2">
        {(loading ? Array.from({ length: 8 }) : cards).map((card, index) => (
          <div key={loading ? index : (card as MediaCard).id} className="w-art-card shrink-0">
            {loading ? (
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
    </section>
  )
}
