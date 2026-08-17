# Themes

*Dated 17 August 2026. Settles how Tally reads, writes and applies a
`.umbertheme` file, so a theme made in Umber opens here and one made here opens
in Umber.*

The format is `../../Design-Principles/STYLE-GUIDE.md` §3.2 and this page does
not restate it. What follows is only what §3.2 leaves to the app: where the
library lives when the app is hosted rather than on a desktop, what the API
looks like, and how a theme reaches the browser.

## The three decisions

**The library is per user.** §3.2 puts the files "under the user's data
directory". On a desktop that is per user by definition; here it is
`$DATA_DIR/themes/<user_id>/`. A household Tally has several accounts and a
shared directory would let one of them delete another's work, which is the same
reasoning that keeps `UserServerAccess` per user while `PlexServer` is global.
The files stay ordinary files somebody can hand to somebody else.

**A theme's `base` decides whether it is dark or light, and selecting one
overrides the light/dark preference.** It has to: `tokens.css` carries a
handful of values that are *not* in the twenty-seven and differ by theme, the
shadows most obviously. So applying a custom theme also stamps
`class="dark"` or `class="light"` to match its base, and the three-state
preference (dark / light / follow the system) governs the **built-ins** only.
A custom theme is a fourth choice beside those three, not a modifier of them.

**Parsing, encoding and derivation happen on the server.** The library's rules
are file-system rules — atomic writes, an id that is the filename stem, a cap
on how many are read back — so the files' owner owns the format too. The
browser receives a resolved table and applies it. One decoder, one encoder, and
no second implementation to drift.

## What the browser is given, and what it does with it

`GET /api/themes/{id}/resolved` returns a flat object of **CSS custom property
names to opaque colours**: the twenty-seven mapped to their token names, plus
the five derived values that `tokens.css` states literally rather than as a
`color-mix`:

| Derived | From |
|---|---|
| `--line-soft` | `border` 40 % of the way to `window` |
| `--line-dashed` | `border` 30 % of the way to `text-dim` |
| `--placeholder` | `text-dim` 30 % of the way to `window` |
| `--field` | `dock` in a dark theme, `popover` in a light one |
| `--accent-ink` | `window` in a dark theme, `popover` in a light one |

Everything else already derives itself and **must not be sent**:
`--accent-tint` and `--accent-ring` are `color-mix` over `--accent`; `--grid`
is `--line-soft`; Tally's own `--heat-1..5` are `color-mix` over `--accent` and
`--chrome`; `--scrim` is `color-mix` over `--backdrop` or `--text-strong`; and
`--critical-line` is `color-mix` over `--critical`. A CSS variable that is
defined as a mix of other variables resolves where it is *used*, so every one
of these follows a custom theme without being computed for it. Sending them
would create a second, stale copy of a value the stylesheet already has right.

`--good` and `--critical` (and their `-bg`) are **not themeable** per §3.2, and
`--area-alpha` is a constant, so they are not sent either.

The client applies the table to `document.documentElement.style`, which is an
element style and therefore beats every selector in `tokens.css` and
`theme-tally.css` without either file needing to know custom themes exist. It
stamps the base's class in the same breath, and clears both when a built-in is
chosen.

## The API

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/themes` | The user's library: id, name, base, and whether it is a built-in. |
| `GET` | `/api/themes/{id}` | One theme as its twenty-seven stored keys, for the editor. |
| `GET` | `/api/themes/{id}/resolved` | The table above, for applying. |
| `POST` | `/api/themes` | Copy a theme (built-in or not) under a new name. The only way to make one. |
| `PATCH` | `/api/themes/{id}` | Rename, or write one or more of the twenty-seven. |
| `DELETE` | `/api/themes/{id}` | Remove the file. |
| `POST` | `/api/themes/import` | Upload a `.umbertheme`. Answers with the theme **and the count of lines that could not be read**. |
| `GET` | `/api/themes/{id}/export` | The file, `text/plain`, as `<id>.umbertheme`. |

Two things the endpoints must not do. **A built-in is read-only**: `graphite`
and `paper` are compiled in, are never written to the library directory, and
answer a write with a 409 and a sentence rather than a silent no-op, because
§9 asks a setting that cannot be changed to say so. And **import reports what
it lost**: the response carries the skipped-line count so the interface can say
"N lines could not be read, so those colours came from the theme it names as
its base", which §3.2 requires and which a 200 with no detail would swallow.

The selected theme is a user preference like any other:
`User.preferences["theme_id"]`, absent meaning a built-in and the existing
dark / light / system preference deciding which.

## Testing

The format's rules are mostly refusals, and refusals are the half that rots
quietly, so they are the half to test: a file whose first line is not
`Umber theme`; a byte-order mark in front of it; `#RGB`, `RRGGBB` and `#RRGGBB`
all accepted and `#RRGGBBAA` refused; a key this build does not know; an
unparseable line costing exactly one colour; `base` read before the colours
whatever order the lines are in; an unknown `base` falling back to `graphite`;
a name of 300 characters cut to 64; a name that is only control characters
falling back to the file stem and then to `Untitled theme`; a second theme of
the same name getting a number rather than replacing one; and a round trip
proving that what is written parses back identically.

The one test that proves the point of the whole exercise: **a file written by
Tally must satisfy §3.2's reader rules exactly** — the header line, the
twenty-seven keys in the documented order, every key present, `#RRGGBB` and no
alpha.
