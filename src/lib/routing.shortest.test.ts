import { describe, it, expect } from 'vitest'
import {
  planRoute,
  planAlternatives,
  alternateLabel,
  DEFAULT_SHALLOW_MARGIN_M,
  MIN_DEPTH_MARGIN_M,
  type ChartFeatures,
  type RoutePlan,
} from './routing'
import { loadUpperBay, UPPER_BAY_FROM, UPPER_BAY_TO } from './__fixtures__/upperBay'
import { loadGalveston } from './__fixtures__/galveston'
import { independentShortest, shoalDistanceField, stateAtPoint } from './__fixtures__/shortestPath'
import type { LatLon } from './search'

/*
 * "Need to always create the shortest route possible" (2026-09-28).
 *
 * The crew's report: from the Houston Ship Channel off Morgan's Point to
 * Three Bird Island, the plotter sent them down the ship channel past
 * Atkinson Island, 5 NM south to the South Boat Cut and 5 NM back north —
 * 17.7 NM — when Five Mile Cut Channel runs east from the ship channel
 * straight to the destination (9.8 NM) in 2.1–2.4 m of dredged water.
 *
 * Replayed on the real chart (upper-bay-enc.json, NOAA ENC Direct through
 * the live relay, 2026-09-28): with the whole harbour chart the planner takes
 * the cut; with the depth areas of ENC cell US5HOUCH missing — what the
 * crew's phone had, a piece of the chart that never loaded — the coastal
 * chart's 0–1.8 m for the whole bay speaks there, and the route goes round
 * the cell, waypoint for waypoint as in the screenshot.
 */

const NM = 1852
const upper = loadUpperBay()
const galveston = loadGalveston()

/** Is any point of the route (sampled every 20 m) inside a channel the chart names like this? */
function runsThrough(plan: RoutePlan, f: ChartFeatures, name: RegExp): boolean {
  const named = f.channels.filter((c) => c.name && name.test(c.name))
  expect(named.length).toBeGreaterThan(0)
  for (const leg of plan.legs) {
    const n = Math.max(1, Math.ceil((leg.lengthNM * NM) / 20))
    for (let k = 0; k <= n; k++) {
      const p = {
        lat: leg.from.lat + ((leg.to.lat - leg.from.lat) * k) / n,
        lon: leg.from.lon + ((leg.to.lon - leg.from.lon) * k) / n,
      }
      for (const c of named) {
        let inside = false
        for (const ring of c.rings) {
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i]
            const [xj, yj] = ring[j]
            if (yi > p.lat !== yj > p.lat && p.lon < xi + ((p.lat - yi) * (xj - xi)) / (yj - yi)) inside = !inside
          }
        }
        if (inside) return true
      }
    }
  }
  return false
}

/** Every sampled point of every sound leg in water at least `safeDepthM` deep (outside the ends). */
function depthViolations(plan: RoutePlan, f: ChartFeatures, safeDepthM: number): string[] {
  const out: string[] = []
  const start = plan.points[0]
  const end = plan.points[plan.points.length - 1]
  const far = (p: LatLon, q: LatLon) =>
    Math.hypot((p.lat - q.lat) * 111_000, (p.lon - q.lon) * 96_800) > 125
  plan.legs.forEach((leg, li) => {
    if (leg.caution !== 'ok') return
    const n = Math.max(1, Math.ceil((leg.lengthNM * NM) / 10))
    for (let k = 0; k <= n; k++) {
      const p = {
        lat: leg.from.lat + ((leg.to.lat - leg.from.lat) * k) / n,
        lon: leg.from.lon + ((leg.to.lon - leg.from.lon) * k) / n,
      }
      if (!far(p, start) || !far(p, end)) continue
      const s = stateAtPoint(f, p)
      if (!(s >= safeDepthM)) out.push(`leg ${li + 1} at ${k}/${n}: ${s}`)
    }
  })
  return out
}

describe('Five Mile Cut — the shortest route (real chart, upper Galveston Bay)', () => {
  it('takes Five Mile Cut for the default boat (0.9 m draft + 0.6 m, 30 m stand-off)', () => {
    const plan = planRoute({
      from: UPPER_BAY_FROM,
      to: UPPER_BAY_TO,
      safeDepthM: 1.5,
      clearanceM: 30,
      speedKn: 20,
      features: upper,
    })
    expect(plan.source).toBe('charted')
    expect(plan.totalNM).toBeLessThan(10.2)
    expect(runsThrough(plan, upper, /Five Mile Cut/)).toBe(true)
    expect(depthViolations(plan, upper, 1.5)).toEqual([])
    // Within a few per cent of a shortest compliant path worked out
    // independently (its own raster, distance transform and search, with the
    // rules read permissively — a lower bound, up to its grid).
    const ind = independentShortest(upper, UPPER_BAY_FROM, UPPER_BAY_TO, { safeDepthM: 1.5, clearanceM: 30 })
    expect(ind).not.toBeNull()
    expect((plan.totalNM * NM) / ind!.lengthM).toBeLessThan(1.03)
  })

  it.each([
    [0.6, 5],
    [1.2, 15],
    [1.5, 5],
    [1.8, 60],
  ])('takes the cut for a %s m boat keeping %s m off, within 5 %% of the shortest', (safeDepthM, clearanceM) => {
    const plan = planRoute({ from: UPPER_BAY_FROM, to: UPPER_BAY_TO, safeDepthM, clearanceM, speedKn: 20, features: upper })
    expect(plan.source).toBe('charted')
    expect(runsThrough(plan, upper, /Five Mile Cut/)).toBe(true)
    expect(depthViolations(plan, upper, safeDepthM)).toEqual([])
    const ind = independentShortest(upper, UPPER_BAY_FROM, UPPER_BAY_TO, { safeDepthM, clearanceM })
    expect(ind).not.toBeNull()
    expect((plan.totalNM * NM) / ind!.lengthM).toBeLessThan(1.05)
  })

  it('reproduces the screenshot when the harbour depths of cell US5HOUCH are missing — and says there is a shorter way', () => {
    // What the crew's phone was planning on. The route it drew: down the
    // ship channel, through the South Boat Cut, north along the cell's edge.
    const partial = loadUpperBay({ dropCell: 'US5HOUCH' })
    const req = { from: UPPER_BAY_FROM, to: UPPER_BAY_TO, safeDepthM: 1.5, clearanceM: 30, speedKn: 20, features: partial }
    const plan = planRoute(req)
    expect(plan.source).toBe('charted')
    expect(plan.totalNM).toBeGreaterThan(16)
    expect(Math.min(...plan.points.map((p) => p.lat))).toBeLessThan(29.56)
    // Now it is not silent about it: the shorter way is offered as an
    // alternative, with the reason, and the preview says why it was not taken.
    const alts = planAlternatives(req, plan)
    expect(alts.alternates.length).toBeGreaterThan(0)
    const alt = alts.alternates[0]
    expect(alt.shorterNM).toBeGreaterThan(6)
    expect(alt.plan.source).toBe('best-effort')
    expect(alt.plan.needsConfirm).toBe(true)
    expect(alt.reasons[0]).toMatchObject({ kind: 'shallow' })
    expect(alt.label).toMatch(/^Shallow \d/)
    // Beside Route 1 there IS a route keeping the boat's depth: the
    // alternate's own lines say what it breaks, not "No route keeps…".
    expect(alt.plan.confirmReason).toMatch(/^This shorter route does not keep 5 ft \(1\.5 m\) of water the whole way\. It crosses /)
    expect(alt.plan.warnings.some((w) => /^No route keeps |safest route found/.test(w))).toBe(false)
    expect(alt.plan.warnings).toContain(
      'It is shorter, not safe: another route keeps your boat’s rules — the flagged legs are red. Confirm before you steer it.',
    )
    expect(alts.shorterNote).toMatch(/A way \d+(\.\d)? NM shorter .* your boat needs/)
  })

  it('offers no alternative when the route is already the shortest', () => {
    const req = { from: UPPER_BAY_FROM, to: UPPER_BAY_TO, safeDepthM: 1.5, clearanceM: 30, speedKn: 20, features: upper }
    const plan = planRoute(req)
    const alts = planAlternatives(req, plan)
    expect(alts.alternates).toEqual([])
    expect(alts.shorterNote).toBeNull()
  })
})

describe('alternateLabel', () => {
  it('says what an alternative bends, worst first, feet by default', () => {
    expect(
      alternateLabel([
        { kind: 'shallow', leastDepthM: 1.07, legIdx: 2 },
        { kind: 'close', minClearanceM: 4.6, legIdx: 3 },
      ]),
    ).toBe('Shallow 3.5 ft · close to land 15 ft')
    expect(alternateLabel([{ kind: 'shallow', leastDepthM: 0.5, legIdx: 0 }], { depth: (m) => `${m.toFixed(1)} m` })).toBe(
      'Shallow 0.5 m',
    )
    expect(alternateLabel([])).toBe('Shorter')
  })
})

/*
 * The property: on random passages across both real charts, planRoute's
 * route is never more than 5 % longer than the independent shortest path
 * INSIDE THE CORRIDOR — "keep 100 ft from shallows" outside marked channels
 * (inside them the independent search is held only to the 3 m the planner
 * never goes below: a lower bound). Where no path keeps the corridor the
 * planner keeps the most it can, and the bound is the path on the least
 * margin it ever keeps. And every leg the plan does not flag `narrow` keeps
 * the corridor, measured on the independent raster. The pairs were drawn at random (seeded) from water deep
 * enough for the boat at both ends, 1.2–6 km apart, and pinned here so the
 * test is reproducible; a few structured ones cross the ship channel and
 * round Atkinson Island, where the channel preference used to add 34 %.
 */
const PAIRS: [string, ChartFeatures, [number, number, number, number, number, number]][] = [
  ...(
    [
      [29.36671, -94.82554, 29.35563, -94.79528, 1.5, 30],
      [29.3806, -94.7967, 29.33902, -94.77221, 0.9, 15],
      [29.35735, -94.79102, 29.37699, -94.79215, 2.5, 5],
      [29.35583, -94.78177, 29.37919, -94.80709, 1.2, 30],
      [29.35165, -94.79313, 29.30853, -94.81109, 1.5, 30],
      [29.30887, -94.80247, 29.33001, -94.77611, 2.5, 5],
      [29.3115, -94.79, 29.37, -94.82, 1.5, 30],
      [29.3724, -94.8064, 29.3147, -94.785, 1.5, 30],
    ] as const
  ).map((p) => ['Galveston', galveston, [...p]] as [string, ChartFeatures, [number, number, number, number, number, number]]),
  ...(
    [
      [29.63577, -94.92943, 29.61958, -94.96167, 1.5, 30],
      [29.61578, -94.96419, 29.57778, -94.99283, 0.9, 15],
      [29.62452, -94.90979, 29.5887, -94.89404, 1.2, 30],
      [29.64403, -94.88794, 29.64996, -94.92831, 0.6, 5],
      [29.56917, -94.99644, 29.59427, -94.95014, 0.6, 5],
      [29.69, -94.99, 29.6135, -94.99, 1.5, 30],
    ] as const
  ).map((p) => ['upper bay', upper, [...p]] as [string, ChartFeatures, [number, number, number, number, number, number]]),
]

describe('planRoute is within 5 % of an independent shortest path inside the corridor', () => {
  const cases = PAIRS.map(([name, f, p]) => [name, p.join(', '), f, p] as const)
  it.each(cases)('%s: %s', (_name, _text, f, [aLat, aLon, bLat, bLon, safeDepthM, clearanceM]) => {
    const from = { lat: aLat, lon: aLon }
    const to = { lat: bLat, lon: bLon }
    const ind =
      independentShortest(f, from, to, { safeDepthM, clearanceM, marginOutM: DEFAULT_SHALLOW_MARGIN_M }) ??
      independentShortest(f, from, to, { safeDepthM, clearanceM })
    expect(ind).not.toBeNull()
    const plan = planRoute({ from, to, safeDepthM, clearanceM, speedKn: 20, features: f })
    expect(plan.source).toBe('charted')
    expect(depthViolations(plan, f, safeDepthM)).toEqual([])
    expect((plan.totalNM * NM) / ind!.lengthM).toBeLessThanOrEqual(1.05)
    // The corridor, leg by leg, outside channels and the ends' 130 m.
    const field = shoalDistanceField(f, plan.points, safeDepthM)
    const start = plan.points[0]
    const end = plan.points[plan.points.length - 1]
    const far = (p: LatLon, q: LatLon) =>
      Math.hypot((p.lat - q.lat) * 111_000, (p.lon - q.lon) * 96_800) > 130
    plan.legs.forEach((leg, li) => {
      if (leg.caution !== 'ok') return
      const want = (leg.narrow ? MIN_DEPTH_MARGIN_M : DEFAULT_SHALLOW_MARGIN_M) - 3
      const n = Math.max(1, Math.ceil((leg.lengthNM * NM) / 10))
      for (let k = 0; k <= n; k++) {
        const p = {
          lat: leg.from.lat + ((leg.to.lat - leg.from.lat) * k) / n,
          lon: leg.from.lon + ((leg.to.lon - leg.from.lon) * k) / n,
        }
        if (!far(p, start) || !far(p, end)) continue
        const r = field(p)
        if (r.inChannel || !Number.isFinite(r.distM)) continue
        expect(r.distM, `leg ${li + 1} at ${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).toBeGreaterThanOrEqual(want)
      }
    })
  })
})
