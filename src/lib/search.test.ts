import { describe, it, expect } from 'vitest'
import {
  expandingSquare,
  expandingSquareLegsFor,
  sectorSearch,
  parallelSweep,
  creepingLine,
  sweepWidthNM,
  coverageFactor,
  podForCoverage,
  spacingForPOD,
  cumulativePOD,
  patternTimeHours,
  recommendPattern,
  PATTERN_GENERATOR_ID,
} from './search'
import { haversineNM, bearingDeg } from './geo'

const DATUM = { lat: 29.5, lon: -94.8 }

/** Local flat-earth NM offsets from the datum, for asserting geometry. */
function offsetNM(p: { lat: number; lon: number }) {
  const north = haversineNM(DATUM.lat, DATUM.lon, p.lat, DATUM.lon) *
    Math.sign(p.lat - DATUM.lat)
  const east = haversineNM(p.lat, DATUM.lon, p.lat, p.lon) *
    Math.sign(p.lon - DATUM.lon)
  return { north, east }
}

describe('expanding square', () => {
  it('follows the IAMSAR leg law: 1S, 1S, 2S, 2S, 3S… with 90° starboard turns', () => {
    const s = 0.5
    const plan = expandingSquare(DATUM, s, 8, 0)
    expect(plan.csp).toEqual(DATUM)
    expect(plan.legs).toHaveLength(8)
    const lengths = plan.legs.map((l) => l.lengthNM)
    const expected = [1, 1, 2, 2, 3, 3, 4, 4].map((k) => k * s)
    lengths.forEach((len, i) => expect(len).toBeCloseTo(expected[i], 2))
    const courses = plan.legs.map((l) => Math.round(l.courseDeg) % 360)
    expect(courses).toEqual([0, 90, 180, 270, 0, 90, 180, 270])
  })

  it('traces the known spiral: after 4m legs the square half-width is m × S', () => {
    // In S units the corners land at (0,1), (1,1), (1,-1), (-1,-1),
    // (-1,2), (2,2), (2,-2), (-2,-2) — north first, then starboard.
    const s = 0.5
    const plan = expandingSquare(DATUM, s, 8, 0)
    const unit = (v: number) => {
      const r = Math.round((v / s) * 10) / 10
      return r === 0 ? 0 : r // normalise -0
    }
    const grid = plan.points.slice(1).map((p) => {
      const o = offsetNM(p)
      return [unit(o.east), unit(o.north)]
    })
    expect(grid).toEqual([
      [0, 1], [1, 1], [1, -1], [-1, -1],
      [-1, 2], [2, 2], [2, -2], [-2, -2],
    ])
  })

  it('sizes the leg count to sweep the search radius', () => {
    expect(expandingSquareLegsFor(0.5, 0.1)).toBe(20)
    expect(expandingSquareLegsFor(1, 0.5)).toBe(8)
    expect(expandingSquareLegsFor(10, 0.1)).toBe(40) // capped
    expect(expandingSquareLegsFor(0.05, 0.5)).toBe(4) // floored
  })
})

describe('sector search', () => {
  it('is nine legs, all of length R, every third returning to the datum', () => {
    const plan = sectorSearch(DATUM, 2, 45)
    expect(plan.legs).toHaveLength(9)
    for (const leg of plan.legs) expect(leg.lengthNM).toBeCloseTo(2, 1)
    // Points 3, 6, 9 are the datum again.
    for (const i of [3, 6, 9]) {
      expect(plan.points[i].lat).toBeCloseTo(DATUM.lat, 6)
      expect(plan.points[i].lon).toBeCloseTo(DATUM.lon, 6)
    }
  })

  it('first leg heads the requested (drift) direction, triangles 120° apart', () => {
    const plan = sectorSearch(DATUM, 2, 45)
    expect(plan.legs[0].courseDeg).toBeCloseTo(45, 0)
    expect(plan.legs[3].courseDeg).toBeCloseTo(165, 0)
    expect(plan.legs[6].courseDeg).toBeCloseTo(285, 0)
  })
})

describe('parallel sweep', () => {
  it('centres the datum in the swept box', () => {
    const plan = parallelSweep(DATUM, 2, 0.5, 4, 90)
    // Legs run east (90°): box is 2 NM along, (4-1)×0.5 across. The mean of
    // all corners should be the datum.
    const offs = plan.points.map(offsetNM)
    const meanN = offs.reduce((a, o) => a + o.north, 0) / offs.length
    const meanE = offs.reduce((a, o) => a + o.east, 0) / offs.length
    expect(meanN).toBeCloseTo(0, 1)
    expect(meanE).toBeCloseTo(0, 1)
  })

  it('alternates search legs with S-length connectors', () => {
    const plan = parallelSweep(DATUM, 2, 0.5, 3, 0)
    const search = plan.legs.filter((l) => l.kind === 'search')
    const conn = plan.legs.filter((l) => l.kind === 'connector')
    expect(search).toHaveLength(3)
    expect(conn).toHaveLength(2)
    for (const l of search) expect(l.lengthNM).toBeCloseTo(2, 1)
    for (const l of conn) expect(l.lengthNM).toBeCloseTo(0.5, 2)
    expect(plan.totalNM).toBeCloseTo(3 * 2 + 2 * 0.5, 1)
  })
})

describe('creeping line', () => {
  it('runs legs across the advance direction and creeps along it', () => {
    // Advance north (0°): legs run east/west, each connector steps north.
    const plan = creepingLine(DATUM, 1, 0.25, 3, 0)
    const search = plan.legs.filter((l) => l.kind === 'search')
    const conn = plan.legs.filter((l) => l.kind === 'connector')
    expect(search).toHaveLength(3)
    expect(Math.round(search[0].courseDeg)).toBe(90)
    expect(Math.round(search[1].courseDeg)).toBe(270)
    for (const l of conn) {
      expect(Math.round(l.courseDeg) % 360).toBe(0)
      expect(l.lengthNM).toBeCloseTo(0.25, 2)
    }
  })

  it('starts with the first leg centred on the datum', () => {
    const plan = creepingLine(DATUM, 1, 0.25, 3, 0)
    // CSP is half a leg to port (west); the first leg's midpoint is the datum.
    const mid = {
      lat: (plan.legs[0].from.lat + plan.legs[0].to.lat) / 2,
      lon: (plan.legs[0].from.lon + plan.legs[0].to.lon) / 2,
    }
    expect(haversineNM(mid.lat, mid.lon, DATUM.lat, DATUM.lon)).toBeLessThan(0.05)
  })
})

describe('sweep width, coverage and POD', () => {
  it('reads the ontology table: PIW from a boat in daylight, calm, is 0.4 NM', () => {
    expect(sweepWidthNM('low', {})).toBeCloseTo(0.4, 5)
    expect(sweepWidthNM('low', { sea: 'moderate' })).toBeCloseTo(0.2, 5)
    expect(sweepWidthNM('high', { night: true, sea: 'rough' })).toBeCloseTo(0.3, 5)
  })

  it('cannot sweep further than you can see', () => {
    expect(sweepWidthNM('high', { visibilityNM: 1 })).toBe(1)
    expect(sweepWidthNM('low', { visibilityNM: 10 })).toBeCloseTo(0.4, 5)
  })

  it('C = W/S and POD = 1 − e^(−C); C = 1 gives the doctrine 63.2 %', () => {
    expect(coverageFactor(0.5, 0.5)).toBe(1)
    expect(podForCoverage(1)).toBeCloseTo(0.632, 3)
    expect(podForCoverage(2)).toBeCloseTo(0.865, 3)
    expect(podForCoverage(3)).toBeCloseTo(0.95, 2)
  })

  it('Koopman spacing inverts the POD formula', () => {
    const s = spacingForPOD(0.4, 0.632)
    expect(coverageFactor(0.4, s)).toBeCloseTo(1, 2)
    expect(spacingForPOD(0.4, 0)).toBeNaN()
    expect(spacingForPOD(0.4, 1)).toBeNaN()
  })

  it('cumulative POD combines independent passes', () => {
    expect(cumulativePOD([0.5, 0.5])).toBeCloseTo(0.75, 5)
    expect(cumulativePOD([])).toBe(0)
  })
})

describe('timing and selection', () => {
  it('adds a turnaround allowance per turn', () => {
    // 12 NM at 6 kn = 2 h, plus 10 turns × 2 min.
    expect(patternTimeHours(12, 6, 10)).toBeCloseTo(2 + 20 / 60, 5)
    expect(patternTimeHours(12, 0, 10)).toBeNaN()
  })

  it('recommends per the ontology selection rules', () => {
    expect(recommendPattern({ radiusNM: 0.3, driftKts: 0 }).code).toBe('SS')
    expect(recommendPattern({ radiusNM: 0.8, driftKts: 0 }).code).toBe('VS')
    expect(recommendPattern({ radiusNM: 2, driftKts: 1 }).code).toBe('CL')
    expect(recommendPattern({ radiusNM: 3, driftKts: 0 }).code).toBe('PS')
  })

  it('names the RescueGPS field_assignments generator ids', () => {
    expect(PATTERN_GENERATOR_ID.SS).toBe('expanding-square')
    expect(PATTERN_GENERATOR_ID.VS).toBe('sector')
    expect(PATTERN_GENERATOR_ID.PS).toBe('parallel')
    expect(PATTERN_GENERATOR_ID.CL).toBe('creeping-line')
  })
})

describe('pattern legs are steerable', () => {
  it('every leg course matches the bearing from its start to its end', () => {
    const plans = [
      expandingSquare(DATUM, 0.5, 8, 30),
      sectorSearch(DATUM, 2, 10),
      parallelSweep(DATUM, 2, 0.5, 4, 45),
      creepingLine(DATUM, 1, 0.25, 4, 120),
    ]
    for (const plan of plans) {
      for (const leg of plan.legs) {
        const brg = bearingDeg(leg.from.lat, leg.from.lon, leg.to.lat, leg.to.lon)
        const diff = Math.abs(((leg.courseDeg - brg + 540) % 360) - 180)
        expect(diff).toBeLessThan(1)
      }
    }
  })
})
