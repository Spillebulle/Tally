/*
 * The list of IANA zones the time zone preference offers, built from the
 * browser rather than typed out here.
 *
 * `Intl.supportedValuesOf('timeZone')` is the same tz database the browser
 * formats dates with, so the list cannot drift from what the machine can
 * actually resolve, and a zone added or renamed upstream arrives with the
 * browser. A hand-written table would be wrong the year after it was written,
 * and wrong silently: a stale name still *looks* like an answer.
 *
 * The backend is the one that decides whether a name is usable — it refuses an
 * unloadable zone with a 422 (`app/timezones.py`) — so this list is a
 * convenience for choosing, never the authority. Everything here is display;
 * only `value`, the bare IANA name, is ever sent.
 */

/** The value that means "no stored preference". Sent to the API as `null`. */
export const FOLLOW_DEVICE = ''

/**
 * Enough of the world to pick from when `Intl.supportedValuesOf` is missing.
 *
 * Only Safari before 15.4 and a few older Android WebViews land here, and the
 * point is that the control still works rather than that the list is complete:
 * a zone this list omits can still be set through the API. Kept deliberately
 * short for that reason.
 */
const FALLBACK_ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Amsterdam',
  'Europe/Brussels',
  'Europe/Berlin',
  'Europe/Copenhagen',
  'Europe/Oslo',
  'Europe/Stockholm',
  'Europe/Helsinki',
  'Europe/Rome',
  'Europe/Zurich',
  'Europe/Vienna',
  'Europe/Prague',
  'Europe/Warsaw',
  'Europe/Athens',
  'Europe/Istanbul',
  'Europe/Kyiv',
  'Europe/Moscow',
  'Atlantic/Reykjavik',
  'America/St_Johns',
  'America/Halifax',
  'America/New_York',
  'America/Toronto',
  'America/Chicago',
  'America/Mexico_City',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Vancouver',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
  'Africa/Casablanca',
  'Africa/Lagos',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Africa/Nairobi',
  'Asia/Jerusalem',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Manila',
  'Asia/Seoul',
  'Asia/Tokyo',
  'Australia/Perth',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Sydney',
  'Pacific/Auckland',
  'Pacific/Fiji',
]

/** The zone this browser is set to, or `null` if it will not say. */
export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

/** Every zone this browser can resolve, or the short list above. */
function supportedZones(): string[] {
  const supported = (
    Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf
  if (typeof supported === 'function') {
    try {
      const zones = supported('timeZone')
      if (Array.isArray(zones) && zones.length > 0) return zones
    } catch {
      // Fall through: an engine that has the method but refuses the key.
    }
  }
  return FALLBACK_ZONES
}

/**
 * `UTC+02:00` for a zone, as it stands *today*.
 *
 * Read out of `Intl` rather than computed, so summer time is whatever the tz
 * database says it is at this moment and not whatever a table remembered. It
 * is a hint for finding a zone in a list of four hundred, not a fact about the
 * zone: the offset moves twice a year and the stored name does not.
 */
function offsetLabel(zone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date())
    const name = parts.find((part) => part.type === 'timeZoneName')?.value
    if (!name) return null
    // `GMT`, `GMT+2`, `GMT-3:30`. Printed as UTC because that is the name the
    // API, the docs and the response header all use.
    const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name)
    if (!match) return null
    const [, sign = '+', hours = '0', minutes = '00'] = match
    return `UTC${sign}${hours.padStart(2, '0')}:${minutes}`
  } catch {
    return null
  }
}

export interface TimezoneChoice {
  value: string
  label: string
}

/**
 * The options the picker offers: "Follow this device", then this device's own
 * zone, then everything else in alphabetical order.
 *
 * The device's zone is lifted out of the alphabet because it is the answer
 * nearly everyone wants and hunting for it among four hundred neighbours is
 * the one thing the list is bad at. Underscores are printed as spaces so that
 * typing "new york" into the search field finds `America/New_York`; the value
 * keeps the real name.
 */
export function timezoneOptions(device: string | null): TimezoneChoice[] {
  const zones = supportedZones()
  const rest = zones.filter((zone) => zone !== device).sort((a, b) => a.localeCompare(b))
  // The device's own zone goes in whether or not the supported list carries it
  // (a private build, an alias): it is the zone the person is actually in, and
  // the backend is what judges a name in the end.
  const ordered = device ? [device, ...rest] : rest

  return [
    { value: FOLLOW_DEVICE, label: 'Follow this device' },
    ...ordered.map((zone) => {
      const offset = offsetLabel(zone)
      const name = zone.replace(/_/g, ' ')
      return {
        value: zone,
        label: offset ? `${name} · ${offset}` : name,
      }
    }),
  ]
}
