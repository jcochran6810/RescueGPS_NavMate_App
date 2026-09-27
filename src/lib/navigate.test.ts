import { describe, it, expect } from 'vitest'
import {
  arrivalRadiusFt,
  isOffCourse,
  isStale,
  legGeometry,
  navProgress,
  offCourseThresholdM,
  recoverTarget,
  smoothSpeedKn,
  startTarget,
  stepTarget,
  type NavPlan,
} from './navigate'
import { FT_PER_NM } from './steer'
import { haversineNM, NM_TO_METERS } from './geo'
import { projectPosition } from './sar'
import type { LatLon } from './search'

/** Feet → NM, for `projectPosition`. */
const ft = (n: number) => n / FT_PER_NM
/** Metres → NM. */
const m = (n: number) => n / NM_TO_METERS
const go = (p: LatLon, deg: number, nm: number) => projectPosition(p.lat, p.lon, deg, nm)

const A = { lat: 29.3, lon: -94.8 }
/** North 1 NM to B, then east 1 NM to C. A right-angle turn at B. */
const B = go(A, 0, 1)
const C = go(B, 90, 1)
const L: NavPlan = { points: [A, B, C] }

describe('legGeometry', () => {
  it('signs cross-track positive to starboard, negative to port', () => {
    // Running north, starboard is east.
    const mid = go(A, 0, 0.5)
    expect(legGeometry(A, B, go(mid, 90, m(40))).crossM).toBeCloseTo(40, 0)
    expect(legGeometry(A, B, go(mid, 270, m(40))).crossM).toBeCloseTo(-40, 0)
    // Running east, starboard is south.
    const midBC = go(B, 90, 0.5)
    expect(legGeometry(B, C, go(midBC, 180, m(25))).crossM).toBeCloseTo(25, 0)
  })

  it('measures to the SEGMENT, not the infinite line, past its end', () => {
    const beyond = go(B, 0, m(300))
    const g = legGeometry(A, B, beyond)
    expect(Math.abs(g.crossM)).toBeLessThan(1)
    expect(g.distM).toBeCloseTo(300, 0)
    expect(g.alongM).toBeCloseTo(g.lengthM + 300, 0)
  })
})

describe('navProgress', () => {
  it('gives bearing and distance to the target', () => {
    const here = go(A, 0, 0.25)
    const p = navProgress(L, 1, here)!
    expect(p.target).toEqual(B)
    expect(p.bearingDeg).toBeCloseTo(0, 1)
    expect(p.distanceNM).toBeCloseTo(0.75, 3)
    expect(p.legIdx).toBe(0)
    expect(p.isFinal).toBe(false)
  })

  it('sums the remaining distance: to the target, then every later leg', () => {
    const here = go(A, 0, 0.25)
    const p = navProgress(L, 1, here)!
    expect(p.remainingNM).toBeCloseTo(0.75 + 1, 3)
    // On the last leg only the run to the destination is left.
    const q = navProgress(L, 2, go(B, 90, 0.4))!
    expect(q.remainingNM).toBeCloseTo(0.6, 3)
    expect(q.isFinal).toBe(true)
  })

  it('reports xte from the leg being run, + right of track', () => {
    const right = go(go(A, 0, 0.5), 90, m(50))
    const left = go(go(A, 0, 0.5), 270, m(50))
    expect(navProgress(L, 1, right)!.xteM).toBeCloseTo(50, 0)
    expect(navProgress(L, 1, left)!.xteM).toBeCloseTo(-50, 0)
  })

  it('has no xte while steering to the first point — there is no leg into it', () => {
    const p = navProgress(L, 0, go(A, 180, 0.2))!
    expect(p.xteM).toBeNull()
    expect(p.legIdx).toBeNull()
    expect(p.remainingNM).toBeCloseTo(0.2 + 2, 3)
  })

  it('works the ETA from the speed being made good', () => {
    const now = Date.UTC(2026, 8, 26, 12, 0, 0)
    const p = navProgress(L, 1, A, { speedKn: 10, cruiseKn: 20, now })!
    expect(p.speedSource).toBe('gps')
    expect(p.speedKn).toBe(10)
    expect(p.timeToGoH).toBeCloseTo(0.2, 3)
    expect(p.etaMs).toBeCloseTo(now + 0.2 * 3_600_000, -3)
  })

  it('falls back to cruise speed below a knot, and says so', () => {
    // Drifting at the dock: "11 hours" from 0.2 kn is arithmetic, not an ETA.
    const p = navProgress(L, 1, A, { speedKn: 0.2, cruiseKn: 20, now: 0 })!
    expect(p.speedSource).toBe('cruise')
    expect(p.speedKn).toBe(20)
    expect(p.timeToGoH).toBeCloseTo(0.1, 3)
  })

  it('gives no time at all when there is no usable speed', () => {
    const p = navProgress(L, 1, A, { speedKn: null, cruiseKn: 0 })!
    expect(p.timeToGoH).toBeNull()
    expect(p.etaMs).toBeNull()
    expect(p.speedKn).toBeNull()
  })

  it('clamps an out-of-range index and refuses without a fix', () => {
    expect(navProgress(L, 9, A)!.targetIdx).toBe(2)
    expect(navProgress(L, -3, A)!.targetIdx).toBe(0)
    expect(navProgress(L, 1, null)).toBeNull()
    expect(navProgress({ points: [] }, 0, A)).toBeNull()
  })
})

describe('arrivalRadiusFt', () => {
  it('uses the planned radius for the point', () => {
    const plan = { points: [A, B, C], arrivalFt: [150, 60, 150] }
    expect(arrivalRadiusFt(plan, 1, null, { arrivalFt: 150 }).radiusFt).toBe(60)
  })

  it('never exceeds the crew’s current setting — turning it down needs no re-plan', () => {
    const plan = { points: [A, B, C], arrivalFt: [150, 150, 150] }
    expect(arrivalRadiusFt(plan, 1, null, { arrivalFt: 100 }).radiusFt).toBe(100)
  })

  it('widens to the fix error, but never past 200 ft', () => {
    expect(arrivalRadiusFt(L, 1, 40, { arrivalFt: 100 }).radiusFt).toBeCloseTo(131.2, 0)
    const poor = arrivalRadiusFt(L, 1, 100, { arrivalFt: 100 })
    expect(poor.radiusFt).toBe(200)
    expect(poor.gpsPoor).toBe(true)
  })
})

describe('stepTarget — the circle', () => {
  it('holds until inside the circle, then advances one point', () => {
    expect(stepTarget(L, 1, go(B, 180, ft(200)), { arrivalFt: 150 }).targetIdx).toBe(1)
    const r = stepTarget(L, 1, go(B, 180, ft(120)), { arrivalFt: 150 })
    expect(r).toEqual({ targetIdx: 2, arrived: false, gpsPoor: false })
  })

  it('advances at most ONE point per fix, even on top of a later one', () => {
    // A coarse fix that lands on the destination while steering to point 1
    // must not skip the turn at B — that turn is there for a reason.
    const plan: NavPlan = { points: [A, B, go(B, 90, ft(100)), C] }
    const r = stepTarget(plan, 1, B, { arrivalFt: 150 })
    expect(r.targetIdx).toBe(2)
  })

  it('uses the per-point safe radius the planner set at a tight turn', () => {
    const plan = { points: [A, B, C], arrivalFt: [150, 40, 150] }
    const at100 = go(B, 180, ft(100))
    expect(stepTarget(plan, 1, at100, { arrivalFt: 150 }).targetIdx).toBe(1)
    expect(stepTarget(L, 1, at100, { arrivalFt: 150 }).targetIdx).toBe(2)
  })

  it('widens the circle to a fix that cannot resolve it', () => {
    // 180 ft short of a 150 ft circle, but ±60 m (197 ft) of fix error.
    const out = go(B, 180, ft(180))
    expect(stepTarget(L, 1, { ...out, accuracy: 5 }, { arrivalFt: 150 }).targetIdx).toBe(1)
    expect(stepTarget(L, 1, { ...out, accuracy: 60 }, { arrivalFt: 150 }).targetIdx).toBe(2)
  })

  it('caps a poor fix at 200 ft and says the GPS is poor', () => {
    // ±100 m would have made a 328 ft circle and switched the boat to the
    // next leg 250 ft short of the turn — hiding the bearing it still needs.
    const out = go(B, 180, ft(250))
    const r = stepTarget(L, 1, { ...out, accuracy: 100 }, { arrivalFt: 150 })
    expect(r.targetIdx).toBe(1)
    expect(r.gpsPoor).toBe(true)
  })

  it('uses the circle alone for the first point', () => {
    const past = { ...go(A, 0, ft(120)), heading: 0 }
    expect(stepTarget(L, 0, past, { arrivalFt: 100 }).targetIdx).toBe(0)
    expect(stepTarget(L, 0, go(A, 180, ft(80)), { arrivalFt: 100 }).targetIdx).toBe(1)
  })

  it('waits without a fix', () => {
    expect(stepTarget(L, 1, null)).toEqual({ targetIdx: 1, arrived: false, gpsPoor: false })
  })
})

describe('stepTarget — passing abeam', () => {
  const plan = { points: [A, B, C], arrivalFt: [150, 50, 150] }

  it('advances a boat that ran past the mark within two circles, still on course', () => {
    const past = { ...go(B, 0, ft(90)), heading: 0 }
    expect(stepTarget(plan, 1, past, { arrivalFt: 150 }).targetIdx).toBe(2)
  })

  it('not beyond two circles', () => {
    const past = { ...go(B, 0, ft(130)), heading: 0 }
    expect(stepTarget(plan, 1, past, { arrivalFt: 150 }).targetIdx).toBe(1)
  })

  it('never beyond 400 ft, however wide the circle', () => {
    // Old rule: 3 × 150 = 450 ft. Now two circles, and 400 ft at most.
    const wide = { points: [A, B, C], arrivalFt: [200, 200, 200] }
    const at390 = { ...go(B, 0, ft(390)), heading: 0 }
    const at420 = { ...go(B, 0, ft(420)), heading: 0 }
    expect(stepTarget(wide, 1, at390, { arrivalFt: 200 }).targetIdx).toBe(2)
    expect(stepTarget(wide, 1, at420, { arrivalFt: 200 }).targetIdx).toBe(1)
    expect(stepTarget(L, 1, { ...go(B, 0, ft(420)), heading: 0 }, { arrivalFt: 150 }).targetIdx).toBe(1)
  })

  it('gives the mark back to a boat that is coming round again', () => {
    const past = { ...go(B, 0, ft(90)), heading: 180 }
    expect(stepTarget(plan, 1, past, { arrivalFt: 150 }).targetIdx).toBe(1)
  })

  it('does nothing without a heading', () => {
    const past = go(B, 0, ft(90))
    expect(stepTarget(plan, 1, past, { arrivalFt: 150 }).targetIdx).toBe(1)
  })

  it('does not skip a hairpin turn from the far side of it', () => {
    // North to B, then back south-south-west past the tip of a spit. A boat
    // still running north just short of B — i.e. right beside the outbound
    // leg — has NOT rounded B.
    const D = go(B, 200, 1)
    const hairpin = { points: [A, B, D], arrivalFt: [150, 100, 150] }
    const short = { ...go(B, 180, ft(200)), heading: 0 }
    expect(stepTarget(hairpin, 1, short, { arrivalFt: 150 }).targetIdx).toBe(1)
    // …and one that ran just past the tip, still going north, has.
    const past = { ...go(B, 0, ft(150)), heading: 0 }
    expect(stepTarget(hairpin, 1, past, { arrivalFt: 150 }).targetIdx).toBe(2)
  })
})

describe('stepTarget — arrival', () => {
  it('arrives inside the destination circle, and stays on the last point', () => {
    const r = stepTarget(L, 2, go(C, 270, ft(100)), { arrivalFt: 150 })
    expect(r).toEqual({ targetIdx: 2, arrived: true, gpsPoor: false })
  })

  it('has not arrived outside it', () => {
    expect(stepTarget(L, 2, go(C, 270, ft(300)), { arrivalFt: 150 }).arrived).toBe(false)
  })

  it('arrives on running past the destination between fixes', () => {
    const past = { ...go(C, 90, ft(200)), heading: 90 }
    expect(stepTarget(L, 2, past, { arrivalFt: 150 }).arrived).toBe(true)
  })
})

describe('recoverTarget — the missed mark', () => {
  it('moves on when the boat cut the corner and is running the next leg', () => {
    // Turned early, never within 150 ft of B, now 0.2 NM down the east leg
    // and 30 m south of it. Steering it back to B would be steering astern.
    const here = { ...go(go(B, 90, 0.2), 180, m(30)), heading: 90 }
    expect(recoverTarget(L, 1, here, { arrivalFt: 150 })).toBe(2)
  })

  it('does not move on for a boat heading the other way down that leg', () => {
    const here = { ...go(go(B, 90, 0.2), 180, m(30)), heading: 270 }
    expect(recoverTarget(L, 1, here, { arrivalFt: 150 })).toBe(1)
  })

  it('does nothing without a heading', () => {
    const here = go(go(B, 90, 0.2), 180, m(30))
    expect(recoverTarget(L, 1, here, { arrivalFt: 150 })).toBe(1)
  })

  it('never skips ahead while the boat is still on its own leg', () => {
    const here = { ...go(A, 0, 0.5), heading: 0 }
    expect(recoverTarget(L, 1, here, { arrivalFt: 150 })).toBe(1)
  })

  it('holds the hairpin: drifting toward the return leg is not being on it', () => {
    // 20° hairpin at B. 300 m short of B the legs are ~100 m apart; a boat
    // 60 m off its track toward the return leg is still going north.
    const D = go(B, 200, 1)
    const hairpin: NavPlan = { points: [A, B, D] }
    const drift = { ...go(go(B, 180, m(300)), 270, m(60)), heading: 0 }
    expect(recoverTarget(hairpin, 1, drift, { arrivalFt: 150 })).toBe(1)
  })

  it('recovers several marks at once when the boat is clearly further on', () => {
    // A dog-leg route; the boat took a shortcut and is now on leg 3 of 4.
    const P0 = A
    const P1 = go(P0, 0, 0.5)
    const P2 = go(P1, 60, 0.5)
    const P3 = go(P2, 0, 0.5)
    const P4 = go(P3, 60, 0.5)
    const plan: NavPlan = { points: [P0, P1, P2, P3, P4] }
    const here = { ...go(P2, 0, 0.3), heading: 0 }
    expect(recoverTarget(plan, 1, here, { arrivalFt: 150 })).toBe(3)
  })

  it('leaves an overshoot alone — that is a job for the off-course re-route', () => {
    // 300 m past B, still going north: equally far from both legs, on neither.
    const over = { ...go(B, 0, m(300)), heading: 0 }
    expect(recoverTarget(L, 1, over, { arrivalFt: 150 })).toBe(1)
    expect(isOffCourse(L, 1, over, { arrivalFt: 150 })).toBe(true)
  })

  it('has nothing to recover to from the destination', () => {
    expect(recoverTarget(L, 2, { ...go(C, 90, 0.2), heading: 90 })).toBe(2)
  })
})

describe('startTarget', () => {
  it('steers to point 1 from the start', () => {
    expect(startTarget(L, A)).toBe(1)
    expect(startTarget(L, go(A, 200, m(40)))).toBe(1)
  })

  it('picks up mid-passage where the boat is — not back at the first turn', () => {
    const onSecondLeg = { ...go(B, 90, 0.4), heading: 90 }
    expect(startTarget(L, onSecondLeg)).toBe(2)
    expect(startTarget(L, go(A, 0, 0.6))).toBe(1)
  })

  it('sends a boat away from the route to its start', () => {
    expect(startTarget(L, go(A, 270, 2))).toBe(0)
  })

  it('steers to the start of a snapped route from before it', () => {
    // The first point is the snapped start 300 m out; the boat is still at
    // the dock behind it, off the route.
    const snapped: NavPlan = { points: [go(A, 180, m(300)), A, B] }
    expect(startTarget(snapped, go(A, 180, m(700)))).toBe(0)
  })

  it('uses the heading to choose between legs that run close together', () => {
    const D = go(B, 185, 1)
    const hairpin: NavPlan = { points: [A, B, D] }
    // Halfway, the legs are ~0.044 NM (81 m) apart; the boat is between them.
    const between = go(go(A, 0, 0.5), 270, m(40))
    expect(startTarget(hairpin, { ...between, heading: 0 })).toBe(1)
    expect(startTarget(hairpin, { ...between, heading: 185 })).toBe(2)
  })

  it('assumes point 1 with no fix yet; point 0 for a one-point plan', () => {
    expect(startTarget(L, null)).toBe(1)
    expect(startTarget({ points: [A] }, A)).toBe(0)
  })
})

describe('isOffCourse', () => {
  it('is on course on the leg and a little either side of it', () => {
    expect(isOffCourse(L, 1, go(go(A, 0, 0.5), 90, m(40)))).toBe(false)
  })

  it('is off course well away from it', () => {
    expect(isOffCourse(L, 1, go(go(A, 0, 0.5), 90, m(100)))).toBe(true)
  })

  it('does not let a poor fix trigger it on its own', () => {
    const here = { ...go(go(A, 0, 0.5), 90, m(100)), accuracy: 80 }
    expect(offCourseThresholdM(L, 1, here)).toBeCloseTo(120, 5)
    expect(isOffCourse(L, 1, here)).toBe(false)
  })

  it('scales with the arrival circle', () => {
    // 200 ft circle → 122 m threshold.
    const here = go(go(A, 0, 0.5), 90, m(100))
    expect(isOffCourse(L, 1, here, { arrivalFt: 200 })).toBe(false)
  })

  it('takes an explicit threshold', () => {
    expect(isOffCourse(L, 1, go(go(A, 0, 0.5), 90, m(40)), { thresholdM: 30 })).toBe(true)
  })

  it('measures to the start point while steering to it', () => {
    expect(isOffCourse(L, 0, go(A, 180, m(40)))).toBe(false)
    expect(isOffCourse(L, 0, go(A, 180, 1))).toBe(true)
  })

  it('is never off course without a fix', () => {
    expect(isOffCourse(L, 1, null)).toBe(false)
  })
})

describe('isStale', () => {
  const now = 1_000_000_000
  it('is fresh within 15 s', () => {
    expect(isStale({ timestamp: now - 14_000 }, now)).toBe(false)
  })
  it('is stale past 15 s', () => {
    expect(isStale({ timestamp: now - 16_000 }, now)).toBe(true)
  })
  it('is stale with no fix or no time on it', () => {
    expect(isStale(null, now)).toBe(true)
    expect(isStale({}, now)).toBe(true)
    expect(isStale({ timestamp: Number.NaN }, now)).toBe(true)
  })
  it('takes another limit', () => {
    expect(isStale({ timestamp: now - 6_000 }, now, 5)).toBe(true)
  })
})

describe('smoothSpeedKn', () => {
  const kn = (k: number) => ({ speed: k / 1.943844 })

  it('takes the first speed as it is', () => {
    expect(smoothSpeedKn(null, kn(12), 1)).toBeCloseTo(12, 6)
  })

  it('moves toward a new speed, more for a longer gap', () => {
    const short = smoothSpeedKn(20, kn(10), 1)!
    const long = smoothSpeedKn(20, kn(10), 15)!
    expect(short).toBeLessThan(20)
    expect(short).toBeGreaterThan(long)
    expect(long).toBeGreaterThan(10)
    // One time constant covers ~63 % of the change.
    expect(long).toBeCloseTo(20 - 10 * (1 - Math.exp(-1)), 6)
  })

  it('settles on a steady speed', () => {
    let s: number | null = 0
    for (let i = 0; i < 120; i++) s = smoothSpeedKn(s, kn(18), 1)
    expect(s).toBeCloseTo(18, 1)
  })

  it('keeps the previous figure through a fix without a speed', () => {
    expect(smoothSpeedKn(14, { speed: null }, 1)).toBe(14)
    expect(smoothSpeedKn(null, { speed: null }, 1)).toBeNull()
    expect(smoothSpeedKn(14, null, 1)).toBe(14)
  })

  it('survives a nonsense interval', () => {
    expect(Number.isFinite(smoothSpeedKn(10, kn(12), Number.NaN)!)).toBe(true)
  })
})

describe('the geometry is the drawn line', () => {
  it('measures remaining distance from the points, whatever the legs say', () => {
    const p = navProgress(L, 1, A)!
    expect(p.remainingNM).toBeCloseTo(
      haversineNM(A.lat, A.lon, B.lat, B.lon) + haversineNM(B.lat, B.lon, C.lat, C.lon),
      6,
    )
  })
})
