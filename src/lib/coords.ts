/**
 * Coordinate parsing and formatting.
 *
 * Accepts decimal degrees, degrees/minutes/seconds and degrees/decimal-minutes
 * in one parser, because in the field people read coordinates off whatever
 * device they happen to be holding.
 */

export type Axis = 'lat' | 'lon'

const NUMBER_TOKEN = /\d+(?:[.,]\d+)?/g

function hemisphereFor(dd: number, axis: Axis): string {
  if (axis === 'lat') return dd >= 0 ? 'N' : 'S'
  return dd >= 0 ? 'E' : 'W'
}

/**
 * Parse a coordinate written in DD, DMS or DDM. Returns decimal degrees, or
 * NaN if the text is not a coordinate on this axis.
 *
 * Deliberately strict about things that are ambiguous rather than merely
 * unusual: "-27 N" contradicts itself, "27 75.0" has impossible minutes, and
 * "27.5 30" mixes a fractional degree with a minutes field. All are rejected
 * instead of being silently reinterpreted — a wrong coordinate that looks
 * plausible is the worst outcome for a rescue crew.
 */
export function parseCoord(raw: string | null | undefined, axis: Axis): number {
  if (raw == null) return NaN
  let s = String(raw).trim()
  if (s === '') return NaN

  let sign = 1

  const hemi = s.match(/[NSEW]/i)
  if (hemi) {
    const h = hemi[0].toUpperCase()
    if (axis === 'lat' && (h === 'E' || h === 'W')) return NaN
    if (axis === 'lon' && (h === 'N' || h === 'S')) return NaN
    if (h === 'S' || h === 'W') sign = -1
    s = s.replace(/[NSEW]/gi, ' ')
  }

  if (/^\s*[-−]/.test(s)) {
    // A leading minus alongside an explicit hemisphere is contradictory.
    if (hemi) return NaN
    sign = -1
  }
  s = s.replace(/[-−+]/g, ' ')

  const tokens = s.match(NUMBER_TOKEN)
  if (!tokens || tokens.length === 0 || tokens.length > 3) return NaN

  const nums = tokens.map((t) => Number(t.replace(',', '.')))
  if (nums.some((n) => !Number.isFinite(n))) return NaN

  const [deg, min = 0, sec = 0] = nums

  // Only the last field present may be fractional.
  if (tokens.length > 1 && !Number.isInteger(deg)) return NaN
  if (tokens.length > 2 && !Number.isInteger(min)) return NaN
  if (min < 0 || min >= 60) return NaN
  if (sec < 0 || sec >= 60) return NaN

  const dd = sign * (deg + min / 60 + sec / 3600)
  const limit = axis === 'lat' ? 90 : 180
  if (!Number.isFinite(dd) || Math.abs(dd) > limit) return NaN
  return dd
}

/** Decimal degrees, e.g. `27.987850`. */
export function toDD(dd: number, digits = 6): string {
  return Number.isFinite(dd) ? dd.toFixed(digits) : ''
}

/**
 * Degrees / minutes / seconds, e.g. `27° 59' 16.3" N`.
 *
 * Rounds once on total seconds so a value like 59'59.98" carries into the next
 * minute instead of rendering the impossible `59' 60.0"`.
 */
export function toDMS(dd: number, axis: Axis, secondDigits = 1): string {
  if (!Number.isFinite(dd)) return ''
  const hemi = hemisphereFor(dd, axis)
  const factor = 10 ** secondDigits

  let remaining = Math.round(Math.abs(dd) * 3600 * factor) / factor
  const deg = Math.floor(remaining / 3600)
  remaining -= deg * 3600
  const min = Math.floor(remaining / 60)
  const sec = remaining - min * 60

  return `${deg}° ${min}' ${sec.toFixed(secondDigits)}" ${hemi}`
}

/** Degrees / decimal minutes, e.g. `27° 59.272' N`. */
export function toDDM(dd: number, axis: Axis, minuteDigits = 3): string {
  if (!Number.isFinite(dd)) return ''
  const hemi = hemisphereFor(dd, axis)
  const factor = 10 ** minuteDigits

  const remaining = Math.round(Math.abs(dd) * 60 * factor) / factor
  const deg = Math.floor(remaining / 60)
  const min = remaining - deg * 60

  return `${deg}° ${min.toFixed(minuteDigits)}' ${hemi}`
}

/** Normalise longitude into [-180, 180). */
export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

const LAT_BANDS = 'CDEFGHJKLMNPQRSTUVWX'

/** MGRS latitude band letter, or '' outside the UTM domain. */
export function latBand(lat: number): string {
  if (!Number.isFinite(lat) || lat < -80 || lat > 84) return ''
  // Band X is 12° tall rather than 8°, so it does not fall out of the formula.
  if (lat >= 72) return 'X'
  return LAT_BANDS.charAt(Math.floor((lat + 80) / 8))
}

/**
 * UTM zone number, honouring the two historical exceptions: south-west Norway
 * widens zone 32V, and Svalbard redraws zones 31X–37X.
 */
export function utmZone(lat: number, lon: number): number {
  const l = wrapLon(lon)
  let zone = Math.floor((l + 180) / 6) + 1
  const band = latBand(lat)

  if (band === 'V' && l >= 3 && l < 12) zone = 32

  if (band === 'X') {
    if (l >= 0 && l < 9) zone = 31
    else if (l >= 9 && l < 21) zone = 33
    else if (l >= 21 && l < 33) zone = 35
    else if (l >= 33 && l < 42) zone = 37
  }

  return zone
}

/**
 * Forward UTM projection on WGS-84, e.g. `17R 356421 3096502`.
 * Returns '' outside the UTM domain (below 80°S or above 84°N).
 */
export function toUTM(lat: number, lon: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return ''
  const band = latBand(lat)
  if (band === '') return ''

  const l = wrapLon(lon)
  const a = 6378137.0
  const f = 1 / 298.257223563
  const e2 = f * (2 - f)
  const ep2 = e2 / (1 - e2)
  const k0 = 0.9996
  const rad = Math.PI / 180

  const zone = utmZone(lat, l)
  const lonOrigin = (zone - 1) * 6 - 180 + 3

  const latR = lat * rad
  const lonR = l * rad
  const lonOR = lonOrigin * rad

  const N = a / Math.sqrt(1 - e2 * Math.sin(latR) ** 2)
  const T = Math.tan(latR) ** 2
  const C = ep2 * Math.cos(latR) ** 2
  const A = Math.cos(latR) * (lonR - lonOR)

  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * latR -
      ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) *
        Math.sin(2 * latR) +
      ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * latR) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * latR))

  const easting =
    k0 *
      N *
      (A +
        ((1 - T + C) * A ** 3) / 6 +
        ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) +
    500000

  let northing =
    k0 *
    (M +
      N *
        Math.tan(latR) *
        ((A * A) / 2 +
          ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720))

  if (lat < 0) northing += 10000000

  return `${zone}${band} ${Math.round(easting)} ${Math.round(northing)}`
}
