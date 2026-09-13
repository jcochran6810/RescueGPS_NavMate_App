import { describe, it, expect } from 'vitest'
import { haversineNM, metersPerDegree, NM_TO_METERS } from './geo'
import {
  astar,
  chamferClearance,
  fillRings,
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

/** '.' navigable, '#' blocked, '?' unsurveyed. Row 0 is the north edge. */
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
  }
  for (let row = 0; row < r; row++) {
    for (let col = 0; col < c; col++) {
      const ch = rows[row][col]
      const i = row * c + col
      g.cells[i] = ch === '.' ? 1 : ch === '#' ? 2 : 0
      g.depth[i] = ch === '.' ? 10 : ch === '#' ? 0.5 : NaN
    }
  }
  chamferClearance(g)
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
      { depthAreas: [{ minDepthM: 1.2, rings: [whole] }], land: [], hazards: [], coverage: 'full' },
      1.5,
    )
    expect(g.cells[0]).toBe(2)

    const g2 = makeGrid(from, to)
    rasterise(
      g2,
      { depthAreas: [{ minDepthM: 2.0, rings: [whole] }], land: [], hazards: [], coverage: 'full' },
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
        land: [],
        hazards: [{ ...mid, radiusM: g.cellM * 2, label: 'wreck' }],
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
    const none = passability(g, 0)
    const oneCell = passability(g, CELL_M)
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
    const p = passability(g, 0)
    expect(passable(g, 1 * 5 + 2, p)).toBe(false)
  })
})

/* -------------------------------------------------------------------------
 * Line of sight
 * ---------------------------------------------------------------------- */

describe('lineOfSight', () => {
  it('sees straight across open water', () => {
    const g = gridFromAscii(Array(10).fill('..........'))
    const p = passability(g, 0)
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
    const p = passability(g, 0)
    expect(lineOfSight(g, { col: 2, row: 0 }, { col: 2, row: 4 }, p)).toBe(false)
  })

  it('refuses to squeeze diagonally between two rocks that touch at a corner', () => {
    const g = gridFromAscii([
      '.#.',
      '#..',
      '...',
    ])
    const p = passability(g, 0)
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
    const p = passability(g, 0)
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
    const p = passability(g, 0)
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
    const p = passability(g, 0)
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
    const p = passability(g, 0)
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
    const p = passability(g, 0)
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
    const p = passability(g, 0)
    expect(astar(g, { col: 0, row: 0 }, { col: 2, row: 2 }, p)).toBeNull()
  })
})

/* -------------------------------------------------------------------------
 * String pulling
 * ---------------------------------------------------------------------- */

describe('stringPull', () => {
  it('reduces a staircase across open water to a single leg', () => {
    const g = gridFromAscii(Array(10).fill('..........'))
    const p = passability(g, 0)
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
    const p = passability(g, 0)
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
    const p = passability(g, 0)
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
    const p = passability(g, 0)
    const onLand = toLatLon(g, 2, 2)
    const snapped = snapToWater(g, onLand, p)
    expect(snapped?.moved).toBe(true)
    expect(g.cells[(snapped as { row: number; col: number }).row * g.cols + (snapped as { col: number }).col]).toBe(1)
  })

  it('gives up rather than teleporting when there is no water within reach', () => {
    const g = gridFromAscii(Array(9).fill('#########'), 200)
    const p = passability(g, 0)
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
      features: { depthAreas: [], land: [], hazards: [], coverage: 'none' },
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
