/**
 * What the crew reads, as opposed to what the app stores.
 *
 * NavMate stores in one set of units and always will: charted depths and
 * drafts in metres, water temperature in Celsius, speed in metres per second,
 * distance in nautical miles. Several of those are contracts rather than
 * preferences — `water_temp_c` and `draft_m` are read by the RescueGPS
 * command system's drift and survivability models, and a stored number that
 * changes meaning with a setting is a number nobody can trust afterwards.
 *
 * So everything here converts **at the screen boundary only**, in both
 * directions, and nothing in this file is ever called on the way into a
 * record. The read path is the dangerous one and the reason the boundary is a
 * single file: a record saved at 21 °C redisplayed under an °F label reads as
 * shirtsleeves when it is a survival window measured in minutes.
 */

export type DistanceUnit = 'nm' | 'mi' | 'km'
export type DepthUnit = 'ft' | 'm' | 'fm'
export type SpeedUnit = 'kn' | 'mph' | 'kmh'
export type TempUnit = 'f' | 'c'
export type AltitudeUnit = 'ft' | 'm'

export const M_TO_FEET = 3.280839895
export const FEET_TO_M = 0.3048
/** A fathom is six feet, and charts that use them are in six-foot steps. */
export const FEET_PER_FATHOM = 6
export const NM_TO_MILES = 1.15078
export const NM_TO_KM = 1.852
export const MPS_TO_KNOTS = 1.943844
export const MPS_TO_MPH = 2.236936
export const MPS_TO_KMH = 3.6

export const DISTANCE_UNITS: { id: DistanceUnit; label: string; hint: string }[] = [
  { id: 'nm', label: 'NM', hint: 'Nautical miles — charts, radios and every bearing in this app' },
  { id: 'mi', label: 'Miles', hint: 'Statute miles' },
  { id: 'km', label: 'km', hint: 'Kilometres' },
]

export const DEPTH_UNITS: { id: DepthUnit; label: string; hint: string }[] = [
  { id: 'ft', label: 'Feet', hint: 'What most US crews say aloud' },
  { id: 'm', label: 'Metres', hint: 'What the chart data is published in' },
  { id: 'fm', label: 'Fathoms', hint: 'Six feet to the fathom, for older charts' },
]

export const SPEED_UNITS: { id: SpeedUnit; label: string; hint: string }[] = [
  { id: 'kn', label: 'Knots', hint: 'Nautical miles per hour' },
  { id: 'mph', label: 'mph', hint: 'Statute miles per hour' },
  { id: 'kmh', label: 'km/h', hint: 'Kilometres per hour' },
]

export const TEMP_UNITS: { id: TempUnit; label: string; hint: string }[] = [
  { id: 'f', label: '°F', hint: 'Fahrenheit' },
  { id: 'c', label: '°C', hint: 'Celsius — what the record stores either way' },
]

export const ALTITUDE_UNITS: { id: AltitudeUnit; label: string; hint: string }[] = [
  { id: 'ft', label: 'Feet', hint: 'Altitude and height above water' },
  { id: 'm', label: 'Metres', hint: 'Altitude and height above water' },
]

/* ---------------------------------------------------------------- distance */

export function distanceIn(nm: number, unit: DistanceUnit): number {
  if (unit === 'mi') return nm * NM_TO_MILES
  if (unit === 'km') return nm * NM_TO_KM
  return nm
}

export const DISTANCE_SUFFIX: Record<DistanceUnit, string> = {
  nm: 'NM',
  mi: 'mi',
  km: 'km',
}

/**
 * A distance, with the precision that suits its size.
 *
 * Two decimals under ten of whatever unit, one above: 0.08 NM is a useful
 * number and 12.34 NM is false precision on a passage nobody steers to a
 * hundredth.
 */
export function formatLength(nm: number, unit: DistanceUnit): string {
  if (!Number.isFinite(nm)) return '—'
  const v = distanceIn(nm, unit)
  const digits = Math.abs(v) < 10 ? 2 : 1
  return `${v.toFixed(digits)} ${DISTANCE_SUFFIX[unit]}`
}

/* ------------------------------------------------------------------- depth */

export function depthIn(metres: number, unit: DepthUnit): number {
  if (unit === 'm') return metres
  const feet = metres * M_TO_FEET
  return unit === 'fm' ? feet / FEET_PER_FATHOM : feet
}

export function depthToMetres(value: number, unit: DepthUnit): number {
  if (unit === 'm') return value
  const feet = unit === 'fm' ? value * FEET_PER_FATHOM : value
  return feet * FEET_TO_M
}

export const DEPTH_SUFFIX: Record<DepthUnit, string> = {
  ft: 'ft',
  m: 'm',
  fm: 'fm',
}

/** "18.4 ft". Null or a non-number prints a dash rather than "NaN ft". */
export function formatDepth(metres: number | null, unit: DepthUnit): string {
  if (metres == null || !Number.isFinite(metres)) return '—'
  const v = depthIn(metres, unit)
  // Fathoms are a coarse unit; a tenth of one is two inches of water.
  return `${v.toFixed(unit === 'fm' ? 1 : 1)} ${DEPTH_SUFFIX[unit]}`
}

/**
 * The long form, for the one place a boat's own numbers are set up.
 *
 * It carries metres in brackets whatever the setting, because a draft is
 * checked against a chart published in metres and the person typing it is
 * entitled to see both without changing a preference.
 */
export function formatDepthBoth(metres: number | null, unit: DepthUnit): string {
  if (metres == null || !Number.isFinite(metres)) return '—'
  if (unit === 'm') return `${metres.toFixed(1)} m`
  return `${formatDepth(metres, unit)} (${metres.toFixed(1)} m)`
}

/* ------------------------------------------------------------------- speed */

export function speedIn(mps: number, unit: SpeedUnit): number {
  if (unit === 'mph') return mps * MPS_TO_MPH
  if (unit === 'kmh') return mps * MPS_TO_KMH
  return mps * MPS_TO_KNOTS
}

export const SPEED_SUFFIX: Record<SpeedUnit, string> = {
  kn: 'kn',
  mph: 'mph',
  kmh: 'km/h',
}

export function formatSpeedIn(
  mps: number | null | undefined,
  unit: SpeedUnit,
): string {
  if (mps == null || !Number.isFinite(mps)) return '—'
  return `${speedIn(mps, unit).toFixed(1)} ${SPEED_SUFFIX[unit]}`
}

/** Knots to the crew's unit, for the many places that already hold knots. */
export function knotsIn(kn: number, unit: SpeedUnit): number {
  return speedIn(kn / MPS_TO_KNOTS, unit)
}

export function formatKnots(kn: number | null | undefined, unit: SpeedUnit): string {
  if (kn == null || !Number.isFinite(kn)) return '—'
  return `${knotsIn(kn, unit).toFixed(1)} ${SPEED_SUFFIX[unit]}`
}

/* ------------------------------------------------------------- temperature */

export function cToF(c: number): number {
  return (c * 9) / 5 + 32
}

export function fToC(f: number): number {
  return ((f - 32) * 5) / 9
}

export function tempIn(celsius: number, unit: TempUnit): number {
  return unit === 'f' ? cToF(celsius) : celsius
}

export function tempToCelsius(value: number, unit: TempUnit): number {
  return unit === 'f' ? fToC(value) : value
}

export const TEMP_SUFFIX: Record<TempUnit, string> = { f: '°F', c: '°C' }

export function formatTemp(celsius: number | null, unit: TempUnit): string {
  if (celsius == null || !Number.isFinite(celsius)) return '—'
  return `${tempIn(celsius, unit).toFixed(0)} ${TEMP_SUFFIX[unit]}`
}

/* ---------------------------------------------------------------- altitude */

export function altitudeIn(metres: number, unit: AltitudeUnit): number {
  return unit === 'ft' ? metres * M_TO_FEET : metres
}

export function formatAltitude(
  metres: number | null | undefined,
  unit: AltitudeUnit,
): string {
  if (metres == null || !Number.isFinite(metres)) return '—'
  return `${Math.round(altitudeIn(metres, unit))} ${unit === 'ft' ? 'ft' : 'm'}`
}
