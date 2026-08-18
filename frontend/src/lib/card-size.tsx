/*
 * How big the posters are in a card grid.
 *
 * Three sizes, and all three are **rungs of the artwork ladder**
 * (STYLE-GUIDE.md 7.21) rather than three numbers somebody liked: 120, 180 and
 * 320. The ladder is four widths and no fifth, so a size control picks among
 * the sanctioned sizes instead of inventing one, and the page is still drawn at
 * exactly one of them - which is what "the same kind of thing is the same size
 * everywhere on a page" asks for. It is the *page's* rung that the reader now
 * chooses.
 *
 * The one place this reads against the guide is the top rung: 7.21 introduces
 * `--art-hero` as "the one big piece on a detail page. One per page". That
 * sentence is about a detail page's hero, and the width is the ladder's; a grid
 * deliberately set to it is using the ladder rather than breaking it. Worth
 * knowing it is a judgement call, because the alternative - a fifth width for
 * "large" - is the thing the ladder exists to forbid.
 *
 * ── Where the value lives ──────────────────────────────────────────────────
 *
 * `localStorage`, not the URL and not the server, and both halves of that are
 * deliberate.
 *
 * **Not the URL.** The rule that the whole browse query lives in the URL is
 * about anything that changes *which rows you are looking at* - filters, sort,
 * page - so that a navigation cannot lose it and a link can carry it. A card
 * size changes none of that. Put it in the query and every shared link would
 * impose the sender's density on the reader, every saved view would freeze one,
 * and changing it would push a history entry that Back has to walk through.
 *
 * **Not the server.** A preference that syncs across devices would hand a phone
 * the density chosen on a 32-inch monitor, and this is exactly the setting
 * where those two disagree. The theme's lightness is stored the same way and
 * for the same reason.
 */
import { useCallback, useState, type CSSProperties, type ReactNode } from 'react'
import { Grid2x2, Grid3x3, RectangleVertical } from 'lucide-react'
import { Segmented } from '@/components/ui'

export type CardSize = 'compact' | 'standard' | 'large'

export const CARD_SIZES: ReadonlyArray<{
  value: CardSize
  label: string
  /** The ladder rung, as a custom property name. */
  token: string
  icon: ReactNode
}> = [
  {
    value: 'compact',
    label: 'Compact posters',
    token: '--art-tile',
    icon: <Grid3x3 className="size-icon" aria-hidden="true" />,
  },
  {
    value: 'standard',
    label: 'Standard posters',
    token: '--art-card',
    icon: <Grid2x2 className="size-icon" aria-hidden="true" />,
  },
  {
    value: 'large',
    label: 'Large posters',
    token: '--art-hero',
    icon: <RectangleVertical className="size-icon" aria-hidden="true" />,
  },
]

const KEY = 'tally.cards'
const FALLBACK: CardSize = 'standard'

/** Stored input is untrusted input: anything unrecognised is the default. */
function read(): CardSize {
  try {
    const stored = localStorage.getItem(KEY)
    return CARD_SIZES.some((size) => size.value === stored) ? (stored as CardSize) : FALLBACK
  } catch {
    // Private browsing, or storage disabled. A preference nobody can save is
    // not a reason for a page not to render.
    return FALLBACK
  }
}

/**
 * The chosen size, remembered.
 *
 * Read once at mount rather than watched: the two pages that offer this each
 * mount their own copy, and a second tab changing it under a grid the reader is
 * looking at would be a surprise rather than a service.
 */
export function useCardSize() {
  const [size, setSizeState] = useState<CardSize>(read)

  const setSize = useCallback((next: CardSize) => {
    setSizeState(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // See `read`. The grid still changes for this visit.
    }
  }, [])

  return { size, setSize }
}

/**
 * The floor for `.poster-grid`, as a custom property.
 *
 * A property rather than a whole `grid-template-columns`, so the reflow rule -
 * and the clamp that stops a poster filling a phone - stays in one place, in
 * `index.css`, where a component cannot get it subtly wrong.
 */
export function cardSizeStyle(size: CardSize): CSSProperties {
  const rung = CARD_SIZES.find((entry) => entry.value === size) ?? CARD_SIZES[1]
  return { '--card-floor': `var(${rung.token})` } as CSSProperties
}

/**
 * The control, on the browse toolbar beside the Filters disclosure.
 *
 * Not in the filter table, and deliberately: everything in that table is
 * derived from - whether "Clear all" appears, what a chip says, what the count
 * badge counts - and a card size narrows nothing. A chip reading "Large" would
 * claim the grid was filtered.
 *
 * Hidden below `sm`, because there it would be a control that cannot do
 * anything: a 390px window holds two portrait posters or one, and one is the
 * window-wide poster 6.4 forbids, so all three sizes resolve to the same two
 * columns. A control that looks live and changes nothing is worse than no
 * control.
 */
export function CardSizeControl({
  value,
  onChange,
}: {
  value: CardSize
  onChange: (next: CardSize) => void
}) {
  return (
    <span className="hidden shrink-0 sm:inline-flex">
      <Segmented label="Poster size" value={value} onChange={onChange} options={CARD_SIZES} />
    </span>
  )
}
