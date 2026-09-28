import { describe, it, expect, vi, beforeEach } from 'vitest'

/*
 * rc5 acceptance findings, at the store:
 *
 *   F3 — no "slow down for the turn" before a 90° turn near land at 25 kn on
 *        a confirmed best-effort route (the arc test only asked whether a
 *        turn meets the route's rules, which a best-effort route's own legs
 *        do not): now the plain geometry too — the run-on past the turn point
 *        at this speed against the room the chart leaves straight on;
 *   F8 — a 45° intercept from the far side of a line laid close along a bank
 *        pointed the boat at the bank within 100 m: the course to steer is
 *        checked along its line and a gentler (or steeper) one chosen;
 *   and re-routes back off instead of storming.
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
const env = vi.hoisted(() => ({ boat: null as unknown, features: null as unknown }))
vi.mock('@/store/useChartData', async () => {
  const { create } = await import('zustand')
  return {
    useChartData: create(() => ({
      status: 'ready',
      error: null,
      get features() {
        return env.features
      },
      regions: [],
      covers: () => true,
      holds: () => true,
      load: async () => env.features,
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

import {
  rerouteGapMs,
  useNavigation,
  REROUTE_MIN_GAP_MS,
  REROUTE_WINDOW_MS,
} from '@/store/useNavigation'
import { useTracker } from '@/store/useTracker'
import { navCardView } from '@/lib/navView'
import { loadGalveston } from '@/lib/__fixtures__/galveston'
import { metersPerDegree } from '@/lib/geo'
import { chartStateAt, type ChartFeatures, type RoutePlan, type Ring } from '@/lib/routing'
import type { Fix } from '@/lib/types'

const T0 = Date.UTC(2026, 8, 27, 12, 0, 0)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  useNavigation.getState().reset()
})

function mkFix(p: { lat: number; lon: number }, t: number, speed: number, heading: number): Fix {
  return { ...p, accuracy: 3, speed, heading, altitude: null, timestamp: t, receivedAt: t }
}

describe('F3: slow down for a tight turn near land — on any plan', () => {
  it('rc5 hc-157: best-effort route, 25 kn, 90° turn with land 42 m straight on — the card goes red before the turn', async () => {
    env.features = loadGalveston()
    env.boat = { id: 'b', draft_m: 1.36, under_keel_margin_m: 0.46, clearance_m: 40, cruise_speed_kn: 24.9 }
    const FROM = { lat: 29.357156, lon: -94.792919 }
    const TO = { lat: 29.333481, lon: -94.822254 }
    useTracker.setState({
      arrivalFt: 200,
      fix: mkFix(FROM, T0, 0, 0),
      watching: true,
      start: () => {},
    } as never)
    await useNavigation.getState().setDestination({ ...TO, label: 'D' }, null)
    const plan = useNavigation.getState().plan!
    expect(plan.source).toBe('best-effort')
    useNavigation.getState().confirmBestEffort()
    expect(useNavigation.getState().start()).toBe(true)
    const n = plan.points.length
    const turn = plan.points[n - 2]
    const before = plan.points[n - 3]
    // Run the leg into the last turn at 12.8 m/s (25 kn), from its start.
    const m = metersPerDegree(turn.lat)
    const dx = (turn.lon - before.lon) * m.lon
    const dy = (turn.lat - before.lat) * m.lat
    const L = Math.hypot(dx, dy)
    const hdg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
    useNavigation.setState({ targetIdx: n - 2, resume: false, roundIdx: null })
    let warned = false
    let t = T0
    for (let s = 0; s * 12.8 < L - 5; s++) {
      t += 1000
      vi.setSystemTime(t)
      const f = s * 12.8 / L
      const fix = mkFix({ lat: before.lat + f * (turn.lat - before.lat), lon: before.lon + f * (turn.lon - before.lon) }, t, 12.8, hdg)
      useNavigation.getState().onFix(fix)
      const st = useNavigation.getState()
      if (st.turnSlow) {
        const card = navCardView({
          plan: st.plan!, status: 'navigating', targetIdx: st.targetIdx, fix, now: t, speedKn: 25, cruiseKn: 25,
          arrivalFt: 200, bearingPref: 'true', declination: null, gpsPoor: false, rerouting: false,
          offCourseSince: null, roundIdx: st.roundIdx, roundAim: st.roundAim, turnSlow: st.turnSlow, guide: st.guide,
        })
        expect(card.slowDown).toBe(true)
        expect(card.slowText).toBe('Slow down for the turn')
        warned = true
        break
      }
    }
    expect(warned).toBe(true)
  }, 60_000)
})

describe('F8: the course to steer never points at the bank', () => {
  it('from 30 m the far side of a line laid 20 m off a bank, at 10 kn: a gentler intercept, clear for 100 m', async () => {
    // Open water; a bank from x = 0 eastward; the route runs north 20 m west of it.
    const base = { lat: 29.3, lon: -94.8 }
    const mpd = metersPerDegree(base.lat)
    const at = (x: number, y: number) => ({ lat: base.lat + y / mpd.lat, lon: base.lon + x / mpd.lon })
    const ll = (x: number, y: number): [number, number] => {
      const p = at(x, y)
      return [p.lon, p.lat]
    }
    const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)]
    const features = {
      depthAreas: [{ minDepthM: 10, rings: [rect(-8000, -8000, 8000, 8000)] }],
      channels: [],
      land: [{ rings: [rect(0, -3000, 800, 3000)] }],
      hazards: [],
      lines: [],
      coverage: 'full',
    } as ChartFeatures
    env.features = features
    env.boat = { id: 'b', draft_m: 1, under_keel_margin_m: 0.5, clearance_m: 5, cruise_speed_kn: 10 }
    const FROM = at(-20, -2500)
    const TO = at(-20, 2500)
    useTracker.setState({ arrivalFt: 150, fix: mkFix(FROM, T0, 0, 0), watching: true, start: () => {} } as never)
    await useNavigation.getState().setDestination({ ...TO, label: 'D' }, null)
    const plan = useNavigation.getState().plan!
    expect(plan.source).toBe('charted')
    expect(useNavigation.getState().start()).toBe(true)
    // Settle on the leg, then a fix 30 m to the west of it, making 5 m/s north.
    let t = T0
    for (const y of [-2400, -2395]) {
      t += 1000
      vi.setSystemTime(t)
      useNavigation.getState().onFix(mkFix(at(-20, y), t, 5, 0))
    }
    t += 1000
    vi.setSystemTime(t)
    const fix = mkFix(at(-50, -1000), t, 5, 0)
    useNavigation.getState().onFix(fix)
    const st = useNavigation.getState()
    expect(st.guide?.fixAt).toBe(t)
    expect(st.guide?.lookaheadM).not.toBeNull()
    const card = navCardView({
      plan: st.plan!, status: 'navigating', targetIdx: st.targetIdx, fix, now: t, speedKn: 10, cruiseKn: 10,
      arrivalFt: 150, bearingPref: 'true', declination: null, gpsPoor: false, rerouting: false,
      offCourseSince: null, guide: st.guide,
    })
    const c = (Number(/^(\d{3})/.exec(card.bearing ?? '')?.[1]) * Math.PI) / 180
    for (let d = 2; d <= 100; d += 2) {
      const q = at(-50 + d * Math.sin(c), -1000 + d * Math.cos(c))
      expect(chartStateAt(features, q)).not.toBe('land')
    }
    // Without the check it would have been the 45° intercept, into the bank.
    const plain = navCardView({
      plan: st.plan!, status: 'navigating', targetIdx: st.targetIdx, fix, now: t, speedKn: 10, cruiseKn: 10,
      arrivalFt: 150, bearingPref: 'true', declination: null, gpsPoor: false, rerouting: false, offCourseSince: null,
    })
    expect(plain.bearing).toBe('045°T')
  }, 60_000)
})

describe('re-routes back off', () => {
  // rc6 (intended): at most two automatic re-routes in any two minutes, 20 s
  // apart — the doubling back-off (20, 40, 45 s) still let four through in
  // 105 s, and the rc3 harness counts three in two minutes as a storm.
  it('20 s after one; after two within two minutes, not until the older is two minutes behind', () => {
    const now = T0 + 1_000_000
    expect(rerouteGapMs([], now)).toBe(REROUTE_MIN_GAP_MS)
    expect(rerouteGapMs([now - 30_000], now)).toBe(20_000)
    // Two, at −60 s and −30 s: the third waits until the first is 121 s old,
    // i.e. 91 s after the last.
    expect(rerouteGapMs([now - 60_000, now - 30_000], now)).toBe(91_000)
    // Two, 100 s apart: 20 s after the last is enough.
    expect(rerouteGapMs([now - 130_000, now - 30_000], now)).toBe(20_000)
    // Old ones no longer count.
    expect(rerouteGapMs([now - 200_000, now - 150_000, now - 30_000], now)).toBe(20_000)
    // Whatever the history, three never fall within two minutes.
    const log: number[] = []
    let t = 0
    for (let k = 0; k < 10; k++) {
      t = log.length ? log[log.length - 1] + rerouteGapMs(log, t) : 0
      log.push(t)
    }
    for (let i = 2; i < log.length; i++) expect(log[i] - log[i - 2]).toBeGreaterThan(REROUTE_WINDOW_MS)
  })
})

describe('a boat that turns slowly is told to slow down for a turn a brisk one makes (rc6)', () => {
  // Deep water; the route runs north to a turn point T, then 75° to the
  // right. A 0.5 m bank lies north of T, 120 m on: clear of the straight
  // run-on of a boat turning at 12°/s a second and a half after the card
  // asks (75 m at 11.6 m/s), but across the arc of one that answers after
  // four seconds and comes round at 6°/s.
  const base = { lat: 29.3, lon: -94.8 }
  const mpd = metersPerDegree(base.lat)
  const at = (x: number, y: number) => ({ lat: base.lat + y / mpd.lat, lon: base.lon + x / mpd.lon })
  const ll = (x: number, y: number): [number, number] => {
    const p = at(x, y)
    return [p.lon, p.lat]
  }
  const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)]
  const features = {
    depthAreas: [
      { minDepthM: 10, rings: [rect(-8000, -8000, 8000, 8000)] },
      { minDepthM: 0.5, rings: [rect(-300, 120, 60, 500)] },
    ],
    channels: [],
    land: [],
    hazards: [],
    lines: [],
    coverage: 'full',
  } as ChartFeatures
  const A = at(0, -2000)
  const T = at(0, 0)
  const B = at(2000 * Math.sin((75 * Math.PI) / 180), 2000 * Math.cos((75 * Math.PI) / 180))
  const leg = { caution: 'ok', minChartedDepthM: 10, minClearanceM: 500 } as unknown as RoutePlan['legs'][number]
  const plan = {
    points: [A, T, B],
    legs: [leg, leg],
    totalNM: 4000 / 1852,
    hours: 0.2,
    source: 'charted',
    coverage: 'full',
    warnings: [],
    movedStart: null,
    movedEnd: null,
    outsideChannelNM: null,
    arrivalFt: [150, 150, 150],
    failure: null,
    needsConfirm: false,
  } as RoutePlan

  const run = (turnRec: unknown) => {
    env.features = features
    useNavigation.setState({
      dest: { ...B, label: 'B' },
      plan,
      status: 'navigating',
      targetIdx: 1,
      confirmed: true,
      plannedFor: { safeDepthM: 1.5, clearanceM: 10, speedKn: 22.6 },
      departure: A,
      resume: false,
      turnRec: turnRec as never,
    })
    let warned = false
    let t = T0
    // Up the leg at 11.6 m/s (22.6 kn), from 400 m short of T.
    for (let y = -400; y < -60; y += 11.6) {
      t += 1000
      vi.setSystemTime(t)
      useNavigation.getState().onFix(mkFix(at(0, y), t, 11.6, 0))
      if (useNavigation.getState().turnSlow) warned = true
    }
    return warned
  }

  it('the assumed brisk boat: no warning', () => {
    expect(run(null)).toBe(false)
  })

  it('a boat seen answering in 4 s and turning at 6°/s: "slow down for the turn"', () => {
    expect(run({ dps: 6, reactS: 4, n: 3, ep: null })).toBe(true)
  })
})

describe('F6: the lookahead is shortened when well off the line near shallows or land (rc6)', () => {
  const base = { lat: 29.3, lon: -94.8 }
  const mpd = metersPerDegree(base.lat)
  const at = (x: number, y: number) => ({ lat: base.lat + y / mpd.lat, lon: base.lon + x / mpd.lon })
  const ll = (x: number, y: number): [number, number] => {
    const p = at(x, y)
    return [p.lon, p.lat]
  }
  const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)]
  const withBankAt = (x: number) =>
    ({
      depthAreas: [{ minDepthM: 10, rings: [rect(-8000, -8000, 8000, 8000)] }],
      channels: [],
      land: [{ rings: [rect(x, -3000, x + 800, 3000)] }],
      hazards: [],
      lines: [],
      coverage: 'full',
    }) as ChartFeatures

  const lookaheadWith = async (bankX: number, offX: number) => {
    env.features = withBankAt(bankX)
    env.boat = { id: 'b', draft_m: 1, under_keel_margin_m: 0.5, clearance_m: 10, cruise_speed_kn: 20 }
    const FROM = at(0, -2500)
    const TO = at(0, 2500)
    useTracker.setState({ arrivalFt: 150, fix: mkFix(FROM, T0, 0, 0), watching: true, start: () => {} } as never)
    await useNavigation.getState().setDestination({ ...TO, label: 'D' }, null)
    expect(useNavigation.getState().plan!.source).toBe('charted')
    expect(useNavigation.getState().start()).toBe(true)
    let t = T0
    for (const y of [-2400, -2390]) {
      t += 1000
      vi.setSystemTime(t)
      useNavigation.getState().onFix(mkFix(at(0, y), t, 10.3, 0))
    }
    t += 1000
    vi.setSystemTime(t)
    useNavigation.getState().onFix(mkFix(at(offX, -1000), t, 10.3, 0))
    return useNavigation.getState().guide
  }

  it('20 m off the line, the bank 60 m beyond it: a shorter lookahead than the speed\'s own 62 m', async () => {
    const g = await lookaheadWith(60, -20)
    expect(g?.hazardNear).toBe(true)
    expect(g?.lookaheadM).not.toBeNull()
    expect(g!.lookaheadM!).toBeLessThan(50)
  }, 60_000)

  it('the same with no bank near: the speed\'s own', async () => {
    const g = await lookaheadWith(1500, -20)
    expect(g?.hazardNear).toBe(false)
    expect(g?.lookaheadM).toBeNull()
  }, 60_000)

  it('on the line near the bank: the speed\'s own', async () => {
    const g = await lookaheadWith(60, -3)
    expect(g?.lookaheadM).toBeNull()
  }, 60_000)
})

describe('"shallows ahead on your heading" counts a heading that grazes the bank (rc6)', () => {
  it('45° off course at 10 m/s, the line passing 4 m from a jetty 60 m on: red', async () => {
    const base = { lat: 29.3, lon: -94.8 }
    const mpd = metersPerDegree(base.lat)
    const at = (x: number, y: number) => ({ lat: base.lat + y / mpd.lat, lon: base.lon + x / mpd.lon })
    const ll = (x: number, y: number): [number, number] => {
      const p = at(x, y)
      return [p.lon, p.lat]
    }
    const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)]
    env.features = {
      depthAreas: [{ minDepthM: 10, rings: [rect(-8000, -8000, 8000, 8000)] }],
      channels: [],
      land: [{ rings: [rect(-39, -955, -20, -935)] }],
      hazards: [],
      lines: [],
      coverage: 'full',
    } as ChartFeatures
    env.boat = { id: 'b', draft_m: 1, under_keel_margin_m: 0.5, clearance_m: 10, cruise_speed_kn: 20 }
    useTracker.setState({ arrivalFt: 150, fix: mkFix(at(0, -2500), T0, 0, 0), watching: true, start: () => {} } as never)
    await useNavigation.getState().setDestination({ ...at(0, 2500), label: 'D' }, null)
    expect(useNavigation.getState().plan!.source).toBe('charted')
    expect(useNavigation.getState().start()).toBe(true)
    let t = T0
    for (const y of [-1030, -1020, -1010]) {
      t += 1000
      vi.setSystemTime(t)
      useNavigation.getState().onFix(mkFix(at(0, y), t, 10, 0))
    }
    expect(useNavigation.getState().guide?.dangerAhead).toBe(false)
    t += 1000
    vi.setSystemTime(t)
    useNavigation.getState().onFix(mkFix(at(0, -1000), t, 10, 315))
    expect(useNavigation.getState().guide?.dangerAhead).toBe(true)
  }, 60_000)
})
