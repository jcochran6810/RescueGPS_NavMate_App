/**
 * Same-origin relay for NOAA's ENC Direct to GIS service.
 *
 * The chart *tiles* are `<img>` elements, so the browser fetches them however
 * the host likes. The depth and hazard **queries** are `fetch`, and a browser
 * will not hand a cross-origin JSON response to a page unless the host sends
 * `Access-Control-Allow-Origin`. NOAA is not known to, which blocks every
 * query while the chart still draws underneath — the exact shape of "it plots
 * a straight line through land". Nothing in the page can work around that:
 * the block happens before any of our code runs. A relay on our own origin is
 * the only fix, which is why this file exists in an app that otherwise has no
 * server at all.
 *
 * **This is not a general proxy, and must never become one.** It forwards to
 * exactly one host, on exactly one path prefix, and passes no credentials.
 * An open relay would let anyone route traffic through this deployment.
 *
 * It also earns its keep as a diagnostic: a failure here comes back as NOAA's
 * own status and body rather than an opaque browser block, so "the service
 * moved" and "the layers were renamed" become readable instead of identical.
 */

export const config = { runtime: 'edge' }

/** The only host this will ever talk to. */
const ALLOWED_HOST = 'encdirect.noaa.gov'
/** …and the only path prefix on it. */
const ALLOWED_PREFIX = '/arcgis/rest/services/'

/** ENC is republished weekly, so a day at the edge is generous and safe. */
const CACHE = 'public, s-maxage=86400, stale-while-revalidate=604800'

function bad(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * Is this body an ArcGIS error object rather than data?
 *
 * Error bodies are a few hundred bytes; feature collections run to megabytes.
 * Only small bodies are parsed, so the relay never pays to parse a chart it
 * is about to hand straight on.
 */
export function isArcgisError(body) {
  if (body.length > 64 * 1024) return false
  try {
    const parsed = JSON.parse(body)
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      parsed.error !== null &&
      typeof parsed.error === 'object'
    )
  } catch {
    return false
  }
}

export default async function handler(request) {
  const target = new URL(request.url).searchParams.get('u')
  if (!target) return bad(400, 'Missing the u parameter')

  let url
  try {
    url = new URL(target)
  } catch {
    return bad(400, 'u is not a URL')
  }

  // Three separate checks rather than one clever one, because each is a
  // different way of being somewhere else: a different scheme, a different
  // host (including a subdomain that merely ends the same way), a different
  // part of the same host.
  if (url.protocol !== 'https:') return bad(400, 'Only https is relayed')
  if (url.hostname !== ALLOWED_HOST) {
    return bad(400, `Only ${ALLOWED_HOST} is relayed`)
  }
  if (!url.pathname.startsWith(ALLOWED_PREFIX)) {
    return bad(400, `Only ${ALLOWED_PREFIX} is relayed`)
  }

  let upstream
  try {
    upstream = await fetch(url.toString(), {
      headers: { accept: 'application/json' },
      redirect: 'follow',
    })
  } catch (e) {
    // The relay reached nothing. Say so as NOAA's failure, not ours.
    return bad(502, `Could not reach ${ALLOWED_HOST}: ${e?.message ?? e}`)
  }

  const body = await upstream.text()

  // ArcGIS reports a failed query as HTTP 200 with `{ "error": … }` in the
  // body. Passed through as a 200, that error would be kept for a day by this
  // relay's edge cache and for a month by the phone's service worker, which
  // caches only 200s — so a crew would re-plot offline against a stored
  // failure. It is re-issued as a 502 carrying NOAA's own body, so the
  // message still reaches the screen but nothing downstream keeps it.
  if (upstream.ok && isArcgisError(body)) {
    return new Response(body, {
      status: 502,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-enc-relay': 'arcgis-error',
      },
    })
  }

  return new Response(body, {
    // Upstream's status is passed through deliberately: a 404 here means the
    // service path is wrong, which is a thing worth reading on the screen.
    status: upstream.status,
    headers: {
      'content-type':
        upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': upstream.ok ? CACHE : 'no-store',
    },
  })
}
