import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Copy,
  Download,
  ExternalLink,
  Info,
  KeyRound,
  Library as LibraryIcon,
  Plus,
  RefreshCw,
  ScanSearch,
  Server as ServerIcon,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  type LucideIcon,
} from 'lucide-react'
import { api } from '@/lib/api'
import {
  THEME_LIBRARY_KEY,
  themeResolvedKey,
  useAuth,
  useTheme,
  useToast,
  type Theme,
} from '@/lib/app-context'
import { THEME_KEYS, baseLightness, findTheme, type ThemeKeyRow } from '@/lib/theme'
import { FOLLOW_DEVICE, deviceTimezone, timezoneOptions } from '@/lib/timezones'
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
import { SyncProgress } from '@/components/Layout'

/*
 * Settings, in the shape STYLE-GUIDE §9 fixes.
 *
 * Two columns at 1024px and up: a 240px column holding the title and the
 * sidebar tabs (§7.4), and a pane with its own header, one body and a footer.
 * Below 1024px the tab column stacks into a segmented control at the top.
 * Every control writes as it is touched, with one exception the footer names:
 * a server address is committed with a button, because a half-typed host would
 * otherwise be tried on every keystroke.
 *
 * The version and licence pair (§12) is *not* here. It lives at the foot of the
 * app sidebar, and §12 offers the sidebar or the settings column, not both:
 * printing it in two corners of one screen reads as two numbers rather than as
 * one. The About pane reports the version as a fact of the instance, which is a
 * different statement.
 *
 * A row is a label, an optional second line, and its control hard against the
 * right edge. Rows group under an eyebrow with a `line-soft` hairline between
 * groups. A setting Tally cannot change from here says so in the row rather
 * than being drawn disabled with no explanation.
 *
 * Every request this page reads is checked for `isError` before its value is
 * drawn. `/api/settings` is a *local* request, and the pane used to explain a
 * failed one with a sentence about what Plex had not told Tally yet, which is
 * a confident and wrong story about somebody else's machine.
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
    description: 'The interface should disappear behind your work. Pick a theme and a time zone.',
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

/**
 * Label at the left, an optional second line under it, the control at the right
 * edge.
 *
 * The 8px vertical padding is `Toggle`'s, deliberately: a group mixes rows and
 * toggles freely, and at 6px against the toggle's 8px the Anime group stepped
 * 48px, 59px, 48px down the page. One rhythm inside one group.
 */
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
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
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
    <div className="py-2">
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

/**
 * A value the pane reports rather than offers: read as a fact, not a control.
 *
 * `figure` is for a value and a value only, so a column of them lines up: a
 * version number, an address, a count. A *phrase* containing a number is not a
 * figure, because a sentence set in mono reads as code. "Every 30 minutes" puts
 * `.figure` round the 30 and nothing else.
 *
 * The same line divides the times on this page. An absolute timestamp is a
 * value and is monospaced; a relative one ("6 hours ago", and in some locales
 * "yesterday", with no number in it at all) is prose and is not.
 */
function Fact({ children, figure }: { children: ReactNode; figure?: boolean }) {
  return (
    <span className={cn('text-control text-strong', figure && 'figure text-tiny')}>{children}</span>
  )
}

/**
 * A standalone sentence under a group's rows.
 *
 * It exists so the 65 ch measure of §4 is not a thing each call site remembers.
 * These notes ran the full width of the pane, 144 characters a line at 1440px,
 * directly under row hints that were already capped.
 */
function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('max-w-[65ch] text-small text-dim', className)}>{children}</p>
}

/**
 * A request this page could not complete, said so where its value would have
 * gone (rule 12). Wrapped in a well so it reads as one region of the pane
 * rather than as the whole page having failed.
 */
function QueryError({
  error,
  title,
  onRetry,
  compact,
}: {
  error: unknown
  title: string
  onRetry: () => void
  /**
   * True where the failure stands in for a single row's value rather than for a
   * whole region. `ErrorState`'s full form is a centred block sized for an empty
   * page, which turned a one-line fact like the public address into a box taller
   * than the pane it sat in.
   */
  compact?: boolean
}) {
  return (
    <div className="well">
      <ErrorState error={error} title={title} onRetry={onRetry} compact={compact} />
    </div>
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
                  <Icon className="size-icon" aria-hidden="true" />
                  <span className="truncate">{tab.label}</span>
                </button>
              )
            })}
          </nav>
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
          <p className="mt-0.5 max-w-[65ch] text-body text-muted">{current.description}</p>
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

        {/* §9 puts a sentence here saying how settings are kept. It has to
            agree with what is on screen: the Plex pane really does have a Save,
            so the footer names it rather than denying it exists. */}
        <footer className="border-t border-line p-strip text-tiny text-dim">
          <span className="block max-w-[65ch]">
            Changes apply as you make them, apart from a Plex server address,
            which waits for its Save button.
          </span>
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
            // A disabled control says why it is disabled, and there are two
            // reasons it can be. The tooltip is readable now that `.btn` no
            // longer takes pointer events off it, so it has to be the right
            // sentence rather than a plausible one.
            title={
              !user?.has_plex_link
                ? 'Link a Plex account first.'
                : discover.isPending
                  ? 'Already asking plex.tv.'
                  : 'Ask plex.tv which servers this account can reach.'
            }
            className="btn-outline"
          >
            {discover.isPending ? <Spinner /> : <RefreshCw className="size-icon" aria-hidden="true" />}
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
        {/* The address comes from `/api/settings`. A failed request there is not
            an address that is "still loading", and saying so would leave a
            disabled Copy button explaining itself with something untrue. */}
        {settings.isError ? (
          <QueryError
            error={settings.error}
            title="Could not load the webhook address"
            onRetry={() => void settings.refetch()}
            compact
          />
        ) : (
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
                title={webhookUrl ? 'Copy the address.' : 'The address is still loading.'}
                onClick={async () => {
                  const copied = await copyText(webhookUrl)
                  notify(
                    copied
                      ? 'Webhook address copied.'
                      : 'Could not copy. Select the address and copy it yourself.',
                    copied ? 'success' : 'error',
                  )
                }}
                className="btn-outline shrink-0"
              >
                <Copy className="size-icon" aria-hidden="true" />
                Copy
              </button>
            </div>
            <Note className="mt-2">Add it in Plex under Settings, then Webhooks.</Note>
          </StackedRow>
        )}
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
            title={
              test.isPending
                ? `Already asking ${server.name}.`
                : `Ask ${server.name} whether it answers on this address.`
            }
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
              saveUrl.isPending
                ? 'Saving the address.'
                : urlDraft.trim() === (server.manual_url ?? '')
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
              title={
                saveUrl.isPending
                  ? 'Saving the address.'
                  : 'Go back to the addresses Plex advertises.'
              }
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

/**
 * The three states of `anime_override`, as the values the dropdown round-trips.
 *
 * Every option names the field, the default included. "Detect" on its own said
 * nothing about *what* is detected, and it is the state most libraries are in,
 * sitting immediately left of a button labelled "Scan".
 */
const ANIME_OPTIONS = [
  { value: 'auto', label: 'Detect anime' },
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

      {/* Wraps, and is not `shrink-0`. Three controls at the web scale (6.5) -
          a 8.5rem select, a 32px button and a toggle with its label - come to
          more than a phone-width panel can hold on one line, and a cluster
          that refuses to shrink does not overflow visibly: `.panel` clips it,
          so the Include switch simply was not there below about 420px. */}
      <span className="flex flex-wrap items-center justify-end gap-2">
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
          {scanning ? <Spinner /> : <RefreshCw className="size-icon" aria-hidden="true" />}
          Scan
        </button>

        {/* The visible label is short because the row already names the library
            immediately to its left. The accessible name carries the library
            anyway, the way the `Select` beside it does with "Anime in {title}":
            read aloud, four switches all called "Include" are told apart only
            by their order. */}
        <Toggle
          label="Include"
          srLabel={`Include ${library.title}`}
          checked={library.enabled}
          onChange={onToggleEnabled}
        />
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

  // A cancel already in flight, whether this button knows it from its own
  // request or from a status that came back with the flag set. Reading only the
  // flag left the label saying "Cancel sync" until a poll landed, up to three
  // seconds after the click. This is the shell's `SyncControl` line for line,
  // and the two must not drift: they are the same control in two places.
  const stopping = cancelSync.isPending || Boolean(syncStatus.data?.cancel_requested)

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
              disabled={!running || stopping}
              title={
                stopping
                  ? 'Already stopping. The run ends after the current step.'
                  : running
                    ? 'Stop after the current step.'
                    : 'The sync has not started yet.'
              }
              className="btn-ghost shrink-0"
            >
              {stopping ? 'Stopping…' : 'Cancel sync'}
            </button>
          </div>
          {/* `status={undefined}` is the "clicked, nothing back yet" state, and
              it depends on `SyncProgress`'s `sliding` defaulting to true: with
              no status there is no total, so the rail is indeterminate only
              while that default holds. Flip the default and this draws an empty
              track under the words "Starting sync". */}
          <SyncProgress status={running ? syncStatus.data : undefined} />
        </div>
      )}

      <Group title="Schedule">
        {settings.isError ? (
          <QueryError
            error={settings.error}
            title="Could not load the sync schedule"
            onRetry={() => void settings.refetch()}
            compact
          />
        ) : (
          <Row
            label="Automatic sync"
            hint="Set with the SYNC_INTERVAL_MINUTES environment variable, so it cannot be changed here."
          >
            {settings.isLoading ? (
              <Skeleton className="h-4 w-28" />
            ) : settings.data ? (
              // The number is the figure; the sentence around it is not.
              <Fact>
                Every <span className="figure">{settings.data.sync_interval_minutes}</span> minutes
              </Fact>
            ) : (
              <Fact>Unknown</Fact>
            )}
          </Row>
        )}
        {/* "Never" is a claim about the sync history, and a failed poll is not
            evidence for it. Same rule as the settings request above: a request
            that did not answer says so. */}
        {syncStatus.isError ? (
          <QueryError
            error={syncStatus.error}
            title="Could not load the sync status"
            onRetry={() => void syncStatus.refetch()}
            compact
          />
        ) : (
          <Row
            label="Last sync"
            hint={
              lastRun ? (
                <span className="figure">{formatDateTime(lastRun.started_at)}</span>
              ) : undefined
            }
          >
            {lastRun ? (
              <>
                <Fact>{relativeTime(lastRun.started_at)}</Fact>
                <RunStatus status={lastRun.status} />
              </>
            ) : (
              <Fact>Never</Fact>
            )}
          </Row>
        )}
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
          <Note className="py-2">No sync has run yet.</Note>
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
            // A disabled control says why *it* is disabled. This used to borrow
            // `syncLabel`, which describes the running sync ("Sync with Plex
            // now." when idle, on a button that does something else).
            title={
              fullSync.isPending
                ? 'Starting the full re-import.'
                : running
                  ? 'A sync is already running. Wait for it to finish, or cancel it above.'
                  : 'Read the whole Plex history again and rescan every library.'
            }
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
        {/* `plexSummary(null)` explains what Plex has not said yet, which is a
            statement about the Plex server and is only true once Tally's own
            settings have actually been read. A failed or unfinished request to
            `/api/settings` says nothing about Plex at all. */}
        {settings.isError ? (
          <QueryError
            error={settings.error}
            title="Could not load Tally's own settings"
            onRetry={() => void settings.refetch()}
            compact
          />
        ) : settings.isLoading ? (
          <Skeleton className="h-8 w-full max-w-[65ch]" />
        ) : (
          <Note>
            {plexSummary(plexWeeks)} {inForceSummary(effectiveWeeks)}
          </Note>
        )}
      </Group>

      <Group title="Danger">
        <Row
          label="Re-run anime detection"
          hint="Every library left to detect anime for itself is judged again, which can move titles between Anime and the film and show sections. A library you have set by hand keeps what you set."
        >
          <button
            type="button"
            onClick={() => reclassify.mutate()}
            disabled={reclassify.isPending}
            title={
              reclassify.isPending
                ? 'Already re-running anime detection.'
                : 'Judge every title again from its library, agent, genres and MyAnimeList.'
            }
            className="btn-danger"
          >
            {reclassify.isPending ? <Spinner /> : <Sparkles className="size-icon" aria-hidden="true" />}
            Re-detect anime
          </button>
        </Row>
      </Group>
    </>
  )
}

/* ── Appearance ──────────────────────────────────────────────────────────── */

/**
 * The zone days are counted in, and the one setting on this page that is not
 * about what Tally looks like to *you*.
 *
 * It lives in Appearance all the same, because it is a question about how
 * things are presented rather than about Plex: a play is stored in UTC and
 * always will be, and this only decides which day that instant is shown under.
 * See the backend's `app/timezones.py` and CLAUDE.md, "A day belongs to the
 * viewer, not to the database".
 *
 * ## Why the control is worth having at all
 *
 * Nothing in the interface needs it. Every statistics request the app makes
 * carries `?tz=` with the browser's own zone, so a person clicking around Tally
 * is already answered in their own days. The stored preference is what
 * `resolve()` falls back to when a request arrives *without* that parameter,
 * which is every Grafana panel, every script and every API consumer. Left
 * unset, all of those get UTC, and until now the only way to change that was a
 * hand-written PUT. That asymmetry is what the note under the row has to say
 * out loud, because the setting appears to do nothing when you are the one
 * looking at the page.
 */
function TimeZoneGroup() {
  const { prefs, update } = usePreferences()

  /* Read once: the browser's zone cannot change while the page is open. */
  const device = useMemo(() => deviceTimezone(), [])
  const stored = typeof prefs.timezone === 'string' && prefs.timezone ? prefs.timezone : null

  const options = useMemo(() => {
    const list = timezoneOptions(device)
    // A zone set through the API that this browser's list does not carry would
    // otherwise show as "nothing chosen", which is a lie about a stored value.
    if (stored && !list.some((option) => option.value === stored)) {
      return [...list, { value: stored, label: stored.replace(/_/g, ' ') }]
    }
    return list
  }, [device, stored])

  const onDevice = device ? `, which is ${device.replace(/_/g, ' ')} just now` : ''

  return (
    <Group title="Time zone">
      <Row
        label="Count days in"
        hint="Where midnight falls, so a film started at 23:30 is counted on the evening you watched it and not the next morning."
      >
        <Select
          label="Time zone"
          /* Fixed rather than sized to the label, for two reasons: the trigger
             must not resize under the pointer as the chosen zone changes, and
             a bordered list is *exactly* the trigger's width (§7.7), so this is
             also how much room four hundred zone names get to be read in. */
          className="w-[13rem]"
          value={stored ?? FOLLOW_DEVICE}
          options={options}
          onChange={(next) =>
            update.mutate({ timezone: next === FOLLOW_DEVICE ? null : next })
          }
        />
      </Row>
      <Note>
        {stored === null
          ? `Statistics you open here always use this device's zone${onDevice}. Nothing is stored, so a Grafana panel or a script that asks the API without naming a zone is answered in UTC.`
          : `Statistics you open here still use this device's zone${onDevice}. A Grafana panel or a script that asks the API without naming a zone is answered in ${stored.replace(/_/g, ' ')}.`}
      </Note>
    </Group>
  )
}

/*
 * The theme library (STYLE-GUIDE §3.1, §3.2, §9).
 *
 * Three built-in choices, then the account's own themes, then the dashed
 * "New…" card. That card **copies what is in use**, and it is the only way to
 * make a theme, because nothing shipped may be written to the library: a
 * built-in is compiled in, and anything the user decides about it has to live
 * where an update never reaches.
 *
 * Under the cards sits the editor: the twenty-seven stored keys grouped
 * exactly as §2.1 and in the order §3.2 fixes, so a file reads top to bottom
 * like the pane it came from. Twenty-seven rows is a lot of pane, so each
 * group is an eyebrow of its own and the rows pair up into two columns once
 * there is room for them.
 *
 * The editor always edits **the theme in use**, and that is the design rather
 * than a shortcut. Settings apply live on this page, so an edit to a swatch is
 * visible on the page it is edited on, which is the strongest argument the
 * arrangement has for itself. Editing a theme nobody is wearing would change
 * nothing on screen, and a change that shows nothing is indistinguishable from
 * a request that never landed.
 */

const THEME_CARDS: Array<{ value: Theme; label: string; caption: string }> = [
  { value: 'dark', label: 'Dark', caption: 'Suits poster artwork.' },
  { value: 'light', label: 'Light', caption: 'Paper, for a bright room.' },
  {
    value: 'system',
    label: 'Follow the system',
    caption: 'Whatever this device is set to.',
  },
]

/**
 * `#RRGGBB`, `RRGGBB` and `#RGB` in; `#RRGGBB` out. Anything else is refused.
 *
 * The refusal is the point (§3.2). A theme that quietly took black for a value
 * it could not read is a theme with an invisible interface in it, so nothing
 * unparsed is ever sent to the server or written into a preview: the swatch
 * shows what the field *will* send, and a field that will send nothing says so
 * where it stands.
 */
function parseColour(text: string): string | null {
  const body = text.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(body)) return `#${body.toLowerCase()}`
  if (/^[0-9a-fA-F]{3}$/.test(body)) {
    return `#${body
      .toLowerCase()
      .split('')
      .map((c) => c + c)
      .join('')}`
  }
  return null
}

/**
 * The five tokens a preview may name, as file key → custom property.
 *
 * `.sample-dark` / `.sample-light` re-declare exactly these on a subtree, so
 * these are the only five a preview can honestly draw. A custom theme fills
 * them from its own table instead; anything it is missing falls through to the
 * sample class underneath, which is why the class is still applied.
 */
const SAMPLE_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['backdrop', '--backdrop'],
  ['chrome', '--chrome'],
  ['border', '--line'],
  ['text_strong', '--text-strong'],
  ['accent', '--accent'],
]

/**
 * A theme's own five tokens as an element style.
 *
 * Setting a custom property from a value the API returned is not "a raw colour
 * in a component": the component names five roles and never a colour, and the
 * table it fills them from is the theme's. Every value is parsed first, so a
 * colour the browser would not understand never reaches the DOM.
 */
function sampleStyle(colours: Record<string, string> | undefined): CSSProperties | undefined {
  if (!colours) return undefined
  const style: Record<string, string> = {}
  for (const [key, property] of SAMPLE_TOKENS) {
    const colour = parseColour(colours[key] ?? '')
    if (colour) style[property] = colour
  }
  return Object.keys(style).length > 0 ? (style as CSSProperties) : undefined
}

/**
 * A card's preview, drawn in the theme the card offers rather than in the one
 * the page happens to be wearing.
 *
 * `.sample-dark` / `.sample-light` in `theme-tally.css` re-declare exactly five
 * tokens on a subtree, so **only** `bg-backdrop`, `bg-chrome`, `border-line`,
 * `bg-strong` / `text-strong` and `bg-accent` may appear in here. Anything else
 * resolves in the page's own theme and the preview becomes a mixture of the two,
 * which is worse than the 24px icon this replaced.
 *
 * What it draws is Tally's own shell in miniature: the sidebar with a selected
 * row carrying its accent mark, then a heading and a rail of cards. The bars
 * stand for text, which is why they are `bg-strong` faded with an element
 * opacity (an alpha *modifier* on a token colour would emit no CSS at all).
 *
 * `vars` is how a *custom* theme shows itself: the same five names, written as
 * an element style from the theme's own table, which outranks the class.
 */
function ThemeSample({
  sample,
  vars,
}: {
  sample: 'sample-dark' | 'sample-light'
  vars?: CSSProperties
}) {
  return (
    <span className={cn('block border-b border-line', sample)} style={vars}>
      <span className="flex h-16 bg-backdrop">
        <span className="flex w-2/5 flex-col gap-1 border-r border-line bg-chrome p-1.5">
          <span className="flex items-center gap-1">
            <span className="h-2 w-0.5 shrink-0 rounded-tight bg-accent" />
            <span className="h-1 flex-1 rounded-tight bg-strong opacity-70" />
          </span>
          <span className="h-1 w-3/4 rounded-tight bg-strong opacity-25" />
          <span className="h-1 w-2/3 rounded-tight bg-strong opacity-25" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1.5 p-1.5">
          <span className="h-1 w-1/2 rounded-tight bg-strong opacity-70" />
          <span className="flex min-h-0 flex-1 gap-1">
            <span className="flex-1 rounded-tight border border-line bg-chrome" />
            <span className="flex-1 rounded-tight border border-line bg-chrome" />
            <span className="flex-1 rounded-tight border border-line bg-chrome" />
          </span>
        </span>
      </span>
    </span>
  )
}

/**
 * One card in the grid (§7.15): a preview, a caption, and a 2px accent border
 * when it is the one in use.
 *
 * The border is a 1px border plus a 1px inset ring rather than a 2px border,
 * so the card does not shift by a pixel when it is picked.
 */
function ThemeCard({
  label,
  caption,
  selected,
  sample,
  vars,
  onSelect,
}: {
  label: string
  caption: ReactNode
  selected: boolean
  sample: 'sample-dark' | 'sample-light'
  vars?: CSSProperties
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'card overflow-hidden text-left transition-colors duration-hover ease-ease',
        selected ? 'border-accent ring-1 ring-inset ring-accent' : 'hover:border-line-dashed',
      )}
    >
      <ThemeSample sample={sample} vars={vars} />
      <span className="flex items-start justify-between gap-2 p-strip">
        <span className="min-w-0">
          <span className="block truncate text-body font-semibold text-strong">{label}</span>
          {/* Wraps rather than truncates: "In use" takes the room the caption
              would otherwise have had. */}
          <span className="block text-tiny text-dim">{caption}</span>
        </span>
        {selected && <span className="shrink-0 text-tiny text-accent">In use</span>}
      </span>
    </button>
  )
}

/**
 * One of the twenty-seven: a 26 by 26 swatch, the token's name, and a typeable
 * hex figure (§7.20).
 *
 * The swatch is a label over a native colour input, so a picker is one click
 * away without a second implementation of one; the hex field is the readout
 * and the keyboard path. Both show the same thing, and both show **what will
 * be sent**: a typed value is parsed as it is typed, the swatch follows the
 * parse rather than the text, and a value that will not parse is refused where
 * it stands instead of being sent as something else.
 *
 * `text` is null while the row is showing the stored value, so nothing has to
 * reconcile a draft with a server answer that arrives later: committing clears
 * the draft and the stored value takes over again. The typed field does that
 * itself; the native picker cannot, because it has no commit of its own, so
 * the effect below does it for it.
 */
function SwatchRow({
  row,
  value,
  readOnly,
  readOnlyReason,
  onCommit,
}: {
  row: ThemeKeyRow
  value: string
  readOnly: boolean
  /** Said in the row, never a silently disabled control (§9). */
  readOnlyReason: string
  onCommit: (key: string, colour: string, settle: boolean) => void
}) {
  const [text, setText] = useState<string | null>(null)
  const picked = useRef(false)
  const shown = text ?? value
  const parsed = parseColour(shown)
  const stored = parseColour(value)
  const swatch = parsed ?? stored
  const id = `theme-colour-${row.key}`

  const commit = () => {
    const colour = parseColour(text ?? '')
    if (colour && colour !== stored) onCommit(row.key, colour, false)
    setText(null)
  }

  /*
   * The picker's draft, given back once the server has answered.
   *
   * A picker edit sets the draft so the swatch can follow the pointer, and
   * then nothing ever cleared it: the row went on showing what was picked
   * rather than what is stored, until something remounted it. Harmless for as
   * long as the two agree, and exactly the wrong way round the moment they do
   * not - a row that would rather show its own draft than the truth is a row
   * that cannot report a value the server normalised. So the draft is dropped
   * the moment the stored value moves, which is the answer landing.
   */
  useEffect(() => {
    if (!picked.current) return
    picked.current = false
    setText(null)
  }, [value])

  return (
    <div className="py-1">
      <div className="flex items-center gap-2">
        {readOnly || !swatch ? (
          <span
            aria-hidden="true"
            title={readOnly ? readOnlyReason : undefined}
            className="h-button w-button shrink-0 rounded-ctl border border-line-popover"
            style={swatch ? { background: swatch } : undefined}
          />
        ) : (
          <label
            className="h-button w-button shrink-0 cursor-pointer rounded-ctl border border-line-popover"
            style={{ background: swatch }}
            title={`Pick a colour for ${row.label.toLowerCase()}.`}
          >
            <input
              type="color"
              className="sr-only"
              value={swatch}
              aria-label={`Pick a colour for ${row.label.toLowerCase()}`}
              onChange={(event) => {
                const colour = parseColour(event.target.value)
                if (!colour) return
                picked.current = true
                setText(colour)
                // The picker fires as the pointer moves, so this one settles
                // before it is sent. The typed field commits at once instead.
                onCommit(row.key, colour, true)
              }}
            />
          </label>
        )}
        <label htmlFor={id} className="min-w-0 flex-1 truncate text-control text-fg">
          {row.label}
        </label>
        <input
          id={id}
          type="text"
          spellCheck={false}
          autoComplete="off"
          className={cn(
            'field figure w-[10ch] shrink-0 px-2 text-tiny',
            // The refused value itself goes critical, not the field's edge: a
            // field being typed into is focused, and `.field`'s focus border
            // is the accent, so a critical *border* is a state that can never
            // be seen. The sentence under the row is the signal that carries;
            // this is the colour beside it, never the colour alone.
            !parsed && 'text-critical',
          )}
          value={shown}
          readOnly={readOnly}
          aria-invalid={parsed ? undefined : true}
          title={readOnly ? readOnlyReason : undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
            if (event.key === 'Escape') setText(null)
          }}
        />
      </div>
      {/* What it will send, said before it is sent. */}
      {text !== null && !parsed && (
        <p role="alert" className="mt-0.5 text-tiny text-critical">
          Not a colour. Use #RRGGBB, RRGGBB or #RGB.
        </p>
      )}
      {text !== null && parsed && parsed !== shown.trim().toLowerCase() && (
        <p className="mt-0.5 text-tiny text-dim">
          Saves as <span className="figure">{parsed}</span>.
        </p>
      )}
    </div>
  )
}

/** The §2.1 groups, in the order §3.2 fixes, taken from the table itself. */
const THEME_GROUPS: ReadonlyArray<ThemeKeyRow['group']> = THEME_KEYS.reduce<
  Array<ThemeKeyRow['group']>
>((groups, row) => (groups.includes(row.group) ? groups : [...groups, row.group]), [])

function AppearancePane() {
  const { theme, resolved, setTheme, themeId, setThemeId, themeLoading, themeError } = useTheme()
  const { notify } = useToast()
  const queryClient = useQueryClient()

  const nameRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const timers = useRef<Record<string, number>>({})
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  /* Whose import it was, so a notice cannot outlive the theme it describes. */
  const [lost, setLost] = useState<{ id: string; lines: number } | null>(null)

  const library = useQuery({
    queryKey: THEME_LIBRARY_KEY,
    queryFn: api.themes.list,
    staleTime: 60_000,
  })
  const themes = library.data ?? []
  const mine = themes.filter((entry) => !entry.is_builtin)

  /*
   * Which theme the editor is pointed at.
   *
   * A custom one when the preference names it; otherwise the built-in whose
   * lightness is on screen, which is what the three cards above actually
   * select. Found by lightness rather than by a hardcoded id, so an app that
   * one day ships a third built-in still lands somewhere true.
   */
  const inUse =
    (themeId ? findTheme(themes, themeId) : null) ??
    (themeId
      ? null
      : (themes.find((entry) => entry.is_builtin && baseLightness(entry.base) === resolved) ??
        null))
  const inUseId = inUse?.id ?? null

  /*
   * Nothing typed or armed about one theme may carry over to another.
   *
   * The delete row is the one that matters: it re-labels itself from `inUse`,
   * so arming it and then clicking another card left "Delete for good"
   * standing over a name it had never been armed for, one click from
   * destroying a theme nobody confirmed. A two-step confirmation that survives
   * a change of subject is not a confirmation. The half-typed name goes with
   * it for the same reason - it belongs to the theme it was being typed for.
   *
   * The import notice is not reset here. It arrives *with* a theme change, so
   * an effect on this edge would clear it before it was ever read; it names
   * the theme it belongs to instead, and is shown only while that theme is on.
   */
  useEffect(() => {
    setConfirmingDelete(false)
    setNameDraft(null)
  }, [inUseId])

  const readOnly = inUse?.is_builtin ?? true
  const readOnlyReason = inUse
    ? `${inUse.name} is built in, so these are read-only.`
    : 'A built-in theme is read-only.'

  /* A card shows its own colours, so each custom theme's table is fetched.
     The key is the editor's, so opening the pane fills both at once. */
  const previews = useQueries({
    queries: mine.map((entry) => ({
      queryKey: ['theme', entry.id],
      queryFn: () => api.themes.get(entry.id),
      staleTime: 60_000,
    })),
  })

  const detail = useQuery({
    queryKey: ['theme', inUseId],
    queryFn: () => api.themes.get(inUseId as string),
    enabled: inUseId !== null,
    staleTime: 60_000,
  })

  const refreshTheme = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: THEME_LIBRARY_KEY })
    void queryClient.invalidateQueries({ queryKey: ['theme', id] })
    // Without this the page goes on wearing the table it fetched before the
    // edit, and a live setting that does not move reads as a failed request.
    void queryClient.invalidateQueries({ queryKey: themeResolvedKey(id) })
  }

  const copy = useMutation({
    mutationFn: ({ source, name }: { source: string; name: string }) =>
      api.themes.create(source, name),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: THEME_LIBRARY_KEY })
      setThemeId(created.id)
      setNameDraft(null)
      notify(`Copied to “${created.name}”. It is yours to edit.`, 'success')
      window.setTimeout(() => nameRef.current?.select(), 0)
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.themes.update(id, { name }),
    onSuccess: (saved, sent) => {
      setNameDraft(null)
      refreshTheme(saved.id)
      // The library numbers a name somebody already used rather than replacing
      // a theme they built, so say so when it happened.
      if (saved.name !== sent.name) {
        notify(`Another theme is called “${sent.name}”, so this one is “${saved.name}”.`)
      }
    },
    onError: (error: Error) => {
      setNameDraft(null)
      notify(error.message, 'error')
    },
  })

  const paint = useMutation({
    mutationFn: ({ id, colours }: { id: string; colours: Record<string, string> }) =>
      api.themes.update(id, { colours }),
    onSuccess: (saved) => refreshTheme(saved.id),
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const importTheme = useMutation({
    mutationFn: (file: File) => api.themes.import(file),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: THEME_LIBRARY_KEY })
      setThemeId(result.theme.id)
      setNameDraft(null)
      // §3.2: an import that loses something has to say so, in these words.
      setLost(
        result.skipped_lines > 0
          ? { id: result.theme.id, lines: result.skipped_lines }
          : null,
      )
      notify(`Imported “${result.theme.name}”.`, 'success')
    },
    onError: (error: Error) => {
      setLost(null)
      notify(error.message, 'error')
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.themes.remove(id),
    onSuccess: () => {
      setConfirmingDelete(false)
      setThemeId(null)
      // The library listing is what drops the card, and dropping it unmounts
      // the query for its colours. Removing that query here instead would make
      // the observer still mounted for it refetch a file that no longer
      // exists, which answers 404 for as long as the old listing is on screen.
      void queryClient.invalidateQueries({ queryKey: THEME_LIBRARY_KEY })
      notify('Theme deleted.', 'success')
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  /*
   * A colour is written as it is chosen, because there is no Save button on
   * this page and there is not going to be one. The picker settles first: it
   * fires on every pointer move, and a request per pixel would be a request
   * per pixel. A typed value has already settled by the time it is committed.
   */
  const commitColour = (key: string, colour: string, settle: boolean) => {
    if (!inUseId || readOnly) return
    window.clearTimeout(timers.current[key])
    const send = () => paint.mutate({ id: inUseId, colours: { [key]: colour } })
    if (settle) timers.current[key] = window.setTimeout(send, 250)
    else send()
  }

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of Object.values(pending)) window.clearTimeout(timer)
    }
  }, [])

  const commitName = () => {
    const wanted = (nameDraft ?? '').trim()
    if (!inUseId || readOnly || !wanted || wanted === inUse?.name) {
      setNameDraft(null)
      return
    }
    rename.mutate({ id: inUseId, name: wanted })
  }

  const colours = detail.data?.colours
  const baseName = (base: string) =>
    themes.find((entry) => entry.id === base)?.name ?? (base === 'paper' ? 'Paper' : 'Graphite')

  return (
    <>
      <Group
        title="Theme"
        action={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".umbertheme,text/plain"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0]
                // Cleared so choosing the same file twice still fires.
                event.target.value = ''
                if (file) importTheme.mutate(file)
              }}
            />
            <button
              type="button"
              className="btn-outline"
              onClick={() => fileRef.current?.click()}
              disabled={importTheme.isPending}
            >
              <Upload className="size-icon" aria-hidden="true" />
              {importTheme.isPending ? 'Importing…' : 'Import a file'}
            </button>
          </>
        }
      >
        {themeError && (
          <Notice className="mb-2">
            <span className="block max-w-[65ch]">
              This theme could not be loaded, so Tally is showing the built-in one instead.
            </span>
          </Notice>
        )}
        {lost !== null && lost.id === themeId && (
          <Notice
            className="mb-2"
            actions={
              <button type="button" className="btn-ghost" onClick={() => setLost(null)}>
                Got it
              </button>
            }
          >
            <span className="block max-w-[65ch]">
              <span className="figure">{lost.lines}</span> line(s) could not be read, so those
              colours came from the theme it names as its base.
            </span>
          </Notice>
        )}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {THEME_CARDS.map((card) => {
            // "Follow the system" previews the *resolved* theme, which is what
            // the viewer is looking at. While a theme is pinned, `resolved` is
            // that pinned theme rather than the operating system's answer, so
            // this card can agree with the Light card while the device asks for
            // dark. Deliberate: reading `prefers-color-scheme` here would be
            // truer for one render and then go stale, because only the "system"
            // preference keeps a `matchMedia` listener alive. Do not swap one
            // for the other without moving that listener into `ThemeProvider`.
            const sample =
              card.value === 'light' ||
              (card.value === 'system' && themeId === null && resolved === 'light')
                ? 'sample-light'
                : 'sample-dark'
            return (
              <ThemeCard
                key={card.value}
                label={card.label}
                caption={card.caption}
                selected={themeId === null && theme === card.value}
                sample={sample}
                onSelect={() => setTheme(card.value)}
              />
            )
          })}

          {mine.map((entry, index) => (
            <ThemeCard
              key={entry.id}
              label={entry.name}
              /* A chosen theme whose table has not landed leaves the built-in
                 colours on screen, which reads as a card that did nothing.
                 Said on the card the user just clicked, where they are looking,
                 and in the room the caption already takes. */
              caption={
                themeLoading && themeId === entry.id
                  ? 'Fetching its colours.'
                  : `Made from ${baseName(entry.base)}.`
              }
              selected={themeId === entry.id}
              sample={baseLightness(entry.base) === 'light' ? 'sample-light' : 'sample-dark'}
              vars={sampleStyle(previews[index]?.data?.colours)}
              onSelect={() => setThemeId(entry.id)}
            />
          ))}

          {library.isLoading && <Skeleton className="h-[7.5rem]" />}

          {/* §3.1: the dashed card copies the current theme, which is the only
              way to make one. No fill, dashed edge, the size of its siblings. */}
          <button
            type="button"
            className="dashed flex min-h-[7.5rem] flex-col items-center justify-center gap-1
                       rounded-card border bg-transparent text-dim transition-colors
                       duration-hover ease-ease enabled:hover:text-strong
                       disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!inUse || copy.isPending}
            title={
              inUse
                ? `Copies ${inUse.name} into a theme of your own.`
                : library.isError
                  ? 'Your themes could not be loaded, so there is nothing to copy yet.'
                  : 'Waiting for the theme library.'
            }
            onClick={() =>
              inUse && copy.mutate({ source: inUse.id, name: `${inUse.name} copy` })
            }
          >
            <Plus size={24} aria-hidden="true" />
            {/* `text-control`: 11.5 px, the control size, and a size only.
                It once emitted `color: var(--control)` as well, because the
                type scale and the colour palette both carried the name
                "control" and the colour rule came second - which painted this
                label the resting-control grey on a `backdrop` card, all but
                invisible. `tailwind.config.js` now closes the set of colours
                text may be, and a surface is not one of them, so the name is
                the size alone and safe to use unpaired. */}
            <span className="text-control">{copy.isPending ? 'Copying…' : 'New theme'}</span>
          </button>
        </div>

        {library.isError && (
          <QueryError
            error={library.error}
            title="Your themes could not be loaded."
            onRetry={() => void library.refetch()}
            compact
          />
        )}

        <Note>
          {themeId !== null && inUse
            ? `“${inUse.name}” is in use, and the theme it was made from decides whether Tally is dark or light. Picking one of the first three brings the ${theme} preference back.`
            : theme === 'system'
              ? `This device is asking for the ${resolved} theme just now, and Tally follows it as it changes.`
              : `Tally stays on the ${theme} theme whatever this device asks for.`}
        </Note>
      </Group>

      {inUse && (
        <Group title="This theme">
          <Row
            label="Name"
            htmlFor={readOnly ? undefined : 'theme-name'}
            hint={
              readOnly
                ? `${inUse.name} is built in, so its name and colours are read-only. Copy it to make one you can edit.`
                : 'Up to 64 characters. It is what the card above is called.'
            }
          >
            {readOnly ? (
              <Fact>{inUse.name}</Fact>
            ) : (
              <input
                id="theme-name"
                ref={nameRef}
                type="text"
                className="field w-[22ch]"
                maxLength={64}
                value={nameDraft ?? inUse.name}
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={commitName}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitName()
                  }
                  if (event.key === 'Escape') setNameDraft(null)
                }}
              />
            )}
          </Row>
          <Row
            label="Made from"
            hint="Which built-in fills anything the file does not carry, and whether the theme is dark or light."
          >
            <Fact>
              {baseName(inUse.base)}, {baseLightness(inUse.base)}
            </Fact>
          </Row>
          <Row
            label="Export"
            hint="Writes a .umbertheme file. It opens in Umber, and in anything else in the family."
          >
            {/* A plain link: the browser saves the file, and nothing here
                claims it happened, because nothing here can know that it did. */}
            <a
              className="btn-outline"
              href={api.themes.exportUrl(inUse.id)}
              download={`${inUse.id}.umbertheme`}
            >
              <Download className="size-icon" aria-hidden="true" />
              Save the file
            </a>
          </Row>
        </Group>
      )}

      {inUseId && detail.isError && (
        <Group title="Colours">
          <QueryError
            error={detail.error}
            title="These colours could not be loaded."
            onRetry={() => void detail.refetch()}
          />
        </Group>
      )}

      {inUseId && !detail.isError && (
        <>
          {THEME_GROUPS.map((group) => (
            <Group
              key={group}
              title={group}
              action={
                readOnly ? (
                  <span className="text-tiny text-dim" title={readOnlyReason}>
                    Read-only
                  </span>
                ) : undefined
              }
            >
              <div className="grid gap-x-6 lg:grid-cols-2">
                {THEME_KEYS.filter((row) => row.group === group).map((row) =>
                  colours ? (
                    <SwatchRow
                      key={`${inUseId}:${row.key}`}
                      row={row}
                      value={colours[row.key] ?? ''}
                      readOnly={readOnly}
                      readOnlyReason={readOnlyReason}
                      onCommit={commitColour}
                    />
                  ) : (
                    <div key={row.key} className="py-1">
                      <Skeleton className="h-button" />
                    </div>
                  ),
                )}
              </div>
            </Group>
          ))}
        </>
      )}

      <TimeZoneGroup />

      {inUse && !readOnly && (
        <Group title="Danger">
          <Row
            label={`Delete “${inUse.name}”`}
            hint="The file goes for good and its colours cannot be recovered. Tally goes back to the built-in themes."
          >
            {confirmingDelete ? (
              <>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Keep it
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(inUse.id)}
                >
                  <Trash2 className="size-icon" aria-hidden="true" />
                  {remove.isPending ? 'Deleting…' : 'Delete for good'}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-danger"
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 className="size-icon" aria-hidden="true" />
                Delete
              </button>
            )}
          </Row>
        </Group>
      )}
    </>
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
      <Note>
        Keys are read from environment variables when Tally starts, so they cannot be changed
        here.
      </Note>
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
                title={
                  create.isPending
                    ? 'Issuing the key.'
                    : name.trim()
                      ? 'Issue the key.'
                      : 'Give the key a name first.'
                }
                className="btn-primary shrink-0"
              >
                {create.isPending ? <Spinner /> : <Plus className="size-icon" aria-hidden="true" />}
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
          <Note>
            Access is fixed when the key is issued. To change it, revoke the key and make
            another.
          </Note>
        </form>

        {issued && (
          <Notice className="mt-2 flex-col items-stretch">
            <p className="text-control font-semibold text-strong">
              Copy this now. It is not shown again.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {/* A textarea rather than an input, because this is the one value
                  in the app that cannot be recovered and it must be readable in
                  full: in a single-line field at 390px it was clipped mid-key.
                  Still focus-selectable, so a long press copies it on a phone.
                  `field-sizing` trims the second row where the key fits on one
                  line; `rows={2}` is what a browser without it falls back to,
                  which is the safe way round. */}
              <textarea
                readOnly
                rows={2}
                value={issued.key}
                aria-label="Your new API key"
                className="field figure h-auto min-w-[15rem] flex-1 resize-none break-all py-1.5 text-tiny [field-sizing:content]"
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                type="button"
                onClick={async () => {
                  // Only claim success when the copy actually resolved:
                  // `navigator.clipboard` does not exist over plain HTTP, which
                  // is how self-hosted Tally is usually reached, and this key
                  // cannot be recovered. The fallback names no keystroke: this
                  // is read on a phone as often as on a desktop.
                  const copied = await copyText(issued.key)
                  notify(
                    copied
                      ? 'API key copied.'
                      : 'Could not copy. Select the key and copy it yourself before closing this.',
                    copied ? 'success' : 'error',
                  )
                }}
                title="Copy the key to the clipboard."
                className="btn-outline shrink-0"
              >
                <Copy className="size-icon" aria-hidden="true" />
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
            <Note className="mt-2">
              Only its fingerprint is stored, so Tally cannot show it to you again.
            </Note>
          </Notice>
        )}
      </Group>

      <Group title="Your keys">
        {keys.isError ? (
          <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
        ) : keys.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : all.length === 0 ? (
          <Note className="py-2">
            No keys yet. Create one to use the API from a script or another app.
          </Note>
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
                    {/* An absolute timestamp is a value and is monospaced; a
                        relative one is a phrase and is not. */}
                    <span className="figure">{key.prefix}…</span> · created{' '}
                    <span className="figure">{formatDateTime(key.created_at)}</span> ·{' '}
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
                    title={
                      revoke.isPending && revoke.variables === key.id
                        ? 'Revoking this key.'
                        : 'Stop this key working. It cannot be restored.'
                    }
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
          <Note>Revoking takes effect immediately, on every integration using that key.</Note>
        )}
      </Group>

      <Group title="Using a key">
        <Note className="py-2">
          Send it as <span className="figure">X-API-Key</span> or{' '}
          <span className="figure">Authorization: Bearer</span>, in a header and never in the
          URL, which ends up in logs. Endpoints under <span className="figure">/api</span>{' '}
          accept it as far as its access allows.
        </Note>
        <a href="/api/docs" className="btn-outline w-fit" title="Open the generated API reference.">
          <ExternalLink className="size-icon" aria-hidden="true" />
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

  // `/api/version` is the source; `/api/settings` reports the same number and
  // stands in when the first has not answered.
  const reported = version.data?.version ?? settings.data?.version

  return (
    <>
      <Group title="This instance">
        {/* A missing value is a word, not a dash: §12 asks for something that
            can be read aloud. A version number and an address are values and
            are monospaced; "Not set" and "Unknown" are words and are not. */}
        <Row label="Version">
          {reported ? <Fact figure>{reported}</Fact> : <Fact>Unknown</Fact>}
        </Row>
        <Row label="Licence">
          <Fact>GPL-3.0</Fact>
        </Row>
        {settings.isError ? (
          <QueryError
            error={settings.error}
            title="Could not load this instance's settings"
            onRetry={() => void settings.refetch()}
            compact
          />
        ) : (
          <Row
            label="Public address"
            hint="What Tally puts in the webhook address it hands to Plex."
          >
            {settings.data?.public_url ? (
              <Fact figure>{settings.data.public_url}</Fact>
            ) : (
              <Fact>Not set</Fact>
            )}
          </Row>
        )}
      </Group>

      <Group title="Your account">
        <Row label="Signed in as">
          <Fact>{user?.display_name || user?.username || 'Unknown'}</Fact>
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
                <ExternalLink className="size-icon" aria-hidden="true" />
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
                <ExternalLink className="size-icon" aria-hidden="true" />
                Docker image
              </a>
            )}
          </div>
        </Group>
      )}
    </>
  )
}
