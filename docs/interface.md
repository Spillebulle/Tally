# Interface

*Dated 18 August 2026. Settles how Tally's interface is built after the move to
the house design language. Supersedes the Inter / rounded-card / elevation look
that shipped up to 0.3.0. Revised for the guide's web scale (6.5) and artwork
ladder (7.21).*

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

Sizes have names too, and **every one of them is the token, never the number** -
that is what carries the scale below. `h-menubar`, `h-toolbar`, `h-status`,
`h-panelhead`, `h-row`, `h-row-plain`, `h-nav`, `h-button`, `h-field`,
`h-dropdown`, `h-bottomnav`, `w-sidebar`, `w-panel`, `p-strip`, `w-mark`,
`size-icon`, `size-icon-lg`.

Type: `text-page`, `text-heading`, `text-body`, `text-control`, `text-small`,
`text-tiny`, `text-eyebrow` (10 px, tracked 2 px, uppercase, and the one size
that does not move), `text-display` (64, the wordmark, nowhere else). Radii:
`rounded-tight` 3, `rounded-ctl`, `rounded-tool`, `rounded-card`,
`rounded-modal`, `rounded-art`, plus `rounded-full` for dots and the toggle
pill. Shadows: `shadow-menu`, `shadow-float`, `shadow-modal`, `shadow-knob`,
and **nothing else casts one**.

## Tally is at the web scale

`<html class="web">`, stamped in `index.html` and nowhere else, which makes
`tokens.css` swap one table of sizes for another (the guide's 6.5). Tally is
read in a browser tab rather than at arm's length in a desktop tool, so the
things you aim at grow about a quarter, the top bar grows by half because it is
the one place the app says its name, and text grows least - a 125 % button with
100 % text looks empty and 125 % prose reads as a document.

| | Desktop | Tally |
|---|---|---|
| Top bar / mark | 34 / 15 | **52 / 22** |
| Button, field | 26 | **32** |
| Nav row, list row | 30 / 26 | **38 / 32** |
| Toolbar, panel header | 36 / 32 | **44 / 40** |
| Icon in a row or button | 16 | **18** |
| Body / control text | 12 / 11.5 | **14 / 13** |
| Sidebar | 240 | **280** |
| Padding inside a strip | 12 | **16** |

What the step never touches: the colour ladder and both themes, the 1 px
hairline, the dashed mark, the 4 and 8 px fine grid, the shadows, the 80/160 ms
motion, the four text ranks, and every rule about where the accent goes.

Three rules come with it:

- **A component never reads the class.** It asks for `h-button`. A rule saying
  `.web .thing { … }` is a token that is missing.
- **Mobile is not a third scale.** A narrow viewport changes the *shell* - the
  sidebar becomes a drawer, a row wraps - never the sizes.
- **The class is in the markup, not in a script.** It is not a preference and
  it never changes, and anything stamping it at runtime would paint one frame
  at the desktop size first.

## Artwork is on a ladder

A poster, a still, a face: not an icon, not decoration, and on most of Tally's
pages it *is* the interface. Four widths and no fifth (the guide's 7.21), plus
the avatar. Tally's numbers are the web column:

| Token | Width | Where in Tally |
|---|---|---|
| `w-art-row` | 48 | A picture inline in a list row. Landscape where there is one; Tally has none, so History's diary spends it on **height** and gets a 32 x 48 poster |
| `w-art-tile` | 120 | A picture beside text: Continue watching, the Discover picker, the hero on a phone |
| `w-art-card` | 180 | The browse card. Every grid and every rail |
| `w-art-hero` | 320 | The item page's poster. One per page |
| `h-avatar w-avatar` | 36 | A cast face, round |

Shape is `aspect-art` (portrait 2/3, from `--art-ratio`) or `aspect-wide`
(16/9). Never a literal `aspect-[2/3]`; `check:design` fails on one.

- **The same kind of thing is one size across a page**, and two rails may
  differ by one rung at most. `.poster-grid` in `index.css` is the single
  definition of the card grid for exactly this reason: the watchlist kept its
  own copy and drifted off the ladder while the browse pages moved.
- **Which rung a card grid uses is the reader's**, through the poster-size
  control on the browse and watchlist toolbars: compact, standard or large,
  which are `--art-tile`, `--art-card` and `--art-hero`. Three *rungs*, not
  three numbers - a size control picks among the sanctioned sizes rather than
  inventing a fifth, and the page is still drawn at exactly one of them. It is
  remembered in `localStorage` and deliberately not in the URL, because it
  changes nothing about which rows you are looking at; `lib/card-size.tsx` has
  the whole argument. The grid's floor is clamped to under half its container,
  which is what stops the standard size becoming one window-wide poster on a
  phone - and the reason the control hides itself below `sm`, where all three
  sizes resolve to the two columns there is room for.
- **A picture in a row gets the row's rung, and the row is sized by it.** The
  History diary and the Stats leaderboards carried posters at 14 x 20 and
  24 x 36 - three rungs under the bottom of the ladder and, in the guide's
  words about faces, a smudge doing no work. The lesson is not "no picture", it
  is `--art-row`: 48, the one width meant to sit inline in a list. With no
  landscape still to spend it on, History's row spends it on height and comes
  out 32 x 48, which grows the row from `h-row` (32) to 48 - a picture is never
  squeezed into a row built for text. The Stats leaderboards still carry none,
  because those rows are ranked *figures* and a picture would be decoration in
  a column of numbers.
- **A picture that cannot have a rung still does not appear.** Below about
  500px a calendar cell is 48px wide, so `MonthCalendar` drops the artwork and
  keeps the number and the count. Same rule, other direction.
- **A seven-column grid is capped, not reflowed.** `.month-grid` is the one
  grid that cannot choose its column count, so the width has to give instead:
  it is capped at seven `--art-tile` columns plus their gaps, which is what
  stops a wide page stretching a `1fr` track into a fifth width nobody
  sanctioned. Everything else uses `.poster-grid`, which reflows.
- **An episode is drawn as its series.** `displayArtwork` prefers
  `show_poster_url`, the same judgement `displayTitle` makes one line above it:
  an episode's own artwork on Plex is the still from that episode, a 16:9 frame
  a portrait card can only centre-crop. The field is only filled where an
  endpoint loaded the parent row, so elsewhere nothing changes.
- **The art card carries its label on the art**, never in a caption strip
  underneath. `.art-card` and `.art-label` in `index.css` own the whole
  behaviour, including that the label is *visible by default* and hidden only
  where a pointer can reveal it: the name of a thing is never something you can
  get only by hovering, so a touch screen and `prefers-reduced-motion` both
  keep it and keyboard focus does exactly what hover does.
- **A missing picture names itself.** `Artwork` draws the title on the
  placeholder *under* the image, so artwork covers it the instant it arrives.
  On a fresh instance with no TMDB key and no Plex artwork that is every card
  on the page, and without it a grid of gradients is anonymous.
- Text on artwork is `text-art` / `text-art-dim` on `bg-scrim-flat` or
  `.scrim-art`. These are white and black in **both** themes: a picture
  supplies its own contrast and a pale scrim over it erases the picture rather
  than the text. It is the one place the light theme does not lighten.
- A backdrop joins the page over a long ramp - `.fade-backdrop`, transparent
  for its first 46 % and reaching the ground only at the bottom edge (7.22).
  Legibility is a separate job and a separate scrim; never a steeper fade.

## The controls that already exist

In `index.css`, so a page composes rather than restyles: `.card`, `.panel`,
`.panel-head`, `.panel-title`, `.panel-body`, `.well`, `.btn` with
`-primary` / `-secondary` / `-outline` / `-ghost` / `-danger` / `.btn-icon`,
`.field`, `.chip`, `.chip-removable`, `.badge` with `-good` / `-caution` /
`-critical`, `.keycap`, `.row`, `.row-selected`, `.nav-row`,
`.nav-row-selected`, `.menu`, `.menu-item`, `.menu-item-selected`,
`.menu-separator`, `.tooltip`, `.dialog`, `.floating`, `.notice`, `.dashed`,
`.eyebrow`, `.figure`, `.skeleton`, `.scroll-x`, `.full-bleed`, and the artwork
set: `.art`, `.art-card`, `.art-label`, `.art-placeholder`, `.poster-grid`,
`.scrim-art`, `.fade-backdrop`. (`.hero-scrim` is gone; `check:design` fails on it.)

If a component needs something that is not there, **add the class here** rather
than assembling it inline at one call site. The test is whether a second page
would want the same thing; almost always it would.

## Icons

`lucide-react`, and nothing else. It is the construction the guide names
(single-weight stroke, round caps), it tree-shakes per icon, and it removes the
hand-drawn set that had to be extended every time a page needed a glyph.

Sizes come from `size-icon` (18 here, 16 on a desktop app) in rows and buttons
and `size-icon-lg` in a panel header, never from lucide's `size` prop, which
would pin an icon to one scale while everything round it took the step. 24 in
an empty state, and never larger; a mark set *inside* a line of text (11, 12)
is sized to that text and stays a number. Colour is `text-muted` at rest, `text-strong` on hover or when
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

**A `1fr` grid track floors at its item's min-content, and `.panel` clips.**
`1fr` is `minmax(auto, 1fr)`, and that `auto` is the item's min-content - which
for a `truncate`d span is the whole nowrap string, because `truncate` only
shrinks a *flex* item. So a row grew past its column, `.panel`'s
`overflow-hidden` ate the difference, and the mark-as-watched button on
Continue watching simply was not there below about 420 px, with no scrollbar to
say so. `min-w-0` on the grid item is the fix. It is worth scanning for after
any size change: an element wider than its nearest `overflow-x: hidden`
ancestor is content nobody can reach.

**Never key or parse a local date through `toISOString()` or
`new Date('YYYY-MM-DD')`.** Both convert via UTC and are off by a day east of
Greenwich. `localDateKey()` and `parseLocalDateLabel()` in `lib/utils.ts`.

**A name may be in the type scale or in the text palette, never in both.**
`control` was in each - 11.5 px in `fontSize`, the resting control fill in
`colors` - so `text-control` emitted a size *and* a colour, colour last. All
forty-five call sites meant the size, and the label it painted the control grey
on a chrome card was invisible until somebody read the pixels rather than the
markup. `tailwind.config.js` now states `textColor` as a closed set: the four
ranks of ink, the hint, the accent, the semantic three, the brand inks, the
series, and `line-dashed` for an empty state's icon. A surface is not a colour
text may be.

**`pointer-events-none` on a disabled control hides the tooltip that explains
it.** §7.6 promises a disabled control says why it is disabled, and `.btn`
carried `disabled:pointer-events-none`, so nine explanations on the settings
page alone could never be seen. A disabled `<button>` receives `mouseover`
perfectly well when its pointer events are left alone, and the `disabled`
attribute is what refuses the click, so the rule is: **never take pointer
events off a control that has something to say.** Every button variant's hover
is gated on `enabled:` instead, because a hoverable disabled control would
otherwise light up as though it were live. Something that cannot take a real
`disabled` attribute states its reason on a wrapping element.

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
