# Interface

*Dated 17 August 2026. Settles how Tally's interface is built after the move to
the house design language. Supersedes the Inter / rounded-card / elevation look
that shipped up to 0.3.0.*

Tally follows `../../Design-Principles/STYLE-GUIDE.md`. That document is the
rule book and is not repeated here. This page settles the things that are
Tally's own: which token file is authoritative, what the Tailwind names are,
which painted controls already exist, and the four or five traps that cost time
if you meet them by surprise.

## What is authoritative

| File | What it is |
|---|---|
| `frontend/src/tokens.css` | A **verbatim copy** of `Design-Principles/tokens.css`. Re-sync with a plain `cp`. Never edit it here; an edit is lost the next time the house file moves. |
| `frontend/src/theme-tally.css` | Everything Tally decides: `--accent-h`, the pinned accent, the Plex yellow, the heat ramp, the `@font-face`. |
| `frontend/tailwind.config.js` | Names for those tokens. Every value in it is a `var(--token)`. |
| `frontend/src/index.css` | The painted controls, as component classes. |
| `frontend/scripts/check-design.mjs` | The rules a type checker cannot see. `npm run check:design`. |

## The accent

`--accent-h: 255`, a steel blue, which is the hue the guide itself suggests for
Tally. The lightness and chroma are **pinned** rather than taken from the house
formula, so the dark accent is exactly `#3987E5`, the blue Tally has always
used:

| | Dark | Light |
|---|---|---|
| `--accent` | `oklch(0.622 0.161 255)` = `#3987E5` | `oklch(0.52 0.14 255)` = `#2769B7` |
| `--accent-dim` | `oklch(0.447 0.097 255)` | `oklch(0.79 0.05 255)` |

This is the one deliberate deviation from the house colour recipe, and it was
checked rather than assumed: accent on `chrome` is 4.88:1 dark and 5.09:1
light, on `control` 4.48:1 and 4.49:1, and `accent-ink` on accent 5.15:1 and
5.54:1. All clear the floors in the guide's §2.6. Everything else accent
coloured still derives from `--accent`, so changing the hue still moves the
whole app.

**Where the accent goes** is the guide's §2.4 and it is a closed list. The short
version, because this is the rule the old interface broke most: a selected row,
tab, nav item or card gets a **neutral** `control` fill and `text-strong`, plus
a small accent mark (a 3 px bar, a dot, a 2 px border). Never an accent
background.

## Tailwind names

Colours are roles. The old names are gone and `check:design` fails on them.

| Old | New | Token |
|---|---|---|
| `bg-canvas` | `bg-backdrop` | the page ground |
| `bg-surface` | `bg-chrome` | cards, strips, panel headers |
| `bg-raised` | `bg-control` | resting control, **selected row** |
| — | `bg-window` | a page's own ground, panel interiors |
| — | `bg-dock` | the sidebar column, chips, fields |
| — | `bg-popover` | menus, tooltips |
| `text-ink` | `text-strong` | titles, selected labels, figures |
| `text-subtle` | `text-fg` | body |
| `text-muted` | `text-muted` | unselected nav, secondary |
| — | `text-dim` | status, notes, captions |
| — | `text-placeholder` | input hints, eyebrows |
| `border-line` | `border-line` | *the* hairline |
| — | `border-line-soft` | separators inside a list |
| — | `border-line-popover` | menu and dialog edges |
| — | `border-line-dashed` | dashed marks |
| `text-warn` | `text-caution` | look at this, not an alarm |
| `text-danger` | `text-critical` | down, failed, destructive |
| `bg-accent-soft` | `bg-accent-tint` | 7 % accent wash |
| `border-line-accent` | *(gone)* | selection is neutral now |
| `bg-heat-0..4` | `bg-heat-1..5` | zero is `bg-control`, not a heat step |

Sizes have names too: `h-menubar` (34), `h-toolbar` (36), `h-status` (26),
`h-panelhead` (32), `h-row` (26), `h-row-plain` (20), `h-button` (26),
`h-bottomnav` (52), `w-sidebar` (240), `w-panel` (264), `p-strip` (12).

Type: `text-page` 15, `text-heading` 13, `text-body` 12, `text-control` 11.5,
`text-small` 11, `text-tiny` 10.5, `text-eyebrow` 10 (tracked 2 px, uppercase),
`text-display` 64 (the wordmark, nowhere else). Radii: `rounded-tight` 3,
`rounded-ctl` 5, `rounded-tool` 6, `rounded-card` 8, `rounded-modal` 10, plus
`rounded-full` for dots and the toggle pill. Shadows: `shadow-menu`,
`shadow-float`, `shadow-modal`, `shadow-knob`, and **nothing else casts one**.

## The controls that already exist

In `index.css`, so a page composes rather than restyles: `.card`, `.panel`,
`.panel-head`, `.panel-title`, `.panel-body`, `.well`, `.btn` with
`-primary` / `-secondary` / `-outline` / `-ghost` / `-danger` / `.btn-icon`,
`.field`, `.chip`, `.chip-removable`, `.badge` with `-good` / `-caution` /
`-critical`, `.keycap`, `.row`, `.row-selected`, `.nav-row`,
`.nav-row-selected`, `.menu`, `.menu-item`, `.menu-item-selected`,
`.menu-separator`, `.tooltip`, `.dialog`, `.floating`, `.notice`, `.dashed`,
`.eyebrow`, `.figure`, `.skeleton`, `.scroll-x`, `.full-bleed`, `.hero-scrim`.

If a component needs something that is not there, **add the class here** rather
than assembling it inline at one call site. The test is whether a second page
would want the same thing; almost always it would.

## Icons

`lucide-react`, and nothing else. It is the construction the guide names
(single-weight stroke, round caps), it tree-shakes per icon, and it removes the
hand-drawn set that had to be extended every time a page needed a glyph.

Sizes are 16 in rows and buttons, 20 in panel headers, 24 in empty states, and
never larger. Colour is `text-muted` at rest, `text-strong` on hover or when
selected, and `accent` only for the active bar-nav item. An icon with no label
carries a `title`. Brand marks (Plex, GitHub, Docker) are solid paths and stay
in `components/Icons.tsx`, which is the only thing that file still holds.

**Never a Unicode glyph as an icon.** Archivo has none of them and they render
as a box or as somebody else's emoji font.

## Traps

**An unknown utility fails silently.** Tailwind emits nothing for
`rounded-2xl` or `text-sm` now that those scales are replaced, so a stale class
does not break the build - it just stops styling the element. `npm run
check:design` is the only thing that catches it.

**An opacity modifier on a token colour emits nothing.** `bg-accent/25`,
`border-critical/40`, `text-strong/60`: all of them produce no CSS at all,
because the colour is a `var(--accent)` and Tailwind cannot compose alpha into
a variable it cannot parse. Use a token that already carries the alpha
(`accent-tint`, `accent-ring`, `caution-bg`, `good-bg`, `critical-bg`) or add
one with `color-mix` in `theme-tally.css`.

**There are three theme states, not two.** Dark is bare `:root`; forced light is
`.light` / `[data-theme="light"]`; following the system is **nothing stamped at
all**, so `prefers-color-scheme` decides. A token written in only one of the two
light blocks breaks the other state. Components never read the class.

**A translucent 1 px border on a rounded element renders jagged.** The fill is
painted under the border and the ring blended on top, so the two coverages
disagree along the caps. This is a second reason selection is a neutral fill
rather than a tinted edge.

**Never key or parse a local date through `toISOString()` or
`new Date('YYYY-MM-DD')`.** Both convert via UTC and are off by a day east of
Greenwich. `localDateKey()` and `parseLocalDateLabel()` in `lib/utils.ts`.

## Copy

British spelling. Sentence case labels, never Title Case, never ALL CAPS except
an eyebrow. Sentences with full stops in notes, tooltips and empty states.
**No em dashes in anything a user reads** - `check:design` fails on one.
Numbers get units. A disabled control explains itself in a `title`.

## Verifying

```sh
cd frontend && npm run check:design   # the rules tsc cannot see
cd frontend && npx tsc --noEmit       # types
cd frontend && npm run build          # the real build
```

Building is not looking. A change to a screen is verified by rendering it in
both themes and reading the picture, which is how the three interface bugs in
`CLAUDE.md` were found. `docs/shots.py` drives a seeded instance with a
headless browser for exactly that.

## What this does not settle

- Whether Tally offers its users an accent picker. The tokens would support it
  (`--accent-h` is the only number), but nothing in the interface exposes it yet.
- The desktop-style document tab strip. Tally has no multi-document surface, so
  §7.3 goes unused.
