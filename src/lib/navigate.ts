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
 * **One point per step.** A coarse fix can land near a point two turns
 * ahead; jumping straight to it is how a crew ends up steering at a mark
 * across a shoal it never rounded. `stepTarget` moves on one point, and only
 * for a boat inside that point's circle, past it abeam, or gone round it
 * (`goneRound`). The store may take several steps on one fix — each one
 * earned the same way, and each switch judged against the chart — because at
 * speed a short leg is gone between two fixes. Passing a mark the boat
 * really has passed from a later leg is `recoverTarget`'s job, and that one
 * asks for evidence.
 *
 * **A poor fix never widens a circle past the point's own radius.** Every
 * point is captured in the crew's own circle (`plan.arrivalFt[i]`, 100–200
 * ft). A fix claiming more error than that is not allowed to widen it: the
 * crew is told the fix is poor instead (`gpsPoor`), and the pass-abeam rule
 * (bounded by twice that radius, 200 ft at most) and `recoverTarget` pick up
 * a mark a poor fix could not resolve.
 *
 * **Switching is not permission to cut the corner.** A boat switched to the
 * next point 200 ft short of a turn, and 20 m off the line, can have land
 * between it and the next point. The store checks the straight line from
 * every fix to the new point against the chart (`liveShortcut` in
 * routing.ts) and, until it is clear, steers the crew to the turn point
 * they have not rounded yet — `shortcutClear` below decides when that ends.
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
   * Capture radius per point, feet, index-aligned with `points` — the crew's
   * setting at every point. Missing entries fall back to the setting.
   */
  arrivalFt?: readonly number[]
}

/** A fix, as much of one as navigation needs. `Fix` from lib/types is one. */
export interface NavFix extends SteerFix {
  /** ms since the epoch. Missing means the age is unknown — treated as stale. */
  timestamp?: number | null
  /**
   * The phone's clock when the fix arrived (see `Fix.receivedAt`). When
   * present, the age is measured from this, not from `timestamp`.
   */
  receivedAt?: number | null
  /** The track filter's own estimate rather than a fix it believes (see `Fix.estimate`). */
  estimate?: 'dead-reckoned' | 'poor'
  /** Just jumped, not yet borne out: nothing is switched on it (see `Fix.settling`). */
  settling?: boolean
}

/* -------------------------------------------------------------------------
 * Tunables
 * ---------------------------------------------------------------------- */

/** A fix older than this is not "where the boat is". Seconds. */
export const STALE_FIX_S = 15

/**
 * The pass-abeam rule never reaches further than this past a mark, feet:
 * the widest circle a route ever uses, 200 ft. The crew's rule is "the next
 * waypoint is selected within 100–200 ft", and a switch 300–400 ft out (twice
 * the setting, as this once allowed) is outside it — and outside anything the
 * planner's corner check measured. A mark missed further out than this is
 * `recoverTarget`'s and the off-course re-route's to deal with. Before this
 * rule had a cap at all it switched up to 3 × 150 = 450 ft out, which on a
 * tight harbour turn is the next jetty.
 */
export const PASS_ABEAM_MAX_FT = MAX_ARRIVAL_FT

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
/** Time constant for speed coming UP (getting under way), seconds. */
export const SPEED_RISE_TAU_S = 2

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
 *   - `safeFt` — the most this point may EVER be given: the plan's radius
 *     for it (the crew's setting when it was planned) or, where the plan has
 *     none, the crew's setting; never more than the cap (200 ft).
 *   - `baseFt` — what it is given with a good fix: `safeFt`, and never more
 *     than the crew's CURRENT setting, so turning the setting down takes
 *     effect at once without a re-plan.
 *   - `radiusFt` — `baseFt` widened to the fix's claimed error, but never past
 *     `safeFt`. A ±25 m fix cannot know it is inside a 100 ft circle, so where
 *     the plan allows 150 ft the circle may grow to meet it.
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
  /** From the fix to the point it was judged against, feet (absent with no fix). */
  rangeFt?: number
  /** The circle it was judged by, feet (absent with no fix). */
  radiusFt?: number
}

/**
 * One fix's worth of progress down the route: stay, advance ONE point, or
 * arrive.
 *
 * Three ways to have reached a point — the first two as in `shouldAdvance`
 * (steer.ts):
 *
 *   1. Inside its circle — `arrivalRadiusFt`: the planned radius, widened by
 *      the fix's error but never past the point's own safe radius.
 *   2. Past it and still running the leg into it (`pastMark`), no further
 *      than twice the point's SAFE radius and never more than 200 ft — the
 *      top of the crew's 100–200 ft rule (`PASS_ABEAM_MAX_FT`). That
 *      limit is new for routes: a planned turn point sits where it does
 *      because of a shoal or a jetty, and "past it" half a football field
 *      later is not rounding it. It is what catches a mark a poor fix could
 *      not resolve inside the circle.
 *   3. Gone round it wide (`goneRound`, not for the destination): beyond the
 *      turn point on the leg into it and not behind the leg out of it,
 *      however far out — the way on is the leg ahead, never back astern.
 *
 * At the destination the first two mean "arrived" and the index stays put.
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
  if (!reached && idx >= 1 && idx < n - 1) reached = goneRound(plan, idx, fix)

  const measured = { rangeFt: range, radiusFt }
  if (idx === n - 1) return { targetIdx: idx, arrived: reached, gpsPoor, ...measured }
  return { targetIdx: reached ? idx + 1 : idx, arrived: false, gpsPoor, ...measured }
}

/**
 * Has the boat gone round turn point `idx` wide — however far out?
 *
 * The circle and the pass-abeam rule both stop at 200 ft. A boat that ran
 * through a turn further out than that (a GPS dropout at the turn, a
 * sluggish helm at speed) is past the turn point on the leg into it AND not
 * behind the start of the leg out of it — it is in the quarter beyond the
 * corner, where the way on is the next leg ahead, never back to the mark:
 * steering it back there pointed the card dead astern until a re-route. So,
 * by geometry alone, regardless of the 200 ft limit:
 *
 *   - past the turn point along the leg into it;
 *   - ahead on the leg out of it (or within a quarter of the overshoot
 *     short of its start line — a turn a little over 90°);
 *   - and the turn point behind the boat: with a heading, more than 90° off
 *     it; without one, clearly along the leg out (30 m) and nearer to it
 *     than to the leg in.
 *
 * Round a hairpin the leg out runs back past the overshoot, so it is never
 * "ahead" there, and the boat is (rightly) sent back round the mark.
 */
export function goneRound(plan: NavPlan, idx: number, fix: SteerFix): boolean {
  const n = plan.points.length
  if (idx < 1 || idx >= n - 1) return false
  const turn = plan.points[idx]
  const inb = legGeometry(plan.points[idx - 1], turn, fix)
  const past = inb.alongM - inb.lengthM
  if (!(past > 0)) return false
  const out = legGeometry(turn, plan.points[idx + 1], fix)
  if (out.alongM < -0.25 * past) return false
  if (hasHeading(fix)) {
    const toTurn = bearingDeg(fix.lat, fix.lon, turn.lat, turn.lon)
    return angleBetween(fix.heading, toTurn) > SAME_WAY_DEG
  }
  return out.alongM >= ON_TRACK_MIN_M && out.distM <= inb.distM
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
 * Rounding a turn point — "don't cut the corner"
 * ---------------------------------------------------------------------- */

/**
 * Within this of the turn point, feet, the boat has rounded it whatever the
 * line check says — the line from there to the next point is the planned leg
 * to within a boat's length. Widened by the fix's claimed error, up to twice
 * this, so a fair fix can still see the boat arrive at the point.
 */
export const ROUNDED_FT = 30

/**
 * Has the boat got round turn point `turnIdx`, so that steering straight for
 * the point after it (`turnIdx + 1`) is sound?
 *
 *
 * `verdict` is the chart's answer for the straight line from the fix to that
 * next point (`liveShortcut` in routing.ts, the fix's error included):
 *
 *   - `clear` — yes;
 *   - `unsafe` — not until the boat is at the turn point (`ROUNDED_FT`);
 *   - null (no chart in memory to check it against) — once the boat is at
 *     the turn point, abeam of it (past it along the leg into it), or on the
 *     leg out of it past the turn point (within 30 m of the line). Without
 *     a chart nothing better than the route's own geometry is known, and the
 *     boat must never be sent round in circles for want of one.
 */
export function shortcutClear(
  plan: NavPlan,
  turnIdx: number,
  fix: SteerFix,
  verdict: 'clear' | 'unsafe' | null,
): boolean {
  if (verdict === 'clear') return true
  const n = plan.points.length
  if (turnIdx < 0 || turnIdx + 1 >= n) return true
  const turn = plan.points[turnIdx]
  const accFt =
    fix.accuracy != null && Number.isFinite(fix.accuracy) && fix.accuracy > 0
      ? fix.accuracy * M_TO_FEET
      : 0
  const roundedFt = Math.max(ROUNDED_FT, Math.min(accFt, 2 * ROUNDED_FT))
  if (rangeFt(fix, turn) <= roundedFt) return true
  if (verdict === null) {
    // Abeam of the turn point or past it, along the leg into it; or on the
    // leg out of it, past the turn point.
    const out = legGeometry(turn, plan.points[turnIdx + 1], fix)
    if (out.alongM >= 0 && out.distM <= ON_TRACK_MIN_M) return true
    if (turnIdx === 0) return out.alongM >= 0
    const g = legGeometry(plan.points[turnIdx - 1], turn, fix)
    return g.alongM >= g.lengthM - 1
  }
  return false
}

/**
 * Has the boat got round turn point `turnIdx` — abeam of it or past it along
 * the leg into it, AND past it along the leg out of it? Then steering back to
 * it would be steering astern: whatever the chart says about the line to the
 * next point, the way on is along the leg out of it (`steerCourse`), not
 * back to the mark. Both tests are needed: round a hairpin the leg out runs
 * back past a boat still short of the mark.
 *
 * For the start (`turnIdx` 0), past it along the first leg.
 */
export function passedTurn(plan: NavPlan, turnIdx: number, fix: LatLon): boolean {
  const n = plan.points.length
  if (turnIdx < 0 || turnIdx + 1 >= n) return true
  const turn = plan.points[turnIdx]
  const out = legGeometry(turn, plan.points[turnIdx + 1], fix)
  if (turnIdx === 0) return out.alongM >= 0
  const inbound = legGeometry(plan.points[turnIdx - 1], turn, fix)
  return inbound.alongM >= inbound.lengthM && out.alongM >= 0
}

/* -------------------------------------------------------------------------
 * The course to steer — back onto the line, not just at the point
 * ---------------------------------------------------------------------- */

/**
 * The least distance ahead along the leg the course is aimed at, metres.
 * Short enough that a boat set off the line by a cross-current is steered
 * back to it firmly (the steady offset a current leaves is this times the
 * tangent of the angle the current sets the boat by — 10 m for a one-knot
 * set at six knots), long enough that a few metres of GPS noise do not swing
 * the number on the card by more than a few degrees.
 */
export const LOOKAHEAD_MIN_M = 30

/**
 * A poor fix wanders tens of metres over half a minute; aimed close, the
 * course chases that wander and the boat with it — off a line it was
 * actually on. So the aim moves further ahead as the fix gets worse: the
 * least lookahead up to a fix of this accuracy (metres), growing with the
 * square of the accuracy beyond it (±10 m → 120 m, ±20 m → 400 m, the cap).
 * Swept on the simulated voyages: a linear 6 × accuracy left 5/20 poor-GPS
 * runs inside the stand-off, the square 2/20. With a poor fix the course
 * answers only a sustained offset (a set), and "slow down" says the rest.
 */
export const LOOKAHEAD_GOOD_ACC_M = 5
/** The most the aim is put ahead for a poor fix, metres. */
export const LOOKAHEAD_MAX_ACC_M = 400

/** Off the line by at least this, the card says so and how to get back, metres. */
export const XTE_CUE_M = 10

export interface SteerCourse {
  /** The point steered for: on the leg ahead of the boat, or the target itself. */
  aim: LatLon
  /** From the boat to `aim`, degrees TRUE — the course to steer. */
  bearingDeg: number
  /** Signed distance from the leg's line, metres, + = right of it; null for the first point. */
  xteM: number | null
  /** How far ahead along the leg the aim was put, metres (0 when aiming at the target). */
  lookaheadM: number
  /**
   * How far along the leg the boat's foot lies, metres — negative while it is
   * still short of the leg's start (coming round the turn onto it). Null for
   * the first point.
   */
  alongM: number | null
}

/**
 * The course to steer for point `targetIdx`: not straight at the point, but
 * at a point on the leg into it a little ahead of the boat (`LOOKAHEAD_MIN_M`,
 * or the boat's distance off the line, or more for a poor fix
 * (`LOOKAHEAD_GOOD_ACC_M`) — whichever is most, so the intercept is never steeper than
 * 45°).
 * On the line it is the leg's own course; set off it — a cross-current, a
 * helm that wandered — it brings the boat back onto the line the planner
 * checked, instead of along a new straight line to the point that nobody
 * did. Within that distance of the point, it is the point.
 *
 * The bearing and distance to the point itself are still what the card
 * leads with (rule 4); this is the steering cue beside them.
 */
export function steerCourse(
  plan: NavPlan,
  targetIdx: number,
  fix: SteerFix | null | undefined,
): SteerCourse | null {
  const n = plan.points.length
  if (!fix || n === 0) return null
  const idx = clampIdx(plan, targetIdx)
  const target = plan.points[idx]
  const direct = (xteM: number | null): SteerCourse => ({
    aim: target,
    bearingDeg: bearingDeg(fix.lat, fix.lon, target.lat, target.lon),
    xteM,
    lookaheadM: 0,
    alongM,
  })
  let alongM: number | null = null
  if (idx === 0) return direct(null)
  const a = plan.points[idx - 1]
  const g = legGeometry(a, target, fix)
  alongM = g.alongM
  if (g.lengthM < 1) return direct(g.crossM)
  const acc =
    fix.accuracy != null && Number.isFinite(fix.accuracy) && fix.accuracy > 0 ? fix.accuracy : 0
  const noisy = Math.min(LOOKAHEAD_MAX_ACC_M, LOOKAHEAD_MIN_M * (acc / LOOKAHEAD_GOOD_ACC_M) ** 2)
  const lookaheadM = Math.max(LOOKAHEAD_MIN_M, Math.abs(g.crossM), noisy)
  const s = Math.min(g.lengthM, Math.max(0, g.alongM)) + lookaheadM
  if (s >= g.lengthM) return direct(g.crossM)
  const f = s / g.lengthM
  const aim = { lat: a.lat + f * (target.lat - a.lat), lon: a.lon + f * (target.lon - a.lon) }
  return {
    aim,
    bearingDeg: bearingDeg(fix.lat, fix.lon, aim.lat, aim.lon),
    xteM: g.crossM,
    lookaheadM,
    alongM,
  }
}

/** Legs closer together than this are told apart by the boat's heading, metres. */
const JOIN_TIE_M = 30

/**
 * Where to pick up a route the boat is not on and not at the start of —
 * the point at the far end of the nearest leg it has not yet run the length
 * of (between legs within `JOIN_TIE_M` of each other, one going the boat's
 * way), never the start. Used when a re-route the crew had to read first is
 * accepted: the boat has moved on meanwhile, and its start is behind it.
 */
export function joinTarget(plan: NavPlan, fix: SteerFix | null | undefined): number {
  const n = plan.points.length
  if (n <= 1) return 0
  if (!fix) return 1
  const heading = hasHeading(fix) ? fix.heading : null
  const legs: { j: number; d: number; sameWay: boolean }[] = []
  for (let j = 0; j < n - 1; j++) {
    const g = legGeometry(plan.points[j], plan.points[j + 1], fix)
    if (g.alongM > g.lengthM && j < n - 2) continue
    const sameWay = heading == null || angleBetween(heading, courseOf(plan, j)) < SAME_WAY_DEG
    legs.push({ j, d: g.distM, sameWay })
  }
  if (legs.length === 0) return n - 1
  legs.sort((x, y) => x.d - y.d)
  const best = legs.find((l) => l.sameWay && l.d <= legs[0].d + JOIN_TIE_M) ?? legs[0]
  return best.j + 1
}

/* -------------------------------------------------------------------------
 * Speed made good along the route — for the ETA
 * ---------------------------------------------------------------------- */

/** How far back the route's progress is measured for the ETA, seconds. */
export const PROGRESS_WINDOW_S = 60
/** Least span of progress to measure a speed from, seconds. */
export const PROGRESS_MIN_S = 20
/** The speed over the ground "now" is the median of this last stretch, seconds. */
export const RECENT_SOG_S = 10
/** Pairs of samples closer together than this say nothing about a rate, seconds. */
const PAIR_MIN_S = 5

/** Distance to go at one moment: ms since the epoch, NM; and the speed over the ground then, knots. */
export interface ProgressSample {
  t: number
  remainingNM: number
  sogKn?: number | null
}

/**
 * The log of distance to go, with `sample` added and anything older than
 * the window dropped (one older sample is kept, so the window is always
 * spanned). A sample from before the last one starts the log again.
 */
export function logProgress(
  log: readonly ProgressSample[] | null | undefined,
  sample: ProgressSample,
): ProgressSample[] {
  if (!Number.isFinite(sample.t) || !Number.isFinite(sample.remainingNM)) return [...(log ?? [])]
  const prev = log ?? []
  const last = prev[prev.length - 1]
  if (last && sample.t <= last.t) return last.t === sample.t ? [...prev] : [sample]
  const out = [...prev, sample]
  const cut = sample.t - PROGRESS_WINDOW_S * 1000
  let k = 0
  while (k + 1 < out.length && out[k + 1].t <= cut) k++
  return out.slice(k)
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * The rate `y` changes at over time, robustly: the median of the slopes
 * between every pair of samples at least `PAIR_MIN_S` apart (Theil–Sen). A
 * jump — a waypoint switched early, a fix that wandered — moves a handful of
 * the pairs, never the median. Units of `y` per hour.
 */
function robustRatePerH(t: readonly number[], y: readonly number[]): number | null {
  const slopes: number[] = []
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) {
      const dtS = (t[j] - t[i]) / 1000
      if (dtS < PAIR_MIN_S) continue
      slopes.push(((y[j] - y[i]) / dtS) * 3600)
    }
  }
  return median(slopes)
}

/**
 * Speed made good along the route, knots — what the ETA is worked at.
 *
 * The ETA was once the distance to go over the speed over the ground
 * smoothed with a 15 s time constant: it lagged every change of speed by
 * that much, and knew nothing of the route — a boat weaving, rounding a turn
 * or making way across the line is not closing the destination at its speed
 * over the ground. It was then worked from the last half-minute's progress,
 * capped at the speed over the ground: every glitch in the distance to go
 * (a waypoint switched early, a fix that wandered) and every fix the filter
 * read as a standstill went straight into it, and it came out twice as far
 * wrong as the smoothed speed it replaced.
 *
 * Now, over the last `PROGRESS_WINDOW_S` seconds:
 *
 *   - how fast the distance to go came down, and how fast the boat ran over
 *     the ground, each as a robust rate (`robustRatePerH`, the median of
 *     many pairs — one bad sample moves neither);
 *   - their ratio is how much of the boat's way is going into the route
 *     (it changes slowly), and times the median speed over the ground of the
 *     last `RECENT_SOG_S` seconds (which does not lag) it is the speed the
 *     crew will actually close the destination at.
 *
 * A speed over the ground of exactly 0 is the filter saying "cannot tell",
 * not the boat stopping, and is left out; a boat that really stops shows it
 * in the distance to go. Without speeds in the log, the progress rate alone.
 *
 * Null until there is `PROGRESS_MIN_S` of log, or when the boat is not
 * closing at a knot — the caller falls back to the smoothed speed over the
 * ground, then the cruise speed.
 */
export function routeSpeedKn(log: readonly ProgressSample[] | null | undefined): number | null {
  if (!log || log.length < 2) return null
  const a = log[0]
  const b = log[log.length - 1]
  if (!((b.t - a.t) / 1000 >= PROGRESS_MIN_S)) return null
  const t = log.map((x) => x.t)
  const progress = robustRatePerH(
    t,
    log.map((x) => -x.remainingNM),
  )
  if (progress == null) return null

  const sog = (x: ProgressSample) =>
    x.sogKn != null && Number.isFinite(x.sogKn) && x.sogKn > 0 ? x.sogKn : null
  const withSog = log.filter((x) => sog(x) != null)
  let kn = progress
  if (withSog.length >= log.length / 2) {
    // Distance run over the ground, from the speeds (a missing one carries
    // the last known), as a series its own robust rate can be read from.
    const ground: number[] = []
    let run = 0
    let v = sog(withSog[0]) as number
    for (let k = 0; k < log.length; k++) {
      if (k > 0) {
        const next = sog(log[k]) ?? v
        run += ((v + next) / 2) * ((log[k].t - log[k - 1].t) / 3_600_000)
        v = next
      }
      ground.push(run)
    }
    const overGround = robustRatePerH(t, ground)
    const recent = median(
      withSog.filter((x) => x.t >= b.t - RECENT_SOG_S * 1000).map((x) => sog(x) as number),
    )
    if (overGround != null && overGround > 0 && recent != null) {
      kn = (progress / overGround) * recent
    }
  }
  return Number.isFinite(kn) && kn >= MIN_SOG_KN ? kn : null
}

/* -------------------------------------------------------------------------
 * Off course, stale, speed
 * ---------------------------------------------------------------------- */

/** The least off-course threshold for a boat with small safety margins, metres. */
export const OFF_COURSE_FLOOR_M = 20

/**
 * With the margin known, never less than this many times the fix's claimed
 * error: 2.5 × the 68 % radius is beyond the 99 % one, so a receiver's own
 * wander is not taken for the boat leaving the route (and re-planning from
 * a position the fix does not actually know).
 */
export const OFF_COURSE_PER_ACC = 2.5

/** Options for the off-course test: the arrival setting, and the boat's margin. */
export interface OffCourseOptions extends ArrivalOptions {
  /**
   * The boat's stand-off from land and hazards, metres — the margin the
   * route was planned with. When given, the threshold scales with it.
   */
  marginM?: number | null
}

/**
 * How far from the leg counts as off it, metres.
 *
 * With the boat's stand-off known (`marginM`): twice the stand-off, never
 * less than 20 m nor more than 60 m — a boat with a 5 m stand-off is well
 * into trouble 60 m off a line planned to clear the bank by 5 m, and used to
 * be allowed 60–122 m before anything re-planned — and never less than
 * `OFF_COURSE_PER_ACC` times the fix's claimed error. Without it: 60 m at
 * least, two arrival circles, or one and a half times the fix's error. A
 * poor fix cannot trigger a re-route by itself either way.
 */
export function offCourseThresholdM(
  plan: NavPlan,
  targetIdx: number,
  fix: SteerFix | null | undefined,
  opts: OffCourseOptions = {},
): number {
  const acc =
    fix?.accuracy != null && Number.isFinite(fix.accuracy) && fix.accuracy > 0
      ? fix.accuracy
      : 0
  const margin = positive(opts.marginM)
  if (margin != null) {
    const base = Math.min(OFF_COURSE_MIN_M, Math.max(OFF_COURSE_FLOOR_M, 2 * margin))
    return Math.max(base, OFF_COURSE_PER_ACC * acc)
  }
  const idx = plan.points.length ? clampIdx(plan, targetIdx) : 0
  const { baseFt } = arrivalRadiusFt(plan, idx, null, opts)
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
  opts: OffCourseOptions & { thresholdM?: number } = {},
): boolean {
  const n = plan.points.length
  if (!fix || n === 0) return false
  const idx = clampIdx(plan, targetIdx)
  const threshold =
    positive(opts.thresholdM) ?? offCourseThresholdM(plan, idx, fix, opts)
  return routeDistM(plan, idx, fix) > threshold
}

/**
 * How far the boat is from the route where it is running it, metres: the
 * nearest of the leg into point `targetIdx`, the leg before it and the leg
 * after it (steering to the first point: that point, and the first leg).
 *
 * The leg into the target alone is not enough. The target is switched up to
 * 200 ft BEFORE the turn point, and for that last stretch the boat is still
 * running the previous leg, dead on its line — yet up to 200 ft from the new
 * leg's segment, which begins at the turn. At a slow speed that stretch
 * takes longer than the 10 s off-course hold, and a boat exactly on the
 * route was being re-routed after every early switch. Measured to the route
 * round the turn, it is where it should be. A boat that overshot a turn, or
 * wandered off, is still far from all of them.
 */
export function routeDistM(plan: NavPlan, targetIdx: number, fix: LatLon): number {
  const n = plan.points.length
  if (n === 0) return Infinity
  const idx = clampIdx(plan, targetIdx)
  let d =
    idx >= 1
      ? legGeometry(plan.points[idx - 1], plan.points[idx], fix).distM
      : haversineNM(fix.lat, fix.lon, plan.points[0].lat, plan.points[0].lon) * NM_TO_METERS
  if (idx >= 2) d = Math.min(d, legGeometry(plan.points[idx - 2], plan.points[idx - 1], fix).distM)
  if (idx + 1 < n) d = Math.min(d, legGeometry(plan.points[idx], plan.points[idx + 1], fix).distM)
  return d
}

/**
 * Is this fix too old to steer by?
 *
 * A phone that has lost the sky keeps handing back its last position, and a
 * frozen bearing looks exactly like a live one. No fix, or no time on it, is
 * stale too — an age that cannot be known cannot be trusted.
 */
export function isStale(
  fix:
    | { timestamp?: number | null; receivedAt?: number | null; speed?: number | null }
    | null
    | undefined,
  now: number = Date.now(),
  maxAgeS?: number,
): boolean {
  if (!fix) return true
  const ts = fixTime(fix)
  if (ts == null) return true
  return now - ts > (maxAgeS ?? staleAfterS(fix)) * 1000
}

/** The least age a fix is shown as live for, seconds, however fast the boat. */
export const STALE_MIN_S = 5
/**
 * How far the boat may run on a fix before it is no longer "where the boat
 * is", metres. At 25 kn the old flat 15 s was 190 m of passage steered on a
 * frozen position shown as live.
 */
export const STALE_RUN_M = 60

/**
 * How old a fix may be and still be steered by, seconds: the time the boat
 * takes to run `STALE_RUN_M` at the fix's own speed, never less than
 * `STALE_MIN_S` nor more than `STALE_FIX_S` (the old flat limit, still the
 * one for a boat barely moving or a fix with no speed).
 */
export function staleAfterS(fix: { speed?: number | null } | null | undefined): number {
  const v = fix?.speed
  if (v == null || !Number.isFinite(v) || v <= 0) return STALE_FIX_S
  return Math.min(STALE_FIX_S, Math.max(STALE_MIN_S, STALE_RUN_M / v))
}

/** Below this age a fix is used as it is, seconds — one fix interval. */
const DR_AFTER_S = 1.5
/**
 * How fast a dead-reckoned position's error grows, as an acceleration, m/s²:
 * the boat may turn or change speed after the last fix, and after `t`
 * seconds it may be ½·a·t² from where running on at the old velocity puts
 * it. 2 m/s² is a firm turn for a planing boat.
 */
const DR_ACCEL_MPS2 = 2
/** Without a course and speed, the error grows this fast instead, m/s. */
const DR_BLIND_MPS = 5

/**
 * Where the boat is NOW on the strength of a fix `now − fixTime` old: run on
 * at the fix's course and speed, with the accuracy widened for the time since
 * (see `DR_ACCEL_MPS2`). A fix under a fix interval old is returned as it
 * is. `deadReckoned` says the position is an estimate between fixes.
 *
 * Between the last fix and "stale" (`staleAfterS`) the card works its numbers
 * from this, so a boat running on through a short dropout is not shown
 * steering from where it was seconds ago — and the growing error is shown.
 */
export function deadReckon<F extends NavFix>(fix: F, now: number): F & { deadReckoned?: boolean } {
  const ts = fixTime(fix)
  if (ts == null) return fix
  const age = (now - ts) / 1000
  if (!(age > DR_AFTER_S)) return fix
  const acc =
    fix.accuracy != null && Number.isFinite(fix.accuracy) && fix.accuracy > 0 ? fix.accuracy : 0
  const v = fix.speed
  const h = fix.heading
  if (v == null || !Number.isFinite(v) || v < 0 || h == null || !Number.isFinite(h)) {
    return { ...fix, accuracy: acc + DR_BLIND_MPS * age, deadReckoned: true }
  }
  const run = v * age
  const rad = (h * Math.PI) / 180
  const dy = run * Math.cos(rad)
  const dx = run * Math.sin(rad)
  const lat = fix.lat + dy / M_PER_DEG
  const lon = fix.lon + dx / (M_PER_DEG * Math.cos((fix.lat * Math.PI) / 180))
  return {
    ...fix,
    lat,
    lon,
    accuracy: acc + 0.5 * DR_ACCEL_MPS2 * age * age,
    deadReckoned: true,
  }
}

/**
 * When a fix arrived, on the phone's own clock: `receivedAt` when the
 * tracker stamped one, else the position's `timestamp`. Null when neither is
 * known.
 *
 * Freshness against the phone clock only works with a time FROM the phone
 * clock. A position stamped with GNSS time, on a phone whose clock is 20 s
 * off, looked 20 s old the moment it arrived — every fix "stale", nothing
 * advancing, while fixes were pouring in.
 */
export function fixTime(
  fix: { timestamp?: number | null; receivedAt?: number | null } | null | undefined,
): number | null {
  if (!fix) return null
  const r = fix.receivedAt
  if (r != null && Number.isFinite(r)) return r
  const ts = fix.timestamp
  return ts != null && Number.isFinite(ts) ? ts : null
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
  // Getting under way from a standstill, the smoothed figure used to crawl
  // up from 0 with the full time constant: a minute after Start the ETA was
  // still worked at a few knots, up to 17 times too long. Below a knot the
  // old figure says nothing (the card uses the cruise speed there anyway),
  // so a boat that starts making way takes its speed at once; and speed
  // coming up is followed on a short time constant — a boat accelerating is
  // not noise — while speed dropping keeps the long one.
  if (prev < MIN_SOG_KN && kn >= MIN_SOG_KN) return kn
  const tau = kn > prev ? SPEED_RISE_TAU_S : SPEED_TAU_S
  const alpha = 1 - Math.exp(-dt / tau)
  return prev + alpha * (kn - prev)
}
