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
 * colour by eye.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { StatCount } from '@/lib/types'
import { cn, compactNumber, localDateKey } from '@/lib/utils'

interface Tooltip {
  x: number
  y: number
  label: string
  value: string
}

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
}: {
  title: string
  description?: string
  children: React.ReactNode
  table?: React.ReactNode
  /** Only for a chart with more than one series; see `ChartLegend`. */
  legend?: React.ReactNode
}) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          {/* The heading names the single plotted series, so no legend box —
              except where there is more than one, which is what `legend` is. */}
          <h2 className="text-base font-semibold tracking-tight text-ink">{title}</h2>
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
}

export function BarList<T extends StatCount>({
  data,
  unit = '',
  emptyMessage = 'No data yet',
  onSelect,
  activeLabel = null,
}: BarListProps<T>) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
  }
  const max = Math.max(...data.map((d) => d.value), 1)

  return (
    <ul className="space-y-2.5">
      {data.map((entry, index) => {
        const active = activeLabel === entry.label
        const row = (
          <>
            <span className="truncate text-left text-sm text-subtle" title={entry.label}>
              {entry.label}
            </span>
            {/* Track is a lighter step of the same hue, so state reads across the bar. */}
            <div className="h-3 overflow-hidden rounded-r-[4px] bg-accent/10">
              <div
                className={cn(
                  'h-full rounded-r-[4px] transition-[width,background-color]',
                  'duration-700 ease-spring',
                  active ? 'bg-accent' : 'bg-series-1',
                  onSelect && !active && 'group-hover/bar:bg-accent',
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
                aria-label={`${entry.label}: ${entry.value}${unit}`}
                className={cn(
                  layout,
                  'group/bar cursor-pointer rounded-lg py-0.5 focus-visible:outline-none',
                  'focus-visible:ring-2 focus-visible:ring-accent',
                )}
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
}

export function ColumnChart<T extends StatCount>({
  data,
  formatLabel = (label) => label,
  emptyMessage = 'No ratings yet',
  onSelect,
  describe,
  activeLabel = null,
  compare,
}: ColumnChartProps<T>) {
  const total = data.reduce((sum, d) => sum + d.value, 0)
  const compareTotal = compare?.data.reduce((sum, d) => sum + d.value, 0) ?? 0
  if (total === 0 && compareTotal === 0) {
    return <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
  }
  // One scale across both series, or the comparison would be a lie.
  const max = Math.max(...data.map((d) => d.value), ...(compare?.data ?? []).map((d) => d.value), 1)

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
    <div className="flex h-44 items-stretch gap-1 sm:gap-2">
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
            <span className="text-xs font-medium tabular-nums text-ink">
              {entry.value || ''}
            </span>
            <div className="flex w-full flex-1 items-end justify-center gap-[2px]">
              <div
                // ≤24px thick; rounded at the data end, square at the baseline.
                className={cn(
                  'w-full rounded-t-[4px] transition-[height,background-color]',
                  'duration-700 ease-spring',
                  compare ? 'max-w-[11px]' : 'max-w-[24px]',
                  active ? 'bg-accent' : 'bg-series-1',
                  onSelect && !active && 'group-hover/col:bg-accent',
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
            <span className={cn('text-xs', active ? 'text-ink' : 'text-muted')}>
              {formatLabel(entry.label)}
            </span>
          </>
        )

        if (!onSelect) {
          return (
            <div
              key={entry.label}
              className="flex flex-1 flex-col items-center gap-2"
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
            className="group/col flex flex-1 cursor-pointer flex-col items-center gap-2
                       rounded-lg focus-visible:outline-none focus-visible:ring-2
                       focus-visible:ring-accent"
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

export function ActivityHeatmap({ data, weeks = 26, onSelect }: HeatmapProps) {
  const [tip, setTip] = useState<Tooltip | null>(null)

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

  const cell = 13
  const gap = 3
  const width = columns.length * (cell + gap)
  const height = 7 * (cell + gap) + 18

  const level = (value: number): number => {
    if (value <= 0) return -1
    return Math.min(HEAT_STEPS - 1, Math.floor((value / max) * HEAT_STEPS))
  }

  return (
    <div className="relative">
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
                    onSelect && day.value > 0 && 'cursor-pointer',
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

      <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-muted">
        <span>Less</span>
        <span className="h-3 w-3 rounded-[3px] bg-line/60" />
        {Array.from({ length: HEAT_STEPS }, (_, index) => (
          <span
            key={index}
            className="h-3 w-3 rounded-[3px]"
            style={{ background: `var(--heat-${index})` }}
          />
        ))}
        <span>More</span>
      </div>

      <TooltipBubble tip={tip} />
    </div>
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

interface StatTileProps {
  label: string
  value: string
  hint?: string
  icon?: React.ReactNode
  accent?: boolean
  /** Movement against a comparison window, when one is being shown. */
  delta?: StatDelta
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
      <div className="min-w-0">
        <p className="label">{label}</p>
        <p className="mt-1 truncate text-2xl font-semibold tracking-tight text-ink">
          {value}
        </p>
        {hint && <p className="mt-0.5 truncate text-xs text-muted">{hint}</p>}
        {delta && <DeltaBadge delta={delta} />}
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
        className={cn(shell, 'hover:border-accent/40 focus-visible:border-accent')}
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
