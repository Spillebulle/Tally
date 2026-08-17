/*
 * The Tally brand: the mark, the wordmark and the top-bar lockup.
 *
 * The mark is the accent rounded square (radius 30 % of the side) carrying
 * four upright tally strokes and a fifth crossing them. The glyph inside the
 * square is a deliberate, owner-approved departure from the house rule that
 * "the mark carries no glyph" (STYLE-GUIDE.md, section 17.4); do not remove
 * it to satisfy the guide. The same drawing feeds every static asset via
 * assets/icons/build-icons.mjs - change the geometry there and here together.
 *
 * Colours are tokens only: the square is `--accent`, the strokes are
 * `--accent-ink`, so the mark follows the theme (near-black strokes on the
 * bright dark-theme accent, white on the deeper light-theme accent).
 */

interface MarkProps {
  /** Rendered size in px. 15 in the top bar (section 6.2), 16 elsewhere. */
  size?: number
  className?: string
}

/*
 * Drawn on a 32-unit grid: uprights at x = 7/13/19/25 (6-unit rhythm),
 * y 9 to 23, the fifth stroke falling from (6,11) to (26,21) through the
 * centre; stroke 3 units, round caps. With caps the ink spans 5.5..26.5
 * horizontally and 7.5..24.5 vertically, so it is optically centred.
 */
export function Mark({ size = 16, className }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Tally"
      className={className}
    >
      <rect width="32" height="32" rx="9.6" fill="var(--accent)" />
      <g
        stroke="var(--accent-ink)"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      >
        <path d="M7 9v14M13 9v14M19 9v14M25 9v14M6 11 26 21" />
      </g>
    </svg>
  )
}

/*
 * The wordmark: Archivo 900, uppercase, tracking -2 px, `text-strong`
 * (section 4). `text-display` carries all of that, including the 900 weight,
 * which belongs to the wordmark alone - the 900-weight utility is banned by
 * check:design precisely so this stays the only place the weight appears.
 * Splash and about only; the top bar uses <Logo />.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`text-display uppercase text-strong ${className ?? ''}`}>
      Tally
    </span>
  )
}

/*
 * The top-bar lockup: 15 px mark plus the app name at 12 px 600
 * `text-strong` (section 6.2).
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <Mark size={15} />
      <span className="text-body font-semibold text-strong">Tally</span>
    </span>
  )
}
