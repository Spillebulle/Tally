import { cn } from '@/lib/utils'
import { ratingMark, type BadgeShape } from '@/lib/rating-systems'
import { CertificateBadge } from './Certificate'

/**
 * A content rating drawn as its board draws it — a BBFC circle, an MPA card,
 * an FSK square — falling back to plain boxed text when there is no mark for
 * the value.
 *
 * The fallback is the common case, not an error path: `NR`, `Unrated` and
 * `Approved` are ordinary values a library holds, and a certificate the filter
 * refuses to show is a row of the library the user cannot reach.
 *
 * Colours and shapes live in `lib/rating-systems.ts`; this file is geometry.
 * The mark carries its own ink colour and, where it needs one, its own edge, so
 * it reads on either surface without a theme rule — which is the point, since
 * these are other organisations' marks and must not shift with the theme.
 */

/** Per shape: the box it needs, the width text may occupy, and the baseline. */
const GEOMETRY: Record<BadgeShape, { width: number; inner: number; baseline: number }> = {
  circle: { width: 24, inner: 17, baseline: 12 },
  square: { width: 24, inner: 18, baseline: 12 },
  // A triangle is narrow where the text sits, so the text sits low and small.
  triangle: { width: 26, inner: 14, baseline: 16.5 },
  card: { width: 42, inner: 34, baseline: 12 },
  tv: { width: 42, inner: 34, baseline: 12 },
}

function fontSize(shape: BadgeShape, length: number): number {
  if (shape === 'card' || shape === 'tv') {
    return length <= 2 ? 13 : length <= 5 ? 11 : 9
  }
  if (shape === 'triangle') {
    return length <= 1 ? 13 : length <= 2 ? 11 : 9
  }
  return length <= 1 ? 14 : length <= 2 ? 12 : length <= 3 ? 10 : 8
}

export function RatingBadge({
  raw,
  label,
  className,
}: {
  /** The stored certificate. Never modified, never sent anywhere. */
  raw: string
  /** The presentable spelling, for the text fallback. */
  label: string
  className?: string
}) {
  const mark = ratingMark(raw)
  if (!mark) return <CertificateBadge className={className}>{label}</CertificateBadge>

  const { width, inner, baseline } = GEOMETRY[mark.shape]
  const size = fontSize(mark.shape, mark.text.length)

  return (
    <svg
      viewBox={`0 0 ${width} 24`}
      className={cn('h-5 w-auto shrink-0', className)}
      role="img"
      aria-label={mark.title}
    >
      <title>{mark.title}</title>
      {mark.shape === 'circle' && (
        <circle
          cx={12}
          cy={12}
          r={mark.edge ? 10.5 : 11}
          fill={mark.fill}
          stroke={mark.edge}
          strokeWidth={mark.edge ? 1 : undefined}
        />
      )}
      {mark.shape === 'square' && (
        <rect
          x={1.5}
          y={1.5}
          width={21}
          height={21}
          rx={4.5}
          fill={mark.fill}
          stroke={mark.edge}
          strokeWidth={mark.edge ? 1 : undefined}
        />
      )}
      {mark.shape === 'triangle' && (
        // Stroked in its own fill so the corners round the way the board's do.
        <path
          d="M13 3.5 L23.5 20.5 H2.5 Z"
          fill={mark.fill}
          stroke={mark.fill}
          strokeWidth={3}
          strokeLinejoin="round"
        />
      )}
      {(mark.shape === 'card' || mark.shape === 'tv') && (
        <rect
          x={mark.edge ? 2 : 1}
          y={mark.edge ? 2 : 1}
          width={mark.edge ? 38 : 40}
          height={mark.edge ? 20 : 22}
          rx={3}
          fill={mark.fill}
          stroke={mark.edge}
          // The MPA card's rule is part of the mark and is drawn heavy; the TV
          // box's edge exists only so a near-black fill has an outline on a
          // near-black page, so it stays hairline.
          strokeWidth={mark.edge ? (mark.shape === 'card' ? 2 : 1.25) : undefined}
        />
      )}
      <text
        x={width / 2}
        y={baseline}
        textAnchor="middle"
        dominantBaseline="central"
        fill={mark.ink}
        fontSize={size}
        fontWeight={700}
        // Longer codes are pinned to the box so no font can push them out of
        // the shape; two characters and under are left to sit naturally.
        textLength={mark.text.length >= 3 ? inner : undefined}
        lengthAdjust={mark.text.length >= 3 ? 'spacingAndGlyphs' : undefined}
      >
        {mark.text}
      </text>
    </svg>
  )
}
