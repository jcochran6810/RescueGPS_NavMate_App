/**
 * Following an ordered list of points — the rule shared by the search
 * patterns and the chart plotter's routes.
 *
 * Kept out of the component so both screens steer by the same definition and
 * so the rule can be tested without a DOM.
 */

import { bearingDeg, haversineNM, NM_TO_METERS } from './geo'
import { M_TO_FEET } from './vessel'
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
export const ARRIVAL_FT_CHOICES = [50, 100, 150] as const
export type ArrivalFt = (typeof ARRIVAL_FT_CHOICES)[number]
export const DEFAULT_ARRIVAL_FT: ArrivalFt = 150

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
  const inbound = plan.legs[targetIdx - 1]
  if (!inbound) return false

  const heading = fix.heading
  if (heading == null || !Number.isFinite(heading)) return false
  if (angleBetween(heading, inbound.courseDeg) >= HEADING_TOLERANCE_DEG) {
    return false
  }

  // Along-track component of the mark→boat vector. Positive means the boat
  // lies beyond the mark in the direction the leg was running.
  const markToBoat = bearingDeg(target.lat, target.lon, fix.lat, fix.lon)
  const along =
    rangeNM * Math.cos(((markToBoat - inbound.courseDeg) * Math.PI) / 180)
  return along > 0
}
