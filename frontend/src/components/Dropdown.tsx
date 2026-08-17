import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Minus, Search } from 'lucide-react'
import type { MultiValue } from '@/lib/browse-filters'
import { cn } from '@/lib/utils'
import { CheckboxMark, Segmented } from './ui'

/**
 * The one dropdown in the app (§7.7).
 *
 * Everything that offers a list of things to pick goes through here: the
 * single-value selects (sort, a decade, a status) and the multi-value facets
 * (genre, certificate, format, library, server) alike, so that a dropdown
 * looks and behaves the same wherever it is met.
 *
 * ## The list matches the box it drops from
 *
 * The list opens 4px below the trigger, left edges aligned (right edges when
 * the trigger sits near the window's right edge), at least as wide as the
 * trigger; a bordered trigger gets a list of exactly its width. It flips above
 * when there is no room below, and it is **portalled** to the page so no
 * container can clip it. The current item is marked with the selected-row
 * look, never an accent background.
 *
 * ## What a floating layer owes
 *
 * - **Escape closes it and hands focus back to the trigger**, so the keyboard
 *   is never stranded in a layer over the page.
 * - **Pointer-down outside closes it**, on `pointerdown` rather than `click`
 *   so a tap that starts outside is not also delivered to whatever it lands on.
 * - **Focus leaving closes it**, which is what makes Tab an exit and not a trap.
 * - **It is unmounted when closed**, never faded. `opacity-0` leaves a panel's
 *   worth of controls armed and tappable over the grid; opacity is not a
 *   hit test.
 * - **Nothing is behind hover.** Hover only tints a row; every state a row can
 *   be in is drawn (a tick, a dash, a strike-through) and said in its
 *   accessible name.
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

/** More than about ten items earns a search field (§7.7); fewer has nothing to find. */
const SEARCHABLE_FROM = 10

/** The list's cap before it scrolls inside itself. */
const LIST_MAX_HEIGHT = 280

/** Stands in for the panel's height on the one frame before it is measured. */
const PANEL_ESTIMATE = LIST_MAX_HEIGHT + 88

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
 * Arrow / Home / End navigation over a menu's rows, plus typing to jump: a
 * printable character focuses the first row whose label starts with what was
 * typed, the way a native select does. The buffer clears after a pause.
 *
 * Takes the ref rather than the node: the handler is built while the list is
 * still being rendered, so reading `.current` here would capture the `null` it
 * held a moment before the panel mounted and the arrow keys would do nothing.
 */
function useMenuKeys(listRef: RefObject<HTMLElement | null>) {
  const buffer = useRef('')
  const timer = useRef<number>()

  return (event: ReactKeyboardEvent) => {
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
      default: {
        // Typing jumps, but only when the keystroke is not already feeding a
        // search box.
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) break
        if ((event.target as HTMLElement).tagName === 'INPUT') break
        window.clearTimeout(timer.current)
        buffer.current += event.key.toLowerCase()
        timer.current = window.setTimeout(() => {
          buffer.current = ''
        }, 500)
        const hit = items().find((item) =>
          (item.dataset.label ?? item.textContent ?? '')
            .trim()
            .toLowerCase()
            .startsWith(buffer.current),
        )
        hit?.focus()
        break
      }
    }
  }
}

/** The widest a bare trigger's list may grow (§7.7). */
const BARE_MAX = 240

/** The narrowest a menu may be (§7.1), so a search field is usable. */
const MENU_MIN = 190

/** Clear of the viewport edge, top and bottom. */
const EDGE = 8

/**
 * Where the open list sits, computed from the trigger's rectangle.
 *
 * `height` is the panel's real measured height once it has rendered, and the
 * estimate only on the first frame. It decides two things that a guess got
 * wrong: whether to flip above (a four-row list fits under a trigger near the
 * foot of the page, and used to flip anyway), and how much of the panel has to
 * be given up when neither side has room.
 */
function panelStyle(rect: DOMRect, exactWidth: boolean, height: number): CSSProperties {
  const style: CSSProperties = { position: 'fixed' }
  // A bordered trigger gets a list of its own width, floored at the menu
  // minimum: a narrow filter trigger would otherwise hand its search field a
  // 90px list. A bare trigger's list is its width or wider, up to 240.
  const width = exactWidth
    ? Math.max(rect.width, MENU_MIN)
    : Math.min(Math.max(rect.width, MENU_MIN), BARE_MAX)
  if (exactWidth) style.width = width
  else {
    style.minWidth = rect.width
    style.maxWidth = Math.min(BARE_MAX, window.innerWidth - 2 * EDGE)
  }

  // Left edges aligned, unless that would push the list off screen. The test
  // uses the width the panel may actually reach, not the floor: a bare panel
  // rendering at 240 against a 190 test sat flush to the window edge.
  if (rect.left + width > window.innerWidth - EDGE) {
    style.right = Math.max(EDGE, window.innerWidth - rect.right)
  } else {
    style.left = rect.left
  }

  // 4px below, or flipped 4px above when the room below has run out. Whichever
  // side is taken, the panel is then clamped into it: nothing here may leave
  // the viewport, because the search field and the first rows are at the top
  // and a panel hanging past it cannot be reached at all. Measured before
  // this: 69px off the top of a 500px window.
  const below = window.innerHeight - rect.bottom - 4 - EDGE
  const above = rect.top - 4 - EDGE
  if (height <= below || below >= above) {
    style.top = rect.bottom + 4
    style.maxHeight = Math.max(120, below)
  } else {
    style.bottom = window.innerHeight - rect.top + 4
    style.maxHeight = Math.max(120, above)
  }
  return style
}

/**
 * The trigger, the portalled list, and the plumbing that closes it.
 *
 * The panel's contents mount fresh on every open (a render prop rather than
 * children), which is what lets a search box and a frozen ordering reset
 * themselves without anything having to remember to clear them.
 */
function DropdownShell({
  label,
  summary,
  summaryNode,
  active,
  variant = 'bordered',
  fullWidth,
  triggerClassName,
  children,
}: {
  /** Names the control to a screen reader, whatever the trigger happens to say. */
  label: string
  /** What the trigger shows: the current selection, in the user's words. */
  summary: string
  /** The summary with structure (a mono count), where plain text is not enough. */
  summaryNode?: ReactNode
  /** Something is in force here: the label is drawn in full ink. */
  active?: boolean
  /**
   * `bordered` reads as a control on its own line or in a form row and gets a
   * list of exactly its width; `bare` is a word and a chevron for inside a
   * dense strip, whose list is at least its width (§7.7).
   */
  variant?: 'bordered' | 'bare'
  /**
   * Fill the line the control stands on, and open a list of the same width.
   * A form row and a filter that is alone on its line both want this; §7.7
   * calls it "full when alone on a line".
   */
  fullWidth?: boolean
  triggerClassName?: string
  children: (api: { close: () => void }) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({})
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const inside = (node: Node | null) =>
    Boolean(
      node && (wrapRef.current?.contains(node) || panelRef.current?.contains(node)),
    )

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const place = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    // The panel's own height once it exists, the estimate only on the frame
    // before it does. `scrollHeight` rather than the rendered height, because
    // the rendered one is already clamped by the last placement and would
    // ratchet the panel smaller on every re-place.
    const height = panelRef.current
      ? panelRef.current.scrollHeight + 2
      : PANEL_ESTIMATE
    setStyle(panelStyle(rect, variant === 'bordered', height))
  }

  // The list is anchored to the trigger but lives in a portal, so it has to
  // follow the trigger when the page scrolls or the window resizes. The
  // *first* placement happens in `toggle`, before the open render: mounted
  // unpositioned even for a frame, the panel sits in flow at the end of the
  // document, and its search box's autofocus scrolls the whole page down to
  // it — which is exactly what happened.
  useLayoutEffect(() => {
    if (!open) return
    // Again now that the panel is on the page and can be measured, so the
    // flip decision is made against the list it actually has rather than
    // against a constant.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, variant])

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (!open) return
    if (event.key === 'Escape') {
      // Stopped here so a page listening for Escape does not also act on the
      // same press; closing this layer is the whole of what was meant.
      event.stopPropagation()
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'Tab') {
      // Tab dismisses the layer back to its trigger, and the next Tab then
      // carries on through the page in the ordinary order. It cannot be left
      // to the default: the panel is portalled to the end of the document, so
      // "the next element" from inside it is the end of the page, and from the
      // trigger it is whatever follows on the strip while an open panel hangs
      // over the grid. Either way the keyboard ends up somewhere the eye is
      // not.
      event.preventDefault()
      close()
    }
  }

  const onBlur = () => {
    if (!open) return
    // Deferred a frame, then judged by where focus actually is. The panel is
    // portalled and its search box autofocuses while the portal is still
    // mounting, so at the instant the trigger blurs, `relatedTarget` points
    // into a subtree the refs have not caught up with yet; judging that
    // snapshot closed the panel in the same breath as opening it. A frame
    // later `document.activeElement` is settled: still inside means the focus
    // only moved within the control, and nowhere (`body`) is a click on the
    // page chrome, which the pointer listener already answers.
    requestAnimationFrame(() => {
      const now = document.activeElement
      if (now && now !== document.body && !inside(now)) setOpen(false)
    })
  }

  return (
    <div
      ref={wrapRef}
      // `cn` is a plain join, not a tailwind-merge: a class a caller passes
      // cannot beat one written here, it only sits beside it and loses to
      // whichever CSS rule is later. So the width is a *prop* rather than
      // something a `className` could be trusted to override.
      className={cn('relative min-w-0', fullWidth ? 'flex w-full' : 'inline-flex')}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${summary}`}
        title={`${label}: ${summary}`}
        onClick={() => {
          if (open) {
            close()
          } else {
            place()
            setOpen(true)
          }
        }}
        className={cn(
          'inline-flex min-w-0 items-center text-control',
          'transition-colors duration-hover ease-ease',
          fullWidth ? 'w-full' : 'max-w-[13rem]',
          variant === 'bordered' &&
            'h-button gap-1.5 rounded-ctl border border-line bg-transparent px-2.5 hover:border-line-dashed',
          variant === 'bordered' && open && 'border-line-dashed',
          variant === 'bare' &&
            'h-dropdown gap-1 rounded-[4px] px-1 hover:bg-control-hover hover:text-strong',
          // While open, the trigger holds its hover look (§7.7): a bordered
          // one keeps the dashed edge, a bare one keeps the fill.
          variant === 'bare' && open && 'bg-control-hover text-strong',
          active ? 'text-strong' : 'text-muted',
          triggerClassName,
        )}
      >
        <span className="truncate">{summaryNode ?? summary}</span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={cn(
            'ml-auto shrink-0 text-muted transition-transform duration-open ease-ease',
            open && 'rotate-180',
          )}
        />
      </button>

      {/* Unmounted when closed, so nothing inside is focusable or tappable
          while it is invisible. Portalled so no container can clip it. */}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={style}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            className="menu z-50 flex flex-col motion-safe:animate-rise"
          >
            {children({ close })}
          </div>,
          document.body,
        )}
    </div>
  )
}

/** The search field every long list gets, pinned at the top (§7.7, §7.11). */
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
    <div className="relative mb-1">
      <Search
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"
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
        className="field pl-8"
      />
    </div>
  )
}

/** Nothing matched the search: said, rather than an empty panel. */
const NoMatches = () => (
  <p className="px-2 py-3 text-center text-tiny text-dim">No matches.</p>
)

/**
 * A dropdown that picks one thing. The house replacement for `<select>`.
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
  variant,
  fullWidth,
  placeholder,
}: {
  label: string
  options: DropdownOption[]
  value: string
  onChange: (value: string) => void
  /** Shown when `value` names no option. Defaults to the field's own name. */
  placeholder?: string
  className?: string
  variant?: 'bordered' | 'bare'
  /** Fill the line: a form row, or a filter alone on its line (§7.7). */
  fullWidth?: boolean
}) {
  const current = options.find((option) => option.value === value)
  // A value that names no option is a stale URL or a list that has changed
  // under a saved view. Showing `options[0]` there reads as a filter that is
  // applied when it is not, and the user cannot tell the difference; the
  // field's own name in muted ink says "nothing chosen", exactly as the
  // multiple-choice trigger does.
  return (
    <DropdownShell
      label={label}
      summary={current?.label ?? placeholder ?? label}
      active={Boolean(current)}
      variant={variant}
      fullWidth={fullWidth}
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
  const menuKeys = useMenuKeys(listRef)
  const searchable = options.length > SEARCHABLE_FROM

  const needle = search.trim().toLowerCase()
  const visible = needle
    ? options.filter((option) => option.label.toLowerCase().includes(needle))
    : options

  // With no search field, the arrow keys have nothing to move *from* unless a
  // row takes focus on mount. The chosen row is the natural one; when the
  // value names no option (a stale URL) it is the first, or ArrowDown does
  // nothing at all and the keyboard is stranded on the trigger.
  const focusAt = Math.max(
    0,
    visible.findIndex((option) => option.value === value),
  )

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
        onKeyDown={menuKeys}
        // `overscroll-contain`: wheeling past the end of the list must not
        // hand the scroll to the page underneath, which moved 2160px.
        className="flex max-h-[280px] min-h-0 flex-col gap-px overflow-y-auto overscroll-contain"
      >
        {visible.length === 0 && <NoMatches />}
        {visible.map((option, index) => {
          const chosen = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              data-option=""
              data-label={option.label}
              role="menuitemradio"
              aria-checked={chosen}
              autoFocus={!searchable && index === focusAt}
              onClick={() => onPick(option.value)}
              className={cn('menu-item text-left', chosen && 'menu-item-selected')}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {/* The fill marks the current item; the check restates it, since
                  short labels can make the fill easy to miss. */}
              {chosen && (
                <Check size={16} aria-hidden="true" className="shrink-0 text-strong" />
              )}
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
 * A row cycles off → included → excluded → off. Three states in one row rather
 * than two parallel lists, because "not horror" is the same question as
 * "horror" asked backwards, and a second list of the same fifty genres doubles
 * the control to say so. The state is drawn (a tick, a dash in critical, a
 * strike-through), named (`aria-checked` is `mixed` for an exclusion, and the
 * accessible name says which state the row is in) and never carried by colour
 * alone. Toggling keeps the list open; changes apply live and there is no
 * Apply button.
 *
 * The rows in force are pinned to the top, but the ordering is frozen when the
 * panel opens, so ticking one does not make the list jump under the pointer
 * mid-selection. It re-sorts the next time the panel is opened, which is when
 * a reordering is information rather than an interruption.
 */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  andable,
  renderOption,
  variant,
  fullWidth,
}: {
  label: string
  options: DropdownOption[]
  value: MultiValue
  onChange: (next: MultiValue) => void
  /** Offer the any/all toggle. Only where a row can hold several values. */
  andable?: boolean
  /** Draws an option as something other than its plain text — a badge, say. */
  renderOption?: (option: DropdownOption) => ReactNode
  variant?: 'bordered' | 'bare'
  /** Fill the line: a form row, or a filter alone on its line (§7.7). */
  fullWidth?: boolean
}) {
  const known = new Map(options.map((option) => [option.value, option.label]))
  const chosen = [
    ...value.include.map((name) => known.get(name) ?? name),
    ...value.exclude.map((name) => `not ${known.get(name) ?? name}`),
  ]

  // The trigger summarises what is in force (§7.7): the field's own name when
  // nothing is, the item itself for one, both for two, a count beyond that.
  const summary =
    chosen.length === 0
      ? label
      : chosen.length <= 2
        ? chosen.join(', ')
        : `${chosen.length} selected`
  const summaryNode =
    chosen.length > 2 ? (
      <>
        <span className="figure">{chosen.length}</span> selected
      </>
    ) : undefined

  return (
    <DropdownShell
      label={label}
      summary={summary}
      summaryNode={summaryNode}
      active={chosen.length > 0}
      variant={variant}
      fullWidth={fullWidth}
    >
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
  const menuKeys = useMenuKeys(listRef)

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
  // "All" acts on the *visible* set, so a search narrows what it clears.
  const visibleSet = anySet
    ? ordered.filter(
        (option) =>
          value.include.includes(option.value) || value.exclude.includes(option.value),
      )
    : []

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
        onKeyDown={menuKeys}
        // `overscroll-contain`: wheeling past the end of the list must not
        // hand the scroll to the page underneath, which moved 2160px.
        className="flex max-h-[280px] min-h-0 flex-col gap-px overflow-y-auto overscroll-contain"
      >
        {/* The "All" row (§7.7): a three-state box in the same column as the
            items, separated by a hairline. Checked means nothing narrows this
            facet; a dash means some rows are in force, and clicking clears
            them (the visible ones, when a search is narrowing the list). */}
        <button
          type="button"
          data-option=""
          data-label="All"
          role="menuitemcheckbox"
          aria-checked={anySet ? 'mixed' : true}
          aria-label={anySet ? `${label}, some selected. Clear.` : `${label}, all shown.`}
          // Same reason as the single-choice panel: unsearchable, something has
          // to hold focus or the arrow keys have nothing to move from. "All" is
          // the first row, so it is the one.
          autoFocus={!searchable}
          title={anySet ? 'Clear the selection' : 'Nothing narrows this'}
          onClick={() => {
            if (!anySet) return
            const clearing = new Set(visibleSet.map((option) => option.value))
            onChange({
              ...value,
              include: value.include.filter((name) => !clearing.has(name)),
              exclude: value.exclude.filter((name) => !clearing.has(name)),
            })
          }}
          className="menu-item mb-1 border-b border-line pb-2 text-left"
        >
          <CheckboxMark state={anySet ? 'mixed' : true} />
          <span className="min-w-0 flex-1 truncate">All</span>
        </button>

        {ordered.length === 0 && <NoMatches />}
        {ordered.map((option) => {
          const included = value.include.includes(option.value)
          const excluded = value.exclude.includes(option.value)
          return (
            <button
              key={option.value}
              type="button"
              data-option=""
              data-label={option.label}
              role="menuitemcheckbox"
              aria-checked={included ? true : excluded ? 'mixed' : false}
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
              className="menu-item text-left"
            >
              {/* Drawn, not implied: a tick for in, a dash in critical for
                  out, an empty box for neither. The row keeps its plain look;
                  the box is the state, and the fill stays the hover cue. */}
              {excluded ? (
                <span
                  aria-hidden="true"
                  className="grid h-4 w-4 shrink-0 place-items-center rounded-tight
                             border border-critical bg-critical-bg text-critical"
                >
                  <Minus size={12} strokeWidth={3} />
                </span>
              ) : (
                <CheckboxMark state={included} />
              )}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  excluded && 'text-critical line-through',
                )}
              >
                {renderOption ? renderOption(option) : option.label}
              </span>
            </button>
          )
        })}
      </div>

      {/* Only where AND can change the answer: a title has several genres, but
          one studio and one certificate, so "all" over those is the empty set
          by construction, and over a single value it says nothing. */}
      {andable && value.include.length > 1 && (
        <div className="mt-1 border-t border-line px-1 pt-1.5">
          <Segmented
            label={`Match ${label.toLowerCase()}`}
            value={value.all ? 'all' : 'any'}
            onChange={(next) => onChange({ ...value, all: next === 'all' })}
            options={[
              { value: 'any', label: 'Any' },
              { value: 'all', label: 'All' },
            ]}
          />
        </div>
      )}
    </>
  )
}
