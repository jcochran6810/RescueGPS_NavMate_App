import { describe, it, expect, vi } from 'vitest'

/*
 * rc3 F1 (critical): a short dog-leg on the Galveston chart, run at 25 kn
 * with an honest GPS and a quick helm that steers what the card says.
 *
 * The route turns at WP1 onto a 42 m leg about 15 m off land, and turns
 * again at WP2. The card used to steer AT WP1 ("round waypoint 1 first")
 * until 30 ft from it, then — one point a fix — show no course at all while
 * the boat was already inside WP2's circle, then "Round WP2 first 269°" to a
 * boat heading 000° six metres from the bank. It ran aground.
 *
 * Here the whole loop is closed: the real planner, store and card; a boat
 * that reads the card a second late and turns at 20°/s; perfect 1 Hz fixes.
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
const env = vi.hoisted(() => ({ boat: null as unknown }))
vi.mock('@/store/useChartData', async () => {
  const { create } = await import('zustand')
  const { loadGalveston } = await import('@/lib/__fixtures__/galveston')
  const f = loadGalveston()
  return {
    useChartData: create(() => ({
      status: 'ready',
      error: null,
      features: f,
      regions: [],
      covers: () => true,
      holds: () => true,
      load: async () => f,
    })),
  }
})
vi.mock('@/store/useVessels', async () => {
  const { create } = await import('zustand')
  return { useVessels: create(() => ({ active: () => env.boat })) }
})
vi.mock('@/store/useTeams', async () => {
  const { create } = await import('zustand')
  return { useTeams: create(() => ({ activeTeamId: null })) }
})

import { useNavigation } from '@/store/useNavigation'
import { useTracker } from '@/store/useTracker'
import { useChartData } from '@/store/useChartData'
import { navCardView } from '@/lib/navView'
import { chartStateAt, liveChartNear, type ChartFeatures } from '@/lib/routing'
import { metersPerDegree } from '@/lib/geo'
import type { Fix } from '@/lib/types'

const FROM = { lat: 29.316384754678378, lon: -94.7772218221964 }
const TO = { lat: 29.335859458561035, lon: -94.77046168824955 }

describe('R4 (rc3 F1): the 42 m dog-leg at 25 kn', () => {
  it('turns the boat round both corners without a blank card, a course astern, or touching the land', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const T0 = Date.UTC(2026, 8, 27, 12, 0, 0)
    vi.setSystemTime(T0)
    env.boat = { id: 'b', draft_m: 0.36, under_keel_margin_m: 0.24, clearance_m: 15, cruise_speed_kn: 26 }
    useTracker.setState({
      arrivalFt: 200,
      fix: { ...FROM, accuracy: 4, speed: 0, heading: null, altitude: null, timestamp: T0, receivedAt: T0 },
      watching: true,
      start: () => {},
    } as never)
    await useNavigation.getState().setDestination({ ...TO, label: 'D' }, null)
    const plan = useNavigation.getState().plan!
    expect(plan.source).toBe('charted')
    expect(useNavigation.getState().start()).toBe(true)

    const features = useChartData.getState().features as ChartFeatures
    const req = { features, from: FROM, to: TO, safeDepthM: 0.6, clearanceM: 15, approachM: 120 }
    const mpd = metersPerDegree(FROM.lat)
    let lat = FROM.lat
    let lon = FROM.lon
    let v = 12.86 // 25 kn
    let want = v
    // Pointed down the first leg, as a crew leaving the dock would be.
    const p1 = plan.points[1]
    let h = (Math.atan2((p1.lon - lon) * mpd.lon, (p1.lat - lat) * mpd.lat) * 180) / Math.PI
    let course: number | null = null
    let astern = 0
    let worstAstern = 0
    let minLand = Infinity
    let t = T0
    for (let s = 0; s < 600 && useNavigation.getState().status === 'navigating'; s++) {
      // A fix, the store, the card.
      t += 1000
      vi.setSystemTime(t)
      const fix: Fix = { lat, lon, accuracy: 4, speed: v, heading: (h + 360) % 360, altitude: null, timestamp: t, receivedAt: t }
      useNavigation.getState().onFix(fix)
      const st = useNavigation.getState()
      if (st.status !== 'navigating') break
      const card = navCardView({
        plan: st.plan!,
        status: 'navigating',
        targetIdx: st.targetIdx,
        fix,
        now: t,
        speedKn: 25,
        cruiseKn: 26,
        arrivalFt: 200,
        bearingPref: 'true',
        declination: null,
        gpsPoor: st.gpsPoor,
        rerouting: st.rerouting,
        offCourseSince: st.offCourseSince,
        roundIdx: st.roundIdx,
        roundAim: st.roundAim,
        turnSlow: st.turnSlow,
      })
      // Never a card with no course on it.
      expect(card.bearing, `t=${s}s ${card.title}`).not.toBeNull()
      const next = parseInt(card.bearing!, 10)
      const off = Math.abs(((next - h + 540) % 360) - 180)
      astern = off > 90 ? astern + 1 : 0
      worstAstern = Math.max(worstAstern, astern)
      // A crew told to slow down for the turn does (to half speed, a knot a
      // second off, as a planing boat comes off the plane); otherwise back up
      // to 25 kn.
      want = card.slowDown ? 6.4 : 12.86
      // The helm answers the card half a second later; 20°/s, 5 steps a second.
      for (let k = 0; k < 5; k++) {
        if (k >= 2 && course !== next) course = next
        if (course != null) {
          const d = ((course - h + 540) % 360) - 180
          h += Math.max(-4, Math.min(4, d))
        }
        v += Math.max(-0.3, Math.min(0.2, want - v))
        const rad = (h * Math.PI) / 180
        lat += (v * 0.2 * Math.cos(rad)) / mpd.lat
        lon += (v * 0.2 * Math.sin(rad)) / mpd.lon
        const here = { lat, lon }
        expect(chartStateAt(features, here), `on land at t=${s}.${k * 2}s`).not.toBe('land')
        // The stand-off, away from the dock stretches at each end (where the
        // route itself may pass closer, flagged).
        const dm = (a: { lat: number; lon: number }) =>
          Math.hypot((a.lat - lat) * mpd.lat, (a.lon - lon) * mpd.lon)
        if (dm(FROM) > 125 && dm(TO) > 125) {
          const near = liveChartNear(req as never, here, 15)
          if (near?.near?.land) {
            minLand = Math.min(minLand, near.near.distM)
          }
        }
      }
    }
    console.log('R4 closed loop: min land distance', minLand.toFixed(1), 'm; worst astern run', worstAstern, 's')
    // Arrived, the corners turned on the card's say-so.
    expect(useNavigation.getState().status).toBe('arrived')
    expect(worstAstern).toBeLessThanOrEqual(3)
    // Never inside the stand-off by more than a boat's helm can answer for.
    expect(minLand).toBeGreaterThan(15 - 1)
    vi.useRealTimers()
  }, 60_000)
})
