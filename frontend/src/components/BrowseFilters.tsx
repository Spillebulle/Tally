import {
  useEffect,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Bookmark,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useToast } from '@/lib/app-context'
import type { SavedView, SavedViewPage } from '@/lib/types'
import {
  chipsFor,
  choicesFor,
  FILTER_GROUPS,
  identity,
  isSet,
  NO_LISTS,
  type AnyFilterDef,
  type BrowseFilterState,
  type DateRangeValue,
  type FilterCtx,
  type FilterLists,
  type MultiValue,
} from '@/lib/browse-filters'
import { cn } from '@/lib/utils'
import { MultiSelect, Select } from './Dropdown'
import { RatingBadge } from './RatingBadge'
import { Checkbox, Segmented } from './ui'

/**
 * The controls that write the browse query.
 *
 * Everything about *what* the filters mean lives in `lib/browse-filters.ts`;
 * this file only knows how a `control.kind` looks. Adding a filter is one entry
 * in that table, and touches this file only if it needs a kind of control that
 * does not exist yet.
 *
 * ## It is one toolbar, and there is no second row of buttons
 *
 * The strip is §7.2: 36px, `chrome`, a hairline below, 12px of padding and
 * 12px gaps, bled out to the content column's edges so it reads as a strip
 * rather than as a box that happens to hold controls. Everything on it is a
 * control of a fixed height — a search field (§7.11) and dropdowns with no
 * fill (§7.7) — because a strip whose height depends on its contents is not a
 * strip.
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
 * The panel *pushes the page down* rather than floating over it — a layer the
 * size of a card, dropped over the grid, is a way to get a control stuck on
 * top of the content. It also opens by itself when the URL arrives with one of
 * its filters already set, so a shared link explains what is narrowing the grid
 * instead of hiding it.
 *
 * The one thing that *does* float is a dropdown, which belongs to the control
 * it hangs off and cannot shove the page down every time somebody glances at
 * the genre list. That is `components/Dropdown.tsx`, and it pays what a
 * floating layer owes — Escape, outside-click, focus-out, and unmounted rather
 * than faded when closed. Its list is portalled and positioned against the
 * viewport, which is what lets the strip scroll sideways on a narrow screen
 * without clipping the list off the edge.
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
 * row**, with its own dismiss mark. The two controls still on the bar do say it
 * twice, and that is the deliberate cost: a chip row that lists some filters
 * and not others is a chip row you cannot read as "this is what is narrowing
 * the grid".
 *
 * ## Saved views get the same treatment
 *
 * A shelf of saved views is the one control here that grows with use, so it
 * takes exactly one button beside "Filters" and its own push-down panel — see
 * `SavedViewsButton` below for why, and for why the button is absent entirely
 * until there is something to save or something to apply.
 */

/** The shelf a page's saved views are filed under. Both halves ask for it. */
const viewsKey = (page: SavedViewPage) => ['saved-views', page]

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

/**
 * The search field (§7.11): a leading magnifier, and a clear mark once there
 * is something to clear.
 *
 * The clear mark writes through the same draft the typing does, rather than
 * only emptying the URL. Clearing the URL alone loses a race it can only lose:
 * the debounce is still holding the last keystroke, so the field would empty
 * and then refill itself a quarter of a second later.
 */
function SearchField({
  value,
  placeholder,
  label,
  autoFocus,
  onCommit,
}: {
  value: string
  placeholder: string
  label: string
  autoFocus?: boolean
  onCommit: (value: string) => void
}) {
  // Remounts on a URL-driven change, which is what makes "clear" reach the
  // draft: the key changes, the draft is rebuilt from the new value, and no
  // pending timer survives to put the old text back.
  const [nonce, setNonce] = useState(0)

  return (
    // Narrower on a phone, where every pixel it takes is a pixel of the
    // scrolling strip that the controls after it have to share.
    <div className="relative w-[9.5rem] shrink-0 sm:w-[13rem]">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 size-icon -translate-y-1/2 text-dim"
      />
      <DraftInput
        key={nonce}
        type="search"
        autoFocus={autoFocus}
        value={value}
        onCommit={onCommit}
        placeholder={placeholder}
        aria-label={label}
        className="field pl-8 pr-7 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            setNonce((n) => n + 1)
            onCommit('')
          }}
          title="Clear the search"
          aria-label="Clear the search"
          className="absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center
                     rounded-tight text-muted transition-colors duration-hover
                     ease-ease hover:text-strong"
        >
          <X className="size-icon" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

/**
 * A dropdown over a filter's choices, addressed by index.
 *
 * By index, because a filter's value is not always a string — a decade is
 * `{min, max}`, a status is a word, a rating is a pair — and only the table
 * knows how to tell two of them apart. `identity` is that comparison; the
 * dropdown never sees a filter value at all, only the position of the one that
 * is selected.
 */
function ChoiceSelect({
  def,
  value,
  lists,
  ctx,
  onPick,
  variant,
}: {
  def: AnyFilterDef
  value: unknown
  lists: FilterLists
  ctx: FilterCtx
  onPick: (value: unknown) => void
  variant?: 'bordered' | 'bare'
}) {
  const choices = choicesFor(def, value, lists, ctx)
  const here = identity(def, value, ctx)
  const selected = choices.findIndex((choice) => identity(def, choice.value, ctx) === here)

  return (
    <Select
      label={def.label}
      options={choices.map((choice, index) => ({
        value: String(index),
        label: choice.label,
      }))}
      value={String(selected < 0 ? 0 : selected)}
      // Sized to its content, because these stand in a row rather than alone
      // on a line (§7.7). `fullWidth` is the other case, and no filter here
      // is in it.
      onChange={(next) => onPick(choices[Number(next)]?.value)}
      variant={variant}
    />
  )
}

/**
 * A multi-value facet, as a searchable dropdown.
 *
 * The three states and the any/all toggle are exactly what the chip row before
 * it had — this changes the control, not the filter. What it adds is the thing
 * a flat row could not do: a library with sixty genres, twenty certificates or
 * a dozen libraries per server does not fit on a bar, and the row that held
 * them scrolled sideways, which hides values behind a gesture nobody makes.
 *
 * The chip row above is untouched and is still the other half of the guarantee:
 * every value in force is listed there with its own dismiss mark, whether or
 * not this control is open.
 */
function MultiControl({
  def,
  value,
  lists,
  variant,
  onChange,
}: {
  def: AnyFilterDef
  value: MultiValue
  lists: FilterLists
  variant?: 'bordered' | 'bare'
  onChange: (next: MultiValue) => void
}) {
  const control = def.control.kind === 'multi' ? def.control : null
  return (
    <MultiSelect
      label={def.label}
      options={(def.options?.(lists) ?? []).map((choice) => ({
        value: choice.value,
        label: choice.label,
      }))}
      value={value}
      onChange={onChange}
      andable={Boolean(control?.andable)}
      variant={variant}
      // The table says *that* an option is a badge; drawing one is this file's
      // business. The badge needs the raw value as well as the label — the mark
      // is chosen by the board that issued the certificate, which only the raw
      // value names.
      //
      // The mark sits *beside* the label rather than replacing it. A board's
      // symbol is recognised at a glance but not always read at 20px — an MPA
      // card and an FSK disc both carry a line of descriptor text that becomes
      // a smudge at that size — and this is a list you search by typing, so the
      // words have to be there to scan. The mark earns recognition; the label
      // keeps it legible.
      renderOption={
        control?.style === 'badge'
          ? (option) => (
              <span className="flex min-w-0 items-center gap-2">
                <RatingBadge raw={option.value} label={option.label} fallback="none" />
                <span className="truncate">{option.label}</span>
              </span>
            )
          : undefined
      }
    />
  )
}

/**
 * Saved views: name the query you are looking at, and get it back later.
 *
 * ## Why it is a second disclosure and not more chrome on the bar
 *
 * The bar already carries search, status, genre, sort, direction and the
 * "Filters" disclosure. A shelf of saved views laid out flat beside those grows
 * with use — the one control here that gets *bigger* the more the feature is
 * used — and it would push the controls people reach for constantly onto a
 * second line, on a phone onto a third.
 *
 * So it takes one button, next to "Filters", opening a panel built the same way
 * (pushes the content down, unmounted when closed, so nothing inside is
 * focusable or tappable while hidden). The button only exists when it can do
 * something: when there is at least one view to apply, or something is
 * filtered and there is therefore a view worth saving. A fresh install sees no
 * extra chrome at all.
 *
 * The button and the panel are two components because they sit in two places —
 * one inside the 36px strip, one under it — and they share the list through
 * the query cache rather than through a prop, which is one key in two places
 * instead of one lifted state and two callbacks.
 */
function SavedViewsButton({
  state,
  open,
  onToggle,
}: {
  state: BrowseFilterState
  open: boolean
  onToggle: () => void
}) {
  const views = useQuery({
    queryKey: viewsKey(state.pageId),
    queryFn: () => api.views.list(state.pageId),
  })
  const list = views.data ?? []

  // Nothing to apply and nothing worth saving: no button at all.
  if (list.length === 0 && !state.active) return null

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="browse-saved-views"
      title="Saved views"
      className={cn('btn-ghost shrink-0 gap-1.5 px-2', open && 'bg-control text-strong')}
    >
      <Bookmark className="size-icon" aria-hidden="true" />
      {/* The label goes on a phone and the icon carries it, which buys the
          scrolling strip beside it about 90px of the controls it holds. The
          `title` is what keeps an icon-only control from being a guess. */}
      <span className="hidden sm:inline">Views</span>
      {list.length > 0 && <span className="figure text-strong">{list.length}</span>}
    </button>
  )
}

/**
 * ## What is offered, and what is not
 *
 * Saving is offered only when a filter is set — `state.active`, the same
 * derived flag that decides whether "Clear all" appears. A saved view of the
 * default grid is a bookmark for the page you are already on.
 *
 * There is no separate "update this view to the current query" control: saving
 * under a name that already exists re-points it, which is one endpoint, one
 * control and one thing to learn.
 *
 * Every button here reacts on click rather than on the refetch that follows —
 * pending labels on save and rename, and a two-step confirm on delete, which is
 * both the confirmation and the reaction. `window.confirm` would block the page
 * and say nothing about which view it means.
 */
function SavedViewsPanel({
  state,
  onApplied,
}: {
  state: BrowseFilterState
  onApplied: () => void
}) {
  const { notify } = useToast()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  /** The view being renamed, and the draft — one at a time, in place. */
  const [renaming, setRenaming] = useState<number | null>(null)
  const [rename, setRename] = useState('')
  /** Delete asks once. The first click is the reaction; the second is the act. */
  const [confirming, setConfirming] = useState<number | null>(null)

  const key = viewsKey(state.pageId)
  const views = useQuery({
    queryKey: key,
    queryFn: () => api.views.list(state.pageId),
  })
  const list = views.data ?? []

  const refresh = () => queryClient.invalidateQueries({ queryKey: key })

  const save = useMutation({
    mutationFn: (viewName: string) =>
      api.views.save(state.pageId, viewName, state.savedQuery),
    onSuccess: (view) => {
      setName('')
      notify(`Saved “${view.name}”`, 'success')
      void refresh()
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const patch = useMutation({
    mutationFn: (vars: { id: number; name: string }) =>
      api.views.update(vars.id, { name: vars.name }),
    onSuccess: (view) => {
      setRenaming(null)
      notify(`Renamed to “${view.name}”`, 'success')
      void refresh()
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.views.remove(id),
    onSuccess: () => {
      setConfirming(null)
      void refresh()
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const apply = (view: SavedView) => {
    state.applyView(view.query)
    onApplied()
  }

  return (
    <div
      id="browse-saved-views"
      className="flex flex-col gap-3 border-t border-line px-strip py-3"
    >
      {state.active ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const trimmed = name.trim()
            if (trimmed) save.mutate(trimmed)
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-[16rem]">
            <label className="text-tiny text-dim" htmlFor="saved-view-name">
              Save this view
            </label>
            <input
              id="saved-view-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder="Name it, e.g. “Weeknight films”"
              className="field"
            />
          </div>
          <button
            type="submit"
            disabled={!name.trim() || save.isPending}
            title={name.trim() ? undefined : 'Give the view a name first.'}
            className="btn-secondary"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <p className="w-full text-tiny text-dim">
            Saving under a name you already have updates it.
          </p>
        </form>
      ) : (
        <p className="text-tiny text-dim">
          Filter or sort the grid, then come back here to save it as a view.
        </p>
      )}

      {/* A failed request is not an empty list: say so, rather than
          reporting that the user has no saved views. */}
      {views.isError ? (
        <p className="flex items-center gap-2 text-tiny text-critical">
          Could not load your saved views.
          <button
            type="button"
            onClick={() => void views.refetch()}
            className="underline"
          >
            Try again
          </button>
        </p>
      ) : list.length === 0 ? (
        !views.isLoading && (
          <p className="text-tiny text-dim">No saved views on this page yet.</p>
        )
      ) : (
        // Capped rather than full-bleed: `ml-auto` puts each row's Rename
        // and Delete at its right edge, and on a wide screen that leaves
        // them a card's width away from the name they act on, reading as
        // controls for the panel instead of for the row.
        <ul className="flex flex-col sm:max-w-[28rem]">
          {list.map((view) => {
            // The view whose query is the one on screen. Compared against
            // the *canonicalised* query, so a view saved from a link that
            // spelled out a default still matches.
            const applied = view.query === state.savedQuery
            const busy = remove.isPending && remove.variables === view.id

            if (renaming === view.id) {
              return (
                <li key={view.id} className="py-1">
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      const trimmed = rename.trim()
                      if (trimmed) patch.mutate({ id: view.id, name: trimmed })
                    }}
                  >
                    <input
                      value={rename}
                      onChange={(event) => setRename(event.target.value)}
                      maxLength={80}
                      autoFocus
                      aria-label={`New name for ${view.name}`}
                      className="field w-full sm:w-[14rem]"
                    />
                    <button
                      type="submit"
                      disabled={!rename.trim() || patch.isPending}
                      title={rename.trim() ? undefined : 'A view needs a name.'}
                      className="btn-secondary"
                    >
                      {patch.isPending ? 'Renaming…' : 'Save name'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenaming(null)}
                      className="btn-ghost"
                    >
                      Cancel
                    </button>
                  </form>
                </li>
              )
            }

            return (
              <li
                key={view.id}
                className={cn(
                  'row gap-2 border-b border-line-soft px-2 last:border-b-0',
                  applied && 'row-selected',
                  busy && 'opacity-60',
                )}
              >
                <button
                  type="button"
                  onClick={() => apply(view)}
                  aria-label={
                    applied ? `${view.name}, applied` : `Apply the view ${view.name}`
                  }
                  // Written, not colour-alone: the applied view says so.
                  aria-current={applied ? 'true' : undefined}
                  className="flex min-w-0 shrink items-center gap-2 truncate text-left"
                >
                  <span className="truncate">{view.name}</span>
                  {applied && <span className="text-tiny text-dim">Applied</span>}
                </button>
                {/* Named after the row they act on, because "Rename" and
                    "Delete" repeated down a list say nothing about which
                    view they mean — to a screen reader they are five
                    identical buttons. */}
                <button
                  type="button"
                  aria-label={`Rename ${view.name}`}
                  onClick={() => {
                    setRenaming(view.id)
                    setRename(view.name)
                    setConfirming(null)
                  }}
                  className="btn-ghost ml-auto h-5 shrink-0 px-1.5 text-tiny"
                >
                  Rename
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={
                    confirming === view.id
                      ? `Confirm deleting ${view.name}`
                      : `Delete ${view.name}`
                  }
                  onClick={() =>
                    confirming === view.id
                      ? remove.mutate(view.id)
                      : setConfirming(view.id)
                  }
                  className={cn(
                    'btn-ghost h-5 shrink-0 px-1.5 text-tiny',
                    confirming === view.id && 'text-critical',
                  )}
                >
                  {busy
                    ? 'Deleting…'
                    : confirming === view.id
                      ? 'Confirm delete'
                      : 'Delete'}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** A control in the panel, under its own written caption. */
function Field({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-tiny text-dim">{caption}</span>
      {children}
    </div>
  )
}

export function BrowseFilters({
  state,
  lists: provided,
  busy,
  actions,
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
  /**
   * Controls that sit on this strip but are **not filters**: how the results
   * are drawn rather than which results they are. The poster size is the one
   * so far.
   *
   * A slot rather than another entry in the filter table, and that is the whole
   * point of it. Everything in that table is derived from — the chips, whether
   * "Clear all" appears, what `clear()` removes, the disclosure's count badge —
   * so a card size in there would put a chip reading "Large" in the filter row
   * and claim the grid was narrowed. It also must not survive `clear()`, and it
   * belongs to the reader rather than to the query.
   *
   * They sit with the view controls at the right, beside the Filters
   * disclosure, not in the scrolling filter run at the left.
   */
  actions?: ReactNode
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
  const [viewsOpen, setViewsOpen] = useState(false)

  const chips = defs.flatMap((def) => {
    if (def.role !== 'filter') return []
    const value = state.values[def.key]
    if (!isSet(def, value, ctx)) return []
    // One chip per *value*, not per filter: three genres are three chips with
    // three dismiss marks, because removing one of them must leave the other
    // two.
    return chipsFor(def, value, lists, ctx).map((chip) => ({ def, ...chip }))
  })

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

  // The bar itself: the handful nobody should have to open a panel for. Every
  // one of them is a control of a fixed height, which is what lets the strip
  // keep its 36px whatever is on it.
  const onBar = defs.filter((def) => !def.group && offered(def))

  const renderControl = (def: AnyFilterDef, inPanel: boolean) => {
    const value = state.values[def.key]

    switch (def.control.kind) {
      case 'search':
        return (
          <SearchField
            key={def.key}
            value={value as string}
            label={def.label}
            placeholder={def.control.placeholder}
            autoFocus={def.control.autoFocus}
            onCommit={(next) => set(def, next)}
          />
        )

      case 'toggle':
        // A boolean in the panel is a tick box (§7.12), not a pill: the row of
        // pills this used to be read as chips, and a chip in this language is
        // a read-only figure that never opens.
        return (
          <span key={def.key} className="flex h-button items-center">
            <Checkbox
              checked={Boolean(value)}
              onChange={(next) => set(def, next)}
              label={def.control.on}
            />
          </span>
        )

      case 'segmented': {
        const segmented = (
          <Segmented
            label={def.label}
            value={String(value)}
            onChange={(next) => set(def, next)}
            options={(def.choices?.(lists) ?? []).map((choice) => ({
              value: String(choice.value),
              label: choice.label,
            }))}
          />
        )
        // Stacked in the panel, where every control sits under its caption;
        // inline on the bar, where a stack would be two lines in a strip whose
        // height is fixed at 36px.
        return inPanel ? (
          <Field key={def.key} caption={def.control.caption}>
            {segmented}
          </Field>
        ) : (
          <span key={def.key} className="flex shrink-0 items-center gap-1.5">
            <span aria-hidden="true" className="text-tiny text-dim">
              {def.control.caption}
            </span>
            {segmented}
          </span>
        )
      }

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
                className="field figure w-[8.75rem]"
              />
              <span className="text-tiny text-dim">to</span>
              <input
                type="date"
                value={range.to ?? ''}
                min={range.from}
                aria-label={`${def.label} to`}
                onChange={(event) =>
                  set(def, { ...range, to: event.target.value || undefined })
                }
                className="field figure w-[8.75rem]"
              />
            </span>
          </Field>
        )
      }

      case 'multi': {
        // No caption on the bar: a multi trigger already names its own field
        // when nothing is picked ("Genre"), so a caption in front of it would
        // print the word twice.
        const control = (
          <MultiControl
            def={def}
            value={value as MultiValue}
            lists={lists}
            variant={inPanel ? 'bordered' : 'bare'}
            onChange={(next) => set(def, next)}
          />
        )
        return inPanel ? (
          <Field key={def.key} caption={def.label}>
            {control}
          </Field>
        ) : (
          <span key={def.key} className="shrink-0">
            {control}
          </span>
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
            variant={inPanel ? 'bordered' : 'bare'}
          />
        )
        return inPanel ? (
          <Field key={def.key} caption={def.label}>
            {select}
          </Field>
        ) : (
          // A select shows only its value, and "All" or "Title" alone says
          // nothing about which question it answers, so on the bar it carries
          // its field's name in front of it (§7.2's label-then-control). The
          // caption is decoration for the eye only: the trigger's own
          // accessible name already reads "Status: All".
          <span key={def.key} className="flex shrink-0 items-center gap-1.5">
            <span aria-hidden="true" className="text-tiny text-dim">
              {def.label}
            </span>
            {select}
          </span>
        )
      }

      default:
        return null
    }
  }

  const ascending = state.values.order === 'asc'

  return (
    // Bled out to the content column's edges: a strip that stops 12px short of
    // the page's own margin reads as a box, and §7.2 is a strip.
    <div className="-mx-strip mb-4 border-b border-line bg-chrome">
      <div className="flex h-toolbar items-center gap-3 px-strip">
        {/* Scrolls inside itself on a narrow screen rather than wrapping: the
            strip's height is part of the design, and the page must never
            scroll sideways (§6.4). The dropdown lists are portalled and
            positioned against the viewport, so nothing here can clip one. */}
        <div className="scroll-x scrollbar-none flex min-w-0 flex-1 items-center gap-3">
          {onBar.map((def) => renderControl(def, false))}

          <button
            type="button"
            onClick={() => state.set('order', ascending ? 'desc' : 'asc')}
            className="btn-icon shrink-0"
            title={ascending ? 'Sorted ascending. Reverse it.' : 'Sorted descending. Reverse it.'}
            aria-label={ascending ? 'Sorted ascending' : 'Sorted descending'}
          >
            {ascending ? (
              <ArrowUpNarrowWide className="size-icon" aria-hidden="true" />
            ) : (
              <ArrowDownWideNarrow className="size-icon" aria-hidden="true" />
            )}
          </button>
        </div>

        {busy && (
          <span className="hidden shrink-0 text-tiny text-dim sm:inline">Updating…</span>
        )}

        {actions}

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="browse-advanced-filters"
          title="Filters"
          className={cn('btn-ghost shrink-0 gap-1.5 px-2', open && 'bg-control text-strong')}
        >
          <SlidersHorizontal className="size-icon" aria-hidden="true" />
          <span className="hidden sm:inline">Filters</span>
          {state.advancedCount > 0 && (
            <span className="figure text-strong">{state.advancedCount}</span>
          )}
        </button>

        <SavedViewsButton
          state={state}
          open={viewsOpen}
          onToggle={() => setViewsOpen((value) => !value)}
        />
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line-soft px-strip py-1.5">
          {chips.map(({ def, text, next }) => (
            <button
              key={`${def.key}:${text}`}
              type="button"
              // What the dismiss mark writes comes from the chip, not from the
              // filter: on a multi-value facet it is "this value gone, the
              // others kept".
              onClick={() => set(def, next)}
              className="chip-removable"
              aria-label={`Remove the ${def.label.toLowerCase()} filter: ${text}`}
            >
              {!def.chipBare && <span className="text-dim">{def.label}</span>}
              {text}
              <X size={12} aria-hidden="true" className="text-muted" />
            </button>
          ))}
          <button type="button" onClick={state.clear} className="btn-ghost px-2">
            Clear all
          </button>
        </div>
      )}

      {/* Pushes the content down rather than floating over it — see the note at
          the top of this file. Unmounted when closed, so nothing inside it is
          focusable or tappable while hidden; `opacity-0` alone would leave a
          panel's worth of invisible controls armed over the grid. */}
      {open && (
        <div
          id="browse-advanced-filters"
          className="flex flex-col gap-4 border-t border-line px-strip py-3"
        >
          {FILTER_GROUPS.map((group) => {
            const members = defs.filter(
              (def) => def.group === group.id && offered(def),
            )
            if (members.length === 0) return null
            return (
              <section key={group.id}>
                <div className="mb-1.5 flex items-baseline gap-2">
                  <h3 className="eyebrow">{group.label}</h3>
                  <span className="text-tiny text-dim">{group.hint}</span>
                </div>
                <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
                  {members.map((def) => renderControl(def, true))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {viewsOpen && (
        <SavedViewsPanel state={state} onApplied={() => setViewsOpen(false)} />
      )}
    </div>
  )
}
