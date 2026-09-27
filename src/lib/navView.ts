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
  isStale,
  navProgress,
  STALE_FIX_S,
  type NavFix,
} from './navigate'
import type { LegCaution, RouteLeg, RoutePlan } from './routing'
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
  const text = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const dayMark =
    dayOffset <= 0 ? '' : dayOffset === 1 ? '+1 day' : `+${dayOffset} days`
  return { text, dayOffset, dayMark }
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
  /** Shallow approach at an end — drawn dotted, "check depth here". */
  dotted: boolean
  /** What is wrong with it, in plain words; null for a sound leg. */
  note: string | null
}

type LegLike = Pick<RouteLeg, 'n' | 'courseDeg' | 'lengthNM' | 'caution'> &
  Partial<Pick<RouteLeg, 'minChartedDepthM' | 'minClearanceM'>>

/** One row per leg, with the reason it is flagged. */
export function legRows(
  legs: readonly LegLike[],
  opts: { formatDepth?: (m: number) => string } = {},
): LegRow[] {
  const depth = opts.formatDepth ?? feetFirst
  return legs.map((leg) => {
    const caution = leg.caution ?? 'ok'
    let note: string | null = null
    if (caution === 'unsafe-depth') {
      note =
        leg.minChartedDepthM != null
          ? `Too shallow — ${depth(leg.minChartedDepthM)} charted`
          : 'Too shallow — not surveyed'
    } else if (caution === 'reduced-clearance') {
      note =
        leg.minClearanceM != null
          ? `Close to land or a hazard — ${feetFirst(leg.minClearanceM)} off`
          : 'Close to land or a hazard'
    } else if (caution === 'shallow-approach') {
      note = 'Check depth here'
    }
    return {
      n: leg.n,
      courseDeg: leg.courseDeg,
      lengthNM: leg.lengthNM,
      caution,
      flagged: caution === 'unsafe-depth' || caution === 'reduced-clearance',
      dotted: caution === 'shallow-approach',
      note,
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
  plan: Pick<RoutePlan, 'points' | 'legs' | 'arrivalFt'>
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
  /** A message from the store — e.g. a re-route that could not be made. */
  error?: string | null
  destLabel?: string | null
  formatLength?: LengthFormatter
}

export type TurnCue =
  | { kind: 'turn'; side: 'left' | 'right'; deg: number; text: string }
  | { kind: 'ahead'; text: string }

export interface NavNotice {
  kind: 'stale' | 'waiting' | 'rerouting' | 'off-course' | 'gps-poor' | 'error'
  text: string
}

export interface NavCardView {
  phase: 'navigating' | 'arrived'
  targetIdx: number
  /** "Waypoint 3 of 5", "Destination", "Start of the route". */
  title: string
  /** "047°T" — null with no fix, or inside the arrival circle. */
  bearing: string | null
  /** Inside the arrival circle of the target. */
  atMark: boolean
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
}

/** Turn-cue deadband, degrees: inside it the boat is "on course". */
export const ON_COURSE_DEG = 5

/**
 * Everything the big card (and the banner) shows, from the store's state and
 * the live fix. Pure: `now` is passed in.
 */
export function navCardView(input: NavCardInput): NavCardView {
  const fmt = input.formatLength ?? defaultLength
  const { plan, fix, now } = input
  const n = plan.points.length
  const idx = Math.min(Math.max(input.targetIdx ?? 1, 0), Math.max(n - 1, 0))
  const last = n - 1

  const stale = !fix || isStale(fix, now)
  const { radiusFt } = arrivalRadiusFt(plan, idx, fix?.accuracy, { arrivalFt: input.arrivalFt })

  const prog = fix
    ? navProgress(plan, idx, fix, { speedKn: input.speedKn, cruiseKn: input.cruiseKn, now })
    : null

  const distFt = prog ? prog.distanceNM * FT_PER_NM : null
  const atMark = distFt != null && distFt <= radiusFt
  const bearing =
    prog && !atMark ? bearingText(prog.bearingDeg, input.bearingPref, input.declination) : null

  let turn: TurnCue | null = null
  if (prog && !atMark && !stale) {
    const t = turnToward(prog.bearingDeg, fix?.heading)
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

  const title =
    idx === 0
      ? 'To the start of the route'
      : idx === last
        ? `To the destination${input.destLabel ? ` · ${input.destLabel}` : ''}`
        : `To waypoint ${idx} of ${last}`

  const eta = prog?.etaMs != null ? formatClock(prog.etaMs, now) : null
  const speedNote =
    prog?.speedKn != null
      ? prog.speedSource === 'gps'
        ? `at ${prog.speedKn.toFixed(1)} kn`
        : `at cruise speed, ${formatKn(prog.speedKn)} kn${
            input.speedKn != null && Number.isFinite(input.speedKn)
              ? ' — not making way over the ground'
              : ' — no speed over the ground yet'
          }`
      : null

  const notices: NavNotice[] = []
  if (!fix) {
    notices.push({ kind: 'waiting', text: 'Waiting for a GPS fix…' })
  } else if (stale) {
    const ts = fix.timestamp
    const ageS = ts != null && Number.isFinite(ts) ? Math.max(0, Math.round((now - ts) / 1000)) : null
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
    } else if (input.offCourseSince != null) {
      notices.push({
        kind: 'off-course',
        text: 'Off the route — a new route from here follows if you stay off it.',
      })
    }
    if (input.gpsPoor && !stale) {
      notices.push({
        kind: 'gps-poor',
        text: `GPS accuracy is poor${
          fix?.accuracy != null ? ` (±${Math.round(fix.accuracy * M_TO_FEET)} ft)` : ''
        } — waypoints switch only when you are clearly there.`,
      })
    }
  }
  if (input.error) notices.push({ kind: 'error', text: input.error })

  return {
    phase: input.status,
    targetIdx: idx,
    title,
    bearing,
    atMark,
    distance: prog ? formatNavDistance(prog.distanceNM, fmt) : '—',
    turn,
    then,
    remaining: prog ? formatNavDistance(prog.remainingNM, fmt) : '—',
    timeToGo: prog?.timeToGoH != null ? formatDuration(prog.timeToGoH) : null,
    eta,
    speedNote,
    radiusFt: Math.round(radiusFt),
    radiusText: `Counts as reached within ${Math.round(radiusFt)} ft`,
    stale,
    notices,
    arrivedText:
      input.status === 'arrived'
        ? `You have arrived${input.destLabel ? ` at ${input.destLabel}` : ''}`
        : null,
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
  /** "WP 3 · 047°T · 850 ft" / "Re-routing…" / "You have arrived". */
  primary: string
  /** "4.2 NM to go · ETA 14:52" */
  secondary: string | null
  tone: 'normal' | 'stale' | 'alert' | 'arrived'
}

export function navBannerView(v: NavCardView): NavBannerView {
  if (v.phase === 'arrived') {
    return { primary: v.arrivedText ?? 'You have arrived', secondary: null, tone: 'arrived' }
  }
  const rerouting = v.notices.some((x) => x.kind === 'rerouting')
  const target =
    v.targetIdx === 0 ? 'Start' : v.title.startsWith('To the destination') ? 'Dest' : `WP ${v.targetIdx}`
  const parts = [target, v.atMark ? 'at the mark' : v.bearing, v.distance].filter(
    (x): x is string => !!x && x !== '—',
  )
  const secondary = [
    v.remaining !== '—' ? `${v.remaining} to go` : null,
    etaText(v.eta),
  ]
    .filter(Boolean)
    .join(' · ')
  return {
    primary: rerouting ? `Re-routing… · ${parts.join(' · ')}` : parts.join(' · '),
    secondary: secondary || null,
    tone: v.stale ? 'stale' : rerouting || v.notices.some((x) => x.kind === 'off-course') ? 'alert' : 'normal',
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
    'Steering moves on to the next waypoint inside this distance. Tight turns use a smaller circle, ' +
    'shown on the card while you steer.'
  return choices.includes(arrivalFt)
    ? base
    : `Now ${arrivalFt} ft (set for search patterns). ${base}`
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
  const flagged = seg.caution === 'unsafe-depth' || seg.caution === 'reduced-clearance'
  const dotted = seg.caution === 'shallow-approach'
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
