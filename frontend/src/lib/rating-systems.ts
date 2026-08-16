/**
 * Content ratings drawn the way the boards themselves draw them.
 *
 * `certificates.ts` answers "how is this certificate *written*". This answers
 * "what does it *look* like" — a BBFC 15 is a pink circle, an FSK 16 a blue
 * square, a TV-MA a black box. Boards publish a mark rather than a word for a
 * reason: `12`, `15` and `18` are indistinguishable from years and runtimes as
 * plain text, and the mark is what a viewer already recognises at a glance.
 *
 * ## This never touches a query
 *
 * Same rule as `certificates.ts`, and for the same reason: the raw string is
 * the identity of the facet. Everything here is display, keyed off the raw
 * value but never replacing it.
 *
 * ## Why the colours are literal hex
 *
 * The house rule is that a colour is a semantic token that shifts with the
 * theme. These are the opposite: they are other organisations' marks, and a
 * BBFC 15 that turned a different pink in dark mode would no longer be the
 * thing it is quoting. They are fixed on purpose, they carry their own ink
 * colour so contrast holds on any surface, and they live in this table rather
 * than in a component so no component holds a hex.
 *
 * ## Two tiers, and the difference is deliberate
 *
 * **Tier one** — BBFC, MPA, US TV, FSK — is drawn to the board's published
 * shape and colour, because those four cover the overwhelming majority of what
 * Plex agents actually attach and their marks are well enough documented to
 * quote. Colours are matched to the published marks by eye, not sampled from
 * official artwork; they read correctly but are not colour-exact.
 *
 * **Tier two** is any other `<country>/<age>` certificate — Norway, the
 * Netherlands, France, Australia and the rest. Those get a plain age disc on
 * one consistent ramp, with the country kept beside it. That is Tally showing
 * an age rating, *not* a claim to reproduce that board's mark, which is the
 * honest option: inventing a brand colour per board would produce a dozen
 * confident, wrong logos. Adding a board to tier one is one table entry.
 *
 * Anything that is not a recognised mark and not an age at all — `NR`,
 * `Approved`, `Unrated` — resolves to `null` and the caller falls back to the
 * plain boxed text, so nothing is ever dropped for want of a picture.
 */
import { splitCertificate } from './certificates'

export type BadgeShape = 'triangle' | 'circle' | 'square' | 'card' | 'tv'

export interface RatingMark {
  /** What is drawn inside the mark. */
  text: string
  shape: BadgeShape
  /** Ground colour. Fixed — see the note above. */
  fill: string
  /** Text colour, chosen against `fill`. */
  ink: string
  /** An edge, where the ground alone would not read against the page. */
  edge?: string
  /** Named in full, for the tooltip and for assistive tech. */
  title: string
}

/**
 * BBFC (UK). Shapes are not decorative and not interchangeable: U and PG are
 * triangles, the age categories circles, R18 a square. Current marks, in
 * cinemas from October 2019.
 */
const BBFC: Record<string, RatingMark> = {
  U: { text: 'U', shape: 'triangle', fill: '#00A650', ink: '#FFFFFF', title: 'BBFC U — Universal' },
  PG: { text: 'PG', shape: 'triangle', fill: '#FFC20E', ink: '#1A1A1A', title: 'BBFC PG — Parental Guidance' },
  '12A': { text: '12A', shape: 'circle', fill: '#F58220', ink: '#FFFFFF', title: 'BBFC 12A' },
  '12': { text: '12', shape: 'circle', fill: '#F58220', ink: '#FFFFFF', title: 'BBFC 12' },
  '15': { text: '15', shape: 'circle', fill: '#EC008C', ink: '#FFFFFF', title: 'BBFC 15' },
  '18': { text: '18', shape: 'circle', fill: '#ED1C24', ink: '#FFFFFF', title: 'BBFC 18' },
  R18: { text: 'R18', shape: 'square', fill: '#0072BC', ink: '#FFFFFF', title: 'BBFC R18' },
}

/**
 * MPA (US theatrical). The mark is monochrome by design — a bordered white
 * card — so it keeps its own light ground in dark mode rather than inverting.
 */
const MPA_TITLES: Record<string, string> = {
  G: 'MPA G — General Audiences',
  PG: 'MPA PG — Parental Guidance Suggested',
  'PG-13': 'MPA PG-13 — Parents Strongly Cautioned',
  R: 'MPA R — Restricted',
  'NC-17': 'MPA NC-17 — Adults Only',
  X: 'MPA X',
  GP: 'MPA GP',
  M: 'MPA M',
}

/** US TV Parental Guidelines: white on a black box. */
const US_TV = new Set([
  'TV-Y',
  'TV-Y7',
  'TV-Y7-FV',
  'TV-G',
  'TV-PG',
  'TV-14',
  'TV-MA',
])

/** FSK (Germany). Colour is the whole signal here; the shape does not vary. */
const FSK: Record<string, { fill: string; ink: string; edge?: string }> = {
  '0': { fill: '#FFFFFF', ink: '#1A1A1A', edge: '#B0B0B0' },
  '6': { fill: '#FFED00', ink: '#1A1A1A' },
  '12': { fill: '#009640', ink: '#FFFFFF' },
  '16': { fill: '#0069B4', ink: '#FFFFFF' },
  '18': { fill: '#E30613', ink: '#FFFFFF' },
}

/**
 * The tier-two ramp: green through red as the age rises.
 *
 * One ramp for every board that has no entry above, so two countries' "12"
 * at least look like the same *kind* of statement. Not any board's palette.
 */
function ageColour(age: number): { fill: string; ink: string } {
  if (age <= 0) return { fill: '#2E7D32', ink: '#FFFFFF' }
  if (age <= 6) return { fill: '#7CB342', ink: '#1A1A1A' }
  if (age <= 9) return { fill: '#F9A825', ink: '#1A1A1A' }
  if (age <= 12) return { fill: '#EF6C00', ink: '#FFFFFF' }
  if (age <= 15) return { fill: '#D84315', ink: '#FFFFFF' }
  return { fill: '#C62828', ink: '#FFFFFF' }
}

/** "All ages" as the boards variously spell it. */
const ALL_AGES = new Set(['A', 'AL', 'T', 'TOUS', 'U'])

/**
 * The mark for a raw certificate, or `null` when it has none worth drawing.
 *
 * `null` is a normal answer, not a failure: `Unrated`, `NR` and `Approved` are
 * real values a library holds and the caller draws them as boxed text.
 */
export function ratingMark(raw: string): RatingMark | null {
  const parts = splitCertificate(raw)
  if (!parts) return null

  const { region, key } = parts

  if (region === 'GB' || region === 'UK') {
    return BBFC[key] ?? ageMark(region, key)
  }

  if (region === 'DE') {
    const fsk = FSK[key]
    if (fsk) {
      return {
        text: key,
        shape: 'square',
        fill: fsk.fill,
        ink: fsk.ink,
        edge: fsk.edge,
        title: `FSK ${key}`,
      }
    }
    return ageMark(region, key)
  }

  // No prefix means a US rating: that is what the agents omit the board for.
  if (region === '' || region === 'US') {
    if (US_TV.has(key)) {
      return {
        text: key,
        shape: 'tv',
        fill: '#111111',
        ink: '#FFFFFF',
        // The box is nearly the colour of a dark page, so without an edge the
        // mark disappears entirely and only the lettering survives. Grey reads
        // against both surfaces; black-on-black does not.
        edge: '#5A5F66',
        title: `US TV Parental Guidelines ${key}`,
      }
    }
    const mpa = MPA_TITLES[key]
    if (mpa) {
      return {
        text: key,
        shape: 'card',
        fill: '#FFFFFF',
        ink: '#111111',
        edge: '#111111',
        title: mpa,
      }
    }
    return null
  }

  return ageMark(region, key)
}

/** Tier two: an age from any other board, on the shared ramp. */
function ageMark(region: string, key: string): RatingMark | null {
  if (ALL_AGES.has(key)) {
    const { fill, ink } = ageColour(0)
    return {
      text: key,
      shape: 'circle',
      fill,
      ink,
      title: region ? `${region} ${key} — all ages` : `${key} — all ages`,
    }
  }

  // `12`, `16`, and the forms that hang something off the number (`12A`, `9+`).
  const match = /^(\d{1,2})[A-Z+]?$/.exec(key)
  if (!match) return null

  const age = Number(match[1])
  const { fill, ink } = ageColour(age)
  return {
    text: key,
    shape: 'circle',
    fill,
    ink,
    title: region ? `${region} ${key}` : key,
  }
}
