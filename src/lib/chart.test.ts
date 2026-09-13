import { describe, it, expect } from 'vitest'
import { MERCATOR_HALF, NOAA_CHART, SEAMARKS, tileBbox3857, lonToTileX, latToTileY } from './tiles'
import {
  bandForSpan,
  boundsSpanNM,
  containsBounds,
  padBounds,
  ENC_BANDS,
  exceededLimit,
  featuresOf,
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
    { id: 60, name: 'Harbor.Land_Area_area', geometryType: 'esriGeometryPolygon' },
    { id: 85, name: 'Harbor.Shoreline_Construction_line', geometryType: 'esriGeometryPolyline' },
    { id: 86, name: 'Harbor.Shoreline_Construction_area', geometryType: 'esriGeometryPolygon' },
    { id: 90, name: 'Harbor.Wrecks_point', geometryType: 'esriGeometryPoint' },
    { id: 91, name: 'Harbor.Obstructions_point', geometryType: 'esriGeometryPoint' },
    { id: 92, name: 'Harbor.Underwater_Rock_point', geometryType: 'esriGeometryPoint' },
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

  it('ignores line layers — a line has no inside to rasterise', () => {
    const found = matchLayers(LAYER_PAYLOAD)
    expect(found.some((l) => l.name.endsWith('_line'))).toBe(false)
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
    expect(f.depthAreas).toHaveLength(1)
    expect(f.depthAreas[0].minDepthM).toBeCloseTo(4.2, 6)
    expect(f.land).toHaveLength(1)
    expect(f.hazards).toHaveLength(1)
    expect(f.hazards[0].radiusM).toBe(HAZARD_RADIUS_M)
    expect(f.hazards[0]).toMatchObject({ lat: 29.32, lon: -94.82 })
  })

  it('reports no coverage when the service cannot be reached at all', async () => {
    const f = await fetchChartFeatures(BOX, {
      fetcher: async () => {
        throw new Error('blocked')
      },
    })
    expect(f.coverage).toBe('none')
    expect(f.depthAreas).toEqual([])
  })

  it('reports no coverage when the area has no charted depths — outside US waters', async () => {
    const f = await fetchChartFeatures(BOX, {
      fetcher: async (url) => (url.includes('/layers?f=json') ? LAYER_PAYLOAD : { features: [] }),
    })
    expect(f.coverage).toBe('none')
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
