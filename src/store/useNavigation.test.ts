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

/**
 * A harbour-sized planning box: small enough that the main chart query
 * includes the harbour band, so no corridor pass runs unless a test asks for
 * one with `LONG_BOX`.
 */
const BOX = { minLat: 29.3, minLon: -94.82, maxLat: 29.35, maxLon: -94.76 }
/** A long passage's box — too big for the harbour band as a whole. */
const LONG_BOX = { minLat: 29, minLon: -95, maxLat: 30, maxLon: -94 }

vi.mock('@/lib/routing', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/routing')>()
  return {
    ...real,
    planningBounds: vi.fn(() => BOX),
    planRoute: vi.fn(),
    // The real chart check by default; the "round first" tests below set the
    // chart's verdict on the line directly.
    liveShortcut: vi.fn(real.liveShortcut),
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
    /** What is in memory. `coverage: 'none'` = nothing loaded. */
    features: { depthAreas: [], channels: [], land: [], hazards: [], lines: [], coverage: 'full' } as ChartFeatures,
    covers: vi.fn((...args: unknown[]) => args.length < 0),
    holds: vi.fn((...args: unknown[]) => args.length < 0),
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

import { liveShortcut, planningBounds, planRoute } from '@/lib/routing'
import { useChartData } from '@/store/useChartData'
import { useVessels } from '@/store/useVessels'
import { useTracker } from '@/store/useTracker'
import {
  CLEAR_FIXES,
  LIVE_CHART_TIMEOUT_MS,
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

/** A sound leg of `mkPlan`'s shape. */
function leg(n: number): RoutePlan['legs'][number] {
  return {
    n,
    kind: 'search',
    courseDeg: 0,
    lengthNM: 1,
    from: A,
    to: B,
    etaHours: 0.05,
    minChartedDepthM: 5,
    channelFraction: null,
    caution: 'ok',
    minClearanceM: 50,
  } as RoutePlan['legs'][number]
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
  vi.mocked(planningBounds).mockImplementation(() => BOX)
  vi.mocked(useChartData.getState().holds).mockReset()
  vi.mocked(useChartData.getState().holds).mockReturnValue(false)
  vi.mocked(useChartData.getState().covers).mockReset()
  vi.mocked(useChartData.getState().covers).mockReturnValue(false)
  useChartData.setState({ status: 'ready', error: null, features: { ...FEATURES } })
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
    // Changed on purpose (finding R8/R5): a failed re-route is its own
    // field, tied to being off the route, not the general `error`.
    expect(s.rerouteError).toMatch(/No water path from here/)
  })

  it('clears a failed re-route’s message once the boat is back on the route', async () => {
    await navigating()
    planRouteMock.mockImplementationOnce(() => mkPlan([], { source: 'none', failure: 'No water path.' }))
    useNavigation.getState().onFix(fixAt(off()))
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    expect(useNavigation.getState().rerouteError).toMatch(/Could not re-route/)
    vi.setSystemTime(T0 + 90_000)
    useNavigation.getState().onFix(fixAt(go(A, 0, 0.5)))
    const s = useNavigation.getState()
    expect(s.offCourseSince).toBeNull()
    expect(s.rerouteError).toBeNull()
  })

  it('keeps steering, and holds a best-effort re-route for confirmation, rather than dropping to the preview', async () => {
    // Changed on purpose (finding R2, both lenses): this used to drop to
    // 'preview' with no target, so the banner on every other tab vanished and
    // steering silently ended exactly when the boat was off course.
    await navigating()
    const before = useNavigation.getState().plan
    const target = useNavigation.getState().targetIdx
    planRouteMock.mockImplementationOnce((req) =>
      mkPlan([req.from, req.to], { source: 'best-effort', needsConfirm: true }),
    )
    useNavigation.getState().onFix(fixAt(off()))
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    let s = useNavigation.getState()
    expect(s.status).toBe('navigating')
    expect(s.plan).toBe(before)
    expect(s.targetIdx).toBe(target)
    expect(s.pendingPlan?.source).toBe('best-effort')
    // While it waits, no re-route storm over the top of it.
    planRouteMock.mockClear()
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS + REROUTE_MIN_GAP_MS + 1_000)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    expect(planRouteMock).not.toHaveBeenCalled()
    // Accepting it steers it, from where the boat is.
    useNavigation.getState().acceptPendingPlan()
    s = useNavigation.getState()
    expect(s.plan?.source).toBe('best-effort')
    expect(s.pendingPlan).toBeNull()
    expect(s.confirmed).toBe(true)
    expect(s.status).toBe('navigating')
  })

  it('lets the crew keep the current route instead of a best-effort re-route', async () => {
    await navigating()
    const before = useNavigation.getState().plan
    planRouteMock.mockImplementationOnce((req) =>
      mkPlan([req.from, req.to], { source: 'best-effort', needsConfirm: true }),
    )
    useNavigation.getState().onFix(fixAt(off()))
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    useNavigation.getState().dismissPendingPlan()
    const s = useNavigation.getState()
    expect(s.pendingPlan).toBeNull()
    expect(s.plan).toBe(before)
    expect(s.status).toBe('navigating')
  })

  it('re-plans from the live position when Start is pressed away from a start chosen by hand', async () => {
    // Changed on purpose (finding R7): this used to steer a straight,
    // unchecked bearing to the hand-set start and never re-route.
    const origin = { ...go(A, 270, 2), label: 'Pier 21' }
    planRouteMock.mockImplementation((req) => mkPlan([req.from, B, req.to]))
    await useNavigation.getState().setDestination(DEST, origin)
    planRouteMock.mockClear()
    expect(useNavigation.getState().start()).toBe(false)
    await settle()
    const s = useNavigation.getState()
    expect(planRouteMock).toHaveBeenCalledTimes(1)
    expect(planRouteMock.mock.calls[0][0].from).toEqual({ lat: A.lat, lon: A.lon })
    expect(s.origin).toBeNull()
    expect(s.status).toBe('preview')
    expect(s.error).toMatch(/not at the planned start/)
    // Start again: now from here, at the start.
    expect(useNavigation.getState().start()).toBe(true)
    expect(useNavigation.getState().targetIdx).toBe(1)
  })

  it('starts a hand-set route normally when the boat is at its start', async () => {
    const origin = { ...go(A, 90, m(20)), label: 'Pier 21' }
    planRouteMock.mockImplementation((req) => mkPlan([req.from, B, req.to]))
    await useNavigation.getState().setDestination(DEST, origin)
    planRouteMock.mockClear()
    expect(useNavigation.getState().start()).toBe(true)
    expect(useNavigation.getState().targetIdx).toBe(1)
    expect(planRouteMock).not.toHaveBeenCalled()
  })

  it('re-routes from the live position when steering to a hand-set start the boat is nowhere near', async () => {
    // Started with no fix (target guessed), then the first fix shows the
    // boat 2 NM from the start: after 10 s that is off course like any leg.
    const origin = { ...go(A, 270, 2), label: 'Pier 21' }
    planRouteMock.mockImplementation((req) => mkPlan([req.from, B, req.to]))
    await useNavigation.getState().setDestination(DEST, origin)
    useTracker.setState({ fix: null })
    expect(useNavigation.getState().start()).toBe(true)
    useNavigation.getState().onFix(fixAt(A))
    expect(useNavigation.getState().targetIdx).toBe(0)
    expect(useNavigation.getState().offCourseSince).toBe(T0)
    planRouteMock.mockClear()
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS)
    useNavigation.getState().onFix(fixAt(A))
    await settle()
    expect(planRouteMock).toHaveBeenCalledTimes(1)
    expect(planRouteMock.mock.calls[0][0].from).toEqual({ lat: A.lat, lon: A.lon })
    expect(useNavigation.getState().origin).toBeNull()
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
    // Grown on purpose: what the plan was checked for (R1), the chart loads
    // to replay offline after a reload (R3), the owning account (regress R3)
    // and a paused-for-review flag (R2).
    expect(Object.keys(kept).sort()).toEqual(
      [
        'chartLoads',
        'confirmed',
        'dest',
        'error',
        'lastPlannedAt',
        'origin',
        'ownerId',
        'plan',
        'plannedFor',
        'reconfirm',
        'status',
        'targetIdx',
      ].sort(),
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

  it('re-plans when the stand-off or speed changes', async () => {
    const stop = startNavigationEngine()
    await useNavigation.getState().setDestination(DEST, null)
    planRouteMock.mockClear()
    setBoat({ ...BOAT, clearance_m: 50 })
    vi.advanceTimersByTime(SETTINGS_SETTLE_MS + 10)
    await settle()
    setBoat({ ...BOAT, clearance_m: 50, cruise_speed_kn: 25 })
    vi.advanceTimersByTime(SETTINGS_SETTLE_MS + 10)
    await settle()
    expect(planRouteMock).toHaveBeenCalledTimes(2)
    expect(planRouteMock.mock.calls[0][0].clearanceM).toBe(50)
    expect(planRouteMock.mock.calls[1][0].speedKn).toBe(25)
    stop()
  })

  it('does NOT re-plan for the arrival setting — it resizes the circles and keeps the waypoints', async () => {
    // Changed on purpose (finding UI-6): the arrival setting used to be in
    // the settings key, so tapping "200 ft" mid-passage re-planned from the
    // live fix and renumbered the waypoints being followed.
    const stop = startNavigationEngine()
    await navigating(mkPlan([A, B, C], { arrivalFt: [150, 150, 150] }))
    useNavigation.getState().onFix(fixAt(go(B, 180, m(10))))
    const before = useNavigation.getState()
    expect(before.targetIdx).toBe(2)
    planRouteMock.mockClear()
    useTracker.setState({ arrivalFt: 100 })
    vi.advanceTimersByTime(SETTINGS_SETTLE_MS + 10)
    await settle()
    const s = useNavigation.getState()
    expect(planRouteMock).not.toHaveBeenCalled()
    expect(s.status).toBe('navigating')
    expect(s.targetIdx).toBe(2)
    expect(s.plan?.points).toEqual(before.plan?.points)
    // Every circle takes the new, smaller setting.
    expect(s.plan?.arrivalFt).toEqual([100, 100, 100])
    // Changed on purpose (the crew's decision after the final check): every
    // point — turn points and the destination — uses the crew's own 100–200
    // ft, so a larger setting now widens the circles too. (They used to be
    // "checked" radii that a larger setting could not widen; the corner the
    // early switch would cut is now refused live instead — see
    // useNavigation.router.test.ts, C1.)
    useTracker.setState({ arrivalFt: 200 })
    expect(useNavigation.getState().plan?.arrivalFt).toEqual([200, 200, 200])
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

  it('reads the passage’s chart back into memory after a reload mid-passage, for the live checks', async () => {
    await navigating()
    const recorded = useNavigation.getState().chartLoads
    expect(recorded.length).toBeGreaterThan(0)
    // The page reloads: steering persisted, the chart did not.
    useChartData.setState({ features: { ...FEATURES, coverage: 'none' } })
    const load = vi.mocked(useChartData.getState().load)
    load.mockClear()
    const stop = startNavigationEngine()
    await settle()
    expect(load).toHaveBeenCalledTimes(recorded.length)
    expect(load.mock.calls[0]).toEqual([recorded[0].bounds, { detailAround: recorded[0].detailAround }])
    // With a chart in memory it does nothing.
    load.mockClear()
    useChartData.setState({ features: { ...FEATURES } })
    await useNavigation.getState().restoreChart()
    expect(load).not.toHaveBeenCalled()
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

/* ------------------------------------------------ review fixes (regressions) */

describe('a boat made stricter mid-passage (R1)', () => {
  it('does not keep steering a route planned for a shallower boat when the re-plan finds nothing', async () => {
    await navigating(mkPlan([A, B, C], { legs: [leg(1), leg(2)] }))
    setBoat({ ...BOAT, draft_m: 2.5 })
    planRouteMock.mockImplementationOnce(() => mkPlan([], { source: 'none', failure: 'No water path.' }))
    await useNavigation.getState().replan('boat')
    const s = useNavigation.getState()
    expect(s.status).toBe('preview')
    expect(s.targetIdx).toBeNull()
    expect(s.reconfirm).toBe(true)
    // No chart in memory to re-check it: every leg flagged as not checked.
    expect(s.plan?.needsConfirm).toBe(true)
    expect(s.plan?.legs.every((l) => l.caution === 'unsafe-depth' && l.unverified)).toBe(true)
    expect(s.error).toMatch(/planned for a boat needing .* could not be re-planned/)
    // Steering it again needs the explicit confirmation.
    expect(useNavigation.getState().start()).toBe(false)
  })

  it('the same when the re-plan throws (no signal)', async () => {
    await navigating(mkPlan([A, B, C], { legs: [leg(1), leg(2)] }))
    setBoat({ ...BOAT, clearance_m: 90 })
    planRouteMock.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    await useNavigation.getState().replan('boat')
    expect(useNavigation.getState().status).toBe('preview')
    expect(useNavigation.getState().reconfirm).toBe(true)
  })

  it('keeps steering when the boat asks less of the route (shallower draft, speed)', async () => {
    await navigating(mkPlan([A, B, C], { legs: [leg(1), leg(2)] }))
    setBoat({ ...BOAT, draft_m: 0.5, cruise_speed_kn: 25 })
    planRouteMock.mockImplementationOnce(() => mkPlan([], { source: 'none', failure: 'No water path.' }))
    await useNavigation.getState().replan('boat')
    const s = useNavigation.getState()
    expect(s.status).toBe('navigating')
    expect(s.reconfirm).toBe(false)
    expect(s.plan?.legs.every((l) => l.caution === 'ok')).toBe(true)
  })

  it('does not re-plan for a "change" to the boat the plan was made for', async () => {
    await navigating()
    planRouteMock.mockClear()
    setBoat({ ...BOAT })
    await useNavigation.getState().replan('boat')
    expect(planRouteMock).not.toHaveBeenCalled()
  })
})

describe('re-routing without a signal (R3 / regress R1)', () => {
  const off = () => go(go(A, 0, 0.5), 90, m(300))

  it('re-routes on the chart already in memory when it holds the new box — no download', async () => {
    await navigating()
    const load = vi.mocked(useChartData.getState().load)
    load.mockClear()
    vi.mocked(useChartData.getState().holds).mockReturnValue(true)
    useNavigation.getState().onFix(fixAt(off()))
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    expect(load).not.toHaveBeenCalled()
    expect(useNavigation.getState().reroutes).toBe(1)
    expect(useNavigation.getState().plan?.points[0].lat).toBeCloseTo(off().lat, 9)
  })

  it('still re-routes on the chart in memory when the download fails', async () => {
    await navigating()
    vi.mocked(useChartData.getState().load).mockImplementationOnce(async () => {
      useChartData.setState({ error: 'Failed to fetch' })
      return { ...FEATURES, coverage: 'none' }
    })
    useNavigation.getState().onFix(fixAt(off()))
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    const s = useNavigation.getState()
    expect(s.rerouteError).toBeNull()
    expect(s.plan?.points[0].lat).toBeCloseTo(off().lat, 9)
    expect(planRouteMock.mock.calls.at(-1)![0].features.coverage).toBe('full')
  })

  it('after a reload, replays the passage’s own chart loads (the same queries the device cache holds) before going further', async () => {
    await navigating()
    const loadsBefore = useNavigation.getState().chartLoads
    expect(loadsBefore).toEqual([{ bounds: BOX, detailAround: [{ lat: A.lat, lon: A.lon }, { lat: C.lat, lon: C.lon }] }])
    // The reload: nothing in memory; the replayed load then holds the box.
    useChartData.setState({ features: { ...FEATURES, coverage: 'none' } })
    const load = vi.mocked(useChartData.getState().load)
    load.mockClear()
    load.mockImplementationOnce(async () => {
      useChartData.setState({ features: { ...FEATURES } })
      vi.mocked(useChartData.getState().holds).mockReturnValue(true)
      return FEATURES
    })
    useNavigation.getState().onFix(fixAt(off()))
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    expect(load).toHaveBeenCalledTimes(1)
    expect(load.mock.calls[0][0]).toEqual(loadsBefore[0].bounds)
    expect(load.mock.calls[0][1]).toEqual({ detailAround: loadsBefore[0].detailAround })
    expect(useNavigation.getState().reroutes).toBe(1)
    expect(useNavigation.getState().rerouteError).toBeNull()
  })
})

describe('a chart load that never answers (R4)', () => {
  const off = () => go(go(A, 0, 0.5), 90, m(300))

  it('gives up on it, clears "Re-routing…", and tries again after the gap', async () => {
    await navigating()
    // Nothing in memory to fall back on.
    useChartData.setState({ features: { ...FEATURES, coverage: 'none' } })
    autoRelease = false
    useNavigation.getState().onFix(fixAt(off()))
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    expect(useNavigation.getState().rerouting).toBe(true)
    await vi.advanceTimersByTimeAsync(LIVE_CHART_TIMEOUT_MS + 10)
    await settle()
    let s = useNavigation.getState()
    expect(s.rerouting).toBe(false)
    expect(s.rerouteError).toMatch(/did not answer in time/)
    expect(s.status).toBe('navigating')
    // The next off-course window, past the gap, tries again.
    const before = loads.length
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS + REROUTE_MIN_GAP_MS + LIVE_CHART_TIMEOUT_MS)
    useNavigation.getState().onFix(fixAt(off()))
    await settle()
    s = useNavigation.getState()
    expect(s.reroutes).toBe(2)
    expect(loads.length).toBe(before + 1)
  })
})

describe('the chart along a long passage (R6 / R3)', () => {
  it('reads the finest charts along the route found, and plans again on them', async () => {
    vi.mocked(planningBounds).mockImplementation(() => LONG_BOX)
    await useNavigation.getState().setDestination(DEST, null)
    const load = vi.mocked(useChartData.getState().load)
    expect(load).toHaveBeenCalledTimes(2)
    const second = load.mock.calls[1][1] as { detailAround: LatLon[] }
    // Both ends, and points all along the first route.
    expect(second.detailAround.length).toBeGreaterThan(2)
    expect(planRouteMock).toHaveBeenCalledTimes(2)
    const s = useNavigation.getState()
    expect(s.status).toBe('preview')
    // Both loads are remembered, to replay after a reload.
    expect(s.chartLoads).toHaveLength(2)
  })

  it('keeps the first plan when the corridor cannot be read', async () => {
    vi.mocked(planningBounds).mockImplementation(() => LONG_BOX)
    const load = vi.mocked(useChartData.getState().load)
    load.mockImplementationOnce(async () => FEATURES)
    load.mockImplementationOnce(async () => ({ ...FEATURES, coverage: 'none' }))
    await useNavigation.getState().setDestination(DEST, null)
    expect(planRouteMock).toHaveBeenCalledTimes(1)
    expect(useNavigation.getState().status).toBe('preview')
  })
})

describe('arrival distance for routes (R13)', () => {
  it('plans with 100 ft when the shared setting is the Search tab’s 50 ft', async () => {
    useTracker.setState({ arrivalFt: 50 })
    await useNavigation.getState().setDestination(DEST, null)
    expect(planRouteMock.mock.calls[0][0].arrivalFt).toBe(100)
  })
})

describe('ending a passage (UI-7)', () => {
  it('End after arriving finishes the passage — no old route offered again as a new one', async () => {
    await navigating()
    useNavigation.getState().onFix(fixAt(go(B, 180, m(10))))
    vi.setSystemTime(T0 + 1_000)
    useNavigation.getState().onFix(fixAt(C))
    expect(useNavigation.getState().status).toBe('arrived')
    useNavigation.getState().stop()
    const s = useNavigation.getState()
    expect(s.status).toBe('idle')
    expect(s.plan).toBeNull()
    expect(s.dest).toBeNull()
    expect(useNavigation.getState().start()).toBe(false)
  })
})

describe('the passage belongs to the account (regress R3)', () => {
  it('clears a passage left by another account, and keeps its own', async () => {
    useNavigation.getState().bindOwner('u1')
    await useNavigation.getState().setDestination(DEST, null)
    useNavigation.getState().bindOwner('u1')
    expect(useNavigation.getState().dest).not.toBeNull()
    useNavigation.getState().bindOwner('u2')
    const s = useNavigation.getState()
    expect(s.dest).toBeNull()
    expect(s.plan).toBeNull()
    expect(s.ownerId).toBe('u2')
  })

  it('reset forgets the owner too (sign-out)', async () => {
    useNavigation.getState().bindOwner('u1')
    await navigating()
    useNavigation.getState().reset()
    const s = useNavigation.getState()
    expect(s.status).toBe('idle')
    expect(s.ownerId).toBeNull()
  })
})

describe('storage (regress R7)', () => {
  it('does not write to localStorage on a fix that changed nothing persisted', async () => {
    await navigating()
    const spy = vi.spyOn(localStorage, 'setItem')
    useNavigation.getState().onFix(fixAt(go(A, 0, 0.2)))
    vi.setSystemTime(T0 + 1_000)
    useNavigation.getState().onFix(fixAt(go(A, 0, 0.21)))
    vi.setSystemTime(T0 + 2_000)
    useNavigation.getState().onFix(fixAt(go(A, 0, 0.22)))
    expect(spy.mock.calls.filter((c) => c[0] === NAV_STORAGE_KEY).length).toBe(0)
    // A change that matters still is written.
    useNavigation.getState().onFix(fixAt(go(B, 180, m(10))))
    expect(spy.mock.calls.filter((c) => c[0] === NAV_STORAGE_KEY).length).toBe(1)
    spy.mockRestore()
  })
})

describe('the simulated-voyage re-check (F1, F5, F7, F8)', () => {
  it('accepts a held re-route from where the boat is NOW, never back to its start (F5)', async () => {
    await navigating()
    const P0 = go(go(A, 0, 0.5), 90, m(300))
    const X = go(P0, 0, 0.5)
    planRouteMock.mockImplementationOnce(() =>
      mkPlan([P0, X, C], { source: 'best-effort', needsConfirm: true }),
    )
    useNavigation.getState().onFix(fixAt(P0))
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS)
    useNavigation.getState().onFix(fixAt(P0))
    await settle()
    expect(useNavigation.getState().pendingPlan).not.toBeNull()
    // The crew reads it for a while; the boat runs on 120 m east, across
    // the new first leg rather than along it — too far off it to "join" it.
    vi.setSystemTime(T0 + OFF_COURSE_HOLD_MS + 8_000)
    useTracker.setState({ fix: fixAt(go(P0, 90, m(120)), { heading: 90 }) })
    useNavigation.getState().acceptPendingPlan()
    const s = useNavigation.getState()
    // Point 0 is the re-route's start, 120 m back along a line nobody checked.
    expect(s.targetIdx).toBe(1)
    expect(s.resume).toBe(false)
  })

  it('does not arrive on one fix only just inside the circle — two in a row, or inside by the fix’s error (F8)', async () => {
    await navigating()
    vi.setSystemTime(T0 + 60_000)
    useNavigation.getState().onFix(fixAt(go(B, 180, m(20))))
    expect(useNavigation.getState().targetIdx).toBe(2)
    // 140 ft out on a ±15 m (49 ft) fix: inside the 150 ft circle, not by
    // its own error — the boat may be 190 ft out.
    vi.setSystemTime(T0 + 200_000)
    useNavigation.getState().onFix(fixAt(go(C, 270, m(140 * 0.3048)), { accuracy: 15 }))
    expect(useNavigation.getState().status).toBe('navigating')
    // A second fix inside: arrived.
    vi.setSystemTime(T0 + 201_000)
    useNavigation.getState().onFix(fixAt(go(C, 270, m(130 * 0.3048)), { accuracy: 15 }))
    expect(useNavigation.getState().status).toBe('arrived')
  })

  it('arrives at once when the fix is inside the circle by its own error (F8)', async () => {
    await navigating()
    vi.setSystemTime(T0 + 60_000)
    useNavigation.getState().onFix(fixAt(go(B, 180, m(20))))
    vi.setSystemTime(T0 + 200_000)
    useNavigation.getState().onFix(fixAt(go(C, 270, m(20)), { accuracy: 5 }))
    expect(useNavigation.getState().status).toBe('arrived')
  })

  it('neither switches nor arrives on a position the filter has only just jumped to (F1/F8)', async () => {
    await navigating()
    vi.setSystemTime(T0 + 60_000)
    useNavigation.getState().onFix(fixAt(go(B, 180, m(20)), { settling: true }))
    expect(useNavigation.getState().targetIdx).toBe(1)
    vi.setSystemTime(T0 + 61_000)
    useNavigation.getState().onFix(fixAt(go(B, 180, m(20))))
    expect(useNavigation.getState().targetIdx).toBe(2)
    vi.setSystemTime(T0 + 200_000)
    useNavigation.getState().onFix(fixAt(C, { settling: true }))
    vi.setSystemTime(T0 + 201_000)
    useNavigation.getState().onFix(fixAt(C, { settling: true }))
    expect(useNavigation.getState().status).toBe('navigating')
    vi.setSystemTime(T0 + 202_000)
    useNavigation.getState().onFix(fixAt(C))
    expect(useNavigation.getState().status).toBe('arrived')
  })

  it('keeps the speed through a fix or two the filter reads as stopped (F7)', async () => {
    await navigating()
    useNavigation.getState().onFix(fixAt(go(A, 0, 0.1), { speed: 5 }))
    const kn = useNavigation.getState().speedKn!
    vi.setSystemTime(T0 + 1_000)
    useNavigation.getState().onFix(fixAt(go(A, 0, 0.101), { speed: 0 }))
    vi.setSystemTime(T0 + 2_000)
    useNavigation.getState().onFix(fixAt(go(A, 0, 0.102), { speed: 0 }))
    expect(useNavigation.getState().speedKn).toBe(kn)
    // A boat that has really stopped shows it, after a few seconds.
    for (let s = 3; s <= 30; s++) {
      vi.setSystemTime(T0 + s * 1_000)
      useNavigation.getState().onFix(fixAt(go(A, 0, 0.102), { speed: 0 }))
    }
    expect(useNavigation.getState().speedKn!).toBeLessThan(kn / 2)
  })
})

describe('round first — held on several clear fixes, re-checked on every fix (F2, F6)', () => {
  const verdict = vi.mocked(liveShortcut)
  afterEach(() => verdict.mockReset())

  /** Steering to B, switched 130 ft short of it with the line on unsafe. */
  async function rounding(plan?: RoutePlan) {
    if (plan?.needsConfirm) {
      planRouteMock.mockImplementationOnce(() => plan)
      await useNavigation.getState().setDestination(DEST, null)
      useNavigation.getState().confirmBestEffort()
      expect(useNavigation.getState().start()).toBe(true)
    } else {
      await navigating(plan)
    }
    verdict.mockReturnValue('unsafe')
    vi.setSystemTime(T0 + 60_000)
    useNavigation.getState().onFix(fixAt(go(B, 180, m(40)), { heading: 0 }))
    const s = useNavigation.getState()
    expect(s.targetIdx).toBe(2)
    expect(s.roundIdx).toBe(1)
  }

  it(`lets "round waypoint N first" go only after ${CLEAR_FIXES} clear fixes in a row`, async () => {
    await rounding()
    verdict.mockReturnValue('clear')
    for (let k = 1; k < CLEAR_FIXES; k++) {
      vi.setSystemTime(T0 + 60_000 + k * 1000)
      useNavigation.getState().onFix(fixAt(go(B, 180, m(40 - 2 * k)), { heading: 0 }))
      expect(useNavigation.getState().roundIdx, `clear fix ${k}`).toBe(1)
    }
    // An unsafe fix starts the count again.
    verdict.mockReturnValueOnce('unsafe')
    vi.setSystemTime(T0 + 70_000)
    useNavigation.getState().onFix(fixAt(go(B, 180, m(33)), { heading: 0 }))
    expect(useNavigation.getState().clearRun).toBe(0)
    for (let k = 1; k <= CLEAR_FIXES; k++) {
      vi.setSystemTime(T0 + 70_000 + k * 1000)
      useNavigation.getState().onFix(fixAt(go(B, 180, m(32 - k)), { heading: 0 }))
    }
    expect(useNavigation.getState().roundIdx).toBeNull()
  })

  it('checks the line with the 95 % circle of the fix’s error, not the 68 % one', async () => {
    await rounding()
    const call = verdict.mock.calls[verdict.mock.calls.length - 1]
    expect(call[4]).toBeCloseTo(1.6 * 5, 5)
  })

  it('keeps re-checking the line after letting go, and falls back to the turn point when it is no longer safe', async () => {
    await navigating()
    // Switched on a clear line (a fix that jumped past the turn)…
    verdict.mockReturnValue('clear')
    vi.setSystemTime(T0 + 60_000)
    useNavigation.getState().onFix(fixAt(go(B, 180, m(40)), { heading: 0 }))
    expect(useNavigation.getState().roundIdx).toBeNull()
    expect(useNavigation.getState().targetIdx).toBe(2)
    // …then the next fix, from where the boat really is, has land on it.
    verdict.mockReturnValue('unsafe')
    vi.setSystemTime(T0 + 61_000)
    useNavigation.getState().onFix(fixAt(go(B, 180, m(44)), { heading: 0 }))
    expect(useNavigation.getState().roundIdx).toBe(1)
  })

  it('lets go once the boat is round the turn, whatever the chart says of the line (never astern)', async () => {
    await rounding()
    // Past B on the way out, 20 m off the new leg.
    vi.setSystemTime(T0 + 62_000)
    useNavigation.getState().onFix(fixAt(go(go(B, 0, m(8)), 90, m(25)), { heading: 90 }))
    expect(useNavigation.getState().roundIdx).toBeNull()
  })

  it('never turns the boat round for a mark behind it', async () => {
    await rounding()
    // Swept wide past B, heading away from it: the card must not say "go back".
    vi.setSystemTime(T0 + 62_000)
    useNavigation.getState().onFix(fixAt(go(B, 300, m(40)), { heading: 330 }))
    expect(useNavigation.getState().roundIdx).toBeNull()
  })

  it('holds a best-effort route to "no worse than its own leg" (F6)', async () => {
    await rounding(mkPlan([A, B, C], { source: 'best-effort', needsConfirm: true }))
    const call = verdict.mock.calls[verdict.mock.calls.length - 1]
    expect(call[5]).toBe(false)
  })

  it('holds a route that meets the rules to the rules', async () => {
    await rounding()
    expect(verdict.mock.calls[verdict.mock.calls.length - 1][5]).toBe(true)
  })
})
