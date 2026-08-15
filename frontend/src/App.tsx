import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from '@/lib/app-context'
import { Layout } from '@/components/Layout'
import { Spinner } from '@/components/ui'
import { Browse } from '@/pages/Browse'
import { Dashboard } from '@/pages/Dashboard'
import { History } from '@/pages/History'
import { ItemDetail } from '@/pages/ItemDetail'
import { Login } from '@/pages/Login'
import { Settings } from '@/pages/Settings'
import { Stats } from '@/pages/Stats'
import { Watchlist } from '@/pages/Watchlist'

function FullPageSpinner() {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas">
      <Spinner className="text-3xl text-accent" />
      <span className="sr-only">Loading</span>
    </div>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) return <FullPageSpinner />
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />
  return <>{children}</>
}

/**
 * Plex redirects the popup here after sign-in. The opener is already polling
 * the PIN, so this page only needs to close itself.
 */
function PlexCallback() {
  useEffect(() => {
    // This has to be an effect. A <script> rendered through JSX is injected as
    // innerHTML, and the HTML spec says scripts inserted that way never
    // execute — so the popup used to sit here until the opener killed it.
    const timer = window.setTimeout(() => window.close(), 600)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-6 text-center">
      <div>
        <Spinner className="mx-auto text-2xl text-accent" />
        <p className="mt-4 text-sm text-muted">
          Signed in with Plex. You can close this window.
        </p>
      </div>
    </div>
  )
}

export function App() {
  const { user, loading } = useAuth()

  if (loading) return <FullPageSpinner />

  return (
    <Routes>
      <Route path="/auth/callback" element={<PlexCallback />} />
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />

      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/movies" element={<Browse mode="movies" />} />
        <Route path="/shows" element={<Browse mode="shows" />} />
        <Route path="/anime" element={<Browse mode="anime" />} />
        <Route path="/search" element={<Browse mode="search" />} />
        {/* Everything, filtered by query string — where the stats charts link. */}
        <Route path="/browse" element={<Browse mode="browse" />} />
        <Route path="/item/:id" element={<ItemDetail />} />
        <Route path="/watchlist" element={<Watchlist />} />
        <Route path="/history" element={<History />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
