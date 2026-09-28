import { describe, it, expect } from 'vitest'
import { MERCATOR_HALF, NOAA_CHART, SEAMARKS, tileBbox3857, lonToTileX, latToTileY } from './tiles'
import { haversineNM } from './geo'
import {
  bandForSpan,
  bandsForSpan,
  boundsSpanNM,
  chartNeeds,
  containsBounds,
  corridorPoints,
  DETAIL_HALF_NM,
  MAX_CORRIDOR_BOXES,
  detailBox,
  encRequestUrl,
  intersectBounds,
  ISLET_RADIUS_M,
  LIGHT_STRUCTURE_WIDTH_M,
  mergeOverlapping,
  pathsOf,
  planChartRegions,
  PLATFORM_RADIUS_M,
  PYLON_RADIUS_M,
  regionsSatisfy,
  STRUCTURE_WIDTH_M,
  unionBounds,
  padBounds,
  ENC_BANDS,
  exceededLimit,
  featuresOf,
  fetchChartArea,
  fetchChartFeatures,
  HAZARD_RADIUS_M,
  layersUrl,
  matchLayers,
  MAX_SPLIT_DEPTH,
  minBridgeClearance,
  pointOf,
  quadrants,
  queryLayer,
  queryUrl,
  ringsOf,
  type ChartBounds,
  type Fetcher,
} from './chart'
import { EMPTY_FEATURES } from './routing'

/* -------------------------------------------------------------------------
 * Web Mercator tile bounds — the WMS depends entirely on getting these right
 * ---------------------------------------------------------------------- */

describe('tileBbox3857', () => {
  it('gives the whole world at zoom 0', () => {
    const [minX, minY, maxX, maxY] = tileBbox3857(0, 0, 0)
    expect(minX).toBeCloseTo(-MERCATOR_HALF, 6)
    expect(minY).toBeCloseTo(-MERCATOR_HALF, 6)
    expect(maxX).toBeCloseTo(MERCATOR_HALF, 6)
    expect(maxY).toBeCloseTo(MERCATOR_HALF, 6)
  })

  it('puts tile (1,0) of zoom 1 in the north-east quadrant', () => {
    const [minX, minY, maxX, maxY] = tileBbox3857(1, 1, 0)
    expect(minX).toBeCloseTo(0, 6)
    expect(minY).toBeCloseTo(0, 6)
    expect(maxX).toBeCloseTo(MERCATOR_HALF, 6)
    expect(maxY).toBeCloseTo(MERCATOR_HALF, 6)
  })

  it('puts tile (0,1) of zoom 1 in the south-west quadrant — row counts south', () => {
    const [minX, minY, maxX, maxY] = tileBbox3857(1, 0, 1)
    expect(minX).toBeCloseTo(-MERCATOR_HALF, 6)
    expect(minY).toBeCloseTo(-MERCATOR_HALF, 6)
    expect(maxX).toBeCloseTo(0, 6)
    expect(maxY).toBeCloseTo(0, 6)
  })

  it('contains the Mercator projection of the position its tile covers', () => {
    // Galveston entrance, and the Mercator maths done independently of tiles.ts.
    const lat = 29.3
    const lon = -94.8
    const z = 12
    const x = Math.floor(lonToTileX(lon, z))
    const y = Math.floor(latToTileY(lat, z))
    const mx = (lon / 180) * MERCATOR_HALF
    const my =
      (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180) / 180) *
      MERCATOR_HALF

    const [minX, minY, maxX, maxY] = tileBbox3857(z, x, y)
    expect(mx).toBeGreaterThanOrEqual(minX)
    expect(mx).toBeLessThanOrEqual(maxX)
    expect(my).toBeGreaterThanOrEqual(minY)
    expect(my).toBeLessThanOrEqual(maxY)
  })

  it('tiles the world without gaps or overlaps at zoom 1', () => {
    const span = tileBbox3857(1, 0, 0)[2] - tileBbox3857(1, 0, 0)[0]
    expect(span).toBeCloseTo(MERCATOR_HALF, 6)
    expect(tileBbox3857(1, 0, 0)[2]).toBeCloseTo(tileBbox3857(1, 1, 0)[0], 6)
  })
})

describe('chart tile sources', () => {
  it('asks NOAA for a 256 px GetMap in EPSG:3857 over the tile it wants', () => {
    const url = NOAA_CHART.url(12, 955, 1716)
    expect(url).toContain('request=GetMap')
    expect(url).toContain('crs=EPSG:3857')
    expect(url).toContain('width=256&height=256')
    expect(url).toContain(`bbox=${tileBbox3857(12, 955, 1716).join(',')}`)
    expect(url).toContain('transparent=true')
  })

  it('says on the map itself that the chart is not for navigation', () => {
    expect(NOAA_CHART.attribution).toMatch(/not for navigation/i)
  })

  it('uses column-before-row for OpenSeaMap, which is a plain XYZ scheme', () => {
    expect(SEAMARKS.url(14, 3821, 6864)).toBe(
      'https://tiles.openseamap.org/seamark/14/3821/6864.png',
    )
    expect(SEAMARKS.overlay).toBe(true)
  })
})

/* -------------------------------------------------------------------------
 * Usage bands
 * ---------------------------------------------------------------------- */

describe('bandForSpan', () => {
  it('uses the harbour chart for a passage across a harbour', () => {
    expect(bandForSpan(2).id).toBe('harbour')
  })

  it('steps out to approach and coastal as the passage grows', () => {
    expect(bandForSpan(10).id).toBe('approach')
    expect(bandForSpan(40).id).toBe('coastal')
  })

  it('always returns a band, however long the passage', () => {
    expect(bandForSpan(100000).id).toBe('overview')
  })

  it('is ordered finest first, so the first match is the most detailed', () => {
    const spans = ENC_BANDS.map((b) => b.maxSpanNM)
    expect([...spans].sort((a, b) => a - b)).toEqual(spans)
  })
})

describe('bandsForSpan', () => {
  it('asks the harbour band about a short hop, even though its padded box is past 4 NM', () => {
    // A 1 NM hop's padded box is ~5 NM across, so `bandForSpan` alone picked
    // approach and never harbour — and Galveston has no approach chart at all.
    expect(bandsForSpan(5).map((b) => b.id)).toEqual(['harbour', 'approach', 'coastal'])
  })

  it('backs the span band with one coarser band and every finer one', () => {
    expect(bandsForSpan(40).map((b) => b.id)).toEqual(['approach', 'coastal', 'general'])
  })

  it('never asks the harbour band about an ocean passage', () => {
    expect(bandsForSpan(500).map((b) => b.id)).toEqual(['general', 'overview'])
  })
})

describe('boundsSpanNM', () => {
  it('measures the diagonal of the box', () => {
    expect(boundsSpanNM({ minLat: 29, minLon: -95, maxLat: 30, maxLon: -95 })).toBeCloseTo(60, 0)
  })
})

/* -------------------------------------------------------------------------
 * Layer discovery
 * ---------------------------------------------------------------------- */

const LAYER_PAYLOAD = {
  layers: [
    { id: 7, name: 'Harbor.Buoy_Safe_Water_point', geometryType: 'esriGeometryPoint' },
    { id: 40, name: 'Harbor.Depth_Area_area', geometryType: 'esriGeometryPolygon' },
    { id: 41, name: 'Harbor.Depth_Contour_line', geometryType: 'esriGeometryPolyline' },
    { id: 52, name: 'Harbor.Dredged_Area_area', geometryType: 'esriGeometryPolygon' },
    { id: 55, name: 'Harbor.Fairway_area', geometryType: 'esriGeometryPolygon' },
    { id: 56, name: 'Harbor.Fairway_line', geometryType: 'esriGeometryPolyline' },
    { id: 60, name: 'Harbor.Land_Area_area', geometryType: 'esriGeometryPolygon' },
    { id: 85, name: 'Harbor.Shoreline_Construction_line', geometryType: 'esriGeometryPolyline' },
    { id: 86, name: 'Harbor.Shoreline_Construction_area', geometryType: 'esriGeometryPolygon' },
    { id: 90, name: 'Harbor.Wrecks_point', geometryType: 'esriGeometryPoint' },
    { id: 91, name: 'Harbor.Obstructions_point', geometryType: 'esriGeometryPoint' },
    { id: 92, name: 'Harbor.Underwater_Rock_point', geometryType: 'esriGeometryPoint' },
    { id: 93, name: 'Harbor_Piles_point', geometryType: 'esriGeometryPoint' },
    { id: 99, name: 'Harbor.Bridge_area', geometryType: 'esriGeometryPolygon' },
    { id: 179, name: 'Harbor.Harbour_Facility_area', geometryType: 'esriGeometryPolygon' },
  ],
}

describe('matchLayers', () => {
  it('finds the depth areas by name rather than by a hardcoded id', () => {
    const found = matchLayers(LAYER_PAYLOAD)
    const depth = found.find((l) => l.role === 'depth')
    expect(depth?.id).toBe(40)
  })

  it('picks up dredged channels, land, wrecks, obstructions and rocks', () => {
    const roles = matchLayers(LAYER_PAYLOAD).map((l) => l.role)
    expect(roles).toContain('dredged')
    expect(roles).toContain('land')
    expect(roles).toContain('wreck')
    expect(roles).toContain('obstruction')
    expect(roles).toContain('rock')
  })

  it("matches NOAA's real rock layer name, with 'Awash' in the middle", () => {
    const found = matchLayers({
      layers: [
        { id: 34, name: 'Harbor.Underwater_Awash_Rock_point', geometryType: 'esriGeometryPoint' },
      ],
    })
    expect(found.map((l) => l.role)).toEqual(['rock'])
  })

  it('reads a line only where the line IS the hazard', () => {
    // Changed on purpose. This used to refuse every line layer, which threw
    // away every jetty, breakwater and pier charted as a centreline — the
    // Galveston jetties among them. A depth contour or a fairway line is
    // still refused: each is the edge of an area published separately.
    const found = matchLayers(LAYER_PAYLOAD)
    const lines = found.filter((l) => l.geometry === 'line')
    expect(lines.map((l) => l.id)).toEqual([85])
    expect(lines[0].role).toBe('shoreline')
    expect(found.some((l) => l.id === 41)).toBe(false) // Depth_Contour_line
    expect(found.some((l) => l.id === 56)).toBe(false) // Fairway_line
    expect(found.some((l) => l.id === 86)).toBe(true)
  })

  it('does not mistake a harbour facility for a depth area', () => {
    expect(matchLayers(LAYER_PAYLOAD).some((l) => l.id === 179)).toBe(false)
  })

  it('returns nothing rather than throwing on a payload it does not recognise', () => {
    expect(matchLayers(null)).toEqual([])
    expect(matchLayers({ error: { code: 500 } })).toEqual([])
  })
})

/* -------------------------------------------------------------------------
 * Geometry parsing — GeoJSON and Esri JSON
 * ---------------------------------------------------------------------- */

describe('ringsOf', () => {
  const ring = [
    [-94.8, 29.3],
    [-94.7, 29.3],
    [-94.7, 29.4],
    [-94.8, 29.3],
  ]

  it('reads a GeoJSON Polygon', () => {
    expect(ringsOf({ type: 'Polygon', coordinates: [ring] })).toHaveLength(1)
  })

  it('reads every ring of a GeoJSON MultiPolygon', () => {
    expect(ringsOf({ type: 'MultiPolygon', coordinates: [[ring], [ring, ring]] })).toHaveLength(3)
  })

  it('reads Esri JSON rings, so the app survives a service without f=geojson', () => {
    expect(ringsOf({ rings: [ring, ring] })).toHaveLength(2)
  })

  it('returns nothing for a point or for rubbish', () => {
    expect(ringsOf({ type: 'Point', coordinates: [-94.8, 29.3] })).toEqual([])
    expect(ringsOf(null)).toEqual([])
  })
})

describe('pointOf', () => {
  it('reads GeoJSON lon-lat order', () => {
    expect(pointOf({ type: 'Point', coordinates: [-94.8, 29.3] })).toEqual({
      lat: 29.3,
      lon: -94.8,
    })
  })

  it('reads Esri x/y', () => {
    expect(pointOf({ x: -94.8, y: 29.3 })).toEqual({ lat: 29.3, lon: -94.8 })
  })
})

describe('featuresOf', () => {
  it('takes GeoJSON properties', () => {
    const f = featuresOf({ features: [{ geometry: {}, properties: { DRVAL1: 3 } }] })
    expect(f[0].properties?.DRVAL1).toBe(3)
  })

  it('takes Esri attributes under the same name', () => {
    const f = featuresOf({ features: [{ geometry: {}, attributes: { DRVAL1: 3 } }] })
    expect(f[0].properties?.DRVAL1).toBe(3)
  })
})

describe('exceededLimit', () => {
  it('is only true when the server actually says so', () => {
    expect(exceededLimit({ exceededTransferLimit: true })).toBe(true)
    expect(exceededLimit({ exceededTransferLimit: false })).toBe(false)
    expect(exceededLimit({})).toBe(false)
  })
})

/* -------------------------------------------------------------------------
 * Querying
 * ---------------------------------------------------------------------- */

const BOX: ChartBounds = { minLat: 29.3, minLon: -94.85, maxLat: 29.35, maxLon: -94.8 }

describe('queryUrl', () => {
  it('asks for the envelope in WGS-84 with geometry, as GeoJSON', () => {
    const url = queryUrl('https://example.test/MapServer', 40, BOX)
    expect(url).toContain('/40/query?')
    expect(url).toContain('f=geojson')
    expect(url).toContain('geometryType=esriGeometryEnvelope')
    expect(url).toContain('inSR=4326')
    expect(url).toContain('outSR=4326')
    expect(url).toContain('returnGeometry=true')
    expect(decodeURIComponent(url)).toContain('geometry=-94.85,29.3,-94.8,29.35')
  })
})

describe('layersUrl', () => {
  it('asks for the whole catalogue in one request', () => {
    expect(layersUrl('https://example.test/MapServer')).toBe(
      'https://example.test/MapServer/layers?f=json',
    )
  })
})

describe('quadrants', () => {
  it('tiles the parent box exactly, with no gap down the middle', () => {
    const q = quadrants(BOX)
    expect(q).toHaveLength(4)
    const area = (b: ChartBounds) => (b.maxLat - b.minLat) * (b.maxLon - b.minLon)
    expect(q.reduce((a, b) => a + area(b), 0)).toBeCloseTo(area(BOX), 12)
    expect(Math.min(...q.map((b) => b.minLat))).toBeCloseTo(BOX.minLat, 12)
    expect(Math.max(...q.map((b) => b.maxLon))).toBeCloseTo(BOX.maxLon, 12)
  })
})

describe('queryLayer', () => {
  it('takes a complete answer as it comes', async () => {
    const fetcher: Fetcher = async () => ({
      features: [{ geometry: {}, properties: { DRVAL1: 5 } }],
    })
    const r = await queryLayer('https://example.test/MapServer', 40, BOX, fetcher)
    expect(r.complete).toBe(true)
    expect(r.features).toHaveLength(1)
  })

  it('splits the box when the server caps the response', async () => {
    let calls = 0
    const fetcher: Fetcher = async () => {
      calls++
      // Only the first (whole-box) call overflows.
      if (calls === 1) {
        return { exceededTransferLimit: true, features: [{ geometry: {}, properties: {} }] }
      }
      return { features: [{ geometry: {}, properties: {} }] }
    }
    const r = await queryLayer('https://example.test/MapServer', 40, BOX, fetcher)
    expect(calls).toBe(5)
    expect(r.complete).toBe(true)
    expect(r.features).toHaveLength(4)
  })

  it('reports the area incomplete rather than pretending, once splitting runs out', async () => {
    const fetcher: Fetcher = async () => ({
      exceededTransferLimit: true,
      features: [{ geometry: {}, properties: {} }],
    })
    const r = await queryLayer('https://example.test/MapServer', 40, BOX, fetcher)
    expect(r.complete).toBe(false)
    // One whole-box call plus 4 + 16 quadrant calls at the split limit.
    expect(MAX_SPLIT_DEPTH).toBe(2)
    expect(r.features.length).toBe(16)
  })

  it('asks a failed piece once more before giving it up (2026-09-28)', async () => {
    // A piece of the harbour chart that failed once on a marginal link and
    // was given up on left a hole the planner routed 8 NM round.
    let calls = 0
    const fetcher: Fetcher = async () => {
      calls++
      // Both formats of the first try fail; the retry answers.
      if (calls <= 2) throw new Error('Chart service returned 502')
      return { features: [{ geometry: {}, properties: { DRVAL1: 3 } }] }
    }
    const r = await queryLayer('https://example.test/MapServer', 40, BOX, fetcher)
    expect(r.complete).toBe(true)
    expect(r.features).toHaveLength(1)
    expect(calls).toBe(3)
  })

  it('treats a dead service as incomplete, never as empty water', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('403')
    }
    const r = await queryLayer('https://example.test/MapServer', 40, BOX, fetcher)
    expect(r.complete).toBe(false)
    expect(r.features).toEqual([])
  })
})

/* -------------------------------------------------------------------------
 * The whole fetch
 * ---------------------------------------------------------------------- */

function stubService(): Fetcher {
  const ring = [
    [-94.85, 29.3],
    [-94.8, 29.3],
    [-94.8, 29.35],
    [-94.85, 29.35],
    [-94.85, 29.3],
  ]
  return async (url: string) => {
    if (url.includes('/layers?f=json')) return LAYER_PAYLOAD
    if (url.includes('/40/query')) {
      return {
        features: [
          { geometry: { type: 'Polygon', coordinates: [ring] }, properties: { DRVAL1: 4.2 } },
        ],
      }
    }
    if (url.includes('/52/query')) {
      return {
        features: [
          { geometry: { type: 'Polygon', coordinates: [ring] }, properties: { DRVAL1: 6.5 } },
        ],
      }
    }
    if (url.includes('/55/query')) {
      // A fairway as ENC actually publishes one: no DRVAL1 anywhere on it.
      return {
        features: [
          { geometry: { type: 'Polygon', coordinates: [ring] }, properties: { ORIENT: 31 } },
        ],
      }
    }
    if (url.includes('/93/query')) {
      return {
        features: [
          { geometry: { type: 'Point', coordinates: [-94.83, 29.31] }, properties: {} },
        ],
      }
    }
    if (url.includes('/60/query')) {
      return {
        features: [{ geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} }],
      }
    }
    if (url.includes('/90/query')) {
      return {
        features: [
          {
            geometry: { type: 'Point', coordinates: [-94.82, 29.32] },
            properties: { VALSOU: 2.1 },
          },
        ],
      }
    }
    return { features: [] }
  }
}

describe('fetchChartFeatures', () => {
  it('turns the services into the shapes the router rasterises', async () => {
    const f = await fetchChartFeatures(BOX, { fetcher: stubService() })
    expect(f.coverage).toBe('full')
    // Two depth areas: the plain one, and the dredged area, which carries a
    // DRVAL1 of its own as well as being a channel.
    expect(f.depthAreas).toHaveLength(2)
    expect(f.depthAreas.map((d) => d.minDepthM).sort()).toEqual([4.2, 6.5])
    expect(f.land).toHaveLength(1)
    const wreck = f.hazards.find((h) => h.kind === 'wreck')
    expect(wreck?.radiusM).toBe(HAZARD_RADIUS_M)
    expect(wreck).toMatchObject({ lat: 29.32, lon: -94.82 })
  })

  it('says the service is unreachable rather than calling it empty sea', async () => {
    // These are different facts and the crew acts on them differently: one is
    // "this app cannot see the chart", the other is "there is no chart here".
    // Reporting the first as the second is how a straight line through land
    // goes unexplained.
    await expect(
      fetchChartFeatures(BOX, {
        fetcher: async () => {
          throw new Error('Failed to fetch')
        },
      }),
    ).rejects.toMatchObject({
      name: 'ChartUnavailableError',
      kind: 'unreachable',
      service: expect.stringContaining('encdirect.noaa.gov'),
    })
  })

  it('says so when the service answers but nothing is named as expected', async () => {
    // NOAA republishes weekly and renames; if the patterns stop matching, that
    // is this app's problem to fix and it must not look like a coverage gap.
    await expect(
      fetchChartFeatures(BOX, {
        fetcher: async () => ({
          layers: [
            { id: 1, name: 'Harbor.Something_Else_area', geometryType: 'esriGeometryPolygon' },
          ],
        }),
      }),
    ).rejects.toMatchObject({
      name: 'ChartUnavailableError',
      kind: 'no-layers',
    })
  })

  it('reports no coverage when the area has no charted depths — outside US waters', async () => {
    const f = await fetchChartFeatures(BOX, {
      fetcher: async (url) => (url.includes('/layers?f=json') ? LAYER_PAYLOAD : { features: [] }),
    })
    expect(f.coverage).toBe('none')
  })

  it('finds the depth layer when the service names it DEPARE', async () => {
    // ENC is published from S-57, whose object classes are six-letter codes.
    // A service exposing those rather than readable names was matching
    // WRECKS and BRIDGE by accident — they read as English words — while
    // DEPARE, DRGARE, LNDARE, FAIRWY, OBSTRN and PILPNT all missed. Enough
    // matched to clear the old "did we recognise anything" gate, so a bay
    // charted in detail came back as "no charted depths for this area".
    const layers = matchLayers({
      layers: [
        { id: 1, name: 'DEPARE', geometryType: 'esriGeometryPolygon' },
        { id: 2, name: 'DRGARE', geometryType: 'esriGeometryPolygon' },
        { id: 3, name: 'LNDARE', geometryType: 'esriGeometryPolygon' },
        { id: 4, name: 'FAIRWY', geometryType: 'esriGeometryPolygon' },
        { id: 5, name: 'SLCONS', geometryType: 'esriGeometryPolygon' },
        { id: 6, name: 'WRECKS', geometryType: 'esriGeometryPoint' },
        { id: 7, name: 'OBSTRN', geometryType: 'esriGeometryPoint' },
        { id: 8, name: 'UWTROC', geometryType: 'esriGeometryPoint' },
        { id: 9, name: 'PILPNT', geometryType: 'esriGeometryPoint' },
      ],
    })
    expect(layers.map((l) => l.role)).toEqual([
      'depth', 'dredged', 'land', 'fairway', 'shoreline',
      'wreck', 'obstruction', 'rock', 'pile',
    ])
  })

  it('still finds the readable names, and the two spellings together', async () => {
    // A service may expose either form, or both in one string. Neither may
    // regress in favour of the other.
    const layers = matchLayers({
      layers: [
        { id: 1, name: 'Harbor.Depth_Area', geometryType: 'esriGeometryPolygon' },
        { id: 2, name: 'Dredged Area (DRGARE)', geometryType: 'esriGeometryPolygon' },
        { id: 3, name: 'Harbor_Piles_point', geometryType: 'esriGeometryPoint' },
      ],
    })
    expect(layers.map((l) => l.role)).toEqual(['depth', 'dredged', 'pile'])
  })

  it('does not match an acronym buried inside a longer word', async () => {
    expect(
      matchLayers({
        layers: [
          { id: 1, name: 'PREDEPAREA_zone', geometryType: 'esriGeometryPolygon' },
        ],
      }),
    ).toEqual([])
  })

  it('blames itself, not the sea, when the catalogue has no depth layer', async () => {
    // A layer catalogue is a property of the service, not of the water, so a
    // catalogue with no recognisable depth layer is always this app's problem.
    // The old gate passed as soon as ANY layer matched, so a wrecks layer was
    // enough to let it report empty sea instead.
    await expect(
      fetchChartFeatures(BOX, {
        fetcher: async () => ({
          layers: [
            { id: 6, name: 'WRECKS', geometryType: 'esriGeometryPoint' },
            { id: 9, name: 'Some_Other_Thing', geometryType: 'esriGeometryPolygon' },
          ],
        }),
      }),
    ).rejects.toMatchObject({
      name: 'ChartUnavailableError',
      kind: 'no-layers',
      // The names the service actually published, so one photograph of the
      // screen settles what it is called.
      message: expect.stringContaining('WRECKS'),
    })
  })

  it('still calls genuinely empty water empty, when a depth layer answered', async () => {
    // The one case that IS geography: the depth layer exists and returns
    // nothing. This must not be swept up by the stricter gate above.
    const f = await fetchChartFeatures(BOX, {
      fetcher: async (url) => (url.includes('/layers?f=json') ? LAYER_PAYLOAD : { features: [] }),
    })
    expect(f.coverage).toBe('none')
  })

  it('does not call a failed depth query an empty sea', async () => {
    // The bug this pins: a query that failed returned zero features, which
    // became `coverage: 'none'`, which the screen reported as "no charted
    // depths for this area" — about the middle of the Houston Ship Channel,
    // 500 ft wide and 50 ft deep, with the chart drawn underneath it.
    await expect(
      fetchChartFeatures(BOX, {
        fetcher: async (url) => {
          if (url.includes('/layers?f=json')) return LAYER_PAYLOAD
          throw new Error('Chart service returned 500')
        },
      }),
    ).rejects.toMatchObject({
      name: 'ChartUnavailableError',
      kind: 'unreachable',
      message: expect.stringContaining('500'),
    })
  })

  it('treats an ArcGIS error body at HTTP 200 as a failure, not as no data', async () => {
    // ArcGIS answers an unsupported request with a 200 carrying an error
    // object. `featuresOf` finds no `features` array and returns [], so the
    // whole thing used to pass for "nothing charted here".
    await expect(
      fetchChartFeatures(BOX, {
        fetcher: async (url) =>
          url.includes('/layers?f=json')
            ? LAYER_PAYLOAD
            : { error: { code: 400, message: 'Unable to complete operation.' } },
      }),
    ).rejects.toMatchObject({
      name: 'ChartUnavailableError',
      kind: 'unreachable',
      message: expect.stringContaining('Unable to complete operation'),
    })
  })

  it('falls back to Esri JSON when the server will not serve GeoJSON', async () => {
    // f=geojson is only supported on MapServer from ArcGIS 10.4. Where it is
    // not, this is the difference between a working plotter and a straight
    // line — and the failure is silent, so nothing would have said why.
    const asked: string[] = []
    const f = await fetchChartFeatures(BOX, {
      fetcher: async (url) => {
        asked.push(url)
        if (url.includes('/layers?f=json')) return LAYER_PAYLOAD
        if (url.includes('f=geojson')) {
          return { error: { code: 400, message: 'Invalid format.' } }
        }
        if (url.includes('/40/query')) {
          // Esri's own form: `rings` and `attributes`, not `coordinates` and
          // `properties`.
          return {
            features: [
              {
                geometry: {
                  rings: [
                    [
                      [-94.85, 29.3],
                      [-94.8, 29.3],
                      [-94.8, 29.35],
                      [-94.85, 29.35],
                      [-94.85, 29.3],
                    ],
                  ],
                },
                attributes: { DRVAL1: 9.1 },
              },
            ],
          }
        }
        return { features: [] }
      },
    })
    expect(f.depthAreas).toHaveLength(1)
    expect(f.depthAreas[0].minDepthM).toBe(9.1)
    expect(asked.some((u) => u.includes('f=geojson'))).toBe(true)
    expect(asked.some((u) => u.includes('f=json') && u.includes('/query'))).toBe(true)
  })

  it('marks the area partial when any layer overflowed', async () => {
    const base = stubService()
    const f = await fetchChartFeatures(BOX, {
      fetcher: async (url) =>
        url.includes('/91/query')
          ? { exceededTransferLimit: true, features: [] }
          : base(url),
    })
    expect(f.coverage).toBe('partial')
  })
})

describe('fetchChartArea', () => {
  const ring = [
    [-94.85, 29.3],
    [-94.8, 29.3],
    [-94.8, 29.35],
    [-94.85, 29.35],
    [-94.85, 29.3],
  ]
  const depth = (d: number) => ({
    features: [{ geometry: { type: 'Polygon', coordinates: [ring] }, properties: { DRVAL1: d } }],
  })

  it('finds the harbour chart when the approach band has nothing there', async () => {
    // Galveston, measured through the live relay: 501 harbour-band depth
    // areas, zero approach-band features of any kind. One band per span
    // meant an empty sea and a straight line over Pelican Island.
    const f = await fetchChartArea(BOX, {
      bands: [ENC_BANDS[0], ENC_BANDS[1]],
      fetcher: async (url) => {
        if (url.includes('/layers?f=json')) return LAYER_PAYLOAD
        if (url.includes('enc_harbour') && url.includes('/40/query')) return depth(9.1)
        return { features: [] }
      },
    })
    expect(f.coverage).toBe('full')
    expect(f.bands).toEqual(['harbour'])
    expect(f.depthAreas).toHaveLength(1)
    expect(f.depthAreas[0].minDepthM).toBe(9.1)
  })

  it('tags each band so the finer chart outranks the coarser one', async () => {
    const f = await fetchChartArea(BOX, {
      bands: [ENC_BANDS[0], ENC_BANDS[2]],
      fetcher: async (url) => {
        if (url.includes('/layers?f=json')) return LAYER_PAYLOAD
        if (url.includes('/40/query')) return depth(url.includes('enc_harbour') ? 9.1 : 0.5)
        return { features: [] }
      },
    })
    const harbour = f.depthAreas.find((d) => d.minDepthM === 9.1)
    const coastal = f.depthAreas.find((d) => d.minDepthM === 0.5)
    expect(harbour?.level).toBeGreaterThan(coastal?.level ?? Infinity)
    expect(f.bands).toEqual(['harbour', 'coastal'])
  })

  it('uses the bands that answered when another one failed — and says one failed', async () => {
    // Changed on purpose: this used to read 'full'. The approach band's
    // depths are real data and are still used, but the harbour chart that
    // should have spoken for this water was never seen, so the area was
    // checked on coarser charts than it should have been. That is a hole in
    // what was checked, like a transfer-limit overflow, and gets the same
    // word — plus the band's name, so the route can say which.
    const f = await fetchChartArea(BOX, {
      bands: [ENC_BANDS[0], ENC_BANDS[1]],
      fetcher: async (url) => {
        if (url.includes('enc_harbour')) throw new Error('Chart service returned 502')
        if (url.includes('/layers?f=json')) return LAYER_PAYLOAD
        if (url.includes('/40/query')) return depth(6)
        return { features: [] }
      },
    })
    expect(f.bands).toEqual(['approach'])
    expect(f.coverage).toBe('partial')
    expect(f.failedBands).toEqual(['harbour'])
  })

  it('still reports a failure, not an empty sea, when nothing produced a depth', async () => {
    await expect(
      fetchChartArea(BOX, {
        bands: [ENC_BANDS[0], ENC_BANDS[1]],
        fetcher: async (url) => {
          if (url.includes('enc_harbour')) throw new Error('Failed to fetch')
          if (url.includes('/layers?f=json')) return LAYER_PAYLOAD
          return { features: [] }
        },
      }),
    ).rejects.toMatchObject({ name: 'ChartUnavailableError', kind: 'unreachable' })
  })

  it('calls genuinely uncharted water empty when every band answered', async () => {
    const f = await fetchChartArea(BOX, {
      bands: [ENC_BANDS[0], ENC_BANDS[1]],
      fetcher: async (url) => (url.includes('/layers?f=json') ? LAYER_PAYLOAD : { features: [] }),
    })
    expect(f.coverage).toBe('none')
  })
})

describe('minBridgeClearance', () => {
  it('takes the lowest span, because that is the one the mast meets', () => {
    expect(
      minBridgeClearance([
        { geometry: {}, properties: { VERCLR: 22 } },
        { geometry: {}, properties: { VERCLR: 4.6 } },
      ]),
    ).toBeCloseTo(4.6, 6)
  })

  it('is null when no clearance is charted', () => {
    expect(minBridgeClearance([{ geometry: {}, properties: {} }])).toBeNull()
  })
})

/* -------------------------------------------------------------------------
 * Bounds helpers
 * ---------------------------------------------------------------------- */

describe('containsBounds', () => {
  it('is true when the outer box swallows the inner one', () => {
    expect(containsBounds(padBounds(BOX), BOX)).toBe(true)
  })

  it('is false when the inner box pokes out of any edge', () => {
    expect(containsBounds(BOX, padBounds(BOX))).toBe(false)
    expect(containsBounds(BOX, { ...BOX, maxLon: BOX.maxLon + 0.01 })).toBe(false)
    expect(containsBounds(BOX, { ...BOX, minLat: BOX.minLat - 0.01 })).toBe(false)
  })

  it('is true for a box against itself — nothing needs refetching', () => {
    expect(containsBounds(BOX, BOX)).toBe(true)
  })

  it('is false when nothing is loaded', () => {
    expect(containsBounds(null, BOX)).toBe(false)
  })
})

describe('padBounds', () => {
  it('grows the box by the fraction on every side', () => {
    const p = padBounds(BOX, 0.5)
    const latSpan = BOX.maxLat - BOX.minLat
    expect(p.minLat).toBeCloseTo(BOX.minLat - latSpan / 2, 12)
    expect(p.maxLat).toBeCloseTo(BOX.maxLat + latSpan / 2, 12)
  })

  it('leaves the box centred where it was', () => {
    const p = padBounds(BOX)
    expect((p.minLat + p.maxLat) / 2).toBeCloseTo((BOX.minLat + BOX.maxLat) / 2, 12)
    expect((p.minLon + p.maxLon) / 2).toBeCloseTo((BOX.minLon + BOX.maxLon) / 2, 12)
  })
})

/* -------------------------------------------------------------------------
 * Marked channels and piles
 * ---------------------------------------------------------------------- */

describe('marked channels', () => {
  it('finds the fairway and pile layers by name', () => {
    // NOAA republishes weekly and renumbers, so a hardcoded id coming back as
    // something else is how a boat ends up outside the channel it thinks it
    // is in. The pile pattern also has to survive an underscore separator —
    // `\b` would not, because an underscore is a word character.
    const roles = matchLayers(LAYER_PAYLOAD)
    expect(roles.find((l) => l.role === 'fairway')?.id).toBe(55)
    expect(roles.find((l) => l.role === 'pile')?.id).toBe(93)
  })

  it('still refuses a fairway drawn as a line', () => {
    // A line has no inside to rasterise. The new roles must not breach the
    // rule that keeps depth contours from being painted as depth bands.
    const found = matchLayers(LAYER_PAYLOAD)
    expect(found.some((l) => l.id === 56)).toBe(false)
  })

  it('records a dredged area as both a depth and a channel', async () => {
    // Two facts at once — this much water, and water you are meant to be in.
    // Flattening it into a depth loses the one the coxswain steers by.
    const f = await fetchChartFeatures(BOX, { fetcher: stubService() })
    expect(f.depthAreas.some((d) => d.minDepthM === 6.5)).toBe(true)
    expect(f.channels.some((c) => c.kind === 'dredged')).toBe(true)
  })

  it('records a fairway as a channel and never as a depth', async () => {
    // A fairway carries no depth of its own, and inventing one for it is the
    // guess this app refuses everywhere else.
    const f = await fetchChartFeatures(BOX, { fetcher: stubService() })
    expect(f.channels.some((c) => c.kind === 'fairway')).toBe(true)
    expect(f.depthAreas).toHaveLength(2)
  })

  it('gives a pile its own kind and a smaller footprint than a wreck', async () => {
    // A wreck's 40 m would close every dredged cut with piles down both
    // banks, which is most of them.
    const f = await fetchChartFeatures(BOX, { fetcher: stubService() })
    const pile = f.hazards.find((h) => h.kind === 'pile')
    const wreck = f.hazards.find((h) => h.kind === 'wreck')
    expect(pile).toBeDefined()
    expect(wreck).toBeDefined()
    expect(pile!.radiusM).toBeLessThan(wreck!.radiusM)
  })

  it('reports no channels rather than guessing when none is published', async () => {
    // Most of the coast has neither a dredged area nor a fairway, and the
    // router has to be able to tell that apart from "outside the channel".
    const f = await fetchChartFeatures(BOX, {
      fetcher: async (url: string) => {
        if (url.includes('/layers?f=json')) return LAYER_PAYLOAD
        if (url.includes('/40/query')) {
          return {
            features: [
              {
                geometry: {
                  type: 'Polygon',
                  coordinates: [[[-94.85, 29.3], [-94.8, 29.3], [-94.8, 29.35], [-94.85, 29.3]]],
                },
                properties: { DRVAL1: 9 },
              },
            ],
          }
        }
        return { features: [] }
      },
    })
    expect(f.channels).toEqual([])
    expect(f.coverage).toBe('full')
  })
})

/* -------------------------------------------------------------------------
 * The ENC relay
 *
 * The tiles are <img> and need no permission; these queries are fetch, and a
 * browser blocks a cross-origin JSON response unless the host allows it. The
 * relay is the only way round that, so where a query is sent is worth pinning.
 * ---------------------------------------------------------------------- */

describe('encRequestUrl', () => {
  const target =
    'https://encdirect.noaa.gov/arcgis/rest/services/encdirect/enc_harbour/MapServer/layers?f=json'

  it('leaves the URL alone outside a browser — there is no origin to relay to', () => {
    expect(encRequestUrl(target)).toBe(target)
  })

  it('sends it through this app own origin in a browser', () => {
    const g = globalThis as { window?: unknown }
    g.window = {}
    try {
      const out = encRequestUrl(target)
      expect(out.startsWith('/api/enc?u=')).toBe(true)
      // Encoded, so the query string of the target cannot be read as ours.
      expect(out).toContain(encodeURIComponent(target))
      expect(out).not.toContain('?f=json')
    } finally {
      delete g.window
    }
  })

  it('never relays a host it was not built for', () => {
    const g = globalThis as { window?: unknown }
    g.window = {}
    try {
      // The relay itself refuses these too, but nothing should be asking.
      expect(encRequestUrl('https://example.com/anything')).toBe(
        'https://example.com/anything',
      )
      expect(encRequestUrl('https://gis.charttools.noaa.gov/x')).toBe(
        'https://gis.charttools.noaa.gov/x',
      )
    } finally {
      delete g.window
    }
  })
})

/* -------------------------------------------------------------------------
 * More hazards: structures as lines, pylons, islets, platforms
 *
 * Names below are NOAA's own, as published by ENC Direct's harbour, approach
 * and coastal services (checked against the live catalogues for Galveston).
 * ---------------------------------------------------------------------- */

const P = 'esriGeometryPoint'
const L = 'esriGeometryPolyline'
const A = 'esriGeometryPolygon'

const HAZARD_CATALOGUE = {
  layers: [
    { id: 227, name: 'Harbor.Depth_Area', geometryType: A },
    { id: 18, name: 'Harbor.Shoreline_Construction_point', geometryType: P },
    { id: 24, name: 'Harbor.Dam_point', geometryType: P },
    { id: 28, name: 'Harbor.Pylon_Bridge_Support_point', geometryType: P },
    { id: 33, name: 'Harbor.Obstruction_point', geometryType: P },
    { id: 38, name: 'Harbor.Land_Area_point', geometryType: P },
    { id: 46, name: 'Harbor.Offshore_Platform_point', geometryType: P },
    { id: 53, name: 'Harbor.Gate_point', geometryType: P },
    { id: 55, name: 'Harbor.Hulk_point', geometryType: P },
    { id: 56, name: 'Harbor.Mooring_Warping_Facility_point', geometryType: P },
    { id: 58, name: 'Harbor.Pile_point', geometryType: P },
    { id: 84, name: 'Harbor.Coastline_line', geometryType: L },
    { id: 85, name: 'Harbor.Shoreline_Construction_line', geometryType: L },
    { id: 87, name: 'Harbor.Bridge_line', geometryType: L },
    { id: 90, name: 'Harbor.Dam_line', geometryType: L },
    { id: 99, name: 'Harbor.Obstruction_line', geometryType: L },
    { id: 103, name: 'Harbor.Depth_Area_line', geometryType: L },
    { id: 104, name: 'Harbor.Depth_Contour_line', geometryType: L },
    { id: 106, name: 'Harbor.Land_Area_line', geometryType: L },
    { id: 118, name: 'Harbor.Causeway_line', geometryType: L },
    { id: 119, name: 'Harbor.Dyke_line', geometryType: L },
    { id: 120, name: 'Harbor.Floating_Dock_line', geometryType: L },
    { id: 121, name: 'Harbor.Gate_line', geometryType: L },
    { id: 122, name: 'Harbor.Mooring_Warping_Facility_line', geometryType: L },
    { id: 93, name: 'Coastal.Pontoon_line', geometryType: L },
    { id: 138, name: 'Harbor.Shoreline_Construction_area', geometryType: A },
    { id: 141, name: 'Harbor.Bridge_area', geometryType: A },
    { id: 145, name: 'Harbor.Dam_area', geometryType: A },
    { id: 149, name: 'Harbor.Pylon_Bridge_Support_area', geometryType: A },
    { id: 156, name: 'Harbor.Obstruction_area', geometryType: A },
    { id: 165, name: 'Harbor.Offshore_Platform_area', geometryType: A },
    { id: 171, name: 'Harbor.Causeway_area', geometryType: A },
    { id: 175, name: 'Harbor.Dyke_area', geometryType: A },
    { id: 176, name: 'Harbor.Floating_Dock_area', geometryType: A },
    { id: 177, name: 'Harbor.Gate_area', geometryType: A },
    { id: 180, name: 'Harbor.Hulk_area', geometryType: A },
    { id: 182, name: 'Harbor.Mooring_Warping_Facility_area', geometryType: A },
    { id: 233, name: 'Harbor.Land_Area', geometryType: A },
  ],
}

describe('matchLayers — structures and small hazards', () => {
  const byId = new Map(matchLayers(HAZARD_CATALOGUE).map((l) => [l.id, l]))
  const role = (id: number) => byId.get(id)?.role
  const geometry = (id: number) => byId.get(id)?.geometry

  it('reads a bridge pylon as a pylon, not as a bridge that is thrown away', () => {
    // "Pylon_Bridge_Support" says bridge too. Bridges are read for air draft
    // only and never block, so a pier standing in the channel used to vanish.
    expect(role(28)).toBe('pylon')
    expect(geometry(28)).toBe('point')
    expect(role(149)).toBe('pylon')
    expect(geometry(149)).toBe('polygon')
  })

  it('reads land charted as a point (an islet) and as a line', () => {
    expect(role(38)).toBe('land')
    expect(geometry(38)).toBe('point')
    expect(role(106)).toBe('land')
    expect(geometry(106)).toBe('line')
    expect(role(233)).toBe('land')
  })

  it('reads jetties, dams, causeways, dykes, gates, docks, pontoons and moorings as lines', () => {
    expect(role(85)).toBe('shoreline')
    expect(role(90)).toBe('dam')
    expect(role(99)).toBe('obstruction')
    expect(role(118)).toBe('causeway')
    expect(role(119)).toBe('dyke')
    expect(role(120)).toBe('floatingDock')
    expect(role(121)).toBe('gate')
    expect(role(122)).toBe('mooring')
    expect(role(93)).toBe('pontoon')
    for (const id of [85, 90, 99, 118, 119, 120, 121, 122, 93]) {
      expect(geometry(id)).toBe('line')
    }
  })

  it('reads the area forms of structures and platforms', () => {
    expect(role(138)).toBe('shoreline')
    expect(role(145)).toBe('dam')
    expect(role(156)).toBe('obstruction')
    expect(role(165)).toBe('platform')
    expect(role(171)).toBe('causeway')
    expect(role(175)).toBe('dyke')
    expect(role(176)).toBe('floatingDock')
    expect(role(180)).toBe('hulk')
    expect(role(182)).toBe('mooring')
  })

  it('reads platforms and piles as points', () => {
    expect(role(46)).toBe('platform')
    expect(role(58)).toBe('pile')
  })

  it('still refuses contours, depth-area edges, the coastline and bridge lines', () => {
    // Each is the edge of an area that is published separately, or (the
    // bridge) something that does not block the water at all.
    for (const id of [84, 87, 103, 104]) expect(byId.has(id)).toBe(false)
  })

  it('does not read the point forms charted on or beside a structure', () => {
    // Dam, gate, hulk, mooring and shoreline-construction points mark
    // something that has its own line or area; the spec does not block them.
    for (const id of [18, 24, 53, 55, 56]) expect(byId.has(id)).toBe(false)
  })

  it('keeps the bridge area for air draft only, and leaves the gate area alone', () => {
    expect(role(141)).toBe('bridge')
    expect(byId.has(177)).toBe(false)
  })

  it('finds the new roles by their S-57 acronyms too', () => {
    const layers = matchLayers({
      layers: [
        { id: 1, name: 'PYLONS', geometryType: P },
        { id: 2, name: 'OFSPLF', geometryType: P },
        { id: 3, name: 'DAMCON', geometryType: L },
        { id: 4, name: 'CAUSWY', geometryType: L },
        { id: 5, name: 'DYKCON', geometryType: L },
        { id: 6, name: 'GATCON', geometryType: L },
        { id: 7, name: 'FLODOC', geometryType: L },
        { id: 8, name: 'HULKES', geometryType: A },
        { id: 9, name: 'PONTON', geometryType: L },
        { id: 10, name: 'MORFAC', geometryType: L },
        { id: 11, name: 'SLCONS', geometryType: L },
        { id: 12, name: 'OBSTRN', geometryType: L },
        { id: 13, name: 'LNDARE', geometryType: P },
      ],
    })
    expect(layers.map((l) => l.role)).toEqual([
      'pylon', 'platform', 'dam', 'causeway', 'dyke', 'gate', 'floatingDock',
      'hulk', 'pontoon', 'mooring', 'shoreline', 'obstruction', 'land',
    ])
  })

  it('matches the short words only as whole words', () => {
    expect(
      matchLayers({
        layers: [
          { id: 1, name: 'Harbor.Damage_Report_line', geometryType: L },
          { id: 2, name: 'Harbor.Navigation_Line', geometryType: L },
          { id: 3, name: 'Harbor.Gateway_Zone_line', geometryType: L },
        ],
      }),
    ).toEqual([])
  })
})

describe('pathsOf', () => {
  const path = [
    [-94.7, 29.3],
    [-94.69, 29.31],
    [-94.68, 29.32],
  ]

  it('reads a GeoJSON LineString', () => {
    expect(pathsOf({ type: 'LineString', coordinates: path })).toEqual([path])
  })

  it('reads every path of a GeoJSON MultiLineString', () => {
    expect(pathsOf({ type: 'MultiLineString', coordinates: [path, path.slice(0, 2)] })).toEqual([
      path,
      path.slice(0, 2),
    ])
  })

  it('reads Esri JSON paths, so the app survives a service without f=geojson', () => {
    expect(pathsOf({ paths: [path, path] })).toHaveLength(2)
  })

  it('drops a Z or M value after the position', () => {
    expect(pathsOf({ type: 'LineString', coordinates: [[-94.7, 29.3, 4], [-94.6, 29.3, 5]] })).toEqual([
      [
        [-94.7, 29.3],
        [-94.6, 29.3],
      ],
    ])
  })

  it('splits a path at a vertex it cannot read rather than joining across it', () => {
    // Joining the neighbours would draw a jetty where none was charted;
    // dropping the whole path would lose the jetty that was.
    const got = pathsOf({
      paths: [[[-94.7, 29.3], [-94.69, 29.31], [null, 29.32], [-94.68, 29.33], [-94.67, 29.34]]],
    })
    expect(got).toEqual([
      [
        [-94.7, 29.3],
        [-94.69, 29.31],
      ],
      [
        [-94.68, 29.33],
        [-94.67, 29.34],
      ],
    ])
  })

  it('drops a path with fewer than two vertices', () => {
    expect(pathsOf({ type: 'LineString', coordinates: [[-94.7, 29.3]] })).toEqual([])
  })

  it('returns nothing for a polygon, a point or rubbish', () => {
    expect(pathsOf({ type: 'Polygon', coordinates: [path] })).toEqual([])
    expect(pathsOf({ type: 'Point', coordinates: [-94.8, 29.3] })).toEqual([])
    expect(pathsOf(null)).toEqual([])
    expect(pathsOf({ paths: 'no' })).toEqual([])
  })
})

describe('fetchChartFeatures — structures and small hazards', () => {
  const sq = (lon: number, lat: number, d = 0.001) => [
    [lon, lat],
    [lon + d, lat],
    [lon + d, lat + d],
    [lon, lat + d],
    [lon, lat],
  ]
  const poly = (lon: number, lat: number) => ({
    features: [{ geometry: { type: 'Polygon', coordinates: [sq(lon, lat)] }, properties: {} }],
  })
  const line = (lon: number, lat: number, properties: Record<string, unknown> = {}) => ({
    features: [
      {
        geometry: { type: 'LineString', coordinates: [[lon, lat], [lon + 0.01, lat]] },
        properties,
      },
    ],
  })
  const pt = (lon: number, lat: number) => ({
    features: [{ geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} }],
  })

  function hazardService(): Fetcher {
    return async (url) => {
      if (url.includes('/layers?f=json')) return HAZARD_CATALOGUE
      const id = Number(/\/(\d+)\/query/.exec(url)?.[1])
      switch (id) {
        case 227:
          return {
            features: [
              { geometry: { type: 'Polygon', coordinates: [sq(-94.85, 29.3, 0.05)] }, properties: { DRVAL1: 9 } },
            ],
          }
        case 28:
          return pt(-94.81, 29.31)
        case 38:
          return pt(-94.82, 29.32)
        case 46:
          return pt(-94.83, 29.33)
        case 85:
          return line(-94.84, 29.3)
        case 90:
          return line(-94.84, 29.301)
        case 99:
          return line(-94.84, 29.302, { VALSOU: 1.2 })
        case 106:
          return line(-94.84, 29.303)
        case 118:
          return line(-94.84, 29.304)
        case 119:
          return line(-94.84, 29.305)
        case 120:
          // Esri's own form for a line: `paths`.
          return {
            features: [
              { geometry: { paths: [[[-94.84, 29.306], [-94.83, 29.306]]] }, attributes: {} },
            ],
          }
        case 121:
          return line(-94.84, 29.307)
        case 122:
          return line(-94.84, 29.308)
        case 93:
          return line(-94.84, 29.309)
        case 141:
          return poly(-94.8, 29.34) // a bridge deck: must not block
        case 149:
          return poly(-94.81, 29.31)
        case 165:
          return poly(-94.83, 29.33)
        case 145:
        case 171:
        case 175:
        case 176:
        case 180:
        case 182:
        case 138:
        case 156:
          return poly(-94.845, 29.345)
        default:
          return { features: [] }
      }
    }
  }

  it('makes structures charted as lines into line hazards with their widths', async () => {
    const f = await fetchChartFeatures(BOX, { fetcher: hazardService() })
    const byLabel = new Map(f.lines.map((l) => [l.label, l]))
    expect(byLabel.get('jetty, pier or breakwater')).toMatchObject({
      kind: 'structure',
      widthM: STRUCTURE_WIDTH_M,
    })
    for (const label of ['dam', 'causeway', 'dyke', 'gate', 'narrow land']) {
      expect(byLabel.get(label)).toMatchObject({ kind: 'structure', widthM: 5 })
    }
    for (const label of ['floating dock', 'pontoon', 'mooring facility']) {
      expect(byLabel.get(label)).toMatchObject({ kind: 'structure', widthM: LIGHT_STRUCTURE_WIDTH_M })
    }
    expect(byLabel.get('obstruction 1.2 m')).toMatchObject({ kind: 'obstruction', widthM: 3 })
    expect(f.lines).toHaveLength(10)
  })

  it('keeps each line as open [lon, lat] paths, from GeoJSON and from Esri paths', async () => {
    const f = await fetchChartFeatures(BOX, { fetcher: hazardService() })
    const jetty = f.lines.find((l) => l.label.startsWith('jetty'))
    expect(jetty?.paths).toEqual([
      [
        [-94.84, 29.3],
        [-94.83, 29.3],
      ],
    ])
    const dock = f.lines.find((l) => l.label === 'floating dock')
    expect(dock?.paths).toEqual([
      [
        [-94.84, 29.306],
        [-94.83, 29.306],
      ],
    ])
  })

  it('gives pylons, islets and platforms footprints sized for what they are', async () => {
    const f = await fetchChartFeatures(BOX, { fetcher: hazardService() })
    expect(f.hazards.find((h) => h.kind === 'pylon')).toMatchObject({
      lat: 29.31,
      lon: -94.81,
      radiusM: PYLON_RADIUS_M,
    })
    expect(f.hazards.find((h) => h.kind === 'islet')).toMatchObject({
      lat: 29.32,
      radiusM: ISLET_RADIUS_M,
    })
    expect(f.hazards.find((h) => h.kind === 'platform')).toMatchObject({
      lat: 29.33,
      radiusM: PLATFORM_RADIUS_M,
    })
    expect(PYLON_RADIUS_M).toBe(10)
    expect(ISLET_RADIUS_M).toBe(15)
    expect(PLATFORM_RADIUS_M).toBe(30)
  })

  it('makes the area forms land, and never a bridge deck', async () => {
    const f = await fetchChartFeatures(BOX, { fetcher: hazardService() })
    // Pylon area, platform area, and eight structure areas (dam, causeway,
    // dyke, floating dock, hulk, mooring, shoreline construction,
    // obstruction). The bridge area is read and discarded.
    expect(f.land).toHaveLength(10)
    const bridgeRing = sq(-94.8, 29.34)
    expect(f.land.some((l) => JSON.stringify(l.rings[0]) === JSON.stringify(bridgeRing))).toBe(
      false,
    )
  })

  it('reads a multipoint layer as every point in it', async () => {
    const f = await fetchChartFeatures(BOX, {
      fetcher: async (url) => {
        if (url.includes('/layers?f=json')) {
          return {
            layers: [
              { id: 1, name: 'DEPARE', geometryType: A },
              { id: 2, name: 'PYLONS', geometryType: 'esriGeometryMultipoint' },
            ],
          }
        }
        if (url.includes('/1/query')) return depth9()
        if (url.includes('/2/query')) {
          return {
            features: [{ geometry: { points: [[-94.81, 29.31], [-94.811, 29.31]] }, attributes: {} }],
          }
        }
        return { features: [] }
      },
    })
    expect(f.hazards.filter((h) => h.kind === 'pylon')).toHaveLength(2)
  })

  it('returns an empty list of lines, never undefined, from a chart with none', async () => {
    const f = await fetchChartFeatures(BOX, { fetcher: stubService() })
    expect(f.lines).toEqual([])
  })
})

function depth9() {
  return {
    features: [
      {
        geometry: {
          type: 'Polygon',
          coordinates: [[[-94.85, 29.3], [-94.8, 29.3], [-94.8, 29.35], [-94.85, 29.35], [-94.85, 29.3]]],
        },
        properties: { DRVAL1: 9 },
      },
    ],
  }
}

describe('EMPTY_FEATURES', () => {
  it('carries an empty list of line hazards', () => {
    expect(EMPTY_FEATURES.lines).toEqual([])
  })
})

/* -------------------------------------------------------------------------
 * Detail near the ends of a long passage
 * ---------------------------------------------------------------------- */

/** About 55 NM corner to corner: too big for the harbour band as a whole. */
const LONG_BOX: ChartBounds = { minLat: 29.0, minLon: -95.2, maxLat: 29.6, maxLon: -94.4 }
const START = { lat: 29.3115, lon: -94.79 } // Galveston Channel
const END = { lat: 29.55, lon: -94.5 }

/** The envelope a query asked about, as a box. */
function envelopeOf(url: string): ChartBounds | null {
  const g = new URL(url).searchParams.get('geometry')
  if (!g) return null
  const [minLon, minLat, maxLon, maxLat] = g.split(',').map(Number)
  return { minLat, minLon, maxLat, maxLon }
}

function inside(p: { lat: number; lon: number }, b: ChartBounds): boolean {
  return p.lat >= b.minLat && p.lat <= b.maxLat && p.lon >= b.minLon && p.lon <= b.maxLon
}

describe('detailBox', () => {
  it('is DETAIL_HALF_NM either side of the position, in both directions', () => {
    const b = detailBox(START)
    expect(DETAIL_HALF_NM).toBeGreaterThanOrEqual(2)
    // North-south and east-west half-sizes, measured independently.
    expect(boundsSpanNM({ ...b, minLon: START.lon, maxLon: START.lon }) / 2).toBeCloseTo(
      DETAIL_HALF_NM,
      2,
    )
    expect(
      boundsSpanNM({ minLat: START.lat, maxLat: START.lat, minLon: b.minLon, maxLon: b.maxLon }) /
        2,
    ).toBeCloseTo(DETAIL_HALF_NM, 1)
    expect(inside(START, b)).toBe(true)
  })

  it('does not ask for the whole world at a pole', () => {
    const b = detailBox({ lat: 90, lon: 0 })
    expect(Number.isFinite(b.minLon) && Number.isFinite(b.maxLon)).toBe(true)
  })
})

describe('intersectBounds and unionBounds', () => {
  const a: ChartBounds = { minLat: 0, minLon: 0, maxLat: 2, maxLon: 2 }
  it('intersects overlapping boxes and refuses apart ones', () => {
    expect(intersectBounds(a, { minLat: 1, minLon: 1, maxLat: 3, maxLon: 3 })).toEqual({
      minLat: 1,
      minLon: 1,
      maxLat: 2,
      maxLon: 2,
    })
    expect(intersectBounds(a, { minLat: 3, minLon: 3, maxLat: 4, maxLon: 4 })).toBeNull()
  })
  it('unions to the smallest box holding both', () => {
    expect(unionBounds(a, { minLat: 3, minLon: -1, maxLat: 4, maxLon: 1 })).toEqual({
      minLat: 0,
      minLon: -1,
      maxLat: 4,
      maxLon: 2,
    })
  })
})

describe('mergeOverlapping', () => {
  it('joins two boxes that overlap along one side', () => {
    const out = mergeOverlapping([
      { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
      { minLat: 0, minLon: 0.5, maxLat: 1, maxLon: 1.5 },
    ])
    expect(out).toEqual([{ minLat: 0, minLon: 0, maxLat: 1, maxLon: 1.5 }])
  })

  it('leaves apart boxes apart, and diagonal neighbours too', () => {
    // The union of a diagonal pair is mostly water nobody asked about.
    expect(
      mergeOverlapping([
        { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
        { minLat: 0.5, minLon: 0.5, maxLat: 1.5, maxLon: 1.5 },
      ]),
    ).toHaveLength(2)
    expect(
      mergeOverlapping([
        { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
        { minLat: 5, minLon: 5, maxLat: 6, maxLon: 6 },
      ]),
    ).toHaveLength(2)
  })
})

describe('planChartRegions', () => {
  it('asks the harbour band about each end of a passage too long for it as a whole', () => {
    const regions = planChartRegions(LONG_BOX, { detailAround: [START, END] })
    expect(regions[0].detail).toBe(false)
    expect(regions[0].bounds).toEqual(LONG_BOX)
    expect(regions[0].bands.map((b) => b.id)).toEqual(['approach', 'coastal', 'general'])
    const detail = regions.slice(1)
    expect(detail).toHaveLength(2)
    for (const r of detail) {
      expect(r.detail).toBe(true)
      // Approach is already asked about the whole box, so only harbour.
      expect(r.bands.map((b) => b.id)).toEqual(['harbour'])
    }
    expect(inside(START, detail[0].bounds)).toBe(true)
    expect(inside(END, detail[1].bounds)).toBe(true)
  })

  it('asks for approach too when the whole-area query leaves it out', () => {
    const ocean: ChartBounds = { minLat: 28, minLon: -96, maxLat: 30, maxLon: -94 }
    const regions = planChartRegions(ocean, { detailAround: [START] })
    expect(regions[0].bands.map((b) => b.id)).not.toContain('approach')
    expect(regions[1].bands.map((b) => b.id)).toEqual(['harbour', 'approach'])
  })

  it('adds nothing for a short hop that already asks the harbour band about everything', () => {
    const regions = planChartRegions(BOX, {
      detailAround: [
        { lat: 29.31, lon: -94.84 },
        { lat: 29.34, lon: -94.81 },
      ],
    })
    expect(regions).toHaveLength(1)
    expect(regions[0].bands[0].id).toBe('harbour')
  })

  it('still asks for detail round a position outside the box, rather than ignoring it', () => {
    // A caller's mistake, not a real passage — but the harbour band over the
    // main box says nothing about water outside it.
    const regions = planChartRegions(BOX, { detailAround: [END] })
    expect(regions).toHaveLength(2)
    expect(inside(END, regions[1].bounds)).toBe(true)
    expect(regions[1].bands.map((b) => b.id)).toEqual(['harbour', 'approach'])
  })

  it('cuts each detail box to the planning area', () => {
    const regions = planChartRegions(LONG_BOX, { detailAround: [{ lat: 29.01, lon: -95.19 }] })
    expect(containsBounds(LONG_BOX, regions[1].bounds)).toBe(true)
  })

  it('joins the boxes of two ends close together into one query', () => {
    const regions = planChartRegions(LONG_BOX, {
      detailAround: [START, { lat: START.lat, lon: START.lon + 0.02 }],
    })
    expect(regions).toHaveLength(2)
  })

  it('ignores positions that are not positions', () => {
    const regions = planChartRegions(LONG_BOX, {
      detailAround: [{ lat: NaN, lon: -94 }, { lat: 91, lon: 0 }],
    })
    expect(regions).toHaveLength(1)
  })
})

describe('chartNeeds and regionsSatisfy', () => {
  const HOP: ChartBounds = {
    minLat: START.lat - 0.01,
    minLon: START.lon - 0.01,
    maxLat: START.lat + 0.01,
    maxLon: START.lon + 0.01,
  }

  it('does not let a coastal-only load stand in for a harbour hop inside it', () => {
    // The old `covers()` was containment alone: a short route after a long
    // one planned on coastal data, which in Galveston is 0 m almost
    // everywhere, so the hop failed or crossed what the harbour chart knows.
    const loaded = [{ bounds: LONG_BOX, bands: ['approach', 'coastal', 'general'] }]
    expect(regionsSatisfy(loaded, chartNeeds(HOP))).toBe(false)
  })

  it('lets a harbour detail box round the old start stand in for a hop inside it', () => {
    const loaded = [
      { bounds: LONG_BOX, bands: ['approach', 'coastal', 'general'] },
      { bounds: detailBox(START), bands: ['harbour'] },
    ]
    expect(regionsSatisfy(loaded, chartNeeds(HOP))).toBe(true)
  })

  it('needs detail round each end of a long passage', () => {
    const needs = chartNeeds(LONG_BOX, { detailAround: [START, END] })
    expect(needs).toHaveLength(3)
    expect(needs[1].bands).toEqual(['harbour'])
    const withoutEnd = [
      { bounds: LONG_BOX, bands: ['approach', 'coastal', 'general'] },
      { bounds: detailBox(START), bands: ['harbour'] },
    ]
    expect(regionsSatisfy(withoutEnd, needs)).toBe(false)
    expect(
      regionsSatisfy([...withoutEnd, { bounds: detailBox(END), bands: ['harbour'] }], needs),
    ).toBe(true)
  })

  it('does not count a band that was not read', () => {
    const needs = chartNeeds(LONG_BOX)
    expect(regionsSatisfy([{ bounds: LONG_BOX, bands: ['coastal', 'general'] }], needs)).toBe(false)
  })

  it('picks bands from `spanOf` when the box is padded before fetching', () => {
    // A 3.5 NM box pads to ~4.4 NM: bands are chosen for what is fetched.
    const needs = chartNeeds(BOX, { spanOf: padBounds(BOX) })
    expect(needs[0].bounds).toEqual(BOX)
    expect(needs[0].bands).toEqual(bandsForSpan(boundsSpanNM(padBounds(BOX))).map((b) => b.id))
  })
})

describe('fetchChartArea — detail round the ends', () => {
  const ring = (b: ChartBounds) => [
    [b.minLon, b.minLat],
    [b.maxLon, b.minLat],
    [b.maxLon, b.maxLat],
    [b.minLon, b.maxLat],
    [b.minLon, b.minLat],
  ]

  /**
   * Galveston as the services describe it: the coastal chart calls the whole
   * box 0 m; the harbour chart knows the channel is 12 m. The harbour depth
   * area returned is the one round whatever envelope was asked about.
   */
  function galveston(asked: string[], fail: RegExp | null = null): Fetcher {
    return async (url) => {
      asked.push(url)
      if (fail && fail.test(url)) throw new Error('Chart service returned 502')
      if (url.includes('/layers?f=json')) return LAYER_PAYLOAD
      if (!url.includes('/40/query')) return { features: [] }
      const env = envelopeOf(url)!
      if (url.includes('enc_harbour')) {
        return {
          features: [
            { geometry: { type: 'Polygon', coordinates: [ring(env)] }, properties: { DRVAL1: 12 } },
          ],
        }
      }
      if (url.includes('enc_coastal')) {
        return {
          features: [
            { geometry: { type: 'Polygon', coordinates: [ring(LONG_BOX)] }, properties: { DRVAL1: 0 } },
          ],
        }
      }
      return { features: [] }
    }
  }

  it('fetches the harbour chart round each end of a long passage, and only there', async () => {
    const asked: string[] = []
    const f = await fetchChartArea(LONG_BOX, { fetcher: galveston(asked), detailAround: [START, END] })
    const harbourQueries = asked.filter((u) => u.includes('enc_harbour') && u.includes('/query'))
    expect(harbourQueries.length).toBeGreaterThan(0)
    for (const u of harbourQueries) {
      const env = envelopeOf(u)!
      expect(boundsSpanNM(env)).toBeLessThan(2 * DETAIL_HALF_NM * Math.SQRT2 + 0.1)
      expect(inside(START, env) || inside(END, env)).toBe(true)
    }
    // Both ends asked.
    expect(harbourQueries.some((u) => inside(START, envelopeOf(u)!))).toBe(true)
    expect(harbourQueries.some((u) => inside(END, envelopeOf(u)!))).toBe(true)
    expect(f.bands).toEqual(['harbour', 'coastal'])
    expect(f.coverage).toBe('full')
    expect(f.failedBands).toEqual([])
  })

  it('tags the harbour depths above the coastal 0 m so the finer chart speaks at the ends', async () => {
    const f = await fetchChartArea(LONG_BOX, { fetcher: galveston([]), detailAround: [START, END] })
    const harbour = f.depthAreas.filter((d) => d.minDepthM === 12)
    const coastal = f.depthAreas.filter((d) => d.minDepthM === 0)
    expect(harbour).toHaveLength(2)
    expect(coastal).toHaveLength(1)
    for (const h of harbour) expect(h.level).toBeGreaterThan(coastal[0].level ?? Infinity)
  })

  it('says what it read, box by box, so the store can tell what a later request can reuse', async () => {
    const f = await fetchChartArea(LONG_BOX, { fetcher: galveston([]), detailAround: [START, END] })
    expect(f.regions).toHaveLength(3)
    expect(f.regions[0]).toEqual({ bounds: LONG_BOX, bands: ['approach', 'coastal', 'general'] })
    expect(f.regions[1].bands).toEqual(['harbour'])
    expect(inside(START, f.regions[1].bounds)).toBe(true)
  })

  it('does not record a band whose depths came back with a piece missing, so it is asked again', async () => {
    // One quadrant of the harbour depth query fails every time: the band
    // "answered", but with a hole in its depths — the hole the crew's phone
    // planned round (2026-09-28). The data that did come is used, the band
    // is named incomplete, and it is not recorded as read.
    const SHORT_BOX: ChartBounds = { minLat: 29.3, minLon: -94.82, maxLat: 29.34, maxLon: -94.78 }
    const base = galveston([])
    const fetcher: Fetcher = async (url) => {
      if (url.includes('enc_harbour') && url.includes('/40/query')) {
        const env = envelopeOf(url)!
        const whole = env.maxLat - env.minLat > (SHORT_BOX.maxLat - SHORT_BOX.minLat) * 0.9
        if (whole) return { exceededTransferLimit: true, features: [] }
        // The south-west quadrant never answers.
        if (env.minLon < SHORT_BOX.minLon + 0.001 && env.minLat < SHORT_BOX.minLat + 0.001) {
          throw new Error('Chart service returned 502')
        }
      }
      return base(url)
    }
    const f = await fetchChartArea(SHORT_BOX, { fetcher })
    expect(f.coverage).toBe('partial')
    expect(f.incompleteBands).toEqual(['harbour'])
    expect(f.depthAreas.some((d) => d.minDepthM === 12)).toBe(true)
    expect(f.regions[0].bands).not.toContain('harbour')
  })

  it('reports a detail band that failed as partial, naming it, and keeps the rest', async () => {
    const f = await fetchChartArea(LONG_BOX, {
      fetcher: galveston([], /enc_harbour/),
      detailAround: [START, END],
    })
    expect(f.coverage).toBe('partial')
    expect(f.failedBands).toEqual(['harbour'])
    expect(f.depthAreas.some((d) => d.minDepthM === 0)).toBe(true)
    // Not recorded as read, so the next request asks again.
    expect(f.regions[1].bands).toEqual([])
  })

  it('does not count a band that answered with an empty sea as failed', async () => {
    // Galveston has no approach-band chart at all. That is geography, and
    // warning about it on every route would teach the crew to ignore warnings.
    const f = await fetchChartArea(LONG_BOX, { fetcher: galveston([]), detailAround: [START] })
    expect(f.failedBands).toEqual([])
    expect(f.regions[0].bands).toContain('approach')
  })

  it('still throws when nothing anywhere produced a depth and something failed', async () => {
    await expect(
      fetchChartArea(LONG_BOX, {
        fetcher: async (url) => {
          if (url.includes('enc_harbour')) throw new Error('Failed to fetch')
          if (url.includes('/layers?f=json')) return LAYER_PAYLOAD
          return { features: [] }
        },
        detailAround: [START],
      }),
    ).rejects.toMatchObject({ name: 'ChartUnavailableError', kind: 'unreachable' })
  })

  it('keeps one copy of a feature two detail boxes both returned', async () => {
    const big = {
      features: [
        { geometry: { type: 'Polygon', coordinates: [ring(LONG_BOX)] }, properties: { DRVAL1: 7 } },
      ],
    }
    const wreck = {
      features: [{ geometry: { type: 'Point', coordinates: [-94.7, 29.4] }, properties: {} }],
    }
    const f = await fetchChartArea(LONG_BOX, {
      detailAround: [START, END],
      fetcher: async (url) => {
        if (url.includes('/layers?f=json')) return LAYER_PAYLOAD
        if (!url.includes('enc_harbour')) return { features: [] }
        if (url.includes('/40/query')) return big
        if (url.includes('/90/query')) return wreck
        return { features: [] }
      },
    })
    expect(f.depthAreas).toHaveLength(1)
    expect(f.hazards.filter((h) => h.kind === 'wreck')).toHaveLength(1)
  })

  it('keeps two different features that happen to share a signature', async () => {
    // Same ring shape, same first and middle vertex, different far corner:
    // dropping one of these would drop real land.
    const a = [[-94.8, 29.3], [-94.79, 29.3], [-94.79, 29.31], [-94.8, 29.31], [-94.8, 29.3]]
    const b = [[-94.8, 29.3], [-94.78, 29.3], [-94.79, 29.31], [-94.8, 29.31], [-94.8, 29.3]]
    const f = await fetchChartArea(BOX, {
      bands: [ENC_BANDS[0]],
      fetcher: async (url) => {
        if (url.includes('/layers?f=json')) return LAYER_PAYLOAD
        if (url.includes('/40/query')) return depth9()
        if (url.includes('/60/query')) {
          return {
            features: [
              { geometry: { type: 'Polygon', coordinates: [a] }, properties: {} },
              { geometry: { type: 'Polygon', coordinates: [b] }, properties: {} },
            ],
          }
        }
        return { features: [] }
      },
    })
    expect(f.land).toHaveLength(2)
  })

  it('tags line hazards with their band level, like land', async () => {
    const f = await fetchChartArea(BOX, {
      bands: [ENC_BANDS[0], ENC_BANDS[2]],
      fetcher: async (url) => {
        if (url.includes('/layers?f=json')) return LAYER_PAYLOAD
        if (url.includes('/40/query')) return depth9()
        if (url.includes('/85/query') && url.includes('enc_harbour')) {
          return {
            features: [
              { geometry: { type: 'LineString', coordinates: [[-94.84, 29.3], [-94.83, 29.3]] }, properties: {} },
            ],
          }
        }
        return { features: [] }
      },
    })
    expect(f.lines).toHaveLength(1)
    expect(f.lines[0].level).toBe(ENC_BANDS.length)
  })

  it('behaves exactly as before when no detail is asked for', async () => {
    const asked: string[] = []
    await fetchChartArea(LONG_BOX, { fetcher: galveston(asked) })
    expect(asked.some((u) => u.includes('enc_harbour'))).toBe(false)
  })

  it('reads the harbour chart along the whole route, not just round its ends (corridor)', async () => {
    // A long passage: without the corridor the middle is planned — and
    // re-routed — on the coastal chart's 0 m.
    const route = [START, { lat: 29.45, lon: -94.62 }, END]
    const pts = corridorPoints(route)
    expect(pts.length).toBeGreaterThan(3)
    const f = await fetchChartArea(LONG_BOX, { fetcher: galveston([]), detailAround: pts })
    // Every stretch of the route lies in a region read at harbour scale.
    for (let i = 1; i < route.length; i++) {
      for (let k = 0; k <= 20; k++) {
        const p = {
          lat: route[i - 1].lat + ((route[i].lat - route[i - 1].lat) * k) / 20,
          lon: route[i - 1].lon + ((route[i].lon - route[i - 1].lon) * k) / 20,
        }
        expect(f.regions.some((r) => r.bands.includes('harbour') && inside(p, r.bounds))).toBe(true)
      }
    }
  })

  it('adds only what is missing to a chart already loaded, and keeps what was there', async () => {
    const first = await fetchChartArea(LONG_BOX, { fetcher: galveston([]), detailAround: [START, END] })
    const asked: string[] = []
    const mid = { lat: 29.45, lon: -94.62 }
    const more = await fetchChartArea(LONG_BOX, {
      fetcher: galveston(asked),
      detailAround: [START, mid, END],
      base: { features: first, regions: first.regions },
    })
    const queries = asked.filter((u) => u.includes('/query'))
    // The whole-area bands and the two ends were read already: only the box
    // round the new point is asked for.
    expect(queries.length).toBeGreaterThan(0)
    for (const u of queries) {
      expect(u).toContain('enc_harbour')
      expect(inside(mid, envelopeOf(u)!)).toBe(true)
    }
    // Nothing lost, nothing doubled.
    expect(more.depthAreas.filter((d) => d.minDepthM === 0)).toHaveLength(1)
    expect(more.depthAreas.filter((d) => d.minDepthM === 12)).toHaveLength(3)
    expect(more.regions.some((r) => r.bands.includes('harbour') && inside(mid, r.bounds))).toBe(true)
    expect(more.regions.some((r) => r.bands.includes('harbour') && inside(START, r.bounds))).toBe(true)
  })
})

describe('corridorPoints', () => {
  it('samples a route every 1.5 detail boxes, ends included', () => {
    const pts = corridorPoints([START, END])
    expect(pts[0]).toEqual(START)
    expect(pts[pts.length - 1]).toEqual(END)
    for (let i = 1; i < pts.length; i++) {
      const d = haversineNM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon)
      expect(d).toBeLessThanOrEqual(1.5 * DETAIL_HALF_NM + 0.01)
    }
  })

  it('never exceeds the box cap on a very long passage', () => {
    const pts = corridorPoints([{ lat: 25, lon: -80 }, { lat: 35, lon: -75 }])
    expect(pts.length).toBeLessThanOrEqual(MAX_CORRIDOR_BOXES)
    expect(pts[pts.length - 1]).toEqual({ lat: 35, lon: -75 })
  })

  it('ignores positions that are not positions', () => {
    expect(corridorPoints([])).toEqual([])
    expect(corridorPoints([{ lat: NaN, lon: 0 }, START])).toEqual([START, START])
  })
})
