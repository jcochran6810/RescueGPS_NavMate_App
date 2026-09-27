import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/*
 * Steering regressions found by the independent rc3 voyage harness, each
 * reproduced on a plain chart of open water (10 m everywhere), so the only
 * thing under test is the store's and the card's handling of the fixes:
 *
 *   - R1 (F2): an automatic re-route fired on a boat exactly on the line,
 *     after every early switch at slow speed;
 *   - R3 (F6): no course on the card at a mark while the store waits for a
 *     settling fix before switching;
 *   - R6 (F3): a turn point passed wider than 200 ft during a GPS dropout
 *     left the card pointing dead astern until a re-route;
 *   - F7: a frozen fix shown as live for 15 s at 25 kn;
 *   - F9: the ETA worked at a speed crawling up from 0 for a minute.
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

vi.mock('@/store/useChartData', async () => {
  const { create } = await import('zustand')
  const L0 = 29.33
  const O0 = -94.8
  const q = (x: number, y: number) => [O0 + x / 96990, L0 + y / 110860]
  const ring = [q(-12000, -12000), q(12000, -12000), q(12000, 12000), q(-12000, 12000), q(-12000, -12000)]
  const sea = {
    depthAreas: [{ minDepthM: 10, rings: [ring] }],
    channels: [],
    land: [],
    hazards: [],
    lines: [],
    coverage: 'full',
  }
  // A load that never answers: a re-route stays "in flight", where a test
  // can see that it started.
  return {
    useChartData: create(() => ({
      status: 'ready',
      error: null,
      features: sea,
      regions: [],
      covers: () => false,
      holds: () => false,
      load: () => new Promise(() => {}),
    })),
  }
})
vi.mock('@/store/useVessels', async () => {
  const { create } = await import('zustand')
  const boat = { id: 'b', draft_m: 0.5, under_keel_margin_m: 0.5, clearance_m: 5, cruise_speed_kn: 5 }
  return { useVessels: create(() => ({ boat, active: () => boat })) }
})
vi.mock('@/store/useTeams', async () => {
  const { create } = await import('zustand')
  return { useTeams: create(() => ({ activeTeamId: null })) }
})

import { useNavigation } from '@/store/useNavigation'
import { useTracker } from '@/store/useTracker'
import { navCardView, type NavCardView } from '@/lib/navView'
import type { RoutePlan } from '@/lib/routing'
import type { Fix } from '@/lib/types'

const LAT0 = 29.33
const LON0 = -94.8
const P = (x: number, y: number) => ({ lat: LAT0 + y / 110860, lon: LON0 + x / 96990 })
const T0 = Date.UTC(2026, 8, 27, 12, 0, 0)

function plan(points: { lat: number; lon: number }[], arrivalFt: number): RoutePlan {
  return {
    points,
    legs: points.slice(1).map(() => ({ caution: 'ok' })) as never,
    totalNM: 1,
    hours: 0.2,
    source: 'charted',
    coverage: 'full',
    warnings: [],
    movedStart: null,
    movedEnd: null,
    outsideChannelNM: null,
    arrivalFt: points.map(() => arrivalFt),
    failure: null,
    needsConfirm: false,
  } as unknown as RoutePlan
}

function steer(p: RoutePlan, clearanceM: number, speedKn: number) {
  const last = p.points[p.points.length - 1]
  useNavigation.setState({
    status: 'navigating',
    plan: p,
    targetIdx: 1,
    resume: false,
    roundIdx: null,
    roundAim: null,
    plannedFor: { safeDepthM: 1, clearanceM, speedKn },
    dest: { ...last, label: 'D' },
    offCourseSince: null,
    lastRerouteAt: null,
    reroutes: 0,
    lastFixAt: null,
    rerouting: false,
    speedKn: null,
    progressLog: [],
  })
}

function fixAt(x: number, y: number, k: number, extra: Partial<Fix> = {}): Fix {
  const t = T0 + k * 1000
  return {
    ...P(x, y),
    accuracy: 4,
    speed: null,
    heading: null,
    altitude: null,
    timestamp: t,
    receivedAt: t,
    ...extra,
  }
}

function card(fix: Fix, now = fix.receivedAt ?? fix.timestamp): NavCardView {
  const s = useNavigation.getState()
  return navCardView({
    plan: s.plan!,
    status: 'navigating',
    targetIdx: s.targetIdx,
    fix,
    now,
    speedKn: s.speedKn,
    cruiseKn: 20,
    arrivalFt: 200,
    bearingPref: 'true',
    declination: null,
    gpsPoor: s.gpsPoor,
    rerouting: s.rerouting,
    offCourseSince: s.offCourseSince,
    roundIdx: s.roundIdx,
    roundAim: s.roundAim,
  })
}

const brg = (v: NavCardView) => (v.bearing ? parseInt(v.bearing, 10) : null)
const off = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  useNavigation.getState().clear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('R1 (rc3 F2): no re-route for a boat exactly on the line after an early switch', () => {
  it('judges off course against the route round the turn, not the new leg ahead of the boat', () => {
    useTracker.setState({ arrivalFt: 200 })
    // Due north 1000 m, a 6° turn, north again; 5 kn, a 5 m stand-off, 200 ft circles.
    steer(plan([P(0, 0), P(0, 1000), P(100, 2000)], 200), 5, 5)
    const v = 2.57
    for (let k = 0; k <= 40; k++) {
      vi.setSystemTime(T0 + k * 1000)
      useNavigation.getState().onFix(fixAt(0, 880 + v * k, k, { speed: v, heading: 0, accuracy: 3 }))
      const s = useNavigation.getState()
      expect(s.offCourseSince, `t=${k}s`).toBeNull()
    }
    const s = useNavigation.getState()
    // Switched at the circle, 200 ft short of the turn, and never re-routed.
    expect(s.targetIdx).toBe(2)
    expect(s.reroutes).toBe(0)
    expect(s.rerouting).toBe(false)
  })

  it('still re-routes a boat that really left the route', () => {
    useTracker.setState({ arrivalFt: 200 })
    steer(plan([P(0, 0), P(0, 1000), P(100, 2000)], 200), 5, 5)
    for (let k = 0; k <= 12; k++) {
      vi.setSystemTime(T0 + k * 1000)
      // 80 m east of the first leg, running north.
      useNavigation.getState().onFix(fixAt(80, 300 + 2.57 * k, k, { speed: 2.57, heading: 0, accuracy: 3 }))
    }
    expect(useNavigation.getState().reroutes).toBe(1)
  })
})

describe('off the route with the point astern (rc3 F3; iter drift-fast)', () => {
  it('re-routes after 3 s a boat that has run on past the point it steers for', () => {
    useTracker.setState({ arrivalFt: 200 })
    steer(plan([P(0, 0), P(0, 1000), P(1000, 1000)], 200), 5, 5)
    // 100 m beyond B and 80 m wide of it, still heading north: B is astern.
    for (let k = 0; k <= 4; k++) {
      vi.setSystemTime(T0 + k * 1000)
      useNavigation.getState().onFix(fixAt(-80, 1100 + 2 * k, k, { speed: 2, heading: 0, accuracy: 3 }))
    }
    expect(useNavigation.getState().targetIdx).toBe(1)
    expect(useNavigation.getState().reroutes).toBe(1)
  })

  it('waits the usual 10 s for a boat set off abeam of the leg, not past its point', () => {
    useTracker.setState({ arrivalFt: 200 })
    steer(plan([P(0, 0), P(0, 1000), P(1000, 1000)], 200), 5, 5)
    // Swept off to the west-south-west, halfway along the first leg: B is
    // behind the way it is being set, but the boat has not run past it.
    // Re-routed mid-set, it was off the new route before the set was over,
    // and re-routed again 20 s later.
    for (let k = 0; k <= 11; k++) {
      vi.setSystemTime(T0 + k * 1000)
      useNavigation.getState().onFix(fixAt(-120 - 3 * k, 500 - k, k, { speed: 3, heading: 250, accuracy: 3 }))
      if (k === 6) expect(useNavigation.getState().reroutes, 'after 6 s').toBe(0)
    }
    expect(useNavigation.getState().reroutes).toBe(1)
  })
})

describe('R3 (rc3 F6): a course on the card at every mark', () => {
  it('shows the course of the leg while a settling fix inside the circle is not switched on', () => {
    useTracker.setState({ arrivalFt: 150 })
    steer(plan([P(0, 0), P(0, 1000), P(600, 2000)], 150), 30, 20)
    const f = fixAt(0, 975, 0, { speed: 10, heading: 0, accuracy: 5, settling: true })
    useNavigation.getState().onFix(f)
    const s = useNavigation.getState()
    expect(s.targetIdx).toBe(1)
    const v = card(f)
    // Inside the circle — but the card does not claim "at the mark" on a fix
    // the store will not switch on.
    expect(v.inCircle).toBe(true)
    expect(v.atMark).toBe(false)
    // Before: no course at all — the helm held whatever it had.
    expect(v.bearing).toBe('000°T')
    // The point's own bearing is still given (the store has not switched).
    expect(v.pointBearing).not.toBeNull()
  })
})

describe('R3 at the destination (rc3 dock-15)', () => {
  it('steers for the destination inside its circle, not along the last leg', () => {
    useTracker.setState({ arrivalFt: 200 })
    steer(plan([P(0, 0), P(0, 1000)], 200), 30, 20)
    // 50 m from it, come in at an angle to the last leg (which runs 000°).
    const f = fixAt(-40, 970, 0, { speed: 6, heading: 53 })
    const v = card(f)
    expect(v.inCircle).toBe(true)
    // Before: 000°T — the last leg's course, 53° off the way to the end.
    expect(off(brg(v)!, 53)).toBeLessThan(3)
  })
})

describe('R6 (rc3 F3): a turn point passed wide in a dropout', () => {
  it('moves on to the next leg ahead instead of pointing the card astern', () => {
    useTracker.setState({ arrivalFt: 200 })
    // North to B, then a right angle east.
    steer(plan([P(0, 0), P(0, 1000), P(1000, 1000)], 200), 30, 25)
    const v = 12.7
    vi.setSystemTime(T0)
    useNavigation.getState().onFix(fixAt(0, 918, 0, { speed: v, heading: 0 }))
    expect(useNavigation.getState().targetIdx).toBe(1)
    // 14 s with no fix: the boat runs on north through B, 108 m past it.
    // Then the fixes are back, and the helm follows the card: it reads it
    // once a second and turns toward it at 20°/s.
    let x = 0
    let y = 918 + 14 * v
    let h = 0
    let asternRun = 0
    let worst = 0
    for (let k = 15; k <= 45; k++) {
      vi.setSystemTime(T0 + k * 1000)
      const f = fixAt(x, y, k, { speed: v, heading: h })
      useNavigation.getState().onFix(f)
      if (k === 15) expect(useNavigation.getState().targetIdx).toBe(2)
      const c = brg(card(f))
      expect(c, `t=${k}s course`).not.toBeNull()
      asternRun = off(c!, h) > 90 ? asternRun + 1 : 0
      worst = Math.max(worst, asternRun)
      const turn = ((c! - h + 540) % 360) - 180
      h = (h + Math.max(-20, Math.min(20, turn)) + 360) % 360
      x += v * Math.sin((h * Math.PI) / 180)
      y += v * Math.cos((h * Math.PI) / 180)
    }
    // On to the next point at once — past the turn on both legs is gone
    // round — and the card never pointed back at B: the course back to the
    // leg out is a hard turn for a boat run on north, not a U-turn, and it
    // is behind the beam for no more than the turn takes.
    expect(worst).toBeLessThanOrEqual(3)
    // …and the boat is back on the leg out, running east.
    expect(Math.abs(y - 1000)).toBeLessThan(30)
    expect(off(h, 90)).toBeLessThan(20)
  })
})

describe('F7: a frozen fix at speed', () => {
  it('runs the position on between fixes, with the error growing, and greys the card within 60 m of run', () => {
    useTracker.setState({ arrivalFt: 200 })
    steer(plan([P(0, 0), P(0, 2000), P(1000, 2000)], 200), 30, 25)
    const f = fixAt(0, 500, 0, { speed: 12.7, heading: 0 })
    useNavigation.getState().onFix(f)
    const at0 = card(f, f.timestamp)
    const at3 = card(f, f.timestamp + 3000)
    // Three seconds on at 12.7 m/s: 38 m nearer the point, and the card says
    // the position is an estimate.
    const nm = (s: string) => parseFloat(s)
    expect(nm(at0.distance) - nm(at3.distance)).toBeCloseTo((12.7 * 3) / 1852, 2)
    expect(at3.stale).toBe(false)
    expect(at3.notices.some((n) => n.kind === 'estimated')).toBe(true)
    // At 25 kn, 60 m of run is under 5 s: grey from 5 s, not 15.
    expect(card(f, f.timestamp + 4_500).stale).toBe(false)
    expect(card(f, f.timestamp + 5_500).stale).toBe(true)
  })
})

describe('F7: dead reckoning between fixes does not chase its own position (rc3 dropturn-0)', () => {
  it('keeps the course from the last fix while the distance runs on', () => {
    useTracker.setState({ arrivalFt: 200 })
    steer(plan([P(0, 0), P(0, 2000), P(1000, 2000)], 200), 30, 25)
    // On the line, heading 30° right of it (the helm answering a cue).
    const f = fixAt(0, 500, 0, { speed: 12.7, heading: 30 })
    useNavigation.getState().onFix(f)
    const at1 = card(f, f.timestamp + 1000)
    const at4 = card(f, f.timestamp + 4000)
    // Before: the course was worked again from the run-on position — 40 m
    // right of the line after 4 s straight on at 30° — and swung further
    // left each second, while a helm following the card had already turned.
    expect(at4.bearing).toBe(at1.bearing)
    // The distance still runs on…
    expect(parseFloat(at4.distance)).toBeLessThan(parseFloat(at1.distance))
    // …and the "N ft off the line" cue, a measurement, is not made up.
    expect(at4.backOnLine).toBeNull()
  })

  it('turns onto the leg on when the run-on carries the boat past the mark', () => {
    useTracker.setState({ arrivalFt: 200 })
    steer(plan([P(0, 0), P(0, 1000), P(1000, 1000)], 200), 30, 25)
    const f = fixAt(0, 900, 0, { speed: 12.7, heading: 0 })
    useNavigation.getState().onFix(f)
    // 4 s on at 12.7 m/s: 51 m past B — its circle is 61 m, so still inside;
    // the course is the leg's either way, never back at B.
    const c = card(f, f.timestamp + 4500)
    expect(c.stale).toBe(false)
    expect(off(brg(c)!, 0) <= 90).toBe(true)
  })
})

describe('F9: the speed for the ETA, getting under way', () => {
  it('takes the boat’s speed as soon as it makes way, not crawling up from 0', () => {
    useTracker.setState({ arrivalFt: 200 })
    steer(plan([P(0, 0), P(0, 5000)], 200), 30, 20)
    // Stopped at the start, then 1 m/s² up to 10 m/s.
    let y = 0
    for (let k = 0; k <= 15; k++) {
      vi.setSystemTime(T0 + k * 1000)
      const v = k < 3 ? 0 : Math.min(10, k - 2)
      y += v
      useNavigation.getState().onFix(fixAt(0, y, k, { speed: v, heading: v > 0 ? 0 : null }))
    }
    const kn = useNavigation.getState().speedKn!
    // 10 m/s is 19.4 kn; a 15 s smoothing from 0 read under 10 kn here.
    expect(kn).toBeGreaterThan(17)
  })
})
