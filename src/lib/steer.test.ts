import { describe, it, expect } from 'vitest'
import {
  arrivalRadiusNM,
  DEFAULT_ARRIVAL_FT,
  FT_PER_NM,
  shouldAdvance,
  type SteerablePlan,
} from './steer'
import { buildLegs, type LatLon } from './search'
import { projectPosition } from './sar'

function planOf(points: LatLon[]): SteerablePlan {
  return { points, legs: buildLegs(points, () => true).legs }
}

const A = { lat: 29.3, lon: -94.8 }
const ft = (n: number) => n / FT_PER_NM

/**
 * A plan that runs due north to the mark and then due east away from it, so
 * "past the mark, still going" and "turning back" are easy to place.
 */
const plan = planOf([
  A,
  projectPosition(A.lat, A.lon, 0, 1),
  projectPosition(A.lat, A.lon, 90, 1),
])
const mark = plan.points[1]
/** Inbound course to the mark is due north. */
const INBOUND = 0

describe('arrivalRadiusNM', () => {
  it('is the chosen distance when the fix can resolve it', () => {
    expect(arrivalRadiusNM(150, 5)).toBeCloseTo(ft(150), 9)
  })

  it('never asks a receiver for better than it claims it can do', () => {
    // A ±25 m fix cannot report being inside a 50 ft (15 m) circle, so a leg
    // set that tight would never complete at all. It gets a circle it can
    // actually satisfy instead.
    const tight = arrivalRadiusNM(50, 25)
    expect(tight).toBeGreaterThan(ft(50))
    expect(tight).toBeCloseTo(25 / 1852, 9)
  })

  it('ignores a missing or nonsense accuracy rather than zeroing the circle', () => {
    expect(arrivalRadiusNM(100, null)).toBeCloseTo(ft(100), 9)
    expect(arrivalRadiusNM(100, undefined)).toBeCloseTo(ft(100), 9)
    expect(arrivalRadiusNM(100, Number.NaN)).toBeCloseTo(ft(100), 9)
  })
})

describe('shouldAdvance — the arrival circle', () => {
  it('does not advance while the mark is still a leg away', () => {
    expect(shouldAdvance(plan, 1, A, 150)).toBe(false)
  })

  it('advances once inside the circle', () => {
    const inside = projectPosition(mark.lat, mark.lon, 180, ft(120))
    expect(shouldAdvance(plan, 1, inside, 150)).toBe(true)
  })

  it('holds the leg at 200 ft short of a 150 ft circle', () => {
    const short = projectPosition(mark.lat, mark.lon, 180, ft(200))
    expect(shouldAdvance(plan, 1, short, 150)).toBe(false)
  })

  it('is tighter on the tightest setting — 120 ft short is not arrived at 50 ft', () => {
    const at120 = projectPosition(mark.lat, mark.lon, 180, ft(120))
    expect(shouldAdvance(plan, 1, at120, 150)).toBe(true)
    expect(shouldAdvance(plan, 1, at120, 50)).toBe(false)
  })

  it('defaults to the most forgiving setting when none is passed', () => {
    expect(DEFAULT_ARRIVAL_FT).toBe(150)
    const at120 = projectPosition(mark.lat, mark.lon, 180, ft(120))
    expect(shouldAdvance(plan, 1, at120)).toBe(true)
  })

  it('advances a sloppy fix on the accuracy floor rather than never', () => {
    // 60 ft out, a 50 ft circle, and a receiver claiming ±25 m (82 ft). The
    // circle it can actually resolve is the bigger one, so the leg completes.
    const out = projectPosition(mark.lat, mark.lon, 180, ft(60))
    expect(shouldAdvance(plan, 1, { ...out }, 50)).toBe(false)
    expect(shouldAdvance(plan, 1, { ...out, accuracy: 25 }, 50)).toBe(true)
  })
})

describe('shouldAdvance — passing the mark without touching the circle', () => {
  it('advances a boat that sailed past the mark and is still running the leg', () => {
    // The whole reason this rule exists: at 20 kn a boat crosses a 50 ft
    // circle in about three seconds, so the sampled fixes can straddle it
    // entirely. Without this the leg never completes and the crew is left
    // steering at a mark astern of them.
    const past = projectPosition(mark.lat, mark.lon, INBOUND, ft(90))
    expect(shouldAdvance(plan, 1, past, 50)).toBe(false)
    expect(shouldAdvance(plan, 1, { ...past, heading: INBOUND }, 50)).toBe(true)
  })

  it('gives the same mark back to a boat that aborted the turn and is coming round', () => {
    // The rule this function used to refuse outright, and the reason why:
    // "a boat that has to abort a turn and come round again should be given
    // the same point back, not carried on to the next one because it once
    // crossed a line." Same position as above — only the heading differs.
    const past = projectPosition(mark.lat, mark.lon, INBOUND, ft(90))
    expect(shouldAdvance(plan, 1, { ...past, heading: 180 }, 50)).toBe(false)
  })

  it('does not count a mark a long way off as passed', () => {
    // Past the perpendicular, but nowhere near arriving.
    const miles = projectPosition(mark.lat, mark.lon, INBOUND, 0.5)
    expect(shouldAdvance(plan, 1, { ...miles, heading: INBOUND }, 150)).toBe(false)
  })

  it('does not advance a boat short of the mark, whatever its heading', () => {
    const short = projectPosition(mark.lat, mark.lon, 180, ft(200))
    expect(shouldAdvance(plan, 1, { ...short, heading: INBOUND }, 150)).toBe(false)
  })

  it('falls back to the circle alone when the device reports no heading', () => {
    const past = projectPosition(mark.lat, mark.lon, INBOUND, ft(90))
    expect(shouldAdvance(plan, 1, { ...past, heading: null }, 50)).toBe(false)
  })

  it('uses the circle only for the first point, which has no leg into it', () => {
    // Steering to the start: there is no inbound course to have carried on
    // down, so there is nothing for the pass-abeam rule to mean.
    const past = projectPosition(A.lat, A.lon, 0, ft(90))
    expect(shouldAdvance(plan, 0, { ...past, heading: 0 }, 50)).toBe(false)
  })
})

describe('shouldAdvance — the edges', () => {
  it('never runs past the last point — arriving at the end is the end', () => {
    const last = plan.points.length - 1
    expect(shouldAdvance(plan, last, plan.points[last], 150)).toBe(false)
  })

  it('waits rather than guessing when there is no fix', () => {
    expect(shouldAdvance(plan, 1, null, 150)).toBe(false)
  })
})

describe('a route and a pattern are the same thing to steer', () => {
  it('builds one leg fewer than it has points, arriving at each in turn', () => {
    const p = planOf([
      A,
      projectPosition(A.lat, A.lon, 45, 2),
      projectPosition(A.lat, A.lon, 135, 3),
    ])
    expect(p.legs).toHaveLength(p.points.length - 1)
    expect(p.legs[0].to).toEqual(p.points[1])
    expect(p.legs[0].courseDeg).toBeCloseTo(45, 1)
  })
})
