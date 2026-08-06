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

  it('believes the receiver once it says the same thing three times', () => {
    const f = settled()
    expect(f.push(at(400, 0, 21_000, 5)).accepted).toBe(false)
    expect(f.push(at(405, 0, 22_000, 5)).accepted).toBe(false)
    expect(f.push(at(410, 0, 23_000, 5)).accepted).toBe(false)
    // The third refusal restarts the filter there, so the next fix is taken
    // at face value rather than fought over forever.
    const back = accepted(f, at(415, 0, 24_000, 5))
    expect(offsetM(back, 415, 0)).toBeLessThan(10)
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
