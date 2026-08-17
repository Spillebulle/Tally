#!/usr/bin/env node
/*
 * Builds every Tally brand asset from one drawing of the mark.
 *
 *     node assets/icons/build-icons.mjs
 *
 * Run it from anywhere; paths are resolved from this file. It uses the
 * Playwright Chromium that frontend/node_modules already carries to rasterise
 * the SVG, so there is nothing to install beyond `npm ci` in frontend/.
 * Nothing is downloaded; the font is the repo's own Archivo subset.
 *
 * Outputs:
 *   assets/icons/tally-{16,32,48,64,128,256}.png   mark on transparent
 *   assets/icons/tally.ico                          all six frames
 *   frontend/public/favicon.svg                     theme-aware (media query)
 *   frontend/public/favicon.ico                     16/32/48 frames
 *   frontend/public/apple-touch-icon.png            180 px, opaque, full bleed
 *   frontend/public/icon-192.png, icon-512.png      manifest icons
 *   docs/images/banner.png                          1354 x 461 on #0D0E10
 *   docs/images/banner-paper.png                    1354 x 461 on #E4E0D9
 *
 * The mark: a rounded square (radius 30 % of the side) in the accent, with
 * four upright tally strokes and a fifth crossing them. The glyph inside the
 * square is a deliberate, owner-approved departure from the house rule that
 * the mark carries no glyph (STYLE-GUIDE.md 17.4); see docs/brand.md.
 *
 * Static assets are files, not components, so literal hexes are correct here.
 * The values mirror theme-tally.css and tokens.css; if those move, move these.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..', '..')
const requireFrontend = createRequire(join(repo, 'frontend', 'package.json'))
const { chromium } = requireFrontend('playwright')

/* ------------------------------------------------------------------ colours */

const ACCENT_DARK = '#3987E5' // --accent, dark theme (theme-tally.css)
const ACCENT_LIGHT = '#2769B7' // --accent, light theme
const INK = '#FFFFFF' // stroke colour in static assets: white reads on both accents
const BACKDROP_DARK = '#0D0E10' // --backdrop, dark
const BACKDROP_PAPER = '#E4E0D9' // --backdrop, light
const TEXT_DARK = '#E6E7E9' // --text-strong, dark
const TEXT_PAPER = '#3A3836' // --text-strong, light

/* ---------------------------------------------------------------- the mark  */

/*
 * Drawn on a 32-unit grid so every dimension is legible:
 *   - square: 0,0 -> 32,32, corner radius 9.6 (30 % of the side)
 *   - four uprights: x = 7, 13, 19, 25 (6-unit rhythm), y = 9 -> 23
 *   - the fifth: (6,11) -> (26,21), falling through the centre (16,16)
 *   - stroke 3 units, round caps
 * With caps the ink spans x 5.5..26.5 and y 7.5..24.5, so the glyph is
 * centred optically as well as geometrically: the diagonal is symmetric about
 * (16,16) and its caps overhang each side equally. At 16 px a stroke is
 * 1.5 px and each gap 1.5 px, which stays separable.
 */
const STROKES =
  '<g stroke="' +
  INK +
  '" stroke-width="3" stroke-linecap="round" fill="none">' +
  '<path d="M7 9v14M13 9v14M19 9v14M25 9v14M6 11 26 21"/></g>'

function markSvg(accent, { size, fullBleed = false } = {}) {
  const dim = size ? ` width="${size}" height="${size}"` : ''
  const rect = fullBleed
    ? `<rect width="32" height="32" fill="${accent}"/>`
    : `<rect width="32" height="32" rx="9.6" fill="${accent}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"${dim}>${rect}${STROKES}</svg>`
}

/*
 * The 16 px frame is redrawn on the pixel grid rather than scaled: 1 px
 * uprights on pixel columns 3/6/9/12 with 2 px gaps, butt caps (a round cap
 * is a smear at this size), and the fifth stroke kept thin so it crosses
 * without flooding the gaps. Same mark, tuned for the one size where
 * antialiasing would otherwise fuse it into a blob.
 */
function mark16Svg(accent) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">` +
    `<rect width="16" height="16" rx="4.8" fill="${accent}"/>` +
    `<g stroke="${INK}" fill="none">` +
    `<path d="M3.5 4v8M6.5 4v8M9.5 4v8M12.5 4v8" stroke-width="1"/>` +
    `<path d="M2.5 5.5 13.5 10.5" stroke-width="1.2" stroke-linecap="round"/>` +
    `</g></svg>`
  )
}

/* The favicon follows the browser chrome: dark accent by default, the light
   accent when the chrome is light. An SVG favicon may carry a media query. */
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <style>
    .square { fill: ${ACCENT_DARK}; }
    @media (prefers-color-scheme: light) { .square { fill: ${ACCENT_LIGHT}; } }
  </style>
  <rect class="square" width="32" height="32" rx="9.6"/>
  ${STROKES}
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
      /* Archivo's em box sits low; nudge caps onto the mark's centre line */
      margin-top: -8px;
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

// Mark on transparent, the app-icon ladder.
const pngs = new Map()
pngs.set(16, await shotSvg(mark16Svg(ACCENT_DARK), 16))
for (const size of [32, 48, 64, 128, 192, 256, 512]) {
  const png = await shotSvg(markSvg(ACCENT_DARK, { size }), size)
  pngs.set(size, png)
}
for (const size of [16, 32, 48, 64, 128, 256]) {
  writeFileSync(join(outIcons, `tally-${size}.png`), pngs.get(size))
}
writeFileSync(join(outPublic, 'icon-192.png'), pngs.get(192))
writeFileSync(join(outPublic, 'icon-512.png'), pngs.get(512))

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

// The theme-aware favicon.
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
