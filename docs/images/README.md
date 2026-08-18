# Pictures

Which pictures the README needs, what each must look like, and how to take one.
Nothing here is a picture requirement for the docs pages, which use tables.

## What the README wants

The house rules are `../../../Design-Principles/STYLE-GUIDE.md` §17.1 for the
order and §17.3 for the pictures themselves. Two of the files already exist; the
rest are missing and the README has a place waiting for each.

| File | Subject | How it appears | Status |
|---|---|---|---|
| `banner.png` | The mark beside the wordmark, on the dark backdrop. 1354 x 461. | Centred, `width="560"`, in a `<picture>` with the light file below. | Present |
| `banner-paper.png` | The same banner on the light backdrop. 1354 x 461. | The light half of that `<picture>`. | Present |
| `dashboard.png` | The whole thing working: the shelf of what you are part-way through, recent plays, the sidebar and the header. | Full width, directly under the honesty note. | Present |
| `continue-watching.png` | The Continue watching shelf on its own, a few cards with episode progress on them. | `<img align="right" width="300">` beside the Continue watching section. | Present |
| `anime.png` | The anime grid, showing it as a section of its own rather than a filter. | `<img align="right" width="300">` beside the Anime section. | Present |
| `stats.png` | The statistics page: the activity heatmap and a chart or two beneath it. | `<img align="right" width="300">` beside the Stats section. | Present |
| `filters.png` | The filter bar with the disclosure open and two or three chips showing. | `<img align="right" width="300">` beside the Filters section. | Present |
| `settings-themes.png` | The Appearance pane: the theme cards, one custom theme among them, and the swatch editor beneath. | `<img align="right" width="300">` beside the Themes section. | Present, without a custom theme: the instance they were taken from has none, and one cannot be invented for a picture |
| `history-calendar.png` | The month calendar: a poster per day and the play counts on them. | `<img align="right" width="300">` beside the History section, which currently has none. | Missing |

Every one of them needs alt text that names what is in it ("The Continue
watching shelf: four cards, each with a progress bar across the poster"), never
"screenshot".

## The rules each picture has to meet

* Dark theme, at Tally's own accent, 100 % scale, **1400 to 1600 px wide**. A
  light-theme picture appears only where the picture is *about* the light theme.
* **Real content, never lorem.** A real watch history. Names may be invented but
  must look like somebody's.
* No browser chrome, no window title bar, no device mock-up, no drop shadow, no
  padding. Square corners in the file. The app's own chrome is its frame.
* PNG, under 500 KB each. The full-width `dashboard.png` may reach 1 MB.
* Lowercase-hyphen filenames that name the subject, all in this directory.
* Detail pictures are cropped **to the module**, not scaled-down whole windows.

## Why the preview harness cannot take them

`docs/shots/` builds the frontend, seeds a scratch database and screenshots
every page in both themes. It is the right tool for checking layout, density and
colour after a UI change, and it is the wrong tool for these files.

The seeded library has no Plex mapping and there is no TMDB key, so **every
poster and backdrop renders as the deterministic placeholder gradient**. That is
the real app's honest behaviour for a missing image, not a bug in the seed, but
a wall of gradients is not what Tally looks like to anybody using it. The
project's engineering notes, in `CLAUDE.md` at the repository root, are explicit
about it: screenshots taken that way misrepresent the product and must not be
committed as documentation.

So these files are taken from a **real instance with a real library**, and the
harness stays what it is for.

## Why `history-calendar.png` is still missing

The same rule, one step further on. The three History views arrived in 0.6.0 and
the instance the other pictures came from was still running 0.5.0, so the
calendar's endpoint answered 404 and the poster grid drew episodes as their own
stills rather than the series poster - which is the very thing 0.6.0 fixed. A
picture of a feature has to be a picture of the version that has it. Take it
once the instance is updated.

## Two things that spoil a crop

* **A `position: fixed` bar is painted once, where it sits in the viewport.** A
  full-page screenshot cropped further down the page therefore has the status
  bar baked across the middle of it. Hide fixed elements before a module crop -
  they are not part of the module.
* **A poster wall is a big PNG.** Two rows of the anime grid came out at 1.1 MB.
  `magick in.png -strip -colors 256 -define png:compression-level=9 out.png`
  brought it to 310 KB with no banding a reader would see at 300px wide. Check
  the result rather than assuming; quantisation is visible on a gradient.

## Taking them from a real instance

`docs/shots/capture.mjs` is the half of the harness that only drives a browser.
It takes a running instance's address in an environment variable and does not
care whether that instance was seeded or is your own, so point it at yours.

It signs in with `POST /api/auth/login`, which needs a username and password. An
account created by signing in with Plex has no password until you set one: while
signed in to that account in a browser, set one with

```bash
curl -X POST https://tally.example.com/api/auth/password \
  -H 'Content-Type: application/json' \
  --cookie 'tally_session=…' \
  -d '{"new_password": "…"}'
```

Then, once per machine, install Playwright without adding it to the project:

```bash
cd frontend && npm i --no-save playwright && npx playwright install chromium
```

`--no-save` matters. It must never land in `frontend/package.json`, or it ships
inside the Docker image.

Then take the pictures, into your scratchpad and never into the repository:

```bash
cd frontend
TALLY_BASE_URL=https://tally.example.com \
TALLY_OUT=/tmp/tally-shots \
TALLY_USERNAME=… TALLY_PASSWORD=… \
TALLY_THEMES=dark \
TALLY_WIDTH=1500 TALLY_HEIGHT=940 \
node ../docs/shots/capture.mjs
```

`TALLY_PAGES` takes a subset (`dashboard,anime,stats,settings`) when you only
want a few, and `TALLY_ITEM_ID` picks which title the item page shows. Each page
is written twice, as `<page>.png` full height and `<page>.viewport.png` without
scrolling.

What comes out is a whole page. Crop each detail picture to its module, rename
it to the filename in the table above, and copy only those files into this
directory. Remove the Playwright package from `frontend/node_modules` afterwards
if you are about to commit anything from `frontend/`.
