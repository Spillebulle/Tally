/**
 * Brand marks only.
 *
 * Interface icons are `lucide-react`, imported at the call site (16 in rows
 * and buttons, 20 in panel headers, 24 in empty states; `text-muted` at rest,
 * `text-strong` on hover or selection). The three marks below are logos, not
 * icons: they are solid paths, and redrawing them as 1.5px strokes would just
 * make them wrong. They are the only drawings this file still owns.
 */
import type { ComponentType, SVGProps } from 'react'
import {
  BarChart3,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Film,
  Heart,
  Home,
  LogOut,
  Menu,
  Moon,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Star,
  Sun,
  TriangleAlert,
  Tv,
  X,
  type LucideProps,
} from 'lucide-react'

type IconProps = SVGProps<SVGSVGElement>

/* ── Brand marks ─────────────────────────────────────────────────────────── */

export const GitHubIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48l-.01-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85l-.01 2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
  </svg>
)

export const DockerIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M13.98 11.08h2.12a.19.19 0 0 0 .19-.19V9.01a.19.19 0 0 0-.19-.19h-2.12a.18.18 0 0 0-.18.18v1.9c0 .1.08.18.18.18m-2.95-5.43h2.12a.19.19 0 0 0 .18-.19V3.58a.19.19 0 0 0-.18-.19h-2.12a.18.18 0 0 0-.19.19v1.88c0 .1.09.19.19.19m0 2.71h2.12a.19.19 0 0 0 .18-.18v-1.9a.19.19 0 0 0-.18-.18h-2.12a.18.18 0 0 0-.19.18v1.9c0 .1.09.18.19.18m-2.93 0h2.12a.19.19 0 0 0 .18-.18v-1.9a.18.18 0 0 0-.18-.18H8.1a.18.18 0 0 0-.18.18v1.9c0 .1.08.18.18.18m-2.96 0h2.11a.19.19 0 0 0 .19-.18v-1.9a.18.18 0 0 0-.19-.18H5.14a.19.19 0 0 0-.19.18v1.9c0 .1.08.18.19.18m5.89 2.72h2.12a.19.19 0 0 0 .18-.18V9.01a.19.19 0 0 0-.18-.19h-2.12a.18.18 0 0 0-.19.18v1.9c0 .1.09.18.19.18m-2.93 0h2.12a.18.18 0 0 0 .18-.18V9.01a.18.18 0 0 0-.18-.19H8.1a.18.18 0 0 0-.18.18v1.9c0 .1.08.18.18.18m-2.96 0h2.11a.18.18 0 0 0 .19-.18V9.01a.18.18 0 0 0-.18-.19H5.14a.19.19 0 0 0-.19.19v1.88c0 .1.08.19.19.19m-2.92 0h2.11a.18.18 0 0 0 .19-.18V9.01a.18.18 0 0 0-.19-.19H2.22a.18.18 0 0 0-.18.18v1.9c0 .1.08.18.18.18M23.76 9.8c-.06-.05-.67-.51-1.95-.51-.34 0-.68.03-1.01.09a3.77 3.77 0 0 0-1.72-2.57l-.34-.2-.23.33a4.6 4.6 0 0 0-.6 1.42c-.24.96-.1 1.87.4 2.65a4.7 4.7 0 0 1-1.74.42H.5a.5.5 0 0 0-.5.5 7.6 7.6 0 0 0 .46 2.68 4.02 4.02 0 0 0 1.6 2.08c.7.4 1.83.62 3.1.62.58 0 1.15-.05 1.72-.15a11.8 11.8 0 0 0 6.85-3.65 15.7 15.7 0 0 0 2.86-4.62h.25c1.37 0 2.21-.55 2.68-1.01.31-.3.55-.65.71-1.05l.1-.29-.57-.17Z" />
  </svg>
)

/** Plex's chevron mark, used only beside the Plex brand. */
export const PlexIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M7.2 2h4.35l5.25 10-5.25 10H7.2l5.25-10L7.2 2z" />
  </svg>
)

/* ── Compatibility shim ──────────────────────────────────────────────────── */
/*
 * The old hand-drawn set, mapped onto Lucide so pages that still import
 * `HomeIcon` and friends keep working while they are rewritten. The old icons
 * were sized `1em` and coloured by the text around them, so the shim keeps
 * that default; pass `className="size-icon"` explicitly in new code instead.
 *
 * This block is temporary: once every page imports from `lucide-react`
 * directly, delete everything below this line.
 */

function em(Icon: ComponentType<LucideProps>) {
  return function EmSizedIcon(props: LucideProps) {
    return <Icon size="1em" aria-hidden="true" {...props} />
  }
}

export const HomeIcon = em(Home)
export const FilmIcon = em(Film)
export const TvIcon = em(Tv)
export const SparkIcon = em(Sparkles)
export const ClockIcon = em(Clock)
export const BookmarkIcon = em(Bookmark)
export const ChartIcon = em(BarChart3)
export const SettingsIcon = em(Settings)
export const SearchIcon = em(Search)
export const PlayIcon = em(Play)
export const CheckIcon = em(Check)
export const PlusIcon = em(Plus)
export const XIcon = em(X)
export const WarningIcon = em(TriangleAlert)
export const RefreshIcon = em(RefreshCw)
export const ChevronLeftIcon = em(ChevronLeft)
export const ChevronRightIcon = em(ChevronRight)
export const SunIcon = em(Sun)
export const MoonIcon = em(Moon)
export const MenuIcon = em(Menu)
export const LogOutIcon = em(LogOut)

/** `filled` fills the glyph with the current colour; the outline stays. */
export const StarIcon = ({
  filled,
  half: _half,
  ...p
}: LucideProps & { filled?: boolean; half?: boolean }) => (
  <Star size="1em" aria-hidden="true" fill={filled ? 'currentColor' : 'none'} {...p} />
)

export const HeartIcon = ({ filled, ...p }: LucideProps & { filled?: boolean }) => (
  <Heart size="1em" aria-hidden="true" fill={filled ? 'currentColor' : 'none'} {...p} />
)
