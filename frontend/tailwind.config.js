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
    fontSize: {
      display: ['64px', { lineHeight: '1', letterSpacing: '-2px', fontWeight: '900' }],
      page: ['15px', { lineHeight: '1.35' }],
      heading: ['13px', { lineHeight: '1.35' }],
      body: ['12px', { lineHeight: '1.35' }],
      control: ['11.5px', { lineHeight: '1.35' }],
      small: ['11px', { lineHeight: '1.35' }],
      tiny: ['10.5px', { lineHeight: '1.35' }],
      eyebrow: ['10px', { lineHeight: '1.35', letterSpacing: '2px' }],
    },
    borderRadius: {
      none: '0',
      tight: 'var(--r-tight)', // 3px  keycap, badge, app mark
      ctl: 'var(--r-ctl)', //    5px  button, chip, swatch
      tool: 'var(--r-tool)', //  6px  tool button, well, field
      card: 'var(--r-card)', //  8px  card, tile, menu, popover
      modal: 'var(--r-modal)', //10px dialog, floating panel
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

      // The chrome's fixed sizes, by name, so a strip cannot drift from the
      // guide by a pixel. Usable as height, width and padding alike.
      spacing: {
        menubar: 'var(--h-menubar)', //   34px top bar
        tabstrip: 'var(--h-tabstrip)', // 30px
        toolbar: 'var(--h-toolbar)', //   36px filter strip
        status: 'var(--h-status)', //     26px status/footer
        panelhead: 'var(--h-panelhead)', //32px panel header
        row: 'var(--h-row)', //           26px list row with a picture
        'row-plain': 'var(--h-row-plain)', //20px text-only row
        button: 'var(--h-button)', //     26px
        dropdown: 'var(--h-dropdown)', // 18px
        bottomnav: 'var(--h-bottomnav)', //52px
        sidebar: 'var(--w-sidebar)', //   240px
        panel: 'var(--w-panel)', //       264px
        strip: 'var(--pad-strip)', //     12px, the padding inside every strip
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
