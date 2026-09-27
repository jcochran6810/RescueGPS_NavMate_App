import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { haversineNM, metersPerDegree, NM_TO_METERS } from './geo'
import {
  astar,
  chamferDistance,
  channelPenalty,
  chordOutsideChannel,
  describeUnusable,
  fillRings,
  formatDepth,
  formatLength,
  legChannelFraction,
  legMinDepth,
  lineOfSight,
  makeGrid,
  passability,
  passable,
  planningBounds,
  planRoute,
  prepareGrid,
  rasterise,
  routeBounds,
  snapToWater,
  stringPull,
  toGrid,
  toLatLon,
  type ChartFeatures,
  type RouteGrid,
  type RoutePlan,
  type Ring,
} from './routing'
import type { LatLon } from './search'

/* -------------------------------------------------------------------------
 * Helpers — an ASCII chart, so the expected answer can be read off the page
 * ---------------------------------------------------------------------- */

const CELL_M = 100
const BASE_LAT = 29.3
const BASE_LON = -94.8

/**
 * One character per cell, row 0 the north edge:
 *
 *   '.' navigable, 10 m          '=' navigable, 10 m, inside a marked channel
 *   ':' 1.7 m — clears a 1.5 m boat and nothing more
 *   '~' 0.5 m — too shallow      '#' land (or a structure charted as land)
 *   'x' a hazard's footprint     '?' unsurveyed
 *
 * The depths are what the two-level channel penalty reads: '.' and '=' are
 * amply clear of any boat in these tests, ':' only just clears a 1.5 m one.
 */
function gridFromAscii(rows: string[], cellM = CELL_M): RouteGrid {
  const r = rows.length
  const c = rows[0].length
  const mpd = metersPerDegree(BASE_LAT)
  const latPerRow = cellM / mpd.lat
  const lonPerCol = cellM / mpd.lon
  const n = r * c
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
    cells: new Uint8Array(n),
    depth: new Float32Array(n).fill(NaN),
    unknown: new Uint8Array(n),
    hard: new Uint8Array(n),
    clearCells: new Float32Array(n),
    shoalCells: new Float32Array(n),
    cDepth: new Float32Array(n).fill(NaN),
    cHard: new Uint8Array(n),
    cClear: new Float32Array(n),
    channel: new Uint8Array(n),
    channelDist: new Float32Array(n).fill(Infinity),
    hasChannels: false,
  }
  const depthOf: Record<string, number> = { '.': 10, '=': 10, ':': 1.7, '~': 0.5, '#': 0, x: 10 }
  for (let row = 0; row < r; row++) {
    for (let col = 0; col < c; col++) {
      const ch = rows[row][col]
      const i = row * c + col
      if (ch === '?') {
        g.unknown[i] = 1
        continue
      }
      g.depth[i] = depthOf[ch]
      g.cDepth[i] = depthOf[ch]
      if (ch === '#') g.hard[i] = g.cHard[i] = 1
      if (ch === 'x') g.hard[i] = g.cHard[i] = 2
      if (ch === '=') {
        g.channel[i] = 1
        g.hasChannels = true
      }
    }
  }
  prepareGrid(g, 1.5)
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
 * Helpers — a chart in metres, for the whole-planner scenarios
 * ---------------------------------------------------------------------- */

const MPD = metersPerDegree(BASE_LAT)

/** A position `x` m east and `y` m north of (BASE_LAT, BASE_LON). */
function at(x: number, y: number): LatLon {
  return { lat: BASE_LAT + y / MPD.lat, lon: BASE_LON + x / MPD.lon }
}

function ll(x: number, y: number): [number, number] {
  const p = at(x, y)
  return [p.lon, p.lat]
}

/** A closed rectangle in metres. */
function rect(x0: number, y0: number, x1: number, y1: number): Ring {
  return [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)]
}

/** Metres east / north of the base, for reading a plan's points. */
function xy(p: LatLon): { x: number; y: number } {
  return { x: (p.lon - BASE_LON) * MPD.lon, y: (p.lat - BASE_LAT) * MPD.lat }
}

/** 10 m of water everywhere the planner could possibly look. */
function sea(extra: Partial<ChartFeatures> = {}): ChartFeatures {
  return {
    depthAreas: [{ minDepthM: 10, rings: [rect(-12000, -12000, 12000, 12000)] }],
    channels: [],
    land: [],
    hazards: [],
    lines: [],
    coverage: 'full',
    ...extra,
  }
}

const SOUTH = at(0, -1500)
const NORTH = at(0, 1500)

/* -------------------------------------------------------------------------
 * The independent check
 *
 * Everything the planner promises about a leg, re-measured from the raw
 * features with nothing shared with the planner: its own point-in-polygon,
 * its own finest-chart-wins, its own distances. Sampling every couple of
 * metres along each leg, plus rings of points at the stand-off around them.
 * A leg the planner calls `ok` or `shallow-approach` must pass all of it.
 * ---------------------------------------------------------------------- */

const boxes = new WeakMap<Ring[], [number, number, number, number]>()

function bboxOf(rings: Ring[]): [number, number, number, number] {
  let b = boxes.get(rings)
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity]
    for (const r of rings) {
      for (const [lon, lat] of r) {
        b[0] = Math.min(b[0], lon)
        b[1] = Math.min(b[1], lat)
        b[2] = Math.max(b[2], lon)
        b[3] = Math.max(b[3], lat)
      }
    }
    boxes.set(rings, b)
  }
  return b
}

function inRings(rings: Ring[], lon: number, lat: number): boolean {
  const b = bboxOf(rings)
  if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) return false
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > lat !== yj > lat && lon < xi + ((lat - yi) * (xj - xi)) / (yj - yi)) {
        inside = !inside
      }
    }
  }
  return inside
}

/** Finest chart wins; land over depth within a chart; NaN unsurveyed; −∞ land. */
function bruteState(f: ChartFeatures, lat: number, lon: number): number {
  let level = -Infinity
  let land = false
  let depth = Infinity
  for (const p of f.depthAreas) {
    if (!Number.isFinite(p.minDepthM) || !inRings(p.rings, lon, lat)) continue
    const l = p.level ?? 0
    if (l > level) {
      level = l
      land = false
      depth = p.minDepthM
    } else if (l === level) depth = Math.min(depth, p.minDepthM)
  }
  for (const p of f.land) {
    if (p.hazard || !inRings(p.rings, lon, lat)) continue
    const l = p.level ?? 0
    if (l > level) {
      level = l
      land = true
    } else if (l === level) land = true
  }
  if (level === -Infinity) return NaN
  return land ? -Infinity : depth
}

function metresBetween(a: LatLon, b: LatLon): number {
  return haversineNM(a.lat, a.lon, b.lat, b.lon) * NM_TO_METERS
}

/** Distance from p to segment a–b, metres, in a local flat frame at p. */
function toSegmentM(p: LatLon, a: LatLon, b: LatLon): number {
  const m = metersPerDegree(p.lat)
  const ax = (a.lon - p.lon) * m.lon
  const ay = (a.lat - p.lat) * m.lat
  const bx = (b.lon - p.lon) * m.lon
  const by = (b.lat - p.lat) * m.lat
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0
  return Math.hypot(ax + t * dx, ay + t * dy)
}

interface Rules {
  safeDepthM: number
  clearanceM: number
  approachM?: number
  /** Sampling step along a leg, metres. */
  stepM?: number
  /** How often to sample a ring of points at the stand-off, metres. */
  ringEveryM?: number
}

/** Everything wrong with the legs the plan did NOT flag. Empty is good. */
function independentCheck(plan: RoutePlan, f: ChartFeatures, rules: Rules): string[] {
  const out: string[] = []
  const approach = rules.approachM ?? 120
  const step = rules.stepM ?? 2
  const ringEvery = rules.ringEveryM ?? 10
  const c = rules.clearanceM
  const start = plan.points[0]
  const end = plan.points[plan.points.length - 1]
  const tol = 0.05 + c * 0.001
  plan.legs.forEach((leg, li) => {
    if (leg.caution !== 'ok' && leg.caution !== 'shallow-approach') return
    const len = metresBetween(leg.from, leg.to)
    const n = Math.max(1, Math.ceil(len / step))
    let sinceRing = Infinity
    for (let k = 0; k <= n; k++) {
      const t = k / n
      const p = {
        lat: leg.from.lat + (leg.to.lat - leg.from.lat) * t,
        lon: leg.from.lon + (leg.to.lon - leg.from.lon) * t,
      }
      const zoned =
        metresBetween(p, start) <= approach + 0.5 || metresBetween(p, end) <= approach + 0.5
      const s = bruteState(f, p.lat, p.lon)
      const where = `leg ${li + 1} at ${(t * len).toFixed(0)} m`
      if (s === -Infinity) out.push(`${where}: on land`)
      else if (!zoned && !(s >= rules.safeDepthM)) out.push(`${where}: ${s} m of water`)
      const need = zoned ? 0 : c
      for (const h of f.hazards) {
        const d = metresBetween(p, h) - h.radiusM
        if (d < -tol || d < need - tol) out.push(`${where}: ${d.toFixed(1)} m from a ${h.kind}`)
      }
      for (const l of f.lines ?? []) {
        for (const path of l.paths) {
          for (let i = 1; i < path.length; i++) {
            const a = { lon: path[i - 1][0], lat: path[i - 1][1] }
            const b = { lon: path[i][0], lat: path[i][1] }
            const d = toSegmentM(p, a, b) - l.widthM / 2
            if (d < -tol || d < need - tol) out.push(`${where}: ${d.toFixed(1)} m from a ${l.label}`)
          }
        }
      }
      for (const a of f.land) {
        if (a.hazard && inRings(a.rings, p.lon, p.lat)) out.push(`${where}: inside an area hazard`)
      }
      sinceRing += len / n
      if (!zoned && c > 0 && sinceRing >= ringEvery) {
        sinceRing = 0
        const m = metersPerDegree(p.lat)
        for (const r of [c - 1, c / 2]) {
          if (r <= 0) continue
          for (let d = 0; d < 16; d++) {
            const th = (d * Math.PI) / 8
            const q = {
              lat: p.lat + (r * Math.sin(th)) / m.lat,
              lon: p.lon + (r * Math.cos(th)) / m.lon,
            }
            if (bruteState(f, q.lat, q.lon) === -Infinity) {
              out.push(`${where}: land ${r.toFixed(0)} m away, inside the ${c} m stand-off`)
            }
          }
        }
      }
    }
  })
  return out
}

/** No stub legs, no turns too small to steer. */
function expectTidy(plan: RoutePlan): void {
  for (const leg of plan.legs) {
    expect(metresBetween(leg.from, leg.to)).toBeGreaterThanOrEqual(20)
  }
  for (let i = 1; i < plan.legs.length; i++) {
    let turn = Math.abs(plan.legs[i].courseDeg - plan.legs[i - 1].courseDeg) % 360
    if (turn > 180) turn = 360 - turn
    expect(turn).toBeGreaterThanOrEqual(3)
  }
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
  const from = { lat: 29.3, lon: -94.8 }
  const to = { lat: 29.32, lon: -94.78 }
  /**
   * A ring well beyond the grid. The grid is conservative: a cell with any
   * part of it outside every chart is part-unsurveyed, so a ring drawn
   * exactly on the grid's own edge would (rightly) mark the edge cells
   * unknown. These tests are about the cells well inside.
   */
  const around = (g: RouteGrid): Ring =>
    boxRing(g.minLat - 0.01, g.minLon - 0.01, g.maxLat + 0.01, g.maxLon + 0.01)
  const mid = (g: RouteGrid) => Math.floor(g.rows / 2) * g.cols + Math.floor(g.cols / 2)

  it('marks water shoaler than the boat needs as blocked, and deeper as open', () => {
    const g = makeGrid(from, to)
    rasterise(
      g,
      { depthAreas: [{ minDepthM: 1.2, rings: [around(g)] }], channels: [], land: [], hazards: [], coverage: 'full' },
      1.5,
    )
    expect(g.cells[0]).toBe(2)

    const g2 = makeGrid(from, to)
    rasterise(
      g2,
      { depthAreas: [{ minDepthM: 2.0, rings: [around(g2)] }], channels: [], land: [], hazards: [], coverage: 'full' },
      1.5,
    )
    expect(g2.cells[0]).toBe(1)
  })

  it('marks the edge of the charted area as part-unsurveyed', () => {
    // Behaviour change, on purpose: the grid used to sample cell centres
    // only, so a cell half outside every chart read as fully charted.
    const g = makeGrid(from, to)
    const inner = boxRing(
      g.minLat + 10 * g.latPerRow + g.latPerRow / 4,
      g.minLon,
      g.maxLat,
      g.maxLon,
    )
    rasterise(g, { depthAreas: [{ minDepthM: 5, rings: [inner] }], channels: [], land: [], hazards: [], coverage: 'full' }, 1.5)
    const straddling = (g.rows - 11) * g.cols + 5
    expect(g.unknown[straddling]).toBe(1)
    expect(g.cells[straddling]).toBe(0)
    expect(g.cDepth[straddling]).toBe(5)
  })

  it('keeps the shoalest reading where two depth areas overlap', () => {
    const g = makeGrid(from, to)
    rasterise(
      g,
      {
        depthAreas: [
          { minDepthM: 9, rings: [around(g)] },
          { minDepthM: 0.6, rings: [around(g)] },
        ],
        channels: [],
        land: [],
        hazards: [],
        coverage: 'full',
      },
      1.5,
    )
    expect(g.depth[mid(g)]).toBeCloseTo(0.6, 5)
    expect(g.cells[mid(g)]).toBe(2)
  })

  it('lets a finer chart open water a coarser chart drew as land', () => {
    // Galveston, for real: the coastal band draws the Galveston Channel as
    // part of the island, the harbour band charts it at 9 m. Shoalest-wins
    // across scales put the start "on land, 1.29 NM from usable water" and
    // drew a straight line. The most detailed chart speaks for its cells.
    const g = makeGrid(from, to)
    rasterise(
      g,
      {
        depthAreas: [
          { minDepthM: 0.5, rings: [around(g)], level: 1 },
          { minDepthM: 9, rings: [around(g)], level: 3 },
        ],
        channels: [],
        land: [{ rings: [around(g)], level: 1 }],
        hazards: [],
        coverage: 'full',
      },
      1.5,
    )
    expect(g.depth[mid(g)]).toBeCloseTo(9, 5)
    expect(g.cells[mid(g)]).toBe(1)
    expect(g.hard[mid(g)]).toBe(0)
  })

  it('lets a finer chart close water a coarser chart called deep', () => {
    // The rule cuts both ways — it is "most detailed wins", not "deepest wins".
    const g = makeGrid(from, to)
    rasterise(
      g,
      {
        depthAreas: [
          { minDepthM: 12, rings: [around(g)], level: 1 },
          { minDepthM: 0.8, rings: [around(g)], level: 3 },
        ],
        channels: [],
        land: [],
        hazards: [],
        coverage: 'full',
      },
      1.5,
    )
    expect(g.cells[mid(g)]).toBe(2)

    const g2 = makeGrid(from, to)
    rasterise(
      g2,
      {
        depthAreas: [{ minDepthM: 12, rings: [around(g2)], level: 1 }],
        channels: [],
        land: [{ rings: [around(g2)], level: 3 }],
        hazards: [],
        coverage: 'full',
      },
      1.5,
    )
    expect(g2.cells[mid(g2)]).toBe(2)
    expect(g2.depth[mid(g2)]).toBe(0)
  })

  it('keeps a coarse chart where no finer one reaches', () => {
    const g = makeGrid(from, to)
    const west: Ring = boxRing(g.minLat - 0.01, g.minLon - 0.01, g.maxLat + 0.01, (g.minLon + g.maxLon) / 2)
    rasterise(
      g,
      {
        depthAreas: [
          { minDepthM: 6, rings: [around(g)], level: 1 },
          { minDepthM: 0.5, rings: [west], level: 3 },
        ],
        channels: [],
        land: [],
        hazards: [],
        coverage: 'full',
      },
      1.5,
    )
    expect(g.cells[0]).toBe(2) // north-west corner: the harbour chart's shoal
    expect(g.cells[g.cols - 1]).toBe(1) // north-east corner: coastal chart only
  })

  it('closes every cell a bar thinner than a cell touches, wherever it falls', () => {
    // The first version sampled cell centres, so a bar lying between two rows
    // of centres was invisible to it — and the route went straight over it.
    const g = makeGrid(from, to)
    const row = Math.floor(g.rows / 2)
    // A 1 m bar laid exactly half-way between two rows of centres.
    const lat = g.maxLat - (row + 1) * g.latPerRow
    const bar = boxRing(lat - 0.5 / MPD.lat, g.minLon - 0.01, lat + 0.5 / MPD.lat, g.maxLon + 0.01)
    rasterise(
      g,
      {
        depthAreas: [
          { minDepthM: 10, rings: [around(g)] },
          { minDepthM: 0.3, rings: [bar] },
        ],
        channels: [],
        land: [],
        hazards: [],
        coverage: 'full',
      },
      1.5,
    )
    for (let col = 0; col < g.cols; col++) {
      expect(g.cells[row * g.cols + col]).toBe(2)
      expect(g.cells[(row + 1) * g.cols + col]).toBe(2)
      // …and its centre never saw it.
      expect(g.cDepth[row * g.cols + col]).toBe(10)
    }
  })

  it('blocks every cell a point hazard’s footprint touches', () => {
    const g = makeGrid(from, { lat: 29.31, lon: -94.79 })
    const centre = toLatLon(g, Math.floor(g.cols / 2), Math.floor(g.rows / 2))
    rasterise(
      g,
      {
        depthAreas: [{ minDepthM: 20, rings: [around(g)] }],
        channels: [],
        land: [],
        hazards: [{ ...centre, kind: 'wreck' as const, radiusM: g.cellM * 2, label: 'wreck' }],
        coverage: 'full',
      },
      1.5,
    )
    const c = toGrid(g, centre)
    const i = Math.floor(c.row) * g.cols + Math.floor(c.col)
    expect(g.cells[i]).toBe(2)
    expect(g.hard[i]).toBe(2)
    // Two cells out, the disc still touches the cell; six out it does not.
    expect(g.hard[i + 2]).toBe(2)
    expect(g.cells[i + 6]).toBe(1)
  })

  it('blocks the cells under a jetty charted as a line', () => {
    const g = makeGrid(from, to)
    const row = Math.floor(g.rows / 2)
    const lat = g.maxLat - (row + 0.5) * g.latPerRow
    rasterise(
      g,
      {
        depthAreas: [{ minDepthM: 20, rings: [around(g)] }],
        channels: [],
        land: [],
        hazards: [],
        lines: [
          {
            kind: 'structure',
            paths: [[[g.minLon + 3 * g.lonPerCol, lat], [g.minLon + 20 * g.lonPerCol, lat]]],
            widthM: 5,
            label: 'jetty',
          },
        ],
        coverage: 'full',
      },
      1.5,
    )
    for (let col = 3; col < 20; col++) expect(g.hard[row * g.cols + col]).toBe(2)
    expect(g.hard[row * g.cols + 25]).toBe(0)
  })
})

/* -------------------------------------------------------------------------
 * Clearance
 * ---------------------------------------------------------------------- */

describe('chamferClearance', () => {
  it('measures rectangle to rectangle: a cell touching land has none', () => {
    // Behaviour change, on purpose. This used to measure centre to centre,
    // which calls a cell touching land "one cell clear" — but the land in
    // that cell may sit on its near edge. Rectangles are what the boat is in.
    const g = gridFromAscii([
      '.......',
      '.......',
      '.......',
      '...#...',
      '.......',
      '.......',
      '.......',
    ])
    expect(g.clearCells[3 * 7 + 4]).toBe(0)
    expect(g.clearCells[3 * 7 + 5]).toBeCloseTo(1, 5)
    expect(g.clearCells[1 * 7 + 1]).toBeCloseTo(1, 5) // one cell in from the grid's edge
    expect(g.clearCells[3 * 7 + 3]).toBe(0)
  })

  it('treats the edge of the grid as land — a route may not leave the box', () => {
    const g = gridFromAscii(Array(9).fill('.........'))
    expect(g.clearCells[0]).toBe(0)
    expect(g.clearCells[4 * 9 + 4]).toBeCloseTo(4, 5)
  })

  it('does not measure the stand-off from shallow water', () => {
    // The stand-off is from land and hazards. Growing a shoal bank by it
    // closed the dredged channels boats are meant to use.
    const g = gridFromAscii([
      '~~~~~~~~~',
      '~~~~~~~~~',
      '.........',
      '~~~~~~~~~',
      '~~~~~~~~~',
    ])
    const p = passability(g, 0, 1.5)
    const wide = passability(g, 50, 1.5)
    expect(passable(g, 2 * 9 + 4, p)).toBe(true)
    expect(g.clearCells[2 * 9 + 4]).toBeCloseTo(2, 5) // only the grid's edge counts
    expect(passable(g, 2 * 9 + 4, wide)).toBe(true)
  })
})

describe('passable', () => {
  it('excludes a cell inside the stand-off the coxswain asked for', () => {
    const g = gridFromAscii([
      '.......',
      '.......',
      '.......',
      '...#...',
      '.......',
      '.......',
      '.......',
    ])
    const none = passability(g, 0, 1.5)
    const oneCell = passability(g, CELL_M, 1.5)
    const next = 3 * 7 + 4
    expect(passable(g, next, none)).toBe(true)
    expect(passable(g, next, oneCell)).toBe(false)
    expect(passable(g, 3 * 7 + 5, oneCell)).toBe(true)
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

  it('opens shallow water only where the approach zone or the last rung says so', () => {
    const g = gridFromAscii(['..~..'])
    const zone = new Uint8Array(5)
    zone[2] = 1
    expect(passable(g, 2, passability(g, 0, 1.5))).toBe(false)
    expect(passable(g, 2, passability(g, 0, 1.5, { zone }))).toBe(true)
    expect(passable(g, 2, passability(g, 0, 1.5, { allowShallow: true }))).toBe(true)
  })

  it('never opens land or a hazard footprint, whatever the mode', () => {
    const g = gridFromAscii(['.#x.'])
    const zone = new Uint8Array(4).fill(1)
    for (const p of [
      passability(g, 0, 1.5, { zone }),
      passability(g, 0, 1.5, { allowShallow: true }),
      passability(g, 0, 1.5, { optimistic: true }),
    ]) {
      expect(passable(g, 1, p)).toBe(false)
      expect(passable(g, 2, p)).toBe(false)
    }
  })

  it('keeps unsurveyed water closed even on the last rung', () => {
    const g = gridFromAscii(['..?..'])
    expect(passable(g, 2, passability(g, 0, 1.5, { allowShallow: true }))).toBe(false)
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

  it('sees a blocked cell the line only clips, which a Bresenham walk steps past', () => {
    // From (0,0) to (4,1) the true line crosses into row 1 at column 2; a
    // one-cell-per-column walk visits (2,0) and never looks at (2,1).
    const g = gridFromAscii([
      '.....',
      '..#..',
    ])
    const p = passability(g, 0, 1.5)
    expect(lineOfSight(g, { col: 0, row: 0 }, { col: 4, row: 1 }, p)).toBe(false)
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

  it('crosses the least of a shoal it has to cross, and the deepest part of it', () => {
    // The last rung of the ladder: shallow water allowed at a price that
    // grows with how shallow it is. The west of the bar dries at 0.5 m; the
    // east is 1.7 m — still not what a 2 m boat needs, but far better.
    const g = gridFromAscii([
      '.........',
      '~~~~~::::',
      '.........',
    ])
    const p = passability(g, 0, 2, { allowShallow: true })
    const path = astar(g, { col: 0, row: 0 }, { col: 0, row: 2 }, p)
    expect(path).not.toBeNull()
    const crossing = (path ?? []).filter((c) => c.row === 1)
    expect(crossing).toHaveLength(1)
    expect(crossing[0].col).toBeGreaterThanOrEqual(5)
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

  it('will not straighten a best-effort route across the worst of a shoal', () => {
    // A* went round through the 1.7 m end; a straight chord through the
    // 0.5 m middle would be shorter and "visible" — and would undo the
    // whole point of pricing depth deficit.
    const g = gridFromAscii([
      '.........',
      '~~~~~~~::',
      '.........',
    ])
    const p = passability(g, 0, 2, { allowShallow: true })
    const raw = astar(g, { col: 0, row: 0 }, { col: 0, row: 2 }, p)
    const pulled = stringPull(g, raw ?? [], p)
    for (let i = 1; i < pulled.length; i++) {
      const a = pulled[i - 1]
      const b = pulled[i]
      // No chord of the pulled path crosses row 1 west of column 7.
      if ((a.row - 1) * (b.row - 1) <= 0 && a.row !== b.row) {
        const t = (1 - a.row) / (b.row - a.row)
        expect(a.col + t * (b.col - a.col)).toBeGreaterThanOrEqual(6.5)
      }
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
    expect(g.cells[(snapped as { row: number }).row * g.cols + (snapped as { col: number }).col]).toBe(1)
  })

  it('picks the truly nearest water, not the first found on a square ring', () => {
    // The first version searched square rings, so a cell two across and two
    // down (2.8 cells away) could win over one three straight across (3).
    // Here the diagonal water is further: (4,4) is 2.83 cells, (2,5) is 3.
    const g = gridFromAscii([
      '#######',
      '#######',
      '#######',
      '#######',
      '####.##',
      '##.####',
      '#######',
    ].map((r, i) => (i === 2 ? '#####.#' : r)))
    const p = passability(g, 0, 1.5)
    const from = toLatLon(g, 2, 2)
    const s = snapToWater(g, from, p)
    // (5,2) is 3 cells east; (4,4) is √8 ≈ 2.83; (2,5) is 3 south.
    expect(s).toEqual({ col: 4, row: 4, moved: true })
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

  it('sees a shoal cell a diagonal leg only clips', () => {
    // From the centre of (0,0) to the centre of (4,1): the leg passes through
    // (2,1) — which one-sample-per-cell stepping jumps.
    const g = gridFromAscii(['.....', '.....'])
    g.depth[1 * 5 + 2] = 0.4
    expect(legMinDepth(g, toLatLon(g, 0, 0), toLatLon(g, 4, 1))).toBeCloseTo(0.4, 5)
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

describe('planningBounds', () => {
  const margin = (b: { maxLat: number }, to: LatLon) => (b.maxLat - to.lat) * MPD.lat

  it('gives a short hop two miles of room — enough to go round an island', () => {
    const b = planningBounds(SOUTH, at(0, -1400))
    expect(margin(b, at(0, -1400))).toBeGreaterThanOrEqual(2 * NM_TO_METERS - 1)
  })

  it('grows with the passage, and stops growing at 25 miles', () => {
    // Within a fraction of a percent: the margin is laid out in degrees at
    // the passage's middle latitude, and measured here at the base's.
    const tenNM = at(0, -1500 + 10 * NM_TO_METERS)
    expect(margin(planningBounds(SOUTH, tenNM), tenNM) / (6 * NM_TO_METERS)).toBeCloseTo(1, 2)
    const farNM = at(0, 60 * NM_TO_METERS)
    expect(margin(planningBounds(SOUTH, farNM), farNM) / (25 * NM_TO_METERS)).toBeCloseTo(1, 2)
  })

  it('always contains the ordinary search box', () => {
    for (const to of [at(0, -1400), NORTH, at(20000, 30000)]) {
      const p = planningBounds(SOUTH, to)
      const r = routeBounds(SOUTH, to)
      expect(p.minLat).toBeLessThanOrEqual(r.minLat)
      expect(p.minLon).toBeLessThanOrEqual(r.minLon)
      expect(p.maxLat).toBeGreaterThanOrEqual(r.maxLat)
      expect(p.maxLon).toBeGreaterThanOrEqual(r.maxLon)
    }
  })
})

describe('words', () => {
  it('puts feet first and metres in brackets', () => {
    expect(formatDepth(1.5)).toBe('5 ft (1.5 m)')
    expect(formatDepth(0.9)).toBe('3 ft (0.9 m)')
    expect(formatLength(30)).toBe('98 ft (30 m)')
    expect(formatLength(400)).toBe('0.22 NM')
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
  const p = planningBounds({ lat: g.minLat, lon: g.minLon }, { lat: g.maxLat, lon: g.maxLon })
  return {
    depthAreas: [
      { minDepthM: 12, rings: [boxRing(p.minLat, p.minLon, p.maxLat, p.maxLon)] },
      {
        minDepthM: barDepthM,
        rings: [boxRing(BAR_SOUTH, p.minLon, BAR_NORTH, channelWest(g))],
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
    const features = barChart(b)
    const plan = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features })

    expect(plan.source).toBe('charted')
    expect(plan.needsConfirm).toBe(false)
    expect(plan.failure).toBeNull()
    const directNM = haversineNM(from.lat, from.lon, to.lat, to.lon)
    expect(plan.totalNM).toBeGreaterThan(directNM)
    // It must come out east of the bar's edge to get round it.
    expect(Math.max(...plan.points.map((p) => p.lon))).toBeGreaterThan(channelWest(b))
    // And no leg may cross water shoaler than the boat needs.
    for (const leg of plan.legs) {
      expect(leg.minChartedDepthM).not.toBeNull()
      expect(leg.minChartedDepthM!).toBeGreaterThanOrEqual(1.5)
      expect(leg.caution).toBe('ok')
    }
    expect(independentCheck(plan, features, { safeDepthM: 1.5, clearanceM: 0 })).toEqual([])
    expectTidy(plan)
  })

  it('starts and ends on exactly the positions the crew gave', () => {
    const features = barChart(routeBounds(from, to))
    const plan = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features })
    expect(plan.points[0]).toEqual(from)
    expect(plan.points[plan.points.length - 1]).toEqual(to)
    expect(plan.movedStart).toBeNull()
    expect(plan.movedEnd).toBeNull()
  })

  it('runs straight when the water is deep the whole way', () => {
    const plan = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features: sea() })
    expect(plan.source).toBe('charted')
    expect(plan.points).toHaveLength(2)
    const directNM = haversineNM(from.lat, from.lon, to.lat, to.lon)
    expect(plan.totalNM).toBeCloseTo(directNM, 2)
    expect(plan.arrivalFt).toEqual([150, 150])
    expect(plan.legs[0].minClearanceM).toBeNull()
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

  it('will not route through unsurveyed water — and draws nothing rather than a guess', () => {
    // Behaviour change, on purpose: this used to hand back a straight line
    // across the gap with a warning. A line through water nobody surveyed,
    // or through an inland field nobody charted, is not a route.
    const p = planningBounds(from, to)
    const features: ChartFeatures = {
      depthAreas: [
        { minDepthM: 12, rings: [boxRing(p.minLat, p.minLon, 29.315, p.maxLon)] },
        { minDepthM: 12, rings: [boxRing(29.325, p.minLon, p.maxLat, p.maxLon)] },
      ],
      channels: [],
      land: [],
      hazards: [],
      coverage: 'full',
    }
    const plan = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features })
    expect(plan.source).toBe('none')
    expect(plan.points).toEqual([])
    expect(plan.legs).toEqual([])
    expect(plan.failure).toMatch(/no charted water route/i)
    expect(plan.failure).toMatch(/unsurveyed/i)
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
    expect(plan.source).toBe('none')
    expect(plan.points).toEqual([])
    expect(plan.failure).toMatch(/no charted depths/i)
    expect(plan.needsConfirm).toBe(false)
  })

  it('says so when the start and the destination are the same place', () => {
    const plan = planRoute({ from, to: from, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features: sea() })
    expect(plan.source).toBe('none')
    expect(plan.failure).toMatch(/same place/i)
  })

  it('will not plot a course to a destination deep inside land', () => {
    const features = sea({
      land: [{ rings: [boxRing(29.33, -94.83, 29.35, -94.81)] }],
    })
    const plan = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features })
    expect(plan.source).toBe('none')
    expect(plan.points).toEqual([])
    // Which of the reasons, and how far was looked, because those are what a
    // crew acts on. The destination is 1 km inside the land box.
    expect(plan.failure).toMatch(/destination is on land/i)
    expect(plan.failure).toMatch(/1,312 ft \(400 m\)/)
  })

  it('warns when the chart query was cut short', () => {
    const features = { ...sea(), coverage: 'partial' as const }
    const plan = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features })
    expect(plan.warnings.join(' ')).toMatch(/hit its limit/i)
  })

  it('warns when a chart band could not be loaded', () => {
    const features = { ...sea(), coverage: 'partial' as const, failedBands: ['harbour'] }
    const plan = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features })
    expect(plan.source).toBe('charted')
    expect(plan.warnings.join(' ')).toMatch(/harbour chart could not be loaded/i)
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
    expect(plan.arrivalFt).toHaveLength(plan.points.length)
  })

  it('keeps the stand-off the coxswain asked for', () => {
    const b = routeBounds(from, to)
    // The bar's east end as land this time: the stand-off applies to land.
    const features = barChart(b)
    features.land = [{ rings: [boxRing(BAR_SOUTH, b.minLon - 0.05, BAR_NORTH, channelWest(b))] }]
    const wide = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 200, speedKn: 20, features })
    const tight = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 0, speedKn: 20, features })
    expect(wide.source).toBe('charted')
    expect(wide.totalNM).toBeGreaterThan(tight.totalNM)
    for (const leg of wide.legs) {
      if (leg.caution === 'ok') expect(leg.minClearanceM ?? Infinity).toBeGreaterThanOrEqual(200 - 0.01)
    }
    expect(independentCheck(wide, features, { safeDepthM: 1.5, clearanceM: 200 })).toEqual([])
  })
})

/* -------------------------------------------------------------------------
 * The chart itself is the authority
 *
 * Each of these is a thing the grid alone got wrong, and the vector check
 * against the real features now gets right.
 * ---------------------------------------------------------------------- */

describe('planRoute against the real geometry', () => {
  const boat = { safeDepthM: 1.5, speedKn: 20 }

  it('will not cross a bar far thinner than a grid cell', () => {
    // 4 m of 0.5 m water across the whole area but one 60 m gap. Every grid
    // here is coarser than 4 m; the route must find the gap anyway.
    const features = sea({
      depthAreas: [
        { minDepthM: 10, rings: [rect(-12000, -12000, 12000, 12000)] },
        { minDepthM: 0.5, rings: [rect(-12000, 0, 400, 4)] },
        { minDepthM: 0.5, rings: [rect(460, 0, 12000, 4)] },
      ],
    })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 0, features })
    expect(plan.source).toBe('charted')
    expect(independentCheck(plan, features, { ...boat, clearanceM: 0, stepM: 0.5 })).toEqual([])
    // It went through the gap, not round the end of the bar.
    const east = Math.max(...plan.points.map((p) => xy(p).x))
    expect(east).toBeGreaterThan(400)
    expect(east).toBeLessThan(1000)
    expectTidy(plan)
  })

  it('keeps the stand-off from land lying just beyond the planning box', () => {
    // A wall forces the route east, round its end, close to the edge of the
    // planning box — and the shore starts half a metre past that edge. The
    // chart index used to be clipped to the planning box, so the vector
    // check could not see that shore: a leg 97.8 m off it passed a 100 m
    // stand-off and the plan still said 'charted'.
    const from = at(0, -500)
    const to = at(0, 500)
    const edgeX = xy({ lat: from.lat, lon: planningBounds(from, to).maxLon }).x
    const features = sea({
      land: [
        { rings: [rect(-12000, -50, edgeX - 200, 50)] },
        { rings: [rect(edgeX + 0.5, -12000, 12000, 12000)] },
      ],
    })
    const rules = { ...boat, clearanceM: 100 }
    const plan = planRoute({ from, to, ...rules, features })
    expect(plan.source).not.toBe('none')
    // Whatever it is, nothing it calls safe breaks the stand-off.
    expect(independentCheck(plan, features, rules)).toEqual([])
    for (const leg of plan.legs) {
      if (leg.caution === 'ok' && leg.minClearanceM !== null) {
        expect(leg.minClearanceM).toBeGreaterThanOrEqual(100 - 0.01)
      }
    }
  })

  it('goes round a jetty charted as a line, keeping the stand-off from its end', () => {
    const features = sea({
      lines: [{ kind: 'structure', paths: [[ll(-12000, 0), ll(300, 0)]], widthM: 5, label: 'jetty' }],
    })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 30, features })
    expect(plan.source).toBe('charted')
    expect(Math.max(...plan.points.map((p) => xy(p).x))).toBeGreaterThan(300 + 2.5 + 30)
    for (const leg of plan.legs) {
      if (leg.minClearanceM !== null) expect(leg.minClearanceM).toBeGreaterThanOrEqual(30 - 0.01)
    }
    expect(independentCheck(plan, features, { ...boat, clearanceM: 30 })).toEqual([])
    expectTidy(plan)
  })

  it('threads between bridge pylons when the stand-off allows, and goes round when not', () => {
    // Pylons every 60 m, footprint 10 m: 40 m of water between footprints.
    const hazards = []
    for (let x = -600; x <= 600; x += 60) {
      hazards.push({ ...at(x, 0), radiusM: 10, kind: 'pylon' as const, label: 'bridge pylon' })
    }
    const features = sea({ hazards })
    const between = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 15, features })
    expect(between.source).toBe('charted')
    expect(independentCheck(between, features, { ...boat, clearanceM: 15 })).toEqual([])
    const xs = between.points.map((p) => Math.abs(xy(p).x))
    expect(Math.max(...xs)).toBeLessThan(100)

    const round = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 30, features })
    expect(round.source).toBe('charted')
    expect(independentCheck(round, features, { ...boat, clearanceM: 30 })).toEqual([])
    expect(Math.max(...round.points.map((p) => Math.abs(xy(p).x)))).toBeGreaterThan(600 + 10 + 30)
  })

  it('keeps an area hazard from a coarse chart, even under a finer chart’s water', () => {
    // Finest-wins is for land and depth. A wreck on any chart is a wreck.
    const features = sea({
      depthAreas: [
        { minDepthM: 10, rings: [rect(-12000, -12000, 12000, 12000)], level: 1 },
        { minDepthM: 9, rings: [rect(-12000, -12000, 12000, 12000)], level: 3 },
      ],
      land: [{ rings: [rect(-100, -100, 100, 100)], level: 1, hazard: true }],
    })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 20, features })
    expect(plan.source).toBe('charted')
    expect(plan.points.length).toBeGreaterThan(2)
    expect(independentCheck(plan, features, { ...boat, clearanceM: 20 })).toEqual([])
  })

  it('crosses coarse-chart "land" that a finer chart charts as water', () => {
    const features = sea({
      depthAreas: [
        { minDepthM: 0.5, rings: [rect(-12000, -12000, 12000, 12000)], level: 1 },
        { minDepthM: 9, rings: [rect(-12000, -12000, 12000, 12000)], level: 3 },
      ],
      land: [{ rings: [rect(-3000, -200, 3000, 200)], level: 1 }],
    })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 30, features })
    expect(plan.source).toBe('charted')
    expect(plan.points).toHaveLength(2)
  })

  it('retries in the wide planning box when the way round lies outside the first', () => {
    // A spoil bank across the route, reaching 2.6 km east: beyond the
    // ordinary box's one-mile margin, inside the planning box's two.
    const features = sea({ land: [{ rings: [rect(-12000, -50, 2600, 50)] }] })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 30, features })
    expect(plan.source).toBe('charted')
    expect(Math.max(...plan.points.map((p) => xy(p).x))).toBeGreaterThan(2600)
    expect(independentCheck(plan, features, { ...boat, clearanceM: 30 })).toEqual([])
    expectTidy(plan)
  })

  it('repairs a long leg only where it fails, on a grid fine enough to see the gap', () => {
    // A 20 km diagonal across a 4 m bar that runs the whole width of the
    // chart, open only in a 30 m gap. The bar is laid between two rows of
    // cell centres, so the optimistic read sees no bar at all and proposes
    // the straight line; the conservative read closes the gap outright. The
    // chart check then catches the line on the bar, and the repair must see
    // a 30 m gap — which a repair grid over the whole 20 km leg (a 15 km
    // square) is far too coarse to do. Only the stretch that failed is
    // re-planned.
    const from = at(-7000, -7000)
    const to = at(7000, 7000)
    const g = makeGrid(from, to)
    const row = Math.round(toGrid(g, at(0, 0)).row - 0.5)
    const yc = xy(toLatLon(g, 0, row)).y
    const y0 = yc + g.cellM * 0.3
    const features = sea({
      depthAreas: [
        { minDepthM: 10, rings: [rect(-12000, -12000, 12000, 12000)] },
        { minDepthM: 0.5, rings: [rect(-12000, y0, 0, y0 + 4)] },
        { minDepthM: 0.5, rings: [rect(30, y0, 12000, y0 + 4)] },
      ],
    })
    const plan = planRoute({ from, to, ...boat, clearanceM: 0, features })
    expect(plan.source).toBe('charted')
    expect(independentCheck(plan, features, { ...boat, clearanceM: 0, stepM: 1 })).toEqual([])
    // Through the gap, and nearly straight: nothing like a detour.
    const direct = haversineNM(from.lat, from.lon, to.lat, to.lon)
    expect(plan.totalNM).toBeLessThan(direct * 1.02)
    // A handful of legs, none a stub. (The turn at the gap is a fraction of a
    // degree, and it stays: the straight line misses the gap by 16 m.)
    expect(plan.legs.length).toBeLessThanOrEqual(3)
    for (const leg of plan.legs) expect(metresBetween(leg.from, leg.to)).toBeGreaterThanOrEqual(20)
  })
})

/* -------------------------------------------------------------------------
 * The ends of a passage
 * ---------------------------------------------------------------------- */

describe('planRoute at the dock', () => {
  const boat = { safeDepthM: 1.5, speedKn: 20 }

  it('lets the route leave a shallow berth near the start, and flags it', () => {
    // The start sits in 0.5 m water 50 m from the deep water: inside the
    // 120 m approach stretch.
    const features = sea({
      depthAreas: [
        { minDepthM: 10, rings: [rect(-12000, -1450, 12000, 12000)] },
        { minDepthM: 0.5, rings: [rect(-12000, -12000, 12000, -1450)] },
      ],
    })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 30, features })
    expect(plan.source).toBe('charted')
    expect(plan.needsConfirm).toBe(false)
    // Only the leg out of the berth carries the flag.
    expect(plan.legs[0].caution).toBe('shallow-approach')
    for (const leg of plan.legs.slice(1)) expect(leg.caution).toBe('ok')
    expect(plan.warnings.join(' ')).toMatch(/check the depth there/i)
    expect(independentCheck(plan, features, { ...boat, clearanceM: 30 })).toEqual([])
  })

  it('lets the route leave a dock closer to land than the stand-off', () => {
    // Moored alongside: 5 m from the quay, the stand-off is 30 m.
    const features = sea({ land: [{ rings: [rect(-12000, -12000, 12000, -1505)] }] })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 30, features })
    expect(plan.source).toBe('charted')
    expect(plan.legs[0].caution).toBe('shallow-approach')
    expect(plan.legs[0].minClearanceM!).toBeCloseTo(5, 0)
    expect(independentCheck(plan, features, { ...boat, clearanceM: 30 })).toEqual([])
  })

  it('does not stretch the approach allowance past approachM', () => {
    // 0.5 m water for 300 m around the start: most of it beyond the zone.
    const features = sea({
      depthAreas: [
        { minDepthM: 10, rings: [rect(-12000, -1200, 12000, 12000)] },
        { minDepthM: 0.5, rings: [rect(-12000, -12000, 12000, -1200)] },
      ],
    })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 0, features })
    expect(plan.source).toBe('best-effort')
    expect(plan.needsConfirm).toBe(true)
    expect(plan.legs[0].caution).toBe('unsafe-depth')
    expect(plan.legs[0].minChartedDepthM).toBeCloseTo(0.5, 5)
    const said = plan.warnings.join(' ')
    expect(said).toMatch(/No route keeps 5 ft \(1\.5 m\) of water the whole way/)
    expect(said).toMatch(/crosses 2 ft \(0\.5 m\) near leg 1/)
    // The legs it did not flag are still genuinely safe.
    expect(independentCheck(plan, features, { ...boat, clearanceM: 0 })).toEqual([])
  })

  it('never lets the approach allowance open land: a wall by the dock is gone round', () => {
    const features = sea({ land: [{ rings: [rect(-200, -1455, 200, -1445)] }] })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 0, features })
    expect(plan.source).toBe('charted')
    expect(Math.max(...plan.points.map((p) => Math.abs(xy(p).x)))).toBeGreaterThan(200)
    expect(independentCheck(plan, features, { ...boat, clearanceM: 0 })).toEqual([])
  })

  it('snaps a start on land to water that actually connects to the destination', () => {
    // On land between a pond 20 m south and the sea 340 m north. The pond is
    // nearer; it also goes nowhere.
    const features = sea({
      land: [{ rings: [rect(-12000, -12000, 12000, -1300), rect(-100, -1720, 100, -1660)] }],
    })
    const start = at(0, -1640)
    const plan = planRoute({ from: start, to: NORTH, ...boat, clearanceM: 0, features })
    expect(plan.source).toBe('best-effort')
    expect(plan.movedStart).not.toBeNull()
    expect(xy(plan.movedStart!).y).toBeGreaterThan(-1300)
    expect(plan.points[0]).toEqual(start)
    expect(plan.points[1]).toEqual(plan.movedStart)
    expect(plan.legs[0].caution).toBe('unsafe-depth')
    expect(plan.legs.slice(1).every((l) => l.caution === 'ok')).toBe(true)
    expect(plan.warnings.join(' ')).toMatch(/chart shows your start on land/i)
    expect(independentCheck(plan, features, { ...boat, clearanceM: 0 })).toEqual([])
  })

  it('moves a destination on a small islet to the water beside it, and says so', () => {
    const features = sea({ land: [{ rings: [rect(-50, 1450, 50, 1550)] }] })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 30, features })
    expect(plan.source).toBe('best-effort')
    expect(plan.movedEnd).not.toBeNull()
    expect(plan.points[plan.points.length - 1]).toEqual(NORTH)
    expect(plan.legs[plan.legs.length - 1].caution).toBe('unsafe-depth')
    expect(plan.warnings.join(' ')).toMatch(/chart shows your destination on land/i)
  })

  it('says why when the start is land-locked, rather than drawing anything', () => {
    const features = sea({ land: [{ rings: [rect(-1000, -2500, 1000, -1000)] }] })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 0, features })
    expect(plan.source).toBe('none')
    expect(plan.points).toEqual([])
    expect(plan.failure).toMatch(/your start is on land/i)
    expect(plan.failure).toMatch(/1,312 ft \(400 m\)/)
  })

  it('says so when no water path joins the two ends at all', () => {
    // The destination is in a lake with no way out.
    const features = sea({
      land: [{ rings: [rect(-600, 900, 600, 2100), rect(-300, 1200, 300, 1800)] }],
    })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 0, features })
    expect(plan.source).toBe('none')
    expect(plan.failure).toMatch(/no charted water route joins/i)
  })
})

/* -------------------------------------------------------------------------
 * Best effort
 * ---------------------------------------------------------------------- */

describe('planRoute when nothing fully safe exists', () => {
  const boat = { safeDepthM: 1.5, speedKn: 20 }

  it('gives up stand-off a step at a time before it gives up depth', () => {
    // A 50 m-wide cut through land, 3 km long. The crew asked for 30 m of
    // stand-off, which a 50 m cut cannot give; 15 m it can.
    const features = sea({
      land: [
        { rings: [rect(-12000, -1000, -25, 1000)] },
        { rings: [rect(25, -1000, 12000, 1000)] },
      ],
    })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 30, features })
    expect(plan.source).toBe('best-effort')
    expect(plan.needsConfirm).toBe(true)
    const flagged = plan.legs.filter((l) => l.caution === 'reduced-clearance')
    expect(flagged.length).toBeGreaterThan(0)
    for (const l of plan.legs) {
      expect(l.caution).not.toBe('unsafe-depth')
      expect(l.minClearanceM ?? Infinity).toBeGreaterThanOrEqual(3)
    }
    // Down the middle, not along a bank.
    const mid = plan.legs.find((l) => xy(l.from).y > -900 && xy(l.to).y < 900 && xy(l.to).y > xy(l.from).y)
    if (mid) expect(mid.minClearanceM!).toBeGreaterThan(15)
    const said = plan.warnings.join(' ')
    expect(said).toMatch(/No route keeps your 98 ft \(30 m\) stand-off/)
    expect(said).toMatch(/Confirm before you steer it/)
    // Everything it did not flag passes the full rules.
    expect(independentCheck(plan, features, { ...boat, clearanceM: 30 })).toEqual([])
  })

  it('crosses shallow water only as a last resort, at its deepest, and says how shallow', () => {
    // A bar right across: 0.4 m on the direct line, 1.2 m well to the east.
    const features = sea({
      depthAreas: [
        { minDepthM: 10, rings: [rect(-12000, -12000, 12000, -100)] },
        { minDepthM: 10, rings: [rect(-12000, 100, 12000, 12000)] },
        { minDepthM: 0.4, rings: [rect(-12000, -100, 300, 100)] },
        { minDepthM: 1.2, rings: [rect(300, -100, 12000, 100)] },
      ],
    })
    const plan = planRoute({ from: SOUTH, to: NORTH, ...boat, clearanceM: 30, features })
    expect(plan.source).toBe('best-effort')
    const bad = plan.legs.filter((l) => l.caution === 'unsafe-depth')
    expect(bad.length).toBeGreaterThan(0)
    for (const l of bad) expect(l.minChartedDepthM).toBeCloseTo(1.2, 5)
    expect(plan.warnings.join(' ')).toMatch(/crosses 4 ft \(1\.2 m\) near leg \d/)
    expect(independentCheck(plan, features, { ...boat, clearanceM: 30 })).toEqual([])
  })

  it('does not let a best-effort turn cut its corner into shoaler water', () => {
    // A 200 m bar at 0.4 m with one 50 m notch at 1.2 m, and a dog-leg
    // through the notch. The early switch at the turn before the bar must
    // not cut the corner across the 0.4 m either side of the notch — the
    // last rung's own check ignores depth, so that has to be asked
    // separately: the chord may be no shoaler than the legs it replaces.
    const features = sea({
      depthAreas: [
        { minDepthM: 10, rings: [rect(-12000, -12000, 12000, -100)] },
        { minDepthM: 10, rings: [rect(-12000, 100, 12000, 12000)] },
        { minDepthM: 0.4, rings: [rect(-12000, -100, 300, 100)] },
        { minDepthM: 1.2, rings: [rect(300, -100, 350, 100)] },
        { minDepthM: 0.4, rings: [rect(350, -100, 12000, 100)] },
      ],
    })
    const from = at(-600, -600)
    const to = at(-600, 600)
    const plan = planRoute({ from, to, ...boat, clearanceM: 0, features, arrivalFt: 200 })
    expect(plan.source).toBe('best-effort')
    for (const l of plan.legs) {
      if (l.caution === 'unsafe-depth') expect(l.minChartedDepthM).toBeCloseTo(1.2, 5)
    }
    const shoalest = (a: LatLon, b: LatLon): number => {
      const n = Math.max(1, Math.ceil(metresBetween(a, b)))
      let min = Infinity
      for (let k = 0; k <= n; k++) {
        const s = bruteState(features, a.lat + ((b.lat - a.lat) * k) / n, a.lon + ((b.lon - a.lon) * k) / n)
        min = Math.min(min, s)
      }
      return min
    }
    for (let i = 1; i + 1 < plan.points.length; i++) {
      // 30 ft is the floor: the radius is never cut below it, whatever the
      // chord does (a turn hard against a bank is steered to closely).
      if (plan.arrivalFt[i] <= 30) continue
      const a = plan.points[i - 1]
      const p = plan.points[i]
      const b = plan.points[i + 1]
      const r = plan.arrivalFt[i] * 0.3048
      const lin = metresBetween(a, p)
      const e = r >= lin ? a : {
        lat: p.lat + ((a.lat - p.lat) * r) / lin,
        lon: p.lon + ((a.lon - p.lon) * r) / lin,
      }
      const legs = Math.min(shoalest(e, p), shoalest(p, b))
      expect(shoalest(e, b)).toBeGreaterThanOrEqual(Math.min(legs, 1.5))
    }
  })
})

/* -------------------------------------------------------------------------
 * Capture radius per point
 * ---------------------------------------------------------------------- */

describe('planRoute arrival radius', () => {
  it('shrinks the radius at a hairpin so the early switch cannot cut the corner', () => {
    // A thin mole running south from y = 0; the route goes up one side,
    // round the tip, and back down the other.
    const features = sea({ land: [{ rings: [rect(-5, -12000, 5, 0)] }] })
    const from = at(-150, -1000)
    const to = at(150, -1000)
    const plan = planRoute({
      from, to, safeDepthM: 1.5, clearanceM: 30, speedKn: 20, features, arrivalFt: 200,
    })
    expect(plan.source).toBe('charted')
    expect(plan.arrivalFt[0]).toBe(200)
    expect(plan.arrivalFt[plan.arrivalFt.length - 1]).toBe(200)
    const inner = plan.arrivalFt.slice(1, -1)
    expect(inner.some((r) => r < 200)).toBe(true)
    for (const r of inner) {
      expect(r).toBeGreaterThanOrEqual(30)
      expect(r).toBeLessThanOrEqual(200)
    }
    // Independently: the early-switch chord from each turn point's radius
    // passes the same rules as the legs.
    for (let i = 1; i + 1 < plan.points.length; i++) {
      const a = plan.points[i - 1]
      const p = plan.points[i]
      const b = plan.points[i + 1]
      const r = plan.arrivalFt[i] * 0.3048
      const lin = metresBetween(a, p)
      const e = r >= lin ? a : {
        lat: p.lat + ((a.lat - p.lat) * r) / lin,
        lon: p.lon + ((a.lon - p.lon) * r) / lin,
      }
      const chord = { ...plan, points: [plan.points[0], e, b, plan.points[plan.points.length - 1]] }
      const legs = [{ ...plan.legs[0], from: e, to: b, caution: 'ok' as const }]
      expect(independentCheck({ ...chord, legs }, features, { safeDepthM: 1.5, clearanceM: 30 })).toEqual([])
    }
  })

  it('gives every point the full radius in open water', () => {
    const plan = planRoute({
      from: SOUTH, to: at(3000, 3000), safeDepthM: 1.5, clearanceM: 30, speedKn: 20,
      features: sea(), arrivalFt: 100,
    })
    expect(plan.arrivalFt.every((r) => r === 100)).toBe(true)
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
  const p = planningBounds({ lat: g.minLat, lon: g.minLon }, { lat: g.maxLat, lon: g.maxLon })
  return {
    depthAreas: [
      {
        minDepthM: surroundDepthM,
        rings: [boxRing(p.minLat, p.minLon, p.maxLat, p.maxLon)],
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
    // A channel somewhere else in the box is not a reason to refuse.
    const b = routeBounds(from, to)
    const features = channelChart(b, 12)
    features.channels = [
      { kind: 'fairway', rings: [boxRing(b.minLat, b.minLon, b.minLat + 0.002, b.minLon + 0.002)] },
    ]
    const plan = planRoute({ from, to, ...boat, features })
    expect(plan.source).toBe('charted')
    expect(plan.points.length).toBeGreaterThanOrEqual(2)
  })

  it('does not shatter an unmarked route into dozens of legs', () => {
    // The budget rule in stringPull is supposed to be inert where nothing is
    // marked, because a chord can never be octile-longer than the path it
    // replaces. True in arithmetic, false in floating point: the two sides sum
    // the same irrational √2 a different number of times in a different order,
    // so equal lengths differed by about 1e-13 and a strict comparison
    // rejected half the chords. This exact route came out as 49 legs instead
    // of 3 — a wall of turn points on a phone, for a course round one bar.
    const p = planningBounds(from, to)
    const features: ChartFeatures = {
      depthAreas: [
        { minDepthM: 1.7, rings: [boxRing(p.minLat, p.minLon, p.maxLat, p.maxLon)] },
        { minDepthM: 0.3, rings: [boxRing(29.315, p.minLon, 29.325, -94.812)] },
      ],
      channels: [],
      land: [],
      hazards: [],
      coverage: 'full',
    }
    const plan = planRoute({ from, to, ...boat, features })
    expect(plan.source).toBe('charted')
    expect(plan.legs.length).toBeLessThanOrEqual(6)
    expectTidy(plan)
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
    expect(independentCheck(round, withPile, { safeDepthM: 1.5, clearanceM: 0 })).toEqual([])
  })
})

/* -------------------------------------------------------------------------
 * Why a position cannot be used
 *
 * "Not in water this boat can use" is true and nearly useless: land, shallow
 * water and a stand-off that has closed a gap have three different answers,
 * and a crew needs to know which before they can do anything about it.
 * ---------------------------------------------------------------------- */

describe('describeUnusable', () => {
  const pos = (g: RouteGrid, col: number, row: number) => toLatLon(g, col, row)

  it('tells dry land apart from shallow water, and says how shallow in feet first', () => {
    const g = gridFromAscii([
      '#~~~~',
      '~~~~~',
      '.....',
      '.....',
    ])
    const p = passability(g, 0, 1.5)
    expect(describeUnusable(g, pos(g, 0, 0), p).why).toMatch(/on land/i)
    expect(describeUnusable(g, pos(g, 1, 0), p).why).toBe(
      'in 2 ft (0.5 m) of charted water at chart datum',
    )
  })

  it('does not call a 0 m depth area land', () => {
    // A depth area charted from 0 m is a drying bank's edge or a mudflat —
    // water, if not much of it. It used to be reported as "on land".
    const g = gridFromAscii(['~....', '.....'])
    g.depth[0] = 0
    const p = passability(g, 0, 1.5)
    expect(describeUnusable(g, pos(g, 0, 0), p).why).toMatch(/0 ft \(0\.0 m\) of charted water/)
  })

  it('names a hazard for what it is, never "NaN m"', () => {
    const g = gridFromAscii(['x....', '.....'])
    g.depth[0] = NaN
    const p = passability(g, 0, 1.5)
    const why = describeUnusable(g, pos(g, 0, 0), p).why
    expect(why).toMatch(/hazard/i)
    expect(why).not.toMatch(/NaN/)
  })

  it('says "right against" land that only clips a corner of the cell, not "on land"', () => {
    const g = gridFromAscii(['.....', '.....'])
    g.hard[0] = 1 // land somewhere in the cell; its centre is still water
    prepareGrid(g, 1.5)
    const p = passability(g, 0, 1.5)
    const why = describeUnusable(g, pos(g, 0, 0), p).why
    expect(why).toMatch(/right against land/i)
    expect(why).not.toMatch(/^on land/i)
  })

  it('says when the water was never surveyed rather than calling it shallow', () => {
    const g = gridFromAscii([
      '?????',
      '?????',
      '.....',
    ])
    const p = passability(g, 0, 1.5)
    expect(describeUnusable(g, pos(g, 2, 0), p).why).toMatch(/never surveyed/i)
  })

  it('names the stand-off when the water itself is deep enough', () => {
    // Open water hard against land: deep enough, but inside the stand-off the
    // coxswain asked for. That is a setting, not the sea.
    const g = gridFromAscii([
      '#....',
      '.....',
      '.....',
    ])
    const p = passability(g, CELL_M * 2, 1.5)
    expect(describeUnusable(g, pos(g, 1, 0), p).why).toMatch(/stand-off/i)
  })

  it('reports how far the nearest usable water is, so the pin can be moved', () => {
    const g = gridFromAscii([
      '##...',
      '##...',
      '.....',
    ])
    const p = passability(g, 0, 1.5)
    const d = describeUnusable(g, pos(g, 0, 0), p)
    expect(d.nearestNM).not.toBeNull()
    expect(d.nearestNM!).toBeGreaterThan(0)
    // Two cells of 100 m is about 0.1 NM — the pin needs a nudge, not a rethink.
    expect(d.nearestNM!).toBeLessThan(0.3)
  })

  it('returns no distance when there is no usable water anywhere near', () => {
    const g = gridFromAscii(['###', '###', '###'])
    const p = passability(g, 0, 1.5)
    expect(describeUnusable(g, pos(g, 1, 1), p).nearestNM).toBeNull()
  })
})

/* -------------------------------------------------------------------------
 * Random charts
 *
 * Islands, shoals and hazards scattered at random, at random scales, with a
 * random boat, and the independent check run over whatever comes back. The
 * scenarios above each pin one behaviour; this is what finds the
 * interaction nobody thought to write down.
 * ---------------------------------------------------------------------- */

describe('planRoute on random charts', () => {
  const rng = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const blob = (rand: () => number, cx: number, cy: number, r: number): Ring => {
    const n = 8 + Math.floor(rand() * 16)
    const ring: Ring = []
    for (let i = 0; i < n; i++) {
      const th = (i / n) * 2 * Math.PI
      const rr = r * (0.5 + 0.5 * rand())
      ring.push(ll(cx + rr * Math.cos(th), cy + rr * Math.sin(th)))
    }
    ring.push(ring[0])
    return ring
  }

  /** No leg at all — flagged or not — runs over land or into a hazard. */
  function neverThroughLand(plan: RoutePlan, f: ChartFeatures): string[] {
    const out: string[] = []
    plan.legs.forEach((leg, li) => {
      const snap = (li === 0 && plan.movedStart) || (li === plan.legs.length - 1 && plan.movedEnd)
      if (snap) return
      const n = Math.max(1, Math.ceil(metresBetween(leg.from, leg.to) / 2))
      for (let k = 0; k <= n; k++) {
        const p = {
          lat: leg.from.lat + ((leg.to.lat - leg.from.lat) * k) / n,
          lon: leg.from.lon + ((leg.to.lon - leg.from.lon) * k) / n,
        }
        if (bruteState(f, p.lat, p.lon) === -Infinity) out.push(`leg ${li + 1} (${leg.caution}) on land`)
        for (const h of f.hazards) {
          if (metresBetween(p, h) < h.radiusM - 0.05) out.push(`leg ${li + 1} (${leg.caution}) in a ${h.kind}`)
        }
      }
    })
    return out
  }

  it('never draws an unflagged leg that breaks a rule, nor any leg through land', () => {
    const sources = new Set<string>()
    for (let seed = 1; seed <= 16; seed++) {
      const rand = rng(seed * 7919)
      const f = sea({
        depthAreas: [{ minDepthM: 3 + rand() * 5, rings: [rect(-12000, -12000, 12000, 12000)], level: 1 }],
      })
      const n = 20 + Math.floor(rand() * 100)
      for (let k = 0; k < n; k++) {
        const cx = rand() * 5000 - 2500
        const cy = rand() * 5000 - 2500
        const r = 20 + rand() * 400
        const kind = rand()
        if (kind < 0.35) f.land.push({ rings: [blob(rand, cx, cy, r)], level: rand() < 0.5 ? 1 : 3 })
        else if (kind < 0.45) f.land.push({ rings: [blob(rand, cx, cy, r / 3)], level: 1, hazard: true })
        else {
          f.depthAreas.push({
            minDepthM: [0, 0.5, 1.2, 1.8, 3.6, 9][Math.floor(rand() * 6)],
            rings: [blob(rand, cx, cy, r)],
            level: rand() < 0.5 ? 1 : 3,
          })
        }
      }
      for (let k = 0; k < 15; k++) {
        f.hazards.push({ ...at(rand() * 5000 - 2500, rand() * 5000 - 2500), radiusM: 5 + rand() * 40, kind: 'wreck', label: 'wreck' })
      }
      for (let k = 0; k < 5; k++) {
        const x = rand() * 5000 - 2500
        const y = rand() * 5000 - 2500
        f.lines!.push({
          kind: 'structure',
          paths: [[ll(x, y), ll(x + rand() * 800 - 400, y + rand() * 800 - 400)]],
          widthM: 5,
          label: 'jetty',
        })
      }
      const from = at(rand() * 4000 - 2000, rand() * 4000 - 2000)
      const to = at(rand() * 4000 - 2000, rand() * 4000 - 2000)
      const safeDepthM = 0.5 + rand() * 2.5
      const clearanceM = [0, 5, 15, 30, 60][Math.floor(rand() * 5)]
      const plan = planRoute({ from, to, safeDepthM, clearanceM, speedKn: 20, features: f })
      sources.add(plan.source)
      if (plan.source === 'none') {
        expect(plan.points).toEqual([])
        expect(plan.failure).toBeTruthy()
        continue
      }
      expect(plan.source === 'charted').toBe(
        plan.legs.every((l) => l.caution === 'ok' || l.caution === 'shallow-approach'),
      )
      expect(plan.needsConfirm).toBe(plan.source === 'best-effort')
      expect(neverThroughLand(plan, f)).toEqual([])
      expect(independentCheck(plan, f, { safeDepthM, clearanceM, ringEveryM: 20 })).toEqual([])
    }
    // The seeds reach both kinds of answer.
    expect(sources.has('charted')).toBe(true)
    expect(sources.has('best-effort')).toBe(true)
  }, 60_000)
})

/* -------------------------------------------------------------------------
 * Performance
 * ---------------------------------------------------------------------- */

describe('planRoute performance', () => {
  it('plans a 20-mile passage through a busy chart in under a second', () => {
    // 20 NM north-east through a chart of a few thousand depth-band polygons
    // (contour-like rings), islands to go round and scattered hazards.
    const depthAreas: ChartFeatures['depthAreas'] = [
      { minDepthM: 6, rings: [rect(-45000, -45000, 45000, 45000)] },
    ]
    const land: ChartFeatures['land'] = []
    const hazards: ChartFeatures['hazards'] = []
    let seed = 99
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let k = 0; k < 2500; k++) {
      const cx = rand() * 60000 - 20000
      const cy = rand() * 60000 - 20000
      const r = 40 + rand() * 300
      const ring: Ring = []
      const n = 24
      for (let i = 0; i <= n; i++) {
        const th = ((i % n) / n) * 2 * Math.PI
        const rr = r * (0.7 + 0.3 * Math.sin(3 * th + k))
        ring.push(ll(cx + rr * Math.cos(th), cy + rr * Math.sin(th)))
      }
      if (k % 10 === 0) land.push({ rings: [ring] })
      else depthAreas.push({ minDepthM: k % 3 === 0 ? 0.8 : 4, rings: [ring] })
    }
    for (let k = 0; k < 300; k++) {
      hazards.push({ ...at(rand() * 50000 - 15000, rand() * 50000 - 15000), radiusM: 40, kind: 'wreck', label: 'wreck' })
    }
    const features = sea({ depthAreas, land, hazards })
    const to = at(20 * NM_TO_METERS * Math.SQRT1_2, 20 * NM_TO_METERS * Math.SQRT1_2)
    const t0 = performance.now()
    const plan = planRoute({ from: at(0, 0), to, safeDepthM: 1.5, clearanceM: 30, speedKn: 20, features })
    const ms = performance.now() - t0
    expect(plan.source).toBe('charted')
    expect(plan.totalNM).toBeGreaterThan(19.9)
    expect(ms).toBeLessThan(1000)
    expect(independentCheck(plan, features, { safeDepthM: 1.5, clearanceM: 30, stepM: 5, ringEveryM: 50 })).toEqual([])
  })
})

/* -------------------------------------------------------------------------
 * Real chart data — Galveston
 *
 * A trimmed copy of what NOAA's ENC Direct actually returned for the
 * Galveston Channel and the lower bay (harbour band at level 5, coastal band
 * at level 3), clipped to the passage and quantised to about a metre. The
 * coastal chart draws the Galveston Channel as part of the island; the
 * harbour chart charts it at 9 m. This is the route the first version drew
 * as a straight line across Pelican Island.
 * ---------------------------------------------------------------------- */

interface Fixture {
  origin: [number, number]
  scale: number
  depth: [number, number, number[][]][]
  land: [number, number[][]][]
  channels: [string, number[][]][]
}

function loadGalveston(): ChartFeatures {
  const path = fileURLToPath(new URL('./__fixtures__/galveston-enc.json', import.meta.url))
  const fx = JSON.parse(readFileSync(path, 'utf8')) as Fixture
  const ring = (d: number[]): Ring => {
    const out: Ring = []
    let x = 0
    let y = 0
    for (let i = 0; i < d.length; i += 2) {
      x += d[i]
      y += d[i + 1]
      out.push([fx.origin[0] + x / fx.scale, fx.origin[1] + y / fx.scale])
    }
    out.push(out[0])
    return out
  }
  return {
    depthAreas: fx.depth.map(([level, minDepthM, rings]) => ({ level, minDepthM, rings: rings.map(ring) })),
    land: fx.land.map(([level, rings]) => ({ level, rings: rings.map(ring) })),
    channels: fx.channels.map(([k, rings]) => ({
      kind: k === 'd' ? ('dredged' as const) : ('fairway' as const),
      rings: rings.map(ring),
    })),
    hazards: [],
    lines: [],
    coverage: 'full',
  }
}

describe('planRoute on the Galveston chart', () => {
  const features = loadGalveston()
  const from = { lat: 29.3115, lon: -94.79 }
  const to = { lat: 29.37, lon: -94.82 }

  it('plans Galveston Channel to Galveston Bay as a charted route that really is in water', () => {
    const plan = planRoute({ from, to, safeDepthM: 1.5, clearanceM: 30, speedKn: 20, features })
    expect(plan.source).toBe('charted')
    expect(plan.needsConfirm).toBe(false)
    expect(plan.points.length).toBeGreaterThan(2)
    expect(plan.totalNM).toBeGreaterThan(haversineNM(from.lat, from.lon, to.lat, to.lon))
    expect(plan.totalNM).toBeLessThan(8)
    expect(
      independentCheck(plan, features, { safeDepthM: 1.5, clearanceM: 30, stepM: 3, ringEveryM: 25 }),
    ).toEqual([])
    expectTidy(plan)
  })

  it('stays charted for a deeper boat with a wider stand-off', () => {
    const plan = planRoute({ from, to, safeDepthM: 2.5, clearanceM: 60, speedKn: 20, features })
    expect(plan.source).toBe('charted')
    expect(
      independentCheck(plan, features, { safeDepthM: 2.5, clearanceM: 60, stepM: 3, ringEveryM: 25 }),
    ).toEqual([])
  })

  // Every boat the settings allow, on the canonical passage, and a handful
  // of other passages across the bay and the channel — each re-measured
  // against the raw polygons with nothing shared with the planner.
  const boats = [0.6, 1.5, 2.5].flatMap((safeDepthM) =>
    [5, 30].map((clearanceM) => ({ safeDepthM, clearanceM })),
  )
  it.each(boats)(
    'is charted and really in water for a $safeDepthM m boat keeping $clearanceM m off',
    ({ safeDepthM, clearanceM }) => {
      const plan = planRoute({ from, to, safeDepthM, clearanceM, speedKn: 20, features })
      expect(plan.source).toBe('charted')
      expect(plan.arrivalFt).toHaveLength(plan.points.length)
      expect(
        independentCheck(plan, features, { safeDepthM, clearanceM, stepM: 4, ringEveryM: 40 }),
      ).toEqual([])
      for (const leg of plan.legs) {
        expect(metresBetween(leg.from, leg.to)).toBeGreaterThanOrEqual(20)
      }
    },
  )

  const passages: [string, LatLon, LatLon, number, number][] = [
    ['bay to channel', { lat: 29.3724, lon: -94.8064 }, { lat: 29.3147, lon: -94.785 }, 1.5, 30],
    ['along the bay', { lat: 29.3806, lon: -94.7965 }, { lat: 29.3561, lon: -94.7993 }, 2.5, 5],
    ['across the bay', { lat: 29.3718, lon: -94.8046 }, { lat: 29.3333, lon: -94.7782 }, 0.6, 30],
  ]
  it.each(passages)('plans %s as a charted route', (_name, a, b, safeDepthM, clearanceM) => {
    const plan = planRoute({ from: a, to: b, safeDepthM, clearanceM, speedKn: 20, features })
    expect(plan.source).toBe('charted')
    expect(plan.points[0]).toEqual(a)
    expect(plan.points[plan.points.length - 1]).toEqual(b)
    expect(
      independentCheck(plan, features, { safeDepthM, clearanceM, stepM: 4, ringEveryM: 40 }),
    ).toEqual([])
  })

  it('moves a destination the chart puts on land, and runs no other leg over land', () => {
    const a = { lat: 29.312, lon: -94.8088 }
    const b = { lat: 29.3667, lon: -94.7767 }
    expect(bruteState(features, b.lat, b.lon)).toBe(-Infinity)
    const plan = planRoute({ from: a, to: b, safeDepthM: 1.5, clearanceM: 30, speedKn: 20, features })
    expect(plan.source).toBe('best-effort')
    expect(plan.needsConfirm).toBe(true)
    expect(plan.movedEnd).not.toBeNull()
    expect(plan.warnings.join(' ')).toMatch(/chart shows your destination on land/i)
    // Only the last leg, off the charted land onto the water, may touch land.
    plan.legs.slice(0, -1).forEach((leg) => {
      const n = Math.ceil(metresBetween(leg.from, leg.to) / 3)
      for (let k = 0; k <= n; k++) {
        const s = bruteState(
          features,
          leg.from.lat + ((leg.to.lat - leg.from.lat) * k) / n,
          leg.from.lon + ((leg.to.lon - leg.from.lon) * k) / n,
        )
        expect(s).not.toBe(-Infinity)
      }
    })
    expect(independentCheck(plan, features, { safeDepthM: 1.5, clearanceM: 30, stepM: 4, ringEveryM: 40 })).toEqual([])
  })

  it('draws nothing from a start on land far from any water, and says why', () => {
    const plan = planRoute({
      from: { lat: 29.3339, lon: -94.8008 },
      to: { lat: 29.37, lon: -94.82 },
      safeDepthM: 1.5,
      clearanceM: 30,
      speedKn: 20,
      features,
    })
    expect(plan.source).toBe('none')
    expect(plan.points).toEqual([])
    expect(plan.failure).toMatch(/your start is on land/i)
  })
})
