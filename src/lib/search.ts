/**
 * Search patterns and coverage — the aids a single unit uses to actually run
 * a search, computed on the device.
 *
 * Everything here is ported from the RescueGPS (rescuegps-navigator-pro)
 * ontology — IAMSAR Vol II Ch 5 as amended by MSC.1/Circ.1594 — and speaks
 * that system's language: pattern codes SS/VS/PS/CL, the generator ids its
 * `field_assignments.pattern_type` column carries, sweep widths in NM,
 * coverage C = W / S, POD = 1 − e^(−C).
 *
 * Deliberately light: leg geometry, spacing guidance and a time estimate.
 * The Monte Carlo drift engine, effort allocation and probability maps stay
 * on the command side — a phone plans and steers one unit's pattern, no more.
 */

import { projectPosition } from './sar'
import { bearingDeg, haversineNM } from './geo'

/* -------------------------------------------------------------------------
 * Pattern geometry
 * ---------------------------------------------------------------------- */

export type PatternCode = 'SS' | 'VS' | 'PS' | 'CL'

/** RescueGPS `field_assignments.pattern_type` values, per pattern code. */
export const PATTERN_GENERATOR_ID: Record<PatternCode, string> = {
  SS: 'expanding-square',
  VS: 'sector',
  PS: 'parallel',
  CL: 'creeping-line',
}

export const PATTERN_NAMES: Record<PatternCode, string> = {
  SS: 'Expanding square',
  VS: 'Sector search',
  PS: 'Parallel track',
  CL: 'Creeping line',
}

export interface LatLon {
  lat: number
  lon: number
}

export interface PatternLeg {
  /** 1-based leg number. */
  n: number
  from: LatLon
  to: LatLon
  /** Commanded course, degrees true. */
  courseDeg: number
  lengthNM: number
  /** Connectors are the short cross-legs between search legs. */
  kind: 'search' | 'connector'
}

export interface SearchPatternPlan {
  code: PatternCode
  /** Commence search point. For SS and VS this is always the datum. */
  csp: LatLon
  /** Every point in order, CSP first — what gets drawn and steered. */
  points: LatLon[]
  legs: PatternLeg[]
  totalNM: number
  spacingNM: number
}

/**
 * Legs from an ordered list of points: leg i is the one arriving at
 * `points[i]`. Exported because a plotted route is the same object as a
 * pattern — one definition of a leg means the steering card cannot drift
 * between the two.
 */
export function buildLegs(
  points: LatLon[],
  searchLeg: (i: number) => boolean,
): {
  legs: PatternLeg[]
  totalNM: number
} {
  const legs: PatternLeg[] = []
  let totalNM = 0
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]
    const to = points[i]
    const lengthNM = haversineNM(from.lat, from.lon, to.lat, to.lon)
    totalNM += lengthNM
    legs.push({
      n: i,
      from,
      to,
      courseDeg: bearingDeg(from.lat, from.lon, to.lat, to.lon),
      lengthNM,
      kind: searchLeg(i) ? 'search' : 'connector',
    })
  }
  return { legs, totalNM }
}

/**
 * Expanding square (SS): CSP is always the datum — the ontology is emphatic
 * about that — first leg on `orientationDeg` (normally the drift direction),
 * every turn 90° to starboard, and leg i is `ceil(i/2) × S` long: 1S, 1S,
 * 2S, 2S, 3S, 3S… For a datum known well and a small area.
 */
export function expandingSquare(
  datum: LatLon,
  spacingNM: number,
  numLegs: number,
  orientationDeg = 0,
): SearchPatternPlan {
  const points: LatLon[] = [datum]
  let at = datum
  for (let i = 1; i <= numLegs; i++) {
    const course = (orientationDeg + 90 * (i - 1)) % 360
    const length = Math.ceil(i / 2) * spacingNM
    at = projectPosition(at.lat, at.lon, course, length)
    points.push(at)
  }
  const { legs, totalNM } = buildLegs(points, () => true)
  return { code: 'SS', csp: datum, points, legs, totalNM, spacingNM }
}

/**
 * How many square legs it takes to sweep out to `radiusNM` around the datum.
 * After 4m legs the square's half-width is m × S, so the whole circle of
 * radius r is inside after 4 × ceil(r / S) legs. Clamped to something a
 * single crew can actually run.
 */
export function expandingSquareLegsFor(
  radiusNM: number,
  spacingNM: number,
): number {
  if (!(radiusNM > 0) || !(spacingNM > 0)) return 8
  return Math.min(40, Math.max(4, 4 * Math.ceil(radiusNM / spacingNM)))
}

/**
 * Sector search (VS): three equilateral triangles with bases 120° apart —
 * the three-leaf clover — 9 legs, every one of length R, every pass back
 * through the datum, which is where a drifting person most probably is.
 * First leg down-drift by convention. All turns are 120°.
 */
export function sectorSearch(
  datum: LatLon,
  radiusNM: number,
  firstLegDeg = 0,
): SearchPatternPlan {
  const points: LatLon[] = [datum]
  for (let t = 0; t < 3; t++) {
    const base = (firstLegDeg + 120 * t) % 360
    // Both vertices sit R from the datum, 60° apart, so the chord between
    // them is also R — an equilateral triangle through the CSP.
    points.push(projectPosition(datum.lat, datum.lon, base, radiusNM))
    points.push(
      projectPosition(datum.lat, datum.lon, (base + 60) % 360, radiusNM),
    )
    points.push(datum)
  }
  const { legs, totalNM } = buildLegs(points, () => true)
  return { code: 'VS', csp: datum, points, legs, totalNM, spacingNM: radiusNM }
}

/** IAMSAR sector-search radius bounds for a vessel, NM. */
export const SECTOR_RADIUS_NM = { min: 2, max: 5, default: 2 }

/**
 * Parallel track (PS): serpentine legs of `legLengthNM` along
 * `orientationDeg` (the area's long axis when there is one), `spacingNM`
 * apart, centred on the datum both across and along the legs so the most
 * probable position is in the middle of the swept box.
 */
export function parallelSweep(
  center: LatLon,
  legLengthNM: number,
  spacingNM: number,
  numLegs: number,
  orientationDeg = 0,
): SearchPatternPlan {
  const port = (orientationDeg + 270) % 360
  const stbd = (orientationDeg + 90) % 360
  const back = (orientationDeg + 180) % 360

  let corner = projectPosition(
    center.lat,
    center.lon,
    port,
    ((numLegs - 1) * spacingNM) / 2,
  )
  corner = projectPosition(corner.lat, corner.lon, back, legLengthNM / 2)

  const points: LatLon[] = [corner]
  let at = corner
  for (let i = 0; i < numLegs; i++) {
    const course = i % 2 === 0 ? orientationDeg : back
    at = projectPosition(at.lat, at.lon, course, legLengthNM)
    points.push(at)
    if (i < numLegs - 1) {
      at = projectPosition(at.lat, at.lon, stbd, spacingNM)
      points.push(at)
    }
  }
  const { legs, totalNM } = buildLegs(points, (i) => i % 2 === 1)
  return { code: 'PS', csp: corner, points, legs, totalNM, spacingNM }
}

/**
 * Creeping line (CL): legs perpendicular to `advanceDeg`, advancing S along
 * it after each — the drift-aligned search, run when the object is moving
 * and the area is elongated along its track. Starts at the datum and creeps
 * down-drift, legs centred on the drift line.
 *
 * This is a true creeping line, not a relabelled parallel sweep — the
 * command side's own generator currently takes that shortcut and records it
 * as a known simplification.
 */
export function creepingLine(
  datum: LatLon,
  legLengthNM: number,
  spacingNM: number,
  numLegs: number,
  advanceDeg = 0,
): SearchPatternPlan {
  const left = (advanceDeg + 270) % 360
  const right = (advanceDeg + 90) % 360

  const start = projectPosition(datum.lat, datum.lon, left, legLengthNM / 2)
  const points: LatLon[] = [start]
  let at = start
  for (let i = 0; i < numLegs; i++) {
    const course = i % 2 === 0 ? right : left
    at = projectPosition(at.lat, at.lon, course, legLengthNM)
    points.push(at)
    if (i < numLegs - 1) {
      at = projectPosition(at.lat, at.lon, advanceDeg, spacingNM)
      points.push(at)
    }
  }
  const { legs, totalNM } = buildLegs(points, (i) => i % 2 === 1)
  return { code: 'CL', csp: start, points, legs, totalNM, spacingNM }
}

/* -------------------------------------------------------------------------
 * Sweep width, spacing and POD
 * ---------------------------------------------------------------------- */

export type ObjectVisibility = 'high' | 'medium' | 'low'
export type SeaClass = 'calm' | 'moderate' | 'rough'

export const SEA_CLASSES: { id: SeaClass; label: string }[] = [
  { id: 'calm', label: 'Calm (≤ 3 ft)' },
  { id: 'moderate', label: 'Moderate (3–6 ft)' },
  { id: 'rough', label: 'Rough (> 6 ft)' },
]

/**
 * Visual sweep widths in NM for a surface vessel, by how visible the object
 * is and the sea running — the RescueGPS ontology's `pod_tables` for the
 * `visual_day` and `visual_night` sensors, columns calm/moderate/rough.
 */
const SWEEP_WIDTH_NM: Record<
  'day' | 'night',
  Record<ObjectVisibility, Record<SeaClass, number>>
> = {
  day: {
    high: { calm: 3.0, moderate: 2.0, rough: 1.0 },
    medium: { calm: 1.5, moderate: 1.0, rough: 0.5 },
    low: { calm: 0.4, moderate: 0.2, rough: 0.1 },
  },
  night: {
    high: { calm: 1.0, moderate: 0.7, rough: 0.3 },
    medium: { calm: 0.3, moderate: 0.2, rough: 0.1 },
    low: { calm: 0.05, moderate: 0.02, rough: 0.01 },
  },
}

/**
 * Sweep width for an unaided visual search from a small vessel. You cannot
 * sweep further than you can see, so poor visibility caps the answer at the
 * visibility itself.
 */
export function sweepWidthNM(
  visibility: ObjectVisibility,
  opts: { night?: boolean; sea?: SeaClass; visibilityNM?: number | null } = {},
): number {
  const w = SWEEP_WIDTH_NM[opts.night ? 'night' : 'day'][visibility][
    opts.sea ?? 'calm'
  ]
  const vis = opts.visibilityNM
  if (vis != null && Number.isFinite(vis) && vis > 0) return Math.min(w, vis)
  return w
}

/** Coverage factor C = W / S — the ontology's convention, kept that way up. */
export function coverageFactor(sweepNM: number, spacingNM: number): number {
  if (!(sweepNM > 0) || !(spacingNM > 0)) return 0
  return sweepNM / spacingNM
}

/** POD for one uniform pass at coverage C: 1 − e^(−C). C=1 → 63 %. */
export function podForCoverage(c: number): number {
  if (!(c > 0)) return 0
  return 1 - Math.exp(-c)
}

/** Koopman: the spacing that delivers a target POD for a sweep width. */
export function spacingForPOD(sweepNM: number, targetPod: number): number {
  if (!(sweepNM > 0) || !(targetPod > 0) || targetPod >= 1) return Number.NaN
  return -sweepNM / Math.log(1 - targetPod)
}

/** Cumulative POD over repeated independent passes. */
export function cumulativePOD(pods: number[]): number {
  let miss = 1
  for (const p of pods) {
    if (Number.isFinite(p) && p > 0) miss *= 1 - Math.min(1, p)
  }
  return 1 - miss
}

/* -------------------------------------------------------------------------
 * Timing and selection
 * ---------------------------------------------------------------------- */

/**
 * Time to run a pattern: track distance at search speed plus a turnaround
 * allowance per turn (2 min, the command side's default).
 */
export function patternTimeHours(
  totalNM: number,
  speedKts: number,
  numTurns: number,
  turnaroundMin = 2,
): number {
  if (!(speedKts > 0) || !(totalNM >= 0)) return Number.NaN
  return totalNM / speedKts + (Math.max(0, numTurns) * turnaroundMin) / 60
}

export interface PatternRecommendation {
  code: PatternCode
  why: string
}

/**
 * Which pattern to run, from the search radius and whether the object is
 * moving — the ontology's selection rules cut down to what one boat crew
 * needs: a tight fresh datum gets an expanding square, a small circle gets
 * sectors, a drifting object gets a creeping line down-drift, and a big or
 * uncertain area gets parallel tracks.
 */
export function recommendPattern(input: {
  radiusNM: number
  driftKts: number
}): PatternRecommendation {
  const { radiusNM, driftKts } = input
  if (radiusNM <= 0.5) {
    return {
      code: 'SS',
      why: 'Datum is tight — spiral out from it in an expanding square.',
    }
  }
  if (radiusNM <= 1) {
    return {
      code: 'VS',
      why: 'Small circle around a good datum — sector passes keep crossing it.',
    }
  }
  if (driftKts >= 0.5) {
    return {
      code: 'CL',
      why: 'The object is moving — creep down-drift with legs across its track.',
    }
  }
  return {
    code: 'PS',
    why: 'Large area — parallel tracks along its long axis cover it evenly.',
  }
}
