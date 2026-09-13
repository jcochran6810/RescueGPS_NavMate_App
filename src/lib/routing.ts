/**
 * Automatic course plotting — a route from here to there that stays in water
 * the boat can actually use.
 *
 * The whole engine runs on the phone. There is no server in this app to put it
 * on, and a crew planning a passage is often the crew with the worst signal, so
 * "ask a routing service" was never an option. What it does instead:
 *
 *   1. Rasterise the charted depth areas, land and point hazards around the
 *      passage into a grid, keeping the shoalest charted depth per cell.
 *   2. Mark a cell usable when that depth clears the boat's draft plus the
 *      margin the coxswain set — at **chart datum**, never with tide added.
 *   3. Grow the blocked cells by the lateral stand-off asked for, and measure
 *      how far every cell sits from the nearest hazard.
 *   4. A* across the usable cells, with a mild preference for the middle of
 *      the channel over shaving a bank.
 *   5. Pull the resulting staircase straight into the handful of legs a
 *      coxswain actually steers.
 *
 * Two refusals are deliberate and should not be "fixed" without a very good
 * reason:
 *
 * **Unknown water is not usable.** A cell no depth area covers is water this
 * dataset never surveyed. It is not shallow, but it is not known to be deep,
 * and routing through it is exactly the guess `coords.ts` refuses to make
 * about an ambiguous coordinate. When the whole area is unknown the engine
 * says so and hands back a straight line rather than a fiction.
 *
 * **No tide is added to the charted depth.** Tide would open up shortcuts, and
 * a shortcut that depends on the tide being in is a grounding waiting for a
 * delay, a wrong prediction or a northerly blowing the water out. Tide belongs
 * on the screen next to the leg, as information; it does not belong in the
 * cost function. `tidalOpportunity()` below exists to surface the shortcut as
 * a decision for the coxswain, not to take it.
 */

import { bearingDeg, haversineNM, metersPerDegree, NM_TO_METERS } from './geo'
import { buildLegs, type LatLon, type PatternLeg } from './search'

/* -------------------------------------------------------------------------
 * Chart features — what the ENC query hands us
 * ---------------------------------------------------------------------- */

/** GeoJSON ring order: an array of rings, each an array of [lon, lat]. */
export type Ring = [number, number][]

export interface DepthPolygon {
  /** Shoalest depth in the band, metres below chart datum. */
  minDepthM: number
  rings: Ring[]
}

export interface LandPolygon {
  rings: Ring[]
}

export interface PointHazard {
  lat: number
  lon: number
  /** Metres. Wrecks and obstructions get a footprint, not a pinprick. */
  radiusM: number
  label: string
}

export interface ChartFeatures {
  depthAreas: DepthPolygon[]
  land: LandPolygon[]
  hazards: PointHazard[]
  /**
   * How much of the requested area the query actually returned.
   * `partial` means a transfer limit was hit — some hazard may be missing,
   * which the route must say out loud.
   */
  coverage: 'full' | 'partial' | 'none'
}

export const EMPTY_FEATURES: ChartFeatures = {
  depthAreas: [],
  land: [],
  hazards: [],
  coverage: 'none',
}

/* -------------------------------------------------------------------------
 * Request and result
 * ---------------------------------------------------------------------- */

export interface RouteRequest {
  from: LatLon
  to: LatLon
  /** Draft + under-keel margin, metres. See vessel.ts `safeDepthM`. */
  safeDepthM: number
  /** Lateral stand-off kept from every hazard, metres. */
  clearanceM: number
  /** Knots. Used for the time estimate only — never for the geometry. */
  speedKn: number
  features: ChartFeatures
}

export interface RouteLeg extends PatternLeg {
  /** Hours from departure to the END of this leg. */
  etaHours: number
  /** Shoalest charted depth anywhere along the leg, or null where unsurveyed. */
  minChartedDepthM: number | null
}

export type RouteSource = 'charted' | 'straight'

export interface RoutePlan {
  /** Every point in order, departure first — drawn and steered as-is. */
  points: LatLon[]
  legs: RouteLeg[]
  totalNM: number
  /** Time to run at the requested speed, hours. */
  hours: number
  source: RouteSource
  coverage: ChartFeatures['coverage']
  /** Things the crew must read before steering this. */
  warnings: string[]
  /** Set when the endpoints had to be moved to reach usable water. */
  movedStart: LatLon | null
  movedEnd: LatLon | null
}

/* -------------------------------------------------------------------------
 * Tunables
 * ---------------------------------------------------------------------- */

/** Longest grid side. 500 × 500 = 250 000 cells — tens of ms, not seconds. */
const MAX_SIDE = 500
/** No point resolving finer than the GPS under the boat. */
const MIN_CELL_M = 8
/** Box margin as a fraction of the direct distance, then clamped. */
const MARGIN_FRACTION = 0.35
const MIN_MARGIN_M = NM_TO_METERS
const MAX_MARGIN_M = 20 * NM_TO_METERS
/** How far an endpoint may be nudged to find usable water. */
const SNAP_RADIUS_M = 400
/** Cost multiplier right against the stand-off, fading to none by PREFER×. */
const CHANNEL_WEIGHT = 0.6
const PREFER_MULTIPLE = 3

const UNKNOWN = 0
const OPEN = 1
const BLOCKED = 2

/* -------------------------------------------------------------------------
 * The grid
 * ---------------------------------------------------------------------- */

export interface RouteGrid {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
  cols: number
  rows: number
  cellM: number
  latPerRow: number
  lonPerCol: number
  /** UNKNOWN | OPEN | BLOCKED, before dilation. */
  cells: Uint8Array
  /** Shoalest charted depth per cell, NaN where nothing is charted. */
  depth: Float32Array
  /** Chamfer distance to the nearest blocked cell, in cells. */
  clearCells: Float32Array
}

export function gridIndex(g: RouteGrid, col: number, row: number): number {
  return row * g.cols + col
}

/** Fractional grid column/row for a position. Row 0 is the north edge. */
export function toGrid(g: RouteGrid, p: LatLon): { col: number; row: number } {
  return {
    col: (p.lon - g.minLon) / g.lonPerCol,
    row: (g.maxLat - p.lat) / g.latPerRow,
  }
}

/** Centre of a cell, as a position. */
export function toLatLon(g: RouteGrid, col: number, row: number): LatLon {
  return {
    lat: g.maxLat - (row + 0.5) * g.latPerRow,
    lon: g.minLon + (col + 0.5) * g.lonPerCol,
  }
}

/**
 * Box the passage sits in, with room to go around whatever is in the way.
 *
 * The margin is a fraction of the direct distance rather than a constant: a
 * quarter-mile hop across a channel does not need ten miles of grid, and a
 * twenty-mile passage around a headland genuinely does.
 */
export function routeBounds(
  from: LatLon,
  to: LatLon,
): { minLat: number; minLon: number; maxLat: number; maxLon: number } {
  const directM = haversineNM(from.lat, from.lon, to.lat, to.lon) * NM_TO_METERS
  const marginM = Math.min(
    MAX_MARGIN_M,
    Math.max(MIN_MARGIN_M, directM * MARGIN_FRACTION),
  )
  const midLat = (from.lat + to.lat) / 2
  const mpd = metersPerDegree(midLat)
  const dLat = marginM / mpd.lat
  const dLon = marginM / mpd.lon
  return {
    minLat: Math.min(from.lat, to.lat) - dLat,
    maxLat: Math.max(from.lat, to.lat) + dLat,
    minLon: Math.min(from.lon, to.lon) - dLon,
    maxLon: Math.max(from.lon, to.lon) + dLon,
  }
}

export function makeGrid(from: LatLon, to: LatLon): RouteGrid {
  const b = routeBounds(from, to)
  const midLat = (b.minLat + b.maxLat) / 2
  const mpd = metersPerDegree(midLat)
  const spanLatM = (b.maxLat - b.minLat) * mpd.lat
  const spanLonM = (b.maxLon - b.minLon) * mpd.lon
  const cellM = Math.max(MIN_CELL_M, Math.max(spanLatM, spanLonM) / MAX_SIDE)
  const rows = Math.max(2, Math.min(MAX_SIDE, Math.ceil(spanLatM / cellM)))
  const cols = Math.max(2, Math.min(MAX_SIDE, Math.ceil(spanLonM / cellM)))
  const n = rows * cols
  return {
    ...b,
    rows,
    cols,
    cellM,
    latPerRow: (b.maxLat - b.minLat) / rows,
    lonPerCol: (b.maxLon - b.minLon) / cols,
    cells: new Uint8Array(n),
    depth: new Float32Array(n).fill(NaN),
    clearCells: new Float32Array(n),
  }
}

/* -------------------------------------------------------------------------
 * Rasterising polygons
 * ---------------------------------------------------------------------- */

/**
 * Scanline fill of a set of rings, even-odd.
 *
 * All rings are crossed in one pass rather than filled one at a time, which is
 * what makes a hole a hole: an island inside a depth area alternates the
 * parity back to "outside" and is left alone. Filling ring by ring would paint
 * the island as deep water — a rock drawn as a channel.
 */
export function fillRings(
  g: RouteGrid,
  rings: Ring[],
  paint: (index: number) => void,
): void {
  if (rings.length === 0) return

  // Project once, and track the row band the polygon actually touches.
  const projected: { x: number; y: number }[][] = []
  let minRow = Infinity
  let maxRow = -Infinity
  for (const ring of rings) {
    if (ring.length < 3) continue
    const pts = ring.map(([lon, lat]) => {
      const p = toGrid(g, { lat, lon })
      if (p.row < minRow) minRow = p.row
      if (p.row > maxRow) maxRow = p.row
      return { x: p.col, y: p.row }
    })
    projected.push(pts)
  }
  if (projected.length === 0) return

  const rowFrom = Math.max(0, Math.floor(minRow))
  const rowTo = Math.min(g.rows - 1, Math.ceil(maxRow))
  const xs: number[] = []

  for (let row = rowFrom; row <= rowTo; row++) {
    const yc = row + 0.5
    xs.length = 0
    for (const pts of projected) {
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[j]
        const b = pts[i]
        // Half-open test: an edge counts when it straddles the scanline, so a
        // vertex exactly on it is not counted twice.
        if (a.y <= yc !== b.y <= yc) {
          xs.push(a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x))
        }
      }
    }
    if (xs.length < 2) continue
    xs.sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const colFrom = Math.max(0, Math.ceil(xs[k] - 0.5))
      const colTo = Math.min(g.cols - 1, Math.floor(xs[k + 1] - 0.5))
      const base = row * g.cols
      for (let col = colFrom; col <= colTo; col++) paint(base + col)
    }
  }
}

/**
 * Paint the chart onto the grid.
 *
 * Depth areas first, keeping the SHOALEST reading where bands overlap, then
 * land, then point hazards. Shoalest-wins is the only safe reconciliation: if
 * two sources disagree about a cell, the boat has to believe the shallow one.
 */
export function rasterise(
  g: RouteGrid,
  features: ChartFeatures,
  safeDepthM: number,
): void {
  for (const poly of features.depthAreas) {
    const d = poly.minDepthM
    if (!Number.isFinite(d)) continue
    fillRings(g, poly.rings, (i) => {
      const prev = g.depth[i]
      g.depth[i] = Number.isNaN(prev) ? d : Math.min(prev, d)
    })
  }

  for (let i = 0; i < g.cells.length; i++) {
    const d = g.depth[i]
    if (Number.isNaN(d)) g.cells[i] = UNKNOWN
    else g.cells[i] = d >= safeDepthM ? OPEN : BLOCKED
  }

  for (const poly of features.land) {
    fillRings(g, poly.rings, (i) => {
      g.cells[i] = BLOCKED
      g.depth[i] = 0
    })
  }

  for (const h of features.hazards) {
    const p = toGrid(g, h)
    const rCells = Math.max(1, h.radiusM / g.cellM)
    const rowFrom = Math.max(0, Math.floor(p.row - rCells))
    const rowTo = Math.min(g.rows - 1, Math.ceil(p.row + rCells))
    const colFrom = Math.max(0, Math.floor(p.col - rCells))
    const colTo = Math.min(g.cols - 1, Math.ceil(p.col + rCells))
    for (let row = rowFrom; row <= rowTo; row++) {
      for (let col = colFrom; col <= colTo; col++) {
        const dx = col + 0.5 - p.col
        const dy = row + 0.5 - p.row
        if (dx * dx + dy * dy <= rCells * rCells) {
          g.cells[row * g.cols + col] = BLOCKED
        }
      }
    }
  }
}

/**
 * Distance from every cell to the nearest blocked or unknown cell, in cells.
 *
 * Two-pass 3-4 chamfer — an integer approximation to Euclidean distance that
 * is within about 8 % and costs two linear sweeps rather than a full BFS per
 * cell. Used for two things at once: growing the hazards by the crew's
 * stand-off, and giving A* its preference for the middle of the channel.
 *
 * The grid edge counts as blocked. A route that leaves the box is a route
 * through water nobody looked at.
 */
export function chamferClearance(g: RouteGrid): void {
  const { cols, rows, cells, clearCells: d } = g
  const INF = 1e9
  for (let i = 0; i < cells.length; i++) d[i] = cells[i] === OPEN ? INF : 0

  const at = (col: number, row: number): number =>
    col < 0 || row < 0 || col >= cols || row >= rows ? 0 : d[row * cols + col]

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col
      if (d[i] === 0) continue
      d[i] = Math.min(
        d[i],
        at(col - 1, row) + 3,
        at(col, row - 1) + 3,
        at(col - 1, row - 1) + 4,
        at(col + 1, row - 1) + 4,
      )
    }
  }
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = cols - 1; col >= 0; col--) {
      const i = row * cols + col
      if (d[i] === 0) continue
      d[i] = Math.min(
        d[i],
        at(col + 1, row) + 3,
        at(col, row + 1) + 3,
        at(col + 1, row + 1) + 4,
        at(col - 1, row + 1) + 4,
      )
    }
  }
  // Chamfer units back to cells: 3 units is one orthogonal step.
  for (let i = 0; i < d.length; i++) d[i] = d[i] === 0 ? 0 : d[i] / 3
}

/* -------------------------------------------------------------------------
 * Passability and visibility
 * ---------------------------------------------------------------------- */

export interface Passability {
  /** Cells of stand-off required from the nearest hazard. */
  dilateCells: number
  /** Beyond this many cells of clearance there is no channel preference. */
  preferCells: number
}

export function passability(g: RouteGrid, clearanceM: number): Passability {
  const dilateCells = Math.max(0, clearanceM / g.cellM)
  return { dilateCells, preferCells: dilateCells * PREFER_MULTIPLE + 1 }
}

export function passable(g: RouteGrid, i: number, p: Passability): boolean {
  return g.cells[i] === OPEN && g.clearCells[i] > p.dilateCells
}

/**
 * Is there clear water on the straight line between two cells?
 *
 * A supercover walk — when the line crosses a corner both neighbouring cells
 * are tested — so the route cannot be squeezed diagonally between two rocks
 * that touch at a corner. A plain Bresenham line would call that gap open.
 */
export function lineOfSight(
  g: RouteGrid,
  a: { col: number; row: number },
  b: { col: number; row: number },
  p: Passability,
): boolean {
  let x0 = Math.floor(a.col)
  let y0 = Math.floor(a.row)
  const x1 = Math.floor(b.col)
  const y1 = Math.floor(b.row)
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy

  for (;;) {
    if (x0 < 0 || y0 < 0 || x0 >= g.cols || y0 >= g.rows) return false
    if (!passable(g, y0 * g.cols + x0, p)) return false
    if (x0 === x1 && y0 === y1) return true
    const e2 = 2 * err
    if (e2 > -dy && e2 < dx) {
      // Diagonal step: both shoulders must be clear.
      const sideA = y0 * g.cols + (x0 + sx)
      const sideB = (y0 + sy) * g.cols + x0
      if (x0 + sx < 0 || x0 + sx >= g.cols || !passable(g, sideA, p)) return false
      if (y0 + sy < 0 || y0 + sy >= g.rows || !passable(g, sideB, p)) return false
    }
    if (e2 > -dy) {
      err -= dy
      x0 += sx
    }
    if (e2 < dx) {
      err += dx
      y0 += sy
    }
  }
}

/**
 * Nearest usable cell to a position, searched outward in rings.
 *
 * A GPS fix taken alongside a dock, in a boathouse, or on the trailer lands on
 * "land" as far as the chart is concerned. Refusing to plan at all there would
 * be pedantic; silently starting somewhere else would be worse. So it snaps a
 * short way and the plan records that it did.
 */
export function snapToWater(
  g: RouteGrid,
  p: LatLon,
  pass: Passability,
): { col: number; row: number; moved: boolean } | null {
  const start = toGrid(g, p)
  const col0 = Math.floor(start.col)
  const row0 = Math.floor(start.row)
  const inside =
    col0 >= 0 && row0 >= 0 && col0 < g.cols && row0 < g.rows
  if (inside && passable(g, row0 * g.cols + col0, pass)) {
    return { col: col0, row: row0, moved: false }
  }
  const maxR = Math.ceil(SNAP_RADIUS_M / g.cellM)
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const col = col0 + dx
        const row = row0 + dy
        if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) continue
        if (passable(g, row * g.cols + col, pass)) return { col, row, moved: true }
      }
    }
  }
  return null
}

/* -------------------------------------------------------------------------
 * A*
 * ---------------------------------------------------------------------- */

/** Binary min-heap over cell indices, keyed by f. */
class Heap {
  private items: number[] = []
  private f: Float64Array
  constructor(f: Float64Array) {
    this.f = f
  }
  get size(): number {
    return this.items.length
  }
  push(i: number): void {
    const a = this.items
    a.push(i)
    let c = a.length - 1
    while (c > 0) {
      const p = (c - 1) >> 1
      if (this.f[a[p]] <= this.f[a[c]]) break
      ;[a[p], a[c]] = [a[c], a[p]]
      c = p
    }
  }
  pop(): number {
    const a = this.items
    const top = a[0]
    const last = a.pop() as number
    if (a.length > 0) {
      a[0] = last
      let p = 0
      for (;;) {
        const l = 2 * p + 1
        const r = l + 1
        let m = p
        if (l < a.length && this.f[a[l]] < this.f[a[m]]) m = l
        if (r < a.length && this.f[a[r]] < this.f[a[m]]) m = r
        if (m === p) break
        ;[a[p], a[m]] = [a[m], a[p]]
        p = m
      }
    }
    return top
  }
}

const DIAG = Math.SQRT2

/**
 * Shortest usable path across the grid, in cells.
 *
 * Eight-neighbour with an octile heuristic, so the heuristic is admissible for
 * the step costs actually used and the first path popped is optimal. The
 * channel preference is a multiplier on step cost rather than a separate term,
 * which keeps it proportional: it can bend a route around a bank but it can
 * never justify a detour longer than about 1.6×.
 */
export function astar(
  g: RouteGrid,
  start: { col: number; row: number },
  goal: { col: number; row: number },
  p: Passability,
): { col: number; row: number }[] | null {
  const n = g.cols * g.rows
  const gScore = new Float64Array(n).fill(Infinity)
  const fScore = new Float64Array(n).fill(Infinity)
  const cameFrom = new Int32Array(n).fill(-1)
  const closed = new Uint8Array(n)

  const si = start.row * g.cols + start.col
  const gi = goal.row * g.cols + goal.col
  if (!passable(g, si, p) || !passable(g, gi, p)) return null

  const h = (i: number): number => {
    const dx = Math.abs((i % g.cols) - goal.col)
    const dy = Math.abs(Math.floor(i / g.cols) - goal.row)
    return Math.max(dx, dy) + (DIAG - 1) * Math.min(dx, dy)
  }

  // Cells right against the stand-off cost more, fading to nothing by
  // preferCells. This is what keeps a boat off the edge of a channel.
  const weight = (i: number): number => {
    const clear = g.clearCells[i] - p.dilateCells
    if (clear >= p.preferCells) return 1
    return 1 + CHANNEL_WEIGHT * (1 - Math.max(0, clear) / p.preferCells)
  }

  gScore[si] = 0
  fScore[si] = h(si)
  const open = new Heap(fScore)
  open.push(si)

  while (open.size > 0) {
    const cur = open.pop()
    if (cur === gi) break
    if (closed[cur]) continue
    closed[cur] = 1
    const col = cur % g.cols
    const row = (cur - col) / g.cols

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nc = col + dx
        const nr = row + dy
        if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue
        const ni = nr * g.cols + nc
        if (closed[ni] || !passable(g, ni, p)) continue
        // No cutting a corner between two blocked cells.
        if (dx !== 0 && dy !== 0) {
          if (!passable(g, row * g.cols + nc, p)) continue
          if (!passable(g, nr * g.cols + col, p)) continue
        }
        const step = dx !== 0 && dy !== 0 ? DIAG : 1
        const tentative = gScore[cur] + step * weight(ni)
        if (tentative < gScore[ni]) {
          gScore[ni] = tentative
          fScore[ni] = tentative + h(ni)
          cameFrom[ni] = cur
          open.push(ni)
        }
      }
    }
  }

  if (cameFrom[gi] === -1 && gi !== si) return null
  const path: { col: number; row: number }[] = []
  for (let i = gi; i !== -1; i = cameFrom[i]) {
    path.push({ col: i % g.cols, row: Math.floor(i / g.cols) })
    if (i === si) break
  }
  path.reverse()
  return path
}

/**
 * Collapse a grid staircase into the legs a coxswain steers.
 *
 * Keep the furthest point still visible in a straight line from the one being
 * held, then start again from there. A 400-step A* path through a harbour
 * comes out as three or four legs, which is what goes on a chart and what fits
 * on a phone.
 */
export function stringPull(
  g: RouteGrid,
  path: { col: number; row: number }[],
  p: Passability,
): { col: number; row: number }[] {
  if (path.length <= 2) return path.slice()
  const out = [path[0]]
  let anchor = 0
  while (anchor < path.length - 1) {
    let best = anchor + 1
    for (let j = path.length - 1; j > anchor + 1; j--) {
      if (lineOfSight(g, path[anchor], path[j], p)) {
        best = j
        break
      }
    }
    out.push(path[best])
    anchor = best
  }
  return out
}

/* -------------------------------------------------------------------------
 * Depth along a leg
 * ---------------------------------------------------------------------- */

/**
 * Shoalest charted depth along a leg, or null where nothing is charted.
 *
 * This is the number that answers "why did it take me the long way round" and
 * the number a coxswain checks against their own chart before accepting the
 * route, so it is sampled from the same grid the routing used rather than
 * recomputed from the features.
 */
export function legMinDepth(g: RouteGrid, from: LatLon, to: LatLon): number | null {
  const a = toGrid(g, from)
  const b = toGrid(g, to)
  const steps = Math.max(
    1,
    Math.ceil(Math.max(Math.abs(b.col - a.col), Math.abs(b.row - a.row))),
  )
  let min: number | null = null
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    const col = Math.floor(a.col + (b.col - a.col) * t)
    const row = Math.floor(a.row + (b.row - a.row) * t)
    if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) continue
    const d = g.depth[row * g.cols + col]
    if (Number.isNaN(d)) continue
    if (min === null || d < min) min = d
  }
  return min
}

/* -------------------------------------------------------------------------
 * The plan
 * ---------------------------------------------------------------------- */

function legsFrom(
  points: LatLon[],
  speedKn: number,
  grid: RouteGrid | null,
): { legs: RouteLeg[]; totalNM: number; hours: number } {
  const { legs, totalNM } = buildLegs(points, () => true)
  const usableSpeed = Number.isFinite(speedKn) && speedKn > 0 ? speedKn : NaN
  let run = 0
  const out: RouteLeg[] = legs.map((leg) => {
    run += leg.lengthNM
    return {
      ...leg,
      kind: 'search',
      etaHours: usableSpeed > 0 ? run / usableSpeed : NaN,
      minChartedDepthM: grid ? legMinDepth(grid, leg.from, leg.to) : null,
    }
  })
  return {
    legs: out,
    totalNM,
    hours: usableSpeed > 0 ? totalNM / usableSpeed : NaN,
  }
}

function straightPlan(
  req: RouteRequest,
  warnings: string[],
  coverage: ChartFeatures['coverage'],
  grid: RouteGrid | null,
): RoutePlan {
  const points = [req.from, req.to]
  const { legs, totalNM, hours } = legsFrom(points, req.speedKn, grid)
  return {
    points,
    legs,
    totalNM,
    hours,
    source: 'straight',
    coverage,
    warnings,
    movedStart: null,
    movedEnd: null,
  }
}

/**
 * Plot a course.
 *
 * Always returns a plan. When the chart cannot support one it returns the
 * straight line with `source: 'straight'` and says why in `warnings` — a crew
 * that asked for a course and got nothing back has been given a blank screen
 * in the one moment they needed an answer, and a straight line they have been
 * told not to trust is still more use than that.
 */
export function planRoute(req: RouteRequest): RoutePlan {
  const warnings: string[] = []
  const { features } = req

  const directNM = haversineNM(req.from.lat, req.from.lon, req.to.lat, req.to.lon)
  if (!Number.isFinite(directNM) || directNM === 0) {
    return straightPlan(req, ['Start and destination are the same place.'], features.coverage, null)
  }

  if (features.coverage === 'none' || features.depthAreas.length === 0) {
    warnings.push(
      'No charted depths for this area — this is a straight line, not a route. ' +
        'Check it against the chart before you run it.',
    )
    return straightPlan(req, warnings, 'none', null)
  }

  const grid = makeGrid(req.from, req.to)
  rasterise(grid, features, req.safeDepthM)
  chamferClearance(grid)
  const pass = passability(grid, req.clearanceM)

  const start = snapToWater(grid, req.from, pass)
  const goal = snapToWater(grid, req.to, pass)

  if (!start) {
    warnings.push(
      'Your position is not in water this boat can use on the chart. ' +
        'Showing a straight line — steer clear on your own eyes until you are in the channel.',
    )
    return straightPlan(req, warnings, features.coverage, grid)
  }
  if (!goal) {
    warnings.push(
      'The destination is on land or too shallow for this draft. ' +
        'Showing a straight line — pick a point in navigable water to get a course.',
    )
    return straightPlan(req, warnings, features.coverage, grid)
  }

  const raw = astar(grid, start, goal, pass)
  if (!raw) {
    warnings.push(
      `No charted route at ${req.safeDepthM.toFixed(1)} m of water. ` +
        'Showing a straight line — a shallower draft, a smaller stand-off, or local knowledge is needed.',
    )
    return straightPlan(req, warnings, features.coverage, grid)
  }

  const pulled = stringPull(grid, raw, pass)
  const points: LatLon[] = pulled.map((c) => toLatLon(grid, c.col, c.row))
  // The real endpoints are what the crew asked for; only replace them when the
  // snap actually moved somewhere else, and say so when it did.
  const movedStart = start.moved ? points[0] : null
  const movedEnd = goal.moved ? points[points.length - 1] : null
  if (!start.moved) points[0] = req.from
  if (!goal.moved) points[points.length - 1] = req.to

  if (movedStart) {
    warnings.push('Started from the nearest navigable water — you are not in it yet.')
  }
  if (movedEnd) {
    warnings.push('Destination moved to the nearest navigable water.')
  }
  if (features.coverage === 'partial') {
    warnings.push(
      'The chart query hit its limit, so some hazards in this area may be missing.',
    )
  }

  const { legs, totalNM, hours } = legsFrom(points, req.speedKn, grid)
  return {
    points,
    legs,
    totalNM,
    hours,
    source: 'charted',
    coverage: features.coverage,
    warnings,
    movedStart,
    movedEnd,
  }
}

/* -------------------------------------------------------------------------
 * Tide, as information
 * ---------------------------------------------------------------------- */

export interface TidalOpportunity {
  /** Extra depth needed for the direct line to work, metres. */
  neededM: number
  shorterByNM: number
}

/**
 * How much water the direct line is short of, and what taking it would save.
 *
 * This is the honest way to surface the shortcut the tide opens up: the number
 * is put on screen next to the high-water time so the coxswain can decide,
 * and the route itself is never planned on it. See the file header.
 */
export function tidalOpportunity(
  plan: RoutePlan,
  grid: RouteGrid,
  safeDepthM: number,
): TidalOpportunity | null {
  if (plan.source !== 'charted' || plan.points.length < 3) return null
  const from = plan.points[0]
  const to = plan.points[plan.points.length - 1]
  const directDepth = legMinDepth(grid, from, to)
  if (directDepth === null || directDepth >= safeDepthM) return null
  const directNM = haversineNM(from.lat, from.lon, to.lat, to.lon)
  const shorterByNM = plan.totalNM - directNM
  if (shorterByNM <= 0.1) return null
  return { neededM: safeDepthM - directDepth, shorterByNM }
}

/** Course to steer and distance to run for the next turn point. */
export function steerTo(
  fix: LatLon,
  target: LatLon,
): { courseDeg: number; distanceNM: number } {
  return {
    courseDeg: bearingDeg(fix.lat, fix.lon, target.lat, target.lon),
    distanceNM: haversineNM(fix.lat, fix.lon, target.lat, target.lon),
  }
}
