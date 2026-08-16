import {
  useEffect,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  chipsFor,
  choicesFor,
  FILTER_GROUPS,
  identity,
  isSet,
  NO_LISTS,
  STATUS_FILTERS,
  type AnyFilterDef,
  type BrowseFilterState,
  type DateRangeValue,
  type FilterChoice,
  type FilterCtx,
  type FilterLists,
  type MultiValue,
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

/**
 * A chip per value, cycling off → include → exclude → off.
 *
 * Three states in one control, because the alternative is two controls saying
 * "include" and "exclude" over the same list of genres, and a `<select
 * multiple>` — which needs a modifier key nobody discovers, loses the whole
 * selection on a stray click, and cannot express "not this" at all.
 *
 * Nothing here is carried by colour alone: an excluded value is struck through
 * and prefixed with a minus, and its accessible name says which state it is in.
 *
 * The selected values sort to the front. A library with fifty genres scrolls,
 * and a filter you cannot see is a filter you cannot remove — the chip row
 * above is the other half of that guarantee.
 */
function MultiChips({
  def,
  value,
  lists,
  onChange,
  wrap,
}: {
  def: AnyFilterDef
  value: MultiValue
  lists: FilterLists
  onChange: (next: MultiValue) => void
  /** Wrap in the panel; scroll sideways on the bar, like the status chips. */
  wrap: boolean
}) {
  const options = def.options?.(lists) ?? []
  const known = new Set(options.map((choice) => choice.value))
  // A value arrived at from a link — a stats drill, a bookmark, a facet click
  // — need not be one the library list offers. Appended rather than dropped:
  // a control showing "any genre" over a grid filtered to one is a control
  // that lies.
  const arrived: Array<FilterChoice<string>> = [...value.include, ...value.exclude]
    .filter((name) => !known.has(name))
    .map((name) => ({ value: name, label: name }))

  const rank = (choice: FilterChoice<string>) =>
    value.include.includes(choice.value) ? 0 : value.exclude.includes(choice.value) ? 1 : 2
  // Stable by specification, so equal ranks keep the library's own ordering.
  const ordered = [...arrived, ...options].sort((a, b) => rank(a) - rank(b))

  const cycle = (name: string): MultiValue => {
    if (value.include.includes(name)) {
      return {
        ...value,
        include: value.include.filter((entry) => entry !== name),
        exclude: [...value.exclude, name],
      }
    }
    if (value.exclude.includes(name)) {
      return { ...value, exclude: value.exclude.filter((entry) => entry !== name) }
    }
    return { ...value, include: [...value.include, name] }
  }

  const andable = def.control.kind === 'multi' && def.control.andable
  return (
    // The toggle drops below the chips on a phone. Beside them it squeezed the
    // scrolling row against the edge of the screen and wrapped its own two
    // options into a stack, which read as a menu floating over the chips.
    //
    // Stacked, the chip row must still stretch to the full width — sized to its
    // content it takes the whole vocabulary with it and pushes the *page*
    // sideways, which is the one thing the sideways-scrolling row exists to
    // prevent. Hence no `items-start` here, and `self-start` on the toggle.
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
      <div
        className={cn(
          'flex min-w-0 gap-2',
          wrap ? 'flex-wrap' : 'scroll-x scrollbar-none pb-1',
        )}
      >
        {ordered.map((choice) => {
          const included = value.include.includes(choice.value)
          const excluded = value.exclude.includes(choice.value)
          return (
            <button
              key={choice.value}
              type="button"
              onClick={() => onChange(cycle(choice.value))}
              aria-label={`${def.label}: ${choice.label}${
                included ? ', included' : excluded ? ', excluded' : ''
              }`}
              title={
                included
                  ? `Exclude ${choice.label}`
                  : excluded
                    ? `Stop excluding ${choice.label}`
                    : `Include ${choice.label}`
              }
              className={cn(
                'chip shrink-0',
                included && 'chip-active',
                excluded && 'border-danger/50 bg-danger/10 text-danger line-through',
              )}
            >
              {excluded && <span aria-hidden="true">−</span>}
              {choice.label}
            </button>
          )
        })}
      </div>
      {/* Only where AND can change the answer: a title has several genres, but
          one studio and one certificate, so "all" over those is the empty set
          by construction — and with a single value selected it says nothing. */}
      {andable && value.include.length > 1 && (
        <div className="self-start sm:self-auto">
          <Segmented
            label={`Match ${def.label.toLowerCase()}`}
            value={value.all ? 'all' : 'any'}
            onChange={(next) => onChange({ ...value, all: next === 'all' })}
            options={[
              { value: 'any', label: 'Any' },
              { value: 'all', label: 'All' },
            ]}
          />
        </div>
      )}
    </div>
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
  lists: provided,
  busy,
}: {
  state: BrowseFilterState
  /**
   * Whatever the page fetched for the controls that offer real library values.
   * Partial, so a page that has not fetched one of them simply does not
   * mention it — the control hides itself rather than offering an empty list.
   */
  lists?: Partial<FilterLists>
  /** Shows a quiet "Updating…" while a refetch is in flight. */
  busy?: boolean
}) {
  const [params] = useSearchParams()
  const ctx: FilterCtx = { params }
  const lists: FilterLists = { ...NO_LISTS, ...provided }
  const defs = state.defs
  const set = (def: AnyFilterDef, value: unknown) => state.set(def.key, value as never)

  // Open from the start when a link arrives with one of these already set —
  // otherwise the page is narrowed by controls the reader cannot see. Initial
  // state only: after that the panel is the user's to open and close.
  const [open, setOpen] = useState(() => state.advancedCount > 0)

  const chips = defs.flatMap((def) => {
    if (def.role !== 'filter') return []
    const value = state.values[def.key]
    if (!isSet(def, value, ctx)) return []
    // One chip per *value*, not per filter: three genres are three chips with
    // three ×, because removing one of them must leave the other two.
    return chipsFor(def, value, lists, ctx).map((chip) => ({ def, ...chip }))
  })

  const statusDef = defs.find((def) => def.control.kind === 'chips')

  /** A control the rest of the query has made meaningless — see `showWhen`. */
  const irrelevant = (def: AnyFilterDef) =>
    def.showWhen !== undefined && !def.showWhen(state.values)

  /** A control whose options the library has not supplied, and nothing is set. */
  const emptyList = (def: AnyFilterDef) => {
    if (isSet(def, state.values[def.key], ctx)) return false
    if (def.control.kind === 'select' && def.control.lists) {
      return lists[def.control.lists].length === 0
    }
    if (def.control.kind === 'multi') {
      return (def.options?.(lists) ?? []).length < (def.control.minOptions ?? 1)
    }
    return false
  }

  const offered = (def: AnyFilterDef) =>
    def.control.kind !== 'none' && !emptyList(def) && !irrelevant(def)

  // The bar itself: the handful nobody should have to open a panel for. A chip
  // group among them takes a full row rather than a slot in the flex line.
  const onBar = defs.filter(
    (def) => !def.group && def.control.kind !== 'chips' && offered(def),
  )
  const barChips = onBar.filter((def) => def.control.kind === 'multi')
  const inline = onBar.filter((def) => def.control.kind !== 'multi')

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

      case 'multi': {
        const chips = (
          <MultiChips
            def={def}
            value={value as MultiValue}
            lists={lists}
            onChange={(next) => set(def, next)}
            wrap={inPanel}
          />
        )
        return inPanel ? (
          <Field key={def.key} caption={def.label}>
            {chips}
          </Field>
        ) : (
          <div key={def.key}>{chips}</div>
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
          {chips.map(({ def, text, next }) => (
            <button
              key={`${def.key}:${text}`}
              type="button"
              // What the × writes comes from the chip, not from the filter: on
              // a multi-value facet it is "this value gone, the others kept".
              onClick={() => set(def, next)}
              className="chip chip-active"
              aria-label={`Remove the ${def.label.toLowerCase()} filter: ${text}`}
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

      {/* A chip group gets a row of its own, the way the status chips do: it is
          as wide as the library's vocabulary, and wrapped into the control bar
          it would push the sort and the disclosure off the first line. */}
      {barChips.map((def) => renderControl(def, false))}

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
              (def) => def.group === group.id && offered(def),
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
