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
 *   4. A* across the usable cells, preferring the middle of navigable water
 *      over shaving a bank, and preferring a marked channel over open water.
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
  /**
   * What it is. A pile is a fixed structure in a well-known position; a wreck
   * is a hull somewhere near a reported one. They deserve different footprints
   * and read differently on a leg card, so the kind is carried rather than
   * being stringified into the label and lost.
   */
  kind: 'wreck' | 'obstruction' | 'rock' | 'pile'
  label: string
}

/**
 * Water a boat is meant to be in — a dredged area or a fairway.
 *
 * Geometry only, deliberately carrying no depth. A DRGARE does have a
 * `DRVAL1` and is recorded as a depth polygon too; a FAIRWY has none at all,
 * and inventing one for it would be exactly the guess this engine refuses to
 * make everywhere else. The consequence is worth knowing before it is filed as
 * a bug: **a fairway over water no depth area covers is unusable**, because
 * unknown water is not usable and a fairway is not a survey. Being marked
 * makes water preferable, never passable.
 */
export interface ChannelPolygon {
  kind: 'dredged' | 'fairway'
  rings: Ring[]
}

export interface ChartFeatures {
  depthAreas: DepthPolygon[]
  /** Dredged areas and fairways — the water traffic is meant to use. */
  channels: ChannelPolygon[]
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
  channels: [],
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
  /**
   * How much of the leg runs inside a marked channel, 0–1. **Null where no
   * channel is charted in this area at all** — "there is nothing marked here"
   * and "this leg is outside the marked channel" are different facts, and a
   * crew must never read the first as the second.
   */
  channelFraction: number | null
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
  /** Distance run outside marked water, NM. Null where none is charted. */
  outsideChannelNM: number | null
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
/**
 * Cost multiplier right against the stand-off, fading to none by EDGE_FADE×.
 *
 * This is about the *edge of navigable water* — shaving a bank — and has
 * nothing to do with a charted channel, which is a separate preference below.
 * It used to be called CHANNEL_WEIGHT, which made the two impossible to tell
 * apart once marked channels arrived.
 */
const EDGE_WEIGHT = 0.6
const EDGE_FADE_MULTIPLE = 3

/**
 * How much deeper than the boat needs before open water counts as
 * "confidently deep enough", and the course may leave marked water for it.
 *
 * Two metres, and the number comes from how depth areas actually arrive: ENC
 * bands them (0–2, 2–5, 5–10, 10–20 m), so two metres means "a whole band
 * clear of what this boat needs" rather than a value sitting inside the band's
 * own rounding. Absolute rather than a fraction of the draft because what it
 * covers is absolute — the trough of a short steep chop in a bay entrance, and
 * a survey that may be decades old. `safeDepthM` already carries the
 * coxswain's under-keel margin; this is the margin on top of it that buys
 * leaving the channel.
 */
const AMPLE_MARGIN_M = 2

/**
 * Cost added to a cell outside a marked channel — cheap where the water is
 * amply deep, dear where it only just clears the boat.
 *
 * The ordering that matters is OUTSIDE_THIN_WEIGHT > EDGE_WEIGHT. It makes the
 * *worst* cell inside a channel (1.6, hard against the stand-off) cheaper than
 * the *best* cell outside one in water that merely clears the draft (2.5).
 * Without it the router would slide out of a narrow channel purely to stop
 * shaving its bank, which is the opposite of seamanship.
 *
 * What they buy, as a detour a course will accept to stay in the channel:
 * 2.5× where the open water merely clears the draft, 1.25× where it is amply
 * deep. In the narrowest channel, where every cell carries the full bank-edge
 * cost, those become 1.56× and 0.78× — and that second figure losing is the
 * requirement's own escape clause working.
 */
const OUTSIDE_AMPLE_WEIGHT = 0.25
const OUTSIDE_THIN_WEIGHT = 1.5

/**
 * Distance over which leaving a channel ramps up to its full cost, metres.
 *
 * Not a claim that closer is safer. Its job is to keep a short gap between a
 * dredged cut and the fairway continuing it costing in proportion to its
 * length rather than standing up like a wall, and to saturate, which is what
 * stops the penalty swamping the heuristic.
 */
const CHANNEL_FADE_M = 200

/**
 * The share of the penalty charged the instant a cell is outside the channel,
 * before the distance ramp adds the rest.
 *
 * Found by driving the built app rather than by reasoning. With a pure ramp
 * from zero, a cell one cell outside a cut cost about 8 % of the full penalty
 * — near enough to free that the course rounded the bar's tip *just* outside
 * the dredged area for its whole length, hugging the boundary without ever
 * crossing it. That is the letter of the cost function and the opposite of
 * what a coxswain would do.
 *
 * The decision a crew actually makes is binary: in the channel, or not. So
 * the step carries most of the weight and the ramp only says how much worse
 * it gets from there.
 */
const OUTSIDE_STEP = 0.55

/**
 * How far a course may run outside marked water before it is worth saying so.
 *
 * A quarter of a mile is about the run from a channel to a ramp, a dock or an
 * anchorage — which is what a course is *doing* when it leaves one. Warning on
 * that would fire on nearly every harbour route and teach a crew to stop
 * reading the warnings, which is worse than not having them. Absolute rather
 * than a fraction of the passage, because the hazard is absolute: half a mile
 * outside marked water is half a mile outside marked water whether the trip is
 * one mile or twenty.
 */
const CHANNEL_WARN_NM = 0.25

const UNKNOWN = 0
const OPEN = 1
const BLOCKED = 2

/** The length of a diagonal step, in cells. */
const DIAG = Math.SQRT2

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
  /**
   * 1 where a charted channel covers the cell.
   *
   * Geometry only. A channel never makes a cell usable — a dredged cut that
   * has shoaled is still a shoal — it only makes a usable cell preferable.
   */
  channel: Uint8Array
  /**
   * Chamfer distance to the nearest channel cell, in cells. 0 inside one, and
   * Infinity everywhere when nothing is charted.
   */
  channelDist: Float32Array
  /**
   * Does any charted channel actually touch this box? The single switch that
   * makes the whole preference inert on the great majority of the coast that
   * has no dredged area or fairway on it.
   */
  hasChannels: boolean
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
    channel: new Uint8Array(n),
    // Infinity, not 0. A zero fill would read as "every cell is in a channel"
    // if a guard were ever missed, and the safe direction to fail is
    // "everything is outside one".
    channelDist: new Float32Array(n).fill(Infinity),
    hasChannels: false,
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
 * the island as deep water — a rock drawn as navigable.
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

  // The channel plane, painted last and touching nothing else — a channel is
  // a preference, never a permission. It has to come after the classification
  // sweep above, which rewrites every cell; and it lives inside rasterise so
  // no call site can forget it.
  //
  // `painted` comes from the callback rather than from channels.length, so a
  // channel polygon lying entirely outside the box correctly leaves this
  // false. A channel somewhere else is not a channel in this grid.
  let painted = false
  for (const ch of features.channels) {
    fillRings(g, ch.rings, (i) => {
      g.channel[i] = 1
      painted = true
    })
  }
  g.hasChannels = painted
}

/**
 * Distance from every cell to the nearest source cell, in cells.
 *
 * Two-pass 3-4 chamfer — an integer approximation to Euclidean distance that
 * is within about 8 % and costs two linear sweeps rather than a full BFS per
 * cell.
 *
 * `outside` is what lies beyond the grid, and the two callers want opposite
 * answers. The clearance transform wants 0, making the edge a source: a route
 * that leaves the box is a route through water nobody looked at. The channel
 * transform wants Infinity: nothing outside the box is known to be marked
 * water, and treating the edge as a channel would cheapen every cell near it.
 */
export function chamferDistance(
  cols: number,
  rows: number,
  isSource: (i: number) => boolean,
  outside: number,
  d: Float32Array,
): void {
  const INF = 1e9
  for (let i = 0; i < d.length; i++) d[i] = isSource(i) ? 0 : INF

  const at = (col: number, row: number): number =>
    col < 0 || row < 0 || col >= cols || row >= rows
      ? outside
      : d[row * cols + col]

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

/**
 * Distance to the nearest blocked or unknown cell, in cells.
 *
 * Grows the hazards by the crew's stand-off and gives A* its preference for
 * the middle of navigable water. The grid edge counts as blocked.
 */
export function chamferClearance(g: RouteGrid): void {
  chamferDistance(g.cols, g.rows, (i) => g.cells[i] !== OPEN, 0, g.clearCells)
}

/**
 * Distance to the nearest charted channel, in cells.
 *
 * Skipped entirely — and left at Infinity — where nothing is marked, which is
 * most of the coast. That short-circuit is what makes the channel preference
 * cost nothing where it has nothing to say.
 */
export function chamferChannel(g: RouteGrid): void {
  if (!g.hasChannels) {
    g.channelDist.fill(Infinity)
    return
  }
  chamferDistance(
    g.cols,
    g.rows,
    (i) => g.channel[i] === 1,
    Infinity,
    g.channelDist,
  )
}

/* -------------------------------------------------------------------------
 * Passability and visibility
 * ---------------------------------------------------------------------- */

export interface Passability {
  /** Cells of stand-off required from the nearest hazard. */
  dilateCells: number
  /** Beyond this many cells of clearance there is no bank-edge cost. */
  edgeFadeCells: number
  /** Depth at which water outside a channel is confidently deep enough, m. */
  ampleDepthM: number
  /** Cells over which leaving a channel ramps up to its full cost. */
  channelFadeCells: number
}

export function passability(
  g: RouteGrid,
  clearanceM: number,
  safeDepthM: number,
): Passability {
  const dilateCells = Math.max(0, clearanceM / g.cellM)
  return {
    dilateCells,
    edgeFadeCells: dilateCells * EDGE_FADE_MULTIPLE + 1,
    ampleDepthM: safeDepthM + AMPLE_MARGIN_M,
    // In metres, not cells: a cell is 8 m in a harbour and 250 m on a coastal
    // passage, so a fade measured in cells would mean a different thing on
    // every chart. Floored at one cell — below that the grid cannot express a
    // ramp, and a step is the honest representation.
    channelFadeCells: Math.max(1, CHANNEL_FADE_M / g.cellM),
  }
}

/**
 * Extra cost for a cell outside a marked channel.
 *
 * Zero inside a channel, and zero everywhere when none is charted — so a route
 * is never charged for being where it belongs, and nothing changes at all on
 * the great majority of the coast with no dredged area or fairway on it.
 *
 * Two levels, which is the whole of "stay in the channel until there is a
 * clear, deep enough unobstructed path": water clearing the boat by a full
 * depth band is cheap to cross, water that merely clears its draft is dear.
 */
export function channelPenalty(
  g: RouteGrid,
  i: number,
  p: Passability,
): number {
  if (!g.hasChannels) return 0
  if (g.channel[i] === 1) return 0
  const reach = Math.min(1, g.channelDist[i] / p.channelFadeCells)
  const ramp = OUTSIDE_STEP + (1 - OUTSIDE_STEP) * reach
  // An unsurveyed cell has a NaN depth, fails this comparison and lands in the
  // dear branch, which is where it belongs. `passable` should never let one
  // through to here — this is belt and braces, not a live branch.
  const ample = g.depth[i] >= p.ampleDepthM
  return ramp * (ample ? OUTSIDE_AMPLE_WEIGHT : OUTSIDE_THIN_WEIGHT)
}

export function passable(g: RouteGrid, i: number, p: Passability): boolean {
  return g.cells[i] === OPEN && g.clearCells[i] > p.dilateCells
}

/**
 * Walk the straight line between two cells, and say how much of it runs
 * outside a marked channel — in cell lengths — or null if it is not clear
 * water at all.
 *
 * A supercover walk: when the line crosses a corner both neighbouring cells
 * are tested, so the route cannot be squeezed diagonally between two rocks
 * that touch at a corner. A plain Bresenham line would call that gap open.
 * Shoulder cells are tested for water but never counted — they are not on the
 * line.
 *
 * One walk answering both questions is deliberate. `lineOfSight` below is
 * defined in terms of it, so the visibility test and the string-pull cannot
 * drift apart about what a line crosses. A number-or-null rather than a result
 * object because string-pulling is O(n²) in this walk, and a 400-step path
 * would otherwise allocate a six-figure number of short-lived objects on a
 * phone. The starting cell is not counted; it belongs to the leg before.
 */
export function chordOutsideChannel(
  g: RouteGrid,
  a: { col: number; row: number },
  b: { col: number; row: number },
  p: Passability,
): number | null {
  let x0 = Math.floor(a.col)
  let y0 = Math.floor(a.row)
  const x1 = Math.floor(b.col)
  const y1 = Math.floor(b.row)
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  let outside = 0

  for (;;) {
    if (x0 < 0 || y0 < 0 || x0 >= g.cols || y0 >= g.rows) return null
    if (!passable(g, y0 * g.cols + x0, p)) return null
    if (x0 === x1 && y0 === y1) return outside
    const e2 = 2 * err
    const diagonal = e2 > -dy && e2 < dx
    if (diagonal) {
      // Diagonal step: both shoulders must be clear.
      const sideA = y0 * g.cols + (x0 + sx)
      const sideB = (y0 + sy) * g.cols + x0
      if (x0 + sx < 0 || x0 + sx >= g.cols || !passable(g, sideA, p)) return null
      if (y0 + sy < 0 || y0 + sy >= g.rows || !passable(g, sideB, p)) return null
    }
    if (e2 > -dy) {
      err -= dy
      x0 += sx
    }
    if (e2 < dx) {
      err += dx
      y0 += sy
    }
    if (x0 >= 0 && y0 >= 0 && x0 < g.cols && y0 < g.rows) {
      if (g.channel[y0 * g.cols + x0] !== 1) outside += diagonal ? DIAG : 1
    }
  }
}

/** Is there clear water on the straight line between two cells? */
export function lineOfSight(
  g: RouteGrid,
  a: { col: number; row: number },
  b: { col: number; row: number },
  p: Passability,
): boolean {
  return chordOutsideChannel(g, a, b, p) !== null
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


/**
 * Shortest usable path across the grid, in cells.
 *
 * Eight-neighbour with an octile heuristic. Every step cost is at least 1, so
 * the heuristic is both admissible and consistent — which matters twice: the
 * first path popped is optimal, and the closed-set pruning below is sound.
 * A preference that made a cell cheaper than 1 would quietly break both.
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

  // Two costs over a base of one: cells right against the stand-off, and cells
  // outside a marked channel. Both are added, never subtracted, so every step
  // costs at least 1 and the octile heuristic above stays admissible AND
  // consistent. A preference that made a cell cheaper than 1 would break the
  // closed-set pruning below and quietly return a path that is not the best.
  const weight = (i: number): number => {
    const clear = g.clearCells[i] - p.dilateCells
    const edge =
      clear >= p.edgeFadeCells
        ? 0
        : EDGE_WEIGHT * (1 - Math.max(0, clear) / p.edgeFadeCells)
    return 1 + edge + channelPenalty(g, i, p)
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
 *
 * With a marked channel in play the smoother is also bound by a budget: **a
 * chord may not spend more distance outside a channel than the piece of path
 * it replaces.** Without it the string-pull would cheerfully straighten a
 * channel transit into a chord over the bank — the shortest line between two
 * points in a channel is very often not in the channel — and every bit of
 * seamanship A* just paid for would be undone in the last pass.
 *
 * Note the budget is compared against the replaced sub-path rather than
 * against the endpoints' own channel membership. A channel that dog-legs is
 * usually entered and left mid-path, so a rule keyed on the endpoints would be
 * inert in exactly the case that matters.
 *
 * It needs no "is a channel charted?" guard, because it is inert without one:
 * with `channel` all zero, every arriving cell contributes its own step
 * length, so the budget is the sub-path's octile length and the chord's is the
 * octile distance between the same endpoints — which is never longer.
 *
 * That is true in arithmetic and false in floating point, which cost a
 * straight diagonal 49 legs instead of 3 before it was caught. Both sides sum
 * the same irrational √2 a different number of times in a different order, so
 * two mathematically equal lengths differ by about 1e-13 and a strict `>`
 * fires on half the chords. Hence the tolerance: it is pure arithmetic slack,
 * far below any distance the grid can express — a millionth of a cell is
 * microns — and it is what actually makes the no-channel case inert.
 */
export function stringPull(
  g: RouteGrid,
  path: { col: number; row: number }[],
  p: Passability,
): { col: number; row: number }[] {
  if (path.length <= 2) return path.slice()

  // Running total of how much of the path so far ran outside a channel.
  const outAt = new Float64Array(path.length)
  for (let i = 1; i < path.length; i++) {
    const c = path[i]
    const diagonal = c.col !== path[i - 1].col && c.row !== path[i - 1].row
    const step = diagonal ? DIAG : 1
    outAt[i] =
      outAt[i - 1] + (g.channel[c.row * g.cols + c.col] === 1 ? 0 : step)
  }

  const out = [path[0]]
  let anchor = 0
  while (anchor < path.length - 1) {
    let best = anchor + 1
    for (let j = path.length - 1; j > anchor + 1; j--) {
      const chordOut = chordOutsideChannel(g, path[anchor], path[j], p)
      if (chordOut === null) continue
      const budget = outAt[j] - outAt[anchor]
      if (chordOut > budget + budget * 1e-9 + 1e-9) continue
      best = j
      break
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

/**
 * How much of a leg runs inside a marked channel, 0–1, or null where no
 * channel is charted in this area at all.
 *
 * Sampled off the same grid the routing used, on the same walk as
 * `legMinDepth`, so the two numbers on a leg card always describe the same
 * line. A sibling rather than a combined sampler, so `legMinDepth` keeps its
 * own tests and its own meaning.
 */
export function legChannelFraction(
  g: RouteGrid,
  from: LatLon,
  to: LatLon,
): number | null {
  if (!g.hasChannels) return null
  const a = toGrid(g, from)
  const b = toGrid(g, to)
  const steps = Math.max(
    1,
    Math.ceil(Math.max(Math.abs(b.col - a.col), Math.abs(b.row - a.row))),
  )
  let seen = 0
  let inside = 0
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    const col = Math.floor(a.col + (b.col - a.col) * t)
    const row = Math.floor(a.row + (b.row - a.row) * t)
    if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) continue
    seen++
    if (g.channel[row * g.cols + col] === 1) inside++
  }
  return seen === 0 ? null : inside / seen
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
      channelFraction: grid ? legChannelFraction(grid, leg.from, leg.to) : null,
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
    outsideChannelNM: null,
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
  chamferChannel(grid)
  const pass = passability(grid, req.clearanceM, req.safeDepthM)

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

  const outsideChannelNM = grid.hasChannels
    ? legs.reduce((a, l) => a + l.lengthNM * (1 - (l.channelFraction ?? 0)), 0)
    : null
  if (outsideChannelNM !== null && outsideChannelNM > CHANNEL_WARN_NM) {
    warnings.push(
      `${outsideChannelNM.toFixed(1)} NM of this course runs outside the marked channel. ` +
        'The chart shows enough water there, but it is not dredged, not swept and not buoyed — ' +
        'watch your set and check the least depth on each leg.',
    )
  }

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
    outsideChannelNM,
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
