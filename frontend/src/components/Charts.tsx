/**
 * Charts for the stats page, drawn to STYLE-GUIDE §8.
 *
 * Hand-built SVG and CSS rather than a charting library, and that is still the
 * right call: §8 fixes the marks (≤24px thick, radius 2 on the data end only,
 * square at the baseline, a 2px gap between neighbours, horizontal hairline
 * gridlines and nothing else), and a library fights every one of them.
 *
 * ## Colour, and why nothing here reads `getComputedStyle`
 *
 * Every colour is a `var(--token)`, either through a Tailwind role class
 * (`bg-accent`, `fill-heat-3`, `bg-series-2`) or written into a `style` as the
 * variable itself. A variable is resolved by the browser at paint, so the
 * charts follow a theme change with nothing to re-read and no effect to keep in
 * step. Sampling the tokens into JavaScript would be the *weaker* version of
 * the same rule: it re-reads only when something tells it to.
 *
 * The rules the marks follow, from §8:
 *
 *  - **One series is the accent**, at 85% opacity at rest and 100% on hover.
 *    The opacity is on the element, so "the accent at 85%" is exactly what it
 *    says over whatever surface the chart sits on.
 *  - **Several series take `series-1..6` in order, and never the accent.** Two
 *    frames here hold two series: the window comparison (paired) and the
 *    first-watch/rewatch split (stacked). Both take `series-1` and `series-2`.
 *  - **Sequential is the heat ramp**, `heat-1..5`, and **zero is `control`**,
 *    not the lightest step: "nothing watched" and "watched a little" are
 *    different facts and must not be confusable.
 *  - **Grid is horizontal hairlines only**, in `grid`, with the baseline in
 *    `line`. No vertical grid, no axis lines, no ticks, no chart-area fill.
 *  - **Axis labels are 10.5px mono `text-dim`**, tabular; the y labels sit
 *    inside the plot above their gridline, the x labels below it.
 *  - **No motion on load**, and a hover highlight that is immediate.
 *  - **Empty keeps its axes and grid**, with a sentence in `text-dim`.
 *
 * Every chart also ships a `DataTable` (or `MatrixTable`) fallback, so no
 * number on this page is reachable only through colour or hover.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { StatCount } from '@/lib/types'
import { cn, compactNumber, localDateKey } from '@/lib/utils'
import { Tile } from './ui'
import { Artwork } from './Poster'

/* ── Shared pieces ───────────────────────────────────────────────────────── */

/**
 * How a **clickable** chart mark reacts, so it reads as a control.
 *
 * Three statements at once, because hover alone is not an affordance: a
 * `control-hover` fill (the same one every row in the app uses), the same fill
 * on keyboard focus so a keyboard reaches it, and a pointer cursor, which is
 * the only one of the three a pointer user reads *before* committing to a
 * click. The focus ring itself is global, from `tokens.css`.
 *
 * Touch gets none of these, which is why every chart that drills also says so
 * in its own description ("Pick one to ..."). That sentence is the affordance
 * on a phone and it is not optional.
 */
const CLICKABLE_MARK =
  'cursor-pointer rounded-ctl transition-colors duration-hover ease-ease ' +
  'hover:bg-control-hover focus-visible:bg-control-hover'

/** Height of the plot area, and of the axis label strip under it. */
const PLOT_HEIGHT = 152
const AXIS_HEIGHT = 18

/**
 * Room for the y figures, which sit *inside* the plot rather than in an axis
 * column with a rule down it. Both numbers exist because the placement the
 * guide asks for collides with the data if it is taken literally, and both were
 * measured on the rendered page rather than guessed:
 *
 * `HEADROOM` is the gap above the topmost gridline. Without it that gridline is
 * the plot's own top edge, so its figure is drawn *outside* the chart and lands
 * on the description above it, reading as part of the sentence.
 *
 * `Y_GUTTER` is how far the marks are indented. The figures are drawn at the
 * left of each band, and a chart dense enough that its first column is 20px
 * wide (the 24-hour profile) then draws that column straight through them. The
 * figures still sit inside the chart, above their own gridline and with no axis
 * line anywhere; they simply do not have a bar on top of them.
 *
 * It is a **floor**, not the gutter itself: see `yGutterFor`.
 */
const HEADROOM = 12
const Y_GUTTER = 26

/**
 * One character of a 10.5px axis figure, measured in the browser rather than
 * guessed: a tick reading "5" is 6.16px wide, "10" is 12.31 and "12.5" is 24.61,
 * so the mono face is 6.16px per character at this size.
 */
const FIGURE_CHAR = 6.16

/**
 * The five steps of the sequential ramp, as class names rather than as an
 * index into a template string.
 *
 * Tailwind scans the source for literal class names, so `bg-heat-${tier}` would
 * generate nothing at all. Written out, both arrays are also the one place the
 * ramp is named: `heatLevel` decides which step, and nothing else knows the
 * colours exist.
 */
const HEAT_BG = ['bg-heat-1', 'bg-heat-2', 'bg-heat-3', 'bg-heat-4', 'bg-heat-5'] as const
const HEAT_FILL = [
  'fill-heat-1',
  'fill-heat-2',
  'fill-heat-3',
  'fill-heat-4',
  'fill-heat-5',
] as const

/**
 * The width a chart has to draw in, tracked as its box changes.
 *
 * Only for the charts that cannot be sized in CSS. Anything laid out with flex
 * or grid stretches on its own; an **SVG with a computed `width` attribute** is
 * the case that does not, and `ActivityHeatmap` is the one such chart here.
 *
 * A `ResizeObserver` rather than a window `resize` listener, because the box
 * changes without the window doing so (a disclosure opening, a font loading).
 * The fallback exists for a test runner and errs towards "measure once".
 *
 * The node arrives through a callback ref: the element does not exist on the
 * first render, and an effect keyed on a mutable ref would never see it appear.
 */
function useMeasuredWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [node, setNode] = useState<T | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    if (!node) return
    const measure = () => setWidth(node.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  return [setNode, width]
}

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value))

/**
 * The gridlines for a plot, and what the tallest mark is measured against.
 *
 * **The ceiling is the data's own maximum, not a rounded-up one.** Rounding it
 * was tried and looked broken: a weekday profile peaking at 104 rounds to 150,
 * so the tallest column filled two thirds of the frame and the top third was
 * permanently empty, on a chart whose whole job is the shape of the peak. With
 * the ceiling at the maximum the shape always fills its frame, and the axis is
 * still read off round gridlines below it.
 *
 * The steps come from the 1 / 2 / 2.5 / 5 family, so every figure on the axis
 * is a number somebody would say out loud.
 *
 * **Every candidate is scored rather than the first adequate one taken**, and
 * that is the difference between three gridlines and one. Walking the family
 * until a step is big enough falls through the family's own gaps: a maximum of
 * 57 wants a step of about 14, the next member up is 20, and the axis then drew
 * two lines on a chart that had room for five. Counting what each step would
 * actually produce and keeping the one nearest four lines cannot fall through a
 * gap, because the gap is what it is measuring.
 *
 * **`integers` refuses a step that is not whole**, and the caller decides it by
 * looking at its own series rather than at the maximum. Half a play does not
 * exist, and the 2.5 candidate does not merely happen to win occasionally: at a
 * maximum of 13 it scores better than every other member and the monthly axis
 * drew `2.5 / 5 / 7.5 / 10 / 12.5` over a count of plays. Every maximum from 11
 * to 15 did the same.
 *
 * The member is refused rather than removed, because `2.5 × 10^k` is a whole
 * number for every k above zero: a weekday profile peaking at 145 wants a step
 * of 25 and gets five gridlines, where dropping the member outright left it with
 * two. Only the k = 0 case, the literal 2.5, is the one that cannot be a count.
 */
function niceScale(
  max: number,
  { integers = false, targetTicks = 4 }: { integers?: boolean; targetTicks?: number } = {},
): { ceiling: number; ticks: number[] } {
  // §8: "Empty: the axes and grid stay." So the empty case needs a scale to draw
  // them against — with no ticks at all the frame was a baseline and nothing
  // else, and the sentence floated in a box that no longer read as a chart. The
  // ceiling is nominal because there is nothing to measure against it.
  if (!Number.isFinite(max) || max <= 0) return { ceiling: 4, ticks: [1, 2, 3] }
  // A handful of plays needs whole numbers, not a step of 0.2. The floor under
  // the ceiling is what keeps a grid there at all: at a maximum of 1 there is no
  // whole number below it to draw a line on, and at 2 there is exactly one.
  if (max <= 6) {
    const ceiling = Math.max(max, 3)
    return {
      ceiling,
      ticks: Array.from({ length: Math.max(0, Math.ceil(ceiling) - 1) }, (_, i) => i + 1),
    }
  }
  const magnitude = Math.pow(10, Math.floor(Math.log10(max / targetTicks)))
  // A whole-number series takes whole-number steps, and never one below 1.
  const floor = integers ? 1 : 0
  let step = Math.max(floor, magnitude)
  let best = Infinity
  for (const multiple of [1, 2, 2.5, 5, 10]) {
    const candidate = Math.max(floor, multiple * magnitude)
    if (integers && !Number.isInteger(candidate)) continue
    const count = Math.ceil(max / candidate) - 1
    if (count < 2) continue
    const score = Math.abs(count - targetTicks)
    if (score < best) {
      best = score
      step = candidate
    }
  }
  const ticks: number[] = []
  for (let value = step; value < max; value += step) {
    ticks.push(Number(value.toPrecision(12)))
  }
  return { ceiling: max, ticks }
}

/** An axis figure: short enough to sit under a 14px column. */
const axisFigure = (value: number) => compactNumber(value)

/**
 * The gutter the widest tick on *this* axis actually needs.
 *
 * A fixed 26px was a bet against the figures, and the bet was already lost:
 * "12.5" measures 24.61px and left 1.4px of clearance, and a five-character tick
 * ("12.5k", which `compactNumber` produces the moment a count passes ten
 * thousand) is 30.8px and would be drawn under the first column, which is the
 * one thing the gutter exists to prevent. Derived from the formatted text, so it
 * cannot fall behind a change in how a tick is written.
 */
function yGutterFor(ticks: number[]): number {
  const widest = ticks.reduce((n, tick) => Math.max(n, axisFigure(tick).length), 0)
  return Math.max(Y_GUTTER, Math.ceil(widest * FIGURE_CHAR) + 4)
}

/**
 * The plot's ground: horizontal hairlines, their figures, and the baseline.
 *
 * Absolutely positioned behind the marks, so the marks stay a plain flex row
 * and cannot be pushed out of alignment by an axis. The y figures sit *inside*
 * the plot, just above their own gridline at the left, which is the house
 * placement and the reason there is no gutter and no y axis line.
 */
function PlotGround({ ticks, ceiling }: { ticks: number[]; ceiling: number }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {ticks.map((tick) => (
        <div
          key={tick}
          className="absolute inset-x-0"
          style={{ bottom: `${(tick / ceiling) * 100}%` }}
        >
          <span className="figure absolute bottom-px left-0 text-tiny leading-none text-dim">
            {axisFigure(tick)}
          </span>
          <div className="h-px w-full bg-grid" />
        </div>
      ))}
      {/* The one axis line the guide allows, and it is the baseline. */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-line" />
    </div>
  )
}

/** "No data for this range", drawn over the grid rather than instead of it. */
function PlotEmpty({ message }: { message: string }) {
  return (
    <p
      className="pointer-events-none absolute inset-0 flex items-center justify-center
                 px-4 text-center text-small text-dim"
      role="status"
    >
      {message}
    </p>
  )
}

/* ── Tooltip ─────────────────────────────────────────────────────────────── */

/** One line of a chart tooltip: a swatch, what it is, and the figure. */
interface TipRow {
  label: string
  value: string
  /** A Tailwind background role for the swatch. Omitted for a single series. */
  swatch?: string
}

interface ChartTip {
  x: number
  y: number
  /** The x value, in `text-dim` above the rows. */
  heading: string
  rows: TipRow[]
}

/**
 * Roughly how much room the bubble needs above and beside the mark it points
 * at, so it can be kept inside the chart's own box.
 *
 * `.panel` clips its overflow, which it must (a card is a box), so a tooltip
 * anchored to a mark at the top or the far right of a plot loses a corner. The
 * charts are the one place a popover is anchored to something that can sit
 * flush against the panel's edge, and portalling one bubble per hover would be
 * a lot of machinery for a clamp.
 */
const TIP_HEIGHT = 52
const TIP_HALF_WIDTH = 64

/** Where the bubble may sit, given the box it must stay inside. */
function tipPosition(mark: DOMRect, frame: DOMRect | undefined): { x: number; y: number } {
  const width = frame?.width ?? mark.width
  return {
    x: clamp(
      mark.left - (frame?.left ?? 0) + mark.width / 2,
      TIP_HALF_WIDTH,
      Math.max(TIP_HALF_WIDTH, width - TIP_HALF_WIDTH),
    ),
    y: Math.max(mark.top - (frame?.top ?? 0), TIP_HEIGHT),
  }
}

/**
 * The popover, per §7.17: the x value in `text-dim`, then one row per series as
 * swatch, label and mono figure, sorted by value.
 */
function TooltipBubble({ tip }: { tip: ChartTip | null }) {
  if (!tip) return null
  const rows = [...tip.rows].sort((a, b) => b.value.localeCompare(a.value, undefined, { numeric: true }))
  return (
    <div
      className="tooltip pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full"
      style={{ left: tip.x, top: tip.y - 8 }}
      role="status"
    >
      <div className="text-dim">{tip.heading}</div>
      {rows.map((row) => (
        <div key={row.label} className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap">
          {row.swatch && (
            <span className={cn('h-2 w-2 shrink-0 rounded-[2px]', row.swatch)} aria-hidden="true" />
          )}
          <span className="text-fg">{row.label}</span>
          <span className="figure ml-auto pl-2 text-strong">{row.value}</span>
        </div>
      ))}
    </div>
  )
}

/* ── The frame every chart sits in ───────────────────────────────────────── */

/**
 * A panel around one chart, with its table fallback underneath.
 *
 * The panel header carries the title, and its right side carries the legend,
 * which is where §7.5 puts a region's own commands. The chart then sits
 * directly on the panel body: no inner border, no chart-area fill, no title bar
 * of its own.
 *
 * Composed from the `.panel` classes rather than from `ui.tsx`'s `Panel`
 * because of `headingLevel` alone: the stats page groups its cards under named
 * sections a link can target, so a card inside one is an `h3` under that
 * section's `h2`, and `Panel` always writes an `h2`. Everything else here is
 * the same classes `Panel` composes.
 */
export function ChartCard({
  title,
  description,
  children,
  table,
  legend,
  headingLevel = 2,
}: {
  title: string
  description?: string
  children: React.ReactNode
  table?: React.ReactNode
  /** Only for a chart with more than one series; see `ChartLegend`. */
  legend?: React.ReactNode
  headingLevel?: 2 | 3
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  return (
    // `min-w-0` is load-bearing wherever a card is a grid or flex item, which
    // on the stats page is most of them. A grid item's automatic minimum size
    // is its content's min-content width, so a chart that declares a floor
    // pushes that floor up through the card, through the grid track and out to
    // the document. A scroller only starts scrolling once it is allowed to be
    // narrower than what it holds.
    <section className="panel min-w-0">
      <header className="panel-head">
        <Heading className="panel-title truncate">{title}</Heading>
        {legend && <div className="ml-auto min-w-0">{legend}</div>}
      </header>
      <div className="panel-body">
        {description && <p className="mb-3 text-small text-dim">{description}</p>}
        {children}
        {table}
      </div>
    </section>
  )
}

/**
 * Which colour is which series: inline chips above the chart at the right, per
 * §8. No boxed legend, and no legend at all where there is a single series,
 * because the panel title names it.
 *
 * Each entry is a swatch *beside its name* rather than a colour standing in for
 * one, the same reason a status dot always sits next to a written label.
 */
export function ChartLegend({ series }: { series: Array<{ label: string; className: string }> }) {
  return (
    <ul className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
      {series.map((entry) => (
        <li key={entry.label} className="flex items-center gap-1.5 text-tiny text-muted">
          <span
            className={cn('h-2 w-2 shrink-0 rounded-[2px]', entry.className)}
            aria-hidden="true"
          />
          {entry.label}
        </li>
      ))}
    </ul>
  )
}

/* ── Horizontal bars ─────────────────────────────────────────────────────── */

/**
 * Selection hands back the whole entry, not its label.
 *
 * A label is what the axis *reads*, which is not always what the row *is*: the
 * monthly columns are labelled "Aug" but the bucket is `2026-08`, and the raw
 * key was formatted away before the chart ever saw it, so a drill-down had
 * nothing to drill on. The charts are generic over the entry type for the same
 * reason: a caller may hang whatever it needs off `StatCount` and get it back
 * intact, with `formatLabel` doing the display work instead.
 */
export type SelectEntry<T extends StatCount> = (entry: T, index: number) => void

interface BarListProps<T extends StatCount> {
  data: T[]
  unit?: string
  emptyMessage?: string
  /** Makes each row a button. Given the whole entry and its index. */
  onSelect?: SelectEntry<T>
  activeLabel?: string | null
  /**
   * A second line under the label: "18 titles · 42 hours", "crowd 7.4".
   *
   * For the figure that qualifies the bar rather than competes with it. A facet
   * ranked by plays is unreadable without the number of titles behind it: "300
   * plays" is one binged series or thirty films. It joins the accessible name
   * too, so it is not a sighted-only aside.
   */
  meta?: (entry: T) => string | null
  /**
   * The value a full-width bar means. Defaults to the largest in the list.
   *
   * A count has no ceiling, so the biggest row filling the track is the right
   * reading and the bars are a *ranking*. A **percentage** does have one, and
   * without this the two disagree completely: library coverage of 49% drew as a
   * full track, which reads as "all of it" for a slice that is barely half
   * watched. Any series on a fixed scale has to pin it.
   */
  scaleTo?: number
  /**
   * How the figure at the data end is written. `compactNumber` by default.
   *
   * A count and an average are not written the same way, and hard-coding the
   * count's format made a column of ratings read
   * "7.95 / 7.12 / 8.25 / 6 / 6 / 9.5 / 5" while the meta line beside each one
   * said "crowd 7.1". A caller that knows its series holds a score asks for one
   * decimal, and the tabular figures then line up as a column instead of as a
   * ragged edge.
   */
  formatValue?: (value: number) => string
}

export function BarList<T extends StatCount>({
  data,
  unit = '',
  emptyMessage = 'No data for this range.',
  onSelect,
  activeLabel = null,
  meta,
  scaleTo,
  formatValue = compactNumber,
}: BarListProps<T>) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-small text-dim">{emptyMessage}</p>
  }
  const max = scaleTo ?? Math.max(...data.map((d) => d.value), 1)

  return (
    <ul className="space-y-1">
      {data.map((entry, index) => {
        const active = activeLabel === entry.label
        const note = meta?.(entry) ?? null
        const row = (
          <>
            <span className="min-w-0 text-left" title={entry.label}>
              <span
                className={cn('block truncate text-control', active ? 'text-strong' : 'text-fg')}
              >
                {entry.label}
              </span>
              {note && <span className="block truncate text-tiny text-dim">{note}</span>}
            </span>
            {/* Track in `rail`, the family's colour for the unfilled part of
                anything. Radius 2 on the data end only, square at the origin. */}
            <div className="h-2.5 overflow-hidden rounded-r-[2px] bg-rail">
              <div
                className={cn(
                  'h-full rounded-r-[2px] bg-accent transition-opacity duration-hover ease-ease',
                  active ? 'opacity-100' : 'opacity-85',
                  // §8: a bar goes to 100% on hover, whether or not it leads
                  // anywhere. Gating this on `onSelect` meant the rows that only
                  // read stayed at 85% for ever, and the group class is on both
                  // wrappers for the same reason.
                  !active && 'group-hover/bar:opacity-100 group-focus-visible/bar:opacity-100',
                )}
                // A floor so a very small share is still a mark, but **zero
                // draws nothing**: the coverage bars include decades with no
                // watched titles at all, and a stub there says "a little" about
                // a row whose whole point is that the answer is none.
                style={{
                  width: entry.value > 0 ? `${Math.max(2, (entry.value / max) * 100)}%` : 0,
                }}
              />
            </div>
            {/* Direct label at the data end. */}
            <span className="figure text-right text-tiny text-strong">
              {formatValue(entry.value)}
              {unit}
            </span>
          </>
        )

        const layout = 'grid w-full grid-cols-[7.5rem_1fr_2.5rem] items-center gap-3 group/bar'
        return (
          <li key={entry.label}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(entry, index)}
                aria-pressed={active}
                aria-label={`${entry.label}: ${formatValue(entry.value)}${unit}${note ? `, ${note}` : ''}`}
                className={cn(layout, 'px-1.5 py-1', CLICKABLE_MARK)}
              >
                {row}
              </button>
            ) : (
              <div className={cn(layout, 'px-1.5 py-1')}>{row}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/* ── Columns ─────────────────────────────────────────────────────────────── */

interface ColumnChartProps<T extends StatCount> {
  data: T[]
  /**
   * Display text for the axis. The chart keeps the raw label as the entry's
   * identity, so `onSelect` still receives the bucket it was given: the monthly
   * chart shows "Aug" and hands back `2026-08`.
   */
  formatLabel?: (label: string) => string
  emptyMessage?: string
  /** Makes each column a button. Given the whole entry and its index. */
  onSelect?: SelectEntry<T>
  /** Tooltip/aria text for a column; falls back to "<label>: <value>". */
  describe?: (entry: T) => string
  /** Label of the column currently reflected elsewhere, e.g. an active filter. */
  activeLabel?: string | null
  /**
   * A second series drawn beside the first, **aligned by index**.
   *
   * By index and not by label, because the two series deliberately do not share
   * labels: the whole point of a comparison is that the second window is a
   * different stretch of calendar. The caller guarantees the two are the same
   * length and describe the same offsets, which is why the only caller builds
   * both windows from one resolved range rather than from two queries that
   * happen to look similar.
   */
  compare?: { data: T[]; describe?: (entry: T) => string; label?: string }
  /** What the primary series is called, in the tooltip's rows. */
  seriesLabel?: string
  /**
   * Fit every label to its column instead of letting the axis overflow.
   * Declares "this axis has more columns than a 10.5px label per column can
   * hold", and turns on both halves of the fix.
   *
   * The 24-hour profile is what this exists for, and it has been broken twice.
   * First it printed a label on every third column, so twenty-four bars sat
   * under eight numbers and nothing said which was which. Then it *thinned* the
   * labels to whatever the measured width could hold, leaving an empty span
   * under the unnamed columns, and an empty span has no line box, so those
   * columns lost their label row and their bars dropped into it.
   *
   * So nothing is dropped. Every column keeps its bar and its label; what gives
   * is the **type size**, computed from the measured column width and the
   * longest formatted label, down to a floor small enough for twenty-four
   * two-digit hours on a phone. Every column is `min-w-0`, so the text can
   * never widen one column at its neighbours' expense.
   */
  fitLabels?: boolean
}

export function ColumnChart<T extends StatCount>({
  data,
  formatLabel = (label) => label,
  emptyMessage = 'No data for this range.',
  onSelect,
  describe,
  activeLabel = null,
  compare,
  seriesLabel = 'Plays',
  fitLabels = false,
}: ColumnChartProps<T>) {
  // Only consulted when `fitLabels` is set, but hooks cannot be conditional.
  const [frame, available] = useMeasuredWidth<HTMLDivElement>()
  const [tip, setTip] = useState<ChartTip | null>(null)

  const total = data.reduce((sum, d) => sum + d.value, 0)
  const compareTotal = compare?.data.reduce((sum, d) => sum + d.value, 0) ?? 0
  const blank = total === 0 && compareTotal === 0

  // One scale across both series, or the comparison would be a lie.
  const peak = Math.max(...data.map((d) => d.value), ...(compare?.data ?? []).map((d) => d.value), 0)
  // Whether the axis may hold a fraction is a fact about the *series*, not about
  // its maximum: every chart drawn here counts plays or sittings, and a gridline
  // at 2.5 plays is not a number anybody would say out loud.
  const integers = [...data, ...(compare?.data ?? [])].every((entry) =>
    Number.isInteger(entry.value),
  )
  const { ceiling, ticks } = niceScale(peak, { integers })
  const gutter = yGutterFor(ticks)

  // Type size that lets the longest label fit inside one column. 320 stands in
  // for the first render, one frame before the observer answers: a plausible
  // phone width, so the axis is never briefly drawn larger than it can hold and
  // then snapped down. 0.62em per character is a fair average for tabular
  // digits in the UI face; the floor keeps a phone legible rather than
  // technically present.
  const gap = fitLabels ? 2 : 0
  const columnWidth =
    ((available || 320) - gutter - gap * (data.length - 1)) / Math.max(1, data.length)
  const longest = fitLabels
    ? data.reduce((n, entry) => Math.max(n, formatLabel(entry.label).length), 1)
    : 1
  const labelSize = fitLabels ? clamp(columnWidth / (0.62 * longest), 7, 10.5) : undefined

  const showTip = (event: React.MouseEvent<HTMLElement>, entry: T, earlier: T | undefined) => {
    const box = event.currentTarget.getBoundingClientRect()
    const parent = event.currentTarget.offsetParent?.getBoundingClientRect()
    setTip({
      ...tipPosition(box, parent),
      heading: formatLabel(entry.label),
      rows: compare
        ? [
            { label: seriesLabel, value: String(entry.value), swatch: 'bg-series-1' },
            { label: compare.label ?? 'Earlier', value: String(earlier?.value ?? 0), swatch: 'bg-series-2' },
          ]
        : [{ label: seriesLabel, value: String(entry.value) }],
    })
  }

  return (
    <div className="relative" ref={frame}>
      <div
        className="relative"
        style={{ height: PLOT_HEIGHT + AXIS_HEIGHT }}
        onMouseLeave={() => setTip(null)}
      >
        {/* The ground covers the plot only; the axis strip below it is clear,
            and the headroom above it is where the top figure goes. */}
        <div
          className="absolute inset-x-0"
          style={{ top: HEADROOM, bottom: AXIS_HEIGHT }}
        >
          <PlotGround ticks={ticks} ceiling={ceiling} />
          {blank && <PlotEmpty message={emptyMessage} />}
        </div>

        <div
          // `items-stretch` is load-bearing: the bars are sized as a percentage,
          // and a percentage height needs a parent with a definite height to
          // resolve against. `items-end` here makes each column shrink to its
          // content, which leaves every bar's wrapper zero-tall and every bar
          // computed to zero.
          className={cn(
            'relative flex h-full items-stretch',
            fitLabels ? 'gap-[2px]' : 'gap-1 sm:gap-2',
          )}
          style={{ paddingLeft: gutter }}
        >
          {data.map((entry, index) => {
            const height = (entry.value / ceiling) * 100
            const active = activeLabel === entry.label
            const earlier = compare?.data[index]
            const text = [
              describe?.(entry) ?? `${formatLabel(entry.label)}: ${entry.value}`,
              earlier && (compare?.describe?.(earlier) ?? `${earlier.label}: ${earlier.value}`),
            ]
              .filter(Boolean)
              .join(' · ')

            const bar = (
              <>
                <div
                  // The padding is what aligns a full-height bar with the top
                  // gridline: a percentage height resolves against the content
                  // box, so the bars measure the same span the ground draws.
                  className="flex w-full min-w-0 flex-1 items-end justify-center gap-[2px]"
                  style={{ paddingTop: HEADROOM, paddingBottom: 1 }}
                >
                  <div
                    // ≤24px thick; radius 2 at the data end, square at the
                    // baseline. A single series is the accent at 85%, rising to
                    // 100% when it is the one in hand.
                    className={cn(
                      'w-full rounded-t-[2px] transition-[height,opacity] duration-hover ease-ease',
                      compare ? 'max-w-[11px] bg-series-1' : 'max-w-[24px] bg-accent',
                      active || compare ? 'opacity-100' : 'opacity-85',
                      !compare &&
                        !active &&
                        'group-hover/col:opacity-100 group-focus-visible/col:opacity-100',
                    )}
                    style={{ height: `${Math.max(entry.value ? 2 : 0, height)}%` }}
                  />
                  {compare && (
                    <div
                      className="w-full max-w-[11px] rounded-t-[2px] bg-series-2
                                 transition-[height] duration-hover ease-ease"
                      style={{
                        height: `${Math.max(earlier?.value ? 2 : 0, ((earlier?.value ?? 0) / ceiling) * 100)}%`,
                      }}
                    />
                  )}
                </div>
                {/* One line-height for every label whatever its size, so a
                    scaled axis cannot make one column taller than its
                    neighbours. No ticks: §8 omits them. */}
                <span
                  className={cn(
                    'figure block w-full truncate text-center text-tiny leading-none',
                    active ? 'text-strong' : 'text-dim',
                  )}
                  style={{
                    height: AXIS_HEIGHT,
                    paddingTop: 6,
                    ...(labelSize ? { fontSize: `${labelSize}px` } : {}),
                  }}
                >
                  {formatLabel(entry.label)}
                </span>
              </>
            )

            // `group/col` on the shell rather than on the button branch alone: the
            // bar's hover brightening reads `group-hover/col`, so on the charts that
            // do not drill (the weekday and hour profiles) there was no group to
            // hover and the mark stayed at 85% for ever, while a drilling chart beside
            // it reached 100%. Same spec, two behaviours, for a reason a reader could
            // not possibly infer.
            const shell = 'group/col flex h-full min-w-0 flex-1 flex-col items-center'

            if (!onSelect) {
              return (
                <div
                  key={entry.label}
                  className={shell}
                  title={text}
                  onMouseEnter={(event) => showTip(event, entry, earlier)}
                >
                  {bar}
                </div>
              )
            }

            return (
              <button
                key={entry.label}
                type="button"
                // The whole column is the hit target, not just the drawn bar: a
                // short bar is only a few pixels tall and would be unclickable.
                className={cn(shell, CLICKABLE_MARK)}
                onClick={() => onSelect(entry, index)}
                onMouseEnter={(event) => showTip(event, entry, earlier)}
                title={text}
                aria-label={text}
                aria-pressed={active}
              >
                {bar}
              </button>
            )
          })}
        </div>
      </div>
      <TooltipBubble tip={tip} />
    </div>
  )
}

/* ── Stacked columns ─────────────────────────────────────────────────────── */

/** One column of a stacked chart: the parts, and whatever the caller hangs on. */
export interface StackedEntry extends StatCount {
  /** Bottom segment. */
  first: number
  /** Top segment. `value` must be `first + rewatch`, or the axis lies. */
  rewatch: number
}

interface StackedColumnChartProps<T extends StackedEntry> {
  data: T[]
  formatLabel?: (label: string) => string
  describe?: (entry: T) => string
  emptyMessage?: string
  onSelect?: SelectEntry<T>
  /** Names the two segments in the tooltip. */
  labels?: { first: string; rewatch: string }
}

/**
 * Two series stacked, not paired.
 *
 * Stacked because the parts genuinely sum to the whole here: a play is either a
 * first watch or a rewatch, never both, so the column's full height is the
 * period's plays and the split is read inside it. `ColumnChart`'s `compare`
 * draws its two side by side for the opposite reason: two *windows* do not add
 * up to anything, and stacking them would invent a total.
 *
 * Same mark spec as the other columns: ≤24px thick, radius 2 at the data end
 * only, square at the baseline, and a 2px gap between the segments so the
 * boundary is not carried by colour alone.
 */
export function StackedColumnChart<T extends StackedEntry>({
  data,
  formatLabel = (label) => label,
  describe,
  emptyMessage = 'No data for this range.',
  onSelect,
  labels = { first: 'First watch', rewatch: 'Rewatch' },
}: StackedColumnChartProps<T>) {
  const [tip, setTip] = useState<ChartTip | null>(null)
  const total = data.reduce((sum, entry) => sum + entry.value, 0)
  // Plays, split two ways: whole numbers on both halves and therefore on the axis.
  const integers = data.every(
    (entry) => Number.isInteger(entry.first) && Number.isInteger(entry.rewatch),
  )
  const { ceiling, ticks } = niceScale(Math.max(...data.map((entry) => entry.value), 0), {
    integers,
  })
  const gutter = yGutterFor(ticks)

  const showTip = (event: React.MouseEvent<HTMLElement>, entry: T) => {
    const box = event.currentTarget.getBoundingClientRect()
    const parent = event.currentTarget.offsetParent?.getBoundingClientRect()
    setTip({
      ...tipPosition(box, parent),
      heading: formatLabel(entry.label),
      rows: [
        { label: labels.first, value: String(entry.first), swatch: 'bg-series-1' },
        { label: labels.rewatch, value: String(entry.rewatch), swatch: 'bg-series-2' },
      ],
    })
  }

  return (
    <div className="relative">
      <div
        className="relative"
        style={{ height: PLOT_HEIGHT + AXIS_HEIGHT }}
        onMouseLeave={() => setTip(null)}
      >
        <div className="absolute inset-x-0" style={{ top: HEADROOM, bottom: AXIS_HEIGHT }}>
          <PlotGround ticks={ticks} ceiling={ceiling} />
          {total === 0 && <PlotEmpty message={emptyMessage} />}
        </div>

        <div
          className="relative flex h-full items-stretch gap-1 sm:gap-2"
          style={{ paddingLeft: gutter }}
        >
          {data.map((entry, index) => {
            const text =
              describe?.(entry) ??
              `${formatLabel(entry.label)}: ${entry.first} first watches, ${entry.rewatch} rewatches`
            const share = (part: number) => (part / ceiling) * 100
            const bar = (
              <>
                <div
                  className={cn(
                    'flex w-full min-w-0 flex-1 flex-col justify-end',
                    // The 2px gap separates two segments. With only one of them
                    // drawn there is nothing to separate, and the gap then sat
                    // *under* the surviving segment: a period of pure rewatches
                    // floated 3px clear of the baseline, which every other mark
                    // on the page sits exactly on.
                    entry.first > 0 && entry.rewatch > 0 && 'gap-[2px]',
                  )}
                  style={{ paddingTop: HEADROOM, paddingBottom: 1 }}
                >
                  {/* Top segment first in the DOM: it is the top of the stack. */}
                  <div
                    className="w-full max-w-[24px] self-center rounded-t-[2px] bg-series-2
                               transition-[height] duration-hover ease-ease"
                    style={{ height: `${Math.max(entry.rewatch ? 2 : 0, share(entry.rewatch))}%` }}
                  />
                  <div
                    className={cn(
                      'w-full max-w-[24px] self-center bg-series-1',
                      'transition-[height] duration-hover ease-ease',
                      // Rounded on top only when it *is* the data end: with a
                      // rewatch segment above it, its top is an internal edge.
                      entry.rewatch ? '' : 'rounded-t-[2px]',
                    )}
                    style={{ height: `${Math.max(entry.first ? 2 : 0, share(entry.first))}%` }}
                  />
                </div>
                <span
                  className="figure block w-full truncate text-center text-tiny leading-none text-dim"
                  style={{ height: AXIS_HEIGHT, paddingTop: 6 }}
                >
                  {formatLabel(entry.label)}
                </span>
              </>
            )

            // `group/col` on both branches, as in `ColumnChart`: a hover state that
            // only a clickable mark can reach is the same spec behaving two ways.
            const shell = 'group/col flex h-full min-w-0 flex-1 flex-col items-center'
            if (!onSelect) {
              return (
                <div
                  key={entry.label}
                  className={shell}
                  title={text}
                  onMouseEnter={(event) => showTip(event, entry)}
                >
                  {bar}
                </div>
              )
            }
            return (
              <button
                key={entry.label}
                type="button"
                className={cn(shell, CLICKABLE_MARK)}
                onClick={() => onSelect(entry, index)}
                onMouseEnter={(event) => showTip(event, entry)}
                title={text}
                aria-label={text}
              >
                {bar}
              </button>
            )
          })}
        </div>
      </div>
      <TooltipBubble tip={tip} />
    </div>
  )
}

/* ── Calendar heatmap ────────────────────────────────────────────────────── */

interface HeatmapProps {
  data: StatCount[]
  weeks?: number
  /**
   * Drill into one day. Given the local `YYYY-MM-DD` key and its count.
   *
   * A **secondary** way in, never the only one. A cell is a few pixels square,
   * a fraction of the 44px a finger needs, and putting 180 of them in the tab
   * order would bury every control after the chart. So the cells take a click
   * for the pointer users who will try it, stay out of the tab order, and the
   * page pairs this chart with a ranked list of the same days as real buttons.
   * That list, not this, is the route a keyboard or a thumb takes.
   */
  onSelect?: (dateKey: string, value: number) => void
}

/** Steps in the sequential ramp. The colours are `--heat-1..5`. */
const HEAT_STEPS = 5

/**
 * Which step of the ramp a value sits on, or -1 for "nothing at all".
 *
 * Absence is deliberately *not* the lowest step: a day with no plays and a day
 * with one are different kinds of fact, and colouring them the same removes the
 * only thing the shape is for. Callers paint -1 with `control` instead, which
 * is what §8 asks for.
 */
function heatLevel(value: number, max: number): number {
  if (value <= 0) return -1
  return Math.min(HEAT_STEPS - 1, Math.floor((value / Math.max(max, 1)) * HEAT_STEPS))
}

/**
 * The key for the sequential ramp, shared by every chart that uses it.
 *
 * One definition so the calendar heatmap and the matrix charts cannot drift
 * apart: a reader who has learned the scale on one has learned it on all of
 * them, and there is one place to change if the ramp ever changes.
 *
 * "None" is a swatch of its own, set apart from the ramp by a gap, because it
 * is a different kind of answer rather than the bottom of the scale.
 *
 * **Same 8px swatch as `ChartLegend`**, because a reader meeting both on one
 * page reads them as one device and two sizes says they are two. It sits
 * **below** its chart where §8's series legend sits above at the right, and that
 * difference is deliberate: a legend names which mark is which and has to be
 * read before the chart, while a ramp is a scale, read off a shape already
 * looked at. Seven swatches and three words would also crowd the panel header
 * out of the title it exists to carry, and the heat charts are the two on this
 * page whose header the title already fills.
 *
 * Not exported: both callers are in this file, and a key without a ramp beside
 * it is not a thing another page should be able to draw.
 */
function HeatScale({ less = 'Less', more = 'More' }: { less?: string; more?: string }) {
  return (
    <div className="mt-3 flex items-center justify-end gap-1.5 text-tiny text-dim">
      <span>None</span>
      <span className="h-2 w-2 rounded-[2px] bg-control" />
      <span className="ml-2">{less}</span>
      {HEAT_BG.map((step) => (
        <span key={step} className={cn('h-2 w-2 rounded-[2px]', step)} />
      ))}
      <span>{more}</span>
    </div>
  )
}

/**
 * How small and how large a heatmap cell may get.
 *
 * The floor is where a square stops reading as a value and starts reading as
 * noise; below it the chart scrolls instead of shrinking further. The ceiling
 * is what stops a fortnight of history rendering as a row of tiles the size of
 * buttons: a short window genuinely cannot fill a wide card, and stretching to
 * fill it anyway would make two weeks look like a year's worth of data.
 */
const HEAT_CELL_MIN = 9
const HEAT_CELL_MAX = 24

export function ActivityHeatmap({ data, weeks = 26, onSelect }: HeatmapProps) {
  const [tip, setTip] = useState<ChartTip | null>(null)
  // Measured on the outer box rather than on the scroller, so the SVG's own
  // width can never feed back into the number it is derived from.
  const [frame, available] = useMeasuredWidth<HTMLDivElement>()

  const byDate = new Map(data.map((d) => [d.label, d.value]))
  const max = Math.max(...data.map((d) => d.value), 1)

  // Build columns of 7 days ending today, starting on a Sunday.
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const end = new Date(today)
  end.setDate(end.getDate() + (6 - end.getDay()))
  const start = new Date(end)
  start.setDate(start.getDate() - weeks * 7 + 1)

  const columns: Array<Array<{ date: Date; value: number; future: boolean }>> = []
  const cursor = new Date(start)
  for (let week = 0; week < weeks; week += 1) {
    const column: Array<{ date: Date; value: number; future: boolean }> = []
    for (let day = 0; day < 7; day += 1) {
      // Local key, not toISOString(): `cursor` is a local midnight, and the UTC
      // conversion shifted every lookup a day earlier east of Greenwich.
      const iso = localDateKey(cursor)
      column.push({
        date: new Date(cursor),
        value: byDate.get(iso) ?? 0,
        future: cursor > today,
      })
      cursor.setDate(cursor.getDate() + 1)
    }
    columns.push(column)
  }

  const monthLabels: Array<{ index: number; label: string }> = []
  let lastMonth = -1
  columns.forEach((column, index) => {
    const month = column[0].date.getMonth()
    if (month !== lastMonth) {
      monthLabels.push({
        index,
        label: column[0].date.toLocaleDateString(undefined, { month: 'short' }),
      })
      lastMonth = month
    }
  })

  const gap = 3
  // Sized to the box rather than fixed. A fixed cell meant 26 columns claimed
  // exactly 416px however wide the card was, which is what made this read as a
  // chart that had not finished loading. The fallback before the first
  // measurement keeps a server render or a test runner drawing something sane.
  const cell = available
    ? clamp(Math.floor(available / columns.length) - gap, HEAT_CELL_MIN, HEAT_CELL_MAX)
    : 13
  const width = columns.length * (cell + gap)
  const height = 7 * (cell + gap) + 18

  /*
   * A month is named only where its name fits.
   *
   * The label is drawn at the left edge of the month's first column, and a month
   * that owns one or two columns therefore starts before its neighbour's name has
   * ended. Measured at 390px: "Aug" ran to 18.5 while "Sept" began at 12 — a
   * 6.5px overlap that renders as a pile of glyphs, not as two words — and even
   * at 1440px the pair cleared each other by 3.5px. The 10.5px mono face made it
   * worse than the 10px sans it replaced, by about 2.5px a label.
   *
   * So a name that cannot start clear of the previous one is dropped rather than
   * shifted: shifting it would point at a column that is not where that month
   * begins, which is worse than an unnamed band on an axis whose bands are three
   * days apart anyway.
   */
  const monthLabelGap = 4
  let nameableFrom = -Infinity
  const drawnMonths = monthLabels.filter(({ index, label }) => {
    const x = index * (cell + gap)
    if (x < nameableFrom) return false
    nameableFrom = x + label.length * FIGURE_CHAR + monthLabelGap
    return true
  })

  return (
    <div className="relative" ref={frame}>
      <div className="scroll-x pb-1">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Watch activity by day"
          className="block"
        >
          {drawnMonths.map(({ index, label }) => (
            <text
              key={`${label}-${index}`}
              x={index * (cell + gap)}
              y={10}
              // The axis label spec: 10.5px mono, tabular, `text-dim`.
              className="fill-dim font-mono text-tiny [font-variant-numeric:tabular-nums]"
            >
              {label}
            </text>
          ))}
          {columns.map((column, columnIndex) =>
            column.map((day, dayIndex) => {
              if (day.future) return null
              const tier = heatLevel(day.value, max)
              const dayLabel = day.date.toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              })
              const valueLabel =
                day.value === 0
                  ? 'Nothing watched'
                  : `${day.value} ${day.value === 1 ? 'play' : 'plays'}`
              return (
                <rect
                  key={`${columnIndex}-${dayIndex}`}
                  x={columnIndex * (cell + gap)}
                  y={18 + dayIndex * (cell + gap)}
                  width={cell}
                  height={cell}
                  rx={2}
                  className={cn(
                    // Zero is `control`, never the ramp's lowest step.
                    tier < 0 ? 'fill-control' : HEAT_FILL[tier],
                    'transition-opacity duration-hover hover:opacity-80',
                    // The mark's own affordance. A rect cannot take
                    // `CLICKABLE_MARK` (there is no background to raise), so it
                    // says the same thing with an accent outline, which is also
                    // the only treatment legible on a 13px square.
                    onSelect &&
                      day.value > 0 &&
                      'cursor-pointer stroke-2 stroke-transparent hover:stroke-accent',
                  )}
                  onClick={
                    onSelect && day.value > 0
                      ? () => onSelect(localDateKey(day.date), day.value)
                      : undefined
                  }
                  onMouseEnter={(event) => {
                    const box = event.currentTarget.getBoundingClientRect()
                    const parent =
                      event.currentTarget.ownerSVGElement?.parentElement?.parentElement?.getBoundingClientRect()
                    setTip({
                      ...tipPosition(box, parent),
                      heading: dayLabel,
                      rows: [{ label: 'Plays', value: day.value === 0 ? '0' : String(day.value) }],
                    })
                  }}
                  onMouseLeave={() => setTip(null)}
                >
                  {/* Native tooltip, so the value is reachable without a mouse:
                      the rects carry only mouse handlers. */}
                  <title>{`${dayLabel}: ${valueLabel}`}</title>
                </rect>
              )
            }),
          )}
        </svg>
      </div>

      <HeatScale />

      <TooltipBubble tip={tip} />
    </div>
  )
}

/* ── Matrix ──────────────────────────────────────────────────────────────── */

export interface MatrixChartProps {
  /** Row headers, top to bottom. Weekdays for a punch card, years for seasonality. */
  rows: string[]
  /** Column headers, left to right. Hours, or months. */
  columns: string[]
  /** `values[row][column]`, the same shape as `rows` × `columns`. */
  values: number[][]
  /**
   * The largest cell, for scaling the ramp.
   *
   * Taken from the caller rather than computed, because the server already
   * knows it (`punch_card.max_plays`) and because two matrices drawn from the
   * same data must be able to share one scale on purpose.
   */
  max?: number
  /** Full sentence for one cell: the tooltip, the accessible name, the title. */
  describe: (row: number, column: number, value: number) => string
  /**
   * Drill into one cell. Only pass this where the cell names a window the
   * destination can actually express; see `lib/drill-links.ts`. Omitted, the
   * cells stay readable and keyboard-reachable but do not pretend to lead
   * anywhere.
   */
  onSelect?: (row: number, column: number, value: number) => void
  /** Print only every nth column header, for 24 hours on a phone. */
  columnLabelEvery?: number
  /** Sizes the square. 14px reads at 24 columns; smaller gets muddy. */
  cell?: number
  emptyMessage?: string
}

/**
 * A grid of value-shaded squares: weekday × hour, or year × month.
 *
 * **Why one primitive for both.** The punch card and the seasonality years grid
 * are the same figure, a categorical row axis, a cyclic column axis, one count
 * per pair, and drawing them twice would be two ramps, two keyboard models and
 * two sets of labels to keep honest.
 *
 * **Why HTML and not SVG**, unlike the calendar heatmap. The marks have to be
 * operable: a cell needs an accessible name, a focus ring and (for seasonality)
 * a click that navigates. `ActivityHeatmap` is SVG and pays for it: its cells
 * carry mouse handlers only, so it has to be paired with a separate list of
 * real buttons to be reachable at all. 168 cells cannot be paired with a list,
 * so they are real elements from the start.
 *
 * **One tab stop, not 168.** The grid is a roving-tabindex `role="grid"`: Tab
 * enters it once and the arrow keys, Home and End move within it.
 *
 * Colour is the shared sequential ramp, and an empty cell is `control` rather
 * than the ramp's lowest step.
 */
export function MatrixChart({
  rows,
  columns,
  values,
  max,
  describe,
  onSelect,
  columnLabelEvery = 1,
  cell = 14,
  emptyMessage = 'No data for this range.',
}: MatrixChartProps) {
  // The cell the arrow keys are currently on. Clamped on every render rather
  // than reset, so a data change cannot leave focus pointing off the grid.
  const [cursor, setCursor] = useState<[number, number]>([0, 0])
  const [moved, setMoved] = useState(false)
  const cells = useRef(new Map<string, HTMLElement>())

  const rowCount = rows.length
  const columnCount = columns.length
  const row = Math.min(cursor[0], Math.max(0, rowCount - 1))
  const column = Math.min(cursor[1], Math.max(0, columnCount - 1))

  useEffect(() => {
    // Only after a key moved the cursor: focusing on mount would yank the page
    // to the chart, and focusing on a re-render would steal it back mid-scroll.
    if (moved) cells.current.get(`${row}-${column}`)?.focus()
  }, [moved, row, column])

  const ceiling = max ?? Math.max(...values.flat(), 1)
  const total = values.reduce((sum, line) => sum + line.reduce((a, b) => a + b, 0), 0)
  if (rowCount === 0 || columnCount === 0 || total === 0) {
    return <p className="py-8 text-center text-small text-dim">{emptyMessage}</p>
  }

  const gap = 3
  const move = (event: React.KeyboardEvent) => {
    const keys: Record<string, [number, number]> = {
      ArrowLeft: [row, column - 1],
      ArrowRight: [row, column + 1],
      ArrowUp: [row - 1, column],
      ArrowDown: [row + 1, column],
      Home: [row, 0],
      End: [row, columnCount - 1],
    }
    const next = keys[event.key]
    if (!next) return
    event.preventDefault()
    setMoved(true)
    setCursor([
      Math.max(0, Math.min(rowCount - 1, next[0])),
      Math.max(0, Math.min(columnCount - 1, next[1])),
    ])
  }

  const label = (rowIndex: number, columnIndex: number) =>
    describe(rowIndex, columnIndex, values[rowIndex]?.[columnIndex] ?? 0)

  return (
    <div>
      {/*
        Scrolls when it cannot fit, **stretches when it can**, and neither needs
        measuring: `minmax(cell, 1fr)` is a floor and a share at once, so the
        tracks grow to fill a wide card and refuse to shrink past legible on a
        narrow one, at which point this scroller takes over and the page body
        still never scrolls sideways.

        The cells become rectangles on a wide box, which is fine and deliberate:
        the ramp is read by colour and the row is read across. Only the *height*
        is a fixed square-ish size.
      */}
      <div className="scroll-x pb-1">
        <div
          role="grid"
          aria-label="Values by row and column"
          onKeyDown={move}
          className="grid w-full"
          style={{
            gridTemplateColumns: `auto repeat(${columnCount}, minmax(${cell}px, 1fr))`,
            gap: `${gap}px`,
          }}
        >
          {/* Corner, then the column headers. */}
          <div aria-hidden="true" />
          {columns.map((name, index) => (
            <div
              key={name}
              role="columnheader"
              className="figure overflow-hidden text-center text-tiny leading-none text-dim"
            >
              {index % columnLabelEvery === 0 ? name : ''}
            </div>
          ))}

          {rows.map((name, rowIndex) => (
            <div key={name} role="row" className="contents">
              <div
                role="rowheader"
                className="figure pr-2 text-right text-tiny leading-none text-dim"
                style={{ lineHeight: `${cell}px` }}
              >
                {name}
              </div>
              {columns.map((_, columnIndex) => {
                const value = values[rowIndex]?.[columnIndex] ?? 0
                const tier = heatLevel(value, ceiling)
                const focusable = rowIndex === row && columnIndex === column
                const text = label(rowIndex, columnIndex)
                // A cell with no plays leads nowhere, exactly as in the calendar
                // heatmap: the year-by-month grid draws every month of the current
                // year, so September 2026 was a button that navigated to a history
                // page with no rows in it. An empty cell stays readable and
                // keyboard-reachable; it simply does not pretend to be a route.
                const clickable = onSelect !== undefined && value > 0
                const shared = {
                  ref: (node: HTMLElement | null) => {
                    if (node) cells.current.set(`${rowIndex}-${columnIndex}`, node)
                    else cells.current.delete(`${rowIndex}-${columnIndex}`)
                  },
                  role: 'gridcell',
                  tabIndex: focusable ? 0 : -1,
                  'aria-label': text,
                  title: text,
                  onFocus: () => setCursor([rowIndex, columnIndex]),
                  className: cn(
                    'rounded-[2px] transition-opacity duration-hover hover:opacity-80',
                    // Zero is `control`, never the ramp's lowest step.
                    tier < 0 ? 'bg-control' : HEAT_BG[tier],
                    // A ring rather than `CLICKABLE_MARK`'s raised background:
                    // the cell *is* its background, so raising it would erase
                    // the value. Same accent, same statement.
                    clickable && 'cursor-pointer hover:ring-1 hover:ring-accent',
                  ),
                  style: {
                    // Width comes from the grid track, so the cell can stretch;
                    // the height is what keeps the ramp reading as a grid.
                    height: cell,
                  },
                }
                return clickable ? (
                  <button
                    key={columnIndex}
                    type="button"
                    {...shared}
                    ref={shared.ref as (node: HTMLButtonElement | null) => void}
                    onClick={() => onSelect?.(rowIndex, columnIndex, value)}
                  />
                ) : (
                  <div
                    key={columnIndex}
                    {...shared}
                    ref={shared.ref as (node: HTMLDivElement | null) => void}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>
      <HeatScale />
    </div>
  )
}

/* ── Table fallbacks ─────────────────────────────────────────────────────── */

/**
 * The disclosure every table fallback hangs off, so they all read as the same
 * control rather than as several near-misses.
 */
function TableDisclosure({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-4">
      <summary
        className="cursor-pointer list-none text-tiny text-dim transition-colors
                   duration-hover ease-ease hover:text-strong"
      >
        View as table
      </summary>
      <div className="scroll-x mt-2">{children}</div>
    </details>
  )
}

/**
 * A matrix as a table. The `DataTable` fallback cannot be one, since that is
 * one value per label and this is one per pair.
 *
 * §7.16: header row in `text-dim` at 10.5px and not shouted, figures
 * right-aligned and mono, a `line-soft` hairline between rows, no zebra
 * striping and no vertical rules.
 */
export function MatrixTable({
  caption,
  rows,
  columns,
  values,
  rowHeader = 'Row',
}: {
  caption: string
  rows: string[]
  columns: string[]
  values: number[][]
  rowHeader?: string
}) {
  if (rows.length === 0 || columns.length === 0) return null
  return (
    <TableDisclosure>
      <table className="w-full text-left text-control">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-tiny text-dim">
            <th scope="col" className="py-1.5 pr-3 font-normal">
              {rowHeader}
            </th>
            {columns.map((name) => (
              <th key={name} scope="col" className="px-1.5 py-1.5 text-right font-normal">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((name, rowIndex) => (
            <tr key={name} className="border-b border-line-soft last:border-0">
              <th scope="row" className="py-1.5 pr-3 text-left font-normal text-fg">
                {name}
              </th>
              {columns.map((column, columnIndex) => (
                <td key={column} className="figure px-1.5 py-1.5 text-right text-strong">
                  {values[rowIndex]?.[columnIndex] ?? 0}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableDisclosure>
  )
}

/**
 * Accessible fallback for every chart: the same numbers as a table, so nothing
 * is gated behind colour or hover.
 */
export function DataTable({
  caption,
  rows,
  valueHeader = 'Count',
  compare,
  formatValue = (value) => value.toLocaleString(),
}: {
  caption: string
  rows: StatCount[]
  valueHeader?: string
  /**
   * How a figure is written. Grouped digits by default.
   *
   * The same reason `BarList` takes one: a table of average scores set with the
   * count's formatting reads "7.95 / 6 / 9.5", and a fallback that disagrees with
   * the chart it stands in for is a second version of the truth.
   */
  formatValue?: (value: number) => string
  /**
   * A second column of the same shape, for a two-series chart.
   *
   * Aligned by index, exactly as `ColumnChart`'s `compare` is and for the same
   * reason (the two windows do not share labels), so `rowLabel` gets to say
   * what the earlier row was called. Without this a comparison chart would have
   * a fallback that showed only half of what was drawn, which is not a
   * fallback.
   */
  compare?: { header: string; rows: StatCount[]; rowLabel?: (row: StatCount) => string }
}) {
  if (rows.length === 0) return null
  return (
    <TableDisclosure>
      <table className="w-full text-left text-control">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-tiny text-dim">
            <th scope="col" className="py-1.5 pr-4 font-normal">
              Label
            </th>
            <th scope="col" className="py-1.5 text-right font-normal">
              {valueHeader}
            </th>
            {compare && (
              <th scope="col" className="py-1.5 pl-4 text-right font-normal">
                {compare.header}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const earlier = compare?.rows[index]
            return (
              <tr key={row.label} className="border-b border-line-soft last:border-0">
                <td className="py-1.5 pr-4 text-fg">{row.label}</td>
                <td className="figure py-1.5 text-right text-strong">
                  {formatValue(row.value)}
                </td>
                {compare && (
                  <td className="figure py-1.5 pl-4 text-right text-fg">
                    {earlier ? (
                      <>
                        {formatValue(earlier.value)}
                        {compare.rowLabel && (
                          <span className="ml-1 font-sans text-tiny text-dim">
                            ({compare.rowLabel(earlier)})
                          </span>
                        )}
                      </>
                    ) : (
                      /* An en dash for "no data", never a zero. */
                      <span className="text-dim">–</span>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </TableDisclosure>
  )
}

/* ── Ranked rows with artwork ────────────────────────────────────────────── */

export interface RankedRow {
  key: string | number
  title: string
  /** Second line: an episode's series, a film's year. */
  subtitle?: string | null
  posterUrl: string | null
  value: number
  /**
   * What to print in place of the bare count, and what to say instead of
   * "<value> <unit>s" in the accessible name.
   *
   * The bar still scales on `value`, so the ranking keeps its shape: a list of
   * hours ranks on minutes and reads "14h", and a list of disagreements ranks
   * on the size of the gap and reads "+2.5". Without this the two would have to
   * choose between a sortable number and a legible one.
   */
  valueLabel?: string
  /** Right-hand caption under the figure: "since 2019". */
  meta?: string | null
  /** Where the row goes. A row without one is read-only rather than a dead link. */
  to?: string
}

/**
 * A ranked list whose rows carry artwork.
 *
 * Deliberately **not** `BarList`. That component's label column is a fixed
 * 7.5rem and its row is one line, which is right for "Sci-Fi & Fantasy: 412"
 * and wrong for a title: "The Lord of the Rings: The Fellowship of the Ring"
 * truncates to three words, there is nowhere to put the year, and nothing to
 * tell two episodes of the same series apart. These rows are also a route to a
 * *title* rather than to a filtered view, so the poster is the thing a reader
 * actually recognises them by.
 *
 * The bar is kept, as a 3px rail behind the count, so the ranking is still a
 * shape and not only an ordering.
 */
export function RankedList({
  rows,
  unit,
  emptyMessage = 'Nothing yet.',
}: {
  rows: RankedRow[]
  /** Singular unit for the accessible name: "play" gives "12 plays". */
  unit: string
  emptyMessage?: string
}) {
  if (rows.length === 0) {
    return <p className="py-8 text-center text-small text-dim">{emptyMessage}</p>
  }
  const max = Math.max(...rows.map((row) => row.value), 1)

  return (
    <ol>
      {rows.map((row, index) => {
        const figure = row.valueLabel ?? `${row.value} ${row.value === 1 ? unit : `${unit}s`}`
        const name = `${row.title}${row.subtitle ? `, ${row.subtitle}` : ''}: ${figure}${
          row.meta ? `, ${row.meta}` : ''
        }`
        const body = (
          <>
            <span className="figure w-4 shrink-0 text-right text-tiny text-dim">{index + 1}</span>
            <Artwork
              src={row.posterUrl}
              title={row.title}
              showTitle={false}
              className="h-9 w-6 shrink-0 rounded-[3px]"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-control text-strong">{row.title}</span>
              {row.subtitle && (
                <span className="block truncate text-tiny text-dim">{row.subtitle}</span>
              )}
            </span>
            {/*
              The bar is a shape for the ranking, never the only statement of
              the number: that is spelled out beside it.

              A fixed 64px track beside the figure rather than a full-width one
              under the title, and that was measured. Stretched across the row a
              3px rail is indistinguishable from a hairline separator, and a
              list where every row holds the same value drew four full-width
              rails that read as ruled lines rather than as a ranking at all.
            */}
            <span
              className="hidden h-[3px] w-16 shrink-0 overflow-hidden rounded-full bg-rail sm:block"
              aria-hidden="true"
            >
              <span
                className="block h-full rounded-full bg-accent opacity-85"
                style={{ width: `${Math.max(4, (row.value / max) * 100)}%` }}
              />
            </span>
            {/* Sized to its own content rather than to a fixed column: the
                caption under the figure runs from "since 2019" to "first seen
                30 Nov 2025", and a fixed width wrapped the long ones onto two
                lines in a row that is already two lines tall. */}
            <span className="shrink-0 whitespace-nowrap text-right">
              <span className="figure block text-control text-strong">
                {row.valueLabel ?? compactNumber(row.value)}
              </span>
              {row.meta && <span className="block text-tiny text-dim">{row.meta}</span>}
            </span>
          </>
        )
        const layout = 'flex w-full items-center gap-2.5 rounded-ctl px-1.5 py-1'
        return (
          <li key={row.key}>
            {row.to ? (
              <Link
                to={row.to}
                aria-label={name}
                className={cn(
                  layout,
                  'transition-colors duration-hover ease-ease hover:bg-control-hover',
                )}
              >
                {body}
              </Link>
            ) : (
              <div className={layout}>{body}</div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/* ── Stat tiles ──────────────────────────────────────────────────────────── */

/**
 * How this figure moved against the window it is being compared with.
 *
 * `pct` is null when the earlier window held nothing of this metric: "up from
 * nothing" has no percentage, so the tile falls back to naming the raw earlier
 * value instead of inventing an infinity.
 */
export interface StatDelta {
  pct: number | null
  /** The earlier figure, already formatted. */
  previous: string
  /** What it is being compared with: "vs. the previous 90 days". */
  against: string
}

/**
 * Direction, in the sign and in words.
 *
 * Deliberately *not* coloured green and red. Those two colours would assert
 * that watching more is good and watching less is bad, which this app has no
 * business claiming: a quiet month is not a regression. Semantic colour marks
 * state, and this is not state.
 *
 * The direction is carried by the **written sign** rather than by an arrow.
 * Archivo has no arrow glyph, and a Unicode arrow used as an icon is exactly
 * what §11 rules out; a signed figure says the same thing, in the mono face
 * every other figure on this page is set in.
 */
function DeltaLine({ delta }: { delta: StatDelta }) {
  const direction = delta.pct == null ? 0 : Math.sign(delta.pct)
  // Five tiles across leaves about 140px of text, so the phrase naming the
  // comparison window lives in the title and in the accessible name instead.
  // The control that turned the comparison on is at the top of the page and
  // says it once.
  // A negative percentage already carries its sign; only a rise needs one, and
  // no movement at all is written plainly rather than as a "±0%" that looks
  // like a tolerance.
  const signed = delta.pct == null ? null : `${direction > 0 ? '+' : ''}${delta.pct}%`
  const full =
    delta.pct == null
      ? `was ${delta.previous} ${delta.against}`
      : `${direction > 0 ? 'up' : direction < 0 ? 'down' : 'unchanged at'} ${Math.abs(delta.pct)}%, was ${delta.previous} ${delta.against}`
  return (
    <span className="mt-0.5 block truncate text-tiny text-dim" title={full}>
      <span className="sr-only">{full}</span>
      <span aria-hidden="true">
        {signed && <span className="figure">{signed}</span>}
        {signed && ' · '}
        was <span className="figure">{delta.previous}</span>
      </span>
    </span>
  )
}

/**
 * The tile's optional shape: where this figure has been over the window.
 *
 * §8's sparkline exactly: 48 by 16, the accent line at 1.25px, an area fill at
 * `--area-alpha` fading to nothing at the baseline, an endpoint dot, and
 * nothing else. No axes, no labels, no scale of its own, so it says "rising",
 * "spiky", "flat" and nothing a reader could misread as a value.
 *
 * It is **redundant** by construction: the figure above it and the delta below
 * it carry every number, so the tile loses nothing without it. That is why it
 * is `aria-hidden` rather than given a name repeating what is already read out.
 *
 * A single point cannot be a trend, so fewer than two is drawn as nothing.
 */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null
  const width = 48
  const height = 16
  const max = Math.max(...points, 1)
  const step = width / (points.length - 1)
  // A 1px inset top and bottom so a flat maximum is not clipped by the edge.
  const at = (value: number, index: number) => ({
    x: index * step,
    y: height - 1 - (value / max) * (height - 2),
  })
  const path = points
    .map((value, index) => {
      const { x, y } = at(value, index)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const last = at(points[points.length - 1], points.length - 1)
  // Unique per instance, because two sparklines on one page would otherwise
  // share a gradient id and the second would silently take the first's.
  const gradient = `spark-${points.length}-${Math.round(max)}-${Math.round(last.y * 10)}`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          {/* The one gradient the family allows: the accent fading to nothing
              at the baseline. Both stops name the token, so the fill follows a
              theme change with nothing to re-read. */}
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="var(--area-alpha)" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path} L${width},${height} L0,${height} Z`} fill={`url(#${gradient})`} />
      <path
        d={path}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last.x} cy={last.y} r={2} fill="var(--accent)" />
    </svg>
  )
}

/**
 * The numbers inside a hint sentence, set in the figure face.
 *
 * §4: every number read as a value is mono and tabular, and a tile's second line
 * is full of them — "19% of your plays", "83 plays", "Of 737 plays". They were
 * sans while `DeltaLine` directly below wrapped its own figures in mono, so one
 * tile held two treatments of the same kind of number.
 *
 * Done here rather than at the 35 call sites because a rule applied by hand is a
 * rule with exceptions: the split keeps the digit runs (with a trailing `%`, a
 * decimal point, a thousands separator or a colon) and leaves the words alone.
 */
const FIGURE_RUN = /(\d[\d.,:]*%?)/g

function withFigures(text: string) {
  // A capture group makes `split` alternate text, match, text, match — so the
  // odd indices are exactly the numbers, with no second pass over the pattern
  // and no `lastIndex` to reset.
  return text.split(FIGURE_RUN).map((part, index) =>
    index % 2 === 1 ? (
      <span key={index} className="figure">
        {part}
      </span>
    ) : (
      part
    ),
  )
}

interface StatTileProps {
  label: string
  /** Null, or an empty string, draws the en dash that means "no data". */
  value: string | null
  /** A sentence under the figure. Its numbers are set in mono; see `withFigures`. */
  hint?: string
  /** Movement against a comparison window, when one is being shown. */
  delta?: StatDelta
  /**
   * Where this figure has been, as a sparkline beside it. Optional and off by
   * default. Purely supplementary; see `Sparkline`.
   */
  trend?: number[]
  /** Makes the whole tile a link. A tile is well past 44px, so this is a real target. */
  to?: string
  /** Required with `to`: what the destination is, for a screen reader. */
  toLabel?: string
  /**
   * How many columns of the tile grid this one takes, once the grid has more
   * than one. Two is for the figure a grid leads with; the figure itself stays
   * the same 24px, so this buys width for a longer value and a fuller second
   * line, never a bigger number.
   */
  span?: 1 | 2
}

/**
 * A stat, composed from `ui.tsx`'s `Tile` rather than drawn again here.
 *
 * The tile owns the geometry (§7.14: eyebrow, a 24px mono figure, a second
 * line, an optional trailing sparkline); this wrapper owns what the stats and
 * dashboard pages need on top of it, which is the delta line, the sparkline
 * itself and the link.
 */
export function StatTile({ label, value, hint, delta, trend, to, toLabel, span }: StatTileProps) {
  const detail =
    hint || delta ? (
      <>
        {hint && <span className="block truncate">{withFigures(hint)}</span>}
        {delta && <DeltaLine delta={delta} />}
      </>
    ) : undefined

  const tile = (
    <Tile
      eyebrow={label}
      value={value}
      detail={detail}
      spark={trend && trend.length > 1 ? <Sparkline points={trend} /> : undefined}
      className={cn(
        'h-full',
        to && 'transition-colors duration-hover ease-ease group-hover/tile:bg-control-hover',
      )}
    />
  )

  const wide = span === 2 ? 'sm:col-span-2' : undefined

  if (to) {
    return (
      <Link
        to={to}
        aria-label={toLabel ?? `${label}: ${value ?? 'no data'}`}
        className={cn('group/tile block rounded-card', wide)}
      >
        {tile}
      </Link>
    )
  }
  return wide ? <div className={wide}>{tile}</div> : tile
}
