import { useEffect, useRef, useState } from 'react'
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth, useTheme, useToast } from '@/lib/app-context'
import type { SyncStatus } from '@/lib/types'
import { cn, initials } from '@/lib/utils'
import {
  BookmarkIcon,
  ChartIcon,
  ClockIcon,
  DockerIcon,
  FilmIcon,
  GitHubIcon,
  HomeIcon,
  LogOutIcon,
  MenuIcon,
  MoonIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  SparkIcon,
  SunIcon,
  TvIcon,
  XIcon,
} from './Icons'

const NAV = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/movies', label: 'Movies', icon: FilmIcon },
  { to: '/shows', label: 'Shows', icon: TvIcon },
  { to: '/anime', label: 'Anime', icon: SparkIcon },
  { to: '/watchlist', label: 'Watchlist', icon: BookmarkIcon },
  { to: '/history', label: 'History', icon: ClockIcon },
  { to: '/stats', label: 'Stats', icon: ChartIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

function Wordmark() {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-1">
      <span
        className="grid h-8 w-8 place-items-center rounded-xl bg-accent text-accent-ink
                   shadow-glow"
        aria-hidden="true"
      >
        {/* Tally marks — four strokes and a cross-stroke. */}
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <path d="M6 6v12M10 6v12M14 6v12M18 6v12M4.5 8l15 8" />
        </svg>
      </span>
      <span className="text-[17px] font-semibold tracking-tight text-ink">Tally</span>
    </Link>
  )
}

function SyncButton() {
  const queryClient = useQueryClient()
  const { notify } = useToast()

  const { data: status } = useQuery({
    queryKey: ['sync-status'],
    queryFn: api.sync.status,
    // Poll faster while a sync is running so the spinner reflects reality.
    refetchInterval: (query) => (query.state.data?.running ? 3000 : 30_000),
  })

  const mutation = useMutation({
    mutationFn: () => api.sync.trigger(false, true),
    onSuccess: () => {
      notify('Sync started — this can take a few minutes on a first run', 'info')
      queryClient.invalidateQueries({ queryKey: ['sync-status'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const cancel = useMutation({
    mutationFn: api.sync.cancel,
    onSuccess: () => {
      notify('Stopping after the current step', 'info')
      queryClient.invalidateQueries({ queryKey: ['sync-status'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const busy = mutation.isPending || status?.running
  const label = syncLabel(status, mutation.isPending)

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={busy}
        className="btn-ghost h-9 w-9 rounded-xl p-0"
        title={label}
        aria-label={label}
      >
        <RefreshIcon className={cn('text-lg', busy && 'animate-spin')} />
      </button>

      {busy && (
        // Shown from the click, not from the first poll that confirms it: the
        // request and its follow-up refetch are two round trips, and waiting
        // for them made the button look like it had done nothing.
        // Hover/focus only, and the same text is already on the button's title
        // and aria-label, so nothing here is the only way to reach it.
        <div
          role="status"
          className="pointer-events-none absolute right-0 top-full z-30 mt-2 hidden w-64 rounded-xl border border-line bg-surface p-3 shadow-lg group-hover:block group-focus-within:block"
        >
          <p className="text-xs font-medium text-ink">
            {status?.running ? (status.phase ?? 'Syncing') : 'Starting sync'}
          </p>
          <SyncProgress status={status?.running ? status : undefined} />
          <button
            type="button"
            onClick={() => cancel.mutate()}
            disabled={!status?.running || cancel.isPending || status.cancel_requested}
            className="btn-ghost pointer-events-auto mt-2 h-7 w-full px-2 text-xs"
          >
            {status?.cancel_requested ? 'Stopping…' : 'Cancel sync'}
          </button>
        </div>
      )}
    </div>
  )
}

/** One line describing the running sync, for tooltips and screen readers. */
export function syncLabel(status: SyncStatus | undefined, starting = false): string {
  if (starting) return 'Starting sync'
  if (!status?.running) return 'Sync with Plex now'
  if (status.cancel_requested) return 'Cancelling after the current step'
  if (!status.phase) return 'Sync in progress'
  return status.progress_total > 0
    ? `${status.phase} — ${status.progress_current} of ${status.progress_total}`
    : status.phase
}

/**
 * A bar when the phase knows how much work it has, a sliding indeterminate one
 * when it doesn't — a sync cannot know its total up front, and inventing a
 * percentage would be worse than admitting that.
 */
export function SyncProgress({ status }: { status?: SyncStatus }) {
  // Undefined means the click has been made but the first status has not come
  // back yet. That is a real state and it gets the indeterminate bar, so a
  // button press never looks like it did nothing.
  // A phase with no total reports 0, meaning "unknown" — never divide by it.
  const determinate = (status?.progress_total ?? 0) > 0
  const percent =
    determinate && status
      ? Math.min(100, Math.round((status.progress_current / status.progress_total) * 100))
      : null

  return (
    <div className="mt-2">
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-valuenow={percent ?? undefined}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
        aria-label={status?.phase ?? 'Sync progress'}
      >
        <div
          className={cn(
            'h-full rounded-full bg-accent',
            // Indeterminate: a third-width bar sliding the length of the track.
            // It must travel — a stationary partial bar is indistinguishable
            // from a real percentage, and the sync opens on exactly this state,
            // so every run used to start by claiming it was a third done.
            // Reduced motion cannot slide, so it fills the track dimmed instead;
            // still not a percentage.
            !determinate &&
              'w-1/3 animate-progress-slide motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40',
          )}
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
      {determinate && status && (
        <p className="mt-1 text-[11px] tabular-nums text-muted">
          {/* Separators, not compact notation: a counter ticking through
              "45.2K" for thousands of items looks stuck. */}
          {status.progress_current.toLocaleString()} of{' '}
          {status.progress_total.toLocaleString()}
        </p>
      )}
    </div>
  )
}

function ThemeToggle() {
  const { resolved, setTheme } = useTheme()
  return (
    <button
      type="button"
      onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
      className="btn-ghost h-9 w-9 rounded-xl p-0"
      title={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} mode`}
      aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} mode`}
    >
      {resolved === 'dark' ? <SunIcon className="text-lg" /> : <MoonIcon className="text-lg" />}
    </button>
  )
}

function SearchBox() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  // Reflect the term in the URL, so arriving at /search?q=dune from a link, a
  // reload or the back button shows results *and* the box that produced them.
  // Held purely in local state, the field sat empty next to a page full of
  // results, and refining the search meant retyping it.
  const urlTerm = params.get('q') ?? ''
  const [value, setValue] = useState(urlTerm)
  const [lastUrlTerm, setLastUrlTerm] = useState(urlTerm)
  if (lastUrlTerm !== urlTerm) {
    setLastUrlTerm(urlTerm)
    setValue(urlTerm)
  }
  const inputRef = useRef<HTMLInputElement>(null)

  // "/" focuses search from anywhere, the way media apps behave.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target && ['INPUT', 'TEXTAREA'].includes(target.tagName)
      if (event.key === '/' && !typing) {
        event.preventDefault()
        inputRef.current?.focus()
      }
      if (event.key === 'Escape') inputRef.current?.blur()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault()
        if (value.trim()) navigate(`/search?q=${encodeURIComponent(value.trim())}`)
      }}
      className="relative w-full max-w-md"
    >
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-muted" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search your library…"
        aria-label="Search your library"
        className="input pl-9 pr-10"
      />
      <kbd
        className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2
                   rounded border border-line px-1.5 py-0.5 text-[10px] text-muted sm:block"
      >
        /
      </kbd>
    </form>
  )
}

function UserMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (!user) return null
  const name = user.display_name || user.username

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full
                   border border-line bg-raised text-xs font-semibold text-subtle
                   transition-colors hover:border-accent/50"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${name}`}
      >
        {user.avatar_url ? (
          <img src={user.avatar_url} alt="" className="h-full w-full object-cover" />
        ) : (
          initials(name)
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-2 w-56 animate-fade-up rounded-xl border
                     border-line bg-surface p-1.5 shadow-lift"
        >
          <div className="border-b border-line px-3 py-2">
            <p className="truncate text-sm font-medium text-ink">{name}</p>
            <p className="truncate text-xs text-muted">
              {user.plex_username ? `Plex · ${user.plex_username}` : 'Local account'}
            </p>
          </div>
          <Link
            to="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-subtle
                       hover:bg-raised hover:text-ink"
          >
            <SettingsIcon /> Settings
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => void logout()}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm
                       text-subtle hover:bg-raised hover:text-ink"
          >
            <LogOutIcon /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}

function Toasts() {
  const { toasts, dismiss } = useToast()
  if (toasts.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))]
                 flex-col gap-2"
      role="region"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'pointer-events-auto flex animate-fade-up items-start gap-3 rounded-xl border',
            'bg-surface p-3 shadow-lift',
            toast.tone === 'error' && 'border-danger/40',
            toast.tone === 'success' && 'border-good/40',
            toast.tone === 'info' && 'border-line',
          )}
        >
          <span
            className={cn(
              'mt-1.5 h-2 w-2 shrink-0 rounded-full',
              toast.tone === 'error' && 'bg-danger',
              toast.tone === 'success' && 'bg-good',
              toast.tone === 'info' && 'bg-accent',
            )}
            aria-hidden="true"
          />
          <p className="flex-1 text-sm text-ink">{toast.message}</p>
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            className="text-muted hover:text-ink"
            aria-label="Dismiss"
          >
            <XIcon className="text-sm" />
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Version and where this build came from, at the foot of the sidebar.
 *
 * Cached indefinitely: the version cannot change without the page reloading,
 * because changing it means replacing the container.
 */
function VersionFooter() {
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
    <div className="flex items-center justify-between gap-2 px-3">
      <span className="text-[11px] tabular-nums text-muted">
        {data ? `v${data.version}` : 'Tally'}
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
              className="grid h-7 w-7 place-items-center rounded-lg text-muted
                         transition-colors hover:bg-raised hover:text-ink"
            >
              <Icon className="text-sm" />
            </a>
          ) : null,
        )}
      </span>
    </div>
  )
}

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium',
              'transition-all duration-200 ease-spring',
              isActive
                ? 'bg-accent-soft text-accent'
                : 'text-subtle hover:bg-raised hover:text-ink',
            )
          }
        >
          {({ isActive }) => (
            <>
              <Icon
                className={cn(
                  'text-lg transition-transform duration-200 ease-spring',
                  !isActive && 'group-hover:scale-110',
                )}
              />
              {label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )

  return (
    <div className="min-h-screen bg-canvas">
      {/* Sidebar — fixed on desktop, a drawer below lg. */}
      <aside
        className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line
                   bg-surface px-3 py-5 lg:flex"
      >
        <Wordmark />
        <div className="mt-7 flex-1">{nav}</div>
        <VersionFooter />
      </aside>

      {mobileOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          />
          <aside
            className="fixed inset-y-0 left-0 z-50 flex w-64 animate-fade-up flex-col border-r
                       border-line bg-surface px-3 py-5 lg:hidden"
          >
            <div className="flex items-center justify-between">
              <Wordmark />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="btn-ghost h-9 w-9 rounded-xl p-0"
                aria-label="Close navigation"
              >
                <XIcon className="text-lg" />
              </button>
            </div>
            <div className="mt-7 flex-1">{nav}</div>
            <VersionFooter />
          </aside>
        </>
      )}

      <div className="lg:pl-60">
        <header
          className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line
                     bg-canvas/85 px-4 backdrop-blur-xl sm:px-6"
        >
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="btn-ghost h-9 w-9 rounded-xl p-0 lg:hidden"
            aria-label="Open navigation"
          >
            <MenuIcon className="text-lg" />
          </button>
          <div className="flex-1">
            <SearchBox />
          </div>
          <SyncButton />
          <ThemeToggle />
          <UserMenu />
        </header>

        {/* A size query container, so a page can measure the region the
            centred column sits in and break out of it — see `.full-bleed`,
            which the item hero uses to reach the sidebar and the window edge.
            Nothing else can supply that width: a percentage inside <main>
            only ever knows the column. */}
        <div className="[container-type:inline-size]">
          <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8">
            <Outlet />
          </main>
        </div>
      </div>

      <Toasts />
    </div>
  )
}
