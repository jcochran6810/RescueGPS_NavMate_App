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

import { planningBounds } from '@/lib/routing'
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
