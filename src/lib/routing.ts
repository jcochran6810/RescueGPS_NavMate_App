/**
 * Automatic course plotting — a route from here to there that stays in water
 * the boat can actually use, and away from everything it could hit.
 *
 * The whole engine runs on the phone. There is no server in this app to put it
 * on, and a crew planning a passage is often the crew with the worst signal, so
 * "ask a routing service" was never an option. What it does instead:
 *
 *   1. Index the chart once (`routeGeometry.ts`): every depth area, piece of
 *      land, line and point hazard, projected into metres, with the pieces of
 *      boundary where the water actually changes worked out in advance.
 *   2. Rasterise that into a grid **conservatively** — a cell is only usable
 *      when *every* part of it is deep enough and clear of land and hazards —
 *      and measure how far every cell sits from the nearest land or hazard.
 *   3. A* across the usable cells, preferring the middle of navigable water
 *      over shaving a bank, and preferring a marked channel over open water.
 *   4. Pull the resulting staircase straight into the handful of legs a
 *      coxswain actually steers.
 *   5. **Check every leg against the real chart**, not the grid, and re-plan
 *      any that fails on a finer grid around it. The grid proposes; the chart
 *      disposes. A plan is only called `charted` when every leg passes.
 *   6. Where no fully safe route exists, find the safest one and say exactly
 *      where and how it falls short — a `best-effort` plan the crew has to
 *      confirm. Never a straight line through land.
 *
 * The rules it holds a route to are the crew's own, in this order:
 *
 * - **Depth, the whole way.** Every point of every leg is in charted water at
 *   least `safeDepthM` deep (draft + under-keel margin) at chart datum.
 * - **Stand-off from land and hazards.** Every leg keeps `clearanceM` from
 *   land, structures and every charted hazard's footprint. The stand-off is
 *   deliberately NOT applied to the edge of shallow water: a dredged channel
 *   is shallow bank either side by design, and growing the bank by the
 *   stand-off closed exactly the channels a boat is meant to use.
 * - **The approach exception.** Within `approachM` (default 120 m) of the
 *   start and the destination — the dock, the ramp, the marina — the route may
 *   use water charted in a band that starts shallower than the boat needs,
 *   unsurveyed water, and run closer to land than the stand-off. Such legs are
 *   flagged `shallow-approach` and drawn dotted: "check depth here". Land and
 *   hazard footprints are never passable, approach or not.
 *
 * Two refusals are deliberate and should not be "fixed" without a very good
 * reason:
 *
 * **Unknown water is not usable.** A cell no depth area covers is water this
 * dataset never surveyed. It is not shallow, but it is not known to be deep,
 * and routing through it is exactly the guess `coords.ts` refuses to make
 * about an ambiguous coordinate. (Near the ends, the approach exception above
 * covers the unsurveyed corner of a marina; out on a passage it does not.)
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
import {
  CLEARANCE_MEASURE_M,
  LAND,
  chartIndexFor,
  checkSegment,
  distanceTransform,
  forEachHazardIn,
  forEachPieceIn,
  fromXY,
  hazardDistance,
  inHazardArea,
  pointSegDist2,
  segRectDist,
  stateAt,
  toXY,
  traverseCells,
  type Bounds,
  type ChartIndex,
  type SegmentCheck,
  type Zone,
} from './routeGeometry'

/* -------------------------------------------------------------------------
 * Chart features — what the ENC query hands us
 * ---------------------------------------------------------------------- */

/** GeoJSON ring order: an array of rings, each an array of [lon, lat]. */
export type Ring = [number, number][]

export interface DepthPolygon {
  /** Shoalest depth in the band, metres below chart datum. */
  minDepthM: number
  rings: Ring[]
  /**
   * How detailed the chart this came from is — higher is a larger-scale
   * (finer) chart. Absent means 0. See `rasterise` for why it matters.
   */
  level?: number
}

export interface LandPolygon {
  rings: Ring[]
  /** As on `DepthPolygon`. */
  level?: number
  /**
   * An area hazard rather than land: a wreck, obstruction or rock charted as
   * an area, a pylon's or platform's footprint, a hulk. Land takes part in
   * "finest chart wins" — a harbour chart may rightly open water a coastal
   * chart drew as land — but a hazard does not: a wreck on any chart blocks,
   * whatever a finer chart says about the depth around it. Absent means land.
   */
  hazard?: boolean
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
  kind: 'wreck' | 'obstruction' | 'rock' | 'pile' | 'pylon' | 'islet' | 'platform'
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

/**
 * A hazard charted as a line — a jetty, breakwater, pier, obstruction line or
 * causeway. Kept as polylines (not closed rings); the router treats every
 * segment as solid, with `widthM` of its own and the crew's stand-off beyond.
 */
export interface LineHazard {
  kind: 'structure' | 'obstruction'
  /** Each path is an array of [lon, lat], open (not closed). */
  paths: [number, number][][]
  /** Physical width assumed for the structure, metres. */
  widthM: number
  label: string
  /** As on `DepthPolygon`. */
  level?: number
}

export interface ChartFeatures {
  /** Line hazards (jetties, piers, obstruction lines). Optional for older callers. */
  lines?: LineHazard[]
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
  /**
   * Chart bands (`'harbour'`, `'approach'`, …) that were asked for and could
   * not be read, while another band did answer. Their absence makes the
   * coverage `partial`: the area was planned on coarser charts than it should
   * have been, and the crew is told so. Absent or empty means nothing failed.
   */
  failedBands?: string[]
}

export const EMPTY_FEATURES: ChartFeatures = {
  lines: [],
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
  /**
   * The capture radius the crew steers with, feet (100–200). Turn points are
   * given a per-point `arrivalFt` no larger than this, reduced where
   * switching that early would cut the corner into shallow water or the
   * stand-off. Default 150.
   */
  arrivalFt?: number
  /**
   * How far from each endpoint the route may run through water charted in a
   * band that starts shallower than the boat needs (or not surveyed), metres —
   * the dock, ramp or marina stretch. Such legs are flagged
   * `caution: 'shallow-approach'`. Default 120 m (~400 ft).
   */
  approachM?: number
}

/**
 * Why a leg needs the crew's eyes.
 *
 * - `ok` — clears the depth and the stand-off along its whole length.
 * - `shallow-approach` — runs within `approachM` of the start or destination
 *   through water charted as possibly shallower than the boat needs, not
 *   surveyed, or closer to land or a hazard than the stand-off (a dock is
 *   always closer to land than the stand-off). Allowed by design so docks and
 *   ramps work; drawn dotted — "check depth here".
 * - `reduced-clearance` — keeps the depth, but passes land or a hazard closer
 *   than the stand-off. Only in a best-effort plan.
 * - `unsafe-depth` — crosses water charted shallower than the boat needs (or
 *   unsurveyed, or — only on the short leg from a position the chart shows on
 *   land — land). Only in a best-effort plan.
 */
export type LegCaution = 'ok' | 'shallow-approach' | 'reduced-clearance' | 'unsafe-depth'

export interface RouteLeg extends PatternLeg {
  /** Hours from departure to the END of this leg. */
  etaHours: number
  /**
   * Shoalest charted depth anywhere along the leg (land counts as 0), or null
   * where nothing along it is charted. Measured on the chart itself.
   */
  minChartedDepthM: number | null
  /**
   * How much of the leg runs inside a marked channel, 0–1. **Null where no
   * channel is charted in this area at all** — "there is nothing marked here"
   * and "this leg is outside the marked channel" are different facts, and a
   * crew must never read the first as the second.
   */
  channelFraction: number | null
  /** See `LegCaution`. */
  caution: LegCaution
  /**
   * Least distance from the leg to land or a charted hazard's footprint,
   * metres, measured against the chart geometry itself (not the grid). Null
   * where nothing is charted within `CLEARANCE_MEASURE_M` (or twice the
   * stand-off, if larger).
   */
  minClearanceM: number | null
}

/**
 * - `charted` — every leg keeps the depth and the stand-off (legs may still be
 *   `shallow-approach` at the ends).
 * - `best-effort` — no fully safe route exists; this is the safest one found,
 *   with the failing legs flagged. The crew must confirm before steering it.
 * - `none` — nothing to draw: no chart, or no water path at all. `points` is
 *   empty and `failure` says why in plain words.
 * - `straight` — LEGACY, never produced any more; kept only until the UI stops
 *   referring to it.
 */
export type RouteSource = 'charted' | 'best-effort' | 'none' | 'straight'

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
  /**
   * Safe capture radius per point, feet, index-aligned with `points`. Never
   * larger than the requested `arrivalFt`. The steering engine switches to the
   * next point inside this radius.
   */
  arrivalFt: number[]
  /** When `source === 'none'`: the reason, in plain words for the crew. */
  failure: string | null
  /** True for a `best-effort` plan: steering needs an explicit confirmation. */
  needsConfirm: boolean
}

/* -------------------------------------------------------------------------
 * Tunables
 * ---------------------------------------------------------------------- */

/**
 * Most cells in one grid. 250 000 is a 500 × 500 square: tens of
 * milliseconds to search on a laptop, a few hundred on a slow phone.
 */
const MAX_CELLS = 250_000
/** Longest side of any grid, however elongated the box. */
const MAX_SIDE = 1_200
/** No point resolving finer than the GPS under the boat. */
const MIN_CELL_M = 8

/** Box margin as a fraction of the direct distance, then clamped. */
const MARGIN_FRACTION = 0.35
const MIN_MARGIN_M = NM_TO_METERS
const MAX_MARGIN_M = 20 * NM_TO_METERS

/**
 * The planning box — see `planningBounds`. Generous on purpose: an island or a
 * spoil bank beside a short hop needs a detour far wider than the hop.
 */
const PLAN_MARGIN_FRACTION = 0.6
const PLAN_MIN_MARGIN_M = 2 * NM_TO_METERS
const PLAN_MAX_MARGIN_M = 25 * NM_TO_METERS

/** How far an endpoint may be nudged to find usable water. */
const SNAP_RADIUS_M = 400

/** The approach stretch at each end, metres. */
const DEFAULT_APPROACH_M = 120

/** Capture radius, feet: default, and the floor a turn point may be cut to. */
const DEFAULT_ARRIVAL_FT = 150
const MIN_ARRIVAL_FT = 30
const FT_TO_M = 0.3048

/**
 * Repair grids — the finer grid a failing leg is re-planned on. Cells a third
 * of the stand-off, never above 10 m, never below 2 m; the grid capped so a
 * repair costs tens of milliseconds, not seconds.
 */
const LOCAL_MAX_CELLS = 160_000
const MIN_LOCAL_CELL_M = 2
const MAX_LOCAL_CELL_M = 10
const MAX_REPAIR_DEPTH = 3
/** Total repairs one plan may spend — bounded work whatever the chart. */
const REPAIR_BUDGET = 40

/**
 * How much shorter the optimistic read's route must be before it replaces the
 * conservative one. Both passed the same check against the chart; this only
 * stops a few metres' difference from swapping a route that rides a channel
 * for one that does not.
 */
const OPTIMISTIC_GAIN = 0.05

/** Legs shorter than this, and turns smaller than this, are merged away. */
const STUB_LEG_M = 20
const STRAIGHT_TURN_DEG = 3

/**
 * The best-effort ladder: the stand-off is reduced to these fractions of what
 * was asked, never below the floor, before shallow water is considered.
 */
const LADDER_FRACTIONS = [0.75, 0.5, 0.25]
const CLEARANCE_FLOOR_M = 3

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

/**
 * Extra cost of a cell that is only usable because of the approach
 * exception — shallow or unsurveyed near an end, or inside the stand-off
 * there. High, so the course leaves the dock for proper water as directly as
 * it can instead of running along the quay.
 */
const APPROACH_WEIGHT = 4

/**
 * Extra cost, on the best-effort ladder, of a cell closer to land or a hazard
 * than the stand-off asked for — scaled by how much closer. Makes the route
 * give up only as much of the stand-off as it has to, where it has to.
 */
const REDUCED_WEIGHT = 3

/**
 * Extra cost, on the last rung of the ladder, of water shallower than the
 * boat needs: a flat price for being there at all, plus a price that grows
 * with the deficit as a fraction of what the boat needs. So the route crosses
 * as little of it as it can, and the deepest part of what it must cross.
 * (Unsurveyed water is not on offer even then — see `cellCost`.)
 */
const SHALLOW_BASE = 10
const SHALLOW_PER_DEFICIT = 40

const UNKNOWN = 0
const OPEN = 1
const BLOCKED = 2

/** Bits of `RouteGrid.hard`. */
const HARD_LAND = 1
const HARD_HAZARD = 2

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
  /** Side of a (square) cell, metres. */
  cellM: number
  latPerRow: number
  lonPerCol: number
  /**
   * UNKNOWN | OPEN | BLOCKED for the depth the grid was rasterised for — a
   * summary for display and the older callers. The planner itself reads the
   * layers below.
   */
  cells: Uint8Array
  /**
   * Shoalest charted depth ANYWHERE in the cell (land counts as 0), NaN
   * where nothing in the cell is charted. Conservative: one corner of a cell
   * on a bar makes the whole cell as shallow as the bar.
   */
  depth: Float32Array
  /** 1 where any part of the cell is unsurveyed. */
  unknown: Uint8Array
  /** Bits: 1 land (or structure) touches the cell, 2 a hazard footprint does. */
  hard: Uint8Array
  /**
   * Distance from this cell's rectangle to the nearest rectangle of a `hard`
   * cell, in cells — so a cell with `clearCells * cellM ≥ c` has every point
   * in it at least `c` from land and hazards. The grid edge counts as hard: a
   * route may not leave the box.
   */
  clearCells: Float32Array
  /**
   * Nearest distance to shallow, unsurveyed or hard water, cell centre to cell
   * centre. A preference only — keeps the course off the edges of a channel —
   * never a stand-off.
   */
  shoalCells: Float32Array
  /** The chart's state at each cell centre: depth, 0 for land, NaN unknown. */
  cDepth: Float32Array
  /** `hard` bits, at the cell centre only. */
  cHard: Uint8Array
  /** Centre-to-centre distance to the nearest `cHard` cell, in cells. */
  cClear: Float32Array
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

function boxAround(from: LatLon, to: LatLon, marginM: number): Bounds {
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

/**
 * Box the passage is first searched in, with room to go around whatever is in
 * the way.
 *
 * The margin is a fraction of the direct distance rather than a constant: a
 * quarter-mile hop across a channel does not need ten miles of grid, and a
 * twenty-mile passage around a headland genuinely does. When nothing safe fits
 * in here, the search is repeated over `planningBounds`.
 */
export function routeBounds(
  from: LatLon,
  to: LatLon,
): { minLat: number; minLon: number; maxLat: number; maxLon: number } {
  const directM = haversineNM(from.lat, from.lon, to.lat, to.lon) * NM_TO_METERS
  const marginM = Math.min(MAX_MARGIN_M, Math.max(MIN_MARGIN_M, directM * MARGIN_FRACTION))
  return boxAround(from, to, marginM)
}

/**
 * The box the chart must cover for this passage — the one the navigation
 * store loads the chart for, and the widest the planner will ever search.
 *
 * The margin is at least 2 NM and 0.6 of the direct distance, clamped to
 * 25 NM. The first version searched only `routeBounds`, and the commonest
 * reason a short hop failed was an island or spoil bank beside it whose way
 * round lay outside a one-mile box.
 */
export function planningBounds(from: LatLon, to: LatLon): Bounds {
  const directM = haversineNM(from.lat, from.lon, to.lat, to.lon) * NM_TO_METERS
  const marginM = Math.min(
    PLAN_MAX_MARGIN_M,
    Math.max(PLAN_MIN_MARGIN_M, directM * PLAN_MARGIN_FRACTION),
  )
  return boxAround(from, to, marginM)
}

/**
 * An empty grid over (at least) this box, with square cells.
 *
 * The box is grown by up to a cell so the cells come out square: a cell
 * narrower in one direction than `cellM` says would make every distance
 * measured in cells an overestimate — the unsafe direction.
 */
export function makeGridFor(b: Bounds, cellM?: number, maxCells: number = MAX_CELLS): RouteGrid {
  const midLat = (b.minLat + b.maxLat) / 2
  const midLon = (b.minLon + b.maxLon) / 2
  const mpd = metersPerDegree(midLat)
  const spanLatM = Math.max(1, (b.maxLat - b.minLat) * mpd.lat)
  const spanLonM = Math.max(1, (b.maxLon - b.minLon) * mpd.lon)
  const cell = Math.max(
    cellM ?? MIN_CELL_M,
    Math.sqrt((spanLatM * spanLonM) / maxCells),
    spanLatM / MAX_SIDE,
    spanLonM / MAX_SIDE,
  )
  const rows = Math.max(2, Math.ceil(spanLatM / cell - 1e-9))
  const cols = Math.max(2, Math.ceil(spanLonM / cell - 1e-9))
  const latPerRow = cell / mpd.lat
  const lonPerCol = cell / mpd.lon
  const n = rows * cols
  return {
    minLat: midLat - (rows * latPerRow) / 2,
    maxLat: midLat + (rows * latPerRow) / 2,
    minLon: midLon - (cols * lonPerCol) / 2,
    maxLon: midLon + (cols * lonPerCol) / 2,
    rows,
    cols,
    cellM: cell,
    latPerRow,
    lonPerCol,
    cells: new Uint8Array(n),
    depth: new Float32Array(n).fill(NaN),
    unknown: new Uint8Array(n),
    hard: new Uint8Array(n),
    clearCells: new Float32Array(n),
    shoalCells: new Float32Array(n).fill(Infinity),
    cDepth: new Float32Array(n).fill(NaN),
    cHard: new Uint8Array(n),
    cClear: new Float32Array(n),
    channel: new Uint8Array(n),
    // Infinity, not 0. A zero fill would read as "every cell is in a channel"
    // if a guard were ever missed, and the safe direction to fail is
    // "everything is outside one".
    channelDist: new Float32Array(n).fill(Infinity),
    hasChannels: false,
  }
}

/** The grid for `routeBounds(from, to)`. */
export function makeGrid(from: LatLon, to: LatLon): RouteGrid {
  return makeGridFor(routeBounds(from, to))
}

/* -------------------------------------------------------------------------
 * Rasterising
 * ---------------------------------------------------------------------- */

/**
 * Scanline fill of a set of rings at cell centres, even-odd.
 *
 * All rings are crossed in one pass rather than filled one at a time, which is
 * what makes a hole a hole: an island inside a depth area alternates the
 * parity back to "outside" and is left alone. Filling ring by ring would paint
 * the island as deep water — a rock drawn as navigable.
 *
 * Only the channel plane uses this now; the chart itself is rasterised from
 * the index (see `rasteriseIndex`), which also sees what lies between centres.
 */
export function fillRings(
  g: RouteGrid,
  rings: Ring[],
  paint: (index: number) => void,
): void {
  if (rings.length === 0) return
  // One list of crossings per row, built edge by edge: linear in the edges
  // plus the crossings, where scanning every edge for every row was not.
  const rowXs = new Map<number, number[]>()
  for (const ring of rings) {
    if (ring.length < 3) continue
    const n = ring.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = (ring[j][0] - g.minLon) / g.lonPerCol
      const ay = (g.maxLat - ring[j][1]) / g.latPerRow
      const bx = (ring[i][0] - g.minLon) / g.lonPerCol
      const by = (g.maxLat - ring[i][1]) / g.latPerRow
      if (![ax, ay, bx, by].every(Number.isFinite)) continue
      const lo = Math.min(ay, by)
      const hi = Math.max(ay, by)
      const r0 = Math.max(0, Math.ceil(lo - 0.5))
      const r1 = Math.min(g.rows - 1, Math.floor(hi - 0.5))
      for (let row = r0; row <= r1; row++) {
        const yc = row + 0.5
        // Half-open: an edge counts when it straddles the scanline, so a
        // vertex exactly on it is not counted twice.
        if (ay <= yc === by <= yc) continue
        let xs = rowXs.get(row)
        if (!xs) {
          xs = []
          rowXs.set(row, xs)
        }
        xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax))
      }
    }
  }
  for (const [row, xs] of rowXs) {
    if (xs.length < 2) continue
    xs.sort((p, q) => p - q)
    const base = row * g.cols
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const colFrom = Math.max(0, Math.ceil(xs[k] - 0.5))
      const colTo = Math.min(g.cols - 1, Math.floor(xs[k + 1] - 0.5))
      for (let col = colFrom; col <= colTo; col++) paint(base + col)
    }
  }
}

/** How a grid maps onto an index's metres: col = (x − x0)/w, row = (yTop − y)/h. */
interface GridMap {
  x0: number
  yTop: number
  w: number
  h: number
}

function gridMap(g: RouteGrid, ix: ChartIndex): GridMap {
  const pr = ix.proj
  return {
    x0: (g.minLon - pr.lon0) * pr.mLon,
    yTop: (g.maxLat - pr.lat0) * pr.mLat,
    w: g.lonPerCol * pr.mLon,
    h: g.latPerRow * pr.mLat,
  }
}

/**
 * Paint the chart onto the grid, conservatively.
 *
 * Every cell gets the chart's state at its centre, and then — the part that
 * makes the grid honest — every piece of effective boundary is walked cell by
 * cell and the states on BOTH its sides are folded into every cell it
 * touches. Inside a cell the chart only changes across such a piece, so the
 * result is the worst state anywhere in the cell: a bar thinner than a cell,
 * lying between two cell centres, still closes the cells it crosses. The
 * first version sampled centres only, and routed straight over exactly that.
 *
 * "Worst" here is: land beats everything, then unsurveyed, then the shoalest
 * depth. Across charts of different scale the state itself is already the
 * finest-chart-wins answer (`stateAt`), which is the rule every ECDIS uses —
 * a coastal chart generalises a 12 m dredged cut into the 0–2 m flat either
 * side of it and draws a harbour's marinas as solid land, and shoalest-wins
 * across scales would let that close every channel the harbour chart
 * surveyed. Hazards are the exception: a wreck, pile or obstruction from any
 * chart blocks, whatever the finer chart says about the water around it.
 */
export function rasteriseIndex(
  g: RouteGrid,
  ix: ChartIndex,
  channels: ChannelPolygon[],
  safeDepthM: number,
): void {
  const m = gridMap(g, ix)
  const { cols, rows } = g

  // 1. The state at every cell centre.
  for (let row = 0; row < rows; row++) {
    const y = m.yTop - (row + 0.5) * m.h
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col
      const s = stateAt(ix, m.x0 + (col + 0.5) * m.w, y)
      if (s === LAND) {
        g.cDepth[i] = 0
        g.cHard[i] = HARD_LAND
      } else {
        g.cDepth[i] = s
        g.cHard[i] = 0
      }
      g.depth[i] = g.cDepth[i]
      g.hard[i] = g.cHard[i]
      g.unknown[i] = Number.isNaN(s) ? 1 : 0
    }
  }

  // 2. Both sides of every boundary piece, into every cell it touches.
  const fold = (i: number, s: number) => {
    if (Number.isNaN(s)) {
      g.unknown[i] = 1
      return
    }
    const d = s === LAND ? 0 : s
    if (s === LAND) g.hard[i] |= HARD_LAND
    const prev = g.depth[i]
    g.depth[i] = Number.isNaN(prev) ? d : Math.min(prev, d)
  }
  const gx1 = m.x0 + cols * m.w
  const gy0 = m.yTop - rows * m.h
  forEachPieceIn(ix, m.x0, gy0, gx1, m.yTop, (ax, ay, bx, by, left, right) => {
    traverseCells(
      (ax - m.x0) / m.w, (m.yTop - ay) / m.h, (bx - m.x0) / m.w, (m.yTop - by) / m.h,
      cols, rows,
      (c, r) => {
        const i = r * cols + c
        fold(i, left)
        fold(i, right)
      },
    )
  })

  // 3. Hazards: every cell any part of whose rectangle is inside a
  //    footprint, and — for the optimistic view — every centre that is.
  const cellRect = (c: number, r: number): [number, number, number, number] => [
    m.x0 + c * m.w,
    m.yTop - (r + 1) * m.h,
    m.x0 + (c + 1) * m.w,
    m.yTop - r * m.h,
  ]
  const cellRange = (x0: number, y0: number, x1: number, y1: number) => ({
    c0: Math.max(0, Math.floor((x0 - m.x0) / m.w)),
    c1: Math.min(cols - 1, Math.floor((x1 - m.x0) / m.w)),
    r0: Math.max(0, Math.floor((m.yTop - y1) / m.h)),
    r1: Math.min(rows - 1, Math.floor((m.yTop - y0) / m.h)),
  })
  forEachHazardIn(
    ix, m.x0, gy0, gx1, m.yTop,
    (hx, hy, hr) => {
      const { c0, c1, r0, r1 } = cellRange(hx - hr, hy - hr, hx + hr, hy + hr)
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const [x0, y0, x1, y1] = cellRect(c, r)
          const dx = hx < x0 ? x0 - hx : hx > x1 ? hx - x1 : 0
          const dy = hy < y0 ? y0 - hy : hy > y1 ? hy - y1 : 0
          if (dx * dx + dy * dy > hr * hr) continue
          const i = r * cols + c
          g.hard[i] |= HARD_HAZARD
          const cx = (x0 + x1) / 2 - hx
          const cy = (y0 + y1) / 2 - hy
          if (cx * cx + cy * cy <= hr * hr) g.cHard[i] |= HARD_HAZARD
        }
      }
    },
    (ax, ay, bx, by, hw) => {
      const { c0, c1, r0, r1 } = cellRange(
        Math.min(ax, bx) - hw, Math.min(ay, by) - hw, Math.max(ax, bx) + hw, Math.max(ay, by) + hw,
      )
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const [x0, y0, x1, y1] = cellRect(c, r)
          if (segRectDist(ax, ay, bx, by, x0, y0, x1, y1) > hw) continue
          const i = r * cols + c
          g.hard[i] |= HARD_HAZARD
          if (pointSegDist2((x0 + x1) / 2, (y0 + y1) / 2, ax, ay, bx, by) <= hw * hw) {
            g.cHard[i] |= HARD_HAZARD
          }
        }
      }
    },
  )
  for (const area of ix.hazAreas) {
    const [bx0, by0, bx1, by1] = area.box
    const { c0, c1, r0, r1 } = cellRange(bx0, by0, bx1, by1)
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const [x0, y0, x1, y1] = cellRect(c, r)
        if (inHazardArea(ix, (x0 + x1) / 2, (y0 + y1) / 2)) {
          const i = r * cols + c
          g.hard[i] |= HARD_HAZARD
          g.cHard[i] |= HARD_HAZARD
        }
      }
    }
  }

  // 4. The channel plane, touching nothing else — a channel is a
  //    preference, never a permission. `painted` comes from the callback
  //    rather than from channels.length, so a channel polygon lying entirely
  //    outside the box correctly leaves this false. A channel somewhere else
  //    is not a channel in this grid.
  g.channel.fill(0)
  let painted = false
  for (const ch of channels) {
    fillRings(g, ch.rings, (i) => {
      g.channel[i] = 1
      painted = true
    })
  }
  g.hasChannels = painted

  // 5. Everything derived from those layers — except the centre clearance,
  //    which only the optimistic view needs and `passability` computes then.
  classifyCells(g, safeDepthM)
  rectClearance(g)
  centreReady.delete(g)
  shoalDistance(g, safeDepthM)
  chamferChannel(g)
}

/**
 * Derive the summary and distance layers — `cells`, `clearCells`, `cClear`,
 * `shoalCells`, `channelDist` — from the chart layers (`depth`, `unknown`,
 * `hard`, their centre twins, and `channel`). `rasteriseIndex` ends with
 * this; a grid built by hand (the tests draw them in ASCII) calls it too.
 */
export function prepareGrid(g: RouteGrid, safeDepthM: number): void {
  classifyCells(g, safeDepthM)
  chamferClearance(g)
  shoalDistance(g, safeDepthM)
  chamferChannel(g)
}

function classifyCells(g: RouteGrid, safeDepthM: number): void {
  for (let i = 0; i < g.cells.length; i++) {
    const d = g.depth[i]
    if (g.hard[i] !== 0 || (!Number.isNaN(d) && d < safeDepthM)) g.cells[i] = BLOCKED
    else if (g.unknown[i] === 1 || Number.isNaN(d)) g.cells[i] = UNKNOWN
    else g.cells[i] = OPEN
  }
}

/**
 * Paint the chart onto the grid — the form older callers and the tests use.
 *
 * Indexes the features over the grid's own box (plus a margin, so the grid's
 * edge is not also the chart's edge) and hands over to `rasteriseIndex`.
 */
export function rasterise(
  g: RouteGrid,
  features: ChartFeatures,
  safeDepthM: number,
): void {
  const padLat = 2 * g.latPerRow
  const padLon = 2 * g.lonPerCol
  const ix = chartIndexFor(features, {
    minLat: g.minLat - padLat,
    maxLat: g.maxLat + padLat,
    minLon: g.minLon - padLon,
    maxLon: g.maxLon + padLon,
  })
  rasteriseIndex(g, ix, features.channels, safeDepthM)
}

/**
 * Distance from every cell to the nearest source cell, in cells.
 *
 * Two-pass 3-4 chamfer — an integer approximation to Euclidean distance that
 * is within about 8 % and costs two linear sweeps rather than a full BFS per
 * cell. Used for the channel preference, where 8 % does not matter; the
 * stand-off uses the exact transform (`distanceTransform`), where it does.
 *
 * `outside` is what lies beyond the grid, and the two callers want opposite
 * answers. A clearance-like transform wants 0, making the edge a source: a
 * route that leaves the box is a route through water nobody looked at. The
 * channel transform wants Infinity: nothing outside the box is known to be
 * marked water, and treating the edge as a channel would cheapen every cell
 * near it.
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
  for (let i = 0; i < d.length; i++) d[i] = d[i] === 0 ? 0 : d[i] >= INF ? Infinity : d[i] / 3
}

/**
 * How far each cell is from land and hazards — `clearCells` (rectangle to
 * rectangle, exact) and `cClear` (centre to centre, for the optimistic view).
 *
 * Rectangle distance is what makes the stand-off honest on a coarse grid. Two
 * cells whose centres are three cells apart have rectangles only two cells
 * apart, and the land in the blocked one may sit right on its near edge. The
 * trick: grow the hard cells by one in every direction first, and the plain
 * centre-to-centre distance to that grown set IS the rectangle distance —
 * the ±1 of each offset is exactly what the growth absorbs.
 *
 * The grid edge counts as hard: a route may not leave the box.
 */
export function chamferClearance(g: RouteGrid): void {
  rectClearance(g)
  centreClearance(g)
}

function rectClearance(g: RouteGrid): void {
  const { cols, rows } = g
  const n = cols * rows
  // Grow by one cell: along rows, then along columns (a 3×3 max, separably).
  const across = new Uint8Array(n)
  for (let r = 0; r < rows; r++) {
    const base = r * cols
    for (let c = 0; c < cols; c++) {
      const i = base + c
      across[i] =
        g.hard[i] !== 0 || (c > 0 && g.hard[i - 1] !== 0) || (c + 1 < cols && g.hard[i + 1] !== 0)
          ? 1
          : 0
    }
  }
  const grown = new Uint8Array(n)
  for (let r = 0; r < rows; r++) {
    const base = r * cols
    const edgeRow = r === 0 || r === rows - 1
    for (let c = 0; c < cols; c++) {
      const i = base + c
      // The grid's own border touches the world outside it, which counts
      // as hard.
      grown[i] =
        edgeRow || c === 0 || c === cols - 1 ||
        across[i] !== 0 || across[i - cols] !== 0 || across[i + cols] !== 0
          ? 1
          : 0
    }
  }
  distanceTransform(cols, rows, grown, true, g.clearCells)
}

/**
 * `cClear` — only the optimistic view reads it, so `rasteriseIndex` leaves it
 * to `passability` to compute on first use.
 */
function centreClearance(g: RouteGrid): void {
  distanceTransform(g.cols, g.rows, g.cHard, true, g.cClear)
  centreReady.add(g)
}

const centreReady = new WeakSet<RouteGrid>()

/** Distance to the nearest cell that is not fully usable at this depth. */
function shoalDistance(g: RouteGrid, safeDepthM: number): void {
  const n = g.cols * g.rows
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const d = g.depth[i]
    mask[i] = g.hard[i] !== 0 || g.unknown[i] === 1 || !(d >= safeDepthM) ? 1 : 0
  }
  distanceTransform(g.cols, g.rows, mask, false, g.shoalCells)
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
 * Passability and cost
 * ---------------------------------------------------------------------- */

export interface Passability {
  /** Cells of stand-off the route must keep from land and hazards. */
  dilateCells: number
  /**
   * Cells of stand-off the crew asked for. Above `dilateCells` only on the
   * best-effort ladder, where closer than this costs extra but is allowed.
   */
  wantCells: number
  /** Beyond this many cells of clearance there is no bank-edge cost. */
  edgeFadeCells: number
  /** Depth at which water outside a channel is confidently deep enough, m. */
  ampleDepthM: number
  /** Cells over which leaving a channel ramps up to its full cost. */
  channelFadeCells: number
  /** Draft + under-keel margin, metres. */
  safeDepthM: number
  /** Last rung of the ladder: shallow water allowed, at a price. */
  allowShallow: boolean
  /**
   * Read the centre-only layers instead of the conservative ones — used to
   * find narrow channels a coarse conservative grid closes; the legs it
   * produces are then checked and repaired against the chart.
   */
  optimistic: boolean
  /** 1 where a cell lies wholly inside an approach zone; null for none. */
  zone: Uint8Array | null
}

export interface PassabilityOptions {
  allowShallow?: boolean
  optimistic?: boolean
  zone?: Uint8Array | null
  /** The stand-off asked for, when `clearanceM` is a reduced one. */
  wantClearanceM?: number
}

export function passability(
  g: RouteGrid,
  clearanceM: number,
  safeDepthM: number,
  opts: PassabilityOptions = {},
): Passability {
  const dilateCells = Math.max(0, clearanceM / g.cellM)
  const wantCells = Math.max(dilateCells, (opts.wantClearanceM ?? clearanceM) / g.cellM)
  if (opts.optimistic && !centreReady.has(g)) centreClearance(g)
  return {
    dilateCells,
    wantCells,
    edgeFadeCells: dilateCells * EDGE_FADE_MULTIPLE + 1,
    ampleDepthM: safeDepthM + AMPLE_MARGIN_M,
    // In metres, not cells: a cell is 8 m in a harbour and 250 m on a coastal
    // passage, so a fade measured in cells would mean a different thing on
    // every chart. Floored at one cell — below that the grid cannot express a
    // ramp, and a step is the honest representation.
    channelFadeCells: Math.max(1, CHANNEL_FADE_M / g.cellM),
    safeDepthM,
    allowShallow: opts.allowShallow ?? false,
    optimistic: opts.optimistic ?? false,
    zone: opts.zone ?? null,
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
  // dear branch, which is where it belongs.
  const ample = (p.optimistic ? g.cDepth[i] : g.depth[i]) >= p.ampleDepthM
  return ramp * (ample ? OUTSIDE_AMPLE_WEIGHT : OUTSIDE_THIN_WEIGHT)
}

/**
 * The cost of entering a cell, split in two: `base` (1 + bank edge +
 * channel) is seamanship; `extra` (approach, reduced stand-off, shallow) is
 * the price of bending a rule, which the string-pull may not increase.
 * `base` is Infinity where the cell may not be used at all.
 */
function cellCost(g: RouteGrid, i: number, p: Passability, out: { base: number; extra: number }): void {
  out.base = Infinity
  out.extra = 0
  const opt = p.optimistic
  if ((opt ? g.cHard[i] : g.hard[i]) !== 0) return
  const clear = opt ? g.cClear[i] : g.clearCells[i]
  const zone = p.zone !== null && p.zone[i] !== 0
  let extra = 0
  if (clear < p.dilateCells) {
    if (!zone) return
    extra += APPROACH_WEIGHT
  } else if (clear < p.wantCells) {
    extra += REDUCED_WEIGHT * (1 - clear / p.wantCells)
  }
  const d = opt ? g.cDepth[i] : g.depth[i]
  const unknown = Number.isNaN(d) || (!opt && g.unknown[i] === 1)
  if (unknown || d < p.safeDepthM) {
    if (zone) {
      extra += APPROACH_WEIGHT
    } else if (p.allowShallow && !unknown) {
      // Unsurveyed water stays closed even here: "no chart covers it" is as
      // often a marsh or an inland field as it is water, and a best-effort
      // route is still never a line across land.
      const deficit = Math.min(2, (p.safeDepthM - d) / Math.max(0.1, p.safeDepthM))
      extra += SHALLOW_BASE + SHALLOW_PER_DEFICIT * deficit
    } else {
      return
    }
  }
  // Shaving a bank: the nearer land, a hazard or the edge of shallow water,
  // the dearer — never a wall, only a preference for the middle. Measured
  // centre to centre (a rectangle distance plus one), which is what the
  // fade was tuned on; the stand-off above is the rectangle distance itself.
  const margin = Math.min((opt ? clear : clear + 1) - p.dilateCells, g.shoalCells[i])
  const edge =
    margin >= p.edgeFadeCells ? 0 : EDGE_WEIGHT * (1 - Math.max(0, margin) / p.edgeFadeCells)
  out.base = 1 + edge + channelPenalty(g, i, p)
  out.extra = extra
}

/** Per-cell cost (Infinity = not usable) and rule-bending extra, for one mode. */
interface CostField {
  cost: Float32Array
  extra: Float32Array
}

function costField(g: RouteGrid, p: Passability): CostField {
  const n = g.cols * g.rows
  const cost = new Float32Array(n)
  const extra = new Float32Array(n)
  const out = { base: 0, extra: 0 }
  for (let i = 0; i < n; i++) {
    cellCost(g, i, p, out)
    cost[i] = out.base === Infinity ? Infinity : out.base + out.extra
    extra[i] = out.extra
  }
  return { cost, extra }
}

export function passable(g: RouteGrid, i: number, p: Passability): boolean {
  const out = { base: 0, extra: 0 }
  cellCost(g, i, p, out)
  return out.base !== Infinity
}

/* -------------------------------------------------------------------------
 * Visibility
 * ---------------------------------------------------------------------- */

/**
 * Walk the straight line between two cells, and say how much of it runs
 * outside a marked channel — in cell lengths — or null if it is not clear
 * water at all. `extraOut[0]` gets the rule-bending cost along it.
 *
 * Clear means every cell the continuous line between the two centres passes
 * through — a true supercover, corners included — is usable. The length
 * outside a channel is counted on a Bresenham walk of the same line, one step
 * per cell, so it compares like for like with the path it would replace.
 *
 * One walk answering both questions is deliberate. `lineOfSight` below is
 * defined in terms of it, so the visibility test and the string-pull cannot
 * drift apart about what a line crosses. The starting cell is not counted; it
 * belongs to the leg before.
 */
function chordWalk(
  g: RouteGrid,
  a: { col: number; row: number },
  b: { col: number; row: number },
  f: CostField,
  extraOut: Float64Array | null,
): number | null {
  let x0 = Math.floor(a.col)
  let y0 = Math.floor(a.row)
  const x1 = Math.floor(b.col)
  const y1 = Math.floor(b.row)
  if (x0 < 0 || y0 < 0 || x0 >= g.cols || y0 >= g.rows) return null
  if (x1 < 0 || y1 < 0 || x1 >= g.cols || y1 >= g.rows) return null
  const clear = traverseCells(
    x0 + 0.5, y0 + 0.5, x1 + 0.5, y1 + 0.5,
    g.cols, g.rows,
    (c, r) => f.cost[r * g.cols + c] !== Infinity,
  )
  if (!clear) return null
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  let outside = 0
  let extra = 0
  while (x0 !== x1 || y0 !== y1) {
    const e2 = 2 * err
    const diagonal = e2 > -dy && e2 < dx
    if (e2 > -dy) {
      err -= dy
      x0 += sx
    }
    if (e2 < dx) {
      err += dx
      y0 += sy
    }
    const i = y0 * g.cols + x0
    const step = diagonal ? DIAG : 1
    if (g.channel[i] !== 1) outside += step
    extra += f.extra[i] * step
  }
  if (extraOut) extraOut[0] = extra
  return outside
}

/**
 * How much of the straight line between two cells runs outside a marked
 * channel, in cell lengths, or null if it is not clear water.
 */
export function chordOutsideChannel(
  g: RouteGrid,
  a: { col: number; row: number },
  b: { col: number; row: number },
  p: Passability,
): number | null {
  return chordWalk(g, a, b, costField(g, p), null)
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

/* -------------------------------------------------------------------------
 * Finding usable water near a point
 * ---------------------------------------------------------------------- */

/** Usable cells within `radiusM` of a position, nearest first (true distance). */
function nearbyCells(
  g: RouteGrid,
  p: LatLon,
  cost: Float32Array,
  radiusM: number,
): { i: number; d: number }[] {
  const at = toGrid(g, p)
  const R = Math.ceil(radiusM / g.cellM) + 1
  const c0 = Math.floor(at.col)
  const r0 = Math.floor(at.row)
  const out: { i: number; d: number }[] = []
  for (let r = Math.max(0, r0 - R); r <= Math.min(g.rows - 1, r0 + R); r++) {
    for (let c = Math.max(0, c0 - R); c <= Math.min(g.cols - 1, c0 + R); c++) {
      const i = r * g.cols + c
      if (cost[i] === Infinity) continue
      // The cell the point is in is distance 0: the point is already there.
      const own = c === c0 && r === r0
      const d = own ? 0 : Math.hypot(c + 0.5 - at.col, r + 0.5 - at.row) * g.cellM
      if (d > radiusM) continue
      out.push({ i, d })
    }
  }
  out.sort((x, y) => x.d - y.d)
  return out
}

/**
 * Nearest usable cell to a position — by true distance, not by the rings of
 * a square — within `SNAP_RADIUS_M`.
 *
 * A GPS fix taken alongside a dock, in a boathouse, or on the trailer lands on
 * "land" as far as the chart is concerned. Refusing to plan at all there would
 * be pedantic; silently starting somewhere else would be worse. So it snaps a
 * short way and the plan records that it did. (The planner itself also
 * insists the cell is connected to the other end — see `pickEnds`.)
 */
export function snapToWater(
  g: RouteGrid,
  p: LatLon,
  pass: Passability,
): { col: number; row: number; moved: boolean } | null {
  const { cost } = costField(g, pass)
  const near = nearbyCells(g, p, cost, SNAP_RADIUS_M)
  if (near.length === 0) return null
  const at = toGrid(g, p)
  const i = near[0].i
  const col = i % g.cols
  const row = (i - col) / g.cols
  return { col, row, moved: !(col === Math.floor(at.col) && row === Math.floor(at.row)) }
}

/** Connected regions of usable cells, 8-way without corner-cutting; −1 unusable. */
function components(g: RouteGrid, cost: Float32Array): Int32Array {
  const { cols, rows } = g
  const n = cols * rows
  const label = new Int32Array(n).fill(-1)
  const queue = new Int32Array(n)
  let next = 0
  for (let s = 0; s < n; s++) {
    if (label[s] !== -1 || cost[s] === Infinity) continue
    let head = 0
    let tail = 0
    queue[tail++] = s
    label[s] = next
    while (head < tail) {
      const cur = queue[head++]
      const col = cur % cols
      const row = (cur - col) / cols
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nc = col + dx
          const nr = row + dy
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
          const ni = nr * cols + nc
          if (label[ni] !== -1 || cost[ni] === Infinity) continue
          if (dx !== 0 && dy !== 0) {
            if (cost[row * cols + nc] === Infinity || cost[nr * cols + col] === Infinity) continue
          }
          label[ni] = next
          queue[tail++] = ni
        }
      }
    }
    next++
  }
  return label
}

/**
 * Why a position cannot be used, and how far the nearest water that can be.
 *
 * "Your position is not in water this boat can use" is true and almost
 * useless: it does not say whether the spot is dry land, too shallow, or fine
 * water that the stand-off has closed off — and those have three different
 * answers. Nor does it say whether usable water is a boat length away or a
 * mile, which is the difference between nudging the pin and picking somewhere
 * else entirely.
 *
 * The search here is deliberately much wider than `snapToWater`'s, because it
 * only *reports* the distance. Nothing is moved on the strength of it; the
 * crew decides.
 */
export function describeUnusable(
  g: RouteGrid,
  p: LatLon,
  pass: Passability,
): { why: string; nearestNM: number | null } {
  const at = toGrid(g, p)
  const col0 = Math.floor(at.col)
  const row0 = Math.floor(at.row)
  const inside = col0 >= 0 && row0 >= 0 && col0 < g.cols && row0 < g.rows

  let why = 'outside the area the chart was loaded for'
  if (inside) {
    const i = row0 * g.cols + col0
    const d = g.depth[i]
    if (g.hard[i] & HARD_LAND) {
      why = 'on land, or on a structure the chart draws as land'
    } else if (g.hard[i] & HARD_HAZARD) {
      why = 'inside the footprint of a charted hazard (a wreck, obstruction, rock, pile or pylon)'
    } else if (!Number.isNaN(d) && d < pass.safeDepthM) {
      why = describeDepth(d)
    } else if (g.unknown[i] === 1 || Number.isNaN(d)) {
      why = 'in water this chart never surveyed'
    } else {
      // Deep enough, clear of land: the only thing left is the stand-off.
      why = 'too close to land or a hazard for the stand-off this boat is set to keep'
    }
  }

  // Far enough to tell a crew whether to nudge the pin or move it properly.
  const { cost } = costField(g, pass)
  const maxR = Math.ceil((5 * NM_TO_METERS) / g.cellM)
  let best: number | null = null
  for (let r = 1; r <= maxR && best === null; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const col = col0 + dx
        const row = row0 + dy
        if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) continue
        if (cost[row * g.cols + col] === Infinity) continue
        const found = toLatLon(g, col, row)
        const d = haversineNM(p.lat, p.lon, found.lat, found.lon)
        if (best === null || d < best) best = d
      }
    }
  }
  return { why, nearestNM: best }
}

/** A charted depth, as a place: "in 3 ft (0.9 m) of charted water". */
function describeDepth(d: number): string {
  if (d < 0) return `on a bank that dries ${formatDepth(-d)} at chart datum`
  return `in ${formatDepth(d)} of charted water at chart datum`
}

/* -------------------------------------------------------------------------
 * A*
 * ---------------------------------------------------------------------- */

/** Binary min-heap of (key, cell) pairs in typed arrays; stale entries skipped. */
class Heap {
  keys = new Float64Array(1024)
  vals = new Int32Array(1024)
  size = 0
  push(k: number, v: number): void {
    if (this.size === this.keys.length) {
      const k2 = new Float64Array(this.size * 2)
      const v2 = new Int32Array(this.size * 2)
      k2.set(this.keys)
      v2.set(this.vals)
      this.keys = k2
      this.vals = v2
    }
    const keys = this.keys
    const vals = this.vals
    let c = this.size++
    while (c > 0) {
      const p = (c - 1) >> 1
      if (keys[p] <= k) break
      keys[c] = keys[p]
      vals[c] = vals[p]
      c = p
    }
    keys[c] = k
    vals[c] = v
  }
  pop(): number {
    const keys = this.keys
    const vals = this.vals
    const top = vals[0]
    const n = --this.size
    if (n > 0) {
      const k = keys[n]
      const v = vals[n]
      let p = 0
      for (;;) {
        const l = 2 * p + 1
        if (l >= n) break
        const r = l + 1
        const m = r < n && keys[r] < keys[l] ? r : l
        if (keys[m] >= k) break
        keys[p] = keys[m]
        vals[p] = vals[m]
        p = m
      }
      keys[p] = k
      vals[p] = v
    }
    return top
  }
}

/**
 * Cheapest usable path between two cells over a cost field, as cell indices.
 *
 * Eight-neighbour with an octile heuristic. Every step cost is at least 1, so
 * the heuristic is both admissible and consistent — which matters twice: the
 * first path popped is optimal, and the closed-set pruning below is sound.
 * A preference that made a cell cheaper than 1 would quietly break both.
 */
function searchPath(g: RouteGrid, cost: Float32Array, si: number, gi: number): number[] | null {
  const { cols, rows } = g
  const n = cols * rows
  if (cost[si] === Infinity || cost[gi] === Infinity) return null
  const gScore = new Float64Array(n).fill(Infinity)
  const cameFrom = new Int32Array(n).fill(-1)
  const closed = new Uint8Array(n)
  const gc = gi % cols
  const gr = (gi - gc) / cols
  const h = (c: number, r: number): number => {
    const dx = Math.abs(c - gc)
    const dy = Math.abs(r - gr)
    return Math.max(dx, dy) + (DIAG - 1) * Math.min(dx, dy)
  }
  const open = new Heap()
  gScore[si] = 0
  open.push(h(si % cols, (si - (si % cols)) / cols), si)
  let found = si === gi
  while (open.size > 0 && !found) {
    const cur = open.pop()
    if (closed[cur]) continue
    if (cur === gi) {
      found = true
      break
    }
    closed[cur] = 1
    const col = cur % cols
    const row = (cur - col) / cols
    const base = gScore[cur]
    for (let dy = -1; dy <= 1; dy++) {
      const nr = row + dy
      if (nr < 0 || nr >= rows) continue
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nc = col + dx
        if (nc < 0 || nc >= cols) continue
        const ni = nr * cols + nc
        if (closed[ni]) continue
        const w = cost[ni]
        if (w === Infinity) continue
        // No cutting a corner between two blocked cells.
        if (dx !== 0 && dy !== 0) {
          if (cost[row * cols + nc] === Infinity) continue
          if (cost[nr * cols + col] === Infinity) continue
        }
        const tentative = base + (dx !== 0 && dy !== 0 ? DIAG : 1) * w
        if (tentative < gScore[ni]) {
          gScore[ni] = tentative
          cameFrom[ni] = cur
          open.push(tentative + h(nc, nr), ni)
        }
      }
    }
  }
  if (!found) return null
  const path: number[] = []
  for (let i = gi; i !== -1; i = cameFrom[i]) {
    path.push(i)
    if (i === si) break
  }
  path.reverse()
  return path
}

/**
 * Shortest usable path across the grid, in cells — the form the tests and
 * older callers use. The planner calls `searchPath` over a prepared field.
 */
export function astar(
  g: RouteGrid,
  start: { col: number; row: number },
  goal: { col: number; row: number },
  p: Passability,
): { col: number; row: number }[] | null {
  const { cost } = costField(g, p)
  const path = searchPath(
    g, cost, start.row * g.cols + start.col, goal.row * g.cols + goal.col,
  )
  if (!path) return null
  return path.map((i) => ({ col: i % g.cols, row: Math.floor(i / g.cols) }))
}

/**
 * Collapse a grid staircase into the legs a coxswain steers.
 *
 * Keep the furthest point still visible in a straight line from the one being
 * held, then start again from there. A 400-step A* path through a harbour
 * comes out as three or four legs, which is what goes on a chart and what fits
 * on a phone.
 *
 * The smoother is bound by two budgets: **a chord may not spend more
 * distance outside a channel, nor more rule-bending cost (approach, reduced
 * stand-off, shallow water), than the piece of path it replaces.** Without
 * the first, the string-pull would cheerfully straighten a channel transit
 * into a chord over the bank — the shortest line between two points in a
 * channel is very often not in the channel — and every bit of seamanship A*
 * just paid for would be undone in the last pass. Without the second, a
 * best-effort route that A* had carefully routed round the worst of a shoal
 * would be straightened across the middle of it.
 *
 * Note the budget is compared against the replaced sub-path rather than
 * against the endpoints' own channel membership. A channel that dog-legs is
 * usually entered and left mid-path, so a rule keyed on the endpoints would be
 * inert in exactly the case that matters.
 *
 * Both are inert where they have nothing to say: with `channel` all zero,
 * every arriving cell contributes its own step length, so the budget is the
 * sub-path's octile length and the chord's is the octile distance between the
 * same endpoints — which is never longer.
 *
 * That is true in arithmetic and false in floating point, which cost a
 * straight diagonal 49 legs instead of 3 before it was caught. Both sides sum
 * the same irrational √2 a different number of times in a different order, so
 * two mathematically equal lengths differ by about 1e-13 and a strict `>`
 * fires on half the chords. Hence the tolerance: it is pure arithmetic slack,
 * far below any distance the grid can express — a millionth of a cell is
 * microns — and it is what actually makes the no-channel case inert.
 */
function pullPath(
  g: RouteGrid,
  path: { col: number; row: number }[],
  f: CostField,
): { col: number; row: number }[] {
  if (path.length <= 2) return path.slice()

  // Running totals of how much of the path so far ran outside a channel, and
  // how much rule-bending it paid for.
  const outAt = new Float64Array(path.length)
  const extraAt = new Float64Array(path.length)
  for (let i = 1; i < path.length; i++) {
    const c = path[i]
    const diagonal = c.col !== path[i - 1].col && c.row !== path[i - 1].row
    const step = diagonal ? DIAG : 1
    const idx = c.row * g.cols + c.col
    outAt[i] = outAt[i - 1] + (g.channel[idx] === 1 ? 0 : step)
    extraAt[i] = extraAt[i - 1] + f.extra[idx] * step
  }

  const within = (have: number, budget: number) => have <= budget + Math.abs(budget) * 1e-9 + 1e-9
  const extraOut = new Float64Array(1)
  const out = [path[0]]
  let anchor = 0
  while (anchor < path.length - 1) {
    let best = anchor + 1
    for (let j = path.length - 1; j > anchor + 1; j--) {
      extraOut[0] = 0
      const chordOut = chordWalk(g, path[anchor], path[j], f, extraOut)
      if (chordOut === null) continue
      if (!within(chordOut, outAt[j] - outAt[anchor])) continue
      if (!within(extraOut[0], extraAt[j] - extraAt[anchor])) continue
      best = j
      break
    }
    out.push(path[best])
    anchor = best
  }
  return out
}

export function stringPull(
  g: RouteGrid,
  path: { col: number; row: number }[],
  p: Passability,
): { col: number; row: number }[] {
  return pullPath(g, path, costField(g, p))
}

/* -------------------------------------------------------------------------
 * Depth along a leg (grid)
 * ---------------------------------------------------------------------- */

/**
 * Shoalest charted depth along a leg as the grid sees it, or null where
 * nothing is charted.
 *
 * Every cell the leg passes through counts — a supercover walk, so a leg
 * clipping the corner of a shoal cell reads the shoal. The first version
 * stepped along the leg at one sample per cell and could step clean over a
 * shallow cell on a diagonal. (The plan's own legs report the depth measured
 * on the chart itself; this is for `tidalOpportunity`.)
 */
export function legMinDepth(g: RouteGrid, from: LatLon, to: LatLon): number | null {
  const a = toGrid(g, from)
  const b = toGrid(g, to)
  let min = Infinity
  traverseCells(a.col, a.row, b.col, b.row, g.cols, g.rows, (c, r) => {
    const d = g.depth[r * g.cols + c]
    if (!Number.isNaN(d) && d < min) min = d
  })
  return Number.isFinite(min) ? min : null
}

/**
 * How much of a leg runs inside a marked channel, 0–1, or null where no
 * channel is charted in this area at all.
 *
 * Sampled off the grid, one sample per cell length along the leg — a
 * fraction, where a supercover's extra corner cells would only blur it.
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
 * Words
 * ---------------------------------------------------------------------- */

const M_TO_FT = 1 / FT_TO_M

/** A depth for a crew: feet first, metres in brackets — "5 ft (1.5 m)". */
export function formatDepth(m: number): string {
  return `${Math.round(m * M_TO_FT)} ft (${m.toFixed(1)} m)`
}

/** A distance for a crew: feet below a tenth of a mile, else miles. */
export function formatLength(m: number): string {
  if (m < 0.1 * NM_TO_METERS) {
    return `${Math.round(m * M_TO_FT).toLocaleString('en-US')} ft (${Math.round(m)} m)`
  }
  return `${(m / NM_TO_METERS).toFixed(2)} NM`
}

/* -------------------------------------------------------------------------
 * The plan
 * ---------------------------------------------------------------------- */

interface XY {
  x: number
  y: number
}

/**
 * One way of searching: how much stand-off the route must keep, how much was
 * asked for, whether shallow water may be crossed, and which view of the grid
 * to search.
 */
interface Mode {
  /** Stand-off every leg must keep (outside the approach zones), metres. */
  clearanceM: number
  /** Stand-off the crew asked for, metres. */
  wantClearanceM: number
  allowShallow: boolean
  optimistic: boolean
}

interface Ctx {
  req: RouteRequest
  ix: ChartIndex
  safeDepthM: number
  clearanceM: number
  zones: Zone[]
  from: XY
  to: XY
  /** The chart shows the endpoint on land or inside a hazard footprint. */
  fromBlocked: boolean
  toBlocked: boolean
  grids: Map<string, RouteGrid>
  budget: number
}

type Failure = 'start' | 'end' | 'path'

interface Built {
  pts: XY[]
  snapStart: boolean
  snapEnd: boolean
  grid: RouteGrid
  mode: Mode
}

function distXY(a: XY, b: XY): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function check(ctx: Ctx, clearanceM: number, a: XY, b: XY): SegmentCheck {
  return checkSegment(ctx.ix, a.x, a.y, b.x, b.y, {
    safeDepthM: ctx.safeDepthM,
    clearanceM,
    zones: ctx.zones,
  })
}

/** Does a leg meet what this mode demands? */
function passes(ctx: Ctx, mode: Mode, a: XY, b: XY): boolean {
  const r = check(ctx, mode.clearanceM, a, b)
  if (mode.allowShallow) return !r.crossesLand && r.clearanceOk
  return r.ok
}

/** Cells lying wholly inside an approach zone. */
function zoneRaster(g: RouteGrid, ctx: Ctx): Uint8Array | null {
  if (ctx.zones.length === 0) return null
  const m = gridMap(g, ctx.ix)
  const out = new Uint8Array(g.cols * g.rows)
  let any = false
  for (const z of ctx.zones) {
    const c0 = Math.max(0, Math.floor((z.x - z.r - m.x0) / m.w))
    const c1 = Math.min(g.cols - 1, Math.floor((z.x + z.r - m.x0) / m.w))
    const r0 = Math.max(0, Math.floor((m.yTop - (z.y + z.r)) / m.h))
    const r1 = Math.min(g.rows - 1, Math.floor((m.yTop - (z.y - z.r)) / m.h))
    const r2 = z.r * z.r
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        // The corner furthest from the zone's centre decides.
        const x0 = m.x0 + c * m.w - z.x
        const x1 = x0 + m.w
        const y1 = m.yTop - r * m.h - z.y
        const y0 = y1 - m.h
        const fx = Math.max(Math.abs(x0), Math.abs(x1))
        const fy = Math.max(Math.abs(y0), Math.abs(y1))
        if (fx * fx + fy * fy <= r2) {
          out[r * g.cols + c] = 1
          any = true
        }
      }
    }
  }
  return any ? out : null
}

function gridFor(ctx: Ctx, b: Bounds, cellM?: number, maxCells?: number): RouteGrid {
  const key = `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon},${cellM ?? ''}`
  const hit = ctx.grids.get(key)
  if (hit) return hit
  const g = makeGridFor(b, cellM, maxCells)
  rasteriseIndex(g, ctx.ix, ctx.req.features.channels, ctx.safeDepthM)
  ctx.grids.set(key, g)
  return g
}

function cellXY(g: RouteGrid, ctx: Ctx, i: number): XY {
  const col = i % g.cols
  const row = (i - col) / g.cols
  return toXY(ctx.ix.proj, toLatLon(g, col, row))
}

function ownCell(g: RouteGrid, p: LatLon): number {
  const at = toGrid(g, p)
  const c = Math.floor(at.col)
  const r = Math.floor(at.row)
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return -1
  return r * g.cols + c
}

/**
 * Where the path starts and ends on this grid: the nearest usable cell to each
 * endpoint — its own when that is usable — such that the two are in the same
 * connected piece of water. Nearest-to-A then whatever-connects would happily
 * snap a start into a pocket that no route leaves; this picks the pair.
 */
function pickEnds(
  g: RouteGrid,
  field: CostField,
  from: LatLon,
  to: LatLon,
  radiusM: number,
): { si: number; gi: number } | Failure {
  const sc = nearbyCells(g, from, field.cost, radiusM)
  if (sc.length === 0) return 'start'
  const gcs = nearbyCells(g, to, field.cost, radiusM)
  if (gcs.length === 0) return 'end'
  const label = components(g, field.cost)
  const nearestGoal = new Map<number, { i: number; d: number }>()
  for (const c of gcs) {
    const l = label[c.i]
    if (!nearestGoal.has(l)) nearestGoal.set(l, c)
  }
  let best: { si: number; gi: number; d: number } | null = null
  for (const c of sc) {
    const gcand = nearestGoal.get(label[c.i])
    if (!gcand) continue
    const d = c.d + gcand.d
    if (!best || d < best.d) best = { si: c.i, gi: gcand.i, d }
  }
  return best ? { si: best.si, gi: best.gi } : 'path'
}

/**
 * Search one grid, in one mode, from exact endpoint to exact endpoint, and
 * hand back the legs as points in the index's metres.
 *
 * The exact positions the crew gave are kept: where an endpoint's own cell is
 * usable the path's first cell centre is replaced by the endpoint itself;
 * where it is not, the endpoint is joined to the nearest usable cell by a leg
 * of its own. That first leg is the one the first version never checked — it
 * is checked now, like every other.
 */
function route(
  ctx: Ctx,
  g: RouteGrid,
  mode: Mode,
  from: XY,
  to: XY,
  fromBlocked: boolean,
  toBlocked: boolean,
  radiusM: number,
): { pts: XY[] } | Failure {
  const pass = passability(g, mode.clearanceM, ctx.safeDepthM, {
    allowShallow: mode.allowShallow,
    optimistic: mode.optimistic,
    zone: zoneRaster(g, ctx),
    wantClearanceM: mode.wantClearanceM,
  })
  const field = costField(g, pass)
  const fromLL = fromXY(ctx.ix.proj, from.x, from.y)
  const toLL = fromXY(ctx.ix.proj, to.x, to.y)
  // The usual case first: the nearest usable cell at each end, connected.
  // Only when those two do not connect is the whole grid labelled into
  // connected pieces to find the pair that does (`pickEnds`) — a pocket
  // near one end costs a search of the pocket, not of the grid.
  const sc = nearbyCells(g, fromLL, field.cost, radiusM)
  if (sc.length === 0) return 'start'
  const gcs = nearbyCells(g, toLL, field.cost, radiusM)
  if (gcs.length === 0) return 'end'
  let ends = { si: sc[0].i, gi: gcs[0].i }
  let raw = searchPath(g, field.cost, ends.si, ends.gi)
  if (!raw) {
    const picked = pickEnds(g, field, fromLL, toLL, radiusM)
    if (typeof picked === 'string') return picked
    ends = picked
    raw = searchPath(g, field.cost, ends.si, ends.gi)
    if (!raw) return 'path'
  }
  const cells = raw.map((i) => ({ col: i % g.cols, row: Math.floor(i / g.cols) }))
  const pulled = pullPath(g, cells, field)
  const inner: XY[] = pulled.map((c) => cellXY(g, ctx, c.row * g.cols + c.col))
  // An endpoint in its own usable cell stands in for that cell's centre.
  if (ends.si === ownCell(g, fromLL) && !fromBlocked && inner.length > 0) inner.shift()
  if (ends.gi === ownCell(g, toLL) && !toBlocked && inner.length > 0) inner.pop()
  return { pts: [from, ...inner, to] }
}

/**
 * Re-plan a failing leg on a finer grid around it and splice the result in.
 *
 * The finer grid's cells are a third of the stand-off (and ≤ 10 m, ≥ 2 m),
 * so a stand-off the coarse grid could only approximate is one this grid can
 * see. The legs that come back are checked in turn, and a failure among them
 * is repaired again on a finer grid still — up to `MAX_REPAIR_DEPTH` deep and
 * `REPAIR_BUDGET` repairs per plan. What cannot be repaired is left as it is
 * and flagged: never hidden.
 */
function repairLeg(ctx: Ctx, mode: Mode, a: XY, b: XY, parentCellM: number, depth: number): XY[] | null {
  if (depth >= MAX_REPAIR_DEPTH || ctx.budget <= 0) return null
  const c = mode.clearanceM
  const len = distXY(a, b)
  // A third of the stand-off: a conservative grid gives up about a cell each
  // side of a gap, and a third leaves room to thread one the stand-off
  // itself allows.
  // …and always at most half the grid that failed, or nothing new is seen.
  const want = Math.max(
    MIN_LOCAL_CELL_M,
    Math.min(MAX_LOCAL_CELL_M, c / 3, parentCellM / 2),
  )
  if (want > parentCellM * 0.75) return null
  const ix = ctx.ix
  // Room to go round what the leg hit. Generous first; if that makes the
  // grid too coarse to be worth it, tighter.
  const margins = [
    Math.max(60, 3 * c, 2 * parentCellM, Math.min(0.3 * len, 600)),
    Math.max(40, 2 * c, 2 * parentCellM),
  ]
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null
  let cell = Infinity
  for (const margin of margins) {
    const x0 = Math.max(ix.x0, Math.min(a.x, b.x) - margin)
    const x1 = Math.min(ix.x1, Math.max(a.x, b.x) + margin)
    const y0 = Math.max(ix.y0, Math.min(a.y, b.y) - margin)
    const y1 = Math.min(ix.y1, Math.max(a.y, b.y) + margin)
    if (!(x1 > x0 && y1 > y0)) return null
    cell = Math.max(want, Math.sqrt(((x1 - x0) * (y1 - y0)) / LOCAL_MAX_CELLS))
    box = { x0, y0, x1, y1 }
    if (cell <= parentCellM * 0.75) break
  }
  if (!box || cell > parentCellM * 0.75) return null
  const { x0, y0, x1, y1 } = box
  ctx.budget--
  const sw = fromXY(ix.proj, x0, y0)
  const ne = fromXY(ix.proj, x1, y1)
  const g = gridFor(
    ctx,
    { minLat: sw.lat, minLon: sw.lon, maxLat: ne.lat, maxLon: ne.lon },
    cell,
    LOCAL_MAX_CELLS,
  )
  // Turn points are fixed: the repaired stretch has to start and end on them.
  // Neither may be moved off land here — only the plan's own endpoints are
  // ever snapped — so the search radius is a few cells. Conservative first;
  // the optimistic read is the second chance, its legs checked (and repaired
  // finer still) like any other.
  for (const optimistic of [false, true]) {
    const found = route(ctx, g, { ...mode, optimistic }, a, b, false, false, 4 * g.cellM)
    if (typeof found === 'string') continue
    return repairPolyline(ctx, mode, found.pts, false, false, g.cellM, depth + 1)
  }
  return null
}

function repairPolyline(
  ctx: Ctx,
  mode: Mode,
  pts: XY[],
  snapStart: boolean,
  snapEnd: boolean,
  cellM: number,
  depth: number,
): XY[] {
  const out: XY[] = [pts[0]]
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const snapLeg = (snapStart && i === 0) || (snapEnd && i === pts.length - 2)
    if (snapLeg || passes(ctx, mode, a, b)) {
      out.push(b)
      continue
    }
    const fixed = repairLeg(ctx, mode, a, b, cellM, depth)
    if (fixed) out.push(...fixed.slice(1))
    else out.push(b)
  }
  return out
}

/** Angle between two consecutive legs, degrees, 0 = straight on. */
function turnDeg(a: XY, p: XY, b: XY): number {
  const h1 = Math.atan2(p.y - a.y, p.x - a.x)
  const h2 = Math.atan2(b.y - p.y, b.x - p.x)
  let d = Math.abs(h2 - h1) * (180 / Math.PI)
  if (d > 180) d = 360 - d
  return d
}

/**
 * Merge away stub legs (under `STUB_LEG_M`) and turns too small to steer
 * (under `STRAIGHT_TURN_DEG`) — but only where the leg that replaces them
 * passes the same check. A splice from a repair, or the join from an exact
 * endpoint to its cell, leaves exactly these; a crew does not want a
 * waypoint 15 ft after the last one, or a "turn" of one degree.
 */
function simplify(ctx: Ctx, mode: Mode, pts: XY[], snapStart: boolean, snapEnd: boolean): XY[] {
  const out = pts.slice()
  let changed = true
  let guard = out.length * 2 + 4
  while (changed && guard-- > 0) {
    changed = false
    for (let i = 1; i + 1 < out.length; i++) {
      if (snapStart && i === 1) continue
      if (snapEnd && i === out.length - 2) continue
      const a = out[i - 1]
      const p = out[i]
      const b = out[i + 1]
      const stub = distXY(a, p) < STUB_LEG_M || distXY(p, b) < STUB_LEG_M
      if (!stub && turnDeg(a, p, b) >= STRAIGHT_TURN_DEG) continue
      if (!passes(ctx, mode, a, b)) continue
      out.splice(i, 1)
      changed = true
      break
    }
  }
  return out
}

/** Plan in one mode over one box: route, repair, tidy. */
function attempt(ctx: Ctx, box: Bounds, mode: Mode): Built | Failure {
  const g = gridFor(ctx, box)
  const found = route(ctx, g, mode, ctx.from, ctx.to, ctx.fromBlocked, ctx.toBlocked, SNAP_RADIUS_M)
  if (typeof found === 'string') return found
  let pts = found.pts
  const snapStart = ctx.fromBlocked
  const snapEnd = ctx.toBlocked
  pts = repairPolyline(ctx, mode, pts, snapStart, snapEnd, g.cellM, 0)
  pts = simplify(ctx, mode, pts, snapStart, snapEnd)
  return { pts, snapStart, snapEnd, grid: g, mode }
}

/** Every leg (snap legs aside) meets what this mode demands. */
function accepted(ctx: Ctx, b: Built): boolean {
  for (let i = 0; i + 1 < b.pts.length; i++) {
    if (b.snapStart && i === 0) continue
    if (b.snapEnd && i === b.pts.length - 2) continue
    if (b.mode.allowShallow) {
      // The last rung: whatever it could not repair is flagged rather than
      // refused — except land and hazard footprints, which no route crosses.
      const r = check(ctx, b.mode.clearanceM, b.pts[i], b.pts[i + 1])
      if (r.crossesLand || r.entersHazard || r.unsurveyed) return false
      continue
    }
    if (!passes(ctx, b.mode, b.pts[i], b.pts[i + 1])) return false
  }
  return true
}

function cautionOf(r: SegmentCheck): LegCaution {
  if (r.crossesLand || r.shallow || r.unsurveyed) return 'unsafe-depth'
  if (!r.clearanceOk) return 'reduced-clearance'
  if (r.usedApproach) return 'shallow-approach'
  return 'ok'
}

/**
 * Per-point capture radius, feet.
 *
 * The steering engine switches to the next point as soon as the boat is
 * inside the radius — which on a sharp turn means the boat starts steering
 * for the NEXT point from up to that far short of this one, cutting the
 * corner. At each turn the radius is the largest (up to what the crew asked
 * for) for which that early-switch line — from the point on the inbound leg
 * `r` short of the turn, to the next point — still passes the same check as
 * the legs. Binary search; never below 30 ft.
 */
function arrivalRadii(ctx: Ctx, mode: Mode, pts: XY[], requestedFt: number): number[] {
  const out = pts.map(() => requestedFt)
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1]
    const p = pts[i]
    const b = pts[i + 1]
    const lin = distXY(a, p)
    const ok = (ft: number): boolean => {
      const r = ft * FT_TO_M
      const e = r >= lin ? a : { x: p.x + ((a.x - p.x) * r) / lin, y: p.y + ((a.y - p.y) * r) / lin }
      return passes(ctx, mode, e, b)
    }
    if (ok(requestedFt)) continue
    if (!ok(MIN_ARRIVAL_FT)) {
      out[i] = MIN_ARRIVAL_FT
      continue
    }
    let lo = MIN_ARRIVAL_FT
    let hi = requestedFt
    for (let k = 0; k < 7 && hi - lo > 2; k++) {
      const mid = (lo + hi) / 2
      if (ok(mid)) lo = mid
      else hi = mid
    }
    out[i] = Math.floor(lo)
  }
  return out
}

function nonePlan(req: RouteRequest, failure: string, warnings: string[] = []): RoutePlan {
  return {
    points: [],
    legs: [],
    totalNM: 0,
    hours: 0,
    source: 'none',
    coverage: req.features.coverage,
    warnings,
    movedStart: null,
    movedEnd: null,
    outsideChannelNM: null,
    arrivalFt: [],
    failure,
    needsConfirm: false,
  }
}

/** What the chart says about an exact position, as a place. */
function describeAt(ix: ChartIndex, p: XY): string {
  if (hazardDistance(ix, p.x, p.y, p.x, p.y, 0) <= 0) {
    return 'inside the footprint of a charted hazard (a wreck, obstruction, rock, pile or pylon)'
  }
  const s = stateAt(ix, p.x, p.y)
  if (s === LAND) return 'on land, or on a structure the chart draws as land'
  if (Number.isNaN(s)) return 'in water this chart never surveyed'
  return describeDepth(s)
}

/** The warnings every plan carries about the chart itself. */
function chartWarnings(f: ChartFeatures): string[] {
  const out: string[] = []
  const failed = (f.failedBands ?? []).filter((b) => typeof b === 'string' && b.length > 0)
  if (failed.length > 0) {
    const names = failed.join(' and ')
    out.push(
      `The ${names} chart${failed.length > 1 ? 's' : ''} could not be loaded, so this route was ` +
        'planned on coarser charts — some detail and hazards may be missing. Check it against a chart.',
    )
  } else if (f.coverage === 'partial') {
    out.push('The chart query hit its limit, so some hazards in this area may be missing.')
  }
  return out
}

/**
 * Plot a course.
 *
 * Always returns a plan, and never a line through land:
 *
 * - `charted` when every leg keeps the depth and the stand-off (approach
 *   stretches at the ends allowed, and flagged);
 * - `best-effort` when nothing does — the safest route found, its failing
 *   legs flagged, `needsConfirm` set and the shortfall said in plain words;
 * - `none`, with no points and a `failure` saying why, when there is nothing
 *   honest to draw: no chart, an end with no reachable water within 400 m,
 *   or no water path at all.
 *
 * The search order is the whole policy. First the ordinary box, then the wide
 * planning box — a detour round an island is not a reason to bend a rule.
 * Each is searched on the conservative grid and read optimistically too, to
 * find a gap narrower than a coarse cell allows, with legs repaired on fine
 * grids. Only then the ladder: the stand-off reduced a step at a time (75 %,
 * 50 %, 25 %, never under 3 m), and last, shallow water allowed at a price
 * that grows with how shallow it is.
 */
export function planRoute(req: RouteRequest): RoutePlan {
  const { features } = req
  const valid = (p: LatLon) =>
    Number.isFinite(p?.lat) && Number.isFinite(p?.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180
  if (!valid(req.from) || !valid(req.to)) {
    return nonePlan(req, 'The start or the destination is not a valid position.')
  }
  const directNM = haversineNM(req.from.lat, req.from.lon, req.to.lat, req.to.lon)
  if (!Number.isFinite(directNM) || directNM * NM_TO_METERS < 1) {
    return nonePlan(req, 'Start and destination are the same place.')
  }
  const baseWarnings = chartWarnings(features)
  if (features.coverage === 'none' || features.depthAreas.length === 0) {
    return nonePlan(
      req,
      'No charted depths are available for this area, so no route can be drawn. ' +
        'Check your signal and try again, or plan this passage with a paper chart.',
      baseWarnings,
    )
  }

  const safeDepthM = Number.isFinite(req.safeDepthM) ? Math.max(0, req.safeDepthM) : 0
  const clearanceM = Number.isFinite(req.clearanceM) ? Math.max(0, req.clearanceM) : 0
  const approachM = Number.isFinite(req.approachM) ? Math.max(0, req.approachM as number) : DEFAULT_APPROACH_M
  const arrivalReq = Number.isFinite(req.arrivalFt) && (req.arrivalFt as number) > 0
    ? Math.max(MIN_ARRIVAL_FT, req.arrivalFt as number)
    : DEFAULT_ARRIVAL_FT

  const planBox = planningBounds(req.from, req.to)
  const ix = chartIndexFor(features, planBox)
  const from = toXY(ix.proj, req.from)
  const to = toXY(ix.proj, req.to)
  const blocked = (p: XY) =>
    stateAt(ix, p.x, p.y) === LAND || hazardDistance(ix, p.x, p.y, p.x, p.y, 0) <= 0
  const ctx: Ctx = {
    req,
    ix,
    safeDepthM,
    clearanceM,
    zones: approachM > 0
      ? [{ x: from.x, y: from.y, r: approachM }, { x: to.x, y: to.y, r: approachM }]
      : [],
    from,
    to,
    fromBlocked: blocked(from),
    toBlocked: blocked(to),
    grids: new Map(),
    budget: REPAIR_BUDGET,
  }

  const strict: Mode = { clearanceM, wantClearanceM: clearanceM, allowShallow: false, optimistic: false }
  let lastFailure: Failure = 'path'
  const tryMode = (box: Bounds, mode: Mode): Built | null => {
    const b = attempt(ctx, box, mode)
    if (typeof b === 'string') {
      lastFailure = b
      return null
    }
    return accepted(ctx, b) ? b : null
  }

  // Each mode is searched on the conservative grid first. When that finds a
  // route, the same box is also read optimistically, and the optimistic
  // route — checked and repaired against the chart like any other — wins if
  // it is clearly shorter: a conservative grid rounds every gap down by a
  // cell each side, and a 40 m gap between bridge pylons is exactly what it
  // closes. When the conservative grid finds nothing, the optimistic read is
  // the second chance.
  const directM = distXY(from, to)
  const tryBox = (box: Bounds, mode: Mode): Built | null => {
    const safe = tryMode(box, mode)
    // Nothing can be 5 % shorter than a route already within 5 % of the
    // straight line — the open-water case, which is most of them.
    if (safe && lengthOf(safe.pts) * (1 - OPTIMISTIC_GAIN) <= directM) return safe
    const bold = tryMode(box, { ...mode, optimistic: true })
    if (!safe) return bold
    if (bold && lengthOf(bold.pts) < lengthOf(safe.pts) * (1 - OPTIMISTIC_GAIN)) return bold
    return safe
  }

  // 1–2: every rule intact — the ordinary box, then the wide one.
  let built = tryBox(routeBounds(req.from, req.to), strict) ?? tryBox(planBox, strict)

  // Is there any water path at all? The most relaxed mode answers in one
  // sweep (per view of the grid), and saves climbing down a ladder that ends
  // nowhere.
  const shallowMode: Mode = {
    clearanceM: Math.min(clearanceM, CLEARANCE_FLOOR_M),
    wantClearanceM: clearanceM,
    allowShallow: true,
    optimistic: false,
  }
  if (!built) {
    const g = gridFor(ctx, planBox)
    let reason: Failure | null = null
    for (const optimistic of [false, true]) {
      const pass = passability(g, shallowMode.clearanceM, safeDepthM, {
        allowShallow: true,
        optimistic,
        zone: zoneRaster(g, ctx),
        wantClearanceM: clearanceM,
      })
      const ends = pickEnds(g, costField(g, pass), req.from, req.to, SNAP_RADIUS_M)
      if (typeof ends !== 'string') {
        reason = null
        break
      }
      reason = ends
    }
    if (reason) return nonePlan(req, failureText(reason, ctx), baseWarnings)
  }

  // 3: the stand-off, a step at a time.
  if (!built && clearanceM > CLEARANCE_FLOOR_M) {
    const rungs = [...new Set(
      [...LADDER_FRACTIONS.map((f) => clearanceM * f), CLEARANCE_FLOOR_M]
        .map((c) => Math.max(CLEARANCE_FLOOR_M, c)),
    )]
    for (const c of rungs) {
      built = tryBox(planBox, { clearanceM: c, wantClearanceM: clearanceM, allowShallow: false, optimistic: false })
      if (built) break
    }
  }

  // 4: shallow water, at a price.
  if (!built) built = tryBox(planBox, shallowMode)
  if (!built) return nonePlan(req, failureText(lastFailure, ctx), baseWarnings)

  return finish(ctx, built, arrivalReq, baseWarnings)
}

function lengthOf(pts: XY[]): number {
  let d = 0
  for (let i = 1; i < pts.length; i++) d += distXY(pts[i - 1], pts[i])
  return d
}

function failureText(f: Failure, ctx: Ctx): string {
  const reach = `${Math.round(SNAP_RADIUS_M * M_TO_FT).toLocaleString('en-US')} ft (${SNAP_RADIUS_M} m)`
  if (f === 'start') {
    return (
      `Your start is ${describeAt(ctx.ix, ctx.from)}, and there is no water this boat can use ` +
      `within ${reach} of it. Move the start into open water, or check the boat's draft.`
    )
  }
  if (f === 'end') {
    return (
      `The destination is ${describeAt(ctx.ix, ctx.to)}, and there is no water this boat can use ` +
      `within ${reach} of it. Pick a point in open water, or check the boat's draft.`
    )
  }
  return (
    'No charted water route joins the start and the destination — land, charted hazards or ' +
    'unsurveyed water close every way through. Pick another point, or check the draft and ' +
    'stand-off in the boat settings.'
  )
}

/** Turn a built route into the plan the crew sees. */
function finish(ctx: Ctx, b: Built, arrivalReq: number, baseWarnings: string[]): RoutePlan {
  const { req, ix } = ctx
  const pts = b.pts
  const points: LatLon[] = pts.map((p) => fromXY(ix.proj, p.x, p.y))
  // The crew's own positions, exactly — not a round trip through metres.
  points[0] = req.from
  points[points.length - 1] = req.to

  const checks = pts.slice(1).map((p, i) => check(ctx, ctx.clearanceM, pts[i], p))
  const cautions = checks.map(cautionOf)
  const charted = cautions.every((c) => c === 'ok' || c === 'shallow-approach')

  const { legs: base, totalNM } = buildLegs(points, () => true)
  const speed = Number.isFinite(req.speedKn) && req.speedKn > 0 ? req.speedKn : NaN
  let run = 0
  const legs: RouteLeg[] = base.map((leg, i) => {
    run += leg.lengthNM
    return {
      ...leg,
      kind: 'search',
      etaHours: speed > 0 ? run / speed : NaN,
      minChartedDepthM: checks[i].minDepthM,
      channelFraction: legChannelFraction(b.grid, leg.from, leg.to),
      caution: cautions[i],
      minClearanceM: checks[i].minClearanceM,
    }
  })
  const hours = speed > 0 ? totalNM / speed : NaN

  const movedStart = b.snapStart ? points[1] : null
  const movedEnd = b.snapEnd ? points[points.length - 2] : null

  const warnings: string[] = []
  if (movedStart) {
    warnings.push(
      `The chart shows your start ${describeAt(ix, ctx.from)}. The route starts from the nearest ` +
        `navigable water, ${formatLength(distXY(pts[0], pts[1]))} away — you are not in it yet, ` +
        'and the first leg is not charted water.',
    )
  }
  if (movedEnd) {
    warnings.push(
      `The chart shows your destination ${describeAt(ix, ctx.to)}. The route reaches the nearest ` +
        `navigable water, ${formatLength(distXY(pts[pts.length - 2], pts[pts.length - 1]))} short ` +
        'of it — the last leg is not charted water.',
    )
  }
  if (!charted) {
    const snapLeg = (i: number) => (b.snapStart && i === 0) || (b.snapEnd && i === checks.length - 1)
    warnings.push(...shortfallWarnings(ctx, legs, checks, snapLeg))
  }
  const approach = legs.filter((l) => l.caution === 'shallow-approach').map((l) => l.n)
  if (approach.length > 0) {
    warnings.push(
      `${approach.length === 1 ? 'Leg' : 'Legs'} ${joinWords(approach.map(String))} ` +
        `${approach.length === 1 ? 'runs' : 'run'} close to the start or destination through water ` +
        'charted shallower than you need, not surveyed, or near land — check the depth there by eye.',
    )
  }
  warnings.push(...baseWarnings)

  const outsideChannelNM = b.grid.hasChannels
    ? legs.reduce((a, l) => a + l.lengthNM * (1 - (l.channelFraction ?? 0)), 0)
    : null
  if (outsideChannelNM !== null && outsideChannelNM > CHANNEL_WARN_NM) {
    warnings.push(
      `${outsideChannelNM.toFixed(1)} NM of this course runs outside the marked channel. ` +
        'The chart shows enough water there, but it is not dredged, not swept and not buoyed — ' +
        'watch your set and check the least depth on each leg.',
    )
  }

  const arrivalMode: Mode = charted
    ? { clearanceM: ctx.clearanceM, wantClearanceM: ctx.clearanceM, allowShallow: false, optimistic: false }
    : b.mode
  return {
    points,
    legs,
    totalNM,
    hours,
    source: charted ? 'charted' : 'best-effort',
    coverage: req.features.coverage,
    warnings,
    movedStart,
    movedEnd,
    outsideChannelNM,
    arrivalFt: arrivalRadii(ctx, arrivalMode, pts, arrivalReq),
    failure: null,
    needsConfirm: !charted,
  }
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Plain words for how a best-effort route falls short, worst first. */
function shortfallWarnings(
  ctx: Ctx,
  legs: RouteLeg[],
  checks: SegmentCheck[],
  snapLeg: (i: number) => boolean,
): string[] {
  const out: string[] = []
  const safe = formatDepth(ctx.safeDepthM)

  // Depth: the shoalest charted water crossed outside the approach zones.
  // The leg off (or onto) a position the chart shows on land is explained
  // by its own warning, not counted here.
  let shoalLeg = -1
  let shoal = Infinity
  let unsurveyedLeg = -1
  for (let i = 0; i < checks.length; i++) {
    const r = checks[i]
    if (r.crossesLand || snapLeg(i)) continue
    if (r.shallow && r.minDepthOutsideM !== null && r.minDepthOutsideM < shoal) {
      shoal = r.minDepthOutsideM
      shoalLeg = i
    }
    if (r.unsurveyed && unsurveyedLeg === -1) unsurveyedLeg = i
  }
  if (shoalLeg >= 0) {
    out.push(
      `No route keeps ${safe} of water the whole way. The safest route crosses ` +
        `${formatDepth(shoal)} near leg ${legs[shoalLeg].n}.`,
    )
  } else if (unsurveyedLeg >= 0) {
    out.push(
      `No route keeps ${safe} of charted water the whole way. The safest route runs through water ` +
        `the chart never surveyed near leg ${legs[unsurveyedLeg].n}.`,
    )
  }

  // Stand-off: the closest pass among the legs that fall short of it.
  let closeLeg = -1
  let close = Infinity
  for (let i = 0; i < checks.length; i++) {
    const r = checks[i]
    if (r.clearanceOk || snapLeg(i)) continue
    const d = r.entersHazard ? 0 : r.clearanceOutsideM
    if (d < close) {
      close = d
      closeLeg = i
    }
  }
  if (closeLeg >= 0) {
    const what = checks[closeLeg].entersHazard
      ? 'crosses the footprint of a charted hazard'
      : `is ${formatLength(close)} from land or a hazard`
    out.push(
      `No route keeps your ${formatLength(ctx.clearanceM)} stand-off from land and hazards the whole ` +
        `way. The closest pass ${what} near leg ${legs[closeLeg].n}.`,
    )
  }

  out.push(
    'This is the safest route found, not a safe one — the flagged legs are red. ' +
      'Confirm before you steer it.',
  )
  return out
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

/** Re-exported for callers that measure against the chart themselves. */
export { CLEARANCE_MEASURE_M }
