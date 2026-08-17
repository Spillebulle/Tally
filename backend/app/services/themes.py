"""The `.umbertheme` format: reading it, writing it, and deriving from it.

STYLE-GUIDE §3.2 is the specification and this module is a transcription of it,
not an interpretation. The point of the format is that a theme somebody makes in
Umber opens in Tally unchanged and one made here opens in Umber, so wherever
fidelity and convenience disagreed, fidelity won — see the notes on each rule
below, which record the places that was a real choice.

Nothing here knows about HTTP or about the filesystem. It is handed text and it
answers with a theme; `theme_library` owns where the text came from and what it
is called, and `routers/themes.py` owns the wire. One decoder and one encoder,
because §3.2's "the interchange format is the storage format" only holds if
there is exactly one of each.

A theme carries **twenty-seven** colours. Everything else in `tokens.css` is
derived from them — five values here, and the rest by `color-mix()` in the
stylesheet itself, which resolves where it is *used* and therefore follows a
custom theme without anybody computing it. See `docs/themes.md`.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

# --- the format -----------------------------------------------------------

#: The first line of every theme file. Matched case-insensitively, with a
#: byte-order mark ignored. The *header* decides whether a file is a theme —
#: not the extension — because import is handed whatever the file dialog
#: returned, and a text file that is not a theme has to be refused with a
#: sentence rather than read as a theme of entirely default colours.
HEADER = "Umber theme"

EXTENSION = ".umbertheme"

#: The twenty-seven shared keys, in file order, which is also the order the
#: editor draws them. Four of them are deliberately not their `tokens.css`
#: names: the stored word may never be reworded, so `border`, `popover_border`,
#: `warning*` and `link_*` stay as Umber first wrote them.
KEYS: tuple[str, ...] = (
    # Surfaces
    "backdrop",
    "window",
    "dock",
    "chrome",
    "popover",
    # Lines
    "border",
    "popover_border",
    # Controls
    "control",
    "control_hover",
    "control_active",
    "rail",
    "knob",
    # Type
    "text_strong",
    "text",
    "text_muted",
    "text_dim",
    # Accent
    "accent",
    "accent_dim",
    # Warnings
    "warning",
    "warning_bg",
    "warning_border",
    # Link colours (the chart series)
    "link_1",
    "link_2",
    "link_3",
    "link_4",
    "link_5",
    "link_6",
)

KEY_SET = frozenset(KEYS)

#: File key → the CSS custom property it fills.
CSS_NAMES: dict[str, str] = {
    "backdrop": "--backdrop",
    "window": "--window",
    "dock": "--dock",
    "chrome": "--chrome",
    "popover": "--popover",
    "border": "--line",
    "popover_border": "--line-popover",
    "control": "--control",
    "control_hover": "--control-hover",
    "control_active": "--control-active",
    "rail": "--rail",
    "knob": "--knob",
    "text_strong": "--text-strong",
    "text": "--text",
    "text_muted": "--text-muted",
    "text_dim": "--text-dim",
    "accent": "--accent",
    "accent_dim": "--accent-dim",
    "warning": "--caution",
    "warning_bg": "--caution-bg",
    "warning_border": "--caution-line",
    "link_1": "--series-1",
    "link_2": "--series-2",
    "link_3": "--series-3",
    "link_4": "--series-4",
    "link_5": "--series-5",
    "link_6": "--series-6",
}

#: A name ends up on a card that has to be laid out every frame, so the bound
#: is not decoration. §3.2 sets it at 64 characters, in both directions.
NAME_MAX = 64

#: The filename stem, and therefore the id, is cut to this.
SLUG_MAX = 48

FALLBACK_NAME = "Untitled theme"
FALLBACK_SLUG = "theme"

#: An id the reader does not know falls back to this one.
DEFAULT_BASE = "graphite"


class ThemeFormatError(ValueError):
    """The bytes handed in are not a theme file."""


# --- colour ---------------------------------------------------------------

_HEX6 = re.compile(r"#?([0-9a-fA-F]{6})\Z")
_HEX3 = re.compile(r"#([0-9a-fA-F]{3})\Z")


def parse_colour(raw: str) -> str | None:
    """`#RRGGBB`, `RRGGBB` or `#RGB` as `#RRGGBB`, or None.

    Those three spellings and nothing else. `#RRGGBBAA` is refused rather than
    truncated, because §3.2 says **no alpha, ever**: every token is drawn as an
    opaque fill or an opaque stroke, and the places that want one faded ask for
    that at the call site. A named colour, an `rgb()` or a typo is refused too —
    anything else is refused rather than guessed, since a theme that quietly
    took black for a misread line would be a theme with an invisible interface
    in it.
    """
    value = raw.strip()
    if not value:
        return None
    short = _HEX3.match(value)
    if short:
        r, g, b = short.group(1)
        return f"#{r}{r}{g}{g}{b}{b}".upper()
    long = _HEX6.match(value)
    if long:
        return f"#{long.group(1).upper()}"
    return None


def _srgb_to_linear(channel: int) -> float:
    c = channel / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _linear_to_srgb(value: float) -> int:
    c = 12.92 * value if value <= 0.0031308 else 1.055 * (value ** (1 / 2.4)) - 0.055
    return round(min(1.0, max(0.0, c)) * 255)


def _to_oklab(hex_colour: str) -> tuple[float, float, float]:
    digits = hex_colour.lstrip("#")
    r, g, b = (_srgb_to_linear(int(digits[i : i + 2], 16)) for i in (0, 2, 4))
    long_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    med = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    short = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = long_ ** (1 / 3), med ** (1 / 3), short ** (1 / 3)
    return (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )


def _from_oklab(lab: tuple[float, float, float]) -> str:
    lightness, a, b = lab
    l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
    m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
    s_ = lightness - 0.0894841775 * a - 1.2914855480 * b
    long_, med, short = l_**3, m_**3, s_**3
    r = 4.0767416621 * long_ - 3.3077115913 * med + 0.2309699292 * short
    g = -1.2684380046 * long_ + 2.6097574011 * med - 0.3413193965 * short
    blue = -0.0041960863 * long_ - 0.7034186147 * med + 1.7076147010 * short
    return f"#{_linear_to_srgb(r):02X}{_linear_to_srgb(g):02X}{_linear_to_srgb(blue):02X}"


def mix(start: str, end: str, fraction: float) -> str:
    """`start` `fraction` of the way to `end`.

    **In Oklab, not sRGB**, and that is the whole reason the conversion above
    exists rather than a three-line channel average. Two reasons, one of
    principle and one measured:

    * `tokens.css` writes every one of its own mixes as
      `color-mix(in oklab, …)`, and §2 states the whole neutral ladder in
      OKLCH. A derivation done in a different space is a colour nobody chose,
      and would put the value Tally computes for a custom theme in a different
      place from the value the browser computes for the shipped one.
    * It lands closer to the authored built-ins. Deriving `--line-soft`,
      `--line-dashed` and `--placeholder` from Graphite's and Paper's own
      twenty-seven reproduces the hand-picked values in `tokens.css` to within
      a couple of steps per channel in Oklab, and consistently further out in
      sRGB (`#404246` against the authored `#3A3D42`, versus sRGB's `#424448`).

    Hue interpolation is not a question here: every mix in §3.2's table is
    between two near-neutrals, and Oklab's rectangular form cannot take the
    long way round a hue circle the way OKLCH can.
    """
    a = _to_oklab(start)
    b = _to_oklab(end)
    return _from_oklab(tuple(x + (y - x) * fraction for x, y in zip(a, b, strict=True)))


# --- names and ids --------------------------------------------------------


def bound_name(raw: str | None, *, stem: str | None = None) -> str:
    """A theme name, held to §3.2's bound.

    Control characters become spaces, the result is trimmed and cut to 64. A
    blank or absent name falls back to the file's own stem, and then to
    `Untitled theme`.

    The trim is repeated after the cut, which §3.2 does not spell out: without
    it a 65-character name whose 64th character is a space would encode with a
    trailing space and decode a character shorter, and a format whose own
    output does not round-trip is not an interchange format.
    """
    cleaned = ""
    if raw:
        cleaned = "".join(ch if ch.isprintable() else " " for ch in raw)
        cleaned = cleaned.strip()[:NAME_MAX].strip()
    if cleaned:
        return cleaned
    if stem:
        from_stem = "".join(ch if ch.isprintable() else " " for ch in stem)
        from_stem = from_stem.strip()[:NAME_MAX].strip()
        if from_stem:
            return from_stem
    return FALLBACK_NAME


def slugify(name: str) -> str:
    """The filename stem for a theme called `name`, before uniquing.

    Lower-cased, runs of non-alphanumerics collapsed to `-`, trimmed, cut to 48,
    `theme` if nothing survives.

    "Alphanumeric" is read as ASCII alphanumeric, after stripping accents: a
    stem is a filename, and macOS stores one decomposed while Linux stores it
    as written, so a non-ASCII id would compare equal on one machine and not on
    another — and the id is what the preferences file points at. "Café noir"
    becomes `cafe-noir` rather than `caf-noir`, which is what makes the
    restriction cost nothing.
    """
    folded = unicodedata.normalize("NFKD", name)
    stripped = "".join(ch for ch in folded if not unicodedata.combining(ch))
    slug = re.sub(r"[^a-z0-9]+", "-", stripped.lower()).strip("-")
    slug = slug[:SLUG_MAX].strip("-")
    return slug or FALLBACK_SLUG


def unique_slug(name: str, taken: set[str] | frozenset[str]) -> str:
    """`slugify(name)`, plus a number if that stem is already taken.

    A name already in the library gets a number rather than replacing a theme
    somebody built. The stem is shortened to keep the suffix inside the 48
    characters, so a very long name cannot produce two ids that truncate to one.
    """
    stem = slugify(name)
    if stem not in taken:
        return stem
    for n in range(2, 1000):
        suffix = f"-{n}"
        candidate = f"{stem[: SLUG_MAX - len(suffix)].strip('-') or FALLBACK_SLUG}{suffix}"
        if candidate not in taken:
            return candidate
    raise ValueError("Too many themes with that name")


# --- the theme ------------------------------------------------------------


@dataclass
class Theme:
    """One theme: an id, a name, a base, and the complete twenty-seven.

    `colours` is always complete, whatever the file held. §3.2 puts it that way
    round — "`base` decides which built-in fills every token the file does not
    carry" — so absent keys are resolved at decode time and every later step
    (the editor, the resolver, the encoder) can assume a full table. A file
    hand-trimmed to the six colours somebody cared about is still a legal theme;
    it simply decodes to twenty-seven.
    """

    id: str
    name: str
    base: str
    colours: dict[str, str] = field(default_factory=dict)
    builtin: bool = False

    @property
    def dark(self) -> bool:
        """Whether this theme is dark.

        **Stated rather than measured off its colours.** A theme edited into the
        opposite lightness must not change what its authored derivation was, so
        this is a question about `base` and only about `base`.
        """
        return is_dark(self.base)


@dataclass(frozen=True)
class DecodeResult:
    theme: Theme
    #: How many lines carried a setting this build could not use. An import
    #: that loses something must say so.
    skipped: int


# --- the built-ins --------------------------------------------------------

# Graphite and Paper, compiled in, exactly as `frontend/src/tokens.css` and
# `frontend/src/theme-tally.css` author them. They are *not* files and are never
# written to the library directory: anything the user decides about a shipped
# item cannot be written where the shipped item is, or an update replaces it
# wholesale and the choice vanishes silently, months later.
#
# The hexes are the OKLCH values in those files converted to sRGB, and each one
# that the stylesheet also states as a hex comment agrees with it exactly — the
# conversion was checked against all thirty-two of them rather than trusted.
# `control_active` is the one accent leak in the neutral ladder,
# `oklch(0.29 0.012 H)` / `oklch(0.909 0.020 H)` at Tally's hue 255.
#
# `accent`, `accent_dim`, `link_1` and `link_3` come from `theme-tally.css`
# rather than the house file, because that is what Tally actually renders: the
# accent is pinned to Tally's blue (a deliberate, documented deviation from the
# house formula) and series 1 and 3 are swapped so no chart series collides with
# it. A "copy of Graphite" that came out ochre would not be a copy of what the
# user is looking at.
#
# Where a built-in disagrees with a derivation rule, the built-in is right and
# stays as written (§3.2).

GRAPHITE: dict[str, str] = {
    "backdrop": "#0D0E10",
    "window": "#111214",
    "dock": "#141517",
    "chrome": "#17181A",
    "popover": "#1B1C1F",
    "border": "#26282B",
    "popover_border": "#2C2E32",
    "control": "#1F2023",
    "control_hover": "#26282B",
    "control_active": "#272C31",
    "rail": "#26282B",
    "knob": "#E6E7E9",
    "text_strong": "#E6E7E9",
    "text": "#C9CBCE",
    "text_muted": "#9A9DA2",
    "text_dim": "#84878C",
    "accent": "#3987E5",
    "accent_dim": "#2C5589",
    "warning": "#D08770",
    "warning_bg": "#2A1D18",
    "warning_border": "#6E4034",
    "link_1": "#A96BE8",
    "link_2": "#46B04A",
    "link_3": "#3F7BE8",
    "link_4": "#1FB5B5",
    "link_5": "#EE5AA8",
    "link_6": "#F0D53C",
}

PAPER: dict[str, str] = {
    "backdrop": "#E4E0D9",
    "window": "#EFECE7",
    "dock": "#F2EFEA",
    "chrome": "#F7F5F1",
    "popover": "#FFFFFF",
    "border": "#DEDAD3",
    "popover_border": "#DEDAD3",
    "control": "#EAE7E1",
    "control_hover": "#E0DCD5",
    "control_active": "#D8E2EE",
    "rail": "#DEDAD3",
    "knob": "#FFFFFF",
    "text_strong": "#3A3836",
    "text": "#3A3836",
    "text_muted": "#6D6A66",
    "text_dim": "#8D8A85",
    "accent": "#2769B7",
    "accent_dim": "#A5BDDB",
    "warning": "#9E4E33",
    "warning_bg": "#F7E9E2",
    "warning_border": "#DFC1B0",
    "link_1": "#7742AE",
    "link_2": "#2E7C33",
    "link_3": "#2A5AB4",
    "link_4": "#137F7F",
    "link_5": "#B0326E",
    "link_6": "#7E760A",
}


@dataclass(frozen=True)
class Builtin:
    id: str
    label: str
    dark: bool
    colours: dict[str, str]


#: The family's two, under exactly the ids §3.2 names. An app with more presets
#: adds its own; Tally has none. The ids are stored words, chosen once and never
#: reworded — deliberately not the label lower-cased, because a label is what
#: the interface shows and is free to change.
BUILTINS: dict[str, Builtin] = {
    "graphite": Builtin("graphite", "Graphite", True, GRAPHITE),
    "paper": Builtin("paper", "Paper", False, PAPER),
}


def is_dark(base: str) -> bool:
    """Whether `base` names a dark theme. An unknown base is Graphite's."""
    return BUILTINS.get(base, BUILTINS[DEFAULT_BASE]).dark


def base_colours(base: str) -> dict[str, str]:
    """The table a theme naming `base` falls back to, dict-copied."""
    return dict(BUILTINS.get(base, BUILTINS[DEFAULT_BASE]).colours)


def builtin_theme(theme_id: str) -> Theme | None:
    """One of the compiled-in themes, or None."""
    preset = BUILTINS.get(theme_id)
    if preset is None:
        return None
    return Theme(
        id=preset.id,
        name=preset.label,
        base=preset.id,
        colours=dict(preset.colours),
        builtin=True,
    )


# --- decoding -------------------------------------------------------------


def decode(text: str, *, theme_id: str = "", stem: str | None = None) -> DecodeResult:
    """Read a `.umbertheme`, or refuse it.

    Raises `ThemeFormatError` when the first line is not the header. That
    refusal is the format's own rule and is load-bearing: without it any text
    file at all imports as "a theme of entirely default colours", which looks
    like a successful import of something that will never be what the user
    meant.

    `stem` is the file's own name without its extension, used only as the
    fallback when the file carries no usable `name`. Nothing here reads the
    filesystem; the caller has already been to it.

    **`base` is read in a first pass and the colours in a second**, so the order
    somebody's editor left the lines in cannot decide what the absent tokens
    fall back to.
    """
    body = _body(text)

    base = DEFAULT_BASE
    for key, value in _settings(body):
        if key == "base":
            candidate = value.strip().lower()
            # An id the reader does not know falls back to graphite. It is not
            # counted as a skipped line: falling back is the specified answer,
            # not a loss, and the file keeps its own word for it on the way out.
            base = candidate or DEFAULT_BASE
            break

    colours = base_colours(base)
    name_raw: str | None = None
    skipped = 0

    for key, value in _settings(body):
        if key == "base":
            continue
        if key == "name":
            name_raw = value
            continue
        if key not in KEY_SET:
            # A key this build does not have costs that one colour and nothing
            # else — the base's value stands. This is the tolerance the format
            # is built on: it is how a file written by a newer build still opens
            # in an older one.
            skipped += 1
            continue
        parsed = parse_colour(value)
        if parsed is None:
            skipped += 1
            continue
        colours[key] = parsed

    return DecodeResult(
        theme=Theme(
            id=theme_id,
            name=bound_name(name_raw, stem=stem),
            # Kept as written, even when unknown, so a file naming a base this
            # build lacks is not silently rewritten into one it has. `is_dark`
            # and `base_colours` do the falling back, at the point of use.
            base=base,
            colours=colours,
        ),
        skipped=skipped,
    )


def _body(text: str) -> list[str]:
    """Every line after the header, or `ThemeFormatError`."""
    lines = text.lstrip("﻿").splitlines()
    first = lines[0].strip() if lines else ""
    if first.casefold() != HEADER.casefold():
        raise ThemeFormatError(
            f"That file does not start with “{HEADER}”, so it is not a theme file."
        )
    return lines[1:]


def _settings(body: list[str]) -> list[tuple[str, str]]:
    """The `key = value` lines, keys lower-cased, both sides trimmed.

    A blank line, a line starting with `#`, and a line with no `=` are all
    skipped — and skipped *silently*, because §3.2 lists all three as ordinary
    grammar rather than as damage. Only a line that names a setting and fails to
    deliver one is counted against the import, which is what makes the sentence
    the user is shown ("N line(s) could not be read, so those colours came from
    the theme it names as its base") true rather than merely arithmetic.
    """
    out: list[tuple[str, str]] = []
    for line in body:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        out.append((key.strip().lower(), value.strip()))
    return out


# --- encoding -------------------------------------------------------------


def encode(theme: Theme) -> str:
    """A theme as the bytes of a `.umbertheme` file.

    The header, `name`, `base`, then **every one of the twenty-seven keys in
    §3.2's order, always** — even where the value equals the base's — so what
    leaves the app is complete and legible.

    Nothing else is written: no blank lines, no group comments, no trailing
    commentary. All three would be legal (a reader skips them), and a comment
    per group would read nicely — but a reader that counts every line it skipped
    would then report a file Tally wrote as one it could not fully read. The
    format's tolerance is for other people's files, not something to spend on
    decoration.
    """
    colours = {**base_colours(theme.base), **theme.colours}
    lines = [HEADER, f"name = {bound_name(theme.name)}", f"base = {theme.base}"]
    lines.extend(f"{key} = {colours[key]}" for key in KEYS)
    return "\n".join(lines) + "\n"


# --- derivation -----------------------------------------------------------


def resolve(theme: Theme) -> dict[str, str]:
    """The CSS custom properties a browser needs, as name → opaque colour.

    The twenty-seven under their token names, plus the five values `tokens.css`
    states literally rather than as a `color-mix`. Nothing else: a custom
    property defined as a mix of other custom properties resolves where it is
    *used*, so `--accent-tint`, `--accent-ring`, `--grid`, `--scrim`,
    `--critical-line` and Tally's `--heat-1..5` all follow a custom theme
    without being computed for it. Sending them would create a second, stale
    copy of a value the stylesheet already has right.

    `--good` and `--critical` (and their `-bg`) are not themeable per §3.2, and
    `--area-alpha` is a constant, so they are not sent either.
    """
    colours = {**base_colours(theme.base), **theme.colours}
    out = {CSS_NAMES[key]: colours[key] for key in KEYS}
    out.update(derived(colours, dark=theme.dark))
    return out


def derived(colours: dict[str, str], *, dark: bool) -> dict[str, str]:
    """§3.2's derivation table, for the five values that are not `color-mix`."""
    return {
        "--line-soft": mix(colours["border"], colours["window"], 0.40),
        "--line-dashed": mix(colours["border"], colours["text_dim"], 0.30),
        "--placeholder": mix(colours["text_dim"], colours["window"], 0.30),
        # `--field` and `--accent-ink` are a choice between two of the stored
        # colours rather than a mix, and which one is a question about the
        # theme's *base*, not about how light its surfaces have been edited to.
        "--field": colours["dock"] if dark else colours["popover"],
        "--accent-ink": colours["window"] if dark else colours["popover"],
    }
