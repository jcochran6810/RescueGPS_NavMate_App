/**
 * Sharing a planned route: a GPX 1.1 file, a compact NavMate link, and a
 * plain-text summary — and reading such a link back, strictly (2026-09-28).
 *
 * A shared route is only ever a PROPOSAL for whoever opens it: their boat is
 * not the sender's, so the app re-checks it against their chart and their
 * boat (`recheckPlan`, or a re-plan between the same ends) before it can be
 * steered, exactly like a saved route. Nothing here decides safety.
 *
 * The link is untrusted input. `decodeRouteLink` bounds everything — length,
 * point count, coordinates, label length and characters — and refuses rather
 * than repairs.
 */

import { buildLegs, type LatLon } from './search'
import type { RouteLeg, RoutePlan } from './routing'

export interface SharedRoute {
  name: string
  startLabel: string
  destLabel: string
  /** Every route point, start first, destination last. */
  points: LatLon[]
}

/** Most points a link may carry, and its longest encoded form, characters. */
export const MAX_LINK_POINTS = 250
export const MAX_LINK_CHARS = 6000
/** Longest name or label kept, characters. */
export const MAX_LABEL = 80
/** The query parameter a shared route arrives in. */
export const ROUTE_PARAM = 'route'

const Q = 1e5
const VERSION = 1

/* ------------------------------------------------------------------ text */

/** Printable text only, trimmed and bounded — for labels read from anywhere. */
export function cleanLabel(s: unknown, fallback: string): string {
  if (typeof s !== 'string') return fallback
  // Control characters (and the bidi overrides that can make a name read
  // backwards) are dropped; whitespace runs collapse.
  const t = [...s]
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0
      const control = c < 0x20 || (c >= 0x7f && c <= 0x9f)
      const bidi = (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
      return !control && !bidi
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL)
  return t || fallback
}

function validPoint(p: unknown): p is LatLon {
  const q = p as LatLon
  return (
    !!q &&
    typeof q.lat === 'number' &&
    typeof q.lon === 'number' &&
    Number.isFinite(q.lat) &&
    Number.isFinite(q.lon) &&
    Math.abs(q.lat) <= 90 &&
    Math.abs(q.lon) <= 180
  )
}

/* ------------------------------------------------------------------- GPX */

function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const coord = (v: number) => v.toFixed(6)

/**
 * GPX 1.1: one `<rte>` with a `<rtept>` for every point, and a `<wpt>` for
 * the start and the destination — the shape chart plotters import as a
 * route. Names escaped; no timestamps (a plan is not a track).
 */
export function gpxOf(route: SharedRoute): string {
  const name = cleanLabel(route.name, 'NavMate route')
  const pts = route.points.filter(validPoint)
  const last = pts.length - 1
  const rtept = pts
    .map((p, i) => {
      const n = i === 0 ? cleanLabel(route.startLabel, 'Start') : i === last ? cleanLabel(route.destLabel, 'Destination') : `WP ${i}`
      return `    <rtept lat="${coord(p.lat)}" lon="${coord(p.lon)}"><name>${xml(n)}</name></rtept>`
    })
    .join('\n')
  const wpt = (p: LatLon, n: string) =>
    `  <wpt lat="${coord(p.lat)}" lon="${coord(p.lon)}"><name>${xml(n)}</name></wpt>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="NavMate" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${xml(name)}</name><desc>${xml('Planned in NavMate. Check against your chart.')}</desc></metadata>`,
    ...(pts.length > 0 ? [wpt(pts[0], cleanLabel(route.startLabel, 'Start'))] : []),
    ...(pts.length > 1 ? [wpt(pts[last], cleanLabel(route.destLabel, 'Destination'))] : []),
    '  <rte>',
    `    <name>${xml(name)}</name>`,
    rtept,
    '  </rte>',
    '</gpx>',
    '',
  ].join('\n')
}

/** A file name for the GPX: letters, digits and dashes only. */
export function gpxFileName(route: SharedRoute): string {
  const base = cleanLabel(route.name, 'navmate-route')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `${base || 'navmate-route'}.gpx`
}

/* ------------------------------------------------------------------ link */

function pushVarint(out: number[], v: number): void {
  // Zig-zag, then 7 bits a byte.
  let z = v >= 0 ? v * 2 : -v * 2 - 1
  while (z >= 0x80) {
    out.push((z % 0x80) | 0x80)
    z = Math.floor(z / 0x80)
  }
  out.push(z)
}

function readVarint(bytes: Uint8Array, at: { i: number }): number {
  let z = 0
  let mul = 1
  for (let k = 0; k < 6; k++) {
    if (at.i >= bytes.length) throw new Error('truncated')
    const b = bytes[at.i++]
    z += (b & 0x7f) * mul
    if (b < 0x80) return z % 2 === 0 ? z / 2 : -(z + 1) / 2
    mul *= 0x80
  }
  throw new Error('overlong number')
}

function utf8(s: string): number[] {
  return [...new TextEncoder().encode(s)]
}

function toBase64Url(bytes: number[]): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url')
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * The route as a link parameter: version, three labels (length-prefixed
 * UTF-8) and the points as delta-encoded 1e-5° integers (about a metre),
 * zig-zag varints, base64url. A 12-point route is about 120 characters.
 */
export function encodeRouteParam(route: SharedRoute): string {
  const pts = route.points.filter(validPoint).slice(0, MAX_LINK_POINTS)
  const out: number[] = [VERSION]
  for (const label of [cleanLabel(route.name, 'Route'), cleanLabel(route.startLabel, 'Start'), cleanLabel(route.destLabel, 'Destination')]) {
    const b = utf8(label)
    pushVarint(out, b.length)
    out.push(...b)
  }
  pushVarint(out, pts.length)
  let pl = 0
  let po = 0
  for (const p of pts) {
    const la = Math.round(p.lat * Q)
    const lo = Math.round(p.lon * Q)
    pushVarint(out, la - pl)
    pushVarint(out, lo - po)
    pl = la
    po = lo
  }
  return toBase64Url(out)
}

/** The whole link: this app's origin with `?route=…`. */
export function routeLink(origin: string, route: SharedRoute): string {
  return `${origin.replace(/\/+$/, '')}/?${ROUTE_PARAM}=${encodeRouteParam(route)}`
}

export type DecodedRoute = { ok: true; route: SharedRoute } | { ok: false; error: string }

/** Read a `route` parameter back — strictly; any doubt is a refusal. */
export function decodeRouteParam(param: unknown): DecodedRoute {
  const bad = (error: string): DecodedRoute => ({ ok: false, error })
  if (typeof param !== 'string' || param.length === 0) return bad('The link has no route in it.')
  if (param.length > MAX_LINK_CHARS) return bad('The route in this link is too long to open.')
  try {
    const bytes = fromBase64Url(param)
    const at = { i: 0 }
    if (bytes[at.i++] !== VERSION) return bad('This route link is from a newer NavMate — update the app.')
    const labels: string[] = []
    const dec = new TextDecoder('utf-8', { fatal: true })
    for (let k = 0; k < 3; k++) {
      const n = readVarint(bytes, at)
      if (n < 0 || n > MAX_LABEL * 4 || at.i + n > bytes.length) return bad('The route link is damaged.')
      labels.push(dec.decode(bytes.subarray(at.i, at.i + n)))
      at.i += n
    }
    const count = readVarint(bytes, at)
    if (!Number.isInteger(count) || count < 2 || count > MAX_LINK_POINTS) return bad('The route link has too few or too many points.')
    const points: LatLon[] = []
    let la = 0
    let lo = 0
    for (let k = 0; k < count; k++) {
      la += readVarint(bytes, at)
      lo += readVarint(bytes, at)
      const p = { lat: la / Q, lon: lo / Q }
      if (!validPoint(p)) return bad('The route link has a position that is not on Earth.')
      points.push(p)
    }
    if (at.i !== bytes.length) return bad('The route link is damaged.')
    return {
      ok: true,
      route: {
        name: cleanLabel(labels[0], 'Shared route'),
        startLabel: cleanLabel(labels[1], 'Start'),
        destLabel: cleanLabel(labels[2], 'Destination'),
        points,
      },
    }
  } catch {
    return bad('The route link is damaged.')
  }
}

/* ------------------------------------------------------------ summary */

/**
 * The text that goes with a shared route: its name, distance, what the boat
 * it was planned for needs, every point in the reader's own coordinate
 * format, and the disclaimer.
 */
export function shareText(
  route: SharedRoute,
  opts: {
    distance: string
    needs?: string | null
    formatPoint: (p: LatLon) => string
    link?: string | null
  },
): string {
  const lines = [
    cleanLabel(route.name, 'NavMate route'),
    `${opts.distance}${opts.needs ? ` · planned for a boat needing ${opts.needs}` : ''}`,
    '',
    ...route.points.map((p, i) => {
      const last = route.points.length - 1
      const n = i === 0 ? `Start (${cleanLabel(route.startLabel, 'Start')})` : i === last ? `Destination (${cleanLabel(route.destLabel, 'Destination')})` : `WP ${i}`
      return `${n}: ${opts.formatPoint(p)}`
    }),
    '',
    'Check against your chart — planned for another boat; NavMate re-checks it for yours before you can steer it.',
  ]
  if (opts.link) lines.push('', opts.link)
  return lines.join('\n')
}

/* --------------------------------------------------- back into a plan */

/**
 * A route that arrived as bare points (a link), as a plan the app can
 * re-check. Never steerable as it stands: `best-effort` and `needsConfirm`
 * until `recheckPlan` has measured it for this boat.
 */
export function planFromPoints(points: LatLon[], speedKn: number): RoutePlan {
  const { legs: base, totalNM } = buildLegs(points, () => true)
  let run = 0
  const legs: RouteLeg[] = base.map((leg) => {
    run += leg.lengthNM
    return {
      ...leg,
      kind: 'search',
      etaHours: speedKn > 0 ? run / speedKn : NaN,
      minChartedDepthM: null,
      channelFraction: null,
      caution: 'unsafe-depth',
      minClearanceM: null,
      unverified: true,
    }
  })
  return {
    points,
    legs,
    totalNM,
    hours: speedKn > 0 ? totalNM / speedKn : NaN,
    source: 'best-effort',
    coverage: 'none',
    warnings: ['Not yet checked for your boat.'],
    movedStart: null,
    movedEnd: null,
    outsideChannelNM: null,
    arrivalFt: points.map(() => 150),
    failure: null,
    needsConfirm: true,
    confirmReason: 'Not yet checked for your boat.',
  }
}
