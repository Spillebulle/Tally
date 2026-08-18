#!/usr/bin/env node
/*
 * The design rules that a type checker cannot see.
 *
 * Tailwind silently generates *nothing* for a utility it does not know, so a
 * retired class name (`rounded-2xl`, `text-sm`, `bg-surface`) does not fail the
 * build - it just stops styling the element, and the element quietly falls back
 * to whatever it inherits. The same is true of an opacity modifier on a
 * token colour: `bg-accent/25` emits no rule at all, because the colour is a
 * `var(--accent)` and Tailwind cannot compose alpha into it.
 *
 * So the rules below are checked here rather than trusted. Run:
 *
 *     npm run check:design
 *
 * Each finding prints file:line and the rule it broke. See
 * ../../docs/interface.md and ../../../Design-Principles/STYLE-GUIDE.md.
 */
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(root, 'src')

/* Files that are allowed to name colours directly: the token layer itself,
   and the rating certificate artwork, which is other people's marks redrawn
   and has to keep their colours. */
const EXEMPT = [
  join('src', 'tokens.css'),
  join('src', 'theme-tally.css'),
  join('src', 'assets') + sep,
]

/*
 * A single line may opt out, and must say why:
 *
 *     // design-check-allow raw-colour: the board prints this exact green.
 *
 * On the line itself or the line above it. A blanket file exemption hides the
 * next violation somebody adds to that file; a line exemption cannot.
 */
const ALLOW = /design-check-allow\s+([a-z-]+)\s*:/g

function allowancesFor(source) {
  const lines = source.split('\n')
  const allowed = new Map() // line number (1-based) -> Set of rule ids
  lines.forEach((text, i) => {
    ALLOW.lastIndex = 0
    let m
    while ((m = ALLOW.exec(text))) {
      for (const n of [i + 1, i + 2]) {
        if (!allowed.has(n)) allowed.set(n, new Set())
        allowed.get(n).add(m[1])
      }
    }
  })
  return allowed
}

const TOKEN_COLOURS =
  '(?:backdrop|window|dock|chrome|popover|line|control|rail|knob|field|strong|fg|muted|dim|placeholder|accent|caution|good|critical|plex|grid|series-[1-6]|heat-[1-5]|art|ink-art|scrim-flat)'

const RULES = [
  {
    id: 'raw-colour',
    // A hex, rgb() or oklch() literal written into a component.
    re: /(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\boklch\(|\bhsla?\()/g,
    why: 'Never a raw colour in a component. Add a token to theme-tally.css and name the role.',
  },
  {
    id: 'alpha-on-token',
    // `bg-accent/25` and friends emit no CSS at all.
    re: new RegExp(
      `\\b(?:bg|text|border|fill|stroke|ring|divide|from|via|to|shadow)-${TOKEN_COLOURS}(?:-[a-z]+)?\\/\\d+`,
      'g',
    ),
    why: 'An opacity modifier on a token colour generates nothing. Use a token (accent-tint, accent-ring, *-bg) or color-mix in index.css.',
  },
  {
    id: 'retired-radius',
    re: /\brounded(?:-[trbl]{1,2})?-(?:sm|md|lg|xl|2xl|3xl)\b/g,
    why: 'Radii are tight/ctl/tool/card/modal (3/5/6/8/10) and full. Nothing else exists.',
  },
  {
    id: 'retired-type',
    re: /\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)\b/g,
    why: 'The type scale is display/page/heading/body/control/small/tiny/eyebrow.',
  },
  {
    id: 'retired-shadow',
    re: /\bshadow-(?:sm|md|lg|xl|2xl|inner|card|lift|glow)\b/g,
    why: 'Only things that float cast a shadow: shadow-menu, shadow-float, shadow-modal, shadow-knob.',
  },
  {
    id: 'retired-colour',
    re: /\b(?:bg|text|border|from|via|to|ring|fill|stroke)-(?:surface|raised|canvas|ink|subtle|warn|danger|line-accent(?:-soft)?|accent-soft)\b/g,
    why: 'Old token names. Map to the house roles: surface->chrome, raised->control, canvas->backdrop, ink->strong, subtle->fg, warn->caution, danger->critical, accent-soft->accent-tint.',
  },
  {
    id: 'retired-class',
    // Classes that used to exist in index.css. A class naming nothing renders
    // nothing, silently - the same failure as a retired utility.
    re: /\b(?:hero-scrim)\b/g,
    why: 'Retired component class. The backdrop ramp is `.fade-backdrop` now (7.22).',
  },
  {
    id: 'off-ladder-art',
    // Artwork is four widths and no fifth (7.21), and two shapes.
    re: /\baspect-\[\s*(?:2\s*\/\s*3|16\s*\/\s*9)\s*\]/g,
    why: 'Artwork shape is `aspect-art` (portrait 2/3) or `aspect-wide` (16/9), from --art-ratio.',
  },
  {
    id: 'grey-scale',
    re: /\b(?:bg|text|border|ring|fill|stroke|divide)-(?:gray|slate|zinc|neutral|stone|red|blue|green|yellow|amber|orange|emerald|indigo|violet|purple|pink)-\d{2,3}\b/g,
    why: 'Tailwind palette colours are not in the language. Name a role.',
  },
  {
    id: 'font-weight',
    re: /\bfont-(?:thin|extralight|light|medium|bold|extrabold|black)\b/g,
    why: 'Two weights in the interface: normal (400) and semibold (600). 900 belongs to the wordmark alone.',
  },
  {
    id: 'em-dash',
    // Only in strings a user reads. Comments are prose and may use them.
    re: /—/g,
    why: 'No em dashes in user-facing text. Full stop and a new sentence.',
    codeOnly: true,
  },
]

/** Strip block and line comments so prose in a comment is not flagged. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '))
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (/\.(tsx?|css|html)$/.test(entry.name)) yield full
  }
}

const findings = []

for await (const file of walk(SRC)) {
  const rel = relative(root, file)
  if (EXEMPT.some((e) => rel.startsWith(e) || rel === e)) continue
  const raw = readFileSync(file, 'utf8')
  const stripped = withoutComments(raw)
  const allowed = allowancesFor(raw)
  for (const rule of RULES) {
    // Comments are prose: they may use an em dash and may quote a hex while
    // explaining one. Class names are matched in the raw source, because a
    // class inside a template string is still a class.
    const hay = rule.codeOnly || rule.id === 'raw-colour' ? stripped : raw
    rule.re.lastIndex = 0
    let m
    while ((m = rule.re.exec(hay))) {
      const line = hay.slice(0, m.index).split('\n').length
      if (allowed.get(line)?.has(rule.id)) continue
      findings.push({ rel, line, rule: rule.id, text: m[0].trim(), why: rule.why })
    }
  }
}

if (findings.length === 0) {
  console.log('check:design - clean.')
  process.exit(0)
}

const byRule = new Map()
for (const f of findings) {
  if (!byRule.has(f.rule)) byRule.set(f.rule, [])
  byRule.get(f.rule).push(f)
}

for (const [rule, list] of byRule) {
  console.log(`\n${rule} (${list.length})\n  ${list[0].why}`)
  for (const f of list.slice(0, 40)) {
    console.log(`  ${f.rel}:${f.line}  ${f.text}`)
  }
  if (list.length > 40) console.log(`  ... and ${list.length - 40} more`)
}

console.log(`\n${findings.length} findings.`)
process.exit(1)
