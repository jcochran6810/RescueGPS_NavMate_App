/**
 * The service-worker rule that keeps ENC chart queries on the phone.
 *
 * The route planner's depth and hazard queries never go to NOAA directly in a
 * browser: `encRequestUrl` (lib/chart.ts) sends them to this app's own
 * `/api/enc` relay. The old `navmate-charts` rule matched `encdirect.noaa.gov`
 * and so never saw one of them — a crew that had plotted a route in the
 * morning got a straight line in the afternoon once the signal went.
 *
 * It lives here rather than inline in vite.config.ts so it can be tested; the
 * config imports it. Workbox **stringifies `urlPattern` into the service
 * worker**, so that function must stay self-contained: no imports, no
 * constants from outside its own body. A test re-creates it from its source
 * text to hold that line.
 */

/** Separate from the tile caches so a saved area's chart data and its tiles cannot evict each other. */
export const ENC_CACHE_NAME = 'navmate-enc'

/**
 * Entries kept.
 *
 * One area load asks up to three bands (`bandsForSpan`), each a layer list plus
 * about thirteen layer queries — some forty requests, more when a busy harbour
 * trips the transfer limit and the box is split. `useChartData` remembers the
 * last twenty areas, so ~900 entries is what the saved list promises; the rest
 * is headroom for those splits.
 */
export const ENC_CACHE_MAX_ENTRIES = 1500

/** ENC is republished weekly; a month is the most stale an offline answer may be. */
export const ENC_CACHE_MAX_AGE_S = 60 * 60 * 24 * 30

/**
 * How long a query waits on the network before answering from the phone.
 *
 * A harbour-band depth query can be two megabytes, so this is generous; and a
 * query with nothing stored keeps waiting for the network regardless.
 */
export const ENC_NETWORK_TIMEOUT_S = 10

export const ENC_QUERY_RULE = {
  // Same-origin only: another site's `/api/enc` is not our relay.
  urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
    sameOrigin && url.pathname === '/api/enc',
  // Network first, not cache first. Online, a crew gets this week's chart
  // rather than whatever was stored a month ago; offline — or on a link too
  // slow to answer — it gets the stored one. Cache-first would steer by
  // month-old wreck positions with a perfectly good signal.
  handler: 'NetworkFirst' as const,
  options: {
    cacheName: ENC_CACHE_NAME,
    networkTimeoutSeconds: ENC_NETWORK_TIMEOUT_S,
    expiration: {
      maxEntries: ENC_CACHE_MAX_ENTRIES,
      maxAgeSeconds: ENC_CACHE_MAX_AGE_S,
      purgeOnQuotaError: true,
    },
    // 200 only. The relay is same-origin, so there is no opaque response to
    // allow for, and it re-issues ArcGIS's error-at-200 as a 502 — so a 200
    // here is data, and nothing else is ever stored.
    cacheableResponse: { statuses: [200] },
  },
}
