/**
 * Following an ordered list of points — the rule shared by the search
 * patterns and the chart plotter's routes.
 *
 * Kept out of the component so both screens steer by the same definition and
 * so the rule can be tested without a DOM.
 */

import { haversineNM } from './geo'
import type { LatLon, PatternLeg } from './search'

/**
 * How close counts as arrived. Small enough to hold a pattern, big enough
 * that a boat does not have to drive over the exact point — and five times
 * `AT_POSITION_NM` in geo.ts, which answers a different question: whether the
 * crew is standing on the thing.
 */
export const ARRIVAL_NM = 0.05

export interface SteerablePlan {
  points: LatLon[]
  legs: PatternLeg[]
}

/**
 * Should the target advance to the next point?
 *
 * Distance to the point, not a plane-crossing test: a boat that has to abort a
 * turn and come round again should be given the same point back, not carried
 * on to the next one because it once crossed a line.
 *
 * Never advances past the last point — arriving at the end is the end.
 */
export function shouldAdvance(
  plan: SteerablePlan,
  targetIdx: number,
  fix: LatLon | null,
): boolean {
  if (!fix) return false
  const target = plan.points[targetIdx]
  if (!target) return false
  if (targetIdx >= plan.points.length - 1) return false
  return haversineNM(fix.lat, fix.lon, target.lat, target.lon) < ARRIVAL_NM
}
