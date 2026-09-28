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
 * - **A depth margin beside the track, outside channels.** A boat never runs
 *   exactly on the drawn line: a phone fix is good to 5–10 m and a helm
 *   wanders as much again. So outside a marked channel (and outside the
 *   approach zones) no water charted shallower than the boat needs may lie
 *   within `depthMarginM` (10–15 m, see `depthMarginFor`) of a leg — the
 *   least any leg keeps. Inside a dredged area or fairway, a smaller margin
 *   from its edges (`channelMarginFor`).
 * - **The corridor: shortest route inside "keep ___ from shallows".** The
 *   crew's own margin (`RouteRequest.shallowMarginM`, 100 ft by default):
 *   outside channels the route keeps it wherever the water allows, inside a
 *   marked channel it keeps to the centreline (`centreLegs`), and every turn
 *   has room for the boat to make it at its cruise speed (`turnRoom`). The
 *   shortest route is the shortest inside that corridor; where no route keeps
 *   it, the route keeps as much as there is and the leg says so (`narrow`,
 *   "keep a lookout"). Shorter ways outside it are offered as alternatives.
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
  edgeDistance,
  peekChartIndex,
  shoalGap,
  distanceTransform,
  forEachHazardIn,
  forEachPieceIn,
  fromXY,
  hazardDistance,
  inHazardArea,
  landDistance,
  pointSegDist2,
  segRectDist,
  stateAt,
  toXY,
  traverseCells,
  type Bounds,
  type ChannelMargin,
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
  /** The chart's name for it (OBJNAM), when it has one — "Five Mile Cut Channel". */
  name?: string
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
  /**
   * Bands that answered, but with part of their depths missing — a piece of
   * the area whose query failed twice, or hit the service's transfer limit.
   * Where the finer chart's depths are missing the coarser one speaks, and a
   * coastal chart draws a whole bay as 0 m: the planner then goes the long
   * way round. The crew is told, and the chart store asks again next time.
   */
  incompleteBands?: string[]
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
  /**
   * The approach zones themselves, when they are not the two circles of
   * `approachM` round `from` and `to`. A re-route underway plans from the
   * boat, and the boat is not the start: the shallow-band allowance stays
   * round the passage's real departure and destination — "shallow bands only
   * near the start and the end" — instead of following the boat to wherever
   * it strayed (rc6: a boat 90 m off the line near the dock was re-routed
   * through a fresh 120 m "approach" of charted 0 m water round itself).
   * An empty list: no zones at all.
   */
  approachZones?: ApproachZone[]
  /**
   * With `approachZones`: a zone of this radius round `from` as well, but
   * only when the chart puts `from` itself in water too shallow for the boat
   * (or unsurveyed) — a re-route from a boat already in a shallow patch has
   * to cross it to get out, and that leg is drawn dotted, "check depth
   * here", like the dock stretch. A boat in deep water gets none.
   */
  fromShallowZoneM?: number
  /**
   * With `approachZones`: a small zone round `from` whatever the water there
   * (metres) — a boat re-routed from a few metres off a channel's edge is
   * inside the depth margin before it has moved, and a leg off it is not
   * the crew's to confirm.
   */
  fromZoneM?: number
  /**
   * Lateral depth margin outside channels, metres. Default
   * `depthMarginFor(clearanceM)`; 0 turns it off.
   */
  depthMarginM?: number
  /**
   * Lateral depth margin INSIDE marked channels, metres: the most kept from
   * a dredged cut's own edges (less in a cut too narrow for it — see
   * `channelMarginFor`). Default the smaller of `CHANNEL_MARGIN_MAX_M` and
   * the depth margin; 0 turns it off (the old rule).
   */
  channelMarginM?: number
  /**
   * Room planned beyond the stand-off, metres, where it fits. Default
   * max(3 m, 10 % of the stand-off); 0 plans on the stand-off itself.
   */
  planBufferM?: number
  /**
   * The crew's "keep ___ from shallows", metres — the planner's corridor.
   * Outside marked channels (and the approach zones) every leg keeps at
   * least this from water charted shallower than the boat needs; inside a
   * marked channel it keeps to the middle — half the channel's usable width,
   * less a little (`CENTRE_FRACTION`), up to this. The shortest route is
   * the shortest INSIDE that corridor. Where no route keeps it (a gut or a
   * cut narrower than twice the margin) the route keeps as much as the water
   * allows — never less than the depth margin (`depthMarginFor`) — and the
   * leg is flagged `narrow`: "keep a lookout". Default
   * `DEFAULT_SHALLOW_MARGIN_M` (100 ft); 0 turns the corridor off.
   */
  shallowMarginM?: number
}

/** Least and most lateral depth margin, metres. */
export const MIN_DEPTH_MARGIN_M = 10
export const MAX_DEPTH_MARGIN_M = 15

/**
 * "Keep 100 ft from shallows" — the corridor a route is planned inside by
 * default, metres (`RouteRequest.shallowMarginM`). The depth margin above is
 * the least a leg may ever keep; this is what it keeps wherever the water
 * allows. A route planned only on the 10–15 m margin ran its legs 19 m off
 * a drying bank, and a boat's ordinary overshoot after the first turn put
 * it aground there (rc8 F1); the margin to shallow water of the shortest
 * routes had fallen to a median of 32 m, from 47 m.
 */
export const DEFAULT_SHALLOW_MARGIN_M = 100 * 0.3048
/** The corridor setting's range, metres (0 = off). */
export const MAX_SHALLOW_MARGIN_M = 300

/**
 * Inside a marked channel the corridor is its middle: a leg keeps this share
 * of the channel's usable width from its edges (up to the corridor itself) —
 * 0.4 puts it within a tenth of the width of the centreline. A route laid
 * 9–12 m off the south edge of the ~36 m Five Mile Cut had boats with an
 * ordinary 12–15 m tracking error aground on it (rc8 F3).
 */
export const CENTRE_FRACTION = 0.4

/** The corridor a request asks for, metres (0 = off). */
export function shallowMarginFor(m: number | null | undefined): number {
  if (m == null || !Number.isFinite(m)) return DEFAULT_SHALLOW_MARGIN_M
  return Math.min(MAX_SHALLOW_MARGIN_M, Math.max(0, m))
}

/**
 * How far beside a leg (outside a channel) water too shallow for the boat
 * must stay, metres: a quarter of the stand-off, between 10 and 15 m — a
 * typical phone fix error plus a helm's wander, and no more, so it does not
 * close the natural channels a boat is meant to use.
 */
export function depthMarginFor(clearanceM: number): number {
  const c = Number.isFinite(clearanceM) ? Math.max(0, clearanceM) : 0
  return Math.min(MAX_DEPTH_MARGIN_M, Math.max(MIN_DEPTH_MARGIN_M, 0.25 * c))
}

/** A circle within which a route may use shallow-band or unsurveyed water (`RouteRequest.approachZones`). */
export interface ApproachZone {
  lat: number
  lon: number
  radiusM: number
}

/**
 * The margin a leg keeps from the edges of a marked channel, metres: the
 * most (`CHANNEL_MARGIN_MAX_M`), the least (`CHANNEL_MARGIN_MIN_M`) and, in
 * between, the share of the channel's width across the leg
 * (`CHANNEL_MARGIN_FRACTION` — in a narrow cut the leg keeps to its middle
 * half). A route used to be allowed right to the edge of a dredged cut: one
 * ran 3 m from the 2 m shelf of the Intracoastal Waterway, and a boat's own
 * wander put it aground there (rc5 F2). 8 m rather than 10: the same
 * margin holds for the live "round waypoint N first" check, and a boat on
 * the line at the switch in the Intracoastal cut had its corner line refused
 * at 10 m — "round first" on every turn of a charted channel route.
 */
export const CHANNEL_MARGIN_MAX_M = 8
export const CHANNEL_MARGIN_MIN_M = 3
export const CHANNEL_MARGIN_FRACTION = 0.25

/** The channel margin for a request (see `RouteRequest.channelMarginM`); null = off. */
export function channelMarginFor(depthMarginM: number, channelMarginM?: number | null): ChannelMargin | null {
  const want =
    channelMarginM != null && Number.isFinite(channelMarginM)
      ? Math.max(0, channelMarginM)
      : Math.min(CHANNEL_MARGIN_MAX_M, Math.max(0, depthMarginM))
  if (!(want > 0)) return null
  return {
    maxM: want,
    minM: Math.min(want, CHANNEL_MARGIN_MIN_M),
    fraction: CHANNEL_MARGIN_FRACTION,
  }
}

/**
 * Outside marked channels, the least a leg keeps from shallow water in a
 * natural gut too narrow for the full depth margin, metres — and the share of
 * the gut's width it keeps otherwise (the middle half). The full margin
 * (`depthMarginFor`, 10–15 m) closed every gut narrower than 20–30 m, however
 * deep: a boat has to be able to use a narrow channel that is deep enough,
 * kept to its middle and told so ("keep to the middle"), instead of being
 * sent the long way round. 5 m rather than the 3 m of a dredged cut: an
 * unmarked gut is not maintained or buoyed.
 */
export const NARROW_MARGIN_MIN_M = 5

/** The keep-to-the-middle rule outside channels for a depth margin; null when the margin is off. */
export function narrowMarginFor(depthMarginM: number): ChannelMargin | null {
  if (!(depthMarginM > NARROW_MARGIN_MIN_M)) return null
  return { minM: NARROW_MARGIN_MIN_M, maxM: depthMarginM, fraction: CHANNEL_MARGIN_FRACTION }
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
 *   unsurveyed, or passes within the depth margin of such water outside a
 *   channel, or — on a long leg from a position the chart shows on land —
 *   land). Only in a best-effort plan.
 * - `off-chart-end` — the short leg (no longer than the approach zone) from a
 *   start, or to a destination, that the chart draws as land or inside a
 *   hazard footprint: a dock, slip, ramp or pier. Nothing about it can be
 *   checked — "leave / come alongside by eye" — but it does not make an
 *   otherwise sound route best-effort. Drawn dotted.
 */
export type LegCaution =
  | 'ok'
  | 'shallow-approach'
  | 'off-chart-end'
  | 'reduced-clearance'
  | 'unsafe-depth'

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
  /**
   * Shoalest charted depth along the leg OUTSIDE the approach zones — the
   * figure the plan's warnings quote. Null where none is charted there.
   */
  minDepthOutsideM?: number | null
  /** The leg runs over what the chart draws as land (a snap leg to a dock). */
  overLand?: boolean
  /**
   * What the approach exception was used for on a `shallow-approach` leg:
   * shallow or unsurveyed water, and/or closer than the stand-off.
   */
  approachReasons?: ('depth' | 'clearance')[]
  /**
   * Water shallower than the boat needs within the depth margin beside the
   * leg (outside a channel): its depth and distance, metres. Null otherwise.
   */
  nearShoalDepthM?: number | null
  nearShoalDistM?: number | null
  /**
   * Keeps the depth margin only by keeping to the middle: the leg runs through
   * a marked channel or a natural gut too narrow for the full margin, never
   * closer than `NARROW_MARGIN_MIN_M` (a gut) or `CHANNEL_MARGIN_MIN_M` (a
   * dredged cut) to its edges. Sound — the crew is told "keep to the middle".
   */
  narrow?: boolean
  /**
   * Closer than the crew's "keep ___ from shallows" (`RouteRequest.shallowMarginM`)
   * to water charted shallower than the boat needs — beside the leg, where
   * no route keeps the corridor (a leg that could keep it, does): how close,
   * metres, and that water's depth. The leg is `narrow` and flagged "keep a
   * lookout". Absent when the leg keeps the corridor.
   */
  corridorGapM?: number
  corridorDepthM?: number
  /**
   * Not checked for the boat now being steered: the boat was made deeper or
   * its stand-off wider, and neither a new plan nor a re-check against the
   * chart could be made (no chart in memory). Drawn and flagged as unsafe
   * until the crew has read it.
   */
  unverified?: boolean
}

/**
 * - `charted` — every leg keeps the depth and the stand-off (legs may still be
 *   `shallow-approach` at the ends).
 * - `best-effort` — no fully safe route exists; this is the safest one found,
 *   with the failing legs flagged. The crew must confirm before steering it.
 * - `none` — nothing to draw: no chart, or no water path at all. `points` is
 *   empty and `failure` says why in plain words.
 *
 * There is no "straight line" source: a line drawn without the chart is a line
 * through whatever is in the way, and the plotter never draws one.
 */
export type RouteSource = 'charted' | 'best-effort' | 'none'

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
  /**
   * For a `best-effort` plan: the one line that says how it falls short —
   * the least depth or stand-off, feet first. What the red box shows; the
   * other warnings are listed below it. Null (or absent) otherwise.
   */
  confirmReason?: string | null
  /**
   * Turn points (indexes into `points`) where the chart leaves no room for
   * the boat to turn at its cruise speed — the water beyond the turn is
   * narrower than the turn swings it — and no gentler turn or better-placed
   * point could be found. The crew is told to slow down for them. Absent
   * when there are none.
   */
  slowTurns?: number[]
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
/**
 * How far the chart index reaches beyond the planning box, over and above
 * the stand-off measuring distance: room for a grid grown by a cell or two
 * past the box (cells are at most ~150 m on the widest box).
 */
const INDEX_PAD_M = 500

/** The approach stretch at each end, metres. */
const DEFAULT_APPROACH_M = 120

/**
 * Capture radius, feet: the default, and the range a route's setting is held
 * to — the crew's rule is "the next waypoint is selected within 100–200 ft",
 * at every point, the destination included (see `arrivalRadii`).
 */
const DEFAULT_ARRIVAL_FT = 150
const MIN_ARRIVAL_FT = 100
const MAX_ARRIVAL_FT = 200
const FT_TO_M = 0.3048

/** The crew's arrival setting as a route uses it, feet: 100–200, default 150. */
function arrivalSetting(ft: number | null | undefined): number {
  if (ft == null || !Number.isFinite(ft) || ft <= 0) return DEFAULT_ARRIVAL_FT
  return Math.min(MAX_ARRIVAL_FT, Math.max(MIN_ARRIVAL_FT, ft))
}

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
 * A failing leg longer than twice this is checked in pieces this long, and
 * only the stretch that fails is re-planned. A repair grid is a box round
 * the stretch, so a 10 km diagonal repaired whole would be a 7 km square —
 * far too coarse at the cell cap to see what the leg hit.
 */
const REPAIR_WINDOW_M = 500

/**
 * How much shorter the optimistic read's route must be before it replaces the
 * conservative one, and how close to the straight line a route must be before
 * the optimistic read is not tried at all. Both routes passed the same check
 * against the chart, so the shorter one wins; the 1 % only stops a swap over
 * rounding. (It was 5 %, so that a route riding a channel was not swapped for
 * a shorter one that did not — the channel preference is gone: the crew's
 * rule is the shortest route that keeps the rules.)
 */
const OPTIMISTIC_GAIN = 0.01
/** A route within this of the straight line is not searched again optimistically. */
const NEAR_DIRECT = 0.05

/** Legs shorter than this, and turns smaller than this, are merged away. */
const STRAIGHT_TURN_DEG = 3

/**
 * Room planned beyond the stand-off, so a leg is not laid exactly on it: at
 * least this many metres, or this share of the stand-off, whichever is more.
 * A leg planned at exactly 5 m from a bank left the boat's own helm error —
 * a few metres at any speed — inside the stand-off. Where the buffer does not
 * fit (a narrow channel) the route is planned on the stand-off itself.
 */
const PLAN_BUFFER_MIN_M = 3
const PLAN_BUFFER_FRACTION = 0.1
/**
 * The route with the buffer is taken unless it is longer than the route on
 * the stand-off itself by more than this factor and distance together. The
 * buffer is room, not a rule: it may cost a boat 1 % (and 20 m), never the
 * long way round (it was 3 % and 50 m).
 */
const BUFFER_DETOUR_FACTOR = 1.03
const BUFFER_DETOUR_M = 50

/**
 * The wider search before any rule is bent: the planning box with its margin
 * multiplied by this, clipped to the chart actually loaded. A compliant way
 * round lying just outside the planning box used to turn into "no safe
 * route" and a best-effort line through 0 m water.
 */
const WIDE_MARGIN_FACTOR = 2.2

/**
 * The best-effort ladder: the stand-off is reduced to these fractions of what
 * was asked, never below the floor, before shallow water is considered.
 */
const LADDER_FRACTIONS = [0.75, 0.5, 0.25]
const CLEARANCE_FLOOR_M = 3

/**
 * The shortest route that keeps the rules, and nothing else — the crew's
 * rule (2026-09-28: "always create the shortest route possible"). Safety is
 * the hard constraints and margins (depth, stand-off, depth-edge margin,
 * vector check); the cost of a cell is its length. What is left below are
 * TIE-BREAKERS: among routes of (nearly) equal length, prefer the one off the
 * bank and in marked water. Together they add at most `EDGE_WEIGHT +
 * OUTSIDE_THIN_WEIGHT` = 1 % to a cell, so they can never make the route more
 * than about 1 % longer than the shortest one.
 *
 * History: these were 0.6 (bank edge) and 0.25/1.5 (outside a channel) — a
 * preference strong enough to accept a detour of 2.5× to stay in a channel.
 * That is how a Galveston Bay passage came to be planned 17.7 NM round the
 * South Boat Cut when the chart it had in memory also allowed less.
 *
 * `EDGE_WEIGHT` is about the *edge of navigable water* — shaving a bank — and
 * has nothing to do with a charted channel, which is the separate tie-breaker
 * below. OUTSIDE_THIN_WEIGHT > EDGE_WEIGHT still holds, so between two
 * equally long ways the one inside a narrow channel wins over the one beside
 * it.
 */
const EDGE_WEIGHT = 0.004
const EDGE_FADE_MULTIPLE = 3
/**
 * The same, planning inside the corridor: room off the bank is worth a few
 * per cent of distance there, so the search proposes the middle of the water
 * where it is cheap — the any-angle shortening (`tighten`) then gives room
 * up only where it buys distance (`ROOM_PRICE`). At most 2 % on a cell.
 */
const CORRIDOR_EDGE_WEIGHT = 0.02

/**
 * The corridor in the grid (`RouteRequest.shallowMarginM`): a cell outside
 * a marked channel closer than the corridor to water too shallow for the boat
 * costs `CORRIDOR_BASE` extra, plus up to `CORRIDOR_SLOPE` more the closer it
 * is — rule-bending cost, which the string-pull may not increase. In open
 * water keeping the corridor costs a boat a few metres of sideways offset,
 * so the route keeps it; a narrow gut on the way is used, down its widest
 * part, rather than a way round more than two to three times its length
 * longer (the Five Mile Cut approaches: 0.7 NM of them, against 7 NM round
 * by the South Boat Cut). Inside a marked channel, a cell off the channel's
 * middle (`CENTRE_FRACTION`) costs up to `CENTRE_WEIGHT`. The alternatives
 * (`Mode.corridor` false) plan without it.
 */
const CORRIDOR_BASE = 0.5
const CORRIDOR_SLOPE = 3
const CENTRE_WEIGHT = 1
/** The least off-centre distance, in cells, the grid prices at all (see `cellCost`). */
const CENTRE_MIN_CELLS = 1.5

/**
 * Room beyond the corridor, where it is cheap. The any-angle shortening
 * (`tighten`) takes a shortcut that passes closer to shallow water or land
 * than the legs it replaces only when it saves `ROOM_PRICE` metres of route
 * for every metre of room given up — room measured out to `ROOM_FACTOR`
 * times the corridor. A route squeezed onto its margins everywhere left
 * nothing for a boat's overshoot after a turn (rc8).
 */
const ROOM_PRICE = 4
const ROOM_FACTOR = 2

/**
 * How much deeper than the boat needs before open water counts as
 * "confidently deep enough" for the (tie-breaking) channel preference: a
 * whole ENC depth band (0–2, 2–5, 5–10 m) clear of what the boat needs.
 */
const AMPLE_MARGIN_M = 2

/**
 * Tie-breaking cost added to a cell outside a marked channel — smaller where
 * the water is amply deep. See `EDGE_WEIGHT` for why they are this small.
 */
const OUTSIDE_AMPLE_WEIGHT = 0.003
const OUTSIDE_THIN_WEIGHT = 0.006

/** Distance over which leaving a channel ramps up to its full (tie-breaking) cost, metres. */
const CHANNEL_FADE_M = 200

/** The share of the tie-breaker charged the instant a cell is outside a channel. */
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
 * Extra cost of a cell inside a marked channel but off its middle — closer to
 * the cut's edge than the keep-to-the-middle rule allows (`channelMarginFor`).
 * Rule-bending cost, so the string-pull may not straighten a leg across more
 * of it than the path it replaces; the check against the chart has the last
 * word.
 */
const MIDDLE_WEIGHT = 2

/**
 * Extra cost, on the last rung of the ladder, of water shallower than the
 * boat needs: a flat price for being there at all, plus a price that grows
 * with the deficit as a fraction of what the boat needs. So the route crosses
 * as little of it as it can, and the deepest part of what it must cross.
 * (Unsurveyed water is not on offer even then — see `cellCost`.)
 */
const SHALLOW_BASE = 10
const SHALLOW_PER_DEFICIT = 40

/**
 * The same prices for an alternative route (`planAlternatives`) — the
 * Google-Maps "faster, but…" line: short enough to be worth showing, still
 * preferring the deeper water and the wider berth among ways of about the
 * same length.
 */
const RELAXED_SHALLOW_BASE = 0.05
const RELAXED_SHALLOW_PER_DEFICIT = 1
const RELAXED_REDUCED_WEIGHT = 0.2

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
  /**
   * Rectangle distance, in cells, to the nearest cell holding water charted
   * shallower than the depth the grid was rasterised for (land, hazards and
   * unsurveyed water aside) — for the lateral depth margin. Absent on a grid
   * built by hand: no margin is applied there.
   */
  shallowRect?: Float32Array
  /** The same, centre to centre from `cDepth`, for the optimistic view. */
  cShallow?: Float32Array
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
 * The widest box the planner searches before bending a rule (`planRoute`):
 * the planning box with `WIDE_MARGIN_FACTOR` times its margin, still clamped
 * to 25 NM. The navigation store loads the chart over it when a plan on the
 * planning box could not keep every rule.
 */
export function widePlanningBounds(from: LatLon, to: LatLon): Bounds {
  const directM = haversineNM(from.lat, from.lon, to.lat, to.lon) * NM_TO_METERS
  const marginM = Math.min(
    PLAN_MAX_MARGIN_M,
    WIDE_MARGIN_FACTOR * Math.max(PLAN_MIN_MARGIN_M, directM * PLAN_MARGIN_FRACTION),
  )
  return boxAround(from, to, marginM)
}

/** The box the loaded chart's depth areas span, or null for none. Cached per chart. */
const extentCache = new WeakMap<ChartFeatures, Bounds | null>()
function chartExtent(f: ChartFeatures): Bounds | null {
  if (extentCache.has(f)) return extentCache.get(f) ?? null
  let minLat = Infinity
  let minLon = Infinity
  let maxLat = -Infinity
  let maxLon = -Infinity
  for (const a of f.depthAreas) {
    for (const ring of a.rings) {
      for (const [lon, lat] of ring) {
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
        if (lon < minLon) minLon = lon
        if (lon > maxLon) maxLon = lon
      }
    }
  }
  const out = Number.isFinite(minLat) ? { minLat, minLon, maxLat, maxLon } : null
  extentCache.set(f, out)
  return out
}

/**
 * An empty grid over (at least) this box, with square cells.
 *
 * The box is grown by up to a cell so the cells come out square: a cell
 * narrower in one direction than `cellM` says would make every distance
 * measured in cells an overestimate — the unsafe direction.
 */
/** The cell size, metres, `makeGridFor` gives a box. */
function gridCellM(b: Bounds, cellM?: number, maxCells: number = MAX_CELLS): number {
  const mpd = metersPerDegree((b.minLat + b.maxLat) / 2)
  const spanLatM = Math.max(1, (b.maxLat - b.minLat) * mpd.lat)
  const spanLonM = Math.max(1, (b.maxLon - b.minLon) * mpd.lon)
  return Math.max(
    cellM ?? MIN_CELL_M,
    Math.sqrt((spanLatM * spanLonM) / maxCells),
    spanLatM / MAX_SIDE,
    spanLonM / MAX_SIDE,
  )
}

export function makeGridFor(b: Bounds, cellM?: number, maxCells: number = MAX_CELLS): RouteGrid {
  const midLat = (b.minLat + b.maxLat) / 2
  const midLon = (b.minLon + b.maxLon) / 2
  const mpd = metersPerDegree(midLat)
  const spanLatM = Math.max(1, (b.maxLat - b.minLat) * mpd.lat)
  const spanLonM = Math.max(1, (b.maxLon - b.minLon) * mpd.lon)
  const cell = gridCellM(b, cellM, maxCells)
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
    shallowRect: new Float32Array(n).fill(Infinity),
    cShallow: new Float32Array(n).fill(Infinity),
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
  shallowDistance(g, safeDepthM)
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
  shallowDistance(g, safeDepthM)
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

/**
 * A mask grown by one cell in every direction (a 3×3 max, separably) —
 * after which the centre distance to it is the rectangle distance to the
 * original. `edge` makes the grid's own border part of it.
 */
function growByOne(cols: number, rows: number, src: Uint8Array, edge: boolean): Uint8Array {
  const n = cols * rows
  const across = new Uint8Array(n)
  for (let r = 0; r < rows; r++) {
    const base = r * cols
    for (let c = 0; c < cols; c++) {
      const i = base + c
      across[i] =
        src[i] !== 0 || (c > 0 && src[i - 1] !== 0) || (c + 1 < cols && src[i + 1] !== 0)
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
      grown[i] =
        (edge && (edgeRow || c === 0 || c === cols - 1)) ||
        across[i] !== 0 || (r > 0 && across[i - cols] !== 0) || (r + 1 < rows && across[i + cols] !== 0)
          ? 1
          : 0
    }
  }
  return grown
}

/**
 * Distance to charted water shallower than `safeDepthM` — rectangle to
 * rectangle (`shallowRect`) and centre to centre (`cShallow`). Land, hazards
 * and unsurveyed water are the stand-off's and the depth check's business.
 */
function shallowDistance(g: RouteGrid, safeDepthM: number): void {
  const { cols, rows } = g
  const n = cols * rows
  if (!g.shallowRect) g.shallowRect = new Float32Array(n)
  if (!g.cShallow) g.cShallow = new Float32Array(n)
  const rect = new Uint8Array(n)
  const centre = new Uint8Array(n)
  let any = false
  for (let i = 0; i < n; i++) {
    const d = g.depth[i]
    if (g.hard[i] === 0 && Number.isFinite(d) && d < safeDepthM) {
      rect[i] = 1
      any = true
    }
    const cd = g.cDepth[i]
    if (g.cHard[i] === 0 && Number.isFinite(cd) && cd < safeDepthM) centre[i] = 1
  }
  if (!any) {
    g.shallowRect.fill(Infinity)
    g.cShallow.fill(Infinity)
    return
  }
  distanceTransform(cols, rows, growByOne(cols, rows, rect, false), false, g.shallowRect)
  distanceTransform(cols, rows, centre, false, g.cShallow)
}

function rectClearance(g: RouteGrid): void {
  const { cols, rows } = g
  // The grid's own border touches the world outside it, which counts as hard.
  const grown = growByOne(cols, rows, g.hard, true)
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
  /** The bank-edge tie-breaker's full weight (`EDGE_WEIGHT`, `CORRIDOR_EDGE_WEIGHT`). */
  edgeWeight: number
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
  /**
   * Lateral depth margin, in cells: outside a channel and a zone, a cell
   * this close to water shallower than `safeDepthM` is not usable (0 = off).
   * Not applied on the last rung, where shallow water itself is allowed.
   */
  marginCells: number
  /**
   * The keep-to-the-middle rules, in cells — inside a marked channel
   * (`channelMargin`) and, for a natural gut too narrow for the full margin,
   * outside one (`narrowMargin`): a cell must keep `min(max, max(min,
   * fraction × width))` from shallow water, where the width is judged from
   * `wide` (see `wideField`). Null: that rule is off (outside, the flat
   * `marginCells` then applies).
   */
  chanRule: CellRule | null
  outRule: CellRule | null
  /** Twice the largest distance to shallow water nearby — the local width, cells. */
  wide: Float32Array | null
  /** See `PassabilityOptions.relaxed`. */
  relaxed: boolean
  /** The corridor outside channels, cells (0 = off). See `CORRIDOR_BASE`. */
  corridorCells: number
  /** The corridor inside a marked channel — its middle — in cells; null = off. */
  centreRule: CellRule | null
}

/** A keep-to-the-middle rule in cells. */
interface CellRule {
  minCells: number
  maxCells: number
  fraction: number
}

export interface PassabilityOptions {
  allowShallow?: boolean
  optimistic?: boolean
  zone?: Uint8Array | null
  /** The stand-off asked for, when `clearanceM` is a reduced one. */
  wantClearanceM?: number
  /** Lateral depth margin outside channels, metres. Default 0 (off). */
  depthMarginM?: number
  /** The margin inside marked channels (see `channelMarginFor`). Default none. */
  channelMargin?: ChannelMargin | null
  /** The keep-to-the-middle rule for natural guts (see `narrowMarginFor`). Default none. */
  narrowMargin?: ChannelMargin | null
  /** Cheap rule-bending, for an alternative route (see `Mode.relaxed`). */
  relaxed?: boolean
  /** The corridor outside channels, metres (`RouteRequest.shallowMarginM`). Default 0 (off). */
  corridorM?: number
  /** The corridor inside channels — keep to the middle (`CENTRE_FRACTION`). Default none. */
  centre?: ChannelMargin | null
}

/**
 * The local width of deep-enough water round every cell, in cells: twice the
 * largest distance to shallow water within `r` cells — at the middle of a
 * channel of width W that distance is W/2. `r` reaches the middle of any
 * channel narrow enough for the width to matter. Cached per grid and view.
 */
const wideCache = new WeakMap<RouteGrid, Map<string, Float32Array>>()
function wideField(g: RouteGrid, optimistic: boolean, r: number): Float32Array | null {
  const src = optimistic ? g.cShallow : g.shallowRect
  if (!src) return null
  let byKey = wideCache.get(g)
  if (!byKey) {
    byKey = new Map()
    wideCache.set(g, byKey)
  }
  const key = `${optimistic ? 'c' : 'r'}${r}`
  const hit = byKey.get(key)
  if (hit) return hit
  const { cols, rows } = g
  const tmp = new Float32Array(cols * rows)
  const out = new Float32Array(cols * rows)
  // Separable square max filter: rows, then columns.
  for (let row = 0; row < rows; row++) {
    const base = row * cols
    for (let col = 0; col < cols; col++) {
      let m = -Infinity
      const c0 = Math.max(0, col - r)
      const c1 = Math.min(cols - 1, col + r)
      for (let c = c0; c <= c1; c++) if (src[base + c] > m) m = src[base + c]
      tmp[base + col] = m
    }
  }
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      let m = -Infinity
      const r0 = Math.max(0, row - r)
      const r1 = Math.min(rows - 1, row + r)
      for (let k = r0; k <= r1; k++) if (tmp[k * cols + col] > m) m = tmp[k * cols + col]
      out[row * cols + col] = 2 * m
    }
  }
  byKey.set(key, out)
  return out
}

function cellRule(m: ChannelMargin | null | undefined, cellM: number): CellRule | null {
  if (!m || !(m.maxM > 0)) return null
  return { minCells: m.minM / cellM, maxCells: m.maxM / cellM, fraction: m.fraction }
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
  const chanRule = cellRule(opts.channelMargin, g.cellM)
  const outRule = (opts.depthMarginM ?? 0) > 0 ? cellRule(opts.narrowMargin, g.cellM) : null
  const centreRule = cellRule(opts.centre, g.cellM)
  const corridorCells = Math.max(0, (opts.corridorM ?? 0) / g.cellM)
  return {
    dilateCells,
    wantCells,
    // With the corridor on, the preference for room reaches out as far as
    // the room the route is measured for (`ROOM_FACTOR`).
    edgeFadeCells: Math.max(dilateCells * EDGE_FADE_MULTIPLE + 1, (ROOM_FACTOR * (opts.corridorM ?? 0)) / g.cellM),
    edgeWeight: (opts.corridorM ?? 0) > 0 ? CORRIDOR_EDGE_WEIGHT : EDGE_WEIGHT,
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
    marginCells: Math.max(0, (opts.depthMarginM ?? 0) / g.cellM),
    chanRule,
    outRule,
    relaxed: opts.relaxed ?? false,
    corridorCells,
    centreRule,
    wide:
      chanRule || outRule || centreRule
        ? wideField(
            g,
            opts.optimistic ?? false,
            Math.ceil(2 * Math.max(chanRule?.maxCells ?? 0, outRule?.maxCells ?? 0, centreRule?.maxCells ?? 0)),
          )
        : null,
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
function cellCost(g: RouteGrid, i: number, p: Passability, out: { base: number; extra: number; room?: number }): void {
  out.base = Infinity
  out.extra = 0
  out.room = 0
  const opt = p.optimistic
  if ((opt ? g.cHard[i] : g.hard[i]) !== 0) return
  const clear = opt ? g.cClear[i] : g.clearCells[i]
  const zone = p.zone !== null && p.zone[i] !== 0
  let extra = 0
  if (clear < p.dilateCells) {
    if (!zone) return
    extra += APPROACH_WEIGHT
  } else if (clear < p.wantCells) {
    extra += (p.relaxed ? RELAXED_REDUCED_WEIGHT : REDUCED_WEIGHT) * (1 - clear / p.wantCells)
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
      extra += p.relaxed
        ? RELAXED_SHALLOW_BASE + RELAXED_SHALLOW_PER_DEFICIT * deficit
        : SHALLOW_BASE + SHALLOW_PER_DEFICIT * deficit
    } else {
      return
    }
  } else if (
    !zone &&
    !p.allowShallow &&
    (p.marginCells > 0 || p.chanRule || p.corridorCells > 0 || p.centreRule)
  ) {
    // Deep enough itself, but shallow water too close beside it for a boat
    // that is never exactly on the line. The conservative view measures
    // rectangle to rectangle; the optimistic one from the centre, less half
    // a cell — the legs it proposes are checked against the chart anyway.
    const d = opt
      ? g.cShallow !== undefined ? g.cShallow[i] - 0.5 : Infinity
      : g.shallowRect !== undefined ? g.shallowRect[i] : Infinity
    const inChannel = g.channel[i] === 1
    const rule = inChannel ? p.chanRule : p.outRule
    // Outside a channel the full margin, unless the water is a gut too narrow
    // for it — then its middle (the same rule the vector check applies).
    let need = inChannel ? 0 : p.marginCells
    if (rule && d < rule.maxCells) {
      const w = p.wide ? p.wide[i] : Infinity
      need = Math.min(rule.maxCells, Math.max(rule.minCells, rule.fraction * w))
    }
    if (inChannel) {
      // Inside a marked channel the grid only estimates the rule (the width
      // is judged cell by cell), and the vector check is the authority — so
      // a cell off the middle of a narrow cut is dear rather than closed.
      // Closed, the turn points a repair must start and end on were no
      // longer on usable cells, and the joins it drew were never checked.
      if (d < need) extra += MIDDLE_WEIGHT
      // The corridor in a channel is its middle: the further off it, the dearer.
      // Only where the grid resolves the channel's width — in a cut a cell
      // or two wide it cannot tell the middle from the edge, and the price
      // would only send the route the long way round; the centring
      // (`centreLegs`) finds the middle on the chart itself.
      const c = p.centreRule
      if (c && d < c.maxCells) {
        const w = p.wide ? p.wide[i] : Infinity
        const want = Math.min(c.maxCells, Math.max(c.minCells, c.fraction * w))
        if (want >= CENTRE_MIN_CELLS && d < want) {
          extra += (p.relaxed ? 0.1 : 1) * CENTRE_WEIGHT * (1 - Math.max(0, d) / want)
        }
      }
    } else if (d < need) {
      return
    } else if (d < p.corridorCells) {
      // Inside the corridor: usable, at a price that grows towards its edge.
      const f = 1 - Math.max(0, d) / p.corridorCells
      extra += p.relaxed ? 0.05 + 0.2 * f : CORRIDOR_BASE + CORRIDOR_SLOPE * f
    }
  }
  // Shaving a bank: the nearer land, a hazard or the edge of shallow water,
  // the dearer — never a wall, only a preference for the middle. Measured
  // centre to centre (a rectangle distance plus one), which is what the
  // fade was tuned on; the stand-off above is the rectangle distance itself.
  const margin = Math.min((opt ? clear : clear + 1) - p.dilateCells, g.shoalCells[i])
  const edge =
    margin >= p.edgeFadeCells ? 0 : p.edgeWeight * (1 - Math.max(0, margin) / p.edgeFadeCells)
  out.base = 1 + edge + channelPenalty(g, i, p)
  out.extra = extra
  out.room = Math.min(p.edgeFadeCells, Math.max(0, margin))
}

/** Per-cell cost (Infinity = not usable) and rule-bending extra, for one mode. */
interface CostField {
  cost: Float32Array
  extra: Float32Array
  /**
   * Planning inside the corridor: each cell's room from the bank, in cells,
   * up to the fade of the bank-edge preference — the string-pull keeps as
   * much of it as the path it straightens had. Null otherwise.
   */
  room: Float32Array | null
}

function costField(g: RouteGrid, p: Passability): CostField {
  const n = g.cols * g.rows
  const cost = new Float32Array(n)
  const extra = new Float32Array(n)
  const keepRoom = p.corridorCells > 0 && !p.allowShallow
  const room = keepRoom ? new Float32Array(n) : null
  const out = { base: 0, extra: 0, room: 0 }
  for (let i = 0; i < n; i++) {
    cellCost(g, i, p, out)
    cost[i] = out.base === Infinity ? Infinity : out.base + out.extra
    extra[i] = out.extra
    if (room) room[i] = out.room
  }
  return { cost, extra, room }
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
  // The worst rule-bending cell the line so much as clips (the start cell
  // aside — it belongs to the leg before): a line that grazes the corner of
  // a 0.4 m cell must not stand in for a path that only ever crossed 1.2 m.
  let worst = 0
  let tight = Infinity
  const start = y0 * g.cols + x0
  const room = f.room
  const clear = traverseCells(
    x0 + 0.5, y0 + 0.5, x1 + 0.5, y1 + 0.5,
    g.cols, g.rows,
    (c, r) => {
      const i = r * g.cols + c
      if (f.cost[i] === Infinity) return false
      if (i !== start && f.extra[i] > worst) worst = f.extra[i]
      if (room && room[i] < tight) tight = room[i]
      return true
    },
  )
  if (!clear) return null
  if (extraOut && extraOut.length > 1) extraOut[1] = worst
  if (extraOut && extraOut.length > 2) extraOut[2] = tight
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
    // The centre layers say what the chart shows AT the position's cell; the
    // conservative ones what lies anywhere in it. Land or a hazard only in a
    // corner of the cell is "right against" it, not "on" it.
    if (g.cHard[i] & HARD_LAND) {
      why = 'on land, or on a structure the chart draws as land'
    } else if (g.cHard[i] & HARD_HAZARD) {
      why = 'inside the footprint of a charted hazard (a wreck, obstruction, rock, pile or pylon)'
    } else if (g.hard[i] & HARD_LAND) {
      why = 'right against land, or a structure the chart draws as land'
    } else if (g.hard[i] & HARD_HAZARD) {
      why = 'right against the footprint of a charted hazard (a wreck, obstruction, rock, pile or pylon)'
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
 * The smoother is bound by one budget, in two parts: **a chord may not
 * spend more rule-bending cost (approach, reduced stand-off, shallow water)
 * than the piece of path it replaces, nor clip any cell that bends a rule
 * harder than the worst cell of that piece.** Without the first a
 * best-effort route that A* had carefully routed round the worst of a shoal
 * would be straightened across the middle of it; without the second, a chord
 * out of a 1.2 m notch could shave the 0.4 m corner beside it — a total is
 * counted one cell per step, and a corner the line only clips is not.
 *
 * There used to be a second budget — a chord could not run further outside a
 * marked channel than the path it replaced — which kept every dog-leg of a
 * channel even where the chord across it kept every rule. It went with the
 * channel preference (2026-09-28): the route is the shortest that keeps the
 * rules, and the chord is shorter.
 *
 * The comparison carries a tolerance: two mathematically equal sums of √2 in
 * a different order differ by about 1e-13, and a strict `>` would fire on
 * half the chords (that once cost a straight diagonal 49 legs instead of 3).
 */
function pullPath(
  g: RouteGrid,
  path: { col: number; row: number }[],
  f: CostField,
): { col: number; row: number }[] {
  if (path.length <= 2) return path.slice()

  // Running total of how much rule-bending the path so far paid for, and a
  // sparse table of the worst single cell over any stretch of it.
  const extraAt = new Float64Array(path.length)
  const cellExtra = new Float64Array(path.length)
  for (let i = 1; i < path.length; i++) {
    const c = path[i]
    const diagonal = c.col !== path[i - 1].col && c.row !== path[i - 1].row
    const step = diagonal ? DIAG : 1
    const idx = c.row * g.cols + c.col
    extraAt[i] = extraAt[i - 1] + f.extra[idx] * step
    cellExtra[i] = f.extra[idx]
  }
  const table: Float64Array[] = [cellExtra]
  for (let k = 1; 1 << k <= path.length; k++) {
    const prev = table[k - 1]
    const half = 1 << (k - 1)
    const row = new Float64Array(path.length)
    for (let i = 0; i + (1 << k) <= path.length; i++) row[i] = Math.max(prev[i], prev[i + half])
    table.push(row)
  }
  // Worst cell over path[lo..hi], inclusive.
  const worstOn = (lo: number, hi: number): number => {
    const k = Math.floor(Math.log2(hi - lo + 1))
    return Math.max(table[k][lo], table[k][hi - (1 << k) + 1])
  }

  // Inside the corridor, the same for room: a chord may not pass closer to
  // the bank than the path it replaces does anywhere (less a cell) — the
  // search chose that room where it was cheap, and the any-angle shortening
  // (`tighten`) gives it up only where it buys distance.
  const room = f.room
  let roomOn: ((lo: number, hi: number) => number) | null = null
  if (room) {
    const cellRoom = new Float64Array(path.length)
    for (let i = 0; i < path.length; i++) cellRoom[i] = room[path[i].row * g.cols + path[i].col]
    const rt: Float64Array[] = [cellRoom]
    for (let k = 1; 1 << k <= path.length; k++) {
      const prev = rt[k - 1]
      const half = 1 << (k - 1)
      const row = new Float64Array(path.length)
      for (let i = 0; i + (1 << k) <= path.length; i++) row[i] = Math.min(prev[i], prev[i + half])
      rt.push(row)
    }
    roomOn = (lo, hi) => {
      const k = Math.floor(Math.log2(hi - lo + 1))
      return Math.min(rt[k][lo], rt[k][hi - (1 << k) + 1])
    }
  }

  const within = (have: number, budget: number) => have <= budget + Math.abs(budget) * 1e-9 + 1e-9
  const extraOut = new Float64Array(3)
  const out = [path[0]]
  let anchor = 0
  while (anchor < path.length - 1) {
    let best = anchor + 1
    for (let j = path.length - 1; j > anchor + 1; j--) {
      extraOut[0] = 0
      extraOut[1] = 0
      extraOut[2] = Infinity
      const chordOut = chordWalk(g, path[anchor], path[j], f, extraOut)
      if (chordOut === null) continue
      if (!within(extraOut[0], extraAt[j] - extraAt[anchor])) continue
      if (!within(extraOut[1], worstOn(anchor + 1, j))) continue
      if (roomOn && extraOut[2] < roomOn(anchor, j) - 1) continue
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

/**
 * A charted depth as a crew reads it: "3 ft (0.9 m)", and for a drying
 * height — a negative sounding — "ground that dries 1 ft (0.3 m)", or
 * "0 ft (dries)" when that rounds to nothing. "Crosses -1 ft (-0.3 m)" read
 * as nonsense (rc5 F3).
 */
export function chartedDepthText(m: number): string {
  if (!(m < 0)) return formatDepth(m)
  const ft = Math.round(-m * M_TO_FT)
  return ft === 0 ? '0 ft (dries)' : `ground that dries ${ft} ft (${(-m).toFixed(1)} m)`
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
  /**
   * An alternative route (`planAlternatives`): bending the rule is cheap —
   * the shortest way the relaxed rule allows, preferring deeper water and
   * more room only between ways of about the same length.
   */
  relaxed?: boolean
  /**
   * Plan inside the corridor (`RouteRequest.shallowMarginM`) — the default.
   * False for the alternative that relaxes it ("passes 40 ft from shallows").
   */
  corridor?: boolean
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
  /**
   * The planning box, in the index's metres. Every route and repair stays
   * inside it; the index itself reaches `INDEX_PAD_M` (or more) further, so
   * the stand-off from a leg near the box edge is measured to land that lies
   * just beyond it rather than to nothing.
   */
  lim: { x0: number; y0: number; x1: number; y1: number }
  /** Lateral depth margin outside channels, metres (0 = off). */
  depthMarginM: number
  /** …and inside them (null = off). See `channelMarginFor`. */
  channelMargin: ChannelMargin | null
  /** …and in a natural gut too narrow for the full margin (null = off). See `narrowMarginFor`. */
  narrowMargin: ChannelMargin | null
  /** Is this point (index metres) inside a charted channel? */
  inChannel: (x: number, y: number) => boolean
  /** Legs already checked, by clearance and ends (see `check`). */
  checks: Map<string, SegmentCheck>
  /** The corridor outside channels, metres (0 = off) — `RouteRequest.shallowMarginM`. */
  corridorM: number
  /** …and inside them: keep to the middle (null = off). See `CENTRE_FRACTION`. */
  centre: ChannelMargin | null
  /** Corridor and room answers already worked out, by kind and ends. */
  gaps: Map<string, { distM: number; depthM: number } | null>
}

type Failure = 'start' | 'end' | 'path'

interface Built {
  pts: XY[]
  snapStart: boolean
  snapEnd: boolean
  grid: RouteGrid
  mode: Mode
  /** The context it was built (and checked) in — the planning buffer's, or the plain one. */
  ctx: Ctx
}

function distXY(a: XY, b: XY): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/**
 * One leg against the chart, remembered for the plan: `tighten`, `simplify`
 * and the best-effort comparisons ask about the same legs many times over,
 * and each answer costs milliseconds on a long leg.
 */
function check(ctx: Ctx, clearanceM: number, a: XY, b: XY): SegmentCheck {
  const key = `${clearanceM}|${ctx.channelMargin ? 1 : 0}|${a.x}|${a.y}|${b.x}|${b.y}`
  const hit = ctx.checks.get(key)
  if (hit) return hit
  const r = checkSegment(ctx.ix, a.x, a.y, b.x, b.y, {
    safeDepthM: ctx.safeDepthM,
    clearanceM,
    zones: ctx.zones,
    depthMarginM: ctx.depthMarginM,
    inChannel: ctx.inChannel,
    channelMargin: ctx.channelMargin,
    narrowMargin: ctx.narrowMargin,
  })
  if (ctx.checks.size > 20_000) ctx.checks.clear()
  ctx.checks.set(key, r)
  return r
}

/**
 * Where a leg falls short of the corridor (`RouteRequest.shallowMarginM`):
 * the least distance to water too shallow for the boat, and its depth — or
 * null when it keeps the corridor (or there is none). Outside channels the
 * corridor itself; inside a marked channel its middle (`CENTRE_FRACTION`).
 */
function corridorOf(ctx: Ctx, a: XY, b: XY): { distM: number; depthM: number } | null {
  if (!(ctx.corridorM > 0)) return null
  const key = `c|${a.x}|${a.y}|${b.x}|${b.y}`
  if (ctx.gaps.has(key)) return ctx.gaps.get(key) ?? null
  // A metre inside the corridor is the chart's own precision, not a squeeze.
  const r = shoalGap(ctx.ix, a.x, a.y, b.x, b.y, {
    safeDepthM: ctx.safeDepthM,
    marginM: ctx.corridorM - CORRIDOR_SLACK_M,
    zones: ctx.zones,
    inChannel: ctx.inChannel,
    channel: ctx.centre && { ...ctx.centre, maxM: ctx.centre.maxM - CORRIDOR_SLACK_M },
  })
  if (ctx.gaps.size > 20_000) ctx.gaps.clear()
  ctx.gaps.set(key, r)
  return r
}

/**
 * How much room a leg has, metres, up to `ROOM_FACTOR` times the corridor:
 * the least of its distance to water too shallow for the boat (outside
 * marked channels — inside one, the corridor keeps it to the middle) and its
 * distance to land and hazards beyond the stand-off. Infinity when the
 * corridor is off.
 */
function roomOf(ctx: Ctx, a: XY, b: XY): number {
  const cap = ROOM_FACTOR * ctx.corridorM
  if (!(cap > 0)) return Infinity
  const key = `r|${a.x}|${a.y}|${b.x}|${b.y}`
  let shoal: number
  if (ctx.gaps.has(key)) {
    shoal = ctx.gaps.get(key)?.distM ?? cap
  } else {
    const r = shoalGap(ctx.ix, a.x, a.y, b.x, b.y, {
      safeDepthM: ctx.safeDepthM,
      marginM: cap,
      zones: ctx.zones,
      inChannel: ctx.inChannel,
      channel: null,
    })
    ctx.gaps.set(key, r)
    shoal = r?.distM ?? cap
  }
  const land = check(ctx, ctx.clearanceM, a, b).clearanceOutsideM - ctx.clearanceM
  return Math.min(cap, shoal, Number.isFinite(land) ? Math.max(0, land) : cap)
}

/**
 * Is segment a–b no worse against the corridor than the run of legs
 * `parts` it stands in for? It keeps the corridor, or they did not either
 * and it passes shallow water no closer than the closest of them does.
 */
function corridorNoWorse(ctx: Ctx, mode: Mode, a: XY, b: XY, parts: [XY, XY][], slackM = 0.25): boolean {
  if (!(ctx.corridorM > 0) || mode.corridor === false) return true
  const g = corridorOf(ctx, a, b)
  if (!g) return true
  let worst = Infinity
  for (const [p, q] of parts) {
    const h = corridorOf(ctx, p, q)
    if (h && h.distM < worst) worst = h.distM
  }
  return g.distM >= worst - slackM
}

/** How far inside the corridor a leg may pass before it counts as short of it, metres. */
const CORRIDOR_SLACK_M = 1

/** Does a leg meet what this mode demands? */
function passes(ctx: Ctx, mode: Mode, a: XY, b: XY): boolean {
  const r = check(ctx, mode.clearanceM, a, b)
  if (mode.allowShallow) return !r.crossesLand && r.clearanceOk
  return r.ok
}

/**
 * May segment a–b stand in for the run of legs `parts`?
 *
 * Used where a leg is replaced by a shortcut the grid never proposed — a stub
 * or near-straight turn merged away, or the early-switch chord a turn point's
 * capture radius allows. On a fully safe route the answer is simply "does
 * the shortcut keep every rule". On the best-effort ladder `passes` alone is
 * too lenient: its own mode ignores depth (last rung) or accepts a reduced
 * stand-off, so a shortcut could quietly cross more of the shoal — or pass
 * closer to the rocks — than the route A* paid to avoid. So there the
 * shortcut must also be no worse than what it replaces: no shoaler water, no
 * less stand-off, and no unsurveyed water the parts did not already cross.
 */
function noWorse(ctx: Ctx, mode: Mode, a: XY, b: XY, parts: [XY, XY][], corridorSlackM?: number): boolean {
  const full = check(ctx, ctx.clearanceM, a, b)
  if (full.ok) return corridorNoWorse(ctx, mode, a, b, parts, corridorSlackM)
  const strict = !mode.allowShallow && mode.clearanceM >= ctx.clearanceM
  if (strict) return false
  if (!passes(ctx, mode, a, b)) return false
  if (full.crossesLand || full.entersHazard) return false
  let shoal = Infinity
  let close = Infinity
  let unsurveyed = false
  let nearShoal = false
  for (const [p, q] of parts) {
    const r = check(ctx, ctx.clearanceM, p, q)
    if (r.shallow && r.minDepthOutsideM !== null) shoal = Math.min(shoal, r.minDepthOutsideM)
    if (!r.clearanceOk) close = Math.min(close, r.entersHazard ? 0 : r.clearanceOutsideM)
    if (r.unsurveyed) unsurveyed = true
    if (r.nearShoal || r.shallow) nearShoal = true
  }
  if (full.unsurveyed && !unsurveyed) return false
  if (full.nearShoal && !nearShoal) return false
  if (full.shallow && !(full.minDepthOutsideM !== null && full.minDepthOutsideM >= shoal)) return false
  if (!full.clearanceOk && !(full.clearanceOutsideM >= close - 1e-6)) return false
  return true
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
  // Keyed by the cell it comes out at: a small box reaches the finest cell
  // (`MIN_CELL_M`) on the ordinary budget, and its "fine" grid is the same one.
  const key = `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon},${gridCellM(b, cellM, maxCells)}`
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
    depthMarginM: ctx.depthMarginM,
    channelMargin: ctx.channelMargin,
    narrowMargin: ctx.narrowMargin,
    relaxed: mode.relaxed,
    ...corridorOpts(ctx, mode),
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
    const lim = ctx.lim
    const x0 = Math.max(lim.x0, Math.min(a.x, b.x) - margin)
    const x1 = Math.min(lim.x1, Math.max(a.x, b.x) + margin)
    const y0 = Math.max(lim.y0, Math.min(a.y, b.y) - margin)
    const y1 = Math.min(lim.y1, Math.max(a.y, b.y) + margin)
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
    const fixed = repairSpan(ctx, mode, a, b, cellM, depth)
    if (fixed) out.push(...fixed.slice(1))
    else out.push(b)
  }
  return out
}

/**
 * Repair a failing leg, narrowing a long one to the stretch that fails.
 *
 * The leg is cut into `REPAIR_WINDOW_M` pieces and each checked; each run of
 * failing pieces, with one passing piece either side for room, is re-planned
 * on its own fine grid and spliced in between the untouched straight parts
 * (which `simplify` then merges back into single legs). The ends of a passing
 * piece are good water by construction, so every splice starts and ends on
 * a position that already passed the check. Should any window fail, the whole
 * leg is repaired as one — the detour may need more room than a window has.
 */
function repairSpan(ctx: Ctx, mode: Mode, a: XY, b: XY, cellM: number, depth: number): XY[] | null {
  const len = distXY(a, b)
  if (len <= 2 * REPAIR_WINDOW_M) return repairLeg(ctx, mode, a, b, cellM, depth)
  const n = Math.ceil(len / REPAIR_WINDOW_M)
  const at = (k: number): XY =>
    k <= 0 ? a : k >= n ? b : { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }
  const bad: boolean[] = []
  for (let k = 0; k < n; k++) bad.push(!passes(ctx, mode, at(k), at(k + 1)))
  if (bad.every(Boolean)) return repairLeg(ctx, mode, a, b, cellM, depth)
  const out: XY[] = [a]
  let done = 0
  for (let k = 0; k < n; k++) {
    if (!bad[k]) continue
    let j = k
    while (j < n && bad[j]) j++
    const s = Math.max(done, k - 1)
    const e = Math.min(n, j + 1)
    const fixed = repairLeg(ctx, mode, at(s), at(e), cellM, depth)
    if (!fixed) return repairLeg(ctx, mode, a, b, cellM, depth)
    if (s > done) out.push(at(s))
    out.push(...fixed.slice(1))
    done = e
    k = e - 1
  }
  if (done < n) out.push(b)
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
 * Merge away stub legs (shorter than the arrival circle) and turns too small to steer
 * (under `STRAIGHT_TURN_DEG`) — but only where the leg that replaces them
 * passes the same check. A splice from a repair, or the join from an exact
 * endpoint to its cell, leaves exactly these; a crew does not want a
 * waypoint 15 ft after the last one, or a "turn" of one degree.
 */
function simplify(ctx: Ctx, mode: Mode, pts: XY[], snapStart: boolean, snapEnd: boolean): XY[] {
  const out = pts.slice()
  // A first or last leg shorter than the arrival circle is a stub too: the
  // boat is inside the next circle before it has reached the point, and a
  // final leg of 20–35 m under a destination circle of 150 ft had the boat
  // weaving round a point it could not tell from the destination.
  const endStubM = arrivalSetting(ctx.req.arrivalFt) * FT_TO_M
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
      // A leg shorter than the arrival circle anywhere along the route is
      // a micro-leg: the boat is inside the next circle before it reaches
      // this one, and at speed it is gone between two fixes. Dropped where
      // the leg that replaces it passes the same check.
      const stub =
        distXY(a, p) < endStubM ||
        distXY(p, b) < endStubM
      if (!stub && turnDeg(a, p, b) >= STRAIGHT_TURN_DEG) continue
      // A stub is worth a couple of metres of the corridor: a waypoint the
      // boat is inside the circle of before it gets there is no waypoint.
      if (!noWorse(ctx, mode, a, b, [[a, p], [p, b]], stub ? STUB_CORRIDOR_SLACK_M : undefined)) continue
      out.splice(i, 1)
      changed = true
      break
    }
    if (changed) continue
    // A micro-leg neither end of which can simply go (a dog-leg round a
    // shoal): both its ends replaced by one point — where the legs either
    // side of it meet, or its middle — when the two legs that makes pass.
    for (let i = 1; i + 2 < out.length; i++) {
      if (snapStart && i === 1) continue
      if (snapEnd && i + 1 === out.length - 2) continue
      const a = out[i - 1]
      const p = out[i]
      const q = out[i + 1]
      const b = out[i + 2]
      if (distXY(p, q) >= endStubM) continue
      const cands: XY[] = []
      const x = lineMeet(a, p, q, b)
      if (x && distXY(x, p) + distXY(x, q) <= 3 * distXY(p, q) + 1e-9) cands.push(x)
      cands.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })
      const parts: [XY, XY][] = [[a, p], [p, q], [q, b]]
      const m = cands.find(
        (c) =>
          noWorse(ctx, mode, a, c, parts, STUB_CORRIDOR_SLACK_M) &&
          noWorse(ctx, mode, c, b, parts, STUB_CORRIDOR_SLACK_M),
      )
      if (!m) continue
      out.splice(i, 2, m)
      changed = true
      break
    }
  }
  return out
}

/** How much closer to the shallows (metres) merging a stub leg may take a route. */
const STUB_CORRIDOR_SLACK_M = 3

/** Furthest ahead a shortcut is looked for from one point (bounded work). */
const TIGHTEN_MAX_SKIP = 12

/**
 * Make the route as short as the chart allows — on the chart itself, not the
 * grid.
 *
 * A* on an eight-neighbour grid, string-pulled, is within a few per cent of
 * the shortest line, but the pull only ever joins the grid's own cells, and
 * a conservative grid rounds every gap down. So, with the vector check that
 * is the final authority anyway: from each point, the furthest later point it
 * can reach in a straight line that keeps every rule (the same `noWorse` test
 * the stub merging uses). A grid line check (`maybe`) first, so the long
 * shortcuts that plainly cross land are not measured against the chart.
 *
 * The turn points themselves are not pulled tighter onto the bank: the
 * shortest route already puts them as close as the rules allow, and a boat
 * swings wide of a turn — `cornerRoom` gives them room instead.
 *
 * The snap legs off (or onto) a position the chart shows ashore are kept as
 * they are. Bounded work: a dozen points ahead per shortcut.
 */
function tighten(
  ctx: Ctx,
  mode: Mode,
  pts: XY[],
  snapStart: boolean,
  snapEnd: boolean,
  maybe: (a: XY, b: XY) => boolean = () => true,
): XY[] {
  // Only a route that keeps every rule: on the best-effort ladder each
  // shortcut must also be compared, part by part, with what it replaces, and
  // those legs cross the most chart — seconds of checks on a slow phone for
  // a few metres on a route the crew reads leg by leg anyway.
  if (pts.length < 3 || mode.allowShallow || mode.clearanceM < ctx.clearanceM) return pts
  // Room is kept where it is cheap: a shortcut that gives up room the legs
  // it replaces had must pay for it in distance saved (`ROOM_PRICE`).
  const roomy = (a: XY, b: XY, parts: [XY, XY][]): boolean => {
    if (mode.corridor === false || !(ctx.corridorM > 0)) return true
    let had = Infinity
    let run = 0
    for (const [p, q] of parts) {
      had = Math.min(had, roomOf(ctx, p, q))
      run += distXY(p, q)
    }
    const lost = had - roomOf(ctx, a, b)
    return lost <= 1 || run - distXY(a, b) >= ROOM_PRICE * lost
  }
  const ok = (a: XY, b: XY, parts: [XY, XY][]) =>
    maybe(a, b) && noWorse(ctx, mode, a, b, parts) && roomy(a, b, parts)
  const last = pts.length - 1
  const first = snapStart ? 1 : 0
  const end = snapEnd ? last - 1 : last
  const out: XY[] = pts.slice(0, first + 1)
  let i = first
  while (i < end) {
    let best = i + 1
    for (let j = Math.min(end, i + TIGHTEN_MAX_SKIP); j > i + 1; j--) {
      const parts: [XY, XY][] = []
      for (let k = i; k < j; k++) parts.push([pts[k], pts[k + 1]])
      if (ok(pts[i], pts[j], parts)) {
        best = j
        break
      }
    }
    out.push(pts[best])
    i = best
  }
  for (let k = end + 1; k <= last; k++) out.push(pts[k])

  return out
}

/** Where line a→p (extended) meets line q→b (extended); null when they are parallel. */
function lineMeet(a: XY, p: XY, q: XY, b: XY): XY | null {
  const d1x = p.x - a.x
  const d1y = p.y - a.y
  const d2x = b.x - q.x
  const d2y = b.y - q.y
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-9) return null
  const t = ((q.x - a.x) * d2y - (q.y - a.y) * d2x) / den
  if (!(t > 0)) return null
  return { x: a.x + t * d1x, y: a.y + t * d1y }
}

/**
 * Most cells in a fine grid (`planRoute`'s second look at a box before it
 * bends a rule, and before it says there is no route): the side cap
 * (`MAX_SIDE`) squared — about 10 m cells over a 12 km box.
 */
const FINE_MAX_CELLS = MAX_SIDE * MAX_SIDE

/** Is the fine grid over this box finer than the ordinary one at all? */
function finerGrid(box: Bounds): boolean {
  return gridCellM(box, undefined, FINE_MAX_CELLS) < 0.9 * gridCellM(box)
}

/** Plan in one mode over one box: route, repair, tidy. */
function attempt(ctx: Ctx, box: Bounds, mode: Mode, maxCells?: number): Built | Failure {
  const g = gridFor(ctx, box, undefined, maxCells)
  const found = route(ctx, g, mode, ctx.from, ctx.to, ctx.fromBlocked, ctx.toBlocked, SNAP_RADIUS_M)
  if (typeof found === 'string') return found
  let pts = found.pts
  const snapStart = ctx.fromBlocked
  const snapEnd = ctx.toBlocked
  pts = repairPolyline(ctx, mode, pts, snapStart, snapEnd, g.cellM, 0)
  pts = simplify(ctx, mode, pts, snapStart, snapEnd)
  return { pts, snapStart, snapEnd, grid: g, mode, ctx }
}

/**
 * Room at a turn, beyond the stand-off, as a share of the stand-off (never
 * less than the planning buffer's floor): a boat turning at speed swings
 * wide of the turn point, and the shortest route puts its turn points as
 * close to the bank as the rules allow. The old bank-edge cost used to keep
 * them well off it; with that gone, a boat at 25 kn swung 4 m inside a 15 m
 * stand-off on the outside of a 69° turn (rc3 R4). Only turns of
 * `CORNER_MIN_TURN_DEG` or more, only on routes that keep every rule.
 */
const CORNER_ROOM_FRACTION = 0.35
const CORNER_MIN_TURN_DEG = 15
/** How far a turn point may be moved to find that room, metres, and in how many directions. */
const CORNER_SEARCH_M = [6, 12, 24, 36]
const CORNER_DIRECTIONS = 12

/**
 * Give each turn point room beyond the stand-off (`CORNER_ROOM_FRACTION`)
 * where the chart has it: a turn point closer than that to land or a hazard
 * is moved — a few metres to a few tens — to the nearby spot with the most
 * room from which both its legs still keep every rule, preferring the
 * smallest detour. Where there is no such spot it stays where it is (it
 * keeps the stand-off; the room is extra).
 */
function cornerRoom(ctx: Ctx, mode: Mode, pts: XY[], snapStart: boolean, snapEnd: boolean): XY[] {
  if (pts.length < 3 || mode.allowShallow || mode.clearanceM < ctx.clearanceM || ctx.clearanceM <= 0) return pts
  // Inside the corridor, the corridor again beyond the stand-off: a turn
  // point wrapped tight round a headland is where a boat's overshoot goes,
  // and where a fix that is 50 m out points the card at the land (rc8
  // random-242: the route rounded Pelican Island's tip at 32 m; rc7's at 91).
  const want =
    ctx.clearanceM +
    Math.max(
      PLAN_BUFFER_MIN_M,
      CORNER_ROOM_FRACTION * ctx.clearanceM,
      corridorMode(ctx, mode) ? ctx.corridorM : 0,
    )
  const out = pts.slice()
  // The stretch of the leg out of a turn a boat swings wide over: about its
  // turning radius at the planned speed (a turn at ~20°/s), 20–60 m.
  const kn = Number.isFinite(ctx.req.speedKn) && ctx.req.speedKn > 0 ? ctx.req.speedKn : 20
  const run = Math.min(60, Math.max(20, (kn * 0.5144) / ((20 * Math.PI) / 180)))
  const roomAt = (p: XY, next: XY): number => {
    const len = distXY(p, next)
    const t = len > 0 ? Math.min(1, run / len) : 0
    const q = { x: p.x + (next.x - p.x) * t, y: p.y + (next.y - p.y) * t }
    const r = check(ctx, ctx.clearanceM, p, q)
    if (r.crossesLand || r.entersHazard) return -Infinity
    return r.minClearanceM ?? Infinity
  }
  // Inside the corridor, the stretch into the turn as well: rounding a
  // headland, the land is closest where the two legs meet.
  const both = corridorMode(ctx, mode)
  const roomOver = (c: XY, prev: XY, next: XY): number => Math.min(roomAt(c, next), both ? roomAt(c, prev) : Infinity)
  const inZone = (p: XY) => ctx.zones.some((z) => (p.x - z.x) ** 2 + (p.y - z.y) ** 2 <= z.r * z.r)
  for (let k = 1; k + 1 < out.length; k++) {
    if (snapStart && k === 1) continue
    if (snapEnd && k === out.length - 2) continue
    const a = out[k - 1]
    const p = out[k]
    const b = out[k + 1]
    if (turnDeg(a, p, b) < CORNER_MIN_TURN_DEG || inZone(p)) continue
    const here = roomOver(p, a, b)
    if (here >= want) continue
    const base = distXY(a, p) + distXY(p, b)
    let best: { c: XY; score: number } | null = null
    for (const r of CORNER_SEARCH_M) {
      for (let d = 0; d < CORNER_DIRECTIONS; d++) {
        const th = (2 * Math.PI * d) / CORNER_DIRECTIONS
        const c = { x: p.x + r * Math.cos(th), y: p.y + r * Math.sin(th) }
        if (inZone(c)) continue
        const room = roomOver(c, a, b)
        if (!(room > here)) continue
        const extra = distXY(a, c) + distXY(c, b) - base
        // Short of the room wanted: every metre of room counts for far more
        // than a metre of route.
        const score = Math.max(0, want - room) * 100 + extra
        if (best && score >= best.score) continue
        if (!passes(ctx, mode, a, c) || !passes(ctx, mode, c, b)) continue
        if (!corridorNoWorse(ctx, mode, a, c, [[a, p]]) || !corridorNoWorse(ctx, mode, c, b, [[p, b]])) continue
        best = { c, score }
      }
      if (best && best.score < 100) break
    }
    if (best) out[k] = best.c
  }
  return out
}

/**
 * The route chosen, pulled as short as the chart allows (`tighten`) — once,
 * at the end, rather than for every candidate the search compares.
 */
function tightened(b: Built): Built {
  const { ctx, mode, snapStart, snapEnd } = b
  const pts = tighten(ctx, mode, b.pts, snapStart, snapEnd, lineMaybeClear(ctx, b.grid, mode))
  const roomy = cornerRoom(ctx, mode, simplify(ctx, mode, pts, snapStart, snapEnd), snapStart, snapEnd)
  const centred = centreLegs(ctx, mode, simplify(ctx, mode, roomy, snapStart, snapEnd), snapStart, snapEnd)
  const turned = turnRoom(ctx, mode, simplify(ctx, mode, centred, snapStart, snapEnd), snapStart, snapEnd)
  return { ...b, pts: simplify(ctx, mode, turned, snapStart, snapEnd) }
}

/* -------------------------------------------------------------------------
 * The corridor's middle, and room to turn
 * ---------------------------------------------------------------------- */

/** How far across a leg the centring looks for the edges of the water, as a multiple of the corridor. */
const CENTRE_REACH = 3

function inZoneXY(ctx: Ctx, p: XY): boolean {
  return ctx.zones.some((z) => (p.x - z.x) ** 2 + (p.y - z.y) ** 2 <= z.r * z.r)
}

/** Only on a route keeping every rule, planned inside the corridor. */
function corridorMode(ctx: Ctx, mode: Mode): boolean {
  return ctx.corridorM > 0 && mode.corridor !== false && !mode.allowShallow && mode.clearanceM >= ctx.clearanceM
}

/** The least distance to shallow water of legs a–p–…, against the corridor (Infinity: keeps it). */
function gapOf(ctx: Ctx, pts: XY[]): number {
  let g = Infinity
  for (let i = 0; i + 1 < pts.length; i++) {
    const h = corridorOf(ctx, pts[i], pts[i + 1])
    if (h && h.distM < g) g = h.distM
  }
  return g
}

/** How far a point is from water too shallow for the boat, metres, up to `capM`. */
function pointGap(ctx: Ctx, p: XY, capM: number): number {
  const g = shoalGap(ctx.ix, p.x, p.y, p.x, p.y, { safeDepthM: ctx.safeDepthM, marginM: capM, zones: [] })
  return g ? g.distM : capM
}

/**
 * Where across the track, from p along the left normal of (ux, uy), the
 * point with the most room from the edges of the water lies — as far as the
 * corridor wants, or the middle of water narrower than twice that. Returns
 * the move (metres along the left normal, negative to the right), how much
 * room that gains, and the width of the water across p.
 */
function centreShift(
  ctx: Ctx, p: XY, ux: number, uy: number,
): { off: number; short: number; nx: number; ny: number; width: number } {
  const reach = CENTRE_REACH * ctx.corridorM
  const nx = -uy
  const ny = ux
  const l = edgeDistance(ctx.ix, p.x, p.y, nx, ny, reach, ctx.safeDepthM)
  const r = edgeDistance(ctx.ix, p.x, p.y, -nx, -ny, reach, ctx.safeDepthM)
  const width = l + r
  const cap = ctx.corridorM
  const here = pointGap(ctx, p, cap)
  if (!(here < cap - 0.25)) return { off: 0, short: 0, nx, ny, width }
  // The room across the water, coarse then fine; ties go to the least move.
  const at = (off: number) => pointGap(ctx, { x: p.x + off * nx, y: p.y + off * ny }, cap)
  const lo = -Math.max(0, r - 0.5)
  const hi = Math.max(0, l - 0.5)
  let best = { off: 0, g: here }
  const consider = (off: number) => {
    if (off < lo || off > hi) return
    const g = at(off)
    if (g > best.g + 0.05 || (Math.abs(g - best.g) <= 0.05 && Math.abs(off) < Math.abs(best.off))) best = { off, g }
  }
  const coarse = 12
  for (let k = 0; k <= coarse; k++) consider(lo + ((hi - lo) * k) / coarse)
  let step = (hi - lo) / coarse / 2
  while (step > 0.5) {
    const c = best.off
    consider(c - step)
    consider(c + step)
    step /= 2
  }
  return { off: best.off, short: best.g - here, nx, ny, width }
}

/**
 * Keep to the middle where the corridor cannot be kept whole. A leg that
 * passes closer than the corridor to shallow water — through a marked
 * channel, or a natural gut narrower than twice the corridor — is moved to
 * the middle of the water, turn points first, then the legs themselves: the
 * worst-placed point of a leg is replaced by the middle of the water across
 * it, and each half is looked at again. Every change must keep every rule
 * and leave the route further from the shallows than it was. The result is
 * the centreline, as near as straight legs can follow it; in open water the
 * grid already kept the corridor and nothing moves.
 */
function centreLegs(ctx: Ctx, mode: Mode, pts: XY[], snapStart: boolean, snapEnd: boolean): XY[] {
  if (!corridorMode(ctx, mode) || pts.length < 2) return pts
  const last = pts.length - 1
  const short = pts.slice(1).map((q, i) => {
    const snapLeg = (snapStart && i === 0) || (snapEnd && i === last - 1)
    return !snapLeg && corridorOf(ctx, pts[i], q) !== null
  })
  // Each run of consecutive legs short of the corridor is centred as one:
  // the turn points inside the run move with the line.
  const out: XY[] = [pts[0]]
  let i = 0
  while (i < last) {
    if (!short[i]) {
      out.push(pts[i + 1])
      i++
      continue
    }
    let j = i
    while (j < last && short[j]) j++
    out.push(...centreRun(ctx, mode, pts.slice(i, j + 1)).slice(1))
    i = j
  }
  return out
}

/** Spacing of the points the centreline is first drawn through, metres, and the most of them per run. */
const CENTRE_STEP_M = 20
const CENTRE_MAX_SAMPLES = 120

/**
 * A run of legs moved to the middle of the water: the run is sampled every
 * `CENTRE_STEP_M` (its turn points included), each sample moved across the
 * track to the spot with the most room (`centreShift`), and the line through
 * them pulled straight again — the furthest sample a straight leg reaches
 * keeping every rule, staying on the centreline wherever the water is narrow
 * and passing the shallows no closer than the centreline does there. Kept
 * only when the whole is further from the shallows than the run it replaces.
 */
function centreRun(ctx: Ctx, mode: Mode, run: XY[]): XY[] {
  const was = gapOf(ctx, run)
  if (!Number.isFinite(was)) return run
  let total = 0
  for (let k = 1; k < run.length; k++) total += distXY(run[k - 1], run[k])
  const step = Math.max(CENTRE_STEP_M, total / CENTRE_MAX_SAMPLES)
  // Samples: position and the direction across which to centre.
  const samples: { p: XY; ux: number; uy: number }[] = []
  for (let k = 0; k + 1 < run.length; k++) {
    const a = run[k]
    const b = run[k + 1]
    const len = distXY(a, b)
    if (!(len > 0)) continue
    const ux = (b.x - a.x) / len
    const uy = (b.y - a.y) / len
    if (k > 0) {
      // The turn point itself, across the bisector of its legs.
      const prev = run[k - 1]
      const lp = distXY(prev, a)
      let bx = ux + (lp > 0 ? (a.x - prev.x) / lp : 0)
      let by = uy + (lp > 0 ? (a.y - prev.y) / lp : 0)
      const bl = Math.hypot(bx, by)
      if (bl > 1e-6) {
        bx /= bl
        by /= bl
      } else {
        bx = ux
        by = uy
      }
      samples.push({ p: a, ux: bx, uy: by })
    }
    const n = Math.max(1, Math.round(len / step))
    for (let m = 1; m < n; m++) samples.push({ p: { x: a.x + (ux * len * m) / n, y: a.y + (uy * len * m) / n }, ux, uy })
  }
  const line: XY[] = [run[0]]
  // How far a pulled leg may pass from each sample: where the water is
  // narrower than twice the corridor, a tenth of its width (2 m at least) —
  // the leg follows the middle; elsewhere anywhere the rules allow.
  const tol: number[] = [Infinity]
  let moved = false
  for (const s of samples) {
    if (inZoneXY(ctx, s.p)) {
      line.push(s.p)
      tol.push(Infinity)
      continue
    }
    const sh = centreShift(ctx, s.p, s.ux, s.uy)
    tol.push(sh.width < 2 * ctx.corridorM + 2 ? Math.max(2, 0.1 * sh.width) : Infinity)
    if (sh.short >= 0.5) {
      line.push({ x: s.p.x + sh.off * sh.nx, y: s.p.y + sh.off * sh.ny })
      moved = true
    } else {
      line.push(s.p)
    }
  }
  line.push(run[run.length - 1])
  tol.push(Infinity)
  if (!moved) return run
  // The centreline's own gap over each stretch — what a pulled leg must match.
  const segGap = line.slice(1).map((q, k) => corridorOf(ctx, line[k], q)?.distM ?? Infinity)
  const out: XY[] = [line[0]]
  let anchor = 0
  while (anchor < line.length - 1) {
    let best = -1
    for (let j = line.length - 1; j > anchor; j--) {
      const p = line[anchor]
      const q = line[j]
      let want = Infinity
      for (let k = anchor; k < j; k++) want = Math.min(want, segGap[k])
      let near = true
      for (let k = anchor + 1; k < j && near; k++) {
        if (tol[k] === Infinity) continue
        near = Math.sqrt(pointSegDist2(line[k].x, line[k].y, p.x, p.y, q.x, q.y)) <= tol[k]
      }
      if (!near) continue
      if (!passes(ctx, mode, p, q)) continue
      const g = corridorOf(ctx, p, q)?.distM ?? Infinity
      if (g < Math.min(want, ctx.corridorM) - 0.5) continue
      best = j
      break
    }
    if (best < 0) return run
    out.push(line[best])
    anchor = best
  }
  if (!(gapOf(ctx, out) > was + 0.5)) return run
  return out
}

/**
 * How a boat is assumed to turn when the route is planned: a firm turn at
 * `PLAN_TURN_DPS` (the same rate the card assumes, `TURN_ASSUMED_DPS`),
 * begun `PLAN_TURN_REACT_S` after the turn point — the worst case the card
 * allows, a boat that runs to the mark before it turns ("round waypoint N
 * first", a lost fix).
 */
const PLAN_TURN_DPS = 12
const PLAN_TURN_REACT_S = 1
/** Turns gentler than this need no room checked, degrees. */
const TURN_ROOM_MIN_DEG = 20

/** Unit vectors of the legs into and out of p, the turn angle (radians) and its sense (1 = to port). */
function turnAt(a: XY, p: XY, b: XY): { u1: XY; u2: XY; theta: number; sign: number } | null {
  const l1 = distXY(a, p)
  const l2 = distXY(p, b)
  if (!(l1 > 0 && l2 > 0)) return null
  const u1 = { x: (p.x - a.x) / l1, y: (p.y - a.y) / l1 }
  const u2 = { x: (b.x - p.x) / l2, y: (b.y - p.y) / l2 }
  const cross = u1.x * u2.y - u1.y * u2.x
  const dot = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y))
  return { u1, u2, theta: Math.acos(dot), sign: cross >= 0 ? 1 : -1 }
}

/**
 * The water a boat at the route's cruise speed swings through turning at p
 * from leg a→p onto p→b: on past the mark for its reaction, then round a
 * circle of radius v/ω — the run-on beyond the turn and the outside of its
 * arc. Every stretch of it must keep the rules a leg keeps.
 */
function turnFits(ctx: Ctx, mode: Mode, a: XY, p: XY, b: XY): boolean {
  const kn = ctx.req.speedKn
  if (!(Number.isFinite(kn) && kn > 0)) return true
  const t = turnAt(a, p, b)
  if (!t || t.theta < (TURN_ROOM_MIN_DEG * Math.PI) / 180) return true
  const v = kn * 0.514444
  const R = v / ((PLAN_TURN_DPS * Math.PI) / 180)
  const react = v * PLAN_TURN_REACT_S
  const path: XY[] = [p, { x: p.x + t.u1.x * react, y: p.y + t.u1.y * react }]
  const steps = Math.max(3, Math.ceil(t.theta / ((20 * Math.PI) / 180)))
  const h0 = Math.atan2(t.u1.y, t.u1.x)
  const run = (R * t.theta) / steps
  let q = path[1]
  for (let k = 0; k < steps; k++) {
    const h = h0 + t.sign * t.theta * ((k + 0.5) / steps)
    q = { x: q.x + run * Math.cos(h), y: q.y + run * Math.sin(h) }
    path.push(q)
  }
  for (let i = 0; i + 1 < path.length; i++) {
    if (!passes(ctx, mode, path[i], path[i + 1])) return false
  }
  return true
}

/** May a cut corner pass this close to the shallows (`turnRoom`)? */
function cornerCutOk(ctx: Ctx, a: XY, b: XY): boolean {
  const g = corridorOf(ctx, a, b)
  return !g || g.distM >= Math.max(ctx.depthMarginM, 0.5 * ctx.corridorM)
}

/** Directions and distances a turn point is tried at when it has no room to turn, metres. */
const TURN_MOVE_M = [15, 30, 50, 80]
const TURN_MOVE_DIRECTIONS = 16

/**
 * Room to turn at every turn point. Where the water beyond a turn is
 * narrower than the boat swings at its cruise speed (`turnFits`) — an 83°
 * turn with 42 m of water beyond it, taken at 40 kn (rc8 F2) — the turn is
 * split into two gentler ones, cutting the corner where the chart allows
 * it; failing that, the turn point is moved to where there is room. Where
 * neither is possible it stays, and the plan tells the crew to slow down for
 * it (`RoutePlan.slowTurns`).
 */
function turnRoom(ctx: Ctx, mode: Mode, pts: XY[], snapStart: boolean, snapEnd: boolean): XY[] {
  if (pts.length < 3 || mode.allowShallow || mode.clearanceM < ctx.clearanceM) return pts
  const kn = ctx.req.speedKn
  if (!(Number.isFinite(kn) && kn > 0)) return pts
  const v = kn * 0.514444
  const R = v / ((PLAN_TURN_DPS * Math.PI) / 180)
  const stub = arrivalSetting(ctx.req.arrivalFt) * FT_TO_M
  const out = pts.slice()
  for (let k = 1; k + 1 < out.length; k++) {
    if (snapStart && k === 1) continue
    if (snapEnd && k === out.length - 2) continue
    const a = out[k - 1]
    const p = out[k]
    const b = out[k + 1]
    if (inZoneXY(ctx, p)) continue
    const t = turnAt(a, p, b)
    if (!t || t.theta < (TURN_ROOM_MIN_DEG * Math.PI) / 180) continue
    if (turnFits(ctx, mode, a, p, b)) continue
    // 1: two gentler turns, the corner cut s metres either side of p — a
    // new leg no shorter than the arrival circle, so it stays a leg.
    const sMax = 0.45 * Math.min(distXY(a, p), distXY(p, b))
    const sMin = Math.max(10, stub / Math.max(0.2, 2 * Math.sin(t.theta / 2)))
    const quarter = R * Math.tan(t.theta / 4)
    const cands = [...new Set([quarter, 1.5 * quarter, 2.5 * quarter, 30, 60, 100, 150].map((x) => Math.round(x)))]
      .filter((x) => x >= sMin && x <= sMax)
      .sort((x, y) => x - y)
    let split: [XY, XY] | null = null
    for (const sM of cands) {
      const p1 = { x: p.x - t.u1.x * sM, y: p.y - t.u1.y * sM }
      const p2 = { x: p.x + t.u2.x * sM, y: p.y + t.u2.y * sM }
      if (inZoneXY(ctx, p1) || inZoneXY(ctx, p2)) continue
      if (!passes(ctx, mode, p1, p2)) continue
      // A boat that cannot make the turn swings onto the shoal outside it:
      // cutting the corner may take the route up to half-way into the
      // corridor on the inside, never closer than the depth margin.
      if (!corridorNoWorse(ctx, mode, p1, p2, [[p1, p], [p, p2]]) && !cornerCutOk(ctx, p1, p2)) continue
      if (!turnFits(ctx, mode, a, p1, p2) || !turnFits(ctx, mode, p1, p2, b)) continue
      split = [p1, p2]
      break
    }
    if (split) {
      out.splice(k, 1, split[0], split[1])
      k++
      continue
    }
    // 2: the turn point moved to where the boat has room, the shortest
    // such detour — its neighbours' turns kept as they were.
    const prev = k >= 2 ? out[k - 2] : null
    const next = k + 2 < out.length ? out[k + 2] : null
    const fitsA = prev ? turnFits(ctx, mode, prev, a, p) : true
    const fitsB = next ? turnFits(ctx, mode, p, b, next) : true
    const base = distXY(a, p) + distXY(p, b)
    let best: { c: XY; extra: number } | null = null
    for (const r of TURN_MOVE_M) {
      for (let d = 0; d < TURN_MOVE_DIRECTIONS; d++) {
        const th = (2 * Math.PI * d) / TURN_MOVE_DIRECTIONS
        const c = { x: p.x + r * Math.cos(th), y: p.y + r * Math.sin(th) }
        const extra = distXY(a, c) + distXY(c, b) - base
        if (best && extra >= best.extra) continue
        if (inZoneXY(ctx, c)) continue
        if (distXY(a, c) < stub || distXY(c, b) < stub) continue
        if (!passes(ctx, mode, a, c) || !passes(ctx, mode, c, b)) continue
        if (!corridorNoWorse(ctx, mode, a, c, [[a, p]]) || !corridorNoWorse(ctx, mode, c, b, [[p, b]])) continue
        if (!turnFits(ctx, mode, a, c, b)) continue
        if (fitsA && prev && !turnFits(ctx, mode, prev, a, c)) continue
        if (fitsB && next && !turnFits(ctx, mode, c, b, next)) continue
        best = { c, extra }
      }
      if (best) break
    }
    if (best) out[k] = best.c
  }
  return out
}

/**
 * A cheap first look for `tighten`: is the straight line between two points
 * clear on the grid's optimistic (cell-centre) view? A line that crosses a
 * cell whose centre is ashore, too shallow or inside the stand-off will fail
 * the check against the chart, so it is not worth making; one that is clear
 * here is then checked properly. Lines off the grid are not tried.
 */
function lineMaybeClear(ctx: Ctx, g: RouteGrid, mode: Mode): (a: XY, b: XY) => boolean {
  let field: CostField | null = null
  return (a, b) => {
    field ??= costField(
      g,
      passability(g, mode.clearanceM, ctx.safeDepthM, {
        allowShallow: mode.allowShallow,
        optimistic: true,
        zone: zoneRaster(g, ctx),
        wantClearanceM: mode.wantClearanceM,
        depthMarginM: ctx.depthMarginM,
        channelMargin: ctx.channelMargin,
        narrowMargin: ctx.narrowMargin,
        ...corridorOpts(ctx, mode),
      }),
    )
    const pa = toGrid(g, fromXY(ctx.ix.proj, a.x, a.y))
    const pb = toGrid(g, fromXY(ctx.ix.proj, b.x, b.y))
    return chordWalk(g, pa, pb, field, null) !== null
  }
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
  if (r.crossesLand || r.shallow || r.unsurveyed || r.nearShoal) return 'unsafe-depth'
  if (!r.clearanceOk) return 'reduced-clearance'
  if (r.usedApproach) return 'shallow-approach'
  return 'ok'
}

/**
 * Per-point capture radius, feet: the crew's setting, at every point.
 *
 * This used to shrink the circle at a tight turn (down to 30 ft) so that the
 * early switch could not cut the corner, and to half the shorter leg either
 * side. Both went, by the crew's decision: a circle of 30 ft is inside the
 * error of the fix that judges it, and a boat orbiting a destination whose
 * circle had been cut to 60 ft was the result. Every point — turn points and
 * the destination — keeps the 100–200 ft the crew set. What stops the early
 * switch cutting the corner is now checked live, fix by fix, against the
 * chart: `liveShortcut` below, and "Round waypoint N first" on the card
 * until the straight line to the next point is clear.
 */
function arrivalRadii(pts: readonly unknown[], requestedFt: number): number[] {
  const r = arrivalSetting(requestedFt)
  return pts.map(() => r)
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

/**
 * How far round a position `stateNear` looks for land, metres — about the
 * quantisation of the chart data (a metre) and then some.
 */
const LAND_EDGE_M = 3

/**
 * The chart's state at a position, reading a point ON the edge of land as
 * land. A position exactly on the shared edge of two land polygons (a pier
 * drawn against the shore, two charts' coastlines meeting) is inside neither
 * by the even-odd rule: it came back as whatever lies under the land — as
 * unsurveyed water ("the destination is in water this chart never
 * surveyed", for a point on a jetty), or as the depth area beneath.
 *
 *   - Land on both sides of the position, half a metre either way along any
 *     of four directions, is land: the position is on a seam inside it.
 *   - A position that reads as unsurveyed, with land within `LAND_EDGE_M`,
 *     is land too — it is on the land's edge, not out in unknown water.
 */
function stateNear(ix: ChartIndex, x: number, y: number): number {
  const s = stateAt(ix, x, y)
  if (s === LAND) return s
  const around = (r: number, k: number) => {
    const a = (k * Math.PI) / 4
    return stateAt(ix, x + r * Math.cos(a), y + r * Math.sin(a))
  }
  for (let k = 0; k < 4; k++) {
    if (around(0.5, k) === LAND && around(0.5, k + 4) === LAND) return LAND
  }
  if (!Number.isNaN(s)) return s
  for (const r of [0.5, LAND_EDGE_M]) {
    for (let k = 0; k < 8; k++) if (around(r, k) === LAND) return LAND
  }
  return s
}

/** What the chart says about an exact position, as a place. */
function describeAt(ix: ChartIndex, p: XY): string {
  if (hazardDistance(ix, p.x, p.y, p.x, p.y, 0) <= 0) {
    return 'inside the footprint of a charted hazard (a wreck, obstruction, rock, pile or pylon)'
  }
  const s = stateNear(ix, p.x, p.y)
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
  } else if ((f.incompleteBands ?? []).length > 0) {
    out.push(
      `Part of the ${f.incompleteBands!.join(' and ')} chart did not load, so some depths and hazards ` +
        'in this area are missing. The route may go the long way round, or miss a hazard — plan it ' +
        'again with a better signal, and check it against a chart.',
    )
  } else if (f.coverage === 'partial') {
    out.push(
      'Part of the chart did not load (the query hit its limit), so some depths and hazards in this ' +
        'area may be missing — the route may go the long way round. Check it against a chart.',
    )
  }
  return out
}

/**
 * "Is this point inside a charted dredged area or fairway?", in the index's
 * metres — even-odd over each channel's rings, with a box test first.
 */
function channelTest(
  channels: ChannelPolygon[],
  ix: ChartIndex,
): (x: number, y: number) => boolean {
  const polys = channels.map((ch) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    const rings = ch.rings.map((ring) => {
      const out = new Float64Array(ring.length * 2)
      ring.forEach(([lon, lat], k) => {
        const p = toXY(ix.proj, { lat, lon })
        out[2 * k] = p.x
        out[2 * k + 1] = p.y
        if (p.x < x0) x0 = p.x
        if (p.y < y0) y0 = p.y
        if (p.x > x1) x1 = p.x
        if (p.y > y1) y1 = p.y
      })
      return out
    })
    return { rings, x0, y0, x1, y1 }
  })
  if (polys.length === 0) return () => false
  return (x, y) => {
    for (const p of polys) {
      if (x < p.x0 || x > p.x1 || y < p.y0 || y > p.y1) continue
      let inside = false
      for (const ring of p.rings) {
        const n = ring.length / 2
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const yi = ring[2 * i + 1]
          const yj = ring[2 * j + 1]
          if (yi > y !== yj > y) {
            const xc = ring[2 * i] + ((y - yi) * (ring[2 * j] - ring[2 * i])) / (yj - yi)
            if (xc > x) inside = !inside
          }
        }
      }
      if (inside) return true
    }
    return false
  }
}

/**
 * The grids of the last chart planned on, kept for the next plan on it — the
 * alternatives (`planAlternatives`) straight after a plan, a re-plan for a
 * changed stand-off. Grids depend only on the chart and the boat's depth;
 * one chart and depth at a time, and the big fine grids are dropped after
 * each plan (`evictBigGrids`) — a phone has no memory to spare.
 */
let gridMemo: { features: ChartFeatures; safeDepthM: number; grids: Map<string, RouteGrid> } | null = null
function gridsFor(features: ChartFeatures, safeDepthM: number): Map<string, RouteGrid> {
  if (gridMemo && gridMemo.features === features && gridMemo.safeDepthM === safeDepthM) return gridMemo.grids
  gridMemo = { features, safeDepthM, grids: new Map() }
  return gridMemo.grids
}
function evictBigGrids(): void {
  if (!gridMemo) return
  for (const [k, g] of gridMemo.grids) if (g.cols * g.rows > MAX_CELLS * 1.2) gridMemo.grids.delete(k)
  // Repair grids are small but many; keep the plan-sized ones only.
  for (const [k, g] of gridMemo.grids) if (g.cols * g.rows < MAX_CELLS / 4) gridMemo.grids.delete(k)
}

/**
 * Everything a plan (or a re-check of one) is measured against: the chart
 * indexed over the planning box and a pad, the ends in its metres, the
 * approach zones, the depth margin and the channel test.
 */
function makeCtx(req: RouteRequest, box?: Bounds): Ctx {
  const { features } = req
  const safeDepthM = Number.isFinite(req.safeDepthM) ? Math.max(0, req.safeDepthM) : 0
  const clearanceM = Number.isFinite(req.clearanceM) ? Math.max(0, req.clearanceM) : 0
  const approachM = Number.isFinite(req.approachM) ? Math.max(0, req.approachM as number) : DEFAULT_APPROACH_M

  const planBox = box ?? planningBounds(req.from, req.to)
  // The index reaches past the planning box. It clips every polygon to its
  // own box and reads beyond it as unsurveyed, so land lying just outside
  // an index the size of the planning box was invisible to the stand-off
  // check of a leg running along the box edge — a leg 15 m off a shore
  // passed a 30 m stand-off. Routes stay inside the planning box (grids are
  // at most a cell bigger); the pad is what their stand-off is measured in.
  const pad = Math.max(CLEARANCE_MEASURE_M, 2 * clearanceM) + INDEX_PAD_M
  const ix = chartIndexFor(features, boxAround(
    { lat: planBox.minLat, lon: planBox.minLon },
    { lat: planBox.maxLat, lon: planBox.maxLon },
    pad,
  ))
  const limSW = toXY(ix.proj, { lat: planBox.minLat, lon: planBox.minLon })
  const limNE = toXY(ix.proj, { lat: planBox.maxLat, lon: planBox.maxLon })
  const from = toXY(ix.proj, req.from)
  const to = toXY(ix.proj, req.to)
  const blocked = (p: XY) =>
    stateNear(ix, p.x, p.y) === LAND || hazardDistance(ix, p.x, p.y, p.x, p.y, 0) <= 0
  // Water too shallow for the boat, or unsurveyed, at p (not land).
  const shoalAt = (p: XY) => {
    const st = stateNear(ix, p.x, p.y)
    return st !== LAND && (Number.isNaN(st) || st < safeDepthM)
  }
  const depthMarginM =
    req.depthMarginM != null && Number.isFinite(req.depthMarginM)
      ? Math.max(0, req.depthMarginM)
      : depthMarginFor(clearanceM)
  return {
    req,
    ix,
    safeDepthM,
    clearanceM,
    zones: req.approachZones
      ? [
          ...req.approachZones
            .filter((z) => Number.isFinite(z?.lat) && Number.isFinite(z?.lon) && z.radiusM > 0)
            .map((z) => ({ ...toXY(ix.proj, z), r: z.radiusM })),
          ...((() => {
            const r = Math.max(
              req.fromZoneM != null && req.fromZoneM > 0 ? req.fromZoneM : 0,
              req.fromShallowZoneM != null && req.fromShallowZoneM > 0 && shoalAt(from) ? req.fromShallowZoneM : 0,
            )
            return r > 0 ? [{ x: from.x, y: from.y, r }] : []
          })()),
        ]
      : approachM > 0
        ? [{ x: from.x, y: from.y, r: approachM }, { x: to.x, y: to.y, r: approachM }]
        : [],
    from,
    to,
    fromBlocked: blocked(from),
    toBlocked: blocked(to),
    grids: gridsFor(features, safeDepthM),
    budget: REPAIR_BUDGET,
    lim: { x0: limSW.x, y0: limSW.y, x1: limNE.x, y1: limNE.y },
    depthMarginM,
    channelMargin: channelMarginFor(depthMarginM, req.channelMarginM),
    narrowMargin: narrowMarginFor(depthMarginM),
    inChannel: channelTest(features.channels, ix),
    checks: new Map(),
    ...corridorFor(req.shallowMarginM),
    gaps: new Map(),
  }
}

/** The corridor fields of a context, for a request's `shallowMarginM`. */
function corridorFor(m: number | null | undefined): { corridorM: number; centre: ChannelMargin | null } {
  const corridorM = shallowMarginFor(m)
  return {
    corridorM,
    centre:
      corridorM > 0 ? { maxM: corridorM, minM: CHANNEL_MARGIN_MIN_M, fraction: CENTRE_FRACTION } : null,
  }
}

/** The corridor a search in this mode is costed with (`PassabilityOptions`). */
function corridorOpts(ctx: Ctx, mode: Mode): { corridorM: number; centre: ChannelMargin | null } {
  if (mode.corridor === false || mode.allowShallow) return { corridorM: 0, centre: null }
  return { corridorM: ctx.corridorM, centre: ctx.centre }
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

  const ctx = makeCtx(req)
  const { safeDepthM, clearanceM } = ctx
  const planBox = planningBounds(req.from, req.to)
  const { from, to } = ctx
  const arrivalReq = arrivalSetting(req.arrivalFt)

  const strict: Mode = { clearanceM, wantClearanceM: clearanceM, allowShallow: false, optimistic: false }
  let lastFailure: Failure = 'path'
  const tryMode = (c: Ctx, box: Bounds, mode: Mode, maxCells?: number): Built | null => {
    const b = attempt(c, box, mode, maxCells)
    if (typeof b === 'string') {
      lastFailure = b
      return null
    }
    return accepted(c, b) ? b : null
  }

  // Each mode is searched on the conservative grid first. When that finds a
  // route, the same box is also read optimistically, and the optimistic
  // route — checked and repaired against the chart like any other — wins if
  // it is clearly shorter: a conservative grid rounds every gap down by a
  // cell each side, and a 40 m gap between bridge pylons is exactly what it
  // closes. When the conservative grid finds nothing, the optimistic read is
  // the second chance.
  const directM = distXY(from, to)
  // The length of the grid's own answer, before any repair — a cheap bound
  // on whether a full attempt could possibly win. A route that is not
  // shorter even before its legs are repaired will not be shorter after.
  const rawLength = (c: Ctx, box: Bounds, mode: Mode): number => {
    const g = gridFor(c, box)
    const found = route(c, g, mode, c.from, c.to, c.fromBlocked, c.toBlocked, SNAP_RADIUS_M)
    return typeof found === 'string' ? Infinity : lengthOf(found.pts)
  }
  const tryBox = (c: Ctx, box: Bounds, mode: Mode): Built | null => {
    const safe = tryMode(c, box, mode)
    // A route already within 5 % of the straight line is not searched
    // again — the open-water case, which is most of them.
    if (safe && lengthOf(safe.pts) <= directM * (1 + NEAR_DIRECT)) return safe
    if (safe && !(rawLength(c, box, { ...mode, optimistic: true }) < lengthOf(safe.pts) * (1 - OPTIMISTIC_GAIN))) {
      return safe
    }
    const bold = tryMode(c, box, { ...mode, optimistic: true })
    if (!safe) return bold
    if (bold && lengthOf(bold.pts) < lengthOf(safe.pts) * (1 - OPTIMISTIC_GAIN)) return bold
    return safe
  }

  // 1: every rule intact, with room to spare — the stand-off plus a buffer
  // (`PLAN_BUFFER_MIN_M`), in the ordinary box and then the wide one. The
  // same chart index and grids; only the stand-off the search keeps grows.
  const buffer =
    req.planBufferM != null && Number.isFinite(req.planBufferM)
      ? Math.max(0, req.planBufferM)
      : clearanceM > 0
        ? Math.max(PLAN_BUFFER_MIN_M, PLAN_BUFFER_FRACTION * clearanceM)
        : 0
  let built: Built | null = null
  if (buffer > 0) {
    const roomy: Ctx = { ...ctx, clearanceM: clearanceM + buffer, budget: REPAIR_BUDGET }
    const mode: Mode = { ...strict, clearanceM: clearanceM + buffer, wantClearanceM: clearanceM + buffer }
    built = tryBox(roomy, routeBounds(req.from, req.to), mode) ?? tryBox(roomy, planBox, mode)
  }

  // 2: every rule intact, on the stand-off itself — a narrow channel that
  // has no room for the buffer is still a channel. Also where the buffer
  // only fits a long way round: 3 m more room is not worth going round a
  // bridge for when the gap between its piers keeps the stand-off.
  const tightCouldWin = (b: Built): boolean => {
    const box = routeBounds(req.from, req.to)
    const raw = Math.min(rawLength(ctx, box, strict), rawLength(ctx, box, { ...strict, optimistic: true }))
    // No raw route in the ordinary box: the planning box is searched in full.
    return !Number.isFinite(raw) || raw * BUFFER_DETOUR_FACTOR + BUFFER_DETOUR_M < lengthOf(b.pts)
  }
  if (!built || (lengthOf(built.pts) > directM * (1 + NEAR_DIRECT) && tightCouldWin(built))) {
    ctx.budget = REPAIR_BUDGET
    const tight = tryBox(ctx, routeBounds(req.from, req.to), strict) ?? tryBox(ctx, planBox, strict)
    if (
      tight &&
      (!built || lengthOf(built.pts) > lengthOf(tight.pts) * BUFFER_DETOUR_FACTOR + BUFFER_DETOUR_M)
    ) {
      built = tight
    }
  }

  // 3: every rule intact, further afield — a wider box, as far as the chart
  // that is loaded reaches, before any rule is bent. Then the same on a
  // fine grid (`FINE_MAX_CELLS`): over a wide box the ordinary grid's cells
  // grow past 20 m, and a conservative grid that coarse closes a 30 m-wide
  // gut that keeps every rule — the planner offered a best-effort route
  // through the shallows with a compliant one a mile to the east (rc5 F4).
  let use = ctx
  if (!built) {
    const wide = clipTo(widePlanningBounds(req.from, req.to), chartExtent(features), planBox)
    const fineBox = wide ?? planBox
    const fineCtx = wide ? makeCtx(req, wide) : ctx
    if (wide) built = tryBox(fineCtx, wide, strict)
    if (!built && finerGrid(fineBox)) {
      fineCtx.budget = REPAIR_BUDGET
      const fine = attempt(fineCtx, fineBox, strict, FINE_MAX_CELLS)
      if (typeof fine === 'string') lastFailure = fine
      else if (accepted(fineCtx, fine)) built = fine
      // The optimistic read of the fine grid only when the conservative one
      // joined the ends (and could not make the legs good): where it found
      // no water path at all, one or two cells' worth of rounding will not
      // open one, and the search costs as much again.
      if (!built && fine !== 'path') {
        built = tryMode(fineCtx, fineBox, { ...strict, optimistic: true }, FINE_MAX_CELLS)
      }
    }
    if (built) use = fineCtx
  }

  // 3b: a marked channel too narrow for its edge margin (`channelMarginFor`)
  // — even keeping to the middle of it, closer than a few metres to its
  // edge. Every other rule intact; the plan is best-effort, the legs that
  // run that close to the edge flagged (`finish` measures them against the
  // full margin) and the crew told to keep to the middle.
  if (!built && ctx.channelMargin && (features.channels?.length ?? 0) > 0) {
    const loose: Ctx = { ...ctx, channelMargin: null, budget: REPAIR_BUDGET }
    built = tryBox(loose, planBox, strict)
  }

  // Is there any water path at all? The most relaxed mode answers in one
  // sweep (per view of the grid), and saves climbing down a ladder that ends
  // nowhere. A coarse grid that finds none is asked again at the fine
  // resolution: "no route" is only said when there is truly no water path.
  const shallowMode: Mode = {
    clearanceM: Math.min(clearanceM, CLEARANCE_FLOOR_M),
    wantClearanceM: clearanceM,
    allowShallow: true,
    optimistic: false,
  }
  if (!built) {
    let reason: Failure | null = null
    const sizes = finerGrid(planBox) ? [undefined, FINE_MAX_CELLS] : [undefined]
    for (const maxCells of sizes) {
      const g = gridFor(ctx, planBox, undefined, maxCells)
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
      if (reason === null || reason !== 'path') break
    }
    if (reason) return nonePlan(req, failureText(reason, ctx), baseWarnings)
  }

  // 4: the stand-off, a step at a time. Each rung gets the whole repair
  // budget: rungs sharing one had spent it before the last was tried, and
  // whether a route was found at all turned on where the start was to within
  // a few metres (rc5 F5, rand-78).
  if (!built && clearanceM > CLEARANCE_FLOOR_M) {
    const rungs = [...new Set(
      [...LADDER_FRACTIONS.map((f) => clearanceM * f), CLEARANCE_FLOOR_M]
        .map((c) => Math.max(CLEARANCE_FLOOR_M, c)),
    )]
    for (const c of rungs) {
      ctx.budget = REPAIR_BUDGET
      built = tryBox(ctx, planBox, { clearanceM: c, wantClearanceM: clearanceM, allowShallow: false, optimistic: false })
      if (built) break
    }
  }

  // 5: shallow water, at a price — on the ordinary grid, then the fine one:
  // where the only way out of a pocket of shoal water is a winding gut, a
  // 20 m grid put the route across the spit beside it, and with no repair
  // possible the planner said "no route" with water all the way (rc5 F5).
  if (!built) {
    ctx.budget = REPAIR_BUDGET
    built = tryBox(ctx, planBox, shallowMode)
  }
  if (!built) {
    for (const box of [routeBounds(req.from, req.to), planBox]) {
      if (!finerGrid(box)) continue
      ctx.budget = REPAIR_BUDGET
      built =
        tryMode(ctx, box, shallowMode, FINE_MAX_CELLS) ??
        tryMode(ctx, box, { ...shallowMode, optimistic: true }, FINE_MAX_CELLS)
      if (built) break
    }
  }
  if (!built) return nonePlan(req, failureText(lastFailure, ctx), baseWarnings)

  const plan = finish(use, tightened(built), arrivalReq, baseWarnings)
  evictBigGrids()
  return plan
}

/* -------------------------------------------------------------------------
 * Alternatives — "shorter, but…", Google-Maps style
 * ---------------------------------------------------------------------- */

/** Why an alternative breaks the boat's rules — machine-readable, index into its `plan.legs`. */
export type AltReason =
  | { kind: 'shallow'; leastDepthM: number; legIdx: number }
  | { kind: 'close'; minClearanceM: number; legIdx: number }
  /** Inside the crew's "keep ___ from shallows": `gapM` from water `depthM` deep. */
  | { kind: 'corridor'; gapM: number; depthM: number; legIdx: number }

export interface RouteAlternate {
  /** A whole plan of its own — legs, points, circles, flags. `needsConfirm` when it bends a rule. */
  plan: RoutePlan
  reasons: AltReason[]
  /** "Shallow 3.5 ft · close to land 15 ft" (feet by default; see `alternateLabel`). */
  label: string
  /** How much shorter than the main route, NM. */
  shorterNM: number
}

export interface Alternatives {
  /** At most `MAX_ALTERNATES`, shortest first. */
  alternates: RouteAlternate[]
  /**
   * When the main route is more than `SHORTER_NOTE_FACTOR` × the shortest
   * water path: why the shorter way was not taken, in plain words. Null
   * otherwise.
   */
  shorterNote: string | null
  /** The shortest water path found (depth and stand-off relaxed, never land, hazards or unsurveyed water), NM. */
  shortestWaterNM: number | null
  /**
   * A route that keeps every rule and is shorter than the main one — the
   * relaxed search found a way the main search missed. The caller should
   * use it as the route (it is not an alternative: it bends nothing).
   */
  betterMain: RoutePlan | null
}

/** Offered only when this much shorter than the main route: a share of it, or NM — either. */
export const ALT_MIN_GAIN = 0.05
export const ALT_MIN_GAIN_NM = 0.2
/** At most this many alternatives. */
export const MAX_ALTERNATES = 2
/** "Shorter route not taken because…" when the main route is this much longer than the shortest water path. */
export const SHORTER_NOTE_FACTOR = 1.15

/** "3.5 ft" / "12 ft". */
function shortFeet(m: number): string {
  const ft = m * M_TO_FT
  return ft < 10 ? `${(Math.round(ft * 10) / 10).toFixed(1).replace(/\.0$/, '')} ft` : `${Math.round(ft)} ft`
}

/**
 * "Shallow 3.5 ft · close to land 15 ft" — what an alternative bends, the
 * worst of each. Depth in the crew's unit when a formatter is given.
 */
export function alternateLabel(
  reasons: readonly AltReason[],
  fmt: { depth?: (m: number) => string; length?: (m: number) => string } = {},
): string {
  const depth = fmt.depth ?? shortFeet
  const length = fmt.length ?? shortFeet
  const parts: string[] = []
  for (const r of reasons) {
    if (r.kind === 'shallow') parts.push(`shallow ${depth(Math.max(0, r.leastDepthM))}`)
    else if (r.kind === 'close') parts.push(`close to land ${length(Math.max(0, r.minClearanceM))}`)
    else parts.push(`passes ${length(Math.max(0, r.gapM))} from shallows`)
  }
  const text = parts.join(' · ')
  return text ? text[0].toUpperCase() + text.slice(1) : 'Shorter'
}

/** The closest a plan's sound legs pass to the shallows inside the corridor, or null. */
function corridorWorst(plan: RoutePlan): { gapM: number; depthM: number; legIdx: number } | null {
  let out: { gapM: number; depthM: number; legIdx: number } | null = null
  plan.legs.forEach((l, i) => {
    if (l.corridorGapM == null) return
    if (!out || l.corridorGapM < out.gapM) out = { gapM: l.corridorGapM, depthM: l.corridorDepthM ?? 0, legIdx: i }
  })
  return out
}

/**
 * What a relaxed plan bends, from its own legs — the corridor only where it
 * passes closer to the shallows than the main route itself has to.
 */
function reasonsOf(plan: RoutePlan, clearanceM: number, main?: RoutePlan): AltReason[] {
  let shallow: { leastDepthM: number; legIdx: number } | null = null
  let close: { minClearanceM: number; legIdx: number } | null = null
  plan.legs.forEach((l, i) => {
    if (l.caution === 'unsafe-depth') {
      const d = l.minDepthOutsideM ?? l.minChartedDepthM ?? l.nearShoalDepthM ?? 0
      if (!shallow || d < shallow.leastDepthM) shallow = { leastDepthM: d, legIdx: i }
    }
    const tooClose =
      l.caution === 'reduced-clearance' ||
      (l.caution === 'unsafe-depth' && l.minClearanceM != null && l.minClearanceM < clearanceM)
    if (tooClose) {
      const c = l.minClearanceM ?? 0
      if (!close || c < close.minClearanceM) close = { minClearanceM: c, legIdx: i }
    }
  })
  const out: AltReason[] = []
  const sh = shallow as { leastDepthM: number; legIdx: number } | null
  const cl = close as { minClearanceM: number; legIdx: number } | null
  if (sh) out.push({ kind: 'shallow', ...sh })
  if (cl) out.push({ kind: 'close', ...cl })
  const tight = corridorWorst(plan)
  const had = main ? corridorWorst(main) : null
  if (!sh && tight && (!had || tight.gapM < had.gapM - 1)) out.push({ kind: 'corridor', ...tight })
  return out
}

/**
 * The name of a marked channel a leg runs through, if the chart names one
 * ("Five Mile Cut Channel") — sampled every 50 m along it.
 */
function channelNameOn(features: ChartFeatures, a: LatLon, b: LatLon): string | null {
  const named = features.channels.filter((c) => c.name)
  if (named.length === 0) return null
  const lenM = haversineNM(a.lat, a.lon, b.lat, b.lon) * NM_TO_METERS
  const n = Math.max(1, Math.min(400, Math.ceil(lenM / 50)))
  for (let k = 0; k <= n; k++) {
    const lat = a.lat + ((b.lat - a.lat) * k) / n
    const lon = a.lon + ((b.lon - a.lon) * k) / n
    for (const c of named) {
      let inside = false
      for (const ring of c.rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i]
          const [xj, yj] = ring[j]
          if (yi > lat !== yj > lat && lon < xi + ((lat - yi) * (xj - xi)) / (yj - yi)) inside = !inside
        }
      }
      if (inside) return c.name ?? null
    }
  }
  return null
}

/**
 * Shorter ways than the main route that bend a rule — Google Maps' faded
 * "alternative route" — and, when the main route is much longer than the
 * shortest water path, why that shorter way was not taken.
 *
 * Three relaxed searches over the same chart index and grids as the plan
 * (`makeCtx` reuses them): depth down to whatever is charted (never
 * unsurveyed water, never land or a hazard footprint), the stand-off down to
 * `CLEARANCE_FLOOR_M`, and both. Each is a whole plan — its legs checked
 * against the chart and flagged exactly like a best-effort route, so
 * selecting one needs the same "I understand" as best-effort before Start.
 *
 * Skipped outright when the main route is already within `ALT_MIN_GAIN` of
 * the straight line: nothing can be meaningfully shorter.
 */
export function planAlternatives(
  req: RouteRequest,
  main: RoutePlan,
  fmt: { depth?: (m: number) => string; length?: (m: number) => string } = {},
): Alternatives {
  const none: Alternatives = { alternates: [], shorterNote: null, shortestWaterNM: null, betterMain: null }
  if (main.source === 'none' || main.points.length < 2) return none
  const { features } = req
  if (features.coverage === 'none' || features.depthAreas.length === 0) return none
  const directNM = haversineNM(req.from.lat, req.from.lon, req.to.lat, req.to.lon)
  const worth = (nm: number) => main.totalNM - nm >= Math.min(ALT_MIN_GAIN * main.totalNM, ALT_MIN_GAIN_NM)
  if (!worth(directNM)) return none

  const ctx = makeCtx(req)
  const box = planningBounds(req.from, req.to)
  const arrivalReq = arrivalSetting(req.arrivalFt)
  const baseWarnings = chartWarnings(features)
  const floor = Math.min(ctx.clearanceM, CLEARANCE_FLOOR_M)
  const modes: Mode[] = [
    // Every rule kept, the corridor relaxed: "passes 40 ft from shallows".
    { clearanceM: ctx.clearanceM, wantClearanceM: ctx.clearanceM, allowShallow: false, optimistic: false, corridor: false },
    { clearanceM: ctx.clearanceM, wantClearanceM: ctx.clearanceM, allowShallow: true, optimistic: false, relaxed: true },
    { clearanceM: floor, wantClearanceM: ctx.clearanceM, allowShallow: false, optimistic: false, relaxed: true },
    { clearanceM: floor, wantClearanceM: ctx.clearanceM, allowShallow: true, optimistic: false, relaxed: true },
  ]
  const found: RoutePlan[] = []
  for (const mode of modes) {
    ctx.budget = REPAIR_BUDGET
    let b = attempt(ctx, box, mode)
    if (typeof b === 'string' || !accepted(ctx, b)) {
      ctx.budget = REPAIR_BUDGET
      b = attempt(ctx, box, { ...mode, optimistic: true })
    }
    if (typeof b === 'string' || !accepted(ctx, b)) continue
    found.push(finish(ctx, mode.corridor === false ? tightened(b) : b, arrivalReq, baseWarnings))
  }
  evictBigGrids()
  if (found.length === 0) return none

  const shortestWaterNM = Math.min(...found.map((p) => p.totalNM))
  const better = found
    .filter(
      (p) =>
        p.source === 'charted' &&
        p.totalNM < main.totalNM * (1 - OPTIMISTIC_GAIN) &&
        !reasonsOf(p, ctx.clearanceM, main).some((r) => r.kind === 'corridor'),
    )
    .sort((a, b) => a.totalNM - b.totalNM)[0] ?? null

  const alternates: RouteAlternate[] = []
  for (const plan of found.sort((a, b) => a.totalNM - b.totalNM)) {
    if (!worth(plan.totalNM)) continue
    const reasons = reasonsOf(plan, ctx.clearanceM, main)
    if (reasons.length === 0) continue
    if (plan.source !== 'best-effort' && !reasons.some((r) => r.kind === 'corridor')) continue
    const kinds = reasons.map((r) => r.kind).join('+')
    const same = alternates.some(
      (a) =>
        a.reasons.map((r) => r.kind).join('+') === kinds ||
        Math.abs(a.plan.totalNM - plan.totalNM) < 0.01 * plan.totalNM,
    )
    if (same) continue
    alternates.push({
      plan: asAlternate(plan, reasons, ctx),
      reasons,
      label: alternateLabel(reasons, fmt),
      shorterNM: main.totalNM - plan.totalNM,
    })
    if (alternates.length >= MAX_ALTERNATES) break
  }

  let shorterNote: string | null = null
  const shortest = alternates[0]
  if (
    shortest &&
    (main.totalNM > SHORTER_NOTE_FACTOR * shortest.plan.totalNM || shortest.reasons.some((r) => r.kind === 'corridor'))
  ) {
    shorterNote = shorterRouteNote(req, ctx, main, shortest, fmt)
  }
  return { alternates, shorterNote, shortestWaterNM, betterMain: better }
}

/**
 * An alternate's own shortfall lines, in words true of an alternate. The
 * router writes "No route keeps 5 ft of water the whole way. The safest route
 * crosses 0 ft…" for its last resort — but beside an alternate there IS a
 * route that keeps it (Route 1), and this one was chosen for being shorter.
 */
function asAlternate(plan: RoutePlan, reasons: AltReason[] = [], ctx?: Ctx): RoutePlan {
  const tight = reasons.find((r) => r.kind === 'corridor') as
    | { kind: 'corridor'; gapM: number; depthM: number; legIdx: number }
    | undefined
  if (plan.source === 'charted' && tight && ctx) {
    // Keeps every rule but the corridor: steering it still takes the crew's OK.
    const water = tight.depthM < 0 ? chartedDepthText(tight.depthM) : `${formatDepth(tight.depthM)} water`
    const reason =
      `This shorter route passes ${formatLength(tight.gapM)} from ${water} near leg ${plan.legs[tight.legIdx]?.n ?? tight.legIdx + 1} — ` +
      `closer than your ${formatLength(ctx.corridorM)} margin from shallows. Confirm before you steer it.`
    return {
      ...plan,
      needsConfirm: true,
      confirmReason: reason,
      warnings: [reason, ...plan.warnings.filter((w) => !/margin from shallows, which no route here keeps/.test(w))],
    }
  }
  const say = (w: string): string =>
    w
      .replace(/^No route keeps /, 'This shorter route does not keep ')
      .replace(/ The safest route /, ' It ')
      .replace(/ The closest pass /, ' Its closest pass ')
      .replace(
        /^This is the safest route found, not a safe one — /,
        'It is shorter, not safe: another route keeps your boat’s rules — ',
      )
  return {
    ...plan,
    warnings: plan.warnings.map(say),
    confirmReason: plan.confirmReason != null ? say(plan.confirmReason) : plan.confirmReason,
  }
}

/**
 * "A way 7.8 NM shorter, via Five Mile Cut Channel, needs water charted
 * 0 ft; your boat needs 5 ft." — why the main route is so much longer than
 * the shortest water path, in the words the crew asked for.
 */
function shorterRouteNote(
  req: RouteRequest,
  ctx: Ctx,
  main: RoutePlan,
  alt: RouteAlternate,
  fmt: { depth?: (m: number) => string; length?: (m: number) => string },
): string {
  const depth = fmt.depth ?? shortFeet
  const length = fmt.length ?? shortFeet
  const saved = `${(main.totalNM - alt.plan.totalNM).toFixed(1)} NM`
  const shallow = alt.reasons.find((r) => r.kind === 'shallow') as
    | { kind: 'shallow'; leastDepthM: number; legIdx: number }
    | undefined
  const close = alt.reasons.find((r) => r.kind === 'close') as
    | { kind: 'close'; minClearanceM: number; legIdx: number }
    | undefined
  const tight = alt.reasons.find((r) => r.kind === 'corridor') as
    | { kind: 'corridor'; gapM: number; depthM: number; legIdx: number }
    | undefined
  const leg = alt.plan.legs[(shallow ?? close ?? tight)?.legIdx ?? 0]
  const via = leg ? channelNameOn(req.features, leg.from, leg.to) : null
  const way = `A way ${saved} shorter${via ? `, via ${via},` : ''}`
  const parts: string[] = []
  if (shallow) {
    parts.push(
      `crosses water charted ${depth(Math.max(0, shallow.leastDepthM))} — your boat needs ${depth(ctx.safeDepthM)}`,
    )
  }
  if (close) {
    parts.push(
      `passes ${length(Math.max(0, close.minClearanceM))} from land or a hazard — your stand-off is ${length(ctx.clearanceM)}`,
    )
  }
  if (tight) {
    parts.push(
      `passes within ${length(Math.max(0, tight.gapM))} of ${depth(Math.max(0, tight.depthM))} water — ` +
        `your margin is ${length(ctx.corridorM)}`,
    )
  }
  return `${way} ${parts.join(', and ')}. This route keeps your boat's rules.`
}

/**
 * `box`, clipped to the chart's extent — but never smaller than `floor` (the
 * planning box, which the chart was loaded for). Null when the clip leaves
 * nothing beyond the floor to search.
 */
function clipTo(box: Bounds, extent: Bounds | null, floor: Bounds): Bounds | null {
  const e = extent ?? floor
  const out = {
    minLat: Math.min(floor.minLat, Math.max(box.minLat, e.minLat)),
    minLon: Math.min(floor.minLon, Math.max(box.minLon, e.minLon)),
    maxLat: Math.max(floor.maxLat, Math.min(box.maxLat, e.maxLat)),
    maxLon: Math.max(floor.maxLon, Math.min(box.maxLon, e.maxLon)),
  }
  const grows =
    out.minLat < floor.minLat - 1e-9 ||
    out.minLon < floor.minLon - 1e-9 ||
    out.maxLat > floor.maxLat + 1e-9 ||
    out.maxLon > floor.maxLon + 1e-9
  return grows ? out : null
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
  const snapLeg = (i: number) => (b.snapStart && i === 0) || (b.snapEnd && i === checks.length - 1)
  const cautions = legCautions(ctx, pts, checks, snapLeg)
  const charted = isCharted(cautions)
  const gaps = corridorGaps(ctx, pts, cautions, snapLeg)

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
      minDepthOutsideM: checks[i].minDepthOutsideM,
      overLand: checks[i].crossesLand || (snapLeg(i) && checks[i].entersHazard),
      approachReasons: [
        ...(checks[i].approachDepth ? (['depth'] as const) : []),
        ...(checks[i].approachClearance ? (['clearance'] as const) : []),
      ],
      nearShoalDepthM: checks[i].nearShoal ? checks[i].nearShoalDepthM : null,
      nearShoalDistM: checks[i].nearShoal ? checks[i].nearShoalDistM : null,
      ...(checks[i].narrow && cautions[i] === 'ok' ? { narrow: true } : {}),
      ...corridorFields(gaps[i]),
    }
  })
  const hours = speed > 0 ? totalNM / speed : NaN

  const movedStart = b.snapStart ? points[1] : null
  const movedEnd = b.snapEnd ? points[points.length - 2] : null

  const warnings: string[] = []
  let movedNote: string | null = null
  if (movedStart) {
    movedNote =
      `The chart shows your start ${describeAt(ix, ctx.from)}. The route starts from the nearest ` +
      `navigable water, ${formatLength(distXY(pts[0], pts[1]))} away — you are not in it yet, ` +
      'and the first leg is not charted water: leave by eye.'
    warnings.push(movedNote)
  }
  if (movedEnd) {
    const note =
      `The chart shows your destination ${describeAt(ix, ctx.to)}. The route reaches the nearest ` +
      `navigable water, ${formatLength(distXY(pts[pts.length - 2], pts[pts.length - 1]))} short ` +
      'of it — the last leg is not charted water: come alongside by eye.'
    movedNote ??= note
    warnings.push(note)
  }
  let confirmReason: string | null = null
  if (!charted) {
    const lines = shortfallWarnings(ctx, legs, checks, snapLeg)
    // The red box leads with how the route falls short, feet first; only
    // when the one failing leg is a long hop off the chart's land is that
    // hop the reason.
    confirmReason = lines.length > 1 ? lines[0] : (movedNote ?? lines[0] ?? null)
    warnings.push(...lines)
  }
  warnings.push(...narrowWarnings(ctx, legs))
  const slowTurns = charted ? turnsWithoutRoom(ctx, pts, b.snapStart, b.snapEnd) : []
  if (slowTurns.length > 0) {
    const kn = Math.round(req.speedKn)
    warnings.push(
      `Slow down for the turn at ${slowTurns.length === 1 ? 'waypoint' : 'waypoints'} ` +
        `${joinWords(slowTurns.map(String))}: at ${kn} kn there is not room there to turn at speed.`,
    )
  }
  const approachDepth = legs
    .filter((l) => l.caution === 'shallow-approach' && l.approachReasons?.includes('depth'))
    .map((l) => l.n)
  if (approachDepth.length > 0) {
    warnings.push(
      `${approachDepth.length === 1 ? 'Leg' : 'Legs'} ${joinWords(approachDepth.map(String))} ` +
        `${approachDepth.length === 1 ? 'runs' : 'run'} close to the start or destination through water ` +
        'charted shallower than you need, or not surveyed — check the depth there by eye.',
    )
  }
  const approachClose = legs.filter(
    (l) => l.caution === 'shallow-approach' && l.approachReasons?.includes('clearance'),
  )
  if (approachClose.length > 0) {
    const least = Math.min(...approachClose.map((l) => l.minClearanceM ?? Infinity))
    warnings.push(
      `${approachClose.length === 1 ? 'Leg' : 'Legs'} ${joinWords(approachClose.map((l) => String(l.n)))} ` +
        `${approachClose.length === 1 ? 'passes' : 'pass'} ` +
        `${Number.isFinite(least) ? formatLength(least) : 'closer than your stand-off'} from land or a ` +
        `structure near the start or destination — inside your ${formatLength(ctx.clearanceM)} ` +
        'stand-off. Keep a lookout.',
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
    arrivalFt: arrivalRadii(pts, arrivalReq),
    failure: null,
    needsConfirm: !charted,
    confirmReason,
    ...(slowTurns.length > 0 ? { slowTurns } : {}),
  }
}

/**
 * Each leg's shortfall against the corridor — the least distance to water
 * too shallow for the boat, where it is closer than "keep ___ from shallows"
 * — for the legs that are otherwise sound (a leg already flagged for its
 * depth or its stand-off says so instead). Snap legs off or onto a position
 * the chart shows ashore are not measured.
 */
function corridorGaps(
  ctx: Ctx,
  pts: XY[],
  cautions: LegCaution[],
  snapLeg: (i: number) => boolean,
): ({ distM: number; depthM: number } | null)[] {
  return cautions.map((c, i) =>
    snapLeg(i) || (c !== 'ok' && c !== 'shallow-approach') ? null : corridorOf(ctx, pts[i], pts[i + 1]),
  )
}

function corridorFields(g: { distM: number; depthM: number } | null): Partial<RouteLeg> {
  return g ? { narrow: true, corridorGapM: g.distM, corridorDepthM: g.depthM } : {}
}

/** The plan's words for its narrow legs: how close to the shallows, and to keep a lookout. */
function narrowWarnings(ctx: Ctx, legs: RouteLeg[]): string[] {
  const narrow = legs.filter((l) => l.narrow)
  if (narrow.length === 0) return []
  const one = narrow.length === 1
  const which = `${one ? 'Leg' : 'Legs'} ${joinWords(narrow.map((l) => String(l.n)))}`
  const close = narrow.filter((l) => l.corridorGapM != null)
  if (close.length === 0 || !(ctx.corridorM > 0)) {
    return [
      `${which} ${one ? 'runs' : 'run'} through a narrow channel with shallow water close on ` +
        'both sides — keep to the middle.',
    ]
  }
  const worst = close.reduce((w, l) => ((l.corridorGapM ?? Infinity) < (w.corridorGapM ?? Infinity) ? l : w))
  const d = worst.corridorDepthM ?? 0
  const water = d < 0 ? chartedDepthText(d) : `${formatDepth(d)} water`
  return [
    `${which} ${one ? 'passes' : 'pass as close as'} ${formatLength(worst.corridorGapM ?? 0)} from ${water} — ` +
      `inside your ${formatLength(ctx.corridorM)} margin from shallows, which no route here keeps. ` +
      'Keep to the middle and keep a lookout.',
  ]
}

/**
 * The turn points of a sound route where a boat at its cruise speed has no
 * room to turn (`turnFits`), outside the approach zones — the crew is told
 * to slow down for them.
 */
function turnsWithoutRoom(ctx: Ctx, pts: XY[], snapStart: boolean, snapEnd: boolean): number[] {
  const mode: Mode = { clearanceM: ctx.clearanceM, wantClearanceM: ctx.clearanceM, allowShallow: false, optimistic: false }
  const out: number[] = []
  for (let k = 1; k + 1 < pts.length; k++) {
    if (snapStart && k === 1) continue
    if (snapEnd && k === pts.length - 2) continue
    if (inZoneXY(ctx, pts[k])) continue
    if (!turnFits(ctx, mode, pts[k - 1], pts[k], pts[k + 1])) out.push(k)
  }
  return out
}

/** Each leg's caution, from its check against the chart. */
function legCautions(
  ctx: Ctx,
  pts: XY[],
  checks: SegmentCheck[],
  snapLeg: (i: number) => boolean,
): LegCaution[] {
  // The dock hop is judged by the approach length itself, whether or not a
  // zone lies round this end (a re-route from a fix the chart puts ashore
  // has none round the boat, and must not need the crew's OK for the hop).
  const approachM = Number.isFinite(ctx.req.approachM)
    ? Math.max(0, ctx.req.approachM as number)
    : DEFAULT_APPROACH_M
  return checks.map((r, i): LegCaution => {
    // The hop off (or onto) a dock the chart draws as land: nothing about it
    // can be checked, but it is the dock, not the passage — flagged "by
    // eye", not a reason to call a sound route unsafe. A long one is a
    // different thing (the chart really puts the boat ashore), and stays
    // unsafe.
    if (
      snapLeg(i) &&
      (r.crossesLand || r.entersHazard) &&
      approachM > 0 &&
      distXY(pts[i], pts[i + 1]) <= approachM + 1e-6
    ) {
      return 'off-chart-end'
    }
    return cautionOf(r)
  })
}

/** Every leg sound — the approach and dock exceptions aside. */
function isCharted(cautions: LegCaution[]): boolean {
  return cautions.every((c) => c === 'ok' || c === 'shallow-approach' || c === 'off-chart-end')
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
        `${chartedDepthText(shoal)} near leg ${legs[shoalLeg].n}.`,
    )
  } else if (unsurveyedLeg >= 0) {
    out.push(
      `No route keeps ${safe} of charted water the whole way. The safest route runs through water ` +
        `the chart never surveyed near leg ${legs[unsurveyedLeg].n}.`,
    )
  } else {
    // Only beside the track: water too shallow within the depth margin.
    let nearLeg = -1
    let nearDist = Infinity
    for (let i = 0; i < checks.length; i++) {
      const r = checks[i]
      if (!r.nearShoal || snapLeg(i) || r.nearShoalDistM === null) continue
      if (r.nearShoalDistM < nearDist) {
        nearDist = r.nearShoalDistM
        nearLeg = i
      }
    }
    if (nearLeg >= 0) {
      const d = checks[nearLeg].nearShoalDepthM ?? 0
      const water = d < 0 ? chartedDepthText(d) : `${formatDepth(d)} water`
      const a = legs[nearLeg].from
      const b = legs[nearLeg].to
      const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }
      const m = toXY(ctx.ix.proj, mid)
      if (ctx.channelMargin && ctx.inChannel(m.x, m.y)) {
        out.push(
          `The marked channel near leg ${legs[nearLeg].n} is too narrow to keep ` +
            `${formatLength(ctx.channelMargin.minM)} from its edges: the route passes ` +
            `${formatLength(nearDist)} from ${water}. Keep to the middle of the channel.`,
        )
      } else {
        out.push(
          `No route keeps ${formatLength(ctx.depthMarginM)} clear of water shallower than ${safe} ` +
            `the whole way outside the marked channels. The safest route passes ${formatLength(nearDist)} ` +
            `from ${water} near leg ${legs[nearLeg].n}.`,
        )
      }
    }
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

/**
 * The per-point capture radii for a plan already made, at a new arrival
 * setting — without re-planning it. The route's points and legs do not
 * depend on the setting at all, so changing it mid-passage must not renumber
 * the waypoints the crew is following. Every point takes the setting itself
 * (100–200 ft, see `arrivalRadii`); nothing about it needs the chart.
 *
 * Null when the plan has no line. `req` is kept for callers written when
 * the radii were measured against the chart.
 */
export function recomputeArrivalRadii(
  plan: Pick<RoutePlan, 'points' | 'source'>,
  _req: Pick<RouteRequest, 'safeDepthM' | 'clearanceM' | 'features' | 'approachM' | 'depthMarginM'>,
  arrivalFt: number,
): number[] | null {
  if (plan.source === 'none' || plan.points.length < 2) return null
  return arrivalRadii(plan.points, arrivalFt)
}

/**
 * A plan already made, checked again against the chart for a boat whose
 * draft, margin or stand-off has changed — without moving a single point.
 *
 * What a route was checked against is the boat it was planned for. When the
 * boat is made deeper (or its stand-off wider) mid-passage and a fresh plan
 * cannot be made — no signal, no chart for the new box — the route being
 * steered must not carry on looking sound: every leg is measured again for
 * the new boat, and one that now falls short is flagged exactly as the
 * planner would have flagged it, with the plan made `best-effort` and
 * `needsConfirm` so it is not steered again until the crew has read it.
 *
 * Null when the plan has no line, or there is no chart to measure against.
 */
export function recheckPlan(
  plan: RoutePlan,
  req: Pick<
    RouteRequest,
    'safeDepthM' | 'clearanceM' | 'features' | 'approachM' | 'depthMarginM' | 'arrivalFt' | 'shallowMarginM'
  >,
): RoutePlan | null {
  if (plan.source === 'none' || plan.points.length < 2) return null
  if (req.features.coverage === 'none' || req.features.depthAreas.length === 0) return null
  if (plan.legs.length !== plan.points.length - 1) return null
  const from = plan.points[0]
  const to = plan.points[plan.points.length - 1]
  const ctx = makeCtx({ ...req, from, to, speedKn: 0 })
  const pts = plan.points.map((p) => toXY(ctx.ix.proj, p))
  const checks = pts.slice(1).map((p, i) => check(ctx, ctx.clearanceM, pts[i], p))
  const snapLeg = (i: number) =>
    (plan.movedStart != null && i === 0) || (plan.movedEnd != null && i === checks.length - 1)
  const cautions = legCautions(ctx, pts, checks, snapLeg)
  const charted = isCharted(cautions)
  const gaps = corridorGaps(ctx, pts, cautions, snapLeg)
  const legs: RouteLeg[] = plan.legs.map((old, i) => {
    const leg: RouteLeg = { ...old }
    delete leg.narrow
    delete leg.corridorGapM
    delete leg.corridorDepthM
    return {
    ...leg,
    ...(checks[i].narrow && cautions[i] === 'ok' ? { narrow: true } : {}),
    ...corridorFields(gaps[i]),
    caution: cautions[i],
    minChartedDepthM: checks[i].minDepthM,
    minClearanceM: checks[i].minClearanceM,
    minDepthOutsideM: checks[i].minDepthOutsideM,
    overLand: checks[i].crossesLand || (snapLeg(i) && checks[i].entersHazard),
    approachReasons: [
      ...(checks[i].approachDepth ? (['depth'] as const) : []),
      ...(checks[i].approachClearance ? (['clearance'] as const) : []),
    ],
    nearShoalDepthM: checks[i].nearShoal ? checks[i].nearShoalDepthM : null,
    nearShoalDistM: checks[i].nearShoal ? checks[i].nearShoalDistM : null,
    }
  })
  const shortfall = charted ? [] : shortfallWarnings(ctx, legs, checks, snapLeg)
  // The old plan's own shortfall lines were about the old boat.
  const kept = plan.warnings.filter(
    (w) =>
      !/^(No route keeps |This shorter route does not keep )/.test(w) &&
      !/^(This is the safest route found|It is shorter, not safe)/.test(w) &&
      !/^The marked channel near leg \d+ is too narrow/.test(w) &&
      !/^Legs? [\d, and]+ (runs? through a narrow channel|pass(es| as close as) )/.test(w),
  )
  const arrivalReq = arrivalSetting(req.arrivalFt ?? Math.max(...plan.arrivalFt, 0))
  return {
    ...plan,
    legs,
    source: charted ? 'charted' : 'best-effort',
    needsConfirm: !charted,
    confirmReason: charted ? null : (shortfall[0] ?? null),
    warnings: [...shortfall, ...narrowWarnings(ctx, legs), ...kept],
    arrivalFt: arrivalRadii(pts, arrivalReq),
  }
}

/**
 * What the chart says at one position — a depth in metres, `'land'`, or
 * `'unsurveyed'` — read from an index a plan has already built over this
 * features object. Null when none covers the position: this never builds one,
 * because it is asked once a second from the steering loop.
 */
export function chartStateAt(
  features: ChartFeatures,
  p: LatLon,
): number | 'land' | 'unsurveyed' | null {
  if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) return null
  const ix = peekChartIndex(features, { minLat: p.lat, maxLat: p.lat, minLon: p.lon, maxLon: p.lon })
  if (!ix) return null
  const q = toXY(ix.proj, p)
  if (q.x < ix.x0 || q.x > ix.x1 || q.y < ix.y0 || q.y > ix.y1) return null
  const s = stateNear(ix, q.x, q.y)
  if (s === LAND) return 'land'
  if (Number.isNaN(s)) return 'unsurveyed'
  return s
}

/* -------------------------------------------------------------------------
 * Live checks — asked once a second from the steering loop
 *
 * The route was checked at the dock; these check where the boat actually
 * is, against the same chart and the same rules, with the fix's claimed
 * error added to every margin: a boat reported 20 ft inside a 30 ft stand-off
 * by a ±25 ft fix may be right on the bank.
 * ---------------------------------------------------------------------- */

/** What a live check measures against: the route's chart, its ends, the boat. */
export interface LiveChartRequest {
  features: ChartFeatures
  /** The route's own start and destination — the approach zones are round them. */
  from: LatLon
  to: LatLon
  safeDepthM: number
  clearanceM: number
  approachM?: number
  depthMarginM?: number
  /** See `RouteRequest.channelMarginM`. */
  channelMarginM?: number
  /** See `RouteRequest.approachZones`. */
  approachZones?: ApproachZone[]
  /** See `RouteRequest.fromShallowZoneM`. */
  fromShallowZoneM?: number
  /** See `RouteRequest.fromZoneM`. */
  fromZoneM?: number
}

/**
 * The one context the steering loop measures against, kept between fixes —
 * the index itself is cached per chart by `chartIndexFor`, and for the route
 * being steered it is the one the planner already built (same chart, same
 * ends, same box), so this normally costs nothing.
 */
let liveCache: { features: ChartFeatures; key: string; ctx: Ctx } | null = null

function liveCtx(req: LiveChartRequest): Ctx | null {
  const f = req.features
  if (!f || f.coverage === 'none' || f.depthAreas.length === 0) return null
  const ok = (p: LatLon) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon)
  if (!ok(req.from) || !ok(req.to)) return null
  if (haversineNM(req.from.lat, req.from.lon, req.to.lat, req.to.lon) * NM_TO_METERS < 1) return null
  const key = [
    req.from.lat, req.from.lon, req.to.lat, req.to.lon,
    req.safeDepthM, req.clearanceM, req.approachM ?? '', req.depthMarginM ?? '', req.channelMarginM ?? '',
    req.approachZones ? req.approachZones.map((z) => `${z.lat},${z.lon},${z.radiusM}`).join(';') : '-',
    req.fromShallowZoneM ?? '', req.fromZoneM ?? '',
  ].join('|')
  if (liveCache && liveCache.features === f && liveCache.key === key) return liveCache.ctx
  // The corridor is the planner's: live checks hold the boat to the rules a
  // leg must keep (the depth margin, the channel's edge), not to the room
  // the route was planned with.
  const ctx = makeCtx({ ...req, speedKn: 0, shallowMarginM: 0 })
  liveCache = { features: f, key, ctx }
  return ctx
}

/** Inside the index, with room for a measuring radius — else nothing to say. */
function insideIndex(ix: ChartIndex, p: XY, padM = 0): boolean {
  return p.x - padM > ix.x0 && p.x + padM < ix.x1 && p.y - padM > ix.y0 && p.y + padM < ix.y1
}

function accuracyOf(accuracyM: number | null | undefined): number {
  return accuracyM != null && Number.isFinite(accuracyM) && accuracyM > 0 ? accuracyM : 0
}

/**
 * Is the shortcut no worse than the leg it stands in for, rule by rule? Used
 * when the leg itself cannot meet the rules with the fix's error added: the
 * straight line is then held to the leg's own standard, never below it.
 */
function noWorseThanLeg(line: SegmentCheck, leg: SegmentCheck): boolean {
  if (line.crossesLand && !leg.crossesLand) return false
  if (line.entersHazard && !leg.entersHazard) return false
  if (line.unsurveyed && !leg.unsurveyed) return false
  if (line.shallow) {
    if (!leg.shallow) return false
    if ((line.minDepthOutsideM ?? -Infinity) < (leg.minDepthOutsideM ?? -Infinity) - 1e-9) return false
  }
  if (line.nearShoal && !leg.shallow) {
    if (!leg.nearShoal) return false
    if ((line.nearShoalDistM ?? 0) < (leg.nearShoalDistM ?? 0) - 1e-6) return false
    if ((line.nearShoalDepthM ?? 0) < (leg.nearShoalDepthM ?? 0) - 1e-9) return false
  }
  if (!line.clearanceOk && line.clearanceOutsideM < leg.clearanceOutsideM - 1e-6) return false
  return true
}

export type ShortcutVerdict = 'clear' | 'unsafe'

/**
 * May the boat steer straight from where it is to `target`, the point after
 * the turn point `turn` it has just switched away from?
 *
 * The line from the fix to the target is checked with the same rules as a
 * leg — depth under it, the depth margin beside it (outside channels), the
 * stand-off from land and hazards, the approach allowance near the ends —
 * with the fix's claimed error added to the stand-off and to the depth
 * margin, since the boat may be that far from where the fix puts it.
 *
 * `clear` when it passes; also — unless `strict` — when the planned leg
 * `turn` → `target` cannot itself pass with that error added and the line
 * is no worse than it, rule by rule (the shortcut is never held to more than
 * the route it cuts: a best-effort route's own legs fail the rules, and its
 * turns must still be let go). `unsafe` otherwise. Null when there is no
 * chart in memory for the line — the caller decides what to do without one.
 *
 * `strict` is for a route that DOES meet the rules: where the fix's error is
 * wider than the room the leg has, "no worse than the leg" was a corner cut
 * at the leg's own clearance with the boat anywhere within that error of it,
 * and the way on is round the turn point, along the checked legs.
 */
export function liveShortcut(
  req: LiveChartRequest,
  fix: LatLon,
  turn: LatLon,
  target: LatLon,
  accuracyM?: number | null,
  strict = false,
): ShortcutVerdict | null {
  const ctx = liveCtx(req)
  if (!ctx) return null
  const { ix } = ctx
  const p = toXY(ix.proj, fix)
  const t = toXY(ix.proj, turn)
  const g = toXY(ix.proj, target)
  if (!insideIndex(ix, p) || !insideIndex(ix, t) || !insideIndex(ix, g)) return null
  const acc = accuracyOf(accuracyM)
  const opts = {
    safeDepthM: ctx.safeDepthM,
    clearanceM: ctx.clearanceM + acc,
    zones: ctx.zones,
    depthMarginM: ctx.depthMarginM + acc,
    inChannel: ctx.inChannel,
    // The channel margin is not widened by the fix's error: inside a dredged
    // cut it is already the room for the boat's error and wander, and a line
    // held to both refused every turn in a narrow channel.
    channelMargin: ctx.channelMargin,
    // Nor the keep-to-the-middle rule of a narrow gut, for the same reason.
    narrowMargin: ctx.narrowMargin && { ...ctx.narrowMargin, maxM: ctx.narrowMargin.maxM + acc },
  }
  const line = checkSegment(ix, p.x, p.y, g.x, g.y, opts)
  if (line.ok) return 'clear'
  if (strict) return 'unsafe'
  const leg = checkSegment(ix, t.x, t.y, g.x, g.y, opts)
  if (leg.ok) return 'unsafe'
  return noWorseThanLeg(line, leg) ? 'clear' : 'unsafe'
}

/**
 * May the boat steer straight from the fix to `target` instead of along the
 * path fix → `via`… → target? The line is checked like a leg, with the fix's
 * error added to the stand-off and the depth margin (see `liveShortcut`).
 * `clear` when it passes; when it does not, `clear` still if the path it
 * replaces fails too (with that error added) and the line is no worse than
 * the worst of the path, rule by rule — never less water, less room or more
 * unsurveyed water than the way it stands in for — or if the line meets the
 * rules with the smaller allowance `plainM` added. `unsafe` otherwise; null
 * without a chart for it.
 *
 * Used to turn a boat onto the leg out of a turn point before it gets there
 * ("Round waypoint N first"). The path is judged from the first `via` point
 * on — the planned stretches — never from where the boat happens to be.
 */
export function livePathShortcut(
  req: LiveChartRequest,
  fix: LatLon,
  via: readonly LatLon[],
  target: LatLon,
  accuracyM?: number | null,
  plainM?: number | null,
): ShortcutVerdict | null {
  const ctx = liveCtx(req)
  if (!ctx) return null
  const { ix } = ctx
  const pts = [fix, ...via, target].map((p) => toXY(ix.proj, p))
  if (!pts.every((p) => insideIndex(ix, p))) return null
  const acc = accuracyOf(accuracyM)
  const opts = {
    safeDepthM: ctx.safeDepthM,
    clearanceM: ctx.clearanceM + acc,
    zones: ctx.zones,
    depthMarginM: ctx.depthMarginM + acc,
    inChannel: ctx.inChannel,
    // The channel margin is not widened by the fix's error: inside a dredged
    // cut it is already the room for the boat's error and wander, and a line
    // held to both refused every turn in a narrow channel.
    channelMargin: ctx.channelMargin,
    // Nor the keep-to-the-middle rule of a narrow gut, for the same reason.
    narrowMargin: ctx.narrowMargin && { ...ctx.narrowMargin, maxM: ctx.narrowMargin.maxM + acc },
  }
  const p = pts[0]
  const g = pts[pts.length - 1]
  const line = checkSegment(ix, p.x, p.y, g.x, g.y, opts)
  if (line.ok) return 'clear'
  // The path's standard is its planned stretches — from the first `via`
  // point on — not the boat's own position: measured from the fix, a boat
  // already close along a bank set its own (lower) bar, and each fix's line
  // was allowed a little closer than the last.
  let worst: SegmentCheck | null = null
  for (let i = via.length > 0 ? 1 : 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) continue
    const r = checkSegment(ix, a.x, a.y, b.x, b.y, opts)
    worst = worst ? worstOf(worst, r) : r
  }
  if (worst && !worst.ok && noWorseThanLeg(line, worst)) return 'clear'
  // Or the line meets the rules every planned leg meets with `plainM` (the
  // fix's 68 % error, rather than its 95 %) added. A turn started a few
  // metres early cuts inside the corner by a few metres; where the route
  // hugs a bank on the outside, "no worse than the path" refused every such
  // line, and the boat was sent on at the mark and turned there — too late.
  const plainAcc = plainM == null ? null : accuracyOf(plainM)
  if (plainAcc != null && plainAcc < acc) {
    const plain = checkSegment(ix, p.x, p.y, g.x, g.y, {
      ...opts,
      clearanceM: ctx.clearanceM + plainAcc,
      depthMarginM: ctx.depthMarginM + plainAcc,
      channelMargin: ctx.channelMargin,
      narrowMargin: ctx.narrowMargin && { ...ctx.narrowMargin, maxM: ctx.narrowMargin.maxM + plainAcc },
    })
    if (plain.ok) return 'clear'
  }
  return 'unsafe'
}

/** The worse of two checks, rule by rule — a path's standard is its worst stretch. */
function worstOf(a: SegmentCheck, b: SegmentCheck): SegmentCheck {
  const minN = (x: number | null, y: number | null) =>
    x == null ? y : y == null ? x : Math.min(x, y)
  return {
    ok: a.ok && b.ok,
    depthOk: a.depthOk && b.depthOk,
    clearanceOk: a.clearanceOk && b.clearanceOk,
    crossesLand: a.crossesLand || b.crossesLand,
    entersHazard: a.entersHazard || b.entersHazard,
    usedApproach: a.usedApproach || b.usedApproach,
    approachDepth: a.approachDepth || b.approachDepth,
    approachClearance: a.approachClearance || b.approachClearance,
    nearShoal: a.nearShoal || b.nearShoal,
    narrow: a.narrow || b.narrow,
    nearShoalDepthM: minN(a.nearShoalDepthM, b.nearShoalDepthM),
    nearShoalDistM: minN(a.nearShoalDistM, b.nearShoalDistM),
    shallow: a.shallow || b.shallow,
    unsurveyed: a.unsurveyed || b.unsurveyed,
    minDepthM: minN(a.minDepthM, b.minDepthM),
    minDepthOutsideM: minN(a.minDepthOutsideM, b.minDepthOutsideM),
    minClearanceM: minN(a.minClearanceM, b.minClearanceM),
    clearanceOutsideM: Math.min(a.clearanceOutsideM, b.clearanceOutsideM),
  }
}

/**
 * Is the line `lengthM` metres from `from` on `courseDeg` (true) clear of
 * land and hazard footprints? The course to steer is checked with it before
 * the card gives it (`useNavigation`). Null when no chart covers the line.
 */
export function liveRayClear(
  req: LiveChartRequest,
  from: LatLon,
  courseDeg: number,
  lengthM: number,
): boolean | null {
  const r = liveRay(req, from, courseDeg, lengthM)
  return r == null ? null : !r.land
}

/**
 * What lies on the line `lengthM` metres from `from` on `courseDeg` (true):
 * land or a hazard footprint anywhere on it; water charted too shallow for
 * the boat on it outside the approach zones round the route's ends (below
 * `floorDepthM` instead, when that is shallower); and, asked for with
 * `closeM`, whether it passes within that of land or a hazard. Null when no
 * chart covers the line.
 */
export function liveRay(
  req: LiveChartRequest,
  from: LatLon,
  courseDeg: number,
  lengthM: number,
  floorDepthM?: number | null,
  closeM?: number | null,
): { land: boolean; shallow: boolean; close?: boolean } | null {
  if (!Number.isFinite(from?.lat) || !Number.isFinite(from?.lon) || !(lengthM > 0)) return null
  if (!Number.isFinite(courseDeg)) return null
  const ctx = liveCtx(req)
  if (!ctx) return null
  const { ix } = ctx
  const p = toXY(ix.proj, from)
  const th = (courseDeg * Math.PI) / 180
  const e = { x: p.x + lengthM * Math.sin(th), y: p.y + lengthM * Math.cos(th) }
  if (!insideIndex(ix, p) || !insideIndex(ix, e)) return null
  const r = checkSegment(ix, p.x, p.y, e.x, e.y, {
    // "Shallow" below the floor asked for, when that is shallower than the
    // boat needs: a best-effort route's own least depth.
    safeDepthM:
      floorDepthM != null && Number.isFinite(floorDepthM)
        ? Math.min(ctx.safeDepthM, Math.max(0, floorDepthM))
        : ctx.safeDepthM,
    clearanceM: closeM != null && closeM > 0 ? closeM : 0,
    zones: ctx.zones,
    depthMarginM: 0,
  })
  const land = r.crossesLand || r.entersHazard
  return {
    land,
    shallow: r.shallow,
    // Within `closeM` of land or a hazard (outside the approach zones).
    ...(closeM != null && closeM > 0 ? { close: land || r.clearanceOutsideM < closeM } : {}),
  }
}

/** What lies close to the line ahead — see `liveAhead`. */
export interface ChartAhead {
  /** Land, a structure or a hazard footprint within the radius of the line. */
  land: boolean
  /** Water charted shallower than the boat needs within the radius of the line. */
  shallow: boolean
}

/**
 * Is there land, a hazard, or water charted too shallow for the boat within
 * `radiusM` of the line ahead — the polyline `pts`, starting at the fix?
 *
 * Asked with the fix's claimed error as the radius: the boat may be
 * anywhere in that circle, so anything that close to the line it is
 * steering is somewhere it may actually be about to go. Outside the
 * approach zones round the route's own ends (the dock stretches, drawn
 * dotted already). Marked channels are NOT excused here: a dredged cut is
 * shallow bank either side, which is exactly where a poor fix is dangerous.
 *
 * Null when no chart covers the line.
 */
export function liveAhead(
  req: LiveChartRequest,
  pts: readonly LatLon[],
  radiusM: number,
): ChartAhead | null {
  if (pts.length < 2 || !(radiusM > 0)) return null
  const ctx = liveCtx(req)
  if (!ctx) return null
  const { ix } = ctx
  const xy = pts.map((p) => toXY(ix.proj, p))
  if (!xy.every((p) => insideIndex(ix, p))) return null
  let land = false
  let shallow = false
  for (let i = 0; i + 1 < xy.length; i++) {
    const a = xy[i]
    const b = xy[i + 1]
    const r = checkSegment(ix, a.x, a.y, b.x, b.y, {
      safeDepthM: ctx.safeDepthM,
      clearanceM: radiusM,
      zones: ctx.zones,
      depthMarginM: radiusM,
    })
    if (r.crossesLand || r.entersHazard || !r.clearanceOk) land = true
    if (r.shallow || r.nearShoal) shallow = true
  }
  return { land, shallow }
}

/** What the chart shows at and round a fix — see `liveChartNear`. */
export interface ChartNear {
  /** At the fix itself: land, or water charted shallower than the boat needs. Null otherwise. */
  here: { land: boolean; depthM: number | null } | null
  /**
   * Within `radiusM` of the fix, when the fix itself is fine: land or a
   * hazard footprint (how far), or water charted shallower than the boat
   * needs (its depth and how far). Null when there is none that close.
   */
  near:
    | { land: true; depthM: null; distM: number }
    | { land: false; depthM: number; distM: number }
    | null
}

/**
 * The chart at the boat's position, and within its accuracy circle.
 *
 * "Shallow here" read the chart at the fix only: a boat 30 m inside the
 * shallows, with a fix 26 m off claiming ±18 m, read as fine. So the whole
 * circle the fix claims is looked at: the fix itself first, then anything
 * within `radiusM` — land, a hazard footprint, or water charted shallower
 * than the boat needs, marked channel or not (the fix's error does not stop
 * at a channel's edge). Unsurveyed water is not counted: it is not known to
 * be shallow, and the route itself says where it relied on it.
 *
 * Null when no chart covers the position.
 */
export function liveChartNear(
  req: LiveChartRequest,
  fix: LatLon,
  radiusM?: number | null,
): ChartNear | null {
  if (!Number.isFinite(fix?.lat) || !Number.isFinite(fix?.lon)) return null
  const ctx = liveCtx(req)
  if (!ctx) return null
  const { ix } = ctx
  const q = toXY(ix.proj, fix)
  const r = accuracyOf(radiusM)
  if (!insideIndex(ix, q, r)) return null
  const s = stateNear(ix, q.x, q.y)
  if (s === LAND || hazardDistance(ix, q.x, q.y, q.x, q.y, 0) <= 0) {
    return { here: { land: true, depthM: null }, near: null }
  }
  if (!Number.isNaN(s) && s < ctx.safeDepthM) {
    return { here: { land: false, depthM: s }, near: null }
  }
  if (r <= 0) return { here: null, near: null }
  const landD = Math.min(
    landDistance(ix, q.x, q.y, q.x, q.y, r),
    Math.max(0, hazardDistance(ix, q.x, q.y, q.x, q.y, r)),
  )
  if (landD <= r) return { here: null, near: { land: true, depthM: null, distM: landD } }
  const around = checkSegment(ix, q.x, q.y, q.x, q.y, {
    safeDepthM: ctx.safeDepthM,
    clearanceM: 0,
    zones: [],
    depthMarginM: r,
  })
  if (around.nearShoal && around.nearShoalDepthM != null) {
    return {
      here: null,
      near: { land: false, depthM: around.nearShoalDepthM, distM: around.nearShoalDistM ?? r },
    }
  }
  return { here: null, near: null }
}

/** Re-exported for callers that measure against the chart themselves. */
export { CLEARANCE_MEASURE_M }
