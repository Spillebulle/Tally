import type { MediaCard, WatchStatus } from './types'

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** "1h 47m" / "24m" — compact runtime for cards and detail headers. */
export function formatRuntime(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (!hours) return `${mins}m`
  return mins ? `${hours}h ${mins}m` : `${hours}h`
}

/** Long-form total for the stats page: "12 days, 4 hours". */
export function formatWatchTime(minutes: number): string {
  if (minutes <= 0) return '0 minutes'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days >= 1) {
    const dayPart = `${days} ${days === 1 ? 'day' : 'days'}`
    return hours ? `${dayPart}, ${hours} ${hours === 1 ? 'hour' : 'hours'}` : dayPart
  }
  const mins = minutes % 60
  if (hours) return `${hours} ${hours === 1 ? 'hour' : 'hours'}, ${mins}m`
  return `${mins} minutes`
}

export function compactNumber(value: number): string {
  if (Math.abs(value) >= 1000) {
    return new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
  }
  return value.toLocaleString()
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  const seconds = Math.round((then - Date.now()) / 1000)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, secondsInUnit] of units) {
    if (Math.abs(seconds) >= secondsInUnit) {
      return formatter.format(Math.round(seconds / secondsInUnit), unit)
    }
  }
  return formatter.format(seconds, 'second')
}

export const STATUS_LABELS: Record<WatchStatus, string> = {
  plan_to_watch: 'Plan to watch',
  watching: 'Watching',
  completed: 'Completed',
  on_hold: 'On hold',
  dropped: 'Dropped',
}

/**
 * Status uses shape + text, never colour alone — the dot is a redundant cue
 * beside a written label so it stays readable without colour vision.
 */
export const STATUS_DOT: Record<WatchStatus, string> = {
  plan_to_watch: 'bg-muted',
  watching: 'bg-accent',
  completed: 'bg-good',
  on_hold: 'bg-warn',
  dropped: 'bg-danger',
}

/**
 * Ratings are 0–10 everywhere: that is what Plex stores, what MyAnimeList uses,
 * and now what Tally shows. There is deliberately no conversion step — the old
 * five-star display meant every rating was divided on the way out and doubled on
 * the way back, and a value like 7 could only ever render as "3.5 stars".
 */
export const RATING_MAX = 10
export const RATING_SCALE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const

/** Trim the decimal when a rating is whole: "8" rather than "8.0". */
export const formatRating = (rating: number | null): string =>
  rating === null ? '—' : Number.isInteger(rating) ? String(rating) : rating.toFixed(1)

export function episodeCode(card: MediaCard): string | null {
  if (card.media_type !== 'episode') return null
  const season = card.season_number ?? 0
  const episode = card.episode_number ?? 0
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
}

export function displayTitle(card: MediaCard): string {
  if (card.media_type === 'episode' && card.show_title) return card.show_title
  return card.title
}

export function displaySubtitle(card: MediaCard): string | null {
  if (card.media_type === 'episode') {
    const code = episodeCode(card)
    return code ? `${code} · ${card.title}` : card.title
  }
  if (card.media_type === 'season') return card.show_title
  return card.year ? String(card.year) : null
}

/** Deterministic gradient for items with no poster, seeded by title. */
export function posterFallbackGradient(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i)
    hash |= 0
  }
  const hue = Math.abs(hash) % 360
  return `linear-gradient(150deg, hsl(${hue} 42% 32%), hsl(${(hue + 45) % 360} 38% 18%))`
}

export function initials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}
