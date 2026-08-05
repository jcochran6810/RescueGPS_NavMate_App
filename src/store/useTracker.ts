import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Fix } from '@/lib/types'

interface TrackerState {
  fix: Fix | null
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

  start: () => void
  stop: () => void
  clearTrail: () => void
  setIntervalS: (seconds: number) => void
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

let watchId: number | null = null

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

export const useTracker = create<TrackerState>()(
  persist(
    (set, get) => ({
      fix: null,
      watching: false,
      error: null,
      trail: [],
      intervalS: DEFAULT_INTERVAL_S,

      start: () => {
        if (!navigator.geolocation) {
          set({ error: 'This browser does not support geolocation.' })
          return
        }
        if (watchId !== null) return

        watchId = navigator.geolocation.watchPosition(
          (pos) => {
            const fix = toFix(pos)
            const { trail, intervalS } = get()
            const last = trail[trail.length - 1]

            // The readout follows every fix the receiver gives us; the path is
            // sampled on the chosen interval so an hour of tracking stays a
            // few hundred points rather than a few thousand.
            const due =
              !last || fix.timestamp - last.timestamp >= intervalS * 1000
            const next = due ? [...trail, fix] : trail

            set({
              fix,
              error: null,
              trail:
                next.length > TRAIL_LIMIT ? next.slice(-TRAIL_LIMIT) : next,
            })
          },
          (err) => set({ error: describe(err) }),
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 },
        )
        set({ watching: true, error: null })
      },

      stop: () => {
        if (watchId !== null) {
          navigator.geolocation.clearWatch(watchId)
          watchId = null
        }
        set({ watching: false })
      },

      clearTrail: () => set({ trail: [] }),

      setIntervalS: (seconds) => {
        if (!Number.isFinite(seconds) || seconds <= 0) return
        set({ intervalS: Math.round(seconds) })
      },

      once: () =>
        new Promise<Fix | null>((resolve) => {
          if (!navigator.geolocation) {
            set({ error: 'This browser does not support geolocation.' })
            resolve(null)
            return
          }
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const fix = toFix(pos)
              set({ fix, error: null })
              resolve(fix)
            },
            (err) => {
              set({ error: describe(err) })
              resolve(null)
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
          )
        }),
    }),
    {
      name: 'navmate-tracker',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Only the preference is kept. A trail restored on next launch would
      // look like the crew teleported between shifts.
      partialize: (s) => ({ intervalS: s.intervalS }),
    },
  ),
)
