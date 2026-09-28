import { describe, it, expect } from 'vitest'
import { depthWords, navBannerView, navCardView, type NavCardInput } from './navView'
import { loadGalveston } from './__fixtures__/galveston'
import { chartStateAt, planRoute } from './routing'

/*
 * rc5 F1 (major): the card mis-steered through a GPS dropout at speed — five
 * groundings on honest GPS with a helm that steers exactly what the card says.
 *
 *   R1  a stale card held a 45° intercept course indefinitely: the boat
 *       crossed the line and ran on into the bank beyond it;
 *   R2  the course flipped back and forth as the card went from "estimated"
 *       to "stale" (074 → 008 → 074), and the title and distance jumped;
 *   R3  with the fix 2–3 s old the dead-reckoned position entered the 200 ft
 *       circle and the card switched to the next waypoint with the boat still
 *       ~200 ft short — round the "Round waypoint N first" guard, into the
 *       side of the slip.
 *
 * Now: nothing is switched on an estimated position; while estimating the
 * card holds the course of the leg itself (never an intercept), the same
 * whether the fix is seconds late or stale; and moving near hazards it goes
 * red — "Slow down — GPS lost".
 */

const M_LAT = 110850
const M_LON = 97000
const O = { lat: 29.3, lon: -94.8 }
const at = (x: number, y: number) => ({ lat: O.lat + y / M_LAT, lon: O.lon + x / M_LON })
const r = (d: number) => (d * Math.PI) / 180
const base = {
  status: 'navigating' as const,
  speedKn: 28,
  cruiseKn: 28,
  arrivalFt: 150,
  bearingPref: 'true' as const,
  declination: null,
  gpsPoor: false,
  rerouting: false,
  offCourseSince: null,
}
const t0 = 1_800_000_000_000
const deg = (s: string | null) => (s == null ? null : Number(/^(\d{3})/.exec(s)?.[1]))

describe('R1: a stale card steers the leg, not an intercept', () => {
  // Leg A→B on 053°T; the boat 30 m right of it at 28 kn.
  const A = at(0, 0)
  const B = at(3000 * Math.sin(r(53)), 3000 * Math.cos(r(53)))
  const plan = { points: [A, B], arrivalFt: [150, 150] }
  const nx = Math.cos(r(53))
  const ny = -Math.sin(r(53))
  const p = at(500 * Math.sin(r(53)) + 30 * nx, 500 * Math.cos(r(53)) + 30 * ny)
  const fix = { ...p, accuracy: 4, speed: 14.4, heading: 53, timestamp: t0, receivedAt: t0 }

  it('live: back onto the line, gently at speed (speed-scaled lookahead, F6)', () => {
    const v = navCardView({ ...base, plan, targetIdx: 1, fix, now: t0 })
    const c = deg(v.bearing)!
    // 30 m off with ~86 m of lookahead: about 19° in, not 45°.
    expect(Math.abs(((c - 53 + 540) % 360) - 180)).toBeLessThan(25)
    expect(v.slowDown).toBe(false)
  })

  it('3–18 s without a fix: the leg course, 053°T, and "Slow down — GPS lost"', () => {
    for (const dt of [3, 6, 12, 18]) {
      const v = navCardView({ ...base, plan, targetIdx: 1, fix, now: t0 + dt * 1000 })
      expect(v.bearing).toBe('053°T')
      expect(v.slowDown).toBe(true)
      expect(v.slowText).toBe('Slow down — GPS lost')
      expect(v.notices.map((n) => n.kind)).toContain('gps-lost')
      // No turn cue from a course over the ground seconds old.
      expect(v.turn).toBeNull()
    }
    const banner = navBannerView(navCardView({ ...base, plan, targetIdx: 1, fix, now: t0 + 6000 }))
    expect(banner.status).toMatch(/Slow down — GPS lost/)
  })

  it('not red when the store saw nothing near (guide.hazardNear false), nor when not moving', () => {
    const guide = { fixAt: t0, lookaheadM: null, setDeg: 0, hazardNear: false }
    const v = navCardView({ ...base, plan, targetIdx: 1, fix, now: t0 + 6000, guide })
    expect(v.slowDown).toBe(false)
    expect(v.bearing).toBe('053°T')
    const still = navCardView({ ...base, speedKn: 0, plan, targetIdx: 1, fix: { ...fix, speed: 0.2 }, now: t0 + 6000 })
    expect(still.slowDown).toBe(false)
  })
})

describe('R2: no flip-back as the card goes from estimated to stale', () => {
  // A → T on 074°, then T → C on 008° (66° to port); the boat 40 m short of T.
  const A = at(0, 0)
  const T = at(1000 * Math.sin(r(74)), 1000 * Math.cos(r(74)))
  const C = at(1000 * Math.sin(r(74)) + 800 * Math.sin(r(8)), 1000 * Math.cos(r(74)) + 800 * Math.cos(r(8)))
  const plan = { points: [A, T, C], arrivalFt: [150, 150, 150] }
  const fix = { ...at(960 * Math.sin(r(74)), 960 * Math.cos(r(74))), accuracy: 4, speed: 14.4, heading: 74, timestamp: t0, receivedAt: t0 }

  it('the same title and course from 2 s to 10 s; the distance runs on smoothly, then holds — never back to the last fix', () => {
    const ft: number[] = []
    const times = [2, 3, 4, 5, 6, 8, 10]
    for (const dt of times) {
      const v = navCardView({ ...base, plan, targetIdx: 1, fix, now: t0 + dt * 1000 })
      expect(v.title).toBe('To waypoint 1 of 2')
      expect(v.bearing).toBe('074°T')
      const m = /^(\d+) ft$/.exec(v.distance)
      expect(m).not.toBeNull()
      ft.push(Number(m![1]))
    }
    // Continuous: no step bigger than the run between two readings.
    for (let i = 1; i < ft.length; i++) {
      const runFt = 14.4 * (times[i] - times[i - 1]) * 3.281
      expect(Math.abs(ft[i] - ft[i - 1])).toBeLessThanOrEqual(runFt + 10)
    }
    // Once stale (5 s) the position stops running on, where it had got to —
    // it does not snap back to the last fix's 131 ft.
    expect(ft.slice(3)).toEqual([ft[3], ft[3], ft[3], ft[3]])
  })
})

describe('R3: nothing switched on a dead-reckoned position (Galveston slip A)', () => {
  it('holds waypoint 1 and its leg course while the fix is 2–5 s old', () => {
    const f = loadGalveston()
    const plan = planRoute({
      from: { lat: 29.307225, lon: -94.815598 },
      to: { lat: 29.314216, lon: -94.785633 },
      safeDepthM: 1.2,
      clearanceM: 15,
      speedKn: 10,
      features: f,
      arrivalFt: 200,
    })
    expect(plan.source).toBe('charted')
    const fix = { lat: 29.308131, lon: -94.815666, accuracy: 5, speed: 5.1, heading: 353, timestamp: t0, receivedAt: t0 }
    const input = (dt: number): NavCardInput => ({
      ...base,
      speedKn: 10,
      cruiseKn: 10,
      arrivalFt: 200,
      plan,
      targetIdx: 1,
      fix,
      now: t0 + dt * 1000,
    })
    const live = navCardView(input(0))
    expect(live.title).toMatch(/^To waypoint 1 of/)
    for (const dt of [2, 3, 5]) {
      const v = navCardView(input(dt))
      expect(v.title).toBe(live.title)
      expect(v.targetIdx).toBe(1)
      // Where the boat really is (it ran on at 353°), nothing but water for
      // 40 m along the course the card now gives.
      const run = 5.1 * dt
      const here = {
        lat: fix.lat + (run * Math.cos(r(353))) / 110850,
        lon: fix.lon + (run * Math.sin(r(353))) / 97000,
      }
      const c = deg(v.bearing)!
      for (let d = 2; d <= 40; d += 2) {
        const q = { lat: here.lat + (d * Math.cos(r(c))) / 110850, lon: here.lon + (d * Math.sin(r(c))) / 97000 }
        expect(chartStateAt(f, q)).not.toBe('land')
      }
    }
  }, 60_000)
})

describe('the store\'s steering guide on the card', () => {
  const A = at(0, 0)
  const B = at(0, 3000)
  const plan = { points: [A, B], arrivalFt: [150, 150] }
  const fix = { ...at(20, 500), accuracy: 4, speed: 5, heading: 0, timestamp: t0, receivedAt: t0 }

  it('uses its lookahead and set allowance for the fix it was worked for, and not for another', () => {
    const guide = { fixAt: t0, lookaheadM: 200, setDeg: -10, hazardNear: true }
    const plain = navCardView({ ...base, plan, targetIdx: 1, fix, now: t0 })
    const guided = navCardView({ ...base, plan, targetIdx: 1, fix, now: t0, guide })
    // 20 m right of a line due north: 30 m lookahead → 326°; 200 m → 354°, less 10° for the set.
    expect(deg(plain.bearing)).toBe(326)
    expect(deg(guided.bearing)).toBe(344)
    const other = navCardView({ ...base, plan, targetIdx: 1, fix, now: t0, guide: { ...guide, fixAt: t0 - 1000 } })
    expect(deg(other.bearing)).toBe(326)
  })

  it('goes red — "shallows ahead on your heading" — when the store says so', () => {
    const guide = { fixAt: t0, lookaheadM: null, setDeg: 0, hazardNear: true, dangerAhead: true }
    const v = navCardView({ ...base, plan, targetIdx: 1, fix, now: t0, guide })
    expect(v.slowDown).toBe(true)
    expect(v.slowText).toBe('Slow down — shallows ahead on your heading')
    expect(v.notices.map((n) => n.kind)).toContain('heading-danger')
  })
})

describe('depthWords (rc5 F3 wording)', () => {
  it('never a negative depth', () => {
    expect(depthWords(0.9)).toBe('3 ft (0.9 m) water')
    expect(depthWords(-0.3)).toBe('ground that dries 1 ft (0.3 m)')
    expect(depthWords(-0.1)).toBe('ground that dries at low water')
  })
})
