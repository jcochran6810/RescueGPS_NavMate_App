import { describe, it, expect, vi, beforeEach } from 'vitest'

/*
 * The 2026-09-28 additions to the chart plotter, rendered to HTML in node
 * (the same harness as ChartTab.render.test.ts): the ETA speed choice, the
 * route options and their confirmation, save / share at the bottom, and the
 * "Plan a course" steps. Plus the 320 px rules each relies on.
 */

vi.hoisted(() => {
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
  ;(globalThis as Record<string, unknown>).window = globalThis
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
})

vi.mock('zustand', async (orig) => {
  const real = await orig<typeof import('zustand')>()
  const { createStore } = await import('zustand/vanilla')
  const make = (init: never) => {
    const api = createStore(init)
    const hook = (sel: (s: unknown) => unknown = (x) => x) => sel(api.getState())
    return Object.assign(hook, api)
  }
  const create = (init?: never) => (init ? make(init) : make)
  return { ...real, create }
})

// Portals cannot be rendered on the server: the sheet renders in place here.
vi.mock('@/components/Sheet', async () => {
  const { createElement } = await import('react')
  return {
    Sheet: ({ label, children }: { label: string; children: unknown }) =>
      createElement('div', { role: 'dialog', 'aria-label': label }, children as never),
  }
})

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { projectPosition } from '@/lib/sar'
import type { RoutePlan } from '@/lib/routing'
import { useNavigation, type NavStatus, type RouteOption } from '@/store/useNavigation'
import { useTracker } from '@/store/useTracker'
import { useVessels } from '@/store/useVessels'
import { useEtaSpeed } from '@/store/useEtaSpeed'
import { usePlanCourse } from '@/store/usePlanCourse'
import { ChartTab } from '@/tabs/ChartTab'
import { EtaSpeedPicker } from '@/components/EtaSpeedPicker'
import { PlanCourseSheet } from '@/components/PlanCourseSheet'

const A = { lat: 29.3, lon: -94.8 }
const B = projectPosition(A.lat, A.lon, 0, 1)
const C = projectPosition(B.lat, B.lon, 90, 0.05)
const leg = (n: number, from: typeof A, to: typeof A, caution: string, depth = 3) => ({
  n, from, to, courseDeg: n === 1 ? 0 : 90, lengthNM: 1, etaHours: 1, minChartedDepthM: depth,
  channelFraction: null, caution, minClearanceM: 40, minDepthOutsideM: depth,
})
const MAIN = {
  points: [A, B, C],
  legs: [leg(1, A, B, 'ok'), leg(2, B, C, 'ok')],
  totalNM: 3.2,
  hours: 0.16,
  source: 'charted',
  coverage: 'full',
  warnings: [],
  movedStart: null,
  movedEnd: null,
  outsideChannelNM: null,
  arrivalFt: [150, 150, 150],
  failure: null,
  needsConfirm: false,
} as unknown as RoutePlan
const ALT = {
  ...MAIN,
  totalNM: 1.05,
  legs: [leg(1, A, B, 'unsafe-depth', 1.07), leg(2, B, C, 'ok')],
  source: 'best-effort',
  needsConfirm: true,
  confirmReason: 'No route keeps 5 ft of water the whole way. The safest route crosses 3.5 ft near leg 1.',
  warnings: ['No route keeps 5 ft of water the whole way. The safest route crosses 3.5 ft near leg 1.'],
} as unknown as RoutePlan
const ROUTES: RouteOption[] = [
  { plan: MAIN, reasons: [], label: '', shorterNM: 0 },
  { plan: ALT, reasons: [{ kind: 'shallow', leastDepthM: 1.07, legIdx: 0 }], label: 'Shallow 3.5 ft', shorterNM: 2.15 },
]
const DEST = { ...C, label: 'Three Bird Island' }

function render(status: NavStatus, plan: RoutePlan | null, extra: object = {}) {
  useNavigation.setState({
    status,
    plan,
    dest: status === 'idle' ? null : DEST,
    origin: null,
    targetIdx: status === 'navigating' || status === 'arrived' ? 1 : null,
    confirmed: false,
    rerouting: false,
    gpsPoor: false,
    error: null,
    rerouteError: null,
    pendingPlan: null,
    reconfirm: false,
    shallowHere: null,
    roundIdx: null,
    progressLog: [],
    plannedFor: { safeDepthM: 1.5, clearanceM: 20, speedKn: 20 },
    routes: null,
    routeIdx: 0,
    shorterNote: null,
    ...extra,
  })
  return renderToString(createElement(ChartTab))
}

function fix(speedMps: number) {
  useTracker.setState({
    fix: { ...A, accuracy: 5, heading: 10, speed: speedMps, timestamp: Date.now() } as never,
  })
}

beforeEach(() => {
  useVessels.setState({
    cache: [
      {
        id: 'v1', name: 'Marine 2', callsign: '', draft_m: 1, under_keel_margin_m: 0.5, clearance_m: 20,
        cruise_speed_kn: 20, max_speed_kn: 30, fuel_burn_gph: 0, air_draft_m: 0, beam_m: 3, length_m: 8,
        team_id: null, user_id: 'u',
      },
    ],
    activeId: 'v1',
    ownerId: null,
  } as never)
  useEtaSpeed.setState({ mode: 'current', customKn: null })
  usePlanCourse.getState().dispatch({ type: 'cancel' })
  fix(0)
})

describe('the ETA speed choice', () => {
  it('stationary with "current": the preview says so and works the time at cruise — never days', () => {
    const tab = render('preview', MAIN)
    expect(tab).toContain('Not moving — ETA at cruise 20 kn')
    expect(tab).toMatch(/3\.20 NM · 10 min · ETA/)
    expect(tab).not.toMatch(/\d+ d \d+ h/)
  })

  it('offers Current, Cruise, Top and Custom, the chosen one checked, with the boat’s speeds', () => {
    useEtaSpeed.setState({ mode: 'top' })
    const tab = render('preview', MAIN)
    expect(tab).toContain('aria-label="Speed the ETA is worked at"')
    for (const m of ['Current', 'Cruise', 'Top', 'Custom']) expect(tab).toContain(`<span class="block">${m}</span>`)
    expect(tab).toMatch(/aria-checked="true"[^>]*><span class="block">Top<\/span>/)
    expect(tab).toContain('30 kn')
    expect(tab).toContain('ETA at 30 kn (top)')
    expect(tab).toMatch(/3\.20 NM · 6 min/)
  })

  it('custom: a speed box in the crew’s unit', () => {
    useEtaSpeed.setState({ mode: 'custom', customKn: 16 })
    const html = renderToString(createElement(EtaSpeedPicker, { cruiseKn: 20, topKn: 30 }))
    expect(html).toContain('Custom speed (kn)')
    expect(html).toContain('inputMode="decimal"')
    expect(html).toContain('value="16"')
  })

  it('on the steering card too, following the choice', () => {
    useEtaSpeed.setState({ mode: 'cruise' })
    fix(6)
    const tab = render('navigating', MAIN)
    expect(tab).toContain('ETA at 20 kn (cruise)')
    expect(tab).toContain('aria-label="Speed the ETA is worked at"')
  })

  it('fits 320 px: four equal cells that may shrink, labels truncated', () => {
    const html = renderToString(createElement(EtaSpeedPicker, { cruiseKn: 20, topKn: 30 }))
    expect(html).toContain('grid grid-cols-4 gap-1')
    expect(html.match(/min-h-11 min-w-0/g)).toHaveLength(4)
    expect(html).toContain('truncate')
  })
})

describe('route options — the faded alternatives', () => {
  it('lists Route 1 and Route 2 with what each saves and bends; the main route is selected', () => {
    const tab = render('preview', MAIN, { routes: ROUTES, routeIdx: 0, shorterNote: 'A way 2.2 NM shorter crosses water charted 3.5 ft — your boat needs 4.9 ft.' })
    expect(tab).toContain('aria-label="Routes to choose from"')
    expect(tab).toMatch(/aria-checked="true"[^>]*><span[^>]*><span>Route 1<\/span>/)
    expect(tab).toContain('Keeps your boat’s rules')
    expect(tab).toContain('Shallow 3.5 ft')
    expect(tab).toContain('A way 2.2 NM shorter crosses water charted 3.5 ft')
    // The route shown keeps the rules: a plain Start.
    expect(tab).toContain('>Start</button>')
  })

  it('an alternative selected needs "I understand" before Start, and its reason is on screen', () => {
    const tab = render('preview', ALT, { routes: ROUTES, routeIdx: 1 })
    expect(tab).toMatch(/aria-checked="true"[^>]*><span[^>]*><span>Route 2<\/span>/)
    expect(tab).toContain('I understand — start anyway')
    expect(tab).not.toContain('>Start</button>')
    expect(tab).toContain('crosses 3.5 ft near leg 1')
  })

  it('shows every waypoint with its coordinates, in the crew’s format', () => {
    const tab = render('preview', MAIN)
    expect(tab).toContain('WP 1')
    expect(tab).toContain('Dest')
    // toDDM writes "29° 18.000' N"; the server render escapes the apostrophe.
    expect(tab).toMatch(/29° \d+\.\d{3}(&#x27;|') N/)
  })
})

describe('save and share at the bottom', () => {
  it.each(['preview', 'navigating', 'arrived'] as const)('are there whenever a route is planned: %s', (status) => {
    const tab = render(status, MAIN)
    const save = tab.indexOf('Save this route')
    expect(save).toBeGreaterThan(-1)
    expect(tab).toContain('Share this route')
    expect(tab).toContain('Save as waypoints')
    // At the bottom: after the route's legs.
    expect(save).toBeGreaterThan(tab.indexOf('Waypoint reached within'))
  })

  it('are not there without a route', () => {
    expect(render('idle', null)).not.toContain('Share this route')
  })

  it('fit 320 px: two columns of buttons', () => {
    const tab = render('preview', MAIN)
    const section = tab.slice(tab.indexOf('aria-label="Save or share this route"'))
    expect(section).toContain('grid grid-cols-2 gap-2')
  })
})

describe('Plan a course — the steps, rendered', () => {
  const sheet = (hasFix = true) =>
    renderToString(
      createElement(PlanCourseSheet, {
        waypoints: [{ id: 'w1', name: 'Three Bird Island', lat: 29.62, lon: -94.89 }],
        hasFix,
        onCreate: () => {},
        onOpenSaved: () => {},
      }),
    )

  it('step 1: the four ways to set the starting point, and saved routes', () => {
    usePlanCourse.getState().dispatch({ type: 'open' })
    const html = sheet()
    expect(html).toContain('step 1 of 2')
    expect(html).toContain('Starting point')
    for (const w of ['Use my current location', 'Choose on map', 'Enter coordinates', 'Select a saved waypoint', 'Open a saved route']) {
      expect(html).toContain(w)
    }
    expect(html).not.toContain('Create route')
  })

  it('step 2: the destination — no "my location"', () => {
    usePlanCourse.getState().dispatch({ type: 'open' })
    usePlanCourse.getState().dispatch({ type: 'here', hasFix: true })
    const html = sheet()
    expect(html).toContain('step 2 of 2')
    expect(html).toContain('Choose destination on map')
    expect(html).not.toContain('Use my current location')
    expect(html).toContain('My location')
    expect(html).toContain('aria-label="Change the starting point"')
  })

  it('coordinates: the app’s own coordinate boxes', () => {
    usePlanCourse.getState().dispatch({ type: 'open' })
    usePlanCourse.getState().dispatch({ type: 'method', method: 'coords' })
    const html = sheet()
    expect(html).toContain('Use this position')
  })

  it('a searchable waypoint list', () => {
    usePlanCourse.getState().dispatch({ type: 'open' })
    usePlanCourse.getState().dispatch({ type: 'method', method: 'waypoint' })
    const html = sheet()
    expect(html).toContain('Search waypoints')
    expect(html).toContain('Three Bird Island')
  })

  it('both set: Create route', () => {
    usePlanCourse.getState().dispatch({ type: 'open' })
    usePlanCourse.getState().dispatch({ type: 'here', hasFix: true })
    usePlanCourse.getState().dispatch({ type: 'waypoint', place: { lat: 29.62, lon: -94.89, label: 'Three Bird Island' } })
    const html = sheet()
    expect(html).toContain('Ready to plan')
    expect(html).toContain('>Create route</button>')
  })

  it('no GPS fix: says so, and still lets the crew go on', () => {
    usePlanCourse.getState().dispatch({ type: 'open' })
    usePlanCourse.getState().dispatch({ type: 'here', hasFix: false })
    expect(sheet(false)).toContain('No GPS position yet')
  })

  it('picking on the chart: the sheet steps aside for the pick bar under the map', () => {
    usePlanCourse.getState().dispatch({ type: 'open' })
    usePlanCourse.getState().dispatch({ type: 'method', method: 'map' })
    expect(sheet()).toBe('')
    usePlanCourse.getState().dispatch({ type: 'tap', lat: 29.31, lon: -94.8 })
    const tab = render('idle', null)
    expect(tab).toContain('Starting point here?')
    expect(tab).toContain('>Confirm</button>')
  })
})
