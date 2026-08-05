/**
 * SAR datum mathematics: leeway, drift, the datum position and the first
 * search radius — computed on the device, because the unit that needs a datum
 * is usually the one outside coverage.
 *
 * NavMate is the field app for RescueGPS, and this module speaks that
 * system's language on purpose: `leeway_type` keys, wind directions given as
 * where the wind blows FROM (meteorological), current directions as where the
 * water flows TOWARD (oceanographic), speeds in knots. The exported report
 * (`datumReport`) matches the parameter names of RescueGPS's drift engine so
 * a collected datum can be fed straight into a full Monte Carlo run when the
 * unit gets back into coverage.
 *
 * The worksheet itself is the IAMSAR single-unit method: total water movement
 * plus leeway, applied for the time adrift, with the search radius built from
 * the root-sum-square of the position errors and a 10 % safety factor. It is
 * a first-cut planning number, not a replacement for the drift engine — the
 * UI says so.
 */

import { haversineNM, bearingDeg } from './geo'

const RAD = Math.PI / 180
const EARTH_RADIUS_NM = 3440.065

/* -------------------------------------------------------------------------
 * Search object types (leeway)
 * ---------------------------------------------------------------------- */

export interface SearchObjectType {
  key: string
  label: string
  /** Leeway speed as a fraction of wind speed (USCG/IAMSAR-derived). */
  downwindFactor: number
  /** Leeway divergence either side of downwind, degrees. */
  divergenceDeg: number
}

/**
 * The common USCG/IAMSAR leeway table, keyed the way RescueGPS's drift engine
 * keys `leeway_type` (lower snake case). RescueGPS carries 88 Allen & Plourde
 * categories; these are the ones a single field unit actually chooses between.
 */
export const SEARCH_OBJECT_TYPES: SearchObjectType[] = [
  { key: 'person_in_water', label: 'Person in water', downwindFactor: 0.03, divergenceDeg: 15 },
  { key: 'person_with_pfd', label: 'Person in water with PFD', downwindFactor: 0.04, divergenceDeg: 20 },
  { key: 'person_in_drysuit', label: 'Person in drysuit', downwindFactor: 0.05, divergenceDeg: 25 },
  { key: 'life_raft_4_person', label: 'Life raft (4 person)', downwindFactor: 0.06, divergenceDeg: 10 },
  { key: 'life_raft_6_person', label: 'Life raft (6 person)', downwindFactor: 0.065, divergenceDeg: 12 },
  { key: 'life_raft_10_plus', label: 'Life raft (10+)', downwindFactor: 0.07, divergenceDeg: 15 },
  { key: 'small_vessel', label: 'Small vessel (< 20 ft)', downwindFactor: 0.05, divergenceDeg: 5 },
  { key: 'medium_vessel', label: 'Vessel (20–40 ft)', downwindFactor: 0.04, divergenceDeg: 3 },
  { key: 'sailboat', label: 'Sailboat', downwindFactor: 0.08, divergenceDeg: 20 },
  { key: 'kayak', label: 'Kayak', downwindFactor: 0.045, divergenceDeg: 18 },
  { key: 'canoe', label: 'Canoe', downwindFactor: 0.05, divergenceDeg: 20 },
  { key: 'surfboard', label: 'Surfboard', downwindFactor: 0.035, divergenceDeg: 25 },
  { key: 'paddleboard', label: 'Paddleboard', downwindFactor: 0.04, divergenceDeg: 22 },
  { key: 'wood_debris', label: 'Debris (wood)', downwindFactor: 0.02, divergenceDeg: 30 },
  { key: 'cooler', label: 'Cooler / ice chest', downwindFactor: 0.055, divergenceDeg: 15 },
]

export function searchObjectType(key: string): SearchObjectType {
  return (
    SEARCH_OBJECT_TYPES.find((t) => t.key === key) ?? SEARCH_OBJECT_TYPES[0]
  )
}

/** Leeway speed in knots for a wind, per object type. */
export function leewayKts(windKts: number, type: SearchObjectType): number {
  if (!Number.isFinite(windKts) || windKts <= 0) return 0
  return windKts * type.downwindFactor
}

/* -------------------------------------------------------------------------
 * Vector geometry
 * ---------------------------------------------------------------------- */

/** Where a great-circle leg of `distanceNM` toward `bearing` ends up. */
export function projectPosition(
  lat: number,
  lon: number,
  bearing: number,
  distanceNM: number,
): { lat: number; lon: number } {
  const d = distanceNM / EARTH_RADIUS_NM
  const brg = bearing * RAD
  const lat1 = lat * RAD
  const lon1 = lon * RAD

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg),
  )
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    )

  return {
    lat: lat2 / RAD,
    lon: ((lon2 / RAD + 540) % 360) - 180,
  }
}

interface Vector {
  /** Knots north. */
  n: number
  /** Knots east. */
  e: number
}

function toVector(towardDeg: number, kts: number): Vector {
  return {
    n: kts * Math.cos(towardDeg * RAD),
    e: kts * Math.sin(towardDeg * RAD),
  }
}

function vectorSpeed(v: Vector): number {
  return Math.hypot(v.n, v.e)
}

function vectorBearing(v: Vector): number {
  return (Math.atan2(v.e, v.n) / RAD + 360) % 360
}

/* -------------------------------------------------------------------------
 * Set and drift from an observed marker
 * ---------------------------------------------------------------------- */

export interface DriftObservation {
  /** Direction of movement, degrees true (toward). */
  setDeg: number
  /** Speed of movement, knots. */
  driftKts: number
  distanceNM: number
  hours: number
}

/**
 * Observed set and drift from a marker deployed and later retrieved — the
 * field measurement that beats any forecast, because it is the actual water
 * the search object is in.
 */
export function observedDrift(
  deploy: { lat: number; lon: number; time: number },
  retrieve: { lat: number; lon: number; time: number },
): DriftObservation | null {
  const hours = (retrieve.time - deploy.time) / 3_600_000
  if (!Number.isFinite(hours) || hours <= 0) return null
  const distanceNM = haversineNM(deploy.lat, deploy.lon, retrieve.lat, retrieve.lon)
  return {
    setDeg: bearingDeg(deploy.lat, deploy.lon, retrieve.lat, retrieve.lon),
    driftKts: distanceNM / hours,
    distanceNM,
    hours,
  }
}

/* -------------------------------------------------------------------------
 * The datum worksheet
 * ---------------------------------------------------------------------- */

export type LkpSource = 'gps' | 'witness' | 'estimated'

/**
 * Initial position error by how the LKP was fixed, nautical miles. The GPS
 * figure is generous for a phone fix; the witness and estimate figures are
 * the working numbers used when nothing better is known. All are editable in
 * the UI — these are defaults, not doctrine.
 */
export const LKP_ERROR_NM: Record<LkpSource, number> = {
  gps: 0.1,
  witness: 1.0,
  estimated: 2.5,
}

/** Search-unit navigation error, NM. GPS-equipped: small and flat. */
export const NAV_ERROR_NM = 0.1

export interface DatumInput {
  lkp: { lat: number; lon: number; time: number }
  /** When the datum is being computed for — normally now. */
  at: number
  objectType: SearchObjectType
  /** Where the wind blows FROM, degrees true. */
  windFromDeg: number | null
  windKts: number | null
  /** Where the current flows TOWARD, degrees true. */
  currentTowardDeg: number | null
  currentKts: number | null
  /** Initial LKP position error, NM. */
  lkpErrorNM: number
}

export interface DatumResult {
  hoursAdrift: number
  /** Combined current + leeway movement. */
  driftKts: number
  driftBearingDeg: number
  driftDistanceNM: number
  leewayKts: number
  datum: { lat: number; lon: number }
  /** Leeway diverges either side of downwind, so the object is as likely to
   *  be off to one side as dead downwind. Both sides are worth marking. */
  datumLeft: { lat: number; lon: number }
  datumRight: { lat: number; lon: number }
  /** Total probable position error, NM (RSS of LKP, nav and drift error). */
  totalErrorNM: number
  /** First search radius: E × 1.1 (IAMSAR safety factor). */
  searchRadiusNM: number
}

/**
 * The IAMSAR single-unit datum worksheet.
 *
 * datum = LKP + (total water current × time) + (leeway × time)
 *
 * Drift error is taken as 0.3 × drift distance, combined with the initial
 * position error and the search unit's navigation error as a root-sum-square,
 * and the first search radius is that total with a 10 % safety factor. With
 * no wind or current entered the datum is the LKP and the radius is just the
 * position errors — still a real answer.
 */
export function computeDatum(input: DatumInput): DatumResult {
  const hours = Math.max(0, (input.at - input.lkp.time) / 3_600_000)

  const current =
    input.currentTowardDeg !== null &&
    input.currentKts !== null &&
    input.currentKts > 0
      ? toVector(input.currentTowardDeg, input.currentKts)
      : { n: 0, e: 0 }

  const lee =
    input.windFromDeg !== null && input.windKts !== null && input.windKts > 0
      ? leewayKts(input.windKts, input.objectType)
      : 0
  const downwind = input.windFromDeg !== null ? (input.windFromDeg + 180) % 360 : 0

  const total = (leewayToward: number): Vector => {
    const l = toVector(leewayToward, lee)
    return { n: current.n + l.n, e: current.e + l.e }
  }

  const centre = total(downwind)
  const driftKts = vectorSpeed(centre)
  const driftBearing = vectorBearing(centre)
  const driftDistanceNM = driftKts * hours

  const place = (v: Vector) => {
    const d = vectorSpeed(v) * hours
    return d > 0
      ? projectPosition(input.lkp.lat, input.lkp.lon, vectorBearing(v), d)
      : { lat: input.lkp.lat, lon: input.lkp.lon }
  }

  const div = input.objectType.divergenceDeg
  const datum = place(centre)
  const datumLeft = lee > 0 ? place(total((downwind - div + 360) % 360)) : datum
  const datumRight = lee > 0 ? place(total((downwind + div) % 360)) : datum

  const driftErrorNM = 0.3 * driftDistanceNM
  const totalErrorNM = Math.hypot(input.lkpErrorNM, NAV_ERROR_NM, driftErrorNM)
  const searchRadiusNM = 1.1 * totalErrorNM

  return {
    hoursAdrift: hours,
    driftKts,
    driftBearingDeg: driftBearing,
    driftDistanceNM,
    leewayKts: lee,
    datum,
    datumLeft,
    datumRight,
    totalErrorNM,
    searchRadiusNM,
  }
}

/* -------------------------------------------------------------------------
 * The datum report — what gets handed to RescueGPS
 * ---------------------------------------------------------------------- */

export interface DatumReportInput {
  lkp: {
    lat: number
    lon: number
    time: number
    source: LkpSource
    errorNM: number
    note?: string
  }
  objectTypeKey: string
  windFromDeg: number | null
  windKts: number | null
  currentTowardDeg: number | null
  currentKts: number | null
  waterTempC?: number | null
  result: DatumResult
  observations?: (DriftObservation & { deployTime: number })[]
  clues?: {
    type: string
    lat: number | null
    lon: number | null
    time: number
    note: string
  }[]
}

/**
 * Everything a datum run needs, in RescueGPS's own field names — `lng` not
 * `lon`, wind FROM, current TOWARD, knots throughout — so the file imports
 * into the drift engine without a translation step. `simulate_drift_params`
 * is exactly the parameter object of that engine's `simulateDrift()`.
 */
export function datumReport(input: DatumReportInput): string {
  const { result } = input
  return JSON.stringify(
    {
      format: 'rescuegps-navmate/datum-report',
      version: 1,
      generated_at: new Date().toISOString(),
      lkp: {
        lat: input.lkp.lat,
        lng: input.lkp.lon,
        time: new Date(input.lkp.time).toISOString(),
        source: input.lkp.source,
        position_error_nm: input.lkp.errorNM,
        note: input.lkp.note ?? '',
      },
      search_object: { leeway_type: input.objectTypeKey },
      environmental: {
        wind_speed_kts: input.windKts,
        wind_direction_deg: input.windFromDeg,
        current_speed_kts: input.currentKts,
        current_direction_deg: input.currentTowardDeg,
        water_temp_c: input.waterTempC ?? null,
      },
      drift_observations: (input.observations ?? []).map((o) => ({
        deploy_time: new Date(o.deployTime).toISOString(),
        set_deg: o.setDeg,
        drift_kts: o.driftKts,
        distance_nm: o.distanceNM,
        hours: o.hours,
      })),
      clues: (input.clues ?? []).map((c) => ({
        type: c.type,
        lat: c.lat,
        lng: c.lon,
        time: new Date(c.time).toISOString(),
        note: c.note,
      })),
      datum: {
        hours_adrift: result.hoursAdrift,
        lat: result.datum.lat,
        lng: result.datum.lon,
        left: { lat: result.datumLeft.lat, lng: result.datumLeft.lon },
        right: { lat: result.datumRight.lat, lng: result.datumRight.lon },
        drift_bearing_deg: result.driftBearingDeg,
        drift_distance_nm: result.driftDistanceNM,
        total_probable_error_nm: result.totalErrorNM,
        search_radius_nm: result.searchRadiusNM,
      },
      simulate_drift_params: {
        lat: input.lkp.lat,
        lng: input.lkp.lon,
        wind_speed_kts: input.windKts ?? 0,
        wind_direction_deg: input.windFromDeg ?? 0,
        current_speed_kts: input.currentKts ?? 0,
        current_direction_deg: input.currentTowardDeg ?? 0,
        leeway_type: input.objectTypeKey,
        duration_hrs: Math.max(1, Math.ceil(result.hoursAdrift) + 6),
      },
    },
    null,
    2,
  )
}
