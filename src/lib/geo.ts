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

/** Clock time of arrival, given hours from now. */
export function formatEtaClock(hours: number, now = new Date()): string {
  if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 7) return ''
  const at = new Date(now.getTime() + hours * 3600 * 1000)
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
