import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth, useTheme, useToast, type Theme } from '@/lib/app-context'
import type { ApiKeyCreated, Library, Server } from '@/lib/types'
import { cn, formatDateTime, relativeTime } from '@/lib/utils'
import { EmptyState, PageHeader, Segmented, Spinner, Toggle } from '@/components/ui'
import { SyncProgress, syncLabel } from '@/components/Layout'
import {
  CheckIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  SparkIcon,
} from '@/components/Icons'

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
      // The Continue Watching window is a preference, so both the settings
      // payload that reports it and the shelf itself are now stale.
      queryClient.invalidateQueries({ queryKey: ['app-settings'] })
      queryClient.invalidateQueries({ queryKey: ['continue-watching'] })
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

  const cancelSync = useMutation({
    mutationFn: api.sync.cancel,
    onSuccess: () => {
      notify('Stopping after the current step', 'info')
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
          <div className="flex items-center gap-2">
            {syncStatus.data?.running && (
              <button
                type="button"
                onClick={() => cancelSync.mutate()}
                disabled={cancelSync.isPending || syncStatus.data.cancel_requested}
                className="btn-ghost h-9 text-sm"
              >
                {syncStatus.data.cancel_requested ? 'Stopping…' : 'Cancel'}
              </button>
            )}
            <button
              type="button"
              onClick={() => fullSync.mutate()}
              disabled={fullSync.isPending || syncStatus.data?.running}
              className="btn-outline h-9 text-sm"
              title={syncLabel(syncStatus.data, fullSync.isPending)}
            >
              {fullSync.isPending || syncStatus.data?.running ? (
                <Spinner />
              ) : (
                <RefreshIcon />
              )}
              Full re-import
            </button>
          </div>
        }
      >
        {/* From the click, not from the poll that confirms it — see SyncProgress. */}
        {(syncStatus.data?.running || fullSync.isPending) && (
          <div className="mb-4 rounded-xl border border-line p-3">
            <p className="text-xs font-medium text-ink">
              {syncStatus.data?.running
                ? (syncStatus.data.phase ?? 'Syncing')
                : 'Starting sync'}
            </p>
            <SyncProgress
              status={syncStatus.data?.running ? syncStatus.data : undefined}
            />
          </div>
        )}
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

      {/* --- Continue Watching ------------------------------------------ */}
      <Section
        title="Continue Watching"
        description="How long a half-finished film or a show you stopped mid-season keeps its place on the dashboard."
      >
        <ContinueWatchingWindow
          value={
            typeof prefs.continue_watching_weeks === 'number'
              ? prefs.continue_watching_weeks
              : null
          }
          plexWeeks={settings.data?.plex_on_deck_weeks ?? null}
          effectiveWeeks={settings.data?.continue_watching_weeks ?? null}
          onChange={(weeks) => updatePreference.mutate({ continue_watching_weeks: weeks })}
        />
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
            {reclassify.isPending ? <Spinner /> : <SparkIcon />} Re-detect
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

      {/* --- API keys --------------------------------------------------- */}
      <Section
        title="API keys"
        description="For scripts and integrations. A key acts as this account, so treat it like a password."
      >
        <ApiKeys />
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

function ApiKeys() {
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const [name, setName] = useState('')
  // The plaintext exists only in this response. Once it leaves the screen it is
  // gone for good, so it is held here until the user dismisses it deliberately.
  const [issued, setIssued] = useState<ApiKeyCreated | null>(null)

  const keys = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys.list })

  const create = useMutation({
    mutationFn: (value: string) => api.apiKeys.create(value),
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
      notify('Key revoked', 'info')
      queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    },
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const active = (keys.data ?? []).filter((key) => !key.revoked_at)

  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (name.trim()) create.mutate(name.trim())
        }}
        className="flex gap-2"
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="What is this key for? e.g. Home Assistant"
          aria-label="New API key name"
          className="input"
        />
        <button
          type="submit"
          disabled={create.isPending || !name.trim()}
          className="btn-primary shrink-0"
        >
          {create.isPending ? <Spinner /> : <PlusIcon />}
          Create
        </button>
      </form>

      {issued && (
        <div className="mt-3 rounded-xl border border-accent/40 bg-accent-soft p-3">
          <p className="text-sm font-medium text-ink">
            Copy this now — it is not shown again
          </p>
          <div className="mt-2 flex gap-2">
            <input
              readOnly
              value={issued.key}
              className="input font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(issued.key)
                notify('API key copied', 'success')
              }}
              className="btn-outline shrink-0"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => setIssued(null)}
              className="btn-ghost shrink-0"
            >
              Done
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Only its fingerprint is stored, so Tally cannot show it to you again.
          </p>
        </div>
      )}

      {keys.isLoading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted">
          <Spinner /> Loading keys…
        </p>
      ) : (keys.data ?? []).length === 0 ? (
        <p className="mt-4 text-sm text-muted">
          No keys yet. Create one to use the API from a script or another app.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {(keys.data ?? []).map((key) => (
            <li
              key={key.id}
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-xl border border-line p-3',
                key.revoked_at && 'opacity-60',
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">
                  {key.name}
                  {key.revoked_at && (
                    <span className="ml-2 rounded-md bg-raised px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                      Revoked
                    </span>
                  )}
                </p>
                <p className="font-mono text-xs text-muted">{key.prefix}…</p>
                <p className="mt-0.5 text-xs text-muted">
                  Created {formatDateTime(key.created_at)} ·{' '}
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
                  className="btn-outline h-8 shrink-0 px-2.5 text-xs"
                >
                  {revoke.isPending && revoke.variables === key.id ? (
                    <Spinner />
                  ) : null}
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs text-muted">
        Send it as <code className="font-mono">X-API-Key</code> or{' '}
        <code className="font-mono">Authorization: Bearer</code>. Every endpoint
        under <code className="font-mono">/api</code> accepts it, and{' '}
        <a href="/api/docs" className="text-accent hover:underline">
          the API docs
        </a>{' '}
        list them all.
        {active.length > 0 &&
          ' Revoking takes effect immediately, on every integration using that key.'}
      </p>
    </div>
  )
}

/** Weeks offered as an explicit override, alongside "follow Plex" and "never". */
const WINDOW_CHOICES = [2, 4, 8, 16, 26, 52]

const weekLabel = (weeks: number) => `${weeks} ${weeks === 1 ? 'week' : 'weeks'}`

function plexSummary(plexWeeks: number | null) {
  if (plexWeeks === null) {
    return 'Plex has not told Tally its own setting yet — only the server owner can read it, and it arrives with the next sync. Until then Tally uses Plex’s default of 16 weeks.'
  }
  if (plexWeeks === 0) {
    return 'Plex has On Deck switched off entirely (0 weeks). Tally reads that as no cut-off rather than an empty shelf.'
  }
  return `Plex’s “Weeks to consider for On Deck and Continue Watching” is set to ${weekLabel(plexWeeks)}.`
}

function inForceSummary(effectiveWeeks: number | null) {
  if (effectiveWeeks === null) return ''
  if (effectiveWeeks === 0) return 'Nothing is being hidden.'
  return `Anything you have not touched in ${weekLabel(effectiveWeeks)} drops off the shelf — it stays in your library and history.`
}

function ContinueWatchingWindow({
  value,
  plexWeeks,
  effectiveWeeks,
  onChange,
}: {
  /** null = follow the Plex server, 0 = never hide anything. */
  value: number | null
  plexWeeks: number | null
  effectiveWeeks: number | null
  onChange: (weeks: number | null) => void
}) {
  return (
    <div>
      <label htmlFor="cw-window" className="label">
        Drop off after
      </label>
      <select
        id="cw-window"
        className="input mt-1.5"
        value={value === null ? 'plex' : String(value)}
        onChange={(event) =>
          onChange(event.target.value === 'plex' ? null : Number(event.target.value))
        }
      >
        <option value="plex">
          Match Plex{plexWeeks !== null ? ` — ${plexWeeks} weeks` : ''}
        </option>
        {WINDOW_CHOICES.map((weeks) => (
          <option key={weeks} value={weeks}>
            {weeks} weeks
          </option>
        ))}
        <option value="0">Never — keep everything</option>
      </select>
      <p className="mt-2 text-xs text-muted">
        {plexSummary(plexWeeks)} {inForceSummary(effectiveWeeks)}
      </p>
    </div>
  )
}

type LibraryPatch = { enabled?: boolean; anime_override?: boolean | null }

function ServerCard({ server }: { server: Server }) {
  const queryClient = useQueryClient()
  const { notify } = useToast()

  const [urlDraft, setUrlDraft] = useState(server.manual_url ?? '')

  const test = useMutation({
    mutationFn: () => api.servers.test(server.id),
    onSuccess: (result) =>
      notify(
        result.reachable ? `${server.name} is reachable` : `${server.name} is not responding`,
        result.reachable ? 'success' : 'error',
      ),
    onError: (error: Error) => notify(error.message, 'error'),
  })

  const saveUrl = useMutation({
    mutationFn: (manual_url: string | null) => api.servers.update(server.id, { manual_url }),
    onSuccess: (updated) => {
      notify(
        updated.manual_url
          ? `Using ${updated.manual_url}`
          : 'Back to auto-detecting the address',
        'success',
      )
      // The previous result describes the old address, so drop it rather than
      // leaving a stale green or red tick next to a URL that just changed.
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
    // for the round trip left the chip showing its old value with no feedback,
    // so it read as an unresponsive button.
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
            {server.manual_url ? ' · set manually' : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => test.mutate()}
          disabled={test.isPending}
          className={cn(
            'btn-ghost h-8 gap-1.5 px-2.5 text-xs',
            // Never colour alone: the label and the dot carry the result too,
            // so it still reads for anyone who cannot separate the two hues.
            reachable === true && 'border-good text-good',
            reachable === false && 'border-danger text-danger',
          )}
        >
          {test.isPending ? (
            <Spinner />
          ) : reachable === null ? null : (
            <span
              aria-hidden="true"
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                reachable ? 'bg-good' : 'bg-danger',
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
      </div>

      <div className="mt-3 border-t border-line pt-3">
        <label
          htmlFor={`server-url-${server.id}`}
          className="text-xs font-medium text-ink"
        >
          Server address
        </label>
        <p className="mt-0.5 text-xs text-muted">
          Leave empty to let Plex advertise its own addresses. Set it if
          auto-detection picks a route that cannot be reached — a Plex server in
          Docker advertises its host's internal addresses too.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            id={`server-url-${server.id}`}
            type="url"
            inputMode="url"
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder={server.base_url}
            className="input h-8 min-w-0 flex-1 text-xs"
          />
          <button
            type="button"
            onClick={() => saveUrl.mutate(urlDraft.trim() || null)}
            disabled={saveUrl.isPending || urlDraft.trim() === (server.manual_url ?? '')}
            className="btn-ghost h-8 px-2.5 text-xs"
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
              className="btn-ghost h-8 px-2.5 text-xs"
            >
              Auto-detect
            </button>
          )}
        </div>
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
