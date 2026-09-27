/**
 * The chart as geometry — what the route planner checks its own answer
 * against.
 *
 * The planner in `routing.ts` searches a grid, because a grid is what makes
 * "find a way round everything" fast enough to run on a phone. But a grid is a
 * picture of the chart, not the chart: a cell is 8 m in a harbour and well
 * over 100 m on a long passage, and a shoal bar, a jetty or a pylon narrower
 * than a cell can slip between two cell centres and never be seen. That is not
 * a theoretical worry — it is exactly how the first version of this planner
 * drew courses across bars and jetties.
 *
 * So the grid only *proposes*. This file *disposes*: every leg the planner
 * wants to hand a crew is checked against the real polygons, lines and points
 * the chart service returned, and a leg that fails is re-planned on a finer
 * grid or flagged. Nothing here is approximate in the way the grid is: a
 * segment either enters a polygon or it does not.
 *
 * Three ideas carry the whole file:
 *
 * **One flat projection per area.** Everything is projected once into metres
 * east and north of the area's south-west corner, at the area's middle
 * latitude. Over the ≤ 50 NM boxes the planner ever asks for the scale error
 * of that projection is a few parts in a thousand — centimetres on a
 * stand-off — and it turns every distance into plain arithmetic.
 *
 * **The chart's state at a point is "finest chart wins".** ENC is published in
 * bands of different scale, and a coastal chart generalises a 12 m dredged cut
 * into the flat either side of it, or draws a whole harbour as land. The most
 * detailed chart covering a point speaks for it — see `rasterise` in
 * `routing.ts` for the long version. Area hazards (wrecks, obstructions) are
 * the exception: they block from any band, whatever a finer chart says about
 * the depth around them, so they are kept apart from the depth/land picture.
 *
 * **Only the boundaries where that state changes matter.** Depth areas tile
 * the sea and share their edges, and most of those edges separate two bands
 * the boat is equally happy in. The index works out, once per area, which
 * pieces of which edges actually separate two different states — the
 * "effective boundary" — and what the state is on each side. A leg then only
 * has to be split where it crosses one of those, and a stand-off only has to
 * be measured to the pieces with land on one side.
 */

import { metersPerDegree } from './geo'
import type { ChartFeatures } from './routing'

/* -------------------------------------------------------------------------
 * Basics
 * ---------------------------------------------------------------------- */

export interface Bounds {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

/**
 * Slivers of chart narrower than this are not seen, metres.
 *
 * ENC cells meet along straight seams, and two adjoining cells' polygons do
 * not always share the seam's vertices exactly — rounding to six decimal
 * places of a degree leaves gaps and overlaps of a few centimetres. Read
 * literally, a leg crossing such a seam passes through a 3 cm strip of
 * "unsurveyed" water and fails. Nothing a boat can hit or ground on is half a
 * metre wide and charted as an area, so gaps below this are treated as the
 * artefacts they are. Line and point hazards are not areas and are never
 * subject to this.
 */
export const SLIVER_M = 0.5

/**
 * How far a leg's least clearance is measured, metres.
 *
 * `minClearanceM` on a leg is exact up to this distance (or twice the
 * stand-off, whichever is larger); with nothing charted that close it is
 * reported as null — "nothing within a quarter of a kilometre" rather than an
 * invented number.
 */
export const CLEARANCE_MEASURE_M = 250

/** A flat local projection: metres east and north of (`lat0`, `lon0`). */
export interface Projection {
  lat0: number
  lon0: number
  /** Metres per degree of latitude and of longitude, at the middle latitude. */
  mLat: number
  mLon: number
}

export function projectionFor(b: Bounds): Projection {
  const mpd = metersPerDegree((b.minLat + b.maxLat) / 2)
  return { lat0: b.minLat, lon0: b.minLon, mLat: mpd.lat, mLon: mpd.lon }
}

export function toXY(pr: Projection, p: { lat: number; lon: number }): { x: number; y: number } {
  return { x: (p.lon - pr.lon0) * pr.mLon, y: (p.lat - pr.lat0) * pr.mLat }
}

export function fromXY(pr: Projection, x: number, y: number): { lat: number; lon: number } {
  return { lat: pr.lat0 + y / pr.mLat, lon: pr.lon0 + x / pr.mLon }
}

/**
 * The chart's answer about one point, as a single number.
 *
 * - a finite number: charted depth, metres below chart datum (negative dries);
 * - `LAND` (−∞): land, or a structure the chart draws as land;
 * - `NaN`: no chart covers the point — water nobody surveyed.
 *
 * One number rather than an object because it is computed hundreds of
 * thousands of times per plan, and because it makes "is this deep enough?" a
 * single comparison that is false for both land and unsurveyed water.
 */
export const LAND = -Infinity

export function isLandState(s: number): boolean {
  return s === LAND
}

export function isUnsurveyedState(s: number): boolean {
  return Number.isNaN(s)
}

function sameState(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b))
}

/* -------------------------------------------------------------------------
 * Segment arithmetic
 * ---------------------------------------------------------------------- */

/** Twice the signed area of (a, b, c): > 0 when c is left of a→b. */
function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

/** Squared distance from point p to segment a–b. */
export function pointSegDist2(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const qx = ax + t * dx - px
  const qy = ay + t * dy - py
  return qx * qx + qy * qy
}

/** Do segments a–b and c–d touch or cross? */
export function segmentsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = orient(cx, cy, dx, dy, ax, ay)
  const d2 = orient(cx, cy, dx, dy, bx, by)
  const d3 = orient(ax, ay, bx, by, cx, cy)
  const d4 = orient(ax, ay, bx, by, dx, dy)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true
  }
  // Touching or collinear: fall back to distances, which handle every
  // degenerate case the orientation test does not.
  if (d1 === 0 && pointSegDist2(ax, ay, cx, cy, dx, dy) === 0) return true
  if (d2 === 0 && pointSegDist2(bx, by, cx, cy, dx, dy) === 0) return true
  if (d3 === 0 && pointSegDist2(cx, cy, ax, ay, bx, by) === 0) return true
  if (d4 === 0 && pointSegDist2(dx, dy, ax, ay, bx, by) === 0) return true
  return false
}

/** Squared distance between segments a–b and c–d; 0 when they cross. */
export function segSegDist2(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0
  return Math.min(
    pointSegDist2(ax, ay, cx, cy, dx, dy),
    pointSegDist2(bx, by, cx, cy, dx, dy),
    pointSegDist2(cx, cy, ax, ay, bx, by),
    pointSegDist2(dx, dy, ax, ay, bx, by),
  )
}

/**
 * Distance from segment a–b to the axis-aligned rectangle [x0,x1]×[y0,y1].
 *
 * Exact: the least distance between two convex shapes is always between a
 * vertex of one and the boundary of the other, so the segment's endpoints
 * against the rectangle and the rectangle's corners against the segment
 * cover every case once crossing is ruled out.
 */
export function segRectDist(
  ax: number, ay: number, bx: number, by: number,
  x0: number, y0: number, x1: number, y1: number,
): number {
  const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1
  if (inside(ax, ay) || inside(bx, by)) return 0
  if (
    segmentsIntersect(ax, ay, bx, by, x0, y0, x1, y0) ||
    segmentsIntersect(ax, ay, bx, by, x1, y0, x1, y1) ||
    segmentsIntersect(ax, ay, bx, by, x1, y1, x0, y1) ||
    segmentsIntersect(ax, ay, bx, by, x0, y1, x0, y0)
  ) {
    return 0
  }
  const pr = (x: number, y: number) => {
    const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0
    const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0
    return dx * dx + dy * dy
  }
  return Math.sqrt(
    Math.min(
      pr(ax, ay),
      pr(bx, by),
      pointSegDist2(x0, y0, ax, ay, bx, by),
      pointSegDist2(x1, y0, ax, ay, bx, by),
      pointSegDist2(x1, y1, ax, ay, bx, by),
      pointSegDist2(x0, y1, ax, ay, bx, by),
    ),
  )
}

/**
 * Every unit cell a segment passes through — a supercover walk.
 *
 * Coordinates are in cell units, cell (i, j) covering [i, i+1) × [j, j+1).
 * Where the segment passes exactly through a cell corner, both cells beside
 * the corner are visited as well as the diagonal one: a line through the
 * corner where two blocked cells meet has touched both of them, and a walk
 * that visited neither would call the gap open. Cells outside [0, nx) × [0,
 * ny) are skipped but the walk carries on through them.
 *
 * `visit` returning `false` stops the walk early; the function then returns
 * false.
 */
export function traverseCells(
  x0: number, y0: number, x1: number, y1: number,
  nx: number, ny: number,
  visit: (cx: number, cy: number) => boolean | void,
): boolean {
  let cx = Math.floor(x0)
  let cy = Math.floor(y0)
  const ex = Math.floor(x1)
  const ey = Math.floor(y1)
  const dx = x1 - x0
  const dy = y1 - y0
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0
  const tDeltaX = stepX !== 0 ? 1 / Math.abs(dx) : Infinity
  const tDeltaY = stepY !== 0 ? 1 / Math.abs(dy) : Infinity
  let tMaxX = stepX > 0 ? (cx + 1 - x0) / dx : stepX < 0 ? (x0 - cx) / -dx : Infinity
  let tMaxY = stepY > 0 ? (cy + 1 - y0) / dy : stepY < 0 ? (y0 - cy) / -dy : Infinity

  const at = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return true
    return visit(i, j) !== false
  }

  if (!at(cx, cy)) return false
  // A hard cap on steps: the exact count is |ex−cx| + |ey−cy| plus corner
  // extras, and a float edge case must never turn this into an endless loop.
  let guard = Math.abs(ex - cx) + Math.abs(ey - cy) + 4
  while ((cx !== ex || cy !== ey) && guard-- > 0) {
    const tie = Math.abs(tMaxX - tMaxY) <= 1e-12 * Math.max(1, Math.abs(tMaxX))
    if (tie) {
      if (Math.min(tMaxX, tMaxY) > 1) break
      // Exactly through a corner: both shoulders were touched.
      if (!at(cx + stepX, cy)) return false
      if (!at(cx, cy + stepY)) return false
      cx += stepX
      cy += stepY
      tMaxX += tDeltaX
      tMaxY += tDeltaY
    } else if (tMaxX < tMaxY) {
      if (tMaxX > 1) break
      cx += stepX
      tMaxX += tDeltaX
    } else {
      if (tMaxY > 1) break
      cy += stepY
      tMaxY += tDeltaY
    }
    if (!at(cx, cy)) return false
  }
  return true
}

/**
 * One 1-D pass of the distance transform: the lower envelope of the parabolas
 * rooted at each sample of `line`, evaluated into `d`. Top-level and
 * monomorphic because it runs once per row and column of every grid.
 */
function edtPass(
  line: Float64Array, len: number, d: Float64Array, v: Int32Array, z: Float64Array, big: number,
): void {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  let vk = 0
  let fvk = line[0]
  for (let q = 1; q < len; q++) {
    const fq = line[q]
    if (fq >= big && fvk >= big) continue
    const qq = fq + q * q
    let s = (qq - (fvk + vk * vk)) / (2 * (q - vk))
    while (s <= z[k]) {
      k--
      vk = v[k]
      fvk = line[vk]
      s = (qq - (fvk + vk * vk)) / (2 * (q - vk))
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
    vk = q
    fvk = fq
  }
  k = 0
  for (let q = 0; q < len; q++) {
    while (z[k + 1] < q) k++
    const p = v[k]
    const dq = q - p
    d[q] = dq * dq + line[p]
  }
}

/**
 * Exact Euclidean distance transform, in cells, from every cell to the
 * nearest source cell's centre (Felzenszwalb & Huttenlocher, two separable
 * passes of the lower envelope of parabolas — linear time). `source` is a
 * mask: non-zero marks a source. Infinity where there is no source at all.
 *
 * `outsideIsSource` makes the world beyond the grid a source, which is what
 * the stand-off wants: a route that leaves the box is a route through water
 * nobody looked at. It is done with one virtual source on each end of every
 * 1-D pass rather than by copying the grid into a padded one.
 */
export function distanceTransform(
  cols: number,
  rows: number,
  source: Uint8Array,
  outsideIsSource: boolean,
  out: Float32Array,
): void {
  const BIG = 1e20
  const pad = outsideIsSource ? 1 : 0
  const f = new Float64Array(cols * rows)
  const n = Math.max(cols, rows) + 2
  const line = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  // Columns.
  const lenC = rows + 2 * pad
  for (let c = 0; c < cols; c++) {
    if (pad) {
      line[0] = 0
      line[lenC - 1] = 0
    }
    for (let r = 0, i = c; r < rows; r++, i += cols) line[r + pad] = source[i] !== 0 ? 0 : BIG
    edtPass(line, lenC, d, v, z, BIG)
    for (let r = 0, i = c; r < rows; r++, i += cols) f[i] = d[r + pad]
  }
  // Rows.
  const lenR = cols + 2 * pad
  for (let r = 0; r < rows; r++) {
    const base = r * cols
    if (pad) {
      line[0] = 0
      line[lenR - 1] = 0
    }
    for (let c = 0; c < cols; c++) line[c + pad] = f[base + c]
    edtPass(line, lenR, d, v, z, BIG)
    for (let c = 0; c < cols; c++) {
      const val = d[c + pad]
      out[base + c] = val >= BIG / 2 ? Infinity : Math.sqrt(val)
    }
  }
}

/* -------------------------------------------------------------------------
 * Clipping
 * ---------------------------------------------------------------------- */

/**
 * Clip a ring (flat [x0, y0, x1, y1, …], implicitly closed) to a rectangle.
 *
 * Sutherland–Hodgman, one half-plane at a time. For a concave ring the output
 * may run back and forth along the rectangle's edge, but the region it
 * encloses is exactly ring ∩ rectangle, and even-odd containment of any point
 * strictly inside the rectangle is unchanged — which is all the index needs.
 * Clipping is what lets a coastal land polygon a thousand kilometres around
 * cost only the part of it in this box.
 */
export function clipRing(
  xy: number[],
  x0: number, y0: number, x1: number, y1: number,
): number[] {
  let pts = xy
  const clip = (inside: (x: number, y: number) => boolean, cut: (ax: number, ay: number, bx: number, by: number) => [number, number]) => {
    const out: number[] = []
    const n = pts.length / 2
    if (n === 0) return out
    let px = pts[2 * n - 2]
    let py = pts[2 * n - 1]
    let pIn = inside(px, py)
    for (let i = 0; i < n; i++) {
      const cx = pts[2 * i]
      const cy = pts[2 * i + 1]
      const cIn = inside(cx, cy)
      if (cIn) {
        if (!pIn) out.push(...cut(px, py, cx, cy))
        out.push(cx, cy)
      } else if (pIn) {
        out.push(...cut(px, py, cx, cy))
      }
      px = cx
      py = cy
      pIn = cIn
    }
    return out
  }
  const atX = (x: number) => (ax: number, ay: number, bx: number, by: number): [number, number] => [
    x,
    ay + ((x - ax) * (by - ay)) / (bx - ax),
  ]
  const atY = (y: number) => (ax: number, ay: number, bx: number, by: number): [number, number] => [
    ax + ((y - ay) * (bx - ax)) / (by - ay),
    y,
  ]
  pts = clip((x) => x >= x0, atX(x0))
  pts = clip((x) => x <= x1, atX(x1))
  pts = clip((_x, y) => y >= y0, atY(y0))
  pts = clip((_x, y) => y <= y1, atY(y1))
  return pts
}

/* -------------------------------------------------------------------------
 * Buckets — a uniform spatial index, compressed-row storage
 * ---------------------------------------------------------------------- */

interface Buckets {
  start: Int32Array
  items: Int32Array
}

/**
 * Put `n` items into the buckets their boxes overlap.
 *
 * Two passes, count then fill, into one flat array — the same layout as a
 * sparse matrix. Hundreds of thousands of small arrays would cost more in
 * garbage than the whole plan costs in arithmetic.
 */
function bucketise(
  ix: { bx0: number; by0: number; bSize: number; bnx: number; bny: number },
  n: number,
  boxOf: (i: number, out: Float64Array) => boolean,
): Buckets {
  const { bx0, by0, bSize, bnx, bny } = ix
  const nb = bnx * bny
  const count = new Int32Array(nb + 1)
  const box = new Float64Array(4)
  const ranges = new Int32Array(n * 4)
  const pad = 1e-6
  for (let i = 0; i < n; i++) {
    if (!boxOf(i, box)) {
      ranges[i * 4] = 1
      ranges[i * 4 + 1] = 0
      continue
    }
    const c0 = Math.max(0, Math.floor((box[0] - pad - bx0) / bSize))
    const c1 = Math.min(bnx - 1, Math.floor((box[2] + pad - bx0) / bSize))
    const r0 = Math.max(0, Math.floor((box[1] - pad - by0) / bSize))
    const r1 = Math.min(bny - 1, Math.floor((box[3] + pad - by0) / bSize))
    ranges[i * 4] = c0
    ranges[i * 4 + 1] = c1
    ranges[i * 4 + 2] = r0
    ranges[i * 4 + 3] = r1
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) count[r * bnx + c + 1]++
    }
  }
  for (let b = 0; b < nb; b++) count[b + 1] += count[b]
  const items = new Int32Array(count[nb])
  const fill = count.slice(0, nb)
  for (let i = 0; i < n; i++) {
    const c0 = ranges[i * 4]
    const c1 = ranges[i * 4 + 1]
    const r0 = ranges[i * 4 + 2]
    const r1 = ranges[i * 4 + 3]
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) items[fill[r * bnx + c]++] = i
    }
  }
  return { start: count, items }
}

/* -------------------------------------------------------------------------
 * The index
 * ---------------------------------------------------------------------- */

export interface ChartIndex {
  /** The area this index covers, as asked. */
  bounds: Bounds
  proj: Projection
  /** The clip rectangle, metres. Beyond it everything reads as unsurveyed. */
  x0: number
  y0: number
  x1: number
  y1: number

  /* Depth and land polygons (area hazards are kept apart, below). */
  nPoly: number
  polyLevel: Int16Array
  /** Charted depth, or LAND. */
  polyValue: Float64Array

  /* Their edges, four numbers each: x1, y1, x2, y2. */
  nEdge: number
  ex: Float64Array
  ePoly: Int32Array

  /* The bucket grid, and what is in each bucket. */
  bx0: number
  by0: number
  bSize: number
  bnx: number
  bny: number
  edgeB: Buckets
  /** The polygons containing each bucket's reference point. */
  refB: Buckets

  /* The effective boundary: pieces of edge with a different state each side. */
  nPiece: number
  px: Float64Array
  /** State on the left of the piece (walking x1,y1 → x2,y2), and on its right. */
  pLeft: Float64Array
  pRight: Float64Array
  pieceB: Buckets
  /** Pieces with land on exactly one side — the coastline as the boat sees it. */
  landB: Buckets

  /* Hazards: points (x, y, r) and segments (x1, y1, x2, y2, halfWidth). */
  nHazPt: number
  hp: Float64Array
  nHazSeg: number
  hs: Float64Array
  /** Area hazards: rings in metres, for "is this point inside one?". */
  hazAreas: { rings: Float64Array[]; box: [number, number, number, number] }[]
  hazB: Buckets

  /* Scratch, reused by every query so a plan allocates nothing per call. */
  parity: Uint8Array
  polyStamp: Uint32Array
  touched: Int32Array
  eStamp: Uint32Array
  pStamp: Uint32Array
  hStamp: Uint32Array
  stamp: number
}

/** Where in its bucket the reference point sits — anywhere not special. */
const REF_FX = 0.3183098861837907
const REF_FY = 0.2718281828459045

/** How far to either side of a boundary its two states are sampled, metres. */
const SIDE_M = SLIVER_M

/** Distance within which an edge's endpoint counts as lying on another edge. */
const T_JUNCTION_M = 0.05

function nextStamp(ix: ChartIndex): number {
  ix.stamp++
  if (ix.stamp >= 0xfffffff0) {
    ix.stamp = 1
    ix.polyStamp.fill(0)
    ix.eStamp.fill(0)
    ix.pStamp.fill(0)
    ix.hStamp.fill(0)
  }
  return ix.stamp
}

/**
 * Index a chart for one area.
 *
 * Costs a few hundred milliseconds for a detailed harbour and is the same for
 * every boat, so `chartIndexFor` below caches it against the features object
 * — a re-route or an edit to the boat reuses it.
 */
export function buildChartIndex(features: ChartFeatures, bounds: Bounds): ChartIndex {
  const proj = projectionFor(bounds)
  const x0 = 0
  const y0 = 0
  const x1 = (bounds.maxLon - bounds.minLon) * proj.mLon
  const y1 = (bounds.maxLat - bounds.minLat) * proj.mLat
  const W = Math.max(1, x1 - x0)
  const H = Math.max(1, y1 - y0)

  // Buckets of roughly 150 000 over the box, never smaller than 40 m: small
  // enough that a point-in-polygon test looks at tens of edges, not
  // thousands; large enough that the tables stay a few megabytes.
  const bSize = Math.max(40, Math.sqrt((W * H) / 150_000))
  // One bucket of slack all round, so the clip rectangle's own edges lie
  // strictly inside the bucket grid.
  const bx0 = x0 - bSize
  const by0 = y0 - bSize
  const bnx = Math.ceil(W / bSize) + 2
  const bny = Math.ceil(H / bSize) + 2

  // ---- Polygons: project, clip, flatten into edges ------------------------
  const polyLevel: number[] = []
  const polyValue: number[] = []
  const edges: number[] = []
  const ePoly: number[] = []
  const projRing = (ring: [number, number][]): number[] => {
    const out: number[] = []
    const n = ring.length
    // GeoJSON closes rings by repeating the first vertex; the clip and the
    // edges below close them implicitly, so drop the repeat.
    const last = n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1] ? n - 1 : n
    for (let i = 0; i < last; i++) {
      const lon = ring[i][0]
      const lat = ring[i][1]
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
      out.push((lon - proj.lon0) * proj.mLon, (lat - proj.lat0) * proj.mLat)
    }
    return out
  }
  const addPolygon = (rings: [number, number][][], value: number, level: number) => {
    const id = polyLevel.length
    let any = false
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 3) continue
      const clipped = clipRing(projRing(ring), x0, y0, x1, y1)
      const n = clipped.length / 2
      if (n < 3) continue
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        const ax = clipped[2 * i]
        const ay = clipped[2 * i + 1]
        const bx = clipped[2 * j]
        const by = clipped[2 * j + 1]
        if (ax === bx && ay === by) continue
        edges.push(ax, ay, bx, by)
        ePoly.push(id)
        any = true
      }
    }
    if (any) {
      polyLevel.push(level)
      polyValue.push(value)
    }
  }
  for (const p of features.depthAreas) {
    if (!Number.isFinite(p.minDepthM)) continue
    addPolygon(p.rings, p.minDepthM, p.level ?? 0)
  }
  const hazardAreaRings: [number, number][][][] = []
  for (const p of features.land) {
    if (p.hazard) {
      hazardAreaRings.push(p.rings)
      continue
    }
    addPolygon(p.rings, LAND, p.level ?? 0)
  }

  const nPoly = polyLevel.length
  const nEdge = ePoly.length
  const ex = Float64Array.from(edges)
  const ePolyArr = Int32Array.from(ePoly)
  const grid = { bx0, by0, bSize, bnx, bny }
  const edgeB = bucketise(grid, nEdge, (i, out) => {
    const o = i * 4
    out[0] = Math.min(ex[o], ex[o + 2])
    out[1] = Math.min(ex[o + 1], ex[o + 3])
    out[2] = Math.max(ex[o], ex[o + 2])
    out[3] = Math.max(ex[o + 1], ex[o + 3])
    return true
  })

  // ---- Reference points: which polygons contain each bucket's ref point ---
  // A horizontal scanline per bucket row, at the reference height, crossing
  // every edge of every polygon; the even-odd spans say which reference
  // points each polygon contains. Every later containment test starts from
  // one of these and only has to look at the edges in its own bucket.
  const refPairs: number[] = []
  {
    // Edges are stored polygon by polygon, so one polygon's edges are a run.
    let e = 0
    const rowsHit: number[] = []
    const xsHit: number[] = []
    while (e < nEdge) {
      const p = ePolyArr[e]
      rowsHit.length = 0
      xsHit.length = 0
      let f = e
      for (; f < nEdge && ePolyArr[f] === p; f++) {
        const o = f * 4
        const ay = ex[o + 1]
        const by = ex[o + 3]
        const lo = Math.min(ay, by)
        const hi = Math.max(ay, by)
        const r0 = Math.max(0, Math.ceil((lo - by0) / bSize - REF_FY))
        const r1 = Math.min(bny - 1, Math.floor((hi - by0) / bSize - REF_FY))
        for (let r = r0; r <= r1; r++) {
          const Y = by0 + (r + REF_FY) * bSize
          if (ay > Y === by > Y) continue
          const ax = ex[o]
          const bx = ex[o + 2]
          rowsHit.push(r)
          xsHit.push(ax + ((Y - ay) * (bx - ax)) / (by - ay))
        }
      }
      if (rowsHit.length > 0) {
        const order = rowsHit.map((_, k) => k)
        order.sort((a, b) => rowsHit[a] - rowsHit[b] || xsHit[a] - xsHit[b])
        let k = 0
        while (k < order.length) {
          const r = rowsHit[order[k]]
          let m = k
          while (m < order.length && rowsHit[order[m]] === r) m++
          for (let q = k; q + 1 < m; q += 2) {
            const xa = xsHit[order[q]]
            const xb = xsHit[order[q + 1]]
            const c0 = Math.max(0, Math.ceil((xa - bx0) / bSize - REF_FX))
            const c1 = Math.min(bnx - 1, Math.floor((xb - bx0) / bSize - REF_FX))
            for (let c = c0; c <= c1; c++) refPairs.push(r * bnx + c, p)
          }
          k = m
        }
      }
      e = f
    }
  }
  const nb = bnx * bny
  const refStart = new Int32Array(nb + 1)
  for (let k = 0; k < refPairs.length; k += 2) refStart[refPairs[k] + 1]++
  for (let b = 0; b < nb; b++) refStart[b + 1] += refStart[b]
  const refItems = new Int32Array(refStart[nb])
  {
    const fill = refStart.slice(0, nb)
    for (let k = 0; k < refPairs.length; k += 2) refItems[fill[refPairs[k]]++] = refPairs[k + 1]
  }

  // ---- Hazards ---------------------------------------------------------------
  const hp: number[] = []
  for (const h of features.hazards) {
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) continue
    const x = (h.lon - proj.lon0) * proj.mLon
    const y = (h.lat - proj.lat0) * proj.mLat
    const r = Math.max(0, Number.isFinite(h.radiusM) ? h.radiusM : 0)
    if (x < x0 - r || x > x1 + r || y < y0 - r || y > y1 + r) continue
    hp.push(x, y, r)
  }
  const hs: number[] = []
  for (const l of features.lines ?? []) {
    const hw = Math.max(0, (Number.isFinite(l.widthM) ? l.widthM : 0) / 2)
    for (const path of l.paths) {
      for (let i = 1; i < path.length; i++) {
        const [alon, alat] = path[i - 1]
        const [blon, blat] = path[i]
        if (![alon, alat, blon, blat].every(Number.isFinite)) continue
        const ax = (alon - proj.lon0) * proj.mLon
        const ay = (alat - proj.lat0) * proj.mLat
        const bx = (blon - proj.lon0) * proj.mLon
        const by = (blat - proj.lat0) * proj.mLat
        if (Math.max(ax, bx) < x0 - hw || Math.min(ax, bx) > x1 + hw) continue
        if (Math.max(ay, by) < y0 - hw || Math.min(ay, by) > y1 + hw) continue
        hs.push(ax, ay, bx, by, hw)
      }
    }
  }
  const hazAreas: ChartIndex['hazAreas'] = []
  for (const rings of hazardAreaRings) {
    const out: Float64Array[] = []
    let bx = Infinity
    let by = Infinity
    let tx = -Infinity
    let ty = -Infinity
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 3) continue
      const c = clipRing(projRing(ring), x0, y0, x1, y1)
      if (c.length < 6) continue
      const arr = Float64Array.from(c)
      out.push(arr)
      for (let i = 0; i < arr.length; i += 2) {
        bx = Math.min(bx, arr[i])
        tx = Math.max(tx, arr[i])
        by = Math.min(by, arr[i + 1])
        ty = Math.max(ty, arr[i + 1])
        // Each edge of an area hazard is also a zero-width line hazard: a leg
        // crossing into one crosses one of these.
        const j = (i + 2) % arr.length
        hs.push(arr[i], arr[i + 1], arr[j], arr[j + 1], 0)
      }
    }
    if (out.length > 0) hazAreas.push({ rings: out, box: [bx, by, tx, ty] })
  }
  const nHazPt = hp.length / 3
  const nHazSeg = hs.length / 5
  const hpArr = Float64Array.from(hp)
  const hsArr = Float64Array.from(hs)
  const hazB = bucketise(grid, nHazPt + nHazSeg, (i, out) => {
    if (i < nHazPt) {
      const r = hpArr[i * 3 + 2]
      out[0] = hpArr[i * 3] - r
      out[1] = hpArr[i * 3 + 1] - r
      out[2] = hpArr[i * 3] + r
      out[3] = hpArr[i * 3 + 1] + r
      return true
    }
    const o = (i - nHazPt) * 5
    const hw = hsArr[o + 4]
    out[0] = Math.min(hsArr[o], hsArr[o + 2]) - hw
    out[1] = Math.min(hsArr[o + 1], hsArr[o + 3]) - hw
    out[2] = Math.max(hsArr[o], hsArr[o + 2]) + hw
    out[3] = Math.max(hsArr[o + 1], hsArr[o + 3]) + hw
    return true
  })

  const ix: ChartIndex = {
    bounds,
    proj,
    x0,
    y0,
    x1,
    y1,
    nPoly,
    polyLevel: Int16Array.from(polyLevel),
    polyValue: Float64Array.from(polyValue),
    nEdge,
    ex,
    ePoly: ePolyArr,
    bx0,
    by0,
    bSize,
    bnx,
    bny,
    edgeB,
    refB: { start: refStart, items: refItems },
    nPiece: 0,
    px: new Float64Array(0),
    pLeft: new Float64Array(0),
    pRight: new Float64Array(0),
    pieceB: { start: new Int32Array(nb + 1), items: new Int32Array(0) },
    landB: { start: new Int32Array(nb + 1), items: new Int32Array(0) },
    nHazPt,
    hp: hpArr,
    nHazSeg,
    hs: hsArr,
    hazAreas,
    hazB,
    parity: new Uint8Array(nPoly),
    polyStamp: new Uint32Array(nPoly),
    touched: new Int32Array(nPoly),
    eStamp: new Uint32Array(nEdge),
    pStamp: new Uint32Array(0),
    hStamp: new Uint32Array(nHazPt + nHazSeg),
    stamp: 0,
  }

  buildEffectiveBoundary(ix)
  return ix
}

/**
 * The chart's state at a point: a depth, LAND, or NaN for unsurveyed.
 *
 * Finest chart wins: of the polygons containing the point, the ones from the
 * most detailed band decide, land over depth within that band (as `rasterise`
 * paints it), and the shoalest depth where two of that band's areas overlap.
 *
 * Containment starts from the bucket's reference point, whose containing
 * polygons are precomputed, and flips a polygon's parity for every one of its
 * edges crossing the short segment from there to the point. Only the edges in
 * this one bucket can cross it, so this is tens of tests, not thousands.
 */
export function stateAt(ix: ChartIndex, x: number, y: number): number {
  if (!(x > ix.x0 && x < ix.x1 && y > ix.y0 && y < ix.y1)) return NaN
  const { bx0, by0, bSize, bnx, bny } = ix
  let c = Math.floor((x - bx0) / bSize)
  let r = Math.floor((y - by0) / bSize)
  if (c < 0) c = 0
  else if (c >= bnx) c = bnx - 1
  if (r < 0) r = 0
  else if (r >= bny) r = bny - 1
  const b = r * bnx + c
  const rx = bx0 + (c + REF_FX) * bSize
  const ry = by0 + (r + REF_FY) * bSize

  const stamp = nextStamp(ix)
  const parity = ix.parity
  const polyStamp = ix.polyStamp
  const touched = ix.touched
  const ex = ix.ex
  const ePoly = ix.ePoly
  let nt = 0

  const refB = ix.refB
  const refItems = refB.items
  for (let k = refB.start[b], kEnd = refB.start[b + 1]; k < kEnd; k++) {
    const p = refItems[k]
    // Each polygon appears at most once per reference point.
    polyStamp[p] = stamp
    parity[p] = 1
    touched[nt++] = p
  }

  // Flip a polygon's parity for every one of its edges crossing the segment
  // from the reference point to (x, y).
  const dxr = x - rx
  const dyr = y - ry
  const eb = ix.edgeB
  const items = eb.items
  for (let k = eb.start[b], kEnd = eb.start[b + 1]; k < kEnd; k++) {
    const e = items[k]
    const o = e * 4
    const ax = ex[o]
    const ay = ex[o + 1]
    const bx = ex[o + 2]
    const by = ex[o + 3]
    // Does the edge straddle the line through ref and the point? Half-open,
    // so a vertex exactly on that line counts for one of its two edges.
    const s1 = dxr * (ay - ry) - dyr * (ax - rx) > 0
    const s2 = dxr * (by - ry) - dyr * (bx - rx) > 0
    if (s1 === s2) continue
    // And do ref and the point lie on opposite sides of the edge?
    const ux = bx - ax
    const uy = by - ay
    const q1 = ux * (ry - ay) - uy * (rx - ax) > 0
    const q2 = ux * (y - ay) - uy * (x - ax) > 0
    if (q1 === q2) continue
    const p = ePoly[e]
    if (polyStamp[p] !== stamp) {
      polyStamp[p] = stamp
      parity[p] = 1
      touched[nt++] = p
    } else {
      parity[p] ^= 1
    }
  }

  let bestLevel = -Infinity
  let land = false
  let depth = Infinity
  for (let k = 0; k < nt; k++) {
    const p = touched[k]
    if (!parity[p]) continue
    const lvl = ix.polyLevel[p]
    const v = ix.polyValue[p]
    if (lvl > bestLevel) {
      bestLevel = lvl
      land = v === LAND
      depth = v === LAND ? Infinity : v
    } else if (lvl === bestLevel) {
      if (v === LAND) land = true
      else if (v < depth) depth = v
    }
  }
  if (bestLevel === -Infinity) return NaN
  return land ? LAND : depth
}

/**
 * Work out, once, which pieces of which edges separate two different states.
 *
 * Every edge is split wherever another edge crosses it or ends on it — those
 * are the only places the state beside it can change — and each piece's two
 * sides are sampled half a metre out. Pieces with the same state both sides
 * (a seam between two harbour charts, a coarse chart's coastline under a
 * finer chart's water) are dropped; they do not exist as far as the boat is
 * concerned.
 */
function buildEffectiveBoundary(ix: ChartIndex): void {
  const { ex, nEdge } = ix
  const px: number[] = []
  const pl: number[] = []
  const pr: number[] = []
  const ts: number[] = []
  const eb = ix.edgeB
  const { bx0, by0, bSize, bnx, bny } = ix

  // Depth areas tile the sea, so nearly every edge is charted twice — once
  // by the area on each side of it, from the same vertices, so to the same
  // bits. The second copy separates exactly what the first does; skipping it
  // halves the work. Found by sorting the edges on their endpoints (numbers,
  // not strings: formatting floats into keys cost more than it saved).
  const canon = new Float64Array(nEdge * 4)
  for (let e = 0; e < nEdge; e++) {
    const o = e * 4
    const fwd = ex[o] < ex[o + 2] || (ex[o] === ex[o + 2] && ex[o + 1] <= ex[o + 3])
    canon[o] = fwd ? ex[o] : ex[o + 2]
    canon[o + 1] = fwd ? ex[o + 1] : ex[o + 3]
    canon[o + 2] = fwd ? ex[o + 2] : ex[o]
    canon[o + 3] = fwd ? ex[o + 3] : ex[o + 1]
  }
  const order = new Int32Array(nEdge)
  for (let e = 0; e < nEdge; e++) order[e] = e
  order.sort((a, b) => {
    const oa = a * 4
    const ob = b * 4
    return (
      canon[oa] - canon[ob] || canon[oa + 1] - canon[ob + 1] ||
      canon[oa + 2] - canon[ob + 2] || canon[oa + 3] - canon[ob + 3] || a - b
    )
  })
  const twin = new Uint8Array(nEdge)
  for (let k = 1; k < nEdge; k++) {
    const oa = order[k - 1] * 4
    const ob = order[k] * 4
    if (
      canon[oa] === canon[ob] && canon[oa + 1] === canon[ob + 1] &&
      canon[oa + 2] === canon[ob + 2] && canon[oa + 3] === canon[ob + 3]
    ) {
      twin[order[k]] = 1
    }
  }
  for (let e = 0; e < nEdge; e++) {
    if (twin[e]) continue
    const o = e * 4
    const ax = ex[o]
    const ay = ex[o + 1]
    const bx = ex[o + 2]
    const by = ex[o + 3]
    const rx = bx - ax
    const ry = by - ay
    const len2 = rx * rx + ry * ry
    if (len2 === 0) continue
    const len = Math.sqrt(len2)

    ts.length = 0
    ts.push(0, 1)
    const exMin = Math.min(ax, bx) - T_JUNCTION_M
    const exMax = Math.max(ax, bx) + T_JUNCTION_M
    const eyMin = Math.min(ay, by) - T_JUNCTION_M
    const eyMax = Math.max(ay, by) + T_JUNCTION_M
    const stamp = nextStamp(ix)
    ix.eStamp[e] = stamp
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - 1e-6 - bx0) / bSize))
    const c1 = Math.min(bnx - 1, Math.floor((Math.max(ax, bx) + 1e-6 - bx0) / bSize))
    const r0 = Math.max(0, Math.floor((Math.min(ay, by) - 1e-6 - by0) / bSize))
    const r1 = Math.min(bny - 1, Math.floor((Math.max(ay, by) + 1e-6 - by0) / bSize))
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const b = r * bnx + c
        for (let k = eb.start[b]; k < eb.start[b + 1]; k++) {
          const f = eb.items[k]
          if (ix.eStamp[f] === stamp) continue
          ix.eStamp[f] = stamp
          const q = f * 4
          const cx = ex[q]
          const cy = ex[q + 1]
          const dx = ex[q + 2]
          const dy = ex[q + 3]
          // Boxes apart: nothing to cross or end on this edge.
          if (
            (cx < exMin && dx < exMin) || (cx > exMax && dx > exMax) ||
            (cy < eyMin && dy < eyMin) || (cy > eyMax && dy > eyMax)
          ) {
            continue
          }
          const sx = dx - cx
          const sy = dy - cy
          const den = rx * sy - ry * sx
          if (Math.abs(den) > 1e-12 * len * Math.sqrt(sx * sx + sy * sy)) {
            const t = ((cx - ax) * sy - (cy - ay) * sx) / den
            const u = ((cx - ax) * ry - (cy - ay) * rx) / den
            if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t)
          }
          // Another edge ending on this one — a T-junction, or a collinear
          // run along a seam — changes the state beside it there too.
          for (let end = 0; end < 2; end++) {
            const qx = end === 0 ? cx : dx
            const qy = end === 0 ? cy : dy
            const t = ((qx - ax) * rx + (qy - ay) * ry) / len2
            if (t <= 0 || t >= 1) continue
            const hx = ax + t * rx - qx
            const hy = ay + t * ry - qy
            if (hx * hx + hy * hy <= T_JUNCTION_M * T_JUNCTION_M) ts.push(t)
          }
        }
      }
    }
    if (ts.length > 2) ts.sort((a, b) => a - b)
    // Left normal of the edge.
    const nx = -ry / len
    const ny = rx / len
    let prevLeft = NaN
    let prevRight = NaN
    let open = false
    for (let k = 0; k + 1 < ts.length; k++) {
      const ta = ts[k]
      const tb = ts[k + 1]
      if ((tb - ta) * len < 1e-3) continue
      const tm = (ta + tb) / 2
      const mx = ax + tm * rx
      const my = ay + tm * ry
      const sl = stateAt(ix, mx + nx * SIDE_M, my + ny * SIDE_M)
      const sr = stateAt(ix, mx - nx * SIDE_M, my - ny * SIDE_M)
      if (sameState(sl, sr)) {
        open = false
        continue
      }
      const sxA = ax + ta * rx
      const syA = ay + ta * ry
      const sxB = ax + tb * rx
      const syB = ay + tb * ry
      // Consecutive pieces with the same two states are one piece: fewer
      // pieces, fewer crossings to split a leg at.
      if (open && sameState(sl, prevLeft) && sameState(sr, prevRight)) {
        const last = px.length - 4
        px[last + 2] = sxB
        px[last + 3] = syB
        continue
      }
      px.push(sxA, syA, sxB, syB)
      pl.push(sl)
      pr.push(sr)
      prevLeft = sl
      prevRight = sr
      open = true
    }
  }

  ix.nPiece = pl.length
  ix.px = Float64Array.from(px)
  ix.pLeft = Float64Array.from(pl)
  ix.pRight = Float64Array.from(pr)
  ix.pStamp = new Uint32Array(ix.nPiece)
  const grid = { bx0, by0, bSize, bnx, bny }
  const P = ix.px
  const pieceBox = (i: number, out: Float64Array) => {
    const o = i * 4
    out[0] = Math.min(P[o], P[o + 2])
    out[1] = Math.min(P[o + 1], P[o + 3])
    out[2] = Math.max(P[o], P[o + 2])
    out[3] = Math.max(P[o + 1], P[o + 3])
    return true
  }
  ix.pieceB = bucketise(grid, ix.nPiece, pieceBox)
  ix.landB = bucketise(grid, ix.nPiece, (i, out) => {
    const l = ix.pLeft[i] === LAND
    const r = ix.pRight[i] === LAND
    if (l === r) return false
    return pieceBox(i, out)
  })
}

/**
 * Every effective-boundary piece whose box overlaps the rectangle, once each.
 * `fn` gets the piece's endpoints and its left and right states.
 */
export function forEachPieceIn(
  ix: ChartIndex,
  x0: number, y0: number, x1: number, y1: number,
  fn: (ax: number, ay: number, bx: number, by: number, left: number, right: number) => void,
): void {
  const { bx0, by0, bSize, bnx, bny } = ix
  const c0 = Math.max(0, Math.floor((x0 - bx0) / bSize))
  const c1 = Math.min(bnx - 1, Math.floor((x1 - bx0) / bSize))
  const r0 = Math.max(0, Math.floor((y0 - by0) / bSize))
  const r1 = Math.min(bny - 1, Math.floor((y1 - by0) / bSize))
  const stamp = nextStamp(ix)
  const pb = ix.pieceB
  const P = ix.px
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const b = r * bnx + c
      for (let k = pb.start[b]; k < pb.start[b + 1]; k++) {
        const p = pb.items[k]
        if (ix.pStamp[p] === stamp) continue
        ix.pStamp[p] = stamp
        const o = p * 4
        fn(P[o], P[o + 1], P[o + 2], P[o + 3], ix.pLeft[p], ix.pRight[p])
      }
    }
  }
}

/**
 * Every hazard whose footprint box overlaps the rectangle, once each: points
 * as (x, y, r) and segments as (x1, y1, x2, y2, halfWidth).
 */
export function forEachHazardIn(
  ix: ChartIndex,
  x0: number, y0: number, x1: number, y1: number,
  point: (x: number, y: number, r: number) => void,
  segment: (ax: number, ay: number, bx: number, by: number, hw: number) => void,
): void {
  const { bx0, by0, bSize, bnx, bny } = ix
  const c0 = Math.max(0, Math.floor((x0 - bx0) / bSize))
  const c1 = Math.min(bnx - 1, Math.floor((x1 - bx0) / bSize))
  const r0 = Math.max(0, Math.floor((y0 - by0) / bSize))
  const r1 = Math.min(bny - 1, Math.floor((y1 - by0) / bSize))
  const stamp = nextStamp(ix)
  const hb = ix.hazB
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const b = r * bnx + c
      for (let k = hb.start[b]; k < hb.start[b + 1]; k++) {
        const h = hb.items[k]
        if (ix.hStamp[h] === stamp) continue
        ix.hStamp[h] = stamp
        if (h < ix.nHazPt) {
          const o = h * 3
          point(ix.hp[o], ix.hp[o + 1], ix.hp[o + 2])
        } else {
          const o = (h - ix.nHazPt) * 5
          segment(ix.hs[o], ix.hs[o + 1], ix.hs[o + 2], ix.hs[o + 3], ix.hs[o + 4])
        }
      }
    }
  }
}

/** Is the point inside an area hazard? */
export function inHazardArea(ix: ChartIndex, x: number, y: number): boolean {
  for (const a of ix.hazAreas) {
    const [bx, by, tx, ty] = a.box
    if (x < bx || x > tx || y < by || y > ty) continue
    let inside = false
    for (const ring of a.rings) {
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

/**
 * Least distance from segment a–b to a hazard footprint, metres — negative
 * when the segment enters one (by how far, for a point or a line; −0 for an
 * area). Only hazards within `radius` are looked at; Infinity when none is.
 */
export function hazardDistance(
  ix: ChartIndex, ax: number, ay: number, bx: number, by: number, radius: number,
): number {
  let best = Infinity
  if (ix.hazAreas.length > 0 && (inHazardArea(ix, ax, ay) || inHazardArea(ix, bx, by))) {
    best = -1e-9
  }
  const stamp = nextStamp(ix)
  const R = radius
  forBucketsNear(ix, ax, ay, bx, by, R + maxHazardReach(ix), (b) => {
    const hb = ix.hazB
    for (let k = hb.start[b]; k < hb.start[b + 1]; k++) {
      const h = hb.items[k]
      if (ix.hStamp[h] === stamp) continue
      ix.hStamp[h] = stamp
      let d: number
      if (h < ix.nHazPt) {
        const o = h * 3
        d = Math.sqrt(pointSegDist2(ix.hp[o], ix.hp[o + 1], ax, ay, bx, by)) - ix.hp[o + 2]
      } else {
        const o = (h - ix.nHazPt) * 5
        const hw = ix.hs[o + 4]
        const d2 = segSegDist2(ax, ay, bx, by, ix.hs[o], ix.hs[o + 1], ix.hs[o + 2], ix.hs[o + 3])
        // A zero-width edge of an area hazard that the leg touches is a leg
        // entering the area.
        d = hw === 0 && d2 === 0 ? -1e-9 : Math.sqrt(d2) - hw
      }
      if (d < best) best = d
    }
  })
  return best
}

function maxHazardReach(ix: ChartIndex): number {
  // The buckets hold each hazard under its whole footprint's box, so a query
  // only has to widen by its own radius. Kept as a function in case that
  // ever changes.
  void ix
  return 0
}

/**
 * Least distance from segment a–b to land as the boat sees it — the pieces of
 * effective boundary with land on one side — within `radius`, metres.
 * Infinity when there is none that close. (Entering land is the depth
 * check's business; this is the stand-off.)
 */
export function landDistance(
  ix: ChartIndex, ax: number, ay: number, bx: number, by: number, radius: number,
): number {
  let best2 = Infinity
  const stamp = nextStamp(ix)
  const P = ix.px
  const lb = ix.landB
  forBucketsNear(ix, ax, ay, bx, by, radius, (b) => {
    for (let k = lb.start[b]; k < lb.start[b + 1]; k++) {
      const p = lb.items[k]
      if (ix.pStamp[p] === stamp) continue
      ix.pStamp[p] = stamp
      const o = p * 4
      const d2 = segSegDist2(ax, ay, bx, by, P[o], P[o + 1], P[o + 2], P[o + 3])
      if (d2 < best2) best2 = d2
    }
  })
  const d = Math.sqrt(best2)
  return d <= radius ? d : Infinity
}

/**
 * Call `fn` for every bucket within `radius` of segment a–b.
 *
 * Walks the segment's bounding box widened by the radius but skips buckets
 * whose rectangle is further than that from the segment itself, so a long
 * diagonal leg does not pay for the whole square around it.
 */
function forBucketsNear(
  ix: ChartIndex, ax: number, ay: number, bx: number, by: number, radius: number,
  fn: (b: number) => void,
): void {
  const { bx0, by0, bSize, bnx, bny } = ix
  const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - radius - bx0) / bSize))
  const c1 = Math.min(bnx - 1, Math.floor((Math.max(ax, bx) + radius - bx0) / bSize))
  const r0 = Math.max(0, Math.floor((Math.min(ay, by) - radius - by0) / bSize))
  const r1 = Math.min(bny - 1, Math.floor((Math.max(ay, by) + radius - by0) / bSize))
  const small = (c1 - c0 + 1) * (r1 - r0 + 1) <= 9
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!small) {
        const qx = bx0 + c * bSize
        const qy = by0 + r * bSize
        if (segRectDist(ax, ay, bx, by, qx, qy, qx + bSize, qy + bSize) > radius) continue
      }
      fn(r * bnx + c)
    }
  }
}

/* -------------------------------------------------------------------------
 * Checking a segment
 * ---------------------------------------------------------------------- */

/** A disc near an endpoint where the approach rules apply, metres. */
export interface Zone {
  x: number
  y: number
  r: number
}

export interface SegmentCheckOptions {
  /** Draft + under-keel margin, metres. */
  safeDepthM: number
  /** The stand-off the segment must keep from land and hazards, metres. */
  clearanceM: number
  /** Approach zones: inside them shallow/unsurveyed water and a smaller
   * stand-off are allowed (land and hazard footprints never are). */
  zones: Zone[]
  /**
   * Lateral depth margin, metres: outside the zones and outside a marked
   * channel, water charted shallower than `safeDepthM` may not lie within
   * this distance of the leg. 0 or absent turns the test off. See
   * `depthMarginFor` in routing.ts for why it exists.
   */
  depthMarginM?: number
  /** Is this point inside a charted dredged area or fairway? */
  inChannel?: (x: number, y: number) => boolean
}

export interface SegmentCheck {
  /** Keeps the depth and the stand-off, with the approach allowance. */
  ok: boolean
  /** No land, and no shallow or unsurveyed water outside the approach zones. */
  depthOk: boolean
  /** Keeps the stand-off outside the zones and enters no hazard footprint. */
  clearanceOk: boolean
  /** Enters land (or a structure charted as land) anywhere. */
  crossesLand: boolean
  /** Enters a wreck, obstruction, pile, pylon or other hazard footprint. */
  entersHazard: boolean
  /** Relied on the approach allowance somewhere. */
  usedApproach: boolean
  /** Relied on it for DEPTH: shallow or unsurveyed water inside a zone. */
  approachDepth: boolean
  /** Relied on it for the STAND-OFF: closer to land or a hazard inside a zone. */
  approachClearance: boolean
  /**
   * Water charted shallower than the boat needs lies within the lateral
   * depth margin of the leg (outside the zones and any marked channel).
   */
  nearShoal: boolean
  /** The shoalest such water, metres, or null. */
  nearShoalDepthM: number | null
  /** How far from the leg it lies, metres, or null. */
  nearShoalDistM: number | null
  /** Shallower-than-safe water outside the zones. */
  shallow: boolean
  /** Unsurveyed water outside the zones. */
  unsurveyed: boolean
  /** Shoalest charted depth along the segment (land counts as 0), or null. */
  minDepthM: number | null
  /** Shoalest charted depth outside the zones, or null. */
  minDepthOutsideM: number | null
  /** Least distance to land or a hazard footprint, or null if none within
   * the measuring distance. */
  minClearanceM: number | null
  /** Least clearance outside the zones (Infinity when none within range). */
  clearanceOutsideM: number
}

function inAnyZone(zones: Zone[], x: number, y: number): boolean {
  for (const z of zones) {
    const dx = x - z.x
    const dy = y - z.y
    if (dx * dx + dy * dy <= z.r * z.r) return true
  }
  return false
}

/** Parameters in (0, 1) where segment a–b crosses the circle. */
function circleParams(ax: number, ay: number, bx: number, by: number, z: Zone, out: number[]): void {
  const dx = bx - ax
  const dy = by - ay
  const fx = ax - z.x
  const fy = ay - z.y
  const A = dx * dx + dy * dy
  if (A === 0) return
  const B = 2 * (fx * dx + fy * dy)
  const C = fx * fx + fy * fy - z.r * z.r
  const disc = B * B - 4 * A * C
  if (disc <= 0) return
  const s = Math.sqrt(disc)
  const t1 = (-B - s) / (2 * A)
  const t2 = (-B + s) / (2 * A)
  if (t1 > 0 && t1 < 1) out.push(t1)
  if (t2 > 0 && t2 < 1) out.push(t2)
}

/** How bad a state is, for choosing among disagreeing samples. */
function badness(s: number): number {
  if (s === LAND) return Infinity
  if (Number.isNaN(s)) return 1e9
  return -s
}

/**
 * The chart's state along one piece of a leg between two boundary crossings.
 *
 * The state is constant along such a piece as far as the effective boundary
 * is concerned — but a sub-`SLIVER_M` seam gap the boundary deliberately
 * ignores can still sit exactly under the one point sampled. So a piece long
 * enough is sampled three times, `1.5 × SLIVER_M` apart, and the majority
 * decides: a sliver can catch one sample, never two. Three different answers
 * cannot happen without a boundary between them; if they somehow do, the
 * worst is taken.
 */
function intervalState(
  ix: ChartIndex, ax: number, ay: number, rx: number, ry: number, len: number, ta: number, tb: number,
): number {
  const tm = (ta + tb) / 2
  const s1 = stateAt(ix, ax + tm * rx, ay + tm * ry)
  if ((tb - ta) * len < 4 * SLIVER_M) return s1
  const d = (1.5 * SLIVER_M) / len
  const s0 = stateAt(ix, ax + (tm - d) * rx, ay + (tm - d) * ry)
  if (sameState(s0, s1)) return s1
  const s2 = stateAt(ix, ax + (tm + d) * rx, ay + (tm + d) * ry)
  if (sameState(s1, s2)) return s1
  if (sameState(s0, s2)) return s0
  return [s0, s1, s2].reduce((w, s) => (badness(s) > badness(w) ? s : w))
}

/**
 * Water charted shallower than `safeDepthM` within `margin` of segment s–e,
 * judged from the effective boundary: the track itself is in deep enough
 * water, so shallow water within the margin means a boundary piece with a
 * shallow side lies within it. Land is the stand-off's business and
 * unsurveyed water the depth check's, so only charted depths count. A piece
 * whose nearest point on the track lies inside a marked channel is skipped —
 * a dredged cut is shallow bank either side by design.
 */
function shoalBeside(
  ix: ChartIndex,
  sx: number, sy: number, ex: number, ey: number,
  margin: number,
  safeDepthM: number,
  inChannel: ((x: number, y: number) => boolean) | undefined,
): { depthM: number; distM: number } | null {
  let best: { depthM: number; distM: number } | null = null
  const stamp = nextStamp(ix)
  const P = ix.px
  const pb = ix.pieceB
  const m2 = margin * margin
  const dx = ex - sx
  const dy = ey - sy
  const len2 = dx * dx + dy * dy
  const onTrack = (qx: number, qy: number): [number, number] => {
    if (len2 === 0) return [sx, sy]
    const t = Math.min(1, Math.max(0, ((qx - sx) * dx + (qy - sy) * dy) / len2))
    return [sx + t * dx, sy + t * dy]
  }
  forBucketsNear(ix, sx, sy, ex, ey, margin, (b) => {
    for (let k = pb.start[b]; k < pb.start[b + 1]; k++) {
      const p = pb.items[k]
      if (ix.pStamp[p] === stamp) continue
      ix.pStamp[p] = stamp
      const l = ix.pLeft[p]
      const r = ix.pRight[p]
      const shoalL = Number.isFinite(l) && l < safeDepthM
      const shoalR = Number.isFinite(r) && r < safeDepthM
      if (!shoalL && !shoalR) continue
      const o = p * 4
      const qax = P[o]
      const qay = P[o + 1]
      const qbx = P[o + 2]
      const qby = P[o + 3]
      const d2 = segSegDist2(sx, sy, ex, ey, qax, qay, qbx, qby)
      if (d2 > m2) continue
      // The point of the track nearest the piece: the closest pair of two
      // segments that do not cross has an endpoint of one of them in it.
      let bx = sx
      let by = sy
      let bd = Infinity
      const tryPair = (tx: number, ty: number, ux: number, uy: number) => {
        const d = (tx - ux) * (tx - ux) + (ty - uy) * (ty - uy)
        if (d < bd) {
          bd = d
          bx = tx
          by = ty
        }
      }
      for (const [qx, qy] of [[qax, qay], [qbx, qby]] as const) {
        const [tx, ty] = onTrack(qx, qy)
        tryPair(tx, ty, qx, qy)
      }
      for (const [tx, ty] of [[sx, sy], [ex, ey]] as const) {
        const qdx = qbx - qax
        const qdy = qby - qay
        const q2 = qdx * qdx + qdy * qdy
        const u = q2 === 0 ? 0 : Math.min(1, Math.max(0, ((tx - qax) * qdx + (ty - qay) * qdy) / q2))
        tryPair(tx, ty, qax + u * qdx, qay + u * qdy)
      }
      if (inChannel && inChannel(bx, by)) continue
      const depthM = Math.max(0, Math.min(shoalL ? l : Infinity, shoalR ? r : Infinity))
      const distM = Math.sqrt(d2)
      if (!best) best = { depthM, distM }
      else {
        best.depthM = Math.min(best.depthM, depthM)
        best.distM = Math.min(best.distM, distM)
      }
    }
  })
  return best
}

/**
 * Check one leg against the real chart.
 *
 * Depth: the leg is cut wherever it crosses an effective boundary or the edge
 * of an approach zone; the state is constant between cuts, so one
 * containment test in the middle of each piece is the whole answer. Pieces
 * shorter than `SLIVER_M` are seam artefacts and skipped.
 *
 * Stand-off: least distance from the parts of the leg outside the approach
 * zones to the coastline (land pieces of the boundary) and to every hazard
 * footprint. Inside a zone the stand-off is waived, but a footprint may still
 * not be entered, and land never.
 */
export function checkSegment(
  ix: ChartIndex,
  ax: number, ay: number, bx: number, by: number,
  opts: SegmentCheckOptions,
): SegmentCheck {
  const len = Math.hypot(bx - ax, by - ay)
  const ts: number[] = [0, 1]

  // Crossings with the effective boundary, walking the buckets under the leg.
  const { bx0, by0, bSize, bnx, bny } = ix
  const P = ix.px
  const stamp = nextStamp(ix)
  const pb = ix.pieceB
  const rx = bx - ax
  const ry = by - ay
  traverseCells(
    (ax - bx0) / bSize, (ay - by0) / bSize, (bx - bx0) / bSize, (by - by0) / bSize,
    bnx, bny,
    (c, r) => {
      const b = r * bnx + c
      for (let k = pb.start[b]; k < pb.start[b + 1]; k++) {
        const p = pb.items[k]
        if (ix.pStamp[p] === stamp) continue
        ix.pStamp[p] = stamp
        const o = p * 4
        const cx = P[o]
        const cy = P[o + 1]
        const sx = P[o + 2] - cx
        const sy = P[o + 3] - cy
        const den = rx * sy - ry * sx
        if (den === 0) continue
        const t = ((cx - ax) * sy - (cy - ay) * sx) / den
        const u = ((cx - ax) * ry - (cy - ay) * rx) / den
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t)
      }
    },
  )
  for (const z of opts.zones) circleParams(ax, ay, bx, by, z, ts)
  ts.sort((a, b) => a - b)

  let crossesLand = false
  let approachDepth = false
  let shallow = false
  let unsurveyed = false
  let minDepth = Infinity
  let minDepthOut = Infinity
  const outside: [number, number][] = []
  const minLen = len > SLIVER_M * 2 ? SLIVER_M : 0
  // Pieces shorter than a sliver are seam artefacts and skipped — but never
  // all of them: a short leg cut into slivers still has its longest piece
  // read, so no leg is ever passed without looking at the chart under it.
  let longest = 0
  let anyLong = false
  for (let k = 0; k + 1 < ts.length; k++) {
    const l = (ts[k + 1] - ts[k]) * len
    if (l >= minLen) anyLong = true
    if (l > (ts[longest + 1] - ts[longest]) * len) longest = k
  }
  for (let k = 0; k + 1 < ts.length; k++) {
    const ta = ts[k]
    const tb = ts[k + 1]
    if (anyLong ? (tb - ta) * len < minLen : k !== longest) continue
    const tm = (ta + tb) / 2
    const mx = ax + tm * rx
    const my = ay + tm * ry
    const zone = opts.zones.length > 0 && inAnyZone(opts.zones, mx, my)
    if (!zone) {
      const last = outside[outside.length - 1]
      if (last && Math.abs(last[1] - ta) < 1e-12) last[1] = tb
      else outside.push([ta, tb])
    }
    const s = intervalState(ix, ax, ay, rx, ry, len, ta, tb)
    if (s === LAND) {
      crossesLand = true
      minDepth = Math.min(minDepth, 0)
      if (!zone) minDepthOut = Math.min(minDepthOut, 0)
      continue
    }
    if (Number.isNaN(s)) {
      if (zone) approachDepth = true
      else unsurveyed = true
      continue
    }
    minDepth = Math.min(minDepth, s)
    if (!zone) minDepthOut = Math.min(minDepthOut, s)
    if (s < opts.safeDepthM) {
      if (zone) approachDepth = true
      else shallow = true
    }
  }

  // Stand-off. One pass over everything within the measuring distance of
  // the whole leg gives the reported clearance; the zone-free parts are
  // checked against the stand-off separately only when a zone cuts the leg.
  const c = Math.max(0, opts.clearanceM)
  const measure = Math.max(CLEARANCE_MEASURE_M, 2 * c)
  const landD = landDistance(ix, ax, ay, bx, by, measure)
  const hazD = hazardDistance(ix, ax, ay, bx, by, measure)
  const entersHazard = hazD <= 0
  const whole = Math.min(landD, Math.max(0, hazD))
  let clearOut: number
  if (outside.length === 1 && outside[0][0] === 0 && outside[0][1] === 1) {
    clearOut = whole
  } else {
    clearOut = Infinity
    for (const [ta, tb] of outside) {
      const sx = ax + ta * rx
      const sy = ay + ta * ry
      const ex2 = ax + tb * rx
      const ey2 = ay + tb * ry
      const reach = Math.max(c, 1)
      const l = landDistance(ix, sx, sy, ex2, ey2, reach)
      const h = hazardDistance(ix, sx, sy, ex2, ey2, reach)
      clearOut = Math.min(clearOut, l, Math.max(0, h))
    }
  }
  // Inside a zone the stand-off is waived; say so when the leg used that.
  const approachClearance = whole < c && clearOut >= c && !entersHazard

  // The lateral depth margin: shallow water beside the track, not under it.
  // Only where the track itself is sound (a leg already crossing shallow
  // water is flagged for that), outside the zones and outside channels.
  let nearShoal = false
  let nearShoalDepthM: number | null = null
  let nearShoalDistM: number | null = null
  const margin = opts.depthMarginM ?? 0
  if (margin > 0 && !shallow && !crossesLand) {
    for (const [ta, tb] of outside) {
      const hit = shoalBeside(
        ix,
        ax + ta * rx, ay + ta * ry, ax + tb * rx, ay + tb * ry,
        margin, opts.safeDepthM, opts.inChannel,
      )
      if (!hit) continue
      nearShoal = true
      if (nearShoalDepthM === null || hit.depthM < nearShoalDepthM) nearShoalDepthM = hit.depthM
      if (nearShoalDistM === null || hit.distM < nearShoalDistM) nearShoalDistM = hit.distM
    }
  }

  const depthOk = !crossesLand && !shallow && !unsurveyed && !nearShoal
  const clearanceOk = !entersHazard && (c === 0 || clearOut >= c)
  return {
    ok: depthOk && clearanceOk,
    depthOk,
    clearanceOk,
    crossesLand,
    entersHazard,
    usedApproach: approachDepth || approachClearance,
    approachDepth,
    approachClearance,
    nearShoal,
    nearShoalDepthM,
    nearShoalDistM,
    shallow,
    unsurveyed,
    minDepthM: Number.isFinite(minDepth) ? minDepth : null,
    minDepthOutsideM: Number.isFinite(minDepthOut) ? minDepthOut : null,
    minClearanceM: Number.isFinite(whole) ? whole : null,
    clearanceOutsideM: clearOut,
  }
}

/* -------------------------------------------------------------------------
 * Caching
 * ---------------------------------------------------------------------- */

const cache = new WeakMap<ChartFeatures, ChartIndex[]>()

function containsBox(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.minLat <= inner.minLat &&
    outer.minLon <= inner.minLon &&
    outer.maxLat >= inner.maxLat &&
    outer.maxLon >= inner.maxLon
  )
}

/**
 * An index already built over (at least) this box for this chart, or null.
 * Never builds one — see `chartIndexFor` for that.
 */
export function peekChartIndex(features: ChartFeatures, bounds: Bounds): ChartIndex | null {
  return cache.get(features)?.find((ix) => containsBox(ix.bounds, bounds)) ?? null
}

/**
 * The index for this chart over (at least) this box, reusing one already
 * built for a box that contains it.
 *
 * The same features object comes back for a re-route, a changed draft or a
 * changed stand-off, and none of those change the chart — so none of them
 * pay to index it again. Two entries per features object at most: a phone
 * does not need a museum of old areas.
 */
export function chartIndexFor(features: ChartFeatures, bounds: Bounds): ChartIndex {
  let list = cache.get(features)
  if (list) {
    const hit = list.find((ix) => containsBox(ix.bounds, bounds))
    if (hit) return hit
  } else {
    list = []
    cache.set(features, list)
  }
  const ix = buildChartIndex(features, bounds)
  list.unshift(ix)
  if (list.length > 2) list.length = 2
  return ix
}
