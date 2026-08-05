import { describe, it, expect } from 'vitest'
import {
  parseStationList,
  parsePredictions,
  parseNoaaTime,
  nearestStations,
  tideNow,
  formatTideHeight,
  formatTideClock,
  type TideExtreme,
} from './tides'

const GALVESTON = {
  id: '8771450',
  name: 'Galveston Pier 21, TX',
  state: 'TX',
  lat: 29.31,
  lng: -94.7933,
}

describe('parseStationList', () => {
  it('reads the documented shape', () => {
    const list = parseStationList({ count: 1, stations: [GALVESTON] })
    expect(list).toEqual([
      {
        id: '8771450',
        name: 'Galveston Pier 21, TX',
        state: 'TX',
        lat: 29.31,
        lon: -94.7933,
      },
    ])
  })

  it('accepts lon as well as lng', () => {
    const [s] = parseStationList({
      stations: [{ id: '1', name: 'A', lat: 10, lon: -20 }],
    })
    expect(s.lon).toBe(-20)
  })

  it('reads coordinates delivered as strings', () => {
    const [s] = parseStationList({
      stations: [{ id: '1', name: 'A', lat: '29.31', lng: '-94.79' }],
    })
    expect(s.lat).toBeCloseTo(29.31)
    expect(s.lon).toBeCloseTo(-94.79)
  })

  it('drops a station with no longitude rather than putting it on the meridian', () => {
    // Number(null) and Number('') are both 0, so a missing longitude would
    // otherwise become a station in the Gulf of Guinea and win every
    // nearest-station lookup on the planet.
    const list = parseStationList({
      stations: [
        { id: '1', name: 'Broken', lat: 29.31, lng: null },
        { id: '2', name: 'Broken too', lat: 29.31, lng: '' },
        GALVESTON,
      ],
    })
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('8771450')
  })

  it('drops a station with out-of-range coordinates', () => {
    const list = parseStationList({
      stations: [{ id: '1', name: 'Nowhere', lat: 95, lng: -94 }, GALVESTON],
    })
    expect(list.map((s) => s.id)).toEqual(['8771450'])
  })

  it('throws on a payload that is not a station list', () => {
    expect(() => parseStationList({})).toThrow(/station list/i)
    expect(() => parseStationList('<html>error</html>')).toThrow(/station list/i)
  })

  it('throws when every station is unusable rather than reporting none nearby', () => {
    expect(() =>
      parseStationList({ stations: [{ id: '1', name: 'Broken', lat: null, lng: null }] }),
    ).toThrow(/no usable/i)
  })
})

describe('parseNoaaTime', () => {
  it('reads a CO-OPS timestamp as GMT', () => {
    expect(parseNoaaTime('2026-08-06 14:42')?.toISOString()).toBe(
      '2026-08-06T14:42:00.000Z',
    )
  })

  it('rejects anything that is not a timestamp', () => {
    expect(parseNoaaTime('')).toBeNull()
    expect(parseNoaaTime('tomorrow')).toBeNull()
  })
})

describe('parsePredictions', () => {
  const payload = {
    predictions: [
      { t: '2026-08-06 12:58', v: '-0.234', type: 'L' },
      { t: '2026-08-06 06:42', v: '2.145', type: 'H' },
    ],
  }

  it('reads highs and lows and puts them in time order', () => {
    const out = parsePredictions(payload)
    expect(out.map((e) => e.type)).toEqual(['H', 'L'])
    expect(out[0].heightFt).toBeCloseTo(2.145)
    expect(out[1].heightFt).toBeCloseTo(-0.234)
    expect(out[0].at.toISOString()).toBe('2026-08-06T06:42:00.000Z')
  })

  it('surfaces the NOAA error message instead of an empty tide table', () => {
    expect(() =>
      parsePredictions({ error: { message: 'No Predictions data was found.' } }),
    ).toThrow(/No Predictions data was found/)
  })

  it('throws on an unrecognised payload', () => {
    expect(() => parsePredictions({ data: [] })).toThrow(/predictions/i)
  })

  it('skips a row with a missing height rather than calling it zero feet', () => {
    const out = parsePredictions({
      predictions: [
        { t: '2026-08-06 06:42', v: '', type: 'H' },
        { t: '2026-08-06 12:58', v: '-0.2', type: 'L' },
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('L')
  })
})

describe('nearestStations', () => {
  const stations = [
    { id: 'gal', name: 'Galveston Pier 21', state: 'TX', lat: 29.31, lon: -94.7933 },
    { id: 'fpt', name: 'Freeport', state: 'TX', lat: 28.95, lon: -95.31 },
    { id: 'hou', name: 'Houston Ship Channel', state: 'TX', lat: 29.73, lon: -95.08 },
    { id: 'spi', name: 'South Padre Island', state: 'TX', lat: 26.07, lon: -97.17 },
  ]

  it('sorts by distance from the position', () => {
    // A position in the Houston Ship Channel.
    const near = nearestStations(30.013, -95.1855, stations, 3)
    expect(near.map((s) => s.id)).toEqual(['hou', 'gal', 'fpt'])
    expect(near[0].distanceNM).toBeLessThan(20)
  })

  it('reports the bearing to each station', () => {
    const [nearest] = nearestStations(30.013, -95.1855, stations, 1)
    // Houston Ship Channel gauge is south and slightly east of that position.
    expect(nearest.bearingDeg).toBeGreaterThan(150)
    expect(nearest.bearingDeg).toBeLessThan(200)
  })

  it('honours the limit', () => {
    expect(nearestStations(30, -95, stations, 2)).toHaveLength(2)
    expect(nearestStations(30, -95, stations, 0)).toHaveLength(0)
  })

  it('returns nothing without a position', () => {
    expect(nearestStations(Number.NaN, -95, stations)).toEqual([])
  })
})

describe('tideNow', () => {
  const extremes: TideExtreme[] = [
    { at: new Date('2026-08-06T06:00:00Z'), heightFt: 2.1, type: 'H' },
    { at: new Date('2026-08-06T12:00:00Z'), heightFt: -0.2, type: 'L' },
    { at: new Date('2026-08-06T18:00:00Z'), heightFt: 1.9, type: 'H' },
  ]

  it('is falling on the way to a low', () => {
    const s = tideNow(new Date('2026-08-06T09:00:00Z'), extremes)
    expect(s.trend).toBe('falling')
    expect(s.next?.type).toBe('L')
    expect(s.previous?.type).toBe('H')
  })

  it('is rising on the way to a high', () => {
    const s = tideNow(new Date('2026-08-06T15:00:00Z'), extremes)
    expect(s.trend).toBe('rising')
    expect(s.nextHigh?.at.toISOString()).toBe('2026-08-06T18:00:00.000Z')
    expect(s.nextLow).toBeNull()
  })

  it('reports both next high and next low when both are ahead', () => {
    const s = tideNow(new Date('2026-08-06T07:00:00Z'), extremes)
    expect(s.nextLow?.at.toISOString()).toBe('2026-08-06T12:00:00.000Z')
    expect(s.nextHigh?.at.toISOString()).toBe('2026-08-06T18:00:00.000Z')
  })

  it('falls back to the last extreme once the table runs out', () => {
    const s = tideNow(new Date('2026-08-07T00:00:00Z'), extremes)
    expect(s.trend).toBe('falling')
    expect(s.next).toBeNull()
  })

  it('says unknown rather than guessing with no data', () => {
    expect(tideNow(new Date(), []).trend).toBe('unknown')
  })

  it('does not depend on the order it was handed', () => {
    const shuffled = [extremes[2], extremes[0], extremes[1]]
    expect(tideNow(new Date('2026-08-06T09:00:00Z'), shuffled).next?.type).toBe('L')
  })
})

describe('formatting', () => {
  it('renders heights to a tenth of a foot', () => {
    expect(formatTideHeight(2.145)).toBe('2.1 ft')
    expect(formatTideHeight(0)).toBe('0.0 ft')
  })

  it('renders a negative height with a real minus sign', () => {
    expect(formatTideHeight(-0.24)).toBe('−0.2 ft')
  })

  it('renders unknown values as an em dash', () => {
    expect(formatTideHeight(Number.NaN)).toBe('—')
    expect(formatTideClock(null)).toBe('—')
  })
})
