import type { ReactNode } from 'react'
import { cn, formatRating, RATING_SCALE, STATUS_DOT, STATUS_LABELS } from '@/lib/utils'
import type { WatchStatus } from '@/lib/types'
import { StarIcon, WarningIcon } from './Icons'

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string
  description?: string
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="card flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && (
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-raised text-xl text-muted">
          {icon}
        </span>
      )}
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {description && (
        <p className="max-w-sm text-balance text-sm text-muted">{description}</p>
      )}
      {action}
    </div>
  )
}

/**
 * A request that failed, said so.
 *
 * Distinct from `EmptyState` on purpose. Every list page used to fall through
 * to "Nothing here yet — run a Plex sync from Settings" whenever a request
 * errored, which confidently tells the user their library is empty and hides
 * the real problem. A 500 and an empty library need different reactions.
 */
export function ErrorState({
  error,
  onRetry,
  title = 'Could not load this',
}: {
  error: unknown
  onRetry?: () => void
  title?: string
}) {
  const message =
    error instanceof Error && error.message ? error.message : 'Something went wrong.'
  return (
    <div className="card flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-danger/10 text-xl text-danger">
        <WarningIcon />
      </span>
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      <p className="max-w-sm text-balance text-sm text-muted">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-outline mt-2">
          Try again
        </button>
      )}
    </div>
  )
}

export function StatusBadge({ status }: { status: WatchStatus | null }) {
  if (!status) return null
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface
                 px-2.5 py-1 text-xs font-medium text-subtle"
    >
      {/* Dot is redundant with the text label, never the only cue. */}
      <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[status])} aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  )
}

interface StarRatingProps {
  rating: number | null
  onChange?: (rating: number | null) => void
  size?: 'sm' | 'md' | 'lg'
  readOnly?: boolean
}

/**
 * Ten stars, one per point, matching Plex's underlying 0–10 scale directly.
 *
 * Previously this was five stars at half-star granularity over the same range,
 * which needed two hit zones per star and made "7" unrepresentable as anything
 * but three and a half stars. One star per point removes the translation
 * entirely. Clicking the current value again clears the rating.
 */
export function StarRating({ rating, onChange, size = 'md', readOnly }: StarRatingProps) {
  const score = rating ?? 0
  const sizes = { sm: 'text-xs', md: 'text-sm', lg: 'text-lg' }
  const interactive = !readOnly && Boolean(onChange)

  return (
    <div
      className={cn('flex items-center gap-0.5', sizes[size])}
      role={interactive ? 'radiogroup' : undefined}
      aria-label={interactive ? 'Your rating out of 10' : undefined}
    >
      {RATING_SCALE.map((position) => {
        const filled = score >= position

        if (!interactive) {
          return (
            <StarIcon
              key={position}
              filled={filled}
              className={filled ? 'text-warn' : 'text-line'}
            />
          )
        }

        return (
          <button
            key={position}
            type="button"
            role="radio"
            aria-checked={score === position}
            aria-label={`${position} out of 10`}
            title={`${position} / 10`}
            onClick={() => onChange?.(score === position ? null : position)}
            className="inline-flex"
          >
            <StarIcon
              filled={filled}
              className={cn(
                'transition-all duration-150 ease-spring hover:scale-110',
                filled ? 'text-warn' : 'text-line hover:text-warn/50',
              )}
            />
          </button>
        )
      })}
      {/* The number is not decoration: ten stars are hard to count at a glance. */}
      {rating != null && (
        <span className="ml-1.5 text-xs font-medium tabular-nums text-muted">
          {formatRating(rating)}
        </span>
      )}
      {interactive && rating != null && (
        <button
          type="button"
          onClick={() => onChange?.(null)}
          className="ml-2 text-xs text-muted hover:text-danger"
        >
          Clear
        </button>
      )}
    </div>
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  label?: string
}) {
  return (
    // radiogroup, not tablist: these pick a filter, they do not switch between
    // panels. `role="tab"` promises `aria-controls` and arrow-key navigation
    // with a roving tabindex, none of which was here — so the markup described
    // a widget that did not behave like one. A radio group is what this
    // actually is, and it needs neither.
    <div
      role="radiogroup"
      aria-label={label}
      // Wraps: the stats timeframe control offers seven windows, and a fixed
      // row of seven pushed the page sideways on a phone.
      className="inline-flex flex-wrap rounded-xl border border-line bg-raised p-1"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-200 ease-spring',
            value === option.value
              ? 'bg-surface text-ink shadow-card'
              : 'text-muted hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin', className)}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" fill="none" opacity="0.2" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}) {
  return (
    <label
      className={cn(
        'flex items-start justify-between gap-4 py-3',
        disabled && 'opacity-50',
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description && (
          <span className="mt-0.5 block text-xs text-muted">{description}</span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors duration-200',
          checked ? 'bg-accent' : 'bg-line',
        )}
      >
        {/* Anchored with an explicit left: without one the knob falls at the
            button's static position, which lands outside the track. */}
        <span
          className={cn(
            'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow',
            'transition-transform duration-200 ease-spring',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </button>
    </label>
  )
}
