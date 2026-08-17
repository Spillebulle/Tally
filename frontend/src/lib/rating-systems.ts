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
 * `assets/ratings/*.svg`, vendored from Wikimedia Commons, with
 * `assets/ratings/PROVENANCE.md` recording the source and licence of every
 * file. All are **public domain** — the symbols are simple geometry and text,
 * which is not copyrightable.
 *
 * The symbols are nonetheless **trademarks** of their boards. They are used
 * here to state the certificate a title actually carries, which is what they
 * exist to do.
 *
 * Seventeen boards have their real marks: BBFC (UK), MPA (US film), US TV
 * Parental Guidelines, FSK (Germany), Kijkwijzer (Netherlands), Medietilsynet
 * (Norway), ACB (Australia), DJCTQ (Brazil), Eirin (Japan), Mibact (Italy),
 * OFLC (New Zealand), CSA/Arcom (France), IFCO (Ireland), KAVI (Finland),
 * Medierådet (Denmark), ICAA (Spain) and KMRB (South Korea).
 *
 * ## Everything else gets a plain age disc
 *
 * A board with no free mark — Sweden is the one that matters in practice —
 * gets a neutral disc on one shared ramp, with the country kept beside it.
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
  U: ['bbfc-u', 'BBFC U, Universal'],
  PG: ['bbfc-pg', 'BBFC PG, Parental Guidance'],
  '12A': ['bbfc-12a', 'BBFC 12A'],
  '12': ['bbfc-12', 'BBFC 12'],
  '15': ['bbfc-15', 'BBFC 15'],
  '18': ['bbfc-18', 'BBFC 18'],
  R18: ['bbfc-r18', 'BBFC R18'],
}

/** MPA (US theatrical). */
const MPA: Marks = {
  G: ['mpa-g', 'MPA G, General Audiences'],
  PG: ['mpa-pg', 'MPA PG, Parental Guidance Suggested'],
  'PG-13': ['mpa-pg-13', 'MPA PG-13, Parents Strongly Cautioned'],
  R: ['mpa-r', 'MPA R, Restricted'],
  'NC-17': ['mpa-nc-17', 'MPA NC-17, Adults Only'],
  X: ['mpa-x', 'MPA X'],
}

/** US TV Parental Guidelines. */
const US_TV: Marks = {
  'TV-Y': ['ustv-tv-y', 'TV-Y, All Children'],
  'TV-Y7': ['ustv-tv-y7', 'TV-Y7, Directed to Older Children'],
  'TV-Y7-FV': ['ustv-tv-y7-fv', 'TV-Y7-FV, Fantasy Violence'],
  'TV-G': ['ustv-tv-g', 'TV-G, General Audience'],
  'TV-PG': ['ustv-tv-pg', 'TV-PG, Parental Guidance Suggested'],
  'TV-14': ['ustv-tv-14', 'TV-14, Parents Strongly Cautioned'],
  'TV-MA': ['ustv-tv-ma', 'TV-MA, Mature Audience Only'],
}

/** FSK (Germany). */
const FSK: Marks = {
  '0': ['fsk-0', 'FSK 0, ohne Altersbeschränkung'],
  '6': ['fsk-6', 'FSK 6, ab 6 Jahren'],
  '12': ['fsk-12', 'FSK 12, ab 12 Jahren'],
  '16': ['fsk-16', 'FSK 16, ab 16 Jahren'],
  '18': ['fsk-18', 'FSK 18, keine Jugendfreigabe'],
}

/** Kijkwijzer (Netherlands). */
const KIJKWIJZER: Marks = {
  AL: ['kijkwijzer-al', 'Kijkwijzer AL, alle leeftijden'],
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
  A: ['no-a', 'Norsk aldersgrense A, tillatt for alle'],
  '6': ['no-6', 'Norsk aldersgrense 6 år'],
  '9': ['no-9', 'Norsk aldersgrense 9 år'],
  '12': ['no-12', 'Norsk aldersgrense 12 år'],
  '15': ['no-15', 'Norsk aldersgrense 15 år'],
  '18': ['no-18', 'Norsk aldersgrense 18 år'],
}

/** ACB (Australia). Agents spell the plus-forms both with and without a space. */
const ACB: Marks = {
  G: ['acb-g', 'ACB G, General'],
  PG: ['acb-pg', 'ACB PG, Parental Guidance'],
  M: ['acb-m', 'ACB M, Mature'],
  'MA15+': ['acb-ma15', 'ACB MA 15+, Mature Accompanied'],
  'MA-15+': ['acb-ma15', 'ACB MA 15+, Mature Accompanied'],
  'R18+': ['acb-r18', 'ACB R 18+, Restricted'],
  'R-18+': ['acb-r18', 'ACB R 18+, Restricted'],
  'X18+': ['acb-x18', 'ACB X 18+, Restricted'],
  'X-18+': ['acb-x18', 'ACB X 18+, Restricted'],
}

/** DJCTQ (Brazil). */
const DJCTQ: Marks = {
  L: ['djctq-l', 'DJCTQ L, Livre'],
  '10': ['djctq-10', 'DJCTQ 10 anos'],
  '12': ['djctq-12', 'DJCTQ 12 anos'],
  '14': ['djctq-14', 'DJCTQ 14 anos'],
  '16': ['djctq-16', 'DJCTQ 16 anos'],
  '18': ['djctq-18', 'DJCTQ 18 anos'],
}

/** Eirin (Japan). */
const EIRIN: Marks = {
  G: ['eirin-g', 'Eirin G, General'],
  PG12: ['eirin-pg12', 'Eirin PG12'],
  'PG-12': ['eirin-pg12', 'Eirin PG12'],
  'R15+': ['eirin-r15', 'Eirin R15+'],
  'R-15+': ['eirin-r15', 'Eirin R15+'],
  'R18+': ['eirin-r18', 'Eirin R18+'],
  'R-18+': ['eirin-r18', 'Eirin R18+'],
}

/** Mibact (Italy). */
const MIBACT: Marks = {
  T: ['it-t', 'T, tutti, all ages'],
  VM6: ['it-vm6', 'VM6, vietato ai minori di 6 anni'],
  VM10: ['it-vm10', 'VM10, vietato ai minori di 10 anni'],
  VM14: ['it-vm14', 'VM14, vietato ai minori di 14 anni'],
  VM18: ['it-vm18', 'VM18, vietato ai minori di 18 anni'],
}

/**
 * CSA / Arcom (France). The signage introduced in 2002, which is what the
 * country uses; `Tous publics` is a phrase rather than a symbol and has none.
 */
const CSA: Marks = {
  '10': ['fr-10', 'Déconseillé aux moins de 10 ans'],
  '-10': ['fr-10', 'Déconseillé aux moins de 10 ans'],
  '12': ['fr-12', 'Déconseillé aux moins de 12 ans'],
  '-12': ['fr-12', 'Déconseillé aux moins de 12 ans'],
  '16': ['fr-16', 'Déconseillé aux moins de 16 ans'],
  '-16': ['fr-16', 'Déconseillé aux moins de 16 ans'],
  '18': ['fr-18', 'Interdit aux moins de 18 ans'],
  '-18': ['fr-18', 'Interdit aux moins de 18 ans'],
}

/** IFCO (Ireland), cinema marks. */
const IFCO: Marks = {
  G: ['ifco-g', 'IFCO G, General'],
  PG: ['ifco-pg', 'IFCO PG, Parental Guidance'],
  '12A': ['ifco-12a', 'IFCO 12A'],
  '15A': ['ifco-15a', 'IFCO 15A'],
  '16': ['ifco-16', 'IFCO 16'],
  '18': ['ifco-18', 'IFCO 18'],
}

/** KAVI (Finland). `K-7` and `7` are the same rating, spelled two ways. */
const KAVI: Marks = {
  S: ['fi-s', 'S, sallittu, all ages'],
  T: ['fi-s', 'T, tillåten, all ages'],
  '7': ['fi-7', 'K-7, ikäraja 7'],
  'K-7': ['fi-7', 'K-7, ikäraja 7'],
  '12': ['fi-12', 'K-12, ikäraja 12'],
  'K-12': ['fi-12', 'K-12, ikäraja 12'],
  '16': ['fi-16', 'K-16, ikäraja 16'],
  'K-16': ['fi-16', 'K-16, ikäraja 16'],
  '18': ['fi-18', 'K-18, ikäraja 18'],
  'K-18': ['fi-18', 'K-18, ikäraja 18'],
}

/** Medierådet (Denmark), 2021 marks. */
const MEDIERAADET: Marks = {
  A: ['dk-a', 'Tilladt for alle'],
  F: ['dk-a', 'Tilladt for alle'],
  '7': ['dk-7', 'Tilladt for alle, men frarådes børn under 7 år'],
  '11': ['dk-11', 'Tilladt for børn over 11 år'],
  '15': ['dk-15', 'Tilladt for børn over 15 år'],
}

/** ICAA (Spain). */
const ICAA: Marks = {
  A: ['icaa-a', 'ICAA A, apta para todos los públicos'],
  APTA: ['icaa-a', 'ICAA A, apta para todos los públicos'],
  '7': ['icaa-7', 'ICAA 7, no recomendada para menores de 7 años'],
  '12': ['icaa-12', 'ICAA 12, no recomendada para menores de 12 años'],
  '16': ['icaa-16', 'ICAA 16, no recomendada para menores de 16 años'],
  '18': ['icaa-18', 'ICAA 18, no recomendada para menores de 18 años'],
  X: ['icaa-x', 'ICAA X, película X'],
}

/** KMRB (South Korea), 2021 marks. */
const KMRB: Marks = {
  ALL: ['kmrb-all', 'KMRB All, all ages'],
  '12': ['kmrb-12', 'KMRB 12'],
  '15': ['kmrb-15', 'KMRB 15'],
  '19': ['kmrb-19', 'KMRB 19'],
}

/** OFLC (New Zealand), 2022 labels. */
const OFLC: Marks = {
  G: ['oflc-g', 'OFLC G, General'],
  PG: ['oflc-pg', 'OFLC PG, Parental Guidance'],
  M: ['oflc-m', 'OFLC M, Mature'],
  R13: ['oflc-r13', 'OFLC R13, Restricted to 13 and over'],
  R15: ['oflc-r15', 'OFLC R15, Restricted to 15 and over'],
  R16: ['oflc-r16', 'OFLC R16, Restricted to 16 and over'],
  R18: ['oflc-r18', 'OFLC R18, Restricted to 18 and over'],
}

/** CBFC (India). */
const CBFC: Marks = {
  U: ['cbfc-u', 'CBFC U, Unrestricted'],
  UA: ['cbfc-ua', 'CBFC U/A, Parental guidance'],
  A: ['cbfc-a', 'CBFC A, Adults only'],
}

/**
 * Canada. Two systems share the country: CHVRS nationally, and Quebec's own
 * board, whose ratings are the ones written with a `+`.
 */
const CANADA: Marks = {
  G: ['chvrs-g', 'CHVRS G, General'],
  PG: ['chvrs-pg', 'CHVRS PG, Parental Guidance'],
  '14A': ['chvrs-14a', 'CHVRS 14A'],
  '18A': ['chvrs-18a', 'CHVRS 18A'],
  R: ['chvrs-r', 'CHVRS R, Restricted'],
  A: ['chvrs-adult', 'CHVRS A, Adult'],
  E: ['chvrs-e', 'CHVRS E, Exempt'],
  '13+': ['qc-13', 'Québec 13+'],
  '16+': ['qc-16', 'Québec 16+'],
  '18+': ['qc-18', 'Québec 18+'],
}

/** IMDA (Singapore). */
const IMDA: Marks = {
  G: ['imda-g', 'IMDA G, General'],
  PG: ['imda-pg', 'IMDA PG, Parental Guidance'],
  PG13: ['imda-pg13', 'IMDA PG13'],
  'PG-13': ['imda-pg13', 'IMDA PG13'],
  NC16: ['imda-nc16', 'IMDA NC16, No Children Under 16'],
  'NC-16': ['imda-nc16', 'IMDA NC16, No Children Under 16'],
  M18: ['imda-m18', 'IMDA M18, Mature 18'],
  'M-18': ['imda-m18', 'IMDA M18, Mature 18'],
  R21: ['imda-r21', 'IMDA R21, Restricted 21'],
  'R-21': ['imda-r21', 'IMDA R21, Restricted 21'],
}

/** LSF (Indonesia). */
const LSF: Marks = {
  SU: ['lsf-su', 'LSF SU, semua umur'],
  '13+': ['lsf-13', 'LSF 13+'],
  '17+': ['lsf-17', 'LSF 17+'],
  '21+': ['lsf-21', 'LSF 21+'],
}

/** Thailand. */
const THAILAND: Marks = {
  G: ['th-g', 'Thai G, general'],
  P: ['th-p', 'Thai P, promotional / educational'],
  '13+': ['th-13', 'Thai 13+'],
  '15+': ['th-15', 'Thai 15+'],
  '18+': ['th-18', 'Thai 18+'],
  '20-': ['th-20', 'Thai 20-, adults only'],
}

/** GSRR (Taiwan). */
const GSRR: Marks = {
  G: ['gsrr-g', 'GSRR G, general'],
  P: ['gsrr-p', 'GSRR P, protected'],
  PG12: ['gsrr-pg12', 'GSRR PG12'],
  'PG-12': ['gsrr-pg12', 'GSRR PG12'],
  PG15: ['gsrr-pg15', 'GSRR PG15'],
  'PG-15': ['gsrr-pg15', 'GSRR PG15'],
  R: ['gsrr-r', 'GSRR R, restricted'],
}

/** TRDSİ (Turkey). The `A` forms mean "with an adult". */
const TRDSI: Marks = {
  '6+': ['trdsi-6', 'TRDSİ 6+'],
  '6A': ['trdsi-6a', 'TRDSİ 6A'],
  '10+': ['trdsi-10', 'TRDSİ 10+'],
  '10A': ['trdsi-10a', 'TRDSİ 10A'],
  '13+': ['trdsi-13', 'TRDSİ 13+'],
  '13A': ['trdsi-13a', 'TRDSİ 13A'],
  '16+': ['trdsi-16', 'TRDSİ 16+'],
  '18+': ['trdsi-18', 'TRDSİ 18+'],
}

/** KFCB (Kenya). */
const KFCB: Marks = {
  GE: ['kfcb-ge', 'KFCB GE, General Exhibition'],
  PG: ['kfcb-pg', 'KFCB PG, Parental Guidance'],
  '16': ['kfcb-16', 'KFCB 16'],
  '18': ['kfcb-18', 'KFCB 18'],
}

/** NFVCB (Nigeria). */
const NFVCB: Marks = {
  G: ['nfvcb-g', 'NFVCB G, General'],
  PG: ['nfvcb-pg', 'NFVCB PG, Parental Guidance'],
  '12': ['nfvcb-12', 'NFVCB 12'],
  '12A': ['nfvcb-12a', 'NFVCB 12A'],
  '15': ['nfvcb-15', 'NFVCB 15'],
  '18': ['nfvcb-18', 'NFVCB 18'],
  RE: ['nfvcb-re', 'NFVCB RE, Restricted Exhibition'],
}

/** FPB (South Africa). */
const FPB: Marks = {
  A: ['fpb-a', 'FPB A, all ages'],
  PG: ['fpb-pg', 'FPB PG, Parental Guidance'],
  '7-9PG': ['fpb-7-9pg', 'FPB 7–9 PG'],
  '10-12PG': ['fpb-10-12pg', 'FPB 10–12 PG'],
  '13': ['fpb-13', 'FPB 13'],
  '16': ['fpb-16', 'FPB 16'],
  '18': ['fpb-18', 'FPB 18'],
  X18: ['fpb-x18', 'FPB X18'],
  XX: ['fpb-xx', 'FPB XX, refused'],
}

/** INCAA (Argentina). */
const INCAA: Marks = {
  G: ['incaa-g', 'INCAA ATP, apta para todo público'],
  ATP: ['incaa-g', 'INCAA ATP, apta para todo público'],
  'R-13': ['incaa-r13', 'INCAA R-13'],
  '13': ['incaa-r13', 'INCAA R-13'],
  'R-17': ['incaa-r17', 'INCAA R-17'],
  '17': ['incaa-r17', 'INCAA R-17'],
  C: ['incaa-c', 'INCAA C, condicionada'],
  SP: ['incaa-sp', 'INCAA SP, sólo para adultos'],
}

/** NBC (Maldives). */
const NBC: Marks = {
  G: ['nbc-g', 'NBC G, General'],
  PU: ['nbc-pu', 'NBC PU, Parental Guidance under'],
  PG: ['nbc-pg', 'NBC PG, Parental Guidance'],
  '12+': ['nbc-12', 'NBC 12+'],
  '15+': ['nbc-15', 'NBC 15+'],
  '18+': ['nbc-18', 'NBC 18+'],
  '18+R': ['nbc-18r', 'NBC 18+R, restricted'],
}

/** Kuwait. */
const KUWAIT: Marks = {
  'R-15': ['kw-r15', 'Kuwait R-15'],
  '15': ['kw-r15', 'Kuwait R-15'],
  'R-18': ['kw-r18', 'Kuwait R-18'],
  '18': ['kw-r18', 'Kuwait R-18'],
}

/** RTC (Mexico). */
const RTC: Marks = {
  A: ['rtc-a', 'RTC A, todo público'],
  AA: ['rtc-aa', 'RTC AA, menores de 7'],
  B: ['rtc-b', 'RTC B, adolescentes de 12'],
  B15: ['rtc-b15', 'RTC B15'],
  'B-15': ['rtc-b15', 'RTC B15'],
  C: ['rtc-c', 'RTC C, adultos de 18'],
  D: ['rtc-d', 'RTC D, adultos'],
}

/** Iceland. */
const ICELAND: Marks = {
  L: ['is-l', 'Leyfð öllum, all ages'],
  '6': ['is-6', 'Iceland 6'],
  '9': ['is-9', 'Iceland 9'],
  '12': ['is-12', 'Iceland 12'],
  '14': ['is-14', 'Iceland 14'],
  '16': ['is-16', 'Iceland 16'],
  '18': ['is-18', 'Iceland 18'],
}

/** Hungary. */
const HUNGARY: Marks = {
  KN: ['hu-kn', 'Korhatár nélkül, all ages'],
  '6': ['hu-6', 'Hungary 6'],
  '12': ['hu-12', 'Hungary 12'],
  '16': ['hu-16', 'Hungary 16'],
  '18': ['hu-18', 'Hungary 18'],
  X: ['hu-x', 'Hungary X'],
}

/** JSO (Slovakia). */
const JSO: Marks = {
  U: ['jso-u', 'JSO U, all ages'],
  '7': ['jso-7', 'JSO 7+'],
  '7+': ['jso-7', 'JSO 7+'],
  '12': ['jso-12', 'JSO 12+'],
  '12+': ['jso-12', 'JSO 12+'],
  '15': ['jso-15', 'JSO 15+'],
  '15+': ['jso-15', 'JSO 15+'],
  '18': ['jso-18', 'JSO 18+'],
  '18+': ['jso-18', 'JSO 18+'],
}

/** NFA (Ghana). */
const NFA: Marks = {
  U: ['nfa-u', 'NFA U, universal'],
  PG: ['nfa-pg', 'NFA PG, Parental Guidance'],
  '12+': ['nfa-12', 'NFA 12+'],
  '15+': ['nfa-15', 'NFA 15+'],
  '18+': ['nfa-18', 'NFA 18+'],
  NS: ['nfa-ns', 'NFA NS, not suitable'],
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
  FR: CSA,
  IE: IFCO,
  FI: KAVI,
  DK: MEDIERAADET,
  ES: ICAA,
  KR: KMRB,
  IN: CBFC,
  CA: CANADA,
  SG: IMDA,
  ID: LSF,
  TH: THAILAND,
  TW: GSRR,
  TR: TRDSI,
  KE: KFCB,
  NG: NFVCB,
  ZA: FPB,
  AR: INCAA,
  MV: NBC,
  KW: KUWAIT,
  MX: RTC,
  IS: ICELAND,
  HU: HUNGARY,
  SK: JSO,
  GH: NFA,
}

/** The shared ramp: green through red as the age rises. Not any board's palette. */
function ageColour(age: number): { fill: string; ink: string } {
  // design-check-allow raw-colour: the age disc mimics the boards' own printed ramp, fixed in both themes like the vendored marks beside it.
  if (age <= 0) return { fill: '#2E7D32', ink: '#FFFFFF' }
  // design-check-allow raw-colour: the age disc ramp is fixed, like the vendored board marks.
  if (age <= 6) return { fill: '#7CB342', ink: '#1A1A1A' }
  // design-check-allow raw-colour: the age disc ramp is fixed, like the vendored board marks.
  if (age <= 9) return { fill: '#F9A825', ink: '#1A1A1A' }
  // design-check-allow raw-colour: the age disc ramp is fixed, like the vendored board marks.
  if (age <= 12) return { fill: '#EF6C00', ink: '#FFFFFF' }
  // design-check-allow raw-colour: the age disc ramp is fixed, like the vendored board marks.
  if (age <= 15) return { fill: '#D84315', ink: '#FFFFFF' }
  // design-check-allow raw-colour: the age disc ramp is fixed, like the vendored board marks.
  return { fill: '#C62828', ink: '#FFFFFF' }
}

/**
 * "All ages", as the boards variously spell it.
 *
 * Only reached for a board with no mark of its own — Sweden's `Btl`
 * (barntillåten) is the live example. Without this the word falls through to
 * bare text and sits next to `SE 7` and `SE 11`, which do get a disc, so the
 * one rating meaning "anyone may watch" is the only one drawn as nothing.
 */
const ALL_AGES = new Set(['A', 'AL', 'T', 'TOUS', 'TOUS-PUBLICS', 'TP', 'L', 'S', 'U', 'BTL', 'ALL'])

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
      title: region ? `${region} ${key}, all ages` : `${key}, all ages`,
    }
  }

  // `12`, `16`, and the forms that hang something off the number (`12A`, `9+`).
  const match = /^(\d{1,2})[A-Z+]?$/.exec(key)
  if (!match) return null

  const { fill, ink } = ageColour(Number(match[1]))
  return { kind: 'drawn', text: key, fill, ink, title: region ? `${region} ${key}` : key }
}
