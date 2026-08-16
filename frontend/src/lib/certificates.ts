/**
 * How a content rating is written down.
 *
 * The value stored on `MediaItem.content_rating` is whatever the agent that
 * scanned the library happened to hand Plex, and the agents disagree with each
 * other and with themselves: `pg_13`, `PG-13`, `pg-13`, `TV-MA`, `tv_ma`,
 * `Not Rated`, `nr`, and — for anything scanned with a non-US board — the
 * country-prefixed form `gb/12A` or `de/16`.
 *
 * This is **display only**. The raw string is the identity of the facet: it is
 * what the URL carries, what `?content_rating=` is matched against, and what a
 * `facetLink` on an item page points at. Nothing here may reach the query — a
 * "tidied" value would simply match no rows, silently, which is the one failure
 * an empty grid cannot be told apart from an honest answer.
 *
 * ## Unknown values are shown, never dropped
 *
 * A library can hold any certificate at all, including one no table here has
 * heard of. Anything unrecognised falls through in the least surprising shape
 * available — upper-cased when it looks like a code, and exactly as it arrived
 * when it does not — because a certificate the filter refuses to name is a row
 * of the library the user cannot reach.
 */

/**
 * The certificates worth spelling a particular way.
 *
 * Keyed by the *normalised* form (upper case, one hyphen for any run of spaces
 * or underscores), so every spelling of a value collapses to one entry.
 */
const CANONICAL: Record<string, string> = {
  // US theatrical (MPA)
  G: 'G',
  PG: 'PG',
  'PG-13': 'PG-13',
  R: 'R',
  'NC-17': 'NC-17',
  X: 'X',
  GP: 'GP',
  M: 'M',

  // US television
  'TV-Y': 'TV-Y',
  'TV-Y7': 'TV-Y7',
  'TV-Y7-FV': 'TV-Y7-FV',
  'TV-G': 'TV-G',
  'TV-PG': 'TV-PG',
  'TV-14': 'TV-14',
  'TV-MA': 'TV-MA',

  // The words the agents use where a board gave no certificate. They all mean
  // "nobody rated this", and three spellings of that in one picker read as
  // three different answers.
  NR: 'NR',
  'NOT-RATED': 'NR',
  NOTRATED: 'NR',
  'NO-RATING': 'NR',
  UNRATED: 'Unrated',
  UR: 'Unrated',
  NONE: 'Unrated',
  APPROVED: 'Approved',
  PASSED: 'Passed',
  OPEN: 'Open',
}

/** A code-shaped value: short, and made of the characters certificates use. */
const CODE = /^[A-Z0-9][A-Z0-9+-]{0,11}$/

/**
 * How this certificate should be written, without changing what it *is*.
 *
 * Never call this on a value on its way into a query — see the note above.
 */
export function certificateLabel(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return raw

  // `gb/12A`, `de/16`: Plex prefixes the certificate with the board that
  // issued it, and two countries' "12" are not the same certificate — so the
  // prefix is kept, spaced rather than slashed.
  const slash = trimmed.lastIndexOf('/')
  const region = slash > 0 ? trimmed.slice(0, slash).trim() : ''
  const code = (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).trim()
  if (!code) return trimmed

  const key = code.toUpperCase().replace(/[\s_]+/g, '-')
  const named = CANONICAL[key] ?? (CODE.test(key) ? key : code)

  return region ? `${region.toUpperCase()} ${named}` : named
}
