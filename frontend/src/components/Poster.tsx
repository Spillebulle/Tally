import { Link } from 'react-router-dom'
import type { MediaCard } from '@/lib/types'
import {
  cn,
  displaySubtitle,
  displayTitle,
  formatRating,
  posterFallbackGradient,
} from '@/lib/utils'
import { CheckIcon, SparkIcon, StarIcon } from './Icons'
import { Spinner } from './ui'

/**
 * Artwork with its placeholder underneath, rather than instead of it.
 *
 * Artwork that needs a Plex token is proxied through Tally, so whether an image
 * actually exists is only known once the request comes back. Layering means a
 * 404 simply reveals the placeholder, and there is no second code path to keep
 * in step with the first. `children` render above the artwork.
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
          <span className="line-clamp-4 text-sm font-semibold text-white/90">{title}</span>
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
          loading="lazy"
          decoding="async"
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
  className?: string
}

/**
 * The poster tile used across every grid and rail.
 *
 * The whole tile is one link; quick actions sit in an overlay that only appears
 * on hover or keyboard focus, so the default state stays quiet and the artwork
 * carries the page.
 */
export function Poster({
  card,
  showProgress = true,
  onQuickWatch,
  quickWatchPending = false,
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
    <div className={cn('group/poster relative', className)}>
      <Link
        to={`/item/${card.id}`}
        className="block focus-visible:outline-none"
        aria-label={subtitle ? `${title} — ${subtitle}` : title}
      >
        <Artwork
          src={card.poster_url}
          title={title}
          className="aspect-[2/3] w-full rounded-xl bg-raised shadow-card
                     ring-1 ring-line transition-all duration-300 ease-spring
                     group-hover/poster:-translate-y-1 group-hover/poster:shadow-lift
                     group-focus-within/poster:-translate-y-1 group-focus-within/poster:ring-accent"
          imgClassName="transition-transform duration-500 ease-spring
                        group-hover/poster:scale-[1.04]"
        >
          {/* Badges */}
          <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap gap-1.5">
            {card.is_anime && (
              <span
                className="inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5
                           text-[10px] font-semibold uppercase tracking-wide text-white
                           backdrop-blur-sm"
              >
                <SparkIcon className="text-[11px]" />
                Anime
              </span>
            )}
            {/* Says what a blank tile is. These only reach a grid through
                search, and without this one looks like a film whose artwork
                failed to load — which is how it got reported as a bug. */}
            {card.is_personal_media && (
              <span
                className="inline-flex items-center rounded-md bg-black/70 px-1.5 py-0.5
                           text-[10px] font-semibold uppercase tracking-wide text-white
                           backdrop-blur-sm"
              >
                Home video
              </span>
            )}
          </div>

          {isComplete && (
            <span
              className="pointer-events-none absolute right-2 top-2 grid h-6 w-6 place-items-center
                         rounded-full bg-good text-white shadow"
              title="Watched"
            >
              <CheckIcon className="text-xs" />
            </span>
          )}

          {/* Hover overlay */}
          <div
            className="absolute inset-0 flex items-end justify-between gap-2 bg-gradient-to-t
                       from-black/85 via-black/25 to-transparent p-2.5 opacity-0
                       transition-opacity duration-300
                       group-hover/poster:opacity-100 group-focus-within/poster:opacity-100"
          >
            {card.rating != null && card.rating > 0 ? (
              <span className="flex items-center gap-0.5 text-[11px] text-white/90">
                <StarIcon filled className="text-warn" />
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
                className="pointer-events-auto grid h-8 w-8 place-items-center rounded-full
                           bg-white/95 text-black transition-transform hover:scale-110
                           active:scale-95 disabled:scale-100"
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
                  <Spinner className="text-sm" />
                ) : (
                  <CheckIcon className="text-sm" />
                )}
              </button>
            )}
          </div>

          {/* Resume progress sits on the artwork's bottom edge. */}
          {showProgress && progress != null && progress > 0 && progress < 100 && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
              <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
            </div>
          )}
        </Artwork>
      </Link>

      <div className="mt-2 px-0.5">
        <Link
          to={`/item/${card.id}`}
          className="line-clamp-1 text-sm font-medium text-ink hover:text-accent"
        >
          {title}
        </Link>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          <span className="line-clamp-1">{subtitle ?? '—'}</span>
        </div>
        {episodeProgress != null && card.media_type === 'show' && (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.min(100, episodeProgress)}%` }}
              />
            </div>
            <span className="shrink-0 text-[10px] tabular-nums text-muted">
              {card.watched_episodes}/{card.total_episodes}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

export function PosterSkeleton() {
  return (
    <div>
      <div className="skeleton aspect-[2/3] w-full rounded-xl" />
      <div className="skeleton mt-2 h-3.5 w-3/4 rounded" />
      <div className="skeleton mt-1.5 h-3 w-1/3 rounded" />
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
      className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4
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
    <section className="animate-fade-up">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
        {action}
      </div>
      <div className="scroll-x scrollbar-none -mx-1 flex gap-4 px-1 pb-2">
        {(loading ? Array.from({ length: 8 }) : cards).map((card, index) => (
          <div key={loading ? index : (card as MediaCard).id} className="w-[140px] shrink-0 sm:w-[160px]">
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
