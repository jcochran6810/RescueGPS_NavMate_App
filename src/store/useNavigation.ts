import { create } from 'zustand'
import {
  persist,
  createJSONStorage,
  type PersistStorage,
  type StorageValue,
} from 'zustand/middleware'
import {
  liveChartNear,
  liveShortcut,
  planningBounds,
  planRoute,
  recheckPlan,
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
  isOffCourse,
  isStale,
  logProgress,
  navProgress,
  recoverTarget,
  shortcutClear,
  smoothSpeedKn,
  startTarget,
  stepTarget,
  type ArrivalOptions,
  type ProgressSample,
} from '@/lib/navigate'
import { haversineNM, MPS_TO_KNOTS, NM_TO_METERS } from '@/lib/geo'
import { routeArrivalFt } from '@/lib/steer'
import type { LatLon } from '@/lib/search'
import type { Fix } from '@/lib/types'
import { safeDepthM, M_TO_FEET, type Vessel } from '@/lib/vessel'
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
/** Least time between two automatic re-routes, ms. */
export const REROUTE_MIN_GAP_MS = 20_000
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

export const NAV_STORAGE_KEY = 'navmate.nav.v1'

/** What a plan was checked against — the boat it was made for. */
export interface PlannedFor {
  safeDepthM: number
  clearanceM: number
  speedKn: number
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

export interface NavigationState {
  dest: Place | null
  /** null = start from my live position (the normal case). */
  origin: Place | null
  plan: RoutePlan | null
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
  /** Distance to go over the last half-minute, for the ETA. Not persisted. */
  progressLog: ProgressSample[]

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
  }
}

/** Does the boat now ask more of the route than the one it was planned for? */
function stricter(boat: Vessel | null, was: PlannedFor | null): boolean {
  if (!boat || !was) return true
  return safeDepthM(boat) > was.safeDepthM + 1e-9 || boat.clearance_m > was.clearanceM + 1e-9
}

function samePlannedFor(a: PlannedFor | null, b: PlannedFor): boolean {
  return (
    !!a &&
    Math.abs(a.safeDepthM - b.safeDepthM) < 1e-9 &&
    Math.abs(a.clearanceM - b.clearanceM) < 1e-9 &&
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

const INITIAL = {
  dest: null,
  origin: null,
  plan: null,
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
  rerouting: false,
  lastRerouteAt: null,
  lastFixAt: null,
  resume: false,
  roundIdx: null,
  progressLog: [] as ProgressSample[],
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
  return {
    features: useChartData.getState().features,
    from: plan.points[0],
    to: plan.points[plan.points.length - 1],
    safeDepthM: was.safeDepthM,
    clearanceM: was.clearanceM,
    approachM: APPROACH_M,
  }
}

/**
 * The chart's verdict on steering straight from the fix to point `next`,
 * having switched away from `turn` — null with no chart (or no boat) to
 * judge it by. See `liveShortcut`.
 */
function shortcutVerdict(
  plan: RoutePlan,
  turn: number,
  next: number,
  fix: Fix,
  was: PlannedFor | null,
): ShortcutVerdict | null {
  if (!was) return null
  try {
    return liveShortcut(liveRequest(plan, was), fix, plan.points[turn], plan.points[next], fix.accuracy)
  } catch {
    return null
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
          progressLog: [],
          error: message,
        })
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
        const my = ++seq
        const now = Date.now()

        if (live) {
          set({
            rerouting: true,
            ...(reason === 'reroute'
              ? { lastRerouteAt: now, reroutes: s.reroutes + 1 }
              : {}),
          })
        } else {
          set({
            status: 'planning',
            plan: null,
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
          const request = (f: ChartFeatures) => ({
            from,
            to,
            safeDepthM: forBoat.safeDepthM,
            clearanceM: forBoat.clearanceM,
            speedKn: forBoat.speedKn,
            features: f,
            arrivalFt: arrivalOpts().arrivalFt,
          })

          // Paint "Re-routing…" / "Finding a safe route…" before the search.
          await yieldToPaint()
          if (seq !== my) return
          let plan = planRoute(request(features))

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
                if (rank(second) >= rank(plan)) plan = second
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
                  loads = [...loads, { bounds: box, detailAround: [from, to] }]
                }
              }
            } catch {
              // Keep what was planned on the chart in memory.
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
              progressLog: [],
              pendingPlan: null,
              rerouting: false,
              rerouteError: null,
              offCourseSince: null,
              resume: false,
              lastPlannedAt: done,
              error: null,
            })
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

        acceptPendingPlan: () => {
          const s = get()
          const pending = s.pendingPlan
          if (!pending || s.status !== 'navigating') return
          const boat = activeVessel()
          seq++
          set({
            plan: pending,
            pendingPlan: null,
            confirmed: true,
            origin: null,
            plannedFor: boat ? plannedForBoat(boat) : s.plannedFor,
            targetIdx: startTarget(pending, useTracker.getState().fix, arrivalOpts()),
            roundIdx: null,
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
            progressLog: [],
          })
        },

        clear: () => {
          seq++
          set({ ...INITIAL, ownerId: get().ownerId })
        },

        reset: () => {
          seq++
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
          const speedKn = smoothSpeedKn(s.speedKn, fix, dtS)
          const opts = arrivalOpts()

          const resuming = s.resume || s.targetIdx == null
          const from = resuming ? startTarget(plan, fix, opts) : (s.targetIdx as number)
          // A turn point switched away from but not yet rounded — see below.
          const rounding = resuming ? null : s.roundIdx
          const step = stepTarget(plan, from, fix, opts)
          const base = { speedKn, gpsPoor: step.gpsPoor, lastFixAt: fix.timestamp, resume: false }

          if (step.arrived) {
            seq++ // a re-route in flight is moot now
            set({
              ...base,
              status: 'arrived',
              targetIdx: step.targetIdx,
              roundIdx: null,
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
          let idx = from
          let switched = false
          if (rounding == null) {
            idx = step.targetIdx
            switched = idx !== from
            // A missed mark picked up from a later leg the boat is already
            // on, and running the way of, is not a corner about to be cut:
            // sending it back to the mark would be steering it astern.
            if (!switched) idx = recoverTarget(plan, idx, fix, opts)
          }

          // Switching is not permission to cut the corner. After every
          // switch, and on every fix until it is clear, the straight line
          // from the boat to the new point is checked against the chart
          // (with the fix's error added); while it is not clear the card
          // steers to the turn point just switched away from — "Round
          // waypoint N first". The switch itself still happens at the crew's
          // 100–200 ft, and the distance to go counts via the turn point.
          let roundIdx: number | null = null
          if ((switched || rounding != null) && idx >= 1) {
            const turn = idx - 1
            const verdict = shortcutVerdict(plan, turn, idx, fix, s.plannedFor)
            if (!shortcutClear(plan, turn, fix, verdict)) roundIdx = turn
          }
          const shown = roundIdx ?? idx

          // Off the leg being run — including, now, steering to the first
          // point: a start chosen by hand that the boat is not at is not a
          // line anyone checked, so after the usual 10 s the route is
          // re-planned from where the boat is.
          const off = isOffCourse(plan, shown, fix, opts)
          const offCourseSince = off ? (s.offCourseSince ?? now) : null

          // The chart under the boat — and within the fix's error of it —
          // whatever the off-course rule says: a boat 20 m off the line can
          // be in water too shallow for it, and the off-course threshold is
          // 60 m or more.
          const shallowHere = shallowAt(plan, fix, s.plannedFor)

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
            progressLog,
            offCourseSince,
            // Back on the route: an old "could not re-route" is no longer
            // true, and a re-route waiting for confirmation is moot.
            ...(off ? {} : { rerouteError: null, pendingPlan: null }),
            ...(sameShallow(s.shallowHere, shallowHere) ? {} : { shallowHere }),
          })

          if (
            off &&
            !s.rerouting &&
            !s.pendingPlan &&
            now - offCourseSince! >= OFF_COURSE_HOLD_MS &&
            (s.lastRerouteAt == null || now - s.lastRerouteAt >= REROUTE_MIN_GAP_MS)
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

