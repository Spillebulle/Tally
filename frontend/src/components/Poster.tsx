import { Link } from 'react-router-dom'
import { Check, Sparkles, Star } from 'lucide-react'
import type { MediaCard } from '@/lib/types'
import {
  cn,
  displaySubtitle,
  displayTitle,
  formatRating,
  posterFallbackGradient,
} from '@/lib/utils'
import { Spinner } from './ui'

/**
 * Artwork with its placeholder underneath, rather than instead of it.
 *
 * Artwork that needs a Plex token is proxied through Tally, so whether an image
 * actually exists is only known once the request comes back. Layering means a
 * 404 simply reveals the placeholder, and there is no second code path to keep
 * in step with the first. `children` render above the artwork.
 *
 * Everything drawn over the artwork is a mark over user content, so it takes
 * a derived ink (white on a dark scrim) rather than a theme token (§2.6).
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
    <div
      className={cn('relative overflow-hidden', className)}
      style={{ background: posterFallbackGradient(title) }}
    >
      {showTitle && (
        <div className="absolute inset-0 flex items-end p-3">
          <span className="line-clamp-4 text-body font-semibold text-white/90">{title}</span>
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

interface PosterProps {
  card: MediaCard
  showProgress?: boolean
  onQuickWatch?: (card: MediaCard) => void
  /** True while this card's quick-watch is in flight. */
  quickWatchPending?: boolean
  /** Draws the 2px accent border of a picked card (§7.15). */
  selected?: boolean
  className?: string
}

/**
 * The poster card used across every grid and rail (§7.15): the picture flush
 * to the card's edge, a caption row under it, never over it. Hover turns the
 * border dashed; a selected card wears the 2px accent border. No lift, no
 * shadow — cards are the page's structure, not floating things.
 */
export function Poster({
  card,
  showProgress = true,
  onQuickWatch,
  quickWatchPending = false,
  selected = false,
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

  return (
    <div
      className={cn(
        'group/poster card relative overflow-hidden transition-colors duration-hover ease-ease',
        selected
          ? 'border-accent ring-1 ring-accent'
          : 'hover:border-line-dashed focus-within:border-line-dashed',
        className,
      )}
    >
      <Link
        to={`/item/${card.id}`}
        className="block focus-visible:outline-none"
        aria-label={subtitle ? `${title}, ${subtitle}` : title}
      >
        <Artwork src={card.poster_url} title={title} className="aspect-[2/3] w-full">
          {/* Badges sit over the artwork, so they keep the scrim-and-white
              derived ink rather than theme tokens. */}
          <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap gap-1.5">
            {card.is_anime && (
              <span
                className="inline-flex items-center gap-1 rounded-tight bg-black/70 px-1.5 py-0.5
                           text-eyebrow font-semibold uppercase text-white backdrop-blur-sm"
              >
                <Sparkles size={11} aria-hidden="true" />
                Anime
              </span>
            )}
            {/* Says what a blank tile is. These only reach a grid through
                search, and without this one looks like a film whose artwork
                failed to load — which is how it got reported as a bug. */}
            {card.is_personal_media && (
              <span
                className="inline-flex items-center rounded-tight bg-black/70 px-1.5 py-0.5
                           text-eyebrow font-semibold uppercase text-white backdrop-blur-sm"
              >
                Home video
              </span>
            )}
          </div>

          {isComplete && (
            <span
              className="pointer-events-none absolute right-2 top-2 grid h-5 w-5 place-items-center
                         rounded-full bg-good text-white"
              title="Watched"
            >
              <Check size={12} strokeWidth={3} aria-hidden="true" />
            </span>
          )}

          {/* Hover overlay. Everything in it is also reachable elsewhere (the
              item page), since hover does not exist on touch. */}
          <div
            className="absolute inset-0 flex items-end justify-between gap-2 bg-gradient-to-t
                       from-black/85 via-black/25 to-transparent p-2.5 opacity-0
                       transition-opacity duration-open
                       group-hover/poster:opacity-100 group-focus-within/poster:opacity-100"
          >
            {card.rating != null && card.rating > 0 ? (
              <span className="figure flex items-center gap-1 text-tiny text-white/90">
                <Star size={11} fill="currentColor" aria-hidden="true" />
                {formatRating(card.rating)}
                <span className="text-white/60">/10</span>
              </span>
            ) : (
              <span />
            )}
            {onQuickWatch && !isComplete && (
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault()
                  onQuickWatch(card)
                }}
                disabled={quickWatchPending}
                className="pointer-events-auto grid h-7 w-7 place-items-center rounded-full
                           bg-white/95 text-black transition-opacity duration-hover
                           hover:opacity-90 disabled:opacity-70"
                title={quickWatchPending ? 'Marking as watched…' : 'Mark as watched'}
                aria-label={
                  quickWatchPending
                    ? `Marking ${title} as watched`
                    : `Mark ${title} as watched`
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
          </div>

          {/* Resume progress sits on the artwork's bottom edge. */}
          {showProgress && progress != null && progress > 0 && progress < 100 && (
            <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/50">
              <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
            </div>
          )}
        </Artwork>

        {/* Caption row: title 12px 600 `text-strong`, the figure at the right
            in `text-dim` (§7.15). */}
        <div className="px-2.5 py-2">
          <div className="line-clamp-1 text-body font-semibold text-strong">{title}</div>
          <div className="mt-0.5 flex items-center justify-between gap-2 text-tiny text-dim">
            <span className="line-clamp-1">{subtitle ?? '–'}</span>
            {episodeProgress != null && card.media_type === 'show' && (
              <span className="figure shrink-0">
                {card.watched_episodes}/{card.total_episodes}
              </span>
            )}
          </div>
          {episodeProgress != null && card.media_type === 'show' && (
            <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-rail">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.min(100, episodeProgress)}%` }}
              />
            </div>
          )}
        </div>
      </Link>
    </div>
  )
}

export function PosterSkeleton() {
  return (
    <div className="card overflow-hidden">
      <div className="skeleton aspect-[2/3] w-full" />
      <div className="px-2.5 py-2">
        <div className="skeleton h-3 w-3/4 rounded-tight" />
        <div className="skeleton mt-1.5 h-2.5 w-1/3 rounded-tight" />
      </div>
    </div>
  )
}

interface PosterGridProps {
  cards: MediaCard[]
  loading?: boolean
  skeletonCount?: number
  onQuickWatch?: (card: MediaCard) => void
  /** Card whose quick-watch is currently in flight, if any. */
  quickWatchPendingId?: number | null
}

export function PosterGrid({
  cards,
  loading,
  skeletonCount = 12,
  onQuickWatch,
  quickWatchPendingId = null,
}: PosterGridProps) {
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4
                 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7"
    >
      {loading
        ? Array.from({ length: skeletonCount }, (_, index) => (
            <PosterSkeleton key={index} />
          ))
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
  action?: React.ReactNode
  onQuickWatch?: (card: MediaCard) => void
  quickWatchPendingId?: number | null
}

/** Horizontally scrolling rail — used for dashboard sections. */
export function PosterRail({
  title,
  cards,
  loading,
  action,
  onQuickWatch,
  quickWatchPendingId = null,
}: PosterRailProps) {
  if (!loading && cards.length === 0) return null

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <h2 className="text-heading font-semibold text-strong">{title}</h2>
        {action}
      </div>
      {/* The padding is room for the keyboard focus ring, not spacing:
          `scroll-x` clips on both axes (see index.css), and a 2px ring on a
          flush tile would be cut on every edge. Each padding is taken straight
          back as a negative margin, so nothing moves and the rail still starts
          flush with the heading above it. */}
      <div className="scroll-x scrollbar-none -mx-1 -my-1 flex gap-3 px-1 py-1">
        {(loading ? Array.from({ length: 8 }) : cards).map((card, index) => (
          <div
            key={loading ? index : (card as MediaCard).id}
            className="w-[140px] shrink-0 sm:w-[150px]"
          >
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
