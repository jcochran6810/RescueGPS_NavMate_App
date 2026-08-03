import { describe, it, expect } from 'vitest'
import {
  haversineNM,
  bearingDeg,
  compassPoint,
  formatDistance,
  formatDuration,
  formatSpeed,
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
