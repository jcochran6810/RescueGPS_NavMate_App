/**
 * Following an ordered list of points — the rule shared by the search
 * patterns and the chart plotter's routes.
 *
 * Kept out of the component so both screens steer by the same definition and
 * so the rule can be tested without a DOM.
 */

import { bearingDeg, haversineNM, NM_TO_METERS } from './geo'
import { M_TO_FEET } from './vessel'
import { magneticFromTrue } from './geomag'
import type { LatLon, PatternLeg } from './search'

/** Feet in a nautical mile, derived so there is one conversion in the app. */
export const FT_PER_NM = NM_TO_METERS * M_TO_FEET

/**
 * How close counts as arrived, in feet.
 *
 * A crew asked for "close enough" to be 50–150 ft rather than the 0.05 NM
 * (304 ft) this used to be — most of a football field short of the mark, which
 * is far too generous for a harbour pattern.
 *
 * 150 ft is the default because the failures are asymmetric. Advancing a
 * little early costs a slightly wide turn; failing to advance at all leaves
 * the crew steering at a point they have already passed, which they have to
 * notice before they can do anything about it. The tightest setting is offered
 * for tight work, and the accuracy floor below is what keeps it honest.
 */
export const ARRIVAL_FT_CHOICES = [50, 100, 150, 200] as const
export type ArrivalFt = (typeof ARRIVAL_FT_CHOICES)[number]
export const DEFAULT_ARRIVAL_FT: ArrivalFt = 150

/**
 * The choices offered for a chart-plotter route. 50 ft stays a Search-tab
 * setting: a pattern leg in open water can be run that tight, but a route's
 * turn points are placed by the planner round shoals and jetties, and a 50 ft
 * circle at planing speed is two fixes wide — missed marks, not precision.
 */
export const ROUTE_ARRIVAL_FT_CHOICES = [100, 150, 200] as const satisfies readonly ArrivalFt[]

/**
 * The widest circle any route point is ever given, feet, whatever the fix
 * accuracy says. Past this a poor fix no longer widens the circle — that
 * would hide the bearing to a mark the boat has not reached — and the crew is
 * told the fix is poor instead.
 */
export const MAX_ARRIVAL_FT = 200

/**
 * How far past the arrival circle the pass-abeam rule still applies.
 *
 * Keeps "sailed through the circle between two fixes" separate from "happens
 * to be past the perpendicular of a mark half a mile away", which is not
 * arriving at anything.
 */
const CAPTURE_MULTIPLE = 3

/** Beyond this much off the leg's course, the boat is not carrying on down it. */
const HEADING_TOLERANCE_DEG = 90

export interface SteerablePlan {
  points: LatLon[]
  legs: PatternLeg[]
}

/**
 * A fix, as much of one as this rule needs.
 *
 * `accuracy` and `heading` are optional so a test — or any caller with only a
 * position — can pass a plain `LatLon`; both simply disable the parts of the
 * rule that depend on them.
 */
export interface SteerFix extends LatLon {
  /** Metres. */
  accuracy?: number | null
  /** Degrees true. */
  heading?: number | null
  /** Metres per second over the ground, when the receiver or filter has one. */
  speed?: number | null
}

/**
 * Which way to turn, and by how much.
 *
 * A bearing alone is a number a coxswain has to do arithmetic on while
 * steering; the useful form is "come right 40°". Positive is starboard,
 * negative is port, and the answer is always the short way round — the whole
 * point is to name the turn nobody has to think about.
 *
 * Null when the boat has no heading to turn *from*: course over ground needs
 * movement, and a stationary boat pointing anywhere would be told to turn by
 * a figure made of noise.
 */
export function turnToward(
  courseDeg: number,
  headingDeg: number | null | undefined,
): number | null {
  if (headingDeg == null || !Number.isFinite(headingDeg)) return null
  const diff = (((courseDeg - headingDeg) % 360) + 540) % 360 - 180
  // -180 and 180 are the same turn; reported as starboard so the sign is
  // never ambiguous at the one bearing where both are true.
  return diff === -180 ? 180 : diff
}

/**
 * How long until the turn, in hours, at the speed actually being made good.
 *
 * Null below a knot: at a drift of a tenth of a knot the arithmetic says
 * eleven hours to a mark a mile away, which is arithmetically true and
 * useless. A crew that is not moving is not approaching anything.
 */
export function timeToRunHours(
  distanceNM: number,
  speedMps: number | null | undefined,
): number | null {
  if (speedMps == null || !Number.isFinite(speedMps)) return null
  const kn = speedMps * 1.943844
  if (kn < 1) return null
  return distanceNM / kn
}

/**
 * The arrival circle actually used, in NM.
 *
 * Never smaller than the fix's own uncertainty. A receiver reporting ±25 m
 * cannot tell you it is inside a 15 m circle, so asking it to would mean a leg
 * that can never complete; it gets a circle it can actually satisfy instead.
 * Same reasoning as `trailDistanceNM` in geo.ts, which ignores movement
 * smaller than the fix is uncertain.
 */
export function arrivalRadiusNM(
  arrivalFt: number,
  accuracyM?: number | null,
): number {
  const chosen = arrivalFt / FT_PER_NM
  const floor =
    accuracyM != null && Number.isFinite(accuracyM) && accuracyM > 0
      ? accuracyM / NM_TO_METERS
      : 0
  return Math.max(chosen, floor)
}

/** Smallest angle between two bearings, degrees, 0–180. */
function angleBetween(a: number, b: number): number {
  return Math.abs((((a - b + 540) % 360) - 180))
}

/**
 * Should the target advance to the next point?
 *
 * Two ways to have arrived, and the second one exists because the first is not
 * enough once the circle is small. At 20 knots a boat covers about 34 ft a
 * second, so a 50 ft circle is three seconds wide — two or three fixes — and
 * each of those carries its own error. Miss them and the leg never completes
 * at all, leaving the crew steering to a mark astern of them.
 *
 *   1. **Inside the circle.** The plain range test, as it always was.
 *   2. **Past it and still going.** Beyond the perpendicular through the mark,
 *      still within reach of it, and still heading the way the leg heads.
 *
 * That third condition on rule 2 is the important one, and it is why this is
 * not the plane-crossing test this function used to refuse. The original
 * objection stands and is worth keeping in full:
 *
 *   > a boat that has to abort a turn and come round again should be given the
 *   > same point back, not carried on to the next one because it once crossed
 *   > a line.
 *
 * A boat coming round again is heading back down the leg, so it fails the
 * heading check and gets the same point back — exactly as that requires. Only
 * a boat still running the leg's course is carried on. Where the device gives
 * no heading, rule 2 does not fire at all and the behaviour falls back to the
 * circle, which is the safe direction to be wrong in.
 *
 * Never advances past the last point — arriving at the end is the end.
 */
export function shouldAdvance(
  plan: SteerablePlan,
  targetIdx: number,
  fix: SteerFix | null,
  arrivalFt: number = DEFAULT_ARRIVAL_FT,
): boolean {
  if (!fix) return false
  const target = plan.points[targetIdx]
  if (!target) return false
  if (targetIdx >= plan.points.length - 1) return false

  const radiusNM = arrivalRadiusNM(arrivalFt, fix.accuracy)
  const rangeNM = haversineNM(fix.lat, fix.lon, target.lat, target.lon)
  if (rangeNM <= radiusNM) return true

  // Rule 2 — past the mark and still running the leg.
  if (rangeNM > radiusNM * CAPTURE_MULTIPLE) return false

  // The leg that ARRIVES at this point: legs[i] runs points[i] → points[i+1],
  // so the inbound one is the leg before. Steering to the very first point has
  // no inbound leg — there is no course to have carried on down — so the
  // circle is the only rule there.
  return pastMark(plan.legs[targetIdx - 1], target, fix)
}

/**
 * Rule 2 of `shouldAdvance` on its own: is the boat beyond the perpendicular
 * through `mark`, still running the course of the leg that arrives there?
 *
 * No range check — the caller decides how far past the mark still counts
 * (`shouldAdvance` allows three circles, the route engine in navigate.ts a
 * tighter bound). Exported so both apply the same geometry and the same
 * heading refusal, rather than two copies drifting apart.
 *
 * False without an inbound leg or without a heading: a boat with no course to
 * have carried on down, or no way to tell which way it is going, has not
 * "passed" anything — it gets the circle alone, the safe way to be wrong.
 */
export function pastMark(
  inbound: Pick<PatternLeg, 'courseDeg'> | undefined,
  mark: LatLon,
  fix: SteerFix,
): boolean {
  if (!inbound) return false
  const heading = fix.heading
  if (heading == null || !Number.isFinite(heading)) return false
  if (angleBetween(heading, inbound.courseDeg) >= HEADING_TOLERANCE_DEG) {
    return false
  }

  // Along-track component of the mark→boat vector. Positive means the boat
  // lies beyond the mark in the direction the leg was running.
  const rangeNM = haversineNM(fix.lat, fix.lon, mark.lat, mark.lon)
  const markToBoat = bearingDeg(mark.lat, mark.lon, fix.lat, fix.lon)
  const along =
    rangeNM * Math.cos(((markToBoat - inbound.courseDeg) * Math.PI) / 180)
  return along > 0
}

/* -------------------------------------------------------------------------
 * Saying it out loud — distances and bearings as the crew reads them
 * ---------------------------------------------------------------------- */

/**
 * Below this, a distance to a mark is given in feet. A tenth of a mile is
 * about 600 ft — the point where "0.04 NM" stops meaning anything to a
 * coxswain and "250 ft" is what the bow lookout would shout.
 */
export const FEET_BELOW_NM = 0.1

/**
 * A distance to steer to: feet when close, the crew's distance unit
 * otherwise.
 *
 * Feet are rounded to the nearest 10 above 100 ft — the fix is not better
 * than that, and a number that flickers by single feet every second is noise
 * a crew learns to stop reading. Under 100 ft they are rounded to 5, which is
 * still honest for a fix at its best.
 *
 * `formatLength` is passed in rather than imported so this file does not
 * depend on the units module's display rules; callers hand over whichever
 * formatter their screen already uses (`useFormat().length`).
 */
export function formatNavDistance(
  nm: number | null | undefined,
  formatLength: (nm: number) => string = (v) =>
    `${v.toFixed(Math.abs(v) < 10 ? 2 : 1)} NM`,
): string {
  if (nm == null || !Number.isFinite(nm) || nm < 0) return '—'
  if (nm < FEET_BELOW_NM) {
    const ft = nm * FT_PER_NM
    const step = ft >= 100 ? 10 : 5
    return `${Math.round(ft / step) * step} ft`
  }
  return formatLength(nm)
}

/** Which north a bearing is given from. */
export type BearingRef = 'T' | 'M'

/**
 * A true bearing, turned into the one the crew asked to read.
 *
 * Magnetic only when it was asked for AND a declination is known; otherwise
 * true, and labelled so. A bearing is never shown without saying which north
 * it is from — 10° of declination is 10° of wrong course, and on a 2 NM leg
 * that is a third of a mile off the mark.
 */
export function navBearing(
  trueDeg: number,
  wanted: 'true' | 'magnetic' = 'true',
  declination: number | null = null,
): { deg: number; ref: BearingRef } {
  const norm = (d: number) => ((d % 360) + 360) % 360
  if (!Number.isFinite(trueDeg)) return { deg: Number.NaN, ref: 'T' }
  if (wanted === 'magnetic' && declination != null && Number.isFinite(declination)) {
    // Same conversion the Compass tab uses, so the two can never disagree.
    return { deg: magneticFromTrue(trueDeg, declination), ref: 'M' }
  }
  return { deg: norm(trueDeg), ref: 'T' }
}

/** "047°T" / "041°M" — three digits, the way bearings are spoken on the radio. */
export function formatNavBearing(b: { deg: number; ref: BearingRef }): string {
  if (!Number.isFinite(b.deg)) return '—'
  const whole = Math.round(b.deg) % 360
  return `${String(whole).padStart(3, '0')}°${b.ref}`
}
