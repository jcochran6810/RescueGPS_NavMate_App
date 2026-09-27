import { describe, it, expect } from 'vitest'
import {
  DEFAULT_GATE_M,
  TrackFilter,
  fixQuality,
  shouldRecord,
} from './track'
import { metersPerDegree } from './geo'
import type { Fix } from './types'

const BASE = { lat: 29.7604, lon: -95.3698 }
const M = metersPerDegree(BASE.lat)

/** A fix `east`/`north` metres from the base position. */
function at(
  east: number,
  north: number,
  t: number,
  accuracy = 5,
  over: Partial<Fix> = {},
): Fix {
  return {
    lat: BASE.lat + north / M.lat,
    lon: BASE.lon + east / M.lon,
    speed: null,
    heading: null,
    accuracy,
    altitude: null,
    timestamp: t,
    ...over,
  }
}

/** Metres between a fix and a point east/north of the base. */
function offsetM(fix: Fix, east: number, north: number): number {
  return Math.hypot(
    (fix.lon - BASE.lon) * M.lon - east,
    (fix.lat - BASE.lat) * M.lat - north,
  )
}

/** Deterministic noise — a seeded generator, so a failure is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller, so the simulated error is Gaussian like the real thing. */
function gaussian(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd())
}

function accepted(f: TrackFilter, fix: Fix): Fix {
  const r = f.push(fix)
  if (!r.accepted) throw new Error(`fix refused: ${r.detail}`)
  return r.fix
}

describe('fix quality', () => {
  it('bands accuracy the way it changes what you can do with it', () => {
    expect(fixQuality(3)).toBe('excellent')
    expect(fixQuality(5)).toBe('excellent')
    expect(fixQuality(9)).toBe('good')
    expect(fixQuality(25)).toBe('fair')
    expect(fixQuality(40)).toBe('poor')
    expect(fixQuality(300)).toBe('coarse')
  })

  it('treats a missing figure as the worst case, not the best', () => {
    expect(fixQuality(null)).toBe('coarse')
    expect(fixQuality(undefined)).toBe('coarse')
    expect(fixQuality(Number.NaN)).toBe('coarse')
  })
})

describe('the accuracy gate', () => {
  it('takes the first fix as it stands', () => {
    const f = new TrackFilter()
    const r = f.push(at(0, 0, 1000))
    expect(r.accepted).toBe(true)
    if (r.accepted) expect(r.fix.lat).toBe(r.raw.lat)
  })

  it('refuses the cell-tower fix a phone opens with', () => {
    const f = new TrackFilter({ maxAccuracyM: 25 })
    const r = f.push(at(0, 0, 1000, 1200))
    expect(r.accepted).toBe(false)
    if (!r.accepted) {
      expect(r.reason).toBe('accuracy')
      expect(r.detail).toContain('1200')
    }
    expect(f.rejected.accuracy).toBe(1)
    expect(f.started).toBe(false)
  })

  it('refuses a fix with no accuracy figure at all while a gate is set', () => {
    const f = new TrackFilter({ maxAccuracyM: 25 })
    const r = f.push(at(0, 0, 1000, 5, { accuracy: null }))
    expect(r.accepted).toBe(false)
    if (!r.accepted) expect(r.reason).toBe('accuracy')
  })

  it('takes anything when the gate is off', () => {
    const f = new TrackFilter({ maxAccuracyM: 0 })
    expect(f.push(at(0, 0, 1000, 900)).accepted).toBe(true)
  })

  it('can be loosened without losing the track so far', () => {
    const f = new TrackFilter({ maxAccuracyM: 10 })
    accepted(f, at(0, 0, 1000))
    expect(f.push(at(1, 0, 2000, 40)).accepted).toBe(false)
    f.setMaxAccuracy(50)
    expect(f.push(at(1, 0, 3000, 40)).accepted).toBe(true)
    expect(f.started).toBe(true)
  })
})

describe('filtering a stationary receiver', () => {
  /** One minute of 1 Hz fixes on a phone that is not moving. */
  function run(sigma: number) {
    const rnd = mulberry32(7)
    const f = new TrackFilter({ maxAccuracyM: 0 })
    let rawErr = 0
    let filtErr = 0
    let n = 0
    for (let i = 0; i < 60; i++) {
      const raw = at(gaussian(rnd) * sigma, gaussian(rnd) * sigma, 1000 + i * 1000, sigma)
      const r = f.push(raw)
      if (!r.accepted) continue
      // The first ten fixes are the filter converging; judge it on the rest.
      if (i < 10) continue
      rawErr += offsetM(raw, 0, 0) ** 2
      filtErr += offsetM(r.fix, 0, 0) ** 2
      n++
    }
    return { raw: Math.sqrt(rawErr / n), filtered: Math.sqrt(filtErr / n) }
  }

  it('cuts the scatter of a phone sitting still', () => {
    const { raw, filtered } = run(10)
    expect(filtered).toBeLessThan(raw / 2)
  })

  it('helps most where the receiver is worst', () => {
    expect(run(20).filtered).toBeLessThan(run(20).raw / 2)
    expect(run(4).filtered).toBeLessThan(run(4).raw)
  })

  it('never claims better accuracy than half what the receiver reported', () => {
    const f = new TrackFilter({ maxAccuracyM: 0 })
    let last: Fix | null = null
    for (let i = 0; i < 200; i++) last = accepted(f, at(0, 0, 1000 + i * 1000, 12))
    expect(last?.accuracy).toBeGreaterThanOrEqual(6)
  })
})

describe('filtering a receiver under way', () => {
  /**
   * Five metres a second due east, 1 Hz, ±6 m fixes. Judged on the second
   * half of the run — the first half is the filter working out how fast the
   * crew is going, which is the part that is meant to take a moment.
   */
  function underWay() {
    const rnd = mulberry32(3)
    const f = new TrackFilter({ maxAccuracyM: 0 })
    let rawErr = 0
    let filtErr = 0
    let speed = 0
    let heading = 0
    let n = 0
    for (let i = 0; i < 60; i++) {
      const east = i * 5
      const raw = at(east + gaussian(rnd) * 6, gaussian(rnd) * 6, 1000 + i * 1000, 6)
      const fix = accepted(f, raw)
      if (i < 30) continue
      rawErr += offsetM(raw, east, 0) ** 2
      filtErr += offsetM(fix, east, 0) ** 2
      speed += fix.speed ?? 0
      heading += fix.heading ?? 0
      n++
    }
    return {
      raw: Math.sqrt(rawErr / n),
      filtered: Math.sqrt(filtErr / n),
      speed: speed / n,
      heading: heading / n,
    }
  }

  it('follows the movement instead of lagging behind it', () => {
    const { raw, filtered } = underWay()
    // Not merely better than the raw scatter — the lag a smoother buys is
    // paid for in exactly this number, so it has to come out ahead while
    // actually moving, not just while parked.
    expect(filtered).toBeLessThan(raw)
    expect(filtered).toBeLessThan(6)
  })

  it('works out speed and course the receiver never reported', () => {
    const { speed, heading } = underWay()
    expect(speed).toBeGreaterThan(4)
    expect(speed).toBeLessThan(6)
    expect(heading).toBeGreaterThan(80)
    expect(heading).toBeLessThan(100)
  })

  it('leaves the receiver’s own speed and course alone when it has them', () => {
    const f = new TrackFilter({ maxAccuracyM: 0 })
    accepted(f, at(0, 0, 1000, 6, { speed: 4, heading: 270 }))
    const fix = accepted(f, at(5, 0, 2000, 6, { speed: 4.2, heading: 268 }))
    expect(fix.speed).toBe(4.2)
    expect(fix.heading).toBe(268)
  })

  it('reports a standstill as a standstill', () => {
    const rnd = mulberry32(11)
    const f = new TrackFilter({ maxAccuracyM: 0 })
    let last: Fix | null = null
    for (let i = 0; i < 40; i++) {
      last = accepted(
        f,
        at(gaussian(rnd) * 3, gaussian(rnd) * 3, 1000 + i * 1000, 3),
      )
    }
    expect(last?.speed).toBe(0)
  })
})

describe('outliers', () => {
  function settled(gate = DEFAULT_GATE_M) {
    const f = new TrackFilter({ maxAccuracyM: gate })
    for (let i = 0; i < 20; i++) accepted(f, at(0, 0, 1000 + i * 1000, 5))
    return f
  }

  it('drops a fix that has jumped off a wall', () => {
    const f = settled()
    const r = f.push(at(300, 0, 21_000, 5))
    expect(r.accepted).toBe(false)
    if (!r.accepted) expect(r.reason).toBe('jump')
    expect(f.rejected.jump).toBe(1)
  })

  it('keeps the good position while it refuses the bad one', () => {
    const f = settled()
    f.push(at(300, 0, 21_000, 5))
    const next = accepted(f, at(0, 0, 22_000, 5))
    expect(offsetM(next, 0, 0)).toBeLessThan(5)
  })

  it('believes the receiver once it keeps saying the same thing — when a boat could have got there', () => {
    const f = settled()
    expect(f.push(at(400, 0, 21_000, 5)).accepted).toBe(false)
    expect(f.push(at(405, 0, 22_000, 5)).accepted).toBe(false)
    expect(f.push(at(410, 0, 23_000, 5)).accepted).toBe(false)
    // Behaviour changed on purpose (rc3 F5). Four fixes over three seconds
    // that agree used to be believed at once — a 400 m jump in 4 s from a
    // standing start, and a four-fix multipath excursion with it. Now the
    // jump must also be one the boat could have made from where dead
    // reckoning puts it (`ADOPT_ACCEL_MPS2`); until then the filter says so,
    // rather than going quiet: its dead-reckoned position, flagged, with an
    // accuracy that covers the fixes it refused.
    const quiet = f.push(at(415, 0, 24_000, 5))
    expect(quiet.accepted).toBe(true)
    if (!quiet.accepted) return
    expect(quiet.fix.estimate).toBe('dead-reckoned')
    expect(quiet.fix.settling).toBe(true)
    expect(offsetM(quiet.fix, 0, 0)).toBeLessThan(5)
    expect(quiet.fix.accuracy!).toBeGreaterThanOrEqual(415)
    let back: Fix | null = null
    let k = 5
    for (; k < 30 && !back; k++) {
      const r = f.push(at(415, 0, 20_000 + k * 1000, 5))
      if (r.accepted && !r.fix.estimate) back = r.fix
    }
    expect(back).not.toBeNull()
    expect(offsetM(back!, 415, 0)).toBeLessThan(10)
    // Not believed before a boat could have covered it from a standstill.
    expect(k).toBeGreaterThan(8)
    expect(back!.settling).toBe(true)
    // …and still says how far it jumped.
    expect(back!.accuracy!).toBeGreaterThan(300)
  })

  it('refuses a step no vehicle on the incident could make', () => {
    const f = settled()
    const r = f.push(at(50_000, 0, 21_000, 5))
    expect(r.accepted).toBe(false)
    if (!r.accepted) {
      expect(r.reason).toBe('jump')
      expect(r.detail).toContain('50000 m')
    }
  })

  it('refuses a fix older than the one before it', () => {
    const f = settled()
    const r = f.push(at(0, 0, 19_000, 5))
    expect(r.accepted).toBe(false)
    if (!r.accepted) expect(r.reason).toBe('stale')
    expect(f.rejected.stale).toBe(1)
  })

  it('starts again after a long gap rather than bridging it', () => {
    const f = settled()
    // Ten minutes in a tunnel. The old velocity says nothing about where the
    // crew is now, so the new fix is taken as read.
    const out = accepted(f, at(2000, 500, 620_000, 5))
    expect(offsetM(out, 2000, 500)).toBeLessThan(0.001)
  })

  it('forgets its counts on reset', () => {
    const f = settled()
    f.push(at(300, 0, 21_000, 5))
    f.reset()
    expect(f.rejected.jump).toBe(0)
    expect(f.started).toBe(false)
  })
})

describe('what earns a place in the recorded path', () => {
  const a = at(0, 0, 1000, 5)

  it('always records the first point', () => {
    expect(shouldRecord(undefined, a, 15)).toBe(true)
  })

  it('waits for the interval', () => {
    expect(shouldRecord(a, at(100, 0, 6000, 5), 15)).toBe(false)
    expect(shouldRecord(a, at(100, 0, 16_000, 5), 15)).toBe(true)
  })

  it('will not record movement smaller than the uncertainty', () => {
    // Twenty seconds later, three metres away, on a fix good to five: the
    // receiver has not shown that anything moved.
    expect(shouldRecord(a, at(3, 0, 21_000, 5), 15)).toBe(false)
    expect(shouldRecord(a, at(9, 0, 21_000, 5), 15)).toBe(true)
  })

  it('takes the worse of the two accuracies', () => {
    expect(shouldRecord(a, at(20, 0, 21_000, 40), 15)).toBe(false)
    expect(shouldRecord(at(0, 0, 1000, 40), at(20, 0, 21_000, 5), 15)).toBe(
      false,
    )
  })

  it('keeps a floor under it for a receiver claiming perfection', () => {
    expect(shouldRecord(a, at(2, 0, 21_000, 0.1), 15)).toBe(false)
    expect(shouldRecord(at(0, 0, 1000, 0.1), at(6, 0, 21_000, 0.1), 15)).toBe(
      true,
    )
  })
})

describe('a boat turning hard (M3)', () => {
  /**
   * A planing boat at 18 kn (9.26 m/s): 30 s straight east, a 180° turn at
   * 20° a second (3.2 m/s² sideways — ten times what the filter used to
   * allow), then 30 s straight back. 1 Hz fixes claiming ±5 m (the 68 %
   * radius — 3.3 m a side). The filter used to fall 82 m behind a turn like
   * this while reporting 8–10 m.
   */
  function turn(seed: number, withCourse: boolean) {
    const rnd = mulberry32(seed)
    const f = new TrackFilter({ maxAccuracyM: 0 })
    const v = 9.26
    let x = 0
    let y = 0
    let course = 90
    let maxErr = 0
    let worstRatio = 0
    let refused = 0
    for (let i = 0; i < 70; i++) {
      if (i > 0) {
        const steps = i > 30 && i <= 39 ? 10 : 1
        for (let k = 0; k < steps; k++) {
          if (steps === 10) course += 2
          const c = (course * Math.PI) / 180
          x += (v / steps) * Math.sin(c)
          y += (v / steps) * Math.cos(c)
        }
      }
      const raw = at(x + gaussian(rnd) * 3.3, y + gaussian(rnd) * 3.3, 1000 + i * 1000, 5, {
        speed: withCourse ? v : null,
        heading: withCourse ? ((course % 360) + 360) % 360 : null,
      })
      const r = f.push(raw)
      if (!r.accepted) {
        refused++
        continue
      }
      if (i < 5) continue
      const err = offsetM(r.fix, x, y)
      maxErr = Math.max(maxErr, err)
      worstRatio = Math.max(worstRatio, err / (r.fix.accuracy ?? 1))
    }
    return { maxErr, worstRatio, refused }
  }
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

  it('keeps up with the turn from the fixes alone', () => {
    for (const seed of seeds) {
      const r = turn(seed, false)
      expect(r.maxErr).toBeLessThan(20)
      // At most one fix of the turn is doubted before the filter follows it.
      expect(r.refused).toBeLessThanOrEqual(1)
    }
  })

  it('keeps up closely when the receiver reports its own course and speed', () => {
    for (const seed of seeds) {
      const r = turn(seed, true)
      expect(r.maxErr).toBeLessThan(12)
      expect(r.refused).toBe(0)
    }
  })

  it('reports an accuracy its real error stays within (never the lag hidden behind 8 m)', () => {
    for (const seed of seeds) {
      expect(turn(seed, false).worstRatio).toBeLessThan(2)
      expect(turn(seed, true).worstRatio).toBeLessThan(2)
    }
  })

  it('never claims better than the receiver itself', () => {
    const f = new TrackFilter({ maxAccuracyM: 0 })
    let last: Fix | null = null
    for (let i = 0; i < 100; i++) last = accepted(f, at(0, 0, 1000 + i * 1000, 12))
    expect(last?.accuracy).toBeGreaterThanOrEqual(12)
  })

  it('reports the distance to the fix when it has fallen further behind than the fix’s own error', () => {
    // Settled on a boat at rest, which then sets off at 6 m/s. The fixes are
    // exact, so the estimate's real error is its distance from them: while
    // it catches up, the accuracy it reports covers that, every fix.
    const f = new TrackFilter({ maxAccuracyM: 0 })
    for (let i = 0; i < 30; i++) accepted(f, at(0, 0, 1000 + i * 1000, 3))
    let worst = 0
    for (let i = 1; i <= 15; i++) {
      const fix = accepted(f, at(6 * i, 0, 31_000 + i * 1000, 3))
      const err = offsetM(fix, 6 * i, 0)
      worst = Math.max(worst, err)
      expect(fix.accuracy ?? 0).toBeGreaterThanOrEqual(err)
    }
    // It did fall behind — this is not a vacuous pass.
    expect(worst).toBeGreaterThan(3)
  })
})

describe('multipath jumps (F1)', () => {
  /** 12 kn due north, 1 Hz, ±8 m; `east` metres of jump on fixes [from, from + len). */
  function voyage(len: number, from = 30, n = 45, jump = 100) {
    const rnd = mulberry32(21 + len)
    const f = new TrackFilter({ maxAccuracyM: 25 })
    const out: { i: number; r: ReturnType<TrackFilter['push']>; north: number }[] = []
    for (let i = 0; i < n; i++) {
      const north = 6.17 * i
      const east = i >= from && i < from + len ? jump : 0
      const r = f.push(at(east + gaussian(rnd) * 2, north + gaussian(rnd) * 2, 1000 + i * 1000, 8))
      out.push({ i, r, north })
    }
    return out
  }

  for (const len of [1, 2, 3]) {
    it(`refuses a ${len}-fix 100 m jump, and keeps the true track and its speed`, () => {
      const out = voyage(len)
      for (const { i, r, north } of out) {
        if (i < 5) continue
        if (i >= 30 && i < 30 + len) {
          expect(r.accepted).toBe(false)
          continue
        }
        expect(r.accepted).toBe(true)
        if (!r.accepted) continue
        expect(offsetM(r.fix, 0, north)).toBeLessThan(20)
        expect(r.settling).toBe(false)
        // No collapse of speed or course after the jump.
        expect(r.fix.speed! * 1.943844).toBeGreaterThan(9)
        const h = r.fix.heading!
        expect(Math.min(h, 360 - h)).toBeLessThan(30)
      }
    })
  }

  it('believes a lasting jump only once a boat could have made it, marks it settling, and says how far it was', () => {
    // Behaviour changed on purpose (rc3 F5): believed on the fourth agreeing
    // fix before, reporting ±6 m straight after a 100 m jump. Now: refused
    // for 3 s, then the dead-reckoned position with an honest accuracy, and
    // the jump believed once ½·a·t² (plus the errors) covers it.
    const out = voyage(20, 30, 60)
    for (const { i, r } of out.slice(30, 33)) expect(r.accepted, `fix ${i}`).toBe(false)
    const dr = out[33].r
    expect(dr.accepted).toBe(true)
    if (!dr.accepted) return
    expect(dr.fix.estimate).toBe('dead-reckoned')
    expect(dr.fix.accuracy!).toBeGreaterThan(90)
    const i = out.findIndex(({ i: j, r }) => j >= 30 && r.accepted && !r.fix.estimate)
    expect(i).toBeGreaterThanOrEqual(34)
    expect(i).toBeLessThanOrEqual(38)
    const adopted = out[i].r
    if (!adopted.accepted) return
    expect(adopted.settling).toBe(true)
    expect(adopted.fix.settling).toBe(true)
    expect(offsetM(adopted.fix, 100, out[i].north)).toBeLessThan(20)
    // The jump is in the reported error while it is on probation…
    expect(adopted.fix.accuracy!).toBeGreaterThan(50)
    // Its speed is the run's, not zero.
    expect(adopted.fix.speed! * 1.943844).toBeGreaterThan(9)
    // …and gone from it once the new track has held for its hold time.
    const later = out[i + 11].r
    expect(later.accepted && later.settling).toBe(false)
    if (later.accepted) expect(later.fix.accuracy!).toBeLessThan(15)
  })

  it('goes back to the old track when a believed jump turns out to be a reflection (rc3 F5)', () => {
    // A 100 m excursion that lasts 8 fixes — long enough to be believed —
    // and then the receiver is back on the true track.
    const out = voyage(8, 30, 60)
    let adoptedAt = -1
    for (const { i, r, north } of out) {
      if (i < 30 || !r.accepted) continue
      if (i < 38 && !r.fix.estimate && adoptedAt < 0) adoptedAt = i
      if (i >= 39) {
        expect(offsetM(r.fix, 0, north), `fix ${i}`).toBeLessThan(20)
        expect(r.fix.accuracy!, `fix ${i}`).toBeLessThan(30)
      }
    }
    expect(adoptedAt).toBeGreaterThan(0)
  })

  it('a four-fix 100 m excursion claiming ±4 m is never believed (rc3 F5)', () => {
    const f = new TrackFilter({ maxAccuracyM: 25 })
    for (let k = 0; k < 60; k++) {
      const east = k >= 40 && k < 44 ? 100 : 0
      const r = f.push(at(east, 10 * k, 1000 + k * 1000, 4))
      if (!r.accepted) continue
      // Every position handed out is on the true track; one that is not a
      // fix the filter believes says so, with an accuracy that covers both.
      expect(offsetM(r.fix, 0, 10 * k), `fix ${k}`).toBeLessThan(5)
      if (k >= 40 && k < 44) expect(r.fix.estimate).toBe('dead-reckoned')
    }
  })

  it('never runs away after a second reflection mid-turn (rc3 dock-0, lies profile)', () => {
    // 36 fixes replayed from the rc3 voyage: east, north, claimed accuracy,
    // Doppler speed and course, then where the boat really was. The boat
    // turns and slows; one reflection (fix 6) is refused and then a jump is
    // believed (fixes 7–9, borne out); then a second, 110–120 m reflection
    // lasting five fixes (11–15) while claiming ±4–6 m.
    //
    // Before: the second reflection passed for "back on the old track" —
    // within a manoeuvre's worth of doubt six seconds on — the filter was put
    // back six seconds and took it in at 55 m/s, then dead-reckoned on at
    // that speed to 680 m from the boat, while the true fixes were refused.
    const rows = [
      [-424.2, -830.0, 4, 13.24, 220, -434.2, -817.1], [-432.6, -852.3, 5.2, 12.99, 225, -443.2, -826.6],
      [-431.8, -846.9, 6.8, 13.19, 225, -452.5, -835.9], [-455.2, -847.8, 3.6, 13.32, 228, -462.0, -844.9],
      [-462.3, -870.0, 5.3, 13.06, 214, -471.1, -854.4], [-477.4, -862.7, 3.7, 13.14, 212, -478.5, -865.2],
      [-460.9, -897.8, 5.6, 13.29, 198, -484.9, -876.5], [-473.1, -900.5, 3.5, 12.9, 191, -487.9, -889.2],
      [-495.0, -910.4, 4.2, 13.04, 201, -491.2, -901.8], [-493.5, -935.0, 5.1, 13.1, 210, -497.8, -913.1],
      [-502.7, -934.4, 5.4, 12.35, 222, -505.4, -923.3], [-499.2, -1051.7, 6.1, 10.69, 227, -513.7, -931.0],
      [-506.3, -1031.9, 4.1, 9.4, 239, -521.4, -937.1], [-522.6, -1036.6, 3.7, 7.81, 260, -529.2, -939.9],
      [-516.1, -1036.2, 5.2, 6.72, 255, -536.1, -941.0], [-529.6, -1050.0, 4.5, 6.49, 239, -542.0, -943.9],
      [-546.9, -964.4, 7, 6.62, 257, -548.2, -946.4], [-538.5, -975.7, 4.2, 6.68, 273, -554.8, -946.7],
      [-561.6, -954.1, 7.5, 6.87, 294, -561.2, -944.8], [-562.0, -943.8, 9, 6.76, 313, -566.5, -940.9],
      [-567.1, -936.3, 9.4, 6.62, 331, -570.3, -935.3], [-569.1, -937.7, 9.3, 6.49, 351, -572.0, -928.9],
      [-568.0, -930.2, 9.5, 6.54, 11, -571.4, -922.3], [-573.4, -930.5, 9.6, 6.51, 10, -569.6, -916.0],
      [-567.9, -922.4, 7.9, 6.6, 346, -569.9, -909.3], [-568.5, -910.1, 6.7, 6.6, 330, -572.5, -903.2],
      [-576.6, -904.8, 6.3, 6.81, 309, -576.9, -898.2], [-577.4, -902.2, 6.4, 6.66, 291, -582.8, -895.1],
      [-588.3, -906.4, 7, 6.72, 273, -589.4, -894.0], [-593.1, -901.1, 7.1, 6.45, 248, -595.9, -895.3],
      [-599.9, -907.0, 6.5, 6.6, 231, -601.5, -898.6], [-603.2, -912.9, 5.6, 7.05, 215, -605.8, -903.9],
      [-606.9, -917.0, 5.9, 7.93, 193, -608.3, -911.1], [-606.6, -929.8, 5.9, 9.0, 181, -609.1, -919.7],
      [-609.4, -935.7, 6.1, 10.11, 179, -609.2, -929.4], [-608.2, -947.9, 6.6, 11.19, 175, -608.7, -940.1],
    ]
    const f = new TrackFilter({ maxAccuracyM: 25 })
    const worstRaw = Math.max(...rows.map(([e, n, , , , te, tn]) => Math.hypot(e - te, n - tn)))
    rows.forEach(([e, n, acc, speed, heading, te, tn], k) => {
      const r = f.push(at(e, n, 1000 + k * 1000, acc, { speed, heading }))
      if (!r.accepted) return
      // Never further from the boat than the worst fix the receiver gave…
      expect(offsetM(r.fix, te, tn), `fix ${k}`).toBeLessThan(worstRaw + 5)
      // …and back on it once the true fixes return.
      if (k >= 22) expect(offsetM(r.fix, te, tn), `fix ${k}`).toBeLessThan(20)
    })
  })

  it('does not take a jump faster than the receiver’s own speed as a turn (rc3 drift-6, lies profile)', () => {
    // 38 fixes replayed from the rc3 voyage (east, north, claimed accuracy,
    // Doppler speed, course; then the boat's true position). At fix 21 a
    // 110 m jump claiming ±4 m arrives while the receiver's course swings
    // right; it lasts six fixes.
    //
    // Before: it was let in as the boat turning, the velocity went to
    // 45 m/s, and dead reckoning on it ran the position 630 m from the boat
    // while the true fixes that followed were refused.
    const rows = [
      [-181.2, 148.6, 5.6, 10.94, 322, -172.3, 167.9], [-190.6, 165.0, 3.6, 11.05, 319, -179.0, 176.4],
      [-212.1, 182.2, 7.1, 11.02, 327, -185.3, 185.3], [-198.9, 173.8, 5.2, 10.8, 323, -191.7, 194.1],
      [-211.9, 207.1, 5.9, 10.76, 329, -197.8, 203.1], [-216.0, 207.8, 4.3, 10.75, 316, -204.0, 212.0],
      [-219.8, 199.8, 6.8, 10.83, 320, -210.9, 220.4], [-231.5, 220.6, 5.5, 10.94, 318, -217.9, 228.8],
      [-231.8, 242.3, 4.5, 10.83, 323, -224.7, 237.3], [-253.1, 242.0, 5, 10.7, 308, -232.2, 245.2],
      [-260.8, 227.4, 7, 11.02, 317, -240.2, 252.5], [-276.5, 250.6, 6.7, 10.88, 323, -247.3, 260.7],
      [-261.7, 261.2, 4.1, 10.82, 328, -253.5, 269.6], [-272.4, 260.2, 6.2, 10.83, 325, -259.5, 278.7],
      [-277.2, 292.0, 5.4, 10.9, 324, -266.1, 287.3], [-278.1, 292.2, 5.4, 10.97, 315, -273.3, 295.5],
      [-281.1, 299.0, 6.7, 10.74, 302, -281.5, 302.7], [-291.2, 312.8, 4, 10.85, 305, -290.5, 308.8],
      [-300.8, 309.2, 4.3, 10.98, 289, -300.0, 314.1], [-331.3, 295.0, 5.9, 10.97, 298, -309.7, 318.9],
      [-322.3, 319.0, 4.4, 10.96, 314, -318.3, 325.6], [-400.3, 254.3, 4.2, 10.9, 326, -324.6, 334.4],
      [-404.8, 258.5, 4.4, 10.78, 342, -329.6, 344.0], [-406.6, 272.0, 4.2, 10.84, 0, -331.2, 354.8],
      [-403.5, 281.6, 3.8, 10.95, 12, -329.5, 365.5], [-400.9, 293.4, 4.1, 10.8, 17, -326.6, 376.0],
      [-400.4, 301.5, 4.8, 10.75, 22, -322.8, 386.2], [-323.1, 396.9, 4.6, 10.83, 39, -317.1, 395.3],
      [-310.1, 405.3, 3.8, 10.13, 47, -309.7, 402.9], [-300.6, 407.4, 3.7, 8.43, 46, -303.1, 409.0],
      [-299.5, 415.8, 4.5, 6.99, 46, -297.5, 414.1], [-295.8, 419.8, 4.5, 5.59, 48, -292.9, 418.2],
      [-296.9, 421.9, 5, 5.42, 47, -288.9, 421.8], [-289.5, 425.9, 4.6, 5.5, 33, -285.4, 425.8],
      [-286.7, 433.5, 5, 5.44, 15, -283.4, 430.9], [-285.4, 434.1, 5, 5.91, 355, -283.2, 436.5],
      [-288.2, 444.0, 5, 7.04, 333, -285.3, 442.7], [-288.8, 447.6, 5, 8.02, 314, -290.1, 448.7],
    ]
    const f = new TrackFilter({ maxAccuracyM: 25 })
    const worstRaw = Math.max(...rows.map(([e, n, , , , te, tn]) => Math.hypot(e - te, n - tn)))
    rows.forEach(([e, n, acc, speed, heading, te, tn], k) => {
      const r = f.push(at(e, n, 1000 + k * 1000, acc, { speed, heading }))
      if (k === 21) expect(r.accepted, 'the 110 m jump').toBe(false)
      if (!r.accepted) return
      // Never run away past the receiver's own worst: the six-fix jump may
      // in the end be believed (it lasts long enough), but nothing further.
      expect(offsetM(r.fix, te, tn), `fix ${k}`).toBeLessThan(worstRaw + 25)
      if (k >= 32) expect(offsetM(r.fix, te, tn), `fix ${k}`).toBeLessThan(15)
    })
  })

  it('a receiver that reports speed 0 for "no idea" does not hold a moving boat back', () => {
    const f = new TrackFilter({ maxAccuracyM: 25 })
    for (let k = 0; k < 40; k++) {
      const r = f.push(at(0, 12 * k, 1000 + k * 1000, 4, { speed: 0 }))
      expect(r.accepted, `fix ${k}`).toBe(true)
      if (r.accepted && k > 3) expect(offsetM(r.fix, 0, 12 * k), `fix ${k}`).toBeLessThan(8)
    }
  })

  it('never follows a smaller jump that snaps back, even when the gate lets it in', () => {
    const out = voyage(2, 30, 45, 40)
    for (const { i, r, north } of out) {
      if (i < 5 || !r.accepted) continue
      expect(offsetM(r.fix, 0, north), `fix ${i}`).toBeLessThan(25)
    }
  })
})
