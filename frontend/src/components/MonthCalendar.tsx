/**
 * A month of the watch log, as a wall of posters.
 *
 * The list answers "what did I watch, most recent first". This answers a
 * question the list cannot: *when*, and with what shape. A fortnight off, three
 * nights in a row, a Sunday that took six episodes - all of it is the shape of
 * the month rather than anything in the rows, and a diary in date order hides
 * it behind a scroll bar.
 *
 * ## The cell is the picture
 *
 * Every cell is `aspect-art`, poster-shaped whether or not it holds a poster,
 * and a day that has plays is drawn as the artwork of the last thing watched on
 * it. That is the only honest way a calendar can carry pictures: portrait art
 * never goes in a text row (7.21), because a row with a picture is sized *by*
 * the picture - so here the picture is the cell and the numbers are marks on
 * it, exactly as they are on an art card.
 *
 * The width is capped at seven `--art-tile` columns in `.month-grid`, which is
 * what keeps this on the ladder: tracks are `1fr`, so an uncapped seven-column
 * grid on a wide page would invent a fifth width somewhere above the browse
 * card.
 *
 * Below about 500px the cells cannot hold a picture at all, and a picture that
 * cannot have a rung does not appear: the artwork drops and the cell keeps its
 * number and its count. A narrow viewport changes the shell, never a size.
 *
 * ## A binge is one poster
 *
 * The server collapses a day's plays to distinct titles and sends the most
 * recent few, so five episodes of one series is one poster and a count of five
 * plays. One tile per *play* would let a single evening of television bury a
 * month of films, and it is the series you recognise, not its third episode.
 */
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { HistoryCalendarDay } from '@/lib/types'
import {
  cn,
  displayArtwork,
  displayTitle,
  localDateKey,
  parseLocalDateLabel,
} from '@/lib/utils'
import { Artwork } from '@/components/Poster'

/**
 * Which day the week starts on, asked of the reader's own locale.
 *
 * A hard-coded Sunday is wrong nearly everywhere Tally is self-hosted, and a
 * hard-coded Monday is wrong in the US - and a calendar whose columns are a day
 * out is not read as a preference, it is read as a bug. `getWeekInfo` is the
 * only thing that actually knows; where it is missing, Monday is the ISO week
 * and the better of the two guesses.
 */
function weekStart(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    // `firstDay` is 1..7 with Monday 1 and Sunday 7; `Date.getDay()` is 0..6
    // with Sunday 0, so 7 has to come back to 0.
    const first = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay
    if (first) return first % 7
  } catch {
    // An unparseable `navigator.language`, or a runtime without `Intl.Locale`.
  }
  return 1
}

/** The seven column headings, named by the reader's locale, in their order. */
function weekdayNames(start: number): string[] {
  const format = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
  // Any week will do; 4 Jan 1970 was a Sunday, so index 0 is Sunday.
  return Array.from({ length: 7 }, (_, index) =>
    format.format(new Date(1970, 0, 4 + ((start + index) % 7))),
  )
}

/** `YYYY-MM` a number of months away from this one, without leaving the year to Date. */
export function shiftMonth(month: string, by: number): string {
  const [year, index] = month.split('-').map(Number)
  const moved = new Date(year, index - 1 + by, 1)
  return `${moved.getFullYear()}-${String(moved.getMonth() + 1).padStart(2, '0')}`
}

export function monthLabel(month: string): string {
  return parseLocalDateLabel(month).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })
}

interface MonthCalendarProps {
  /** `YYYY-MM`, in the viewer's own zone. */
  month: string
  /** Only the days that have plays. The empty cells are drawn from the month. */
  days: HistoryCalendarDay[]
  loading?: boolean
  /** The day whose plays are listed under the grid, if any. */
  selected?: string | null
  /** Open one day: the diary, narrowed to it. Given a local `YYYY-MM-DD`. */
  onSelectDay: (dateKey: string) => void
  onMonth: (month: string) => void
}

export function MonthCalendar({
  month,
  days,
  loading,
  selected,
  onSelectDay,
  onMonth,
}: MonthCalendarProps) {
  const start = weekStart()
  const byDate = new Map(days.map((day) => [day.date, day]))

  const first = parseLocalDateLabel(`${month}-01`)
  const length = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  // How many cells of the previous month stand before the 1st, in this locale's
  // week. Modulo, because the offset is negative for a week starting later than
  // the month does.
  const lead = (first.getDay() - start + 7) % 7
  const rows = Math.ceil((lead + length) / 7)

  const todayKey = localDateKey(new Date())
  const cells = Array.from({ length: rows * 7 }, (_, index) => {
    const dayOfMonth = index - lead + 1
    if (dayOfMonth < 1 || dayOfMonth > length) return null
    const date = new Date(first.getFullYear(), first.getMonth(), dayOfMonth)
    const key = localDateKey(date)
    return { key, dayOfMonth, entry: byDate.get(key), future: key > todayKey }
  })

  return (
    <section>
      {/* The stepper, above its own grid. `‹ August 2026 ›` is one control:
          the month is the heading and the arrows are how you change it. */}
      <div className="mb-2 flex items-center gap-1">
        <button
          type="button"
          onClick={() => onMonth(shiftMonth(month, -1))}
          className="btn-ghost px-1.5"
          title="Previous month"
          aria-label="Previous month"
        >
          <ChevronLeft className="size-icon" aria-hidden="true" />
        </button>
        <h2 className="min-w-[9rem] text-center text-heading font-semibold text-strong">
          {monthLabel(month)}
        </h2>
        <button
          type="button"
          onClick={() => onMonth(shiftMonth(month, 1))}
          className="btn-ghost px-1.5"
          title="Next month"
          aria-label="Next month"
        >
          <ChevronRight className="size-icon" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onMonth(localDateKey(new Date()).slice(0, 7))}
          className="btn-ghost ml-1 text-small"
        >
          Today
        </button>
      </div>

      <div className="month-grid mb-1">
        {weekdayNames(start).map((name) => (
          <span key={name} className="eyebrow truncate text-center" aria-hidden="true">
            {name}
          </span>
        ))}
      </div>

      <div className="month-grid">
        {cells.map((cell, index) =>
          cell === null ? (
            // A cell belonging to a neighbouring month. Drawn as nothing rather
            // than as that month's date: a grid that starts on Wednesday has to
            // say so, and a faint "29" invites a click that would leave the
            // month the heading names.
            <span key={`pad-${index}`} aria-hidden="true" />
          ) : (
            <DayCell
              key={cell.key}
              dateKey={cell.key}
              dayOfMonth={cell.dayOfMonth}
              entry={cell.entry}
              selected={cell.key === selected}
              today={cell.key === todayKey}
              future={cell.future}
              loading={loading}
              onSelect={onSelectDay}
            />
          ),
        )}
      </div>
    </section>
  )
}

function DayCell({
  dateKey,
  dayOfMonth,
  entry,
  selected,
  today,
  future,
  loading,
  onSelect,
}: {
  dateKey: string
  dayOfMonth: number
  entry: HistoryCalendarDay | undefined
  selected: boolean
  today: boolean
  future: boolean
  loading?: boolean
  onSelect: (dateKey: string) => void
}) {
  const card = entry?.items[0]
  const plays = entry?.count ?? 0
  const title = card ? displayTitle(card) : null
  const more = entry ? entry.titles - entry.items.length : 0
  const day = parseLocalDateLabel(dateKey).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
  const named = today ? `${day}, today` : day

  if (loading) return <span className="art skeleton aspect-art w-full" aria-hidden="true" />

  /*
   * One shell for both cases, and the marks are siblings of the artwork rather
   * than children of it. That is what lets the picture drop out below `sm`
   * while the number and the count stay: a cell of 50px cannot hold a poster at
   * any rung of the ladder, and a picture that cannot have a rung does not
   * appear (7.21).
   *
   * `today` is a hairline accent outline rather than a filled cell. Selection
   * in this language is a neutral fill and a small mark, never an accent
   * background - and "today" is not even selection, it is a position.
   */
  const shell = cn(
    'art relative aspect-art w-full',
    // The picked cell (7.15) is 2px accent on the artwork's own corner, inset
    // so the grid cannot clip it; today is the same accent at a hairline. One
    // branch rather than two flags, because today's cell is very often the
    // picked one and two `ring-*` utilities on one element resolve by
    // stylesheet order, which is not something a component may rely on.
    selected
      ? 'ring-2 ring-inset ring-accent'
      : today
        ? 'ring-1 ring-inset ring-accent'
        : undefined,
  )

  const marks = (
    <>
      <span
        className={cn(
          'pointer-events-none absolute left-1 top-1 grid h-5 min-w-[1.25rem] place-items-center',
          'rounded-tight px-1 figure text-tiny',
          entry ? 'bg-scrim-flat text-art backdrop-blur-sm' : 'text-dim',
        )}
      >
        {dayOfMonth}
      </span>

      {entry && (
        // How much of the day this was. Always visible, never behind a hover:
        // the counts are what the shape of the month is made of.
        <span
          className="pointer-events-none absolute bottom-1 right-1 rounded-tight bg-scrim-flat
                     px-1 py-0.5 text-eyebrow font-semibold text-art backdrop-blur-sm"
        >
          <span className="figure">{plays}</span>
          {more > 0 && <span className="text-art-dim"> +{more}</span>}
        </span>
      )}
    </>
  )

  if (!entry) {
    return (
      <span
        className={cn(
          shell,
          // A day with nothing on it is the ground, not the faintest step of a
          // ramp: "nothing happened" and "a little happened" must not read as
          // the same fact. A day that has not arrived yet is dashed instead.
          future && 'bg-transparent border border-dashed border-line',
        )}
        title={`${named}: nothing watched`}
      >
        {marks}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(dateKey)}
      // The whole day, not the one title the picture happens to show: this
      // opens the diary narrowed to this date, where every play of it is
      // listed. A link straight to the film would drop the other four.
      aria-pressed={selected}
      aria-label={`${named}: ${plays} ${plays === 1 ? 'play' : 'plays'}. Show this day.`}
      title={`${named}: ${title}${more > 0 ? ` and ${more} more` : ''}`}
      className={cn(shell, 'art-card text-left')}
    >
      {/* Hidden rather than shrunk on a narrow viewport. `hidden sm:block` sits
          on the artwork itself, so the marks above are unaffected. */}
      <Artwork
        src={card ? displayArtwork(card) : null}
        title={title ?? ''}
        className="absolute inset-0 hidden rounded-none sm:block"
      />
      {marks}
      {/* The same label an art card carries: the name of a thing is never
          something you can get only by hovering, so `.art-label` shows it by
          default and hides it only where a pointer exists to bring it back. */}
      <span className="art-label hidden sm:block">
        <span className="line-clamp-2 text-tiny font-semibold text-art">{title}</span>
      </span>
    </button>
  )
}
