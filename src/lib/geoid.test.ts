import { describe, expect, it } from 'vitest'
import { geoidHeight, reportsEllipsoidHeight, seaLevelAltitude } from './geoid'

// Reference values from the full 15' EGM96 grid at the same points.
const REF: [string, number, number, number][] = [
  ['Houston', 29.76, -95.37, -28.49],
  ['Galveston', 29.3, -94.8, -27.79],
  ['Boston', 42.36, -71.06, -28.54],
  ['Denver', 39.74, -104.99, -16.98],
  ['Indian Ocean low', 5, 78, -104.68],
]

describe('geoidHeight', () => {
  for (const [name, lat, lon, n] of REF) {
    it(`matches EGM96 at ${name} to within 2 m`, () => {
      expect(Math.abs(geoidHeight(lat, lon)! - n)).toBeLessThan(2)
    })
  }

  it('is continuous across the antimeridian', () => {
    const a = geoidHeight(10, 179.999)!
    const b = geoidHeight(10, -179.999)!
    expect(Math.abs(a - b)).toBeLessThan(0.1)
  })

  it('handles the poles and refuses nonsense', () => {
    expect(geoidHeight(90, 0)).not.toBeNull()
    expect(geoidHeight(-90, 123)).not.toBeNull()
    expect(geoidHeight(91, 0)).toBeNull()
    expect(geoidHeight(Number.NaN, 0)).toBeNull()
  })
})

describe('seaLevelAltitude', () => {
  it('turns the reported -21 m in Galveston into a few metres above the sea', () => {
    const h = seaLevelAltitude(-21, 29.3, -94.8, true)!
    expect(h).toBeGreaterThan(4)
    expect(h).toBeLessThan(9)
  })

  it('leaves a sea-level altitude (iOS) alone', () => {
    expect(seaLevelAltitude(6, 29.3, -94.8, false)).toBe(6)
  })

  it('passes a missing altitude through as missing', () => {
    expect(seaLevelAltitude(null, 29.3, -94.8, true)).toBeNull()
  })
})

describe('reportsEllipsoidHeight', () => {
  it('Android reports ellipsoid height; iPhone and iPad report sea level', () => {
    expect(reportsEllipsoidHeight('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126')).toBe(true)
    expect(reportsEllipsoidHeight('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)')).toBe(false)
    expect(reportsEllipsoidHeight('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(false)
  })
})
