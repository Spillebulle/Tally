import {
  useEffect,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useToast } from '@/lib/app-context'
import type { SavedView } from '@/lib/types'
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
 *
 * ## Saved views get the same treatment
 *
 * A shelf of saved views is the one control here that grows with use, so it
 * takes exactly one button beside "Filters" and its own push-down panel — see
 * `SavedViews` below for why, and for why the button is absent entirely until
 * there is something to save or something to apply.
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

/**
 * Saved views: name the query you are looking at, and get it back later.
 *
 * ## Why it is a second disclosure and not more chrome on the bar
 *
 * The bar already carries status chips, a genre row, sort, direction, search
 * and the "Filters · N" disclosure. A shelf of saved views laid out flat beside
 * those grows with use — the one control here that gets *bigger* the more the
 * feature is used — and it would push the controls people reach for constantly
 * onto a second line, on a phone onto a third.
 *
 * So it takes one button, next to "Filters", opening a panel built the same way
 * (pushes the content down, unmounted when closed, so nothing inside is
 * focusable or tappable while hidden). The button only exists when it can do
 * something: when there is at least one view to apply, or something is
 * filtered and there is therefore a view worth saving. A fresh install sees no
 * extra chrome at all.
 *
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
function SavedViews({ state }: { state: BrowseFilterState }) {
  const { notify } = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  /** The view being renamed, and the draft — one at a time, in place. */
  const [renaming, setRenaming] = useState<number | null>(null)
  const [rename, setRename] = useState('')
  /** Delete asks once. The first click is the reaction; the second is the act. */
  const [confirming, setConfirming] = useState<number | null>(null)

  const key = ['saved-views', state.pageId]
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

  // Nothing to apply and nothing worth saving: no button at all.
  if (list.length === 0 && !state.active) return null

  const apply = (view: SavedView) => {
    state.applyView(view.query)
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="browse-saved-views"
        className="btn-outline h-9 gap-1.5 px-3 text-sm"
      >
        <ChevronRightIcon
          className={cn('text-xs transition-transform duration-200', open && 'rotate-90')}
        />
        Views
        {list.length > 0 && <span className="tabular-nums">· {list.length}</span>}
      </button>

      {open && (
        // `order-last` because this sits inside the control bar's flex row, so
        // that opening it drops the panel below the whole row rather than
        // between the buttons and the "Updating…" note that follows them. DOM
        // order still puts it straight after its own button, which is where a
        // keyboard should find it.
        <div id="browse-saved-views" className="card order-last w-full space-y-4 p-4">
          {state.active ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                const trimmed = name.trim()
                if (trimmed) save.mutate(trimmed)
              }}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
                <label className="label" htmlFor="saved-view-name">
                  Save this view
                </label>
                <input
                  id="saved-view-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  placeholder="Name it, e.g. “Weeknight films”"
                  className="input h-9 py-0 text-sm"
                />
              </div>
              <button
                type="submit"
                disabled={!name.trim() || save.isPending}
                className="btn-primary h-9 px-3 text-sm"
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
              <p className="w-full text-xs text-muted">
                Saving under a name you already have updates it.
              </p>
            </form>
          ) : (
            <p className="text-xs text-muted">
              Filter or sort the grid, then come back here to save it as a view.
            </p>
          )}

          {/* A failed request is not an empty list: say so, rather than
              reporting that the user has no saved views. */}
          {views.isError ? (
            <p className="flex items-center gap-2 text-xs text-danger">
              Could not load your saved views.
              <button
                type="button"
                onClick={() => void views.refetch()}
                className="font-medium underline"
              >
                Try again
              </button>
            </p>
          ) : list.length === 0 ? (
            !views.isLoading && (
              <p className="text-xs text-muted">No saved views on this page yet.</p>
            )
          ) : (
            // Capped rather than full-bleed: `ml-auto` puts each row's Rename
            // and Delete at its right edge, and on a wide screen that leaves
            // them a card's width away from the name they act on, reading as
            // controls for the panel instead of for the row.
            <ul className="flex flex-col gap-1.5 sm:max-w-md">
              {list.map((view) => {
                // The view whose query is the one on screen. Compared against
                // the *canonicalised* query, so a view saved from a link that
                // spelled out a default still matches.
                const applied = view.query === state.savedQuery
                const busy = remove.isPending && remove.variables === view.id

                if (renaming === view.id) {
                  return (
                    <li key={view.id}>
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
                          className="input h-8 w-full py-0 text-sm sm:w-56"
                        />
                        <button
                          type="submit"
                          disabled={!rename.trim() || patch.isPending}
                          className="btn-primary h-8 px-3 text-xs"
                        >
                          {patch.isPending ? 'Renaming…' : 'Save name'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenaming(null)}
                          className="btn-ghost h-8 px-2 text-xs"
                        >
                          Cancel
                        </button>
                      </form>
                    </li>
                  )
                }

                return (
                  <li key={view.id} className={cn('flex items-center gap-1.5', busy && 'opacity-60')}>
                    <button
                      type="button"
                      onClick={() => apply(view)}
                      aria-label={
                        applied ? `${view.name}, applied` : `Apply the view ${view.name}`
                      }
                      // Written, not colour-alone: the applied view says so.
                      aria-current={applied ? 'true' : undefined}
                      className={cn('chip min-w-0 shrink', applied && 'chip-active')}
                    >
                      <span className="truncate">{view.name}</span>
                      {applied && <span className="text-[0.65rem] uppercase">Applied</span>}
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
                      className="btn-ghost ml-auto h-8 shrink-0 px-2 text-xs"
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
                        'btn-ghost h-8 shrink-0 px-2 text-xs',
                        confirming === view.id && 'text-danger',
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
      )}
    </>
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

        <SavedViews state={state} />

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
