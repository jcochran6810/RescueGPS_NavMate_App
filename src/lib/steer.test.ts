import { describe, it, expect } from 'vitest'
import {
  ARRIVAL_FT_CHOICES,
  arrivalRadiusNM,
  DEFAULT_ARRIVAL_FT,
  formatNavBearing,
  formatNavDistance,
  FT_PER_NM,
  MAX_ARRIVAL_FT,
  navBearing,
  pastMark,
  ROUTE_ARRIVAL_FT_CHOICES,
  routeArrivalFt,
  shouldAdvance,
  type SteerablePlan,
  turnToward,
  timeToRunHours,
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

describe('turnToward', () => {
  it('names the short way round, starboard positive', () => {
    expect(turnToward(90, 80)).toBe(10)
    expect(turnToward(80, 90)).toBe(-10)
  })

  /*
   * The case that makes this worth a function: crossing north. A coxswain
   * heading 350 told to steer 010 is turning 20° right, not 340° left.
   */
  it('crosses north the short way', () => {
    expect(turnToward(10, 350)).toBe(20)
    expect(turnToward(350, 10)).toBe(-20)
  })

  it('reports a reversal as starboard rather than ambiguously', () => {
    expect(turnToward(180, 0)).toBe(180)
    expect(turnToward(0, 180)).toBe(180)
  })

  it('has nothing to say without a heading to turn from', () => {
    expect(turnToward(90, null)).toBeNull()
    expect(turnToward(90, undefined)).toBeNull()
    expect(turnToward(90, Number.NaN)).toBeNull()
  })
})

describe('timeToRunHours', () => {
  it('divides the distance by the speed being made good', () => {
    // 10 kn is 5.144 m/s; 5 NM at 10 kn is half an hour.
    expect(timeToRunHours(5, 5.144)!).toBeCloseTo(0.5, 2)
  })

  /*
   * A boat drifting at a tenth of a knot is not approaching the mark, and
   * "11 h" printed beside a turn point a mile away is arithmetic pretending
   * to be information.
   */
  it('refuses to estimate from a drift', () => {
    expect(timeToRunHours(1, 0.05)).toBeNull()
    expect(timeToRunHours(1, null)).toBeNull()
  })
})

describe('pastMark — rule 2 on its own', () => {
  const inbound = { courseDeg: INBOUND }

  it('is past a mark the boat ran beyond on the leg’s course', () => {
    expect(pastMark(inbound, mark, { ...projectPosition(mark.lat, mark.lon, 0, ft(500)), heading: 5 })).toBe(true)
  })

  it('is not past it from short of it, turning back, or with no heading', () => {
    const short = projectPosition(mark.lat, mark.lon, 180, ft(100))
    const beyond = projectPosition(mark.lat, mark.lon, 0, ft(100))
    expect(pastMark(inbound, mark, { ...short, heading: 0 })).toBe(false)
    expect(pastMark(inbound, mark, { ...beyond, heading: 180 })).toBe(false)
    expect(pastMark(inbound, mark, beyond)).toBe(false)
    expect(pastMark(undefined, mark, { ...beyond, heading: 0 })).toBe(false)
  })

  it('agrees with shouldAdvance, which is built on it', () => {
    const past = { ...projectPosition(mark.lat, mark.lon, INBOUND, ft(90)), heading: INBOUND }
    expect(shouldAdvance(plan, 1, past, 50)).toBe(pastMark(plan.legs[0], mark, past))
  })
})

describe('arrival choices', () => {
  it('offers routes 100 / 150 / 200 ft, and keeps 50 ft for the Search tab', () => {
    expect([...ROUTE_ARRIVAL_FT_CHOICES]).toEqual([100, 150, 200])
    expect(ARRIVAL_FT_CHOICES).toContain(50)
    expect(ARRIVAL_FT_CHOICES).toContain(200)
    expect(MAX_ARRIVAL_FT).toBe(200)
  })
})

describe('formatNavDistance', () => {
  it('gives feet under a tenth of a mile', () => {
    expect(formatNavDistance(ft(423))).toBe('420 ft')
    expect(formatNavDistance(ft(87))).toBe('85 ft')
    expect(formatNavDistance(0)).toBe('0 ft')
  })

  it('gives miles from a tenth up, through the caller’s formatter when given', () => {
    expect(formatNavDistance(0.1)).toBe('0.10 NM')
    expect(formatNavDistance(12.34)).toBe('12.3 NM')
    expect(formatNavDistance(2, (nm) => `${(nm * 1.852).toFixed(1)} km`)).toBe('3.7 km')
  })

  it('shows a dash for nothing to show', () => {
    expect(formatNavDistance(null)).toBe('—')
    expect(formatNavDistance(Number.NaN)).toBe('—')
    expect(formatNavDistance(-1)).toBe('—')
  })
})

describe('navBearing', () => {
  it('stays true, labelled T, unless magnetic is asked for', () => {
    expect(navBearing(47)).toEqual({ deg: 47, ref: 'T' })
    expect(navBearing(-10)).toEqual({ deg: 350, ref: 'T' })
  })

  it('turns to magnetic with a known declination (east is subtracted)', () => {
    // Galveston: about 2.5° E. 047°T is 044.5°M.
    const b = navBearing(47, 'magnetic', 2.5)
    expect(b.ref).toBe('M')
    expect(b.deg).toBeCloseTo(44.5, 6)
    expect(navBearing(2, 'magnetic', 5).deg).toBeCloseTo(357, 6)
  })

  it('stays true — and says so — when no declination is known', () => {
    expect(navBearing(47, 'magnetic', null)).toEqual({ deg: 47, ref: 'T' })
  })

  it('formats three digits with the north it is from', () => {
    expect(formatNavBearing({ deg: 7.4, ref: 'T' })).toBe('007°T')
    expect(formatNavBearing({ deg: 359.6, ref: 'M' })).toBe('000°M')
    expect(formatNavBearing({ deg: Number.NaN, ref: 'T' })).toBe('—')
  })
})

describe('routeArrivalFt — the arrival distance a route is steered with', () => {
  it('holds the shared setting to the route choices, 100–200 ft (the Search tab’s 50 counts as 100)', () => {
    expect(routeArrivalFt(50)).toBe(100)
    expect(routeArrivalFt(100)).toBe(100)
    expect(routeArrivalFt(150)).toBe(150)
    expect(routeArrivalFt(200)).toBe(200)
    expect(routeArrivalFt(400)).toBe(200)
    expect(routeArrivalFt(null)).toBe(150)
    expect(routeArrivalFt(Number.NaN)).toBe(150)
  })
})
