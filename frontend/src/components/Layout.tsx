/*
 * The hosted web shell: STYLE-GUIDE.md section 6.2, and nothing more.
 *
 *   Top bar   34px, `chrome`, hairline below. The mark and the app name at the
 *             left; the global status and the session control at the right.
 *             This bar is the menu bar. It holds no page navigation.
 *   Sidebar   240px, `dock`, hairline right. Section eyebrows, 30px nav rows,
 *             and a footer with the licence and where this build came from.
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
 * which used to focus the top-bar box, now goes to that destination and puts
 * the caret in the page's own search field.
 *
 * **Below 1024px the sidebar becomes a drawer, not bar navigation.** Bar
 * navigation is offered for five destinations or fewer (section 6.3) and Tally
 * has eight. Cutting three to fit would either hide real destinations behind a
 * "More" item or fold Movies, Shows and Anime into one, and neither is a
 * smaller loss than a menu button.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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

/* ── Navigation ──────────────────────────────────────────────────────────── */

function NavRow({ item }: { item: NavItem }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => cn('nav-row', isActive && 'nav-row-selected')}
    >
      {/* The icon takes the row's own colour, so it is `text-muted` at rest and
          `text-strong` when the row is selected without being told twice. */}
      <Icon size={16} aria-hidden="true" />
      {item.label}
    </NavLink>
  )
}

function NavList() {
  return (
    <nav className="flex flex-col gap-px" aria-label="Main">
      {NAV_GROUPS.map((group, index) => (
        <div key={group.eyebrow ?? 'home'} className={cn('flex flex-col gap-px', index > 0 && 'mt-3')}>
          {group.eyebrow && <p className="eyebrow px-strip pb-1">{group.eyebrow}</p>}
          {group.items.map((item) => (
            <NavRow key={item.to} item={item} />
          ))}
        </div>
      ))}
    </nav>
  )
}

/**
 * The licence and where this build came from, at the foot of the sidebar.
 *
 * The version itself is in the top bar, which is where section 6.2 puts the
 * global status. Printing the same number in both corners of one screen reads
 * as two facts rather than one, so the footer carries the rest of what section
 * 12 asks for: the licence, and the two places this image lives.
 */
function SidebarFooter() {
  const { data } = useQuery({
    queryKey: ['app-version'],
    queryFn: api.settings.version,
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const links = [
    { href: data?.github_url, label: 'Source on GitHub', icon: GitHubIcon },
    { href: data?.dockerhub_url, label: 'Image on Docker Hub', icon: DockerIcon },
  ]

  return (
    <div className="flex h-status shrink-0 items-center justify-between gap-2 border-t border-line px-strip">
      <span className="text-tiny text-dim">Apache-2.0</span>
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

/** One line describing the running sync, for tooltips and screen readers. */
export function syncLabel(status: SyncStatus | undefined, starting = false): string {
  if (starting) return 'Starting sync'
  if (!status?.running) return 'Sync with Plex now'
  if (status.cancel_requested) return 'Cancelling after the current step'
  if (!status.phase) return 'Sync in progress'
  return status.progress_total > 0
    ? `${status.phase} · ${status.progress_current} of ${status.progress_total}`
    : status.phase
}

/**
 * A 3px rail (section 7.18) with an accent fill when the phase knows how much
 * work it has, and the one permitted sliding bar when it does not.
 *
 * `undefined` means the click has been made but the first status has not come
 * back yet. That is a real state and it gets the sliding bar, so a button press
 * never looks like it did nothing. A phase with no total reports 0, meaning
 * "unknown", and a sync genuinely cannot know its total up front.
 */
export function SyncProgress({ status }: { status?: SyncStatus }) {
  const total = status?.progress_total ?? 0
  const determinate = total > 0

  return (
    <ProgressBar
      className="mt-2"
      fraction={determinate && status ? status.progress_current / total : null}
      sliding={!determinate}
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

/**
 * The sync control: an icon button in the top bar with a popover carrying the
 * phase, the progress rail and the cancel path.
 *
 * The popover opens on **click**, not on hover. Hover is not a gesture a touch
 * screen has, and the cancel button lives in there, so on a phone the old hover
 * card made stopping a sync unreachable. Clicking while a sync runs opens the
 * detail rather than starting a second one.
 */
function SyncControl() {
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const { data: status } = useQuery({
    queryKey: ['sync-status'],
    queryFn: api.sync.status,
    // Poll faster while a sync is running so the rail reflects reality.
    refetchInterval: (query) => (query.state.data?.running ? 3000 : 30_000),
  })

  const mutation = useMutation({
    mutationFn: () => api.sync.trigger(false, true),
    onSuccess: () => {
      notify('Sync started. A first run can take a few minutes.', 'info')
      queryClient.invalidateQueries({ queryKey: ['sync-status'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const cancel = useMutation({
    mutationFn: api.sync.cancel,
    onSuccess: () => {
      notify('Stopping after the current step.', 'info')
      queryClient.invalidateQueries({ queryKey: ['sync-status'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  // True from the click, not from the first poll that confirms it: the request
  // and its follow-up refetch are two round trips, and waiting for them made
  // the button look like it had done nothing.
  const busy = mutation.isPending || Boolean(status?.running)
  const label = syncLabel(status, mutation.isPending)

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
          {mutation.isPending && !status?.running
            ? 'Starting sync'
            : (status?.phase ?? 'Sync in progress')}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          if (busy) setOpen((value) => !value)
          else {
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
        <div role="status" className="menu absolute right-0 top-full z-40 mt-1 w-64 animate-rise">
          <p className="px-1 pt-1 text-control text-strong">
            {status?.running ? (status.phase ?? 'Syncing') : 'Starting sync'}
          </p>
          <div className="px-1">
            <SyncProgress status={status?.running ? status : undefined} />
          </div>
          <button
            type="button"
            onClick={() => cancel.mutate()}
            disabled={!status?.running || cancel.isPending || status.cancel_requested}
            title={status?.running ? 'Stop after the current step.' : 'No sync is running.'}
            className="btn-outline mt-2 w-full"
          >
            {status?.cancel_requested ? 'Stopping…' : 'Cancel sync'}
          </button>
        </div>
      )}
    </div>
  )
}

/** The version, at 10.5px `text-dim`, as section 6.2's global status. */
function VersionReadout() {
  const { data } = useQuery({
    queryKey: ['app-version'],
    queryFn: api.settings.version,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  if (!data) return null
  return <span className="figure hidden text-tiny text-dim sm:inline">v{data.version}</span>
}

/* ── Session ─────────────────────────────────────────────────────────────── */

function UserMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

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
        title={name}
        aria-label={`Account menu for ${name}`}
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
          <Link to="/settings" role="menuitem" onClick={() => setOpen(false)} className="menu-item">
            <Settings size={16} aria-hidden="true" /> Settings
          </Link>
          <button type="button" role="menuitem" onClick={() => void logout()} className="menu-item">
            <LogOut size={16} aria-hidden="true" /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}

/* ── Toasts ──────────────────────────────────────────────────────────────── */

/**
 * Bottom right, floating-panel styling, one sentence and at most one action
 * (section 7.17). Never more than three at once; the rest collapse into a
 * count, because a fourth panel covers the page it is reporting on.
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
      {shown.map((toast) => (
        <div
          key={toast.id}
          className="floating pointer-events-auto flex animate-rise items-start gap-2 p-strip"
        >
          {toast.tone !== 'info' && (
            <span
              className={cn(
                'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                toast.tone === 'error' ? 'bg-critical' : 'bg-good',
              )}
              aria-hidden="true"
            />
          )}
          <p className="flex-1 text-body text-fg">{toast.message}</p>
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            className="shrink-0 text-muted transition-colors duration-hover hover:text-strong"
            title="Dismiss"
            aria-label="Dismiss"
          >
            <X size={16} />
          </button>
        </div>
      ))}
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
  const { data: status } = useQuery({ queryKey: ['sync-status'], queryFn: api.sync.status })

  const finished = status?.last_run?.finished_at
  const left = status?.running
    ? 'Sync running.'
    : finished
      ? `Last sync ${relativeTime(finished)}.`
      : 'No sync has finished yet.'

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

export function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const wantsSearchFocus = useRef(false)

  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  /*
   * "/" searches from anywhere, the way media apps behave. The field it lands
   * in is the browse toolbar's, so the shortcut navigates and then hands the
   * caret over.
   *
   * The hand-over is a short poll for the field rather than a prop, because the
   * toolbar is rendered by the route, which does not exist yet at the moment
   * the key is pressed. A few frames is the whole budget: if the field has not
   * mounted by then the user is on the search page with the box in front of
   * them, which is the same place, one click further away. An `autoFocus` on
   * BrowseFilters' search control would replace this outright.
   */
  const focusPageSearch = useCallback(() => {
    let frames = 20
    const attempt = () => {
      const field = document.querySelector<HTMLInputElement>('input[type="search"]')
      if (field) {
        field.focus()
        field.select()
        return
      }
      if (frames-- > 0) requestAnimationFrame(attempt)
    }
    attempt()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/') return
      const target = event.target as HTMLElement | null
      if (target && (['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable)) {
        return
      }
      event.preventDefault()
      if (location.pathname === '/search') focusPageSearch()
      else {
        wantsSearchFocus.current = true
        navigate('/search')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [location.pathname, navigate, focusPageSearch])

  useEffect(() => {
    if (!wantsSearchFocus.current) return
    wantsSearchFocus.current = false
    if (location.pathname === '/search') focusPageSearch()
  }, [location.pathname, focusPageSearch])

  return (
    <div className="min-h-screen bg-window">
      {/* Top bar: the menu bar. No page navigation lives here. */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-menubar items-center gap-2 border-b border-line bg-chrome px-strip">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="btn-icon lg:hidden"
          title="Open navigation"
          aria-label="Open navigation"
        >
          <Menu size={16} />
        </button>
        <Link to="/" title="Tally home" className="rounded-ctl">
          <Logo />
        </Link>
        <div className="flex-1" />
        <SyncControl />
        <VersionReadout />
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
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-backdrop opacity-60"
            aria-label="Close navigation"
          />
          <aside className="floating absolute inset-y-2 left-2 flex w-sidebar animate-rise flex-col overflow-hidden">
            <div className="flex h-menubar shrink-0 items-center justify-between gap-2 border-b border-line px-strip">
              <Logo />
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="btn-icon"
                title="Close navigation"
                aria-label="Close navigation"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5">
              <NavList />
            </div>
            <div className="p-1.5 pt-0">
              <NavRow item={SETTINGS_ITEM} />
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
  )
}
