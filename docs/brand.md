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
| Uprights | x = 7.75, 13.25, 18.75, 24.25 (pitch 5.5), y = 8.5 to 23.5 |
| Fifth mark | (7.75, 21) to (24.25, 11), rising, 31.2° |
| Stroke | 2.4 units, round caps |
| Ink bounds incl. caps | 6.55 to 25.45 across, 7.3 to 24.7 down |

Three things about it are load-bearing. The fifth mark ends **on the outer
uprights' centre lines**, so its round caps are buried inside those strokes
rather than poking into open field as blobs. Its angle was picked by rendering
the alternatives: much shallower and each segment between two uprights reads
as a rung, turning the mark into a fence of H shapes. And the figure has
180° rotational symmetry about (16, 16), so its centroid is exactly the
square's centre; a rendered 256 px frame measures 53 px of margin at both
sides and 59 px top and bottom.

Negative space is wider than the ink: strokes are 2.4 units and the gaps
between uprights are 3.1.

**At and below 20 px a second drawing takes over.** The master fuses at that
size, so the small frame is redrawn on the pixel grid: 1 px uprights on whole
pixel columns x = 3.5, 6.5, 9.5, 12.5 with 2 px gaps, butt caps, y = 4 to 12,
and a thin rising fifth mark from (3.5, 10.5) to (12.5, 5.5). This is the
frame the browser tab and the top bar show.

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
- **Whether 32 px wants its own frame.** 16 has one and 256 needs none; at
  32 the master renders slightly soft because the strokes fall on fractional
  pixels. It is legible and no third drawing has been cut, but a third drawing
  is the obvious next move if the desktop `.ico` ever looks wrong in a file
  list.
- **Whether the app offers the mark in a neutral.** Section 17.4 wants the
  GitHub profile avatar in a neutral so it favours no one app. Tally does not
  ship one; that belongs to the profile, not to this repository.
