import { describe, it, expect } from 'vitest'
import {
  blendDeg,
  describeTurn,
  headingFromOrientation,
  headingWander,
  HeadingSmoother,
  normalizeDeg,
  shortestDelta,
  unwrapDeg,
} from './heading'

/** Narrow away the null case so the attitude tests read cleanly. */
function at(alpha: number, beta: number, gamma: number, screen = 0) {
  const r = headingFromOrientation(alpha, beta, gamma, screen)
  if (!r) throw new Error('expected a heading')
  return r
}

/** How far apart two bearings are, ignoring which side. */
function apart(a: number, b: number): number {
  return Math.abs(shortestDelta(a, b))
}

describe('angle arithmetic', () => {
  it('normalises anything to 0–360', () => {
    expect(normalizeDeg(0)).toBe(0)
    expect(normalizeDeg(-1)).toBe(359)
    expect(normalizeDeg(720.5)).toBeCloseTo(0.5)
  })

  it('takes the short way round', () => {
    expect(shortestDelta(359, 1)).toBeCloseTo(2)
    expect(shortestDelta(1, 359)).toBeCloseTo(-2)
    // Half a turn is the same distance either way round; the sign there is
    // arbitrary and nothing may depend on it.
    expect(Math.abs(shortestDelta(0, 180))).toBeCloseTo(180)
  })

  it('unwraps so a dial never spins the long way', () => {
    // The bug this exists for: 359 -> 1 as raw rotation is a 358° backspin.
    expect(unwrapDeg(359, 1)).toBeCloseTo(361)
    expect(unwrapDeg(361, 359)).toBeCloseTo(359)
    expect(unwrapDeg(-720, 10)).toBeCloseTo(-710)
  })

  it('blends across north without passing through south', () => {
    expect(blendDeg(350, 10, 0.5)).toBeCloseTo(0)
    expect(blendDeg(10, 350, 0.5)).toBeCloseTo(0)
    expect(blendDeg(0, 90, 1 / 3)).toBeCloseTo(30)
  })
})

describe('a phone held flat, like a hand-bearing compass', () => {
  it('reads the azimuth of the top edge of the screen', () => {
    // Lying flat, screen up: alpha 0 means the top edge points north, and
    // alpha runs anticlockwise, so the heading is its mirror.
    for (const alpha of [0, 45, 90, 180, 271, 359]) {
      expect(apart(at(alpha, 0, 0).heading, normalizeDeg(-alpha))).toBeLessThan(0.001)
    }
  })

  it('calls that attitude flat and level', () => {
    const r = at(0, 0, 0)
    expect(r.mode).toBe('flat')
    expect(r.tilt).toBeCloseTo(0)
    expect(r.level.x).toBeCloseTo(0)
    expect(r.level.y).toBeCloseTo(0)
    expect(r.confidence).toBeCloseTo(1)
  })

  it('holds the heading when the far edge is tilted down', () => {
    // A phone read at waist height sits nose-down by 20–40°. The top edge is
    // still what points, and the heading must not move as the wrist drops.
    for (const beta of [0, -10, -20, -30, -40]) {
      expect(apart(at(30, beta, 0).heading, 330)).toBeLessThan(0.5)
    }
  })

  it('reports the tilt and which way it leans', () => {
    const nose = at(0, -25, 0)
    expect(nose.tilt).toBeCloseTo(25, 1)
    // Nose down puts the near edge, at the bottom of the screen, uphill.
    expect(nose.level.y).toBeGreaterThan(0.3)

    const roll = at(0, 0, 20)
    expect(roll.tilt).toBeCloseTo(20, 1)
    // Rolled with the right side down, the high side is to the left.
    expect(roll.level.x).toBeLessThan(-0.3)
  })
})

describe('a phone held up to look at', () => {
  it('reads where the back of the phone points, not the top edge', () => {
    // Standing upright, screen towards you, facing north: the top edge points
    // at the sky and means nothing, so the camera direction is the heading.
    const r = at(0, 90, 0)
    expect(r.mode).toBe('upright')
    expect(apart(r.heading, 0)).toBeLessThan(0.001)
    expect(r.confidence).toBeCloseTo(1)
    expect(r.tilt).toBeCloseTo(0)
  })

  it('is unmoved by roll, which is the bug in every alpha-only compass', () => {
    // Held upright, a roll of the wrist and a turn of the body are the same
    // rotation as far as `alpha` can tell: the device reports the two as one
    // number. Physically the same attitude is (alpha + gamma) constant — so a
    // compass worth having returns the same heading for every member of that
    // family, and `360 - alpha` returns a different one for each.
    const naive: number[] = []
    for (const gamma of [-60, -30, 0, 30, 60]) {
      const alpha = normalizeDeg(30 - gamma)
      expect(apart(at(alpha, 90, gamma).heading, 330)).toBeLessThan(0.5)
      naive.push(normalizeDeg(360 - alpha))
    }
    // The reading the old code would have given, for comparison: it swings
    // through 120° across the same five attitudes.
    expect(Math.max(...naive) - Math.min(...naive)).toBeGreaterThan(100)
  })

  it('crosses between the two holds without the needle jumping', () => {
    // Raising the phone from flat to upright must not put a discontinuity
    // anywhere in the sweep — that would read as the compass losing north.
    let prev = at(30, 0, 0).heading
    for (let beta = 0; beta <= 90; beta += 2) {
      const h = at(30, beta, 0).heading
      expect(apart(h, prev)).toBeLessThan(3)
      expect(apart(h, 330)).toBeLessThan(1)
      prev = h
    }
  })

  it('stays sane when the phone is tipped past vertical', () => {
    // Leaning back to look at the sky: still the camera direction, still north.
    expect(apart(at(0, 110, 0).heading, 0)).toBeLessThan(1)
    expect(apart(at(0, 135, 0).heading, 0)).toBeLessThan(1)
  })

  it('measures tilt from upright once it is upright', () => {
    const r = at(0, 70, 0)
    expect(r.mode).toBe('upright')
    expect(r.tilt).toBeCloseTo(20, 1)
  })
})

describe('screen rotation', () => {
  it('follows the top of the page, not the top of the device', () => {
    // Turned into landscape, the device's right edge is what the user sees as
    // up, so the same physical attitude reads 90° round.
    expect(apart(at(0, 0, 0, 90).heading, 90)).toBeLessThan(0.001)
    expect(apart(at(0, 0, 0, 270).heading, 270)).toBeLessThan(0.001)
    expect(apart(at(30, 0, 0, 90).heading, 60)).toBeLessThan(0.001)
  })

  it('reads a phone held up in landscape the same way as one held up in portrait', () => {
    // Turned on its side and lifted to eye height, facing north: the device's
    // right-hand edge is now what points at the sky, so the whole hold-detection
    // test has to be done in the screen's axes rather than the device's. These
    // angles are that attitude exactly — the top edge points west, the screen
    // faces south at the person holding it, and the camera looks north.
    const r = at(90, 0, -90, 90)
    expect(r.mode).toBe('upright')
    expect(apart(r.heading, 0)).toBeLessThan(0.5)
    expect(r.tilt).toBeCloseTo(0, 4)
  })

  it('moves the bubble into screen coordinates', () => {
    // Nose-down in portrait puts the bubble low on the screen; the same
    // attitude in landscape puts it to one side.
    const portrait = at(0, -25, 0, 0)
    const landscape = at(0, -25, 0, 90)
    expect(portrait.level.y).toBeGreaterThan(0.3)
    expect(Math.abs(landscape.level.y)).toBeLessThan(0.05)
    expect(Math.abs(landscape.level.x)).toBeGreaterThan(0.3)
  })
})

describe('readings it refuses', () => {
  it('returns null rather than a plausible-looking number', () => {
    expect(headingFromOrientation(null, 0, 0)).toBeNull()
    expect(headingFromOrientation(0, null, 0)).toBeNull()
    expect(headingFromOrientation(0, 0, undefined)).toBeNull()
    expect(headingFromOrientation(Number.NaN, 0, 0)).toBeNull()
  })
})

describe('smoothing', () => {
  /** Feed one heading for a while at 20 Hz. */
  function hold(s: HeadingSmoother, deg: number, seconds: number, t0 = 0): number {
    let out = deg
    for (let t = t0; t <= t0 + seconds * 1000; t += 50) out = s.update(deg, t)
    return out
  }

  it('takes the first sample whole rather than easing up from nowhere', () => {
    const s = new HeadingSmoother()
    expect(s.ready).toBe(false)
    expect(s.update(137, 0)).toBeCloseTo(137)
    expect(s.ready).toBe(true)
    expect(s.value()).toBeCloseTo(137)
  })

  it('settles on a steady reading', () => {
    const s = new HeadingSmoother()
    s.update(137, 0)
    expect(hold(s, 137, 2, 50)).toBeCloseTo(137, 4)
  })

  it('damps a shaking hand', () => {
    // ±6° of jitter at 20 Hz — a phone held in a moving boat.
    const s = new HeadingSmoother()
    s.update(100, 0)
    let worst = 0
    for (let i = 1; i < 200; i++) {
      const noisy = 100 + (i % 2 === 0 ? 6 : -6)
      const out = s.update(noisy, i * 50)
      if (i > 20) worst = Math.max(worst, apart(out, 100))
    }
    expect(worst).toBeLessThan(2)
  })

  it('keeps up with a real turn instead of lagging behind it', () => {
    // A boat coming round 90°. Half a second later the needle has to be most
    // of the way there, or the coxswain is steering by where they were.
    const s = new HeadingSmoother()
    hold(s, 0, 1)
    let out = 0
    for (let i = 1; i <= 10; i++) out = s.update(90, 1000 + i * 50)
    expect(out).toBeGreaterThan(80)
  })

  it('crosses north without swinging through south', () => {
    // Averaging the numbers rather than the vectors makes 359 and 1 average
    // to 180, which points the needle at the opposite horizon.
    const s = new HeadingSmoother()
    s.update(359, 0)
    let worst = 0
    for (let i = 1; i < 60; i++) {
      const out = s.update(i % 2 === 0 ? 359 : 1, i * 50)
      worst = Math.max(worst, apart(out, 0))
    }
    expect(worst).toBeLessThan(2)
  })

  it('smooths by elapsed time, not by sample count', () => {
    // The same half-second of turning has to land in the same place whether
    // the device reported 10 samples or 50.
    const slow = new HeadingSmoother()
    const fast = new HeadingSmoother()
    slow.update(0, 0)
    fast.update(0, 0)
    let a = 0
    let b = 0
    for (let t = 100; t <= 600; t += 100) a = slow.update(45, t)
    for (let t = 20; t <= 600; t += 20) b = fast.update(45, t)
    expect(apart(a, b)).toBeLessThan(3)
  })

  it('ignores a clock that jumps backwards', () => {
    const s = new HeadingSmoother()
    s.update(10, 5000)
    const out = s.update(200, 0)
    expect(apart(out, 10)).toBeLessThan(0.001)
  })

  it('forgets everything on reset', () => {
    const s = new HeadingSmoother()
    s.update(10, 0)
    s.reset()
    expect(s.ready).toBe(false)
    expect(s.value()).toBeNull()
    expect(s.update(200, 100)).toBeCloseTo(200)
  })
})

describe('telling a bad magnetometer from a turning boat', () => {
  /** A window of readings at 25 Hz, built from a function of time. */
  function window_(f: (i: number) => number, n = 30): { deg: number; t: number }[] {
    return Array.from({ length: n }, (_, i) => ({ deg: f(i), t: i * 40 }))
  }

  it('says nothing until it has seen enough', () => {
    expect(headingWander(window_(() => 90, 4))).toBeNull()
  })

  it('is near zero for a phone held still', () => {
    // A good magnetometer still wobbles by a degree or so.
    const w = headingWander(window_((i) => 90 + (i % 3) - 1))
    expect(w).not.toBeNull()
    expect(w!).toBeLessThan(2)
  })

  it('is near zero for a boat coming round hard', () => {
    // 60°/s — faster than any boat this app will be on. A detector that only
    // looked at how much the readings moved would call this a broken compass
    // and tell the coxswain to stop and wave the phone about.
    const w = headingWander(window_((i) => normalizeDeg(i * 2.4)))
    expect(w!).toBeLessThan(1)
  })

  it('is near zero for a turn that passes through north', () => {
    // Unwrapping is what makes this true; without it the 359-to-0 step reads
    // as a 359° excursion and every pass through north flags a fault.
    const w = headingWander(window_((i) => normalizeDeg(350 + i * 2)))
    expect(w!).toBeLessThan(1)
  })

  it('is large for a reading that will not settle', () => {
    // The real signature of an uncalibrated or disturbed sensor: it does not
    // drift, it alternates.
    const w = headingWander(window_((i) => 90 + (i % 2 === 0 ? 20 : -20)))
    expect(w!).toBeGreaterThan(15)
  })

  it('catches jitter riding on top of a turn', () => {
    const w = headingWander(window_((i) => normalizeDeg(i * 2 + (i % 2 ? 14 : -14))))
    expect(w!).toBeGreaterThan(10)
  })
})

describe('describing a turn', () => {
  it('names the side to turn towards', () => {
    expect(describeTurn(90, 50)).toBe('turn 40° right')
    expect(describeTurn(50, 90)).toBe('turn 40° left')
  })

  it('takes the short way round north', () => {
    expect(describeTurn(10, 350)).toBe('turn 20° right')
    expect(describeTurn(350, 10)).toBe('turn 20° left')
  })

  it('stops asking for a correction nobody can steer', () => {
    expect(describeTurn(92, 90)).toBe('dead ahead')
  })
})
