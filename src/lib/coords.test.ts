import { describe, it, expect } from 'vitest'
import {
  parseCoord,
  toDD,
  toDMS,
  toDDM,
  toUTM,
  latBand,
  utmZone,
  wrapLon,
} from './coords'

describe('parseCoord', () => {
  it('reads plain decimal degrees', () => {
    expect(parseCoord('27.98785', 'lat')).toBeCloseTo(27.98785, 6)
    expect(parseCoord('-82.44712', 'lon')).toBeCloseTo(-82.44712, 6)
  })

  it('reads DMS with a hemisphere', () => {
    expect(parseCoord(`27° 59' 16.3" N`, 'lat')).toBeCloseTo(27.987861, 5)
    expect(parseCoord(`82° 26' 49.6" W`, 'lon')).toBeCloseTo(-82.447111, 5)
  })

  it('reads degrees decimal minutes', () => {
    expect(parseCoord(`27° 59.272' N`, 'lat')).toBeCloseTo(27.987867, 5)
    expect(parseCoord(`82° 26.827' W`, 'lon')).toBeCloseTo(-82.447117, 5)
  })

  it('accepts a decimal comma', () => {
    expect(parseCoord('27,98785', 'lat')).toBeCloseTo(27.98785, 6)
  })

  it('rejects a hemisphere from the wrong axis', () => {
    expect(parseCoord('27 N', 'lon')).toBeNaN()
    expect(parseCoord('82 W', 'lat')).toBeNaN()
  })

  it('rejects a minus sign that contradicts the hemisphere', () => {
    expect(parseCoord('-27 N', 'lat')).toBeNaN()
  })

  it('rejects impossible minutes and seconds', () => {
    expect(parseCoord('27 75 00', 'lat')).toBeNaN()
    expect(parseCoord('27 30 90', 'lat')).toBeNaN()
  })

  it('rejects a fractional degree when minutes follow', () => {
    expect(parseCoord('27.5 30', 'lat')).toBeNaN()
  })

  it('enforces axis limits', () => {
    expect(parseCoord('91', 'lat')).toBeNaN()
    expect(parseCoord('181', 'lon')).toBeNaN()
    expect(parseCoord('90', 'lat')).toBe(90)
    expect(parseCoord('180', 'lon')).toBe(180)
  })

  it('returns NaN for empty and junk input', () => {
    expect(parseCoord('', 'lat')).toBeNaN()
    expect(parseCoord('   ', 'lat')).toBeNaN()
    expect(parseCoord('north a bit', 'lat')).toBeNaN()
    expect(parseCoord(null, 'lat')).toBeNaN()
    expect(parseCoord('1 2 3 4', 'lat')).toBeNaN()
  })
})

describe('formatting', () => {
  it('round-trips DD through DMS', () => {
    const dd = 27.98785
    expect(parseCoord(toDMS(dd, 'lat'), 'lat')).toBeCloseTo(dd, 4)
  })

  it('round-trips DD through DDM', () => {
    const dd = -82.44712
    expect(parseCoord(toDDM(dd, 'lon'), 'lon')).toBeCloseTo(dd, 5)
  })

  it('carries rounded seconds into the next minute', () => {
    // 27° 59' 59.99" rounds to 60.0" — it must render as 28° 00' 00.0".
    const dd = 27 + 59 / 60 + 59.99 / 3600
    expect(toDMS(dd, 'lat')).toBe(`28° 0' 0.0" N`)
  })

  it('carries rounded minutes into the next degree', () => {
    const dd = 27 + 59.9999 / 60
    expect(toDDM(dd, 'lat')).toBe(`28° 0.000' N`)
  })

  it('picks the right hemisphere letters', () => {
    expect(toDMS(10, 'lat')).toContain('N')
    expect(toDMS(-10, 'lat')).toContain('S')
    expect(toDDM(10, 'lon')).toContain('E')
    expect(toDDM(-10, 'lon')).toContain('W')
  })

  it('returns empty for non-finite input', () => {
    expect(toDD(Number.NaN)).toBe('')
    expect(toDMS(Number.NaN, 'lat')).toBe('')
    expect(toDDM(Number.NaN, 'lon')).toBe('')
  })
})

describe('UTM', () => {
  it('projects a known Tampa coordinate', () => {
    // 27.98785 N, 82.44712 W falls in zone 17R.
    const utm = toUTM(27.98785, -82.44712)
    const [zone, easting, northing] = utm.split(' ')
    expect(zone).toBe('17R')
    expect(Number(easting)).toBeGreaterThan(350000)
    expect(Number(easting)).toBeLessThan(360000)
    expect(Number(northing)).toBeGreaterThan(3090000)
    expect(Number(northing)).toBeLessThan(3100000)
  })

  it('adds the southern hemisphere false northing', () => {
    const north = Number(toUTM(-33.8688, 151.2093).split(' ')[2])
    expect(north).toBeGreaterThan(6000000)
  })

  it('widens zone 32V for south-west Norway', () => {
    expect(utmZone(60, 5)).toBe(32)
    expect(latBand(60)).toBe('V')
  })

  it('applies the Svalbard zone exceptions', () => {
    expect(latBand(78)).toBe('X')
    expect(utmZone(78, 5)).toBe(31)
    expect(utmZone(78, 15)).toBe(33)
    expect(utmZone(78, 25)).toBe(35)
    expect(utmZone(78, 35)).toBe(37)
  })

  it('is undefined outside the UTM domain', () => {
    expect(toUTM(85, 0)).toBe('')
    expect(toUTM(-81, 0)).toBe('')
    expect(latBand(90)).toBe('')
  })

  it('never uses the excluded band letters I and O', () => {
    for (let lat = -80; lat <= 84; lat += 1) {
      expect(latBand(lat)).not.toBe('I')
      expect(latBand(lat)).not.toBe('O')
    }
  })
})

describe('wrapLon', () => {
  it('normalises into [-180, 180)', () => {
    expect(wrapLon(180)).toBe(-180)
    expect(wrapLon(190)).toBe(-170)
    expect(wrapLon(-190)).toBe(170)
    expect(wrapLon(0)).toBe(0)
  })
})
