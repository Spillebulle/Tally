/** @type {import('tailwindcss').Config} */

/*
 * Tailwind is a thin naming layer over `src/tokens.css`. Every value here is a
 * `var(--token)`; nothing in this file is a colour, a size or a shadow of its
 * own. See ../docs/interface.md and ../../Design-Principles/STYLE-GUIDE.md.
 *
 * Three scales are *replaced* rather than extended - `fontSize`, `borderRadius`
 * and `boxShadow`. That is deliberate. The guide fixes the type scale at
 * 13/12/11.5/11/10.5, radii at 3/5/6/8/10 and shadows to the four things that
 * float, and leaving Tailwind's defaults in place leaves `text-lg`,
 * `rounded-2xl` and `shadow-md` reachable, which is how the old interface
 * ended up with eleven radii. An unknown utility silently generates nothing,
 * so `npm run check:design` greps for the retired names as well.
 */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    /*
     * Every size is the token, never the number.
     *
     * This is what carries the web scale (STYLE-GUIDE 6.5). `<html class="web">`
     * makes `--text-body` 14px instead of 12, and a `fontSize` stating `12px`
     * here would quietly pin the whole app to the desktop table while the
     * chrome around it grew - which is worse than either scale on its own.
     * The two that do not move are stated flat because they do not move:
     * the wordmark and the eyebrow are the same size in both tables.
     */
    fontSize: {
      display: ['var(--text-display)', { lineHeight: '1', letterSpacing: '-2px', fontWeight: '900' }],
      page: ['var(--text-page)', { lineHeight: 'var(--lh)' }],
      heading: ['var(--text-heading)', { lineHeight: 'var(--lh)' }],
      body: ['var(--text-body)', { lineHeight: 'var(--lh)' }],
      control: ['var(--text-control)', { lineHeight: 'var(--lh)' }],
      small: ['var(--text-small)', { lineHeight: 'var(--lh)' }],
      tiny: ['var(--text-tiny)', { lineHeight: 'var(--lh)' }],
      eyebrow: ['10px', { lineHeight: 'var(--lh)', letterSpacing: '2px' }],
    },
    borderRadius: {
      none: '0',
      tight: 'var(--r-tight)', // 3px  keycap, badge, app mark
      ctl: 'var(--r-ctl)', //    5px  button, chip, swatch
      tool: 'var(--r-tool)', //  6px  tool button, well, field
      card: 'var(--r-card)', //  8px  card, tile, menu, popover
      modal: 'var(--r-modal)', //10px dialog, floating panel
      art: 'var(--r-art)', //    6px  artwork, whatever its size (7.21)
      full: '9999px', //              dots, the toggle pill
    },
    boxShadow: {
      none: 'none',
      menu: 'var(--shadow-menu)',
      float: 'var(--shadow-float)',
      modal: 'var(--shadow-modal)',
      knob: 'var(--shadow-knob)',
    },

    /*
     * The colours text is allowed to be, stated rather than inherited.
     *
     * By default Tailwind builds `text-*` colours from the whole palette, and
     * `text-` is also the prefix of the type scale - so `control` being both a
     * size (11.5px) and a surface (the resting control fill) made
     * `.text-control` emit **both**, with the colour last. Forty-five call
     * sites meant the size; the label on the "New theme" card was painted the
     * control grey on a chrome card and was invisible until somebody read the
     * pixels rather than the markup.
     *
     * So the set is closed here, and it closes honestly: the four ranks of ink,
     * the hint, the accent, the semantic three, the two brand inks, the series
     * for a chart label, and `line-dashed`, which §7.19 puts on an empty
     * state's icon. A surface is not a colour text may be, which is why
     * removing them costs nothing and why nothing in `src` used one.
     *
     * The rule this leaves behind: **a name may be in the type scale or in the
     * text palette, never in both.** Adding `heading` or `body` as a colour
     * would break the same way.
     */
    textColor: {
      inherit: 'inherit',
      current: 'currentColor',
      transparent: 'transparent',
      white: '#ffffff',
      black: '#000000',

      strong: 'var(--text-strong)',
      fg: 'var(--text)',
      muted: 'var(--text-muted)',
      dim: 'var(--text-dim)',
      placeholder: 'var(--placeholder)',

      accent: {
        DEFAULT: 'var(--accent)',
        dim: 'var(--accent-dim)',
        ink: 'var(--accent-ink)',
      },

      caution: 'var(--caution)',
      good: 'var(--good)',
      critical: 'var(--critical)',

      plex: { DEFAULT: 'var(--plex)', ink: 'var(--plex-ink)' },
      'brand-ink': 'var(--brand-ink)',

      /*
       * Text laid on artwork (7.21). Two ranks, and they are the same in both
       * themes: a picture supplies its own contrast, so a pale scrim over it
       * would erase the picture rather than the text. This is the one place
       * the light theme does not lighten, which is why these are their own
       * tokens rather than `strong` and `muted`.
       */
      art: { DEFAULT: 'var(--ink-art)', dim: 'var(--ink-art-dim)' },

      series: {
        1: 'var(--series-1)',
        2: 'var(--series-2)',
        3: 'var(--series-3)',
        4: 'var(--series-4)',
        5: 'var(--series-5)',
        6: 'var(--series-6)',
      },

      // The dashed mark's colour, for the 24px icon on an empty state.
      'line-dashed': 'var(--line-dashed)',
    },
    extend: {
      colors: {
        // Surfaces, darkest behind the work to lightest floating on top.
        backdrop: 'var(--backdrop)',
        window: 'var(--window)',
        dock: 'var(--dock)',
        chrome: 'var(--chrome)',
        popover: 'var(--popover)',

        // Lines. `line` is the hairline; `soft` separates rows inside a list;
        // `popover` edges menus and dialogs; `dashed` is the neutral dashed mark.
        line: {
          DEFAULT: 'var(--line)',
          soft: 'var(--line-soft)',
          popover: 'var(--line-popover)',
          dashed: 'var(--line-dashed)',
        },

        // Controls. `control` is also the selected-row fill.
        control: {
          DEFAULT: 'var(--control)',
          hover: 'var(--control-hover)',
          active: 'var(--control-active)',
        },
        rail: 'var(--rail)',
        knob: 'var(--knob)',
        field: 'var(--field)',

        // Ink, four ranks and a hint. Named so they cannot collide with the
        // `text-*` size utilities above: text-strong / text-fg / text-muted /
        // text-dim / text-placeholder.
        strong: 'var(--text-strong)',
        fg: 'var(--text)',
        muted: 'var(--text-muted)',
        dim: 'var(--text-dim)',
        placeholder: 'var(--placeholder)',

        accent: {
          DEFAULT: 'var(--accent)',
          dim: 'var(--accent-dim)',
          ink: 'var(--accent-ink)',
          tint: 'var(--accent-tint)',
          ring: 'var(--accent-ring)',
        },

        // State only, never decoration, never the accent.
        caution: {
          DEFAULT: 'var(--caution)',
          bg: 'var(--caution-bg)',
          line: 'var(--caution-line)',
        },
        good: { DEFAULT: 'var(--good)', bg: 'var(--good-bg)' },
        critical: {
          DEFAULT: 'var(--critical)',
          bg: 'var(--critical-bg)',
          line: 'var(--critical-line)',
        },

        /*
         * The scrims that go under text on artwork (7.21). Black in both
         * themes, for the reason in `art` above. `--scrim-art` is the bottom
         * gradient and is a background-image rather than a colour, so it is
         * `.scrim-art` in index.css; this one is the even wash.
         */
        'scrim-flat': 'var(--scrim-flat)',
        'ink-art': { DEFAULT: 'var(--ink-art)', dim: 'var(--ink-art-dim)' },

        // The logo mark's ink. One colour in every theme, because the mark is
        // artwork rather than text. See theme-tally.css.
        'brand-ink': 'var(--brand-ink)',

        // Plex's own yellow. The one brand colour Tally does not restyle, and
        // it goes on the Plex badge and nowhere else.
        plex: { DEFAULT: 'var(--plex)', ink: 'var(--plex-ink)' },

        series: {
          1: 'var(--series-1)',
          2: 'var(--series-2)',
          3: 'var(--series-3)',
          4: 'var(--series-4)',
          5: 'var(--series-5)',
          6: 'var(--series-6)',
        },
        grid: 'var(--grid)',
        // Sequential ramp for the heatmap. Zero is `control`, not heat-1.
        heat: {
          1: 'var(--heat-1)',
          2: 'var(--heat-2)',
          3: 'var(--heat-3)',
          4: 'var(--heat-4)',
          5: 'var(--heat-5)',
        },
      },

      fontFamily: {
        sans: ['Archivo', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        // Every figure that is read as a value. Tabular, so a changing number
        // does not jitter its column.
        mono: [
          'ui-monospace',
          'Cascadia Mono',
          'JetBrains Mono',
          'SF Mono',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },

      /*
       * The chrome's fixed sizes, by name, so a strip cannot drift from the
       * guide by a pixel. Usable as height, width and padding alike.
       *
       * The numbers in the comments are the *desktop* table. Tally stamps
       * `class="web"` (STYLE-GUIDE 6.5), so what actually renders is the web
       * column beside it - the token is the same either way, which is the
       * point: a component asks for `h-button` and never asks which scale it
       * is on.
       */
      spacing: {
        menubar: 'var(--h-menubar)', //   34 -> 52  top bar
        tabstrip: 'var(--h-tabstrip)', // 30 -> 38
        toolbar: 'var(--h-toolbar)', //   36 -> 44  filter strip
        status: 'var(--h-status)', //     26 -> 32  status/footer
        panelhead: 'var(--h-panelhead)', //32 -> 40 panel header
        row: 'var(--h-row)', //           26 -> 32  list row with a picture
        'row-plain': 'var(--h-row-plain)', //20 -> 26 text-only row
        nav: 'var(--h-nav)', //           30 -> 38  sidebar navigation row
        button: 'var(--h-button)', //     26 -> 32
        field: 'var(--h-field)', //       26 -> 32  text field, search well
        dropdown: 'var(--h-dropdown)', // 18 -> 22
        bottomnav: 'var(--h-bottomnav)', //52 -> 56
        sidebar: 'var(--w-sidebar)', //   240 -> 280
        panel: 'var(--w-panel)', //       264 -> 300
        strip: 'var(--pad-strip)', //     12 -> 16, the padding inside every strip
        mark: 'var(--mark)', //           15 -> 22  the app mark in the top bar
        icon: 'var(--icon)', //           16 -> 18  icon in a row or a button
        'icon-lg': 'var(--icon-lg)', //   20 -> 22  icon in a panel header

        /*
         * The artwork ladder (7.21). Four widths and no fifth, plus the
         * avatar. Written as widths, because artwork is sized by its width and
         * takes its height from `aspect-art` (portrait 2/3) or `aspect-wide`
         * (landscape 16/9); a picture is never stretched into a box of the
         * other shape.
         */
        'art-row': 'var(--art-row)', //   40 -> 48   landscape, inline in a row
        'art-tile': 'var(--art-tile)', // 100 -> 120 a picture beside text
        'art-card': 'var(--art-card)', // 150 -> 180 the browse card
        'art-hero': 'var(--art-hero)', // 260 -> 320 one per detail page
        avatar: 'var(--avatar)', //       28 -> 36   a person, round
      },

      aspectRatio: {
        // Portrait artwork. The token, so the shape is stated once (7.21).
        art: 'var(--art-ratio)',
        // Landscape artwork: stills, backdrops, the inline row thumb.
        wide: '16 / 9',
      },

      borderWidth: { DEFAULT: '1px', 0: '0', 2: '2px' },

      transitionTimingFunction: { ease: 'var(--ease)' },
      transitionDuration: { hover: '80ms', open: '160ms' },

      keyframes: {
        // The one permitted indeterminate animation: a third-width bar
        // travelling the whole track, only where the total cannot be known.
        'progress-slide': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        // A menu appears with a 4px rise; nothing bounces, nothing pulses.
        rise: {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'progress-slide': 'progress-slide 1.4s cubic-bezier(0.65, 0, 0.35, 1) infinite',
        shimmer: 'shimmer 1.6s infinite',
        rise: 'rise 160ms var(--ease) both',
      },
    },
  },
  plugins: [],
}
