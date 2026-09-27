import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { RoutePlan, RouteRequest } from '@/lib/routing'
import type { ChartFeatures } from '@/lib/routing'
import type { Fix } from '@/lib/types'
import type { Vessel } from '@/lib/vessel'
import type { LatLon } from '@/lib/search'
import { projectPosition } from '@/lib/sar'

/*
 * Node has no localStorage; persist needs one to be tested at all. Installed
 * before any store module is imported.
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

/* ---------------------------------------------------------------- mocks
 * The router and the chart service are replaced: this file tests the
 * store's sequencing, gates and timing, not routing. Each chart load can be
 * held open to pin what happens when plans overlap.
 */

const BOX = { minLat: 29, minLon: -95, maxLat: 30, maxLon: -94 }

vi.mock('@/lib/routing', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/routing')>()
  return {
    ...real,
    planningBounds: vi.fn(() => BOX),
    planRoute: vi.fn(),
  }
})

const loads: { release: (f?: ChartFeatures) => void; opts: unknown; bounds: unknown }[] = []
let autoRelease = true
const FEATURES: ChartFeatures = {
  depthAreas: [],
  channels: [],
  land: [],
  hazards: [],
  lines: [],
  coverage: 'full',
}

vi.mock('@/store/useChartData', async () => {
  const { create } = await import('zustand')
  const useChartData = create(() => ({
    status: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
    error: null as string | null,
    load: vi.fn(
      (bounds: unknown, opts: unknown) =>
        new Promise<ChartFeatures>((resolve) => {
          const call = { bounds, opts, release: (f?: ChartFeatures) => resolve(f ?? FEATURES) }
          loads.push(call)
          if (autoRelease) call.release()
        }),
    ),
  }))
  return { useChartData }
})

const BOAT: Vessel = {
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
}

vi.mock('@/store/useVessels', async () => {
  const { create } = await import('zustand')
  const useVessels = create<{ boat: Vessel | null; active: (t: string | null) => Vessel | null }>(
    (_set, get) => ({
      boat: null,
      active: () => get().boat,
    }),
  )
  return { useVessels }
})

vi.mock('@/store/useTeams', async () => {
  const { create } = await import('zustand')
  return { useTeams: create(() => ({ activeTeamId: null as string | null })) }
})

import { planningBounds, planRoute } from '@/lib/routing'
import { useChartData } from '@/store/useChartData'
import { useVessels } from '@/store/useVessels'
import { useTracker } from '@/store/useTracker'
import {
  NAV_STORAGE_KEY,
  OFF_COURSE_HOLD_MS,
  REROUTE_MIN_GAP_MS,
  partializeNav,
  useNavigation,
} from '@/store/useNavigation'
import { SETTINGS_SETTLE_MS, startNavigationEngine } from '@/hooks/useNavigationEngine'

const planRouteMock = vi.mocked(planRoute)
/** The mock vessel store: one boat, chosen or not. */
const setBoat = (boat: Vessel | null) =>
  (useVessels as unknown as { setState: (p: { boat: Vessel | null }) => void }).setState({ boat })

/* -------------------------------------------------------------- helpers */

const T0 = Date.UTC(2026, 8, 26, 14, 0, 0)
const go = (p: LatLon, deg: number, nm: number) => projectPosition(p.lat, p.lon, deg, nm)
const m = (n: number) => n / 1852

const A = { lat: 29.3115, lon: -94.79 }
const B = go(A, 0, 1)
const C = go(B, 90, 1)
const DEST = { ...C, label: 'Galveston Bay' }

function mkPlan(points: LatLon[], over: Partial<RoutePlan> = {}): RoutePlan {
  return {
    points,
    legs: [],
    totalNM: 2,
    hours: 0.1,
    source: 'charted',
    coverage: 'full',
    warnings: [],
    movedStart: null,
    movedEnd: null,
    outsideChannelNM: null,
    arrivalFt: points.map(() => 150),
    failure: null,
    needsConfirm: false,
    ...over,
  }
}

function fixAt(p: LatLon, over: Partial<Fix> = {}): Fix {
  return {
    lat: p.lat,
    lon: p.lon,
    speed: 5,
    heading: null,
    accuracy: 5,
    altitude: null,
    timestamp: Date.now(),
    ...over,
  }
}

/** Let the store's async planning run to its next real wait. */
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

const trackerStart = vi.fn()
const trackerOnce = vi.fn(async (): Promise<Fix | null> => null)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(T0)
  mem.clear()
  loads.length = 0
  autoRelease = true
  planRouteMock.mockReset()
  // Default: a route from wherever it was asked, via B, to C.
  planRouteMock.mockImplementation((req: RouteRequest) => mkPlan([req.from, B, req.to]))
  vi.mocked(planningBounds).mockClear()
  vi.mocked(useChartData.getState().load).mockClear()
  useChartData.setState({ status: 'ready', error: null })
  setBoat({ ...BOAT })
  trackerStart.mockReset()
  trackerOnce.mockReset()
  trackerOnce.mockResolvedValue(null)
  useTracker.setState({
    fix: fixAt(A),
    watching: false,
    error: null,
    arrivalFt: 150,
    start: trackerStart,
    once: trackerOnce,
  })
  useNavigation.getState().clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Plan to DEST from the live fix at A and start steering. */
async function navigating(plan?: RoutePlan) {
  if (plan) planRouteMock.mockImplementationOnce(() => plan)
  await useNavigation.getState().setDestination(DEST, null)
  expect(useNavigation.getState().start()).toBe(true)
}

/* ---------------------------------------------------------------- planning */

describe('planning', () => {
  it('plans from the live fix for the active boat, on the planning box with detail round both ends', async () => {
    await useNavigation.getState().setDestination(DEST, null)
    const s = useNavigation.getState()
    expect(s.status).toBe('preview')
    expect(s.plan?.points[0]).toEqual({ lat: A.lat, lon: A.lon })
    expect(s.lastPlannedAt).toBe(T0)

    const req = planRouteMock.mock.calls[0][0]
    expect(req.from).toEqual({ lat: A.lat, lon: A.lon })
    expect(req.to).toEqual({ lat: C.lat, lon: C.lon })
    expect(req.safeDepthM).toBeCloseTo(1.5, 9)
    expect(req.clearanceM).toBe(30)
    expect(req.speedKn).toBe(20)
    expect(req.arrivalFt).toBe(150)

    expect(planningBounds).toHaveBeenCalledWith(req.from, req.to)
    const load = vi.mocked(useChartData.getState().load)
    expect(load).toHaveBeenCalledWith(BOX, { detailAround: [req.from, req.to] })
  })

  it('asks the receiver again rather than planning from a stale fix', async () => {
    // "Here" used to be whatever fix was lying around, however old.
    useTracker.setState({ fix: fixAt(A, { timestamp: T0 - 60_000 }) })
    const fresh = fixAt(go(A, 90, 0.3))
    trackerOnce.mockResolvedValueOnce(fresh)
    await useNavigation.getState().setDestination(DEST, null)
    expect(trackerOnce).toHaveBeenCalled()
    expect(planRouteMock.mock.calls[0][0].from).toEqual({ lat: fresh.lat, lon: fresh.lon })
  })

  it('fails in plain words with no GPS fix at all', async () => {
    useTracker.setState({ fix: null })
    await useNavigation.getState().setDestination(DEST, null)
    const s = useNavigation.getState()
    expect(s.status).toBe('failed')
    expect(s.error).toMatch(/GPS/)
    expect(planRouteMock).not.toHaveBeenCalled()
  })

  it('fails without a boat — the draft is what keeps the route safe', async () => {
    setBoat(null)
    await useNavigation.getState().setDestination(DEST, null)
    expect(useNavigation.getState().status).toBe('failed')
    expect(useNavigation.getState().error).toMatch(/boat/)
  })

  it('plans from a start chosen by hand, without the GPS', async () => {
    useTracker.setState({ fix: null })
    const origin = { ...go(A, 270, 1), label: 'Pier 21' }
    await useNavigation.getState().setDestination(DEST, origin)
    expect(planRouteMock.mock.calls[0][0].from).toEqual({ lat: origin.lat, lon: origin.lon })
    expect(useNavigation.getState().status).toBe('preview')
  })

  it('keeps the chosen start when a new destination is given without one', async () => {
    const origin = { ...go(A, 270, 1), label: 'Pier 21' }
    await useNavigation.getState().setDestination(DEST, origin)
    await useNavigation.getState().setDestination({ ...B, label: 'B' })
    expect(useNavigation.getState().origin).toEqual(origin)
    expect(planRouteMock.mock.calls[1][0].from).toEqual({ lat: origin.lat, lon: origin.lon })
  })

  it('reports a route that cannot be drawn as failed, with the router’s reason', async () => {
    planRouteMock.mockImplementationOnce(() =>
      mkPlan([], { source: 'none', failure: 'No water path to the destination.' }),
    )
    await useNavigation.getState().setDestination(DEST, null)
    const s = useNavigation.getState()
    expect(s.status).toBe('failed')
    expect(s.error).toBe('No water path to the destination.')
    expect(s.start()).toBe(false)
  })

  it('says the chart could not be read, rather than "no route"', async () => {
    vi.mocked(useChartData.getState().load).mockImplementationOnce(async () => {
      useChartData.setState({ status: 'error', error: 'No connection' })
      return { ...FEATURES, coverage: 'none' }
    })
    await useNavigation.getState().setDestination(DEST, null)
    expect(useNavigation.getState().status).toBe('failed')
    expect(useNavigation.getState().error).toMatch(/Could not read the chart.*No connection/)
    expect(planRouteMock).not.toHaveBeenCalled()
  })

  it('clears the old route the moment a new destination is asked for', async () => {
    // Defect: while the new plot ran, the OLD route stayed on the screen.
    await useNavigation.getState().setDestination(DEST, null)
    autoRelease = false
    const pending = useNavigation.getState().setDestination({ ...B, label: 'B' })
    await settle()
    expect(useNavigation.getState().status).toBe('planning')
    expect(useNavigation.getState().plan).toBeNull()
    loads.at(-1)!.release()
    await pending
    expect(useNavigation.getState().status).toBe('preview')
  })
})

describe('race guard', () => {
  it('never lets an older plan overwrite a newer one', async () => {
    autoRelease = false
    const first = useNavigation.getState().setDestination(DEST, null)
    await settle()
    const other = { ...go(A, 45, 2), label: 'Somewhere else' }
    const second = useNavigation.getState().setDestination(other, null)
    await settle()
    expect(loads).toHaveLength(2)

    // The newer request answers first…
    loads[1].release()
    await second
    expect(useNavigation.getState().plan?.points.at(-1)).toEqual({ lat: other.lat, lon: other.lon })

    // …and the older one finishing late changes nothing.
    loads[0].release()
    await first
    const s = useNavigation.getState()
    expect(s.dest?.label).toBe('Somewhere else')
    expect(s.plan?.points.at(-1)).toEqual({ lat: other.lat, lon: other.lon })
    expect(planRouteMock).toHaveBeenCalledTimes(1)
  })

  it('drops a plan still running when the route is cleared', async () => {
    autoRelease = false
    const p = useNavigation.getState().setDestination(DEST, null)
    await settle()
    useNavigation.getState().clear()
    loads[0].release()
    await p
    expect(useNavigation.getState().status).toBe('idle')
    expect(useNavigation.getState().plan).toBeNull()
  })
})

/* ------------------------------------------------------------ start gate */

describe('starting', () => {
  it('starts steering at point 1 from the start, and turns the GPS on', async () => {
    await navigating()
    const s = useNavigation.getState()
    expect(s.status).toBe('navigating')
    expect(s.targetIdx).toBe(1)
    expect(s.resume).toBe(false)
    expect(trackerStart).toHaveBeenCalled()
  })

  it('without a fresh fix, guesses point 1 and re-derives it from the first fix', async () => {
    await useNavigation.getState().setDestination(DEST, null)
    useTracker.setState({ fix: null })
    useNavigation.getState().start()
    expect(useNavigation.getState().resume).toBe(true)
    // First fix lands halfway down the second leg — steer to C, not B.
    useNavigation.getState().onFix(fixAt(go(B, 90, 0.5), { heading: 90 }))
    expect(useNavigation.getState().targetIdx).toBe(2)
    expect(useNavigation.getState().resume).toBe(false)
  })

  it('refuses to start without a plan', () => {
    expect(useNavigation.getState().start()).toBe(false)
    expect(useNavigation.getState().status).toBe('idle')
  })

  it('will not steer a best-effort route until the crew confirms it', async () => {
    planRouteMock.mockImplementationOnce((req) =>
      mkPlan([req.from, B, req.to], { source: 'best-effort', needsConfirm: true }),
    )
    await useNavigation.getState().setDestination(DEST, null)
    expect(useNavigation.getState().status).toBe('preview')

    expect(useNavigation.getState().start()).toBe(false)
    expect(useNavigation.getState().status).toBe('preview')
    expect(useNavigation.getState().error).toMatch(/not fully safe/)
    expect(trackerStart).not.toHaveBeenCalled()

    useNavigation.getState().confirmBestEffort()
    expect(useNavigation.getState().confirmed).toBe(true)
    expect(useNavigation.getState().start()).toBe(true)
    expect(useNavigation.getState().status).toBe('navigating')
  })

  it('does not carry a confirmation over to a new plan', async () => {
    planRouteMock.mockImplementation((req) =>
      mkPlan([req.from, B, req.to], { source: 'best-effort', needsConfirm: true }),
    )
    await useNavigation.getState().setDestination(DEST, null)
    useNavigation.getState().confirmBestEffort()
    await useNavigation.getState().replan('user')
    expect(useNavigation.getState().confirmed).toBe(false)
    expect(useNavigation.getState().start()).toBe(false)
  })

  it('has nothing to confirm on a charted plan', async () => {
    await useNavigation.getState().setDestination(DEST, null)
    useNavigation.getState().confirmBestEffort()
    expect(useNavigation.getState().confirmed).toBe(false)
  })
})

/* ------------------------------------------------------------- steering */

describe('onFix — advancing and arriving', () => {
  it('advances at the turn point and arrives at the destination', async () => {
    await navigating()
    vi.setSystemTime(T0 + 60_000)
    useNavigation.getState().onFix(fixAt(go(B, 180, m(20))))
    expect(useNavigation.getState().targetIdx).toBe(2)

    vi.setSystemTime(T0 + 240_000)
    useNavigation.getState().onFix(fixAt(go(C, 270, m(20))))
    const s = useNavigation.getState()
    expect(s.status).toBe('arrived')
    expect(s.targetIdx).toBe(2)
  })

  it('moves one point per fix, however far the fix jumped', async () => {
    const D = go(B, 90, m(30))
    await navigating(mkPlan([A, B, D, C]))
    useNavigation.getState().onFix(fixAt(D))
    expect(useNavigation.getState().targetIdx).toBe(2)
    expect(useNavigation.getState().status).toBe('navigating')
  })

  it('does nothing on a stale fix', async () => {
    await navigating()
    useNavigation.getState().onFix(fixAt(B, { timestamp: T0 - 30_000 }))
    expect(useNavigation.getState().targetIdx).toBe(1)
    expect(useNavigation.getState().lastFixAt).toBeNull()
  })

  it('ignores a fix older than the last one used', async () => {
    await navigating()
    vi.setSystemTime(T0 + 10_000)
    useNavigation.getState().onFix(fixAt(go(A, 0, 0.2)))
    useNavigation.getState().onFix(fixAt(B, { timestamp: T0 + 5_000 }))
    expect(useNavigation.getState().targetIdx).toBe(1)
  })

  it('recovers a missed mark instead of steering the boat back astern', async () => {
    await navigating()
    useNavigation.getState().onFix(fixAt(go(go(B, 90, 0.3), 180, m(20)), { heading: 90 }))
    expect(useNavigation.getState().targetIdx).toBe(2)
    expect(useNavigation.getState().offCourseSince).toBeNull()
  })

  it('flags a fix too poor to judge arrival', async () => {
    await navigating()
    useNavigation.getState().onFix(fixAt(go(A, 0, 0.2), { accuracy: 90 }))
    expect(useNavigation.getState().gpsPoor).toBe(true)
  })

  it('smooths the speed over ground for the ETA', async () => {
    await navigating()
    useNavigation.getState().onFix(fixAt(go(A, 0, 0.1), { speed: 10 }))
    const first = useNavigation.getState().speedKn!
    expect(first).toBeCloseTo(19.44, 1)
    vi.setSystemTime(T0 + 1_000)
    useNavigation.getState().onFix(fixAt(go(A, 0, 0.11), { speed: 5 }))
    const second = useNavigation.getState().speedKn!
    expect(second).toBeLessThan(first)
    expect(second).toBeGreaterThan(9.72)
  })

  it('is ignored unless navigating', async () => {
    await useNavigation.getState().setDestination(DEST, null)
    useNavigation.getState().onFix(fixAt(B))
    expect(useNavigation.getState().targetIdx).toBeNull()
  })
})

describe('onFix — off course and re-routing', () => {
  const off = () => go(go(A, 0, 0.5), 90, m(300))

  it('waits 10 s of continuous off-course before re-routing from the live fix', async () => {
    await navigating()
    planRouteMock.mockClear()

    useNavigation.getState().onFix(fixAt(off()))
    expect(useNavigation.getState().offCourseSince).toBe(T0)
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS - 1_000)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    expect(planRouteMock).not.toHaveBeenCalled()

    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS)
    const here = fixAt(off())
    useNavigation.getState().onFix(here)
    expect(useNavigation.getState().rerouting).toBe(true)
    await settle()

    expect(planRouteMock).toHaveBeenCalledTimes(1)
    expect(planRouteMock.mock.calls[0][0].from).toEqual({ lat: here.lat, lon: here.lon })
    const s = useNavigation.getState()
    expect(s.status).toBe('navigating')
    expect(s.reroutes).toBe(1)
    expect(s.rerouting).toBe(false)
    expect(s.offCourseSince).toBeNull()
    expect(s.origin).toBeNull()
    expect(s.plan?.points[0]).toEqual({ lat: here.lat, lon: here.lon })
    expect(s.targetIdx).toBe(1)
  })

  it('forgets being off course once back on the route', async () => {
    await navigating()
    useNavigation.getState().onFix(fixAt(off()))
    vi.setSystemTime(T0 + 5_000)
    useNavigation.getState().onFix(fixAt(go(A, 0, 0.5)))
    expect(useNavigation.getState().offCourseSince).toBeNull()
    vi.setSystemTime(T0 + 12_000)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    expect(useNavigation.getState().reroutes).toBe(0)
  })

  it('leaves at least 20 s between re-routes', async () => {
    // Every reroute plans a route that ignores where the boat really goes,
    // so the boat stays off course: the throttle is what stops a storm.
    planRouteMock.mockImplementation(() => mkPlan([A, B, C]))
    await navigating()

    let t = T0
    const tick = async (ms: number) => {
      t += ms
      vi.setSystemTime(t)
      useNavigation.getState().onFix(fixAt(off()))
      await settle()
    }
    await tick(0)
    await tick(OFF_COURSE_HOLD_MS) // first re-route at +10 s
    expect(useNavigation.getState().reroutes).toBe(1)
    // Off course again from +11 s: ten continuous seconds are up at +21 s,
    // but the gap since the first re-route is not up until +30 s.
    for (let i = 0; i < 19; i++) await tick(1_000) // +29 s
    expect(useNavigation.getState().reroutes).toBe(1)
    await tick(1_000) // +30 s: 20 s since the first
    expect(useNavigation.getState().reroutes).toBe(2)
    expect(REROUTE_MIN_GAP_MS).toBe(20_000)
  })

  it('keeps steering the current route when a re-route finds nothing', async () => {
    await navigating()
    const before = useNavigation.getState().plan
    planRouteMock.mockImplementationOnce(() =>
      mkPlan([], { source: 'none', failure: 'No water path from here.' }),
    )
    useNavigation.getState().onFix(fixAt(off()))
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    const s = useNavigation.getState()
    expect(s.status).toBe('navigating')
    expect(s.plan).toBe(before)
    expect(s.error).toMatch(/No water path from here/)
  })

  it('drops to the preview for confirmation when a re-route is best-effort', async () => {
    await navigating()
    planRouteMock.mockImplementationOnce((req) =>
      mkPlan([req.from, req.to], { source: 'best-effort', needsConfirm: true }),
    )
    useNavigation.getState().onFix(fixAt(off()))
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    const s = useNavigation.getState()
    expect(s.status).toBe('preview')
    expect(s.confirmed).toBe(false)
    expect(s.plan?.source).toBe('best-effort')
    expect(s.error).toMatch(/confirm/)
  })

  it('treats a route planned ahead from elsewhere as "go to the start", not off course', async () => {
    const origin = { ...go(A, 270, 2), label: 'Pier 21' }
    planRouteMock.mockImplementation((req) => mkPlan([req.from, B, req.to]))
    await useNavigation.getState().setDestination(DEST, origin)
    useNavigation.getState().start()
    expect(useNavigation.getState().targetIdx).toBe(0)
    vi.setSystemTime(T0 + 60_000)
    useNavigation.getState().onFix(fixAt(A))
    expect(useNavigation.getState().offCourseSince).toBeNull()
  })

  it('drops a re-route still in flight when steering stops', async () => {
    await navigating()
    const before = useNavigation.getState().plan
    autoRelease = false
    useNavigation.getState().onFix(fixAt(off()))
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    useNavigation.getState().stop()
    loads.at(-1)!.release()
    await settle()
    const s = useNavigation.getState()
    expect(s.status).toBe('preview')
    expect(s.plan).toBe(before)
  })
})

/* ------------------------------------------------------- stop / clear / replan */

describe('stop, clear, replan', () => {
  it('stop keeps the route as a preview; clear forgets it', async () => {
    await navigating()
    useNavigation.getState().stop()
    let s = useNavigation.getState()
    expect(s.status).toBe('preview')
    expect(s.plan).not.toBeNull()
    expect(s.targetIdx).toBeNull()
    useNavigation.getState().clear()
    s = useNavigation.getState()
    expect(s.status).toBe('idle')
    expect(s.dest).toBeNull()
    expect(s.plan).toBeNull()
  })

  it('a new destination while steering ends the passage and previews the new route', async () => {
    await navigating()
    await useNavigation.getState().setDestination({ ...B, label: 'B' })
    expect(useNavigation.getState().status).toBe('preview')
    expect(useNavigation.getState().targetIdx).toBeNull()
  })

  it('a boat change while steering re-plans from the live fix and keeps steering', async () => {
    await navigating()
    const here = fixAt(go(A, 0, 0.3))
    useTracker.setState({ fix: here })
    setBoat({ ...BOAT, draft_m: 1.5 })
    await useNavigation.getState().replan('boat')
    const req = planRouteMock.mock.calls.at(-1)![0]
    expect(req.safeDepthM).toBeCloseTo(2.1, 9)
    expect(req.from).toEqual({ lat: here.lat, lon: here.lon })
    expect(useNavigation.getState().status).toBe('navigating')
    // A boat edit is not an off-course re-route.
    expect(useNavigation.getState().reroutes).toBe(0)
  })

  it('does not re-plan after arriving', async () => {
    await navigating()
    useNavigation.getState().onFix(fixAt(go(B, 180, m(10))))
    vi.setSystemTime(T0 + 1_000)
    useNavigation.getState().onFix(fixAt(C))
    expect(useNavigation.getState().status).toBe('arrived')
    planRouteMock.mockClear()
    await useNavigation.getState().replan('boat')
    expect(planRouteMock).not.toHaveBeenCalled()
    expect(useNavigation.getState().status).toBe('arrived')
  })

  it('retries a failed plan', async () => {
    useTracker.setState({ fix: null })
    await useNavigation.getState().setDestination(DEST, null)
    expect(useNavigation.getState().status).toBe('failed')
    useTracker.setState({ fix: fixAt(A) })
    await useNavigation.getState().replan('retry')
    expect(useNavigation.getState().status).toBe('preview')
  })

  it('setOrigin re-plans from the new start', async () => {
    await useNavigation.getState().setDestination(DEST, null)
    const origin = { ...go(A, 270, 1), label: 'Pier 21' }
    await useNavigation.getState().setOrigin(origin)
    expect(planRouteMock.mock.calls.at(-1)![0].from).toEqual({ lat: origin.lat, lon: origin.lon })
  })
})

/* ------------------------------------------------------------ persistence */

describe('persistence', () => {
  it('keeps the passage, not the moment-to-moment readings', async () => {
    await navigating()
    useNavigation.setState({ speedKn: 12, gpsPoor: true, offCourseSince: T0, rerouting: true })
    const kept = partializeNav(useNavigation.getState())
    expect(Object.keys(kept).sort()).toEqual(
      ['confirmed', 'dest', 'error', 'lastPlannedAt', 'origin', 'plan', 'status', 'targetIdx'].sort(),
    )
    const stored = JSON.parse(mem.get(NAV_STORAGE_KEY)!)
    expect(stored.state.status).toBe('navigating')
    expect(stored.state.dest.label).toBe('Galveston Bay')
    expect(stored.state.speedKn).toBeUndefined()
    expect(NAV_STORAGE_KEY).toBe('navmate.nav.v1')
  })

  it('resumes steering after a reload, re-deriving the target from the next fix', async () => {
    const plan = mkPlan([A, B, C])
    mem.set(
      NAV_STORAGE_KEY,
      JSON.stringify({
        state: { dest: DEST, origin: null, plan, status: 'navigating', targetIdx: 1, confirmed: false, lastPlannedAt: T0, error: null },
        version: 1,
      }),
    )
    await useNavigation.persist.rehydrate()
    await settle()
    expect(useNavigation.getState().status).toBe('navigating')
    expect(useNavigation.getState().resume).toBe(true)
    // The boat is on the second leg by now.
    useNavigation.getState().onFix(fixAt(go(B, 90, 0.5), { heading: 90 }))
    expect(useNavigation.getState().targetIdx).toBe(2)
  })

  it('re-plans a plan that was lost mid-way by a reload', async () => {
    mem.set(
      NAV_STORAGE_KEY,
      JSON.stringify({
        state: { dest: DEST, origin: null, plan: null, status: 'planning', targetIdx: null, confirmed: false, lastPlannedAt: null, error: null },
        version: 1,
      }),
    )
    await useNavigation.persist.rehydrate()
    await settle()
    expect(planRouteMock).toHaveBeenCalled()
    expect(useNavigation.getState().status).toBe('preview')
  })
})

/* --------------------------------------------------------------- engine */

describe('the engine', () => {
  it('feeds fixes to the route while navigating', async () => {
    const stop = startNavigationEngine()
    await navigating()
    useTracker.setState({ fix: fixAt(go(B, 180, m(10))) })
    expect(useNavigation.getState().targetIdx).toBe(2)
    stop()
  })

  it('re-plans when the boat’s draft changes — and not when nothing did', async () => {
    const stop = startNavigationEngine()
    await useNavigation.getState().setDestination(DEST, null)
    planRouteMock.mockClear()

    setBoat({ ...BOAT }) // same values, new object
    vi.advanceTimersByTime(SETTINGS_SETTLE_MS + 10)
    await settle()
    expect(planRouteMock).not.toHaveBeenCalled()

    setBoat({ ...BOAT, draft_m: 1.2 })
    vi.advanceTimersByTime(SETTINGS_SETTLE_MS + 10)
    await settle()
    expect(planRouteMock).toHaveBeenCalledTimes(1)
    expect(planRouteMock.mock.calls[0][0].safeDepthM).toBeCloseTo(1.8, 9)
    stop()
  })

  it('re-plans when the stand-off, speed or arrival setting changes', async () => {
    const stop = startNavigationEngine()
    await useNavigation.getState().setDestination(DEST, null)
    planRouteMock.mockClear()
    setBoat({ ...BOAT, clearance_m: 50 })
    vi.advanceTimersByTime(SETTINGS_SETTLE_MS + 10)
    await settle()
    useTracker.setState({ arrivalFt: 200 })
    vi.advanceTimersByTime(SETTINGS_SETTLE_MS + 10)
    await settle()
    expect(planRouteMock).toHaveBeenCalledTimes(2)
    expect(planRouteMock.mock.calls[1][0].arrivalFt).toBe(200)
    stop()
  })

  it('does not re-plan a boat change with no destination', async () => {
    const stop = startNavigationEngine()
    setBoat({ ...BOAT, draft_m: 2 })
    vi.advanceTimersByTime(SETTINGS_SETTLE_MS + 10)
    await settle()
    expect(planRouteMock).not.toHaveBeenCalled()
    stop()
  })

  it('retries a failed plan when the network comes back', async () => {
    const win = new EventTarget()
    vi.stubGlobal('window', win)
    const stop = startNavigationEngine()
    useTracker.setState({ fix: null })
    await useNavigation.getState().setDestination(DEST, null)
    expect(useNavigation.getState().status).toBe('failed')
    useTracker.setState({ fix: fixAt(A) })
    win.dispatchEvent(new Event('online'))
    await settle()
    expect(useNavigation.getState().status).toBe('preview')
    stop()
  })

  it('keeps the GPS on while navigating', async () => {
    const stop = startNavigationEngine()
    await navigating()
    trackerStart.mockClear()
    useTracker.setState({ watching: true })
    useTracker.setState({ watching: false }) // stopped from another tab
    expect(trackerStart).toHaveBeenCalledTimes(1)
    stop()
  })
})
