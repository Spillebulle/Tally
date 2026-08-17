#!/usr/bin/env node
/*
 * Builds every Tally brand asset from one drawing of the mark.
 *
 *     cd frontend && npm install --no-save playwright && npx playwright install chromium
 *     node assets/icons/build-icons.mjs
 *
 * Playwright is deliberately *not* a dependency of frontend/package.json:
 * `Dockerfile` runs `npm ci`, and a Playwright devDependency would pull a
 * Chromium download into every image build. So it is installed ad hoc for a
 * regeneration and thrown away again. Nothing else is downloaded; the font is
 * the repo's own Archivo subset.
 *
 * Outputs:
 *   assets/icons/tally-{16,32,48,64,128,256}.png   mark on transparent
 *   assets/icons/tally.ico                          all six frames
 *   frontend/public/favicon.svg                     both frames, size-switched
 *   frontend/public/favicon.ico                     16/32/48 frames
 *   frontend/public/apple-touch-icon.png            180 px, opaque, full bleed
 *   frontend/public/icon-192.png, icon-512.png      manifest icons
 *   frontend/public/icon-192-maskable.png, icon-512-maskable.png
 *   docs/images/banner.png                          1354 × 461 on #0D0E10
 *   docs/images/banner-paper.png                    1354 × 461 on #E4E0D9
 *
 * The mark: a rounded square (radius 30 % of the side) in the accent, with
 * four upright tally strokes and a fifth rising across them. The glyph inside
 * the square is a deliberate, owner-approved departure from the house rule
 * that the mark carries no glyph (STYLE-GUIDE.md §17.4); see docs/brand.md.
 *
 * Static assets are files, not components, so literal hexes are correct here.
 * The values mirror theme-tally.css and tokens.css; if those move, move these.
 * The geometry is duplicated in frontend/src/components/Brand.tsx - change
 * the two together.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..', '..')
const requireFrontend = createRequire(join(repo, 'frontend', 'package.json'))

let chromium
try {
  ;({ chromium } = requireFrontend('playwright'))
} catch {
  console.error(
    'playwright is not installed. It is kept out of package.json so that the\n' +
      'Docker build does not download a Chromium. Install it just for this run:\n\n' +
      '    cd frontend && npm install --no-save playwright && npx playwright install chromium\n',
  )
  process.exit(1)
}

/* ------------------------------------------------------------------ colours */

const ACCENT_DARK = '#3987E5' // --accent, dark theme (theme-tally.css)
const ACCENT_LIGHT = '#2769B7' // --accent, light theme
const INK = '#FFFFFF' // --brand-ink: one ink for the mark, in both themes
const BACKDROP_DARK = '#0D0E10' // --backdrop, dark
const BACKDROP_PAPER = '#E4E0D9' // --backdrop, light
const TEXT_DARK = '#E6E7E9' // --text-strong, dark
const TEXT_PAPER = '#3A3836' // --text-strong, light

/* ---------------------------------------------------------------- the mark  */

/*
 * The master drawing, on a 32-unit grid.
 *
 *   square      0,0 to 32,32, corner radius 9.6 (30 % of the side)
 *   uprights    x = 8.5, 13.5, 18.5, 23.5 (pitch 5), y = 8 to 24
 *   fifth mark  (8.5, 22.75) to (23.5, 9.25), rising, as a tally's fifth does
 *   stroke      2.4 units, round caps
 *
 * The fifth mark starts and ends exactly on the outer uprights' centre lines,
 * so its round caps sit inside those strokes' own width instead of poking out
 * into open field as blobs.
 *
 * It rises at 42 degrees, and the angle is the load-bearing number. A stroke
 * that merges with what it crosses is not read as one stroke: only the
 * segments *between* the uprights survive, and if those segments are close to
 * horizontal they read as rungs, so four uprights joined by rungs read as two
 * letter H's. That is what happened at 31 degrees. It is invisible at 256 px,
 * where the eye still integrates the whole stroke, and plain at 32, which is
 * a size people actually see: the tab, the task bar, the bookmark bar. The
 * angle was chosen by rendering two dozen candidates *rasterised at 32 px*
 * and picking the one with no letters in it. A slight overhang past the outer
 * uprights was tried as well, and dropped: it does not fix the rung reading
 * on its own, and it brings back a nib on each end.
 *
 * Ink is 2.4 wide and the gaps between uprights are 2.6, so the negative
 * space stays wider than the ink. Including the caps the ink spans 7.3 to
 * 24.7 across and 6.8 to 25.2 down: 7.3 units of margin at the sides, 6.8 top
 * and bottom, and 1.25 units of upright left proud beyond the fifth mark's
 * ink at either end.
 *
 * The artwork has 180-degree rotational symmetry about (16, 16): the uprights
 * swap in pairs and the fifth mark maps onto itself. Its centroid is
 * therefore exactly the square's centre, which is what "optically centred"
 * has to mean for a figure with a diagonal in it.
 */
const STROKES =
  `<g stroke="${INK}" stroke-width="2.4" stroke-linecap="round" fill="none">` +
  '<path d="M8.5 8v16M13.5 8v16M18.5 8v16M23.5 8v16M8.5 22.75 23.5 9.25"/></g>'

function markSvg(accent, { size, fullBleed = false } = {}) {
  const dim = size ? ` width="${size}" height="${size}"` : ''
  const rect = fullBleed
    ? `<rect width="32" height="32" fill="${accent}"/>`
    : `<rect width="32" height="32" rx="9.6" fill="${accent}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"${dim}>${rect}${STROKES}</svg>`
}

/*
 * The 16 px frame, redrawn on the pixel grid rather than scaled: 1 px
 * uprights centred on x = 3.5/6.5/9.5/12.5 so each lands on one whole pixel
 * column with a 2 px gap either side, butt caps (a round cap is a smear at
 * this size), y = 3 to 13, and a rising fifth mark from (3.5, 11.5) to
 * (12.5, 4.5). That is 37.9 degrees, as near the master's 42 as a 9-pixel
 * run allows, and steep for the same reason: at 29 degrees the three visible
 * segments sit almost level and read as rungs here too. Same mark, tuned
 * for the sizes where antialiasing would otherwise fuse it into a blob.
 *
 * The uprights carry `shape-rendering="crispEdges"`. The frame is pixel-exact
 * only at exactly 16 px, and the top bar draws it at 15 (section 6.2), where
 * a 1 px stroke lands on 0.94 px and smears across two columns; snapping the
 * edges keeps four separate uprights at any size the frame is used at. The
 * fifth mark is left antialiased, because snapping a diagonal is what makes
 * it a staircase.
 */
const STROKES_16 =
  `<g stroke="${INK}" fill="none">` +
  '<path d="M3.5 3v10M6.5 3v10M9.5 3v10M12.5 3v10" stroke-width="1" shape-rendering="crispEdges"/>' +
  '<path d="M3.5 11.5 12.5 4.5" stroke-width="1" stroke-linecap="round"/>' +
  '</g>'

function mark16Svg(accent) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">' +
    `<rect width="16" height="16" rx="4.8" fill="${accent}"/>${STROKES_16}</svg>`
  )
}

/*
 * The favicon carries *both* drawings and switches on rendered size. It has
 * to: index.html declares it `type="image/svg+xml"`, so Chrome and Firefox
 * prefer it over the .ico and would otherwise render the master geometry into
 * a 16 px tab, where the uprights fuse. A media query inside an SVG resolves
 * against the size the image is rendered at, so `max-width: 20px` picks the
 * tuned frame in a tab and the master everywhere else. The accent follows the
 * browser chrome the same way.
 */
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <style>
    .square { fill: ${ACCENT_DARK}; }
    @media (prefers-color-scheme: light) { .square { fill: ${ACCENT_LIGHT}; } }
    /* One frame at a time: the tuned 16 px drawing only in a tab. */
    .small { display: none; }
    @media (max-width: 20px) {
      .large { display: none; }
      .small { display: inline; }
    }
  </style>
  <rect class="square" width="32" height="32" rx="9.6"/>
  <g class="large">${STROKES}</g>
  <g class="small" transform="scale(2)">${STROKES_16}</g>
</svg>
`

/* ------------------------------------------------------------------ banner  */

const fontB64 = readFileSync(
  join(repo, 'frontend', 'src', 'assets', 'fonts', 'archivo-variable.woff2'),
).toString('base64')

/*
 * 1354 x 461, mark beside the wordmark, centred, nothing else. The wordmark
 * is Archivo 900 uppercase; tracking is -2 px at the spec size of 64 px and
 * scales with the size, so at 176 px it is -5.5 px.
 */
function bannerHtml(bg, accent, inkText) {
  const fontSize = 176
  const tracking = (-2 * fontSize) / 64
  return `<!doctype html><html><head><style>
    @font-face {
      font-family: Archivo;
      src: url(data:font/woff2;base64,${fontB64}) format('woff2');
      font-weight: 100 900;
    }
    html, body { margin: 0; }
    body {
      width: 1354px; height: 461px; background: ${bg};
      display: flex; align-items: center; justify-content: center; gap: 48px;
    }
    .word {
      font-family: Archivo, sans-serif; font-weight: 900;
      font-size: ${fontSize}px; line-height: 1; letter-spacing: ${tracking}px;
      text-transform: uppercase; color: ${inkText};
      /* trim the trailing tracking so the word is optically centred */
      margin-right: ${-tracking}px;
      /* Flexbox centres the line box, but the cap band sits above the line
         box's centre because of the descender space, so the word rides high.
         Nudged with a relative offset rather than a margin: under
         align-items:center a margin is absorbed into the centring and moves
         the item by half its value, which is how the first attempt at this
         overshot. */
      position: relative;
      top: 1.5px;
    }
  </style></head><body>${markSvg(accent, { size: 152 })}<div class="word">Tally</div></body></html>`
}

/* ---------------------------------------------------------------- ico files */

/* An ICO is a tiny directory in front of PNG blobs; PNG frames are understood
   by every browser and by Windows Vista onwards. */
function buildIco(frames /* [{ size, png }] */) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  const entries = []
  let offset = 6 + 16 * frames.length
  for (const f of frames) {
    const e = Buffer.alloc(16)
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 0)
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 1)
    e.writeUInt16LE(1, 4) // colour planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(f.png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += f.png.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.png)])
}

/* -------------------------------------------------------------------- build */

const outIcons = here
const outPublic = join(repo, 'frontend', 'public')
const outImages = join(repo, 'docs', 'images')
for (const d of [outIcons, outPublic, outImages]) mkdirSync(d, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ deviceScaleFactor: 1 })

async function shotSvg(svg, size, { transparent = true } = {}) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<!doctype html><html><body style="margin:0">${svg}</body></html>`,
  )
  return page.screenshot({ omitBackground: transparent })
}

// Mark on transparent, the app-icon ladder. 16 uses the tuned frame.
const pngs = new Map()
pngs.set(16, await shotSvg(mark16Svg(ACCENT_DARK), 16))
for (const size of [32, 48, 64, 128, 192, 256, 512]) {
  pngs.set(size, await shotSvg(markSvg(ACCENT_DARK, { size }), size))
}
for (const size of [16, 32, 48, 64, 128, 256]) {
  writeFileSync(join(outIcons, `tally-${size}.png`), pngs.get(size))
}
writeFileSync(join(outPublic, 'icon-192.png'), pngs.get(192))
writeFileSync(join(outPublic, 'icon-512.png'), pngs.get(512))

/* Maskable icons are full-bleed: Android applies its own mask, so a rounded
   square handed in whole ends up inside a second rounded square. The glyph is
   unchanged and its corner-to-corner span is 25.3 of 32 units, inside the
   25.6-unit safe circle the maskable spec guarantees. */
for (const size of [192, 512]) {
  writeFileSync(
    join(outPublic, `icon-${size}-maskable.png`),
    await shotSvg(markSvg(ACCENT_DARK, { size, fullBleed: true }), size, {
      transparent: false,
    }),
  )
}

// ICOs from the same frames.
const frame = (size) => ({ size, png: pngs.get(size) })
writeFileSync(join(outPublic, 'favicon.ico'), buildIco([16, 32, 48].map(frame)))
writeFileSync(
  join(outIcons, 'tally.ico'),
  buildIco([16, 32, 48, 64, 128, 256].map(frame)),
)

// Apple touch icon: opaque, the accent filling the whole tile (iOS masks it).
writeFileSync(
  join(outPublic, 'apple-touch-icon.png'),
  await shotSvg(markSvg(ACCENT_DARK, { size: 180, fullBleed: true }), 180, {
    transparent: false,
  }),
)

// The size- and theme-switching favicon.
writeFileSync(join(outPublic, 'favicon.svg'), faviconSvg)

// Banners.
async function shotBanner(html, file) {
  await page.setViewportSize({ width: 1354, height: 461 })
  await page.setContent(html)
  await page.evaluate(() => document.fonts.ready)
  writeFileSync(join(outImages, file), await page.screenshot())
}
await shotBanner(bannerHtml(BACKDROP_DARK, ACCENT_DARK, TEXT_DARK), 'banner.png')
await shotBanner(
  bannerHtml(BACKDROP_PAPER, ACCENT_LIGHT, TEXT_PAPER),
  'banner-paper.png',
)

await browser.close()
console.log('brand assets rebuilt.')
