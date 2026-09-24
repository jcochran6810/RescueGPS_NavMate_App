import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ENC_CACHE_MAX_AGE_S,
  ENC_CACHE_MAX_ENTRIES,
  ENC_CACHE_NAME,
  ENC_QUERY_RULE,
} from './encCache'
import { encRequestUrl } from './chart'

const ORIGIN = 'https://navmate.stationinsight.com'
const NOAA =
  'https://encdirect.noaa.gov/arcgis/rest/services/encdirect/enc_harbour/MapServer/227/query?f=geojson&where=1%3D1'

type Match = (o: { url: URL; sameOrigin: boolean }) => boolean

function matches(pattern: Match, href: string): boolean {
  const url = new URL(href, ORIGIN)
  return pattern({ url, sameOrigin: url.origin === ORIGIN })
}

describe('ENC_QUERY_RULE', () => {
  it('matches the relay URL the app actually requests', () => {
    // Built by the same function the fetcher uses, with the browser branch
    // spelled out — `encRequestUrl` returns NOAA's URL unchanged under Node.
    expect(encRequestUrl(NOAA)).toBe(NOAA)
    const relayed = `/api/enc?u=${encodeURIComponent(NOAA)}`
    expect(matches(ENC_QUERY_RULE.urlPattern, relayed)).toBe(true)
    expect(matches(ENC_QUERY_RULE.urlPattern, '/api/enc?u=x')).toBe(true)
  })

  it('does not match anything that is not our relay', () => {
    const p = ENC_QUERY_RULE.urlPattern
    expect(matches(p, 'https://elsewhere.example/api/enc?u=x')).toBe(false)
    expect(matches(p, '/api/encx?u=x')).toBe(false)
    expect(matches(p, '/api/enc/other')).toBe(false)
    expect(matches(p, '/api/other')).toBe(false)
    // NOAA directly belongs to the tile rule, not this one.
    expect(matches(p, NOAA)).toBe(false)
  })

  it('survives being stringified into the service worker', () => {
    // Workbox writes `urlPattern` into sw.js as source text. Anything it
    // closed over would arrive undefined, so rebuild it from its own text and
    // check it still answers the same.
    const rebuilt = new Function(`return (${ENC_QUERY_RULE.urlPattern.toString()})`)() as Match
    expect(matches(rebuilt, '/api/enc?u=x')).toBe(true)
    expect(matches(rebuilt, 'https://elsewhere.example/api/enc?u=x')).toBe(false)
  })

  it('stores only 200s, so neither a failure nor an opaque response is kept', () => {
    // The relay turns ArcGIS's error-at-200 into a 502 (api/enc.js), so this
    // is the line that keeps a stored failure off a crew's phone.
    expect(ENC_QUERY_RULE.options.cacheableResponse.statuses).toEqual([200])
  })

  it('goes to the network first, answering from the phone only without it', () => {
    expect(ENC_QUERY_RULE.handler).toBe('NetworkFirst')
    expect(ENC_QUERY_RULE.options.networkTimeoutSeconds).toBeGreaterThan(0)
  })

  it('has its own cache, sized for the areas the app says it has saved', () => {
    expect(ENC_QUERY_RULE.options.cacheName).toBe(ENC_CACHE_NAME)
    expect(ENC_CACHE_NAME).not.toBe('navmate-charts')
    expect(ENC_CACHE_NAME).not.toBe('navmate-imagery')
    // 20 saved areas (useChartData MAX_SAVED) × ~45 requests per area load.
    expect(ENC_CACHE_MAX_ENTRIES).toBeGreaterThanOrEqual(20 * 45)
    expect(ENC_CACHE_MAX_AGE_S).toBeLessThanOrEqual(60 * 60 * 24 * 30)
    expect(ENC_QUERY_RULE.options.expiration.purgeOnQuotaError).toBe(true)
  })

  it('is registered in the service worker config', () => {
    const config = readFileSync(
      fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
      'utf8',
    )
    expect(config).toMatch(/import \{ ENC_QUERY_RULE \} from '\.\/src\/lib\/encCache'/)
    expect(config).toMatch(/runtimeCaching: \[[\s\S]*ENC_QUERY_RULE,[\s\S]*\]/)
  })
})
