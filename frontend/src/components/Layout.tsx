/*
 * The hosted web shell: STYLE-GUIDE.md section 6.2, and nothing more.
 *
 *   Top bar   34px, `chrome`, hairline below. The mark and the app name at the
 *             left; the global status and the session control at the right.
 *             This bar is the menu bar. It holds no page navigation.
 *   Sidebar   240px, `dock`, hairline right. Section eyebrows, 30px nav rows,
 *             and a footer with the version, the licence and where this build
 *             came from.
 *   Content   over `window`, capped at 1200px. A page is a panel interior; the
 *             `backdrop` pit is for a canvas, and Tally has none.
 *   Status    26px strip along the foot of the content column, 10.5px
 *             `text-dim`, groups separated by " . ".
 *
 * Two shell decisions worth writing down, because both had a defensible
 * alternative:
 *
 * **Search is not in the top bar.** Section 7.2 puts filters and search in the
 * toolbar above the table or board they narrow, and Tally already has that
 * strip (BrowseFilters). A second, permanent search field in the menu bar says
 * the same thing twice on every browse page and says it in the one strip the
 * guide keeps for the app rather than the page. So the global entry point is a
 * *destination* instead: a Search row in the sidebar, and the "/" shortcut,
 * which used to focus the top-bar box, now goes to that destination.
 *
 * **Below 1024px the sidebar becomes a drawer, not bar navigation.** Bar
 * navigation is offered for five destinations or fewer (section 6.3) and Tally
 * has eight. Cutting three to fit would either hide real destinations behind a
 * "More" item or fold Movies, Shows and Anime into one, and neither is a
 * smaller loss than a menu button.
 *
 * **One rule for tooltips**, applied throughout this file: a `title` is a
 * sentence and takes a full stop (section 12), and its `aria-label` carries the
 * same string. A trailing stop is a pause to a screen reader rather than a
 * word, so the two are kept identical instead of drifting apart by a character.
 */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bookmark,
  ChartColumn,
  Clock,
  Film,
  House,
  LogOut,
  Menu,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Tv,
  X,
  type LucideIcon,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth, useToast } from '@/lib/app-context'
import type { SyncStatus } from '@/lib/types'
import { cn, initials, relativeTime } from '@/lib/utils'
import { ProgressBar } from './ui'
import { Logo } from './Brand'
import { DockerIcon, GitHubIcon } from './Icons'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
}

/*
 * Eight destinations is exactly the count section 6.2 wants grouped. Home
 * stands on its own above the groups: an eyebrow over a single row labels
 * nothing.
 */
const NAV_GROUPS: Array<{ eyebrow?: string; items: NavItem[] }> = [
  { items: [{ to: '/', label: 'Home', icon: House, end: true }] },
  {
    eyebrow: 'Library',
    items: [
      { to: '/movies', label: 'Movies', icon: Film },
      { to: '/shows', label: 'Shows', icon: Tv },
      { to: '/anime', label: 'Anime', icon: Sparkles },
      { to: '/watchlist', label: 'Watchlist', icon: Bookmark },
      { to: '/search', label: 'Search', icon: Search },
    ],
  },
  {
    eyebrow: 'Activity',
    items: [
      { to: '/history', label: 'History', icon: Clock },
      { to: '/stats', label: 'Stats', icon: ChartColumn },
    ],
  },
]

/** Settings sits at the foot of the column, away from the destinations. */
const SETTINGS_ITEM: NavItem = { to: '/settings', label: 'Settings', icon: Settings }

/* ── What is floating right now ──────────────────────────────────────────── */

/*
 * A register of the menus and popovers that are open.
 *
 * The "/" shortcut is global, so it fires while a menu has the user's
 * attention: it then navigated out from under that menu and left it mounted,
 * floating over a page it no longer belonged to. The shortcut has to know
 * whether anything is open, and the things that open are children of the shell,
 * so they say so here and the shortcut stands aside.
 *
 * A `Set` behind a ref rather than state: the shortcut reads it at the moment
 * the key is pressed, and re-rendering the whole shell every time a menu opens
 * would buy nothing.
 */
const OverlayContext = createContext<Set<string> | null>(null)

function useOverlay(open: boolean) {
  const registry = useContext(OverlayContext)
  const id = useId()
  useEffect(() => {
    if (!open || !registry) return
    registry.add(id)
    return () => {
      registry.delete(id)
    }
  }, [open, registry, id])
}

/* ── Navigation ──────────────────────────────────────────────────────────── */

function NavRow({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      end={item.end}
      // In the drawer, tapping a row is the whole gesture, so it closes the
      // drawer itself. It has to: the row for the page already open changes no
      // path, and watching the path was the only way out.
      onClick={onNavigate}
      className={({ isActive }) => cn('nav-row', isActive && 'nav-row-selected')}
    >
      {/* The icon takes the row's own colour, so it is `text-muted` at rest and
          `text-strong` when the row is selected without being told twice. */}
      <Icon size={16} aria-hidden="true" />
      {item.label}
    </NavLink>
  )
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-px" aria-label="Main">
      {NAV_GROUPS.map((group, index) => (
        <div
          key={group.eyebrow ?? 'home'}
          className={cn('flex flex-col gap-px', index > 0 && 'mt-3')}
        >
          {group.eyebrow && <p className="eyebrow px-strip pb-1">{group.eyebrow}</p>}
          {group.items.map((item) => (
            <NavRow key={item.to} item={item} onNavigate={onNavigate} />
          ))}
        </div>
      ))}
    </nav>
  )
}

/**
 * The version, the licence and where this build came from, at the foot of the
 * sidebar.
 *
 * Section 12 gives the pairing verbatim, "v0.0.8 · GPL-3.0", and section 6.2
 * names the sidebar footer as where version and build info live. So both facts
 * sit here and the top bar carries neither: printing the version in two corners
 * of one screen reads as two numbers rather than as one.
 */
function SidebarFooter() {
  const { data } = useQuery({
    queryKey: ['app-version'],
    queryFn: api.settings.version,
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const links = [
    { href: data?.github_url, label: 'Source on GitHub.', icon: GitHubIcon },
    { href: data?.dockerhub_url, label: 'Image on Docker Hub.', icon: DockerIcon },
  ]

  return (
    <div className="flex h-status shrink-0 items-center justify-between gap-2 border-t border-line px-strip">
      <span className="truncate text-tiny text-dim">
        {data && (
          <>
            {/* A version is read as a value, so it is monospaced and tabular. */}
            <span className="figure">v{data.version}</span> ·{' '}
          </>
        )}
        Apache-2.0
      </span>
      <span className="flex items-center gap-1">
        {links.map(({ href, label, icon: Icon }) =>
          href ? (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              title={label}
              aria-label={label}
              className="btn-icon h-5 w-5"
            >
              {/* A brand mark is a picture, not type: it takes the icon size
                  the guide fixes (16 in a button), not the strip's 10.5px. */}
              <Icon width={16} height={16} />
            </a>
          ) : null,
        )}
      </span>
    </div>
  )
}

/* ── Sync ────────────────────────────────────────────────────────────────── */

/**
 * One line describing the sync, for tooltips and screen readers.
 *
 * A tooltip is a sentence, so every branch ends in a full stop, the phase the
 * server names included. That phase reads as one ("Importing history from
 * Basement"), which is why it can carry the stop rather than needing a sentence
 * built around it.
 */
export function syncLabel(status: SyncStatus | undefined, starting = false): string {
  if (starting) return 'Starting sync.'
  if (!status?.running) return 'Sync with Plex now.'
  if (status.cancel_requested) return 'Cancelling after the current step.'
  if (!status.phase) return 'Sync in progress.'
  return status.progress_total > 0
    ? `${status.phase} · ${status.progress_current} of ${status.progress_total}.`
    : `${status.phase}.`
}

/**
 * A 3px rail (section 7.18) with an accent fill when the phase knows how much
 * work it has, and the one permitted sliding bar when it does not.
 *
 * `sliding` belongs to the caller, because "the total is unknown" and "nothing
 * is running" are two different facts and only the first earns the animation.
 * The guide allows the sliding third-width bar "only where the total genuinely
 * cannot be known", which is a running phase reporting a total of 0, or the
 * moment between the click and the first status that confirms it. An idle rail
 * is neither: it draws an empty track, and the line beside it says why.
 *
 * The default is `true`, so `status={undefined}` still reads as "clicked,
 * nothing back yet" for a caller that only mounts this while a run is starting.
 */
export function SyncProgress({
  status,
  sliding = true,
}: {
  status?: SyncStatus
  sliding?: boolean
}) {
  const total = status?.progress_total ?? 0
  const determinate = total > 0

  return (
    <ProgressBar
      className="mt-2"
      fraction={determinate && status ? status.progress_current / total : null}
      sliding={!determinate && sliding}
      label={
        determinate && status ? (
          // Separators, not compact notation: a counter ticking through
          // "45.2K" for thousands of items looks stuck.
          <span className="figure">
            {status.progress_current.toLocaleString()} of {total.toLocaleString()}
          </span>
        ) : undefined
      }
    />
  )
}

/** How a finished run is described, by the status the server recorded for it. */
const RUN_OUTCOME: Record<string, string> = {
  success: 'Last sync finished',
  partial: 'Last sync finished with problems',
  failed: 'Last sync failed',
  cancelled: 'Last sync was cancelled',
}

/**
 * The sync control: an icon button in the top bar with a popover carrying the
 * phase, the progress rail and the cancel path.
 *
 * The popover opens on **click**, not on hover. Hover is not a gesture a touch
 * screen has, and the cancel button lives in there, so on a phone the old hover
 * card made stopping a sync unreachable. Clicking while a sync runs opens the
 * detail rather than starting a second one.
 *
 * It has three things it can say and it must never say the wrong one:
 *
 *   running   the phase, the rail, and a Cancel that works.
 *   starting  a run has been asked for and no status has confirmed it yet.
 *             The rail slides, because the total genuinely cannot be known.
 *   idle      what the last run did and when. The rail is drawn empty.
 *
 * The third is also where a *failed* trigger lands, because the click opens the
 * popover whether or not the request succeeds. It used to fall through to the
 * second and claim a sync was starting, animating a rail over nothing, while
 * the status strip two hundred pixels below said the last sync had just
 * finished.
 */
function SyncControl() {
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOverlay(open)

  // Held from the click until the poll catches up. Mirrored into a ref so the
  // poll interval below can read it without the query being rebuilt.
  const [requested, setRequested] = useState(false)
  const requestedRef = useRef(false)
  requestedRef.current = requested
  const requestedAt = useRef(0)

  const { data: status, dataUpdatedAt } = useQuery({
    queryKey: ['sync-status'],
    queryFn: api.sync.status,
    // Poll faster while a sync is running so the rail reflects reality, and
    // while one has been asked for, so the wait to find out is short.
    refetchInterval: (query) =>
      query.state.data?.running || requestedRef.current ? 3000 : 30_000,
  })

  const mutation = useMutation({
    mutationFn: () => api.sync.trigger(false, true),
    onSuccess: () => {
      notify('Sync started. A first run can take a few minutes.', 'info')
      queryClient.invalidateQueries({ queryKey: ['sync-status'] })
    },
    onError: (error: Error) => {
      // Nothing is going to start, so stop saying one is about to.
      setRequested(false)
      notify(error.message, 'error')
    },
  })

  const cancel = useMutation({
    mutationFn: api.sync.cancel,
    onSuccess: () => {
      notify('Stopping after the current step.', 'info')
      queryClient.invalidateQueries({ queryKey: ['sync-status'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  /*
   * `mutation.isPending` alone left a gap. The request settles before the
   * status poll reports the run, so the spinner stopped and then started again
   * a second later. `requested` bridges it, and three things close it, because
   * a flag that only ever gets set is the same lie the other way round.
   */
  useEffect(() => {
    if (!requested) return
    if (status?.running) {
      setRequested(false)
      return
    }
    // A status read well after the click that still reports nothing running:
    // the run either finished inside the gap or never started at all.
    if (dataUpdatedAt > requestedAt.current + 3000) {
      setRequested(false)
      return
    }
    // And a backstop for the case where the status request is itself failing,
    // so `dataUpdatedAt` never moves and neither of the above can fire.
    const timer = window.setTimeout(() => setRequested(false), 15_000)
    return () => window.clearTimeout(timer)
  }, [requested, status?.running, dataUpdatedAt])

  const running = Boolean(status?.running)
  const starting = (mutation.isPending || requested) && !running
  const busy = running || starting
  const label = syncLabel(status, starting)
  const lastRun = status?.last_run

  const headline = running
    ? status?.cancel_requested
      ? 'Stopping after the current step'
      : (status?.phase ?? 'Sync in progress')
    : starting
      ? 'Starting sync'
      : lastRun?.finished_at
        ? `${RUN_OUTCOME[lastRun.status] ?? 'Last sync finished'} ${relativeTime(lastRun.finished_at)}.`
        : 'No sync has finished yet.'

  // A cancel already in flight, whether the button knows it from its own
  // request or from the status coming back with the flag set.
  const stopping = cancel.isPending || Boolean(status?.cancel_requested)
  const cancelTitle = stopping
    ? 'Already stopping. The run ends after the current step.'
    : running
      ? 'Stop after the current step.'
      : starting
        ? 'The sync has not started yet.'
        : 'No sync is running.'

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative flex items-center gap-2">
      {busy && (
        <span className="hidden max-w-[15rem] truncate text-tiny text-dim sm:inline">
          {starting ? 'Starting sync' : (status?.phase ?? 'Sync in progress')}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          if (busy) setOpen((value) => !value)
          else {
            requestedAt.current = Date.now()
            setRequested(true)
            mutation.mutate()
            setOpen(true)
          }
        }}
        className="btn-icon"
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <RefreshCw size={16} className={cn(busy && 'motion-safe:animate-spin')} />
      </button>

      {open && (
        // A dialog, not a live region. `role="status"` re-announced the whole
        // panel on every three-second poll, and it hid the two things in here
        // worth discovering: the Escape key, and a button. The one line worth
        // hearing when it changes is marked live on its own.
        <div
          role="dialog"
          aria-label="Sync status"
          className="menu absolute right-0 top-full z-40 mt-1 w-64 animate-rise"
        >
          <p aria-live="polite" className="px-1 pt-1 text-control text-strong">
            {headline}
          </p>
          <div className="px-1">
            <SyncProgress status={running ? status : undefined} sliding={busy} />
          </div>
          <button
            type="button"
            onClick={() => cancel.mutate()}
            disabled={!running || stopping}
            title={cancelTitle}
            className="btn-outline mt-2 w-full"
          >
            {stopping ? 'Stopping…' : 'Cancel sync'}
          </button>
        </div>
      )}
    </div>
  )
}

/* ── Session ─────────────────────────────────────────────────────────────── */

/**
 * Who is signed in, and the way out.
 *
 * There is no Settings row in here. Section 6.2 keeps page navigation out of
 * the top bar entirely, and the sidebar already carries Settings at the foot of
 * its own column.
 */
function UserMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOverlay(open)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!user) return null
  const name = user.display_name || user.username
  const menuLabel = `Account menu for ${name}.`

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-[22px] w-[22px] items-center justify-center overflow-hidden rounded-full
                   border border-line bg-control text-tiny text-fg transition-colors
                   duration-hover ease-ease hover:bg-control-hover hover:text-strong"
        aria-haspopup="menu"
        aria-expanded={open}
        title={menuLabel}
        aria-label={menuLabel}
      >
        {user.avatar_url ? (
          <img src={user.avatar_url} alt="" className="h-full w-full object-cover" />
        ) : (
          initials(name)
        )}
      </button>

      {open && (
        <div role="menu" className="menu absolute right-0 top-full z-40 mt-1 w-56 animate-rise">
          <div className="px-2.5 pb-1.5 pt-1">
            <p className="truncate text-control text-strong">{name}</p>
            <p className="truncate text-tiny text-dim">
              {user.plex_username ? `Plex · ${user.plex_username}` : 'Local account'}
            </p>
          </div>
          <div className="menu-separator" />
          <button type="button" role="menuitem" onClick={() => void logout()} className="menu-item">
            <LogOut size={16} aria-hidden="true" /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}

/* ── Toasts ──────────────────────────────────────────────────────────────── */

/** What a toast that is not merely informational says about itself, in words. */
const TOAST_TONE = {
  error: { label: 'Error', className: 'badge-critical' },
  success: { label: 'Done', className: 'badge-good' },
} as const

/**
 * Bottom right, floating-panel styling, one sentence and at most one action
 * (section 7.17). Never more than three at once; the rest collapse into a
 * count, because a fourth panel covers the page it is reporting on.
 *
 * Tone is written, not only coloured. A 6px dot in `critical` or `good` with
 * nothing beside it is status carried by hue alone, which is the one thing this
 * language never does, so the dot became a badge with a word in it.
 */
function Toasts() {
  const { toasts, dismiss, dismissAll } = useToast()
  if (toasts.length === 0) return null

  const shown = toasts.slice(-3)
  const hidden = toasts.length - shown.length

  return (
    <div
      // `bottom-status` plus a margin clears the fixed status strip: a toast
      // sitting on top of it hides the one line that says what the app is
      // doing, which is often the line the toast is about.
      className="pointer-events-none fixed bottom-status right-4 z-50 mb-2 flex
                 w-[min(20rem,calc(100vw-2rem))] flex-col gap-2"
      role="region"
      aria-live="polite"
      aria-label="Notifications"
    >
      {hidden > 0 && (
        <div className="floating pointer-events-auto flex items-center justify-between gap-2 p-strip">
          <span className="text-tiny text-dim">
            <span className="figure">{hidden}</span> more {hidden === 1 ? 'notice' : 'notices'}.
          </span>
          <button type="button" onClick={dismissAll} className="btn-ghost h-5 px-1 text-tiny">
            Dismiss all
          </button>
        </div>
      )}
      {shown.map((toast) => {
        const tone = toast.tone === 'info' ? null : TOAST_TONE[toast.tone]
        return (
          <div
            key={toast.id}
            className="floating pointer-events-auto flex animate-rise items-start gap-2 p-strip"
          >
            {tone && <span className={cn(tone.className, 'mt-px shrink-0')}>{tone.label}</span>}
            <p className="flex-1 text-body text-fg">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="shrink-0 text-muted transition-colors duration-hover hover:text-strong"
              title="Dismiss this notice."
              aria-label="Dismiss this notice."
            >
              <X size={16} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/* ── Status strip ────────────────────────────────────────────────────────── */

/**
 * The foot of the content column: when Plex was last read at the left, who is
 * reading it at the right, groups separated by " . " (section 6.1's status bar,
 * at the 26px it fixes).
 *
 * It reads the sync status the top bar already polls, so it costs no request of
 * its own, and it reports the *last finished* run where the top bar reports the
 * running one.
 */
function StatusStrip() {
  const { user } = useAuth()
  const { data: status, isError } = useQuery({
    queryKey: ['sync-status'],
    queryFn: api.sync.status,
  })

  const finished = status?.last_run?.finished_at

  /*
   * `isError` sits *before* the empty branch and after the two that have
   * something to report. A failed request is not "no sync has finished yet",
   * which is a claim about the instance and sends the reader off to run a sync
   * that has already run. A reading that did arrive and has since gone stale is
   * still the last thing known to be true, so it keeps being shown.
   */
  const left = status?.running ? (
    'Sync running.'
  ) : finished ? (
    <>
      Last sync{' '}
      {/* Relative under a day, with the exact time in the tooltip (section 12). */}
      <time dateTime={finished} title={new Date(finished).toLocaleString()}>
        {relativeTime(finished)}
      </time>
      .
    </>
  ) : isError ? (
    'Sync status unavailable.'
  ) : (
    'No sync has finished yet.'
  )

  const right = [
    user?.display_name || user?.username,
    user?.plex_username ? 'Plex' : 'Local account',
  ].filter(Boolean)

  return (
    <footer className="fixed inset-x-0 bottom-0 z-20 flex h-status items-center justify-between gap-strip border-t border-line bg-chrome px-strip text-tiny text-dim lg:left-sidebar">
      <span className="truncate">{left}</span>
      <span className="truncate">{right.join(' · ')}</span>
    </footer>
  )
}

/* ── Shell ───────────────────────────────────────────────────────────────── */

/** Everything inside the drawer that a Tab can land on. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
  ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const overlays = useRef(new Set<string>()).current
  const drawerRef = useRef<HTMLElement>(null)
  const drawerCloseRef = useRef<HTMLButtonElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  // Back and forward close it too. The rows close it themselves, because a row
  // for the page already open changes no path for this to notice.
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  /*
   * The drawer is modal, and modal is four things rather than one.
   *
   * It was none of them. Focus stayed on the menu button outside it; three
   * top-bar controls sat between the scrim and the drawer in the tab order, so
   * they were reached first; Tab ran off the end of the panel into the page
   * behind; and a wheel over the scrim scrolled that page nine hundred pixels.
   * So: the close button takes focus on open, Tab cycles inside the panel, the
   * body cannot scroll while it is up, and the menu button takes focus back
   * when it closes, which is where the user left off.
   */
  useEffect(() => {
    if (!drawerOpen) return
    const panel = drawerRef.current
    drawerCloseRef.current?.focus()

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerOpen(false)
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.getClientRects().length > 0,
      )
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement as HTMLElement | null
      const inside = active ? panel.contains(active) : false
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault()
          last.focus()
        }
      } else if (!inside || active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      menuButtonRef.current?.focus()
    }
  }, [drawerOpen])

  /*
   * "/" searches from anywhere, the way media apps behave.
   *
   * Off the search page it is a plain navigation and nothing more: the field
   * there takes the caret itself on mount, through `autoFocus` on the browse
   * toolbar's search control, so there is no hand-over for the shell to make.
   * On the search page the field does not remount, so it still has to be told.
   */
  const focusPageSearch = useCallback(() => {
    const field = document.querySelector<HTMLInputElement>('input[type="search"]')
    if (!field) return
    field.focus()
    field.select()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/') return
      const target = event.target as HTMLElement | null
      if (target && (['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable)) {
        return
      }
      // A menu, the sync popover or the drawer is a conversation in progress.
      // Navigating out from under one left it floating over the next page.
      if (drawerOpen || overlays.size > 0) return
      event.preventDefault()
      if (location.pathname === '/search') focusPageSearch()
      else navigate('/search')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [location.pathname, navigate, focusPageSearch, drawerOpen, overlays])

  return (
    <OverlayContext.Provider value={overlays}>
      <div className="min-h-screen bg-window">
        {/* Top bar: the menu bar. No page navigation lives here. */}
        <header className="fixed inset-x-0 top-0 z-30 flex h-menubar items-center gap-2 border-b border-line bg-chrome px-strip">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="btn-icon lg:hidden"
            title="Open navigation."
            aria-label="Open navigation."
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
          >
            <Menu size={16} />
          </button>
          <Link to="/" title="Go to the Tally home page." className="rounded-ctl">
            <Logo />
          </Link>
          <div className="flex-1" />
          <SyncControl />
          <UserMenu />
        </header>

        {/* Sidebar: the navigation column. */}
        <aside className="fixed bottom-0 left-0 top-menubar z-20 hidden w-sidebar flex-col border-r border-line bg-dock lg:flex">
          <div className="flex-1 overflow-y-auto p-1.5">
            <NavList />
          </div>
          <div className="p-1.5 pt-0">
            <NavRow item={SETTINGS_ITEM} />
          </div>
          <SidebarFooter />
        </aside>

        {/* Drawer: the sidebar below 1024px, with floating-panel styling. */}
        {drawerOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            {/* The scrim is a surface, not a control. The close button and
                Escape are the two ways out; a third tab stop reading "Close
                navigation" would only say one of them a second time, and it sat
                inside the panel's turn in the tab order without being in it. */}
            <div
              onClick={() => setDrawerOpen(false)}
              className="dialog-backdrop absolute inset-0"
              aria-hidden="true"
            />
            <aside
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className="floating absolute inset-y-2 left-2 flex w-sidebar animate-rise flex-col overflow-hidden"
            >
              <div className="flex h-menubar shrink-0 items-center justify-between gap-2 border-b border-line px-strip">
                <Logo />
                <button
                  ref={drawerCloseRef}
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="btn-icon"
                  title="Close navigation."
                  aria-label="Close navigation."
                >
                  <X size={16} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-1.5">
                <NavList onNavigate={() => setDrawerOpen(false)} />
              </div>
              <div className="p-1.5 pt-0">
                <NavRow item={SETTINGS_ITEM} onNavigate={() => setDrawerOpen(false)} />
              </div>
              <SidebarFooter />
            </aside>
          </div>
        )}

        {/* `pb-status` keeps the fixed status strip off the last row of the page. */}
        <div className="pb-status pt-menubar lg:pl-sidebar">
          {/* A size query container, so a page can measure the region the
              centred column sits in and break out of it - see `.full-bleed`,
              which the item hero uses to reach the sidebar and the window edge.
              Nothing else can supply that width: a percentage inside <main>
              only ever knows the column. */}
          <div className="[container-type:inline-size]">
            <main className="mx-auto max-w-[1200px] px-strip py-strip">
              <Outlet />
            </main>
          </div>
        </div>

        <StatusStrip />
        <Toasts />
      </div>
    </OverlayContext.Provider>
  )
}
