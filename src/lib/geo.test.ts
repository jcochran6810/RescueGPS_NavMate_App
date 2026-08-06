import { describe, it, expect } from 'vitest'
import {
  haversineNM,
  bearingDeg,
  compassPoint,
  relativeBearing,
  formatBearing,
  formatDistance,
  formatDuration,
  formatSpeed,
  trailDistanceNM,
  isAtPosition,
  AT_POSITION_NM,
  metersPerDegree,
  NM_TO_METERS,
} from './geo'

describe('haversineNM', () => {
  it('is zero for the same point', () => {
    expect(haversineNM(27.9, -82.4, 27.9, -82.4)).toBe(0)
  })

  it('gives 60 NM per degree of latitude', () => {
    expect(haversineNM(0, 0, 1, 0)).toBeCloseTo(60, 0)
  })

  it('matches a known long leg (JFK to LHR ~ 3000 NM)', () => {
    const nm = haversineNM(40.6413, -73.7781, 51.47, -0.4543)
    expect(nm).toBeGreaterThan(2960)
    expect(nm).toBeLessThan(3020)
  })

  it('is symmetric', () => {
    const a = haversineNM(10, 20, -30, 140)
    const b = haversineNM(-30, 140, 10, 20)
    expect(a).toBeCloseTo(b, 9)
  })
})

describe('bearingDeg', () => {
  it('reads due north, east, south and west', () => {
    expect(bearingDeg(0, 0, 1, 0)).toBeCloseTo(0, 3)
    expect(bearingDeg(0, 0, 0, 1)).toBeCloseTo(90, 3)
    expect(bearingDeg(1, 0, 0, 0)).toBeCloseTo(180, 3)
    expect(bearingDeg(0, 1, 0, 0)).toBeCloseTo(270, 3)
  })

  it('always returns 0–360', () => {
    for (let i = 0; i < 360; i += 17) {
      const b = bearingDeg(10, 10, 10 + Math.cos(i), 10 + Math.sin(i))
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(360)
    }
  })
})

describe('compassPoint', () => {
  it('labels the cardinals', () => {
    expect(compassPoint(0)).toBe('N')
    expect(compassPoint(90)).toBe('E')
    expect(compassPoint(180)).toBe('S')
    expect(compassPoint(270)).toBe('W')
    expect(compassPoint(360)).toBe('N')
  })

  it('labels an intercardinal', () => {
    expect(compassPoint(135)).toBe('SE')
  })
})

describe('formatting', () => {
  it('converts distance units', () => {
    expect(formatDistance(1, 'nm')).toBe('1.00 NM')
    expect(formatDistance(1, 'km')).toBe('1.85 km')
    expect(formatDistance(1, 'mi')).toBe('1.15 mi')
    expect(formatDistance(Number.NaN, 'nm')).toBe('—')
  })

  it('converts speed from m/s to knots', () => {
    expect(formatSpeed(1)).toBe('1.9 kn')
    expect(formatSpeed(null)).toBe('—')
    expect(formatSpeed(Number.NaN)).toBe('—')
  })

  it('formats durations', () => {
    expect(formatDuration(0.75)).toBe('45 min')
    expect(formatDuration(4.2)).toBe('4 h 12 min')
    expect(formatDuration(0.001)).toBe('under a minute')
    expect(formatDuration(Number.NaN)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
  })

  it('rolls long durations into days', () => {
    expect(formatDuration(30)).toBe('1 d 6 h')
  })
})

describe('trailDistanceNM', () => {
  it('is zero for fewer than two points', () => {
    expect(trailDistanceNM([])).toBe(0)
    expect(trailDistanceNM([{ lat: 1, lon: 2 }])).toBe(0)
  })

  it('sums the legs of a track', () => {
    const a = { lat: 27.9, lon: -82.4 }
    const b = { lat: 28.0, lon: -82.4 }
    const c = { lat: 28.1, lon: -82.4 }
    expect(trailDistanceNM([a, b, c])).toBeCloseTo(
      haversineNM(a.lat, a.lon, b.lat, b.lon) +
        haversineNM(b.lat, b.lon, c.lat, c.lon),
      6,
    )
  })

  it('ignores movement smaller than the reported accuracy', () => {
    // ~11 m apart, both fixes accurate to only 50 m: that is GPS jitter, not
    // travel, and a stationary phone must not accumulate distance.
    const jitter = [
      { lat: 27.9, lon: -82.4, accuracy: 50 },
      { lat: 27.9001, lon: -82.4, accuracy: 50 },
      { lat: 27.9, lon: -82.4, accuracy: 50 },
    ]
    expect(trailDistanceNM(jitter)).toBe(0)
  })

  it('counts the same movement when the fixes are precise', () => {
    const precise = [
      { lat: 27.9, lon: -82.4, accuracy: 3 },
      { lat: 27.9001, lon: -82.4, accuracy: 3 },
    ]
    expect(trailDistanceNM(precise) * NM_TO_METERS).toBeGreaterThan(10)
  })

  it('treats a missing accuracy as no tolerance', () => {
    const legNM = haversineNM(27.9, -82.4, 27.9001, -82.4)
    expect(
      trailDistanceNM([
        { lat: 27.9, lon: -82.4 },
        { lat: 27.9001, lon: -82.4 },
      ]),
    ).toBeCloseTo(legNM, 9)
  })
})

describe('relativeBearing', () => {
  it('is zero when the target is dead ahead', () => {
    expect(relativeBearing(90, 90)).toBe(0)
  })

  it('is positive to starboard and negative to port', () => {
    expect(relativeBearing(100, 90)).toBe(10)
    expect(relativeBearing(80, 90)).toBe(-10)
  })

  it('takes the short way round north', () => {
    // Heading 350, target 010: a 20 degree turn to starboard, not 340 to port.
    expect(relativeBearing(10, 350)).toBe(20)
    expect(relativeBearing(350, 10)).toBe(-20)
  })

  it('reports dead astern as one side or the other, never both', () => {
    expect(Math.abs(relativeBearing(180, 0))).toBe(180)
  })

  it('stays within plus or minus 180 for any input', () => {
    for (let b = 0; b < 360; b += 17) {
      for (let h = 0; h < 360; h += 23) {
        const rel = relativeBearing(b, h)
        expect(rel).toBeGreaterThan(-181)
        expect(rel).toBeLessThanOrEqual(180)
      }
    }
  })

  it('is not a number when either bearing is unknown', () => {
    expect(relativeBearing(Number.NaN, 90)).toBeNaN()
    expect(relativeBearing(90, Number.NaN)).toBeNaN()
  })
})

describe('formatBearing', () => {
  it('gives degrees and a compass point', () => {
    expect(formatBearing(137)).toBe('137° SE')
    expect(formatBearing(0)).toBe('0° N')
  })

  it('normalises past a full circle', () => {
    expect(formatBearing(370)).toBe('10° N')
    expect(formatBearing(-90)).toBe('270° W')
  })

  it('renders an unknown bearing as an em dash', () => {
    expect(formatBearing(Number.NaN)).toBe('—')
  })
})

describe('isAtPosition', () => {
  it('treats a point inside GPS error as underfoot', () => {
    // A metre of jitter swings the bearing between two coincident points
    // through the whole compass, so the UI must not print one.
    expect(isAtPosition(0)).toBe(true)
    expect(isAtPosition(0.009)).toBe(true)
  })

  it('leaves a point you could actually walk to alone', () => {
    expect(isAtPosition(AT_POSITION_NM)).toBe(false)
    expect(isAtPosition(0.5)).toBe(false)
  })

  it('is false without a distance to judge', () => {
    expect(isAtPosition(null)).toBe(false)
    expect(isAtPosition(Number.NaN)).toBe(false)
  })

  it('sits inside a consumer GPS error', () => {
    // 0.01 NM is about 18 m. If this ever grows past a phone's accuracy the
    // app starts hiding bearings a crew could have used.
    expect(AT_POSITION_NM * 1852).toBeLessThan(20)
  })
})

describe('metersPerDegree', () => {
  it('matches the WGS-84 figures at the equator and the pole', () => {
    // The published values: 110 574 m of latitude at the equator, 111 694 at
    // the pole, and 111 320 m of longitude at the equator.
    expect(metersPerDegree(0).lat).toBeCloseTo(110_574, -2)
    expect(metersPerDegree(90).lat).toBeCloseTo(111_694, -2)
    expect(metersPerDegree(0).lon).toBeCloseTo(111_320, -2)
  })

  it('shrinks a degree of longitude towards the pole', () => {
    expect(metersPerDegree(60).lon).toBeCloseTo(55_800, -2)
    expect(metersPerDegree(90).lon).toBeCloseTo(0, 0)
  })

  it('is symmetric about the equator', () => {
    expect(metersPerDegree(-45).lat).toBeCloseTo(metersPerDegree(45).lat, 6)
    expect(metersPerDegree(-45).lon).toBeCloseTo(metersPerDegree(45).lon, 6)
  })

  it('agrees with the great-circle distance it has to live alongside', () => {
    // A tenth of a degree of latitude, both ways round. They differ by about
    // 35 m in 11 km — 0.3 % — which is the sphere the haversine assumes
    // against the ellipsoid this table describes, and the reason the filter
    // uses the table rather than 60 NM to the degree.
    const viaTable = metersPerDegree(29.76).lat * 0.1
    const viaHaversine = haversineNM(29.71, -95.37, 29.81, -95.37) * NM_TO_METERS
    expect(Math.abs(viaTable - viaHaversine)).toBeLessThan(50)
    expect(viaTable).toBeLessThan(viaHaversine)
  })
})
