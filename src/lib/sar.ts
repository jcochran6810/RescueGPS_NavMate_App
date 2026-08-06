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
  /** Canonical RescueGPS leeway_type code (Allen & Plourde 1999 category). */
  key: string
  label: string
  /** Downwind leeway: speed = slope × wind + offset, knots. */
  downwindSlope: number
  downwindOffsetKts: number
  /** Crosswind leeway component: speed = slope × wind, either side. */
  crosswindSlope: number
  /** How visible the object is to a lookout — drives sweep width. */
  visibility: 'high' | 'medium' | 'low'
}

/**
 * The choices a single field unit actually picks between, keyed by the
 * canonical Allen & Plourde codes RescueGPS's drift engine accepts as
 * `leeway_type`, carrying that ontology's exact coefficients
 * (downwind_slope / downwind_offset_kts / crosswind_slope). RescueGPS
 * carries 88 categories; fifteen is what fits a gloved thumb on a pitching
 * deck, so each entry here is the nearest canonical category.
 */
export const SEARCH_OBJECT_TYPES: SearchObjectType[] = [
  { key: 'person_in_water', label: 'Person in water', downwindSlope: 0.011, downwindOffsetKts: 0.07, crosswindSlope: 0.007, visibility: 'low' },
  { key: 'person_with_pfd', label: 'Person in water with PFD', downwindSlope: 0.014, downwindOffsetKts: 0.08, crosswindSlope: 0.009, visibility: 'low' },
  { key: 'person_scuba', label: 'Person in drysuit / scuba', downwindSlope: 0.012, downwindOffsetKts: 0.06, crosswindSlope: 0.007, visibility: 'low' },
  { key: 'life_raft_no_ballast_canopy_light', label: 'Life raft (no ballast)', downwindSlope: 0.04, downwindOffsetKts: 0.35, crosswindSlope: 0.026, visibility: 'medium' },
  { key: 'life_raft_shallow', label: 'Life raft (shallow ballast)', downwindSlope: 0.035, downwindOffsetKts: 0.28, crosswindSlope: 0.022, visibility: 'medium' },
  { key: 'life_raft_deep', label: 'Life raft (deep ballast)', downwindSlope: 0.019, downwindOffsetKts: 0.15, crosswindSlope: 0.012, visibility: 'medium' },
  { key: 'skiff_v_hull', label: 'Small vessel (< 20 ft)', downwindSlope: 0.028, downwindOffsetKts: 0.18, crosswindSlope: 0.017, visibility: 'medium' },
  { key: 'powerboat_cabin', label: 'Powerboat (20–40 ft)', downwindSlope: 0.04, downwindOffsetKts: 0.45, crosswindSlope: 0.028, visibility: 'high' },
  { key: 'sailboat_monohull', label: 'Sailboat', downwindSlope: 0.03, downwindOffsetKts: 0.3, crosswindSlope: 0.024, visibility: 'high' },
  { key: 'kayak_sea', label: 'Kayak', downwindSlope: 0.022, downwindOffsetKts: 0.1, crosswindSlope: 0.014, visibility: 'medium' },
  { key: 'canoe', label: 'Canoe', downwindSlope: 0.02, downwindOffsetKts: 0.1, crosswindSlope: 0.013, visibility: 'medium' },
  { key: 'surfboard', label: 'Surfboard', downwindSlope: 0.018, downwindOffsetKts: 0.08, crosswindSlope: 0.011, visibility: 'low' },
  { key: 'standup_paddleboard', label: 'Paddleboard', downwindSlope: 0.016, downwindOffsetKts: 0.08, crosswindSlope: 0.01, visibility: 'low' },
  { key: 'wooden_plank', label: 'Debris (wood)', downwindSlope: 0.015, downwindOffsetKts: 0.08, crosswindSlope: 0.009, visibility: 'low' },
  { key: 'cooler_small', label: 'Cooler / ice chest', downwindSlope: 0.035, downwindOffsetKts: 0.22, crosswindSlope: 0.021, visibility: 'low' },
]

/**
 * The keys NavMate used before it adopted the canonical codes. Records saved
 * with these still resolve; without the map an old LKP would silently fall
 * back to person_in_water.
 */
const OBJECT_TYPE_ALIASES: Record<string, string> = {
  person_in_drysuit: 'person_scuba',
  life_raft_4_person: 'life_raft_shallow',
  life_raft_6_person: 'life_raft_shallow',
  life_raft_10_plus: 'life_raft_deep',
  small_vessel: 'skiff_v_hull',
  medium_vessel: 'powerboat_cabin',
  sailboat: 'sailboat_monohull',
  kayak: 'kayak_sea',
  paddleboard: 'standup_paddleboard',
  wood_debris: 'wooden_plank',
  cooler: 'cooler_small',
}

export function searchObjectType(key: string): SearchObjectType {
  const canonical = OBJECT_TYPE_ALIASES[key] ?? key
  return (
    SEARCH_OBJECT_TYPES.find((t) => t.key === canonical) ??
    SEARCH_OBJECT_TYPES[0]
  )
}

/** The canonical leeway_type code for any stored key, old or new. */
export function canonicalObjectKey(key: string): string {
  return searchObjectType(key).key
}

/** Downwind leeway speed in knots: slope × wind + offset, zero in a calm. */
export function leewayKts(windKts: number, type: SearchObjectType): number {
  if (!Number.isFinite(windKts) || windKts <= 0) return 0
  return windKts * type.downwindSlope + type.downwindOffsetKts
}

/** Crosswind leeway component in knots, either side of downwind. */
export function crosswindKts(windKts: number, type: SearchObjectType): number {
  if (!Number.isFinite(windKts) || windKts <= 0) return 0
  return windKts * type.crosswindSlope
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
  /** Crosswind leeway component, knots — what makes left and right differ. */
  crosswindLeewayKts: number
  datum: { lat: number; lon: number }
  /** Leeway carries a crosswind component either side of downwind, so the
   *  object is as likely to be off to one side as dead downwind. Both sides
   *  are worth marking. */
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
 * Leeway follows the Allen & Plourde form RescueGPS's drift engine uses:
 * a downwind component (slope × wind + offset) plus a crosswind component
 * (slope × wind) that can act to either side — which is what puts the left
 * and right datums off the downwind line. Drift error is taken as 0.3 ×
 * drift distance, combined with the initial position error and the search
 * unit's navigation error as a root-sum-square, and the first search radius
 * is that total with a 10 % safety factor. With no wind or current entered
 * the datum is the LKP and the radius is just the position errors — still a
 * real answer.
 */
export function computeDatum(input: DatumInput): DatumResult {
  const hours = Math.max(0, (input.at - input.lkp.time) / 3_600_000)

  const current =
    input.currentTowardDeg !== null &&
    input.currentKts !== null &&
    input.currentKts > 0
      ? toVector(input.currentTowardDeg, input.currentKts)
      : { n: 0, e: 0 }

  const windOn =
    input.windFromDeg !== null && input.windKts !== null && input.windKts > 0
  const lee = windOn ? leewayKts(input.windKts!, input.objectType) : 0
  const cross = windOn ? crosswindKts(input.windKts!, input.objectType) : 0
  const downwind = input.windFromDeg !== null ? (input.windFromDeg + 180) % 360 : 0

  const add = (a: Vector, b: Vector): Vector => ({ n: a.n + b.n, e: a.e + b.e })

  const centre = add(current, toVector(downwind, lee))
  const driftKts = vectorSpeed(centre)
  const driftBearing = vectorBearing(centre)
  const driftDistanceNM = driftKts * hours

  const place = (v: Vector) => {
    const d = vectorSpeed(v) * hours
    return d > 0
      ? projectPosition(input.lkp.lat, input.lkp.lon, vectorBearing(v), d)
      : { lat: input.lkp.lat, lon: input.lkp.lon }
  }

  const datum = place(centre)
  const datumLeft =
    cross > 0 ? place(add(centre, toVector((downwind + 270) % 360, cross))) : datum
  const datumRight =
    cross > 0 ? place(add(centre, toVector((downwind + 90) % 360, cross))) : datum

  const driftErrorNM = 0.3 * driftDistanceNM
  const totalErrorNM = Math.hypot(input.lkpErrorNM, NAV_ERROR_NM, driftErrorNM)
  const searchRadiusNM = 1.1 * totalErrorNM

  return {
    hoursAdrift: hours,
    driftKts,
    driftBearingDeg: driftBearing,
    driftDistanceNM,
    leewayKts: lee,
    crosswindLeewayKts: cross,
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
      search_object: { leeway_type: canonicalObjectKey(input.objectTypeKey) },
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
        leeway_type: canonicalObjectKey(input.objectTypeKey),
        duration_hrs: Math.max(1, Math.ceil(result.hoursAdrift) + 6),
      },
    },
    null,
    2,
  )
}
