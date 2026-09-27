import { describe, it, expect } from 'vitest'
import {
  arrivalRadiusFt,
  isOffCourse,
  joinTarget,
  LOOKAHEAD_MIN_M,
  OFF_COURSE_FLOOR_M,
  passedTurn,
  steerCourse,
  fixTime,
  isStale,
  legGeometry,
  logProgress,
  navProgress,
  PROGRESS_MIN_S,
  PROGRESS_WINDOW_S,
  ROUNDED_FT,
  routeSpeedKn,
  shortcutClear,
  offCourseThresholdM,
  PASS_ABEAM_MAX_FT,
  recoverTarget,
  smoothSpeedKn,
  startTarget,
  stepTarget,
  type NavPlan,
  type ProgressSample,
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

  it('widens to the fix error, but never past the point’s own safe radius', () => {
    // Planned safe to 150 ft, crew set 100: a ±40 m (131 ft) fix may grow
    // the circle to 131 ft — still inside what the planner said is safe.
    const roomy = { points: [A, B, C], arrivalFt: [150, 150, 150] }
    const r = arrivalRadiusFt(roomy, 1, 40, { arrivalFt: 100 })
    expect(r.radiusFt).toBeCloseTo(131.2, 0)
    expect(r.safeFt).toBe(150)
    expect(r.gpsPoor).toBe(false)
    // ±100 m: capped at the 150 ft safe radius, and the fix is called poor.
    const poor = arrivalRadiusFt(roomy, 1, 100, { arrivalFt: 100 })
    expect(poor.radiusFt).toBe(150)
    expect(poor.gpsPoor).toBe(true)
  })

  it('never widens a hairpin’s small safe circle, however poor the fix', () => {
    // Integrator finding: the old rule widened a 30 ft hairpin circle to
    // 200 ft on a poor fix — switching early and cutting the corner the
    // planner shrank it to protect.
    const hairpin = { points: [A, B, C], arrivalFt: [150, 30, 150] }
    const r = arrivalRadiusFt(hairpin, 1, 30, { arrivalFt: 150 })
    expect(r.radiusFt).toBe(30)
    expect(r.gpsPoor).toBe(true)
  })

  it('without a planned radius the crew’s setting is the safe radius', () => {
    const r = arrivalRadiusFt(L, 1, 40, { arrivalFt: 100 })
    expect(r.radiusFt).toBe(100)
    expect(r.gpsPoor).toBe(true)
    expect(arrivalRadiusFt(L, 1, 20, { arrivalFt: 100 }).gpsPoor).toBe(false)
  })

  it('never exceeds 200 ft, whatever the plan says', () => {
    const wide = { points: [A, B, C], arrivalFt: [500, 500, 500] }
    const r = arrivalRadiusFt(wide, 1, 200, { arrivalFt: 500 })
    expect(r.radiusFt).toBe(200)
    expect(r.gpsPoor).toBe(true)
  })
})

describe('stepTarget — the circle', () => {
  it('holds until inside the circle, then advances one point', () => {
    expect(stepTarget(L, 1, go(B, 180, ft(200)), { arrivalFt: 150 }).targetIdx).toBe(1)
    const r = stepTarget(L, 1, go(B, 180, ft(120)), { arrivalFt: 150 })
    // toMatchObject: the result now also carries the range and the circle it
    // was judged by (for the store's arrival confirmation, F8).
    expect(r).toMatchObject({ targetIdx: 2, arrived: false, gpsPoor: false })
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

  it('widens the circle to a poor fix only as far as the point is safe', () => {
    // 180 ft short of the turn; the crew set 100 ft but the planner says
    // this point is safe out to 200 ft. A ±60 m (197 ft) fix may use that.
    const roomy = { points: [A, B, C], arrivalFt: [200, 200, 200] }
    const out = go(B, 180, ft(180))
    expect(stepTarget(roomy, 1, { ...out, accuracy: 5 }, { arrivalFt: 100 }).targetIdx).toBe(1)
    expect(stepTarget(roomy, 1, { ...out, accuracy: 60 }, { arrivalFt: 100 }).targetIdx).toBe(2)
  })

  it('does not widen past the safe radius on a poor fix — says the GPS is poor', () => {
    // Behaviour change (integrator finding): this used to widen the 150 ft
    // circle to the fix's 197 ft error and switch 180 ft short of the turn.
    // The turn is only safe to 150 ft, so it now holds and flags the fix.
    const out = go(B, 180, ft(180))
    const r = stepTarget(L, 1, { ...out, accuracy: 60 }, { arrivalFt: 150 })
    expect(r.targetIdx).toBe(1)
    expect(r.gpsPoor).toBe(true)
    // ±100 m, 250 ft short: held, poor.
    const far = stepTarget(L, 1, { ...go(B, 180, ft(250)), accuracy: 100 }, { arrivalFt: 150 })
    // toMatchObject: the result now also carries the range and the circle it
    // was judged by (for the store's arrival confirmation, F8).
    expect(far).toMatchObject({ targetIdx: 1, arrived: false, gpsPoor: true })
  })

  it('never cuts a hairpin on a poor fix', () => {
    // North to B, then straight back south-south-west round the tip of a
    // spit, B safe only to 30 ft. A ±30 m fix 60 ft short of B must not
    // switch — the old rule widened the circle to 98 ft here.
    const D = go(B, 200, 1)
    const hairpin = { points: [A, B, D], arrivalFt: [150, 30, 150] }
    const short = { ...go(B, 180, ft(60)), accuracy: 30, heading: 0 }
    const r = stepTarget(hairpin, 1, short, { arrivalFt: 150 })
    expect(r.targetIdx).toBe(1)
    expect(r.gpsPoor).toBe(true)
    // Inside the 30 ft circle it switches, poor fix or not.
    expect(stepTarget(hairpin, 1, { ...go(B, 180, ft(20)), accuracy: 30 }, { arrivalFt: 150 }).targetIdx).toBe(2)
    // Past the tip, still heading north, within 2 × 30 ft: pass-abeam takes it.
    const past = { ...go(B, 0, ft(50)), accuracy: 30, heading: 0 }
    expect(stepTarget(hairpin, 1, past, { arrivalFt: 150 }).targetIdx).toBe(2)
    // …but not 70 ft past: beyond twice the safe radius.
    const further = { ...go(B, 0, ft(70)), accuracy: 30, heading: 0 }
    expect(stepTarget(hairpin, 1, further, { arrivalFt: 150 }).targetIdx).toBe(1)
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

  it('never beyond 200 ft, however wide the circle — the crew’s 100–200 ft rule', () => {
    // Behaviour changed on purpose (review finding voyage-4): the cap was
    // 400 ft (two 200 ft circles), which selected the next waypoint up to
    // 300–400 ft out — outside the user's "within 100–200 ft" rule and
    // outside anything the planner's corner check measured. Old rule before
    // that: 3 × 150 = 450 ft.
    expect(PASS_ABEAM_MAX_FT).toBe(200)
    const wide = { points: [A, B, C], arrivalFt: [200, 200, 200] }
    const at190 = { ...go(B, 0, ft(190)), heading: 0 }
    const at250 = { ...go(B, 0, ft(250)), heading: 0 }
    const at390 = { ...go(B, 0, ft(390)), heading: 0 }
    expect(stepTarget(wide, 1, at190, { arrivalFt: 200 }).targetIdx).toBe(2)
    expect(stepTarget(wide, 1, at250, { arrivalFt: 200 }).targetIdx).toBe(1)
    expect(stepTarget(wide, 1, at390, { arrivalFt: 200 }).targetIdx).toBe(1)
    // At the 150 ft setting: 256 ft and 298 ft past (the drift runs) no
    // longer switch.
    expect(stepTarget(L, 1, { ...go(B, 0, ft(256)), heading: 0 }, { arrivalFt: 150 }).targetIdx).toBe(1)
    expect(stepTarget(L, 1, { ...go(B, 0, ft(298)), heading: 0 }, { arrivalFt: 150 }).targetIdx).toBe(1)
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
    // toMatchObject: the result now also carries the range and the circle it
    // was judged by (for the store's arrival confirmation, F8).
    expect(r).toMatchObject({ targetIdx: 2, arrived: true, gpsPoor: false })
  })

  it('has not arrived outside it', () => {
    expect(stepTarget(L, 2, go(C, 270, ft(300)), { arrivalFt: 150 }).arrived).toBe(false)
  })

  it('arrives on running past the destination between fixes', () => {
    // 180 ft, not 200: pass-abeam now reaches 200 ft at most (voyage-4),
    // and exactly 200 ft sits on the edge of that.
    const past = { ...go(C, 90, ft(180)), heading: 90 }
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
  it('judges the age on the phone clock at arrival, not the position’s own stamp (clock skew)', () => {
    // A position stamped with GNSS time on a phone whose clock is a minute
    // off either way, but that has just arrived: live.
    expect(isStale({ timestamp: now - 60_000, receivedAt: now }, now)).toBe(false)
    expect(isStale({ timestamp: now + 60_000, receivedAt: now }, now)).toBe(false)
    // …and it still goes stale 15 s after it arrived, even with a stamp in
    // the future.
    expect(isStale({ timestamp: now + 60_000, receivedAt: now - 16_000 }, now)).toBe(true)
    expect(fixTime({ timestamp: 5, receivedAt: 9 })).toBe(9)
    expect(fixTime({ timestamp: 5 })).toBe(5)
    expect(fixTime({})).toBeNull()
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

describe('a short hop between turn points (UI-5)', () => {
  it('with the planner’s capped circles, reaching one point never lands the boat inside the next', () => {
    // wp1 → wp2 is 122 ft. The planner now caps each circle at half the
    // legs either side (61 ft), so arriving at wp1 cannot also be arriving
    // at wp2, and wp2 is steered to in turn instead of flashing past.
    const P1 = go(A, 0, 0.5)
    const P2 = go(P1, 0, ft(122))
    const P3 = go(P2, 90, 0.5)
    const plan = { points: [A, P1, P2, P3], arrivalFt: [150, 61, 61, 150] }
    const atP1 = { ...go(P1, 180, ft(55)), heading: 0, accuracy: 3 }
    const s1 = stepTarget(plan, 1, atP1, { arrivalFt: 150 })
    expect(s1.targetIdx).toBe(2)
    // The next fix from the same place does not skip wp2.
    const s2 = stepTarget(plan, s1.targetIdx, atP1, { arrivalFt: 150 })
    expect(s2.targetIdx).toBe(2)
  })
})

describe('shortcutClear — rounding a turn point (C1)', () => {
  // A right-angle turn at B: north up A→B, east along B→C.
  const before = (distFt: number, offM = 0) => go(go(B, 180, ft(distFt)), 90, m(offM))

  it('is clear the moment the chart says the straight line is clear', () => {
    expect(shortcutClear(L, 1, { ...before(180, 20), accuracy: 5 }, 'clear')).toBe(true)
  })

  it('is not while the chart says it is unsafe — until the boat is at the turn point', () => {
    expect(shortcutClear(L, 1, { ...before(180, 20), accuracy: 5 }, 'unsafe')).toBe(false)
    expect(shortcutClear(L, 1, { ...before(60), accuracy: 5 }, 'unsafe')).toBe(false)
    expect(shortcutClear(L, 1, { ...before(ROUNDED_FT - 5), accuracy: 5 }, 'unsafe')).toBe(true)
    // A fair fix widens "at the turn point" to its error — up to twice the floor.
    expect(shortcutClear(L, 1, { ...before(45), accuracy: 15 }, 'unsafe')).toBe(true)
    expect(shortcutClear(L, 1, { ...before(90), accuracy: 60 }, 'unsafe')).toBe(false)
  })

  it('with no chart to check against: once at the turn point or abeam of it — never round in circles', () => {
    expect(shortcutClear(L, 1, { ...before(150, 20), accuracy: 5 }, null)).toBe(false)
    // Abeam of B, 20 m inside the turn; and past it.
    expect(shortcutClear(L, 1, { ...go(B, 90, m(20)), accuracy: 5 }, null)).toBe(true)
    expect(shortcutClear(L, 1, { ...go(go(B, 0, ft(30)), 90, m(20)), accuracy: 5 }, null)).toBe(true)
    // On the leg out of B, past it, 10 m off the line — even a little short
    // of abeam on the leg in.
    expect(shortcutClear(L, 1, { ...go(go(B, 90, m(100)), 180, m(10)), accuracy: 5 }, null)).toBe(true)
  })

  it('has nothing to guard past the last leg', () => {
    expect(shortcutClear(L, 2, { ...C, accuracy: 5 }, 'unsafe')).toBe(true)
  })
})

describe('speed made good along the route — the ETA (N2)', () => {
  it('keeps half a minute of distance to go, and restarts on a sample from the past', () => {
    let log = logProgress(null, { t: 0, remainingNM: 5 })
    for (let s = 1; s <= 60; s++) log = logProgress(log, { t: s * 1000, remainingNM: 5 - s * 0.003 })
    expect(log[log.length - 1].t - log[0].t).toBeGreaterThanOrEqual(PROGRESS_WINDOW_S * 1000)
    expect(log[log.length - 1].t - log[1].t).toBeLessThan(PROGRESS_WINDOW_S * 1000)
    expect(logProgress(log, { t: 10_000, remainingNM: 4 })).toEqual([{ t: 10_000, remainingNM: 4 }])
  })

  it('needs ten seconds of progress, and a knot of it', () => {
    const log = [
      { t: 0, remainingNM: 2 },
      { t: (PROGRESS_MIN_S - 1) * 1000, remainingNM: 1.99 },
    ]
    expect(routeSpeedKn(log)).toBeNull()
    expect(routeSpeedKn([{ t: 0, remainingNM: 2 }, { t: 60_000, remainingNM: 2 }])).toBeNull()
  })

  it('reads the speed the boat is really closing the destination at, not a lagging average', () => {
    // 20 kn over the ground for a minute, then slowed to 8 kn for a no-wake
    // zone. Fifteen seconds after slowing, the smoothed speed over the
    // ground still says ~13.8 kn; the route has only been closing at 8.
    let sog: number | null = null
    let log: ProgressSample[] = []
    let rem = 3
    for (let s = 0; s <= 75; s++) {
      const kn = s <= 60 ? 20 : 8
      if (s > 0) rem -= kn / 3600
      sog = smoothSpeedKn(sog, { speed: kn / 1.943844 }, 1)
      log = logProgress(log, { t: s * 1000, remainingNM: rem, sogKn: kn })
    }
    // Truth: the rest at 8 kn. The smoothed speed still says ~12 kn.
    const truthH = rem / 8
    const bySog = rem / sog!
    const byRoute = rem / routeSpeedKn(log)!
    expect(Math.abs(bySog - truthH) / truthH).toBeGreaterThan(0.3)
    expect(Math.abs(byRoute - truthH) / truthH).toBeLessThan(0.02)
  })

  it('knows a boat weaving across the line is not closing at its speed over the ground', () => {
    // 20 kn over the ground, zig-zagging 40° either side of the route: it
    // closes at 20 × cos 40° ≈ 15.3 kn, and the ETA is worked at that.
    let log: ProgressSample[] = []
    let rem = 3
    for (let s = 0; s <= 40; s++) {
      if (s > 0) rem -= (20 * Math.cos((40 * Math.PI) / 180)) / 3600
      log = logProgress(log, { t: s * 1000, remainingNM: rem, sogKn: 20 })
    }
    expect(routeSpeedKn(log)).toBeCloseTo(15.32, 1)
    // With no speeds logged, the progress rate alone says the same.
    expect(routeSpeedKn(log.map(({ t, remainingNM }) => ({ t, remainingNM })))).toBeCloseTo(15.32, 1)
  })
})

describe('the course to steer — back onto the line (F4)', () => {
  it('is the leg’s own course on the line, and the bearing to the point', () => {
    const on = { ...go(A, 0, 0.5), accuracy: 3 }
    const c = steerCourse(L, 1, on)!
    expect(c.bearingDeg).toBeCloseTo(0, 0)
    expect(Math.abs(c.xteM!)).toBeLessThan(0.5)
  })

  it('set off the line, steers back onto it ahead — not a new line to the point', () => {
    // 40 m east (starboard) of the northbound leg, half a mile short of B.
    const off = { ...go(go(A, 0, 0.5), 90, m(40)), accuracy: 3 }
    const c = steerCourse(L, 1, off)!
    expect(c.xteM!).toBeCloseTo(40, 0)
    const direct = navProgress(L, 1, off)!.bearingDeg
    // Direct to B is ~2.5° left of north; back onto the line is ~45° left.
    expect(((direct - c.bearingDeg + 540) % 360) - 180).toBeGreaterThan(30)
    // The aim point is ON the leg, ahead of the boat.
    const g = legGeometry(A, B, c.aim)
    expect(g.distM).toBeLessThan(0.5)
    expect(g.alongM).toBeGreaterThan(legGeometry(A, B, off).alongM)
  })

  it('never cuts in steeper than 45°, and aims at the point itself near it', () => {
    const off = { ...go(go(A, 0, 0.5), 90, m(10)), accuracy: 3 }
    const c = steerCourse(L, 1, off)!
    expect(c.lookaheadM).toBeGreaterThanOrEqual(LOOKAHEAD_MIN_M)
    const near = { ...go(B, 180, m(20)), accuracy: 3 }
    expect(steerCourse(L, 1, near)!.aim).toEqual(B)
  })

  it('aims further ahead on a poor fix, so it does not chase the receiver’s wander', () => {
    const off = go(go(A, 0, 0.3), 90, m(15))
    const good = steerCourse(L, 1, { ...off, accuracy: 4 })!
    const poor = steerCourse(L, 1, { ...off, accuracy: 20 })!
    expect(poor.lookaheadM).toBeGreaterThan(good.lookaheadM * 5)
  })
})

describe('off course, scaled with the stand-off (F4)', () => {
  it('uses twice the stand-off, 20–60 m, when it is known', () => {
    const fix = { ...go(A, 0, 0.5), accuracy: 3 }
    expect(offCourseThresholdM(L, 1, fix, { marginM: 5 })).toBe(OFF_COURSE_FLOOR_M)
    expect(offCourseThresholdM(L, 1, fix, { marginM: 15 })).toBe(30)
    expect(offCourseThresholdM(L, 1, fix, { marginM: 45 })).toBe(60)
    // A boat 35 m off a line planned 5 m clear of the bank is off course.
    const off = { ...go(go(A, 0, 0.5), 90, m(35)), accuracy: 3 }
    expect(isOffCourse(L, 1, off, { marginM: 5 })).toBe(true)
    expect(isOffCourse(L, 1, off)).toBe(false)
  })

  it('stays accuracy-aware: a poor fix alone does not re-route', () => {
    const fix = { ...go(A, 0, 0.5), accuracy: 20 }
    expect(offCourseThresholdM(L, 1, fix, { marginM: 5 })).toBe(50)
  })
})

describe('rounding a turn — abeam and past it (F6)', () => {
  it('is round only when past the turn point on the inbound leg AND on the way out', () => {
    expect(passedTurn(L, 1, go(B, 180, m(30)))).toBe(false)
    expect(passedTurn(L, 1, go(go(B, 0, m(10)), 90, m(20)))).toBe(true)
    // Round a hairpin, a boat still short of the mark is "behind" the
    // outbound leg: not round.
    const hairpin: NavPlan = { points: [A, B, go(A, 90, m(40))] }
    expect(passedTurn(hairpin, 1, go(go(A, 0, 0.5), 90, m(20)))).toBe(false)
  })
})

describe('joining an accepted re-route (F5)', () => {
  it('never returns the start: the far end of the nearest leg not yet run', () => {
    expect(joinTarget(L, go(A, 90, m(150)))).toBe(1)
    expect(joinTarget(L, { ...go(go(B, 90, 0.5), 0, m(150)), heading: 90 })).toBe(2)
  })
})

describe('ETA speed made good is robust (F7)', () => {
  function run(kn: number, glitch: (s: number, rem: number) => { rem: number; sog: number }) {
    let log: ProgressSample[] = []
    let rem = 3
    for (let s = 0; s <= 90; s++) {
      if (s > 0) rem -= kn / 3600
      const g = glitch(s, rem)
      log = logProgress(log, { t: s * 1000, remainingNM: g.rem, sogKn: g.sog })
    }
    return routeSpeedKn(log)!
  }

  it('shrugs off a fix that wandered, and a corner switched early', () => {
    // Two fixes 90 m out, then back.
    const spike = run(12, (s, rem) => ({ rem: s === 80 || s === 81 ? rem + 0.05 : rem, sog: 12 }))
    expect(spike).toBeGreaterThan(11.5)
    expect(spike).toBeLessThan(12.5)
    // The distance to go drops 20 m at a switch that cut the corner.
    const cut = run(12, (s, rem) => ({ rem: s >= 70 ? rem - 20 / 1852 : rem, sog: 12 }))
    expect(cut).toBeGreaterThan(11)
    expect(cut).toBeLessThan(13.5)
  })

  it('ignores the filter’s zero-speed dropouts', () => {
    const v = run(12, (s, rem) => ({ rem, sog: s % 5 === 0 ? 0 : 12 }))
    expect(v).toBeGreaterThan(11)
    expect(v).toBeLessThan(13)
  })
})
