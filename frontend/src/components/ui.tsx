import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Check, Star, TriangleAlert, X } from 'lucide-react'
import { cn, formatRating, RATING_SCALE, STATUS_DOT, STATUS_LABELS } from '@/lib/utils'
import type { WatchStatus } from '@/lib/types'

/*
 * The painted controls, composed from the component classes in index.css.
 * Everything here names a role, never a colour; the geometry comes from
 * STYLE-GUIDE §7 and the traps from docs/interface.md.
 */

/**
 * Marks a layer portalled to `document.body` that sits *over* whatever opened
 * it — a dropdown's list, in practice.
 *
 * A modal owns the keyboard, and it decides what is "inside" itself by asking
 * `panel.contains(node)`. A portalled layer opened from within the dialog is
 * visually inside it and, in the DOM, a sibling of the whole backdrop — so
 * without a mark of its own the dialog reads the topmost layer as the page
 * behind it. Two things went wrong from that, and both are one press spending
 * two layers: Escape closed the list *and* the dialog, and Tab yanked focus out
 * of the list onto the dialog's first control.
 *
 * So the dropdown stamps this on its panel and `Dialog` stands down while one is
 * on screen (§7.7 gives Escape to the dropdown, §7.17 gives it to the dialog;
 * the innermost layer answers first). It is an attribute rather than a context
 * because the dialog has to answer "is anything above me?" about layers it
 * never rendered and cannot see.
 */
export const TOP_LAYER_ATTR = 'data-top-layer'

/** Is a portalled layer currently over everything? */
export const topLayerOpen = () =>
  document.querySelector(`[${TOP_LAYER_ATTR}]`) !== null

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
 * Ends a fragment with a full stop, since §12 asks for sentences and a heading
 * that becomes half of one has to earn its punctuation. Idempotent, so a title
 * that already ends in one does not collect a second.
 */
const sentence = (text: string) => (/[.!?…]$/.test(text.trim()) ? text : `${text}.`)

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
      <h3 className="text-body font-semibold text-strong">{title}</h3>
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
 *
 * Shorter than `EmptyState`, and that is not a lapse in the pair. An empty
 * state is a page's whole answer and may hold the room it is given; an error is
 * a sentence about one request, and most of these sit inside a panel or a rail
 * that is about 200px tall when it succeeds. At `py-16` a failed rail measured
 * 248px, so three of them made the page *taller* than the working one and
 * mostly empty air. 184px now. §7.19 asks for a centred sentence, not a large
 * box, and on a wider page the sentence wraps less and the box grew further
 * still.
 *
 * `compact` goes further, for a failure that stands in for **one line** rather
 * than for a region: a settings row whose single fact could not be fetched. The
 * centred column is wrong at that size whatever its padding — it is a block
 * where a sentence belongs — so this is a left-aligned row instead: 16px mark,
 * one sentence, retry as a ghost button at the end. Measured in place of a 24px
 * row, 248px as the full form against 40px as this one.
 */
export function ErrorState({
  error,
  onRetry,
  title = 'Could not load this',
  compact,
  className,
}: {
  error: unknown
  onRetry?: () => void
  title?: string
  /** Standing in for one row rather than for a region. */
  compact?: boolean
  className?: string
}) {
  const message =
    error instanceof Error && error.message ? error.message : 'Something went wrong.'

  if (compact) {
    return (
      <div className={cn('flex items-start gap-2 py-1 text-left', className)}>
        <TriangleAlert
          size={16}
          aria-hidden="true"
          className="mt-px shrink-0 text-critical"
        />
        <p className="min-w-0 flex-1 text-body text-dim">
          <span className="text-fg">{sentence(title)}</span> {sentence(message)}
        </p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="btn-ghost shrink-0">
            Try again
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-8 text-center',
        className,
      )}
    >
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
    <span className="inline-flex items-center gap-1.5 rounded-tight bg-control px-1.5 py-px text-tiny text-muted">
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
              // An empty star is a mark, so it owes 3:1 (§2.6), and the empty
              // ones are the reference that makes the filled count readable.
              // Two tokens have been tried and only this one clears it. Every
              // figure below is sampled off a rendered pixel — the stroke is
              // antialiased and the tokens are oklch, so anything derived from
              // the declaration is a guess about what was painted:
              //
              //             backdrop  chrome  control      worst
              //   line          1.31    1.20     1.10   dark
              //                 1.06    1.28     1.13   light
              //   placeholder   2.97    2.73     2.50   dark
              //                 1.89    2.28     2.01   light   ← light is worse
              //   muted         7.10    6.53     5.99   dark
              //                 4.09    4.94     4.36   light
              //
              // `line` left all ten all but invisible on an unrated title.
              // `placeholder` was a real improvement and still under the floor
              // in both themes — the palette keeps that token deliberately
              // quiet, because it is for hints and eyebrows; the token is not
              // wrong, using it for a mark was. `muted` is the lowest rank that
              // clears 3:1 everywhere, worst case 4.09 on the light backdrop
              // (`dim` clears it in dark only: 2.61 on the light backdrop).
              // An outline in `muted` against a filled star in `strong` still
              // reads as empty — checked in both themes.
              filled ? 'text-strong' : 'text-muted',
              interactive && 'transition-colors duration-hover',
              // Hover has to move somewhere, and from `muted` that is up to the
              // filled ink: the star shows what clicking it would make it.
              interactive && !filled && 'group-hover/star:text-strong',
            )}
          />
        )

        if (!interactive) return <span key={position}>{star}</span>

        // One sentence, used for both the tooltip and the accessible name.
        // They were "1 / 10" and "1 out of 10", so a person hovering and a
        // person listening were told different things about the same star —
        // and neither string said what clicking it does. Clicking the current
        // value clears the rating, so that star says so.
        const say =
          score === position
            ? `Clear your rating of ${position} out of 10.`
            : `Rate this ${position} out of 10.`

        return (
          <button
            key={position}
            type="button"
            role="radio"
            aria-checked={score === position}
            aria-label={say}
            title={say}
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

/**
 * A last resort (§7.18): 16px and `text-dim`.
 *
 * Sized in pixels rather than `1em`, which inherited whatever font-size it
 * landed in — 12px inside a poster's caption, 10.5px in a chip.
 */
export function Spinner({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg
      className={cn('animate-spin', className)}
      viewBox="0 0 24 24"
      width={size}
      height={size}
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
  srLabel,
  description,
  disabled,
  disabledReason,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  /**
   * The switch's accessible name, when the visible label cannot be it.
   *
   * A row is 26px and a repeated word is what the eye skips, so a list of
   * library switches is labelled "Include" four times over and the library's
   * name is the row it sits in. A screen reader has no row: it hears "Include"
   * four times and nothing but order tells them apart. So the visible label
   * stays short and this carries the whole name — `Include Films`, `Include
   * Anime` — exactly as a `Select` in the same row already says "Anime in
   * {title}". Only where the visible label is genuinely ambiguous on its own;
   * duplicating it here would only make a screen reader repeat itself.
   */
  srLabel?: string
  description?: string
  disabled?: boolean
  /** Why it is disabled. Shown as the control's `title` (§7.6, §12). */
  disabledReason?: string
}) {
  return (
    <label
      className={cn(
        'flex items-start justify-between gap-4 py-2',
        disabled && 'opacity-45',
      )}
      title={disabled ? disabledReason : undefined}
    >
      <span className="min-w-0">
        <span className="block text-control text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-small text-dim">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={srLabel ?? label}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
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
  disabledReason,
  className,
}: {
  checked: CheckboxState
  onChange: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
  /** Why it is disabled. Shown as the control's `title` (§7.6, §12). */
  disabledReason?: string
  className?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked === 'mixed' ? 'mixed' : checked}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
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
 *
 * **The 180px minimum belongs to the grid, not to the tile.** §7.14's 180 is a
 * minimum *track* width, which `minmax(180px, 1fr)` already says; a
 * `min-width` here fights it, because a phone-width grid drops its floor to
 * 170 so two tiles fit a 390px screen and a tile that refuses to shrink then
 * eats the gap. Measured on the dashboard at 390px: tracks computed to 177,
 * every tile held 180, the 12px gap collapsed to 9 and the row ended 3px past
 * every panel below it. A tile is as wide as it is given.
 */
export function Tile({
  eyebrow,
  value,
  detail,
  spark,
  dot,
  to,
  toLabel,
  className,
}: {
  eyebrow: string
  value: ReactNode | null
  detail?: ReactNode
  /** A trailing sparkline, drawn by the caller (Charts owns the drawing). */
  spark?: ReactNode
  dot?: 'good' | 'caution' | 'critical' | 'accent'
  /** Make the whole tile a link. §7.14: hover is `control-hover`, nothing else. */
  to?: string
  /** What the link leads to, for a screen reader. Defaults to the eyebrow. */
  toLabel?: string
  className?: string
}) {
  const body = (
    <>
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
    </>
  )

  if (to) {
    return (
      <Link
        to={to}
        aria-label={toLabel ?? eyebrow}
        className={cn(
          'card block p-3 transition-colors duration-hover ease-ease',
          'hover:bg-control-hover',
          className,
        )}
      >
        {body}
      </Link>
    )
  }

  return <div className={cn('card p-3', className)}>{body}</div>
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

/** Everything inside `panel` that Tab can reach and the eye can see. */
const focusableIn = (panel: HTMLElement | null) =>
  Array.from(
    panel?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  ).filter((node) => node.offsetParent !== null)

/**
 * Empty a field in a way React believes.
 *
 * `target.value = ''` is the obvious line and it does not work. React installs
 * its own `value` setter on a mounted input and keeps a *value tracker* beside
 * it; assigning through that setter updates the node and the tracker together,
 * so when the `input` event arrives React compares the tracker to the field and
 * sees no change — and swallows it. `onChange` never fires. Measured: the field
 * read empty after Escape and the caller's old text came back on its next
 * render, because the caller's state had never heard anything.
 *
 * Writing through the *prototype's* setter goes past React's override, which
 * leaves the tracker holding the old string. The dispatched `input` then looks
 * like a real change and the caller's `onChange` runs. Do not simplify this
 * back.
 */
function clearField(target: HTMLInputElement | HTMLTextAreaElement) {
  const proto =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, '')
  target.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * The modal (§7.17): `chrome` fill, radius 10, `shadow-modal`, the page dimmed
 * to ~40% behind it. One scroll area; header and footer stay put. On a narrow
 * screen it becomes the bottom sheet, with a 32 by 4 drag handle.
 *
 * A modal owns the keyboard while it is open, and that is not decoration:
 * without it Tab walks the page *underneath* the backdrop, which is a list of
 * controls the user cannot see and did not ask for. So focus moves in on open,
 * is contained while open, and goes back to whatever opened it on close.
 *
 * `busy` is the guide's "a modal that holds work in flight refuses to close and
 * says so": pass the sentence, and Escape, the backdrop and the close mark all
 * decline and show it instead. It is a prop rather than each caller's own
 * guard, because a caller that has to remember will forget.
 *
 * **Nothing in the app calls this yet.** Every "dialog" on screen today is a
 * page section or a drawer of its own, so the keyboard behaviour above is a
 * primitive that has been measured rather than one that has shipped. Anything
 * written about it — here, in a commit — has to say so, because "the modal owns
 * the keyboard" reads as a fixed bug and is a promise to the first caller.
 */
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  size = 'standard',
  busy,
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
  /** Work in flight: the sentence to show when a close is refused. */
  busy?: string
  /** Right-aligned buttons, primary rightmost. */
  footer?: ReactNode
  /** A note at the footer's left, in `text-dim`. */
  footerNote?: ReactNode
  children: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<Element | null>(null)
  const [refused, setRefused] = useState(false)
  // Was a portalled layer up when the current gesture began? A click has the
  // same "one press, two layers" problem Escape had, one step further out: a
  // dropdown closes on `pointerdown` *outside* itself, so by the time the
  // `click` reaches the backdrop the list is already gone and the backdrop sees
  // an ordinary dismiss. Measured: one click on the backdrop closed the list and
  // the dialog together. Read at pointer-down, when the answer is still true.
  const layerAtPointerDown = useRef(false)

  const tryClose = () => {
    if (busy) {
      setRefused(true)
      return
    }
    onClose()
  }

  // The key listener is installed once per open, so it must not reach `busy` or
  // `onClose` through its closure — it would hold whichever ones existed when
  // the dialog opened. It calls through this instead, refreshed after every
  // render.
  const tryCloseRef = useRef(tryClose)
  useEffect(() => {
    tryCloseRef.current = tryClose
  })

  /*
   * Two effects, both keyed on `open` alone, and the split is the point.
   *
   * One effect owned the listener *and* focus-in *and* focus-return, with
   * `busy` in its dependencies — so flipping `busy` while the dialog was open
   * ran the cleanup, which focuses the opener (behind the backdrop), and then
   * the body again, which moves focus to the body's first control. `busy`
   * becoming truthy is exactly what a Save click does, so this fired on the
   * common path: measured, clicking "Start work" moved focus off that button
   * and onto the first field.
   *
   * Nothing here may depend on a value that changes while the dialog is open.
   * If something must, it goes in a ref like `tryCloseRef` above.
   */

  // Focus in on open, back to the opener on close.
  useEffect(() => {
    if (!open) {
      setRefused(false)
      return
    }
    // Whatever had focus when this opened is where focus goes back to.
    openerRef.current = document.activeElement
    const panel = panelRef.current

    // Into the dialog, not onto the page behind it. The body's first control
    // rather than the panel's, because the panel's first is the close mark and
    // landing there means Enter shuts the dialog the instant it opens. The
    // panel itself when there is nothing at all, so the keyboard is never left
    // outside.
    const items = focusableIn(panel)
    const first = items.find((node) => node.closest('[data-dialog-body]')) ?? items[0]
    if (first) first.focus()
    else panel?.focus()

    return () => {
      ;(openerRef.current as HTMLElement | null)?.focus?.()
    }
  }, [open])

  // The keyboard and the scroll lock.
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current

    const onKey = (event: KeyboardEvent) => {
      // A dropdown's list is portalled to the body, so it is not `inside` this
      // panel however plainly it sits on top of it. While one is up, the
      // innermost layer answers the keyboard: Escape closes the list and not
      // also the dialog, and Tab dismisses the list back to its own trigger
      // instead of being read as focus escaping the modal and hauled to the
      // dialog's first control. This listener is on `document` in the *capture*
      // phase, which is why the dropdown's own `stopPropagation` cannot do it:
      // capture runs first, so the press is already spent by the time the
      // dropdown sees it.
      if (topLayerOpen()) return

      if (event.key === 'Escape') {
        const target = event.target as HTMLElement | null
        // Escape inside a field drops that field's edit first (§7.17). The
        // second press then reaches the dialog.
        if (
          target &&
          (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') &&
          (target as HTMLInputElement).value !== ''
        ) {
          event.stopPropagation()
          clearField(target as HTMLInputElement | HTMLTextAreaElement)
          return
        }
        event.preventDefault()
        tryCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusableIn(panel)
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      const active = document.activeElement
      // Wrapped at both ends, and pulled back in if focus is somehow outside:
      // the page behind a backdrop is not somewhere Tab may go.
      if (!panel?.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? lastItem : firstItem).focus()
      } else if (event.shiftKey && active === firstItem) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }

    document.addEventListener('keydown', onKey, true)
    // The page behind must not scroll while the dialog holds the screen.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = previous
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="dialog-backdrop fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      role="presentation"
      // Capture, and on the whole subtree: every click is preceded by its own
      // pointer-down, so the flag is never stale and needs no clearing.
      onPointerDownCapture={() => {
        layerAtPointerDown.current = topLayerOpen()
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        // The gesture that just ended was spent closing the layer above this
        // dialog. The innermost layer answers first, here as for Escape.
        if (layerAtPointerDown.current) return
        tryClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
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
            onClick={tryClose}
            title={busy ?? 'Close'}
            aria-label="Close"
            className="btn-icon -mr-2 -mt-1 text-dim"
          >
            <X size={16} />
          </button>
        </header>
        <div
          data-dialog-body=""
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6"
        >
          {refused && busy && (
            <div role="alert" className="notice mb-3">
              {busy}
            </div>
          )}
          {children}
        </div>
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
 * Portalled, like the dropdown's list. It sits above its trigger, and the two
 * places a tooltip most obviously belongs — an icon button in a poster rail,
 * and one in the filter strip — are both `.scroll-x` containers, which
 * `index.css` documents as clipping vertically with no z-index able to escape
 * it. Positioned in the same way: from the trigger's rectangle, flipped below
 * when there is no room above.
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
  const [style, setStyle] = useState<CSSProperties | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const timer = useRef<number>()

  const place = () => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    const above = rect.top > 40
    setStyle({
      position: 'fixed',
      left: Math.min(Math.max(8, rect.left + rect.width / 2), window.innerWidth - 8),
      transform: 'translateX(-50%)',
      ...(above
        ? { bottom: window.innerHeight - rect.top + 4 }
        : { top: rect.bottom + 4 }),
    })
  }

  const showSoon = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(place, 400)
  }
  const showNow = () => {
    window.clearTimeout(timer.current)
    place()
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    setStyle(null)
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <span
      ref={wrapRef}
      className={cn('relative inline-flex', className)}
      onMouseEnter={showSoon}
      onMouseLeave={hide}
      onFocus={showNow}
      onBlur={hide}
    >
      {children}
      {style &&
        createPortal(
          <span
            role="tooltip"
            style={style}
            className="tooltip z-50 flex items-center gap-1.5 whitespace-nowrap motion-safe:animate-rise"
          >
            {content}
            {shortcut && <kbd className="keycap">{shortcut}</kbd>}
          </span>,
          document.body,
        )}
    </span>
  )
}
