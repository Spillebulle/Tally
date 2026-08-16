import {
  useEffect,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  chipTextFor,
  choicesFor,
  defaultValueOf,
  FILTER_GROUPS,
  identity,
  isSet,
  STATUS_FILTERS,
  type AnyFilterDef,
  type BrowseFilterState,
  type DateRangeValue,
  type FilterCtx,
  type FilterLists,
} from '@/lib/browse-filters'
import { cn } from '@/lib/utils'
import { ChevronRightIcon, SearchIcon } from './Icons'
import { Segmented } from './ui'

/**
 * The controls that write the browse query.
 *
 * Everything about *what* the filters mean lives in `lib/browse-filters.ts`;
 * this file only knows how a `control.kind` looks. Adding a filter is one entry
 * in that table, and touches this file only if it needs a kind of control that
 * does not exist yet.
 *
 * ## Why there is a disclosure
 *
 * There are far too many filters to sit flat. A bar wide enough to hold twenty
 * controls is a bar nobody reads, and on a phone it is a wall. So the five
 * people reach for constantly stay out — status, genre, sort, order, search —
 * and the rest live behind a "Filters" button, grouped by the question they
 * answer: what the *title* is, what *you* did with it, where in your *library*
 * it sits.
 *
 * The panel *pushes the page down* rather than floating over it. There is no
 * popover primitive in this app, and the touch rules point the same way: a
 * floating layer needs outside-click dismissal, focus trapping and an escape
 * hatch, all of which are ways to get a control stuck over the content. It also
 * opens by itself when the URL arrives with one of its filters already set, so
 * a shared link explains what is narrowing the grid instead of hiding it.
 *
 * ## The chip row says everything, on purpose
 *
 * Chips used to be suppressed whenever a control already showed the same value,
 * on the sound argument that a chip beside a select is saying it twice. That
 * argument dies the moment the control moves behind a disclosure: the value is
 * then invisible, and an unexplained narrowed grid is the exact bug the chips
 * exist to prevent.
 *
 * So the rule is now the opposite — **every active filter appears in the chip
 * row**, with its own ×. The two controls still on the bar do say it twice, and
 * that is the deliberate cost: a chip row that lists some filters and not
 * others is a chip row you cannot read as "this is what is narrowing the grid".
 */

/**
 * A text or number input that reaches the URL a beat after you stop typing.
 *
 * Filtering replaces rather than pushes, so keystrokes cost no history
 * entries — but they would each cost a request, and a grid that reflows on
 * every letter is hard to read. The local draft is what makes typing feel
 * immediate; the URL is still the only place the value actually lives, so a
 * change from anywhere else (Clear, a link, the back button) resets the draft.
 */
function DraftInput({
  value,
  onCommit,
  className,
  ...rest
}: {
  value: string
  onCommit: (value: string) => void
  className?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value)

  useEffect(() => setDraft(value), [value])

  useEffect(() => {
    if (draft === value) return
    const timer = setTimeout(() => onCommit(draft), 250)
    return () => clearTimeout(timer)
    // `onCommit` closes over the current query and is rebuilt every render, so
    // it stays out of the dependency list — in it, the timer would restart on
    // every render and never fire.
  }, [draft, value])

  return (
    <input
      {...rest}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      className={className}
    />
  )
}

/** A select over a filter's choices, rendered by index so any value type works. */
function ChoiceSelect({
  def,
  value,
  lists,
  ctx,
  onPick,
  className,
}: {
  def: AnyFilterDef
  value: unknown
  lists: FilterLists
  ctx: FilterCtx
  onPick: (value: unknown) => void
  className?: string
}) {
  const choices = choicesFor(def, value, lists, ctx)
  const here = identity(def, value, ctx)
  const selected = choices.findIndex((choice) => identity(def, choice.value, ctx) === here)

  return (
    <select
      aria-label={def.label}
      value={selected < 0 ? 0 : selected}
      onChange={(event) => onPick(choices[Number(event.target.value)]?.value)}
      className={className}
    >
      {choices.map((choice, index) => (
        <option key={choice.label} value={index}>
          {choice.label}
        </option>
      ))}
    </select>
  )
}

/** A control in the panel, under its own written caption. */
function Field({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="label">{caption}</span>
      {children}
    </div>
  )
}

export function BrowseFilters({
  state,
  genres,
  contentRatings = [],
  busy,
}: {
  state: BrowseFilterState
  genres: string[]
  /** Certificates present in the library, for the "Rated" select. */
  contentRatings?: string[]
  /** Shows a quiet "Updating…" while a refetch is in flight. */
  busy?: boolean
}) {
  const [params] = useSearchParams()
  const ctx: FilterCtx = { params }
  const lists: FilterLists = { genres, contentRatings }
  const defs = state.defs
  const set = (def: AnyFilterDef, value: unknown) => state.set(def.key, value as never)
  const clearOne = (def: AnyFilterDef) => set(def, defaultValueOf(def))

  // Open from the start when a link arrives with one of these already set —
  // otherwise the page is narrowed by controls the reader cannot see. Initial
  // state only: after that the panel is the user's to open and close.
  const [open, setOpen] = useState(() => state.advancedCount > 0)

  const chips = defs.flatMap((def) => {
    if (def.role !== 'filter') return []
    const value = state.values[def.key]
    if (!isSet(def, value, ctx)) return []
    const text = chipTextFor(def, value, lists, ctx)
    return text ? [{ def, text }] : []
  })

  const statusDef = defs.find((def) => def.control.kind === 'chips')
  // The bar itself: the handful nobody should have to open a panel for.
  const inline = defs.filter(
    (def) => !def.group && def.control.kind !== 'none' && def.control.kind !== 'chips',
  )

  /** A select that draws its options from the library is hidden until there are some. */
  const emptyList = (def: AnyFilterDef) =>
    def.control.kind === 'select' &&
    def.control.lists &&
    lists[def.control.lists].length === 0 &&
    !isSet(def, state.values[def.key], ctx)

  const renderControl = (def: AnyFilterDef, inPanel: boolean) => {
    const value = state.values[def.key]

    switch (def.control.kind) {
      case 'search':
        return (
          <div key={def.key} className="relative w-full sm:w-56">
            <SearchIcon
              className="pointer-events-none absolute left-3 top-1/2
                         -translate-y-1/2 text-base text-muted"
            />
            <DraftInput
              type="search"
              value={value as string}
              onCommit={(next) => set(def, next)}
              placeholder={def.control.placeholder}
              aria-label={def.label}
              className="input h-9 py-0 pl-9 text-sm"
            />
          </div>
        )

      case 'toggle':
        return (
          <button
            key={def.key}
            type="button"
            aria-pressed={Boolean(value)}
            onClick={() => set(def, !value)}
            className={cn('chip shrink-0', Boolean(value) && 'chip-active')}
          >
            {def.control.on}
          </button>
        )

      case 'segmented':
        return (
          <span key={def.key} className="inline-flex items-center gap-2">
            <span className="text-xs text-muted">{def.control.caption}</span>
            <Segmented
              label={def.label}
              value={String(value)}
              onChange={(next) => set(def, next)}
              options={(def.choices?.(lists) ?? []).map((choice) => ({
                value: String(choice.value),
                label: choice.label,
              }))}
            />
          </span>
        )

      case 'daterange': {
        const range = value as DateRangeValue
        // Native date inputs, no dependency. They speak `YYYY-MM-DD` in the
        // viewer's own calendar, which is exactly what the URL holds; the
        // conversion to instants happens once, in `toQuery`.
        return (
          <Field key={def.key} caption={def.control.caption}>
            <span className="flex items-center gap-1.5">
              <input
                type="date"
                value={range.from ?? ''}
                max={range.to}
                aria-label={`${def.label} from`}
                onChange={(event) =>
                  set(def, { ...range, from: event.target.value || undefined })
                }
                className="input h-9 w-[9.5rem] py-0 text-sm"
              />
              <span className="text-xs text-muted">to</span>
              <input
                type="date"
                value={range.to ?? ''}
                min={range.from}
                aria-label={`${def.label} to`}
                onChange={(event) =>
                  set(def, { ...range, to: event.target.value || undefined })
                }
                className="input h-9 w-[9.5rem] py-0 text-sm"
              />
            </span>
          </Field>
        )
      }

      case 'select': {
        if (emptyList(def)) return null
        const select = (
          <ChoiceSelect
            def={def}
            value={value}
            lists={lists}
            ctx={ctx}
            onPick={(next) => set(def, next)}
            className="input h-9 w-auto min-w-[8rem] py-0 text-sm"
          />
        )
        return inPanel ? (
          <Field key={def.key} caption={def.label}>
            {select}
          </Field>
        ) : (
          <span key={def.key}>{select}</span>
        )
      }

      default:
        return null
    }
  }

  return (
    <div className="mb-6 space-y-3">
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map(({ def, text }) => (
            <button
              key={def.key}
              type="button"
              onClick={() => clearOne(def)}
              className="chip chip-active"
              aria-label={`Remove the ${def.label.toLowerCase()} filter`}
            >
              {!def.chipBare && (
                <span className="font-normal opacity-70">{def.label}</span>
              )}
              {text}
              <span aria-hidden="true">×</span>
            </button>
          ))}
          <button
            type="button"
            onClick={state.clear}
            className="px-1 text-xs font-medium text-muted hover:text-danger"
          >
            Clear all
          </button>
        </div>
      )}

      {statusDef && (
        <div className="scroll-x scrollbar-none flex gap-2 pb-1">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => set(statusDef, filter.value)}
              className={cn(
                'chip shrink-0',
                state.values.status === filter.value && 'chip-active',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {inline.map((def) => renderControl(def, false))}

        <button
          type="button"
          onClick={() =>
            state.set('order', state.values.order === 'asc' ? 'desc' : 'asc')
          }
          className="btn-outline h-9 px-3 text-sm"
          title={state.values.order === 'asc' ? 'Ascending' : 'Descending'}
          aria-label={
            state.values.order === 'asc' ? 'Sorted ascending' : 'Sorted descending'
          }
        >
          {state.values.order === 'asc' ? '↑' : '↓'}
        </button>

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="browse-advanced-filters"
          className={cn(
            'btn-outline h-9 gap-1.5 px-3 text-sm',
            state.advancedCount > 0 && 'border-accent/50 bg-accent-soft text-accent',
          )}
        >
          <ChevronRightIcon
            className={cn('text-xs transition-transform duration-200', open && 'rotate-90')}
          />
          Filters
          {state.advancedCount > 0 && (
            <span className="tabular-nums">· {state.advancedCount}</span>
          )}
        </button>

        {busy && <span className="ml-auto text-xs text-muted">Updating…</span>}
      </div>

      {/* Pushes the content down rather than floating over it — see the note at
          the top of this file. Unmounted when closed, so nothing inside it is
          focusable or tappable while hidden; `opacity-0` alone would leave a
          panel's worth of invisible controls armed over the grid. */}
      {open && (
        <div id="browse-advanced-filters" className="card space-y-5 p-4">
          {FILTER_GROUPS.map((group) => {
            const members = defs.filter(
              (def) =>
                def.group === group.id &&
                def.control.kind !== 'none' &&
                !emptyList(def),
            )
            if (members.length === 0) return null
            return (
              <section key={group.id}>
                <h3 className="mb-2 text-sm font-semibold text-ink">
                  {group.label}
                  <span className="ml-2 text-xs font-normal text-muted">
                    {group.hint}
                  </span>
                </h3>
                <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
                  {members.map((def) => renderControl(def, true))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
