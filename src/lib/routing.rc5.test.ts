import { describe, it, expect } from 'vitest'
import { metersPerDegree } from './geo'
import {
  channelMarginFor,
  chartedDepthText,
  chartStateAt,
  liveRay,
  liveRayClear,
  planRoute,
  CHANNEL_MARGIN_MAX_M,
  CHANNEL_MARGIN_MIN_M,
  type ChartFeatures,
  type Ring,
} from './routing'
import type { LatLon } from './search'
import { loadGalveston } from './__fixtures__/galveston'

/*
 * rc5 acceptance findings on the router (independent tester, 1519 routes):
 *
 *   F2 — a charted route hugged the edge of the dredged ICW cut 0–3 m from
 *        water too shallow for the boat (the lateral depth margin was waived
 *        inside channels altogether);
 *   F3 — a best-effort warning read "crosses -1 ft (-0.3 m)";
 *   F4 — best-effort was offered although a compliant route existed in the
 *        wide planning box (a coarse grid there closed a 30 m gut);
 *   F5 — "no route" was returned with water all the way, and flipped with a
 *        start 2.5 m away.
 */

const BASE_LAT = 29.3
const BASE_LON = -94.8
const MPD = metersPerDegree(BASE_LAT)
const at = (x: number, y: number): LatLon => ({ lat: BASE_LAT + y / MPD.lat, lon: BASE_LON + x / MPD.lon })
const ll = (x: number, y: number): [number, number] => {
  const p = at(x, y)
  return [p.lon, p.lat]
}
const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [
  ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0),
]
const xyOf = (p: LatLon) => ({ x: (p.lon - BASE_LON) * MPD.lon, y: (p.lat - BASE_LAT) * MPD.lat })

/**
 * A 1 m bay with a dredged, 5 m deep channel `widthM` wide running north
 * from x = 0 to x = widthM (a finer chart band, as a harbour chart draws it).
 */
function channelBay(widthM: number): ChartFeatures {
  const cut = rect(0, -3000, widthM, 3000)
  return {
    depthAreas: [
      { minDepthM: 1, rings: [rect(-12000, -12000, 12000, 12000)], level: 1 },
      { minDepthM: 5, rings: [cut], level: 2 },
    ],
    channels: [{ kind: 'dredged', rings: [cut] }],
    land: [],
    hazards: [],
    lines: [],
    coverage: 'full',
  } as ChartFeatures
}

/** Least distance, metres, from the plan's legs (outside 120 m of its ends) to x = 0 and x = width. */
function edgeRoom(points: LatLon[], widthM: number): number {
  let room = Infinity
  const a0 = xyOf(points[0])
  const aN = xyOf(points[points.length - 1])
  for (let i = 0; i + 1 < points.length; i++) {
    const a = xyOf(points[i])
    const b = xyOf(points[i + 1])
    const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2))
    for (let k = 0; k <= n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n
      const y = a.y + ((b.y - a.y) * k) / n
      if (Math.hypot(x - a0.x, y - a0.y) <= 120 || Math.hypot(x - aN.x, y - aN.y) <= 120) continue
      room = Math.min(room, x, widthM - x)
    }
  }
  return room
}

describe('F2: a leg keeps off the edges of a dredged channel', () => {
  it('channelMarginFor: 8 m at most, 3 m at least, off with 0', () => {
    expect(channelMarginFor(10)).toEqual({ maxM: CHANNEL_MARGIN_MAX_M, minM: CHANNEL_MARGIN_MIN_M, fraction: 0.25 })
    expect(channelMarginFor(15)?.maxM).toBe(8)
    expect(channelMarginFor(10, 0)).toBeNull()
    expect(channelMarginFor(10, 2)).toEqual({ maxM: 2, minM: 2, fraction: 0.25 })
  })

  it('in a 60 m channel, starting 4 m from its edge: charted, and 8 m off both edges', () => {
    const f = channelBay(60)
    const plan = planRoute({ from: at(4, -1500), to: at(30, 1500), safeDepthM: 2.7, clearanceM: 10, speedKn: 10, features: f, arrivalFt: 150 })
    expect(plan.source).toBe('charted')
    expect(edgeRoom(plan.points, 60)).toBeGreaterThanOrEqual(CHANNEL_MARGIN_MAX_M - 0.5)
  })

  it('in a narrow 16 m channel: still charted — it keeps to the middle half', () => {
    const f = channelBay(16)
    const plan = planRoute({ from: at(8, -1500), to: at(8, 1500), safeDepthM: 2.7, clearanceM: 10, speedKn: 10, features: f, arrivalFt: 150 })
    expect(plan.source).toBe('charted')
    expect(edgeRoom(plan.points, 16)).toBeGreaterThanOrEqual(0.25 * 16 - 0.5)
  })

  it('in a channel too narrow for 3 m either side: best-effort, the leg flagged, and the crew told to keep to the middle', () => {
    const f = channelBay(5)
    const plan = planRoute({ from: at(2.5, -1500), to: at(2.5, 1500), safeDepthM: 2.7, clearanceM: 10, speedKn: 10, features: f, arrivalFt: 150 })
    expect(plan.source).toBe('best-effort')
    expect(plan.needsConfirm).toBe(true)
    expect(plan.legs.some((l) => l.caution === 'unsafe-depth')).toBe(true)
    expect(plan.warnings.join(' ')).toMatch(/too narrow .* Keep to the middle of the channel/)
  })

  it('rc5 edge-27: the ICW route no longer runs 0–3 m from the 2 m shelf', () => {
    const f = loadGalveston()
    const from = { lat: 29.339489641913836, lon: -94.83210757142975 }
    const to = { lat: 29.366284690037816, lon: -94.80263838608323 }
    const plan = planRoute({ from, to, safeDepthM: 2.7, clearanceM: 10, speedKn: 17.5, features: f, arrivalFt: 150 })
    expect(plan.source).toBe('charted')
    // Walk every leg, and 3 m either side of it, outside the 120 m at each
    // end: the chart must give 2.7 m or more at every sample.
    const m = metersPerDegree(from.lat)
    const near = (p: LatLon, q: LatLon) => Math.hypot((p.lat - q.lat) * m.lat, (p.lon - q.lon) * m.lon)
    const bad: string[] = []
    for (let i = 0; i + 1 < plan.points.length; i++) {
      const a = plan.points[i]
      const b = plan.points[i + 1]
      const dx = (b.lon - a.lon) * m.lon
      const dy = (b.lat - a.lat) * m.lat
      const L = Math.hypot(dx, dy)
      if (L < 1) continue
      const nx = -dy / L
      const ny = dx / L
      for (let s = 0; s <= L; s += 5) {
        for (const off of [-3, 0, 3]) {
          const q = {
            lat: a.lat + (dy * (s / L) + ny * off) / m.lat,
            lon: a.lon + (dx * (s / L) + nx * off) / m.lon,
          }
          if (near(q, from) <= 120 || near(q, to) <= 120) continue
          const st = chartStateAt(f, q)
          if (!(typeof st === 'number' && st >= 2.7)) bad.push(`leg ${i + 1} +${Math.round(s)} m off ${off}: ${st}`)
        }
      }
    }
    expect(bad).toEqual([])
  }, 60_000)
})

describe('F3: drying heights are worded as such', () => {
  it('chartedDepthText', () => {
    expect(chartedDepthText(0.9)).toBe('3 ft (0.9 m)')
    expect(chartedDepthText(-0.3)).toBe('ground that dries 1 ft (0.3 m)')
    expect(chartedDepthText(-0.1)).toBe('0 ft (dries)')
  })

  it('rc5 hc-157: the best-effort warning says "dries", never a negative depth', () => {
    const f = loadGalveston()
    const plan = planRoute({
      from: { lat: 29.357156, lon: -94.792919 },
      to: { lat: 29.333481, lon: -94.822254 },
      safeDepthM: 1.82,
      clearanceM: 40,
      speedKn: 24.9,
      features: f,
      arrivalFt: 200,
    })
    expect(plan.source).toBe('best-effort')
    const text = plan.warnings.join(' ')
    expect(text).not.toMatch(/-\d+ ft|-\d\.\d m/)
    expect(text).toMatch(/dries/)
  }, 60_000)
})

describe('F4: the wide box, finely, before bending a rule', () => {
  it('rc5: a compliant route that lies east of the planning box is found (charted, not best-effort)', () => {
    const f = loadGalveston()
    const plan = planRoute({
      from: { lat: 29.305819904675218, lon: -94.82861698658262 },
      to: { lat: 29.344605060192052, lon: -94.82385990634849 },
      safeDepthM: 0.83,
      clearanceM: 20,
      speedKn: 10,
      features: f,
    })
    expect(plan.source).toBe('charted')
    expect(plan.legs.every((l) => l.caution === 'ok' || l.caution === 'shallow-approach')).toBe(true)
  }, 60_000)
})

describe('F5: "no route" only when there is truly no water path', () => {
  const f = loadGalveston()
  const to78 = { lat: 29.325523738043156, lon: -94.78033571121932 }

  it('rc5 rand-158: water all the way (0–14 m) — best-effort, not none', () => {
    const plan = planRoute({
      from: { lat: 29.371968488124722, lon: -94.81054625971919 },
      to: { lat: 29.336810137101438, lon: -94.82481750042159 },
      safeDepthM: 1.39,
      clearanceM: 10,
      speedKn: 10,
      features: f,
    })
    expect(plan.source).toBe('best-effort')
    expect(plan.points.length).toBeGreaterThan(1)
    expect(plan.needsConfirm).toBe(true)
  }, 60_000)

  it('rc5 rand-78: the same answer from two starts 2.5 m apart', () => {
    const a = planRoute({ from: { lat: 29.342446686070843, lon: -94.82187092606266 }, to: to78, safeDepthM: 1.19, clearanceM: 15, speedKn: 10, features: f })
    const b = planRoute({ from: { lat: 29.342466869483168, lon: -94.82188293793949 }, to: to78, safeDepthM: 1.19, clearanceM: 15, speedKn: 10, features: f })
    expect(a.source).toBe('best-effort')
    expect(b.source).toBe('best-effort')
    // Never a leg across land, flagged or not, away from the dock stretches.
    for (const p of [a, b]) {
      for (const l of p.legs) expect(l.overLand ?? false).toBe(false)
    }
  }, 60_000)
})

describe('the fine grid\'s optimistic read is not skipped after a route it found was refused (rc6)', () => {
  it('rc5 rand-40: a re-route 63 m from the start is charted, as the plan from the start was', () => {
    const features = loadGalveston()
    const to = { lat: 29.315103, lon: -94.797233 }
    const req = { to, safeDepthM: 0.77, clearanceM: 15, speedKn: 19.9, features, arrivalFt: 150 }
    expect(planRoute({ ...req, from: { lat: 29.359638, lon: -94.820845 } }).source).toBe('charted')
    expect(planRoute({ ...req, from: { lat: 29.359421, lon: -94.820248 } }).source).toBe('charted')
  }, 60_000)
})

describe('liveRay / liveRayClear', () => {
  it('sees land on the line, and shallows outside the approach zones only', () => {
    const f: ChartFeatures = {
      depthAreas: [
        { minDepthM: 10, rings: [rect(-5000, -5000, 5000, 5000)] },
        { minDepthM: 0.5, rings: [rect(-100, 400, 100, 450)] },
      ],
      channels: [],
      land: [{ rings: [rect(-100, 800, 100, 900)] }],
      hazards: [],
      lines: [],
      coverage: 'full',
    } as ChartFeatures
    const req = { features: f, from: at(0, -2000), to: at(0, 2000), safeDepthM: 2, clearanceM: 10, approachM: 120, speedKn: 10 }
    // Build the index the live checks read (as a plan would have).
    planRoute({ ...req, features: f })
    expect(liveRay(req, at(0, 0), 0, 300)).toEqual({ land: false, shallow: false })
    expect(liveRay(req, at(0, 0), 0, 500)).toEqual({ land: false, shallow: true })
    expect(liveRay(req, at(0, 0), 0, 1000)?.land).toBe(true)
    expect(liveRayClear(req, at(0, 0), 0, 1000)).toBe(false)
    expect(liveRayClear(req, at(0, 0), 180, 1000)).toBe(true)
  })
})

describe('approach zones stay round the passage\'s ends (rc6)', () => {
  // 5 m everywhere, but a 0.5 m bar 120 m wide right across the way north.
  const bar: ChartFeatures = {
    depthAreas: [
      { minDepthM: 5, rings: [rect(-12000, -12000, 12000, 12000)] },
      { minDepthM: 0.5, rings: [rect(-12000, 300, 12000, 420)] },
    ],
    channels: [],
    land: [],
    hazards: [],
    lines: [],
    coverage: 'full',
  }
  const boat = at(0, 350)
  const dest = at(0, 2500)
  const req = { from: boat, to: dest, safeDepthM: 1.5, clearanceM: 10, speedKn: 10, features: bar }

  it('by default a zone round `from` lets the route cross the bar as a dotted approach', () => {
    const p = planRoute(req)
    expect(p.source).toBe('charted')
    expect(p.legs.some((l) => l.caution === 'shallow-approach')).toBe(true)
  })

  it('a re-route given the departure\'s zone instead crosses it only as best-effort, flagged', () => {
    const p = planRoute({
      ...req,
      approachZones: [
        { ...at(0, -2000), radiusM: 120 },
        { ...dest, radiusM: 120 },
      ],
    })
    expect(p.source).toBe('best-effort')
    expect(p.needsConfirm).toBe(true)
    expect(p.legs.some((l) => l.caution === 'unsafe-depth')).toBe(true)
    expect(p.legs.some((l) => l.caution === 'shallow-approach')).toBe(false)
  })

  it('the dock hop off charted land still needs no confirmation without a zone round the boat', () => {
    const f: ChartFeatures = { ...bar, depthAreas: [bar.depthAreas[0]], land: [{ rings: [rect(-30, -30, 30, 30)] }] }
    const p = planRoute({
      from: at(0, 0),
      to: dest,
      safeDepthM: 1.5,
      clearanceM: 5,
      speedKn: 10,
      features: f,
      approachZones: [{ ...dest, radiusM: 120 }],
    })
    expect(p.source).toBe('charted')
    expect(p.legs[0].caution).toBe('off-chart-end')
  })
})
