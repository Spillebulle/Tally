import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/app-context'
import { Mark, Wordmark } from '@/components/Brand'
import { PlexIcon } from '@/components/Icons'
import { Notice, Spinner } from '@/components/ui'

type Mode = 'choose' | 'local'

/**
 * The one screen that wears the full logo.
 *
 * §17.4: the mark alone lives in the top bar, and the mark with the wordmark
 * belongs to the splash and the about box. This is the splash.
 */
function Splash() {
  return (
    <div className="flex flex-col items-center text-center">
      <Mark size={44} decorative />
      <Wordmark className="mt-3 block leading-none" />
      <p className="mt-3 text-balance text-body text-muted">
        Every film, series and anime you have watched, kept in step with your Plex server.
      </p>
    </div>
  )
}

export function Login() {
  const navigate = useNavigate()
  const { refresh } = useAuth()
  const [mode, setMode] = useState<Mode>('choose')
  const [plexPending, setPlexPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollTimer = useRef<number | null>(null)
  const popup = useRef<Window | null>(null)

  const { data: status } = useQuery({
    queryKey: ['auth-status'],
    queryFn: api.auth.status,
  })

  useEffect(
    () => () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current)
    },
    [],
  )

  const startPlexLogin = async () => {
    setError(null)
    setPlexPending(true)
    try {
      const start = await api.auth.plexStart()
      // Open the popup before awaiting anything else would be ideal, but Plex
      // needs the PIN first; browsers still allow this because the click is
      // what started the chain.
      popup.current = window.open(
        start.auth_url,
        'plex-auth',
        'width=760,height=760,menubar=no,toolbar=no',
      )

      pollTimer.current = window.setInterval(async () => {
        try {
          const result = await api.auth.plexPoll(start.state)
          if (result.status === 'authenticated') {
            if (pollTimer.current) window.clearInterval(pollTimer.current)
            // Plex is redirecting the popup to /auth/callback at this moment,
            // and that page closes itself. Closing it from here right away
            // aborts the navigation mid-flight, which shows a browser error in
            // the popup before it disappears. Let the redirect land, then force
            // it shut in case it never does.
            const opened = popup.current
            popup.current = null
            window.setTimeout(() => {
              try {
                opened?.close()
              } catch {
                // Already gone, or it closed itself. Nothing to do.
              }
            }, 2000)
            await refresh()
            navigate('/', { replace: true })
          } else if (result.status === 'expired') {
            if (pollTimer.current) window.clearInterval(pollTimer.current)
            setPlexPending(false)
            setError('That sign-in request expired. Start it again from this page.')
          }
        } catch (pollError) {
          if (pollTimer.current) window.clearInterval(pollTimer.current)
          setPlexPending(false)
          setError((pollError as Error).message)
        }
      }, 2000)
    } catch (startError) {
      setPlexPending(false)
      setError((startError as Error).message)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-backdrop px-strip py-8">
      <div className="w-full max-w-[360px] motion-safe:animate-rise">
        <Splash />

        <div className="card mt-6 p-4">
          {mode === 'choose' ? (
            <div className="space-y-3">
              {/* The one primary action on this view. Plex's own yellow stays
                  on its badge and nowhere else, so the button itself is the
                  house primary rather than a slab of another product's brand. */}
              <button
                type="button"
                onClick={startPlexLogin}
                disabled={plexPending}
                className="btn-primary w-full"
              >
                {plexPending ? (
                  <Spinner />
                ) : (
                  <span
                    aria-hidden="true"
                    className="grid h-4 w-4 place-items-center rounded-tight bg-plex text-plex-ink"
                  >
                    <PlexIcon width={10} height={10} />
                  </span>
                )}
                {plexPending ? 'Waiting for Plex…' : 'Continue with Plex'}
              </button>

              {plexPending && (
                <div className="flex flex-col items-center gap-1">
                  <p className="text-balance text-center text-tiny text-dim">
                    Approve the request in the Plex window, then come back here.
                  </p>
                  <button
                    type="button"
                    className="btn-ghost h-5 px-2 text-tiny"
                    onClick={() => {
                      setPlexPending(false)
                      if (pollTimer.current) window.clearInterval(pollTimer.current)
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}

              <div className="flex items-center gap-2">
                <span className="h-px flex-1 bg-line" />
                <span className="eyebrow">or</span>
                <span className="h-px flex-1 bg-line" />
              </div>

              <button
                type="button"
                onClick={() => setMode('local')}
                className="btn-secondary w-full"
              >
                {status?.setup_required ? 'Create the first account' : 'Sign in with a password'}
              </button>
            </div>
          ) : (
            <LocalForm
              setupRequired={Boolean(status?.setup_required)}
              onBack={() => setMode('choose')}
              onDone={async () => {
                await refresh()
                navigate('/', { replace: true })
              }}
            />
          )}

          {error && (
            <div role="alert">
              <Notice className="mt-3">{error}</Notice>
            </div>
          )}
        </div>

        {/* True, and the reassurance a self-hosted user is looking for. */}
        <p className="mt-4 text-balance text-center text-tiny text-dim">
          Tally never sees your Plex password. Signing in happens on plex.tv.
        </p>
      </div>
    </div>
  )
}

function LocalForm({
  setupRequired,
  onBack,
  onDone,
}: {
  setupRequired: boolean
  onBack: () => void
  onDone: () => Promise<void>
}) {
  const [isRegister, setIsRegister] = useState(setupRequired)
  // `useState` seeds once. If the user opened this form before
  // `api.auth.status` resolved, a fresh install showed "Sign in" rather than
  // "Create account" — with no account to sign into. Follow the answer when it
  // lands, unless they have already chosen the other mode themselves.
  const [seededFrom, setSeededFrom] = useState(setupRequired)
  if (seededFrom !== setupRequired) {
    setSeededFrom(setupRequired)
    setIsRegister(setupRequired)
  }
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (isRegister) {
        await api.auth.register(username, password)
      } else {
        await api.auth.login(username, password)
      }
      await onDone()
    } catch (submitError) {
      setError((submitError as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label htmlFor="username" className="mb-1 block text-control text-fg">
          Username
        </label>
        <input
          id="username"
          className="field"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          required
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-1 block text-control text-fg">
          Password
        </label>
        <input
          id="password"
          type="password"
          className="field"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          minLength={isRegister ? 8 : undefined}
          required
        />
        {isRegister && <p className="mt-1 text-tiny text-dim">At least 8 characters.</p>}
      </div>

      {error && (
        <div role="alert">
          <Notice>
            {error}
            {!isRegister && ' Check the username and password, then try again.'}
          </Notice>
        </div>
      )}

      <button type="submit" disabled={busy} className="btn-primary w-full">
        {busy && <Spinner />}
        {isRegister ? 'Create account' : 'Sign in'}
      </button>

      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onBack} className="btn-ghost h-5 px-1 text-tiny">
          <ChevronLeft size={16} aria-hidden="true" />
          Back
        </button>
        {!setupRequired && (
          <button
            type="button"
            onClick={() => setIsRegister((value) => !value)}
            className="btn-ghost h-5 px-1 text-tiny"
          >
            {isRegister ? 'I already have an account' : 'Create an account'}
          </button>
        )}
      </div>
    </form>
  )
}
