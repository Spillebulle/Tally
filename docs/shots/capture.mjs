// Drives a headless Chromium against a running Tally instance and writes
// screenshots + a console-error log. Invoked by shots.py once the backend is
// up and seeded; not meant to be run standalone (it has no argv parsing of
// its own — everything comes in as TALLY_* env vars).
//
// Resolves Playwright out of frontend/node_modules explicitly, via
// createRequire, rather than relying on cwd-based module resolution: this
// file lives in docs/shots, a sibling of frontend/, and plain `import
// 'playwright'` would walk up from docs/shots and never find it. Playwright
// is deliberately NOT a frontend/package.json dependency (it must stay out of
// the Docker build), so this is the only way to reach it.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.resolve(__dirname, '..', '..', 'frontend')
const require = createRequire(path.join(FRONTEND_DIR, 'package.json'))
const { chromium } = require('playwright')

const BASE_URL = process.env.TALLY_BASE_URL
const OUT_DIR = process.env.TALLY_OUT
const THEMES = (process.env.TALLY_THEMES || 'dark,light').split(',').filter(Boolean)
const PAGES = (process.env.TALLY_PAGES || 'login,dashboard,movies,shows,anime,watchlist,history,stats,settings,item')
  .split(',')
  .filter(Boolean)
const WIDTH = parseInt(process.env.TALLY_WIDTH || '1440', 10)
const HEIGHT = parseInt(process.env.TALLY_HEIGHT || '900', 10)
const USERNAME = process.env.TALLY_USERNAME
const PASSWORD = process.env.TALLY_PASSWORD
const ITEM_ID = process.env.TALLY_ITEM_ID

if (!BASE_URL || !OUT_DIR || !USERNAME || !PASSWORD) {
  console.error('Missing required TALLY_BASE_URL / TALLY_OUT / TALLY_USERNAME / TALLY_PASSWORD')
  process.exit(1)
}

const PAGE_PATHS = {
  login: '/login',
  dashboard: '/',
  movies: '/movies',
  shows: '/shows',
  anime: '/anime',
  watchlist: '/watchlist',
  history: '/history',
  stats: '/stats',
  settings: '/settings',
  item: ITEM_ID ? `/item/${ITEM_ID}` : null,
}

const consoleLines = []

function logLine(theme, pageName, kind, text) {
  consoleLines.push(`[${theme}] ${pageName}: ${kind}: ${text}`)
}

async function shootPage(context, theme, pageName, urlPath) {
  const page = await context.newPage()
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return
    // Chromium logs a failed resource load to the console itself (separately
    // from `requestfailed`, which only fires for network-level failures, not
    // HTTP error statuses). There is no Plex server here, so every poster and
    // backdrop 404s against /api/images/ by design (see README.md) — that is
    // not a finding, and would otherwise drown out anything that is.
    const url = msg.location()?.url || ''
    if (url.includes('/api/images/')) return
    logLine(theme, pageName, msg.type(), msg.text())
  })
  page.on('pageerror', (err) => logLine(theme, pageName, 'pageerror', String(err)))
  page.on('requestfailed', (req) => {
    // The artwork proxy 404ing for a placeholder poster is expected (there is
    // no Plex server here) and would otherwise drown out real findings.
    if (req.url().includes('/api/images/')) return
    logLine(theme, pageName, 'requestfailed', `${req.method()} ${req.url()} - ${req.failure()?.errorText ?? ''}`)
  })

  try {
    await page.goto(BASE_URL + urlPath, { waitUntil: 'networkidle', timeout: 20000 })
  } catch {
    // A page that keeps a connection open (polling) never reaches
    // networkidle; fall back to a plain load and a short settle time so the
    // screenshot still happens instead of the whole run aborting.
    await page.goto(BASE_URL + urlPath, { waitUntil: 'load', timeout: 20000 }).catch(() => {})
  }
  if (pageName !== 'login') {
    // The very first authenticated page after signing in can still be
    // waiting on the client's own `/api/auth/me` hydration even once
    // `networkidle` has fired — that request starts on mount, not on
    // navigation, so it can trail the rest of the page's network activity.
    // The nav sidebar only renders once `RequireAuth` resolves, so waiting
    // for it is a much more reliable "is this actually the page" signal than
    // a fixed delay.
    await page.getByRole('link', { name: 'Settings' }).first().waitFor({ timeout: 15000 }).catch(() => {})
  }
  await page.waitForTimeout(600)

  const dir = path.join(OUT_DIR, theme)
  fs.mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, `${pageName}.viewport.png`) })
  await page.screenshot({ path: path.join(dir, `${pageName}.png`), fullPage: true })
  await page.close()
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()

  for (const theme of THEMES) {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } })
    // Mirrors index.html's own pre-paint script: it reads `tally.theme` out of
    // localStorage, defaulting to 'dark'. Setting it before any navigation
    // means every page in this context renders in the theme we asked for.
    await context.addInitScript((t) => {
      try {
        localStorage.setItem('tally.theme', t)
      } catch {
        /* ignore */
      }
    }, theme)

    if (PAGES.includes('login')) {
      await shootPage(context, theme, 'login', PAGE_PATHS.login)
    }

    const loginResp = await context.request.post(`${BASE_URL}/api/auth/login`, {
      data: { username: USERNAME, password: PASSWORD },
    })
    if (!loginResp.ok()) {
      throw new Error(`Login failed: ${loginResp.status()} ${await loginResp.text()}`)
    }

    for (const pageName of PAGES) {
      if (pageName === 'login') continue
      const urlPath = PAGE_PATHS[pageName]
      if (!urlPath) {
        console.warn(`Skipping unknown page "${pageName}"`)
        continue
      }
      await shootPage(context, theme, pageName, urlPath)
    }

    await context.close()
  }

  await browser.close()
  fs.writeFileSync(path.join(OUT_DIR, 'console.txt'), consoleLines.join('\n') + (consoleLines.length ? '\n' : ''))
  console.log(`Wrote ${consoleLines.length} console line(s) to ${path.join(OUT_DIR, 'console.txt')}`)
}

run()
  .then(() => {
    console.log('capture done')
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
