import { describe, it, expect } from 'vitest'
import { haversineNM, metersPerDegree, NM_TO_METERS } from './geo'
import {
  astar,
  chamferChannel,
  chamferClearance,
  chamferDistance,
  channelPenalty,
  chordOutsideChannel,
  fillRings,
  legChannelFraction,
  legMinDepth,
  lineOfSight,
  makeGrid,
  passability,
  passable,
  planRoute,
  rasterise,
  routeBounds,
  snapToWater,
  stringPull,
  toGrid,
  toLatLon,
  type ChartFeatures,
  type RouteGrid,
  type Ring,
} from './routing'

/* -------------------------------------------------------------------------
 * Helpers — an ASCII chart, so the expected answer can be read off the page
 * ---------------------------------------------------------------------- */

const CELL_M = 100
const BASE_LAT = 29.3
const BASE_LON = -94.8

/**
 * '.' navigable, '#' blocked, '?' unsurveyed, '=' navigable and inside a
 * marked channel, ':' navigable with only just enough water for a 1.5 m boat.
 * Row 0 is the north edge.
 *
 * The depth each character carries is what the two-level channel penalty reads:
 * '.' and '=' are 10 m, which is amply clear of any boat in these tests, and
 * ':' is 1.7 m, which clears a 1.5 m boat and nothing more.
 */
function gridFromAscii(rows: string[], cellM = CELL_M): RouteGrid {
  const r = rows.length
  const c = rows[0].length
  const mpd = metersPerDegree(BASE_LAT)
  const latPerRow = cellM / mpd.lat
  const lonPerCol = cellM / mpd.lon
  const g: RouteGrid = {
    maxLat: BASE_LAT,
    minLat: BASE_LAT - r * latPerRow,
    minLon: BASE_LON,
    maxLon: BASE_LON + c * lonPerCol,
    rows: r,
    cols: c,
    cellM,
    latPerRow,
    lonPerCol,
    cells: new Uint8Array(r * c),
    depth: new Float32Array(r * c).fill(NaN),
    clearCells: new Float32Array(r * c),
    channel: new Uint8Array(r * c),
    channelDist: new Float32Array(r * c).fill(Infinity),
    hasChannels: false,
  }
  for (let row = 0; row < r; row++) {
    for (let col = 0; col < c; col++) {
      const ch = rows[row][col]
      const i = row * c + col
      const water = ch === '.' || ch === '=' || ch === ':'
      g.cells[i] = water ? 1 : ch === '#' ? 2 : 0
      g.depth[i] = water ? (ch === ':' ? 1.7 : 10) : ch === '#' ? 0.5 : NaN
      if (ch === '=') {
        g.channel[i] = 1
        g.hasChannels = true
      }
    }
  }
  chamferClearance(g)
  chamferChannel(g)
  return g
}

/** A closed rectangular ring in [lon, lat] pairs. */
function boxRing(
  minLat: number,
  minLon: number,
  maxLat: number,
  maxLon: number,
): Ring {
  return [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ]
}

/* -------------------------------------------------------------------------
 * Rasterising
 * ---------------------------------------------------------------------- */

describe('fillRings', () => {
  it('fills the cells inside a ring and none outside it', () => {
    const g = gridFromAscii(Array(10).fill('..........'))
    // A box covering grid columns 2..5 and rows 2..5, built from the cell
    // corners so the expected answer is exact.
    const north = g.maxLat - 2 * g.latPerRow
    const south = g.maxLat - 6 * g.latPerRow
    const west = g.minLon + 2 * g.lonPerCol
    const east = g.minLon + 6 * g.lonPerCol
    const hit = new Set<number>()
    fillRings(g, [boxRing(south, west, north, east)], (i) => hit.add(i))

    expect(hit.size).toBe(16)
    for (let row = 2; row <= 5; row++) {
      for (let col = 2; col <= 5; col++) {
        expect(hit.has(row * g.cols + col)).toBe(true)
      }
    }
    expect(hit.has(1 * g.cols + 1)).toBe(false)
    expect(hit.has(6 * g.cols + 6)).toBe(false)
  })

  it('leaves a hole unfilled — an island inside a depth area is not deep water', () => {
    const g = gridFromAscii(Array(12).fill('............'))
    const ring = (r0: number, c0: number, r1: number, c1: number): Ring =>
      boxRing(
        g.maxLat - r1 * g.latPerRow,
        g.minLon + c0 * g.lonPerCol,
        g.maxLat - r0 * g.latPerRow,
        g.minLon + c1 * g.lonPerCol,
      )
    const hit = new Set<number>()
    // Outer 1..9, inner hole 4..6.
    fillRings(g, [ring(1, 1, 9, 9), ring(4, 4, 6, 6)], (i) => hit.add(i))

    // Outer covers 8×8 = 64 cells, the hole removes 2×2 = 4.
    expect(hit.size).toBe(60)
    expect(hit.has(5 * g.cols + 5)).toBe(false)
    expect(hit.has(2 * g.cols + 2)).toBe(true)
  })
})

describe('rasterise', () => {
  it('marks water shoaler than the boat needs as blocked, and deeper as open', () => {
    const from = { lat: 29.3, lon: -94.8 }
    const to = { lat: 29.32, lon: -94.78 }
    const g = makeGrid(from, to)
    const whole: Ring = boxRing(g.minLat, g.minLon, g.maxLat, g.maxLon)
    rasterise(
      g,
      { depthAreas: [{ minDepthM: 1.2, rings: [whole] }], channels: [], land: [], hazards: [], coverage: 'full' },
      1.5,
    )
    expect(g.cells[0]).toBe(2)

    const g2 = makeGrid(from, to)
    rasterise(
      g2,
      { depthAreas: [{ minDepthM: 2.0, rings: [whole] }], channels: [], land: [], hazards: [], coverage: 'full' },
      1.5,
    )
    expect(g2.cells[0]).toBe(1)
  })

  it('keeps the shoalest reading where two depth areas overlap', () => {
    const from = { lat: 29.3, lon: -94.8 }
    const to = { lat: 29.32, lon: -94.78 }
    const g = makeGrid(from, to)
    const whole: Ring = boxRing(g.minLat, g.minLon, g.maxLat, g.maxLon)
    rasterise(
      g,
      {
        depthAreas: [
          { minDepthM: 9, rings: [whole] },
          { minDepthM: 0.6, rings: [whole] },
        ],
        channels: [],
        land: [],
        hazards: [],
        coverage: 'full',
      },
      1.5,
    )
    expect(g.depth[0]).toBeCloseTo(0.6, 5)
    expect(g.cells[0]).toBe(2)
  })

  it('blocks a circle of cells around a point hazard', () => {
    const from = { lat: 29.3, lon: -94.8 }
    const to = { lat: 29.31, lon: -94.79 }
    const g = makeGrid(from, to)
    const whole: Ring = boxRing(g.minLat, g.minLon, g.maxLat, g.maxLon)
    const mid = toLatLon(g, Math.floor(g.cols / 2), Math.floor(g.rows / 2))
    rasterise(
      g,
      {
        depthAreas: [{ minDepthM: 20, rings: [whole] }],
        channels: [],
        land: [],
        hazards: [{ ...mid, kind: 'wreck' as const, radiusM: g.cellM * 2, label: 'wreck' }],
        coverage: 'full',
      },
      1.5,
    )
    const c = toGrid(g, mid)
    expect(g.cells[Math.floor(c.row) * g.cols + Math.floor(c.col)]).toBe(2)
    // Well outside the radius is still open.
    expect(g.cells[Math.floor(c.row) * g.cols + Math.floor(c.col) + 6]).toBe(1)
  })
})

/* -------------------------------------------------------------------------
 * Clearance
 * ---------------------------------------------------------------------- */

describe('chamferClearance', () => {
  it('gives a cell touching a hazard one cell of clearance', () => {
    const g = gridFromAscii([
      '.....',
      '.....',
      '..#..',
      '.....',
      '.....',
    ])
    expect(g.clearCells[2 * 5 + 3]).toBeCloseTo(1, 5)
    expect(g.clearCells[2 * 5 + 2]).toBe(0)
  })

  it('treats the edge of the grid as blocked — a route may not leave the box', () => {
    const g = gridFromAscii(Array(9).fill('.........'))
    expect(g.clearCells[0]).toBeCloseTo(1, 5)
    expect(g.clearCells[4 * 9 + 4]).toBeGreaterThan(1)
  })
})

describe('passable', () => {
  it('excludes a cell inside the stand-off the coxswain asked for', () => {
    const g = gridFromAscii([
      '.....',
      '.....',
      '..#..',
      '.....',
      '.....',
    ])
    const none = passability(g, 0, 1.5)
    const oneCell = passability(g, CELL_M, 1.5)
    const next = 2 * 5 + 3
    expect(passable(g, next, none)).toBe(true)
    expect(passable(g, next, oneCell)).toBe(false)
  })

  it('never treats unsurveyed water as usable', () => {
    const g = gridFromAscii([
      '.....',
      '..?..',
      '.....',
    ])
    const p = passability(g, 0, 1.5)
    expect(passable(g, 1 * 5 + 2, p)).toBe(false)
  })
})

/* -------------------------------------------------------------------------
 * Line of sight
 * ---------------------------------------------------------------------- */

describe('lineOfSight', () => {
  it('sees straight across open water', () => {
    const g = gridFromAscii(Array(10).fill('..........'))
    const p = passability(g, 0, 1.5)
    expect(lineOfSight(g, { col: 0, row: 0 }, { col: 9, row: 9 }, p)).toBe(true)
  })

  it('is blocked by a wall between the two points', () => {
    const g = gridFromAscii([
      '.....',
      '.....',
      '#####',
      '.....',
      '.....',
    ])
    const p = passability(g, 0, 1.5)
    expect(lineOfSight(g, { col: 2, row: 0 }, { col: 2, row: 4 }, p)).toBe(false)
  })

  it('refuses to squeeze diagonally between two rocks that touch at a corner', () => {
    const g = gridFromAscii([
      '.#.',
      '#..',
      '...',
    ])
    const p = passability(g, 0, 1.5)
    // (0,0) to (1,1) would slip through the corner gap on a plain Bresenham.
    expect(lineOfSight(g, { col: 0, row: 0 }, { col: 1, row: 1 }, p)).toBe(false)
  })
})

/* -------------------------------------------------------------------------
 * A*
 * ---------------------------------------------------------------------- */

describe('astar', () => {
  it('crosses open water in the fewest possible steps', () => {
    const g = gridFromAscii(Array(5).fill('.....'))
    const p = passability(g, 0, 1.5)
    const path = astar(g, { col: 0, row: 0 }, { col: 4, row: 4 }, p)
    // Corner to corner of a 5×5 is four diagonal steps: five points.
    expect(path).not.toBeNull()
    expect(path).toHaveLength(5)
    expect(path?.[0]).toEqual({ col: 0, row: 0 })
    expect(path?.[4]).toEqual({ col: 4, row: 4 })
  })

  it('goes through the one gap in a wall rather than around it', () => {
    const g = gridFromAscii([
      '...#...',
      '...#...',
      '.......',
      '...#...',
      '...#...',
    ])
    const p = passability(g, 0, 1.5)
    const path = astar(g, { col: 0, row: 2 }, { col: 6, row: 2 }, p)
    expect(path).not.toBeNull()
    expect(path?.some((c) => c.col === 3 && c.row === 2)).toBe(true)
  })

  it('returns null when the destination is walled off', () => {
    const g = gridFromAscii([
      '..#..',
      '..#..',
      '..#..',
      '..#..',
      '..#..',
    ])
    const p = passability(g, 0, 1.5)
    expect(astar(g, { col: 0, row: 2 }, { col: 4, row: 2 }, p)).toBeNull()
  })

  it('will not slip diagonally between two rocks that touch at a corner', () => {
    // The only way out of the top-left pocket is the corner where the blocked
    // cells (2,1) and (1,2) meet. A boat cannot use that gap, so neither may
    // the route: the honest answer here is no route at all.
    const g = gridFromAscii([
      '..#..',
      '..#..',
      '##...',
      '.....',
      '.....',
    ])
    const p = passability(g, 0, 1.5)
    expect(astar(g, { col: 0, row: 0 }, { col: 4, row: 4 }, p)).toBeNull()
  })

  it('takes the same gap once one shoulder of it is actually open', () => {
    const g = gridFromAscii([
      '..#..',
      '.....',
      '##...',
      '.....',
      '.....',
    ])
    const p = passability(g, 0, 1.5)
    const path = astar(g, { col: 0, row: 0 }, { col: 4, row: 4 }, p)
    expect(path).not.toBeNull()
    for (const c of path ?? []) {
      expect(g.cells[c.row * g.cols + c.col]).toBe(1)
    }
  })

  it('leaves a dead end rather than reporting a route through it', () => {
    const g = gridFromAscii([
      '.....',
      '.###.',
      '.#?#.',
      '.###.',
      '.....',
    ])
    const p = passability(g, 0, 1.5)
    expect(astar(g, { col: 0, row: 0 }, { col: 2, row: 2 }, p)).toBeNull()
  })
})

/* -------------------------------------------------------------------------
 * String pulling
 * ---------------------------------------------------------------------- */

describe('stringPull', () => {
  it('reduces a staircase across open water to a single leg', () => {
    const g = gridFromAscii(Array(10).fill('..........'))
    const p = passability(g, 0, 1.5)
    const staircase = [
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 1, row: 1 },
      { col: 2, row: 1 },
      { col: 2, row: 2 },
      { col: 3, row: 2 },
      { col: 3, row: 3 },
    ]
    expect(stringPull(g, staircase, p)).toEqual([
      { col: 0, row: 0 },
      { col: 3, row: 3 },
    ])
  })

  it('keeps the corner it has to go round', () => {
    const g = gridFromAscii([
      '.......',
      '.......',
      '####...',
      '.......',
      '.......',
    ])
    const p = passability(g, 0, 1.5)
    const raw = astar(g, { col: 0, row: 0 }, { col: 0, row: 4 }, p)
    expect(raw).not.toBeNull()
    const pulled = stringPull(g, raw as { col: number; row: number }[], p)
    expect(pulled.length).toBeGreaterThan(2)
    expect(pulled.length).toBeLessThan((raw as unknown[]).length)
    // Every leg of the pulled path must still be clear water.
    for (let i = 1; i < pulled.length; i++) {
      expect(lineOfSight(g, pulled[i - 1], pulled[i], p)).toBe(true)
    }
  })
})

/* -------------------------------------------------------------------------
 * Snapping
 * ---------------------------------------------------------------------- */

describe('snapToWater', () => {
  it('leaves a position already in usable water alone', () => {
    const g = gridFromAscii(Array(5).fill('.....'))
    const p = passability(g, 0, 1.5)
    const here = toLatLon(g, 2, 2)
    expect(snapToWater(g, here, p)).toEqual({ col: 2, row: 2, moved: false })
  })

  it('moves a fix taken on land to the nearest water and says that it did', () => {
    const g = gridFromAscii([
      '.....',
      '.....',
      '..#..',
      '.....',
      '.....',
    ])
    const p = passability(g, 0, 1.5)
    const onLand = toLatLon(g, 2, 2)
    const snapped = snapToWater(g, onLand, p)
    expect(snapped?.moved).toBe(true)
    expect(g.cells[(snapped as { row: number; col: number }).row * g.cols + (snapped as { col: number }).col]).toBe(1)
  })

  it('gives up rather than teleporting when there is no water within reach', () => {
    const g = gridFromAscii(Array(9).fill('#########'), 200)
    const p = passability(g, 0, 1.5)
    expect(snapToWater(g, toLatLon(g, 4, 4), p)).toBeNull()
  })
})

/* -------------------------------------------------------------------------
 * Depth along a leg
 * ---------------------------------------------------------------------- */

describe('legMinDepth', () => {
  it('reports the shoalest cell the leg crosses, not the average', () => {
    const g = gridFromAscii(Array(5).fill('.....'))
    g.depth[2 * 5 + 2] = 1.1
    const a = toLatLon(g, 0, 2)
    const b = toLatLon(g, 4, 2)
    expect(legMinDepth(g, a, b)).toBeCloseTo(1.1, 5)
  })

  it('is null where nothing at all is charted', () => {
    const g = gridFromAscii(['?????', '?????', '?????'])
    expect(legMinDepth(g, toLatLon(g, 0, 1), toLatLon(g, 4, 1))).toBeNull()
  })
})

/* -------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------- */

describe('routeBounds', () => {
  it('always contains both endpoints', () => {
    const from = { lat: 29.3, lon: -94.8 }
    const to = { lat: 29.45, lon: -94.6 }
    const b = routeBounds(from, to)
    expect(b.minLat).toBeLessThan(from.lat)
    expect(b.maxLat).toBeGreaterThan(to.lat)
    expect(b.minLon).toBeLessThan(from.lon)
    expect(b.maxLon).toBeGreaterThan(to.lon)
  })

  it('gives a short hop at least a nautical mile of room to manoeuvre', () => {
    const from = { lat: 29.3, lon: -94.8 }
    const to = { lat: 29.301, lon: -94.8 }
    const b = routeBounds(from, to)
    const mpd = metersPerDegree(29.3)
    expect(((b.maxLat - to.lat) * mpd.lat)).toBeGreaterThanOrEqual(NM_TO_METERS - 1)
  })
})

/* -------------------------------------------------------------------------
 * planRoute — the whole thing
 * ---------------------------------------------------------------------- */

/**
 * Deep water everywhere, with a shoal bar reaching out from the west shore and
 * a navigable channel left along the east side of the box. The direct line
 * crosses the bar, so a boat that needs the depth has to use the channel.
 */
function barChart(
  g: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  barDepthM = 0.3,
): ChartFeatures {
  return {
    depthAreas: [
      { minDepthM: 12, rings: [boxRing(g.minLat, g.minLon, g.maxLat, g.maxLon)] },
      {
        minDepthM: barDepthM,
        rings: [boxRing(BAR_SOUTH, g.minLon, BAR_NORTH, channelWest(g))],
      },
    ],
    channels: [],
    land: [],
    hazards: [],
    coverage: 'full',
  }
}

const BAR_SOUTH = 29.315
const BAR_NORTH = 29.325

/** East edge of the bar — everything east of this is the open channel. */
function channelWest(g: { maxLon: number }): number {
  return g.maxLon - 0.008
}

describe('planRoute', () => {
  const from = { lat: 29.30, lon: -94.82 }
  const to = { lat: 29.34, lon: -94.82 }

  it('routes round a bar instead of straight over it', () => {
    const b = routeBounds(from, to)
    // A bar across the direct line, open water to the east of -94.80.
    const features = barChart(b)
    const plan = planRoute({
      from,
      to,
      safeDepthM: 1.5,
      clearanceM: 0,
      speedKn: 20,
      features,
    })

    expect(plan.source).toBe('charted')
    const directNM = haversineNM(from.lat, from.lon, to.lat, to.lon)
    expect(plan.totalNM).toBeGreaterThan(directNM)
    // It must come out east of the bar's edge to get round it.
    expect(Math.max(...plan.points.map((p) => p.lon))).toBeGreaterThan(channelWest(b))
    // And no leg may cross water shoaler than the boat needs.
    for (const leg of plan.legs) {
      expect(leg.minChartedDepthM === null || leg.minChartedDepthM >= 1.5).toBe(true)
    }
  })

  it('runs straight when the water is deep the whole way', () => {
    const b = routeBounds(from, to)
    const features: ChartFeatures = {
      depthAreas: [
        { minDepthM: 12, rings: [boxRing(b.minLat, b.minLon, b.maxLat, b.maxLon)] },
      ],
      channels: [],
      land: [],
      hazards: [],
      coverage: 'full',
    }
    const plan = planRoute({
      from,
      to,
      safeDepthM: 1.5,
      clearanceM: 0,
      speedKn: 20,
      features,
    })
    expect(plan.source).toBe('charted')
    expect(plan.points).toHaveLength(2)
    const directNM = haversineNM(from.lat, from.lon, to.lat, to.lon)
    expect(plan.totalNM).toBeCloseTo(directNM, 2)
  })

  it('lets a shallower boat take the direct line the deep one could not', () => {
    const b = routeBounds(from, to)
    // A bar with 1.0 m over it: fine for a 0.8 m need, not for 1.5 m.
    const features = barChart(b, 1.0)
    const deep = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features })
    const shallow = planRoute({ from, to, safeDepthM: 0.8, clearanceM: 0, speedKn: 20, features })
    expect(shallow.totalNM).toBeLessThan(deep.totalNM)
    expect(shallow.points).toHaveLength(2)
  })

  it('refuses to route through unsurveyed water', () => {
    const b = routeBounds(from, to)
    // Deep water only in two patches, nothing charted in between.
    const features: ChartFeatures = {
      depthAreas: [
        { minDepthM: 12, rings: [boxRing(b.minLat, b.minLon, 29.315, b.maxLon)] },
        { minDepthM: 12, rings: [boxRing(29.325, b.minLon, b.maxLat, b.maxLon)] },
      ],
      channels: [],
      land: [],
      hazards: [],
      coverage: 'full',
    }
    const plan = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features })
    expect(plan.source).toBe('straight')
    expect(plan.warnings.join(' ')).toMatch(/no charted route/i)
  })

  it('says so plainly when there is no chart data at all', () => {
    const plan = planRoute({
      from,
      to,
      safeDepthM: 1.5,
      clearanceM: 0,
      speedKn: 20,
      features: { depthAreas: [], channels: [], land: [], hazards: [], coverage: 'none' },
    })
    expect(plan.source).toBe('straight')
    expect(plan.points).toEqual([from, to])
    expect(plan.warnings.join(' ')).toMatch(/no charted depths/i)
  })

  it('will not plot a course to a destination on land', () => {
    const b = routeBounds(from, to)
    const features: ChartFeatures = {
      depthAreas: [
        { minDepthM: 12, rings: [boxRing(b.minLat, b.minLon, b.maxLat, b.maxLon)] },
      ],
      channels: [],
      land: [boxRing(29.33, -94.83, 29.35, -94.81)].map((r) => ({ rings: [r] })),
      hazards: [],
      coverage: 'full',
    }
    const plan = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features })
    expect(plan.source).toBe('straight')
    expect(plan.warnings.join(' ')).toMatch(/on land or too shallow/i)
  })

  it('warns when the chart query was cut short', () => {
    const b = routeBounds(from, to)
    const features: ChartFeatures = {
      depthAreas: [
        { minDepthM: 12, rings: [boxRing(b.minLat, b.minLon, b.maxLat, b.maxLon)] },
      ],
      channels: [],
      land: [],
      hazards: [],
      coverage: 'partial',
    }
    const plan = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features })
    expect(plan.warnings.join(' ')).toMatch(/hit its limit/i)
  })

  it('totals the legs and the clock consistently', () => {
    const b = routeBounds(from, to)
    const features = barChart(b)
    const plan = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 10, features })
    const summed = plan.legs.reduce((a, l) => a + l.lengthNM, 0)
    expect(summed).toBeCloseTo(plan.totalNM, 6)
    expect(plan.hours).toBeCloseTo(plan.totalNM / 10, 6)
    // The last leg's ETA is the whole passage.
    expect(plan.legs[plan.legs.length - 1].etaHours).toBeCloseTo(plan.hours, 6)
    expect(plan.legs).toHaveLength(plan.points.length - 1)
  })

  it('keeps the stand-off the coxswain asked for', () => {
    const b = routeBounds(from, to)
    const features = barChart(b)
    const wide = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 200, speedKn: 20, features })
    const tight = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features })
    expect(wide.totalNM).toBeGreaterThan(tight.totalNM)
  })
})

/* -------------------------------------------------------------------------
 * Marked channels
 *
 * A marked channel is a dredged area or a fairway: water that has been
 * surveyed to a depth and is maintained, swept and buoyed to it. Open water
 * that merely charts deep enough is none of those things, which is why a
 * course prefers the channel even when it is longer.
 * ---------------------------------------------------------------------- */

describe('chamferDistance', () => {
  it('treats what lies beyond the grid as the caller says', () => {
    // The clearance transform wants the edge to be a source — a route that
    // leaves the box is a route through water nobody looked at. The channel
    // transform wants the opposite: nothing outside the box is known to be
    // marked water, and counting the edge as a channel would cheapen every
    // cell near it.
    const g = gridFromAscii(['...', '...', '...'])
    const edgeIsSource = new Float32Array(9)
    const edgeIsNothing = new Float32Array(9)
    const centreOnly = (i: number) => i === 4

    chamferDistance(3, 3, centreOnly, 0, edgeIsSource)
    chamferDistance(3, 3, centreOnly, Infinity, edgeIsNothing)

    expect(edgeIsSource[0]).toBeLessThan(edgeIsNothing[0])
    expect(edgeIsSource[4]).toBe(0)
    expect(edgeIsNothing[4]).toBe(0)
    expect(g.cols).toBe(3)
  })
})

describe('channelPenalty', () => {
  it('charges nothing inside a channel, and nothing at all where none is charted', () => {
    // A route must never be charged for being exactly where it belongs, and
    // nothing may change on the great majority of the coast that has no
    // dredged area or fairway charted on it.
    const marked = gridFromAscii(['==.', '==.', '==.'])
    const p = passability(marked, 0, 1.5)
    expect(channelPenalty(marked, 0, p)).toBe(0)
    expect(channelPenalty(marked, 2, p)).toBeGreaterThan(0)

    const bare = gridFromAscii(['...', '...', '...'])
    const bp = passability(bare, 0, 1.5)
    expect(bare.hasChannels).toBe(false)
    for (let i = 0; i < 9; i++) expect(channelPenalty(bare, i, bp)).toBe(0)
  })

  it('saturates rather than growing without limit', () => {
    // An unbounded cost far from the channel would swamp the octile heuristic
    // and turn a 60 ms plot into a Dijkstra sweep of a quarter-million cells.
    const g = gridFromAscii([
      '=..........',
      '=..........',
      '=..........',
    ])
    const p = passability(g, 0, 1.5)
    // Five cells out and ten cells out are both well past the fade distance,
    // so they must cost exactly the same rather than the further one costing
    // twice as much.
    const near = channelPenalty(g, 5, p)
    const far = channelPenalty(g, 10, p)
    expect(near).toBeGreaterThan(0)
    expect(far).toBeCloseTo(near, 10)
  })

  it('costs less over water that is amply deep than over water that only just clears', () => {
    // This is the whole of "stay in the channel until there is a clear, deep
    // enough unobstructed path". ':' charts 1.7 m, which clears a 1.5 m boat
    // and nothing more; '.' charts 10 m.
    const g = gridFromAscii(['=.:', '=.:', '=.:'])
    const p = passability(g, 0, 1.5)
    const ample = channelPenalty(g, 1, p)
    const thin = channelPenalty(g, 2, p)
    expect(ample).toBeGreaterThan(0)
    expect(thin).toBeGreaterThan(ample)
  })
})

describe('astar with a marked channel', () => {
  it('rides a channel rather than the shorter open-water line', () => {
    // The channel runs down column 1 and dog-legs across row 4 to column 5.
    // Straight down column 5 is shorter, and charts deep enough for the boat
    // — but it is not dredged, not swept and not buoyed.
    const g = gridFromAscii([
      '=:::::',
      '=:::::',
      '=:::::',
      '=:::::',
      '======',
    ])
    const p = passability(g, 0, 1.5)
    const path = astar(g, { col: 0, row: 0 }, { col: 5, row: 4 }, p)
    expect(path).not.toBeNull()
    for (const c of path ?? []) {
      expect(g.channel[c.row * g.cols + c.col]).toBe(1)
    }
  })

  it('takes the open-water line when that water is amply deep', () => {
    // Same shape, but the water off the channel is 10 m rather than 1.7 m.
    // A preference that ignored genuinely good water would be a nuisance a
    // crew learns to route around by hand, so this is the escape clause.
    const g = gridFromAscii([
      '=.....',
      '=.....',
      '=.....',
      '=.....',
      '======',
    ])
    const p = passability(g, 0, 1.5)
    const path = astar(g, { col: 0, row: 0 }, { col: 5, row: 4 }, p)
    expect(path).not.toBeNull()
    const outside = (path ?? []).filter(
      (c) => g.channel[c.row * g.cols + c.col] !== 1,
    )
    expect(outside.length).toBeGreaterThan(0)
  })

  it('leaves the channel to reach a destination outside it', () => {
    // A strong preference is not a prison. A course that could not reach a
    // dock because the dock is not dredged would be useless.
    const g = gridFromAscii([
      '===..',
      '===..',
      '===..',
    ])
    const p = passability(g, 0, 1.5)
    const path = astar(g, { col: 0, row: 1 }, { col: 4, row: 1 }, p)
    expect(path).not.toBeNull()
    expect(path?.[path.length - 1]).toEqual({ col: 4, row: 1 })
  })

  it('will not leave a narrow channel merely to stop shaving its bank', () => {
    // The invariant that makes "stay in the channel" true rather than
    // approximately true: the worst cell inside a channel must stay cheaper
    // than the best cell outside one in water that only just clears the boat.
    // Here the channel is one cell wide, so every cell in it carries the full
    // bank-edge cost, and there is wide thin water alongside.
    // The channel is one cell wide against a wall, so every cell in it pays
    // the full bank-edge cost, and its dog-leg is LONGER than cutting the
    // corner through the thin water alongside. It must still be chosen.
    const g = gridFromAscii([
      '#=::::',
      '#=::::',
      '#=::::',
      '#=====',
    ])
    const p = passability(g, 0, 1.5)
    const path = astar(g, { col: 1, row: 0 }, { col: 5, row: 3 }, p)
    expect(path).not.toBeNull()
    for (const c of path ?? []) {
      expect(g.channel[c.row * g.cols + c.col]).toBe(1)
    }
  })
})

describe('stringPull with a marked channel', () => {
  it('keeps the dog-leg of a channel whose chord is open water', () => {
    // The shortest line between two points in a channel is very often not in
    // the channel. Without the budget the smoother would undo, in its last
    // pass, every bit of seamanship A* had just paid for.
    const g = gridFromAscii([
      '=:::::',
      '=:::::',
      '=:::::',
      '=:::::',
      '======',
    ])
    const p = passability(g, 0, 1.5)
    const path = astar(g, { col: 0, row: 0 }, { col: 5, row: 4 }, p)
    expect(path).not.toBeNull()
    const pulled = stringPull(g, path ?? [], p)
    for (let i = 1; i < pulled.length; i++) {
      expect(chordOutsideChannel(g, pulled[i - 1], pulled[i], p)).toBe(0)
    }
  })

  it('still collapses a staircase that stays inside the channel', () => {
    // The constraint must not cost a coxswain turn points they do not need.
    const g = gridFromAscii([
      '=====',
      '=====',
      '=====',
    ])
    const p = passability(g, 0, 1.5)
    const staircase = [
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 1 },
      { col: 3, row: 1 },
      { col: 4, row: 2 },
    ]
    expect(stringPull(g, staircase, p).length).toBe(2)
  })
})

describe('chordOutsideChannel', () => {
  it('agrees with lineOfSight about what is clear, and counts what is outside', () => {
    // One walk, two answers. The visibility test and the smoother must never
    // be able to disagree about what a line crosses.
    const g = gridFromAscii([
      '==..',
      '==..',
      '##..',
    ])
    const p = passability(g, 0, 1.5)
    const a = { col: 0, row: 0 }
    const clear = { col: 3, row: 0 }
    const blocked = { col: 0, row: 2 }

    expect(chordOutsideChannel(g, a, clear, p)).toBe(2)
    expect(lineOfSight(g, a, clear, p)).toBe(true)
    expect(chordOutsideChannel(g, a, blocked, p)).toBeNull()
    expect(lineOfSight(g, a, blocked, p)).toBe(false)
  })
})

describe('legChannelFraction', () => {
  it('is null where nothing is marked, and a fraction where something is', () => {
    // "There is no channel here" and "this leg is outside the channel" are
    // different facts, and a crew must not read the first as the second.
    const bare = gridFromAscii(['...', '...', '...'])
    expect(
      legChannelFraction(bare, toLatLon(bare, 0, 1), toLatLon(bare, 2, 1)),
    ).toBeNull()

    const marked = gridFromAscii(['===', '===', '==='])
    expect(
      legChannelFraction(marked, toLatLon(marked, 0, 1), toLatLon(marked, 2, 1)),
    ).toBe(1)
  })
})

/* -------------------------------------------------------------------------
 * planRoute with a marked channel
 * ---------------------------------------------------------------------- */

/**
 * Water everywhere at `surroundDepthM`, with a dredged channel that runs north
 * up the west side and then dog-legs east. Staying in it is about half again
 * as far as the direct line — which is the point: a marked channel is dredged,
 * swept and buoyed, and open water that merely charts deep enough is none of
 * those.
 */
function channelChart(
  g: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  surroundDepthM: number,
): ChartFeatures {
  const legWest = -94.83
  const legEast = -94.81
  const dogLegSouth = 29.335
  const dogLegNorth = 29.345
  const rings = [
    boxRing(29.295, legWest, dogLegNorth, -94.825),
    boxRing(dogLegSouth, legWest, dogLegNorth, legEast),
  ]
  return {
    depthAreas: [
      {
        minDepthM: surroundDepthM,
        rings: [boxRing(g.minLat, g.minLon, g.maxLat, g.maxLon)],
      },
    ],
    channels: rings.map((r) => ({ kind: 'dredged' as const, rings: [r] })),
    land: [],
    hazards: [],
    coverage: 'full',
  }
}

describe('planRoute with a marked channel', () => {
  const from = { lat: 29.30, lon: -94.82 }
  const to = { lat: 29.34, lon: -94.82 }
  const boat = { safeDepthM: 1.5, clearanceM: 0, speedKn: 20 }

  it('rides the channel when the water around it only just clears the boat', () => {
    const b = routeBounds(from, to)
    const plan = planRoute({ from, to, ...boat, features: channelChart(b, 1.7) })

    expect(plan.source).toBe('charted')
    const directNM = haversineNM(from.lat, from.lon, to.lat, to.lon)
    expect(plan.totalNM).toBeGreaterThan(directNM)
    // Most of the course is inside marked water; what is not is the run off
    // each end to the points the crew actually asked for.
    expect(plan.outsideChannelNM).not.toBeNull()
    expect(plan.outsideChannelNM!).toBeLessThan(plan.totalNM / 2)
  })

  it('runs direct when the water around the channel is amply deep', () => {
    // The same fixture with only the surrounding depth changed. This is the
    // pair that proves both levels are reachable with one set of constants.
    const b = routeBounds(from, to)
    const plan = planRoute({ from, to, ...boat, features: channelChart(b, 12) })

    expect(plan.source).toBe('charted')
    const directNM = haversineNM(from.lat, from.lon, to.lat, to.lon)
    expect(plan.totalNM).toBeLessThan(directNM * 1.1)
  })

  it('says out loud when the course runs outside marked water', () => {
    const b = routeBounds(from, to)
    const plan = planRoute({ from, to, ...boat, features: channelChart(b, 12) })
    expect(plan.warnings.join(' ')).toMatch(/outside the marked channel/i)
  })

  it('reports no channel at all rather than "outside the channel"', () => {
    // "There is nothing marked here" must never be rendered as "you have left
    // the channel".
    const b = routeBounds(from, to)
    const features = channelChart(b, 12)
    features.channels = []
    const plan = planRoute({ from, to, ...boat, features })

    expect(plan.outsideChannelNM).toBeNull()
    for (const leg of plan.legs) expect(leg.channelFraction).toBeNull()
    expect(plan.warnings.join(' ')).not.toMatch(/outside the marked channel/i)
  })

  it('still plots a course when the only charted channel is nowhere near', () => {
    // A channel somewhere else in the box is not a reason to refuse: the
    // planner never hands back nothing.
    const b = routeBounds(from, to)
    const features = channelChart(b, 12)
    features.channels = [
      { kind: 'fairway', rings: [boxRing(b.minLat, b.minLon, b.minLat + 0.002, b.minLon + 0.002)] },
    ]
    const plan = planRoute({ from, to, ...boat, features })
    expect(plan.source).toBe('charted')
    expect(plan.points.length).toBeGreaterThanOrEqual(2)
  })

  it('goes round a charted pile instead of through it', () => {
    // A pile is a fixed structure; hitting one at speed ends the mission.
    const b = routeBounds(from, to)
    const clear = channelChart(b, 12)
    clear.channels = []
    const withPile: ChartFeatures = {
      ...clear,
      hazards: [
        { lat: 29.32, lon: -94.82, radiusM: 60, kind: 'pile', label: 'pile' },
      ],
    }

    const straight = planRoute({ from, to, ...boat, features: clear })
    const round = planRoute({ from, to, ...boat, features: withPile })

    expect(round.source).toBe('charted')
    expect(round.totalNM).toBeGreaterThan(straight.totalNM)
  })
})
