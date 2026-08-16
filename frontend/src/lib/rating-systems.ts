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
 * `assets/ratings/*.svg`, with `assets/ratings/PROVENANCE.md` recording the
 * source and licence of every file. All but one board's are vendored from
 * Wikimedia Commons and are **public domain** — the symbols are simple
 * geometry and text, which is not copyrightable. The exception is Norway,
 * rebuilt from Medietilsynet's own classification guidelines; see below.
 *
 * The symbols are nonetheless **trademarks** of their boards. They are used
 * here to state the certificate a title actually carries, which is what they
 * exist to do.
 *
 * Eleven boards have their real marks: BBFC (UK), MPA (US film), US TV
 * Parental Guidelines, FSK (Germany), Kijkwijzer (Netherlands), Medietilsynet
 * (Norway), ACB (Australia), DJCTQ (Brazil), Eirin (Japan), Mibact (Italy) and
 * OFLC (New Zealand).
 *
 * ## Everything else gets a plain age disc
 *
 * A board with no free mark — France, Ireland, Sweden, Denmark, Finland, Spain
 * — gets a neutral disc on one shared ramp, with the country kept beside it.
 * That is Tally showing an age rating, *not* a claim to be reproducing that
 * board's mark. Adding a board is one asset plus one table entry.
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

/** One entry per certificate: the asset stem, and what it is called in full. */
type Marks = Record<string, [string, string]>

/** BBFC (UK), current marks — in cinemas from October 2019. */
const BBFC: Marks = {
  U: ['bbfc-u', 'BBFC U — Universal'],
  PG: ['bbfc-pg', 'BBFC PG — Parental Guidance'],
  '12A': ['bbfc-12a', 'BBFC 12A'],
  '12': ['bbfc-12', 'BBFC 12'],
  '15': ['bbfc-15', 'BBFC 15'],
  '18': ['bbfc-18', 'BBFC 18'],
  R18: ['bbfc-r18', 'BBFC R18'],
}

/** MPA (US theatrical). */
const MPA: Marks = {
  G: ['mpa-g', 'MPA G — General Audiences'],
  PG: ['mpa-pg', 'MPA PG — Parental Guidance Suggested'],
  'PG-13': ['mpa-pg-13', 'MPA PG-13 — Parents Strongly Cautioned'],
  R: ['mpa-r', 'MPA R — Restricted'],
  'NC-17': ['mpa-nc-17', 'MPA NC-17 — Adults Only'],
  X: ['mpa-x', 'MPA X'],
}

/** US TV Parental Guidelines. */
const US_TV: Marks = {
  'TV-Y': ['ustv-tv-y', 'TV-Y — All Children'],
  'TV-Y7': ['ustv-tv-y7', 'TV-Y7 — Directed to Older Children'],
  'TV-Y7-FV': ['ustv-tv-y7-fv', 'TV-Y7-FV — Fantasy Violence'],
  'TV-G': ['ustv-tv-g', 'TV-G — General Audience'],
  'TV-PG': ['ustv-tv-pg', 'TV-PG — Parental Guidance Suggested'],
  'TV-14': ['ustv-tv-14', 'TV-14 — Parents Strongly Cautioned'],
  'TV-MA': ['ustv-tv-ma', 'TV-MA — Mature Audience Only'],
}

/** FSK (Germany). */
const FSK: Marks = {
  '0': ['fsk-0', 'FSK 0 — ohne Altersbeschränkung'],
  '6': ['fsk-6', 'FSK 6 — ab 6 Jahren'],
  '12': ['fsk-12', 'FSK 12 — ab 12 Jahren'],
  '16': ['fsk-16', 'FSK 16 — ab 16 Jahren'],
  '18': ['fsk-18', 'FSK 18 — keine Jugendfreigabe'],
}

/** Kijkwijzer (Netherlands). */
const KIJKWIJZER: Marks = {
  AL: ['kijkwijzer-al', 'Kijkwijzer AL — alle leeftijden'],
  '6': ['kijkwijzer-6', 'Kijkwijzer 6'],
  '9': ['kijkwijzer-9', 'Kijkwijzer 9'],
  '12': ['kijkwijzer-12', 'Kijkwijzer 12'],
  '14': ['kijkwijzer-14', 'Kijkwijzer 14'],
  '16': ['kijkwijzer-16', 'Kijkwijzer 16'],
  '18': ['kijkwijzer-18', 'Kijkwijzer 18'],
}

/**
 * Medietilsynet (Norway). Four colours across six levels — A and 6 share
 * green, 9 and 12 share yellow — which is the board's own scheme, not a ramp.
 */
const MEDIETILSYNET: Marks = {
  A: ['no-a', 'Norsk aldersgrense A — tillatt for alle'],
  '6': ['no-6', 'Norsk aldersgrense 6 år'],
  '9': ['no-9', 'Norsk aldersgrense 9 år'],
  '12': ['no-12', 'Norsk aldersgrense 12 år'],
  '15': ['no-15', 'Norsk aldersgrense 15 år'],
  '18': ['no-18', 'Norsk aldersgrense 18 år'],
}

/** ACB (Australia). Agents spell the plus-forms both with and without a space. */
const ACB: Marks = {
  G: ['acb-g', 'ACB G — General'],
  PG: ['acb-pg', 'ACB PG — Parental Guidance'],
  M: ['acb-m', 'ACB M — Mature'],
  'MA15+': ['acb-ma15', 'ACB MA 15+ — Mature Accompanied'],
  'MA-15+': ['acb-ma15', 'ACB MA 15+ — Mature Accompanied'],
  'R18+': ['acb-r18', 'ACB R 18+ — Restricted'],
  'R-18+': ['acb-r18', 'ACB R 18+ — Restricted'],
  'X18+': ['acb-x18', 'ACB X 18+ — Restricted'],
  'X-18+': ['acb-x18', 'ACB X 18+ — Restricted'],
}

/** DJCTQ (Brazil). */
const DJCTQ: Marks = {
  L: ['djctq-l', 'DJCTQ L — Livre'],
  '10': ['djctq-10', 'DJCTQ 10 anos'],
  '12': ['djctq-12', 'DJCTQ 12 anos'],
  '14': ['djctq-14', 'DJCTQ 14 anos'],
  '16': ['djctq-16', 'DJCTQ 16 anos'],
  '18': ['djctq-18', 'DJCTQ 18 anos'],
}

/** Eirin (Japan). */
const EIRIN: Marks = {
  G: ['eirin-g', 'Eirin G — General'],
  PG12: ['eirin-pg12', 'Eirin PG12'],
  'PG-12': ['eirin-pg12', 'Eirin PG12'],
  'R15+': ['eirin-r15', 'Eirin R15+'],
  'R-15+': ['eirin-r15', 'Eirin R15+'],
  'R18+': ['eirin-r18', 'Eirin R18+'],
  'R-18+': ['eirin-r18', 'Eirin R18+'],
}

/** Mibact (Italy). `T` — tutti, all ages — has no mark and falls through. */
const MIBACT: Marks = {
  VM6: ['it-vm6', 'VM6 — vietato ai minori di 6 anni'],
  VM14: ['it-vm14', 'VM14 — vietato ai minori di 14 anni'],
  VM18: ['it-vm18', 'VM18 — vietato ai minori di 18 anni'],
}

/** OFLC (New Zealand), 2022 labels. */
const OFLC: Marks = {
  G: ['oflc-g', 'OFLC G — General'],
  PG: ['oflc-pg', 'OFLC PG — Parental Guidance'],
  M: ['oflc-m', 'OFLC M — Mature'],
  R13: ['oflc-r13', 'OFLC R13 — Restricted to 13 and over'],
  R15: ['oflc-r15', 'OFLC R15 — Restricted to 15 and over'],
  R16: ['oflc-r16', 'OFLC R16 — Restricted to 16 and over'],
  R18: ['oflc-r18', 'OFLC R18 — Restricted to 18 and over'],
}

/**
 * Which board issued a certificate carrying this prefix.
 *
 * US is absent on purpose: an unprefixed value *is* a US rating, and it has
 * two boards to try rather than one.
 */
const BY_REGION: Record<string, Marks> = {
  GB: BBFC,
  UK: BBFC,
  DE: FSK,
  NL: KIJKWIJZER,
  NO: MEDIETILSYNET,
  AU: ACB,
  BR: DJCTQ,
  JP: EIRIN,
  IT: MIBACT,
  NZ: OFLC,
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
const ALL_AGES = new Set(['A', 'AL', 'T', 'TOUS', 'L'])

function fromTable(table: Marks, key: string): RatingMark | null {
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

  // No prefix means a US rating: that is the board the agents omit.
  if (region === '' || region === 'US') {
    return fromTable(US_TV, key) ?? fromTable(MPA, key)
  }

  const table = BY_REGION[region]
  return (table && fromTable(table, key)) || ageMark(region, key)
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
