import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Star, TriangleAlert, X } from 'lucide-react'
import { cn, formatRating, RATING_SCALE, STATUS_DOT, STATUS_LABELS } from '@/lib/utils'
import type { WatchStatus } from '@/lib/types'

/*
 * The painted controls, composed from the component classes in index.css.
 * Everything here names a role, never a colour; the geometry comes from
 * STYLE-GUIDE §7 and the traps from docs/interface.md.
 */

/* ── Page header ─────────────────────────────────────────────────────────── */

/**
 * A page's heading: 15px 600, one line of `text-muted` under it, actions at
 * the right. The 28px display titles are gone; the wordmark is the only thing
 * larger than this.
 */
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
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-balance text-page font-semibold text-strong">{title}</h1>
        {subtitle && <p className="mt-0.5 text-body text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/* ── Empty and error states ──────────────────────────────────────────────── */

/**
 * Nothing here, and why: centred, an optional 24px icon drawn in the dashed
 * line colour, a sentence in `text-dim`, and at most a secondary action.
 * Never an illustration.
 */
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
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      {icon && (
        <span
          className="mb-1 grid place-items-center text-[24px] text-line-dashed"
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <h3 className="text-body font-semibold text-fg">{title}</h3>
      {description && <p className="max-w-sm text-balance text-body text-dim">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/**
 * A request that failed, said so.
 *
 * Distinct from `EmptyState` on purpose. Every list page used to fall through
 * to "Nothing here yet, run a Plex sync from Settings" whenever a request
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
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <span className="mb-1 grid place-items-center text-critical" aria-hidden="true">
        <TriangleAlert size={24} />
      </span>
      <h3 className="text-body font-semibold text-strong">{title}</h3>
      <p className="max-w-sm text-balance text-body text-dim">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-secondary mt-2">
          Try again
        </button>
      )}
    </div>
  )
}

/* ── Status ──────────────────────────────────────────────────────────────── */

/** A watch status: a dot beside a written label, never colour alone. */
export function StatusBadge({ status }: { status: WatchStatus | null }) {
  if (!status) return null
  return (
    <span className="inline-flex items-center gap-1.5 rounded-tight bg-control px-1.5 py-px text-tiny text-fg">
      {/* Dot is redundant with the text label, never the only cue. */}
      <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[status])} aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  )
}

/* ── Star rating ─────────────────────────────────────────────────────────── */

interface StarRatingProps {
  rating: number | null
  onChange?: (rating: number | null) => void
  size?: 'sm' | 'md' | 'lg'
  readOnly?: boolean
}

const STAR_SIZE = { sm: 12, md: 14, lg: 16 } as const

/**
 * Ten stars, one per point, matching Plex's underlying 0 to 10 scale directly.
 *
 * Previously this was five stars at half-star granularity over the same range,
 * which needed two hit zones per star and made "7" unrepresentable as anything
 * but three and a half stars. One star per point removes the translation
 * entirely. Clicking the current value again clears the rating.
 *
 * Filled stars are neutral ink, not the accent: §2.4 is a closed list and a
 * rating is a figure, not a selection.
 */
export function StarRating({ rating, onChange, size = 'md', readOnly }: StarRatingProps) {
  const score = rating ?? 0
  const px = STAR_SIZE[size]
  const interactive = !readOnly && Boolean(onChange)

  return (
    <div
      className="flex items-center gap-0.5"
      role={interactive ? 'radiogroup' : undefined}
      aria-label={interactive ? 'Your rating out of 10' : undefined}
    >
      {RATING_SCALE.map((position) => {
        const filled = score >= position
        const star = (
          <Star
            size={px}
            fill={filled ? 'currentColor' : 'none'}
            aria-hidden="true"
            className={cn(
              filled ? 'text-strong' : 'text-line',
              interactive && 'transition-colors duration-hover',
              interactive && !filled && 'group-hover/star:text-muted',
            )}
          />
        )

        if (!interactive) return <span key={position}>{star}</span>

        return (
          <button
            key={position}
            type="button"
            role="radio"
            aria-checked={score === position}
            aria-label={`${position} out of 10`}
            title={`${position} / 10`}
            onClick={() => onChange?.(score === position ? null : position)}
            className="group/star inline-flex"
          >
            {star}
          </button>
        )
      })}
      {/* The number is not decoration: ten stars are hard to count at a glance. */}
      {rating != null && (
        <span className="figure ml-1.5 text-tiny text-muted">{formatRating(rating)}</span>
      )}
      {interactive && rating != null && (
        <button
          type="button"
          onClick={() => onChange?.(null)}
          className="ml-2 text-tiny text-muted transition-colors duration-hover hover:text-critical"
        >
          Clear
        </button>
      )}
    </div>
  )
}

/* ── Segmented control ───────────────────────────────────────────────────── */

/**
 * Two to five exclusive short options in a `line` bordered box. The selected
 * segment is `control` and `text-strong`, never the accent (§7.9).
 */
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
    // with a roving tabindex, none of which was here. A radio group is what
    // this actually is, and it needs neither.
    <div
      role="radiogroup"
      aria-label={label}
      // Wraps: the stats timeframe control offers seven windows, and a fixed
      // row of seven pushed the page sideways on a phone.
      className="inline-flex flex-wrap gap-[2px] rounded-ctl border border-line p-[2px]"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-[4px] px-2.5 py-1 text-small transition-colors duration-hover ease-ease',
            value === option.value
              ? 'bg-control text-strong'
              : 'text-muted hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/* ── Spinner ─────────────────────────────────────────────────────────────── */

/** A last resort (§7.18): 16px, `text-dim`, sized by the text around it. */
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

/* ── Toggle ──────────────────────────────────────────────────────────────── */

/**
 * A 34 by 18 pill with a 14px knob. Off: `rail` fill, knob left. On: `accent`
 * fill, knob right. The label sits to the left, the toggle at the row's right
 * edge, and there is no text inside the pill (§7.8).
 */
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
        'flex items-start justify-between gap-4 py-2',
        disabled && 'opacity-45',
      )}
    >
      <span className="min-w-0">
        <span className="block text-control text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-small text-dim">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-px h-[18px] w-[34px] shrink-0 rounded-full transition-colors duration-hover ease-ease',
          checked ? 'bg-accent' : 'bg-rail',
        )}
      >
        {/* Anchored with an explicit left: without one the knob falls at the
            button's static position, which lands outside the track. */}
        <span
          className={cn(
            'absolute left-[2px] top-[2px] h-3.5 w-3.5 rounded-full bg-knob shadow-knob',
            'transition-transform duration-hover ease-ease',
            checked ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </button>
    </label>
  )
}

/* ── Checkbox ────────────────────────────────────────────────────────────── */

export type CheckboxState = boolean | 'mixed'

/**
 * The drawing alone: 16 by 16, radius 3, accent fill with an `accent-ink`
 * tick when checked, a 2px dash when indeterminate (§7.12). For rows that are
 * themselves the button (a dropdown option), render this inside them; it takes
 * no events and no focus of its own.
 */
export function CheckboxMark({
  state,
  className,
}: {
  state: CheckboxState
  className?: string
}) {
  const on = state === true || state === 'mixed'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid h-4 w-4 shrink-0 place-items-center rounded-tight border',
        on ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-field',
        className,
      )}
    >
      {state === true && <Check size={12} strokeWidth={3} />}
      {state === 'mixed' && <span className="h-[2px] w-2 rounded-full bg-accent-ink" />}
    </span>
  )
}

/** The standalone control: the mark plus an optional label, 18px hit area. */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: CheckboxState
  onChange: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked === 'mixed' ? 'mixed' : checked}
      disabled={disabled}
      onClick={() => onChange(checked !== true)}
      className={cn(
        'inline-flex min-h-[18px] items-center gap-2 text-control text-fg',
        'disabled:pointer-events-none disabled:opacity-45',
        className,
      )}
    >
      <CheckboxMark state={checked} />
      {label}
    </button>
  )
}

/* ── Tile ────────────────────────────────────────────────────────────────── */

/**
 * A stat: eyebrow, a mono figure, a second line (§7.14). No big icon. An
 * unknown value is an en dash in `text-dim`, never "0", because "no data" and
 * "nothing happened" are different answers.
 *
 * `dot` colours a small status dot beside the eyebrow; whatever it signals
 * must also be said in `detail`, since a dot alone is colour alone.
 */
export function Tile({
  eyebrow,
  value,
  detail,
  spark,
  dot,
  className,
}: {
  eyebrow: string
  value: ReactNode | null
  detail?: ReactNode
  /** A trailing sparkline, drawn by the caller (Charts owns the drawing). */
  spark?: ReactNode
  dot?: 'good' | 'caution' | 'critical' | 'accent'
  className?: string
}) {
  return (
    <div className={cn('card min-w-[180px] p-3', className)}>
      <div className="flex items-center gap-1.5">
        {dot && (
          <span
            aria-hidden="true"
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              dot === 'good' && 'bg-good',
              dot === 'caution' && 'bg-caution',
              dot === 'critical' && 'bg-critical',
              dot === 'accent' && 'bg-accent',
            )}
          />
        )}
        <span className="eyebrow truncate">{eyebrow}</span>
      </div>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        {value == null || value === '' ? (
          <span className="figure text-[24px] leading-none text-dim">–</span>
        ) : (
          <span className="figure text-[24px] leading-none text-strong">{value}</span>
        )}
        {spark && <span className="shrink-0">{spark}</span>}
      </div>
      {detail && <div className="mt-1 text-small text-muted">{detail}</div>}
    </div>
  )
}

/* ── Panel ───────────────────────────────────────────────────────────────── */

/**
 * A titled region of a page: 32px header with a 13px 600 title, right-aligned
 * commands, a body with 12px padding (§7.5 without the drag grip).
 */
export function Panel({
  title,
  count,
  commands,
  children,
  className,
  bodyClassName,
}: {
  title: string
  /** A count beside the title, mono in `text-dim` (§7.13). */
  count?: number | string
  commands?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('panel', className)}>
      <header className="panel-head">
        <h2 className="panel-title truncate">{title}</h2>
        {count != null && <span className="figure text-tiny text-dim">{count}</span>}
        {commands && <div className="ml-auto flex items-center gap-1">{commands}</div>}
      </header>
      <div className={cn('panel-body', bodyClassName)}>{children}</div>
    </section>
  )
}

/* ── Dialog ──────────────────────────────────────────────────────────────── */

const DIALOG_SIZE = {
  small: 'sm:w-[430px]',
  standard: 'sm:w-[760px]',
  large: 'sm:h-[640px] sm:w-[1000px]',
} as const

/**
 * The modal (§7.17): `chrome` fill, radius 10, `shadow-modal`, the page dimmed
 * to ~40% behind it. One scroll area; header and footer stay put. Escape and
 * the close mark close it. On a narrow screen it becomes the bottom sheet,
 * with a 32 by 4 drag handle.
 */
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  size = 'standard',
  footer,
  footerNote,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** One line of `text-muted` under the title. */
  subtitle?: ReactNode
  size?: keyof typeof DIALOG_SIZE
  /** Right-aligned buttons, primary rightmost. */
  footer?: ReactNode
  /** A note at the footer's left, in `text-dim`. */
  footerNote?: ReactNode
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // The page behind must not scroll while the dialog holds the screen.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      // The dimmer: `backdrop` at 60% alpha, which reads as the page dimmed to
      // ~40%. No token carries this alpha and an opacity modifier on a token
      // emits nothing, so it is mixed here.
      style={{ background: 'color-mix(in oklab, var(--backdrop) 60%, transparent)' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'dialog flex max-h-[92vh] w-full flex-col overflow-hidden',
          'max-sm:rounded-b-none sm:max-w-[92vw] motion-safe:animate-rise',
          DIALOG_SIZE[size],
        )}
      >
        {/* The sheet's drag handle, narrow screens only. */}
        <span
          aria-hidden="true"
          className="mx-auto mt-2 h-1 w-8 shrink-0 rounded-full bg-line-dashed sm:hidden"
        />
        <header className="flex shrink-0 items-start gap-3 px-6 pb-3 pt-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-page font-semibold text-strong">{title}</h2>
            {subtitle && <p className="mt-0.5 text-body text-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="btn-icon -mr-2 -mt-1 text-dim"
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
        {(footer || footerNote) && (
          <footer className="flex shrink-0 items-center gap-3 border-t border-line px-6 py-3">
            <div className="min-w-0 flex-1 text-tiny text-dim">{footerNote}</div>
            {footer && <div className="flex shrink-0 items-center gap-2">{footer}</div>}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  )
}

/* ── Progress ────────────────────────────────────────────────────────────── */

/**
 * A 3px rail with an accent fill for a known fraction (§7.18). With no
 * fraction the track is drawn empty and the label beside it says what is
 * happening; `sliding` adds the one permitted indeterminate animation, and
 * only where the total genuinely cannot be known.
 */
export function ProgressBar({
  fraction,
  label,
  sliding,
  className,
}: {
  /** 0 to 1, or null/undefined for "total unknown". */
  fraction?: number | null
  label?: ReactNode
  sliding?: boolean
  className?: string
}) {
  const known = fraction != null && Number.isFinite(fraction)
  const clamped = known ? Math.min(1, Math.max(0, fraction)) : 0
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(clamped * 100) : undefined}
        className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-rail"
      >
        {known ? (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-open ease-ease"
            style={{ width: `${clamped * 100}%` }}
          />
        ) : sliding ? (
          <div className="h-full w-1/3 rounded-full bg-accent motion-safe:animate-progress-slide" />
        ) : null}
      </div>
      {label && <span className="shrink-0 text-tiny text-dim">{label}</span>}
    </div>
  )
}

/* ── Skeleton ────────────────────────────────────────────────────────────── */

/** A `control` block with the slow shimmer, at the geometry of what it stands in for. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-ctl', className)} aria-hidden="true" />
}

/* ── Notice ──────────────────────────────────────────────────────────────── */

/**
 * A caution box inside a panel or dialog: sentence at the left, ghost actions
 * at the right (§7.17). `caution` says "look at this", not "alarm".
 */
export function Notice({
  children,
  actions,
  className,
}: {
  children: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('notice flex flex-wrap items-center gap-3', className)}>
      <div className="min-w-0 flex-1">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/* ── Tooltip ─────────────────────────────────────────────────────────────── */

/**
 * Appears after 400ms of hover, immediately on keyboard focus (§7.17). Hover
 * does not exist on touch, so nothing a user *needs* may live only here; the
 * tooltip repeats or expands what the control already conveys.
 *
 * Not portalled: it sits above its trigger and is small enough that clipping
 * has not been met in practice. If a clipped case appears, portal it the way
 * the dropdown list is.
 */
export function Tooltip({
  content,
  shortcut,
  children,
  className,
}: {
  content: ReactNode
  /** A keyboard shortcut, drawn as a keycap. */
  shortcut?: string
  children: ReactNode
  className?: string
}) {
  const [shown, setShown] = useState(false)
  const timer = useRef<number>()

  const showSoon = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setShown(true), 400)
  }
  const showNow = () => {
    window.clearTimeout(timer.current)
    setShown(true)
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    setShown(false)
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={showSoon}
      onMouseLeave={hide}
      onFocus={showNow}
      onBlur={hide}
    >
      {children}
      {shown && (
        <span
          role="tooltip"
          className="tooltip absolute bottom-full left-1/2 z-40 mb-1 flex
                     -translate-x-1/2 items-center gap-1.5 whitespace-nowrap
                     motion-safe:animate-rise"
        >
          {content}
          {shortcut && <kbd className="keycap">{shortcut}</kbd>}
        </span>
      )}
    </span>
  )
}
