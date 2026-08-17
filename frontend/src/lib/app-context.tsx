import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from './api'
import {
  applyTheme,
  clearStoredCustomTheme,
  clearTheme,
  findTheme,
  readStoredCustomTheme,
  themeLightness,
  writeStoredCustomTheme,
  type StoredCustomTheme,
} from './theme'
import type { ThemeSummary, User } from './types'

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

interface AuthValue {
  user: User | null
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.auth.me()
      } catch (error) {
        // 401 is the normal "signed out" state, not a failure worth retrying.
        if (error instanceof ApiError && error.status === 401) return null
        throw error
      }
    },
    retry: false,
    staleTime: 60_000,
  })

  /*
   * The account changed, so what belongs to an account has to be re-read.
   *
   * The theme is the one that shows. It is a server preference, and
   * `ThemeProvider` sits *above* `AuthProvider` in `main.tsx` - it has to,
   * because the theme is settled before anything else renders - so signing in
   * or out never re-renders it. Its three queries are the only thing that can
   * tell it the identity moved. Until they were told, signing in left the
   * account's own theme unworn until somebody reloaded the page, and signing
   * out left the previous account's theme on the login screen and on whoever
   * signed in next.
   *
   * Invalidated rather than reset: an invalidation refetches while keeping the
   * data it already has, so the settings pane reading the same cache does not
   * flash through a skeleton every time a preference is written.
   */
  const forgetAccount = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY }),
        queryClient.invalidateQueries({ queryKey: THEME_LIBRARY_KEY }),
        queryClient.invalidateQueries({ queryKey: THEME_RESOLVED_KEY }),
      ]),
    [queryClient],
  )

  // Both sign-in paths - the password form and the Plex PIN - land here.
  const refresh = useCallback(async () => {
    await refetch()
    await forgetAccount()
  }, [refetch, forgetAccount])

  const logout = useCallback(async () => {
    await api.auth.logout()
    await refetch()
    /*
     * Everything the account had, emptied where it stands. The three above are
     * part of it, and they are the reason this is not `queryClient.clear()`
     * any more: `clear()` destroys every query object while the providers
     * above the router stay mounted, which leaves their observers holding a
     * query the cache no longer has. Nothing re-renders them, and no later
     * invalidation can find them again - so the login screen went on wearing
     * the theme, and the next account to sign in wore it too, for good.
     * `resetQueries` empties a query in place and refetches the ones being
     * watched, so an observer follows and nothing is orphaned.
     */
    await queryClient.resetQueries()
  }, [queryClient, refetch])

  const value = useMemo<AuthValue>(
    () => ({ user: data ?? null, loading: isLoading, refresh, logout }),
    [data, isLoading, refresh, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export type Theme = 'light' | 'dark' | 'system'

/**
 * The theme in use, and the four ways to choose one.
 *
 * `theme`, `resolved` and `setTheme` mean exactly what they always did: the
 * three-state built-in preference, what the viewer is actually looking at, and
 * the setter. `themeId` is the fourth choice beside those three - a theme the
 * user made, which is a *server* preference because it belongs to the account
 * and not to the browser.
 *
 * Picking one of the three drops the custom one and picking a custom one
 * overrides the three, because a theme's `base` decides whether it is dark or
 * light. See `docs/themes.md`.
 */
interface ThemeValue {
  /** The built-in preference. Unchanged: dark, light, or follow the system. */
  theme: Theme
  /** What is on screen, custom themes included. Live while `theme` is 'system'. */
  resolved: 'light' | 'dark'
  /** Pick a built-in. Also clears any custom theme, since there are four choices. */
  setTheme: (theme: Theme) => void
  /** The custom theme in use, or null when one of the three built-in choices is. */
  themeId: string | null
  /** Select a custom theme, or null for the built-in named by `theme`. */
  setThemeId: (id: string | null) => void
  /** A custom theme is chosen and its colours have not arrived yet. */
  themeLoading: boolean
  /**
   * The resolved theme could not be fetched. The built-in is what is on
   * screen; `themeId` still names what the user asked for, so a settings page
   * can keep it selected and say why it is not showing.
   */
  themeError: Error | null
}

const ThemeContext = createContext<ThemeValue | null>(null)
const THEME_KEY = 'tally.theme'

/**
 * The query keys the theme provider reads. Share them.
 *
 * The provider holds the selected theme in `['preferences']` - the same cache
 * the settings page writes - so selecting a theme moves both at once. An
 * editor that changes a colour must invalidate `themeResolvedKey(id)`, or the
 * page keeps wearing the table it fetched before the edit.
 *
 * All three belong to an *account*, so `AuthProvider` invalidates them
 * whenever the identity moves. They are exported for that as much as for the
 * settings page.
 */
export const PREFERENCES_KEY = ['preferences'] as const
export const THEME_LIBRARY_KEY = ['themes'] as const
/** Every resolved table, whichever theme: the prefix `themeResolvedKey` extends. */
export const THEME_RESOLVED_KEY = ['theme-resolved'] as const
export const themeResolvedKey = (id: string | null) => [...THEME_RESOLVED_KEY, id] as const

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/*
 * Three states, and the third one stamps nothing.
 *
 * `tokens.css` reads dark from a bare `:root`, forced light from `.light`, and
 * lets `prefers-color-scheme` decide when neither class is present. So
 * "system" is the *absence* of a class, not a class of its own, and the
 * pre-paint script in index.html does exactly the same thing. The two have to
 * agree or the first paint flashes the other theme.
 *
 * `resolved` is what the user is actually looking at. It is kept live while
 * the preference is "system" so a control can label itself correctly the
 * moment the operating system flips at dusk.
 *
 * A custom theme is the fourth choice and sits *over* all three: its `base`
 * decides its lightness, so choosing one stamps `dark` or `light` whatever the
 * preference says. It has to, because `tokens.css` carries values outside the
 * twenty-seven a theme file stores - the three shadows, `color-scheme`, the
 * `--light` flag - and those still differ by theme. A light theme left without
 * the class wears the dark theme's shadows: wrong, and quietly so.
 *
 * The colours themselves are a fetch and cannot exist before first paint, so
 * only the *lightness* is mirrored into localStorage for the pre-paint script
 * to read. Everything else about that mirror is in `lib/theme.ts`.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()

  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark'
  })
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    theme === 'system' ? systemTheme() : theme,
  )

  // What the pre-paint script stamped, read once at mount. `hint` then tracks
  // the best answer available at any moment: the mirror at boot, the base of a
  // theme just picked, and the confirmed base once the server has answered.
  const [mirror] = useState(readStoredCustomTheme)
  const [hint, setHint] = useState<StoredCustomTheme | null>(mirror)

  const preferences = useQuery({
    queryKey: PREFERENCES_KEY,
    queryFn: async () => {
      try {
        return await api.settings.preferences()
      } catch (error) {
        /*
         * Signed out is the ordinary state on the login screen, not a failure.
         * A custom theme belongs to an account, so there is simply not one,
         * and an error card behind a sign-in form would be a lie.
         *
         * It stays a success, which means it is cached and stale-timed like
         * one. That is only safe because `AuthProvider` invalidates this key
         * the moment the identity moves; without that, this empty answer
         * outlived the sign-in that disproved it and the account's theme
         * never arrived. Do not lengthen `staleTime` here, or swallow
         * anything else into a success, without checking that it is.
         */
        if (error instanceof ApiError && error.status === 401) return {}
        throw error
      }
    },
    retry: false,
    staleTime: 60_000,
  })

  /*
   * The mirror is authority for one round trip and no longer.
   *
   * Once the server has answered at all - with a theme, with none, or with a
   * failure - the answer stands. Without this, `logout()` clears the query
   * cache and the stale mirror would put the signed-out user's own theme back
   * on the login screen; and a preferences request that fails outright would
   * leave the app stamping a lightness whose colours it can never fetch.
   */
  const [booting, setBooting] = useState(true)
  useEffect(() => {
    if (preferences.data !== undefined || preferences.isError) setBooting(false)
  }, [preferences.data, preferences.isError])

  const storedThemeId = preferences.data?.theme_id
  const storedId = typeof storedThemeId === 'string' && storedThemeId ? storedThemeId : null
  const themeId = booting ? (mirror?.id ?? null) : storedId

  // Only fetched when there is a custom theme to describe. The settings page
  // shares this key, so opening the picker fills it for everyone.
  const library = useQuery({
    queryKey: THEME_LIBRARY_KEY,
    queryFn: api.themes.list,
    enabled: themeId !== null,
    staleTime: 60_000,
  })

  const resolvedTheme = useQuery({
    queryKey: themeResolvedKey(themeId),
    queryFn: () => api.themes.resolved(themeId as string),
    enabled: themeId !== null,
    staleTime: 60_000,
  })

  const customTheme = themeId ? findTheme(library.data, themeId) : null
  const themeError = themeId !== null && resolvedTheme.isError ? resolvedTheme.error : null

  /*
   * The theme was deleted while it was being worn.
   *
   * Deleting one clears `preferences["theme_id"]` on the server, but nothing
   * makes this browser re-read that preference, so without a check of its own
   * the page goes on wearing a table for a theme that no longer exists - and
   * `staleTime` means the 404 that would catch it may not be asked for until
   * the next reload. The library is the complete list of what this account
   * has, built-ins included, so an id absent from a *loaded* library is an id
   * that is gone.
   *
   * Quiet, unlike a failed fetch. A deleted theme is something somebody did on
   * purpose, with its own confirmation on the settings page; a fetch that fell
   * over is not, and is the one that has to speak up.
   */
  const themeMissing = themeId !== null && library.isSuccess && customTheme === null

  // A failed request is not an empty theme: half a table would leave some
  // surfaces custom and the rest built-in, which looks like a rendering bug
  // rather than a fetch that did not land.
  const table =
    themeError || themeMissing ? null : themeId ? (resolvedTheme.data ?? null) : null

  /*
   * The lightness of the custom theme in use, or null when a built-in is.
   *
   * The library row answers it: the resolved table is colours and nothing
   * else, deliberately, so the two requests are asked for at once. Until the
   * row lands, the hint holds whatever is already stamped, so choosing a theme
   * or reloading the page does not flash through the other lightness on the
   * way to the right one.
   */
  const customLightness: 'dark' | 'light' | null =
    themeError || themeMissing || !themeId
      ? null
      : customTheme
        ? themeLightness(customTheme)
        : hint?.id === themeId
          ? hint.lightness
          : null

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('dark', 'light')

    if (customLightness) {
      root.classList.add(customLightness)
      setResolved(customLightness)
      return
    }

    // 'system' stamps nothing at all, so prefers-color-scheme decides.
    if (theme === 'dark' || theme === 'light') {
      root.classList.add(theme)
      setResolved(theme)
      return
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => setResolved(media.matches ? 'dark' : 'light')
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme, customLightness])

  // The table itself. `applyTheme` writes onto the root element's own style,
  // which outranks every selector in tokens.css and theme-tally.css, and
  // `clearTheme` removes exactly the names it wrote and nothing else.
  useEffect(() => {
    if (!table) {
      clearTheme()
      return
    }
    const { refused } = applyTheme(table)
    if (refused.length > 0) {
      console.warn(
        `Theme "${themeId}": ignored ${refused.length} variable(s). A value the ` +
          'stylesheet derives must not be sent, and a value must be a plain ' +
          `colour: ${refused.join(', ')}`,
      )
    }
  }, [table, themeId])

  // Keep the pre-paint mirror honest: write it once the base is confirmed,
  // and drop it the moment the account has no custom theme.
  useEffect(() => {
    if (themeId && customLightness) {
      writeStoredCustomTheme(themeId, customLightness)
      setHint((current) =>
        current?.id === themeId && current.lightness === customLightness
          ? current
          : { id: themeId, lightness: customLightness },
      )
    } else if (themeMissing || (!themeId && !booting)) {
      clearStoredCustomTheme()
      setHint(null)
    }
  }, [themeId, customLightness, booting, themeMissing])

  /*
   * A theme that is gone: ask the server what the preference is now.
   *
   * Deleting one clears `theme_id` server-side, so re-reading the preference
   * is enough to stop naming a theme that no longer exists - and it is the
   * *server's* answer rather than a write of our own, which could race a
   * choice made in another tab. Stopping wearing it already happened above;
   * this only tidies up what `themeId` still says.
   */
  useEffect(() => {
    if (themeMissing) void queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY })
  }, [themeMissing, queryClient])

  /*
   * Say so when the theme cannot be fetched, and only then.
   *
   * Nothing else on screen changes when this fails - the built-in is a
   * complete, correct interface - so a silent failure reads as a theme that
   * simply does not work. Reported once per (theme, message) so a refetch loop
   * cannot stack toasts.
   *
   * A 404 is not that. It is a theme somebody deleted, which `docs/themes.md`
   * says is noticed quietly, and `themeMissing` above already handles it the
   * moment the library lands. When the library is the slower of the two, the
   * 404 arrives first, and toasting it raised a card that never goes away -
   * an error toast has no timeout - reading "could not be loaded. No such
   * theme", which is both untrue and the server's own words rather than the
   * user's (STYLE-GUIDE section 12). So the 404 branch only tidies the
   * mirror, which is what it always did.
   */
  const reported = useRef<string | null>(null)
  useEffect(() => {
    if (!themeError || !themeId) {
      if (!themeError) reported.current = null
      return
    }
    if (themeError instanceof ApiError && themeError.status === 404) {
      // A theme the server no longer has must not go on stamping its lightness
      // through the pre-paint script on every reload.
      reported.current = null
      clearStoredCustomTheme()
      setHint(null)
      return
    }
    const signature = `${themeId}:${themeError.message}`
    if (reported.current === signature) return
    reported.current = signature
    notifyDetached(
      `Your theme could not be loaded, so Tally is showing the built-in one. ${themeError.message}`,
      'error',
    )
  }, [themeError, themeId])

  // Read inside callbacks that must not take a dependency on either.
  const resolvedRef = useRef(resolved)
  resolvedRef.current = resolved
  const themeIdRef = useRef(themeId)
  themeIdRef.current = themeId

  const setThemeId = useCallback(
    (id: string | null) => {
      const previous = queryClient.getQueryData<Record<string, unknown>>(PREFERENCES_KEY)

      // The whole interface changes colour on this click, so it changes now
      // rather than after a PUT and a refetch. The settings page reads the
      // same cache, so its card moves in the same frame.
      queryClient.setQueryData<Record<string, unknown>>(PREFERENCES_KEY, (old) => ({
        ...(old ?? {}),
        theme_id: id,
      }))
      setBooting(false)

      if (id === null) {
        clearStoredCustomTheme()
        setHint(null)
      } else {
        // A theme is picked from the library, so its base is known before its
        // colours are and the class need not flash through the other
        // lightness. Falling back to what is already on screen is the same
        // idea when it is not: hold still, and correct once the server answers.
        const known = findTheme(queryClient.getQueryData<ThemeSummary[]>(THEME_LIBRARY_KEY), id)
        const lightness = known ? themeLightness(known) : resolvedRef.current
        setHint({ id, lightness })
        writeStoredCustomTheme(id, lightness)
      }

      void api.settings
        .updatePreferences({ theme_id: id })
        .then((saved) => queryClient.setQueryData(PREFERENCES_KEY, saved))
        .catch((error: Error) => {
          // Put the real preference back; the optimistic one was a guess that
          // lost. The effects above follow it and undo the mirror with it.
          queryClient.setQueryData(PREFERENCES_KEY, previous)
          notifyDetached(`Your theme could not be saved. ${error.message}`, 'error')
        })
    },
    [queryClient],
  )

  const setTheme = useCallback(
    (next: Theme) => {
      localStorage.setItem(THEME_KEY, next)
      setThemeState(next)
      // Four choices, not three plus a modifier: picking a built-in drops the
      // custom theme. Skipped when there is none, so the ordinary dark/light
      // toggle still writes nothing to the server.
      if (themeIdRef.current !== null) setThemeId(null)
    },
    [setThemeId],
  )

  const themeLoading =
    themeId !== null && table === null && themeError === null && !themeMissing

  const value = useMemo(
    () => ({
      theme,
      resolved,
      setTheme,
      themeId,
      setThemeId,
      themeLoading,
      themeError,
    }),
    [theme, resolved, setTheme, themeId, setThemeId, themeLoading, themeError],
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used inside ThemeProvider')
  return context
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'success' | 'error'
}

interface ToastValue {
  toasts: Toast[]
  notify: (message: string, tone?: Toast['tone']) => void
  dismiss: (id: number) => void
  dismissAll: () => void
}

const ToastContext = createContext<ToastValue | null>(null)

/*
 * Six seconds, except for an error.
 *
 * A toast that reports something going wrong is the only record the user has
 * of it, and it is exactly the one they are least likely to be looking at when
 * it appears. So an error stays until it is dismissed (STYLE-GUIDE section
 * 7.17); everything else is a receipt for something the user just did and can
 * leave on its own.
 */
const TOAST_MS = 6000

/*
 * A way to raise a toast from outside the toast tree.
 *
 * `ThemeProvider` sits *above* `ToastProvider` in `main.tsx`, because the
 * theme has to be settled before anything renders, so it cannot call
 * `useToast`. It still has one thing to say - that a theme could not be
 * fetched or could not be saved - and a failure nobody is told about is
 * indistinguishable from a theme that simply does not work.
 *
 * Deliberately the only escape hatch of its shape, and deliberately a
 * no-op before the provider mounts: a toast is a receipt for something that
 * has already happened, and there is no queue here to replay one into.
 */
let detachedNotify: ((message: string, tone?: Toast['tone']) => void) | null = null

export function notifyDetached(message: string, tone: Toast['tone'] = 'info'): void {
  detachedNotify?.(message, tone)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const dismissAll = useCallback(() => setToasts([]), [])

  const notify = useCallback(
    (message: string, tone: Toast['tone'] = 'info') => {
      const id = Date.now() + Math.random()
      setToasts((current) => [...current, { id, message, tone }])
      if (tone !== 'error') window.setTimeout(() => dismiss(id), TOAST_MS)
    },
    [dismiss],
  )

  useEffect(() => {
    detachedNotify = notify
    return () => {
      detachedNotify = null
    }
  }, [notify])

  const value = useMemo(
    () => ({ toasts, notify, dismiss, dismissAll }),
    [toasts, notify, dismiss, dismissAll],
  )
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

export function useToast(): ToastValue {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside ToastProvider')
  return context
}
