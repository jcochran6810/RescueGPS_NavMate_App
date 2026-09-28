import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  cleanLabel,
  decodeRouteParam,
  encodeRouteParam,
  gpxFileName,
  gpxOf,
  MAX_LINK_CHARS,
  MAX_LINK_POINTS,
  planFromPoints,
  routeLink,
  shareText,
  type SharedRoute,
} from './routeShare'

/* Save / share a route (2026-09-28): GPX, a deep link, the text. */

const ROUTE: SharedRoute = {
  name: 'Morgan’s Point → Three Bird Island',
  startLabel: 'Morgan’s Point <dock & "ramp">',
  destLabel: 'Three Bird Island',
  points: [
    { lat: 29.698, lon: -94.9985 },
    { lat: 29.6844, lon: -94.9825 },
    { lat: 29.6097, lon: -94.9481 },
    { lat: 29.611, lon: -94.9129 },
    { lat: 29.634, lon: -94.8866 },
  ],
}

describe('gpxOf', () => {
  const gpx = gpxOf(ROUTE)
  it('is GPX 1.1 with a route point for every point and a waypoint at each end', () => {
    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(gpx).toContain('<gpx version="1.1" creator="NavMate" xmlns="http://www.topografix.com/GPX/1/1">')
    expect(gpx.match(/<rtept /g)).toHaveLength(5)
    expect(gpx.match(/<wpt /g)).toHaveLength(2)
    expect(gpx).toContain('<rtept lat="29.698000" lon="-94.998500">')
    expect(gpx).toContain('<name>WP 2</name>')
    expect(gpx.trim().endsWith('</gpx>')).toBe(true)
  })
  it('escapes names, and every tag it opens it closes', () => {
    expect(gpx).toContain('Morgan’s Point &lt;dock &amp; &quot;ramp&quot;&gt;')
    expect(gpx).not.toMatch(/<dock/)
    for (const tag of ['gpx', 'rte', 'rtept', 'wpt', 'metadata', 'name']) {
      const opened = gpx.match(new RegExp(`<${tag}[ >]`, 'g'))?.length ?? 0
      expect(opened).toBe(gpx.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0)
    }
    expect(gpx).toContain('Check against your chart.')
  })
  it('names the file safely', () => {
    expect(gpxFileName(ROUTE)).toBe('morgan-s-point-three-bird-island.gpx')
    expect(gpxFileName({ ...ROUTE, name: '../../etc/passwd' })).toBe('etc-passwd.gpx')
  })
})

describe('the route link', () => {
  it('round-trips points (to a metre) and labels', () => {
    const param = encodeRouteParam(ROUTE)
    expect(param).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(param.length).toBeLessThan(200)
    const back = decodeRouteParam(param)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.route.name).toBe(ROUTE.name)
    expect(back.route.startLabel).toBe(ROUTE.startLabel)
    back.route.points.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(ROUTE.points[i].lat, 5)
      expect(p.lon).toBeCloseTo(ROUTE.points[i].lon, 5)
    })
    expect(routeLink('https://navmate.stationinsight.com/', ROUTE)).toBe(
      `https://navmate.stationinsight.com/?route=${param}`,
    )
  })

  it('refuses a malformed, truncated, oversized or impossible link', () => {
    const good = encodeRouteParam(ROUTE)
    for (const bad of ['', 'not base64!', good.slice(0, 10), good + 'AA', 'AgAAAA', '*'.repeat(10)]) {
      expect(decodeRouteParam(bad).ok).toBe(false)
    }
    expect(decodeRouteParam(null).ok).toBe(false)
    expect(decodeRouteParam(123).ok).toBe(false)
    expect(decodeRouteParam('A'.repeat(MAX_LINK_CHARS + 1))).toEqual({
      ok: false,
      error: 'The route in this link is too long to open.',
    })
    // Too many points.
    const many = { ...ROUTE, points: Array.from({ length: MAX_LINK_POINTS + 50 }, (_, i) => ({ lat: 29 + i * 1e-4, lon: -94 })) }
    const capped = decodeRouteParam(encodeRouteParam(many))
    expect(capped.ok && capped.route.points.length).toBe(MAX_LINK_POINTS)
    // A position off the Earth: 95° N, hand-made (the encoder never writes one).
    const varint = (v: number) => {
      let z = v >= 0 ? v * 2 : -v * 2 - 1
      const out: number[] = []
      while (z >= 0x80) {
        out.push((z % 0x80) | 0x80)
        z = Math.floor(z / 0x80)
      }
      out.push(z)
      return out
    }
    // Every number in the format is a zig-zag varint — the label lengths and
    // the point count too.
    const bytes = [
      1,
      ...varint(1), 97, ...varint(1), 98, ...varint(1), 99,
      ...varint(2),
      ...varint(9_500_000), ...varint(0), ...varint(0), ...varint(0),
    ]
    const off = Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(decodeRouteParam(off)).toEqual({ ok: false, error: 'The route link has a position that is not on Earth.' })
  })

  it('strips control and direction-override characters from labels', () => {
    expect(cleanLabel('Dock‮ yawa\u0007 ', 'x')).toBe('Dock yawa')
    expect(cleanLabel('   ', 'fallback')).toBe('fallback')
    expect(cleanLabel('x'.repeat(200), 'f')).toHaveLength(80)
  })

  it('is served by the SPA rewrite (vercel.json)', () => {
    const cfg = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as {
      rewrites: { source: string; destination: string }[]
    }
    const spa = cfg.rewrites.find((x) => x.destination === '/index.html')!
    const re = new RegExp(`^${spa.source.replace('/((?!api/).*)', '/((?!api/).*)')}$`)
    expect(re.test('/')).toBe(true)
    expect(re.test('/api/enc')).toBe(false)
  })
})

describe('shareText', () => {
  it('names the route, the distance, the need, every point — and the disclaimer', () => {
    const t = shareText(ROUTE, {
      distance: '9.81 NM',
      needs: '4.9 ft',
      formatPoint: (p) => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`,
      link: 'https://x/?route=abc',
    })
    expect(t).toContain('9.81 NM · planned for a boat needing 4.9 ft')
    expect(t).toContain('Start (Morgan’s Point <dock & "ramp">): 29.6980, -94.9985')
    expect(t).toContain('WP 1: 29.6844, -94.9825')
    expect(t).toContain('Destination (Three Bird Island): 29.6340, -94.8866')
    expect(t).toContain('Check against your chart')
    expect(t.trim().endsWith('https://x/?route=abc')).toBe(true)
  })
})

describe('planFromPoints', () => {
  it('is never steerable as it stands — flagged until re-checked for this boat', () => {
    const p = planFromPoints(ROUTE.points, 20)
    expect(p.source).toBe('best-effort')
    expect(p.needsConfirm).toBe(true)
    expect(p.legs).toHaveLength(4)
    expect(p.legs.every((l) => l.unverified)).toBe(true)
    expect(p.totalNM).toBeGreaterThan(5)
  })
})
