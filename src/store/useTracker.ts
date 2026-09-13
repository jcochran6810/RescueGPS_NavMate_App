import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  ARRIVAL_FT_CHOICES,
  DEFAULT_ARRIVAL_FT,
  type ArrivalFt,
} from '@/lib/steer'
import type { Fix } from '@/lib/types'
import {
  DEFAULT_GATE_M,
  TrackFilter,
  shouldRecord,
  type RejectReason,
} from '@/lib/track'

interface TrackerState {
  /** The filtered position — what everything in the app navigates on. */
  fix: Fix | null
  /** Exactly what the receiver last said, gated or not. Never rewritten. */
  raw: Fix | null
  watching: boolean
  error: string | null
  /** Fixes from this session, newest last. Capped so a long shift cannot
   *  exhaust memory on a phone. */
  trail: Fix[]
  /**
   * Seconds between recorded breadcrumbs. The live readout still updates on
   * every fix; this only controls how densely the path is sampled.
   */
  intervalS: number
  /** Worst accuracy, metres, a fix may report and still be used. 0 = take any. */
  gateM: number
  /**
   * How close counts as arriving at a turn point, in feet. Read by the
   * steering rule in `lib/steer.ts`, which both the chart routes and the
   * search patterns share.
   */
  arrivalFt: ArrivalFt
  /** Fixes refused this session, and why the last one was. */
  rejected: Record<RejectReason, number>
  lastReject: string | null
  /** Whether speed and course are coming from the filter or the receiver. */
  derived: { speed: boolean; heading: boolean }
  /** The screen is being held awake while tracking. */
  screenAwake: boolean

  start: () => void
  stop: () => void
  clearTrail: () => void
  setIntervalS: (seconds: number) => void
  setGateM: (meters: number) => void
  setArrivalFt: (feet: ArrivalFt) => void
  once: () => Promise<Fix | null>
}

const TRAIL_LIMIT = 2000

/**
 * How often a breadcrumb may be dropped.
 *
 * Below ten seconds a walking crew records mostly GPS noise, and above thirty
 * the path starts cutting corners it actually walked.
 */
export const INTERVAL_CHOICES = [10, 15, 20, 30] as const
export const DEFAULT_INTERVAL_S = 15

/**
 * A fix already in hand and this fresh is better than asking the receiver
 * again: it has been through the filter, and `getCurrentPosition` on a cold
 * call can come back with a cell-tower estimate.
 */
const FRESH_MS = 5000

let watchId: number | null = null
const filter = new TrackFilter({ maxAccuracyM: DEFAULT_GATE_M })

/* --------------------------------------------------------------- wake lock
 * A phone that sleeps stops giving the page fixes, so a track recorded with
 * the screen off has a hole in it exactly as long as the crew's attention was
 * elsewhere. The lock is best-effort — unsupported on some browsers, dropped
 * whenever the page is hidden — so it is re-taken on every return to the page
 * and its absence is never an error.
 */

interface Sentinel {
  release: () => Promise<void>
  addEventListener: (type: 'release', fn: () => void) => void
}

let sentinel: Sentinel | null = null

function wakeLockApi(): { request: (t: 'screen') => Promise<Sentinel> } | null {
  const nav = navigator as Navigator & {
    wakeLock?: { request: (t: 'screen') => Promise<Sentinel> }
  }
  return nav.wakeLock ?? null
}

async function holdScreen(set: (p: Partial<TrackerState>) => void) {
  const api = wakeLockApi()
  if (!api || sentinel) return
  try {
    const s = await api.request('screen')
    sentinel = s
    set({ screenAwake: true })
    s.addEventListener('release', () => {
      sentinel = null
      set({ screenAwake: false })
    })
  } catch {
    set({ screenAwake: false })
  }
}

function releaseScreen(set: (p: Partial<TrackerState>) => void) {
  void sentinel?.release().catch(() => {})
  sentinel = null
  set({ screenAwake: false })
}

function toFix(pos: GeolocationPosition): Fix {
  const c = pos.coords
  return {
    lat: c.latitude,
    lon: c.longitude,
    speed: c.speed != null && Number.isFinite(c.speed) ? c.speed : null,
    heading: c.heading != null && Number.isFinite(c.heading) ? c.heading : null,
    accuracy: c.accuracy ?? null,
    altitude:
      c.altitude != null && Number.isFinite(c.altitude) ? c.altitude : null,
    timestamp: pos.timestamp,
  }
}

function describe(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'Location permission denied. Enable it in your browser settings.'
    case err.POSITION_UNAVAILABLE:
      return 'No position available — no GPS signal.'
    case err.TIMEOUT:
      return 'Timed out waiting for a GPS fix.'
    default:
      return err.message || 'Location error'
  }
}

/**
 * Geolocation options for a live watch.
 *
 * `maximumAge: 0` matters more than it looks: the default lets the browser
 * hand back a cached position, and a track built from cached positions is a
 * straight line between the places the cache happened to be refreshed. The
 * timeout is long because under canopy or in a wheelhouse a real GNSS fix
 * genuinely takes half a minute, and a timeout error there reads as a fault
 * when it is only patience.
 */
const WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 30_000,
  maximumAge: 0,
}

export const useTracker = create<TrackerState>()(
  persist(
    (set, get) => ({
      fix: null,
      raw: null,
      watching: false,
      error: null,
      trail: [],
      intervalS: DEFAULT_INTERVAL_S,
      gateM: DEFAULT_GATE_M,
      arrivalFt: DEFAULT_ARRIVAL_FT,
      rejected: { accuracy: 0, jump: 0, stale: 0 },
      lastReject: null,
      derived: { speed: false, heading: false },
      screenAwake: false,

      start: () => {
        if (!navigator.geolocation) {
          set({ error: 'This browser does not support geolocation.' })
          return
        }
        if (watchId !== null) return

        filter.reset()
        filter.setMaxAccuracy(get().gateM)
        set({
          rejected: { accuracy: 0, jump: 0, stale: 0 },
          lastReject: null,
        })

        watchId = navigator.geolocation.watchPosition(
          (pos) => {
            const raw = toFix(pos)
            const result = filter.push(raw)

            if (!result.accepted) {
              // A refused fix is not a silent one. The crew can see the count
              // climb and loosen the gate if the receiver is having a bad day.
              set({
                raw,
                error: null,
                rejected: { ...filter.rejected },
                lastReject: result.detail,
              })
              return
            }

            const { trail, intervalS } = get()
            const last = trail[trail.length - 1]
            const next = shouldRecord(last, result.fix, intervalS)
              ? [...trail, result.fix]
              : trail

            set({
              fix: result.fix,
              raw,
              derived: result.derived,
              error: null,
              trail:
                next.length > TRAIL_LIMIT ? next.slice(-TRAIL_LIMIT) : next,
            })
          },
          (err) => set({ error: describe(err) }),
          WATCH_OPTIONS,
        )
        set({ watching: true, error: null })
        void holdScreen(set)
      },

      stop: () => {
        if (watchId !== null) {
          navigator.geolocation.clearWatch(watchId)
          watchId = null
        }
        releaseScreen(set)
        set({ watching: false })
      },

      clearTrail: () => set({ trail: [] }),

      setIntervalS: (seconds) => {
        if (!Number.isFinite(seconds) || seconds <= 0) return
        set({ intervalS: Math.round(seconds) })
      },

      setGateM: (meters) => {
        if (!Number.isFinite(meters) || meters < 0) return
        filter.setMaxAccuracy(meters)
        set({ gateM: meters })
      },

      setArrivalFt: (feet) => {
        if (!ARRIVAL_FT_CHOICES.includes(feet)) return
        set({ arrivalFt: feet })
      },

      once: () =>
        new Promise<Fix | null>((resolve) => {
          // Already tracking, and the position is seconds old: that fix has
          // been through the filter and is better than anything a fresh
          // one-shot call will return.
          const current = get().fix
          if (current && Date.now() - current.timestamp < FRESH_MS) {
            resolve(current)
            return
          }
          if (!navigator.geolocation) {
            set({ error: 'This browser does not support geolocation.' })
            resolve(null)
            return
          }
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const fix = toFix(pos)
              // Deliberately not gated. A single fix asked for by hand is a
              // fix the crew wants now — capture succeeds, and the accuracy
              // travels with it so nobody has to guess how good it was.
              set({ fix, raw: fix, error: null })
              resolve(fix)
            },
            (err) => {
              set({ error: describe(err) })
              resolve(null)
            },
            { enableHighAccuracy: true, timeout: 30_000, maximumAge: 0 },
          )
        }),
    }),
    {
      name: 'navmate-tracker',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      // Only the preferences are kept. A trail restored on next launch would
      // look like the crew teleported between shifts.
      // `arrivalFt` needs no version bump: a v2 payload simply lacks the key,
      // and persist merges it back to the default above.
      partialize: (s) => ({
        intervalS: s.intervalS,
        gateM: s.gateM,
        arrivalFt: s.arrivalFt,
      }),
      // Version 1 stored the interval alone. Without this the bump would
      // throw it away and quietly reset a preference the crew had chosen.
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<TrackerState>
        if (version < 2) {
          return {
            intervalS: p.intervalS ?? DEFAULT_INTERVAL_S,
            gateM: DEFAULT_GATE_M,
          }
        }
        return p
      },
      onRehydrateStorage: () => (state) => {
        if (state) filter.setMaxAccuracy(state.gateM)
      },
    },
  ),
)

// Browsers drop a screen wake lock whenever the page is hidden and never give
// it back on their own. Taking it again on return is the difference between a
// track that survives a pocket and one that stops there.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (!useTracker.getState().watching) return
    void holdScreen((p) => useTracker.setState(p))
  })
}
