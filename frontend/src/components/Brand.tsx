/*
 * The Tally brand: the mark, the wordmark and the top-bar lockup.
 *
 * The mark is the accent rounded square (radius 30 % of the side) carrying
 * four upright tally strokes and a fifth rising across them. The glyph inside
 * the square is a deliberate, owner-approved departure from the house rule
 * that "the mark carries no glyph" (STYLE-GUIDE.md, section 17.4); do not
 * remove it to satisfy the guide.
 *
 * The same geometry draws every static asset in assets/icons/build-icons.mjs.
 * Change the two together or the tab and the top bar stop showing the same
 * logo. Colours are tokens only: the square is `--accent` and the strokes are
 * `--brand-ink`, which is white in both themes for that same reason.
 */

interface MarkProps {
  /**
   * Which drawing to use, in px: at or below 20 the mark is redrawn on the
   * pixel grid (see SMALL), above it the master is used. It also sets the
   * rendered size, unless a `className` overrides the width and height - which
   * is what the top bar does, so the mark follows `--mark` (section 6.5).
   */
  size?: number
  className?: string
  /**
   * Hide the mark from assistive technology. Set it wherever the app name is
   * written beside the mark, so the lockup is not announced "Tally Tally".
   */
  decorative?: boolean
}

/*
 * The master drawing, on a 32-unit grid: uprights at x = 8.5/13.5/18.5/23.5
 * (pitch 5) from y 8 to 24, the fifth mark rising from (8.5, 22.75) to
 * (23.5, 9.25), stroke 2.4, round caps. The fifth mark ends on the outer
 * uprights' centre lines, so its caps are buried in those strokes rather than
 * poking into open field. The figure has 180-degree rotational symmetry about
 * (16, 16), so its centroid is the square's centre.
 *
 * The 42-degree rise is the load-bearing number. Where the fifth mark crosses
 * an upright it merges with it, so only the segments between the uprights are
 * read; shallower than about 38 degrees those segments sit near level, read
 * as rungs, and the mark becomes two letter H's. It is invisible at 256 px
 * and plain at 32. See assets/icons/build-icons.mjs and docs/brand.md.
 */
const MASTER = (
  <g
    stroke="var(--brand-ink)"
    strokeWidth="2.4"
    strokeLinecap="round"
    fill="none"
  >
    <path d="M8.5 8v16M13.5 8v16M18.5 8v16M23.5 8v16M8.5 22.75 23.5 9.25" />
  </g>
)

/*
 * At and below 20 px the master fuses: 2.4-unit strokes land on 1.2 px of
 * screen and no two uprights keep a clean gap. This frame is redrawn on the
 * pixel grid instead - 1 px uprights on whole pixel columns with 2 px gaps,
 * butt caps, and a thinner rising fifth mark. It is the same mark, and it is
 * what the top bar shows, which at 15 px is the most-seen instance of the
 * mark in the product.
 *
 * The uprights snap with `crispEdges` because the frame is pixel-exact only
 * at exactly 16 px: at the top bar's 15 a 1 px stroke lands on 0.94 px and
 * smears across two columns. The fifth mark is left antialiased, because
 * snapping a diagonal turns it into a staircase.
 */
const SMALL = (
  <g stroke="var(--brand-ink)" fill="none">
    <path
      d="M3.5 3v10M6.5 3v10M9.5 3v10M12.5 3v10"
      strokeWidth="1"
      shapeRendering="crispEdges"
    />
    <path d="M3.5 11.5 12.5 4.5" strokeWidth="1" strokeLinecap="round" />
  </g>
)

export function Mark({ size = 16, className, decorative }: MarkProps) {
  const small = size <= 20
  const label = decorative
    ? { 'aria-hidden': true }
    : { role: 'img' as const, 'aria-label': 'Tally' }
  return (
    <svg
      width={size}
      height={size}
      viewBox={small ? '0 0 16 16' : '0 0 32 32'}
      className={className}
      {...label}
    >
      {small ? (
        <>
          <rect width="16" height="16" rx="4.8" fill="var(--accent)" />
          {SMALL}
        </>
      ) : (
        <>
          <rect width="32" height="32" rx="9.6" fill="var(--accent)" />
          {MASTER}
        </>
      )}
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
 * The top-bar lockup: the mark at `--mark` plus the app name at
 * `--text-heading` `text-strong` (section 6.2). The name is the accessible
 * one, so the mark beside it is decorative.
 *
 * At the web scale Tally is stamped with, that is a 22 px mark beside a 15 px
 * name, where it used to be 15 beside 12. The top bar is the one piece of
 * chrome that grows by half rather than a quarter, because it is the one place
 * the app says who it is: at 34 px with a 15 px mark a hosted app reads as a
 * browser toolbar belonging to nobody.
 *
 * `size` and the class say two different things. The number picks the
 * *drawing* - 22 is above the 20 px threshold, so this is the master and not
 * the pixel-grid redraw - and `h-mark w-mark` sets the rendered size from the
 * token, so the lockup follows the scale rather than a literal.
 *
 * The guide asks for 700 here and this is 600. Section 4 allows two weights in
 * the interface, 400 and 600, with 900 reserved for the wordmark, and
 * `check:design` enforces exactly that; a third weight for one word is a worse
 * trade than a word set one step lighter than the table says.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <Mark size={22} className="h-mark w-mark" decorative />
      <span className="text-heading font-semibold text-strong">Tally</span>
    </span>
  )
}
