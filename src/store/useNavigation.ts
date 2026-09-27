import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { planningBounds, planRoute, type RoutePlan } from '@/lib/routing'
import {
  isOffCourse,
  isStale,
  recoverTarget,
  smoothSpeedKn,
  startTarget,
  stepTarget,
  type ArrivalOptions,
} from '@/lib/navigate'
import type { LatLon } from '@/lib/search'
import type { Fix } from '@/lib/types'
import { safeDepthM, type Vessel } from '@/lib/vessel'
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
 *     legs. A re-route that comes back best-effort drops back to the preview
 *     for the same confirmation: the crew accepted the old route's problems,
 *     not the new one's.
 *   - **Let an older plan overwrite a newer one.** Every plan carries a
 *     sequence number; a plan finishing after a newer one was asked for is
 *     thrown away. Plotting a destination, changing your mind and plotting
 *     another must never end with the first route on the screen.
 *   - **Re-route on a whim.** Off course has to be continuous for 10 s, and
 *     re-routes are at least 20 s apart, so one bad fix or a wide turn does
 *     not throw a new route at the crew every second.
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
 * - `boat` — the boat's draft, margin, stand-off or speed (or the arrival
 *   setting) changed. While steering: from the live fix, keeps steering;
 *   otherwise a fresh preview.
 * - `retry` — the last attempt failed (no signal, no fix); try again.
 */
export type ReplanReason = 'user' | 'reroute' | 'boat' | 'retry'

/** Continuous time off course before re-routing, ms. */
export const OFF_COURSE_HOLD_MS = 10_000
/** Least time between two automatic re-routes, ms. */
export const REROUTE_MIN_GAP_MS = 20_000

export const NAV_STORAGE_KEY = 'navmate.nav.v1'

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
  /** The crew has accepted this best-effort plan's flagged legs. */
  confirmed: boolean
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
   * Plan to `place`, immediately. `origin` undefined keeps the current
   * start; null means my live position; a place means plan from there.
   */
  setDestination: (place: Place, origin?: Place | null) => Promise<void>
  /** Change the start (null = my live position), re-planning if there is a destination. */
  setOrigin: (place: Place | null) => Promise<void>
  replan: (reason: ReplanReason) => Promise<void>
  /**
   * Begin steering. False (with `error` set) when there is nothing safe to
   * start: no plan, a `none` plan, or a best-effort plan not yet confirmed.
   */
  start: () => boolean
  confirmBestEffort: () => void
  /** Stop steering; the route stays on the chart as a preview. */
  stop: () => void
  /** Forget the destination and the route. */
  clear: () => void
  /** Feed a (filtered) GPS fix while navigating. */
  onFix: (fix: Fix) => void
}

/** The boat the plotter plans for — the same choice the Chart tab shows. */
export function activeVessel(): Vessel | null {
  return useVessels.getState().active(useTeams.getState().activeTeamId)
}

/**
 * The crew's arrival setting — the same one the Search tab steers with, and
 * the cap for every per-point radius the planner sets.
 */
function arrivalOpts(): ArrivalOptions {
  return { arrivalFt: useTracker.getState().arrivalFt }
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

/** Bumped by every plan, `stop` and `clear`; a result from an older one is dropped. */
let seq = 0

const INITIAL = {
  dest: null,
  origin: null,
  plan: null,
  status: 'idle' as NavStatus,
  targetIdx: null,
  error: null,
  confirmed: false,
  offCourseSince: null,
  lastPlannedAt: null,
  reroutes: 0,
  speedKn: null,
  gpsPoor: false,
  rerouting: false,
  lastRerouteAt: null,
  lastFixAt: null,
  resume: false,
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
  }
}

/** A plan there is something to steer on: a line of at least one leg. */
function steerable(plan: RoutePlan): boolean {
  return plan.source !== 'none' && plan.points.length >= 2
}

function needsConfirm(plan: RoutePlan): boolean {
  return plan.needsConfirm || plan.source === 'best-effort'
}

export const useNavigation = create<NavigationState>()(
  persist(
    (set, get) => {
      /**
       * Plan (or re-plan) to the destination.
       *
       * Two modes. Steering, for anything but a new destination or start
       * (`live`): plan from the live fix, keep steering the current route
       * until the new one is in, and never drop the crew onto a blank card
       * if the re-plan fails. Otherwise: a fresh preview, the old route
       * cleared at once so it cannot be mistaken for the new one.
       */
      async function runPlan(reason: ReplanReason, liveFix?: Fix | null): Promise<void> {
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
            error: null,
            offCourseSince: null,
            rerouting: false,
            resume: false,
          })
        }

        try {
          const boat = activeVessel()
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

          const features = await useChartData
            .getState()
            .load(planningBounds(from, to), { detailAround: [from, to] })
          if (seq !== my) return
          const chart = useChartData.getState()
          if (features.coverage === 'none' && chart.status === 'error') {
            throw new Error(
              `Could not read the chart for this area${chart.error ? ` — ${chart.error}` : ''}. ` +
                'Check your signal and try again.',
            )
          }

          const plan = planRoute({
            from,
            to,
            safeDepthM: safeDepthM(boat),
            clearanceM: boat.clearance_m,
            speedKn: boat.cruise_speed_kn,
            features,
            arrivalFt: useTracker.getState().arrivalFt,
          })
          if (seq !== my) return
          const done = Date.now()

          if (live) {
            if (!steerable(plan)) {
              // Keep steering what we have; it was safe when it was made.
              set({
                rerouting: false,
                error: `Could not re-route from here: ${plan.failure ?? 'no water path found'}`,
              })
              return
            }
            if (needsConfirm(plan)) {
              set({
                plan,
                origin: null,
                status: 'preview',
                targetIdx: null,
                confirmed: false,
                rerouting: false,
                offCourseSince: null,
                resume: false,
                lastPlannedAt: done,
                error:
                  'Re-routed, but no fully safe route was found from here. ' +
                  'Read the flagged legs and confirm before steering it.',
              })
              return
            }
            const fixNow = liveFix ?? useTracker.getState().fix
            set({
              plan,
              origin: null,
              targetIdx: startTarget(plan, fixNow, arrivalOpts()),
              rerouting: false,
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
              status: 'failed',
              error: plan.failure ?? 'No route could be found to this destination.',
              lastPlannedAt: done,
            })
            return
          }
          set({ plan, status: 'preview', error: null, lastPlannedAt: done })
        } catch (e) {
          if (seq !== my) return
          const message = e instanceof Error ? e.message : describeError(e)
          if (live) {
            set({ rerouting: false, error: `Could not re-route: ${message}` })
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
          const { status, dest } = get()
          if (!dest) return
          // Nothing to re-plan once there: a boat edited at the dock after
          // arriving should not throw a new route onto the "arrived" card.
          if (status === 'arrived' || status === 'idle') {
            if (reason !== 'user' && reason !== 'retry') return
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
          set({
            status: 'navigating',
            targetIdx: startTarget(plan, fix, arrivalOpts()),
            resume: fix == null,
            error: null,
            offCourseSince: null,
            speedKn: null,
            lastFixAt: null,
            gpsPoor: false,
            rerouting: false,
            reroutes: 0,
            lastRerouteAt: null,
          })
          if (!tracker.watching) tracker.start()
          return true
        },

        confirmBestEffort: () => {
          const { plan } = get()
          if (!plan || !steerable(plan) || !needsConfirm(plan)) return
          set({ confirmed: true, error: null })
        },

        stop: () => {
          const { status, plan } = get()
          if (status !== 'navigating' && status !== 'arrived') return
          // A re-route still in flight belongs to the passage being ended.
          seq++
          set({
            status: plan && steerable(plan) ? 'preview' : 'idle',
            targetIdx: null,
            offCourseSince: null,
            rerouting: false,
            resume: false,
            gpsPoor: false,
            error: null,
          })
        },

        clear: () => {
          seq++
          set({ ...INITIAL })
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

          const from =
            s.resume || s.targetIdx == null ? startTarget(plan, fix, opts) : s.targetIdx
          const step = stepTarget(plan, from, fix, opts)
          const base = { speedKn, gpsPoor: step.gpsPoor, lastFixAt: fix.timestamp, resume: false }

          if (step.arrived) {
            seq++ // a re-route in flight is moot now
            set({
              ...base,
              status: 'arrived',
              targetIdx: step.targetIdx,
              offCourseSince: null,
              rerouting: false,
            })
            return
          }

          let idx = step.targetIdx
          if (idx === from) idx = recoverTarget(plan, idx, fix, opts)

          // Steering to the first point of a route planned ahead from
          // somewhere else is not "off course" — it is getting to the start.
          // For a route from my own position it is: the route no longer
          // starts where the boat is.
          const off =
            (idx >= 1 || s.origin === null) && isOffCourse(plan, idx, fix, opts)
          const offCourseSince = off ? (s.offCourseSince ?? now) : null
          set({ ...base, targetIdx: idx, offCourseSince })

          if (
            off &&
            !s.rerouting &&
            now - offCourseSince! >= OFF_COURSE_HOLD_MS &&
            (s.lastRerouteAt == null || now - s.lastRerouteAt >= REROUTE_MIN_GAP_MS)
          ) {
            void runPlan('reroute', fix)
          }
        },
      }
    },
    {
      name: NAV_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
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
