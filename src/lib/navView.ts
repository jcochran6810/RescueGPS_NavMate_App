/**
 * What the navigation screens SAY — worked out without React.
 *
 * `navigate.ts` owns the geometry (where the boat is along the route) and the
 * store owns the state (planning, steering, arrived). This file turns the two
 * into the words and numbers on the card, the banner, the route summary and
 * the map, so every one of them can be pinned by a test in node and the
 * components are left doing layout.
 *
 * The rules it keeps, whichever screen asks:
 *
 *   - **Distances near a mark in feet.** Under a tenth of a mile "0.04 NM"
 *     means nothing at the wheel (`formatNavDistance`).
 *   - **Every bearing says which north.** True unless the crew asked for
 *     magnetic AND a declination is known (`navBearing`).
 *   - **A frozen fix is shown as frozen.** The numbers stay (they are the
 *     last known), but greyed, with how long ago.
 *   - **No bearing inside the arrival circle.** There it is GPS jitter
 *     dressed up as a heading.
 *   - **No straight lines.** A route is drawn leg by leg from the planner's
 *     points or not at all.
 */

import { bearingDeg, formatDuration, haversineNM } from './geo'
import { declinationAt } from './geomag'
import {
  arrivalRadiusFt,
  deadReckon,
  fixTime,
  isStale,
  navProgress,
  steerCourse,
  stepTarget,
  XTE_CUE_M,
  STALE_FIX_S,
  type NavFix,
} from './navigate'
import { depthMarginFor, type LegCaution, type RouteLeg, type RoutePlan } from './routing'
import type { LatLon } from './search'
import {
  FT_PER_NM,
  formatNavBearing,
  formatNavDistance,
  navBearing,
  turnToward,
} from './steer'
import { M_TO_FEET } from './vessel'

export type LengthFormatter = (nm: number) => string
export type BearingPreference = 'true' | 'magnetic'

const defaultLength: LengthFormatter = (nm) =>
  `${nm.toFixed(Math.abs(nm) < 10 ? 2 : 1)} NM`

/* -------------------------------------------------------------------------
 * Small formatters
 * ---------------------------------------------------------------------- */

/** "3 ft (0.9 m)" — feet first, metres in brackets, as the router words it. */
export function feetFirst(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return '—'
  const ft = m * M_TO_FEET
  const ftText = ft < 10 ? ft.toFixed(1).replace(/\.0$/, '') : String(Math.round(ft))
  const mText = m < 10 ? m.toFixed(1) : String(Math.round(m))
  return `${ftText} ft (${mText} m)`
}

export interface ClockText {
  /** Local clock time, as the phone writes it ("14:52" / "2:52 PM"). */
  text: string
  /** Whole calendar days after today: 0 today, 1 tomorrow… */
  dayOffset: number
  /** "" today, "+1 day", "+2 days". */
  dayMark: string
}

/**
 * An arrival time as a clock, with a day marker when it is not today.
 *
 * "ETA 01:10" read at 23:40 is tomorrow's ten past one, and a crew doing the
 * sum at the wheel should not have to notice that.
 */
export function formatClock(ms: number, nowMs: number): ClockText | null {
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return null
  const at = new Date(ms)
  const now = new Date(nowMs)
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayOffset = Math.round((day(at) - day(now)) / 86_400_000)
  const text = noBreakMeridiem(at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  const dayMark =
    dayOffset <= 0 ? '' : dayOffset === 1 ? '+1 day' : `+${dayOffset} days`
  return { text, dayOffset, dayMark }
}

/**
 * "04:10 AM" with a no-break space before the AM/PM, so a narrow screen never
 * wraps the clock into "04:10 / AM". A 24-hour clock is left as it is.
 */
export function noBreakMeridiem(text: string): string {
  return text.replace(/[ \u202f](?=[AaPp]\.?\s?[Mm])/, '\u00a0')
}

/**
 * "10 h 16 min" with a no-break space inside each number-and-unit, so a
 * narrow cell breaks it as "10 h" / "16 min" — never "10 h 16" / "min".
 */
export function keepUnitsTogether(text: string): string {
  return text.replace(/(\d) (?=(?:d|h|min|s|NM|ft|m|kn)\b)/g, '$1\u00a0')
}

/** "ETA 14:52" / "ETA 01:10 +1 day". */
export function etaText(c: ClockText | null): string | null {
  if (!c) return null
  return `ETA ${c.text}${c.dayMark ? ` ${c.dayMark}` : ''}`
}

/**
 * Declination at a position, degrees east, cached per quarter degree.
 *
 * The model is a 12th-degree harmonic expansion; it changes by a degree over
 * roughly 100 km, so a quarter-degree cell (≈ 25 km) is far finer than it
 * needs and saves working it out once a second.
 */
const declCache = new Map<string, number>()
export function declinationFor(lat: number, lon: number, nowMs = Date.now()): number | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const year = new Date(nowMs).getUTCFullYear()
  const key = `${Math.round(lat * 4)},${Math.round(lon * 4)},${year}`
  const hit = declCache.get(key)
  if (hit !== undefined) return hit
  const d = declinationAt(Math.round(lat * 4) / 4, Math.round(lon * 4) / 4, 0, new Date(nowMs))
  if (!Number.isFinite(d)) return null
  if (declCache.size > 256) declCache.clear()
  declCache.set(key, d)
  return d
}

/** A true bearing in the crew's chosen north, labelled: "047°T" / "041°M". */
export function bearingText(
  trueDeg: number,
  pref: BearingPreference,
  declination: number | null,
): string {
  return formatNavBearing(navBearing(trueDeg, pref, declination))
}

/* -------------------------------------------------------------------------
 * The route, before it is started
 * ---------------------------------------------------------------------- */

export interface RouteSummary {
  distance: string
  /** Time to run at cruise speed, or null with no speed. */
  duration: string | null
  eta: ClockText | null
  /** "12.4 NM · 38 min · ETA 14:52" */
  line: string
}

/** The one line under a planned route, Google-Maps style. */
export function routeSummary(
  plan: Pick<RoutePlan, 'totalNM' | 'hours'>,
  opts: { cruiseKn?: number | null; now: number; formatLength?: LengthFormatter },
): RouteSummary {
  const fmt = opts.formatLength ?? defaultLength
  const distance = fmt(plan.totalNM)
  const cruise = opts.cruiseKn
  const hours =
    cruise != null && Number.isFinite(cruise) && cruise > 0
      ? plan.totalNM / cruise
      : Number.isFinite(plan.hours) && plan.hours > 0
        ? plan.hours
        : null
  const duration = hours != null ? formatDuration(hours) : null
  const eta = hours != null ? formatClock(opts.now + hours * 3_600_000, opts.now) : null
  const line = [distance, duration, etaText(eta)].filter(Boolean).join(' · ')
  return { distance, duration, eta, line }
}

export interface LegRow {
  n: number
  courseDeg: number
  lengthNM: number
  caution: LegCaution
  /** Breaks the boat's depth or stand-off — drawn red, needs confirmation. */
  flagged: boolean
  /**
   * Shallow approach at an end, or the hop off / onto a dock the chart draws
   * as land — drawn dotted, checked by eye.
   */
  dotted: boolean
  /** What is wrong with it, in plain words; null for a sound leg. */
  note: string | null
}

type LegLike = Pick<RouteLeg, 'n' | 'courseDeg' | 'lengthNM' | 'caution'> &
  Partial<
    Pick<
      RouteLeg,
      | 'minChartedDepthM'
      | 'minClearanceM'
      | 'minDepthOutsideM'
      | 'overLand'
      | 'approachReasons'
      | 'nearShoalDepthM'
      | 'nearShoalDistM'
      | 'unverified'
    >
  >

/** Flagged: breaks the boat's depth or stand-off — drawn red. */
export function isFlagged(caution: LegCaution | null | undefined): boolean {
  return caution === 'unsafe-depth' || caution === 'reduced-clearance'
}

/** Checked by eye at the ends — drawn dotted. */
export function isDotted(caution: LegCaution | null | undefined): boolean {
  return caution === 'shallow-approach' || caution === 'off-chart-end'
}

/**
 * Why a leg needs the crew's eyes, in plain words — null for a sound leg.
 *
 * Worded from what the planner actually found on it: a hop over what the
 * chart draws as land is not "too shallow — 0 ft"; a leg flagged for shallow
 * water beside it says how close, not the (deep) water under it; an approach
 * leg says whether it was the depth, the stand-off, or both.
 *
 * `first` / `last`: the leg is the route's first / last (for "leave" /
 * "come alongside" on a dock hop).
 */
export function legNote(
  leg: LegLike,
  opts: { formatDepth?: (m: number) => string; first?: boolean; last?: boolean } = {},
): string | null {
  const depth = opts.formatDepth ?? feetFirst
  const caution = leg.caution ?? 'ok'
  if (leg.unverified) {
    return 'Not checked for your boat’s new settings — check it on the chart'
  }
  if (caution === 'off-chart-end') {
    return opts.first && !opts.last
      ? 'Leave the dock by eye — the chart shows land here'
      : 'Come alongside by eye — the chart shows land here'
  }
  if (caution === 'unsafe-depth') {
    if (leg.overLand) return 'Over land on the chart — leave or approach by eye'
    // Shallow water beside a track that is itself deep enough (the planner
    // only measures that when the track is sound): say how close it is.
    if (leg.nearShoalDistM != null && leg.nearShoalDepthM != null) {
      return `Passes ${feetFirst(leg.nearShoalDistM)} from ${depth(leg.nearShoalDepthM)} water`
    }
    // Outside the dock stretches — the figure the plan's warning quotes.
    const d = leg.minDepthOutsideM !== undefined ? leg.minDepthOutsideM : leg.minChartedDepthM
    return d != null ? `Too shallow — ${depth(d)} charted` : 'Too shallow — not surveyed'
  }
  if (caution === 'reduced-clearance') {
    return leg.minClearanceM != null
      ? `Close to land or a hazard — ${feetFirst(leg.minClearanceM)} off`
      : 'Close to land or a hazard'
  }
  if (caution === 'shallow-approach') {
    const reasons = leg.approachReasons ?? []
    const close =
      reasons.includes('clearance')
        ? `Passes ${leg.minClearanceM != null ? feetFirst(leg.minClearanceM) : 'close'} from land or a structure near the end — keep a lookout`
        : null
    const shallow = reasons.includes('depth') || reasons.length === 0 ? 'Check depth here' : null
    return [shallow, close].filter(Boolean).join(' · ')
  }
  return null
}

/** One row per leg, with the reason it is flagged. */
export function legRows(
  legs: readonly LegLike[],
  opts: { formatDepth?: (m: number) => string } = {},
): LegRow[] {
  return legs.map((leg, i) => {
    const caution = leg.caution ?? 'ok'
    return {
      n: leg.n,
      courseDeg: leg.courseDeg,
      lengthNM: leg.lengthNM,
      caution,
      flagged: isFlagged(caution),
      dotted: isDotted(caution),
      note: legNote(leg, { ...opts, first: i === 0, last: i === legs.length - 1 }),
    }
  })
}

/** A plan that may only be steered once the crew has confirmed it. */
export function needsConfirmation(plan: Pick<RoutePlan, 'source' | 'needsConfirm'> | null): boolean {
  return !!plan && (plan.needsConfirm || plan.source === 'best-effort')
}

/** A plan with a line to steer. */
export function hasRoute(plan: Pick<RoutePlan, 'source' | 'points'> | null): boolean {
  return !!plan && plan.source !== 'none' && plan.points.length >= 2
}

/* -------------------------------------------------------------------------
 * The route on the map
 * ---------------------------------------------------------------------- */

export type SegmentState = 'behind' | 'active' | 'ahead'

export interface RouteSegment {
  /** Leg index: points[idx] → points[idx + 1]. */
  idx: number
  from: LatLon
  to: LatLon
  state: SegmentState
  caution: LegCaution
}

/**
 * Every leg with how to draw it: already run (behind), being run (active),
 * still to come (ahead). With no target (a preview) everything is ahead.
 */
export function routeSegments(
  plan: { points: readonly LatLon[]; legs?: readonly { caution?: LegCaution }[] },
  targetIdx: number | null,
): RouteSegment[] {
  const out: RouteSegment[] = []
  for (let j = 0; j + 1 < plan.points.length; j++) {
    let state: SegmentState = 'ahead'
    if (targetIdx != null) {
      if (j + 1 < targetIdx) state = 'behind'
      else if (j + 1 === targetIdx) state = 'active'
    }
    out.push({
      idx: j,
      from: plan.points[j],
      to: plan.points[j + 1],
      state,
      caution: plan.legs?.[j]?.caution ?? 'ok',
    })
  }
  return out
}

export interface RouteMark {
  idx: number
  lat: number
  lon: number
  kind: 'start' | 'turn' | 'end'
  /** The number drawn on it: turn points 1…n−2, the destination n−1; '' for the start. */
  label: string
  state: 'passed' | 'active' | 'upcoming'
}

/** The numbered turn points, with the one being steered to marked active. */
export function routeMarks(points: readonly LatLon[], targetIdx: number | null): RouteMark[] {
  const last = points.length - 1
  return points.map((p, i) => ({
    idx: i,
    lat: p.lat,
    lon: p.lon,
    kind: i === 0 ? 'start' : i === last ? 'end' : 'turn',
    label: i === 0 ? '' : String(i),
    state:
      targetIdx == null
        ? 'upcoming'
        : i === targetIdx
          ? 'active'
          : i < targetIdx
            ? 'passed'
            : 'upcoming',
  }))
}

/* -------------------------------------------------------------------------
 * The card while steering
 * ---------------------------------------------------------------------- */

export interface NavCardInput {
  plan: Pick<RoutePlan, 'points' | 'arrivalFt'> & { legs?: readonly LegLike[] }
  status: 'navigating' | 'arrived'
  targetIdx: number | null
  fix: NavFix | null
  now: number
  /** Smoothed speed over ground, knots. */
  speedKn: number | null
  cruiseKn: number | null
  /** The crew's arrival setting, feet. */
  arrivalFt: number
  bearingPref: BearingPreference
  declination: number | null
  gpsPoor: boolean
  rerouting: boolean
  offCourseSince: number | null
  /** A message from the store. */
  error?: string | null
  /** A re-route that could not be made, while still off the route. */
  rerouteError?: string | null
  /** A best-effort re-route is waiting for the crew to read and confirm it. */
  pendingReroute?: boolean
  /**
   * The chart puts the boat in water shallower than it needs (`depthM`), or
   * on land, away from the dock stretches at the ends — or, with `maybe`,
   * puts such water or land within the fix's claimed error of the boat.
   */
  shallowHere?: { depthM: number | null; land: boolean; maybe?: boolean } | null
  /**
   * The turn point the boat has switched away from but must round first:
   * the straight line to the next point is not clear on the chart. The card
   * steers to this point ("Round waypoint N first") until it is. Null/absent
   * otherwise. See `useNavigation.roundIdx`.
   */
  roundIdx?: number | null
  /**
   * While rounding: the point the store found the boat can steer for on a
   * line the chart clears — on the leg out of the turn point where it can,
   * so the boat is turned onto that leg rather than driven at the mark and
   * turned there (`useNavigation.roundAim`). The course to steer is to it;
   * the bearing and distance to the turn point are still shown beside it.
   */
  roundAim?: LatLon | null
  /**
   * Speed made good along the route, knots (`routeSpeedKn`) — what the ETA
   * is worked at when known; the smoothed speed over the ground otherwise.
   */
  routeSpeedKn?: number | null
  /**
   * The smaller of the boat's safety margins, metres — its stand-off and the
   * depth margin beside the track (`safetyMarginM`). A fix claiming more
   * error than this is said so on the card. Null/absent: not known.
   */
  safetyMarginM?: number | null
  /**
   * The fix claims more error than the safety margin AND the chart shows
   * shallows, land or a hazard within that error of the line ahead
   * (`useNavigation.gpsSlow`): the card goes red — slow down.
   */
  gpsSlow?: boolean
  /**
   * The next turn is too tight for the boat's speed (`useNavigation.turnSlow`):
   * the card goes red — "Slow down for the turn".
   */
  turnSlow?: boolean
  /** How depths are written on this card (default feet first). */
  formatDepth?: (m: number) => string
  destLabel?: string | null
  formatLength?: LengthFormatter
}

export type TurnCue =
  | { kind: 'turn'; side: 'left' | 'right'; deg: number; text: string }
  | { kind: 'ahead'; text: string }

export interface NavNotice {
  kind:
    | 'stale'
    | 'waiting'
    | 'rerouting'
    | 'off-course'
    | 'gps-poor'
    | 'error'
    | 'leg-caution'
    | 'reroute-confirm'
    | 'shallow-here'
    | 'round-first'
    | 'gps-margin'
    | 'gps-slow'
    | 'estimated'
    | 'turn-slow'
  text: string
  /** How loud: red for a rule broken, amber for "check this". */
  tone?: 'alert' | 'caution'
}

export interface NavCardView {
  phase: 'navigating' | 'arrived'
  targetIdx: number
  /** "Waypoint 3 of 5", "Destination", "Start of the route". */
  title: string
  /**
   * The course to steer, "047°T" — the big number. On the line it is the
   * bearing to the point; set off it, the course that brings the boat back
   * onto the line into the point (`steerCourse`). Null with no fix, or
   * inside the arrival circle.
   */
  bearing: string | null
  /**
   * Bearing to the point itself, "051°T" — rule 4, always shown with the
   * distance. Null with no fix, or inside the arrival circle.
   */
  pointBearing: string | null
  /**
   * Off the line into the point: "45 ft right of the line", or, well off
   * it, "Off the route by 820 ft — re-routing if you stay off". The only
   * turn cue on the card is `turn` (from the heading to the course to
   * steer); this says only where the boat is. Null on the line (within
   * `XTE_CUE_M`), while rounding, or with no fix.
   */
  backOnLine: string | null
  /**
   * The point the second row is about: "WP 3", "Dest", "Start" — always
   * shown with its bearing (`pointBearing`, or "at the mark") and distance.
   */
  wpLabel: string
  /** Distance off the line into the point, feet, + = right of it; null without one. */
  xteFt: number | null
  /**
   * "Slow down — GPS not accurate enough here": the whole card goes red.
   * See `NavCardInput.gpsSlow`.
   */
  slowDown: boolean
  /** The headline when `slowDown`: why to slow down, in a few words. */
  slowText: string | null
  /** Inside the arrival circle of the target, on a fix the store switches on. */
  atMark: boolean
  /**
   * Inside the arrival circle by the fix shown — also on a fix still
   * settling, which the store does not switch on (`atMark` false then).
   * The waypoint row says "at the mark" rather than a bearing that is jitter.
   */
  inCircle: boolean
  /** "850 ft" / "1.24 NM" / "—". */
  distance: string
  turn: TurnCue | null
  /** "Then 090°T for 0.80 NM" — what to steer after this mark. */
  then: string | null
  remaining: string
  timeToGo: string | null
  eta: ClockText | null
  /** How the time was worked: "at 14.2 kn" or "at cruise 20 kn". */
  speedNote: string | null
  /** The circle actually in use for this point, feet. */
  radiusFt: number
  radiusText: string
  /** The numbers are from a fix too old (or none) to steer by. */
  stale: boolean
  notices: NavNotice[]
  /** "You have arrived at Datum". */
  arrivedText: string | null
  /** The caution of the leg being run (into the target), or null. */
  legCaution: LegCaution | null
  /**
   * Steering to a turn point the boat switched away from but must round
   * first ("Round waypoint N first — don't cut the corner"). `targetIdx` is
   * then that turn point.
   */
  rounding: boolean
}

/**
 * The smaller of a boat's two safety margins, metres: its stand-off from land
 * and hazards, and the depth margin kept beside the track outside channels
 * (`depthMarginFor`). With no stand-off set, the depth margin alone.
 */
export function safetyMarginM(clearanceM: number | null | undefined): number | null {
  if (clearanceM == null || !Number.isFinite(clearanceM)) return null
  const depth = depthMarginFor(clearanceM)
  return clearanceM > 0 ? Math.min(clearanceM, depth) : depth
}

/** "±26 ft" — a fix's claimed error, feet. */
function accuracyText(m: number): string {
  return `±${Math.round(m * M_TO_FEET)} ft`
}

/** Beyond this far off the line (metres) the card says the boat is off the route. */
const OFF_ROUTE_CUE_M = 60

/** A fix must claim this much more error than the safety margin before the card says so, metres. */
const MARGIN_SLACK_M = 1

/** Turn-cue deadband, degrees: inside it the boat is "on course". */
export const ON_COURSE_DEG = 5

/**
 * The course of the leg into point `idx` (the first leg, for the start),
 * degrees true; null for a one-point plan.
 */
function legCourse(plan: Pick<RoutePlan, 'points'>, idx: number): number | null {
  const pts = plan.points
  if (pts.length < 2) return null
  const i = Math.max(1, Math.min(idx, pts.length - 1))
  const a = pts[i - 1]
  const b = pts[i]
  if (haversineNM(a.lat, a.lon, b.lat, b.lon) * 1852 < 1) return null
  return bearingDeg(a.lat, a.lon, b.lat, b.lon)
}

/**
 * Everything the big card (and the banner) shows, from the store's state and
 * the live fix. Pure: `now` is passed in.
 */
export function navCardView(input: NavCardInput): NavCardView {
  const fmt = input.formatLength ?? defaultLength
  const { plan, fix, now } = input
  const n = plan.points.length
  const last = n - 1
  const clampIdx = (i: number) => Math.min(Math.max(i, 0), Math.max(n - 1, 0))
  const stale = !fix || isStale(fix, now)
  // Between fixes — a fix interval late up to stale — the numbers are worked
  // from where the boat has run on to since (course and speed from the last
  // fix), with the error that grows with it: a boat at 25 kn covers 60 m in
  // the 5 s a frozen fix used to be shown as live for.
  const here = fix && !stale ? deadReckon(fix, now) : fix
  const stored = clampIdx(input.targetIdx ?? 1)
  // …and a boat run on past its mark between fixes (a dropout at a turn) is
  // shown the next point, as the store will once a fix comes — not the mark
  // behind it.
  const reckoned = !!here && here !== fix && 'deadReckoned' in here && !!here.deadReckoned
  const logical =
    reckoned && input.status === 'navigating' && input.roundIdx == null && here
      ? clampIdx(stepTarget(plan, stored, here, { arrivalFt: input.arrivalFt }).targetIdx)
      : stored
  // Rounding a turn point first: everything on the card — bearing, distance,
  // the leg, what comes next, the distance to go — is worked to the turn
  // point, the one the crew is actually steering for.
  const rounding =
    input.status === 'navigating' &&
    input.roundIdx != null &&
    Number.isFinite(input.roundIdx) &&
    clampIdx(input.roundIdx) < logical
  const idx = rounding ? clampIdx(input.roundIdx as number) : logical

  const { radiusFt } = arrivalRadiusFt(plan, idx, here?.accuracy, { arrivalFt: input.arrivalFt })
  const depth = input.formatDepth ?? feetFirst
  // The leg being run is the one INTO the target: legs[idx − 1].
  const leg = idx >= 1 ? (plan.legs?.[idx - 1] ?? null) : null
  const legCaution: LegCaution | null = leg ? (leg.caution ?? 'ok') : null

  const made =
    input.routeSpeedKn != null && Number.isFinite(input.routeSpeedKn) && input.routeSpeedKn > 0
      ? input.routeSpeedKn
      : null
  const prog = here
    ? navProgress(plan, idx, here, { speedKn: made ?? input.speedKn, cruiseKn: input.cruiseKn, now })
    : null
  const madeGood = made != null && prog?.speedSource === 'gps'

  const distFt = prog ? prog.distanceNM * FT_PER_NM : null
  // Rounding, the bearing to the turn point is the whole point of the card:
  // it is shown however close the boat is to it.
  const inCircle = !rounding && distFt != null && distFt <= radiusFt
  // "At the mark" only when the store can act on it: a fix still settling
  // (or the filter's own estimate) is shown inside the circle, with the leg's
  // course, but the point is not switched on it — the card must not say it is.
  const atMark = inCircle && !here?.settling && !here?.estimate
  const pointBearing =
    prog && !atMark ? bearingText(prog.bearingDeg, input.bearingPref, input.declination) : null
  // The course to steer: back onto the line into the point, not a new
  // straight line to it (a cross-current set a card-following helm onto the
  // bank that way). On the line it is the bearing to the point.
  //
  // Between fixes the course is NOT worked again from the position run on
  // to: dead reckoning carries the boat straight on along the last fix's
  // course, while a helm that follows the card turns — and a course worked
  // from where the boat is not kept asking for more of the same turn (rc3
  // dropturn-0: 47° in five seconds of a dropout, the boat led 70 m off the
  // mark). The course from the last fix stands; only when the run-on
  // carries the boat past the mark is it the course of the leg on.
  const steerFrom = reckoned && fix ? fix : here
  const course =
    prog && !inCircle && steerFrom && !(reckoned && logical !== stored)
      ? steerCourse(plan, idx, steerFrom)
      : null
  const nextLegCourse = reckoned && logical !== stored && !inCircle ? legCourse(plan, idx) : null
  // Rounding: toward the point the store cleared on the chart — on the leg
  // out of the turn point where it could, so the turn is made, not
  // overshot.
  const aim = rounding && input.roundAim && steerFrom ? input.roundAim : null
  // At the mark — inside its circle, the switch not yet made (a fix still
  // settling, the store holding it for a turn) — the bearing to the point
  // is GPS jitter, but a card with no course at all left the helm holding
  // whatever it had: the course of the leg into the point is steered on.
  // Not at the destination: there is no leg on to turn onto, and a boat
  // that came into the last circle at an angle to the last leg was shown
  // that leg's course, 94° off its heading, until it was told it had
  // arrived (rc3 dock-15). There the course is the bearing to it.
  const markCourse = prog && inCircle && idx < last ? legCourse(plan, idx) : null
  const courseDeg = aim && steerFrom
    ? bearingDeg(steerFrom.lat, steerFrom.lon, aim.lat, aim.lon)
    : (markCourse ?? nextLegCourse ?? course?.bearingDeg ?? prog?.bearingDeg ?? null)
  const bearing =
    courseDeg != null ? bearingText(courseDeg, input.bearingPref, input.declination) : null
  const xteM = course?.xteM ?? null
  let backOnLine: string | null = null
  // Not while still coming round the turn onto the leg — "off track" is
  // then the distance from a line the boat has not reached yet — and not
  // while rounding a turn point. Where the boat is, only: the one cue that
  // says which way to turn is `turn`, measured from the heading to the
  // course to steer (a second "steer N° left" measured from the waypoint's
  // bearing disagreed with it). Nor from a position run on between fixes:
  // "N ft off the line" is a measurement, and dead reckoning on the course
  // of the last fix, seconds after a turn, put a boat on the new line
  // 60–100 ft off it (UI re-check, fixes 2.5 s apart).
  if (
    course &&
    prog &&
    xteM != null &&
    Math.abs(xteM) >= XTE_CUE_M &&
    (course.alongM ?? 0) >= 0 &&
    !stale &&
    !reckoned &&
    !rounding
  ) {
    const ft = Math.round(Math.abs(xteM) * M_TO_FEET)
    backOnLine =
      input.offCourseSince != null || Math.abs(xteM) >= OFF_ROUTE_CUE_M
        ? `Off the route by ${ft} ft — re-routing if you stay off`
        : `${ft} ft ${xteM > 0 ? 'right' : 'left'} of the line`
  }

  let turn: TurnCue | null = null
  if (courseDeg != null && !stale) {
    const t = turnToward(courseDeg, fix?.heading)
    if (t != null) {
      const deg = Math.round(Math.abs(t))
      turn =
        deg < ON_COURSE_DEG
          ? { kind: 'ahead', text: 'Steady — on course' }
          : {
              kind: 'turn',
              side: t > 0 ? 'right' : 'left',
              deg,
              text: `Come ${t > 0 ? 'right' : 'left'} ${deg}°`,
            }
    }
  }

  // From the points, not `legs` — the line the crew steers is the line drawn.
  let then: string | null = null
  if (idx < last) {
    const a = plan.points[idx]
    const b = plan.points[idx + 1]
    then = `Then ${bearingText(bearingDeg(a.lat, a.lon, b.lat, b.lon), input.bearingPref, input.declination)} for ${formatNavDistance(
      haversineNM(a.lat, a.lon, b.lat, b.lon),
      fmt,
    )}`
  }

  const title = rounding
    ? idx === 0
      ? 'Go to the start of the route first — don’t cut the corner'
      : `Round waypoint ${idx} first — don’t cut the corner`
    : idx === 0
      ? 'To the start of the route'
      : idx === last
        ? `To the destination${input.destLabel ? ` · ${input.destLabel}` : ''}`
        : `To waypoint ${idx} of ${last}`
  const nextName = logical === last ? 'the destination' : `waypoint ${logical}`

  const eta = prog?.etaMs != null ? formatClock(prog.etaMs, now) : null
  const speedNote =
    prog?.speedKn != null
      ? prog.speedSource === 'gps'
        ? madeGood
          ? `at ${prog.speedKn.toFixed(1)} kn made good along the route`
          : `at ${prog.speedKn.toFixed(1)} kn`
        : `at cruise speed, ${formatKn(prog.speedKn)} kn${
            input.speedKn != null && Number.isFinite(input.speedKn)
              ? ' — not making way over the ground'
              : ' — no speed over the ground yet'
          }`
      : null

  const slowGps = input.status === 'navigating' && !!input.gpsSlow && !stale && !!fix
  const slowTurn = input.status === 'navigating' && !!input.turnSlow && !stale && !!fix
  const slowDown = slowGps || slowTurn
  const slowText = slowGps
    ? 'Slow down — GPS not accurate enough here'
    : slowTurn
      ? 'Slow down for the turn'
      : null
  const notices: NavNotice[] = []
  if (!fix) {
    notices.push({ kind: 'waiting', text: 'Waiting for a GPS fix…' })
  } else if (!stale && fix.estimate === 'poor') {
    notices.push({
      kind: 'estimated',
      tone: 'alert',
      text:
        `GPS too inaccurate${fix.accuracy != null && Number.isFinite(fix.accuracy) ? ` (${accuracyText(fix.accuracy)})` : ''} — ` +
        'its fixes are worse than your accuracy limit, and are used only so you are not left without a ' +
        'position. Waypoints will not switch on them. Slow down and keep a lookout.',
    })
  } else if (!stale && fix.estimate === 'dead-reckoned') {
    notices.push({
      kind: 'estimated',
      tone: 'alert',
      text:
        'GPS fixes are jumping about and have been refused — position estimated from your last course ' +
        `and speed${fix.accuracy != null && Number.isFinite(fix.accuracy) ? ` (${accuracyText(fix.accuracy)})` : ''}. ` +
        'Slow down and keep a lookout.',
    })
  } else if (!stale && here && here !== fix && 'deadReckoned' in here && here.deadReckoned) {
    const ts = fixTime(fix)
    const ageS = ts != null ? Math.max(0, Math.round((now - ts) / 1000)) : null
    notices.push({
      kind: 'estimated',
      tone: 'caution',
      text:
        `No GPS fix for ${ageS != null ? formatAge(ageS) : 'a moment'} — position estimated from your ` +
        `last course and speed${
          here.accuracy != null && Number.isFinite(here.accuracy) ? ` (${accuracyText(here.accuracy)})` : ''
        }. Keep a lookout.`,
    })
  } else if (stale) {
    const ts = fixTime(fix)
    const ageS = ts != null ? Math.max(0, Math.round((now - ts) / 1000)) : null
    notices.push({
      kind: 'stale',
      text:
        ageS != null
          ? `GPS signal lost — last fix ${formatAge(ageS)} ago. These numbers are not live.`
          : 'GPS signal lost. These numbers are not live.',
    })
  }
  if (input.status === 'navigating') {
    if (input.rerouting) {
      notices.push({ kind: 'rerouting', text: 'Re-routing…' })
    } else if (input.offCourseSince != null && !rounding) {
      notices.push({
        kind: 'off-course',
        text: 'Off the route — a new route from here follows if you stay off it.',
      })
    }
    if (rounding && !stale) {
      notices.push({
        kind: 'round-first',
        tone: 'caution',
        text:
          `The straight line from here to ${nextName} is not clear of the shallows, land or ` +
          `your stand-off. Steer for ${idx === 0 ? 'the start' : `waypoint ${idx}`} until it is.`,
      })
    }
    if (input.gpsPoor && !stale) {
      notices.push({
        kind: 'gps-poor',
        text: `GPS accuracy is poor${
          here?.accuracy != null ? ` (±${Math.round(here.accuracy * M_TO_FEET)} ft)` : ''
        } — waypoints switch only when you are clearly there.`,
      })
    }
    const margin = input.safetyMarginM
    const acc = here?.accuracy
    if (slowTurn) {
      notices.push({
        kind: 'turn-slow',
        tone: 'alert',
        text:
          'A turn ahead is too tight to take at speed — the chart leaves no room for the swing. ' +
          'Slow down, and keep your speed down until you are round it.',
      })
    }
    if (slowGps) {
      notices.push({
        kind: 'gps-slow',
        tone: 'alert',
        text:
          `Your position is good to ${acc != null && Number.isFinite(acc) ? accuracyText(acc) : 'only a guess'} ` +
          'only, and the chart shows shallows or land that close to your line ahead. Keep a sharp lookout.',
      })
    } else if (
      !stale &&
      margin != null &&
      Number.isFinite(margin) &&
      margin > 0 &&
      acc != null &&
      Number.isFinite(acc) &&
      acc > margin + MARGIN_SLACK_M
    ) {
      notices.push({
        kind: 'gps-margin',
        tone: 'caution',
        text:
          `GPS accuracy ${accuracyText(acc)} — wider than your safety margin ` +
          `(${Math.round(margin * M_TO_FEET)} ft). Keep a sharp lookout.`,
      })
    }
    if (input.pendingReroute) {
      notices.push({
        kind: 'reroute-confirm',
        tone: 'alert',
        text:
          'Re-route needs your confirmation — the only route found from here is not fully safe. ' +
          'Still steering the current route until you choose.',
      })
    }
    if (input.shallowHere && !stale) {
      const sh = input.shallowHere
      const within = fix?.accuracy != null && Number.isFinite(fix.accuracy) ? accuracyText(fix.accuracy) : null
      notices.push(
        sh.maybe
          ? {
              kind: 'shallow-here',
              tone: 'caution',
              text: sh.land
                ? `You may be close to land or a structure — the chart shows one within your GPS accuracy${
                    within ? ` (${within})` : ''
                  }. Check your position and depth now.`
                : `You may be in water too shallow for your boat — ${depth(sh.depthM ?? 0)} is charted within your GPS accuracy${
                    within ? ` (${within})` : ''
                  }. Check your depth now.`,
            }
          : {
              kind: 'shallow-here',
              tone: 'alert',
              text: sh.land
                ? 'The chart shows land or a structure here — check your position and depth now.'
                : `Charted depth here ${depth(sh.depthM ?? 0)} — less than your boat needs. Check your depth now.`,
            },
      )
    }
    if (legCaution && legCaution !== 'ok' && leg) {
      const note = legNote(leg, {
        formatDepth: depth,
        first: idx - 1 === 0,
        last: idx === last,
      })
      if (note) {
        notices.push({
          kind: 'leg-caution',
          tone: isFlagged(legCaution) ? 'alert' : 'caution',
          text: `This leg: ${note.charAt(0).toLowerCase()}${note.slice(1)}`,
        })
      }
    }
  }
  if (input.rerouteError && input.status === 'navigating') {
    notices.push({ kind: 'error', text: input.rerouteError })
  }
  if (input.error) notices.push({ kind: 'error', text: input.error })

  return {
    phase: input.status,
    targetIdx: idx,
    title,
    bearing,
    pointBearing,
    backOnLine,
    wpLabel: rounding
      ? idx === 0
        ? 'Start'
        : `WP ${idx}`
      : idx === 0
        ? 'Start'
        : idx === last
          ? 'Dest'
          : `WP ${idx}`,
    xteFt: xteM != null ? Math.round(xteM * M_TO_FEET) : null,
    slowDown,
    slowText,
    atMark,
    inCircle,
    distance: prog ? formatNavDistance(prog.distanceNM, fmt) : '—',
    turn,
    then,
    remaining: prog ? formatNavDistance(prog.remainingNM, fmt) : '—',
    timeToGo: prog?.timeToGoH != null ? formatDuration(prog.timeToGoH) : null,
    eta,
    speedNote,
    radiusFt: Math.round(radiusFt),
    radiusText: rounding
      ? `Then ${nextName}`
      : `Counts as reached within ${Math.round(radiusFt)} ft`,
    stale,
    notices,
    arrivedText:
      input.status === 'arrived'
        ? `You have arrived${input.destLabel ? ` at ${input.destLabel}` : ''}`
        : null,
    legCaution,
    rounding,
  }
}

function formatKn(kn: number): string {
  return Number.isInteger(kn) ? String(kn) : kn.toFixed(1)
}

function formatAge(s: number): string {
  if (s < 90) return `${s} s`
  const min = Math.round(s / 60)
  if (min < 90) return `${min} min`
  return `${Math.round(min / 60)} h`
}

/** The fix age past which the card greys out, seconds — the engine's own rule. */
export const CARD_STALE_S = STALE_FIX_S

/* -------------------------------------------------------------------------
 * The banner on every other tab
 * ---------------------------------------------------------------------- */

export interface NavBannerView {
  /**
   * Everything on one line — status first — for a reader that wants one
   * string: "Round WP 3 first · WP 3 · 047°T · 850 ft".
   */
  primary: string
  /** The status alone, on a line of its own: "Round WP 3 first", "Slow down — GPS poor here". */
  status: string | null
  /** The waypoint, its bearing (not the course) and distance: "WP 3 · 047°T · 850 ft". */
  wp: string
  /** "4.2 NM to go · ETA 14:52" */
  secondary: string | null
  tone: 'normal' | 'stale' | 'alert' | 'arrived'
  /**
   * The words to announce, once, for an alert — "Shallow here", "Re-route
   * needs your OK" — never the numbers, which change every second.
   */
  alertText?: string | null
}

export function navBannerView(v: NavCardView): NavBannerView {
  if (v.phase === 'arrived') {
    return {
      primary: v.arrivedText ?? 'You have arrived',
      status: null,
      wp: v.arrivedText ?? 'You have arrived',
      secondary: null,
      tone: 'arrived',
      alertText: null,
    }
  }
  const rerouting = v.notices.some((x) => x.kind === 'rerouting')
  const target = v.rounding
    ? v.targetIdx === 0
      ? 'Start first'
      : `Round WP ${v.targetIdx} first`
    : v.targetIdx === 0
      ? 'Start'
      : v.title.startsWith('To the destination')
        ? 'Dest'
        : `WP ${v.targetIdx}`
  // The waypoint's own bearing and distance (rule 4) — not the course to
  // steer, which is the card's; always all three, "—" for one not known.
  const wp = [
    v.wpLabel,
    v.inCircle ? 'at the mark' : (v.pointBearing ?? '—'),
    v.distance,
  ].join(' · ')
  const roundText = v.rounding ? `Round ${v.targetIdx === 0 ? 'the start' : `WP ${v.targetIdx}`} first` : null
  void target
  const secondary = [
    v.remaining !== '—' ? `${v.remaining} to go` : null,
    etaText(v.eta),
  ]
    .filter(Boolean)
    .join(' · ')
  const pending = v.notices.some((x) => x.kind === 'reroute-confirm')
  const shallowNotice = v.notices.find((x) => x.kind === 'shallow-here')
  const shallow = !!shallowNotice || v.slowDown
  const flaggedLeg = isFlagged(v.legCaution)
  const prefix = pending
    ? 'Re-route needs your OK'
    : v.slowDown && !(shallowNotice && shallowNotice.tone !== 'caution')
      ? v.notices.some((x) => x.kind === 'gps-slow')
        ? 'Slow down — GPS poor here'
        : 'Slow down for the turn'
      : shallow
      ? shallowNotice?.tone === 'caution'
        ? /land/.test(shallowNotice.text)
          ? 'Land may be close'
          : 'May be shallow'
        : 'Shallow here'
      : rerouting
        ? 'Re-routing…'
        : flaggedLeg
          ? v.legCaution === 'reduced-clearance'
            ? 'Close leg'
            : 'Shallow leg'
          : isDotted(v.legCaution)
            ? 'Check depth'
            : null
  const alert =
    pending ||
    shallow ||
    flaggedLeg ||
    rerouting ||
    v.rounding ||
    v.notices.some((x) => x.kind === 'off-course' || x.kind === 'error')
  const status = [prefix, roundText].filter(Boolean).join(' · ') || null
  return {
    primary: status ? `${status} · ${wp}` : wp,
    status,
    wp,
    secondary: secondary || null,
    // A frozen fix greys the banner; but a rule being broken right now is
    // louder than the fix being old.
    tone: pending || shallow ? 'alert' : v.stale ? 'stale' : alert ? 'alert' : 'normal',
    alertText: pending || shallow || flaggedLeg ? prefix : null,
  }
}

/**
 * The banner while steering is PAUSED for the crew to review the route — a
 * boat change the route no longer suits. There is no card to draw it from
 * (status 'preview'), and without it the banner on every other tab simply
 * vanished: steering stopped with nothing on screen to say so.
 */
export function reconfirmBannerView(): NavBannerView {
  return {
    primary: 'Route changed — not fully safe',
    status: 'Route changed — not fully safe',
    wp: 'Steering paused',
    secondary: 'Steering paused · tap to review the flagged legs',
    tone: 'alert',
    alertText: 'Route changed — not fully safe. Steering paused.',
  }
}

/* -------------------------------------------------------------------------
 * When there is no route
 * ---------------------------------------------------------------------- */

export type FailureAction = 'retry' | 'edit-boat' | 'add-boat' | 'pick-dest' | 'change-start'

export interface FailureView {
  title: string
  reason: string
  /** What to change, beyond what the reason already says. */
  hints: string[]
  actions: FailureAction[]
}

/**
 * No line to draw: the plain reason, what the crew can change, and Retry.
 *
 * The router's own failure text already says what to change for its cases
 * (an end on land, no water path); the hints here add what it cannot know —
 * that the phone is offline, or that the area has no chart at all.
 */
export function planFailureView(input: {
  error: string | null
  plan: Pick<RoutePlan, 'failure' | 'coverage' | 'warnings'> | null
  hasBoat: boolean
  online: boolean
  originSet: boolean
}): FailureView {
  const { error, plan, hasBoat, online, originSet } = input
  if (!hasBoat) {
    return {
      title: 'Set up your boat first',
      reason:
        error ??
        'Its draft and stand-off are what keep the route safe — nothing is planned without them.',
      hints: [],
      actions: ['add-boat'],
    }
  }
  const reason = error ?? plan?.failure ?? 'No route could be found to this destination.'
  const hints: string[] = []
  if (!online) {
    hints.push('You are offline. The chart for a new area needs a signal — try again when you have one.')
  }
  if (plan?.coverage === 'none') {
    hints.push(
      'There is no NOAA chart for this area, so nothing can be checked for depth or hazards. ' +
        'Pick a destination in charted US waters.',
    )
  }
  for (const w of plan?.warnings ?? []) if (!hints.includes(w)) hints.push(w)
  const actions: FailureAction[] = ['pick-dest', 'edit-boat']
  if (originSet) actions.push('change-start')
  actions.push('retry')
  return { title: 'No route', reason, hints, actions }
}

/* -------------------------------------------------------------------------
 * The arrival setting on the plotter
 * ---------------------------------------------------------------------- */

/**
 * The note under the plotter's arrival choices. A setting of 50 ft comes from
 * the Search tab — routes still honour it (it only ever makes a circle
 * smaller), but it is not one of the route choices, so say so.
 */
export function arrivalSettingNote(arrivalFt: number, choices: readonly number[]): string {
  const base =
    'Steering moves on to the next waypoint inside this distance, at every waypoint and the ' +
    'destination. Where the straight line on is not clear, the card says to round the waypoint first.'
  if (choices.includes(arrivalFt)) return base
  const used = Math.max(choices[0], Math.min(arrivalFt, choices[choices.length - 1]))
  return (
    `The Search tab is set to ${arrivalFt} ft for search patterns; routes use ${used} ft — ` +
    `their turn points are placed round shoals and jetties. ${base}`
  )
}

/* -------------------------------------------------------------------------
 * How each leg is drawn
 * ---------------------------------------------------------------------- */

export interface SegmentStyle {
  /** SVG stroke colour. */
  color: string
  width: number
  /** SVG dash array, or null for a solid line. */
  dash: string | null
  opacity: number
  linecap: 'round' | 'butt'
}

/**
 * The look of one leg on the map.
 *
 *   - Behind the boat: grey and faint — run already, not to be steered.
 *   - Flagged (too shallow / too close): solid red, whatever else — the one
 *     thing that must never look like a safe leg.
 *   - Shallow approach at an end: amber dots — "check depth here".
 *   - The leg being run: brightest and widest. The rest ahead: plain blue.
 */
export function segmentStyle(seg: Pick<RouteSegment, 'state' | 'caution'>): SegmentStyle {
  const flagged = isFlagged(seg.caution)
  const dotted = isDotted(seg.caution)
  if (seg.state === 'behind') {
    return {
      color: '#94a3b8',
      width: 2,
      dash: dotted ? '1 6' : null,
      opacity: 0.55,
      linecap: 'round',
    }
  }
  const active = seg.state === 'active'
  if (flagged) {
    return { color: '#f87171', width: active ? 5 : 4, dash: null, opacity: 1, linecap: 'round' }
  }
  if (dotted) {
    return { color: '#fcd34d', width: active ? 5 : 4, dash: '0.1 8', opacity: 1, linecap: 'round' }
  }
  return {
    color: active ? '#7dd3fc' : '#38bdf8',
    width: active ? 5 : 3.5,
    dash: null,
    opacity: 1,
    linecap: 'round',
  }
}

/* -------------------------------------------------------------------------
 * The GPS chip in the header
 * ---------------------------------------------------------------------- */

export interface GpsChip {
  label: 'GPS live' | 'GPS lost' | 'GPS fix' | 'GPS off'
  kind: 'live' | 'lost' | 'fix' | 'off'
  title: string
}

/**
 * What the header's GPS chip says — judged by the same freshness rule as the
 * steering card, so the two can never disagree. A running watch with no fix
 * for 15 s is "GPS lost", not "GPS live": the chip used to read the watch
 * alone and stayed green beside a card saying the signal was gone.
 */
export function gpsChip(
  watching: boolean,
  fix: { timestamp?: number | null; receivedAt?: number | null } | null,
  now: number,
): GpsChip {
  if (watching) {
    if (fix && !isStale(fix, now)) {
      return { label: 'GPS live', kind: 'live', title: 'Recording a continuous track' }
    }
    const t = fixTime(fix)
    return {
      label: 'GPS lost',
      kind: 'lost',
      title:
        t != null
          ? `No fix for ${formatAge(Math.max(0, Math.round((now - t) / 1000)))} — the track is still running`
          : 'Waiting for the first fix — the track is running',
    }
  }
  if (fix) {
    return {
      label: 'GPS fix',
      kind: 'fix',
      title: 'A position fix is in hand; the continuous track is not running',
    }
  }
  return { label: 'GPS off', kind: 'off', title: 'No position yet' }
}

/* -------------------------------------------------------------------------
 * Turn points on a small map
 * ---------------------------------------------------------------------- */

/**
 * Which numbered turn points to draw at this zoom.
 *
 * A best-effort route framed whole puts its short flagged hops — 122, 172,
 * 244 ft — under a pile of marker circles, and the red legs the crew most
 * needs to see are hidden beneath them. So a turn point closer than `minPx`
 * to the last one drawn is left out, unless it is the start, the
 * destination, or the one being steered to. Each kept mark says how many it
 * stands for (`hidden`), so the map can show "5–8".
 *
 * Two more rules, both from what the map actually showed:
 *
 *   - **Nothing is folded into the start.** The start is a plain dot with no
 *     number, so waypoint 1 folded into it simply vanished from the preview.
 *     Waypoint 1 is always drawn, and points close after it fold into IT.
 *   - **Group labels may not overlap.** "10–11" was drawn across "5–9". The
 *     map puts a group's label up and to the right of its circle
 *     (`groupLabelBox`); a group whose circle or label would land on an
 *     earlier circle or label is folded into the group before it ("5–11").
 */
export function declutterMarks<M extends Pick<RouteMark, 'kind' | 'state' | 'idx'> & { label?: string }>(
  marks: readonly M[],
  project: (m: M) => { x: number; y: number },
  minPx = 20,
): { mark: M; hidden: number[] }[] {
  const out: { mark: M; hidden: number[]; p: { x: number; y: number } }[] = []
  const foldable = (m: M) => m.kind === 'turn' && m.state !== 'active'
  for (const m of marks) {
    const p = project(m)
    const prev = out[out.length - 1]
    if (
      foldable(m) &&
      prev &&
      prev.mark.kind !== 'start' &&
      Math.hypot(p.x - prev.p.x, p.y - prev.p.y) < minPx
    ) {
      prev.hidden.push(m.idx)
      continue
    }
    out.push({ mark: m, hidden: [], p })
  }

  // Labels: fold a group into the one before it while it would collide.
  let guard = out.length + 1
  for (let changed = true; changed && guard-- > 0; ) {
    changed = false
    for (let i = 1; i < out.length; i++) {
      const c = out[i]
      const prev = out[i - 1]
      if (!foldable(c.mark) || prev.mark.kind === 'start') continue
      const circle = markBox(c.mark, c.p)
      const label = c.hidden.length > 0 ? groupLabelBox(c.mark, c.p, c.hidden) : null
      let hit = false
      for (let k = 0; k < i && !hit; k++) {
        const o = out[k]
        const oLabel = o.hidden.length > 0 ? groupLabelBox(o.mark, o.p, o.hidden) : null
        hit =
          (oLabel != null && boxesOverlap(circle, oLabel)) ||
          (label != null && (boxesOverlap(label, markBox(o.mark, o.p)) || (oLabel != null && boxesOverlap(label, oLabel))))
      }
      if (!hit) continue
      prev.hidden.push(c.mark.idx, ...c.hidden)
      out.splice(i, 1)
      changed = true
      break
    }
  }
  return out.map(({ mark, hidden }) => ({ mark, hidden }))
}

export interface ScreenBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Radius of a route mark's circle on the map, px — as SatelliteMap draws it. */
export function markRadius(m: Pick<RouteMark, 'kind' | 'state'>): number {
  if (m.kind === 'start') return 5
  return m.state === 'active' ? 11 : 9
}

function markBox(m: Pick<RouteMark, 'kind' | 'state'>, p: { x: number; y: number }): ScreenBox {
  const r = markRadius(m)
  return { x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r }
}

/** The text of a group's label: "5–9". */
export function groupLabelText(m: { idx: number; label?: string }, hidden: readonly number[]): string {
  return `${m.label ?? String(m.idx)}–${hidden[hidden.length - 1]}`
}

/**
 * Where a group's label sits on the map, px: its baseline starts `r + 3`
 * right of the circle's centre and `r` above it, 10 px bold (about 6.6 px a
 * character, allowing for a wide fallback font). SatelliteMap draws it there.
 */
export function groupLabelBox(
  m: Pick<RouteMark, 'kind' | 'state' | 'idx'> & { label?: string },
  p: { x: number; y: number },
  hidden: readonly number[],
): ScreenBox {
  const r = markRadius(m)
  const x0 = p.x + r + 3
  const y1 = p.y - r + 2
  return { x0, y0: y1 - 11, x1: x0 + 6.6 * groupLabelText(m, hidden).length, y1 }
}

/** Space kept between labels and circles, px — touching reads as one label. */
const LABEL_GAP_PX = 4

function boxesOverlap(a: ScreenBox, b: ScreenBox): boolean {
  const g = LABEL_GAP_PX
  return a.x0 < b.x1 + g && b.x0 < a.x1 + g && a.y0 < b.y1 + g && b.y0 < a.y1 + g
}

/**
 * Whether the one-line route banner is up.
 *
 * On every tab but the Chart tab while a route is steered (or just arrived
 * at) — and on the Chart tab too whenever its big card is scrolled out of
 * view, which is where Start used to leave it: no bearing, distance or ETA
 * anywhere on screen. Also while steering is paused for the crew to review a
 * changed route, so that pause is never silent.
 */
export function showNavBanner(o: {
  onChartTab: boolean
  status: string
  reconfirm: boolean
  cardInView: boolean
}): boolean {
  const live =
    o.status === 'navigating' || o.status === 'arrived' || (o.status === 'preview' && o.reconfirm)
  return live && (!o.onChartTab || !o.cardInView)
}

/**
 * The tab the app opens on. A reload mid-passage — or a phone that killed the
 * app in a pocket — used to open on Home, with only the banner to say a route
 * was being steered; it opens on the steering card instead.
 */
export function initialTab(navStatus: string): 'chart' | 'home' {
  return navStatus === 'navigating' || navStatus === 'arrived' ? 'chart' : 'home'
}

/**
 * What the map frames when planning found no route: the boat (or the start
 * chosen by hand) and the destination that failed — so the crew can see the
 * point they picked, instead of a map still zoomed on the boat. Null unless
 * the plan failed with a destination. Keyed per attempt, so it frames once
 * and a pan afterwards is left alone.
 */
export function failureFrame(o: {
  status: string
  dest: LatLon | null
  origin: LatLon | null
  fix: LatLon | null
  lastPlannedAt: number | null
}): { key: string; points: LatLon[] } | null {
  if (o.status !== 'failed' || !o.dest) return null
  const start = o.origin ?? o.fix
  return {
    key: `none:${o.lastPlannedAt ?? `${o.dest.lat},${o.dest.lon}`}`,
    points: [
      ...(start ? [{ lat: start.lat, lon: start.lon }] : []),
      { lat: o.dest.lat, lon: o.dest.lon },
    ],
  }
}
