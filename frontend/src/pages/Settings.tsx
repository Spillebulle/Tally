import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth, useTheme, useToast, type Theme } from '@/lib/app-context'
import type { Library, Server } from '@/lib/types'
import { cn, formatDateTime, relativeTime } from '@/lib/utils'
import { EmptyState, PageHeader, Segmented, Spinner, Toggle } from '@/components/ui'
import { CheckIcon, RefreshIcon, SettingsIcon, SparkIcon } from '@/components/Icons'

function Section({
  title,
  description,
  children,
  actions,
}: {
  title: string
  description?: string
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function Settings() {
  const { user, refresh } = useAuth()
  const { theme, setTheme } = useTheme()
  const { notify } = useToast()
  const queryClient = useQueryClient()

  const settings = useQuery({ queryKey: ['app-settings'], queryFn: api.settings.get })
  const servers = useQuery({ queryKey: ['servers'], queryFn: api.servers.list })
  const preferences = useQuery({
    queryKey: ['preferences'],
    queryFn: api.settings.preferences,
  })
  const syncStatus = useQuery({
    queryKey: ['sync-status'],
    queryFn: api.sync.status,
    refetchInterval: (query) => (query.state.data?.running ? 3000 : 30_000),
  })
  const runs = useQuery({ queryKey: ['sync-runs'], queryFn: api.sync.runs })

  const updatePreference = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.settings.updatePreferences(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preferences'] })
      void refresh()
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const discover = useMutation({
    mutationFn: api.servers.discover,
    onSuccess: () => {
      notify('Plex servers refreshed', 'success')
      queryClient.invalidateQueries({ queryKey: ['servers'] })
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

  const reclassify = useMutation({
    mutationFn: api.settings.reclassifyAnime,
    onSuccess: () => notify('Re-running anime detection across your library', 'info'),
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const prefs = preferences.data ?? {}

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Settings" subtitle={`Signed in as ${user?.display_name || user?.username}`} />

      {/* --- Plex ------------------------------------------------------- */}
      <Section
        title="Plex servers"
        description="Tally reads your libraries, history and ratings from here — and writes changes back."
        actions={
          <button
            type="button"
            onClick={() => discover.mutate()}
            disabled={discover.isPending}
            className="btn-outline h-9 text-sm"
          >
            {discover.isPending ? <Spinner /> : <RefreshIcon />}
            Refresh
          </button>
        }
      >
        {!user?.has_plex_link ? (
          <EmptyState
            title="No Plex account linked"
            description="Sign out and sign back in with Plex to connect your server."
          />
        ) : servers.isLoading ? (
          <div className="skeleton h-24 rounded-xl" />
        ) : (servers.data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No servers found"
            description="Press Refresh to ask plex.tv which servers your account can reach."
          />
        ) : (
          <div className="space-y-4">
            {servers.data?.map((server) => (
              <ServerCard key={server.id} server={server} />
            ))}
          </div>
        )}
      </Section>

      {/* --- Sync ------------------------------------------------------- */}
      <Section
        title="Syncing"
        description={`Runs automatically every ${settings.data?.sync_interval_minutes ?? 30} minutes.`}
        actions={
          <button
            type="button"
            onClick={() => fullSync.mutate()}
            disabled={fullSync.isPending || syncStatus.data?.running}
            className="btn-outline h-9 text-sm"
          >
            {syncStatus.data?.running ? <Spinner /> : <RefreshIcon />}
            Full re-import
          </button>
        }
      >
        <div className="divide-y divide-line">
          <Toggle
            label="Sync ratings with Plex"
            description="Star ratings flow both ways. The most recent change wins."
            checked={Boolean(prefs.sync_ratings ?? true)}
            onChange={(value) => updatePreference.mutate({ sync_ratings: value })}
          />
          <Toggle
            label="Sync watchlist with Plex"
            description="Adding or removing a title here mirrors to your Plex watchlist, and vice versa."
            checked={Boolean(prefs.sync_watchlist ?? true)}
            onChange={(value) => updatePreference.mutate({ sync_watchlist: value })}
          />
          <Toggle
            label="Write watch state back to Plex"
            description="Marking something watched in Tally also marks it watched on your server."
            checked={Boolean(prefs.sync_history ?? true)}
            onChange={(value) => updatePreference.mutate({ sync_history: value })}
          />
        </div>

        <div className="mt-4 rounded-xl bg-raised p-3 text-sm">
          <p className="text-muted">
            Last sync:{' '}
            <span className="text-ink">
              {syncStatus.data?.last_run
                ? `${relativeTime(syncStatus.data.last_run.started_at)} · ${syncStatus.data.last_run.status}`
                : 'never'}
            </span>
          </p>
          {runs.data && runs.data.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted hover:text-ink">
                Recent sync runs
              </summary>
              <ul className="mt-2 space-y-1.5 text-xs">
                {runs.data.slice(0, 8).map((run) => (
                  <li key={run.id} className="flex items-center justify-between gap-3">
                    <span className="text-muted">{formatDateTime(run.started_at)}</span>
                    <span
                      className={cn(
                        'font-medium',
                        run.status === 'success' && 'text-good',
                        run.status === 'partial' && 'text-warn',
                        run.status === 'failed' && 'text-danger',
                        run.status === 'running' && 'text-accent',
                      )}
                    >
                      {run.status}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Section>

      {/* --- Webhook ---------------------------------------------------- */}
      <Section
        title="Live updates (optional)"
        description="With a Plex Pass, point a Plex webhook at Tally so plays register the moment they happen instead of at the next sync."
      >
        <label htmlFor="webhook" className="label">
          Webhook URL
        </label>
        <div className="mt-1.5 flex gap-2">
          <input
            id="webhook"
            readOnly
            value={settings.data?.webhook_url ?? ''}
            className="input font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(settings.data?.webhook_url ?? '')
              notify('Webhook URL copied', 'success')
            }}
            className="btn-outline shrink-0"
          >
            Copy
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">
          Add it under Plex → Settings → Webhooks. Tally still works without this.
        </p>
      </Section>

      {/* --- Anime ------------------------------------------------------ */}
      <Section
        title="Anime"
        description="Tally works out what is anime from your library names, the metadata agent, genres and a MyAnimeList lookup."
        actions={
          <button
            type="button"
            onClick={() => reclassify.mutate()}
            disabled={reclassify.isPending}
            className="btn-outline h-9 text-sm"
          >
            <SparkIcon /> Re-detect
          </button>
        }
      >
        <Toggle
          label="Keep anime in its own section"
          description="When on, anime is filtered out of Movies and Shows and lives under Anime."
          checked={Boolean(prefs.separate_anime ?? true)}
          onChange={(value) => updatePreference.mutate({ separate_anime: value })}
        />
        <p className="mt-3 text-xs text-muted">
          You can force a library to be treated as anime (or not) using the toggles on each
          library above.
        </p>
      </Section>

      {/* --- Metadata --------------------------------------------------- */}
      <Section
        title="Metadata providers"
        description="Posters, descriptions and anime data come from these. Configure keys with environment variables."
      >
        <ul className="space-y-2">
          {[
            ['TMDB', settings.data?.providers.tmdb, 'TMDB_API_KEY', 'Posters, backdrops, descriptions'],
            ['TheTVDB', settings.data?.providers.tvdb, 'TVDB_API_KEY', 'Extra series data and the Anime genre'],
            ['MyAnimeList', settings.data?.providers.mal, 'MAL_CLIENT_ID', 'Official MAL API'],
            ['Jikan', settings.data?.providers.jikan, '—', 'Unauthenticated MAL mirror, used when no MAL key is set'],
          ].map(([name, enabled, envVar, description]) => (
            <li
              key={String(name)}
              className="flex items-center justify-between gap-4 rounded-xl border border-line p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{String(name)}</p>
                <p className="text-xs text-muted">{String(description)}</p>
              </div>
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
                  enabled ? 'bg-good/15 text-good' : 'bg-raised text-muted',
                )}
              >
                {enabled ? <CheckIcon className="text-xs" /> : null}
                {enabled ? 'Active' : `Set ${envVar}`}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      {/* --- Appearance ------------------------------------------------- */}
      <Section title="Appearance">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-ink">Theme</p>
            <p className="text-xs text-muted">Dark suits poster artwork; light is there when you want it.</p>
          </div>
          <Segmented
            label="Theme"
            value={theme}
            onChange={(value) => setTheme(value as Theme)}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'Auto' },
            ]}
          />
        </div>
      </Section>

      <Section title="About">
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Version</dt>
            <dd className="text-ink">{settings.data?.version ?? '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Account</dt>
            <dd className="text-ink">
              {user?.plex_username ? `Plex · ${user.plex_username}` : 'Local account'}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Role</dt>
            <dd className="text-ink">{user?.is_admin ? 'Administrator' : 'Standard user'}</dd>
          </div>
        </dl>
      </Section>
    </div>
  )
}

function ServerCard({ server }: { server: Server }) {
  const queryClient = useQueryClient()
  const { notify } = useToast()

  const test = useMutation({
    mutationFn: () => api.servers.test(server.id),
    onSuccess: (result) =>
      notify(
        result.reachable ? `${server.name} is reachable` : `${server.name} is not responding`,
        result.reachable ? 'success' : 'error',
      ),
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const updateLibrary = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { enabled?: boolean; anime_override?: boolean | null } }) =>
      api.servers.updateLibrary(id, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['servers'] }),
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const scan = useMutation({
    mutationFn: (id: number) => api.servers.scanLibrary(id),
    onSuccess: () => notify('Library scan started', 'info'),
    onError: (error: Error) => notify(error.message, 'error'),
  })

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-medium text-ink">
            {server.name}
            {server.owned && (
              <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                Owner
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted">
            {server.platform ?? 'Plex Media Server'}
            {server.version ? ` · ${server.version}` : ''} · {server.base_url}
          </p>
        </div>
        <button
          type="button"
          onClick={() => test.mutate()}
          disabled={test.isPending}
          className="btn-ghost h-8 px-2.5 text-xs"
        >
          {test.isPending ? <Spinner /> : null}
          Test connection
        </button>
      </div>

      {server.libraries.length > 0 && (
        <ul className="mt-4 space-y-2">
          {server.libraries.map((library) => (
            <LibraryRow
              key={library.id}
              library={library}
              onToggleEnabled={(enabled) =>
                updateLibrary.mutate({ id: library.id, body: { enabled } })
              }
              onCycleAnime={() => {
                // Cycles auto → anime → not anime → auto.
                const next =
                  library.anime_override === null
                    ? true
                    : library.anime_override === true
                      ? false
                      : null
                updateLibrary.mutate({ id: library.id, body: { anime_override: next } })
              }}
              onScan={() => scan.mutate(library.id)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function LibraryRow({
  library,
  onToggleEnabled,
  onCycleAnime,
  onScan,
}: {
  library: Library
  onToggleEnabled: (enabled: boolean) => void
  onCycleAnime: () => void
  onScan: () => void
}) {
  const [busy, setBusy] = useState(false)
  const animeLabel =
    library.anime_override === null
      ? 'Anime: auto'
      : library.anime_override
        ? 'Anime: yes'
        : 'Anime: no'

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg bg-raised px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink">{library.title}</span>
        <span className="text-xs text-muted">
          {library.section_type === 'movie' ? 'Movies' : 'TV'} · {library.item_count} items
          {library.last_synced_at ? ` · scanned ${relativeTime(library.last_synced_at)}` : ''}
        </span>
      </span>

      <button
        type="button"
        onClick={onCycleAnime}
        className={cn('chip shrink-0', library.anime_override === true && 'chip-active')}
        title="Cycle between automatic detection, always anime, and never anime"
      >
        <SparkIcon className="text-[11px]" />
        {animeLabel}
      </button>

      <button
        type="button"
        onClick={() => {
          setBusy(true)
          onScan()
          window.setTimeout(() => setBusy(false), 1500)
        }}
        disabled={busy}
        className="chip shrink-0"
      >
        {busy ? <Spinner className="text-[11px]" /> : <RefreshIcon className="text-[11px]" />}
        Scan
      </button>

      <button
        type="button"
        onClick={() => onToggleEnabled(!library.enabled)}
        className={cn('chip shrink-0', library.enabled && 'chip-active')}
        aria-pressed={library.enabled}
      >
        <SettingsIcon className="text-[11px]" />
        {library.enabled ? 'Included' : 'Skipped'}
      </button>
    </li>
  )
}
