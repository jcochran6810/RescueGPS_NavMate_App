import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ChartFeatures, Ring } from '@/lib/routing'
import { DETAIL_HALF_NM } from '@/lib/chart'
import type { Fix } from '@/lib/types'
import type { Vessel } from '@/lib/vessel'
import type { LatLon } from '@/lib/search'
import { metersPerDegree } from '@/lib/geo'

/*
 * The navigation store wired to the REAL router.
 *
 * useNavigation.test.ts replaces `planRoute` to pin the store's sequencing;
 * this file keeps it, and replaces only the chart service (with a synthetic
 * chart) and the boat, so what is checked is the join: the request the store
 * makes, and what it does with each kind of plan the router really returns —
 * charted, best-effort and none.
 */

const mem = vi.hoisted(() => {
  const m = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
  return m
})

const chart = vi.hoisted(() => ({ features: null as unknown }))

vi.mock('@/store/useChartData', async () => {
  const { create } = await import('zustand')
  const useChartData = create(() => ({
    status: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
    error: null as string | null,
    // What is in memory: the synthetic chart once it has been "loaded".
    features: { depthAreas: [], channels: [], land: [], hazards: [], lines: [], coverage: 'none' } as ChartFeatures,
    covers: () => false,
    holds: () => false,
    load: vi.fn(async (bounds: unknown, opts?: { detailAround?: LatLon[] }) => {
      const f = (
        typeof chart.features === 'function'
          ? (chart.features as (b: unknown, d: LatLon[]) => ChartFeatures)(bounds, opts?.detailAround ?? [])
          : chart.features
      ) as ChartFeatures
      useChartData.setState({ features: f })
      return f
    }),
  }))
  return { useChartData }
})

const BOAT = vi.hoisted((): Vessel => ({
  id: 'boat-1',
  client_id: 'boat-1',
  user_id: 'u1',
  team_id: null,
  name: 'Rescue 1',
  callsign: '',
  draft_m: 0.9,
  air_draft_m: 3,
  beam_m: 2.6,
  length_m: 7.6,
  cruise_speed_kn: 20,
  max_speed_kn: 35,
  fuel_burn_gph: 0,
  under_keel_margin_m: 0.6,
  clearance_m: 30,
  created_at: '',
  updated_at: '',
}))

vi.mock('@/store/useVessels', async () => {
  const { create } = await import('zustand')
  const useVessels = create<{ boat: Vessel | null; active: (t: string | null) => Vessel | null }>(
    (_set, get) => ({
      boat: BOAT,
      active: () => get().boat,
    }),
  )
  return { useVessels }
})

vi.mock('@/store/useTeams', async () => {
  const { create } = await import('zustand')
  return { useTeams: create(() => ({ activeTeamId: null as string | null })) }
})

import { chartStateAt, planningBounds } from '@/lib/routing'
import { loadGalveston } from '@/lib/__fixtures__/galveston'
import { bearingDeg, haversineNM } from '@/lib/geo'
import { steerCourse } from '@/lib/navigate'
import { navCardView, bearingText, navBannerView } from '@/lib/navView'
import { useChartData } from '@/store/useChartData'
import { useTracker } from '@/store/useTracker'
import { useNavigation } from '@/store/useNavigation'

/* ---------------------------------------------------------------- chart */

const BASE_LAT = 29.3
const BASE_LON = -94.8
const MPD = metersPerDegree(BASE_LAT)

function at(x: number, y: number): LatLon {
  return { lat: BASE_LAT + y / MPD.lat, lon: BASE_LON + x / MPD.lon }
}
function ll(x: number, y: number): [number, number] {
  const p = at(x, y)
  return [p.lon, p.lat]
}
function rect(x0: number, y0: number, x1: number, y1: number): Ring {
  return [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)]
}
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
const DEST = { ...NORTH, label: 'North' }

function fixAt(p: LatLon): Fix {
  return {
    lat: p.lat,
    lon: p.lon,
    speed: 5,
    heading: null,
    accuracy: 5,
    altitude: null,
    timestamp: Date.now(),
  }
}

beforeEach(() => {
  mem.clear()
  chart.features = sea()
  vi.mocked(useChartData.getState().load).mockClear()
  useChartData.setState({
    status: 'ready',
    error: null,
    features: { depthAreas: [], channels: [], land: [], hazards: [], lines: [], coverage: 'none' },
  })
  useTracker.setState({
    fix: fixAt(SOUTH),
    watching: true,
    error: null,
    arrivalFt: 200,
    start: vi.fn(),
    once: vi.fn(async () => null),
  })
  useNavigation.getState().clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('navigation store with the real router', () => {
  it('loads the planning box with detail round both ends, and plans a charted route with the arrival setting', async () => {
    await useNavigation.getState().setDestination(DEST, null)
    const s = useNavigation.getState()
    const from = { lat: SOUTH.lat, lon: SOUTH.lon }
    const to = { lat: NORTH.lat, lon: NORTH.lon }
    expect(useChartData.getState().load).toHaveBeenCalledWith(planningBounds(from, to), {
      detailAround: [from, to],
    })
    expect(s.status).toBe('preview')
    expect(s.plan?.source).toBe('charted')
    expect(s.plan?.needsConfirm).toBe(false)
    // The crew's arrival setting reached the router: the ends get it whole.
    expect(s.plan?.arrivalFt[0]).toBe(200)
    expect(s.plan?.arrivalFt[s.plan.arrivalFt.length - 1]).toBe(200)
    expect(useNavigation.getState().start()).toBe(true)
    expect(useNavigation.getState().status).toBe('navigating')
  })

  it('passes a chart band that failed to load through to the plan warnings', async () => {
    chart.features = sea({ coverage: 'partial', failedBands: ['harbour'] })
    await useNavigation.getState().setDestination(DEST, null)
    const s = useNavigation.getState()
    expect(s.status).toBe('preview')
    expect(s.plan?.warnings.some((w) => /harbour chart could not be loaded/.test(w))).toBe(true)
  })

  it('fails with the router’s own words, and nothing to steer, when there is no honest route', async () => {
    // The start is deep inside land: no water within 400 m of it.
    chart.features = sea({ land: [{ rings: [rect(-2000, -3000, 2000, -500)] }] })
    useTracker.setState({ fix: fixAt(at(0, -1750)) })
    await useNavigation.getState().setDestination(DEST, null)
    const s = useNavigation.getState()
    expect(s.status).toBe('failed')
    expect(s.plan?.source).toBe('none')
    expect(s.plan?.points).toEqual([])
    expect(s.error).toBe(s.plan?.failure)
    expect(s.error).toMatch(/start/i)
    expect(useNavigation.getState().start()).toBe(false)
    expect(useNavigation.getState().status).toBe('failed')
  })

  it('will not steer a best-effort route until the crew confirms it', async () => {
    // 0.5 m of water right across the chart: no route keeps 1.5 m.
    chart.features = sea({
      depthAreas: [
        { minDepthM: 10, rings: [rect(-12000, -12000, 12000, 12000)] },
        { minDepthM: 0.5, rings: [rect(-12000, -40, 12000, 40)] },
      ],
    })
    await useNavigation.getState().setDestination(DEST, null)
    let s = useNavigation.getState()
    expect(s.status).toBe('preview')
    expect(s.plan?.source).toBe('best-effort')
    expect(s.plan?.legs.some((l) => l.caution === 'unsafe-depth')).toBe(true)
    expect(useNavigation.getState().start()).toBe(false)
    expect(useNavigation.getState().status).toBe('preview')
    useNavigation.getState().confirmBestEffort()
    expect(useNavigation.getState().start()).toBe(true)
    s = useNavigation.getState()
    expect(s.status).toBe('navigating')
  })

  it('says so on screen when the chart puts the boat in water too shallow for it, on or off the line (voyage-1)', async () => {
    // A 1 m shoal 30 m east of the line: a boat 30 m off it is inside the
    // 60 m off-course threshold, and aground on the chart.
    chart.features = sea({
      depthAreas: [
        { minDepthM: 10, rings: [rect(-12000, -12000, 12000, 12000)] },
        { minDepthM: 1, rings: [rect(25, -300, 200, 300)] },
      ],
    })
    await useNavigation.getState().setDestination(DEST, null)
    expect(useNavigation.getState().plan?.source).toBe('charted')
    expect(useNavigation.getState().start()).toBe(true)
    useNavigation.getState().onFix(fixAt(at(0, 0)))
    expect(useNavigation.getState().shallowHere).toBeNull()
    useNavigation.getState().onFix(fixAt(at(40, 10)))
    const s = useNavigation.getState()
    expect(s.offCourseSince).toBeNull()
    expect(s.shallowHere).toEqual({ depthM: 1, land: false })
    // Back over deep water, it goes away.
    useNavigation.getState().onFix(fixAt(at(0, 20)))
    expect(useNavigation.getState().shallowHere).toBeNull()
  })

  it('says "slow down" when the fix is poorer than the margin AND the shallows are that close to the line ahead (F3)', async () => {
    // A 1 m shoal 25 m east of the line, 100–500 m ahead of the boat.
    chart.features = sea({
      depthAreas: [
        { minDepthM: 10, rings: [rect(-12000, -12000, 12000, 12000)] },
        { minDepthM: 1, rings: [rect(25, -1100, 200, -700)] },
      ],
    })
    await useNavigation.getState().setDestination(DEST, null)
    expect(useNavigation.getState().plan?.source).toBe('charted')
    expect(useNavigation.getState().start()).toBe(true)
    const here = at(0, -1200)
    // ±4 m: good enough for the boat's margins — no alarm.
    useNavigation.getState().onFix({ ...fixAt(here), accuracy: 4 })
    expect(useNavigation.getState().gpsSlow).toBe(false)
    // ±20 m: poorer than the margin, and the shoal is within 1.6 × 20 m of
    // the line ahead — slow down.
    useNavigation.getState().onFix({ ...fixAt(here), accuracy: 20, timestamp: Date.now() + 1 })
    expect(useNavigation.getState().gpsSlow).toBe(true)
    // Past the shoal, open water ahead: it goes away.
    useNavigation.getState().onFix({ ...fixAt(at(0, 0)), accuracy: 20, timestamp: Date.now() + 2 })
    expect(useNavigation.getState().gpsSlow).toBe(false)
  })

  it('says the boat MAY be in the shallows when they lie within its GPS error (M1, drift 109)', async () => {
    // The same shoal, 25 m east of the line. A fix 13 m off the line is in
    // deep water — but claiming ±18 m, the boat may be on the shoal.
    chart.features = sea({
      depthAreas: [
        { minDepthM: 10, rings: [rect(-12000, -12000, 12000, 12000)] },
        { minDepthM: 1, rings: [rect(25, -300, 200, 300)] },
      ],
    })
    await useNavigation.getState().setDestination(DEST, null)
    expect(useNavigation.getState().start()).toBe(true)
    useNavigation.getState().onFix({ ...fixAt(at(13, 0)), accuracy: 5 })
    expect(useNavigation.getState().shallowHere).toBeNull()
    useNavigation.getState().onFix({ ...fixAt(at(13, 10)), accuracy: 18 })
    expect(useNavigation.getState().shallowHere).toEqual({ depthM: 1, land: false, maybe: true })
    useNavigation.getState().onFix({ ...fixAt(at(0, 20)), accuracy: 5 })
    expect(useNavigation.getState().shallowHere).toBeNull()
  })

  it('pauses steering for a deeper boat the route cannot be made safe for, with no signal to download (R1)', async () => {
    // 3 m across the middle: fine for the 1.5 m boat, not for a 3.5 m one.
    chart.features = sea({
      depthAreas: [
        { minDepthM: 10, rings: [rect(-12000, -12000, 12000, 12000)] },
        { minDepthM: 3, rings: [rect(-12000, -200, 12000, 200)] },
      ],
    })
    await useNavigation.getState().setDestination(DEST, null)
    expect(useNavigation.getState().start()).toBe(true)
    // No signal now: the re-plan's download fails.
    vi.mocked(useChartData.getState().load).mockRejectedValueOnce(new Error('Failed to fetch'))
    const { useVessels } = await import('@/store/useVessels')
    ;(useVessels as unknown as { setState: (p: object) => void }).setState({
      boat: { ...BOAT, draft_m: 3, under_keel_margin_m: 0.5 },
    })
    await useNavigation.getState().replan('boat')
    const s = useNavigation.getState()
    expect(s.status).toBe('preview')
    expect(s.reconfirm).toBe(true)
    expect(s.plan?.source).toBe('best-effort')
    expect(s.plan?.legs.some((l) => l.caution === 'unsafe-depth' && !l.unverified)).toBe(true)
  })

  it('plans the middle of a long passage on the harbour chart too, not the coastal chart’s 0 m (R6)', async () => {
    // The coastal band reads the whole bay as 0 m (as at Galveston); the
    // harbour band knows it is 9 m — but it is only ever read in the detail
    // boxes asked for. Round the two ends alone, the middle is 0 m.
    const half = DETAIL_HALF_NM * 1852
    chart.features = (_b: unknown, around: LatLon[]) =>
      sea({
        depthAreas: [
          { minDepthM: 0, level: 3, rings: [rect(-40000, -40000, 40000, 40000)] },
          ...around.map((p) => {
            const x = (p.lon - BASE_LON) * MPD.lon
            const y = (p.lat - BASE_LAT) * MPD.lat
            return { minDepthM: 9, level: 5, rings: [rect(x - half, y - half, x + half, y + half)] }
          }),
        ],
      })
    const from = at(0, -9000)
    const to = { ...at(0, 9000), label: 'Up the bay' }
    useTracker.setState({ fix: fixAt(from) })
    await useNavigation.getState().setDestination(to, null)
    const s = useNavigation.getState()
    const load = vi.mocked(useChartData.getState().load)
    expect(load).toHaveBeenCalledTimes(2)
    expect((load.mock.calls[1][1] as { detailAround: LatLon[] }).detailAround.length).toBeGreaterThan(3)
    expect(s.status).toBe('preview')
    expect(s.plan?.source).toBe('charted')
    expect(s.chartLoads).toHaveLength(2)
  }, 30_000)
})

/* ---------------------------------------------------------------- C1 */

/*
 * C1 (final check, critical): on the real Galveston chart, a boat captured
 * 20 m off the inbound leg, 164 ft short of a 46° turn, was switched to the
 * next waypoint — and the straight line from there to it crosses charted land
 * about 156 m on. The crew decided: keep switching at the 100–200 ft setting,
 * and guard the shortcut. These are the exact reproduction coordinates.
 */
describe('C1 — round the turn point first, on the Galveston chart', () => {
  const galveston = loadGalveston()
  const FROM = { lat: 29.347584785882166, lon: -94.7858192104062 }
  const TO = { lat: 29.323058449566364, lon: -94.82876315772812, label: 'C1 end' }
  const C1_FIX = { lat: 29.312188, lon: -94.820793 }
  const SAFE_M = 0.6

  function fix(p: LatLon, t: number, heading: number): Fix {
    return { lat: p.lat, lon: p.lon, accuracy: 5, heading, speed: 6, altitude: null, timestamp: t }
  }
  /** What the chart shows along a line: the shoalest depth, or -1 for land. */
  function shoalestAlong(a: LatLon, b: LatLon): number {
    const n = Math.ceil(haversineNM(a.lat, a.lon, b.lat, b.lon) * 1852)
    let min = Infinity
    for (let k = 0; k <= n; k++) {
      const s = chartStateAt(galveston, {
        lat: a.lat + ((b.lat - a.lat) * k) / n,
        lon: a.lon + ((b.lon - a.lon) * k) / n,
      })
      if (s === 'land') return -1
      if (typeof s === 'number') min = Math.min(min, s)
    }
    return min
  }
  const card = (f: Fix) => {
    const s = useNavigation.getState()
    return navCardView({
      plan: s.plan!,
      status: 'navigating',
      targetIdx: s.targetIdx,
      roundIdx: s.roundIdx,
      fix: f,
      now: f.timestamp,
      speedKn: 12,
      cruiseKn: 12,
      arrivalFt: 200,
      bearingPref: 'true',
      declination: null,
      gpsPoor: false,
      rerouting: false,
      offCourseSince: null,
    })
  }

  it('switches at the setting, refuses the unsafe shortcut, and keeps the turn-point bearing until the line is clear', async () => {
    const { useVessels } = await import('@/store/useVessels')
    const vessels = useVessels as unknown as { setState: (p: object) => void }
    vessels.setState({
      boat: { ...BOAT, draft_m: 0.3, under_keel_margin_m: 0.3, clearance_m: 5, cruise_speed_kn: 12 },
    })
    try {
      chart.features = galveston
      useTracker.setState({ fix: fixAt(FROM), arrivalFt: 200 })
      await useNavigation.getState().setDestination(TO, null)
      const plan = useNavigation.getState().plan!
      expect(plan.source).toBe('charted')
      expect(plan.points).toHaveLength(13)
      const WP10 = plan.points[10]
      const WP11 = plan.points[11]
      expect(haversineNM(WP10.lat, WP10.lon, 29.312031, -94.821277) * 1852).toBeLessThan(3)
      // Every point keeps the crew's 200 ft — no circle shrunk for the turn.
      expect(plan.arrivalFt.every((r) => r === 200)).toBe(true)

      expect(useNavigation.getState().start()).toBe(true)
      useNavigation.setState({ targetIdx: 10, resume: false, roundIdx: null })

      // The reproduction: 164 ft from WP10, 20 m right of the inbound leg.
      let t = Date.now()
      const f0 = fix(C1_FIX, t, 273)
      expect(haversineNM(f0.lat, f0.lon, WP10.lat, WP10.lon) * 6076.12).toBeCloseTo(164, 0)
      // The straight line from there to WP11 really does cross charted land.
      expect(shoalestAlong(f0, WP11)).toBe(-1)
      useNavigation.getState().onFix(f0)
      let s = useNavigation.getState()
      // Switched at the setting (164 ft is inside 200 ft)…
      expect(s.targetIdx).toBe(11)
      // …but the shortcut is refused: round WP10 first.
      expect(s.roundIdx).toBe(10)
      let v = card(f0)
      expect(v.title).toBe('Round waypoint 10 first — don’t cut the corner')
      expect(v.rounding).toBe(true)
      // Behaviour change (F4): the big number is now the course to steer —
      // back onto the leg into WP10, not a fresh straight line to it — and
      // the bearing to the point itself (rule 4) is `pointBearing`.
      expect(v.pointBearing).toBe(bearingText(bearingDeg(f0.lat, f0.lon, WP10.lat, WP10.lon), 'true', null))
      expect(v.bearing).toBe(bearingText(steerCourse(plan, 10, f0)!.bearingDeg, 'true', null))
      expect(v.notices.some((n) => n.kind === 'round-first')).toBe(true)
      expect(navBannerView(v).primary.startsWith('Round WP 10 first')).toBe(true)
      // The distance to go still counts via the turn point.
      let rem = haversineNM(f0.lat, f0.lon, WP10.lat, WP10.lon)
      for (let i = 10; i < 12; i++) {
        rem += haversineNM(plan.points[i].lat, plan.points[i].lon, plan.points[i + 1].lat, plan.points[i + 1].lon)
      }
      expect(v.remaining).toBe(`${rem.toFixed(2)} NM`)

      // Steer for WP10, 5 m a fix, until the card lets the boat go on.
      let p: LatLon = f0
      let cleared: LatLon | null = null
      for (let k = 0; k < 40 && !cleared; k++) {
        const brg = bearingDeg(p.lat, p.lon, WP10.lat, WP10.lon)
        const d = haversineNM(p.lat, p.lon, WP10.lat, WP10.lon) * 1852
        const step = Math.min(5, d)
        p = {
          lat: p.lat + ((WP10.lat - p.lat) * step) / Math.max(d, 1e-9),
          lon: p.lon + ((WP10.lon - p.lon) * step) / Math.max(d, 1e-9),
        }
        t += 1000
        const f = fix(p, t, brg)
        useNavigation.getState().onFix(f)
        s = useNavigation.getState()
        // One turn at a time: nothing moves on past WP11 meanwhile.
        expect(s.targetIdx).toBe(11)
        v = card(f)
        if (s.roundIdx === 10) {
          // Still the turn point's bearing, however close to it (F4: shown as
          // the point's bearing; the course steers along the leg into it).
          expect(v.pointBearing).toBe(bearingText(bearingDeg(f.lat, f.lon, WP10.lat, WP10.lon), 'true', null))
          expect(v.targetIdx).toBe(10)
        } else {
          expect(s.roundIdx).toBeNull()
          cleared = p
          // The line it now steers is clear of land and deep enough.
          expect(shoalestAlong(f, WP11)).toBeGreaterThanOrEqual(SAFE_M)
          expect(v.title).toBe('To waypoint 11 of 12')
          expect(v.pointBearing).toBe(bearingText(bearingDeg(f.lat, f.lon, WP11.lat, WP11.lon), 'true', null))
        }
      }
      expect(cleared).not.toBeNull()

      // On along the leg, it stays on WP11 — no return to rounding.
      for (let k = 1; k <= 5; k++) {
        t += 1000
        const q = {
          lat: cleared!.lat + ((WP11.lat - cleared!.lat) * k) / 20,
          lon: cleared!.lon + ((WP11.lon - cleared!.lon) * k) / 20,
        }
        useNavigation.getState().onFix(fix(q, t, bearingDeg(q.lat, q.lon, WP11.lat, WP11.lon)))
        expect(useNavigation.getState().roundIdx).toBeNull()
        expect(useNavigation.getState().targetIdx).toBe(11)
      }
    } finally {
      vessels.setState({ boat: BOAT })
    }
  }, 30_000)

  it('a GPS jump past the turn cannot leave the boat steering over land: every fix re-checks the line (F1/F2)', async () => {
    const { useVessels } = await import('@/store/useVessels')
    const vessels = useVessels as unknown as { setState: (p: object) => void }
    vessels.setState({
      boat: { ...BOAT, draft_m: 0.3, under_keel_margin_m: 0.3, clearance_m: 5, cruise_speed_kn: 12 },
    })
    try {
      chart.features = galveston
      useTracker.setState({ fix: fixAt(FROM), arrivalFt: 200 })
      await useNavigation.getState().setDestination(TO, null)
      const plan = useNavigation.getState().plan!
      expect(useNavigation.getState().start()).toBe(true)
      useNavigation.setState({ targetIdx: 10, resume: false, roundIdx: null })
      const WP10 = plan.points[10]
      const WP11 = plan.points[11]
      // The re-check's spike: a fix 30 m past WP10 on the leg out (319°).
      const th = (319 * Math.PI) / 180
      const spike = { lat: WP10.lat + (30 * Math.cos(th)) / 110860, lon: WP10.lon + (30 * Math.sin(th)) / 96990 }
      let t = Date.now()
      useNavigation.getState().onFix(fix(spike, t, 319))
      let s = useNavigation.getState()
      // On the leg out, the line on is clear: switched, nothing to round.
      expect(s.targetIdx).toBe(11)
      expect(s.roundIdx).toBeNull()
      // The next fix is the truth: 164 ft short of WP10, 20 m off the leg
      // in. The line from there to WP11 crosses land — so the card goes back
      // to the turn point, rather than steering on over the land.
      t += 1000
      const f1 = fix(C1_FIX, t, 273)
      expect(shoalestAlong(f1, WP11)).toBe(-1)
      useNavigation.getState().onFix(f1)
      s = useNavigation.getState()
      expect(s.targetIdx).toBe(11)
      expect(s.roundIdx).toBe(10)
      expect(card(f1).title).toBe('Round waypoint 10 first — don’t cut the corner')
    } finally {
      vessels.setState({ boat: BOAT })
    }
  }, 30_000)

  it('seed 5 (F2): a ±20 m fix 50 ft short of the turn is not "at" it — the boat must get round it', async () => {
    const { useVessels } = await import('@/store/useVessels')
    const vessels = useVessels as unknown as { setState: (p: object) => void }
    vessels.setState({
      boat: { ...BOAT, draft_m: 0.3, under_keel_margin_m: 0.3, clearance_m: 30, cruise_speed_kn: 7.35 },
    })
    try {
      chart.features = galveston
      const S5_FROM = { lat: 29.36348, lon: -94.827029 }
      const S5_TO = { lat: 29.387957, lon: -94.830768, label: 'seed 5' }
      useTracker.setState({ fix: fixAt(S5_FROM), arrivalFt: 200 })
      await useNavigation.getState().setDestination(S5_TO, null)
      const plan = useNavigation.getState().plan!
      expect(plan.source).toBe('charted')
      expect(useNavigation.getState().start()).toBe(true)
      // The turn the re-check grounded at: WP3 → WP4, 75° to port.
      const W2 = plan.points[2]
      const W3 = plan.points[3]
      const W4 = plan.points[4]
      expect(haversineNM(W3.lat, W3.lon, 29.3634, -94.8091) * 1852).toBeLessThan(30)
      useNavigation.setState({ targetIdx: 3, resume: false, roundIdx: null })
      const d = haversineNM(W2.lat, W2.lon, W3.lat, W3.lon) * 6076.12
      const at = (ftShort: number) => {
        const k = (d - ftShort) / d
        return { lat: W2.lat + (W3.lat - W2.lat) * k, lon: W2.lon + (W3.lon - W2.lon) * k }
      }
      const hdg = bearingDeg(W2.lat, W2.lon, W3.lat, W3.lon)
      const poor = (p: LatLon, t: number): Fix => ({ ...fix(p, t, hdg), accuracy: 20, speed: 3.8 })
      let t = Date.now()
      useNavigation.getState().onFix(poor(at(190), t))
      let s = useNavigation.getState()
      expect(s.targetIdx).toBe(4)
      // The line from 190 ft short of WP3 to WP4, with 1.6 × 20 m added to
      // the 30 m stand-off, is not clear: round WP3 first.
      expect(s.roundIdx).toBe(3)
      // 50 ft short: once "at the turn" for a ±20 m fix (its error widened
      // the 30 ft to 60 ft). Now it must get round the turn itself.
      t += 1000
      useNavigation.getState().onFix(poor(at(50), t))
      s = useNavigation.getState()
      expect(s.roundIdx).toBe(3)
      // Past WP3 on the way out: round, whatever the line check says.
      t += 1000
      const past = {
        lat: W3.lat + (W4.lat - W3.lat) * 0.02,
        lon: W3.lon + (W4.lon - W3.lon) * 0.02,
      }
      useNavigation.getState().onFix({ ...poor(past, t), heading: bearingDeg(W3.lat, W3.lon, W4.lat, W4.lon) })
      expect(useNavigation.getState().roundIdx).toBeNull()
    } finally {
      vessels.setState({ boat: BOAT })
    }
  }, 30_000)

  it('lets a boat on the line go straight on at the switch', async () => {
    const { useVessels } = await import('@/store/useVessels')
    const vessels = useVessels as unknown as { setState: (p: object) => void }
    vessels.setState({
      boat: { ...BOAT, draft_m: 0.3, under_keel_margin_m: 0.3, clearance_m: 5, cruise_speed_kn: 12 },
    })
    try {
      chart.features = galveston
      useTracker.setState({ fix: fixAt(FROM), arrivalFt: 200 })
      await useNavigation.getState().setDestination(TO, null)
      const plan = useNavigation.getState().plan!
      expect(useNavigation.getState().start()).toBe(true)
      // Waypoint 3 → 4 is a shallow turn in open water: 190 ft short of
      // WP3, on the inbound leg, the line on to WP4 is clear.
      useNavigation.setState({ targetIdx: 3, resume: false, roundIdx: null })
      const a = plan.points[2]
      const b = plan.points[3]
      const d = haversineNM(a.lat, a.lon, b.lat, b.lon) * 6076.12
      const k = (d - 190) / d
      const p = { lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k }
      useNavigation.getState().onFix(fix(p, Date.now(), bearingDeg(a.lat, a.lon, b.lat, b.lon)))
      const s = useNavigation.getState()
      expect(s.targetIdx).toBe(4)
      expect(s.roundIdx).toBeNull()
    } finally {
      vessels.setState({ boat: BOAT })
    }
  }, 30_000)
})
