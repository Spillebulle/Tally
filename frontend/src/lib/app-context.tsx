import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from './api'
import type { User } from './types'

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

  const refresh = useCallback(async () => {
    await refetch()
  }, [refetch])

  const logout = useCallback(async () => {
    await api.auth.logout()
    queryClient.clear()
    await refetch()
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

interface ThemeValue {
  theme: Theme
  resolved: 'light' | 'dark'
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)
const THEME_KEY = 'tally.theme'

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
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark'
  })
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    theme === 'system' ? systemTheme() : theme,
  )

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('dark', 'light')
    // 'system' stamps nothing at all, so prefers-color-scheme decides.
    if (theme === 'dark' || theme === 'light') root.classList.add(theme)

    if (theme !== 'system') {
      setResolved(theme)
      return
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => setResolved(media.matches ? 'dark' : 'light')
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(THEME_KEY, next)
    setThemeState(next)
  }, [])

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme])
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
