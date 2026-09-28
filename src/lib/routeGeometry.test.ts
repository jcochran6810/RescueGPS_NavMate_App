import { describe, it, expect } from 'vitest'
import { metersPerDegree } from './geo'
import type { ChartFeatures, Ring } from './routing'
import {
  LAND,
  SLIVER_M,
  buildChartIndex,
  chartIndexFor,
  checkSegment,
  clipRing,
  distanceTransform,
  fromXY,
  hazardDistance,
  landDistance,
  pointSegDist2,
  projectionFor,
  segRectDist,
  segSegDist2,
  stateAt,
  toXY,
  traverseCells,
  type Bounds,
  type ChartIndex,
} from './routeGeometry'

/* -------------------------------------------------------------------------
 * A small world in metres
 *
 * Every test below builds its chart in metres east and north of one corner
 * and converts to [lon, lat] once, so the numbers in the assertions are the
 * numbers in the fixture — "a bar 4 m wide at y = 500" rather than a
 * sixth-decimal latitude nobody can read.
 * ---------------------------------------------------------------------- */

const LAT0 = 29.3
const LON0 = -94.8
const MPD = metersPerDegree(LAT0 + 0.01)
const BOX: Bounds = {
  minLat: LAT0,
  minLon: LON0,
  maxLat: LAT0 + 2000 / MPD.lat,
  maxLon: LON0 + 2000 / MPD.lon,
}

/** [lon, lat] for a point `x` m east and `y` m north of the corner. */
function ll(x: number, y: number): [number, number] {
  return [LON0 + x / MPD.lon, LAT0 + y / MPD.lat]
}

/** A closed rectangle ring in metres. */
function rect(x0: number, y0: number, x1: number, y1: number): Ring {
  return [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)]
}

function world(extra: Partial<ChartFeatures> = {}): ChartFeatures {
  return {
    depthAreas: [{ minDepthM: 10, rings: [rect(-100, -100, 2100, 2100)] }],
    channels: [],
    land: [],
    hazards: [],
    lines: [],
    coverage: 'full',
    ...extra,
  }
}

/** The index, and a way to talk to it in this file's metres. */
function indexOf(f: ChartFeatures): { ix: ChartIndex; at: (x: number, y: number) => { x: number; y: number } } {
  const ix = buildChartIndex(f, BOX)
  return {
    ix,
    at: (x, y) => {
      const [lon, lat] = ll(x, y)
      return toXY(ix.proj, { lat, lon })
    },
  }
}

function seg(
  ix: ChartIndex,
  at: (x: number, y: number) => { x: number; y: number },
  a: [number, number],
  b: [number, number],
  opts: { safeDepthM?: number; clearanceM?: number; zones?: { x: number; y: number; r: number }[] } = {},
) {
  const p = at(...a)
  const q = at(...b)
  return checkSegment(ix, p.x, p.y, q.x, q.y, {
    safeDepthM: opts.safeDepthM ?? 1.5,
    clearanceM: opts.clearanceM ?? 0,
    zones: (opts.zones ?? []).map((z) => ({ ...at(z.x, z.y), r: z.r })),
  })
}

/* -------------------------------------------------------------------------
 * Arithmetic
 * ---------------------------------------------------------------------- */

describe('projection', () => {
  it('round-trips a position to within a millimetre', () => {
    const pr = projectionFor(BOX)
    const p = { lat: 29.3123456, lon: -94.7987654 }
    const xy = toXY(pr, p)
    const back = fromXY(pr, xy.x, xy.y)
    expect(Math.abs(back.lat - p.lat) * MPD.lat).toBeLessThan(1e-3)
    expect(Math.abs(back.lon - p.lon) * MPD.lon).toBeLessThan(1e-3)
  })

  it('measures metres as metres', () => {
    const pr = projectionFor(BOX)
    const [lon, lat] = ll(1000, 0)
    expect(toXY(pr, { lat, lon }).x).toBeCloseTo(1000, 0)
  })
})

describe('segment distances', () => {
  it('is zero for crossing segments and the gap otherwise', () => {
    expect(segSegDist2(0, 0, 10, 10, 0, 10, 10, 0)).toBe(0)
    expect(Math.sqrt(segSegDist2(0, 0, 10, 0, 0, 3, 10, 3))).toBeCloseTo(3, 9)
    expect(Math.sqrt(pointSegDist2(5, 4, 0, 0, 10, 0))).toBeCloseTo(4, 9)
    // Beyond the end, the distance is to the end.
    expect(Math.sqrt(pointSegDist2(13, 4, 0, 0, 10, 0))).toBeCloseTo(5, 9)
  })

  it('measures a segment to a rectangle exactly, including corners', () => {
    expect(segRectDist(-5, 5, -1, 5, 0, 0, 10, 10)).toBeCloseTo(1, 9)
    expect(segRectDist(-5, 5, 15, 5, 0, 0, 10, 10)).toBe(0)
    // A corner nearest a diagonal line.
    expect(segRectDist(12, 20, 20, 12, 0, 0, 10, 10)).toBeCloseTo(12 / Math.SQRT2, 9)
  })
})

describe('traverseCells', () => {
  const walk = (x0: number, y0: number, x1: number, y1: number, n = 10) => {
    const out: string[] = []
    traverseCells(x0, y0, x1, y1, n, n, (c, r) => {
      out.push(`${c},${r}`)
    })
    return out
  }

  it('visits every cell a horizontal line passes through', () => {
    expect(walk(0.5, 0.5, 3.5, 0.5)).toEqual(['0,0', '1,0', '2,0', '3,0'])
  })

  it('visits both shoulders where a diagonal passes exactly through a corner', () => {
    // A line through the corner shared by four cells has touched all four:
    // a walk that skipped the two beside the corner would call a gap between
    // two blocked cells open.
    const cells = walk(0.5, 0.5, 2.5, 2.5)
    for (const c of ['0,0', '1,0', '0,1', '1,1', '2,1', '1,2', '2,2']) {
      expect(cells).toContain(c)
    }
  })

  it('visits every cell of a shallow slope, not one per column', () => {
    // From (0.1, 0.1) to (5.9, 1.9): a Bresenham walk visits six cells; the
    // line itself crosses into row 1 and so touches more.
    const cells = walk(0.1, 0.1, 5.9, 1.9)
    expect(cells.length).toBeGreaterThan(6)
    expect(cells[0]).toBe('0,0')
    expect(cells[cells.length - 1]).toBe('5,1')
  })

  it('stops early when told to, and says so', () => {
    let n = 0
    const done = traverseCells(0.5, 0.5, 8.5, 0.5, 10, 10, () => ++n < 3)
    expect(done).toBe(false)
    expect(n).toBe(3)
  })

  it('walks backwards as well as forwards', () => {
    expect(walk(3.5, 0.5, 0.5, 0.5)).toEqual(['3,0', '2,0', '1,0', '0,0'])
  })
})

describe('distanceTransform', () => {
  it('is exactly the Euclidean distance to the nearest source centre', () => {
    const cols = 23
    const rows = 17
    const src = new Uint8Array(cols * rows)
    let seed = 7
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < src.length; i++) src[i] = rand() < 0.03 ? 1 : 0
    src[5] = 1
    const out = new Float32Array(cols * rows)
    distanceTransform(cols, rows, src, false, out)
    for (let i = 0; i < src.length; i++) {
      let best = Infinity
      for (let j = 0; j < src.length; j++) {
        if (!src[j]) continue
        const d = Math.hypot((i % cols) - (j % cols), Math.floor(i / cols) - Math.floor(j / cols))
        best = Math.min(best, d)
      }
      expect(out[i]).toBeCloseTo(best, 4)
    }
  })

  it('treats the world outside the grid as a source when asked', () => {
    const out = new Float32Array(25)
    distanceTransform(5, 5, new Uint8Array(25), true, out)
    // The centre cell is three cells from the virtual border ring.
    expect(out[12]).toBeCloseTo(3, 6)
    expect(out[0]).toBeCloseTo(1, 6)
  })

  it('is Infinity everywhere when there is nothing to be near', () => {
    const out = new Float32Array(9)
    distanceTransform(3, 3, new Uint8Array(9), false, out)
    expect(out.every((d) => d === Infinity)).toBe(true)
  })
})

describe('clipRing', () => {
  const area = (xy: number[]) => {
    let a = 0
    const n = xy.length / 2
    for (let i = 0, j = n - 1; i < n; j = i++) {
      a += xy[2 * j] * xy[2 * i + 1] - xy[2 * i] * xy[2 * j + 1]
    }
    return Math.abs(a) / 2
  }

  it('keeps exactly the part inside the rectangle', () => {
    const square = [-5, -5, 5, -5, 5, 5, -5, 5]
    expect(area(clipRing(square, 0, 0, 10, 10))).toBeCloseTo(25, 9)
    expect(area(clipRing(square, -10, -10, 10, 10))).toBeCloseTo(100, 9)
    expect(clipRing(square, 20, 20, 30, 30)).toEqual([])
  })
})

/* -------------------------------------------------------------------------
 * The chart's state at a point
 * ---------------------------------------------------------------------- */

describe('stateAt', () => {
  it('reads a depth inside an area, and unsurveyed outside every area', () => {
    const { ix, at } = indexOf({
      ...world(),
      depthAreas: [{ minDepthM: 4, rings: [rect(100, 100, 900, 900)] }],
    })
    const inside = at(500, 500)
    const outside = at(1500, 1500)
    expect(stateAt(ix, inside.x, inside.y)).toBe(4)
    expect(Number.isNaN(stateAt(ix, outside.x, outside.y))).toBe(true)
  })

  it('leaves a hole a hole — an island inside a depth area is not deep water', () => {
    const { ix, at } = indexOf({
      ...world(),
      depthAreas: [{ minDepthM: 8, rings: [rect(0, 0, 1000, 1000), rect(400, 400, 600, 600)] }],
    })
    const hole = at(500, 500)
    expect(Number.isNaN(stateAt(ix, hole.x, hole.y))).toBe(true)
  })

  it('lets the finest chart speak: fine water over coarse land, fine land over coarse water', () => {
    const { ix, at } = indexOf({
      ...world(),
      depthAreas: [
        { minDepthM: 12, rings: [rect(-100, -100, 2100, 2100)], level: 1 },
        { minDepthM: 9, rings: [rect(0, 0, 1000, 1000)], level: 3 },
      ],
      land: [
        { rings: [rect(0, 0, 1000, 1000)], level: 1 },
        { rings: [rect(1200, 1200, 1400, 1400)], level: 3 },
      ],
    })
    const channel = at(500, 500)
    const pier = at(1300, 1300)
    expect(stateAt(ix, channel.x, channel.y)).toBe(9)
    expect(stateAt(ix, pier.x, pier.y)).toBe(LAND)
  })

  it('keeps the shoalest of two areas of the same chart, and land over both', () => {
    const { ix, at } = indexOf({
      ...world(),
      depthAreas: [
        { minDepthM: 9, rings: [rect(0, 0, 1000, 1000)] },
        { minDepthM: 0.6, rings: [rect(500, 0, 1000, 1000)] },
      ],
      land: [{ rings: [rect(900, 900, 1000, 1000)] }],
    })
    const both = at(700, 500)
    const landed = at(950, 950)
    expect(stateAt(ix, both.x, both.y)).toBeCloseTo(0.6, 9)
    expect(stateAt(ix, landed.x, landed.y)).toBe(LAND)
  })

  it('agrees with a brute-force containment test everywhere', () => {
    // Independent check: a pile of overlapping, holed, multi-level polygons
    // against the plain even-odd rule, at a few thousand random points.
    const f: ChartFeatures = {
      ...world(),
      depthAreas: [
        { minDepthM: 2, rings: [rect(0, 0, 1800, 1800)], level: 1 },
        { minDepthM: 7, rings: [rect(200, 200, 1200, 900), rect(300, 300, 400, 400)], level: 2 },
        { minDepthM: 4, rings: [[ll(100, 1000), ll(1700, 1100), ll(900, 1700), ll(100, 1000)]], level: 2 },
        { minDepthM: 1, rings: [rect(1000, 600, 1500, 1300)], level: 3 },
      ],
      land: [
        { rings: [rect(1300, 100, 1700, 500)], level: 1 },
        { rings: [[ll(600, 1300), ll(800, 1250), ll(750, 1450), ll(600, 1300)]], level: 2 },
      ],
    }
    const { ix, at } = indexOf(f)
    const pip = (ring: Ring, lon: number, lat: number) => {
      let inside = false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if (yi > lat !== yj > lat && lon < xi + ((lat - yi) * (xj - xi)) / (yj - yi)) inside = !inside
      }
      return inside
    }
    const inPoly = (rings: Ring[], lon: number, lat: number) =>
      rings.reduce((acc, r) => (pip(r, lon, lat) ? !acc : acc), false)
    const brute = (lon: number, lat: number) => {
      let level = -Infinity
      let land = false
      let depth = Infinity
      for (const p of f.depthAreas) {
        if (!inPoly(p.rings, lon, lat)) continue
        const l = p.level ?? 0
        if (l > level) {
          level = l
          land = false
          depth = p.minDepthM
        } else if (l === level) depth = Math.min(depth, p.minDepthM)
      }
      for (const p of f.land) {
        if (!inPoly(p.rings, lon, lat)) continue
        const l = p.level ?? 0
        if (l > level) {
          level = l
          land = true
        } else if (l === level) land = true
      }
      if (level === -Infinity) return NaN
      return land ? LAND : depth
    }
    let seed = 12345
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let k = 0; k < 3000; k++) {
      const x = rand() * 1990 + 5
      const y = rand() * 1990 + 5
      const [lon, lat] = ll(x, y)
      const p = at(x, y)
      const got = stateAt(ix, p.x, p.y)
      const want = brute(lon, lat)
      if (Number.isNaN(want)) expect(Number.isNaN(got)).toBe(true)
      else expect(got).toBe(want)
    }
  })
})

/* -------------------------------------------------------------------------
 * The effective boundary
 * ---------------------------------------------------------------------- */

describe('effective boundary', () => {
  it('drops a seam between two areas of the same depth', () => {
    const { ix } = indexOf({
      ...world(),
      depthAreas: [
        { minDepthM: 10, rings: [rect(-100, -100, 1000, 2100)] },
        { minDepthM: 10, rings: [rect(1000, -100, 2100, 2100)] },
      ],
    })
    // Only the outer edge of the pair separates anything (10 m from
    // unsurveyed); the shared seam at x = 1000 separates nothing.
    const P = ix.px
    for (let p = 0; p < ix.nPiece; p++) {
      const midX = (P[p * 4] + P[p * 4 + 2]) / 2
      const seamX = toXY(ix.proj, { lat: LAT0, lon: ll(1000, 0)[0] }).x
      expect(Math.abs(midX - seamX)).toBeGreaterThan(1)
    }
  })

  it('drops a coarse chart coastline that a finer chart covers with water', () => {
    // The Galveston case: the coastal chart draws the channel as land, the
    // harbour chart charts it at 9 m. No coastline should be left in the
    // channel for a stand-off to be measured from.
    const { ix, at } = indexOf({
      ...world(),
      depthAreas: [
        { minDepthM: 10, rings: [rect(-100, -100, 2100, 2100)], level: 1 },
        { minDepthM: 9, rings: [rect(0, 0, 2000, 2000)], level: 3 },
      ],
      land: [{ rings: [rect(800, 800, 1200, 1200)], level: 1 }],
    })
    const p = at(1000, 1000)
    expect(landDistance(ix, p.x, p.y, p.x, p.y, 500)).toBe(Infinity)
  })
})

/* -------------------------------------------------------------------------
 * Checking a leg
 * ---------------------------------------------------------------------- */

describe('checkSegment — depth', () => {
  it('catches a bar far thinner than any grid cell', () => {
    // 4 m of 0.5 m water across the whole box: no cell centre at 8 m or
    // coarser need ever land on it. The chart itself cannot miss it.
    const { ix, at } = indexOf({
      ...world(),
      depthAreas: [
        { minDepthM: 10, rings: [rect(-100, -100, 2100, 2100)] },
        { minDepthM: 0.5, rings: [rect(-100, 998, 2100, 1002)] },
      ],
    })
    const across = seg(ix, at, [500, 100], [500, 1900])
    expect(across.ok).toBe(false)
    expect(across.shallow).toBe(true)
    expect(across.minDepthM).toBeCloseTo(0.5, 9)
    const alongside = seg(ix, at, [100, 900], [1900, 900])
    expect(alongside.ok).toBe(true)
    expect(alongside.minDepthM).toBe(10)
  })

  it('reads land as land and unsurveyed as unsurveyed', () => {
    const { ix, at } = indexOf({
      ...world(),
      depthAreas: [
        { minDepthM: 10, rings: [rect(-100, -100, 2100, 900)] },
        { minDepthM: 10, rings: [rect(-100, 1100, 2100, 2100)] },
      ],
      land: [{ rings: [rect(1500, 0, 1600, 800)] }],
    })
    const gap = seg(ix, at, [500, 500], [500, 1500])
    expect(gap.unsurveyed).toBe(true)
    expect(gap.ok).toBe(false)
    const ashore = seg(ix, at, [1000, 400], [1800, 400])
    expect(ashore.crossesLand).toBe(true)
    expect(ashore.minDepthM).toBe(0)
  })

  it('does not trip over a seam a few centimetres wide between two charts', () => {
    // Adjoining ENC cells meet on a seam their vertices do not always share,
    // leaving centimetre gaps. Read literally, every leg across a seam would
    // pass through "unsurveyed water".
    const { ix, at } = indexOf({
      ...world(),
      depthAreas: [
        { minDepthM: 10, rings: [rect(-100, -100, 2100, 999.97)] },
        { minDepthM: 10, rings: [rect(-100, 1000.02, 2100, 2100)] },
      ],
    })
    expect(SLIVER_M).toBeGreaterThan(0.05)
    expect(seg(ix, at, [500, 500], [500, 1500]).ok).toBe(true)
  })

  it('allows shallow and unsurveyed water inside an approach zone, and nowhere else', () => {
    const { ix, at } = indexOf({
      ...world(),
      depthAreas: [
        { minDepthM: 10, rings: [rect(-100, -100, 2100, 2100)] },
        { minDepthM: 0.4, rings: [rect(-100, -100, 150, 2100)] },
      ],
    })
    const zone = { x: 50, y: 1000, r: 120 }
    const leaving = seg(ix, at, [50, 1000], [400, 1000], { zones: [zone] })
    expect(leaving.ok).toBe(true)
    expect(leaving.usedApproach).toBe(true)
    // The same water, but the leg runs along it well away from the zone.
    const along = seg(ix, at, [50, 1000], [50, 1600], { zones: [zone] })
    expect(along.ok).toBe(false)
    expect(along.shallow).toBe(true)
  })

  it('never lets an approach zone open land', () => {
    const { ix, at } = indexOf({
      ...world(),
      land: [{ rings: [rect(80, 900, 90, 1100)] }],
    })
    const r = seg(ix, at, [50, 1000], [300, 1000], { zones: [{ x: 50, y: 1000, r: 120 }] })
    expect(r.crossesLand).toBe(true)
    expect(r.ok).toBe(false)
  })
})

describe('checkSegment — stand-off', () => {
  const coast = () =>
    indexOf({ ...world(), land: [{ rings: [rect(-100, -100, 2100, 500)] }] })

  it('measures the least distance to land and holds it to the stand-off', () => {
    const { ix, at } = coast()
    const r = seg(ix, at, [100, 520], [1900, 520], { clearanceM: 30 })
    expect(r.minClearanceM).toBeCloseTo(20, 1)
    expect(r.clearanceOk).toBe(false)
    expect(r.depthOk).toBe(true)
    const wide = seg(ix, at, [100, 540], [1900, 540], { clearanceM: 30 })
    expect(wide.clearanceOk).toBe(true)
    expect(wide.ok).toBe(true)
  })

  it('does not apply the stand-off to the edge of shallow water', () => {
    // A dredged cut with shoal banks either side: the stand-off is from land
    // and hazards. Growing the bank by it closed the channels boats use.
    const { ix, at } = indexOf({
      ...world(),
      depthAreas: [
        { minDepthM: 0.3, rings: [rect(-100, -100, 2100, 980)] },
        { minDepthM: 12, rings: [rect(-100, 980, 2100, 1020)] },
        { minDepthM: 0.3, rings: [rect(-100, 1020, 2100, 2100)] },
      ],
    })
    const r = seg(ix, at, [100, 1000], [1900, 1000], { clearanceM: 30 })
    expect(r.ok).toBe(true)
  })

  it('reports no clearance at all when nothing is charted nearby', () => {
    const { ix, at } = indexOf(world())
    expect(seg(ix, at, [900, 900], [1100, 1100], { clearanceM: 30 }).minClearanceM).toBeNull()
  })

  it('waives the stand-off inside an approach zone but says it did', () => {
    const { ix, at } = coast()
    const zone = { x: 1000, y: 505, r: 120 }
    // Leaves the dock straight out: close to land only inside the zone.
    const r = seg(ix, at, [1000, 505], [1000, 900], { clearanceM: 30, zones: [zone] })
    expect(r.ok).toBe(true)
    expect(r.usedApproach).toBe(true)
    // Runs along the quay past the zone: not allowed.
    const along = seg(ix, at, [1000, 505], [1600, 505], { clearanceM: 30, zones: [zone] })
    expect(along.clearanceOk).toBe(false)
  })
})

describe('checkSegment — hazards', () => {
  it('keeps clear of a pylon by its footprint plus the stand-off', () => {
    const [lon, lat] = ll(1000, 1000)
    const { ix, at } = indexOf(
      world({ hazards: [{ lat, lon, radiusM: 10, kind: 'pylon', label: 'bridge pylon' }] }),
    )
    const through = seg(ix, at, [1000, 100], [1000, 1900], { clearanceM: 30 })
    expect(through.entersHazard).toBe(true)
    expect(through.ok).toBe(false)
    const past = seg(ix, at, [1025, 100], [1025, 1900], { clearanceM: 10 })
    expect(past.entersHazard).toBe(false)
    expect(past.minClearanceM).toBeCloseTo(15, 1)
    expect(past.ok).toBe(true)
    expect(seg(ix, at, [1025, 100], [1025, 1900], { clearanceM: 30 }).ok).toBe(false)
  })

  it('treats a jetty charted as a line as solid, with its width', () => {
    const { ix, at } = indexOf(
      world({
        lines: [{ kind: 'structure', paths: [[ll(0, 1000), ll(1500, 1000)]], widthM: 5, label: 'jetty' }],
      }),
    )
    const across = seg(ix, at, [700, 500], [700, 1500])
    expect(across.entersHazard).toBe(true)
    const round = seg(ix, at, [1600, 500], [1600, 1500], { clearanceM: 30 })
    expect(round.ok).toBe(true)
    // 100 m from the end of the jetty, less its half-width.
    expect(round.minClearanceM).toBeCloseTo(97.5, 1)
  })

  it('blocks an area hazard from a coarse chart even under a finer chart’s water', () => {
    // A wreck is a wreck on any chart; only land takes part in finest-wins.
    const { ix, at } = indexOf({
      ...world(),
      depthAreas: [
        { minDepthM: 10, rings: [rect(-100, -100, 2100, 2100)], level: 1 },
        { minDepthM: 9, rings: [rect(-100, -100, 2100, 2100)], level: 3 },
      ],
      land: [{ rings: [rect(900, 900, 1100, 1100)], level: 1, hazard: true }],
    })
    const r = seg(ix, at, [1000, 100], [1000, 1900])
    expect(r.entersHazard).toBe(true)
    expect(r.crossesLand).toBe(false)
    const inside = at(1000, 1000)
    expect(hazardDistance(ix, inside.x, inside.y, inside.x, inside.y, 0)).toBeLessThanOrEqual(0)
  })
})

describe('chartIndexFor', () => {
  it('reuses an index for the same chart and any box inside it', () => {
    const f = world()
    const a = chartIndexFor(f, BOX)
    const inner = { ...BOX, maxLat: (BOX.minLat + BOX.maxLat) / 2 }
    expect(chartIndexFor(f, BOX)).toBe(a)
    expect(chartIndexFor(f, inner)).toBe(a)
    expect(chartIndexFor(world(), BOX)).not.toBe(a)
  })
})
