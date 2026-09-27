/**
 * Steering a planned route — what the crew is told, fix by fix.
 *
 * `routing.ts` answers "which way is safe?" once, at the dock. This file
 * answers the questions that come after, once a second, underway:
 *
 *   - Which point am I steering to, and on what bearing, how far?
 *   - How far is it to the END, and when do I get there?
 *   - Have I reached this point — and if I missed it, where do I go now?
 *   - Have I left the route far enough that it no longer describes where I am?
 *
 * Everything here is pure: a plan, a target index and a fix in, numbers out.
 * The store (`store/useNavigation.ts`) owns state and timing; this owns the
 * geometry, so every rule can be pinned by a test without a phone.
 *
 * Three refusals worth knowing before any of them is "fixed":
 *
 * **At most one point per fix.** A coarse fix can land near a point two turns
 * ahead; advancing through several points on one fix is how a crew ends up
 * steering at a mark across a shoal it never rounded. Passing a mark the boat
 * really has passed is `recoverTarget`'s job, and that one asks for evidence.
 *
 * **A poor fix never widens a circle past the point's own safe radius.** The
 * planner gives every turn point the widest circle that cannot cut the corner
 * (`plan.arrivalFt[i]` — as little as 30 ft at a hairpin round a jetty). A fix
 * claiming more error than that is not allowed to widen the circle past it:
 * switching early on a guess is exactly the corner-cut the planner shrank
 * the circle to prevent. The crew is told the fix is poor instead
 * (`gpsPoor`), and the pass-abeam rule (bounded by twice that same safe
 * radius) and `recoverTarget` pick up a mark a poor fix could not resolve.
 *
 * **No heading, no guessing.** The rules that act on "the boat has gone past"
 * (pass-abeam, missed-mark recovery) need a course over ground to know which
 * way the boat is going. Without one they do nothing, and the plain circle
 * plus the off-course re-route are what keep the crew right — the safe
 * direction to be wrong in.
 */

import {
  bearingDeg,
  haversineNM,
  MPS_TO_KNOTS,
  NM_TO_METERS,
} from './geo'
import {
  DEFAULT_ARRIVAL_FT,
  FT_PER_NM,
  MAX_ARRIVAL_FT,
  pastMark,
  type SteerFix,
} from './steer'
import { FEET_TO_M, M_TO_FEET } from './vessel'
import type { LatLon } from './search'

/* -------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------- */

/**
 * As much of a route as steering needs. A `RoutePlan` from routing.ts is one;
 * tests can build one from bare points.
 *
 * Courses are always derived from `points` here, never read from `legs`, so
 * the geometry the crew is steered along is exactly the line that is drawn.
 */
export interface NavPlan {
  points: LatLon[]
  /**
   * Safe capture radius per point, feet, index-aligned with `points` — the
   * planner reduces it at turn points where switching early would cut a
   * corner into shallows. Missing entries fall back to the crew's setting.
   */
  arrivalFt?: readonly number[]
}

/** A fix, as much of one as navigation needs. `Fix` from lib/types is one. */
export interface NavFix extends SteerFix {
  /** ms since the epoch. Missing means the age is unknown — treated as stale. */
  timestamp?: number | null
}

/* -------------------------------------------------------------------------
 * Tunables
 * ---------------------------------------------------------------------- */

/** A fix older than this is not "where the boat is". Seconds. */
export const STALE_FIX_S = 15

/**
 * The pass-abeam rule never reaches further than this past a mark, feet.
 * Twice the widest circle. Before this rule had a cap it switched up to
 * 3 × 150 = 450 ft out, which on a tight harbour turn is the next jetty.
 */
export const PASS_ABEAM_MAX_FT = 2 * MAX_ARRIVAL_FT

/** The floor of the off-course threshold, metres. */
export const OFF_COURSE_MIN_M = 60

/**
 * How close to a leg counts as "on it", metres, at least. Below this the
 * distinction is inside the error of a good phone fix.
 */
const ON_TRACK_MIN_M = 30

/** Below this the speed over ground is drift, not progress. Knots. */
export const MIN_SOG_KN = 1

/**
 * Time constant of the speed smoothing, seconds. Long enough that a wave
 * lifting the stern does not swing the ETA by ten minutes, short enough that
 * slowing for a no-wake zone shows within half a minute.
 */
export const SPEED_TAU_S = 15

/** Radius of the sphere `haversineNM` uses (geo.ts), NM. */
const EARTH_RADIUS_NM = 3440.065

/** Headings further apart than this are not "going the same way". */
const SAME_WAY_DEG = 90

/* -------------------------------------------------------------------------
 * Local geometry
 *
 * Flat-earth about the fix, on the same sphere as `haversineNM` and
 * `bearingDeg`. Every question here is about a boat within a few miles of the
 * leg it is measured against, where flattening costs well under a metre; and
 * using the haversine's own sphere (rather than the WGS-84 figures in
 * `metersPerDegree`) means a boat 150 ft from a mark by the arrival rule is
 * 150 ft from it here too — the two can never disagree about which side of a
 * threshold it is on.
 * ---------------------------------------------------------------------- */

/** Metres in a degree of latitude on the haversine's sphere. */
const M_PER_DEG = (EARTH_RADIUS_NM * NM_TO_METERS * Math.PI) / 180

interface XY {
  x: number
  y: number
}

/** Metres east (x) and north (y) of `ref`. */
function toXY(ref: LatLon, p: LatLon): XY {
  let dLon = p.lon - ref.lon
  if (dLon > 180) dLon -= 360
  if (dLon < -180) dLon += 360
  const midLat = ((ref.lat + p.lat) / 2) * (Math.PI / 180)
  return { x: dLon * M_PER_DEG * Math.cos(midLat), y: (p.lat - ref.lat) * M_PER_DEG }
}

export interface LegGeometry {
  /** Distance from the boat to the leg SEGMENT (not the infinite line), m. */
  distM: number
  /**
   * Signed distance from the leg's infinite line, metres: positive when the
   * boat is to the RIGHT (starboard) of the track, looking from `a` to `b`.
   */
  crossM: number
  /** How far along the leg the boat's foot lies, from `a`, m. Unclamped. */
  alongM: number
  /** The leg's own length, m. */
  lengthM: number
}

/** Where the boat stands relative to the leg `a` → `b`. */
export function legGeometry(a: LatLon, b: LatLon, fix: LatLon): LegGeometry {
  const A = toXY(fix, a)
  const B = toXY(fix, b)
  const dx = B.x - A.x
  const dy = B.y - A.y
  // The boat is the origin, so boat − A is simply −A.
  const px = -A.x
  const py = -A.y
  const len2 = dx * dx + dy * dy
  const lengthM = Math.sqrt(len2)
  if (lengthM < 1e-6) {
    const d = Math.hypot(px, py)
    return { distM: d, crossM: 0, alongM: 0, lengthM: 0 }
  }
  const t = (px * dx + py * dy) / len2
  const tc = Math.min(1, Math.max(0, t))
  const cx = A.x + tc * dx
  const cy = A.y + tc * dy
  return {
    distM: Math.hypot(cx, cy),
    // Cross product d × p is positive to the LEFT in an east/north frame;
    // starboard-positive is what "xte R" means on every plotter.
    crossM: -(dx * py - dy * px) / lengthM,
    alongM: t * lengthM,
    lengthM,
  }
}

function rangeFt(a: LatLon, b: LatLon): number {
  return haversineNM(a.lat, a.lon, b.lat, b.lon) * FT_PER_NM
}

function courseOf(plan: NavPlan, legIdx: number): number {
  const a = plan.points[legIdx]
  const b = plan.points[legIdx + 1]
  return bearingDeg(a.lat, a.lon, b.lat, b.lon)
}

function angleBetween(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

function hasHeading(fix: SteerFix): fix is SteerFix & { heading: number } {
  return fix.heading != null && Number.isFinite(fix.heading)
}

function clampIdx(plan: NavPlan, idx: number): number {
  const last = plan.points.length - 1
  if (!Number.isFinite(idx)) return Math.min(1, Math.max(0, last))
  return Math.min(last, Math.max(0, Math.trunc(idx)))
}

/* -------------------------------------------------------------------------
 * The arrival circle
 * ---------------------------------------------------------------------- */

export interface ArrivalOptions {
  /** The crew's arrival setting, feet. Default 150. */
  arrivalFt?: number
  /** The widest the circle may ever be, feet. Default 200. */
  arrivalFtCap?: number
}

/**
 * The circle point `idx` is actually captured in, feet, and whether the fix
 * is too poor to judge it honestly.
 *
 *   - `safeFt` — the most this point may EVER be given: the planner's safe
 *     radius for it (reduced at tight turns) or, where the plan has none, the
 *     crew's setting; never more than the cap (200 ft).
 *   - `baseFt` — what it is given with a good fix: `safeFt`, and never more
 *     than the crew's CURRENT setting, so turning the setting down takes
 *     effect at once without a re-plan.
 *   - `radiusFt` — `baseFt` widened to the fix's claimed error, but never past
 *     `safeFt`. A ±25 m fix cannot know it is inside a 100 ft circle, so where
 *     the point is safe out to 150 ft the circle may grow to meet it; where
 *     the point is only safe to 30 ft (a hairpin) it may not grow at all.
 *   - `gpsPoor` — the fix claims more error than `safeFt`: whatever it says
 *     about this point is a guess, and the card says so.
 */
export function arrivalRadiusFt(
  plan: NavPlan,
  idx: number,
  accuracyM: number | null | undefined,
  opts: ArrivalOptions = {},
): { radiusFt: number; baseFt: number; safeFt: number; gpsPoor: boolean } {
  const cap = positive(opts.arrivalFtCap) ?? MAX_ARRIVAL_FT
  const requested = positive(opts.arrivalFt) ?? DEFAULT_ARRIVAL_FT
  const planned = positive(plan.arrivalFt?.[idx])
  const safeFt = Math.min(planned ?? requested, cap)
  const baseFt = Math.min(safeFt, requested)
  const accFt =
    accuracyM != null && Number.isFinite(accuracyM) && accuracyM > 0
      ? accuracyM * M_TO_FEET
      : 0
  return {
    radiusFt: Math.min(safeFt, Math.max(baseFt, accFt)),
    baseFt,
    safeFt,
    gpsPoor: accFt > safeFt,
  }
}

function positive(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) && v > 0 ? v : null
}

/* -------------------------------------------------------------------------
 * Progress — the numbers on the card
 * ---------------------------------------------------------------------- */

export interface NavProgress {
  /** The point being steered to (clamped into the plan). */
  targetIdx: number
  target: LatLon
  /** From the boat to the target, degrees TRUE. */
  bearingDeg: number
  /** From the boat to the target, NM. */
  distanceNM: number
  /** To the target, then along every later leg to the destination, NM. */
  remainingNM: number
  /** Hours to the destination at `speedKn`, or null with no usable speed. */
  timeToGoH: number | null
  /** Clock time of arrival, ms since the epoch, or null with no speed. */
  etaMs: number | null
  /** The speed the time was worked at, knots, or null when there was none. */
  speedKn: number | null
  /**
   * Where `speedKn` came from. `cruise` whenever the boat is making less
   * than a knot — an ETA from a drift is arithmetic, not information — and
   * the card must say so.
   */
  speedSource: 'gps' | 'cruise'
  /**
   * Cross-track error from the leg being run, metres, + = right of track.
   * Null while steering to the first point, which has no leg into it.
   */
  xteM: number | null
  /** Index into `legs` of the leg being run (`targetIdx − 1`), or null. */
  legIdx: number | null
  /** True when the target is the destination. */
  isFinal: boolean
}

export interface ProgressOptions {
  /** Smoothed speed over ground, knots (see `smoothSpeedKn`). */
  speedKn?: number | null
  /** The boat's cruise speed, knots — used when not making way. */
  cruiseKn?: number | null
  /** ms since the epoch. Default `Date.now()`. */
  now?: number
}

/**
 * Bearing and distance to the next point, and distance and time to the end.
 *
 * Null when there is nothing to measure: no fix, or an empty plan.
 */
export function navProgress(
  plan: NavPlan,
  targetIdx: number,
  fix: LatLon | null | undefined,
  opts: ProgressOptions = {},
): NavProgress | null {
  const n = plan.points.length
  if (!fix || n === 0) return null
  const idx = clampIdx(plan, targetIdx)
  const target = plan.points[idx]

  const distanceNM = haversineNM(fix.lat, fix.lon, target.lat, target.lon)
  let remainingNM = distanceNM
  for (let i = idx; i < n - 1; i++) {
    const a = plan.points[i]
    const b = plan.points[i + 1]
    remainingNM += haversineNM(a.lat, a.lon, b.lat, b.lon)
  }

  const sog = opts.speedKn
  const cruise = positive(opts.cruiseKn)
  let speedKn: number | null
  let speedSource: 'gps' | 'cruise'
  if (sog != null && Number.isFinite(sog) && sog >= MIN_SOG_KN) {
    speedKn = sog
    speedSource = 'gps'
  } else {
    speedKn = cruise
    speedSource = 'cruise'
  }
  const now = opts.now ?? Date.now()
  const timeToGoH = speedKn != null ? remainingNM / speedKn : null
  const etaMs = timeToGoH != null ? now + timeToGoH * 3_600_000 : null

  const legIdx = idx >= 1 ? idx - 1 : null
  const xteM =
    legIdx != null
      ? legGeometry(plan.points[legIdx], plan.points[idx], fix).crossM
      : null

  return {
    targetIdx: idx,
    target,
    bearingDeg: bearingDeg(fix.lat, fix.lon, target.lat, target.lon),
    distanceNM,
    remainingNM,
    timeToGoH,
    etaMs,
    speedKn,
    speedSource,
    xteM,
    legIdx,
    isFinal: idx === n - 1,
  }
}

/* -------------------------------------------------------------------------
 * Advancing
 * ---------------------------------------------------------------------- */

export interface StepResult {
  targetIdx: number
  /** The destination has been reached. */
  arrived: boolean
  /**
   * The fix claims an error larger than this point's safe radius, so the
   * circle was NOT widened to match it. The crew should be told; the numbers
   * are still shown, but a "you are there" from this fix would be a guess.
   */
  gpsPoor: boolean
}

/**
 * One fix's worth of progress down the route: stay, advance ONE point, or
 * arrive.
 *
 * Two ways to have reached a point, as in `shouldAdvance` (steer.ts):
 *
 *   1. Inside its circle — `arrivalRadiusFt`: the planned radius, widened by
 *      the fix's error but never past the point's own safe radius.
 *   2. Past it and still running the leg into it (`pastMark`), no further
 *      than twice the point's SAFE radius and never more than 400 ft. That
 *      limit is new for routes: a planned turn point sits where it does
 *      because of a shoal or a jetty, and "past it" half a football field
 *      later is not rounding it. It is what catches a mark a poor fix could
 *      not resolve inside the circle.
 *
 * At the destination both rules mean "arrived" and the index stays put.
 */
export function stepTarget(
  plan: NavPlan,
  targetIdx: number,
  fix: SteerFix | null | undefined,
  opts: ArrivalOptions = {},
): StepResult {
  const n = plan.points.length
  if (!fix || n === 0) return { targetIdx, arrived: false, gpsPoor: false }
  const idx = clampIdx(plan, targetIdx)
  const target = plan.points[idx]
  const { radiusFt, safeFt, gpsPoor } = arrivalRadiusFt(plan, idx, fix.accuracy, opts)
  const range = rangeFt(fix, target)

  let reached = range <= radiusFt
  if (!reached && idx >= 1) {
    const passLimit = Math.min(2 * safeFt, PASS_ABEAM_MAX_FT)
    reached =
      range <= passLimit && pastMark({ courseDeg: courseOf(plan, idx - 1) }, target, fix)
  }

  if (idx === n - 1) return { targetIdx: idx, arrived: reached, gpsPoor }
  return { targetIdx: reached ? idx + 1 : idx, arrived: false, gpsPoor }
}

/**
 * The point to steer to when the boat has clearly left the mark it was
 * steering to behind — cut a corner, or ran past a turn between fixes with no
 * heading to call it passed. Returns `targetIdx` unchanged when there is no
 * such evidence.
 *
 * "Clearly" means all of:
 *
 *   - the boat is ON a later leg's track (within the arrival circle's width,
 *     30 m at least) and at least that far along it — not merely near the
 *     turn point where two legs meet;
 *   - it is well away from the leg it was supposed to be running (further
 *     than from the later leg, by the same margin again) — a boat still on
 *     its own leg never skips ahead, however close another leg runs;
 *   - it is heading the way that later leg runs. This is the hairpin guard:
 *     round the tip of a spit the outbound leg runs back alongside the
 *     inbound one, and a boat drifting toward it is still going the wrong
 *     way for it. Without a heading nothing is recovered — the off-course
 *     re-route deals with the boat instead, from where it really is.
 *
 * When several later legs qualify, the nearest wins.
 */
export function recoverTarget(
  plan: NavPlan,
  targetIdx: number,
  fix: SteerFix | null | undefined,
  opts: ArrivalOptions = {},
): number {
  const n = plan.points.length
  if (!fix || n < 2) return targetIdx
  const idx = clampIdx(plan, targetIdx)
  if (idx >= n - 1) return idx
  if (!hasHeading(fix)) return idx

  const { radiusFt } = arrivalRadiusFt(plan, idx, fix.accuracy, opts)
  const onTrackM = Math.max(ON_TRACK_MIN_M, radiusFt * FEET_TO_M)

  const dCur =
    idx >= 1
      ? legGeometry(plan.points[idx - 1], plan.points[idx], fix).distM
      : haversineNM(fix.lat, fix.lon, plan.points[0].lat, plan.points[0].lon) * NM_TO_METERS

  let best = idx
  let bestD = Infinity
  for (let j = idx; j < n - 1; j++) {
    const g = legGeometry(plan.points[j], plan.points[j + 1], fix)
    if (g.distM > onTrackM) continue
    if (g.alongM < onTrackM) continue
    if (dCur <= g.distM + onTrackM) continue
    if (angleBetween(fix.heading, courseOf(plan, j)) >= SAME_WAY_DEG) continue
    if (g.distM < bestD) {
      bestD = g.distM
      best = j + 1
    }
  }
  return best
}

/**
 * Where to begin — or resume — steering a route from where the boat is.
 *
 *   - At the start (within the start point's circle, 60 m at least): point 1.
 *     Steering to point 0 from on top of it would give a bearing made of GPS
 *     noise.
 *   - On the route: the far end of the nearest leg the boat is on and going
 *     the way of (the heading picks between legs that run close together;
 *     without one, the nearest leg). This is what makes a restart
 *     mid-passage — a reload, a tab switch, an app kill — pick up where the
 *     boat actually is instead of sending it back to the first turn.
 *   - Anywhere else: point 0, the start of the route. The store decides
 *     whether that means "go to the start" (a route planned ahead from
 *     somewhere else) or "re-plan from here" (a route from my position).
 */
export function startTarget(
  plan: NavPlan,
  fix: SteerFix | null | undefined,
  opts: ArrivalOptions = {},
): number {
  const n = plan.points.length
  if (n <= 1) return 0
  if (!fix) return 1

  const { baseFt } = arrivalRadiusFt(plan, 0, null, opts)
  const atStartM = Math.max(OFF_COURSE_MIN_M, baseFt * FEET_TO_M)
  const toStartM =
    haversineNM(fix.lat, fix.lon, plan.points[0].lat, plan.points[0].lon) * NM_TO_METERS
  if (toStartM <= atStartM) return 1

  const joinM = offCourseThresholdM(plan, 1, fix, opts)
  const heading = hasHeading(fix) ? fix.heading : null
  let best = -1
  let bestD = Infinity
  let bestSameWay = false
  for (let j = 0; j < n - 1; j++) {
    const g = legGeometry(plan.points[j], plan.points[j + 1], fix)
    if (g.distM > joinM) continue
    const sameWay =
      heading == null || angleBetween(heading, courseOf(plan, j)) < SAME_WAY_DEG
    // A leg going the boat's way beats a nearer one going the other way.
    if (
      (sameWay && !bestSameWay) ||
      (sameWay === bestSameWay && g.distM < bestD)
    ) {
      best = j
      bestD = g.distM
      bestSameWay = sameWay
    }
  }
  return best >= 0 ? best + 1 : 0
}

/* -------------------------------------------------------------------------
 * Off course, stale, speed
 * ---------------------------------------------------------------------- */

/**
 * How far from the leg counts as off it, metres: 60 m at least, two arrival
 * circles, or one and a half times the fix's claimed error — whichever is
 * largest, so a poor fix cannot trigger a re-route by itself.
 */
export function offCourseThresholdM(
  plan: NavPlan,
  targetIdx: number,
  fix: SteerFix | null | undefined,
  opts: ArrivalOptions = {},
): number {
  const idx = plan.points.length ? clampIdx(plan, targetIdx) : 0
  const { baseFt } = arrivalRadiusFt(plan, idx, null, opts)
  const acc =
    fix?.accuracy != null && Number.isFinite(fix.accuracy) && fix.accuracy > 0
      ? fix.accuracy
      : 0
  return Math.max(OFF_COURSE_MIN_M, 2 * baseFt * FEET_TO_M, 1.5 * acc)
}

/**
 * Has the boat left the leg it is running?
 *
 * Measured to the leg SEGMENT, not its infinite line: a boat that overshot a
 * turn and carried on is off course even though it is still "on the line".
 * Steering to the first point, the "leg" is the point itself — the store
 * decides whether that means anything (it does for a route planned from the
 * boat's own position, not for one planned ahead from somewhere else).
 *
 * `thresholdM` overrides the default of `offCourseThresholdM`.
 */
export function isOffCourse(
  plan: NavPlan,
  targetIdx: number,
  fix: SteerFix | null | undefined,
  opts: ArrivalOptions & { thresholdM?: number } = {},
): boolean {
  const n = plan.points.length
  if (!fix || n === 0) return false
  const idx = clampIdx(plan, targetIdx)
  const threshold =
    positive(opts.thresholdM) ?? offCourseThresholdM(plan, idx, fix, opts)
  const dist =
    idx >= 1
      ? legGeometry(plan.points[idx - 1], plan.points[idx], fix).distM
      : haversineNM(fix.lat, fix.lon, plan.points[0].lat, plan.points[0].lon) * NM_TO_METERS
  return dist > threshold
}

/**
 * Is this fix too old to steer by?
 *
 * A phone that has lost the sky keeps handing back its last position, and a
 * frozen bearing looks exactly like a live one. No fix, or no time on it, is
 * stale too — an age that cannot be known cannot be trusted.
 */
export function isStale(
  fix: { timestamp?: number | null } | null | undefined,
  now: number = Date.now(),
  maxAgeS: number = STALE_FIX_S,
): boolean {
  if (!fix) return true
  const ts = fix.timestamp
  if (ts == null || !Number.isFinite(ts)) return true
  return now - ts > maxAgeS * 1000
}

/**
 * Speed over ground for the ETA, knots, smoothed.
 *
 * Exponential smoothing with a time constant (`SPEED_TAU_S`) rather than a
 * fixed weight, so a burst of fixes and a gap between them count for what
 * they are worth in time. A fix with no speed keeps the previous figure; the
 * first fix with one is taken as it is.
 *
 * Below a knot the result is still returned — `navProgress` is what refuses
 * to work an ETA from it and falls back to cruise speed, labelled so.
 */
export function smoothSpeedKn(
  prevKn: number | null | undefined,
  fix: { speed?: number | null } | null | undefined,
  dtS: number,
): number | null {
  const prev = prevKn != null && Number.isFinite(prevKn) ? prevKn : null
  const raw = fix?.speed
  if (raw == null || !Number.isFinite(raw) || raw < 0) return prev
  const kn = raw * MPS_TO_KNOTS
  if (prev == null) return kn
  const dt = Number.isFinite(dtS) && dtS > 0 ? dtS : 1
  const alpha = 1 - Math.exp(-dt / SPEED_TAU_S)
  return prev + alpha * (kn - prev)
}
