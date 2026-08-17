import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Copy,
  ExternalLink,
  Info,
  KeyRound,
  Library as LibraryIcon,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  ScanSearch,
  Server as ServerIcon,
  Sparkles,
  Sun,
  type LucideIcon,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth, useTheme, useToast, type Theme } from '@/lib/app-context'
import type { ApiKeyCreated, ApiKeyScope, Library, Server } from '@/lib/types'
import { cn, copyText, formatDateTime, relativeTime } from '@/lib/utils'
import { Select } from '@/components/Dropdown'
import {
  EmptyState,
  ErrorState,
  Notice,
  Panel,
  Segmented,
  Skeleton,
  Spinner,
  Toggle,
} from '@/components/ui'
import { SyncProgress, syncLabel } from '@/components/Layout'

/*
 * Settings, in the shape STYLE-GUIDE §9 fixes.
 *
 * Two columns at 1024px and up: a 240px column holding the title, the sidebar
 * tabs (§7.4) and the version line, and a pane with its own header, one body
 * and a footer. Below 1024px the tab column stacks into a segmented control at
 * the top. There is no Save button anywhere: every control writes as it is
 * touched, which is what the footer says.
 *
 * A row is a label, an optional second line, and its control hard against the
 * right edge. Rows group under an eyebrow with a `line-soft` hairline between
 * groups. A setting Tally cannot change from here says so in the row rather
 * than being drawn disabled with no explanation.
 */

/* ── The tabs ────────────────────────────────────────────────────────────── */

type TabId = 'plex' | 'syncing' | 'library' | 'appearance' | 'metadata' | 'keys' | 'about'

interface Tab {
  id: TabId
  label: string
  icon: LucideIcon
  /** One line of `text-muted` under the pane's name. */
  description: string
}

const TABS: Tab[] = [
  {
    id: 'plex',
    label: 'Plex servers',
    icon: ServerIcon,
    description:
      'Tally reads your libraries, history and ratings from here, and writes your changes back.',
  },
  {
    id: 'syncing',
    label: 'Syncing',
    icon: RefreshCw,
    description: 'What Tally reads from Plex, what it writes back, and how often.',
  },
  {
    id: 'library',
    label: 'Library',
    icon: LibraryIcon,
    description: 'How your titles are grouped, and how long a half-finished one keeps its place.',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Sun,
    description: 'The interface should disappear behind your work. Pick a theme.',
  },
  {
    id: 'metadata',
    label: 'Metadata',
    icon: ScanSearch,
    description: 'Where posters, descriptions and anime data come from.',
  },
  {
    id: 'keys',
    label: 'API keys',
    icon: KeyRound,
    description: 'A key lets a script or another app act as this account. Treat one like a password.',
  },
  {
    id: 'about',
    label: 'About',
    icon: Info,
    description: 'Which version is running, and which account you are signed in as.',
  },
]

/** The tab a bare `/settings` opens on, and the one value never written to the URL. */
const DEFAULT_TAB: TabId = 'plex'

/* ── Rows and groups ─────────────────────────────────────────────────────── */

/**
 * A run of settings under an eyebrow: 16px above the group, 4px between rows,
 * a `line-soft` hairline between one group and the next.
 */
function Group({
  title,
  action,
  children,
}: {
  title: string
  /** One control on the eyebrow's line, right-aligned. */
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mt-4 border-t border-line-soft pt-4 first:mt-0 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <h3 className="eyebrow">{title}</h3>
        {action}
      </div>
      <div className="mt-2 space-y-1">{children}</div>
    </section>
  )
}

/** Label at the left, an optional second line under it, the control at the right edge. */
function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  /** Set when the control is a real form field, so the label points at it. */
  htmlFor?: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1.5">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-control text-fg">
            {label}
          </label>
        ) : (
          <span className="block text-control text-fg">{label}</span>
        )}
        {hint && <span className="mt-0.5 block max-w-[65ch] text-small text-dim">{hint}</span>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

/** A row whose control is wide enough to want the whole width under its label. */
function StackedRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="py-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="block text-control text-fg">
          {label}
        </label>
      ) : (
        <span className="block text-control text-fg">{label}</span>
      )}
      {hint && <p className="mt-0.5 max-w-[65ch] text-small text-dim">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  )
}

/** A value the pane reports rather than offers: read as a fact, not a control. */
function Fact({ children, figure }: { children: ReactNode; figure?: boolean }) {
  return (
    <span className={cn('text-control text-strong', figure && 'figure text-tiny')}>{children}</span>
  )
}

/* ── The page ────────────────────────────────────────────────────────────── */

export function Settings() {
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab')
  // A URL is untrusted input: an unknown tab falls back to the default rather
  // than rendering an empty pane.
  const active = TABS.find((tab) => tab.id === requested)?.id ?? DEFAULT_TAB
  const current = TABS.find((tab) => tab.id === active) as Tab

  const version = useQuery({
    queryKey: ['app-version'],
    queryFn: api.settings.version,
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const setTab = (next: TabId) => {
    const params2 = new URLSearchParams(params)
    // A default never survives into the URL.
    if (next === DEFAULT_TAB) params2.delete('tab')
    else params2.set('tab', next)
    setParams(params2)
  }

  return (
    // No `overflow-hidden` on the shell: it would make the sticky tab column
    // stop following the page.
    <div className="card flex flex-col lg:min-h-[560px] lg:flex-row">
      {/* The tab column, 1024px and up. */}
      <div className="hidden shrink-0 border-r border-line lg:block lg:w-sidebar">
        <div className="sticky top-menubar flex flex-col p-1.5">
          <h1 className="px-2.5 pb-2 pt-1.5 text-page font-semibold text-strong">Settings</h1>
          <nav className="flex flex-col gap-0.5" aria-label="Settings sections">
            {TABS.map((tab) => {
              const Icon = tab.icon
              const selected = tab.id === active
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setTab(tab.id)}
                  aria-current={selected ? 'page' : undefined}
                  className={cn('nav-row w-full', selected && 'nav-row-selected')}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span className="truncate">{tab.label}</span>
                </button>
              )
            })}
          </nav>
          <p className="px-2.5 pb-1 pt-3 text-tiny text-dim">
            {version.data ? <span className="figure">v{version.data.version}</span> : null}
            {version.data ? ' · ' : null}
            Apache-2.0
          </p>
        </div>
      </div>

      {/* Below 1024px the same tabs are a segmented control at the top. */}
      <div className="border-b border-line p-strip lg:hidden">
        <h1 className="text-page font-semibold text-strong">Settings</h1>
        <div className="mt-2">
          <Segmented
            label="Settings sections"
            value={active}
            onChange={setTab}
            options={TABS.map((tab) => ({ value: tab.id, label: tab.label }))}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-line p-strip">
          <h2 className="text-page font-semibold text-strong">{current.label}</h2>
          <p className="mt-0.5 text-body text-muted">{current.description}</p>
        </header>

        <div className="min-w-0 flex-1 p-strip">
          {active === 'plex' && <PlexPane />}
          {active === 'syncing' && <SyncingPane />}
          {active === 'library' && <LibraryPane />}
          {active === 'appearance' && <AppearancePane />}
          {active === 'metadata' && <MetadataPane />}
          {active === 'keys' && <ApiKeysPane />}
          {active === 'about' && <AboutPane />}
        </div>

        <footer className="border-t border-line p-strip text-tiny text-dim">
          Changes apply as you make them. There is no save button.
        </footer>
      </div>
    </div>
  )
}

/* ── Preferences ─────────────────────────────────────────────────────────── */

/**
 * The one writer for `/api/users/me/preferences`.
 *
 * Moves the switch on click, not two round trips later. `checked` is read
 * straight from the query cache, so without the optimistic write the knob
 * stayed put until a PUT *and* a follow-up GET had both returned, long enough
 * that people click again and send a second, conflicting write.
 */
function usePreferences() {
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const { refresh } = useAuth()

  const query = useQuery({ queryKey: ['preferences'], queryFn: api.settings.preferences })

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.settings.updatePreferences(body),
    onMutate: async (body: Record<string, unknown>) => {
      await queryClient.cancelQueries({ queryKey: ['preferences'] })
      const previous = queryClient.getQueryData<Record<string, unknown>>(['preferences'])
      queryClient.setQueryData<Record<string, unknown>>(['preferences'], (old) => ({
        ...(old ?? {}),
        ...body,
      }))
      return { previous }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preferences'] })
      // The Continue Watching window is a preference, so both the settings
      // payload that reports it and the shelf itself are now stale.
      queryClient.invalidateQueries({ queryKey: ['app-settings'] })
      queryClient.invalidateQueries({ queryKey: ['continue-watching'] })
      void refresh()
    },
    onError: (error: Error, _body, context) => {
      // Put the real value back; the optimistic one was a guess that lost.
      const previous = (context as { previous?: Record<string, unknown> } | undefined)?.previous
      if (previous) queryClient.setQueryData(['preferences'], previous)
      notify(error.message, 'error')
    },
  })

  return { prefs: query.data ?? {}, query, update }
}

/* ── Plex ────────────────────────────────────────────────────────────────── */

function PlexPane() {
  const { user } = useAuth()
  const { notify } = useToast()
  const queryClient = useQueryClient()

  const servers = useQuery({ queryKey: ['servers'], queryFn: api.servers.list })
  const settings = useQuery({ queryKey: ['app-settings'], queryFn: api.settings.get })

  const discover = useMutation({
    mutationFn: api.servers.discover,
    onSuccess: () => {
      notify('Plex servers refreshed.', 'success')
      queryClient.invalidateQueries({ queryKey: ['servers'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const webhookUrl = settings.data?.webhook_url ?? ''

  return (
    <>
      <Group
        title="Servers"
        action={
          <button
            type="button"
            onClick={() => discover.mutate()}
            disabled={discover.isPending || !user?.has_plex_link}
            title={
              user?.has_plex_link
                ? 'Ask plex.tv which servers this account can reach.'
                : 'Link a Plex account first.'
            }
            className="btn-outline"
          >
            {discover.isPending ? <Spinner /> : <RefreshCw size={16} aria-hidden="true" />}
            Refresh
          </button>
        }
      >
        {!user?.has_plex_link ? (
          <div className="well">
            <EmptyState
              icon={<ServerIcon size={24} />}
              title="No Plex account linked"
              description="Sign out and sign back in with Plex to connect your server."
            />
          </div>
        ) : servers.isError ? (
          <div className="well">
            <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
          </div>
        ) : servers.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (servers.data?.length ?? 0) === 0 ? (
          <div className="well">
            <EmptyState
              icon={<ServerIcon size={24} />}
              title="No servers found"
              description="Press Refresh to ask plex.tv which servers your account can reach."
            />
          </div>
        ) : (
          <div className="space-y-2">
            {servers.data?.map((server) => (
              <ServerPanel key={server.id} server={server} />
            ))}
          </div>
        )}
      </Group>

      <Group title="Live updates">
        <StackedRow
          label="Webhook address"
          htmlFor="webhook"
          hint="With a Plex Pass, point a Plex webhook here and a play registers the moment it happens instead of at the next sync. Tally works without one."
        >
          <div className="flex gap-2">
            <input
              id="webhook"
              readOnly
              value={webhookUrl}
              className="field figure text-tiny"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              disabled={!webhookUrl}
              title={
                webhookUrl ? 'Copy the address.' : 'The address is still loading.'
              }
              onClick={async () => {
                const copied = await copyText(webhookUrl)
                notify(
                  copied
                    ? 'Webhook address copied.'
                    : 'Could not copy. Select the address and press Ctrl+C.',
                  copied ? 'success' : 'error',
                )
              }}
              className="btn-outline shrink-0"
            >
              <Copy size={16} aria-hidden="true" />
              Copy
            </button>
          </div>
          <p className="mt-2 text-small text-dim">
            Add it in Plex under Settings, then Webhooks.
          </p>
        </StackedRow>
      </Group>
    </>
  )
}

type LibraryPatch = { enabled?: boolean; anime_override?: boolean | null }

/** One Plex server as a region of the page: the §7.5 header, then its settings. */
function ServerPanel({ server }: { server: Server }) {
  const queryClient = useQueryClient()
  const { notify } = useToast()

  const [urlDraft, setUrlDraft] = useState(server.manual_url ?? '')
  // `useState` seeds once, so a refetch that brings a new address left the
  // field showing the old one. Re-seed when the server's own value changes,
  // but not while the user is mid-edit.
  const [seededFrom, setSeededFrom] = useState(server.manual_url ?? '')
  if (seededFrom !== (server.manual_url ?? '')) {
    setSeededFrom(server.manual_url ?? '')
    setUrlDraft(server.manual_url ?? '')
  }

  const test = useMutation({
    mutationFn: () => api.servers.test(server.id),
    onSuccess: (result) =>
      notify(
        result.reachable ? `${server.name} is reachable.` : `${server.name} is not responding.`,
        result.reachable ? 'success' : 'error',
      ),
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const saveUrl = useMutation({
    mutationFn: (manual_url: string | null) => api.servers.update(server.id, { manual_url }),
    onSuccess: (updated) => {
      notify(
        updated.manual_url
          ? `Using ${updated.manual_url}.`
          : 'Back to auto-detecting the address.',
        'success',
      )
      // The previous result describes the old address, so drop it rather than
      // leaving a stale reachable or unreachable answer next to a URL that
      // just changed.
      test.reset()
      queryClient.invalidateQueries({ queryKey: ['servers'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  // null until tested, then the outcome of the most recent test.
  const reachable = test.data?.reachable ?? null

  const updateLibrary = useMutation({
    mutationFn: ({ id, body }: { id: number; body: LibraryPatch }) =>
      api.servers.updateLibrary(id, body),
    // Apply the change to the cache before the request goes out. Toggling an
    // override kicks off a reclassification of the whole library, and waiting
    // for the round trip left the control showing its old value with no
    // feedback, so it read as an unresponsive button.
    onMutate: async ({ id, body }: { id: number; body: LibraryPatch }) => {
      await queryClient.cancelQueries({ queryKey: ['servers'] })
      const previous = queryClient.getQueryData<Server[]>(['servers'])
      queryClient.setQueryData<Server[]>(['servers'], (old) =>
        old?.map((entry) => ({
          ...entry,
          libraries: entry.libraries.map((library) =>
            library.id === id ? { ...library, ...body } : library,
          ),
        })),
      )
      return { previous }
    },
    // Write the server's own answer into the cache. Invalidating instead would
    // fire a refetch that can land while a sync is mid-write, and any stale
    // read then looks like the click was undone.
    onSuccess: (updated) => {
      queryClient.setQueryData<Server[]>(['servers'], (old) =>
        old?.map((entry) => ({
          ...entry,
          libraries: entry.libraries.map((library) =>
            library.id === updated.id ? updated : library,
          ),
        })),
      )
    },
    onError: (error: Error, _variables, context) => {
      // Put the real value back; the optimistic one was a guess that lost.
      if (context?.previous) queryClient.setQueryData(['servers'], context.previous)
      notify(error.message, 'error')
    },
  })

  const scan = useMutation({
    mutationFn: (id: number) => api.servers.scanLibrary(id),
    onSuccess: () => notify('Library scan started.', 'info'),
    onError: (error: Error) => notify(error.message, 'error'),
  })

  return (
    <Panel
      title={server.name}
      commands={
        <>
          {server.owned && <span className="badge">Owner</span>}
          <button
            type="button"
            onClick={() => test.mutate()}
            disabled={test.isPending}
            title={`Ask ${server.name} whether it answers on this address.`}
            className={cn(
              'btn-outline',
              // Never colour alone: the label carries the result too, so it
              // still reads for anyone who cannot separate the two hues.
              reachable === true && 'text-good',
              reachable === false && 'text-critical',
            )}
          >
            {test.isPending ? (
              <Spinner />
            ) : reachable === null ? null : (
              <span
                aria-hidden="true"
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  reachable ? 'bg-good' : 'bg-critical',
                )}
              />
            )}
            {test.isPending
              ? 'Testing'
              : reachable === null
                ? 'Test connection'
                : reachable
                  ? 'Reachable'
                  : 'Not responding'}
          </button>
        </>
      }
    >
      <p className="truncate text-small text-dim">
        {server.platform ?? 'Plex Media Server'}
        {server.version ? ` · ${server.version}` : ''} · {server.base_url}
        {server.manual_url ? ' · set by hand' : ''}
      </p>

      <StackedRow
        label="Server address"
        htmlFor={`server-url-${server.id}`}
        hint="Leave it empty to let Plex advertise its own addresses. Set it when auto-detection picks a route that cannot be reached. A Plex server in Docker advertises its host's internal addresses too."
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            id={`server-url-${server.id}`}
            type="url"
            inputMode="url"
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder={server.base_url}
            className="field min-w-0 flex-1"
          />
          <button
            type="button"
            onClick={() => saveUrl.mutate(urlDraft.trim() || null)}
            disabled={saveUrl.isPending || urlDraft.trim() === (server.manual_url ?? '')}
            title={
              urlDraft.trim() === (server.manual_url ?? '')
                ? 'The address has not been changed.'
                : 'Use this address for every request to this server.'
            }
            className="btn-secondary shrink-0"
          >
            {saveUrl.isPending ? <Spinner /> : null}
            Save
          </button>
          {server.manual_url && (
            <button
              type="button"
              onClick={() => {
                setUrlDraft('')
                saveUrl.mutate(null)
              }}
              disabled={saveUrl.isPending}
              title="Go back to the addresses Plex advertises."
              className="btn-ghost shrink-0"
            >
              Auto-detect
            </button>
          )}
        </div>
      </StackedRow>

      {server.libraries.length > 0 && (
        <div className="mt-2 border-t border-line-soft pt-2">
          <h4 className="eyebrow">Libraries</h4>
          <ul className="mt-1 divide-y divide-line-soft">
            {server.libraries.map((library) => (
              <LibraryRow
                key={library.id}
                library={library}
                onToggleEnabled={(enabled) =>
                  updateLibrary.mutate({ id: library.id, body: { enabled } })
                }
                onSetAnime={(anime_override) =>
                  updateLibrary.mutate({ id: library.id, body: { anime_override } })
                }
                onScan={() => scan.mutate(library.id)}
                scanning={scan.isPending && scan.variables === library.id}
              />
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}

/** The three states of `anime_override`, as the values the dropdown round-trips. */
const ANIME_OPTIONS = [
  { value: 'auto', label: 'Detect' },
  { value: 'yes', label: 'Always anime' },
  { value: 'no', label: 'Never anime' },
]

function LibraryRow({
  library,
  onToggleEnabled,
  onSetAnime,
  onScan,
  scanning,
}: {
  library: Library
  onToggleEnabled: (enabled: boolean) => void
  onSetAnime: (override: boolean | null) => void
  onScan: () => void
  /** True while *this* row's scan request is in flight. */
  scanning: boolean
}) {
  const anime =
    library.anime_override === null ? 'auto' : library.anime_override ? 'yes' : 'no'

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2">
      {/* A floor under the name, or a wide control column crushes it to one
          letter and stacks its second line a word at a time. */}
      <span className="min-w-[10rem] flex-1">
        <span className="block truncate text-control text-fg">{library.title}</span>
        <span className="text-small text-dim">
          {library.section_type === 'movie' ? 'Films' : 'Television'} ·{' '}
          <span className="figure">{library.item_count.toLocaleString()}</span> items
          {library.last_synced_at ? ` · scanned ${relativeTime(library.last_synced_at)}` : ''}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-2">
        <Select
          label={`Anime in ${library.title}`}
          value={anime}
          onChange={(next) => onSetAnime(next === 'auto' ? null : next === 'yes')}
          options={ANIME_OPTIONS}
          // One width for every row, so the column of controls lines up
          // whatever each library answers.
          className="w-[8.5rem]"
        />

        <button
          type="button"
          // Busy state comes from the request, not from a timer unrelated to
          // it, which also leaked because nothing cleared it on unmount.
          onClick={onScan}
          disabled={scanning}
          title={scanning ? 'A scan of this library is already running.' : 'Read this library again.'}
          className="btn-outline"
        >
          {scanning ? <Spinner /> : <RefreshCw size={16} aria-hidden="true" />}
          Scan
        </button>

        {/* The switch's label is short because the row already names the
            library immediately to its left. */}
        <Toggle label="Include" checked={library.enabled} onChange={onToggleEnabled} />
      </span>
    </li>
  )
}

/* ── Syncing ─────────────────────────────────────────────────────────────── */

const RUN_BADGE: Record<string, string> = {
  success: 'badge-good',
  partial: 'badge-caution',
  failed: 'badge-critical',
}

/** The API's own words, in sentence case. An unknown state is printed as it came. */
const RUN_LABEL: Record<string, string> = {
  success: 'Success',
  partial: 'Partly done',
  failed: 'Failed',
  running: 'Running',
  cancelled: 'Cancelled',
}

function RunStatus({ status }: { status: string }) {
  return <span className={RUN_BADGE[status] ?? 'badge'}>{RUN_LABEL[status] ?? status}</span>
}

function SyncingPane() {
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const { prefs, update } = usePreferences()

  const settings = useQuery({ queryKey: ['app-settings'], queryFn: api.settings.get })
  const syncStatus = useQuery({
    queryKey: ['sync-status'],
    queryFn: api.sync.status,
    refetchInterval: (query) => (query.state.data?.running ? 3000 : 30_000),
  })
  const runs = useQuery({ queryKey: ['sync-runs'], queryFn: api.sync.runs })

  const cancelSync = useMutation({
    mutationFn: api.sync.cancel,
    onSuccess: () => {
      notify('Stopping after the current step.', 'info')
      queryClient.invalidateQueries({ queryKey: ['sync-status'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const fullSync = useMutation({
    mutationFn: () => api.sync.trigger(true, true),
    onSuccess: () => {
      notify('Full re-import started. This can take a while on large libraries.', 'info')
      queryClient.invalidateQueries({ queryKey: ['sync-status'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const running = syncStatus.data?.running
  const lastRun = syncStatus.data?.last_run

  return (
    <>
      {/* From the click, not from the poll that confirms it. See SyncProgress. */}
      {(running || fullSync.isPending) && (
        <div className="mb-4 rounded-tool border border-line bg-window p-strip">
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-control text-strong">
              {running ? (syncStatus.data?.phase ?? 'Syncing') : 'Starting sync'}
            </p>
            <button
              type="button"
              onClick={() => cancelSync.mutate()}
              disabled={!running || cancelSync.isPending || syncStatus.data?.cancel_requested}
              title={
                running ? 'Stop after the current step.' : 'The sync has not started yet.'
              }
              className="btn-ghost shrink-0"
            >
              {syncStatus.data?.cancel_requested ? 'Stopping' : 'Cancel'}
            </button>
          </div>
          <SyncProgress status={running ? syncStatus.data : undefined} />
        </div>
      )}

      <Group title="Schedule">
        <Row
          label="Automatic sync"
          hint="Set with the SYNC_INTERVAL_MINUTES environment variable, so it cannot be changed here."
        >
          <Fact figure>
            {settings.data ? `Every ${settings.data.sync_interval_minutes} minutes` : '–'}
          </Fact>
        </Row>
        <Row label="Last sync" hint={lastRun ? formatDateTime(lastRun.started_at) : undefined}>
          {lastRun ? (
            <>
              <Fact figure>{relativeTime(lastRun.started_at)}</Fact>
              <RunStatus status={lastRun.status} />
            </>
          ) : (
            <Fact>Never</Fact>
          )}
        </Row>
      </Group>

      <Group title="What syncs">
        <Toggle
          label="Sync ratings with Plex"
          description="Star ratings flow both ways. The most recent change wins."
          checked={Boolean(prefs.sync_ratings ?? true)}
          onChange={(value) => update.mutate({ sync_ratings: value })}
        />
        <Toggle
          label="Sync watchlist with Plex"
          description="Adding or removing a title here mirrors to your Plex watchlist, and the other way round."
          checked={Boolean(prefs.sync_watchlist ?? true)}
          onChange={(value) => update.mutate({ sync_watchlist: value })}
        />
        <Toggle
          label="Write watch state back to Plex"
          description="Marking something watched in Tally also marks it watched on your server."
          checked={Boolean(prefs.sync_history ?? true)}
          onChange={(value) => update.mutate({ sync_history: value })}
        />
      </Group>

      <Group title="Recent runs">
        {runs.isError ? (
          <ErrorState
            error={runs.error}
            title="Could not load the recent runs"
            onRetry={() => void runs.refetch()}
          />
        ) : runs.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (runs.data?.length ?? 0) === 0 ? (
          <p className="py-1.5 text-small text-dim">No sync has run yet.</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {runs.data?.slice(0, 8).map((run) => (
              <li key={run.id} className="flex h-row-plain items-center justify-between gap-3">
                <span className="figure truncate text-tiny text-dim">
                  {formatDateTime(run.started_at)}
                </span>
                <RunStatus status={run.status} />
              </li>
            ))}
          </ul>
        )}
      </Group>

      <Group title="Danger">
        <Row
          label="Full re-import"
          hint="Reads your whole Plex history again and rescans every library. Nothing you have logged in Tally is deleted, but the run can take hours on a large library and your Plex server is under load throughout."
        >
          <button
            type="button"
            onClick={() => fullSync.mutate()}
            disabled={fullSync.isPending || running}
            title={syncLabel(syncStatus.data, fullSync.isPending)}
            className="btn-danger"
          >
            {fullSync.isPending || running ? <Spinner /> : null}
            Re-import everything
          </button>
        </Row>
      </Group>
    </>
  )
}

/* ── Library ─────────────────────────────────────────────────────────────── */

/** Weeks offered as an explicit override, alongside "follow Plex" and "never". */
const WINDOW_CHOICES = [2, 4, 8, 16, 26, 52]

const weekLabel = (weeks: number) => `${weeks} ${weeks === 1 ? 'week' : 'weeks'}`

/**
 * What Plex says about its own On Deck window.
 *
 * An empty answer means "not allowed to ask" as much as "nothing set": only
 * the server owner's token may read `/:/prefs`. So a missing value is unknown
 * and never zero, and Plex reads 0 as "On Deck off" while Tally reads it as
 * "no cut-off", because an empty shelf reads as a broken page.
 */
function plexSummary(plexWeeks: number | null) {
  if (plexWeeks === null) {
    return 'Plex has not told Tally its own setting yet. Only the server owner can read it, and it arrives with the next sync. Until then Tally uses the Plex default of 16 weeks.'
  }
  if (plexWeeks === 0) {
    return 'Plex has On Deck switched off entirely (0 weeks). Tally reads that as no cut-off rather than an empty shelf.'
  }
  return `The Plex setting "Weeks to consider for On Deck and Continue Watching" is ${weekLabel(plexWeeks)}.`
}

function inForceSummary(effectiveWeeks: number | null) {
  if (effectiveWeeks === null) return ''
  if (effectiveWeeks === 0) return 'Nothing is being hidden.'
  return `Anything you have not touched in ${weekLabel(effectiveWeeks)} drops off the shelf. It stays in your library and in your history.`
}

function LibraryPane() {
  const { notify } = useToast()
  const { prefs, update } = usePreferences()
  const settings = useQuery({ queryKey: ['app-settings'], queryFn: api.settings.get })

  const reclassify = useMutation({
    mutationFn: api.settings.reclassifyAnime,
    onSuccess: () => notify('Re-running anime detection across your library.', 'info'),
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const stored =
    typeof prefs.continue_watching_weeks === 'number' ? prefs.continue_watching_weeks : null
  const plexWeeks = settings.data?.plex_on_deck_weeks ?? null
  const effectiveWeeks = settings.data?.continue_watching_weeks ?? null

  return (
    <>
      <Group title="Anime">
        <Toggle
          label="Keep anime in its own section"
          description="When this is on, anime is filtered out of Films and Shows and lives under Anime."
          checked={Boolean(prefs.separate_anime ?? true)}
          onChange={(value) => update.mutate({ separate_anime: value })}
        />
        <Row
          label="How a title is judged"
          hint="Tally reads your library names, the metadata agent, the genres and a MyAnimeList lookup. A whole library can be forced in or out of anime on the Plex servers page."
        />
      </Group>

      <Group title="Continue watching">
        <Row
          label="Drop off after"
          hint="How long a half-finished film, or a show you stopped mid-season, keeps its place on the dashboard."
        >
          {/* The one dropdown the app has. See `components/Dropdown.tsx`. */}
          <Select
            label="Drop off after"
            value={stored === null ? 'plex' : String(stored)}
            onChange={(next) => update.mutate({ continue_watching_weeks: next === 'plex' ? null : Number(next) })}
            options={[
              {
                value: 'plex',
                label: plexWeeks !== null ? `Match Plex (${plexWeeks} weeks)` : 'Match Plex',
              },
              ...WINDOW_CHOICES.map((weeks) => ({
                value: String(weeks),
                label: `${weeks} weeks`,
              })),
              { value: '0', label: 'Never, keep everything' },
            ]}
          />
        </Row>
        <p className="text-small text-dim">
          {plexSummary(plexWeeks)} {inForceSummary(effectiveWeeks)}
        </p>
      </Group>

      <Group title="Danger">
        <Row
          label="Re-run anime detection"
          hint="Every library left on Detect is judged again, which can move titles between Anime and the film and show sections. A library you have set by hand keeps what you set."
        >
          <button
            type="button"
            onClick={() => reclassify.mutate()}
            disabled={reclassify.isPending}
            title="Judge every title again from its library, agent, genres and MyAnimeList."
            className="btn-danger"
          >
            {reclassify.isPending ? <Spinner /> : <Sparkles size={16} aria-hidden="true" />}
            Re-detect anime
          </button>
        </Row>
      </Group>
    </>
  )
}

/* ── Appearance ──────────────────────────────────────────────────────────── */

const THEME_CARDS: Array<{ value: Theme; label: string; icon: LucideIcon; caption: string }> = [
  { value: 'dark', label: 'Dark', icon: Moon, caption: 'Suits poster artwork.' },
  { value: 'light', label: 'Light', icon: Sun, caption: 'Paper, for a bright room.' },
  {
    value: 'system',
    label: 'Follow the system',
    icon: Monitor,
    caption: 'Whatever this device is set to.',
  },
]

function AppearancePane() {
  const { theme, resolved, setTheme } = useTheme()

  return (
    <Group title="Theme">
      <div className="grid max-w-[600px] grid-cols-2 gap-2 sm:grid-cols-3">
        {THEME_CARDS.map((card) => {
          const Icon = card.icon
          const selected = theme === card.value
          return (
            <button
              key={card.value}
              type="button"
              onClick={() => setTheme(card.value)}
              aria-pressed={selected}
              className={cn(
                'card overflow-hidden text-left transition-colors duration-hover ease-ease',
                // The selected card's 2px accent border, drawn as a 1px border
                // and a 1px inset ring so the card does not shift by a pixel
                // when it is picked.
                selected
                  ? 'border-accent ring-1 ring-inset ring-accent'
                  : 'hover:border-line-dashed',
              )}
            >
              <span className="grid h-16 place-items-center border-b border-line bg-window">
                <Icon
                  size={24}
                  aria-hidden="true"
                  className={selected ? 'text-strong' : 'text-muted'}
                />
              </span>
              <span className="flex items-start justify-between gap-2 p-strip">
                <span className="min-w-0">
                  <span className="block truncate text-body font-semibold text-strong">
                    {card.label}
                  </span>
                  {/* Wraps rather than truncates: "In use" takes the room the
                      caption would otherwise have had. */}
                  <span className="block text-tiny text-dim">{card.caption}</span>
                </span>
                {selected && <span className="shrink-0 text-tiny text-accent">In use</span>}
              </span>
            </button>
          )
        })}
      </div>
      <p className="text-small text-dim">
        {theme === 'system'
          ? `This device is asking for the ${resolved} theme just now, and Tally follows it as it changes.`
          : `Tally stays on the ${theme} theme whatever this device asks for.`}
      </p>
    </Group>
  )
}

/* ── Metadata ────────────────────────────────────────────────────────────── */

interface ProviderRow {
  name: string
  enabled: boolean | undefined
  /** The variable that switches it on, or null when it needs no key. */
  envVar: string | null
  description: string
}

function MetadataPane() {
  const settings = useQuery({ queryKey: ['app-settings'], queryFn: api.settings.get })

  if (settings.isError) {
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
  }

  const providers = settings.data?.providers
  const rows: ProviderRow[] = [
    {
      name: 'TMDB',
      enabled: providers?.tmdb,
      envVar: 'TMDB_API_KEY',
      description: 'Posters, backdrops and descriptions.',
    },
    {
      name: 'TheTVDB',
      enabled: providers?.tvdb,
      envVar: 'TVDB_API_KEY',
      description: 'Extra series data, and the Anime genre.',
    },
    {
      name: 'MyAnimeList',
      enabled: providers?.mal,
      envVar: 'MAL_CLIENT_ID',
      description: 'The official MyAnimeList API.',
    },
    {
      name: 'Jikan',
      enabled: providers?.jikan,
      envVar: null,
      description:
        'An unauthenticated MyAnimeList mirror, used when no MyAnimeList key is set.',
    },
  ]

  return (
    <Group title="Providers">
      {settings.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        rows.map((row) => (
          <Row key={row.name} label={row.name} hint={row.description}>
            {row.enabled ? (
              <span className="badge-good">Active</span>
            ) : row.envVar ? (
              <span className="badge figure">Set {row.envVar}</span>
            ) : (
              <span className="badge">Off</span>
            )}
          </Row>
        ))
      )}
      <p className="text-small text-dim">
        Keys are read from environment variables when Tally starts, so they cannot be changed
        here.
      </p>
    </Group>
  )
}

/* ── API keys ────────────────────────────────────────────────────────────── */

/** Fixed when the key is issued. Changing it is revoke and re-issue. */
const SCOPE_OPTIONS: Array<{ value: ApiKeyScope; label: string }> = [
  { value: 'full', label: 'Full' },
  { value: 'read_only', label: 'Read-only' },
  { value: 'stats', label: 'Stats only' },
]

const SCOPE_LABEL: Record<ApiKeyScope, string> = {
  full: 'Full access',
  read_only: 'Read-only',
  stats: 'Stats only',
}

const SCOPE_HELP: Record<ApiKeyScope, string> = {
  full: 'Everything this account can do, including changing data, triggering syncs and, if you are an administrator, the admin endpoints. Give it only to something you would trust with your password.',
  read_only:
    'Reads anything you can see, and writes nothing. Every other method is refused, so nothing using this key can change or delete data.',
  stats:
    'Only the statistics, metrics, health and version endpoints. This is the one for a Grafana datasource: anyone who can edit a dashboard there can send requests with the key it holds.',
}

function ApiKeysPane() {
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<ApiKeyScope>('full')
  // The plaintext exists only in this response. Once it leaves the screen it is
  // gone for good, so it is held here until the user dismisses it deliberately.
  const [issued, setIssued] = useState<ApiKeyCreated | null>(null)

  const keys = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys.list })

  const create = useMutation({
    mutationFn: (value: { name: string; scope: ApiKeyScope }) =>
      api.apiKeys.create(value.name, value.scope),
    onSuccess: (key) => {
      setIssued(key)
      setName('')
      queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const revoke = useMutation({
    mutationFn: (id: number) => api.apiKeys.revoke(id),
    onSuccess: () => {
      notify('Key revoked.', 'info')
      queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const all = keys.data ?? []

  return (
    <>
      <Group title="New key">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) create.mutate({ name: name.trim(), scope })
          }}
        >
          <StackedRow label="What is this key for?" htmlFor="api-key-name">
            <div className="flex max-w-[32rem] gap-2">
              <input
                id="api-key-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="For example, Home Assistant"
                className="field"
              />
              <button
                type="submit"
                disabled={create.isPending || !name.trim()}
                title={name.trim() ? 'Issue the key.' : 'Give the key a name first.'}
                className="btn-primary shrink-0"
              >
                {create.isPending ? <Spinner /> : <Plus size={16} aria-hidden="true" />}
                Create
              </button>
            </div>
          </StackedRow>
          <Row
            label="Access"
            hint={SCOPE_HELP[scope]}
          >
            <Segmented
              label="API key access"
              value={scope}
              onChange={setScope}
              options={SCOPE_OPTIONS}
            />
          </Row>
          <p className="text-small text-dim">
            Access is fixed when the key is issued. To change it, revoke the key and make
            another.
          </p>
        </form>

        {issued && (
          <Notice className="mt-2 flex-col items-stretch">
            <p className="text-control font-semibold text-strong">
              Copy this now. It is not shown again.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                readOnly
                value={issued.key}
                aria-label="Your new API key"
                className="field figure text-tiny"
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                type="button"
                onClick={async () => {
                  // Only claim success when the copy actually resolved:
                  // `navigator.clipboard` does not exist over plain HTTP, which
                  // is how self-hosted Tally is usually reached, and this key
                  // cannot be recovered.
                  const copied = await copyText(issued.key)
                  notify(
                    copied
                      ? 'API key copied.'
                      : 'Could not copy. Select the key and press Ctrl+C before closing this.',
                    copied ? 'success' : 'error',
                  )
                }}
                title="Copy the key to the clipboard."
                className="btn-outline shrink-0"
              >
                <Copy size={16} aria-hidden="true" />
                Copy
              </button>
              <button
                type="button"
                onClick={() => setIssued(null)}
                title="Hide the key. Tally cannot show it again."
                className="btn-ghost shrink-0"
              >
                Done
              </button>
            </div>
            <p className="mt-2 text-small text-dim">
              Only its fingerprint is stored, so Tally cannot show it to you again.
            </p>
          </Notice>
        )}
      </Group>

      <Group title="Your keys">
        {keys.isError ? (
          <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
        ) : keys.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : all.length === 0 ? (
          <p className="py-1.5 text-small text-dim">
            No keys yet. Create one to use the API from a script or another app.
          </p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {all.map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2">
                    <span
                      className={cn(
                        'truncate text-control',
                        key.revoked_at ? 'text-dim' : 'text-fg',
                      )}
                    >
                      {key.name}
                    </span>
                    {key.revoked_at ? (
                      <span className="badge shrink-0">Revoked</span>
                    ) : (
                      <span className="badge shrink-0">{SCOPE_LABEL[key.scope]}</span>
                    )}
                  </p>
                  <p className="text-small text-dim">
                    <span className="figure">{key.prefix}…</span> · created{' '}
                    {formatDateTime(key.created_at)} ·{' '}
                    {key.last_used_at
                      ? `last used ${relativeTime(key.last_used_at)}`
                      : 'never used'}
                  </p>
                </div>
                {!key.revoked_at && (
                  <button
                    type="button"
                    onClick={() => revoke.mutate(key.id)}
                    disabled={revoke.isPending && revoke.variables === key.id}
                    title="Stop this key working. It cannot be restored."
                    className="btn-danger shrink-0"
                  >
                    {revoke.isPending && revoke.variables === key.id ? <Spinner /> : null}
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {all.some((key) => !key.revoked_at) && (
          <p className="text-small text-dim">
            Revoking takes effect immediately, on every integration using that key.
          </p>
        )}
      </Group>

      <Group title="Using a key">
        <p className="py-1.5 text-small text-dim">
          Send it as <span className="figure">X-API-Key</span> or{' '}
          <span className="figure">Authorization: Bearer</span>, in a header and never in the
          URL, which ends up in logs. Endpoints under <span className="figure">/api</span>{' '}
          accept it as far as its access allows.
        </p>
        <a href="/api/docs" className="btn-outline w-fit" title="Open the generated API reference.">
          <ExternalLink size={16} aria-hidden="true" />
          API docs
        </a>
      </Group>
    </>
  )
}

/* ── About ───────────────────────────────────────────────────────────────── */

function AboutPane() {
  const { user } = useAuth()
  const settings = useQuery({ queryKey: ['app-settings'], queryFn: api.settings.get })
  const version = useQuery({
    queryKey: ['app-version'],
    queryFn: api.settings.version,
    staleTime: Infinity,
    gcTime: Infinity,
  })

  return (
    <>
      <Group title="This instance">
        <Row label="Version">
          <Fact figure>{version.data?.version ?? settings.data?.version ?? '–'}</Fact>
        </Row>
        <Row label="Licence">
          <Fact>Apache-2.0</Fact>
        </Row>
        <Row label="Public address" hint="What Tally puts in the webhook address it hands to Plex.">
          <Fact figure>{settings.data?.public_url ?? '–'}</Fact>
        </Row>
      </Group>

      <Group title="Your account">
        <Row label="Signed in as">
          <Fact>{user?.display_name || user?.username || '–'}</Fact>
        </Row>
        <Row label="Account">
          <Fact>{user?.plex_username ? `Plex · ${user.plex_username}` : 'Local account'}</Fact>
        </Row>
        <Row label="Role" hint="Set by an administrator, so it cannot be changed here.">
          <Fact>{user?.is_admin ? 'Administrator' : 'Standard user'}</Fact>
        </Row>
      </Group>

      {(version.data?.github_url || version.data?.dockerhub_url) && (
        <Group title="Project">
          <div className="flex flex-wrap gap-2 py-1.5">
            {version.data?.github_url && (
              <a
                href={version.data.github_url}
                target="_blank"
                rel="noreferrer"
                className="btn-outline"
                title="Open the source repository."
              >
                <ExternalLink size={16} aria-hidden="true" />
                Source
              </a>
            )}
            {version.data?.dockerhub_url && (
              <a
                href={version.data.dockerhub_url}
                target="_blank"
                rel="noreferrer"
                className="btn-outline"
                title="Open the published image."
              >
                <ExternalLink size={16} aria-hidden="true" />
                Docker image
              </a>
            )}
          </div>
        </Group>
      )}
    </>
  )
}
