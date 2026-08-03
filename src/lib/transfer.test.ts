import { describe, it, expect } from 'vitest'
import { toGPX, toCSV, parseImport, serialize } from './transfer'
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
