import { create } from 'zustand'
import type { Fix } from '@/lib/types'

interface TrackerState {
  fix: Fix | null
  watching: boolean
  error: string | null
  /** Fixes from this session, newest last. Capped so a long shift cannot
   *  exhaust memory on a phone. */
  trail: Fix[]

  start: () => void
  stop: () => void
  clearTrail: () => void
  once: () => Promise<Fix | null>
}

const TRAIL_LIMIT = 2000
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

export const useTracker = create<TrackerState>((set, get) => ({
  fix: null,
  watching: false,
  error: null,
  trail: [],

  start: () => {
    if (!navigator.geolocation) {
      set({ error: 'This browser does not support geolocation.' })
      return
    }
    if (watchId !== null) return

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const fix = toFix(pos)
        const trail = [...get().trail, fix]
        set({
          fix,
          error: null,
          trail: trail.length > TRAIL_LIMIT ? trail.slice(-TRAIL_LIMIT) : trail,
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
}))
