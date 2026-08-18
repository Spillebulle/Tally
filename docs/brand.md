# Brand

*Dated 17 August 2026. Settles what the Tally mark is, where its assets live
and how they are regenerated.*

The mark is a rounded square (corner radius 30 % of the side) in the accent,
carrying four upright tally strokes and a fifth rising across them. The glyph
inside the square is a deliberate departure from the house rule that the mark
carries no glyph (`STYLE-GUIDE.md` section 17.4), decided by the owner; the
tally *is* the name, so the exception was judged worth it. Do not remove the
strokes to satisfy the guide.

## Construction

Drawn on a 32-unit grid.

| | |
|---|---|
| Square | 0,0 to 32,32, corner radius 9.6 |
| Uprights | x = 8.5, 13.5, 18.5, 23.5 (pitch 5), y = 8 to 24 |
| Fifth mark | (8.5, 22.75) to (23.5, 9.25), rising, 42° |
| Stroke | 2.4 units, round caps |
| Ink bounds incl. caps | 7.3 to 24.7 across, 6.8 to 25.2 down |

Three things about it are load-bearing.

**The fifth mark ends on the outer uprights' centre lines**, so its round caps
are buried inside those strokes rather than poking into open field as blobs.

**The 42° rise is a correction for how the mark is actually read.** A stroke
that merges with what it crosses is not read as one stroke: only the segments
*between* the uprights survive. If those segments sit near level they read as
rungs, and four uprights joined by rungs read as two letter H's. At 31° that
is what the mark said. The fault is invisible at 256 px, where the eye still
integrates the whole stroke, and plain at 32 px, which is a size people see
constantly: the browser tab, the task bar, the bookmark bar. The angle was
settled by rendering two dozen candidates **rasterised at 32 px** and picking
the one with no letters in it. A slight overhang past the outer uprights was
tried too, and dropped: on its own it does not break the rung reading, and it
puts a nib back on each end.

**The figure has 180° rotational symmetry about (16, 16)**, so its centroid is
exactly the square's centre. A rendered 256 px frame measures 59 px of margin
at both sides and 55 px top and bottom.

Negative space stays wider than the ink: strokes are 2.4 units and the gaps
between uprights are 2.6. The uprights stand 1.25 units proud of the fifth
mark's ink at either end.

**At and below 20 px a second drawing takes over.** The master fuses at that
size, so the small frame is redrawn on the pixel grid: 1 px uprights on whole
pixel columns x = 3.5, 6.5, 9.5, 12.5 with 2 px gaps, butt caps, y = 3 to 13,
and a rising fifth mark from (3.5, 11.5) to (12.5, 4.5). That is 37.9°, as
near the master's 42° as a 9-pixel run allows, and steep for the same reason.
This is the frame the browser tab shows.

The top bar shows the **master**, at `--mark`. Tally is at the guide's web
scale, where the mark in the bar is 22 px rather than 15 (STYLE-GUIDE 6.5): the
top bar is the one place the app says who it is, and it is the one piece of
chrome that grows by half rather than a quarter. 22 is above the 20 px
threshold, so the small drawing no longer applies there.

## Colours

| | Dark theme | Light theme |
|---|---|---|
| Square | `#3987E5` | `#2769B7` |
| Strokes | `#FFFFFF` | `#FFFFFF` |

The strokes are `--brand-ink`, not `--accent-ink`. The mark is one piece of
artwork and has to be the same colour everywhere, or the favicon and the top
bar show two different logos in the same window.

In components use `<Mark />` from `frontend/src/components/Brand.tsx`, which
reads `--accent` and `--brand-ink` so the square follows the theme. Static
assets are files, not components, so they carry literal hexes.

## What exists

| Asset | Where |
|---|---|
| Mark at 16, 32, 48, 64, 128 and 256 px, plus `.ico` | `assets/icons/` |
| Favicon, size-switching and theme-aware | `frontend/public/favicon.svg` |
| Favicon, 16/32/48 frames | `frontend/public/favicon.ico` |
| Touch icon, 180 × 180, opaque | `frontend/public/apple-touch-icon.png` |
| Manifest icons, 192 and 512, plus maskable variants | `frontend/public/icon-*.png` |
| Manifest naming Tally and the two icon purposes | `frontend/public/site.webmanifest` |
| Banners, 1354 × 461, dark and paper | `docs/images/banner.png`, `banner-paper.png` |
| `<Mark />`, `<Wordmark />`, `<Logo />` | `frontend/src/components/Brand.tsx` |

The wordmark is Archivo 900, uppercase, tracking −2 px at 64 px, scaled with
the size so the banner sets it at −5.5 px. 900 belongs to the wordmark alone.

## Regenerating

```sh
cd frontend && npm install --no-save playwright && npx playwright install chromium
node assets/icons/build-icons.mjs
```

Playwright is deliberately not in `frontend/package.json`: `Dockerfile` runs
`npm ci`, and a Playwright devDependency would pull a Chromium download into
every image build. So it is installed for a regeneration and thrown away
again. The script says as much if it is missing. Nothing else is downloaded
and the font is the repo's own Archivo subset.

One script produces every asset in the table except `Brand.tsx`, which repeats
the geometry so the app can draw the mark from tokens. Change the two
together.

## Still open

- **Whether the mark should carry the glyph at all.** It is settled for now by
  the owner, against the house rule, and the rest of the family does not do
  it. If the family ever gains a second glyphed mark, revisit section 17.4
  rather than this page.
- **Whether 32 px wants its own frame.** 16 has one and 256 needs none. The
  master's geometry is now chosen at 32 rather than checked there, so a third
  drawing was not needed; what remains at that size is only softness, because
  a 2.4-unit stroke falls on fractional pixels. If the desktop `.ico` ever
  looks wrong in a file list, a hand-tuned 32 px frame is the next move, and
  it is sanctioned.
- **Whether the app offers the mark in a neutral.** Section 17.4 wants the
  GitHub profile avatar in a neutral so it favours no one app. Tally does not
  ship one; that belongs to the profile, not to this repository.
