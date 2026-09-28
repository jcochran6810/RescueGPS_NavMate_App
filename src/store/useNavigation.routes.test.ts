import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ChartFeatures, Ring, RoutePlan } from '@/lib/routing'
import type { Fix } from '@/lib/types'
import type { Vessel } from '@/lib/vessel'
import type { LatLon } from '@/lib/search'
import { metersPerDegree } from '@/lib/geo'

/*
 * Route options, saved routes and the ETA choice (2026-09-28), through the
 * navigation store wired to the REAL router — the harness is the one in
 * useNavigation.router.test.ts (a synthetic chart, one boat).
 *
 * (Original harness notes follow.) The navigation store wired to the REAL router.
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

import { useChartData } from '@/store/useChartData'
import { useTracker } from '@/store/useTracker'
import { useNavigation } from '@/store/useNavigation'
import { useVessels as realVessels } from '@/store/useVessels'

// The mock above holds the boat as `boat`.
const useVessels = realVessels as unknown as { setState: (p: { boat: Vessel | null }) => void }

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
  useVessels.setState({ boat: BOAT })
})

afterEach(() => {
  vi.restoreAllMocks()
})


/* A shoal, 1 m, across the direct line: the boat needs 0.9 + 0.6 = 1.5 m. The
 * way round its end keeps every rule; straight over it is shorter. */
function shoalAcross(): ChartFeatures {
  return sea({
    depthAreas: [
      { minDepthM: 10, rings: [rect(-12000, -12000, 12000, 12000)] },
      { minDepthM: 1, rings: [rect(-900, -60, 900, 60)] },
    ],
  })
}

async function withAlternates(): Promise<void> {
  chart.features = shoalAcross()
  await useNavigation.getState().setDestination(DEST, null)
  await vi.waitFor(() => expect(useNavigation.getState().routes).not.toBeNull(), { timeout: 20_000 })
}

describe('route options', () => {
  it('offers the shorter way over the shoal beside the route that keeps every rule — never switched to it', async () => {
    await withAlternates()
    const s = useNavigation.getState()
    expect(s.status).toBe('preview')
    expect(s.routeIdx).toBe(0)
    expect(s.plan).toBe(s.routes![0].plan)
    expect(s.plan?.source).toBe('charted')
    const alt = s.routes![1]
    expect(alt.plan.source).toBe('best-effort')
    expect(alt.plan.totalNM).toBeLessThan(s.plan!.totalNM)
    expect(alt.shorterNM).toBeCloseTo(s.plan!.totalNM - alt.plan.totalNM, 6)
    expect(alt.reasons.some((r) => r.kind === 'shallow')).toBe(true)
    expect(alt.label).toMatch(/^Shallow /)
  })

  it('selecting a rule-bending route asks "I understand" again, every time it is chosen', async () => {
    await withAlternates()
    useNavigation.getState().selectRoute(1)
    let s = useNavigation.getState()
    expect(s.routeIdx).toBe(1)
    expect(s.plan).toBe(s.routes![1].plan)
    expect(s.confirmed).toBe(false)
    expect(useNavigation.getState().start()).toBe(false)
    useNavigation.getState().confirmBestEffort()
    expect(useNavigation.getState().confirmed).toBe(true)
    // Back to Route 1 and over to Route 2 again: the confirmation is gone.
    useNavigation.getState().selectRoute(0)
    useNavigation.getState().selectRoute(1)
    expect(useNavigation.getState().confirmed).toBe(false)
    expect(useNavigation.getState().start()).toBe(false)
    useNavigation.getState().confirmBestEffort()
    expect(useNavigation.getState().start()).toBe(true)
    s = useNavigation.getState()
    expect(s.status).toBe('navigating')
    // Steering: the choice is made; selecting does nothing.
    useNavigation.getState().selectRoute(0)
    expect(useNavigation.getState().routeIdx).toBe(1)
  })

  it('ignores a route number that is not on offer', async () => {
    await withAlternates()
    const before = useNavigation.getState().plan
    useNavigation.getState().selectRoute(7)
    useNavigation.getState().selectRoute(-1)
    expect(useNavigation.getState().plan).toBe(before)
    expect(useNavigation.getState().routeIdx).toBe(0)
  })
})

describe('opening a saved or shared route', () => {
  it('re-checks it against the chart for the boat now selected: a route that still passes opens as it was', async () => {
    await useNavigation.getState().setDestination(DEST, null)
    const saved = useNavigation.getState().plan as RoutePlan
    useNavigation.getState().clear()
    await useNavigation.getState().openRoute({
      plan: saved,
      dest: DEST,
      origin: { ...SOUTH, label: 'South' },
      name: 'South → North',
    })
    const s = useNavigation.getState()
    expect(s.status).toBe('preview')
    expect(s.plan?.source).toBe('charted')
    expect(s.plan?.points).toEqual(saved.points)
    expect(s.error).toBe('Saved route “South → North” re-checked for Rescue 1: it keeps your depth and stand-off.')
    expect(s.origin).toMatchObject({ label: 'South' })
    expect(s.dest).toMatchObject({ label: 'North' })
  })

  it('a route that no longer keeps this boat’s depth is re-planned, and says why', async () => {
    await useNavigation.getState().setDestination(DEST, null)
    const saved = useNavigation.getState().plan as RoutePlan
    useNavigation.getState().clear()
    // Since it was saved, the chart shows 1 m across the old line.
    chart.features = shoalAcross()
    await useNavigation.getState().openRoute({
      plan: saved,
      dest: DEST,
      origin: { ...SOUTH, label: 'South' },
      name: 'South → North',
    })
    await vi.waitFor(() => expect(useNavigation.getState().status).toBe('preview'), { timeout: 20_000 })
    const s = useNavigation.getState()
    expect(s.error).toMatch(/^Saved route “South → North” re-planned for Rescue 1 — the old route crosses 3(\.\d)? ft\.$/)
    expect(s.plan?.source).toBe('charted')
    expect(s.plan?.points).not.toEqual(saved.points)
    expect(s.plan!.legs.every((l) => l.caution !== 'unsafe-depth')).toBe(true)
  })

  it('a shared route is named as one', async () => {
    await useNavigation.getState().setDestination(DEST, null)
    const saved = useNavigation.getState().plan as RoutePlan
    useNavigation.getState().clear()
    await useNavigation.getState().openRoute({
      plan: saved,
      dest: DEST,
      origin: { ...SOUTH, label: 'South' },
      name: 'From a friend',
      noun: 'Shared route',
    })
    expect(useNavigation.getState().error).toMatch(/^Shared route “From a friend” re-checked for Rescue 1/)
  })

  it('opened before the boats have loaded: re-planned for the boat when it arrives, and says where the route came from', async () => {
    await useNavigation.getState().setDestination(DEST, null)
    const saved = useNavigation.getState().plan as RoutePlan
    useNavigation.getState().clear()
    useVessels.setState({ boat: null })
    await useNavigation.getState().openRoute({
      plan: saved,
      dest: DEST,
      origin: { ...SOUTH, label: 'South' },
      name: 'From a friend',
      noun: 'Shared route',
    })
    // No boat to plan for yet: the router's own words, nothing to steer.
    await vi.waitFor(() => expect(useNavigation.getState().status).toBe('failed'), { timeout: 20_000 })
    expect(useNavigation.getState().error).toMatch(/^Set up your boat first/)
    // The boat list arrives: the engine re-plans for it ('boat'). The crew is
    // still told where the route came from.
    useVessels.setState({ boat: BOAT })
    await useNavigation.getState().replan('boat')
    expect(useNavigation.getState().status).toBe('preview')
    expect(useNavigation.getState().error).toBe('Shared route “From a friend” re-planned for Rescue 1.')
    // A route the crew planned themselves carries no such note.
    await useNavigation.getState().setDestination(DEST, null)
    useVessels.setState({ boat: { ...BOAT, draft_m: 1.1 } })
    await useNavigation.getState().replan('boat')
    expect(useNavigation.getState().error).toBeNull()
  })
})
