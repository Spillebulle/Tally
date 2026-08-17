/*
 * Wearing a custom theme.
 *
 * The server owns the `.umbertheme` format: it parses a file, fills what the
 * file left out from the theme's `base`, derives the five values `tokens.css`
 * states literally, and hands the browser a flat table of CSS custom property
 * names to opaque colours. See `docs/themes.md`. This module is the whole of
 * the client half: it puts that table on `document.documentElement.style` and
 * takes it off again.
 *
 * Two rules carry the design, and both are easy to undo by accident.
 *
 * **An element style beats every selector.** Writing the table onto the root
 * element's own `style` outranks `:root`, `:root.light` and every media query
 * in `tokens.css` and `theme-tally.css`, so neither of those files needs a
 * single line about custom themes, and neither needs re-syncing when one
 * arrives. That is the only reason this fits under a stylesheet that is a
 * verbatim copy of the house file.
 *
 * **A variable defined as a mix of other variables resolves where it is used,
 * not where it is written.** So `--accent-tint`, `--accent-ring`, `--grid`,
 * `--heat-1..5`, `--scrim` and `--critical-line` follow a custom accent and a
 * custom chrome on their own, without anybody computing them. They are
 * therefore never sent, and `DERIVED_VARIABLES` below refuses them if they
 * ever are: a second copy of a value the stylesheet already has right is a
 * copy that goes stale the next time the derivation changes.
 */

import type { ThemeBase, ThemeSummary } from './types'

/* ── Lightness ────────────────────────────────────────────────────────────
 *
 * A theme is dark because its `base` is, stated rather than measured off its
 * colours (STYLE-GUIDE §3.2). This matters more than it looks: `tokens.css`
 * carries values that are *not* among the twenty-seven and still differ by
 * theme, the three shadows most obviously, plus `color-scheme` and the
 * `--light` flag. So selecting a custom theme also stamps `dark` or `light`,
 * and a light theme wearing the dark shadows is exactly the kind of wrongness
 * that reads as "slightly off" and never gets diagnosed.
 */

/** `graphite` (dark) and `paper` (light) are the family's; every app ships both. */
export const THEME_BASES: readonly ThemeBase[] = ['graphite', 'paper']

/**
 * Dark or light, for a theme in the library.
 *
 * Reads the server's `dark` flag rather than mapping the base id here. An app
 * in the family may ship base ids Tally has never heard of, and §3.2 answers
 * an unknown one with `graphite`; a client doing that mapping itself would
 * read somebody else's light preset as dark and hang the wrong shadows on it.
 */
export function themeLightness(theme: ThemeSummary): 'dark' | 'light' {
  return theme.dark ? 'dark' : 'light'
}

/**
 * Dark or light, from a base id alone. The fallback, for the moment before the
 * library has answered. `graphite` is §3.2's own answer for an unknown id.
 */
export function baseLightness(base: string | null | undefined): 'dark' | 'light' {
  return base === 'paper' ? 'light' : 'dark'
}

/* ── What may be written ──────────────────────────────────────────────────*/

/**
 * The names that must never arrive, because the stylesheet already derives
 * them from the names that do. Listed in `docs/themes.md`.
 *
 * Refused rather than trusted. A server that starts sending `--heat-3` is a
 * server that has computed the ramp against the wrong `--chrome` at least
 * once, and the failure would be a heatmap that quietly stops matching its own
 * accent rather than anything that looks broken.
 */
const DERIVED_VARIABLES: ReadonlySet<string> = new Set([
  '--accent-tint',
  '--accent-ring',
  '--grid',
  '--heat-1',
  '--heat-2',
  '--heat-3',
  '--heat-4',
  '--heat-5',
  '--scrim',
  '--critical-line',
])

/**
 * A colour, conservatively.
 *
 * `#RRGGBB` is what the encoder writes, but the resolved table is derived
 * server-side and may reasonably answer in `oklch(...)`, `rgb(...)` or a
 * `color-mix(...)`, so the shape is checked rather than the syntax. What it
 * excludes is the point: no `:` (so no `url(http://…)` reaching out of the
 * page), no `;`, no braces and no quotes.
 */
const COLOUR_VALUE = /^[A-Za-z0-9#%,.()/ -]{1,64}$/

/* ── Applying ─────────────────────────────────────────────────────────────*/

/*
 * The names currently written, held at module scope rather than in a ref.
 *
 * Clearing has to be *precise*: `style` is a shared surface and wiping it
 * would take out anything else that has written there. It also has to survive
 * a provider remount, which React does on its own in development, so the list
 * cannot live inside the component that sets it.
 */
let applied: string[] = []

export interface ThemeApplication {
  /** How many variables were written. */
  count: number
  /** Names refused: a derived value, or a value that is not a plain colour. */
  refused: string[]
}

/**
 * Write a resolved theme onto the root element.
 *
 * Every previously applied name is removed first, so switching between two
 * custom themes cannot leave a variable from the first one behind. A refused
 * entry costs that one colour and nothing else, which is the same tolerance
 * §3.2 asks of the file reader: the stylesheet's own value stands.
 */
export function applyTheme(table: Record<string, unknown>): ThemeApplication {
  const style = document.documentElement.style
  const refused: string[] = []
  const next: string[] = []

  for (const name of applied) style.removeProperty(name)

  for (const [name, value] of Object.entries(table)) {
    // The contract is colours only, but a field that is not a custom property
    // is skipped silently rather than counted as a refusal: a payload growing
    // a describing field one day is not a theme that failed to apply.
    if (!name.startsWith('--')) continue
    if (DERIVED_VARIABLES.has(name) || typeof value !== 'string' || !COLOUR_VALUE.test(value)) {
      refused.push(name)
      continue
    }
    style.setProperty(name, value)
    next.push(name)
  }

  applied = next
  return { count: next.length, refused }
}

/** Remove every variable this module wrote, and nothing else. */
export function clearTheme(): void {
  const style = document.documentElement.style
  for (const name of applied) style.removeProperty(name)
  applied = []
}

/** The names currently written. Exported so a check can assert none are left. */
export function appliedThemeVariables(): readonly string[] {
  return applied
}

/* ── The local mirror, for the pre-paint script ───────────────────────────
 *
 * The selected theme is a server preference (`User.preferences["theme_id"]`)
 * and a resolved table is a fetch, neither of which exists before first paint.
 * So the *lightness* alone is mirrored into localStorage, which the inline
 * script in `index.html` reads to stamp the right class straight away. The
 * colours arrive a moment later and change no lightness when they do.
 *
 * The mirror is a hint and never authority: it is written only once the base
 * is known, corrected the moment the library answers, and dropped whenever the
 * server says there is no custom theme (or no longer has this one). A stale
 * entry can therefore cost one round trip of the wrong shadows, and cannot
 * strand the app in the wrong lightness.
 */

const CUSTOM_ID_KEY = 'tally.theme.id'
const CUSTOM_LIGHTNESS_KEY = 'tally.theme.base'

export interface StoredCustomTheme {
  id: string
  lightness: 'dark' | 'light'
}

export function readStoredCustomTheme(): StoredCustomTheme | null {
  try {
    const id = localStorage.getItem(CUSTOM_ID_KEY)
    if (!id) return null
    return { id, lightness: localStorage.getItem(CUSTOM_LIGHTNESS_KEY) === 'light' ? 'light' : 'dark' }
  } catch {
    // Private browsing and a blocked origin both throw on read. A theme is not
    // worth failing a page load over.
    return null
  }
}

export function writeStoredCustomTheme(id: string, lightness: 'dark' | 'light'): void {
  try {
    localStorage.setItem(CUSTOM_ID_KEY, id)
    localStorage.setItem(CUSTOM_LIGHTNESS_KEY, lightness)
  } catch {
    /* see above */
  }
}

export function clearStoredCustomTheme(): void {
  try {
    localStorage.removeItem(CUSTOM_ID_KEY)
    localStorage.removeItem(CUSTOM_LIGHTNESS_KEY)
  } catch {
    /* see above */
  }
}

/* ── The editor's table ───────────────────────────────────────────────────*/

/**
 * The twenty-seven stored keys, in file order.
 *
 * Which is also the order the editor draws them, so a file reads top to bottom
 * like the pane it came from (§3.2). `key` is the **stored word** and may never
 * be reworded; four of them deliberately differ from the CSS name, because the
 * file format is the family's and the CSS names are this project's.
 *
 * Exported for the theme editor on the settings page. Nothing here is used to
 * apply a theme: the server resolves and derives, and the browser is handed a
 * finished table.
 */
export interface ThemeKeyRow {
  /** The `.umbertheme` key. Stable for ever. */
  key: string
  /** The custom property it fills. */
  css: string
  /** The §2.1 group it is drawn under. */
  group: 'Surfaces' | 'Lines' | 'Controls' | 'Type' | 'Accent' | 'Warnings' | 'Link colours'
  /** Sentence case, for the row label. */
  label: string
}

export const THEME_KEYS: readonly ThemeKeyRow[] = [
  { key: 'backdrop', css: '--backdrop', group: 'Surfaces', label: 'Backdrop' },
  { key: 'window', css: '--window', group: 'Surfaces', label: 'Window' },
  { key: 'dock', css: '--dock', group: 'Surfaces', label: 'Dock' },
  { key: 'chrome', css: '--chrome', group: 'Surfaces', label: 'Chrome' },
  { key: 'popover', css: '--popover', group: 'Surfaces', label: 'Popover' },
  { key: 'border', css: '--line', group: 'Lines', label: 'Hairline' },
  { key: 'popover_border', css: '--line-popover', group: 'Lines', label: 'Popover edge' },
  { key: 'control', css: '--control', group: 'Controls', label: 'Control' },
  { key: 'control_hover', css: '--control-hover', group: 'Controls', label: 'Control, hovered' },
  { key: 'control_active', css: '--control-active', group: 'Controls', label: 'Control, active' },
  { key: 'rail', css: '--rail', group: 'Controls', label: 'Rail' },
  { key: 'knob', css: '--knob', group: 'Controls', label: 'Knob' },
  { key: 'text_strong', css: '--text-strong', group: 'Type', label: 'Strong text' },
  { key: 'text', css: '--text', group: 'Type', label: 'Body text' },
  { key: 'text_muted', css: '--text-muted', group: 'Type', label: 'Muted text' },
  { key: 'text_dim', css: '--text-dim', group: 'Type', label: 'Dim text' },
  { key: 'accent', css: '--accent', group: 'Accent', label: 'Accent' },
  { key: 'accent_dim', css: '--accent-dim', group: 'Accent', label: 'Accent, dim' },
  { key: 'warning', css: '--caution', group: 'Warnings', label: 'Caution' },
  { key: 'warning_bg', css: '--caution-bg', group: 'Warnings', label: 'Caution fill' },
  { key: 'warning_border', css: '--caution-line', group: 'Warnings', label: 'Caution edge' },
  { key: 'link_1', css: '--series-1', group: 'Link colours', label: 'Series one' },
  { key: 'link_2', css: '--series-2', group: 'Link colours', label: 'Series two' },
  { key: 'link_3', css: '--series-3', group: 'Link colours', label: 'Series three' },
  { key: 'link_4', css: '--series-4', group: 'Link colours', label: 'Series four' },
  { key: 'link_5', css: '--series-5', group: 'Link colours', label: 'Series five' },
  { key: 'link_6', css: '--series-6', group: 'Link colours', label: 'Series six' },
]

/** The library entry for an id, or null. A convenience for the settings page. */
export function findTheme(
  library: readonly ThemeSummary[] | undefined,
  id: string | null,
): ThemeSummary | null {
  if (!id || !library) return null
  return library.find((theme) => theme.id === id) ?? null
}
