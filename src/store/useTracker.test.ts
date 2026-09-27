import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/*
 * The tracker's clock stamping (finding R14): freshness is judged on the
 * phone's clock when a position ARRIVES, and a receiver repeating the same
 * position keeps the time it first arrived, so a frozen fix still goes stale.
 */

vi.hoisted(() => {
  const m = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
})

import { useTracker } from './useTracker'
import { isStale } from '@/lib/navigate'

let onPos: ((p: GeolocationPosition) => void) | null = null

function pos(ts: number, lat = 29.3, lon = -94.8): GeolocationPosition {
  return {
    timestamp: ts,
    coords: {
      latitude: lat,
      longitude: lon,
      accuracy: 5,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
  } as unknown as GeolocationPosition
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000_000)
  vi.stubGlobal('navigator', {
    geolocation: {
      watchPosition: (ok: (p: GeolocationPosition) => void) => {
        onPos = ok
        return 1
      },
      clearWatch: () => {},
    },
  })
  useTracker.getState().stop()
  useTracker.setState({ fix: null, raw: null, trail: [] })
})

afterEach(() => {
  useTracker.getState().stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useTracker — when a fix arrived', () => {
  it('stamps each position with the phone clock at arrival, whatever its own time says', () => {
    useTracker.getState().start()
    // GNSS time a minute behind the phone clock.
    onPos!(pos(Date.now() - 60_000))
    const fix = useTracker.getState().fix!
    expect(fix.receivedAt).toBe(Date.now())
    expect(isStale(fix)).toBe(false)
  })

  it('keeps the first arrival time for a position handed back again, so a frozen fix goes stale', () => {
    useTracker.getState().start()
    const t = Date.now() - 60_000
    onPos!(pos(t))
    const first = useTracker.getState().raw!.receivedAt
    vi.setSystemTime(Date.now() + 20_000)
    onPos!(pos(t)) // the same position, the same stamp: nothing new
    expect(useTracker.getState().raw!.receivedAt).toBe(first)
    expect(isStale(useTracker.getState().raw)).toBe(true)
  })
})
