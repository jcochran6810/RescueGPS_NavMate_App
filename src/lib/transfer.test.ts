import { describe, it, expect } from 'vitest'
import {
  toGPX,
  toCSV,
  parseCSV,
  parseCsvRows,
  parseImport,
  serialize,
  trackToGPX,
} from './transfer'
import type { Waypoint } from './types'

const wp = (over: Partial<Waypoint> = {}): Waypoint => ({
  id: 'w1',
  user_id: 'u1',
  team_id: null,
  name: 'Marker 12',
  lat: 27.98785,
  lon: -82.44712,
  note: 'By the channel',
  photos: [],
  created_at: '2026-08-01T12:00:00.000Z',
  updated_at: '2026-08-01T12:00:00.000Z',
  ...over,
})

describe('toGPX', () => {
  it('writes a wpt per waypoint', () => {
    const gpx = toGPX([wp(), wp({ id: 'w2', name: 'Marker 13' })])
    expect(gpx).toContain('<gpx version="1.1"')
    expect(gpx.match(/<wpt /g)).toHaveLength(2)
    expect(gpx).toContain('lat="27.98785"')
    expect(gpx).toContain('<name>Marker 12</name>')
  })

  it('escapes XML metacharacters in names and notes', () => {
    const gpx = toGPX([wp({ name: 'Rock & <Roll>', note: 'a "quote"' })])
    expect(gpx).toContain('Rock &amp; &lt;Roll&gt;')
    expect(gpx).not.toMatch(/<name>.*<Roll>/)
  })
})

describe('toCSV', () => {
  it('writes a header and one row per waypoint', () => {
    const lines = toCSV([wp()]).trim().split('\n')
    expect(lines[0]).toBe('name,latitude,longitude,note,created_at,photos')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"Marker 12"')
  })

  it('escapes embedded quotes and flattens newlines', () => {
    const csv = toCSV([wp({ name: 'He said "go"', note: 'line1\nline2' })])
    expect(csv).toContain('"He said ""go"""')
    expect(csv).toContain('"line1 line2"')
  })

  it('produces just a header for an empty set', () => {
    expect(toCSV([])).toBe('name,latitude,longitude,note,created_at,photos\n')
  })
})

describe('parseImport', () => {
  it('reads a v2 JSON export', () => {
    const body = serialize([wp()], 'json').body
    const parsed = parseImport(body, 'x.json')
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('Marker 12')
    expect(parsed[0].lat).toBeCloseTo(27.98785, 5)
  })

  it('reads a bare JSON array (the v1 export shape)', () => {
    const parsed = parseImport(
      JSON.stringify([{ name: 'Old', lat: 10, lon: 20, note: 'n' }]),
    )
    expect(parsed).toEqual([{ name: 'Old', lat: 10, lon: 20, note: 'n' }])
  })

  it('drops rows with out-of-range or missing coordinates', () => {
    const parsed = parseImport(
      JSON.stringify([
        { name: 'ok', lat: 10, lon: 20 },
        { name: 'bad lat', lat: 91, lon: 20 },
        { name: 'bad lon', lat: 10, lon: 200 },
        { name: 'missing' },
        { name: 'text', lat: 'north', lon: 20 },
      ]),
    )
    expect(parsed.map((p) => p.name)).toEqual(['ok'])
  })

  it('throws on input that is not JSON at all', () => {
    expect(() => parseImport('not json')).toThrow()
  })

  it('reports no waypoints when the JSON has none', () => {
    expect(parseImport(JSON.stringify({ waypoints: [] }))).toEqual([])
  })
})

describe('parseCsvRows', () => {
  it('keeps commas and newlines inside a quoted cell', () => {
    expect(parseCsvRows('a,"b,c","d\ne"')).toEqual([['a', 'b,c', 'd\ne']])
  })

  it('unescapes doubled quotes', () => {
    expect(parseCsvRows('"He said ""go"""')).toEqual([['He said "go"']])
  })

  it('accepts CRLF and a leading BOM', () => {
    expect(parseCsvRows('\uFEFFa,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })
})

describe('parseCSV', () => {
  it('round-trips a NavMate CSV export', () => {
    const parsed = parseCSV(toCSV([wp(), wp({ id: 'w2', name: 'Marker 13' })]))
    expect(parsed.map((p) => p.name)).toEqual(['Marker 12', 'Marker 13'])
    expect(parsed[0].lat).toBeCloseTo(27.98785, 5)
    expect(parsed[0].lon).toBeCloseTo(-82.44712, 5)
    expect(parsed[0].note).toBe('By the channel')
  })

  it('accepts foreign column names and ignores extra columns', () => {
    const parsed = parseCSV('Title,Y,X,Elevation\nRidge,45.5,-110.25,2400\n')
    expect(parsed).toEqual([
      { name: 'Ridge', lat: 45.5, lon: -110.25, note: '' },
    ])
  })

  it('refuses a CSV with no coordinate columns', () => {
    expect(() => parseCSV('name,note\na,b\n')).toThrow(/latitude and longitude/)
  })

  it('drops rows whose coordinates are unusable', () => {
    const parsed = parseCSV(
      'name,lat,lon\nok,10,20\nbad,91,20\nblank,,20\ntext,north,20\n',
    )
    expect(parsed.map((p) => p.name)).toEqual(['ok'])
  })

  it('returns nothing for a header with no rows', () => {
    expect(parseCSV('name,lat,lon\n')).toEqual([])
  })
})

describe('parseImport routing', () => {
  it('reads CSV when the filename says so', () => {
    const parsed = parseImport(toCSV([wp()]), 'backup.csv')
    expect(parsed[0].name).toBe('Marker 12')
  })

  it('reads CSV from content alone when the header names coordinates', () => {
    const parsed = parseImport('name,latitude,longitude\nA,1,2\n')
    expect(parsed).toEqual([{ name: 'A', lat: 1, lon: 2, note: '' }])
  })

  it('still throws on input that is neither JSON, GPX nor CSV', () => {
    expect(() => parseImport('not json')).toThrow()
  })
})

describe('trackToGPX', () => {
  it('writes one trkpt per fix inside a single segment', () => {
    const gpx = trackToGPX([
      { lat: 1, lon: 2, altitude: 30, timestamp: 1_700_000_000_000 },
      { lat: 3, lon: 4, altitude: null, timestamp: 1_700_000_060_000 },
    ])
    expect(gpx.match(/<trkpt /g)).toHaveLength(2)
    expect(gpx.match(/<trkseg>/g)).toHaveLength(1)
    expect(gpx).toContain('<ele>30</ele>')
    // A fix without altitude omits the element rather than writing null.
    expect(gpx).not.toContain('<ele>null</ele>')
  })

  it('escapes the track name and stays valid with no points', () => {
    const gpx = trackToGPX([], 'Sector A & B')
    expect(gpx).toContain('<name>Sector A &amp; B</name>')
    expect(gpx).toContain('<trkseg>')
    expect(gpx).not.toContain('<trkpt')
  })
})

describe('serialize', () => {
  it('names files by format and stamps the date', () => {
    for (const fmt of ['json', 'gpx', 'csv'] as const) {
      const { filename, mime } = serialize([wp()], fmt)
      expect(filename).toMatch(
        new RegExp(`^navmate-waypoints-\\d{4}-\\d{2}-\\d{2}\\.${fmt}$`),
      )
      expect(mime).toBeTruthy()
    }
  })
})

describe('missing coordinates are never coerced to zero', () => {
  it('drops a JSON row whose coordinate is null or blank', () => {
    const parsed = parseImport(
      JSON.stringify([
        { name: 'null lat', lat: null, lon: 20 },
        { name: 'blank lat', lat: '', lon: 20 },
        { name: 'array lat', lat: [], lon: 20 },
        { name: 'ok', lat: 10, lon: 20 },
      ]),
    )
    expect(parsed.map((p) => p.name)).toEqual(['ok'])
  })

  // The GPX branch feeds getAttribute() — string or null — through the same
  // helper, so the null and blank-string cases above cover it. It has no test
  // of its own because DOMParser does not exist in the node test environment.
})
