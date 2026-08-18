# Changelog

What changed in each release, newest first, in terms of what you would notice.
Releases before 0.4.0 kept their notes on the
[releases page](https://github.com/Spillebulle/Tally/releases) only.

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
