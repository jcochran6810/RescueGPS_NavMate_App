/**
 * Charted depths and hazards, from NOAA's ENC Direct to GIS services.
 *
 * This is where the route planner gets its facts. The services are free and
 * keyless (the same reason the imagery and the tide predictions are usable in
 * a static bundle with no server), and they publish the S-57 objects an ECDIS
 * uses: depth areas with the shoalest depth of each band, land, wrecks,
 * obstructions, rocks and bridge clearances.
 *
 * Two things shape every decision in this file:
 *
 * **The layer ids are discovered, never hardcoded.** ENC Direct splits its
 * catalogue by usage band and renumbers layers; NOAA refreshes the whole thing
 * weekly. A hardcoded id that silently comes back as something else would put
 * a boat through a shoal, so the layer list is fetched and matched by name.
 *
 * **Nothing is trusted to be complete.** A query that hits its transfer limit
 * is split and retried, and if it still overflows the area is reported
 * `partial` — which the route turns into a warning rather than swallowing.
 * Missing hazards are the failure mode that matters here.
 *
 * Coverage is US waters, exactly like the tide predictions. Outside it the
 * result is `coverage: 'none'` and the planner falls back to a straight line
 * it tells the crew not to trust.
 */

import { haversineNM } from './geo'
import type {
  ChannelPolygon,
  ChartFeatures,
  DepthPolygon,
  LandPolygon,
  PointHazard,
  Ring,
} from './routing'

export interface ChartBounds {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

/** Does `outer` fully contain `inner`? */
export function containsBounds(outer: ChartBounds | null, inner: ChartBounds): boolean {
  if (!outer) return false
  return (
    outer.minLat <= inner.minLat &&
    outer.minLon <= inner.minLon &&
    outer.maxLat >= inner.maxLat &&
    outer.maxLon >= inner.maxLon
  )
}

/**
 * Grow a box before asking the service for it.
 *
 * A route that has to detour wants features outside the straight line's box,
 * and a second round trip on a cellular link costs far more than the extra
 * polygons do.
 */
export function padBounds(b: ChartBounds, fraction = 0.25): ChartBounds {
  const dLat = (b.maxLat - b.minLat) * fraction
  const dLon = (b.maxLon - b.minLon) * fraction
  return {
    minLat: b.minLat - dLat,
    maxLat: b.maxLat + dLat,
    minLon: b.minLon - dLon,
    maxLon: b.maxLon + dLon,
  }
}

/* -------------------------------------------------------------------------
 * Usage bands
 * ---------------------------------------------------------------------- */

const ENC_ROOT = 'https://encdirect.noaa.gov/arcgis/rest/services/encdirect'

export interface EncBand {
  id: string
  service: string
  /** Largest passage this band is the right scale for, NM. */
  maxSpanNM: number
}

/**
 * ENC usage bands, finest first. The scale a chart was compiled at is the
 * scale it is honest at: the harbour band knows about a dredged cut, the
 * overview band knows the coastline and nothing that would keep a small boat
 * off a bank.
 */
export const ENC_BANDS: EncBand[] = [
  { id: 'harbour', service: `${ENC_ROOT}/enc_harbour/MapServer`, maxSpanNM: 4 },
  { id: 'approach', service: `${ENC_ROOT}/enc_approach/MapServer`, maxSpanNM: 15 },
  { id: 'coastal', service: `${ENC_ROOT}/enc_coastal/MapServer`, maxSpanNM: 60 },
  { id: 'general', service: `${ENC_ROOT}/enc_general/MapServer`, maxSpanNM: 250 },
  { id: 'overview', service: `${ENC_ROOT}/enc_overview/MapServer`, maxSpanNM: Infinity },
]

/** Diagonal of the box, nautical miles. */
export function boundsSpanNM(b: ChartBounds): number {
  return haversineNM(b.minLat, b.minLon, b.maxLat, b.maxLon)
}

/** The finest band that covers a passage of this size. */
export function bandForSpan(spanNM: number): EncBand {
  return ENC_BANDS.find((b) => spanNM <= b.maxSpanNM) ?? ENC_BANDS[ENC_BANDS.length - 1]
}

/* -------------------------------------------------------------------------
 * Layer discovery
 * ---------------------------------------------------------------------- */

export type ChartRole =
  | 'depth'
  | 'dredged'
  | 'fairway'
  | 'land'
  | 'shoreline'
  | 'wreck'
  | 'obstruction'
  | 'rock'
  | 'pile'
  | 'bridge'

/**
 * What each role looks like in a layer name, and which geometry it must be.
 *
 * Names arrive prefixed by the band (`Harbor.Depth_Area`), sometimes suffixed
 * by geometry (`..._area`), sometimes with spaces instead of underscores, so
 * the match is deliberately loose on separators and strict on the word.
 */
const ROLE_PATTERNS: { role: ChartRole; test: RegExp; geometry: 'polygon' | 'point' | 'any' }[] = [
  { role: 'depth', test: /depth[\s_]*area/i, geometry: 'polygon' },
  { role: 'dredged', test: /dredged[\s_]*area/i, geometry: 'polygon' },
  { role: 'fairway', test: /fairway/i, geometry: 'polygon' },
  { role: 'land', test: /land[\s_]*area/i, geometry: 'polygon' },
  { role: 'shoreline', test: /shoreline[\s_]*construction/i, geometry: 'polygon' },
  { role: 'wreck', test: /wreck/i, geometry: 'any' },
  { role: 'obstruction', test: /obstruction/i, geometry: 'any' },
  { role: 'rock', test: /underwater[\s_]*rock|rock[\s_]*awash/i, geometry: 'any' },
  // `[\W_]` rather than `\b`: an underscore IS a word character, so `\bpile`
  // would miss `Harbor_Piles_point`, which is exactly the shape these names
  // arrive in. The guards also stop it matching "compiled".
  { role: 'pile', test: /(?:^|[\W_])piles?(?:[\W_]|$)/i, geometry: 'point' },
  { role: 'bridge', test: /bridge/i, geometry: 'any' },
]

export interface LayerRef {
  id: number
  name: string
  role: ChartRole
  geometry: 'polygon' | 'point' | 'line'
}

function geometryKind(esri: unknown): LayerRef['geometry'] | null {
  if (typeof esri !== 'string') return null
  if (esri === 'esriGeometryPolygon') return 'polygon'
  if (esri === 'esriGeometryPoint' || esri === 'esriGeometryMultipoint') return 'point'
  if (esri === 'esriGeometryPolyline') return 'line'
  return null
}

/**
 * Pick the layers we can use out of a MapServer's layer list.
 *
 * Takes the parsed `MapServer/layers?f=json` body — one request for the whole
 * catalogue rather than one per layer, which matters on a cellular link.
 */
export function matchLayers(payload: unknown): LayerRef[] {
  const layers = (payload as { layers?: unknown[] })?.layers
  if (!Array.isArray(layers)) return []
  const out: LayerRef[] = []
  for (const raw of layers) {
    const l = raw as { id?: unknown; name?: unknown; geometryType?: unknown }
    if (typeof l.id !== 'number' || typeof l.name !== 'string') continue
    const geometry = geometryKind(l.geometryType)
    if (!geometry) continue
    for (const { role, test, geometry: want } of ROLE_PATTERNS) {
      if (!test.test(l.name)) continue
      if (want === 'polygon' && geometry !== 'polygon') continue
      if (want === 'point' && geometry !== 'point') continue
      // Only polygons and points are useful: a line has no inside to rasterise
      // and a hazard drawn as a line is already covered by its area twin.
      if (geometry === 'line') continue
      out.push({ id: l.id, name: l.name, role, geometry })
      break
    }
  }
  return out
}

/* -------------------------------------------------------------------------
 * Reading features
 * ---------------------------------------------------------------------- */

/** Attribute names a depth might arrive under, in order of preference. */
const DEPTH_FIELDS = ['DRVAL1', 'drval1', 'MINDEPTH', 'mindepth']
const SOUNDING_FIELDS = ['VALSOU', 'valsou']
const CLEARANCE_FIELDS = ['VERCLR', 'verclr']

function pickNumber(props: Record<string, unknown> | null, names: string[]): number | null {
  if (!props) return null
  for (const n of names) {
    const v = props[n]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const parsed = parseFloat(v)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  // Case-insensitive second pass — field casing varies between bands.
  const lower = names.map((n) => n.toLowerCase())
  for (const [k, v] of Object.entries(props)) {
    if (!lower.includes(k.toLowerCase())) continue
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const parsed = parseFloat(v)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function isRing(v: unknown): v is Ring {
  return (
    Array.isArray(v) &&
    v.length >= 3 &&
    Array.isArray(v[0]) &&
    typeof (v[0] as unknown[])[0] === 'number'
  )
}

/**
 * Rings out of one feature's geometry, accepting GeoJSON or Esri JSON.
 *
 * Both are handled because `f=geojson` is not guaranteed on every ArcGIS
 * version NOAA runs, and this cannot be checked from a build sandbox that the
 * proxy blocks from reaching the service at all. Esri's `rings` and GeoJSON's
 * `coordinates` are the same nested arrays of `[x, y]`, so supporting the pair
 * costs one branch and removes a whole class of field failure.
 */
export function ringsOf(geometry: unknown): Ring[] {
  if (!geometry || typeof geometry !== 'object') return []
  const g = geometry as { type?: unknown; coordinates?: unknown; rings?: unknown }

  if (Array.isArray(g.rings)) {
    return (g.rings as unknown[]).filter(isRing)
  }
  if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
    return (g.coordinates as unknown[]).filter(isRing)
  }
  if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
    const out: Ring[] = []
    for (const poly of g.coordinates as unknown[]) {
      if (Array.isArray(poly)) out.push(...(poly as unknown[]).filter(isRing))
    }
    return out
  }
  return []
}

/** A point out of GeoJSON or Esri JSON geometry. */
export function pointOf(geometry: unknown): { lat: number; lon: number } | null {
  if (!geometry || typeof geometry !== 'object') return null
  const g = geometry as { type?: unknown; coordinates?: unknown; x?: unknown; y?: unknown }
  if (typeof g.x === 'number' && typeof g.y === 'number') return { lat: g.y, lon: g.x }
  if (g.type === 'Point' && Array.isArray(g.coordinates)) {
    const [lon, lat] = g.coordinates as number[]
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon }
  }
  return null
}

interface RawFeature {
  geometry: unknown
  properties: Record<string, unknown> | null
}

/** Features out of a FeatureCollection or an Esri query response. */
export function featuresOf(payload: unknown): RawFeature[] {
  const p = payload as { features?: unknown[] }
  if (!Array.isArray(p?.features)) return []
  return p.features.map((raw) => {
    const f = raw as { geometry?: unknown; properties?: unknown; attributes?: unknown }
    const props = (f.properties ?? f.attributes ?? null) as Record<string, unknown> | null
    return { geometry: f.geometry, properties: props }
  })
}

export function exceededLimit(payload: unknown): boolean {
  return (payload as { exceededTransferLimit?: unknown })?.exceededTransferLimit === true
}

/**
 * Radius given to a point hazard, metres.
 *
 * A wreck is a pinprick in the data and a hull-sized object in the water, and
 * the position itself carries survey error. 40 m is deliberately generous: the
 * cost of going round one that was not there is seconds, and the cost of the
 * other mistake is the boat.
 */
export const HAZARD_RADIUS_M = 40

/**
 * Radius given to a charted pile, metres.
 *
 * Deliberately not the wreck's 40 m. A pile is a metre of timber or steel in a
 * position the chart knows to within a few metres — not a hull lying somewhere
 * near a reported wreck position. And piles line the banks of dredged cuts,
 * marina approaches and bridge fenders: at the harbour band a cell is 8 m, so
 * a 40 m disc is five cells, and piles down both sides would close a 60 m
 * channel completely. The route would then fail to the straight line, which is
 * worse than no pile data at all on exactly the harbour routes that need it
 * most. The lateral stand-off the coxswain sets is applied on top of this.
 */
export const PILE_RADIUS_M = 10

/* -------------------------------------------------------------------------
 * Querying
 * ---------------------------------------------------------------------- */

export function queryUrl(service: string, layerId: number, b: ChartBounds): string {
  const geometry = `${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}`
  const params = new URLSearchParams({
    f: 'geojson',
    where: '1=1',
    geometry,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    geometryPrecision: '6',
  })
  return `${service}/${layerId}/query?${params.toString()}`
}

export function layersUrl(service: string): string {
  return `${service}/layers?f=json`
}

/** Split a box into its four quadrants. */
export function quadrants(b: ChartBounds): ChartBounds[] {
  const midLat = (b.minLat + b.maxLat) / 2
  const midLon = (b.minLon + b.maxLon) / 2
  return [
    { minLat: b.minLat, minLon: b.minLon, maxLat: midLat, maxLon: midLon },
    { minLat: b.minLat, minLon: midLon, maxLat: midLat, maxLon: b.maxLon },
    { minLat: midLat, minLon: b.minLon, maxLat: b.maxLat, maxLon: midLon },
    { minLat: midLat, minLon: midLon, maxLat: b.maxLat, maxLon: b.maxLon },
  ]
}

/** Deepest the box is split before giving up and reporting `partial`. */
export const MAX_SPLIT_DEPTH = 2

export type Fetcher = (url: string) => Promise<unknown>

const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' })
  if (!res.ok) throw new Error(`Chart service returned ${res.status}`)
  return (await res.json()) as unknown
}

/**
 * Every feature of one layer inside a box, splitting when the server caps the
 * response. Returns `complete: false` when a quadrant still overflowed at the
 * split limit — that is the signal that a hazard may be missing.
 */
export async function queryLayer(
  service: string,
  layerId: number,
  b: ChartBounds,
  fetcher: Fetcher = defaultFetcher,
  depth = 0,
): Promise<{ features: RawFeature[]; complete: boolean }> {
  let payload: unknown
  try {
    payload = await fetcher(queryUrl(service, layerId, b))
  } catch {
    return { features: [], complete: false }
  }
  if (!exceededLimit(payload)) {
    return { features: featuresOf(payload), complete: true }
  }
  if (depth >= MAX_SPLIT_DEPTH) {
    return { features: featuresOf(payload), complete: false }
  }
  const parts = await Promise.all(
    quadrants(b).map((q) => queryLayer(service, layerId, q, fetcher, depth + 1)),
  )
  return {
    features: parts.flatMap((p) => p.features),
    complete: parts.every((p) => p.complete),
  }
}

/**
 * Everything the router needs for one area.
 *
 * A dredged area is recorded twice, and that is the point rather than a
 * duplication: it carries a `DRVAL1` like any depth area — a dredged cut is
 * usually the most useful depth on the chart — and it is also water traffic is
 * meant to be in. Flattening it into a depth loses the second fact, which is
 * the one the coxswain is actually steering by. A fairway is the opposite: it
 * is marked water carrying no depth at all, so it becomes a channel and never
 * a depth area.
 *
 * Land and shoreline construction both become land: a breakwater is not land,
 * but it stops a boat exactly like land does.
 */
export async function fetchChartFeatures(
  bounds: ChartBounds,
  options: { fetcher?: Fetcher; band?: EncBand } = {},
): Promise<ChartFeatures> {
  const fetcher = options.fetcher ?? defaultFetcher
  const band = options.band ?? bandForSpan(boundsSpanNM(bounds))

  let layers: LayerRef[]
  try {
    layers = matchLayers(await fetcher(layersUrl(band.service)))
  } catch {
    return { depthAreas: [], channels: [], land: [], hazards: [], coverage: 'none' }
  }
  if (layers.length === 0) {
    return { depthAreas: [], channels: [], land: [], hazards: [], coverage: 'none' }
  }

  const results = await Promise.all(
    layers.map(async (layer) => ({
      layer,
      ...(await queryLayer(band.service, layer.id, bounds, fetcher)),
    })),
  )

  const depthAreas: DepthPolygon[] = []
  const channels: ChannelPolygon[] = []
  const land: LandPolygon[] = []
  const hazards: PointHazard[] = []
  let complete = true

  for (const { layer, features, complete: ok } of results) {
    if (!ok) complete = false
    for (const f of features) {
      switch (layer.role) {
        case 'depth':
        case 'dredged': {
          const d = pickNumber(f.properties, DEPTH_FIELDS)
          const rings = ringsOf(f.geometry)
          if (d !== null && rings.length > 0) depthAreas.push({ minDepthM: d, rings })
          if (layer.role === 'dredged' && rings.length > 0) {
            channels.push({ kind: 'dredged', rings })
          }
          break
        }
        case 'fairway': {
          // No depth is read here on purpose: a fairway does not carry one,
          // and inventing a depth for marked water is the guess this app
          // refuses everywhere else. It is preferable water, not usable water
          // — a depth area has to say so independently.
          const rings = ringsOf(f.geometry)
          if (rings.length > 0) channels.push({ kind: 'fairway', rings })
          break
        }
        case 'land':
        case 'shoreline': {
          const rings = ringsOf(f.geometry)
          if (rings.length > 0) land.push({ rings })
          break
        }
        case 'wreck':
        case 'obstruction':
        case 'rock':
        case 'pile': {
          // An area hazard is land as far as the boat is concerned; a point one
          // gets a footprint. A charted sounding deeper than any boat here is
          // still left in — the router decides, not the fetcher.
          const rings = ringsOf(f.geometry)
          if (rings.length > 0) {
            land.push({ rings })
            break
          }
          const p = pointOf(f.geometry)
          if (p) {
            hazards.push({
              ...p,
              radiusM: layer.role === 'pile' ? PILE_RADIUS_M : HAZARD_RADIUS_M,
              kind: layer.role,
              label: pickNumber(f.properties, SOUNDING_FIELDS) !== null
                ? `${layer.role} ${pickNumber(f.properties, SOUNDING_FIELDS)} m`
                : layer.role,
            })
          }
          break
        }
        case 'bridge':
          // Bridges are read for air draft only; they do not block the water.
          break
      }
    }
  }

  if (depthAreas.length === 0) {
    // Channels deliberately do not rescue coverage: marked water over water
    // nobody surveyed is not a route.
    return { depthAreas: [], channels, land, hazards, coverage: 'none' }
  }
  return {
    depthAreas,
    channels,
    land,
    hazards,
    coverage: complete ? 'full' : 'partial',
  }
}

/** Lowest charted vertical clearance among bridge features, metres. */
export function minBridgeClearance(features: RawFeature[]): number | null {
  let min: number | null = null
  for (const f of features) {
    const v = pickNumber(f.properties, CLEARANCE_FIELDS)
    if (v === null) continue
    if (min === null || v < min) min = v
  }
  return min
}
