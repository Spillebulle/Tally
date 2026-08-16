import { cn } from '@/lib/utils'
import { ratingMark } from '@/lib/rating-systems'
import { CertificateBadge } from './Certificate'

/**
 * A content rating, shown as its board's own mark.
 *
 * Three outcomes, in order: the board's published symbol, bundled from
 * `assets/ratings` (BBFC, MPA, US TV, FSK, Kijkwijzer); a plain age disc for a
 * board with no free mark; or boxed text. The last is the common case for
 * `NR`, `Unrated` and `Approved`, not an error path — a certificate the filter
 * refuses to show is a row of the library the user cannot reach.
 *
 * See `lib/rating-systems.ts` for where the marks come from and their licence.
 */

/**
 * Every bundled mark, resolved to a URL at build time.
 *
 * A glob rather than 32 imports: the table in `rating-systems.ts` names the
 * file, and a mark that is added there but never imported here would be a
 * silent blank. Vite emits each file as its own asset, so only the marks a page
 * actually shows are ever fetched.
 */
const ASSETS = import.meta.glob('../assets/ratings/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

function assetUrl(stem: string): string | undefined {
  return ASSETS[`../assets/ratings/${stem}.svg`]
}

export function RatingBadge({
  raw,
  label,
  className,
  fallback = 'text',
}: {
  /** The stored certificate. Never modified, never sent anywhere. */
  raw: string
  /** The presentable spelling, for the text fallback. */
  label: string
  className?: string
  /**
   * What to show when the certificate has no mark.
   *
   * `text` boxes the label, for a caller showing the badge alone. `none`
   * renders nothing, for a caller that already prints the label beside it —
   * otherwise an unmarked value like `NR` appears twice in a row.
   */
  fallback?: 'text' | 'none'
}) {
  const mark = ratingMark(raw)

  if (mark?.kind === 'asset') {
    const src = assetUrl(mark.asset)
    // A stem with no file is a table/asset mismatch. Fall through to text
    // rather than render a broken image.
    if (src) {
      return (
        <img
          src={src}
          alt={mark.title}
          title={mark.title}
          // Marks differ wildly in proportion — a BBFC circle is square, an MPA
          // card is twice as wide as it is tall — so height is what is fixed
          // and width follows, or every mark would be distorted to match.
          className={cn('h-5 w-auto shrink-0', className)}
        />
      )
    }
  }

  if (mark?.kind === 'drawn') {
    return (
      <svg
        viewBox="0 0 24 24"
        className={cn('h-5 w-auto shrink-0', className)}
        role="img"
        aria-label={mark.title}
      >
        <title>{mark.title}</title>
        <circle cx={12} cy={12} r={11} fill={mark.fill} />
        <text
          x={12}
          y={12}
          textAnchor="middle"
          dominantBaseline="central"
          fill={mark.ink}
          fontSize={mark.text.length <= 1 ? 14 : mark.text.length <= 2 ? 12 : 10}
          fontWeight={700}
          // Longer codes are pinned to the disc so no font pushes them out of it.
          textLength={mark.text.length >= 3 ? 17 : undefined}
          lengthAdjust={mark.text.length >= 3 ? 'spacingAndGlyphs' : undefined}
        >
          {mark.text}
        </text>
      </svg>
    )
  }

  if (fallback === 'none') return null
  return <CertificateBadge className={className}>{label}</CertificateBadge>
}
