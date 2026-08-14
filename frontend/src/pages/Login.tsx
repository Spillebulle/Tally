import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { PlexIcon } from '@/components/Icons'
import { Spinner } from '@/components/ui'

type Mode = 'choose' | 'local'

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
            popup.current?.close()
            await refresh()
            navigate('/', { replace: true })
          } else if (result.status === 'expired') {
            if (pollTimer.current) window.clearInterval(pollTimer.current)
            setPlexPending(false)
            setError('That sign-in request expired. Please try again.')
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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas px-4">
      {/* Ambient background — two soft accent washes, no imagery to load. */}
      <div
        className="pointer-events-none absolute -left-40 -top-40 h-[32rem] w-[32rem] rounded-full
                   bg-accent/20 blur-[120px]"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-40 -right-32 h-[28rem] w-[28rem] rounded-full
                   bg-plex/15 blur-[120px]"
        aria-hidden="true"
      />

      <div className="relative w-full max-w-md animate-fade-up">
        <div className="mb-8 flex flex-col items-center text-center">
          <span
            className="grid h-14 w-14 place-items-center rounded-2xl bg-accent text-accent-ink shadow-glow"
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M6 6v12M10 6v12M14 6v12M18 6v12M4.5 8l15 8" />
            </svg>
          </span>
          <h1 className="mt-5 text-3xl font-semibold tracking-tight text-ink">Tally</h1>
          <p className="mt-2 text-balance text-sm text-muted">
            Every film, series and anime you have watched — kept in step with your Plex server.
          </p>
        </div>

        <div className="card p-6">
          {mode === 'choose' ? (
            <div className="space-y-4">
              <button
                type="button"
                onClick={startPlexLogin}
                disabled={plexPending}
                className="btn w-full gap-2.5 bg-plex py-3 text-[15px] font-semibold text-black
                           hover:brightness-105 active:scale-[0.99]"
              >
                {plexPending ? (
                  <>
                    <Spinner className="text-lg" />
                    Waiting for Plex…
                  </>
                ) : (
                  <>
                    <PlexIcon className="text-lg" />
                    Continue with Plex
                  </>
                )}
              </button>

              {plexPending && (
                <p className="text-center text-xs text-muted">
                  Approve the request in the Plex window, then come back here.
                  <br />
                  <button
                    type="button"
                    className="mt-1 underline hover:text-ink"
                    onClick={() => {
                      setPlexPending(false)
                      if (pollTimer.current) window.clearInterval(pollTimer.current)
                    }}
                  >
                    Cancel
                  </button>
                </p>
              )}

              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-line" />
                <span className="text-xs uppercase tracking-wider text-muted">or</span>
                <span className="h-px flex-1 bg-line" />
              </div>

              <button
                type="button"
                onClick={() => setMode('local')}
                className="btn-outline w-full py-2.5"
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
            <p
              className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-muted">
          Tally never sees your Plex password — sign-in happens on plex.tv.
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
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="username" className="label">
          Username
        </label>
        <input
          id="username"
          className="input mt-1.5"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          required
        />
      </div>
      <div>
        <label htmlFor="password" className="label">
          Password
        </label>
        <input
          id="password"
          type="password"
          className="input mt-1.5"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          minLength={isRegister ? 8 : undefined}
          required
        />
        {isRegister && (
          <p className="mt-1.5 text-xs text-muted">At least 8 characters.</p>
        )}
      </div>

      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy} className={cn('btn-primary w-full py-2.5')}>
        {busy && <Spinner />}
        {isRegister ? 'Create account' : 'Sign in'}
      </button>

      <div className="flex items-center justify-between text-xs">
        <button type="button" onClick={onBack} className="text-muted hover:text-ink">
          ← Back
        </button>
        {!setupRequired && (
          <button
            type="button"
            onClick={() => setIsRegister((value) => !value)}
            className="text-muted hover:text-ink"
          >
            {isRegister ? 'I already have an account' : 'Create an account'}
          </button>
        )}
      </div>
    </form>
  )
}
