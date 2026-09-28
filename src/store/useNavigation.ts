import { create } from 'zustand'
import {
  persist,
  createJSONStorage,
  type PersistStorage,
  type StorageValue,
} from 'zustand/middleware'
import {
  liveAhead,
  liveChartNear,
  type ApproachZone,
  liveRay,
  liveRayClear,
  livePathShortcut,
  liveShortcut,
  planningBounds,
  planAlternatives,
  planRoute,
  recheckPlan,
  type AltReason,
  widePlanningBounds,
  recomputeArrivalRadii,
  type ChartFeatures,
  type LiveChartRequest,
  type RoutePlan,
  type ShortcutVerdict,
} from '@/lib/routing'
import {
  bandsForSpan,
  boundsSpanNM,
  containsBounds,
  corridorPoints,
  detailBox,
  padBounds,
  type ChartBounds,
} from '@/lib/chart'
import {
  arrivalRadiusFt,
  isOffCourse,
  isStale,
  joinTarget,
  legGeometry,
  logProgress,
  MIN_SOG_KN,
  navProgress,
  passedTurn,
  recoverTarget,
  shortcutClear,
  smoothSpeedKn,
  startTarget,
  setAllowanceDeg,
  speedLookaheadM,
  steerCourse,
  stepTarget,
  updateHelm,
  updateSet,
  updateTurnRate,
  turnRateDps,
  turnReactS,
  TURN_ASSUMED_DPS,
  TURN_ASSUMED_REACT_S,
  type TurnRecord,
  LOOKAHEAD_MIN_M,
  type HelmRecord,
  type ArrivalOptions,
  type ProgressSample,
  type SetEstimate,
} from '@/lib/navigate'
import { safetyMarginM, type SteerGuideLike } from '@/lib/navView'
import { bearingDeg, haversineNM, MPS_TO_KNOTS, NM_TO_METERS } from '@/lib/geo'
import { MAX_ARRIVAL_FT, routeArrivalFt } from '@/lib/steer'
import type { LatLon } from '@/lib/search'
import type { Fix } from '@/lib/types'
import { DEFAULT_SHALLOW_MARGIN_M, safeDepthM, shallowMarginOf, M_TO_FEET, type Vessel } from '@/lib/vessel'
import { describeError } from '@/lib/retry'
import { useChartData } from '@/store/useChartData'
import { useTeams } from '@/store/useTeams'
import { useTracker } from '@/store/useTracker'
import { useVessels } from '@/store/useVessels'

/**
 * The route being steered — one for the whole app, not one per screen.
 *
 * This used to live inside the Chart tab, which meant a crew that looked at
 * the tide table mid-passage came back to no route, no target and no idea
 * which turn they were on. Now the route, where the boat is along it and
 * what is happening to it (planning, steering, re-routing, arrived) is a
 * store: every tab reads it, the engine hook (`hooks/useNavigationEngine.ts`)
 * drives it from the GPS, and it is persisted so a reload — or a phone that
 * killed the app in a pocket — picks the passage up where it was.
 *
 * The flow is Google Maps', because that is the flow every crew already
 * knows: pick a destination, see the route, press Start, follow the card;
 * leave the route and it re-plans from where you are.
 *
 * What it deliberately does NOT do:
 *
 *   - **Steer a best-effort route unconfirmed.** A plan the router could not
 *     make fully safe (`needsConfirm`) can be looked at but not started until
 *     the crew has said, in so many words, that they have read the flagged
 *     legs. A re-route that comes back best-effort is held as `pendingPlan`
 *     for the same confirmation while the crew keeps steering the route they
 *     already accepted — it never silently ends the steering, and the banner
 *     on every tab says a new route is waiting.
 *   - **Keep steering a route planned for a different boat.** A boat made
 *     deeper (or given a wider stand-off) mid-passage is re-planned; when that
 *     fails the current route is re-checked against the chart for the new
 *     boat, and one that no longer suits it goes back to the preview, flagged,
 *     for confirmation.
 *   - **Let an older plan overwrite a newer one.** Every plan carries a
 *     sequence number; a plan finishing after a newer one was asked for is
 *     thrown away. Plotting a destination, changing your mind and plotting
 *     another must never end with the first route on the screen.
 *   - **Re-route on a whim.** Off course has to be continuous for 10 s, and
 *     re-routes are at least 20 s apart, so one bad fix or a wide turn does
 *     not throw a new route at the crew every second.
 *   - **Wait for ever.** A chart load that does not answer is given up on
 *     (`LIVE_CHART_TIMEOUT_MS`), so "Re-routing…" can never stick.
 *   - **Need a signal to re-route.** The chart is loaded along the whole
 *     route when the passage is planned, and a re-route plans on what is
 *     already in memory when it covers the new box.
 *   - **Make a noise.** Alerts are on screen only — the crew asked for that.
 */

/** See `NavigationState.guide`. */
export type SteerGuide = SteerGuideLike

/** A named position — the destination, or a start chosen by hand. */
export interface Place {
  lat: number
  lon: number
  label: string
}

export type NavStatus =
  | 'idle'
  | 'planning'
  | 'preview'
  | 'navigating'
  | 'arrived'
  | 'failed'

/**
 * Why a plan is being made.
 *
 * - `user` — the crew picked or changed an end. Always a fresh preview.
 * - `reroute` — the boat left the route. From the live fix, keeps steering.
 * - `boat` — the boat's draft, margin, stand-off or speed changed. While
 *   steering: from the live fix, keeps steering; otherwise a fresh preview.
 *   (The arrival setting does NOT re-plan: see `setArrivalCap`.)
 * - `retry` — the last attempt failed (no signal, no fix); try again.
 */
export type ReplanReason = 'user' | 'reroute' | 'boat' | 'retry'

/** Continuous time off course before re-routing, ms. */
export const OFF_COURSE_HOLD_MS = 10_000
/**
 * Continuous time off course before re-routing when the line back to the
 * route is not clear on the chart, ms — see `onFix`.
 */
export const OFF_COURSE_UNSAFE_HOLD_MS = 3_000
/** Most points passed on one fix (see `onFix`). */
const MAX_ADVANCE = 3
/** Least time between two automatic re-routes, ms. */
export const REROUTE_MIN_GAP_MS = 20_000
/**
 * Re-routes back off: at most `REROUTE_MAX_IN_WINDOW` automatic re-routes in
 * any `REROUTE_WINDOW_MS`, and `REROUTE_MIN_GAP_MS` apart. Three or four in
 * two minutes — a boat stopped and drifting in a current, a helm that cannot
 * hold the line — is a new route thrown at the crew every time they look at
 * the card (rc5 reroute storms; the rc3 harness counts three as a storm).
 * Meanwhile the card keeps steering them back onto the route they have.
 */
export const REROUTE_WINDOW_MS = 120_000
export const REROUTE_MAX_IN_WINDOW = 2
/**
 * Longest a re-route waits for the chart, ms. On a stalled link the load
 * used to hang for minutes with "Re-routing…" on the card and every later
 * re-route blocked behind it; now the attempt fails in plain words and the
 * next off-course window tries again.
 */
export const LIVE_CHART_TIMEOUT_MS = 25_000
/** Longest a new plan waits for the chart, ms. A first load is many queries. */
export const PLAN_CHART_TIMEOUT_MS = 90_000
/** The approach stretch round each end the planner uses, metres. */
const APPROACH_M = 120

/**
 * How much of the fix's claimed error is added to the stand-off and the
 * depth margin when the line the boat is about to steer is checked against
 * the chart, as a multiple of that figure. A receiver's "±20 m" is the 68 %
 * circle; 1.6 times it is the 95 % circle — the boat is inside that nineteen
 * times in twenty, where inside the 68 % one it is outside it one fix in
 * three, and that was the margin "round first" used to be let go on.
 */
export const LINE_BUFFER_ACC = 1.6

/**
 * Fixes in a row the line to the next point must be clear on before "round
 * waypoint N first" is let go. One clear fix — a lucky one, in noise — used
 * to be enough, and the boat turned for a line that was clear only on paper.
 */
export const CLEAR_FIXES = 3

/**
 * A speed over the ground of exactly 0 from the filter is ignored for the
 * ETA until it has lasted this long, ms: the filter says 0 when it cannot
 * tell the speed from its own noise, for a fix or two, on a boat making way.
 */
const STILL_HOLD_MS = 5_000

export const NAV_STORAGE_KEY = 'navmate.nav.v1'

/** What a plan was checked against — the boat it was made for. */
export interface PlannedFor {
  safeDepthM: number
  clearanceM: number
  speedKn: number
  /**
   * The boat's "keep ___ from shallows", metres (`RouteRequest.shallowMarginM`).
   * Absent on a passage saved before the setting existed: the default.
   */
  shallowMarginM?: number
}

/** One chart load a passage was planned on — replayed after a reload. */
export interface ChartLoadRecord {
  bounds: ChartBounds
  detailAround: LatLon[]
}

/** Charted water under the boat shallower than it needs, or land. */
export interface ShallowHere {
  /** Charted depth, metres, or null for land / a structure. */
  depthM: number | null
  land: boolean
  /**
   * Not at the fix itself but within the fix's claimed error of it: the boat
   * MAY be in it. The card words it so ("may be"), in amber, not red.
   */
  maybe?: boolean
}

/**
 * One of the routes offered for a passage — Google Maps' main line and its
 * faded alternatives. Index 0 is always the planner's own route (keeps every
 * rule); the rest are shorter ways that bend one (`planAlternatives`).
 */
export interface RouteOption {
  plan: RoutePlan
  /** What it bends — empty for the main route. */
  reasons: AltReason[]
  /** "Shallow 3.5 ft · close to land 15 ft"; "" for the main route. */
  label: string
  /** How much shorter than the main route, NM (0 for the main route). */
  shorterNM: number
}

export interface NavigationState {
  dest: Place | null
  /** null = start from my live position (the normal case). */
  origin: Place | null
  plan: RoutePlan | null
  /**
   * The routes on offer for this passage (not persisted): [main, …shorter
   * alternatives]. Null until worked out (just after the plan) or when there
   * are none. `plan` is always `routes[routeIdx].plan` while they exist.
   */
  routes: RouteOption[] | null
  /** Which of `routes` is shown and will be steered. */
  routeIdx: number
  /**
   * "A way 8.0 NM shorter … crosses water charted 0 ft — your boat needs
   * 4.9 ft" — when the main route is much longer than the shortest water
   * path. Null otherwise.
   */
  shorterNote: string | null
  status: NavStatus
  /** The point being steered to, while navigating (or last steered to). */
  targetIdx: number | null
  /** Plain words for the crew — why planning failed, or what to do next. */
  error: string | null
  /**
   * An automatic re-route (or boat re-plan) that could not be made, while the
   * current route is still being steered. Kept apart from `error` because it
   * is tied to being off the route: back on it, this clears itself.
   */
  rerouteError: string | null
  /** The crew has accepted this best-effort plan's flagged legs. */
  confirmed: boolean
  /**
   * A re-route that came back best-effort, waiting for the crew to read it.
   * Steering carries on along the current (accepted) route meanwhile.
   */
  pendingPlan: RoutePlan | null
  /**
   * Steering was paused for the crew to review the route — a boat change it
   * no longer suits. Status is 'preview'; the banner stays up on every tab
   * with an alert until the crew has looked.
   */
  reconfirm: boolean
  /** The boat `plan` was made (or last checked) for. */
  plannedFor: PlannedFor | null
  /** The chart loads `plan` was made on, in order — replayed after a reload. */
  chartLoads: ChartLoadRecord[]
  /** Account the passage belongs to — cleared when another signs in. */
  ownerId: string | null
  /** When the boat went off course (ms), while it stays off; else null. */
  offCourseSince: number | null
  /** When the current plan was made (ms), or null. */
  lastPlannedAt: number | null
  /** Automatic re-routes this passage. */
  reroutes: number
  /** Smoothed speed over ground, knots — for the ETA. */
  speedKn: number | null
  /**
   * The last fix was too poor to judge arrival honestly: it claimed more
   * error than the target point's safe radius (see `arrivalRadiusFt`).
   */
  gpsPoor: boolean
  /**
   * The chart puts the boat's position in water shallower than it needs (or
   * on land), away from the dock stretches at either end. On screen at once,
   * whether or not the boat is far enough off the line to count as off course.
   */
  shallowHere: ShallowHere | null
  /**
   * Where the passage set out from — the start of the last plan made from
   * scratch (not a re-route). The shallow-band allowance of the approach
   * stays round it on every re-route (`approachZonesFor`). Persisted with
   * the passage.
   */
  departure: LatLon | null
  /**
   * A re-route (or boat-change re-plan) is being worked out while the crew
   * keeps steering the current route. The card says "Re-routing…".
   */
  rerouting: boolean
  /** When the last automatic re-route started (ms). Not persisted. */
  lastRerouteAt: number | null
  /** Timestamp of the last fix used (ms), for the speed smoothing. */
  lastFixAt: number | null
  /**
   * `targetIdx` is a guess (no fix at Start, or restored after a reload) and
   * must be re-derived from the next fix with `startTarget`.
   */
  resume: boolean
  /**
   * The turn point the boat has switched away from but not yet rounded: the
   * straight line from the boat to `targetIdx` is not safe on the chart
   * (with the fix's error added), so the card says "Round waypoint N first —
   * don't cut the corner" and steers to this point until the line is clear.
   * Always `targetIdx − 1` when set; null otherwise. Not persisted.
   */
  roundIdx: number | null
  /**
   * While rounding (`roundIdx` set): the point the card steers for — the
   * furthest point along the leg out of the turn point that the boat can
   * reach on a line the chart clears (fix error included), or a point far
   * along the leg out's course when the turn must start now (speed-aware).
   * Null otherwise — and when none is clear, or the fix is too poor: the
   * card then steers for the turn point along the leg into it. Not persisted.
   */
  roundAim: LatLon | null
  /**
   * The boat has been told to turn onto the leg out (speed-aware turn
   * anticipation, see `aimRound`): the card keeps giving that course until
   * the turn point is rounded — a fix whose error grows in the turn itself
   * must not send the boat back to the mark half way round. Not persisted.
   */
  roundTurning: boolean
  /** Distance to go over the last minute, for the ETA. Not persisted. */
  progressLog: ProgressSample[]
  /**
   * While rounding: fixes in a row the line on to the next point has been
   * clear on (see `CLEAR_FIXES`). Not persisted.
   */
  clearRun: number
  /**
   * The last fix was inside the destination's circle (but not by its own
   * error, so not yet enough to call it arrived). Not persisted.
   */
  arriveSeen: boolean
  /**
   * The fix claims more error than the boat's safety margin, and the chart
   * shows shallows, land or a hazard within that error of the line ahead:
   * the card goes red — "Slow down — GPS not accurate enough here".
   */
  gpsSlow: boolean
  /**
   * The next turn is too tight for the speed the boat is making: the arc a
   * boat swings at this speed to join the leg out does not fit the water the
   * chart allows there, and a slower one would. The card goes red — "Slow
   * down for the turn". Not persisted.
   */
  turnSlow: boolean
  /** The turn point `turnSlow` is for, while it holds. Not persisted. */
  turnSlowAt: number | null
  /** Since when the filter has read the boat as stopped (ms), or null. Not persisted. */
  stillSince: number | null
  /**
   * How to steer on the last fix, worked out against the chart: the
   * lookahead that keeps the course from pointing at land, the allowance
   * for the set, and whether shallows, land or a hazard are near enough that
   * losing the fix should slow the boat down. The card uses it for the fix
   * it was worked for. Not persisted.
   */
  guide: SteerGuide | null
  /** The set learnt so far (`updateSet`). Not persisted. */
  setEst: SetEstimate | null
  /** How the helm has been holding the line (`updateHelm`). Not persisted. */
  helm: HelmRecord | null
  /** When the recent automatic re-routes were made (ms), for the back-off. Not persisted. */
  rerouteLog: number[]
  /** How fast this boat has been seen to come round (`updateTurnRate`). Not persisted. */
  turnRec: TurnRecord | null

  /**
   * Plan to `place`, immediately. `origin` undefined keeps the current
   * start; null means my live position; a place means plan from there.
   */
  setDestination: (place: Place, origin?: Place | null) => Promise<void>
  /** Change the start (null = my live position), re-planning if there is a destination. */
  setOrigin: (place: Place | null) => Promise<void>
  replan: (reason: ReplanReason) => Promise<void>
  /**
   * Begin steering. False (with `error` set) when there is nothing safe to
   * start: no plan, a `none` plan, or a best-effort plan not yet confirmed —
   * or when the boat is away from a start chosen by hand, in which case the
   * route is re-planned from where the boat is (status 'planning').
   */
  start: () => boolean
  confirmBestEffort: () => void
  /**
   * Show route `i` of `routes` instead (preview only). A route that bends a
   * rule needs the "I understand" again — every switch clears it.
   */
  selectRoute: (i: number) => void
  /**
   * Open a route made elsewhere — saved on this phone, or shared by another
   * crew — as a preview. It is re-checked against the chart for THIS boat
   * first (`recheckPlan`): still sound, it is shown as it is; not, it is
   * re-planned between the same two ends and the crew is told why. Never
   * steered on the strength of the boat it was made for.
   */
  openRoute: (input: {
    plan: RoutePlan
    dest: Place
    origin: Place
    name: string
    /** How the crew knows it: "Saved route" (default) or "Shared route". */
    noun?: string
  }) => Promise<void>
  /** Steer the re-route waiting for confirmation (its flagged legs accepted). */
  acceptPendingPlan: () => void
  /** Keep steering the current route; drop the waiting re-route. */
  dismissPendingPlan: () => void
  /**
   * The crew changed the arrival setting: resize the turn points' circles for
   * it, WITHOUT re-planning — the points and their numbers stay as they are.
   */
  setArrivalCap: (ft: number) => void
  /** Stop steering; the route stays on the chart as a preview. After arrival, finish the passage. */
  stop: () => void
  /** Forget the destination and the route. */
  clear: () => void
  /** Forget everything, the owner too — sign-out. */
  reset: () => void
  /** The signed-in account: a passage left by another account is cleared. */
  bindOwner: (uid: string) => void
  /** Feed a (filtered) GPS fix while navigating. */
  onFix: (fix: Fix) => void
  /**
   * Steering with no chart in memory (a reload mid-passage): read the
   * passage's own chart loads again — the device cache answers them with no
   * signal — so the live checks (shortcut, shallow here) have a chart.
   */
  restoreChart: () => Promise<void>
}

/** The boat the plotter plans for — the same choice the Chart tab shows. */
export function activeVessel(): Vessel | null {
  return useVessels.getState().active(useTeams.getState().activeTeamId)
}

/**
 * The crew's arrival setting as a route uses it — the same setting the Search
 * tab steers with, held to 100–200 ft (`routeArrivalFt`), and the cap for
 * every per-point radius the planner sets.
 */
function arrivalOpts(): ArrivalOptions {
  return { arrivalFt: routeArrivalFt(useTracker.getState().arrivalFt) }
}

function plannedForBoat(boat: Vessel): PlannedFor {
  return {
    safeDepthM: safeDepthM(boat),
    clearanceM: boat.clearance_m,
    speedKn: boat.cruise_speed_kn,
    shallowMarginM: shallowMarginOf(boat),
  }
}

/** The corridor a plan was made with (the default for a passage saved before there was one). */
function marginOf(p: PlannedFor | null): number {
  return p?.shallowMarginM ?? DEFAULT_SHALLOW_MARGIN_M
}

/** Does the boat now ask more of the route than the one it was planned for? */
function stricter(boat: Vessel | null, was: PlannedFor | null): boolean {
  if (!boat || !was) return true
  return (
    safeDepthM(boat) > was.safeDepthM + 1e-9 ||
    boat.clearance_m > was.clearanceM + 1e-9 ||
    shallowMarginOf(boat) > marginOf(was) + 1e-9
  )
}

function samePlannedFor(a: PlannedFor | null, b: PlannedFor): boolean {
  return (
    !!a &&
    Math.abs(a.safeDepthM - b.safeDepthM) < 1e-9 &&
    Math.abs(a.clearanceM - b.clearanceM) < 1e-9 &&
    Math.abs(marginOf(a) - marginOf(b)) < 1e-9 &&
    a.speedKn === b.speedKn
  )
}

/**
 * The live fix, if it is fresh enough to plan from; otherwise ask the
 * receiver for one. A route "from my location" planned from a fix a minute
 * old starts a minute's run behind the boat.
 */
async function freshFix(): Promise<Fix | null> {
  const t = useTracker.getState()
  if (t.fix && !isStale(t.fix)) return t.fix
  const got = await t.once()
  return got && !isStale(got) ? got : null
}

/** A promise that gives up after `ms` with `message`. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([p, limit]).finally(() => clearTimeout(timer))
}

const SLOW_CHART = 'The chart service did not answer in time'

/**
 * Let the screen paint before the router's long synchronous search — so
 * "Re-routing…" / "Finding a safe route…" is on screen before the phone
 * spends a second or more planning. A frame, then a task. Where there is no
 * frame to wait for (node, tests) it does not wait.
 */
function yieldToPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const go = () => {
      if (done) return
      done = true
      resolve()
    }
    requestAnimationFrame(() => setTimeout(go, 0))
    // A page in the background gets no frames at all; a re-route must not
    // wait for the crew to look at the phone again.
    setTimeout(go, 100)
  })
}

/**
 * Does a planning box this size leave the harbour band out of its main query?
 * Then the finest charts exist only where detail boxes are asked for, and a
 * long passage needs them all along its line, not just at the ends.
 */
function needsCorridor(box: ChartBounds): boolean {
  return !bandsForSpan(boundsSpanNM(padBounds(box))).some((b) => b.id === 'harbour')
}

/**
 * The chart loads kept for replaying after a reload: the first (the passage's
 * own box) and the most recent ones — a long session of re-routes must not
 * grow the persisted record without bound.
 */
function capLoads(loads: ChartLoadRecord[]): ChartLoadRecord[] {
  return loads.length <= 6 ? loads : [loads[0], ...loads.slice(-5)]
}

/** Bumped by every plan, `stop` and `clear`; a result from an older one is dropped. */
let seq = 0
/**
 * The saved or shared route on screen, while it is the preview: a re-plan
 * for a boat that arrives (or changes) after it was opened says so in its
 * own words, instead of dropping the note about where the route came from.
 */
let opened: { noun: string; name: string } | null = null

const INITIAL = {
  dest: null,
  origin: null,
  plan: null,
  routes: null as RouteOption[] | null,
  routeIdx: 0,
  shorterNote: null as string | null,
  status: 'idle' as NavStatus,
  targetIdx: null,
  error: null,
  rerouteError: null,
  confirmed: false,
  pendingPlan: null,
  reconfirm: false,
  plannedFor: null,
  chartLoads: [] as ChartLoadRecord[],
  ownerId: null,
  offCourseSince: null,
  lastPlannedAt: null,
  reroutes: 0,
  speedKn: null,
  gpsPoor: false,
  shallowHere: null,
  departure: null,
  rerouting: false,
  lastRerouteAt: null,
  lastFixAt: null,
  resume: false,
  roundIdx: null,
  roundAim: null,
  roundTurning: false,
  progressLog: [] as ProgressSample[],
  clearRun: 0,
  arriveSeen: false,
  gpsSlow: false,
  turnSlow: false,
  turnSlowAt: null,
  stillSince: null,
  guide: null,
  setEst: null,
  helm: null,
  rerouteLog: [] as number[],
  turnRec: null,
} satisfies Partial<NavigationState>

/** What survives a reload: the passage, not the moment-to-moment readings. */
export function partializeNav(s: NavigationState) {
  return {
    dest: s.dest,
    origin: s.origin,
    plan: s.plan,
    status: s.status,
    targetIdx: s.targetIdx,
    confirmed: s.confirmed,
    lastPlannedAt: s.lastPlannedAt,
    error: s.error,
    reconfirm: s.reconfirm,
    plannedFor: s.plannedFor,
    chartLoads: s.chartLoads,
    ownerId: s.ownerId,
    departure: s.departure,
  }
}
type PersistedNav = ReturnType<typeof partializeNav>

/**
 * localStorage, written only when something persisted changed.
 *
 * Every GPS fix sets the store (speed, target, off-course clock), and the
 * persist middleware writes the partialized state after every set — the whole
 * route, stringified and stored synchronously, once a second for the whole
 * passage, when almost always nothing that is persisted had moved. The fields
 * are compared by reference first, so an unchanged passage costs nothing.
 */
function navStorage(): PersistStorage<PersistedNav> | undefined {
  const json = createJSONStorage<PersistedNav>(() => localStorage)
  if (!json) return undefined
  let last: StorageValue<PersistedNav> | null = null
  const same = (a: PersistedNav, b: PersistedNav) =>
    (Object.keys(b) as (keyof PersistedNav)[]).every((k) => a[k] === b[k])
  return {
    getItem: (name) => json.getItem(name),
    setItem: (name, value) => {
      if (last && last.version === value.version && same(last.state, value.state)) return
      last = value
      return json.setItem(name, value)
    },
    removeItem: (name) => {
      last = null
      return json.removeItem(name)
    },
  }
}

/** A plan there is something to steer on: a line of at least one leg. */
function steerable(plan: RoutePlan): boolean {
  return plan.source !== 'none' && plan.points.length >= 2
}

function needsConfirm(plan: RoutePlan): boolean {
  return plan.needsConfirm || plan.source === 'best-effort'
}

/** "5 ft (1.5 m)" — for the store's own messages. */
function feet(m: number): string {
  const ft = m * M_TO_FEET
  return `${ft < 10 ? ft.toFixed(1).replace(/\.0$/, '') : Math.round(ft)} ft (${m.toFixed(1)} m)`
}

/**
 * A plan that could not be checked for the boat now being steered: every leg
 * flagged as not checked, needing confirmation. Used only when there is no
 * chart in memory to re-check it against.
 */
function unverifiedPlan(plan: RoutePlan, reason: string): RoutePlan {
  return {
    ...plan,
    legs: plan.legs.map((l) => ({
      ...l,
      caution: l.caution === 'off-chart-end' ? l.caution : 'unsafe-depth',
      unverified: true,
    })),
    source: 'best-effort',
    needsConfirm: true,
    confirmReason: reason,
  }
}

/** Has the harbour or approach chart been read round this position? */
function detailNear(p: LatLon): boolean {
  const near = detailBox(p, 0.5)
  const regions = useChartData.getState().regions ?? []
  return regions.some(
    (r) =>
      (r.bands.includes('harbour') || r.bands.includes('approach')) &&
      containsBounds(r.bounds, near),
  )
}

function metres(a: LatLon, b: LatLon): number {
  return haversineNM(a.lat, a.lon, b.lat, b.lon) * NM_TO_METERS
}

/** A chart replay after a reload is under way (see `restoreChart`). */
let restoring = false

/**
 * What the live checks measure against: the chart in memory, the route's own
 * ends (for the approach zones, as its legs were) and the boat it was
 * planned for.
 */
function liveRequest(plan: RoutePlan, was: PlannedFor): LiveChartRequest {
  const to = plan.points[plan.points.length - 1]
  const dep = useNavigation.getState().departure
  return {
    features: useChartData.getState().features,
    from: plan.points[0],
    to,
    safeDepthM: was.safeDepthM,
    clearanceM: was.clearanceM,
    approachM: APPROACH_M,
    ...(dep ? { approachZones: approachZonesFor(dep, to) } : {}),
  }
}

/**
 * The little a re-route may cross charted shallow-band water round the boat
 * itself, metres, when the boat is in deep enough water: room to leave a
 * channel's edge, not a new dock stretch (`RouteRequest.fromZoneM`). Where
 * the chart puts the boat in water too shallow for it, or the boat is still
 * within the approach stretch of the start or the destination, the full
 * approach (`APPROACH_M`).
 */
const REROUTE_START_ZONE_M = 30

/**
 * The approach zones for a plan: round the passage's departure and its
 * destination — never round wherever a re-route happens to start. (A boat
 * the chart puts in a shallow patch gets a way out as well:
 * `RouteRequest.fromShallowZoneM`.)
 */
function approachZonesFor(departure: LatLon, dest: LatLon): ApproachZone[] {
  return [
    { lat: departure.lat, lon: departure.lon, radiusM: APPROACH_M },
    { lat: dest.lat, lon: dest.lon, radiusM: APPROACH_M },
  ]
}

/**
 * The chart's verdict on steering on for point `idx` from the fix, with
 * `bufferM` added to the stand-off and the depth margin. Two lines must be
 * clear:
 *
 *   - the straight line from the fix to the point itself — the crew's rule:
 *     "round waypoint N first" holds until the direct line to the next point
 *     is safe;
 *   - the line the card actually has the boat steer — from the fix to the
 *     aim point on the leg (`steerCourse`), which differs from the first
 *     when the boat is off the line.
 *
 * Each is judged against the stretch of the planned leg it stands in for.
 * A route that meets the rules is held to them; a best-effort one to "no
 * worse than its own leg" (its own legs fail the rules, and its turns must
 * still be let go). Null with no chart (or no boat) to judge by.
 */
function steerVerdict(
  plan: RoutePlan,
  idx: number,
  fix: Fix,
  was: PlannedFor | null,
  bufferM: number,
): ShortcutVerdict | null {
  if (!was || idx < 1 || idx >= plan.points.length) return null
  const course = steerCourse(plan, idx, fix)
  if (!course) return null
  const a = plan.points[idx - 1]
  const b = plan.points[idx]
  const g = legGeometry(a, b, fix)
  const f = g.lengthM > 0 ? Math.min(1, Math.max(0, g.alongM / g.lengthM)) : 0
  const from = { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon) }
  const strict = !needsConfirm(plan)
  try {
    const req = liveRequest(plan, was)
    const direct = liveShortcut(req, fix, a, b, bufferM, strict)
    if (direct === 'unsafe') return 'unsafe'
    const steered =
      course.lookaheadM > 0 ? liveShortcut(req, fix, from, course.aim, bufferM, strict) : direct
    if (steered === 'unsafe') return 'unsafe'
    return direct ?? steered
  } catch {
    return null
  }
}

/**
 * Is turn point `turn` still one the boat is coming up to — within twice
 * its circle (400 ft at most), and not behind it (more than 100° off its
 * course over the ground, when that is known)? "Round waypoint N first"
 * only ever sends the boat to a mark it is about to reach; a mark behind it
 * is the off-course re-route's business, never a U-turn on the card.
 */
function turnAhead(plan: RoutePlan, turn: number, fix: Fix, opts: ArrivalOptions): boolean {
  const p = plan.points[turn]
  if (!p) return false
  const { safeFt } = arrivalRadiusFt(plan, turn, null, opts)
  const rangeFt = metres(fix, p) * M_TO_FEET
  if (rangeFt > Math.min(2 * safeFt, 2 * MAX_ARRIVAL_FT)) return false
  const cog = fix.heading
  if (cog == null || !Number.isFinite(cog) || rangeFt < 1) return true
  const brg = bearingDeg(fix.lat, fix.lon, p.lat, p.lon)
  return Math.abs(((brg - cog + 540) % 360) - 180) <= 100
}

/** Fractions of the leg out of a turn point tried as the rounding aim, furthest first. */
const ROUND_AIM_FRACTIONS = [0.8, 0.6, 0.4, 0.25, 0.12]
/** …and distances from the turn point, metres, for a long leg out. */
const ROUND_AIM_METRES = [60, 30, 15]

/**
 * Where to steer while rounding turn point `turn` for point `idx`: the
 * furthest point along the leg out of the turn point (turn → idx) that the
 * boat can reach on a straight line the chart clears — with the fix's error
 * added to every margin, as for the shortcut itself, and judged against the
 * stretch of that leg it stands in for (see below). Failing all of them,
 * null: the card steers for the turn point along the leg into it.
 *
 * Steering AT the turn point made the boat arrive there on the old course
 * and only then start to turn — at 25 kn, 40–60 m beyond it on the outside,
 * and on a dog-leg 15 m off a bank that was the bank. Aimed at the leg out,
 * the turn starts as soon as the boat switches (up to 200 ft short of the
 * point) and is done by the time it gets there. Without a chart to check
 * against, or on a poor fix: null, and the turn point as before.
 */
function aimRound(
  plan: RoutePlan,
  turn: number,
  idx: number,
  fix: Fix,
  was: PlannedFor | null,
  bufferM: number,
  speedKn: number | null,
  turnModel: TurnModel = ASSUMED_TURN,
): { aim: LatLon; turning: boolean } | null {
  const t = plan.points[turn]
  const b = plan.points[idx]
  if (!was || !t || !b) return null
  const len = metres(t, b)
  if (!(len > 3)) return null
  // On a poor fix the boat is steered round the turn point along the legs,
  // as before: a turn started early, or a line cut across to the leg out,
  // on a position good to ±20 m put the boat inside the corner by as much
  // (the simulated voyages ran into the stand-off beyond the turn).
  const acc = fix.accuracy != null && Number.isFinite(fix.accuracy) ? fix.accuracy : Infinity
  if (acc > AIM_RELAX_ACC_M) return null
  const early = turnEarly(plan, turn, idx, fix, was, speedKn, turnModel)
  if (early) return { aim: early, turning: true }
  const cands = [
    ...ROUND_AIM_FRACTIONS.map((f) => f * len),
    ...ROUND_AIM_METRES.filter((d) => d < 0.8 * len),
  ].sort((x, y) => y - x)
  let req: LiveChartRequest
  try {
    req = liveRequest(plan, was)
  } catch {
    return null
  }
  const plainM = fix.accuracy != null && Number.isFinite(fix.accuracy) ? fix.accuracy : 0
  for (const d of cands) {
    if (d < 3) continue
    const f = d / len
    const p = { lat: t.lat + f * (b.lat - t.lat), lon: t.lon + f * (b.lon - t.lon) }
    try {
      // Held to the rules — or, where the stretch of the leg out it stands
      // in for cannot itself meet them with the fix's error added (a leg
      // planned close along a bank), to no worse than that stretch, rule by
      // rule: the line to the leg is never allowed less water or less room
      // than the leg the boat would otherwise be put on at the turn point.
      if (aimClear(req, fix, t, p, bufferM, plainM)) return { aim: p, turning: false }
    } catch {
      return null
    }
  }
  // Nothing on the leg out is clear: the card steers for the turn point as
  // before — along the leg into it (`steerCourse`), not straight at it.
  return null
}

/**
 * How this boat turns: how long after the card changes the helm has the
 * boat turning (the card is read once a second, and a brisk helm answers it
 * half a second to a second later) and the rate it then turns at — assumed
 * (`ASSUMED_TURN`) until the boat shows otherwise (`updateTurnRate`).
 */
interface TurnModel {
  dps: number
  reactS: number
}
const ASSUMED_TURN: TurnModel = { dps: TURN_ASSUMED_DPS, reactS: TURN_ASSUMED_REACT_S }
/**
 * The rate a boat is assumed to turn at, degrees a second — a firm, not a
 * crash, turn — until it shows it turns slower (`turnRateDps`).
 */
const TURN_RATE_DPS = TURN_ASSUMED_DPS
/** Turns gentler than this need no leading, degrees; sharper than this are hairpins, rounded at the mark. */
const LEAD_MIN_DEG = 10
const LEAD_MAX_DEG = 120

/**
 * Speed-aware turn anticipation while rounding: a boat at speed cannot turn
 * at the mark. At `v` m/s, turning at `TURN_RATE_DPS`, its turning circle has
 * radius R = v / ω, and to come out of a turn of Δ onto the leg out — not
 * beyond it — the turn must start R·tan(Δ/2) short of the mark, plus the run
 * while the helm answers the card (`TURN_ASSUMED_REACT_S`, or what
 * the boat has shown — `TurnModel`). Within that of the turn
 * point the card steers for where that arc meets the leg out: "turn now".
 *
 * Only where the chart allows it: the arc a boat swings cuts inside the
 * corner, and must meet the route's rules (`turnArcFits`); where it does not
 * the boat is sent on to the mark as before. Returns the point on the leg
 * out to steer for (`turnPoint`), or null for no anticipation.
 */
function turnEarly(
  plan: RoutePlan,
  turn: number,
  idx: number,
  fix: Fix,
  was: PlannedFor,
  speedKn: number | null,
  turnModel: TurnModel = ASSUMED_TURN,
): LatLon | null {
  if (turn < 1) return null
  const a = plan.points[turn - 1]
  const t = plan.points[turn]
  const b = plan.points[idx]
  const v =
    fix.speed != null && Number.isFinite(fix.speed) && fix.speed > 0
      ? fix.speed
      : speedKn != null && Number.isFinite(speedKn)
        ? speedKn / MPS_TO_KNOTS
        : 0
  if (!(v > 1)) return null
  const cin = bearingDeg(a.lat, a.lon, t.lat, t.lon)
  const cout = bearingDeg(t.lat, t.lon, b.lat, b.lon)
  const delta = Math.abs(((cout - cin + 540) % 360) - 180)
  if (delta < LEAD_MIN_DEG || delta > LEAD_MAX_DEG) return null
  const inb = legGeometry(a, t, fix)
  const acc = fix.accuracy != null && Number.isFinite(fix.accuracy) ? fix.accuracy : 0
  // On the leg in (not somewhere else near the mark), and heading its way.
  if (Math.abs(inb.crossM) > Math.max(15, 1.5 * acc)) return null
  if (fix.heading != null && Number.isFinite(fix.heading)) {
    if (Math.abs(((fix.heading - cin + 540) % 360) - 180) > 60) return null
  }
  // Not for a boat already off the line on the inside of the turn: its arc
  // would cut the corner by that much more (on a dog-leg, straight into the
  // bank the second turn runs along). It is steered back onto the line and
  // round the mark instead — any overshoot is then to the outside.
  const turnBy = ((cout - cin + 540) % 360) - 180
  const inside = (turnBy >= 0 ? 1 : -1) * inb.crossM
  if (inside > Math.max(5, acc)) return null
  const toGo = inb.lengthM - inb.alongM
  const radius = v / ((turnModel.dps * Math.PI) / 180)
  const tangent = radius * Math.tan(((delta / 2) * Math.PI) / 180)
  const lead = v * turnModel.reactS + tangent
  if (toGo > lead) return null
  let req: LiveChartRequest
  try {
    req = liveRequest(plan, was)
  } catch {
    return null
  }
  // Only where the arc a boat at this speed swings — started where it must
  // be, `R·tan(Δ/2)` short of the mark, and cutting inside the corner by
  // `R(sec(Δ/2) − 1)` — meets the rules every planned leg meets. Where it
  // does not, the boat is sent on to the mark as before, and told to slow
  // down for the turn (`tooFastForTurn`).
  if (!turnArcFits(req, a, t, b, v, 0, turnModel.dps)) return null
  return turnPoint(plan, turn, idx, tangent)
}

/** The least distance along the leg out the boat is turned for, metres. */
const TURN_JOIN_MIN_M = 15

/**
 * Where a boat turning early for turn point `turn` is steered: the point on
 * the leg out where the arc it swings meets it, `tangentM` past the turn
 * point (`TURN_JOIN_MIN_M` at least, never past the next point). Steered for
 * that point rather than onto the leg out's course: a helm that turns harder
 * than assumed then closes the leg there, instead of running on parallel to
 * it, inside the corner.
 */
function turnPoint(plan: RoutePlan, turn: number, idx: number, tangentM: number): LatLon {
  const t = plan.points[turn]
  const b = plan.points[idx]
  const len = metres(t, b)
  const f = len > 0 ? Math.min(1, Math.max(tangentM, TURN_JOIN_MIN_M) / len) : 1
  return { lat: t.lat + f * (b.lat - t.lat), lon: t.lon + f * (b.lon - t.lon) }
}

/**
 * Points along the arc a boat at `from`, heading `heading`, swings through
 * turning `sweep` degrees (to starboard for `sign` 1, port for −1) on a
 * circle of `radius` metres — the start, three points on it, and the end.
 */
function arcFrom(
  from: LatLon,
  heading: number,
  sign: number,
  sweep: number,
  radius: number,
): LatLon[] {
  const steps = 4
  const out: LatLon[] = [from]
  const run = (radius * sweep * Math.PI) / 180 / steps
  const mLat = 111_320
  const mLon = 111_320 * Math.cos((from.lat * Math.PI) / 180)
  let lat = from.lat
  let lon = from.lon
  for (let k = 0; k < steps; k++) {
    const h = ((heading + sign * sweep * ((k + 0.5) / steps)) * Math.PI) / 180
    lat += (run * Math.cos(h)) / mLat
    lon += (run * Math.sin(h)) / mLon
    out.push({ lat, lon })
  }
  return out
}

/**
 * Above this claimed error, metres, the boat is not steered off the legs to
 * round a turn (no early turn, no line across to the leg out). With a ±20 m
 * fix, a line cut across the corner put the boat 20 m further in than the
 * fix showed — into the stand-off, on the simulated voyages.
 */
const AIM_RELAX_ACC_M = 10

/** May the boat steer from the fix straight for `p`, instead of via the turn point `t`? */
function aimClear(
  req: LiveChartRequest,
  fix: Fix,
  t: LatLon,
  p: LatLon,
  bufferM: number,
  accM: number,
): boolean {
  return livePathShortcut(req, fix, [t], p, bufferM, accM) === 'clear'
}

/** How long a crew is given to slow down before a tight turn, seconds. */
const SLOW_WARN_S = 8
/** The slowest a boat is asked to make a turn at, m/s — steerage way. */
const SLOW_TURN_MPS = 2

/**
 * Is the turn at point `idx` (the one the boat is steering for — or rounding)
 * too tight for the boat's speed? Within the run it takes to slow down before
 * the turn (`SLOW_WARN_S` plus the lead a turn needs), the arc a boat at this
 * speed swings to come off the leg in onto the leg out — starting where it
 * must start, `R·tan(Δ/2)` short of the mark, cutting inside the corner by
 * `R(sec(Δ/2) − 1)` — is checked against the rules every planned leg meets.
 * When it does not fit, and the arc at a crawl would, the card says so. On a
 * dog-leg 15 m off a bank at 25 kn, no course the card could give would have
 * kept the boat off the bank; slowing down would.
 */
function tooFastForTurn(
  plan: RoutePlan,
  idx: number,
  fix: Fix,
  was: PlannedFor | null,
  speedKn: number | null,
  turnModel: TurnModel = ASSUMED_TURN,
): number | null {
  // This turn, and the one after it when that is close behind (a dog-leg:
  // slowing for the second turn has to start before the first).
  if (tooFastAt(plan, idx, fix, was, speedKn, 0, turnModel)) return idx
  if (idx < 1 || idx + 1 >= plan.points.length) return null
  const g = legGeometry(plan.points[idx - 1], plan.points[idx], fix)
  const extra = Math.max(0, g.lengthM - g.alongM)
  return tooFastAt(plan, idx + 1, fix, was, speedKn, extra, turnModel) ? idx + 1 : null
}

/**
 * `tooFastForTurn` for the turn at point `idx`, the boat `beforeM` metres
 * short of the leg into it (0: on that leg).
 */
function tooFastAt(
  plan: RoutePlan,
  idx: number,
  fix: Fix,
  was: PlannedFor | null,
  speedKn: number | null,
  beforeM: number,
  turnModel: TurnModel = ASSUMED_TURN,
): boolean {
  if (!was || idx < 1 || idx + 1 >= plan.points.length) return false
  const made =
    fix.speed != null && Number.isFinite(fix.speed) && fix.speed > 0
      ? fix.speed
      : speedKn != null && Number.isFinite(speedKn)
        ? speedKn / MPS_TO_KNOTS
        : 0
  // Judged at the boat's cruise speed as well as the speed it is making: a
  // boat that has slowed for the first turn of a dog-leg is not told it may
  // speed up again into the second.
  const cruise = Number.isFinite(was.speedKn) && was.speedKn > 0 ? was.speedKn / MPS_TO_KNOTS : 0
  if (!(made > SLOW_TURN_MPS)) return false
  const v = Math.max(made, cruise)
  if (!(v > 2 * SLOW_TURN_MPS)) return false
  const a = plan.points[idx - 1]
  const t = plan.points[idx]
  const b = plan.points[idx + 1]
  const cin = bearingDeg(a.lat, a.lon, t.lat, t.lon)
  const cout = bearingDeg(t.lat, t.lon, b.lat, b.lon)
  const turnBy = ((cout - cin + 540) % 360) - 180
  const delta = Math.abs(turnBy)
  if (delta < 20 || delta > LEAD_MAX_DEG) return false
  const toGo =
    beforeM > 0 ? beforeM + metres(a, t) : (() => {
      const inb = legGeometry(a, t, fix)
      return inb.lengthM - inb.alongM
    })()
  const w = (turnModel.dps * Math.PI) / 180
  const lead = v * turnModel.reactS + (v / w) * Math.tan(((delta / 2) * Math.PI) / 180)
  if (toGo < -10 || toGo > lead + v * SLOW_WARN_S) return false
  // The planner found no room to turn here at cruise speed (`RoutePlan.slowTurns`).
  if (plan.slowTurns?.includes(idx)) return true
  let req: LiveChartRequest
  try {
    req = liveRequest(plan, was)
  } catch {
    return false
  }
  // With the room a helm needs: a turn started a fraction of a second late
  // (`TURN_SLACK_S` — the card is read once a second) swings the boat
  // v·δt·sin(Δ) further out, and at 25 kn on a dog-leg that is the bank.
  const slack = (speed: number) => speed * TURN_SLACK_S * Math.sin((delta * Math.PI) / 180)
  const slow = Math.max(SLOW_TURN_MPS, v / 3)
  const fits = turnArcFits(req, a, t, b, v, slack(v), turnModel.dps)
  if (!fits && turnArcFits(req, a, t, b, slow, slack(slow), turnModel.dps)) return true
  // And the plain geometry, whatever the arcs say: a boat that turns only
  // at the mark — the card switches at the crew's 100–200 ft circle, later
  // than a fast boat's turn must start, and a lost fix leaves it running
  // straight on — runs on past the turn point by its reaction and its
  // turning circle, R·sin Δ (R for a turn of 90° or more). Where the chart
  // puts land, a hazard or water too shallow within that of the turn point,
  // straight on, the boat is too fast for the turn. On a best-effort route
  // at 25 kn a 90° turn with the bank 42 m beyond it had no warning at all
  // — no arc met the route's rules, so none was tried (rc5 F3); at 28 kn a
  // 119° turn with a shoal 40 m beyond it was taken at full speed into a
  // GPS dropout (rc5 hc-67).
  const r = v / w
  const run = v * turnModel.reactS + r * (delta >= 90 ? 1 : Math.sin((delta * Math.PI) / 180))
  try {
    const ahead = liveRay(req, t, cin, run + TURN_ROOM_SLACK_M)
    if (ahead && (ahead.land || ahead.shallow)) return true
  } catch {
    return false
  }
  // And the arc itself, for a boat that turns slower than assumed: run on
  // past the turn point for the helm's reaction, then round at the rate it
  // has shown. A helm that answered the card four seconds late and turned
  // at 6°/s swung 100 m wide of a 73° turn at 22 kn, into water charted
  // 0 m that the straight line on past the turn point just missed (rc6,
  // sluggish helm). Water is "too shallow" here below the boat's need — or,
  // on a best-effort route, below the least the legs round the turn
  // themselves cross: the crew accepted that, not worse.
  // (Also for a boat that turns as assumed: the card switches at the crew's
  // 100–200 ft circle, and a boat sent on to the mark — "round waypoint N
  // first", a lost fix — turns only there. An 83° turn with 42 m of water
  // beyond it was taken at 40 kn with no warning at all: the straight line
  // on past the mark missed the shoal the arc ran onto (rc8 F2).)
  const floor = Math.min(
    was.safeDepthM,
    ...[plan.legs[idx - 1], plan.legs[idx]]
      // Outside the dock stretches, where the leg says so.
      .map((l) => (l && l.minDepthOutsideM !== undefined ? l.minDepthOutsideM : l?.minChartedDepthM))
      .filter((d): d is number => d != null && Number.isFinite(d)),
  )
  try {
    const mLat = 111_320
    const mLon = 111_320 * Math.cos((t.lat * Math.PI) / 180)
    const reactM = v * turnModel.reactS
    const th = (cin * Math.PI) / 180
    const p1 = { lat: t.lat + (reactM * Math.cos(th)) / mLat, lon: t.lon + (reactM * Math.sin(th)) / mLon }
    const path = [t, ...arcFrom(p1, cin, turnBy >= 0 ? 1 : -1, delta, r)]
    for (let i = 0; i + 1 < path.length; i++) {
      const q = path[i]
      const e = path[i + 1]
      const len = metres(q, e)
      if (!(len > 0.5)) continue
      const hit = liveRay(req, q, bearingDeg(q.lat, q.lon, e.lat, e.lon), len, floor)
      if (hit && (hit.land || hit.shallow)) return true
    }
  } catch {
    return false
  }
  return false
}

/** Room kept beyond a turn's run-on, metres (`tooFastAt`). */
const TURN_ROOM_SLACK_M = 5

/** How late a turn may start, seconds, that the water round it must allow for (`tooFastForTurn`). */
const TURN_SLACK_S = 1.0

/**
 * Does the arc a boat at `speed` m/s swings round turn point `t` — off the
 * leg a→t onto the leg t→b, turning at `TURN_RATE_DPS` and started
 * `R·tan(Δ/2)` short of `t` — meet the rules every planned leg meets? A
 * chart that cannot say counts as yes (nothing is claimed without one).
 */
function turnArcFits(
  req: LiveChartRequest,
  a: LatLon,
  t: LatLon,
  b: LatLon,
  speed: number,
  outsideM = 0,
  rateDps: number = TURN_RATE_DPS,
): boolean {
  const cin = bearingDeg(a.lat, a.lon, t.lat, t.lon)
  const cout = bearingDeg(t.lat, t.lon, b.lat, b.lon)
  const turnBy = ((cout - cin + 540) % 360) - 180
  const sign = turnBy >= 0 ? 1 : -1
  const delta = Math.abs(turnBy)
  const r = speed / ((rateDps * Math.PI) / 180)
  const back = r * Math.tan(((delta / 2) * Math.PI) / 180)
  const f = Math.max(0, 1 - back / Math.max(metres(a, t), 1e-6))
  const on = { lat: a.lat + f * (t.lat - a.lat), lon: a.lon + f * (t.lon - a.lon) }
  const starts = [on]
  if (outsideM > 0) {
    // The same arc, begun that much to the outside of the turn.
    const n = ((cin - sign * 90) * Math.PI) / 180
    starts.push({
      lat: on.lat + (outsideM * Math.cos(n)) / 111_320,
      lon: on.lon + (outsideM * Math.sin(n)) / (111_320 * Math.cos((on.lat * Math.PI) / 180)),
    })
  }
  try {
    for (const start of starts) {
      const arc = arcFrom(start, cin, sign, delta, r)
      for (let i = 0; i + 1 < arc.length; i++) {
        if (liveShortcut(req, arc[i], arc[i], arc[i + 1], 0, true) === 'unsafe') return false
      }
    }
  } catch {
    return true
  }
  return true
}

/** Has the boat run on beyond point `idx` along the leg into it? */
function pastPoint(plan: RoutePlan, idx: number, fix: Fix): boolean {
  if (idx < 1 || idx >= plan.points.length) return false
  const g = legGeometry(plan.points[idx - 1], plan.points[idx], fix)
  return g.lengthM > 0 && g.alongM > g.lengthM
}

/** Is `p` more than 100° off the boat's course over the ground (known)? */
function behind(p: LatLon | undefined, fix: Fix): boolean {
  if (!p || fix.heading == null || !Number.isFinite(fix.heading)) return false
  const brg = bearingDeg(fix.lat, fix.lon, p.lat, p.lon)
  return Math.abs(((brg - fix.heading + 540) % 360) - 180) > 100
}

function sameAim(a: LatLon, b: LatLon): boolean {
  return a.lat === b.lat && a.lon === b.lon
}

/**
 * The least time after the last automatic re-route before the next, ms,
 * given when the recent ones were made: `REROUTE_MIN_GAP_MS`, or — with
 * `REROUTE_MAX_IN_WINDOW` already in the last `REROUTE_WINDOW_MS` — until
 * the oldest of them is more than that window (and a second) behind.
 */
export function rerouteGapMs(log: readonly number[], now: number): number {
  const recent = log.filter((t) => now - t < REROUTE_WINDOW_MS + 1_000).sort((a, b) => a - b)
  if (recent.length < REROUTE_MAX_IN_WINDOW) return REROUTE_MIN_GAP_MS
  const last = recent[recent.length - 1]
  const oldest = recent[recent.length - REROUTE_MAX_IN_WINDOW]
  return Math.max(REROUTE_MIN_GAP_MS, oldest + REROUTE_WINDOW_MS + 1_000 - last)
}

/** How far along the course to steer its line is checked against the chart, metres (rc5 F8). */
const STEER_RAY_M = 100

/**
 * The lookahead to steer point `idx` with on this fix (`SteerOptions`), or
 * null for the speed's own (`speedLookaheadM`). The course that lookahead
 * gives is checked against the chart for `STEER_RAY_M` along it (or to just
 * past the point, when that is nearer): where it runs into land or a hazard,
 * the nearest lookahead — longer, a shallower intercept, or shorter, a
 * steeper one away from the bank — whose course does not is used instead.
 * A 45° intercept from the far side of a line laid 15 m off a bank pointed
 * the boat at the bank 30 m beyond the line (rc5 F8). With no chart, or no
 * clear course, the speed's own.
 */
function steerLookahead(
  plan: RoutePlan,
  idx: number,
  fix: Fix,
  was: PlannedFor | null,
  setDeg: number,
  factor = 1,
  hazardNear = false,
): number | null {
  if (idx < 1 || idx >= plan.points.length) return null
  const pref = speedLookaheadM(fix) * Math.max(1, factor)
  // The speed's own (null) unless the helm's swinging stretched it.
  const own = factor > 1.01 ? pref : null
  // Well off the checked line with shallows or land near: back onto it
  // sooner — a shorter lookahead first (never for a helm seen swinging
  // across the line, whose lookahead was stretched for that).
  const g = legGeometry(plan.points[idx - 1], plan.points[idx], fix)
  const hurry = hazardNear && factor <= 1.01 && Math.abs(g.crossM) >= HURRY_XTE_M
  const factors = hurry ? [0.67, 0.5, 1, 1.5, 2, 3, 5] : [1, 1.5, 0.67, 2, 0.5, 3, 5]
  if (!was) return own
  const target = plan.points[idx]
  const reach = Math.min(STEER_RAY_M, metres(fix, target) + 10)
  if (!(reach > 5)) return own
  let req: LiveChartRequest
  try {
    req = liveRequest(plan, was)
  } catch {
    return own
  }
  const tried = new Set<number>()
  for (const f of factors) {
    const want = Math.max(LOOKAHEAD_MIN_M, f * pref)
    const c = steerCourse(plan, idx, fix, { lookaheadM: want, setDeg })
    if (!c) return own
    const key = Math.round(c.lookaheadM)
    if (tried.has(key)) continue
    tried.add(key)
    let clear: boolean | null
    try {
      clear = liveRayClear(req, fix, c.bearingDeg, reach)
    } catch {
      return own
    }
    if (clear === null) return own
    if (clear) return f === 1 ? own : want
  }
  return own
}

/** Off the line by this much near shallows or land, the lookahead is shortened first (`steerLookahead`), metres. */
const HURRY_XTE_M = 8

/** Off the course to steer by more than this, degrees, the boat's own heading is checked ahead. */
const HEADING_OFF_DEG = 30
/** …for this many seconds of its run (40–250 m). */
const HEADING_AHEAD_S = 10
/** …and passing within this share of the stand-off of land counts as running into it. */
const HEADING_CLOSE_FRACTION = 0.5

/**
 * Is the boat — making way, its course over the ground well off the course
 * to steer (`HEADING_OFF_DEG`) — running into land, a hazard or water too
 * shallow for it within `HEADING_AHEAD_S` of its run? Then the card says
 * slow down and come round. A boat leaving the dock pointed the wrong way,
 * or a helm that answers slowly swinging wide of a turn, ran aground at
 * speed before it had come round to the card's course (rc5 sluggish helm).
 */
function dangerOnHeading(
  plan: RoutePlan,
  fix: Fix,
  was: PlannedFor | null,
  steerDeg: number | null,
): boolean {
  if (!was || steerDeg == null || fix.settling || fix.estimate) return false
  const v = fix.speed
  const cog = fix.heading
  if (v == null || !Number.isFinite(v) || v < 2 || cog == null || !Number.isFinite(cog)) return false
  if (Math.abs(((cog - steerDeg + 540) % 360) - 180) <= HEADING_OFF_DEG) return false
  const run = Math.min(250, Math.max(40, HEADING_AHEAD_S * v))
  try {
    // Into it, or within half the stand-off of land: a slow helm swinging
    // wide leaving the dock at 25 kn passed 3 m from the bank, on a line
    // that never touched it (rc6, sluggish helm).
    const r = liveRay(liveRequest(plan, was), fix, cog, run, null, HEADING_CLOSE_FRACTION * was.clearanceM)
    return !!r && (r.land || r.shallow || !!r.close)
  } catch {
    return false
  }
}

/**
 * Are charted shallows, land or a hazard within the boat's run of the fix —
 * 10 s of it, 50–150 m? If the fix is lost now, the card says "Slow down —
 * GPS lost" (`navCardView`). Assumed so when no chart can say.
 */
function hazardNearFix(plan: RoutePlan, fix: Fix, was: PlannedFor | null, speedKn: number | null): boolean {
  if (!was) return true
  const v =
    fix.speed != null && Number.isFinite(fix.speed) && fix.speed > 0
      ? fix.speed
      : speedKn != null && Number.isFinite(speedKn)
        ? speedKn / MPS_TO_KNOTS
        : 0
  const radius = Math.min(150, Math.max(50, 10 * v))
  try {
    const near = liveChartNear(liveRequest(plan, was), fix, radius)
    if (!near) return true
    return !!(near.here || near.near)
  } catch {
    return true
  }
}

/**
 * "Slow down — GPS not accurate enough here": the fix claims more error than
 * the boat's safety margin, AND the chart shows land, a hazard or water too
 * shallow for the boat within that error (its 95 % circle) of the line ahead — the next
 * half-minute's run (60–300 m) along the course the card gives and on round
 * the route's next turn. Away from the dock stretches at each end.
 */
function slowAhead(
  plan: RoutePlan,
  shown: number,
  fix: Fix,
  was: PlannedFor | null,
  speedKn: number | null,
): boolean {
  if (!was) return false
  const acc = fix.accuracy
  const margin = safetyMarginM(was.clearanceM)
  if (acc == null || !Number.isFinite(acc) || margin == null || !(acc > margin)) return false
  const first = plan.points[0]
  const last = plan.points[plan.points.length - 1]
  if (metres(fix, first) <= APPROACH_M || metres(fix, last) <= APPROACH_M) return false
  const course = steerCourse(plan, shown, fix)
  if (!course) return false
  const mps = speedKn != null && Number.isFinite(speedKn) ? speedKn / MPS_TO_KNOTS : 0
  const want = Math.min(300, Math.max(60, 30 * mps))
  // Along the course, then the route on from the point steered for — round
  // its turn — until the run is covered.
  const route = plan.points.slice(Math.min(Math.max(shown, 0), plan.points.length - 1))
  const pts: LatLon[] = [fix]
  let run = 0
  for (const next of [course.aim, ...route]) {
    const prev = pts[pts.length - 1]
    const d = metres(prev, next)
    if (d < 1) continue
    if (run + d >= want) {
      const f = (want - run) / d
      pts.push({ lat: prev.lat + f * (next.lat - prev.lat), lon: prev.lon + f * (next.lon - prev.lon) })
      run = want
      break
    }
    pts.push(next)
    run += d
  }
  if (pts.length < 2) return false
  try {
    // The 95 % circle, as for the line checks: the boat is outside the
    // 68 % one a third of the time.
    const ahead = liveAhead(liveRequest(plan, was), pts, LINE_BUFFER_ACC * acc)
    return !!ahead && (ahead.land || ahead.shallow)
  } catch {
    return false
  }
}

export const useNavigation = create<NavigationState>()(
  persist(
    (set, get) => {
      /**
       * The chart to plan on, and the loads that fetched it.
       *
       * A new plan loads the planning box with detail round both ends, and
       * — when the box is too big for the harbour band — a second time with
       * detail all along the first route found (`corridorPoints`), so the
       * middle of a long passage is planned on the finest chart too, and a
       * re-route from anywhere near the route finds it already in memory.
       *
       * A re-route (`live`) plans on what is in memory when that was read over
       * the whole of the new box; after a reload it first replays the
       * passage's own loads (the same queries, which the device's cache can
       * answer with no signal); only then does it go to the network, and if
       * that fails it still plans on whatever chart is in memory.
       */
      async function chartFor(
        from: LatLon,
        to: LatLon,
        live: boolean,
        my: number,
      ): Promise<{ features: ChartFeatures; loads: ChartLoadRecord[]; fromMemory: boolean } | null> {
        const box = planningBounds(from, to)
        const detailAround = [from, to]
        // One time limit for the whole attempt, however many loads it takes.
        const deadline = Date.now() + (live ? LIVE_CHART_TIMEOUT_MS : PLAN_CHART_TIMEOUT_MS)
        const chart = () => useChartData.getState()
        const load = (b: ChartBounds, d: LatLon[]) =>
          withTimeout(
            chart().load(b, { detailAround: d }),
            Math.max(0, deadline - Date.now()),
            SLOW_CHART,
          )

        if (live) {
          const mem = chart()
          if (mem.covers(box, { detailAround }) || mem.holds(box)) {
            return { features: mem.features, loads: get().chartLoads, fromMemory: true }
          }
          const replay = get().chartLoads
          if (replay.length > 0 && mem.features.coverage === 'none') {
            for (const l of replay) {
              try {
                await load(l.bounds, l.detailAround)
              } catch {
                break
              }
              if (seq !== my) return null
            }
            if (chart().holds(box)) {
              return { features: chart().features, loads: replay, fromMemory: true }
            }
          }
          let fresh: ChartFeatures | null = null
          let failure: unknown = null
          try {
            fresh = await load(box, detailAround)
          } catch (e) {
            failure = e
          }
          if (seq !== my) return null
          if (fresh && fresh.coverage !== 'none') {
            return {
              features: fresh,
              loads: [...get().chartLoads, { bounds: box, detailAround }],
              fromMemory: false,
            }
          }
          // The download failed. Whatever chart is in memory is still a
          // chart: plan on it rather than not at all.
          const held = chart().features
          if (held.coverage !== 'none') {
            return { features: held, loads: get().chartLoads, fromMemory: true }
          }
          if (failure) throw failure
          return { features: fresh ?? held, loads: get().chartLoads, fromMemory: false }
        }

        const features = await load(box, detailAround)
        return { features, loads: [{ bounds: box, detailAround }], fromMemory: false }
      }

      /** The error to raise when the chart could not be read at all. */
      function chartError(features: ChartFeatures): Error | null {
        const chart = useChartData.getState()
        if (features.coverage !== 'none' || !chart.error) return null
        return new Error(
          `Could not read the chart for this area — ${chart.error}. Check your signal and try again.`,
        )
      }

      /**
       * A boat made stricter mid-passage, and no new plan could be made for
       * it: re-check the route being steered against the chart for the new
       * boat. Still sound → keep steering it. Not → back to the preview,
       * flagged, for confirmation. Never carry on steering a route checked
       * only for a shallower boat as if nothing had changed.
       */
      function boatFallback(boat: Vessel | null, why: string): void {
        const s = get()
        const cur = s.plan
        if (!cur || !steerable(cur)) return
        const nowFor = boat ? plannedForBoat(boat) : null
        const checked =
          nowFor != null
            ? recheckPlan(cur, {
                safeDepthM: nowFor.safeDepthM,
                clearanceM: nowFor.clearanceM,
                shallowMarginM: marginOf(nowFor),
                features: useChartData.getState().features,
                arrivalFt: arrivalOpts().arrivalFt,
              })
            : null
        if (checked && checked.source === 'charted' && nowFor) {
          set({
            plan: checked,
            plannedFor: nowFor,
            rerouting: false,
            rerouteError: null,
          })
          return
        }
        const was = s.plannedFor
        const needs = was
          ? `a boat needing ${feet(was.safeDepthM)} of water and a ${feet(was.clearanceM)} stand-off`
          : 'a different boat'
        const message =
          `This route was planned for ${needs}, and could not be re-planned for the new boat settings (${why}). ` +
          (checked
            ? 'The legs it no longer suits are red — read them and confirm before steering it.'
            : 'It has not been checked for them — read it and confirm before steering it.')
        seq++ // a plan in flight belongs to the old settings
        set({
          plan: checked ?? unverifiedPlan(cur, message),
          plannedFor: nowFor ?? s.plannedFor,
          status: 'preview',
          targetIdx: null,
          confirmed: false,
          pendingPlan: null,
          reconfirm: true,
          rerouting: false,
          rerouteError: null,
          offCourseSince: null,
          resume: false,
          shallowHere: null,
          roundIdx: null,
          roundAim: null,
          roundTurning: false,
          progressLog: [],
          error: message,
        })
      }

      /**
       * The shorter ways that bend a rule, worked out after the route is on
       * screen (it is never held up for them) on the same chart, and offered
       * beside it. A relaxed search that found a way keeping every rule
       * shorter than the plan's replaces the plan outright in a preview —
       * that is not an alternative, it is the route.
       */
      async function findAlternates(
        my: number,
        req: Parameters<typeof planAlternatives>[0],
        main: RoutePlan,
      ): Promise<void> {
        try {
          await yieldToPaint()
          if (seq !== my || get().plan !== main) return
          const alts = planAlternatives(req, main)
          if (seq !== my || get().plan !== main) return
          let base = main
          if (alts.betterMain && get().status === 'preview') {
            base = alts.betterMain
          }
          const routes: RouteOption[] = [
            { plan: base, reasons: [], label: '', shorterNM: 0 },
            ...alts.alternates
              .filter((a) => a.plan.totalNM < base.totalNM)
              .map((a) => ({
                plan: a.plan,
                reasons: a.reasons,
                label: a.label,
                shorterNM: base.totalNM - a.plan.totalNM,
              })),
          ]
          set({
            ...(base !== main ? { plan: base } : {}),
            routes: routes.length > 1 ? routes : null,
            routeIdx: 0,
            shorterNote: alts.shorterNote,
          })
        } catch {
          // Alternatives are an offer; the route stands without them.
        }
      }

      /**
       * Plan (or re-plan) to the destination.
       *
       * Two modes. Steering, for anything but a new destination or start
       * (`live`): plan from the live fix, keep steering the current route
       * until the new one is in, and never drop the crew onto a blank card
       * if the re-plan fails. Otherwise: a fresh preview, the old route
       * cleared at once so it cannot be mistaken for the new one.
       *
       * `notice` is shown with a successful preview (why it was re-planned).
       */
      async function runPlan(
        reason: ReplanReason,
        liveFix?: Fix | null,
        notice?: string,
      ): Promise<void> {
        const s = get()
        if (!s.dest) return
        const dest = s.dest
        const live = s.status === 'navigating' && reason !== 'user'
        if (reason === 'user' && notice == null) opened = null
        if (reason === 'boat' && !live && notice == null && opened) {
          const name = activeVessel()?.name?.trim() || 'your boat'
          notice = `${opened.noun} “${opened.name}” re-planned for ${name}.`
        }
        const my = ++seq
        const now = Date.now()

        if (live) {
          set({
            rerouting: true,
            ...(reason === 'reroute'
              ? {
                  lastRerouteAt: now,
                  reroutes: s.reroutes + 1,
                  rerouteLog: [...s.rerouteLog.filter((t) => now - t < REROUTE_WINDOW_MS + 1_000), now],
                }
              : {}),
          })
        } else {
          set({
            status: 'planning',
            plan: null,
            routes: null,
            routeIdx: 0,
            shorterNote: null,
            targetIdx: null,
            confirmed: false,
            pendingPlan: null,
            reconfirm: false,
            error: null,
            rerouteError: null,
            offCourseSince: null,
            rerouting: false,
            resume: false,
            shallowHere: null,
          })
        }

        let boat: Vessel | null = null
        try {
          boat = activeVessel()
          if (!boat) {
            throw new Error(
              'Set up your boat first — its draft and stand-off are what keep the route safe.',
            )
          }

          let from: LatLon
          if (!live && s.origin) {
            from = { lat: s.origin.lat, lon: s.origin.lon }
          } else {
            const fix = liveFix && !isStale(liveFix) ? liveFix : await freshFix()
            if (seq !== my) return
            if (!fix) {
              throw new Error(
                useTracker.getState().error ??
                  'No GPS position yet. Wait for a fix, or choose a start point on the chart.',
              )
            }
            from = { lat: fix.lat, lon: fix.lon }
          }
          const to = { lat: dest.lat, lon: dest.lon }

          const got = await chartFor(from, to, live, my)
          if (seq !== my || !got) return
          const { features, fromMemory } = got
          let loads = got.loads
          const bad = chartError(features)
          if (bad) throw bad

          const forBoat = plannedForBoat(boat)
          // A re-route keeps the passage's own approach zones; a new plan
          // sets out from here.
          const departure = live && s.departure ? s.departure : from
          if (!live) set({ departure: from })
          const zones = live && s.departure ? approachZonesFor(departure, to) : undefined
          // Still in the dock stretch at either end: the boat has not left
          // the start (or has reached the end), and its re-route is planned
          // like one from there — the full approach round it.
          const inEndZone =
            live && s.departure
              ? metres(from, departure) <= APPROACH_M || metres(from, to) <= APPROACH_M
              : false
          const request = (f: ChartFeatures) => ({
            from,
            to,
            safeDepthM: forBoat.safeDepthM,
            clearanceM: forBoat.clearanceM,
            shallowMarginM: marginOf(forBoat),
            speedKn: forBoat.speedKn,
            features: f,
            arrivalFt: arrivalOpts().arrivalFt,
            ...(zones
              ? {
                  approachZones: zones,
                  fromShallowZoneM: APPROACH_M,
                  fromZoneM: inEndZone ? APPROACH_M : REROUTE_START_ZONE_M,
                }
              : {}),
          })

          // Paint "Re-routing…" / "Finding a safe route…" before the search.
          await yieldToPaint()
          if (seq !== my) return
          let plan = planRoute(request(features))
          // The chart the plan in hand was made on — the alternatives are
          // worked out on the same one.
          let planFeatures = features

          // A long passage: read the finest charts all along the route found
          // (or the direct line, when none was), and plan again on them. A
          // re-route that had to download its chart afresh does the same; one
          // planned on the chart in memory already has the passage's corridor.
          const box = planningBounds(from, to)
          if (needsCorridor(box) && (!live || !fromMemory)) {
            const along = corridorPoints(steerable(plan) ? plan.points : [from, to])
            const detailAround = [from, to, ...along]
            try {
              const more = await withTimeout(
                useChartData.getState().load(box, { detailAround }),
                live ? LIVE_CHART_TIMEOUT_MS : PLAN_CHART_TIMEOUT_MS,
                SLOW_CHART,
              )
              if (seq !== my) return
              if (more.coverage !== 'none') {
                await yieldToPaint()
                if (seq !== my) return
                const second = planRoute(request(more))
                const rank = (p: RoutePlan) =>
                  p.source === 'charted' ? 2 : steerable(p) ? 1 : 0
                if (rank(second) >= rank(plan)) {
                  plan = second
                  planFeatures = more
                }
                loads = [...loads, { bounds: box, detailAround }]
              }
            } catch {
              // The first plan stands; the chart it was made on is what the
              // crew is told about in its warnings.
            }
          }
          // A live re-route whose own box came back coarse (the boat far from
          // the loaded corridor) gets one fresh read when there is a signal.
          if (
            live &&
            fromMemory &&
            plan.source !== 'charted' &&
            typeof navigator !== 'undefined' &&
            navigator.onLine !== false &&
            !useChartData.getState().covers(box, { detailAround: [from, to] })
          ) {
            try {
              const more = await withTimeout(
                useChartData.getState().load(box, { detailAround: [from, to] }),
                LIVE_CHART_TIMEOUT_MS,
                SLOW_CHART,
              )
              if (seq !== my) return
              if (more.coverage !== 'none') {
                const second = planRoute(request(more))
                if (second.source === 'charted' || (steerable(second) && !steerable(plan))) {
                  plan = second
                  planFeatures = more
                  loads = [...loads, { bounds: box, detailAround: [from, to] }]
                }
              }
            } catch {
              // Keep what was planned on the chart in memory.
            }
          }
          // Still not a route that keeps every rule: a compliant way round
          // may lie just outside the planning box. Read the chart over the
          // wider box the planner searches before bending a rule
          // (`widePlanningBounds` — it searches as far as the chart it is
          // given reaches) and plan again. Once per new plan; a re-route
          // underway keeps to the chart it has (and its own coarse-chart
          // re-read above), and one that comes back best-effort waits for
          // the crew anyway.
          if (
            plan.source !== 'charted' &&
            !live &&
            (typeof navigator === 'undefined' || navigator.onLine !== false)
          ) {
            const wide = widePlanningBounds(from, to)
            try {
              const more = await withTimeout(
                useChartData.getState().load(wide, { detailAround: [from, to] }),
                live ? LIVE_CHART_TIMEOUT_MS : PLAN_CHART_TIMEOUT_MS,
                SLOW_CHART,
              )
              if (seq !== my) return
              if (more.coverage !== 'none') {
                await yieldToPaint()
                if (seq !== my) return
                const second = planRoute(request(more))
                if (second.source === 'charted' || (steerable(second) && !steerable(plan))) {
                  plan = second
                  planFeatures = more
                  loads = [...loads, { bounds: wide, detailAround: [from, to] }]
                }
              }
            } catch {
              // The plan made on the planning box stands.
            }
          }
          if (seq !== my) return
          const done = Date.now()
          if (live && fromMemory && steerable(plan) && !detailNear(from)) {
            // Planned on the chart already on the phone, and it holds only
            // the coarser charts round here: say so, rather than pass it off
            // as the harbour-scale route the passage was planned on.
            plan = {
              ...plan,
              warnings: [
                'Re-routed on the chart already on this phone — there was no signal to download ' +
                  'more. The finest (harbour) chart was not loaded round your position, so detail ' +
                  'near you may be missing: check the first legs against the chart.',
                ...plan.warnings,
              ],
            }
          }

          if (live) {
            const boatStricter = reason === 'boat' && stricter(boat, get().plannedFor)
            if (!steerable(plan)) {
              if (boatStricter) {
                boatFallback(boat, plan.failure ?? 'no water path found')
                return
              }
              if (reason === 'boat') {
                // No stricter than the boat it was planned for (a speed
                // change, a shallower draft): the current route still holds.
                set({ rerouting: false })
                return
              }
              // Keep steering what we have; it was safe when it was made.
              set({
                rerouting: false,
                rerouteError: `Could not re-route from here: ${plan.failure ?? 'no water path found'}`,
              })
              return
            }
            if (needsConfirm(plan)) {
              if (boatStricter) {
                // The route being steered was checked for the old boat; the
                // new one's route needs reading before anything is steered.
                set({
                  plan,
                  plannedFor: forBoat,
                  chartLoads: capLoads(loads),
                  origin: null,
                  status: 'preview',
                  targetIdx: null,
                  confirmed: false,
                  pendingPlan: null,
                  reconfirm: true,
                  rerouting: false,
                  rerouteError: null,
                  offCourseSince: null,
                  resume: false,
                  roundIdx: null,
                  roundAim: null,
                  roundTurning: false,
                  progressLog: [],
                  lastPlannedAt: done,
                  error:
                    'Re-planned for the new boat settings, but no fully safe route was found from here. ' +
                    'Steering is paused — read the flagged legs and confirm before steering it.',
                })
                return
              }
              if (reason === 'boat') {
                // No stricter than before: the route being steered still
                // holds for this boat. Nothing to confirm.
                set({ rerouting: false })
                return
              }
              // A re-route: keep steering the route the crew accepted, and
              // hold this one for them to read.
              set({
                pendingPlan: plan,
                rerouting: false,
                offCourseSince: null,
                rerouteError: null,
              })
              return
            }
            const fixNow = liveFix ?? useTracker.getState().fix
            set({
              plan,
              plannedFor: forBoat,
              chartLoads: capLoads(loads),
              origin: null,
              targetIdx: startTarget(plan, fixNow, arrivalOpts()),
              roundIdx: null,
              roundAim: null,
              roundTurning: false,
              clearRun: 0,
              arriveSeen: false,
              progressLog: [],
              pendingPlan: null,
              rerouting: false,
              rerouteError: null,
              offCourseSince: null,
              resume: false,
              lastPlannedAt: done,
              error: null,
              routes: null,
              routeIdx: 0,
              shorterNote: null,
            })
            // Offered, never switched to: the boat keeps steering this one.
            void findAlternates(my, request(planFeatures), plan)
            return
          }

          if (!steerable(plan)) {
            set({
              plan,
              plannedFor: forBoat,
              chartLoads: capLoads(loads),
              status: 'failed',
              error: plan.failure ?? 'No route could be found to this destination.',
              lastPlannedAt: done,
            })
            return
          }
          set({
            plan,
            plannedFor: forBoat,
            chartLoads: capLoads(loads),
            status: 'preview',
            error: notice ?? null,
            lastPlannedAt: done,
          })
          void findAlternates(my, request(planFeatures), plan)
        } catch (e) {
          if (seq !== my) return
          const message = e instanceof Error ? e.message : describeError(e)
          if (live) {
            if (reason === 'boat') {
              if (stricter(boat, get().plannedFor)) boatFallback(boat, message)
              // No stricter: the current route still holds for this boat.
              else set({ rerouting: false })
              return
            }
            set({ rerouting: false, rerouteError: `Could not re-route: ${message}` })
          } else {
            set({ status: 'failed', plan: null, error: message })
          }
        }
      }

      return {
        ...INITIAL,

        setDestination: (place, origin) => {
          set({
            dest: { lat: place.lat, lon: place.lon, label: place.label },
            ...(origin !== undefined ? { origin } : {}),
          })
          return runPlan('user')
        },

        setOrigin: async (place) => {
          set({ origin: place })
          if (get().dest) await runPlan('user')
        },

        replan: async (reason) => {
          const { status, dest, plan, plannedFor } = get()
          if (!dest) return
          // Nothing to re-plan once there: a boat edited at the dock after
          // arriving should not throw a new route onto the "arrived" card.
          if (status === 'arrived' || status === 'idle') {
            if (reason !== 'user' && reason !== 'retry') return
          }
          // A "boat change" that changes nothing the plan was made for — the
          // same boat seen again after a team list reloads, a sync writing
          // the same row back — is not a reason to re-plan mid-passage.
          if (reason === 'boat' && plan && steerable(plan)) {
            const boat = activeVessel()
            if (boat && samePlannedFor(plannedFor, plannedForBoat(boat))) return
          }
          await runPlan(reason)
        },

        start: () => {
          const s = get()
          const plan = s.plan
          if (!plan || !steerable(plan)) {
            set({ error: 'There is no route to steer yet.' })
            return false
          }
          if (s.status === 'planning') return false
          if (needsConfirm(plan) && !s.confirmed) {
            set({
              error:
                'This route is not fully safe. Read the flagged legs and confirm before steering it.',
            })
            return false
          }
          if (s.status === 'navigating') return true
          const tracker = useTracker.getState()
          const fix = tracker.fix && !isStale(tracker.fix) ? tracker.fix : null
          const targetIdx = startTarget(plan, fix, arrivalOpts())
          if (s.origin !== null && fix && targetIdx === 0) {
            // Away from a start chosen by hand, and not on the route: the
            // only way to "the start" would be a straight bearing nobody has
            // checked against the chart. Re-plan from where the boat is.
            set({ origin: null })
            void runPlan(
              'user',
              fix,
              'You are not at the planned start, so the route has been re-planned from where you are. ' +
                'Check it, then press Start.',
            )
            if (!tracker.watching) tracker.start()
            return false
          }
          set({
            status: 'navigating',
            targetIdx,
            resume: fix == null,
            error: null,
            rerouteError: null,
            pendingPlan: null,
            reconfirm: false,
            offCourseSince: null,
            speedKn: null,
            lastFixAt: null,
            gpsPoor: false,
            shallowHere: null,
            rerouting: false,
            reroutes: 0,
            lastRerouteAt: null,
            roundIdx: null,
            roundAim: null,
            roundTurning: false,
            clearRun: 0,
            arriveSeen: false,
            gpsSlow: false,
            turnSlow: false,
            turnSlowAt: null,
            guide: null,
            rerouteLog: [],
            turnRec: null,
            stillSince: null,
            progressLog: [],
          })
          if (!tracker.watching) tracker.start()
          return true
        },

        confirmBestEffort: () => {
          const { plan } = get()
          if (!plan || !steerable(plan) || !needsConfirm(plan)) return
          set({ confirmed: true, error: null, reconfirm: false })
        },

        openRoute: async ({ plan, dest, origin, name, noun = 'Saved route' }) => {
          const my = ++seq
          opened = { noun, name }
          set({
            dest: { lat: dest.lat, lon: dest.lon, label: dest.label },
            origin: { lat: origin.lat, lon: origin.lon, label: origin.label },
            status: 'planning',
            plan: null,
            routes: null,
            routeIdx: 0,
            shorterNote: null,
            targetIdx: null,
            confirmed: false,
            pendingPlan: null,
            reconfirm: false,
            error: null,
            rerouteError: null,
          })
          const boat = activeVessel()
          const boatName = boat?.name?.trim() || 'your boat'
          const replanned = (why: string) => {
            if (seq !== my) return
            void runPlan('user', undefined, `${noun} “${name}” re-planned for ${boatName} — ${why}.`)
          }
          try {
            if (!boat) {
              replanned('no boat is selected to check it against')
              return
            }
            if (plan.points.length < 2) {
              replanned('it has no route to check')
              return
            }
            const from = plan.points[0]
            const to = plan.points[plan.points.length - 1]
            const got = await chartFor(from, to, false, my)
            if (seq !== my) return
            if (!got || got.features.coverage === 'none') {
              replanned('no chart could be read to check the old route')
              return
            }
            const forBoat = plannedForBoat(boat)
            const checked = recheckPlan(plan, {
              safeDepthM: forBoat.safeDepthM,
              clearanceM: forBoat.clearanceM,
              shallowMarginM: marginOf(forBoat),
              features: got.features,
              arrivalFt: arrivalOpts().arrivalFt,
            })
            if (!checked) {
              replanned('the old route could not be checked against the chart')
              return
            }
            if (checked.source === 'charted') {
              set({
                plan: checked,
                plannedFor: forBoat,
                chartLoads: capLoads(got.loads),
                status: 'preview',
                departure: from,
                lastPlannedAt: Date.now(),
                error: `${noun} “${name}” re-checked for ${boatName}: it keeps your depth and stand-off.`,
              })
              return
            }
            // Say what the old route does wrong for this boat, in its own words.
            const worst = checked.legs.reduce<number | null>(
              (m, l) =>
                l.caution === 'unsafe-depth' && l.minChartedDepthM != null
                  ? Math.min(m ?? Infinity, l.minChartedDepthM)
                  : m,
              null,
            )
            replanned(
              worst != null
                ? `the old route crosses ${feet(Math.max(0, worst)).replace(/ \(.*\)$/, '')}`
                : 'the old route does not keep your stand-off',
            )
          } catch (e) {
            if (seq !== my) return
            set({ status: 'failed', error: e instanceof Error ? e.message : describeError(e) })
          }
        },

        selectRoute: (i) => {
          const s = get()
          if (s.status !== 'preview' || !s.routes || i < 0 || i >= s.routes.length) return
          if (i === s.routeIdx) return
          set({
            plan: s.routes[i].plan,
            routeIdx: i,
            // Read again for this route: an "I understand" given for one
            // route is not given for another.
            confirmed: false,
            reconfirm: false,
            error: null,
          })
        },

        acceptPendingPlan: () => {
          const s = get()
          const pending = s.pendingPlan
          if (!pending || s.status !== 'navigating') return
          const boat = activeVessel()
          seq++
          // As Start does: from where the boat is NOW. The crew took a few
          // seconds to read the route, and its start — the fix the re-route
          // was planned from — is behind the boat by then. Steering to it
          // pointed the boat back along a line nobody had checked; the far
          // end of the leg the boat is on (or nearest) is where it goes on.
          const fix = useTracker.getState().fix
          const live = fix && !isStale(fix) ? fix : null
          const begin = startTarget(pending, live, arrivalOpts())
          set({
            plan: pending,
            pendingPlan: null,
            confirmed: true,
            origin: null,
            plannedFor: boat ? plannedForBoat(boat) : s.plannedFor,
            targetIdx: begin === 0 ? joinTarget(pending, live) : begin,
            resume: false,
            roundIdx: null,
            roundAim: null,
            roundTurning: false,
            clearRun: 0,
            arriveSeen: false,
            progressLog: [],
            offCourseSince: null,
            rerouteError: null,
            error: null,
            lastPlannedAt: Date.now(),
          })
        },

        dismissPendingPlan: () => {
          if (get().pendingPlan) set({ pendingPlan: null })
        },

        setArrivalCap: (ft) => {
          const s = get()
          const plan = s.plan
          if (!plan || !steerable(plan)) return
          const req = routeArrivalFt(ft)
          const boat = activeVessel()
          const was = s.plannedFor ?? (boat ? plannedForBoat(boat) : null)
          const radii = was
            ? recomputeArrivalRadii(
                plan,
                {
                  safeDepthM: was.safeDepthM,
                  clearanceM: was.clearanceM,
                  features: useChartData.getState().features,
                },
                req,
              )
            : null
          // No chart to measure against: a smaller setting still shrinks
          // every circle at once; a larger one keeps the checked radii.
          const next =
            radii && radii.length === plan.points.length
              ? radii
              : plan.arrivalFt.map((r) => Math.min(r, req))
          if (next.length === plan.arrivalFt.length && next.every((r, i) => r === plan.arrivalFt[i])) {
            return
          }
          set({ plan: { ...plan, arrivalFt: next } })
        },

        stop: () => {
          const { status, plan } = get()
          if (status !== 'navigating' && status !== 'arrived') return
          // A re-route still in flight belongs to the passage being ended.
          seq++
          if (status === 'arrived') {
            // The passage is over. Putting the completed route back up as a
            // fresh preview — "From: My location", a Start button — invited a
            // crew at the destination to start it again from the far end.
            set({ ...INITIAL, ownerId: get().ownerId })
            return
          }
          set({
            status: plan && steerable(plan) ? 'preview' : 'idle',
            targetIdx: null,
            offCourseSince: null,
            rerouting: false,
            resume: false,
            gpsPoor: false,
            shallowHere: null,
            pendingPlan: null,
            reconfirm: false,
            error: null,
            rerouteError: null,
            roundIdx: null,
            roundAim: null,
            roundTurning: false,
            clearRun: 0,
            arriveSeen: false,
            gpsSlow: false,
            turnSlow: false,
            turnSlowAt: null,
            guide: null,
            rerouteLog: [],
            turnRec: null,
            progressLog: [],
          })
        },

        clear: () => {
          seq++
          opened = null
          set({ ...INITIAL, ownerId: get().ownerId })
        },

        reset: () => {
          seq++
          opened = null
          set({ ...INITIAL })
        },

        bindOwner: (uid) => {
          const owner = get().ownerId
          if (owner && owner !== uid) {
            // Another account's passage — its destination, its route, the
            // names of its waypoints — is not this crew's to see or steer.
            seq++
            set({ ...INITIAL, ownerId: uid })
            return
          }
          if (owner !== uid) set({ ownerId: uid })
        },

        onFix: (fix) => {
          const s = get()
          const plan = s.plan
          if (s.status !== 'navigating' || !plan || !steerable(plan)) return
          const now = Date.now()
          // A frozen fix is not where the boat is. Nothing advances on it;
          // the card greys itself out from the same test.
          if (isStale(fix, now)) return
          if (s.lastFixAt != null && fix.timestamp < s.lastFixAt) return

          const dtS = s.lastFixAt != null ? (fix.timestamp - s.lastFixAt) / 1000 : 1
          // The filter reads a boat making way as stopped when it cannot
          // tell the speed from its own noise, for a fix or two: that 0 is
          // left out of the smoothed speed until it has lasted.
          const still = fix.speed === 0
          const stillSince = still ? (s.stillSince ?? now) : null
          const dropout =
            still &&
            s.speedKn != null &&
            s.speedKn >= MIN_SOG_KN &&
            now - (stillSince as number) < STILL_HOLD_MS
          const speedKn = dropout ? s.speedKn : smoothSpeedKn(s.speedKn, fix, dtS)
          const opts = arrivalOpts()
          // A position the filter has only just jumped to (it believed the
          // receiver after refusing a run of fixes) is shown, but nothing is
          // switched, recovered or arrived on it until it is borne out.
          const settling = fix.settling === true

          const resuming = s.resume || s.targetIdx == null
          const from = resuming ? startTarget(plan, fix, opts) : (s.targetIdx as number)
          // A turn point switched away from but not yet rounded — see below.
          const rounding = resuming ? null : s.roundIdx
          const step = stepTarget(plan, from, fix, opts)
          const base = {
            speedKn,
            stillSince,
            gpsPoor: step.gpsPoor,
            lastFixAt: fix.timestamp,
            resume: false,
          }

          // Arrived: inside the destination's circle by at least the fix's
          // own claimed error — or inside it on two fixes running. One fix
          // just inside a 200 ft circle, on a receiver claiming ±60 ft, was
          // a boat anywhere up to 300 ft out being told it was there.
          const accFt =
            fix.accuracy != null && Number.isFinite(fix.accuracy) && fix.accuracy > 0
              ? fix.accuracy * M_TO_FEET
              : 0
          const insideDest = step.arrived && !settling
          const sure =
            insideDest &&
            step.rangeFt != null &&
            step.radiusFt != null &&
            step.rangeFt + accFt <= step.radiusFt
          if (insideDest && (sure || s.arriveSeen)) {
            seq++ // a re-route in flight is moot now
            set({
              ...base,
              status: 'arrived',
              targetIdx: step.targetIdx,
              roundIdx: null,
              roundAim: null,
              roundTurning: false,
              clearRun: 0,
              arriveSeen: false,
              gpsSlow: false,
              turnSlow: false,
              turnSlowAt: null,
              guide: null,
              progressLog: [],
              offCourseSince: null,
              rerouting: false,
              rerouteError: null,
              pendingPlan: null,
              shallowHere: null,
              error: null,
            })
            return
          }

          // One turn at a time: while a turn point is still to be rounded,
          // nothing further moves on — not the circle of the point after it
          // (a short leg), not a recovery onto a later leg.
          const last = plan.points.length - 1
          let idx = from
          let switched = false
          if (rounding == null && !settling) {
            idx = step.targetIdx
            switched = idx !== from
            // A missed mark picked up from a later leg the boat is already
            // on, and running the way of, is not a corner about to be cut:
            // sending it back to the mark would be steering it astern.
            if (!switched) idx = recoverTarget(plan, idx, fix, opts)
          }

          // Switching is not permission to cut the corner. The line the card
          // would have the boat steer for the next point is checked against
          // the chart — with the fix's error (its 95 % circle) added to every
          // margin — at the switch, and then on EVERY fix until the boat has
          // got round the turn point, not only after a switch: a fix that
          // jumped past the turn, then came back, used to leave the boat
          // steering a line nobody re-checked. While it is not clear the card
          // says "Round waypoint N first", and steers the boat round the turn
          // (`roundAim`). It is let go when the line has been clear for
          // `CLEAR_FIXES` fixes running, when the boat is at the turn point,
          // or when it has got round it (abeam and past it on the way out:
          // steering back would be steering astern).
          const buffer = LINE_BUFFER_ACC * (accFt / M_TO_FEET)
          const judge = (
            at: number,
            fresh: boolean,
            was: number | null,
          ): { roundIdx: number | null; clearRun: number } => {
            if (at < 1) return { roundIdx: null, clearRun: 0 }
            const turn = at - 1
            const got = passedTurn(plan, turn, fix)
            if (fresh || was != null) {
              const verdict = steerVerdict(plan, at, fix, s.plannedFor, buffer)
              // At the turn point (or, with no chart, by the route's own
              // geometry) — whatever the line check says.
              // Or when the turn point is behind the boat: sending it back
              // would be steering astern (the boat has gone past it, wide).
              // "At" it means within `ROUNDED_FT` of it by the fix itself —
              // not widened by a poor fix's error, which let a ±20 m fix go
              // 60 ft short of the turn and swing a boat really 25 m further
              // in across the corner; a poor fix is let go abeam (`got`).
              const atTurn =
                got ||
                !turnAhead(plan, turn, fix, opts) ||
                shortcutClear(plan, turn, { ...fix, accuracy: null }, verdict === null ? null : 'unsafe')
              if (was != null) {
                const run = verdict === 'clear' ? s.clearRun + 1 : 0
                return !atTurn && run < CLEAR_FIXES
                  ? { roundIdx: turn, clearRun: run }
                  : { roundIdx: null, clearRun: 0 }
              }
              return !atTurn && verdict !== 'clear'
                ? { roundIdx: turn, clearRun: 0 }
                : { roundIdx: null, clearRun: 0 }
            }
            if (!got && turnAhead(plan, turn, fix, opts)) {
              const verdict = steerVerdict(plan, at, fix, s.plannedFor, buffer)
              if (verdict === 'unsafe' && !shortcutClear(plan, turn, fix, 'unsafe')) {
                return { roundIdx: turn, clearRun: 0 }
              }
            }
            return { roundIdx: null, clearRun: 0 }
          }
          let { roundIdx, clearRun } = judge(idx, switched, rounding)

          // Through several points on one fix: the boat is already inside
          // the next point's circle too (a short leg between two turns — at
          // 25 kn a 42 m leg is gone between two fixes). One step a fix left
          // the card with nothing to steer while the boat was already inside
          // the next circle. Each point passed this way is judged as a fresh
          // switch: straight on where the line on is clear, "round it first"
          // (and steered round it) where it is not.
          for (let k = 0; roundIdx == null && !settling && idx < last && k < MAX_ADVANCE; k++) {
            if (stepTarget(plan, idx, fix, opts).targetIdx === idx) break
            idx++
            switched = true
            ;({ roundIdx, clearRun } = judge(idx, true, null))
          }
          const shown: number = roundIdx ?? idx
          // How fast this boat comes round, as seen so far (`updateTurnRate`).
          const turnModel: TurnModel = { dps: turnRateDps(s.turnRec), reactS: turnReactS(s.turnRec) }
          const turningOn = roundIdx != null && s.roundIdx === roundIdx && s.roundTurning
          const aimed =
            roundIdx != null
              ? turningOn
                ? { aim: s.roundAim ?? plan.points[idx], turning: true }
                : aimRound(plan, roundIdx, idx, fix, s.plannedFor, buffer, speedKn, turnModel)
              : null
          const roundAim = aimed?.aim ?? null
          const roundTurning = !!aimed?.turning

          // Off the route near the boat — including, now, steering to the
          // first point: a start chosen by hand that the boat is not at is
          // not a line anyone checked, so after the usual 10 s the route is
          // re-planned from where the boat is. How far off counts scales
          // with the boat's stand-off: 60 m off a line planned 5 m clear of
          // the bank is 55 m into it. Measured to the route round the turn,
          // not just the leg into the target, which begins up to 200 ft
          // ahead of a boat that has just switched.
          const off = isOffCourse(plan, shown, fix, {
            ...opts,
            marginM: s.plannedFor?.clearanceM ?? null,
          })
          const offCourseSince = off ? (s.offCourseSince ?? now) : null
          // Off the route AND the way the card would take the boat back to
          // it is not clear on the chart: waiting the full 10 s is 10 s of
          // steering across what the chart says not to.
          // Likewise when the boat has run on past the point the card steers
          // for and it is behind it: the card would point it back astern for
          // the whole 10 s. Past it, not merely set off abeam of it — a boat
          // swept sideways off the leg (drift) is re-routed once the set
          // has had its 10 s, not again and again while it lasts.
          const hold =
            off &&
            (steerVerdict(plan, shown, fix, s.plannedFor, buffer) === 'unsafe' ||
              (behind(plan.points[shown], fix) && pastPoint(plan, shown, fix)))
              ? OFF_COURSE_UNSAFE_HOLD_MS
              : OFF_COURSE_HOLD_MS

          // The chart under the boat — and within the fix's error of it —
          // whatever the off-course rule says: a boat 20 m off the line can
          // be in water too shallow for it.
          const shallowHere = shallowAt(plan, fix, s.plannedFor)
          // And ahead of it, when the fix is too poor for the boat's margins.
          const gpsSlow = slowAhead(plan, shown, fix, s.plannedFor, speedKn)
          // And for the next turn, when it is too tight for this speed —
          // held until the boat is round that turn: a boat that has slowed
          // for it would otherwise be told it may speed up again before it.
          const heldSlow =
            s.turnSlowAt != null && s.plan === plan && shown <= s.turnSlowAt ? s.turnSlowAt : null
          const turnSlowAt =
            heldSlow ?? tooFastForTurn(plan, shown, fix, s.plannedFor, speedKn, turnModel)
          const turnSlow = turnSlowAt != null

          // How the card is to steer on this fix (`guide`): the set learnt
          // from the cross-track error while the boat runs a leg — not in a
          // turn, not rounding, not on a position still settling — the
          // lookahead checked against the chart, and whether shallows or
          // land lie near enough that losing the fix should slow the boat.
          const steadyLeg = roundIdx == null && !switched && !settling && !resuming && s.roundIdx == null
          const setEst = updateSet(
            s.setEst,
            plan,
            steadyLeg ? shown : 0,
            fix,
            dtS,
            s.guide?.lookaheadM ?? speedLookaheadM(fix),
          )
          const setDeg = roundIdx == null ? setAllowanceDeg(setEst, plan, shown, fix) : 0
          // A helm swinging across the line gets a longer lookahead.
          const onLeg =
            steadyLeg && shown >= 1
              ? legGeometry(plan.points[shown - 1], plan.points[shown], fix)
              : null
          const helm = updateHelm(
            s.helm,
            shown,
            onLeg && onLeg.alongM >= 0 && onLeg.alongM <= onLeg.lengthM ? onLeg.crossM : null,
            fix.accuracy,
            now,
          )
          const hazardNear = hazardNearFix(plan, fix, s.plannedFor, speedKn)
          const lookaheadM =
            roundIdx == null
              ? steerLookahead(plan, shown, fix, s.plannedFor, setDeg, helm.factor, hazardNear)
              : null
          const steerDeg =
            roundIdx != null
              ? roundAim
                ? bearingDeg(fix.lat, fix.lon, roundAim.lat, roundAim.lon)
                : null
              : (steerCourse(plan, shown, fix, { lookaheadM, setDeg })?.bearingDeg ?? null)
          const guide: SteerGuide = {
            fixAt: fix.timestamp,
            lookaheadM,
            setDeg,
            hazardNear,
            dangerAhead: dangerOnHeading(plan, fix, s.plannedFor, steerDeg),
          }
          const turnRec = updateTurnRate(s.turnRec, fix, steerDeg, now)

          // Distance to go, logged for the speed made good along the route.
          const prog = navProgress(plan, shown, fix)
          const progressLog = prog
            ? logProgress(resuming ? [] : s.progressLog, {
                t: fix.timestamp,
                remainingNM: prog.remainingNM,
                sogKn: fix.speed != null && Number.isFinite(fix.speed) ? fix.speed * MPS_TO_KNOTS : null,
              })
            : s.progressLog

          set({
            ...base,
            targetIdx: idx,
            roundIdx,
            roundAim: roundAim && s.roundAim && sameAim(s.roundAim, roundAim) ? s.roundAim : roundAim,
            roundTurning,
            clearRun,
            arriveSeen: insideDest,
            ...(gpsSlow !== s.gpsSlow ? { gpsSlow } : {}),
            ...(turnSlow !== s.turnSlow ? { turnSlow } : {}),
            turnSlowAt,
            guide,
            setEst,
            helm,
            turnRec,
            progressLog,
            offCourseSince,
            // Back on the route: an old "could not re-route" is no longer
            // true, and a re-route waiting for confirmation is moot.
            ...(off ? {} : { rerouteError: null, pendingPlan: null }),
            ...(sameShallow(s.shallowHere, shallowHere) ? {} : { shallowHere }),
          })

          // Re-routes back off: no more than two in any two minutes
          // (`rerouteGapMs`).
          const gap = rerouteGapMs(s.rerouteLog, now)
          if (
            off &&
            !s.rerouting &&
            !s.pendingPlan &&
            now - offCourseSince! >= hold &&
            (s.lastRerouteAt == null || now - s.lastRerouteAt >= gap)
          ) {
            void runPlan('reroute', fix)
          }
        },

        restoreChart: async () => {
          const s = get()
          if (s.status !== 'navigating' || !s.plan || !steerable(s.plan)) return
          if (restoring || s.chartLoads.length === 0) return
          if (useChartData.getState().features.coverage !== 'none') return
          restoring = true
          try {
            for (const l of s.chartLoads) {
              await withTimeout(
                useChartData.getState().load(l.bounds, { detailAround: l.detailAround }),
                LIVE_CHART_TIMEOUT_MS,
                SLOW_CHART,
              )
            }
          } catch {
            // No chart: the live checks fall back to the route's own geometry.
          } finally {
            restoring = false
          }
        },
      }
    },
    {
      name: NAV_STORAGE_KEY,
      version: 1,
      storage: navStorage(),
      partialize: partializeNav,
      onRehydrateStorage: () => (state) => {
        if (!state) return
        // Deferred: the store is still being created when this runs.
        queueMicrotask(() => {
          const s = useNavigation.getState()
          if (s.status === 'planning') {
            // The plan was lost with the page. Make it again.
            void s.replan('retry')
          } else if (s.status === 'navigating') {
            // Where the boat is along the route is re-derived from the next
            // fix — it may have moved a long way while the app was closed.
            useNavigation.setState({ resume: true, offCourseSince: null })
          }
        })
      },
    },
  ),
)

/**
 * What the chart says under the boat — and within the fix's claimed error of
 * it — when that is water shallower than the boat needs, or land. Away from
 * the dock stretches at each end, where the route is allowed shallow water
 * and is drawn dotted already. Null otherwise, or when no chart covering the
 * position is in memory.
 *
 * At the fix itself it is a fact ("the chart shows land here"); within the
 * accuracy circle only a possibility (`maybe`): a ±18 m fix 26 m off the line
 * can have the boat 30 m off it, in the shallows, with the fix itself in
 * deep water.
 */
function shallowAt(plan: RoutePlan, fix: Fix, was: PlannedFor | null): ShallowHere | null {
  if (!was) return null
  const first = plan.points[0]
  const last = plan.points[plan.points.length - 1]
  if (metres(fix, first) <= APPROACH_M || metres(fix, last) <= APPROACH_M) return null
  let near
  try {
    near = liveChartNear(liveRequest(plan, was), fix, fix.accuracy)
  } catch {
    return null
  }
  if (!near) return null
  if (near.here) return { depthM: near.here.depthM, land: near.here.land }
  if (near.near) return { depthM: near.near.depthM, land: near.near.land, maybe: true }
  return null
}

function sameShallow(a: ShallowHere | null, b: ShallowHere | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.land === b.land && a.depthM === b.depthM && !!a.maybe === !!b.maybe
}

