import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import type { MultiValue } from '@/lib/browse-filters'
import { cn } from '@/lib/utils'
import { CheckIcon, ChevronRightIcon, SearchIcon } from './Icons'
import { Segmented } from './ui'

/**
 * The one dropdown in the app.
 *
 * Everything that offers a list of things to pick goes through here — the
 * single-value selects (sort, a decade, a status) and the multi-value facets
 * (genre, certificate, format, library, server) alike — so that a dropdown
 * looks and behaves the same wherever it is met. Before this there were two
 * shapes: a native `<select>`, whose popup the page cannot style at all and
 * which arrives square-cornered and system-coloured in the middle of a rounded
 * surface, and a flat row of chips, which is fine for six genres and unusable
 * for sixty.
 *
 * ## Why this floats when the filter disclosure does not
 *
 * The "Filters" panel pushes the page down rather than floating, and that is
 * still right for a panel the size of a card. A *dropdown* cannot: it belongs
 * to the control it hangs off, and shoving the grid down every time somebody
 * glances at the genre list is worse than the layer it saves. So this is the
 * one floating layer here, and it pays the price a floating layer owes:
 *
 * - **Escape closes it and hands focus back to the trigger**, so the keyboard
 *   is never stranded in a layer over the page.
 * - **Pointer-down outside closes it**, on `pointerdown` rather than `click`
 *   so a tap that starts outside is not also delivered to whatever it lands on.
 * - **Focus leaving closes it**, which is what makes Tab an exit and not a trap.
 * - **It is unmounted when closed**, never faded. `opacity-0` leaves a panel's
 *   worth of controls armed and tappable over the grid — see the standing rule
 *   about opacity not being a hit test.
 * - **Nothing is behind hover.** Hover only tints a row; every state a row can
 *   be in is drawn (a tick, a minus, a strike-through) and said in its
 *   accessible name.
 *
 * ## Anchoring
 *
 * The panel anchors to whichever edge of its trigger keeps it on screen. A
 * control near the right of the filter bar would otherwise open a panel past
 * the window edge and take the whole page sideways with it, which is the exact
 * thing every horizontally-scrolling row in this app exists to prevent.
 */

/**
 * A choice a dropdown offers.
 *
 * `value` is what the caller round-trips and `label` is what it says, and the
 * two are deliberately not the same string: a certificate is stored as `pg_13`
 * and printed as `PG-13`, and only the stored form may reach a query.
 */
export interface DropdownOption {
  value: string
  label: string
}

/** Roughly the panel's widest rendering, for the "does it fit?" test. */
const PANEL_WIDTH = 288

/** Options above this many earn a search box; below it there is nothing to find. */
const SEARCHABLE_FROM = 6

/** Moves focus between the rows of a menu, for the arrow keys. */
function moveFocus(list: HTMLElement | null, delta: number) {
  const items = Array.from(
    list?.querySelectorAll<HTMLButtonElement>('[data-option]') ?? [],
  )
  if (items.length === 0) return
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    current < 0
      ? delta > 0
        ? 0
        : items.length - 1
      : (current + delta + items.length) % items.length
  items[next]?.focus()
}

/**
 * Arrow / Home / End navigation over a menu's rows.
 *
 * Takes the ref rather than the node: the handler is built while the list is
 * still being rendered, so reading `.current` here would capture the `null` it
 * held a moment before the panel mounted and the arrow keys would do nothing.
 */
const menuKeys =
  (listRef: RefObject<HTMLElement | null>) => (event: ReactKeyboardEvent) => {
    const list = listRef.current
    const items = () =>
      Array.from(list?.querySelectorAll<HTMLButtonElement>('[data-option]') ?? [])
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveFocus(list, 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveFocus(list, -1)
        break
      case 'Home':
        event.preventDefault()
        items()[0]?.focus()
        break
      case 'End': {
        event.preventDefault()
        const all = items()
        all[all.length - 1]?.focus()
        break
      }
      default:
        break
    }
  }

/**
 * The trigger, the panel, and the plumbing that closes it.
 *
 * The panel's contents mount fresh on every open — a render prop rather than
 * children — which is what lets a search box and a frozen ordering reset
 * themselves without anything having to remember to clear them.
 */
function DropdownShell({
  label,
  summary,
  active,
  triggerClassName,
  children,
}: {
  /** Names the control to a screen reader, whatever the trigger happens to say. */
  label: string
  /** What the trigger shows: the current selection, in the user's words. */
  summary: string
  /** Draw the trigger as narrowing something. */
  active?: boolean
  triggerClassName?: string
  children: (api: { close: () => void }) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [alignRight, setAlignRight] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const toggle = () => {
    if (open) {
      close()
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    // Enough room to the right, or hang it off the right edge instead.
    setAlignRight(Boolean(rect && rect.left + PANEL_WIDTH > window.innerWidth - 16))
    setOpen(true)
  }

  return (
    <div
      ref={wrapRef}
      className="relative inline-flex min-w-0"
      onKeyDown={(event) => {
        if (!open) return
        if (event.key === 'Escape') {
          // Stopped here so a page listening for Escape does not also act on
          // the same press — closing this layer is the whole of what was meant.
          event.stopPropagation()
          event.preventDefault()
          close()
        }
      }}
      onBlur={(event) => {
        if (!open) return
        const next = event.relatedTarget as Node | null
        // A null `relatedTarget` is focus going nowhere — a click on the page
        // chrome, which the pointer listener already answers. Closing here too
        // would fight it and swallow the click that reopens the control.
        if (next && !wrapRef.current?.contains(next)) setOpen(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${summary}`}
        title={`${label}: ${summary}`}
        onClick={toggle}
        className={cn(
          'inline-flex h-9 min-w-0 max-w-[13rem] items-center gap-1.5 rounded-xl border',
          'border-line bg-surface px-3 text-sm text-ink transition-colors',
          'hover:border-line-accent-soft',
          active && 'border-line-accent bg-accent-soft text-accent',
          triggerClassName,
        )}
      >
        <span className="truncate">{summary}</span>
        <ChevronRightIcon
          className={cn(
            'ml-auto shrink-0 text-xs text-muted transition-transform duration-200',
            open ? '-rotate-90' : 'rotate-90',
          )}
        />
      </button>

      {/* Unmounted when closed, so nothing inside is focusable or tappable
          while it is invisible. */}
      {open && (
        <div
          className={cn(
            'absolute top-full z-30 mt-1.5 w-max min-w-[11rem]',
            'max-w-[min(18rem,calc(100vw-2rem))] animate-fade-up rounded-2xl border',
            'border-line bg-surface p-1.5 shadow-lift',
            alignRight ? 'right-0' : 'left-0',
          )}
        >
          {children({ close })}
        </div>
      )}
    </div>
  )
}

/** The search box every long list gets, and short ones do not need. */
function OptionSearch({
  label,
  value,
  onChange,
  onEnterList,
  autoFocus,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  onEnterList: () => void
  autoFocus: boolean
}) {
  return (
    <div className="relative mb-1.5">
      <SearchIcon
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2
                   text-sm text-muted"
      />
      <input
        type="text"
        value={value}
        autoFocus={autoFocus}
        aria-label={`Filter ${label.toLowerCase()} options`}
        placeholder="Type to filter…"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Down into the list, and Enter as the shortcut for "the first one
          // that matched what I typed".
          if (event.key === 'ArrowDown' || event.key === 'Enter') {
            event.preventDefault()
            onEnterList()
          }
        }}
        className="input h-8 rounded-lg py-0 pl-8 text-sm"
      />
    </div>
  )
}

/** Nothing matched the search — said, rather than an empty panel. */
const NoMatches = () => (
  <p className="px-2 py-3 text-center text-xs text-muted">No matches.</p>
)

/**
 * A dropdown that picks one thing. The rounded replacement for `<select>`.
 *
 * Values are opaque strings the caller round-trips; `BrowseFilters` hands over
 * indices, because a filter's value can be an object and only the table knows
 * how to compare two of them.
 */
export function Select({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string
  options: DropdownOption[]
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  const current = options.find((option) => option.value === value)
  return (
    <DropdownShell
      label={label}
      summary={current?.label ?? options[0]?.label ?? '—'}
      triggerClassName={className}
    >
      {({ close }) => (
        <SelectPanel
          label={label}
          options={options}
          value={value}
          onPick={(next) => {
            onChange(next)
            close()
          }}
        />
      )}
    </DropdownShell>
  )
}

function SelectPanel({
  label,
  options,
  value,
  onPick,
}: {
  label: string
  options: DropdownOption[]
  value: string
  onPick: (value: string) => void
}) {
  const [search, setSearch] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const searchable = options.length > SEARCHABLE_FROM

  const needle = search.trim().toLowerCase()
  const visible = needle
    ? options.filter((option) => option.label.toLowerCase().includes(needle))
    : options

  return (
    <>
      {searchable && (
        <OptionSearch
          label={label}
          value={search}
          onChange={setSearch}
          onEnterList={() => moveFocus(listRef.current, 1)}
          autoFocus
        />
      )}
      <div
        ref={listRef}
        role="menu"
        aria-label={label}
        onKeyDown={menuKeys(listRef)}
        className="scrollbar-thin max-h-64 overflow-y-auto"
      >
        {visible.length === 0 && <NoMatches />}
        {visible.map((option) => {
          const chosen = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              data-option=""
              role="menuitemradio"
              aria-checked={chosen}
              autoFocus={!searchable && chosen}
              onClick={() => onPick(option.value)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm',
                'transition-colors hover:bg-raised hover:text-ink',
                chosen ? 'font-medium text-accent' : 'text-subtle',
              )}
            >
              <CheckIcon
                className={cn('shrink-0 text-xs', !chosen && 'opacity-0')}
                aria-hidden="true"
              />
              <span className="truncate">{option.label}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}

/**
 * A dropdown that picks several things, and can refuse some.
 *
 * A row is a three-state checkbox, cycling off → included → excluded → off.
 * Three states in one row rather than two parallel lists, because "not horror"
 * is the same question as "horror" asked backwards, and a second list of the
 * same fifty genres doubles the control to say so. The state is drawn (a tick,
 * a minus and a strike-through), named (`aria-checked` is `mixed` for an
 * exclusion, and the accessible name says which state the row is in) and never
 * carried by colour alone.
 *
 * The rows in force are pinned to the top — but the ordering is frozen when the
 * panel opens, so ticking one does not make the list jump under the pointer
 * mid-selection. It re-sorts the next time the panel is opened, which is when a
 * reordering is information rather than an interruption.
 */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  andable,
  renderOption,
}: {
  label: string
  options: DropdownOption[]
  value: MultiValue
  onChange: (next: MultiValue) => void
  /** Offer the any/all toggle. Only where a row can hold several values. */
  andable?: boolean
  /** Draws an option as something other than its plain text — a badge, say. */
  renderOption?: (option: DropdownOption) => ReactNode
}) {
  const known = new Map(options.map((option) => [option.value, option.label]))
  const chosen = [
    ...value.include.map((name) => known.get(name) ?? name),
    ...value.exclude.map((name) => `−${known.get(name) ?? name}`),
  ]

  // The trigger says what is in force, not just that something is. "Genre" over
  // a grid narrowed to two genres is a control that tells you nothing.
  const summary =
    chosen.length === 0
      ? label
      : chosen.length === 1
        ? chosen[0]
        : `${chosen[0]} +${chosen.length - 1}`

  return (
    <DropdownShell label={label} summary={summary} active={chosen.length > 0}>
      {() => (
        <MultiPanel
          label={label}
          options={options}
          value={value}
          onChange={onChange}
          andable={andable}
          renderOption={renderOption}
        />
      )}
    </DropdownShell>
  )
}

/** off → included → excluded → off, for one value. */
const cycle = (value: MultiValue, name: string): MultiValue => {
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

function MultiPanel({
  label,
  options,
  value,
  onChange,
  andable,
  renderOption,
}: {
  label: string
  options: DropdownOption[]
  value: MultiValue
  onChange: (next: MultiValue) => void
  andable?: boolean
  renderOption?: (option: DropdownOption) => ReactNode
}) {
  const [search, setSearch] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // Frozen at open: what was already in force sorts to the top, and stays where
  // it is for as long as the panel is on screen.
  const [pinned] = useState(() => new Set([...value.include, ...value.exclude]))

  const known = new Set(options.map((option) => option.value))
  // A value arrived at from a link — a stats drill, a bookmark, a facet click —
  // need not be one the library list offers. Appended rather than dropped: a
  // control showing "any genre" over a grid filtered to one is a control that
  // lies.
  const arrived: DropdownOption[] = [...value.include, ...value.exclude]
    .filter((name) => !known.has(name))
    .map((name) => ({ value: name, label: name }))

  const needle = search.trim().toLowerCase()
  const visible = [...arrived, ...options].filter(
    (option) =>
      !needle ||
      option.label.toLowerCase().includes(needle) ||
      option.value.toLowerCase().includes(needle),
  )
  // Stable by specification, so equal ranks keep the library's own ordering.
  const ordered = visible.sort(
    (a, b) => Number(pinned.has(b.value)) - Number(pinned.has(a.value)),
  )

  const searchable = options.length > SEARCHABLE_FROM
  const anySet = value.include.length + value.exclude.length > 0

  return (
    <>
      {searchable && (
        <OptionSearch
          label={label}
          value={search}
          onChange={setSearch}
          onEnterList={() => moveFocus(listRef.current, 1)}
          autoFocus
        />
      )}

      <div
        ref={listRef}
        role="menu"
        aria-label={label}
        onKeyDown={menuKeys(listRef)}
        className="scrollbar-thin max-h-64 overflow-y-auto"
      >
        {ordered.length === 0 && <NoMatches />}
        {ordered.map((option, index) => {
          const included = value.include.includes(option.value)
          const excluded = value.exclude.includes(option.value)
          return (
            <button
              key={option.value}
              type="button"
              data-option=""
              role="menuitemcheckbox"
              aria-checked={included ? true : excluded ? 'mixed' : false}
              autoFocus={!searchable && index === 0}
              aria-label={`${option.label}${
                included ? ', included' : excluded ? ', excluded' : ''
              }`}
              title={
                included
                  ? `Exclude ${option.label}`
                  : excluded
                    ? `Stop excluding ${option.label}`
                    : `Include ${option.label}`
              }
              onClick={() => onChange(cycle(value, option.value))}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left
                         text-sm text-subtle transition-colors hover:bg-raised hover:text-ink"
            >
              {/* Drawn, not implied: a tick for in, a minus for out, an empty
                  box for neither. */}
              <span
                aria-hidden="true"
                className={cn(
                  'grid h-4 w-4 shrink-0 place-items-center rounded border text-[0.7rem]',
                  'font-bold leading-none',
                  included && 'border-accent bg-accent text-accent-ink',
                  excluded && 'border-danger bg-danger text-surface',
                  !included && !excluded && 'border-line',
                )}
              >
                {included ? <CheckIcon /> : excluded ? '–' : null}
              </span>
              <span className={cn('truncate', excluded && 'text-danger line-through')}>
                {renderOption ? renderOption(option) : option.label}
              </span>
            </button>
          )
        })}
      </div>

      {(anySet || (andable && value.include.length > 1)) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-line px-1 pt-1.5">
          {/* Only where AND can change the answer: a title has several genres,
              but one studio and one certificate, so "all" over those is the
              empty set by construction — and over a single value it says
              nothing. */}
          {andable && value.include.length > 1 && (
            <Segmented
              label={`Match ${label.toLowerCase()}`}
              value={value.all ? 'all' : 'any'}
              onChange={(next) => onChange({ ...value, all: next === 'all' })}
              options={[
                { value: 'any', label: 'Any' },
                { value: 'all', label: 'All' },
              ]}
            />
          )}
          {anySet && (
            <button
              type="button"
              onClick={() => onChange({ include: [], exclude: [], all: false })}
              className="ml-auto px-1 text-xs font-medium text-muted hover:text-danger"
            >
              Clear {label.toLowerCase()}
            </button>
          )}
        </div>
      )}
    </>
  )
}
