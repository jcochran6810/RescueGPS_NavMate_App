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
 * result is `coverage: 'none'`, and the planner says there is no chart to
 * plan on rather than drawing anything.
 */

import { haversineNM } from './geo'
import type {
  ChannelPolygon,
  ChartFeatures,
  DepthPolygon,
  LandPolygon,
  LineHazard,
  PointHazard,
  Ring,
} from './routing'
import type { LatLon } from './search'

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

/**
 * The chart could not be consulted — as opposed to consulted and found empty.
 *
 * `unreachable` is the network or the browser refusing: no signal, the service
 * moved, or — the one this app cannot fix by itself — the host not sending
 * `Access-Control-Allow-Origin`, which blocks the queries even though the map
 * tiles still draw. `no-layers` means the service answered but nothing in it
 * is named the way `ROLE_PATTERNS` expects, which is a NavMate problem, not
 * the crew's.
 *
 * The service URL travels with the error on purpose: it is the one thing that
 * tells whoever is reading the screen which of those it is.
 */
export type ChartFailure = 'unreachable' | 'no-layers'

export class ChartUnavailableError extends Error {
  readonly kind: ChartFailure
  readonly service: string
  readonly band: string

  constructor(kind: ChartFailure, band: EncBand, detail?: string) {
    super(
      kind === 'unreachable'
        ? `Could not reach the chart service for the ${band.id} band` +
          `${detail ? ` — ${detail}` : ''}`
        : `The ${band.id} chart service answered, but ` +
          `${detail ?? 'none of its layers are named the way this app expects'}`,
    )
    this.name = 'ChartUnavailableError'
    this.kind = kind
    this.service = band.service
    this.band = band.id
  }
}

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

/**
 * Largest box each band is worth querying over, NM.
 *
 * A finer band over a big box is thousands of polygons and a cascade of
 * transfer-limit splits, so past this size it is skipped. These are well
 * above `maxSpanNM` on purpose: the padded box around even a short harbour
 * hop is ~4.5 NM across, which is already past the harbour band's
 * `maxSpanNM`, and harbour charts are what make those hops routable.
 */
const MAX_FETCH_SPAN_NM: Record<string, number> = {
  harbour: 30,
  approach: 100,
  coastal: 400,
  general: 1500,
  overview: Infinity,
}

/**
 * Every band worth asking about a passage of this size, finest first.
 *
 * One band was never enough. ENC Direct publishes each usage band only where
 * charts of that scale exist, and the bands are not nested: Galveston has
 * five hundred harbour-band depth areas and **no approach-band chart at all**,
 * so a route there asked the approach band, got an empty sea back, and was
 * drawn as a straight line across Pelican Island. So every band from the
 * finest down to one coarser than the span calls for is asked, and
 * `fetchChartArea` lets the most detailed one that answered speak for each
 * cell. The coarser band is the backstop between harbours.
 */
export function bandsForSpan(spanNM: number): EncBand[] {
  const primary = ENC_BANDS.indexOf(bandForSpan(spanNM))
  return ENC_BANDS.filter(
    (b, i) => i <= primary + 1 && spanNM <= (MAX_FETCH_SPAN_NM[b.id] ?? Infinity),
  )
}

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
  | 'pylon'
  | 'platform'
  | 'dam'
  | 'causeway'
  | 'dyke'
  | 'gate'
  | 'floatingDock'
  | 'hulk'
  | 'pontoon'
  | 'mooring'
  | 'bridge'

/**
 * What each role looks like in a layer name, and which geometry it must be.
 *
 * Names arrive prefixed by the band (`Harbor.Depth_Area`), sometimes suffixed
 * by geometry (`..._area`), sometimes with spaces instead of underscores, so
 * the match is deliberately loose on separators and strict on the word.
 */
/**
 * A whole word, where an underscore counts as a separator.
 *
 * `\b` will not do: an underscore IS a word character, so `\bpile` misses
 * `Harbor_Piles_point`, which is exactly the shape these names arrive in.
 */
function token(word: string): string {
  return `(?:^|[\\W_])${word}(?:[\\W_]|$)`
}

/**
 * The S-57 object class each role is, as a six-letter acronym.
 *
 * These are the names the data actually has. ENC is published from S-57, whose
 * object classes are six-letter codes — `DEPARE` is a depth area, `LNDARE` is
 * land — and a GIS service may expose either the code or a readable name, or
 * both in one string. Matching only the readable form is a bet on a
 * presentation choice, and losing it is silent: the depth layer simply is not
 * found, no depth areas are collected, and the screen reports "no charted
 * depths for this area" about water that is charted in detail.
 *
 * Note `WRECKS` reads as "wrecks" and `BRIDGE` as "bridge", so those two match
 * either way — which is precisely why this went unnoticed. Enough layers
 * matched to clear the "did we find anything" gate while every layer that
 * carries a depth failed to.
 */
const ROLE_ACRONYMS: Record<ChartRole, string> = {
  depth: 'DEPARE',
  dredged: 'DRGARE',
  fairway: 'FAIRWY',
  land: 'LNDARE',
  shoreline: 'SLCONS',
  wreck: 'WRECKS',
  obstruction: 'OBSTRN',
  rock: 'UWTROC',
  pile: 'PILPNT',
  pylon: 'PYLONS',
  platform: 'OFSPLF',
  dam: 'DAMCON',
  causeway: 'CAUSWY',
  dyke: 'DYKCON',
  gate: 'GATCON',
  floatingDock: 'FLODOC',
  hulk: 'HULKES',
  pontoon: 'PONTON',
  mooring: 'MORFAC',
  bridge: 'BRIDGE',
}

/** The readable name each role goes by, where a service spells it out. */
const ROLE_WORDS: Record<ChartRole, string> = {
  depth: 'depth[\\s_]*area',
  dredged: 'dredged[\\s_]*area',
  fairway: 'fairway',
  land: 'land[\\s_]*area',
  shoreline: 'shoreline[\\s_]*construction',
  wreck: 'wreck',
  obstruction: 'obstruction',
  // NOAA publishes it as `Underwater_Awash_Rock` — both words between.
  rock: 'underwater[\\s_]*(?:awash[\\s_]*)?rock|rock[\\s_]*awash',
  pile: token('piles?'),
  // `Pylon_Bridge_Support` also says "bridge", which is why this role is
  // matched before `bridge` — a bridge is read for air draft and never blocks,
  // a pylon is a concrete pier standing in the channel.
  pylon: 'pylon',
  platform: 'offshore[\\s_]*platform',
  // Short words, so whole-word only: "dam" must not match inside a longer name.
  dam: token('dams?'),
  causeway: 'causeway',
  dyke: token('d[yi]kes?'),
  gate: token('gates?'),
  floatingDock: 'floating[\\s_]*dock',
  hulk: token('hulks?'),
  pontoon: 'pontoon',
  mooring: 'mooring',
  bridge: 'bridge',
}

type Geometry = LayerRef['geometry']

/**
 * The geometries each role is read in. Anything else is skipped — and then
 * offered to the next role in `ROLE_ORDER`, which is how `Land_Area_point`
 * (an islet) is still found after `Depth_Area_line` style names fall through.
 *
 * Lines are read only where a line IS the hazard: a jetty, breakwater, pier,
 * dam, causeway, dyke, gate, floating dock, pontoon, mooring or obstruction
 * line — and land charted as a line, which S-57 uses for land too narrow to
 * draw as an area (a spit, a narrow training wall). A depth contour or a
 * fairway line is a boundary of something that is also published as an area,
 * and is still refused.
 *
 * Points are read for the hazards that have a position and a size: wrecks,
 * obstructions, rocks, piles, bridge pylons, islets and platforms. The point
 * forms of dams, gates, hulks and mooring facilities are not read — they are
 * charted on or beside a structure that has its own line or area.
 */
const ROLE_GEOMETRY: Record<ChartRole, readonly Geometry[]> = {
  depth: ['polygon'],
  dredged: ['polygon'],
  fairway: ['polygon'],
  land: ['polygon', 'point', 'line'],
  shoreline: ['polygon', 'line'],
  wreck: ['polygon', 'point'],
  obstruction: ['polygon', 'point', 'line'],
  rock: ['polygon', 'point'],
  pile: ['point'],
  pylon: ['polygon', 'point'],
  platform: ['polygon', 'point'],
  dam: ['polygon', 'line'],
  causeway: ['polygon', 'line'],
  dyke: ['polygon', 'line'],
  // Only the line: that is the form the gate itself is charted in. The area
  // form is not in this app's list of blocking structures.
  gate: ['line'],
  floatingDock: ['polygon', 'line'],
  hulk: ['polygon'],
  pontoon: ['polygon', 'line'],
  mooring: ['polygon', 'line'],
  // Read for air draft only; a bridge never blocks the water.
  bridge: ['polygon', 'point'],
}

/** Roles in match order — the first that fits a layer name wins. */
const ROLE_ORDER: ChartRole[] = [
  'depth',
  'dredged',
  'fairway',
  'land',
  'shoreline',
  'wreck',
  'obstruction',
  'rock',
  'pile',
  'pylon',
  'platform',
  'dam',
  'causeway',
  'dyke',
  'gate',
  'floatingDock',
  'hulk',
  'pontoon',
  'mooring',
  'bridge',
]

const ROLE_PATTERNS: { role: ChartRole; test: RegExp; geometry: readonly Geometry[] }[] =
  ROLE_ORDER.map((role) => ({
    role,
    test: new RegExp(`${ROLE_WORDS[role]}|${token(ROLE_ACRONYMS[role])}`, 'i'),
    geometry: ROLE_GEOMETRY[role],
  }))

/** The roles that can carry a charted depth — without one, there is no route. */
const DEPTH_ROLES: ChartRole[] = ['depth', 'dredged']

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
/** Every layer name the service published, for saying what we were given. */
export function publishedLayerNames(payload: unknown): string[] {
  const layers = (payload as { layers?: unknown[] })?.layers
  if (!Array.isArray(layers)) return []
  return layers
    .map((raw) => (raw as { name?: unknown }).name)
    .filter((n): n is string => typeof n === 'string')
}

export function matchLayers(payload: unknown): LayerRef[] {
  const layers = (payload as { layers?: unknown[] })?.layers
  if (!Array.isArray(layers)) return []
  const out: LayerRef[] = []
  for (const raw of layers) {
    const l = raw as { id?: unknown; name?: unknown; geometryType?: unknown }
    if (typeof l.id !== 'number' || typeof l.name !== 'string') continue
    const geometry = geometryKind(l.geometryType)
    if (!geometry) continue
    for (const { role, test, geometry: accepts } of ROLE_PATTERNS) {
      if (!test.test(l.name)) continue
      // A name that fits a role in a geometry that role is not read in falls
      // through to the next role rather than stopping: `Land_Area_point` is
      // not a land polygon, but it is an islet.
      if (!accepts.includes(geometry)) continue
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

/** One vertex, `[x, y]` with anything after (a Z or an M) dropped. */
function vertexOf(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null
  const [x, y] = v as unknown[]
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return [x, y]
}

/**
 * The runs of good vertices in one path, each at least two long.
 *
 * A vertex that cannot be read splits the path rather than being skipped or
 * sinking it: joining its neighbours would draw a jetty where the chart did
 * not put one, and dropping the whole path would lose a jetty the chart did
 * put there. The pieces either side are still exactly what was charted.
 */
function runsOf(v: unknown): [number, number][][] {
  if (!Array.isArray(v)) return []
  const runs: [number, number][][] = []
  let run: [number, number][] = []
  for (const raw of v as unknown[]) {
    const p = vertexOf(raw)
    if (p) {
      run.push(p)
      continue
    }
    if (run.length >= 2) runs.push(run)
    run = []
  }
  if (run.length >= 2) runs.push(run)
  return runs
}

/**
 * Polylines out of one feature's geometry, accepting GeoJSON or Esri JSON —
 * the line twin of `ringsOf`, for the same reason: `f=geojson` is not
 * guaranteed, and Esri's `paths` and GeoJSON's `coordinates` are the same
 * nested arrays of `[x, y]`.
 *
 * Each path comes back open, as `[lon, lat]` pairs. A path with fewer than two
 * usable vertices is dropped: a single point has no length to block.
 */
export function pathsOf(geometry: unknown): [number, number][][] {
  if (!geometry || typeof geometry !== 'object') return []
  const g = geometry as { type?: unknown; coordinates?: unknown; paths?: unknown }
  const keep = (list: unknown[]) => list.flatMap(runsOf)

  if (Array.isArray(g.paths)) return keep(g.paths as unknown[])
  if (g.type === 'LineString' && Array.isArray(g.coordinates)) {
    return keep([g.coordinates])
  }
  if (g.type === 'MultiLineString' && Array.isArray(g.coordinates)) {
    return keep(g.coordinates as unknown[])
  }
  return []
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

/**
 * An ArcGIS error, which arrives as **HTTP 200** with an error object in the
 * body rather than as a status a fetch would reject.
 *
 * This is the trap that made a working chart service look like empty sea: the
 * status was fine, `featuresOf` found no `features` array and returned `[]`,
 * and the planner reported "no charted depths for this area" about the Houston
 * Ship Channel. Nothing anywhere said a request had failed.
 */
export function arcgisError(payload: unknown): string | null {
  const e = (payload as { error?: { message?: string; code?: number } })?.error
  if (!e || typeof e !== 'object') return null
  const code = typeof e.code === 'number' ? ` (${e.code})` : ''
  return `${e.message ?? 'the service reported an error'}${code}`
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

/**
 * Radius given to a bridge pylon, metres.
 *
 * A pylon is a pier of a bridge the boat is about to pass under, charted to
 * within metres, and the spans between them are the channel. Like a pile it
 * is sized for what it is: a wreck's 40 m round each pier would close the
 * navigation span of most bridges on the coast.
 */
export const PYLON_RADIUS_M = 10

/**
 * Radius given to an islet charted as a point, metres.
 *
 * S-57 draws land as a point when it is too small to draw as an area at the
 * chart's scale — a rock that dries, a tiny island. Too small to draw is not
 * too small to hit, and "too small" at a coastal scale can still be a boat
 * length or two across.
 */
export const ISLET_RADIUS_M = 15

/**
 * Radius given to an offshore platform charted as a point, metres.
 *
 * A production platform has a jacket, risers and often a boat landing around
 * it; 30 m is the structure itself, before the crew's own stand-off.
 */
export const PLATFORM_RADIUS_M = 30

/**
 * Width assumed for a fixed structure charted as a line, metres — a jetty,
 * breakwater, pier, dam, causeway, dyke, gate, or land too narrow to draw as
 * an area. The chart gives only the centreline; a rubble-mound jetty is
 * wider than this at the waterline, which is what the crew's stand-off is on
 * top of.
 */
export const STRUCTURE_WIDTH_M = 5

/**
 * Width assumed for a light structure charted as a line, metres — a floating
 * dock, pontoon or mooring facility — and for an obstruction line.
 */
export const LIGHT_STRUCTURE_WIDTH_M = 3

/* -------------------------------------------------------------------------
 * Querying
 * ---------------------------------------------------------------------- */

/**
 * The response formats tried, in order.
 *
 * `geojson` first because it needs no translation, but it is **not** a given:
 * ArcGIS only added it for MapServer layers in 10.4, and a server that does
 * not support it does not fail — it answers HTTP 200 with an error object in
 * the body. That is how a perfectly good depth layer comes back as zero
 * features. `json` is Esri's own form, always available, and `ringsOf` and
 * `featuresOf` already read it.
 */
export const QUERY_FORMATS = ['geojson', 'json'] as const
export type QueryFormat = (typeof QUERY_FORMATS)[number]

export function queryUrl(
  service: string,
  layerId: number,
  b: ChartBounds,
  format: QueryFormat = 'geojson',
): string {
  const geometry = `${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}`
  const params = new URLSearchParams({
    f: format,
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

/**
 * Where a chart query is actually sent.
 *
 * The tiles are `<img>` and need nothing; these queries are `fetch`, and a
 * browser refuses a cross-origin JSON response unless the host sends
 * `Access-Control-Allow-Origin`. So in a browser they go through this app's
 * own `/api/enc` relay (see `api/enc.js`), which is same-origin and therefore
 * always allowed. Outside a browser — the unit tests, any Node caller — the
 * URL is used as-is, because there is no origin and no relay.
 *
 * Exported so the rule is one testable function rather than a condition
 * buried in a fetch call.
 */
export function encRequestUrl(url: string): string {
  if (typeof window === 'undefined') return url
  if (!url.startsWith('https://encdirect.noaa.gov/')) return url
  return `/api/enc?u=${encodeURIComponent(url)}`
}

/** How chart queries are fetched in the app. Exported for its tests. */
export const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(encRequestUrl(url), {
    credentials: 'omit',
  })
  if (!res.ok) {
    // The relay passes NOAA's status through, so this number is the service's
    // own answer — a 404 here means the service path is wrong, not the relay.
    //
    // A 502 may also be an ArcGIS error that NOAA sent as a 200: the relay
    // re-issues those as 502 so no cache keeps them (api/enc.js), with NOAA's
    // body intact. Its message is the useful part, so it is read back out.
    let detail = ''
    try {
      const err = arcgisError(await res.json())
      if (err) detail = `: ${err}`
    } catch {
      // Not JSON — the status alone is all there is to say.
    }
    throw new Error(`Chart service returned ${res.status}${detail}`)
  }
  return (await res.json()) as unknown
}

/**
 * Every feature of one layer inside a box, splitting when the server caps the
 * response. Returns `complete: false` when a quadrant still overflowed at the
 * split limit — that is the signal that a hazard may be missing.
 */
export interface LayerResult {
  features: RawFeature[]
  complete: boolean
  /** Why this layer returned nothing, when the reason was a failure. */
  failed: string | null
}

/**
 * One query, trying each response format until one answers with data.
 *
 * A format the server does not support comes back as HTTP 200 carrying an
 * error, so "it answered" is not the same as "it worked" and both have to be
 * checked. The last failure is kept and reported rather than collapsed into an
 * empty result.
 */
async function runQuery(
  service: string,
  layerId: number,
  b: ChartBounds,
  fetcher: Fetcher,
): Promise<{ payload: unknown } | { failed: string }> {
  let last = 'the chart service did not answer'
  for (const format of QUERY_FORMATS) {
    try {
      const payload = await fetcher(queryUrl(service, layerId, b, format))
      const err = arcgisError(payload)
      if (!err) return { payload }
      last = `${format}: ${err}`
    } catch (e) {
      last = `${format}: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return { failed: last }
}

export async function queryLayer(
  service: string,
  layerId: number,
  b: ChartBounds,
  fetcher: Fetcher = defaultFetcher,
  depth = 0,
): Promise<LayerResult> {
  const got = await runQuery(service, layerId, b, fetcher)
  // A failure used to return zero features and nothing else, which is
  // indistinguishable from water with nothing charted in it. It is not the
  // same thing, and on the water the difference is a straight line through a
  // bank versus an honest empty sea.
  if ('failed' in got) return { features: [], complete: false, failed: got.failed }

  const { payload } = got
  if (!exceededLimit(payload)) {
    return { features: featuresOf(payload), complete: true, failed: null }
  }
  if (depth >= MAX_SPLIT_DEPTH) {
    return { features: featuresOf(payload), complete: false, failed: null }
  }
  const parts = await Promise.all(
    quadrants(b).map((q) => queryLayer(service, layerId, q, fetcher, depth + 1)),
  )
  return {
    features: parts.flatMap((p) => p.features),
    complete: parts.every((p) => p.complete),
    // Only a total failure of every quadrant is a failure of the box: one
    // quadrant that answered is still real data about real water.
    failed: parts.every((p) => p.failed) ? (parts[0].failed ?? null) : null,
  }
}

/**
 * What the service published, in the words it used.
 *
 * This exists because the sandbox this app is built in cannot reach NOAA and
 * neither can it reach the deployment's own origin, so the only instrument
 * left is the screen in front of the crew. Printing the names the service
 * actually gave turns "it plots a straight line" into a fact that can be read
 * off a phone in one photograph and fixed in one line.
 */
function describeCatalogue(payload: unknown, matched: LayerRef[]): string {
  const names = publishedLayerNames(payload)
  const shown = names.slice(0, 12).join(', ')
  const more = names.length > 12 ? ` (+${names.length - 12} more)` : ''
  const recognised = matched.length
    ? matched.map((l) => `${l.name} as ${l.role}`).join(', ')
    : 'nothing'
  return (
    `no layer here carries a charted depth. It published ${names.length} ` +
    `layer${names.length === 1 ? '' : 's'}: ${shown}${more}. ` +
    `Recognised: ${recognised}`
  )
}

/**
 * What a point feature of each role becomes: its kind on the leg card and the
 * footprint the router gives it. Roles not listed here are never read as
 * points (see `ROLE_GEOMETRY`), and a stray point from one of them is skipped
 * rather than guessed at.
 */
const POINT_HAZARDS: Partial<
  Record<ChartRole, { kind: PointHazard['kind']; radiusM: number; label: string }>
> = {
  wreck: { kind: 'wreck', radiusM: HAZARD_RADIUS_M, label: 'wreck' },
  obstruction: { kind: 'obstruction', radiusM: HAZARD_RADIUS_M, label: 'obstruction' },
  rock: { kind: 'rock', radiusM: HAZARD_RADIUS_M, label: 'rock' },
  pile: { kind: 'pile', radiusM: PILE_RADIUS_M, label: 'pile' },
  pylon: { kind: 'pylon', radiusM: PYLON_RADIUS_M, label: 'bridge pylon' },
  land: { kind: 'islet', radiusM: ISLET_RADIUS_M, label: 'islet' },
  platform: { kind: 'platform', radiusM: PLATFORM_RADIUS_M, label: 'offshore platform' },
}

/**
 * What a line feature of each role becomes. The chart gives a centreline; the
 * width is the structure the router must not put the boat inside, and the
 * crew's stand-off is applied beyond it.
 */
const LINE_HAZARDS: Partial<
  Record<ChartRole, { kind: LineHazard['kind']; widthM: number; label: string }>
> = {
  shoreline: { kind: 'structure', widthM: STRUCTURE_WIDTH_M, label: 'jetty, pier or breakwater' },
  land: { kind: 'structure', widthM: STRUCTURE_WIDTH_M, label: 'narrow land' },
  dam: { kind: 'structure', widthM: STRUCTURE_WIDTH_M, label: 'dam' },
  causeway: { kind: 'structure', widthM: STRUCTURE_WIDTH_M, label: 'causeway' },
  dyke: { kind: 'structure', widthM: STRUCTURE_WIDTH_M, label: 'dyke' },
  gate: { kind: 'structure', widthM: STRUCTURE_WIDTH_M, label: 'gate' },
  floatingDock: { kind: 'structure', widthM: LIGHT_STRUCTURE_WIDTH_M, label: 'floating dock' },
  pontoon: { kind: 'structure', widthM: LIGHT_STRUCTURE_WIDTH_M, label: 'pontoon' },
  mooring: { kind: 'structure', widthM: LIGHT_STRUCTURE_WIDTH_M, label: 'mooring facility' },
  obstruction: { kind: 'obstruction', widthM: LIGHT_STRUCTURE_WIDTH_M, label: 'obstruction' },
}

/** Every point out of GeoJSON or Esri JSON, including the multipoint forms. */
function pointsOf(geometry: unknown): { lat: number; lon: number }[] {
  const one = pointOf(geometry)
  if (one) return [one]
  if (!geometry || typeof geometry !== 'object') return []
  const g = geometry as { type?: unknown; coordinates?: unknown; points?: unknown }
  const list = Array.isArray(g.points)
    ? (g.points as unknown[])
    : g.type === 'MultiPoint' && Array.isArray(g.coordinates)
      ? (g.coordinates as unknown[])
      : []
  const out: { lat: number; lon: number }[] = []
  for (const raw of list) {
    const v = vertexOf(raw)
    if (v) out.push({ lon: v[0], lat: v[1] })
  }
  return out
}

/** Where the features of one band end up. */
interface FeatureSink {
  depthAreas: DepthPolygon[]
  channels: ChannelPolygon[]
  land: LandPolygon[]
  hazards: PointHazard[]
  lines: LineHazard[]
}

/**
 * Sort one feature into the shapes the router uses.
 *
 * Dispatch is on the geometry the feature actually has, not on the layer's
 * declared type, so a service that hands back an area on a "point" layer is
 * still read as the area it is.
 */
function readFeature(role: ChartRole, f: RawFeature, sink: FeatureSink): void {
  switch (role) {
    case 'depth':
    case 'dredged': {
      const d = pickNumber(f.properties, DEPTH_FIELDS)
      const rings = ringsOf(f.geometry)
      if (d !== null && rings.length > 0) sink.depthAreas.push({ minDepthM: d, rings })
      if (role === 'dredged' && rings.length > 0) {
        sink.channels.push({ kind: 'dredged', rings })
      }
      return
    }
    case 'fairway': {
      // No depth is read here on purpose: a fairway does not carry one,
      // and inventing a depth for marked water is the guess this app
      // refuses everywhere else. It is preferable water, not usable water
      // — a depth area has to say so independently.
      const rings = ringsOf(f.geometry)
      if (rings.length > 0) sink.channels.push({ kind: 'fairway', rings })
      return
    }
    case 'bridge':
      // Bridges are read for air draft only; they do not block the water.
      // Their piers do, and are the `pylon` role.
      return
    default:
      break
  }

  // Everything else stops a boat. An area of any of them — a breakwater, a
  // wreck charted as an area, a pylon's footprint, a platform, a dam, a hulk
  // — is land as far as the hull is concerned.
  const rings = ringsOf(f.geometry)
  if (rings.length > 0) {
    sink.land.push({ rings })
    return
  }

  // A charted sounding deeper than any boat here is still left in — the
  // router decides, not the fetcher — but it goes on the label so the leg
  // card can say what is there.
  const sounding = pickNumber(f.properties, SOUNDING_FIELDS)

  const paths = pathsOf(f.geometry)
  if (paths.length > 0) {
    const spec = LINE_HAZARDS[role]
    if (!spec) return
    sink.lines.push({
      kind: spec.kind,
      paths,
      widthM: spec.widthM,
      label: sounding !== null ? `${spec.label} ${sounding} m` : spec.label,
    })
    return
  }

  const spec = POINT_HAZARDS[role]
  if (!spec) return
  for (const p of pointsOf(f.geometry)) {
    sink.hazards.push({
      ...p,
      radiusM: spec.radiusM,
      kind: spec.kind,
      label: sounding !== null ? `${spec.label} ${sounding} m` : spec.label,
    })
  }
}

/**
 * Everything the router needs for one area, from one band.
 *
 * A dredged area is recorded twice, and that is the point rather than a
 * duplication: it carries a `DRVAL1` like any depth area — a dredged cut is
 * usually the most useful depth on the chart — and it is also water traffic is
 * meant to be in. Flattening it into a depth loses the second fact, which is
 * the one the coxswain is actually steering by. A fairway is the opposite: it
 * is marked water carrying no depth at all, so it becomes a channel and never
 * a depth area.
 *
 * Land, shoreline construction and every other fixed structure charted as an
 * area become land: a breakwater is not land, but it stops a boat exactly like
 * land does. The same structures charted as lines become `lines`, and small
 * things charted as points become `hazards` with a footprint of their own.
 */
export async function fetchChartFeatures(
  bounds: ChartBounds,
  options: { fetcher?: Fetcher; band?: EncBand } = {},
): Promise<ChartFeatures & { lines: LineHazard[] }> {
  const fetcher = options.fetcher ?? defaultFetcher
  const band = options.band ?? bandForSpan(boundsSpanNM(bounds))

  // These two used to return `coverage: 'none'`, which made "the chart service
  // is unreachable", "its layers are not named what we expect" and "this patch
  // of sea genuinely has no ENC coverage" indistinguishable — all three came
  // out as a straight line with no way to tell which. On the water that is the
  // difference between a bug and geography, so they throw now and say which.
  let layers: LayerRef[]
  let layersPayload: unknown = null
  try {
    const payload = await fetcher(layersUrl(band.service))
    layersPayload = payload
    // An error body at HTTP 200 would otherwise reach `matchLayers`, match
    // nothing, and be reported as "its layers are not named what we expect" —
    // blaming the naming for what is actually a service fault.
    const err = arcgisError(payload)
    if (err) throw new Error(err)
    layers = matchLayers(payload)
  } catch (e) {
    throw new ChartUnavailableError(
      'unreachable',
      band,
      e instanceof Error ? e.message : String(e),
    )
  }
  // The gate used to be `layers.length === 0` — "did we recognise anything?"
  // That is the wrong question, and it is what let this fail quietly for
  // weeks. `WRECKS` reads as "wrecks" and `BRIDGE` as "bridge", so those two
  // matched on their acronyms by accident while DEPARE, DRGARE, LNDARE,
  // FAIRWY, OBSTRN and PILPNT all missed. Enough layers matched to pass, not
  // one of them carried a depth, and the result was reported as empty sea.
  //
  // A service's layer catalogue is a property of the service, not of the
  // water, so "this catalogue publishes no depth layer we recognise" is always
  // a NavMate problem and never geography. Only a depth layer that answers
  // with no features is geography.
  const hasDepth = layers.some((l) => DEPTH_ROLES.includes(l.role))
  if (!hasDepth) {
    throw new ChartUnavailableError(
      'no-layers',
      band,
      describeCatalogue(layersPayload, layers),
    )
  }

  const results = await Promise.all(
    layers.map(async (layer) => ({
      layer,
      ...(await queryLayer(band.service, layer.id, bounds, fetcher)),
    })),
  )

  const sink: FeatureSink = { depthAreas: [], channels: [], land: [], hazards: [], lines: [] }
  let complete = true

  for (const { layer, features, complete: ok } of results) {
    if (!ok) complete = false
    for (const f of features) readFeature(layer.role, f, sink)
  }

  const { depthAreas, channels, land, hazards, lines } = sink
  if (depthAreas.length === 0) {
    // Zero depths because every depth query failed is NOT an empty sea, and
    // saying so sent a crew a straight line through a bank with "no charted
    // depths for this area" beside it — about the Houston Ship Channel. If
    // nothing that could carry a depth came back and the reason was a
    // failure, that is the failure being reported, not geography.
    const failure = results.find(
      (r) => r.failed && (r.layer.role === 'depth' || r.layer.role === 'dredged'),
    )
    if (failure) {
      throw new ChartUnavailableError('unreachable', band, failure.failed ?? undefined)
    }
    // Channels deliberately do not rescue coverage: marked water over water
    // nobody surveyed is not a route.
    return { depthAreas: [], channels, land, hazards, lines, coverage: 'none' }
  }
  return {
    depthAreas,
    channels,
    land,
    hazards,
    lines,
    coverage: complete ? 'full' : 'partial',
  }
}

/* -------------------------------------------------------------------------
 * Detail near the ends of a passage
 * ---------------------------------------------------------------------- */

/**
 * Half the side of the box the finest charts are fetched over around each end
 * of a passage, NM.
 *
 * A long passage's box is too big to ask the harbour band about — thousands
 * of polygons — so `bandsForSpan` leaves it out, and the coastal band that is
 * left marks almost every inch of Galveston's water as 0 m. Every long route
 * then failed at its first and last mile, which is exactly where the docks,
 * the cuts and the jetties are. So the harbour (and approach) band is fetched
 * again over a small box round each end: two miles either side is the whole
 * harbour approach at a scale the service answers quickly.
 */
export const DETAIL_HALF_NM = 2

/** The bands fetched over the small boxes round each end, finest first. */
export const DETAIL_BAND_IDS: readonly string[] = ['harbour', 'approach']

/** A square box `halfNM` either side of a position. */
export function detailBox(p: LatLon, halfNM = DETAIL_HALF_NM): ChartBounds {
  const dLat = halfNM / 60
  // Floored so a position at a pole does not ask for the whole world.
  const cos = Math.max(Math.cos((p.lat * Math.PI) / 180), 0.01)
  const dLon = halfNM / (60 * cos)
  return {
    minLat: p.lat - dLat,
    maxLat: p.lat + dLat,
    minLon: p.lon - dLon,
    maxLon: p.lon + dLon,
  }
}

/** The overlap of two boxes, or null when they do not overlap. */
export function intersectBounds(a: ChartBounds, b: ChartBounds): ChartBounds | null {
  const out = {
    minLat: Math.max(a.minLat, b.minLat),
    minLon: Math.max(a.minLon, b.minLon),
    maxLat: Math.min(a.maxLat, b.maxLat),
    maxLon: Math.min(a.maxLon, b.maxLon),
  }
  return out.minLat < out.maxLat && out.minLon < out.maxLon ? out : null
}

/** The smallest box holding both. */
export function unionBounds(a: ChartBounds, b: ChartBounds): ChartBounds {
  return {
    minLat: Math.min(a.minLat, b.minLat),
    minLon: Math.min(a.minLon, b.minLon),
    maxLat: Math.max(a.maxLat, b.maxLat),
    maxLon: Math.max(a.maxLon, b.maxLon),
  }
}

function boxArea(b: ChartBounds): number {
  return (b.maxLat - b.minLat) * (b.maxLon - b.minLon)
}

/**
 * Join boxes that overlap, where joining them costs no more area than asking
 * for both separately — two ends a mile apart become one query rather than
 * two that return the same polygons. Boxes along a diagonal are left apart:
 * their union would be mostly water nobody asked about, and a big enough
 * union would push the harbour band past the size it is fetched at.
 */
export function mergeOverlapping(boxes: ChartBounds[]): ChartBounds[] {
  const out = boxes.map((b) => ({ ...b }))
  for (let merged = true; merged; ) {
    merged = false
    search: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (!intersectBounds(out[i], out[j])) continue
        const u = unionBounds(out[i], out[j])
        if (boxArea(u) > boxArea(out[i]) + boxArea(out[j])) continue
        out[i] = u
        out.splice(j, 1)
        merged = true
        break search
      }
    }
  }
  return out
}

function isPosition(p: LatLon | null | undefined): p is LatLon {
  return (
    !!p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180
  )
}

/**
 * The detail box round each position, cut to the area being planned in.
 *
 * Cut because nothing outside the planning box is routed over; a position
 * outside the box altogether (a caller's mistake, not a real passage) keeps
 * its whole box rather than being silently ignored.
 */
export function detailBoxes(
  bounds: ChartBounds,
  points: readonly LatLon[] = [],
  halfNM = DETAIL_HALF_NM,
): ChartBounds[] {
  return points.filter(isPosition).map((p) => {
    const box = detailBox(p, halfNM)
    return intersectBounds(box, bounds) ?? box
  })
}

/** The detail bands a box needs beyond what the whole-area query already asks. */
function detailBandsFor(
  box: ChartBounds,
  bounds: ChartBounds,
  mainIds: ReadonlySet<string>,
): EncBand[] {
  // A box inside the main area already gets the main bands over it; one
  // poking outside does not, so it asks for every detail band itself.
  const inside = containsBounds(bounds, box)
  const span = boundsSpanNM(box)
  return ENC_BANDS.filter(
    (b) =>
      DETAIL_BAND_IDS.includes(b.id) &&
      !(inside && mainIds.has(b.id)) &&
      span <= (MAX_FETCH_SPAN_NM[b.id] ?? Infinity),
  )
}

/** One box and the bands asked about it. */
export interface ChartRegion {
  bounds: ChartBounds
  bands: EncBand[]
  /** False for the whole planning area, true for a box round one end. */
  detail: boolean
}

/**
 * Every query a chart load makes: the whole area in the bands its size calls
 * for, then each end of the passage in the detail bands the whole-area query
 * left out. A short hop already asks the harbour band about everything and
 * adds nothing here.
 */
export function planChartRegions(
  bounds: ChartBounds,
  options: { bands?: EncBand[]; detailAround?: readonly LatLon[] } = {},
): ChartRegion[] {
  const main = options.bands ?? bandsForSpan(boundsSpanNM(bounds))
  const mainIds = new Set(main.map((b) => b.id))
  const regions: ChartRegion[] = [{ bounds, bands: main, detail: false }]
  for (const box of mergeOverlapping(detailBoxes(bounds, options.detailAround))) {
    const bands = detailBandsFor(box, bounds, mainIds)
    if (bands.length > 0) regions.push({ bounds: box, bands, detail: true })
  }
  return regions
}

/**
 * A box and the bands that were actually read over it — or, as a need, the
 * bands a request wants read over it.
 *
 * "Read" means the band answered: with polygons, or with a genuinely empty sea
 * (Galveston has no approach-band chart at all, and asking again will not make
 * one). A band that failed is not listed, so the next request asks again.
 */
export interface LoadedRegion {
  bounds: ChartBounds
  bands: string[]
}

/**
 * What a request for `bounds` needs read before already-loaded data can stand
 * in for it: the bands its size calls for over the whole box, and the detail
 * bands round each end.
 *
 * `spanOf` is the box the band choice is made from, when that differs from
 * the box that must be covered — the store pads a box before fetching it, and
 * picks its bands from the padded size, so a need is judged the same way.
 */
export function chartNeeds(
  bounds: ChartBounds,
  options: { detailAround?: readonly LatLon[]; spanOf?: ChartBounds } = {},
): LoadedRegion[] {
  const main = bandsForSpan(boundsSpanNM(options.spanOf ?? bounds))
  const mainIds = new Set(main.map((b) => b.id))
  const needs: LoadedRegion[] = [{ bounds, bands: main.map((b) => b.id) }]
  // Not merged: each end is judged on its own box, which is never bigger than
  // the merged box it was fetched as part of.
  for (const box of detailBoxes(bounds, options.detailAround)) {
    const bands = detailBandsFor(box, bounds, mainIds).map((b) => b.id)
    if (bands.length > 0) needs.push({ bounds: box, bands })
  }
  return needs
}

/**
 * Does what has been read satisfy every need? Each band a need asks for must
 * have been read over a box that contains the need's box whole. A coastal-only
 * load of a big area never satisfies a short hop that needs the harbour band,
 * however well its box contains the hop.
 */
export function regionsSatisfy(
  have: readonly LoadedRegion[],
  needs: readonly LoadedRegion[],
): boolean {
  return needs.every((need) =>
    need.bands.every((id) =>
      have.some((h) => h.bands.includes(id) && containsBounds(h.bounds, need.bounds)),
    ),
  )
}

/* -------------------------------------------------------------------------
 * The whole area
 * ---------------------------------------------------------------------- */

/**
 * A filter that lets each feature through once.
 *
 * Overlapping queries of the same band — two detail boxes that both touch one
 * big depth area — return the same polygon twice. Keeping both is harmless to
 * the answer but doubles the router's work on the biggest features. The
 * signature is cheap; two features are only called the same after a full
 * comparison, because dropping a real, different polygon on a signature clash
 * would drop land.
 */
function onceEach<T>(signature: (t: T) => string): (t: T) => boolean {
  const seen = new Map<string, T[]>()
  return (t) => {
    const key = signature(t)
    const list = seen.get(key)
    if (!list) {
      seen.set(key, [t])
      return true
    }
    // Only a clash pays for the full comparison, and a clash is almost always
    // the same feature returned twice.
    const full = JSON.stringify(t)
    if (list.some((o) => JSON.stringify(o) === full)) return false
    list.push(t)
    return true
  }
}

function ringsSignature(rings: Ring[]): string {
  const first = rings[0] ?? []
  return `${rings.length}|${rings.map((r) => r.length).join(',')}|${first[0]}|${first[first.length >> 1]}`
}

/** Everything `fetchChartArea` returns: the merged features and how they were got. */
export interface ChartArea extends ChartFeatures {
  lines: LineHazard[]
  /** Bands that contributed anything, finest first. */
  bands: string[]
  /**
   * Bands that were asked for and could not be read, finest first — also set
   * on the features (`ChartFeatures.failedBands`) so the router can warn.
   */
  failedBands: string[]
  /** What was read, box by box: the whole area first, then each end. */
  regions: LoadedRegion[]
}

/**
 * Everything the router needs for one area, from every chart scale that has
 * something to say about it.
 *
 * Each band is fetched on its own terms by `fetchChartFeatures` (so every
 * failure rule above still holds per band), then merged with each polygon
 * tagged by how detailed its band is. `rasterise` uses that tag to let the
 * finest chart covering a cell win — see there for why that, and not
 * shoalest-wins, is the right rule across scales. Hazards and channels are a
 * plain union: a wreck on any chart is a wreck.
 *
 * `detailAround` adds the finest bands over a small box round each position
 * given — the start and destination of the passage — when the area is too big
 * to ask them about as a whole (see `DETAIL_HALF_NM`). They merge by the same
 * finest-wins levels, so near the ends the harbour chart speaks and between
 * them the coarser one does.
 *
 * A band that failed does not sink the others; one that answered with real
 * depths is real data about real water. But it is not passed off as the whole
 * story either: the coverage becomes `partial` and the band is named in
 * `failedBands`, so the plan can say it was made on coarser charts than it
 * should have been. Only when no band produced a depth is a failure thrown,
 * so "the chart could not be read" is still never passed off as empty sea.
 */
export async function fetchChartArea(
  bounds: ChartBounds,
  options: { fetcher?: Fetcher; bands?: EncBand[]; detailAround?: readonly LatLon[] } = {},
): Promise<ChartArea> {
  const plan = planChartRegions(bounds, options)
  const jobs = plan.flatMap((region) => region.bands.map((band) => ({ region, band })))
  const settled = await Promise.all(
    jobs.map(async ({ region, band }) => {
      try {
        const features = await fetchChartFeatures(region.bounds, {
          fetcher: options.fetcher,
          band,
        })
        return { region, band, features, error: null as unknown }
      } catch (e) {
        return { region, band, features: null, error: e }
      }
    }),
  )

  const depthAreas: DepthPolygon[] = []
  const channels: ChannelPolygon[] = []
  const land: LandPolygon[] = []
  const hazards: PointHazard[] = []
  const lines: LineHazard[] = []
  const used = new Set<string>()
  const failed = new Set<string>()
  let partial = false

  const newDepth = onceEach<DepthPolygon>(
    (p) => `${p.level}|${p.minDepthM}|${ringsSignature(p.rings)}`,
  )
  const newLand = onceEach<LandPolygon>((p) => `${p.level}|${ringsSignature(p.rings)}`)
  const newChannel = onceEach<ChannelPolygon>((c) => `${c.kind}|${ringsSignature(c.rings)}`)
  const newHazard = onceEach<PointHazard>((h) => `${h.kind}|${h.lat}|${h.lon}`)
  const newLine = onceEach<LineHazard>(
    (l) => `${l.level}|${l.kind}|${l.paths.length}|${l.paths[0]?.[0]}`,
  )

  for (const { band, features: f, error } of settled) {
    if (error != null) {
      failed.add(band.id)
      continue
    }
    if (!f || f.coverage === 'none') continue
    // Finer bands sit earlier in ENC_BANDS, so they get the higher level.
    const level = ENC_BANDS.length - ENC_BANDS.indexOf(band)
    for (const p of f.depthAreas) {
      const tagged = { ...p, level }
      if (newDepth(tagged)) depthAreas.push(tagged)
    }
    for (const p of f.land) {
      const tagged = { ...p, level }
      if (newLand(tagged)) land.push(tagged)
    }
    for (const l of f.lines ?? []) {
      const tagged = { ...l, level }
      if (newLine(tagged)) lines.push(tagged)
    }
    for (const c of f.channels) if (newChannel(c)) channels.push(c)
    for (const h of f.hazards) if (newHazard(h)) hazards.push(h)
    if (f.coverage === 'partial') partial = true
    used.add(band.id)
  }

  const inOrder = (ids: Set<string>) =>
    ENC_BANDS.map((b) => b.id).filter((id) => ids.has(id))
  const regions: LoadedRegion[] = plan.map((region) => ({
    bounds: region.bounds,
    bands: settled
      .filter((s) => s.region === region && s.error == null)
      .map((s) => s.band.id),
  }))
  const failedBands = inOrder(failed)

  if (depthAreas.length === 0) {
    // Prefer an `unreachable` over a `no-layers`: a service that did not
    // answer is the likelier story, and the one a crew can do something about.
    const errors = settled.map((r) => r.error).filter((e) => e != null)
    const pick =
      errors.find((e) => e instanceof ChartUnavailableError && e.kind === 'unreachable') ??
      errors[0]
    if (pick) throw pick
    return {
      depthAreas: [],
      channels,
      land,
      hazards,
      lines,
      coverage: 'none',
      bands: [],
      failedBands,
      regions,
    }
  }

  return {
    depthAreas,
    channels,
    land,
    hazards,
    lines,
    // A band that could not be read is a hole in what was checked, exactly
    // like a query that overflowed its transfer limit — the same word, and
    // the same warning.
    coverage: partial || failedBands.length > 0 ? 'partial' : 'full',
    failedBands,
    bands: inOrder(used),
    regions,
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
