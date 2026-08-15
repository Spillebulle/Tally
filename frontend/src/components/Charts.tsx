/**
 * Charts for the stats page.
 *
 * Built as plain SVG rather than a charting library: the specs here are fixed
 * (thin marks, 4px rounded data-ends, a 2px surface gap between neighbours,
 * hairline recessive gridlines) and a library would fight all of them.
 *
 * Colour: every chart plots a single series, so each uses the sequential blue
 * and needs no legend — the heading names what is plotted. Values are directly
 * labelled at the data end, which also satisfies the relief rule for the
 * lighter steps.
 */
import { useId, useState } from 'react'
import type { StatCount } from '@/lib/types'
import { cn, compactNumber } from '@/lib/utils'

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
// Horizontal bars — genre breakdown
// ---------------------------------------------------------------------------

interface BarListProps {
  data: StatCount[]
  unit?: string
  emptyMessage?: string
  /** Makes each row a button. Given the row's label. */
  onSelect?: (label: string) => void
  activeLabel?: string | null
}

export function BarList({
  data,
  unit = '',
  emptyMessage = 'No data yet',
  onSelect,
  activeLabel = null,
}: BarListProps) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
  }
  const max = Math.max(...data.map((d) => d.value), 1)

  return (
    <ul className="space-y-2.5">
      {data.map((entry) => {
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
                onClick={() => onSelect(entry.label)}
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

interface ColumnChartProps {
  data: StatCount[]
  formatLabel?: (label: string) => string
  emptyMessage?: string
  /** Makes each column a button. Given the bar's label. */
  onSelect?: (label: string) => void
  /** Tooltip/aria text for a column; falls back to "<label>: <value>". */
  describe?: (entry: StatCount) => string
  /** Label of the column currently reflected elsewhere, e.g. an active filter. */
  activeLabel?: string | null
}

export function ColumnChart({
  data,
  formatLabel = (label) => label,
  emptyMessage = 'No ratings yet',
  onSelect,
  describe,
  activeLabel = null,
}: ColumnChartProps) {
  const total = data.reduce((sum, d) => sum + d.value, 0)
  if (total === 0) {
    return <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
  }
  const max = Math.max(...data.map((d) => d.value), 1)

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
      {data.map((entry) => {
        const height = (entry.value / max) * 100
        const active = activeLabel === entry.label
        const text = describe?.(entry) ?? `${formatLabel(entry.label)}: ${entry.value}`
        const bar = (
          <>
            {/* Value on the cap. */}
            <span className="text-xs font-medium tabular-nums text-ink">
              {entry.value || ''}
            </span>
            <div className="flex w-full flex-1 items-end justify-center">
              <div
                // ≤24px thick; rounded at the data end, square at the baseline.
                className={cn(
                  'w-full max-w-[24px] rounded-t-[4px] transition-[height,background-color]',
                  'duration-700 ease-spring',
                  active ? 'bg-accent' : 'bg-series-1',
                  onSelect && !active && 'group-hover/col:bg-accent',
                )}
                style={{ height: `${Math.max(entry.value ? 4 : 0, height)}%` }}
              />
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
            onClick={() => onSelect(entry.label)}
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
}

/**
 * Sequential single-hue ramp: light (near zero) to dark (busiest). Empty days
 * are the surface's line colour so "nothing watched" reads as absence rather
 * than as a low value.
 */
const RAMP = ['#cde2fb', '#9ec5f4', '#5598e7', '#2a78d6', '#184f95']
const RAMP_DARK = ['#1c5cab', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4']

export function ActivityHeatmap({ data, weeks = 26 }: HeatmapProps) {
  const [tip, setTip] = useState<Tooltip | null>(null)
  const gradientId = useId()

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
      const iso = cursor.toISOString().slice(0, 10)
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
    return Math.min(RAMP.length - 1, Math.floor((value / max) * RAMP.length))
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
          <defs>
            <linearGradient id={gradientId} />
          </defs>
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
                  )}
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
                      label: day.date.toLocaleDateString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                      }),
                      value:
                        day.value === 0
                          ? 'Nothing watched'
                          : `${day.value} ${day.value === 1 ? 'play' : 'plays'}`,
                    })
                  }}
                  onMouseLeave={() => setTip(null)}
                />
              )
            }),
          )}
        </svg>
      </div>

      <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-muted">
        <span>Less</span>
        <span className="h-3 w-3 rounded-[3px] bg-line/60" />
        {RAMP.map((_, index) => (
          <span
            key={index}
            className="h-3 w-3 rounded-[3px]"
            style={{ background: `var(--heat-${index})` }}
          />
        ))}
        <span>More</span>
      </div>

      <TooltipBubble tip={tip} />

      {/* Ramp steps as variables so the dark set is a deliberate re-step, not a flip. */}
      <style>{`
        :root {
          ${RAMP.map((hex, index) => `--heat-${index}: ${hex};`).join('\n')}
        }
        .dark {
          ${RAMP_DARK.map((hex, index) => `--heat-${index}: ${hex};`).join('\n')}
        }
      `}</style>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------

interface StatTileProps {
  label: string
  value: string
  hint?: string
  icon?: React.ReactNode
  accent?: boolean
}

export function StatTile({ label, value, hint, icon, accent }: StatTileProps) {
  return (
    <div
      className={cn(
        'card flex items-start gap-3 p-4 transition-transform duration-300 ease-spring hover:-translate-y-0.5',
        accent && 'ring-1 ring-accent/25',
      )}
    >
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
      </div>
    </div>
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
}: {
  caption: string
  rows: StatCount[]
  valueHeader?: string
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
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-line/60 last:border-0">
                <td className="py-1.5 pr-4 text-subtle">{row.label}</td>
                <td className="py-1.5 text-right tabular-nums text-ink">
                  {row.value.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
