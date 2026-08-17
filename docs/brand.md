# Brand

*Dated 17 August 2026. Settles what the Tally mark is, where its assets live
and how they are regenerated.*

The mark is a rounded square (corner radius 30 % of the side) in the accent,
carrying four upright tally strokes and a fifth crossing them. The glyph
inside the square is a deliberate departure from the house rule that the mark
carries no glyph (`STYLE-GUIDE.md` section 17.4), decided by the owner; the
tally *is* the name, so the exception was judged worth it. Do not remove the
strokes to satisfy the guide.

## Construction

Drawn on a 32-unit grid: uprights at x = 7, 13, 19 and 25 (a 6-unit rhythm),
from y = 9 to y = 23; the fifth stroke falls from (6, 11) to (26, 21) through
the centre; stroke weight 3 units, round caps. The 16 px frame is redrawn on
the pixel grid (1 px uprights, 2 px gaps, butt caps) because a scaled render
fuses at that size.

## Colours

| | Dark theme | Light theme |
|---|---|---|
| Square | `#3987E5` | `#2769B7` |
| Strokes, in the app | `--accent-ink` (near black) | `--accent-ink` (white) |
| Strokes, static assets | white | white |

In components use `<Mark />` from `frontend/src/components/Brand.tsx`, which
reads `--accent` and `--accent-ink` so it follows the theme. Static assets are
files, not components, so they carry literal hexes; white strokes read on both
accent values.

## What exists

| Asset | Where |
|---|---|
| Mark at 16, 32, 48, 64, 128 and 256 px, plus `.ico` | `assets/icons/` |
| Favicon (theme-aware SVG and `.ico`), touch icon, manifest icons | `frontend/public/` |
| Banners, 1354 x 461, dark and paper | `docs/images/banner.png`, `banner-paper.png` |
| `<Mark />`, `<Wordmark />`, `<Logo />` | `frontend/src/components/Brand.tsx` |

The wordmark is Archivo 900, uppercase, tracking -2 px at 64 px, scaled
proportionally in the banner. 900 belongs to the wordmark alone.

## Regenerating

```sh
cd frontend && npm ci        # once, for the bundled Chromium
node assets/icons/build-icons.mjs
```

One script draws the mark and produces every file above except `Brand.tsx`;
edit the geometry in both places together. Nothing is downloaded and the font
is the repo's own Archivo subset.
