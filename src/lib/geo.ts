/** Distance, bearing and the unit conversions the tracker and ETA need. */

const EARTH_RADIUS_NM = 3440.065
const RAD = Math.PI / 180

export const MPS_TO_KNOTS = 1.943844
export const NM_TO_METERS = 1852
export const NM_TO_MILES = 1.15078
export const NM_TO_KM = 1.852

/** Great-circle distance in nautical miles. */
export function haversineNM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = (lat2 - lat1) * RAD
  const dLon = (lon2 - lon1) * RAD
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** Initial great-circle bearing in degrees true, 0–360. */
export function bearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD)
  const x =
    Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) -
    Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD)
  return (Math.atan2(y, x) / RAD + 360) % 360
}

const COMPASS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]

/** Bearing as a 16-point compass label, e.g. 137° -> "SE". */
export function compassPoint(deg: number): string {
  if (!Number.isFinite(deg)) return ''
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]
}

/**
 * Where a bearing sits relative to the way you are facing, -180 to 180.
 *
 * Positive is to starboard, negative to port. This is what turns a compass
 * bearing into an arrow on the screen that means "that way" rather than one
 * the crew has to do arithmetic on.
 */
export function relativeBearing(bearing: number, heading: number): number {
  if (!Number.isFinite(bearing) || !Number.isFinite(heading)) return Number.NaN
  return ((((bearing - heading) % 360) + 540) % 360) - 180
}

/** A bearing as `137° SE`, or an em dash when it is unknown. */
export function formatBearing(deg: number): string {
  if (!Number.isFinite(deg)) return '—'
  const norm = ((deg % 360) + 360) % 360
  return `${Math.round(norm)}° ${compassPoint(norm)}`
}

/**
 * How close counts as standing on it — about 18 m, inside the error of a
 * consumer GPS on a good day.
 *
 * Inside that radius the bearing between the fix and the point is noise: a
 * metre of jitter swings it through the whole compass. The UI has to stop
 * printing a heading there, because a printed heading is one a crew can act
 * on, and this one means nothing.
 */
export const AT_POSITION_NM = 0.01

export function isAtPosition(distanceNM: number | null): boolean {
  return (
    distanceNM !== null &&
    Number.isFinite(distanceNM) &&
    distanceNM < AT_POSITION_NM
  )
}

export type DistanceUnit = 'nm' | 'mi' | 'km'

export function formatDistance(nm: number, unit: DistanceUnit): string {
  if (!Number.isFinite(nm)) return '—'
  if (unit === 'mi') return `${(nm * NM_TO_MILES).toFixed(2)} mi`
  if (unit === 'km') return `${(nm * NM_TO_KM).toFixed(2)} km`
  return `${nm.toFixed(2)} NM`
}

export function formatSpeed(mps: number | null | undefined): string {
  if (mps == null || !Number.isFinite(mps)) return '—'
  return `${(mps * MPS_TO_KNOTS).toFixed(1)} kn`
}

/** Hours as "4 h 12 min", "45 min", or "—" when it cannot be computed. */
export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '—'
  const totalMin = Math.round(hours * 60)
  if (totalMin < 1) return 'under a minute'
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m} min`
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `${d} d ${h % 24} h`
  }
  return `${h} h ${m} min`
}

/**
 * Total distance along a sequence of fixes, in nautical miles.
 *
 * Consecutive fixes closer together than the worse of the two accuracy figures
 * are treated as the same point. A phone sitting still reports a jittering
 * position, and summing that jitter would otherwise invent miles of travel.
 */
export function trailDistanceNM(
  points: { lat: number; lon: number; accuracy?: number | null }[],
): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const legNM = haversineNM(a.lat, a.lon, b.lat, b.lon)
    const slopM = Math.max(a.accuracy ?? 0, b.accuracy ?? 0)
    if (legNM * NM_TO_METERS <= slopM) continue
    total += legNM
  }
  return total
}

/**
 * Metres in a degree of latitude and of longitude at a given latitude.
 *
 * The usual "60 NM to a degree" shortcut is a sphere; the WGS-84 ellipsoid is
 * 110 574 m per degree at the equator and 111 694 m at the pole, a 1 % spread.
 * That is nothing on a chart and everything on a track filter working in
 * metres, where the same error turns straight into a speed and a drift. These
 * are the standard series expansions, good to well under a metre per degree.
 */
export function metersPerDegree(lat: number): { lat: number; lon: number } {
  const p = lat * RAD
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lon:
      111412.84 * Math.cos(p) -
      93.5 * Math.cos(3 * p) +
      0.118 * Math.cos(5 * p),
  }
}

/** Clock time of arrival, given hours from now. */
export function formatEtaClock(hours: number, now = new Date()): string {
  if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 7) return ''
  const at = new Date(now.getTime() + hours * 3600 * 1000)
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
