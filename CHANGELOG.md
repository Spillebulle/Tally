# Changelog

What changed in each release, newest first, in terms of what you would notice.
Releases before 0.4.0 kept their notes on the
[releases page](https://github.com/Spillebulle/Tally/releases) only.

## 0.5.0

**Tally is drawn a size up.** It is a web application read in a browser tab,
not a desktop tool used at arm's length, and it was drawn at the desktop
density. The top bar is 52 px with a 22 px mark, buttons and fields are 32,
navigation rows 38, the sidebar 280, body text 14 px and icons 18. Nothing else
changed: the same colours, the same hairlines, the same rules about where the
accent goes.

**Posters are the cards now.** A card in a grid or a rail is the artwork and
nothing else, with no caption strip underneath making every card taller than
the thing it exists to show. The title and one figure sit over the bottom of
the picture, always visible on a touch screen and on a keyboard, and a title
with no artwork still names itself. Cards lift slightly under the pointer.

**You can choose how big the posters are.** Movies, Shows, Anime, Search and
the Watchlist have a poster-size control on their filter strip: compact,
standard or large, which on a full-width window is about eight, five and three
columns. It is remembered for next time, per device, so a phone and a desktop
can differ. It is not part of a shared link or a saved view, which stay about
*which* titles you are looking at.

**Artwork is one set of sizes across the app.** Continue watching used to show
a 40 px thumbnail on the same page as 150 px posters. Everything is now on one
ladder: 120 px where a picture sits beside text, 180 px for a browse card,
320 px for the poster on a title's own page, and 36 px for a cast face, which
was 20. The watchlist and the browse grids were two different grids and are now
one.

**Two lists lost their thumbnails.** History and the Stats leaderboards carried
posters at 14 x 20 and 24 x 36 pixels, which recognise nothing and cost a row
its height. Both read better as lists; the artwork is one click away, on the
title.

**A title's backdrop is a picture again.** The fade into the page was finished
by the middle of the band, which paid the whole cost of loading the image for
almost none of the effect. The top of the picture is now untouched and it
reaches the page only at the bottom edge, over a taller band.

**Fixed: the mark-as-watched button on Continue watching was missing on a
phone.** The row was wider than its column and the panel quietly clipped the
end of it, with no scrollbar to say so. The same fault hid the Include switch
on each library row in Settings.

## 0.4.1

**Tally is now under the GNU General Public License v3.0**, where releases up
to and including 0.4.0 were Apache 2.0. The bundled Archivo typeface and Lucide
icons keep their own licences, both of which the GPL permits.

**The Docker Hub listing shows its banner again.** The description is pushed
from the README, and the README's banner is a `<picture>` element so that
GitHub can swap it between dark and light. Docker Hub renders Markdown and not
raw HTML, and the URL completion that turns relative paths into absolute ones
only rewrites Markdown, so the paths arrived pointing at nothing. Docker Hub
now gets its own short description with absolute image URLs.

## 0.4.0

**The interface has been rebuilt.** Tally now follows one design language from
top to bottom: a denser layout with a 34 px top bar and a 240 px sidebar, the
Archivo typeface, every number set in a monospaced figure so columns line up,
and selection shown as a raised neutral fill with a small accent mark rather
than a wash of blue. Dark and light are both complete, and following the device
is a first-class choice rather than a fallback.

**Tally has a proper mark.** A new logo, favicon, app icons and banner, drawn
from one script so they can be regenerated rather than redrawn.

**You can make your own theme.** Settings, Appearance now holds a theme library:
copy a built-in, edit any of its twenty-seven colours with a live preview,
rename it, export it and import somebody else's. Theme files are the same
`.umbertheme` format my other applications use, so a theme made in one opens in
the others unchanged. See `docs/themes.md`.

**Continue watching no longer repeats a series.** A show with three part-watched
episodes took three of the shelf's slots and, on a full shelf, crowded
everything else out. It is one row now, the episode you left off in most
recently, and the shelf fills its limit with distinct things.

**The stats charts were wrong in ways worth naming.** Bars were drawn in a frame
scaled to a rounded-up ceiling, so roughly a third of every chart was
permanently empty; the frame now fits the data. A seven-day window could put
half a play on the axis. The activity heatmap drew days with no plays as solid
black in the light theme. Charts that are not links now brighten on hover like
the ones that are, and a failed comparison request says so instead of quietly
dropping a series and every tile delta.

**You can say which zone counts your days.** Settings, Appearance now has a
timezone picker. The interface always used your device's zone, but anything
asking the API without naming one, a Grafana panel or a script, was answered in
UTC with no way to change that. The row says so plainly, because the two
answers differing is the reason the setting exists.

**Fixes you may feel rather than see.** A disabled control can finally show the
tooltip explaining why it is disabled, which it structurally could not before. A
tap in the corner of a poster no longer marks it watched on a touch screen. The
filter dropdowns keep the keyboard, stay inside the window on a short screen,
and no longer scroll the page behind them. Empty stars, and several other marks,
now meet their contrast floor.

**The README is a shop window again,** and everything it used to spell out (the
API, Grafana and Prometheus, every environment variable, backups,
troubleshooting) is a page under `docs/`.
