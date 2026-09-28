import { describe, it, expect } from 'vitest'
import {
  deadReckon,
  fixAgeS,
  navProgress,
  ETA_ARRIVAL_S,
  ETA_TURN_S,
  legCourseDeg,
  setAllowanceDeg,
  speedLookaheadM,
  steerCourse,
  updateHelm,
  updateSet,
  updateTurnRate,
  turnRateDps,
  turnReactS,
  HELM_FACTOR_MAX,
  TURN_ASSUMED_DPS,
  TURN_ASSUMED_REACT_S,
  LOOKAHEAD_MAX_M,
  LOOKAHEAD_MIN_M,
  type HelmRecord,
  type SetEstimate,
  type TurnRecord,
} from './navigate'

/*
 * rc5 F6 / F8 — the course to steer.
 *
 *   F6  a fixed 30 m lookahead made a helm that answers slowly swing ±54 m
 *       across the line at 20 kn: it is now six seconds of the boat's run
 *       (30–120 m), and stretched further for a helm seen swinging across;
 *   F8  a boat at low speed in a strong cross-set was held 40–50 m off the
 *       line: the set is learnt from the cross-track error and allowed for.
 */

const M_LAT = 110850
const M_LON = 97000
const A = { lat: 29.3, lon: -94.8 }
const B = { lat: 29.3 + 5000 / M_LAT, lon: -94.8 }
const plan = { points: [A, B] }
const fixAt = (x: number, y: number, speed: number, heading: number | null = 0) => ({
  lat: A.lat + y / M_LAT,
  lon: A.lon + x / M_LON,
  accuracy: 3,
  speed,
  heading,
})

describe('F6: a speed-scaled lookahead', () => {
  it('is six seconds of run, 30–120 m', () => {
    expect(speedLookaheadM({ speed: 2 })).toBe(LOOKAHEAD_MIN_M)
    expect(speedLookaheadM({ speed: 10 })).toBeCloseTo(60, 6)
    expect(speedLookaheadM({ speed: 30 })).toBe(LOOKAHEAD_MAX_M)
    expect(speedLookaheadM({ speed: null })).toBe(LOOKAHEAD_MIN_M)
  })

  it('steerCourse aims that far ahead, never steeper than 45°, and takes the store\'s choice', () => {
    const c = steerCourse(plan, 1, fixAt(20, 1000, 10))!
    expect(c.lookaheadM).toBeCloseTo(60, 6)
    // 20 m right of a line due north, 60 m ahead: 18° in.
    expect(c.bearingDeg).toBeCloseTo(360 - (Math.atan(20 / 60) * 180) / Math.PI, 0)
    const far = steerCourse(plan, 1, fixAt(90, 1000, 10))!
    expect(far.lookaheadM).toBeCloseTo(90, 0)
    const chosen = steerCourse(plan, 1, fixAt(20, 1000, 10), { lookaheadM: 200, setDeg: 5 })!
    expect(chosen.lookaheadM).toBe(200)
    expect(chosen.trackDeg).toBeCloseTo(360 - (Math.atan(20 / 200) * 180) / Math.PI, 0)
    expect(chosen.bearingDeg).toBeCloseTo((chosen.trackDeg + 5) % 360, 6)
  })
})

describe('F8: the set is learnt and allowed for', () => {
  /** A boat that steers exactly the course given, at `v` m/s, in a cross-set `cx` m/s (east). */
  function sail(v: number, cx: number, learn: boolean) {
    let x = 0
    let y = 0
    let cog = 0
    let est: SetEstimate | null = null
    let worst = 0
    for (let t = 0; t < 600; t++) {
      const fix = fixAt(x, y, v, cog)
      if (learn) est = updateSet(est, plan, 1, fix, 1, speedLookaheadM(fix))
      const set = learn ? setAllowanceDeg(est, plan, 1, fix) : 0
      const c = steerCourse(plan, 1, fix, { setDeg: set })!
      const h = (c.bearingDeg * Math.PI) / 180
      const dx = v * Math.sin(h) + cx
      const dy = v * Math.cos(h)
      x += dx
      y += dy
      cog = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
      if (t > 300) worst = Math.max(worst, Math.abs(x))
    }
    return { worst, est }
  }

  it('lets the allowance go when the course over the ground follows the card, not the track (rc6, rc3 narrow-7)', () => {
    // A set of 1 m/s east learnt, the boat on the line at 2 m/s: an
    // allowance of about 30° to port.
    const learnt: SetEstimate = { e: 1, n: 0 }
    const f0 = fixAt(0, 1000, 2, 0)
    const allowance = setAllowanceDeg(learnt, plan, 1, f0)
    expect(allowance).toBeLessThan(-20)
    const track = steerCourse(plan, 1, f0)!.trackDeg
    // A helm steering by compass: the boat makes good the track — kept.
    const kept = updateSet(learnt, plan, 1, { ...f0, heading: track }, 1, speedLookaheadM(f0))
    expect(kept.e).toBeGreaterThan(0.99)
    // A helm putting the GPS course over the ground on the card's course
    // makes its own allowance: the card's is let go (a 15 s time constant).
    let est: SetEstimate = learnt
    for (let t = 0; t < 30; t++) {
      est = updateSet(est, plan, 1, { ...f0, heading: (track + allowance + 360) % 360 }, 1, speedLookaheadM(f0))
    }
    expect(est.e).toBeLessThan(0.2)
  })

  it('a 1 m/s cross-set at 4 kn: 15 m off the line without it, within 3 m with it', () => {
    expect(sail(2, 1, false).worst).toBeGreaterThan(10)
    const { worst, est } = sail(2, 1, true)
    expect(worst).toBeLessThan(3)
    // It learnt a set to the east of about a metre a second.
    expect(est!.e).toBeGreaterThan(0.7)
    expect(est!.e).toBeLessThan(1.3)
  })

  it('learns nothing from a poor fix (rc6: ±20 m cross-track noise is not a set)', () => {
    let est: SetEstimate | null = null
    for (let t = 0; t < 120; t++) {
      est = updateSet(est, plan, 1, { ...fixAt(20, 100 + t * 2, 2, 0), accuracy: 20, timestamp: t * 1000 }, 1, 30)
    }
    expect(Math.hypot(est!.e, est!.n)).toBe(0)
  })

  it('learns nothing with no set, and nothing off the leg, in a turn, or on an estimated fix', () => {
    expect(Math.abs(sail(5, 0, true).est!.e)).toBeLessThan(0.05)
    const off = updateSet(null, plan, 1, { ...fixAt(20, -50, 5), timestamp: 0 }, 1, 30)
    expect(off).toEqual({ e: 0, n: 0 })
    const turning = updateSet(null, plan, 1, { ...fixAt(20, 500, 5, 90) }, 1, 30)
    expect(turning).toEqual({ e: 0, n: 0 })
    const est = updateSet(null, plan, 1, { ...fixAt(20, 500, 5), estimate: 'poor' }, 1, 30)
    expect(est).toEqual({ e: 0, n: 0 })
  })

  it('the allowance points up into the set, and is capped', () => {
    expect(setAllowanceDeg({ e: 1, n: 0 }, plan, 1, { speed: 2 })).toBeCloseTo(-30, 0)
    expect(setAllowanceDeg({ e: -1, n: 0 }, plan, 1, { speed: 2 })).toBeCloseTo(30, 0)
    expect(setAllowanceDeg({ e: 5, n: 0 }, plan, 1, { speed: 2 })).toBeGreaterThan(-37.5)
    // Along the leg it is no allowance at all.
    expect(setAllowanceDeg({ e: 0, n: 1 }, plan, 1, { speed: 2 })).toBe(0)
  })
})

describe('a helm seen swinging across the line gets a longer lookahead', () => {
  it('two full swings of 15 m+ within two minutes stretch it; it fades back', () => {
    let h: HelmRecord | null = null
    let t = 0
    for (const x of [5, 20, 30, 10, -5, -25, -30, -10, 5, 25, 20, 4, -20, -28]) {
      h = updateHelm(h, 1, x, 3, (t += 3000))
    }
    expect(h!.factor).toBeGreaterThan(1.3)
    expect(h!.factor).toBeLessThanOrEqual(HELM_FACTOR_MAX)
    const stretched = h!.factor
    for (let k = 0; k < 100; k++) h = updateHelm(h, 1, 1, 3, (t += 3000))
    expect(h!.factor).toBeLessThan(1 + (stretched - 1) * 0.5)
  })

  it('small wander, or a poor fix, is not a swing', () => {
    let h: HelmRecord | null = null
    let t = 0
    for (const x of [5, 10, -8, -12, 9, 12, -10, -9]) h = updateHelm(h, 1, x, 3, (t += 3000))
    expect(h!.factor).toBe(1)
    for (const x of [30, -30, 30, -30, 30]) h = updateHelm(h, 1, x, 25, (t += 3000))
    expect(h!.factor).toBe(1)
  })
})

describe('estimating between fixes (F1)', () => {
  it('deadReckon stops running on at maxAgeS', () => {
    const fix = { ...A, accuracy: 4, speed: 10, heading: 0, timestamp: 0, receivedAt: 0 }
    const five = deadReckon(fix, 5000, 5)
    const nine = deadReckon(fix, 9000, 5)
    expect(nine.lat).toBe(five.lat)
    expect(((five.lat - A.lat) * 111_000) / 50).toBeCloseTo(1, 1)
  })

  it('fixAgeS and legCourseDeg', () => {
    expect(fixAgeS({ timestamp: 0, receivedAt: 1000 }, 3500)).toBe(2.5)
    expect(fixAgeS({ timestamp: null }, 3500)).toBeNull()
    expect(legCourseDeg(plan, 1)).toBeCloseTo(0, 6)
    expect(legCourseDeg({ points: [A] }, 1)).toBeNull()
  })
})

describe('the boat\'s own turn rate is learnt (rc6, sluggish helm)', () => {
  // A boat at 10 m/s asked to come round `want`°, turning at `dps` after `lagS`.
  const timeTurn = (dps: number, lagS: number, prev: TurnRecord | null = null, want = 40) => {
    let rec = prev
    for (let t = 0; t <= 30; t++) {
      const h = t <= lagS ? 0 : Math.min(want, (t - lagS) * dps)
      rec = updateTurnRate(rec, { ...fixAt(0, t * 10, 10, h), timestamp: t * 1000 }, want, t * 1000)
    }
    return rec!
  }

  it('assumes 12°/s and 1.5 s until a turn is timed', () => {
    expect(turnRateDps(null)).toBe(TURN_ASSUMED_DPS)
    expect(turnReactS(null)).toBe(TURN_ASSUMED_REACT_S)
    expect(turnRateDps({ dps: null, reactS: null, n: 0, ep: null })).toBe(TURN_ASSUMED_DPS)
  })

  it('a brisk helm (15°/s, answering within 1 s) keeps the assumed figures', () => {
    const rec = timeTurn(15, 1)
    expect(rec.n).toBe(1)
    expect(rec.dps!).toBeGreaterThanOrEqual(12)
    expect(turnRateDps(rec)).toBe(TURN_ASSUMED_DPS)
    expect(turnReactS(rec)).toBe(TURN_ASSUMED_REACT_S)
  })

  it('a slow one (6°/s, 4 s to answer) is planned with what it showed', () => {
    const rec = timeTurn(6, 4)
    expect(rec.n).toBe(1)
    expect(turnRateDps(rec)).toBeCloseTo(6, 0)
    expect(turnReactS(rec)).toBeGreaterThanOrEqual(4)
    // …and a second turn is averaged in, not taken on its own.
    const more = timeTurn(15, 1, rec)
    expect(more.n).toBe(2)
    expect(more.dps!).toBeGreaterThan(6)
    expect(more.dps!).toBeLessThan(15)
  })

  it('learns nothing from a turn the helm did not make, a slow boat, or a poor fix', () => {
    expect(timeTurn(0, 0).n).toBe(0)
    let rec: TurnRecord | null = null
    for (let t = 0; t <= 20; t++) {
      rec = updateTurnRate(rec, { ...fixAt(0, t, 1, Math.min(90, t * 5)), timestamp: t * 1000 }, 90, t * 1000)
    }
    expect(rec!.n).toBe(0)
    rec = null
    for (let t = 0; t <= 20; t++) {
      const f = { ...fixAt(0, t * 10, 10, Math.min(90, t * 5)), timestamp: t * 1000, accuracy: 30 }
      rec = updateTurnRate(rec, f, 90, t * 1000)
    }
    expect(rec!.n).toBe(0)
  })
})

describe('ETA: a mild allowance for the turns ahead and the arrival (rc5 ETA)', () => {
  // A dog-leg: 1 km north, a 90° turn east, 1 km east.
  const P = { points: [A, { lat: A.lat + 1000 / M_LAT, lon: A.lon }, { lat: A.lat + 1000 / M_LAT, lon: A.lon + 1000 / M_LON }] }
  const here = { lat: A.lat, lon: A.lon }

  it('is off by default — distance over speed, as before', () => {
    const p = navProgress(P, 1, here, { speedKn: 10, now: 0 })!
    expect(p.timeToGoH! * 3600).toBeCloseTo((p.remainingNM / 10) * 3600, 6)
  })

  it('adds the arrival and each turn still ahead, pro rata to its angle', () => {
    const plain = navProgress(P, 1, here, { speedKn: 10, now: 0 })!
    const withIt = navProgress(P, 1, here, { speedKn: 10, now: 0, allowance: true })!
    expect((withIt.timeToGoH! - plain.timeToGoH!) * 3600).toBeCloseTo(ETA_ARRIVAL_S + ETA_TURN_S, 0)
    expect(withIt.etaMs! - plain.etaMs!).toBeCloseTo((ETA_ARRIVAL_S + ETA_TURN_S) * 1000, -2)
    // Past the turn, only the arrival is left.
    const last = navProgress(P, 2, P.points[1], { speedKn: 10, now: 0, allowance: true })!
    const lastPlain = navProgress(P, 2, P.points[1], { speedKn: 10, now: 0 })!
    expect((last.timeToGoH! - lastPlain.timeToGoH!) * 3600).toBeCloseTo(ETA_ARRIVAL_S, 0)
  })
})
