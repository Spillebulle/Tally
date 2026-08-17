/**
 * Charts for the stats page.
 *
 * Built as plain SVG rather than a charting library: the specs here are fixed
 * (thin marks, 4px rounded data-ends, a 2px surface gap between neighbours,
 * hairline recessive gridlines) and a library would fight all of them.
 *
 * Colour: almost every chart plots a single series, so it uses the sequential
 * blue and needs no legend — the heading names what is plotted. Values are
 * directly labelled at the data end, which also satisfies the relief rule for
 * the lighter steps.
 *
 * The comparison chart is the one exception, and it is the exception the rule
 * was always conditioned on: two series in one frame cannot be told apart by a
 * heading, so it ships a `ChartLegend`. Two series, not three — `--series-1`
 * and `--series-2` are from the validated palette and nothing here may invent a
 * colour by eye. The rewatch split is the second such frame and uses the same
 * two, stacked rather than paired.
 *
 * `MatrixChart` is the one 2-D shape here and it is *sequential*, not
 * categorical: it reuses the `--heat-0…4` ramp the calendar heatmap already
 * defines rather than inventing a scale, which is also why a third categorical
 * series never had to be introduced to draw it.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { StatCount } from '@/lib/types'
import { cn, compactNumber, localDateKey } from '@/lib/utils'
import { Artwork } from './Poster'

interface Tooltip {
  x: number
  y: number
  label: string
  value: string
}

/**
 * How a **clickable** chart mark reacts, so it reads as a control.
 *
 * The boxes on this page already say "I lead somewhere" on hover — a tile
 * lifts, a ranked row fills with `bg-raised`. The charts said nothing, even
 * though their bars have always navigated, so a whole class of drill-downs was
 * discoverable only by trying. This is the same statement in the same tokens.
 *
 * Three things it deliberately does at once, because hover alone is not an
 * affordance:
 *
 *  - **`bg-raised` on hover**, matching `RankedList`'s rows exactly rather than
 *    inventing a chart-only treatment.
 *  - **The same fill on focus**, so a keyboard reaches it. The ring is a focus
 *    *indicator*; it does not tell you the mark is interactive before you get
 *    there, and the two answer different questions.
 *  - **`cursor-pointer`**, which is the only one of the three a pointer user
 *    reads before committing to a click.
 *
 * Touch gets none of these, which is why every chart that drills also says so
 * in its card description ("Pick one to …") — that sentence is the affordance
 * on a phone, and it is not optional.
 */
const CLICKABLE_MARK =
  'cursor-pointer rounded-lg transition-colors hover:bg-raised ' +
  'focus-visible:bg-raised focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-accent'

/**
 * The width a chart has to draw in, tracked as its box changes.
 *
 * Only for the charts that cannot be sized in CSS. Anything laid out with flex
 * or grid should stretch on its own — `MatrixChart` fills its box with
 * `minmax(cell, 1fr)` tracks and `Sparkline` with a fluid `viewBox`, and
 * neither needs to measure anything. An **SVG with a computed `width`
 * attribute** is the case that does: `ActivityHeatmap` draws 26 columns of 16px
 * and therefore claimed 416px however wide the card was, which on a full-width
 * card is a third of it.
 *
 * A `ResizeObserver` rather than a window `resize` listener, because the box
 * changes without the window doing so — a sidebar, a disclosure opening, a font
 * loading. The fallback exists for a test runner and for browsers without one,
 * and errs towards "measure once" rather than never.
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

function TooltipBubble({ tip }: { tip: Tooltip | null }) {
  if (!tip) return null
  return (
    <div
      className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full
                 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-lift"
      style={{ left: tip.x, top: tip.y - 8 }}
      role="status"
    >
      <div className="font-medium text-ink">{tip.label}</div>
      <div className="text-muted">{tip.value}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The frame every chart sits in
// ---------------------------------------------------------------------------

/**
 * A titled card around one chart, with its table fallback underneath.
 *
 * Lives here rather than on the stats page because every chart wants it and
 * the heading is load-bearing, not decoration — see below.
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
  /**
   * Where this card sits in the document outline.
   *
   * The stats page groups its cards under named sections a link can target, so
   * a card inside one is an `h3` under that section's `h2`. Left at 2 the
   * outline would claim every card is a sibling of the section heading above
   * it, which is what a screen reader's heading list actually navigates by.
   */
  headingLevel?: 2 | 3
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  return (
    // `min-w-0` is load-bearing wherever a card is a grid or flex item, which
    // on the stats page is most of them. A grid item's automatic minimum size
    // is its content's min-content width, and a chart that declares a floor —
    // the hour chart is `min-w-[520px]` inside its own `.scroll-x` — pushes
    // that floor up through the card, through the grid track, and out to the
    // document: measured at 375px, the whole page scrolled sideways to 578px
    // and *every* card in that grid grew with it, including the one with no
    // wide content in it at all. The scroller only starts scrolling once it is
    // allowed to be narrower than what it holds.
    <section className="card min-w-0 p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          {/* The heading names the single plotted series, so no legend box —
              except where there is more than one, which is what `legend` is. */}
          <Heading className="text-base font-semibold tracking-tight text-ink">
            {title}
          </Heading>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {legend}
      </div>
      {children}
      {table}
    </section>
  )
}

/**
 * Which colour is which series.
 *
 * Exists only where a frame holds more than one, and each entry is a swatch
 * *beside its name* rather than a colour standing in for one — the same reason
 * a status dot always sits next to a written label.
 */
export function ChartLegend({ series }: { series: Array<{ label: string; className: string }> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((entry) => (
        <li key={entry.label} className="flex items-center gap-1.5 text-xs text-subtle">
          <span className={cn('h-2.5 w-2.5 shrink-0 rounded-[3px]', entry.className)} />
          {entry.label}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Horizontal bars — genre breakdown
// ---------------------------------------------------------------------------

/**
 * Selection hands back the whole entry, not its label.
 *
 * A label is what the axis *reads*, which is not always what the row *is*: the
 * monthly columns are labelled "Aug" but the bucket is `2026-08`, and the raw
 * key was formatted away before the chart ever saw it — so a drill-down had
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
   * For the figure that qualifies the bar rather than competes with it. A
   * facet ranked by plays is unreadable without the number of titles behind
   * it — "300 plays" is one binged series or thirty films — and folding that
   * into the label would push it out of a 7.5rem column. It joins the
   * accessible name too, so it is not a sighted-only aside.
   */
  meta?: (entry: T) => string | null
  /**
   * The value a full-width bar means. Defaults to the largest in the list.
   *
   * A count has no ceiling, so the biggest row filling the track is the right
   * reading and the bars are a *ranking*. A **percentage** does have one, and
   * without this the two disagree completely: library coverage of 49% drew as a
   * full track — because 49 was the largest figure in the list — which reads as
   * "all of it" for a slice that is barely half watched. Any series on a fixed
   * scale (a percentage, a 0–10 rating) has to pin it.
   */
  scaleTo?: number
}

export function BarList<T extends StatCount>({
  data,
  unit = '',
  emptyMessage = 'No data yet',
  onSelect,
  activeLabel = null,
  meta,
  scaleTo,
}: BarListProps<T>) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
  }
  const max = scaleTo ?? Math.max(...data.map((d) => d.value), 1)

  return (
    <ul className="space-y-2.5">
      {data.map((entry, index) => {
        const active = activeLabel === entry.label
        const note = meta?.(entry) ?? null
        const row = (
          <>
            <span className="min-w-0 text-left" title={entry.label}>
              <span className="block truncate text-sm text-subtle">{entry.label}</span>
              {note && <span className="block truncate text-[11px] text-muted">{note}</span>}
            </span>
            {/* Track is a lighter step of the same hue, so state reads across the bar. */}
            <div className="h-3 overflow-hidden rounded-r-[4px] bg-accent/10">
              <div
                className={cn(
                  'h-full rounded-r-[4px] transition-[width,background-color]',
                  'duration-700 ease-spring',
                  active ? 'bg-accent' : 'bg-series-1',
                  onSelect &&
                    !active &&
                    'group-hover/bar:bg-accent group-focus-visible/bar:bg-accent',
                )}
                style={{ width: `${Math.max(2, (entry.value / max) * 100)}%` }}
              />
            </div>
            {/* Direct label at the data end. */}
            <span className="text-right text-sm font-medium tabular-nums text-ink">
              {compactNumber(entry.value)}
              {unit}
            </span>
          </>
        )

        const layout = 'grid w-full grid-cols-[7.5rem_1fr_3rem] items-center gap-3'
        return (
          <li key={entry.label}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(entry, index)}
                aria-pressed={active}
                aria-label={`${entry.label}: ${entry.value}${unit}${note ? `, ${note}` : ''}`}
                className={cn(layout, 'group/bar px-1.5 py-1', CLICKABLE_MARK)}
              >
                {row}
              </button>
            ) : (
              <div className={layout}>{row}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Columns — rating distribution
// ---------------------------------------------------------------------------

interface ColumnChartProps<T extends StatCount> {
  data: T[]
  /**
   * Display text for the axis. The chart keeps the raw label as the entry's
   * identity, so `onSelect` still receives the bucket it was given — the
   * monthly chart shows "Aug" and hands back `2026-08`.
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
   * length and describe the same offsets — which is why the only caller builds
   * both windows from one resolved range rather than from two queries that
   * happen to look similar.
   */
  compare?: { data: T[]; describe?: (entry: T) => string }
  /**
   * Print the value on each column's cap. On by default — direct labelling is
   * the house style and is what lets the lighter steps skip a tooltip.
   *
   * Turned off where the columns are too many and too narrow for it to be
   * reading rather than clutter: the 24-hour profile drew 24 numbers across a
   * strip about 20px wide each, which took a third of the frame's height and
   * left the bars a stub. The values are still in the tooltip, the accessible
   * name and the table.
   */
  showValues?: boolean
  /**
   * Fit every label to its column instead of letting the axis overflow.
   * Declares "this axis has more columns than a 12px label per column can
   * hold", and turns on both halves of the fix.
   *
   * The 24-hour profile is what this exists for, and it has been broken twice.
   * First it printed a label on every third column, so twenty-four bars sat
   * under eight numbers and nothing said which was which. Then it *thinned* the
   * labels to whatever the measured width could hold, leaving an empty span
   * under the unnamed columns — and an empty span has no line box, so those
   * columns lost their label row, their bar dropped into the space where the
   * number should have been, and, because the named columns kept the intrinsic
   * width of their text, the unnamed ones were squeezed thinner as well. A
   * chart that scales its bars to the data must not also scale them to whether
   * they happen to be labelled.
   *
   * So now nothing is dropped. Every column keeps its bar, its tick and its
   * label; what gives is the **type size**, computed from the measured column
   * width and the longest formatted label, down to a floor small enough for
   * twenty-four two-digit hours on a phone. Every column is `min-w-0` so the
   * text can never widen one column at its neighbours' expense — the label
   * fits the column, never the other way round.
   */
  fitLabels?: boolean
}

export function ColumnChart<T extends StatCount>({
  data,
  formatLabel = (label) => label,
  emptyMessage = 'No ratings yet',
  onSelect,
  describe,
  activeLabel = null,
  compare,
  showValues = true,
  fitLabels = false,
}: ColumnChartProps<T>) {
  // Only consulted when `fitLabels` is set, but hooks cannot be conditional.
  const [frame, available] = useMeasuredWidth<HTMLDivElement>()
  const total = data.reduce((sum, d) => sum + d.value, 0)
  const compareTotal = compare?.data.reduce((sum, d) => sum + d.value, 0) ?? 0
  if (total === 0 && compareTotal === 0) {
    return <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
  }
  // One scale across both series, or the comparison would be a lie.
  const max = Math.max(...data.map((d) => d.value), ...(compare?.data ?? []).map((d) => d.value), 1)

  // Type size that lets the longest label fit inside one column. 320 stands
  // in for the first render, one frame before the observer answers: a
  // plausible phone width, so the axis is never briefly drawn larger than it
  // can hold and then snapped down. 0.62em per character is a fair average
  // for tabular digits and short caps in the UI face; the floor keeps a phone
  // legible rather than technically present.
  const gap = fitLabels ? 2 : 0
  const columnWidth = ((available || 320) - gap * (data.length - 1)) / Math.max(1, data.length)
  const longest = fitLabels
    ? data.reduce((n, entry) => Math.max(n, formatLabel(entry.label).length), 1)
    : 1
  const labelSize = fitLabels ? clamp(columnWidth / (0.62 * longest), 7, 12) : undefined

  return (
    // `items-stretch` is load-bearing, not a default worth "tidying" away: the
    // bars are sized as a percentage, and a percentage height needs a parent
    // with a definite height to resolve against. `items-end` here made each
    // column shrink to its content instead of filling h-44, which left the
    // bar's flex-1 wrapper zero-tall — so every bar computed to zero and the
    // charts rendered as a row of numbers with nothing under them. The bars are
    // bottom-aligned by the wrapper below, not by this.
    //
    // Tighter gap on narrow screens: the rating chart went from five columns to
    // ten, and a fixed 8px gutter ate most of the width on a phone.
    <div
      className={cn('flex h-44 items-stretch', fitLabels ? 'gap-[2px]' : 'gap-1 sm:gap-2')}
      ref={frame}
    >
      {data.map((entry, index) => {
        const height = (entry.value / max) * 100
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
            {/* Value on the cap — the primary series only. Two numbers stacked
                over a 24px column is unreadable at twelve columns, and the
                second series' value is in the tooltip, the aria label and the
                table, which is where a comparison is actually read anyway. */}
            {showValues && (
              <span className="text-xs font-medium tabular-nums text-ink">
                {entry.value || ''}
              </span>
            )}
            <div className="flex w-full flex-1 items-end justify-center gap-[2px]">
              <div
                // ≤24px thick; rounded at the data end, square at the baseline.
                className={cn(
                  'w-full rounded-t-[4px] transition-[height,background-color]',
                  'duration-700 ease-spring',
                  compare ? 'max-w-[11px]' : 'max-w-[24px]',
                  active ? 'bg-accent' : 'bg-series-1',
                  onSelect &&
                    !active &&
                    'group-hover/col:bg-accent group-focus-visible/col:bg-accent',
                )}
                style={{ height: `${Math.max(entry.value ? 4 : 0, height)}%` }}
              />
              {compare && (
                <div
                  className={cn(
                    'w-full max-w-[11px] rounded-t-[4px] bg-series-2',
                    'transition-[height] duration-700 ease-spring',
                  )}
                  style={{
                    height: `${Math.max(earlier?.value ? 4 : 0, ((earlier?.value ?? 0) / max) * 100)}%`,
                  }}
                />
              )}
            </div>
            <span className="flex flex-col items-center gap-1">
              {/* A tick per column, drawn *inside* the column, so it is aligned
                  with its own bar by construction rather than by arithmetic
                  that can drift. Only where the axis said it is dense — a chart
                  that names every column at full size needs no help locating
                  them. */}
              {fitLabels ? (
                <span aria-hidden="true" className="h-1 w-px shrink-0 bg-line" />
              ) : null}
              {/* One line-height for every label whatever its font size, so a
                  scaled axis cannot make one column taller than its neighbours. */}
              <span
                className={cn(
                  'text-xs leading-4 tabular-nums',
                  active ? 'text-ink' : 'text-muted',
                )}
                style={labelSize ? { fontSize: `${labelSize}px` } : undefined}
              >
                {formatLabel(entry.label)}
              </span>
            </span>
          </>
        )

        if (!onSelect) {
          return (
            <div
              key={entry.label}
              className="flex min-w-0 flex-1 flex-col items-center gap-2"
              title={text}
            >
              {bar}
            </div>
          )
        }

        return (
          <button
            key={entry.label}
            type="button"
            // The whole column is the hit target, not just the drawn bar — a
            // short bar is only a few pixels tall and would be unclickable.
            className={cn(
              'group/col flex min-w-0 flex-1 flex-col items-center gap-2',
              CLICKABLE_MARK,
            )}
            onClick={() => onSelect(entry, index)}
            title={text}
            aria-label={text}
            aria-pressed={active}
          >
            {bar}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Calendar heatmap — activity over time
// ---------------------------------------------------------------------------

interface HeatmapProps {
  data: StatCount[]
  weeks?: number
  /**
   * Drill into one day. Given the local `YYYY-MM-DD` key and its count.
   *
   * A **secondary** way in, never the only one. A cell is 13px square, which is
   * a third of the 44px a finger needs, and putting 180 of them in the tab
   * order would bury every control after the chart. So the cells take a click
   * for the pointer users who will try it, stay out of the tab order, and the
   * page pairs this chart with a ranked list of the same days as real buttons —
   * that list, not this, is the route a keyboard or a thumb takes.
   */
  onSelect?: (dateKey: string, value: number) => void
}

/**
 * Steps in the sequential heatmap ramp. The colours themselves are
 * `--heat-0`…`--heat-4` in index.css, light and dark defined alongside every
 * other token — they used to be hex literals here, injected into the document
 * as a runtime <style> block from inside this component.
 *
 * Empty days use the surface's line colour instead, so "nothing watched" reads
 * as absence rather than as a low value.
 */
const HEAT_STEPS = 5

/**
 * Which step of the ramp a value sits on, or -1 for "nothing at all".
 *
 * Absence is deliberately *not* step 0: a day with no plays and a day with one
 * are different kinds of fact, and colouring them the same removes the only
 * thing the shape is for. Callers paint -1 with the line colour instead.
 */
function heatLevel(value: number, max: number): number {
  if (value <= 0) return -1
  return Math.min(HEAT_STEPS - 1, Math.floor((value / Math.max(max, 1)) * HEAT_STEPS))
}

/**
 * The key for the sequential ramp, shared by every chart that uses it.
 *
 * One definition so the calendar heatmap and the matrix charts cannot drift
 * apart — a reader who has learned the scale on one has learned it on all of
 * them, and there is one place to change if the ramp ever changes.
 */
export function HeatScale({ less = 'Less', more = 'More' }: { less?: string; more?: string }) {
  return (
    <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-muted">
      <span>{less}</span>
      <span className="h-3 w-3 rounded-[3px] bg-line/60" />
      {Array.from({ length: HEAT_STEPS }, (_, index) => (
        <span
          key={index}
          className="h-3 w-3 rounded-[3px]"
          style={{ background: `var(--heat-${index})` }}
        />
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
 * buttons — a short window genuinely cannot fill a wide card, and stretching to
 * fill it anyway would make two weeks look like a year's worth of data.
 */
const HEAT_CELL_MIN = 9
const HEAT_CELL_MAX = 24

export function ActivityHeatmap({ data, weeks = 26, onSelect }: HeatmapProps) {
  const [tip, setTip] = useState<Tooltip | null>(null)
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
      // Local key, not toISOString(): `cursor` is a local midnight, and the
      // UTC conversion shifted every lookup a day earlier east of Greenwich.
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
  // Sized to the box rather than fixed at 13px. The old constant meant 26
  // columns claimed exactly 416px however wide the card was — a third of a
  // full-width one — which is what made this read as a chart that had not
  // finished loading. `available || 0` before the first measurement falls back
  // to the old constant, so a server render or a test runner draws the same
  // chart it always did.
  const cell = available
    ? clamp(Math.floor(available / columns.length) - gap, HEAT_CELL_MIN, HEAT_CELL_MAX)
    : 13
  const width = columns.length * (cell + gap)
  const height = 7 * (cell + gap) + 18

  const level = (value: number): number => heatLevel(value, max)

  return (
    <div className="relative" ref={frame}>
      <div className="scroll-x scrollbar-thin pb-1">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Watch activity by day"
          className="block"
        >
          {monthLabels.map(({ index, label }) => (
            <text
              key={`${label}-${index}`}
              x={index * (cell + gap)}
              y={10}
              className="fill-muted text-[10px]"
            >
              {label}
            </text>
          ))}
          {columns.map((column, columnIndex) =>
            column.map((day, dayIndex) => {
              if (day.future) return null
              const tier = level(day.value)
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
                  rx={3}
                  className={cn(
                    tier < 0 && 'fill-line/60',
                    'transition-opacity hover:opacity-80',
                    // The mark's own affordance. A rect cannot take
                    // `CLICKABLE_MARK` — there is no background to raise — so
                    // it says the same thing with an accent outline, which is
                    // also the only treatment legible on a 13px square.
                    onSelect &&
                      day.value > 0 &&
                      'cursor-pointer stroke-2 stroke-transparent hover:stroke-accent',
                  )}
                  onClick={
                    onSelect && day.value > 0
                      ? () => onSelect(localDateKey(day.date), day.value)
                      : undefined
                  }
                  style={
                    tier >= 0
                      ? {
                          fill: `var(--heat-${tier})`,
                        }
                      : undefined
                  }
                  onMouseEnter={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect()
                    const parent =
                      event.currentTarget.ownerSVGElement?.parentElement?.parentElement?.getBoundingClientRect()
                    setTip({
                      x: rect.left - (parent?.left ?? 0) + rect.width / 2,
                      y: rect.top - (parent?.top ?? 0),
                      label: dayLabel,
                      value: valueLabel,
                    })
                  }}
                  onMouseLeave={() => setTip(null)}
                >
                  {/* Native tooltip, so the value is reachable without a
                      mouse — the rects carry only mouse handlers. */}
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

// ---------------------------------------------------------------------------
// Matrix — a value per (row, column) pair
// ---------------------------------------------------------------------------

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
   * destination can actually express — see `lib/drill-links.ts`. Omitted, the
   * cells stay readable (and keyboard-reachable) but do not pretend to lead
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
 * are the same figure — a categorical row axis, a cyclic column axis, one count
 * per pair — and drawing them twice would be two ramps, two keyboard models and
 * two sets of labels to keep honest.
 *
 * **Why HTML and not SVG**, unlike every other chart here. The marks have to be
 * operable: a cell needs an accessible name, a focus ring and (for seasonality)
 * a click that navigates. `ActivityHeatmap` is SVG and pays for it — its cells
 * carry mouse handlers only, so it has to be paired with a separate list of
 * real buttons to be reachable at all. 168 cells cannot be paired with a list,
 * so they are real elements from the start.
 *
 * **One tab stop, not 168.** The grid is a roving-tabindex `role="grid"`: Tab
 * enters it once and the arrow keys, Home and End move within it. Putting every
 * cell in the tab order would bury every control after the chart, which is
 * exactly the reason the calendar heatmap keeps its cells out of it — this
 * solves the same problem without giving up the marks.
 *
 * Colour is the shared sequential ramp, and an empty cell is drawn as absence
 * (the line colour) rather than as the ramp's lowest step.
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
  emptyMessage = 'Nothing to plot yet',
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
    return <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
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
        Scrolls when it cannot fit, **stretches when it can**, and neither
        needs measuring: `minmax(cell, 1fr)` is a floor and a share at once, so
        the tracks grow to fill a wide card and refuse to shrink past legible on
        a narrow one — at which point this scroller takes over and the page body
        still never scrolls sideways. The old `inline-grid` of fixed `cell`px
        tracks claimed the same ~410px whatever the card was, so 24 hours drew
        into a third of a full-width one and looked broken rather than compact.

        The cells become rectangles on a wide box, which is fine and deliberate:
        the ramp is read by colour, and the row is read across. Only the
        *height* is a fixed square-ish size.
      */}
      <div className="scroll-x scrollbar-thin pb-1">
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
              className="overflow-hidden text-center text-[10px] leading-none text-muted"
            >
              {index % columnLabelEvery === 0 ? name : ''}
            </div>
          ))}

          {rows.map((name, rowIndex) => (
            <div key={name} role="row" className="contents">
              <div
                role="rowheader"
                className="pr-2 text-right text-[11px] leading-none text-muted"
                style={{ lineHeight: `${cell}px` }}
              >
                {name}
              </div>
              {columns.map((_, columnIndex) => {
                const value = values[rowIndex]?.[columnIndex] ?? 0
                const tier = heatLevel(value, ceiling)
                const focusable = rowIndex === row && columnIndex === column
                const text = label(rowIndex, columnIndex)
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
                    'rounded-[3px] transition-opacity hover:opacity-80',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    tier < 0 && 'bg-line/60',
                    // A ring rather than `CLICKABLE_MARK`'s raised background:
                    // the cell *is* its background, so raising it would erase
                    // the value. Same accent, same statement.
                    onSelect && 'cursor-pointer hover:ring-1 hover:ring-accent',
                  ),
                  style: {
                    // Width comes from the grid track, so the cell can stretch;
                    // the height is what keeps the ramp reading as a grid.
                    height: cell,
                    ...(tier >= 0 ? { background: `var(--heat-${tier})` } : {}),
                  },
                }
                return onSelect ? (
                  <button
                    key={columnIndex}
                    type="button"
                    {...shared}
                    ref={shared.ref as (node: HTMLButtonElement | null) => void}
                    onClick={() => onSelect(rowIndex, columnIndex, value)}
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

/**
 * A matrix as a table — the fallback `DataTable` cannot be, since that is one
 * value per label and this is one per pair.
 *
 * Same `<details>` affordance and the same wording, so it reads as the same
 * control as every other chart's fallback rather than as a different one.
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
    <details className="mt-4 text-sm">
      <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">
        View as table
      </summary>
      <div className="scroll-x mt-2">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wider text-muted">
              <th scope="col" className="py-1.5 pr-3 font-medium">
                {rowHeader}
              </th>
              {columns.map((name) => (
                <th key={name} scope="col" className="py-1.5 px-1.5 text-right font-medium">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((name, rowIndex) => (
              <tr key={name} className="border-b border-line/60 last:border-0">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal text-subtle">
                  {name}
                </th>
                {columns.map((column, columnIndex) => (
                  <td
                    key={column}
                    className="px-1.5 py-1.5 text-right tabular-nums text-ink"
                  >
                    {values[rowIndex]?.[columnIndex] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Stacked columns — two series that sum to something meaningful
// ---------------------------------------------------------------------------

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
}

/**
 * Two series stacked, not paired.
 *
 * Stacked because the parts genuinely sum to the whole here — a play is either
 * a first watch or a rewatch, never both — so the column's full height is the
 * period's plays and the split is read inside it. `ColumnChart`'s `compare`
 * draws its two side by side for the opposite reason: two *windows* do not add
 * up to anything, and stacking them would invent a total.
 *
 * Same mark spec as the other columns: ≤24px thick, 4px rounded at the data end
 * only, square at the baseline, and a 2px gap between the two segments so the
 * boundary is not carried by colour alone.
 */
export function StackedColumnChart<T extends StackedEntry>({
  data,
  formatLabel = (label) => label,
  describe,
  emptyMessage = 'Nothing watched in this range',
  onSelect,
}: StackedColumnChartProps<T>) {
  const total = data.reduce((sum, entry) => sum + entry.value, 0)
  if (total === 0) {
    return <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
  }
  const max = Math.max(...data.map((entry) => entry.value), 1)

  return (
    // `items-stretch` for the same reason as `ColumnChart`: the segments are
    // sized as a percentage and a percentage height needs a parent with a
    // definite one. `items-end` here leaves every bar zero-tall.
    <div className="flex h-44 items-stretch gap-1 sm:gap-2">
      {data.map((entry, index) => {
        const text =
          describe?.(entry) ??
          `${formatLabel(entry.label)}: ${entry.first} first watches, ${entry.rewatch} rewatches`
        const share = (part: number) => (part / max) * 100
        const bar = (
          <>
            <span className="text-xs font-medium tabular-nums text-ink">
              {entry.value || ''}
            </span>
            <div className="flex w-full flex-1 flex-col justify-end gap-[2px]">
              {/* Top segment first in the DOM: it is the top of the stack. */}
              <div
                className="w-full max-w-[24px] self-center rounded-t-[4px] bg-series-2
                           transition-[height] duration-700 ease-spring"
                style={{ height: `${Math.max(entry.rewatch ? 4 : 0, share(entry.rewatch))}%` }}
              />
              <div
                className={cn(
                  'w-full max-w-[24px] self-center transition-[height,background-color]',
                  'duration-700 ease-spring bg-series-1',
                  // The stack keeps its two validated series, so the hover
                  // statement is the raised background on the button rather
                  // than a colour swap that would collide with `--series-2`.
                  // Rounded on top only when it *is* the data end — with a
                  // rewatch segment above it, its top is an internal boundary.
                  entry.rewatch ? '' : 'rounded-t-[4px]',
                )}
                style={{ height: `${Math.max(entry.first ? 4 : 0, share(entry.first))}%` }}
              />
            </div>
            <span className="text-xs text-muted">{formatLabel(entry.label)}</span>
          </>
        )

        if (!onSelect) {
          return (
            <div
              key={entry.label}
              className="flex min-w-0 flex-1 flex-col items-center gap-2"
              title={text}
            >
              {bar}
            </div>
          )
        }
        return (
          <button
            key={entry.label}
            type="button"
            className={cn(
              'group/col flex min-w-0 flex-1 flex-col items-center gap-2',
              CLICKABLE_MARK,
            )}
            onClick={() => onSelect(entry, index)}
            title={text}
            aria-label={text}
          >
            {bar}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ranked rows with artwork
// ---------------------------------------------------------------------------

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
 * actually recognises them by — the same argument the grids make.
 *
 * The bar is kept, as a track behind the count, so the ranking is still a shape
 * and not only an ordering.
 */
export function RankedList({
  rows,
  unit,
  emptyMessage = 'Nothing yet',
}: {
  rows: RankedRow[]
  /** Singular unit for the accessible name: "play" → "12 plays". */
  unit: string
  emptyMessage?: string
}) {
  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
  }
  const max = Math.max(...rows.map((row) => row.value), 1)

  return (
    <ol className="space-y-1">
      {rows.map((row, index) => {
        const figure =
          row.valueLabel ?? `${row.value} ${row.value === 1 ? unit : `${unit}s`}`
        const name = `${row.title}${row.subtitle ? ` — ${row.subtitle}` : ''}: ${figure}${
          row.meta ? `, ${row.meta}` : ''
        }`
        const body = (
          <>
            <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted">
              {index + 1}
            </span>
            <Artwork
              src={row.posterUrl}
              title={row.title}
              showTitle={false}
              className="h-14 w-[38px] shrink-0 rounded-md"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{row.title}</span>
              {row.subtitle && (
                <span className="block truncate text-xs text-muted">{row.subtitle}</span>
              )}
              {/* The bar is a shape for the ranking, never the only statement
                  of the number — that is spelled out beside it. */}
              <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-accent/10">
                <span
                  className="block h-full rounded-full bg-series-1"
                  style={{ width: `${Math.max(4, (row.value / max) * 100)}%` }}
                />
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-sm font-semibold tabular-nums text-ink">
                {row.valueLabel ?? compactNumber(row.value)}
              </span>
              {row.meta && <span className="block text-[11px] text-muted">{row.meta}</span>}
            </span>
          </>
        )
        const layout = 'flex w-full items-center gap-3 rounded-xl p-1.5'
        return (
          <li key={row.key}>
            {row.to ? (
              <Link
                to={row.to}
                aria-label={name}
                className={cn(layout, 'transition-colors hover:bg-raised')}
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

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------

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
 * Direction, in a glyph and in words.
 *
 * Deliberately *not* coloured green and red. Those two colours would assert
 * that watching more is good and watching less is bad, which this app has no
 * business claiming — a quiet month is not a regression. The arrow and the sign
 * carry the direction, so nothing here depends on colour vision either.
 */
function DeltaBadge({ delta }: { delta: StatDelta }) {
  const direction = delta.pct == null ? 0 : Math.sign(delta.pct)
  const arrow = direction > 0 ? '↑' : direction < 0 ? '↓' : '→'
  // Five tiles across leaves about 140px of text. "↓ 7.8%, was 77 in the
  // period before" truncates to "↓ 7.8%, was 77 in…", which is the same
  // mistake the hints here already avoid — so the phrase naming the comparison
  // window lives in the title and in the accessible name instead. The control
  // that turned the comparison on is three inches up the page and says it once.
  const short =
    delta.pct == null
      ? `was ${delta.previous}`
      : `${Math.abs(delta.pct)}% · was ${delta.previous}`
  const full =
    delta.pct == null
      ? `was ${delta.previous} ${delta.against}`
      : `${direction > 0 ? 'up' : direction < 0 ? 'down' : 'unchanged at'} ${Math.abs(delta.pct)}%, was ${delta.previous} ${delta.against}`
  return (
    <p className="mt-1 truncate text-xs text-subtle" title={full}>
      <span aria-hidden="true">{arrow} </span>
      <span className="sr-only">{full}</span>
      <span aria-hidden="true">{short}</span>
    </p>
  )
}

/**
 * The tile's optional shape: where this figure has been over the window.
 *
 * Drawn from a plain list of numbers with no axis, no labels and no scale of
 * its own — it says "rising", "spiky", "flat", and nothing a reader could
 * misread as a precise value. It is **redundant** by construction: the figure
 * above it and the delta below it carry every number, so the tile loses no
 * information without it. That is why it is `aria-hidden` rather than given an
 * accessible name that would repeat what is already read out.
 *
 * A single point cannot be a trend, so fewer than two is drawn as nothing.
 *
 * **It fills the tile.** It used to carry `width={72}` as an attribute, so the
 * shape sat in the left third of a tile two hundred-odd pixels wide and read as
 * a chart that had failed to load. The viewBox stays 72×20 — it is only a
 * coordinate space — and the element is sized in CSS instead, which means it
 * follows the tile through every breakpoint with nothing to keep in step.
 *
 * `preserveAspectRatio="none"` is the point and is safe *here* specifically: a
 * sparkline has no axis, no labels and no scale a reader could misread, so
 * stretching it horizontally changes nothing it claims. `vector-effect:
 * non-scaling-stroke` keeps the line 1.5px whatever the stretch, which is the
 * one thing that would otherwise give it away.
 */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null
  const width = 72
  const height = 20
  const max = Math.max(...points, 1)
  const step = width / (points.length - 1)
  // A 1px inset top and bottom so a flat maximum is not clipped by the edge.
  const path = points
    .map((value, index) => {
      const x = index * step
      const y = height - 1 - (value / max) * (height - 2)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="mt-1.5 block h-5 w-full text-series-1"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={`${path} L${width},${height} L0,${height} Z`}
        className="fill-series-1/10 stroke-none"
      />
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

interface StatTileProps {
  label: string
  value: string
  hint?: string
  icon?: React.ReactNode
  accent?: boolean
  /** Movement against a comparison window, when one is being shown. */
  delta?: StatDelta
  /**
   * Where this figure has been, as a sparkline under the delta.
   *
   * Optional and off by default, so every existing tile — the dashboard's
   * included — renders exactly as it did. Purely supplementary: see
   * `Sparkline`.
   */
  trend?: number[]
  /** Makes the whole tile a link. A tile is 44px-plus, so this is a real target. */
  to?: string
  /** Required with `to`: what the destination is, for a screen reader. */
  toLabel?: string
}

export function StatTile({
  label,
  value,
  hint,
  icon,
  accent,
  delta,
  trend,
  to,
  toLabel,
}: StatTileProps) {
  const body = (
    <>
      {icon && (
        <span
          className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl
                     bg-accent-soft text-base text-accent"
        >
          {icon}
        </span>
      )}
      {/*
        `flex-1` as well as `min-w-0`, and the pair is load-bearing. Without it
        this column sizes to its own content, so the sparkline's `w-full` was
        100% of "as wide as the word PLAYS" — about 76px in a 270px tile, which
        is exactly what made the trend line look like a chart that had failed to
        load. `min-w-0` alone lets it shrink; `flex-1` is what makes it fill.
      */}
      <div className="min-w-0 flex-1">
        <p className="label">{label}</p>
        <p className="mt-1 truncate text-2xl font-semibold tracking-tight text-ink">
          {value}
        </p>
        {hint && <p className="mt-0.5 truncate text-xs text-muted">{hint}</p>}
        {delta && <DeltaBadge delta={delta} />}
        {trend && <Sparkline points={trend} />}
      </div>
    </>
  )

  const shell = cn(
    'card flex items-start gap-3 p-4 transition-transform duration-300 ease-spring hover:-translate-y-0.5',
    accent && 'ring-1 ring-accent/25',
  )

  if (to) {
    return (
      <Link
        to={to}
        aria-label={toLabel ?? `${label}: ${value}`}
        className={cn(shell, 'hover:border-line-accent-soft focus-visible:border-accent')}
      >
        {body}
      </Link>
    )
  }
  return <div className={shell}>{body}</div>
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
}: {
  caption: string
  rows: StatCount[]
  valueHeader?: string
  /**
   * A second column of the same shape, for a two-series chart.
   *
   * Aligned by index, exactly as `ColumnChart`'s `compare` is and for the same
   * reason — the two windows do not share labels — so `rowLabel` gets to say
   * what the earlier row was called. Without this a comparison chart would have
   * a fallback that showed only half of what was drawn, which is not a
   * fallback.
   */
  compare?: { header: string; rows: StatCount[]; rowLabel?: (row: StatCount) => string }
}) {
  if (rows.length === 0) return null
  return (
    <details className="mt-4 text-sm">
      <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">
        View as table
      </summary>
      <div className="scroll-x mt-2">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wider text-muted">
              <th scope="col" className="py-1.5 pr-4 font-medium">
                Label
              </th>
              <th scope="col" className="py-1.5 text-right font-medium">
                {valueHeader}
              </th>
              {compare && (
                <th scope="col" className="py-1.5 pl-4 text-right font-medium">
                  {compare.header}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const earlier = compare?.rows[index]
              return (
                <tr key={row.label} className="border-b border-line/60 last:border-0">
                  <td className="py-1.5 pr-4 text-subtle">{row.label}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink">
                    {row.value.toLocaleString()}
                  </td>
                  {compare && (
                    <td className="py-1.5 pl-4 text-right tabular-nums text-subtle">
                      {earlier ? (
                        <>
                          {earlier.value.toLocaleString()}
                          {compare.rowLabel && (
                            <span className="ml-1 text-xs text-muted">
                              ({compare.rowLabel(earlier)})
                            </span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </details>
  )
}
