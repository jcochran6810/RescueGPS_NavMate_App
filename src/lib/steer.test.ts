import { describe, it, expect } from 'vitest'
import { ARRIVAL_NM, shouldAdvance, type SteerablePlan } from './steer'
import { buildLegs, type LatLon } from './search'
import { projectPosition } from './sar'

function planOf(points: LatLon[]): SteerablePlan {
  return { points, legs: buildLegs(points, () => true).legs }
}

const A = { lat: 29.3, lon: -94.8 }

describe('shouldAdvance', () => {
  const plan = planOf([
    A,
    projectPosition(A.lat, A.lon, 0, 1),
    projectPosition(A.lat, A.lon, 90, 1),
  ])

  it('does not advance while the point is still a leg away', () => {
    expect(shouldAdvance(plan, 1, A)).toBe(false)
  })

  it('advances once inside the arrival circle', () => {
    const nearly = projectPosition(plan.points[1].lat, plan.points[1].lon, 180, ARRIVAL_NM / 2)
    expect(shouldAdvance(plan, 1, nearly)).toBe(true)
  })

  it('does not advance just outside it', () => {
    const short = projectPosition(plan.points[1].lat, plan.points[1].lon, 180, ARRIVAL_NM * 1.5)
    expect(shouldAdvance(plan, 1, short)).toBe(false)
  })

  it('never runs past the last point — arriving at the end is the end', () => {
    const last = plan.points.length - 1
    expect(shouldAdvance(plan, last, plan.points[last])).toBe(false)
  })

  it('waits rather than guessing when there is no fix', () => {
    expect(shouldAdvance(plan, 1, null)).toBe(false)
  })

  it('is five times the underfoot threshold, which answers a different question', () => {
    expect(ARRIVAL_NM).toBeCloseTo(0.05, 6)
  })
})

describe('a route and a pattern are the same thing to steer', () => {
  it('builds one leg fewer than it has points, arriving at each in turn', () => {
    const plan = planOf([A, projectPosition(A.lat, A.lon, 45, 2), projectPosition(A.lat, A.lon, 135, 3)])
    expect(plan.legs).toHaveLength(plan.points.length - 1)
    expect(plan.legs[0].to).toEqual(plan.points[1])
    expect(plan.legs[0].courseDeg).toBeCloseTo(45, 1)
  })
})
