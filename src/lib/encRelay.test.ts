import { afterEach, describe, it, expect, vi } from 'vitest'
// @ts-expect-error — a plain-JS Vercel function with no type declarations.
import handler, { isArcgisError } from '../../api/enc.js'
import { defaultFetcher } from './chart'

const NOAA =
  'https://encdirect.noaa.gov/arcgis/rest/services/encdirect/enc_harbour/MapServer/227/query?f=geojson'
const relay = (u: string) =>
  new Request(`https://navmate.stationinsight.com/api/enc?u=${encodeURIComponent(u)}`)

const ARCGIS_ERROR = JSON.stringify({
  error: { code: 400, message: 'Invalid format.', details: [] },
})

function upstream(body: string, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api/enc relay', () => {
  it('passes chart data through as a cacheable 200', async () => {
    upstream('{"type":"FeatureCollection","features":[]}')
    const res: Response = await handler(relay(NOAA))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('s-maxage')
    expect(await res.json()).toEqual({ type: 'FeatureCollection', features: [] })
  })

  it("re-issues ArcGIS's error-at-200 as an uncacheable 502, body intact", async () => {
    // The trap: HTTP 200 with an error object inside. As a 200 it would sit
    // in the edge cache for a day and on the phone for a month.
    upstream(ARCGIS_ERROR)
    const res: Response = await handler(relay(NOAA))
    expect(res.status).toBe(502)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-enc-relay')).toBe('arcgis-error')
    expect(await res.text()).toBe(ARCGIS_ERROR)
  })

  it("passes NOAA's own failure status through, uncached", async () => {
    upstream('Not Found', 404)
    const res: Response = await handler(relay(NOAA))
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('still refuses to relay anywhere but NOAA', async () => {
    const res: Response = await handler(relay('https://example.com/arcgis/rest/services/x'))
    expect(res.status).toBe(400)
  })
})

describe('isArcgisError', () => {
  it('spots an error object and nothing else', () => {
    expect(isArcgisError(ARCGIS_ERROR)).toBe(true)
    expect(isArcgisError('{"features":[]}')).toBe(false)
    expect(isArcgisError('{"error":null}')).toBe(false)
    expect(isArcgisError('{"error":"text"}')).toBe(false)
    expect(isArcgisError('not json')).toBe(false)
    expect(isArcgisError('null')).toBe(false)
  })

  it('does not parse a body too big to be an error', () => {
    const big = `{"error":{"code":1},"pad":"${'x'.repeat(70 * 1024)}"}`
    expect(isArcgisError(big)).toBe(false)
  })
})

describe('defaultFetcher', () => {
  it("reads the ArcGIS message back out of the relay's 502", async () => {
    upstream(ARCGIS_ERROR, 502)
    await expect(defaultFetcher(NOAA)).rejects.toThrow(
      'Chart service returned 502: Invalid format. (400)',
    )
  })

  it('reports the status alone when the body is not JSON', async () => {
    upstream('Bad Gateway', 502)
    await expect(defaultFetcher(NOAA)).rejects.toThrow(/^Chart service returned 502$/)
  })

  it('returns the parsed body on success', async () => {
    upstream('{"features":[]}')
    await expect(defaultFetcher(NOAA)).resolves.toEqual({ features: [] })
  })
})
