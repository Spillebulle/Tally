/**
 * Content ratings, shown as the marks the boards actually publish.
 *
 * `certificates.ts` answers "how is this certificate *written*". This answers
 * "which mark stands for it". Boards publish a symbol rather than a word for a
 * reason: `12`, `15` and `18` are indistinguishable from years and runtimes as
 * plain text, and the mark is what a viewer already recognises.
 *
 * ## This never touches a query
 *
 * Same rule as `certificates.ts`: the raw string is the identity of the facet.
 * Everything here is display, keyed off the raw value but never replacing it.
 *
 * ## Where the marks come from
 *
 * `assets/ratings/*.svg`, vendored from Wikimedia Commons. Every file is in the
 * **public domain** — the symbols are simple geometry and text, which is not
 * copyrightable — and `assets/ratings/PROVENANCE.md` records the source file,
 * licence and any edit for each one. The symbols are nonetheless **trademarks**
 * of their boards; they are used here to state the certificate a title actually
 * carries, which is what they exist to do.
 *
 * Five boards have their real marks: BBFC (UK), MPA (US film), US TV Parental
 * Guidelines, FSK (Germany) and Kijkwijzer (Netherlands). Between them they
 * cover the overwhelming majority of what Plex agents attach.
 *
 * ## Everything else gets a plain age disc
 *
 * Norway, France, Australia and the rest have no free asset, so they get a
 * neutral disc on one shared ramp with the country kept beside it. That is
 * Tally showing an age rating, *not* a claim to be reproducing that board's
 * mark. Adding a board is one asset plus one table entry.
 *
 * Anything that is not a mark and not an age — `NR`, `Approved`, `Unrated` —
 * resolves to `null`, and the caller falls back to plain boxed text so that no
 * certificate is ever dropped for want of a picture.
 */
import { splitCertificate } from './certificates'

export type RatingMark =
  /** A board's own mark, bundled. `asset` is the filename stem. */
  | { kind: 'asset'; asset: string; title: string }
  /** Tally's own age disc, for a board with no free mark available. */
  | { kind: 'drawn'; text: string; fill: string; ink: string; title: string }

/** BBFC (UK), current marks — in cinemas from October 2019. */
const BBFC: Record<string, [string, string]> = {
  U: ['bbfc-u', 'BBFC U — Universal'],
  PG: ['bbfc-pg', 'BBFC PG — Parental Guidance'],
  '12A': ['bbfc-12a', 'BBFC 12A'],
  '12': ['bbfc-12', 'BBFC 12'],
  '15': ['bbfc-15', 'BBFC 15'],
  '18': ['bbfc-18', 'BBFC 18'],
  R18: ['bbfc-r18', 'BBFC R18'],
}

/** MPA (US theatrical). */
const MPA: Record<string, [string, string]> = {
  G: ['mpa-g', 'MPA G — General Audiences'],
  PG: ['mpa-pg', 'MPA PG — Parental Guidance Suggested'],
  'PG-13': ['mpa-pg-13', 'MPA PG-13 — Parents Strongly Cautioned'],
  R: ['mpa-r', 'MPA R — Restricted'],
  'NC-17': ['mpa-nc-17', 'MPA NC-17 — Adults Only'],
  X: ['mpa-x', 'MPA X'],
}

/** US TV Parental Guidelines. */
const US_TV: Record<string, [string, string]> = {
  'TV-Y': ['ustv-tv-y', 'TV-Y — All Children'],
  'TV-Y7': ['ustv-tv-y7', 'TV-Y7 — Directed to Older Children'],
  'TV-Y7-FV': ['ustv-tv-y7-fv', 'TV-Y7-FV — Fantasy Violence'],
  'TV-G': ['ustv-tv-g', 'TV-G — General Audience'],
  'TV-PG': ['ustv-tv-pg', 'TV-PG — Parental Guidance Suggested'],
  'TV-14': ['ustv-tv-14', 'TV-14 — Parents Strongly Cautioned'],
  'TV-MA': ['ustv-tv-ma', 'TV-MA — Mature Audience Only'],
}

/** FSK (Germany). */
const FSK: Record<string, [string, string]> = {
  '0': ['fsk-0', 'FSK 0 — ohne Altersbeschränkung'],
  '6': ['fsk-6', 'FSK 6 — ab 6 Jahren'],
  '12': ['fsk-12', 'FSK 12 — ab 12 Jahren'],
  '16': ['fsk-16', 'FSK 16 — ab 16 Jahren'],
  '18': ['fsk-18', 'FSK 18 — keine Jugendfreigabe'],
}

/** Kijkwijzer (Netherlands). */
const KIJKWIJZER: Record<string, [string, string]> = {
  AL: ['kijkwijzer-al', 'Kijkwijzer AL — alle leeftijden'],
  '6': ['kijkwijzer-6', 'Kijkwijzer 6'],
  '9': ['kijkwijzer-9', 'Kijkwijzer 9'],
  '12': ['kijkwijzer-12', 'Kijkwijzer 12'],
  '14': ['kijkwijzer-14', 'Kijkwijzer 14'],
  '16': ['kijkwijzer-16', 'Kijkwijzer 16'],
  '18': ['kijkwijzer-18', 'Kijkwijzer 18'],
}

/** The shared ramp: green through red as the age rises. Not any board's palette. */
function ageColour(age: number): { fill: string; ink: string } {
  if (age <= 0) return { fill: '#2E7D32', ink: '#FFFFFF' }
  if (age <= 6) return { fill: '#7CB342', ink: '#1A1A1A' }
  if (age <= 9) return { fill: '#F9A825', ink: '#1A1A1A' }
  if (age <= 12) return { fill: '#EF6C00', ink: '#FFFFFF' }
  if (age <= 15) return { fill: '#D84315', ink: '#FFFFFF' }
  return { fill: '#C62828', ink: '#FFFFFF' }
}

/** "All ages", as the boards variously spell it. */
const ALL_AGES = new Set(['A', 'AL', 'T', 'TOUS'])

function fromTable(table: Record<string, [string, string]>, key: string): RatingMark | null {
  const hit = table[key]
  return hit ? { kind: 'asset', asset: hit[0], title: hit[1] } : null
}

/**
 * The mark for a raw certificate, or `null` when it has none worth drawing.
 *
 * `null` is a normal answer, not a failure — see the note at the top.
 */
export function ratingMark(raw: string): RatingMark | null {
  const parts = splitCertificate(raw)
  if (!parts) return null

  const { region, key } = parts

  if (region === 'GB' || region === 'UK') return fromTable(BBFC, key) ?? ageMark(region, key)
  if (region === 'DE') return fromTable(FSK, key) ?? ageMark(region, key)
  if (region === 'NL') return fromTable(KIJKWIJZER, key) ?? ageMark(region, key)

  // No prefix means a US rating: that is the board the agents omit.
  if (region === '' || region === 'US') {
    return fromTable(US_TV, key) ?? fromTable(MPA, key)
  }

  return ageMark(region, key)
}

/** A board with no free mark: an age on the shared ramp. */
function ageMark(region: string, key: string): RatingMark | null {
  if (ALL_AGES.has(key)) {
    const { fill, ink } = ageColour(0)
    return {
      kind: 'drawn',
      text: key,
      fill,
      ink,
      title: region ? `${region} ${key} — all ages` : `${key} — all ages`,
    }
  }

  // `12`, `16`, and the forms that hang something off the number (`12A`, `9+`).
  const match = /^(\d{1,2})[A-Z+]?$/.exec(key)
  if (!match) return null

  const { fill, ink } = ageColour(Number(match[1]))
  return { kind: 'drawn', text: key, fill, ink, title: region ? `${region} ${key}` : key }
}
