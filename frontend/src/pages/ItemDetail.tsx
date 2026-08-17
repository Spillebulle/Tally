import { Fragment, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
  Heart,
  ListChecks,
  Sparkles,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useToast } from '@/lib/app-context'
import type { Credit, MediaCard, MediaDetail, UserState, WatchStatus } from '@/lib/types'
import { cn, formatDate, formatRuntime, relativeTime, STATUS_LABELS } from '@/lib/utils'
import { certificateLabel } from '@/lib/certificates'
import { Artwork, PosterRail } from '@/components/Poster'
import { RatingBadge } from '@/components/RatingBadge'
import { Select } from '@/components/Dropdown'
import {
  EmptyState,
  ErrorState,
  Panel,
  ProgressBar,
  Skeleton,
  Spinner,
  StarRating,
  StatusBadge,
} from '@/components/ui'

const STATUS_OPTIONS: WatchStatus[] = [
  'plan_to_watch',
  'watching',
  'completed',
  'on_hold',
  'dropped',
]

/**
 * Where a facet on this page takes you.
 *
 * `/browse`, not `/movies` or `/shows`, for the reason the genre links already
 * give: those force `anime: 'exclude'`, so an anime title's own facet would
 * lead to a grid guaranteed not to contain it. The query key is the one
 * `useBrowseFilters` reads, so the filter bar over there shows the same filter
 * as a removable chip and can widen or clear it.
 */
const facetLink = (key: string, value: string) =>
  `/browse?${key}=${encodeURIComponent(value)}`

/**
 * "returning series" → "Returning series".
 *
 * Not the `capitalize` utility, which capitalises *every* word and would print
 * "Returning Series" — Title Case, which §12 rules out everywhere but a proper
 * noun. Providers store this value lower-cased (`tmdb.py`, `tvdb.py`, `mal.py`
 * all `.lower()` it), so the first letter is the only one to fix.
 */
const sentenceCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

/**
 * The row the server inserts the first time you touch a title.
 *
 * `state` is null until a `UserMediaState` exists, so an optimistic write has
 * to stand one up rather than skip the update. Every field is the column
 * default in `models.py`.
 */
const EMPTY_STATE: UserState = {
  status: null,
  rating: null,
  view_count: 0,
  last_watched_at: null,
  progress_ms: null,
  duration_ms: null,
  is_favorite: false,
  notes: null,
}

export function ItemDetail() {
  const { id } = useParams<{ id: string }>()
  const itemId = Number(id)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const [openSeason, setOpenSeason] = useState<number | null>(null)
  // React Router keeps this component mounted across /item/:id changes, so
  // without resetting, navigating from one show to another opened the new one
  // with the previous show's season expanded — and an empty episode list when
  // that show has fewer seasons.
  const [seasonForItem, setSeasonForItem] = useState(itemId)
  if (seasonForItem !== itemId) {
    setSeasonForItem(itemId)
    setOpenSeason(null)
  }

  const {
    data: item,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['item', itemId],
    queryFn: () => api.media.detail(itemId),
    enabled: Number.isFinite(itemId),
  })

  // Fetched on first view rather than during a library scan — see
  // `services/credits.py`. Only films and series have them; an episode's
  // credits are the show's, and asking per episode is the cost that design
  // exists to avoid.
  const credits = useQuery({
    queryKey: ['credits', itemId],
    queryFn: () => api.media.credits(itemId),
    enabled: item?.media_type === 'movie' || item?.media_type === 'show',
  })

  const seasons = useQuery({
    queryKey: ['children', itemId],
    queryFn: () => api.media.children(itemId),
    enabled: item?.media_type === 'show',
  })

  const episodes = useQuery({
    queryKey: ['children', itemId, openSeason],
    queryFn: () => api.media.children(itemId, openSeason ?? undefined),
    enabled: item?.media_type === 'show' && openSeason !== null,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['item', itemId] })
    queryClient.invalidateQueries({ queryKey: ['children', itemId] })
    queryClient.invalidateQueries({ queryKey: ['media'] })
    queryClient.invalidateQueries({ queryKey: ['stats'] })
    queryClient.invalidateQueries({ queryKey: ['history'] })
    queryClient.invalidateQueries({ queryKey: ['continue-watching'] })
    // Marking something watched takes it out of every recommendation shelf.
    queryClient.invalidateQueries({ queryKey: ['recommendations'] })
  }

  const rate = useMutation({
    mutationFn: (rating: number | null) => api.media.setRating(itemId, rating),
    onSuccess: (_data, rating) => {
      notify(rating === null ? 'Rating cleared' : 'Rating saved and pushed to Plex', 'success')
      invalidate()
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const setStatus = useMutation({
    mutationFn: (status: WatchStatus | null) => api.media.setStatus(itemId, status),
    onSuccess: invalidate,
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const toggleFavorite = useMutation({
    mutationFn: (value: boolean) => api.media.setFavorite(itemId, value),
    // Fill the heart on click rather than on the round trip. It is one small
    // boolean and the button has no other pending affordance, so without this
    // the click looked like it had missed. Rolled back if the write fails.
    //
    // A title nobody has rated, watched or annotated has **no**
    // `UserMediaState` row and arrives with `state: null`, and favouriting is
    // the commonest way one gets created. Leaving null alone left exactly those
    // titles with no reaction at all — the case this exists for. So the write
    // synthesises the row the server is about to insert, which is the empty
    // state plus the flag just set.
    onMutate: async (value: boolean) => {
      await queryClient.cancelQueries({ queryKey: ['item', itemId] })
      const previous = queryClient.getQueryData<MediaDetail>(['item', itemId])
      queryClient.setQueryData<MediaDetail>(['item', itemId], (old) =>
        old
          ? {
              ...old,
              state: old.state
                ? { ...old.state, is_favorite: value }
                : { ...EMPTY_STATE, is_favorite: value },
            }
          : old,
      )
      return { previous }
    },
    onError: (error: Error, _value, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['item', itemId], context.previous)
      }
      notify(error.message, 'error')
    },
    onSettled: invalidate,
  })

  const markWatched = useMutation({
    mutationFn: (target: number) => api.history.markWatched(target),
    onSuccess: () => {
      notify('Marked as watched', 'success')
      invalidate()
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const markUnwatched = useMutation({
    mutationFn: (target: number) => api.history.markUnwatched(target),
    onSuccess: () => {
      notify('Cleared watch history for this item', 'info')
      invalidate()
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const markSeason = useMutation({
    mutationFn: (season: number) => api.history.markSeasonWatched(itemId, season),
    onSuccess: (result) => {
      notify(`Marked ${result.marked} episodes as watched`, 'success')
      invalidate()
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const watchlist = useMutation({
    mutationFn: async (add: boolean) => {
      if (add) await api.watchlist.add(itemId)
      else await api.watchlist.remove(itemId)
    },
    onSuccess: (_data, add) => {
      notify(add ? 'Added to your Plex watchlist' : 'Removed from your watchlist', 'success')
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['watchlist'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  if (isLoading) {
    return (
      <div className="-mt-strip">
        {/* Same geometry as the hero it stands in for, so the page does not
            jump sideways or shorten when the item arrives. */}
        <Skeleton className="full-bleed h-[140px] rounded-none sm:h-[170px] lg:h-[200px]" />
        <div className="relative -mt-16 flex gap-strip sm:-mt-24 sm:gap-4">
          <Skeleton className="aspect-[2/3] w-[120px] shrink-0 rounded-card sm:w-[160px]" />
          <div className="min-w-0 flex-1 space-y-2 pt-5 sm:pt-12">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-button w-40" />
          </div>
        </div>
      </div>
    )
  }

  // A failed request is not a missing title: a 500 used to render as "that
  // item could not be found", which sends the user looking for a title that is
  // sitting right there.
  if (isError) {
    return (
      <div className="card">
        <ErrorState error={error} onRetry={() => refetch()} title="Could not load this title" />
      </div>
    )
  }

  if (!item) {
    return (
      <div className="card">
        <EmptyState
          title="That title is not here"
          description="It may have been removed from your library. Go back and pick another one."
          action={
            <button type="button" onClick={() => navigate(-1)} className="btn-secondary">
              <ChevronLeft size={16} aria-hidden="true" />
              Go back
            </button>
          }
        />
      </div>
    )
  }

  const watched = (item.state?.view_count ?? 0) > 0
  const watchPending = markWatched.isPending || markUnwatched.isPending
  const progressPercent =
    item.state?.progress_ms && item.state.duration_ms
      ? Math.round((item.state.progress_ms / item.state.duration_ms) * 100)
      : null
  const episodeProgress =
    item.watched_episodes != null && item.total_episodes
      ? Math.round((item.watched_episodes / item.total_episodes) * 100)
      : null

  const directors = credits.data?.directors ?? []

  /**
   * Whether there is a *list* to put in the wide column: the seasons, or the
   * cast. Those are the only two panels tall enough to stand beside the record
   * column, which runs to roughly 360px.
   *
   * `CastPanel` renders nothing at all when there are no credits and none are
   * pending, and TMDB credits need an API key most installs do not have. So on
   * the common install a film's wide column was one short Overview panel over
   * about 285px of void, and an episode's — no cast, no seasons, often no
   * overview either — was 380px of nothing. Overview alone does not earn a
   * column: it is one paragraph, and it reads better full width with the record
   * panels spread in a row beneath it. The grid is what has to know, so the
   * question is asked out here rather than inside each panel.
   */
  const hasCredits = credits.isLoading || credits.isError || (credits.data?.cast.length ?? 0) > 0
  const hasWideColumn = item.media_type === 'show' || (item.media_type === 'movie' && hasCredits)

  // "Elsewhere" draws nothing without an external id, so the row of record
  // panels is two wide or three. Told to make three columns for two panels, the
  // grid would leave the last one empty.
  const recordPanels =
    item.tmdb_id || item.tvdb_id || item.imdb_id || item.mal_id ? 3 : 2

  const overviewPanel = item.overview ? (
    <Panel title="Overview">
      <p className="max-w-[65ch] text-balance text-body text-fg">{item.overview}</p>
    </Panel>
  ) : null

  // `to` turns a fact into a way into the library: certificate, studio and
  // director are all things a whole shelf shares, and each lands on a browse
  // view already filtered to it. `figure` marks the values that are read as
  // numbers: every date, duration and count is monospaced (§4).
  const facts: Fact[] = [
    item.first_aired && {
      term: 'Released',
      values: [{ label: formatDate(item.first_aired) }],
      figure: true,
    },
    formatRuntime(item.runtime_minutes) && {
      term: 'Runtime',
      values: [{ label: formatRuntime(item.runtime_minutes)! }],
      figure: true,
    },
    item.content_rating && {
      term: 'Rated',
      // Written the way the board writes it; the *link* still carries the raw
      // value, which is the only thing `?content_rating=` matches.
      values: [
        {
          label: certificateLabel(item.content_rating),
          to: facetLink('content_rating', item.content_rating),
        },
      ],
      mark: item.content_rating,
    },
    directors.length > 0 && {
      // One key, every name under it. Emitted as one pair per director with
      // the second key left blank, the list came apart at the width where it
      // runs two pairs to a line: the blank key sat beside an unrelated value
      // and the second director appeared under the key before it.
      term: directors.length > 1 ? 'Directors' : 'Director',
      values: directors.map((person) => ({
        label: person.name,
        to: facetLink('director', person.name),
      })),
    },
    item.studio && {
      term: 'Studio',
      values: [{ label: item.studio, to: facetLink('studio', item.studio) }],
    },
    item.network && { term: 'Network', values: [{ label: item.network }] },
    // "Release", not "Status": the record panel a column away has a Status row
    // of its own, and the two mean different things — whether the title is
    // finished, and whether you have watched it.
    item.release_status && {
      term: 'Release',
      values: [{ label: sentenceCase(item.release_status) }],
    },
    item.anime_format && { term: 'Format', values: [{ label: item.anime_format }] },
  ].filter(Boolean) as Fact[]

  return (
    <div className="-mt-strip">
      {/* The detail hero (§10): a backdrop band, the picture flush at the left,
          the title, the facts as a two-column key/value list, one primary
          button. */}
      <Artwork
        src={item.backdrop_url}
        title={item.title}
        showTitle={false}
        imgClassName="object-top"
        className="full-bleed h-[140px] sm:h-[170px] lg:h-[200px]"
      >
        {/* Scrim so what follows stays readable over any artwork, eased out
            over the band's whole height so the artwork does not stop at a
            line. See `.hero-scrim`. The badges and the title sit in its lower
            reaches, which is what all those stops are for; the band was 240px
            of pure decoration while everything began at its bottom edge. */}
        <div className="hero-scrim absolute inset-0" />

        {/* A mark over user content, so it takes a derived ink (white on a dark
            scrim) rather than a theme token (§2.6). */}
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="absolute left-strip top-strip inline-flex h-button items-center gap-1.5
                     rounded-ctl bg-black/50 px-2.5 text-control text-white
                     transition-colors duration-hover ease-ease hover:bg-black/70"
        >
          <ChevronLeft size={16} aria-hidden="true" />
          Back
        </button>
      </Artwork>

      <div className="relative -mt-16 flex gap-strip sm:-mt-24 sm:gap-4">
        <div className="w-[120px] shrink-0 sm:w-[160px]">
          {/* The placeholder is a layer *underneath* the artwork rather than an
              else-branch: whether a poster exists is only known once the proxy
              answers, and a 404 simply reveals what is already drawn. */}
          <Artwork
            src={item.poster_url}
            title={item.title}
            showTitle={false}
            className="aspect-[2/3] rounded-card border border-line"
          />
        </div>

        {/* The padding is the pull-up less the height of the badge row and the
            title, so those two land inside the band and the title's baseline
            sits just above its bottom edge, where the scrim is solid. */}
        <div className="min-w-0 flex-1 pt-5 sm:pt-12">
          <div className="flex flex-wrap items-center gap-1.5">
            {item.is_anime && (
              <span className="badge gap-1">
                <Sparkles size={11} aria-hidden="true" />
                Anime
              </span>
            )}
            {item.is_personal_media && <span className="badge">Home video</span>}
            <StatusBadge status={item.state?.status ?? null} />
            {!item.available_on_plex && (
              <span
                className="badge"
                title="No file for this title on any Plex server you can reach."
              >
                Not on your server
              </span>
            )}
          </div>

          <h1 className="mt-1.5 text-balance text-page font-semibold text-strong">{item.title}</h1>

          {item.media_type === 'episode' && item.show_title && (
            <Link
              to={`/item/${item.show_id}`}
              className="mt-0.5 inline-flex items-center gap-1.5 text-control text-muted
                         transition-colors duration-hover ease-ease hover:text-strong"
            >
              {item.show_title}
              <span className="figure text-tiny">
                S{item.season_number}E{item.episode_number}
              </span>
            </Link>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted">
            {item.year && <span className="figure">{item.year}</span>}
            {formatRuntime(item.runtime_minutes) && (
              <>
                <span aria-hidden="true">·</span>
                <span className="figure">{formatRuntime(item.runtime_minutes)}</span>
              </>
            )}
            {item.community_rating != null && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  <span className="figure">{item.community_rating.toFixed(1)}</span> community
                </span>
              </>
            )}
          </div>

          {item.tagline && (
            <p className="mt-1.5 max-w-[65ch] text-balance text-body italic text-dim">
              {item.tagline}
            </p>
          )}

          {item.genres.length > 0 && (
            /* Buttons (§7.6), not chips. Each one opens a filtered grid, and
               `.chip` says of itself in index.css that a chip is a read-only
               figure which never opens anything, so a genre wearing one teaches
               the wrong thing about every other chip in the app. `btn-outline`
               is the quiet control, and `px-2` matches the identical row of
               genre links on the dashboard rather than the button scale's 12px,
               so the same thing is the same size on both pages. The hover
               belongs to the class now instead of being repainted here. */
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.genres.slice(0, 8).map((genre) => (
                <Link
                  key={genre}
                  // /browse, not /movies or /shows: those force
                  // `anime: 'exclude'`, so an anime title's own genre link led
                  // to a grid guaranteed not to contain it.
                  to={`/browse?genre=${encodeURIComponent(genre)}`}
                  className="btn-outline px-2"
                >
                  {genre}
                </Link>
              ))}
            </div>
          )}

          {/* The one primary button on this view is the play: recording what
              you watched is what the app is for. A show has no single play to
              record, so it draws no primary at all rather than promoting a
              lesser action into the slot. */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {item.media_type !== 'show' && (
              <button
                type="button"
                onClick={() =>
                  watched ? markUnwatched.mutate(item.id) : markWatched.mutate(item.id)
                }
                disabled={watchPending}
                className={cn(watched ? 'btn-secondary' : 'btn-primary')}
                title={
                  watched
                    ? 'Clear every recorded play of this title.'
                    : 'Record a play now and scrobble it to Plex.'
                }
              >
                {watchPending ? (
                  <Spinner />
                ) : watched ? (
                  <X size={16} aria-hidden="true" />
                ) : (
                  <Check size={16} aria-hidden="true" />
                )}
                {watched ? 'Mark unwatched' : 'Mark watched'}
              </button>
            )}

            <button
              type="button"
              onClick={() => watchlist.mutate(!item.on_watchlist)}
              disabled={watchlist.isPending}
              className="btn-secondary"
              title={
                watchlist.isPending
                  ? 'Your Plex watchlist is being updated. Wait for it to finish.'
                  : item.on_watchlist
                    ? 'Remove this title from your Plex watchlist.'
                    : 'Add this title to your Plex watchlist.'
              }
            >
              {/* Adding writes through to the Plex watchlist, so this is a real
                  round trip and needs to say so. */}
              {watchlist.isPending ? (
                <Spinner />
              ) : (
                <Bookmark
                  size={16}
                  fill={item.on_watchlist ? 'currentColor' : 'none'}
                  aria-hidden="true"
                />
              )}
              {item.on_watchlist ? 'On watchlist' : 'Add to watchlist'}
            </button>

            <button
              type="button"
              onClick={() => toggleFavorite.mutate(!item.state?.is_favorite)}
              className="btn-icon"
              title={item.state?.is_favorite ? 'Remove from favourites' : 'Add to favourites'}
              aria-label={item.state?.is_favorite ? 'Remove from favourites' : 'Add to favourites'}
              aria-pressed={Boolean(item.state?.is_favorite)}
            >
              <Heart
                size={16}
                fill={item.state?.is_favorite ? 'currentColor' : 'none'}
                className={item.state?.is_favorite ? 'text-strong' : undefined}
                aria-hidden="true"
              />
            </button>
          </div>

          {(progressPercent != null || episodeProgress != null) && (
            <ProgressBar
              className="mt-3 max-w-md"
              fraction={(episodeProgress ?? progressPercent ?? 0) / 100}
              label={
                episodeProgress != null ? (
                  <span className="figure">
                    {item.watched_episodes}/{item.total_episodes} episodes
                  </span>
                ) : (
                  <span className="figure">{progressPercent}%</span>
                )
              }
            />
          )}

          {facts.length > 0 && (
            <dl
              className="mt-4 grid max-w-[560px] grid-cols-[auto_1fr] items-baseline gap-x-3
                         gap-y-1 sm:grid-cols-[auto_1fr_auto_1fr] sm:gap-x-4"
            >
              {facts.map((fact) => (
                <Fragment key={fact.term}>
                  <dt className="text-tiny text-dim">{fact.term}</dt>
                  <dd
                    className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-control
                               text-fg"
                  >
                    {fact.mark && (
                      <RatingBadge
                        raw={fact.mark}
                        label={fact.values[0]?.label ?? ''}
                        // The label is printed next to it, so an unrecognised
                        // certificate draws nothing here rather than boxing the
                        // same word twice.
                        fallback="none"
                      />
                    )}
                    {fact.values.map((value, index) => (
                      <Fragment key={value.label}>
                        {/* The same separator the year/runtime line above uses,
                            so two values under one key read as one fact. */}
                        {index > 0 && <span aria-hidden="true" className="text-dim">·</span>}
                        {value.to ? (
                          // Underlined at rest, not on hover: touch has no
                          // hover, so a hover-only cue leaves half the users
                          // with no way of knowing this goes anywhere.
                          <Link
                            to={value.to}
                            className={cn(
                              'truncate underline decoration-line decoration-dotted',
                              'underline-offset-4 transition-colors duration-hover ease-ease',
                              'hover:text-strong',
                              fact.figure && 'figure',
                            )}
                          >
                            {value.label}
                          </Link>
                        ) : (
                          <span className={cn('truncate', fact.figure && 'figure')}>
                            {value.label}
                          </span>
                        )}
                      </Fragment>
                    ))}
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
        </div>
      </div>

      <div className={cn('mt-4 grid gap-3', hasWideColumn && 'lg:grid-cols-[1fr_264px]')}>
        {/* Collapsed, the overview is the grid's own first row and the record
            panels its second, so the two are one gap apart rather than two. */}
        {!hasWideColumn && overviewPanel}

        {/* `min-w-0`, or a wide child cannot scroll inside its own box. A grid
            track sizes to its content by default (`min-width: auto`), so the
            child's full intrinsic width pushed this column — and the whole
            page — wider than the viewport instead of scrolling. */}
        {hasWideColumn && (
        <div className="min-w-0 space-y-3">
          {overviewPanel}

          {item.media_type === 'show' && (
            <SeasonsPanel
              seasons={seasons.data ?? []}
              loading={seasons.isLoading}
              isError={seasons.isError}
              error={seasons.error}
              onRetry={() => void seasons.refetch()}
              openSeason={openSeason}
              onOpenSeason={setOpenSeason}
              episodes={episodes.data ?? []}
              episodesLoading={episodes.isLoading}
              episodesError={episodes.isError}
              episodesErrorValue={episodes.error}
              onRetryEpisodes={() => void episodes.refetch()}
              onMarkSeason={(season) => markSeason.mutate(season)}
              markSeasonPending={markSeason.isPending ? markSeason.variables ?? null : null}
              onToggleEpisode={(target, isWatched) =>
                isWatched ? markUnwatched.mutate(target) : markWatched.mutate(target)
              }
              pendingEpisode={
                markWatched.isPending
                  ? markWatched.variables ?? null
                  : markUnwatched.isPending
                    ? markUnwatched.variables ?? null
                    : null
              }
            />
          )}

          {(item.media_type === 'movie' || item.media_type === 'show') && (
            <CastPanel
              cast={credits.data?.cast ?? []}
              loading={credits.isLoading}
              isError={credits.isError}
              error={credits.error}
              onRetry={() => void credits.refetch()}
            />
          )}
        </div>
        )}

        {/* With no list to stand beside them, the record panels spread across
            the width instead of holding a 264px column against an empty half
            page. `items-start` so a short panel does not stretch to the height
            of the tallest one. */}
        <aside
          className={cn(
            hasWideColumn
              ? 'space-y-3'
              : 'grid items-start gap-3 sm:grid-cols-2',
            !hasWideColumn && recordPanels === 3 && 'lg:grid-cols-3',
          )}
        >
          <Panel title="Your record">
            <div className="space-y-0.5">
              {/* Label-left like the three rows under it. At `md` the ten
                  stars, the figure and Clear came to about 280px against a
                  240px body and `.panel` clipped the overflow; `sm` is 12px a
                  star, which brings the whole row to about 235px and fits.
                  Stacking it broke the panel's row rhythm to solve a problem
                  the size prop already solves. */}
              <div className="flex min-h-row items-center justify-between gap-2">
                <span className="text-control text-fg">Rating</span>
                <StarRating
                  size="sm"
                  rating={item.state?.rating ?? null}
                  onChange={(rating) => rate.mutate(rating)}
                />
              </div>
              <div className="flex min-h-row items-center justify-between gap-3">
                <span className="text-control text-fg">Status</span>
                {/* The same dropdown the browse filters use, so a picker looks
                    and behaves the same wherever it is met. */}
                <Select
                  label="Status"
                  value={item.state?.status ?? ''}
                  onChange={(next) => setStatus.mutate((next || null) as WatchStatus | null)}
                  options={[
                    { value: '', label: 'Not set' },
                    ...STATUS_OPTIONS.map((status) => ({
                      value: status,
                      label: STATUS_LABELS[status],
                    })),
                  ]}
                />
              </div>
              <div className="flex min-h-row items-center justify-between gap-3">
                <span className="text-control text-fg">Plays</span>
                <span className="figure text-tiny text-dim">{item.state?.view_count ?? 0}</span>
              </div>
              <div className="flex min-h-row items-center justify-between gap-3">
                <span className="text-control text-fg">Last watched</span>
                <span className="figure text-tiny text-dim">
                  {relativeTime(item.state?.last_watched_at)}
                </span>
              </div>
            </div>
          </Panel>

          <NotesPanel itemId={item.id} notes={item.state?.notes ?? null} />

          <ExternalLinks
            tmdbId={item.tmdb_id}
            tvdbId={item.tvdb_id}
            imdbId={item.imdb_id}
            malId={item.mal_id}
            isShow={item.media_type === 'show'}
          />
        </aside>
      </div>

      {(item.media_type === 'movie' || item.media_type === 'show') && (
        <Recommendations itemId={item.id} />
      )}
    </div>
  )
}

/**
 * Unwatched titles that share the most genres with this one.
 *
 * Its own component so the shelf owns its request, and so the three states a
 * request has — loading, failed, genuinely nothing — stay visible next to each
 * other. An empty strip under a heading reads as broken; a failed request that
 * falls through to the empty branch reads as "you have watched everything".
 */
function Recommendations({ itemId }: { itemId: number }) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['recommendations', itemId],
    queryFn: () => api.media.recommendations(itemId),
  })

  if (isError) {
    return (
      <Panel title="More like this" className="mt-3">
        <ErrorState
          error={error}
          onRetry={() => refetch()}
          title="Could not load recommendations"
        />
      </Panel>
    )
  }

  if (!isLoading && (data?.length ?? 0) === 0) {
    return (
      <Panel title="More like this" className="mt-3">
        <p className="text-body text-dim">
          Nothing unwatched shares enough genres with this one yet.
        </p>
      </Panel>
    )
  }

  return (
    <div className="mt-4">
      <PosterRail title="More like this" cards={data ?? []} loading={isLoading} />
    </div>
  )
}

/** One value inside a fact. `to` makes it a way into the library. */
interface FactValue {
  label: string
  to?: string
}

/**
 * One pair in the hero's key/value list.
 *
 * `values` is a list rather than a string because a fact can hold more than one
 * — two directors — and every one of them has to stay inside the same `<dd>`.
 * The list is a grid that runs two pairs to a line on a wide screen, so a
 * second value emitted as its own pair with an empty key does not sit under the
 * key it belongs to; it lands beside whatever pair shares that line.
 */
interface Fact {
  term: string
  values: FactValue[]
  /** A value read as a number: a date, a duration, a count. Drawn monospaced. */
  figure?: boolean
  /**
   * A raw certificate to draw the board's mark for, beside the value.
   *
   * The raw string rather than the label, because which mark stands for a
   * certificate is decided by the board that issued it, and only the raw value
   * names that. The label stays printed beside it — the mark is recognised at a
   * glance but not always read at 20px, and the row has room for both.
   */
  mark?: string
}

/**
 * The cast, as rows (§7.16): a 20px portrait, the name, the part at the right.
 *
 * A list rather than the poster strip it used to be. The strip spent a whole
 * poster's height on each face and hid the rest behind a horizontal scroll;
 * a dozen rows fit in less space and read top to bottom like the rest of the
 * page.
 */
function CastPanel({
  cast,
  loading,
  isError,
  error,
  onRetry,
}: {
  cast: Credit[]
  loading: boolean
  isError: boolean
  error: unknown
  onRetry: () => void
}) {
  // A failed request is not an empty cast — checked before the empty branch, or
  // a 500 would render as "this film has nobody in it".
  if (isError) {
    return (
      <Panel title="Cast">
        <ErrorState error={error} onRetry={onRetry} title="Could not load the cast" />
      </Panel>
    )
  }

  // Nothing to show and nothing pending: TMDB had no credits for this title, or
  // no TMDB key is configured. Neither is worth a panel over an empty list.
  if (!loading && cast.length === 0) return null

  return (
    <Panel title="Cast" count={loading ? undefined : cast.length} bodyClassName="p-0">
      {loading ? (
        <ul className="p-strip">
          {Array.from({ length: 6 }, (_, index) => (
            <li key={index} className="flex h-row items-center gap-2">
              <Skeleton className="h-5 w-5 rounded-full" />
              <Skeleton className="h-2.5 w-40" />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="max-h-[286px] overflow-y-auto">
          {cast.map((person) => (
            <li
              key={person.person_id}
              className="flex h-row items-center gap-2 border-b border-line-soft px-strip
                         last:border-b-0"
            >
              <Artwork
                src={person.profile_url}
                title={person.name}
                showTitle={false}
                imgClassName="object-top"
                className="h-5 w-5 shrink-0 rounded-full"
              />
              <span className="min-w-0 flex-1 truncate text-control text-fg">{person.name}</span>
              {person.character && (
                <span className="min-w-0 max-w-[45%] truncate text-tiny text-dim">
                  {person.character}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/**
 * The seasons, and the episodes of whichever one is open.
 *
 * One season is open at a time and its episodes are their own request, so a
 * show with forty seasons does not fetch every episode just to draw the list
 * of headings.
 */
function SeasonsPanel({
  seasons,
  loading,
  isError,
  error,
  onRetry,
  openSeason,
  onOpenSeason,
  episodes,
  episodesLoading,
  episodesError,
  episodesErrorValue,
  onRetryEpisodes,
  onMarkSeason,
  markSeasonPending,
  onToggleEpisode,
  pendingEpisode,
}: {
  seasons: MediaCard[]
  loading: boolean
  isError: boolean
  error: unknown
  onRetry: () => void
  openSeason: number | null
  onOpenSeason: (season: number | null) => void
  episodes: MediaCard[]
  episodesLoading: boolean
  episodesError: boolean
  episodesErrorValue: unknown
  onRetryEpisodes: () => void
  onMarkSeason: (season: number) => void
  /** The season whose "mark all watched" is in flight, if any. */
  markSeasonPending: number | null
  onToggleEpisode: (id: number, watched: boolean) => void
  /** The episode whose own write is in flight, if any. */
  pendingEpisode: number | null
}) {
  if (isError) {
    return (
      <Panel title="Seasons">
        <ErrorState error={error} onRetry={onRetry} title="Could not load the seasons" />
      </Panel>
    )
  }

  return (
    <Panel title="Seasons" count={loading ? undefined : seasons.length} bodyClassName="p-0">
      {loading ? (
        <div className="space-y-1 p-strip">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-row w-full" />
          ))}
        </div>
      ) : seasons.length === 0 ? (
        <EmptyState
          icon={<ListChecks size={24} aria-hidden="true" />}
          title="No seasons yet"
          description="Nothing has been imported for this show. Run a library scan from Settings."
        />
      ) : (
        <ul>
          {seasons.map((season) => {
            const number = season.season_number ?? 0
            const isOpen = openSeason === number
            const done =
              season.watched_episodes != null &&
              season.total_episodes != null &&
              season.total_episodes > 0 &&
              season.watched_episodes >= season.total_episodes
            return (
              <li
                key={`${season.id}-${number}`}
                className="border-b border-line-soft last:border-b-0"
              >
                {/* Open is a selection, so it is a neutral `control` fill and
                    strong text, never an accent wash (§2.4). */}
                <div
                  className={cn(
                    'flex h-row items-center gap-2 px-strip transition-colors duration-hover',
                    'ease-ease',
                    isOpen ? 'bg-control' : 'hover:bg-control-hover',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onOpenSeason(isOpen ? null : number)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={isOpen}
                  >
                    <ChevronDown
                      size={16}
                      aria-hidden="true"
                      className={cn(
                        'shrink-0 transition-transform duration-hover ease-ease',
                        isOpen ? 'text-strong' : '-rotate-90 text-muted',
                      )}
                    />
                    <span className={cn('truncate text-control', isOpen ? 'text-strong' : 'text-fg')}>
                      {number === 0 ? (
                        'Specials'
                      ) : (
                        <>
                          Season <span className="figure">{number}</span>
                        </>
                      )}
                    </span>
                    {done && (
                      <Check size={16} className="shrink-0 text-good" aria-label="Fully watched" />
                    )}
                  </button>
                  {season.total_episodes != null && (
                    <span className="figure shrink-0 text-tiny text-dim">
                      {season.watched_episodes ?? 0}/{season.total_episodes}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => onMarkSeason(number)}
                    disabled={markSeasonPending != null}
                    className="btn-icon h-5 w-5 shrink-0"
                    title={
                      markSeasonPending != null
                        ? 'A season is already being marked. Wait for it to finish.'
                        : 'Mark every episode in this season as watched'
                    }
                    aria-label={`Mark every episode in season ${number} as watched`}
                  >
                    {markSeasonPending === number ? (
                      <Spinner className="text-tiny" />
                    ) : (
                      <ListChecks size={16} aria-hidden="true" />
                    )}
                  </button>
                </div>

                {isOpen && (
                  <div className="well m-strip mt-0">
                    {episodesError ? (
                      <ErrorState
                        error={episodesErrorValue}
                        onRetry={onRetryEpisodes}
                        title="Could not load the episodes"
                      />
                    ) : episodesLoading ? (
                      <div className="space-y-1 p-2">
                        {Array.from({ length: 4 }, (_, index) => (
                          <Skeleton key={index} className="h-row-plain w-full" />
                        ))}
                      </div>
                    ) : (
                      <ul>
                        {episodes.map((episode) => (
                          <EpisodeRow
                            key={episode.id}
                            episode={episode}
                            onToggle={onToggleEpisode}
                            pending={pendingEpisode === episode.id}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

function EpisodeRow({
  episode,
  onToggle,
  pending = false,
}: {
  episode: MediaCard
  onToggle: (id: number, watched: boolean) => void
  /** True while this row's own request is in flight. */
  pending?: boolean
}) {
  const watched = episode.status === 'completed'
  return (
    <li className="flex h-row items-center gap-2 border-b border-line-soft px-2 last:border-b-0">
      <button
        type="button"
        onClick={() => onToggle(episode.id, watched)}
        // The tick is derived from `episode.status`, which only changes after
        // the write *and* a refetch. With no pending state the box sat
        // unchanged for a second, so people clicked again — logging a
        // duplicate play. Every other write on this page already showed one.
        disabled={pending}
        className={cn(
          'grid h-4 w-4 shrink-0 place-items-center rounded-tight border',
          'transition-colors duration-hover ease-ease',
          watched
            ? 'border-accent bg-accent text-accent-ink'
            // Unchecked is a `line` edge on `field` (§7.12). The hover was an
            // accent edge, which is not on §2.4's list: an empty box is not
            // selected, in hand or primary. Dashed is the house hover for an
            // outlined control (§7.6).
            : 'border-line bg-field text-transparent hover:border-line-dashed',
          pending && 'opacity-45',
        )}
        title={watched ? 'Mark unwatched' : 'Mark watched'}
        aria-label={watched ? `Mark ${episode.title} unwatched` : `Mark ${episode.title} watched`}
        aria-pressed={watched}
        aria-busy={pending}
      >
        {pending ? (
          <Spinner className="text-tiny text-muted" />
        ) : (
          <Check size={12} strokeWidth={3} aria-hidden="true" />
        )}
      </button>
      <span className="figure w-7 shrink-0 text-tiny text-dim">
        E{String(episode.episode_number ?? 0).padStart(2, '0')}
      </span>
      <Link
        to={`/item/${episode.id}`}
        className={cn(
          'min-w-0 flex-1 truncate text-control transition-colors duration-hover ease-ease',
          watched ? 'text-muted hover:text-fg' : 'text-fg hover:text-strong',
        )}
      >
        {episode.title}
      </Link>
      {episode.progress_percent != null &&
        episode.progress_percent > 0 &&
        episode.progress_percent < 100 && (
          <span className="figure shrink-0 text-tiny text-dim">
            {Math.round(episode.progress_percent)}%
          </span>
        )}
    </li>
  )
}

/**
 * A private note on a title.
 *
 * Saved on a button rather than as you type. The write pushes nothing to Plex,
 * but it is still a round trip, and a field that saves on every keystroke has
 * no honest moment at which to say "saved". The button is disabled while the
 * text is unchanged, and says why.
 */
function NotesPanel({ itemId, notes }: { itemId: number; notes: string | null }) {
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const stored = notes ?? ''
  const [draft, setDraft] = useState(stored)
  // The saved note arrives with the item and can change underneath us: a
  // refetch after a save, or a different title on this same mounted component.
  // Follow it, the way the season list follows the id.
  const [seeded, setSeeded] = useState(stored)
  if (seeded !== stored) {
    setSeeded(stored)
    setDraft(stored)
  }

  const save = useMutation({
    mutationFn: (value: string) =>
      api.media.setNotes(itemId, value.trim() === '' ? null : value.trim()),
    onSuccess: (_data, value) => {
      notify(value.trim() === '' ? 'Note cleared' : 'Note saved', 'success')
      queryClient.invalidateQueries({ queryKey: ['item', itemId] })
      // `has_notes` is a browse filter, so any grid narrowed by it is now out
      // of date.
      queryClient.invalidateQueries({ queryKey: ['media'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const dirty = draft !== stored

  return (
    <Panel title="Notes">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={4}
        placeholder="Only you can see this."
        aria-label="Your note on this title"
        className="field h-auto resize-y py-1.5 leading-normal"
      />
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => save.mutate(draft)}
          disabled={!dirty || save.isPending}
          className="btn-secondary"
          title={dirty ? 'Save this note.' : 'The note is unchanged, so there is nothing to save.'}
        >
          {save.isPending && <Spinner />}
          Save note
        </button>
      </div>
    </Panel>
  )
}

function ExternalLinks({
  tmdbId,
  tvdbId,
  imdbId,
  malId,
  isShow,
}: {
  tmdbId: number | null
  tvdbId: number | null
  imdbId: string | null
  malId: number | null
  isShow: boolean
}) {
  const links = [
    tmdbId && {
      label: 'TMDB',
      href: `https://www.themoviedb.org/${isShow ? 'tv' : 'movie'}/${tmdbId}`,
    },
    imdbId && { label: 'IMDb', href: `https://www.imdb.com/title/${imdbId}/` },
    tvdbId && { label: 'TheTVDB', href: `https://thetvdb.com/dereferrer/series/${tvdbId}` },
    malId && { label: 'MyAnimeList', href: `https://myanimelist.net/anime/${malId}` },
  ].filter(Boolean) as Array<{ label: string; href: string }>

  if (links.length === 0) return null

  return (
    <Panel title="Elsewhere" bodyClassName="p-0">
      <ul>
        {links.map((link) => (
          <li key={link.label} className="border-b border-line-soft last:border-b-0">
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer noopener"
              className="flex h-row items-center gap-2 px-strip text-control text-fg
                         transition-colors duration-hover ease-ease hover:bg-control-hover
                         hover:text-strong"
            >
              <span className="min-w-0 flex-1 truncate">{link.label}</span>
              <ExternalLink size={16} className="shrink-0 text-muted" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
