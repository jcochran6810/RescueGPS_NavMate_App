import { describe, it, expect, vi, beforeEach } from 'vitest'

/*
 * The Chart tab, the steering card and the banner rendered to HTML in node —
 * one pass per navigation state — so a render-time crash, or a state that
 * shows the wrong thing (a Start button on an unconfirmed best-effort route,
 * a line with no route), fails here rather than on a phone at sea.
 *
 * No DOM: `react-dom/server`. Zustand's hook is swapped for one that reads
 * the live state, because server rendering otherwise shows each store's
 * INITIAL state, whatever the test set.
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
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true },
    configurable: true,
  })
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

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { projectPosition } from '@/lib/sar'
import type { RoutePlan } from '@/lib/routing'
import { useNavigation, type NavStatus } from '@/store/useNavigation'
import { useTracker } from '@/store/useTracker'
import { useVessels } from '@/store/useVessels'
import { ChartTab } from '@/tabs/ChartTab'
import { NavBanner } from '@/components/NavBanner'

const A = { lat: 29.3, lon: -94.8 }
const B = projectPosition(A.lat, A.lon, 0, 1)
const C = projectPosition(B.lat, B.lon, 90, 0.05)

function leg(n: number, caution: RoutePlan['legs'][number]['caution']) {
  return {
    n,
    courseDeg: n === 1 ? 0 : 90,
    lengthNM: 1,
    etaHours: 1,
    minChartedDepthM: 1,
    channelFraction: null,
    caution,
    minClearanceM: 4,
  }
}

const BEST_EFFORT = {
  points: [A, B, C],
  legs: [leg(1, 'shallow-approach'), leg(2, 'unsafe-depth')],
  totalNM: 1.05,
  hours: 0.05,
  source: 'best-effort',
  coverage: 'full',
  warnings: ['No route keeps 5 ft of water the whole way.'],
  movedStart: null,
  movedEnd: null,
  outsideChannelNM: null,
  arrivalFt: [150, 40, 150],
  failure: null,
  needsConfirm: true,
} as unknown as RoutePlan

const CHARTED = {
  ...BEST_EFFORT,
  legs: [leg(1, 'ok'), leg(2, 'ok')],
  source: 'charted',
  warnings: [],
  needsConfirm: false,
} as unknown as RoutePlan

const NONE = {
  ...BEST_EFFORT,
  points: [],
  legs: [],
  source: 'none',
  failure: 'No charted water route joins the start and the destination.',
  needsConfirm: false,
} as unknown as RoutePlan

const DEST = { ...C, label: 'Datum' }

function render(status: NavStatus, plan: RoutePlan | null, extra: object = {}) {
  useNavigation.setState({
    status,
    plan,
    dest: status === 'idle' ? null : DEST,
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
    plannedFor: null,
    ...extra,
  })
  return {
    tab: renderToString(createElement(ChartTab)),
    banner: renderToString(createElement(NavBanner, { onOpen: () => {} })),
  }
}

beforeEach(() => {
  useVessels.setState({
    cache: [
      {
        id: 'v1',
        name: 'FB2',
        callsign: '',
        draft_m: 1,
        under_keel_margin_m: 0.5,
        clearance_m: 20,
        cruise_speed_kn: 20,
        max_speed_kn: 30,
        fuel_burn_gph: 0,
        air_draft_m: 0,
        beam_m: 3,
        length_m: 8,
        team_id: null,
        user_id: 'u',
      },
    ],
    activeId: 'v1',
    ownerId: null,
  } as never)
  useTracker.setState({
    fix: {
      ...projectPosition(A.lat, A.lon, 0, 0.5),
      accuracy: 5,
      heading: 10,
      speed: 5,
      timestamp: Date.now(),
    } as never,
  })
})

describe('Chart tab, by navigation state', () => {
  it('idle: asks where to, no banner', () => {
    const r = render('idle', null)
    expect(r.tab).toContain('Where to?')
    expect(r.tab).toContain('My location')
    expect(r.banner).toBe('')
  })

  it('planning: says it is finding a route', () => {
    expect(render('planning', null).tab).toContain('Finding a safe route from your position')
  })

  it('preview, charted: summary and a big Start', () => {
    const r = render('preview', CHARTED)
    expect(r.tab).toMatch(/1\.05 NM · 3 min · ETA/)
    expect(r.tab).toContain('>Start</button>')
    expect(r.tab).not.toContain('I understand')
    expect(r.tab).toContain('Waypoint reached within')
  })

  it('preview, best-effort: red warning and the explicit confirmation — no plain Start', () => {
    const r = render('preview', BEST_EFFORT)
    expect(r.tab).toContain('Not a fully safe route.')
    expect(r.tab).toContain('I understand — start anyway')
    expect(r.tab).not.toContain('>Start</button>')
    expect(r.tab).toContain('Check depth here')
    expect(r.tab).toContain('Too shallow')
  })

  it('failed: no line, the reason, what to change and Retry', () => {
    const r = render('failed', NONE, { error: NONE.failure })
    expect(r.tab).toContain(NONE.failure!)
    expect(r.tab).toContain('Pick another point')
    expect(r.tab).toContain('Edit boat')
    expect(r.tab).toContain('Retry')
    expect(r.tab).not.toContain('>Start</button>')
  })

  it('navigating: the big card on the Chart tab, the banner elsewhere', () => {
    const r = render('navigating', CHARTED, { rerouting: true, gpsPoor: true })
    expect(r.tab).toContain('To waypoint 1 of 2')
    expect(r.tab).toContain('000°T')
    expect(r.tab).toContain('Counts as reached within 40 ft')
    expect(r.tab).toContain('Re-routing…')
    expect(r.tab).toContain('GPS accuracy is poor')
    expect(r.tab).toContain('>End</button>')
    expect(r.banner).toContain('WP 1 · 000°T · 0.50 NM')
  })

  it('arrived: says so, with Done (one button — the passage is over)', () => {
    const r = render('arrived', CHARTED)
    expect(r.tab).toContain('You have arrived at Datum')
    // Renamed on purpose (finding UI-7): End after arriving finishes the
    // passage — "Done" — instead of offering the old route again.
    expect(r.tab).toContain('>Done</button>')
    expect(r.tab).not.toContain('Clear route')
    expect(r.banner).toContain('You have arrived at Datum')
  })

  it('preview: the summary and Start come before the map, on the first screen (UI-2)', () => {
    const r = render('preview', CHARTED)
    const start = r.tab.indexOf('>Start</button>')
    const map = r.tab.indexOf('Base layer')
    expect(start).toBeGreaterThan(-1)
    expect(start).toBeLessThan(map)
    expect(r.tab.indexOf('1.05 NM · 3 min')).toBeLessThan(map)
    // The intro paragraph folds away once there is a destination.
    expect(r.tab).not.toContain('Pick where you are going')
  })

  it('best-effort: the red box leads with how the route falls short, not the dock note (R5)', () => {
    const plan = {
      ...BEST_EFFORT,
      warnings: [
        'The chart shows your start on land…',
        'No route keeps 5 ft of water the whole way. The safest route crosses 3 ft near leg 2.',
      ],
      confirmReason: 'No route keeps 5 ft of water the whole way. The safest route crosses 3 ft near leg 2.',
    } as unknown as RoutePlan
    const r = render('preview', plan)
    const red = r.tab.indexOf('Not a fully safe route.')
    expect(r.tab.slice(red, red + 300)).toContain('No route keeps 5 ft of water')
    // The dock note is still there, among the other warnings.
    expect(r.tab).toContain('The chart shows your start on land')
    const map = r.tab.indexOf('Base layer')
    expect(r.tab.indexOf('I understand — start anyway')).toBeLessThan(map)
  })

  it('a dock hop is dotted and "by eye", and does not make the route unsafe (R5)', () => {
    const plan = {
      ...CHARTED,
      legs: [{ ...leg(1, 'off-chart-end') }, leg(2, 'ok')],
    } as unknown as RoutePlan
    const r = render('preview', plan)
    expect(r.tab).toContain('Leave the dock by eye')
    expect(r.tab).toContain('>Start</button>')
    expect(r.tab).not.toContain('Not a fully safe route.')
  })

  it('shows the arrival distance a route really uses when the Search tab set 50 ft (R13)', () => {
    useTracker.setState({ arrivalFt: 50 } as never)
    const r = render('preview', CHARTED)
    expect(r.tab).toMatch(/aria-checked="true"[^>]*>100 ft/)
    expect(r.tab).toContain('routes use 100 ft')
    useTracker.setState({ arrivalFt: 150 } as never)
  })

  it('says where an old route is really from, not "My location" (UI-7)', () => {
    // The fix is 0.5 NM from the route's start.
    const r = render('preview', CHARTED)
    expect(r.tab).toContain('Where you were when planned')
  })

  it('navigating a flagged leg says so on the card (R11)', () => {
    const plan = { ...CHARTED, legs: [leg(1, 'unsafe-depth'), leg(2, 'ok')], source: 'best-effort', needsConfirm: true } as unknown as RoutePlan
    const r = render('navigating', plan, { confirmed: true })
    expect(r.tab).toContain('This leg: too shallow')
    expect(r.banner).toContain('Shallow leg')
  })

  it('a best-effort re-route waiting for the crew: still steering, with the choice on the card and an alert banner (R2)', () => {
    const r = render('navigating', CHARTED, { pendingPlan: BEST_EFFORT })
    expect(r.tab).toContain('To waypoint 1 of 2')
    expect(r.tab).toContain('I understand — steer it')
    expect(r.tab).toContain('Keep current route')
    expect(r.banner).toContain('Re-route needs your OK')
  })

  it('steering paused for a changed boat keeps an alert banner on the other tabs (R2 / R1)', () => {
    const r = render('preview', BEST_EFFORT, { reconfirm: true })
    expect(r.banner).toContain('Route changed — not fully safe')
    expect(render('preview', BEST_EFFORT, { reconfirm: false }).banner).toBe('')
  })

  it('does not put the moving numbers in the live region (regress R8)', () => {
    const r = render('navigating', CHARTED)
    const live = r.tab.match(/<span class="sr-only" aria-live="polite">([\s\S]*?)<\/span>/)
    expect(live).not.toBeNull()
    expect(live![1]).toContain('To waypoint 1 of 2')
    expect(live![1]).not.toMatch(/NM|ETA|°T/)
  })

  it('the steering numbers wrap on a narrow phone instead of running off it (UI-1)', () => {
    // A slow boat on a long way: "10 h 16 min"-style times.
    useVessels.setState({ cache: [{ ...useVessels.getState().cache[0], cruise_speed_kn: 0.0536 }] } as never)
    try {
      const r = render('navigating', CHARTED, { speedKn: null })
      // Two fixed rows (UI3 #1): STEER and the course; then the waypoint,
      // its bearing and distance, which wraps rather than running off.
      expect(r.tab).toContain('>Steer</span>')
      expect(r.tab).toContain('tnum mt-1 flex flex-wrap items-baseline')
      expect(r.tab).toMatch(/max-\[359px\]:text-\[2\.5rem\]/)
      // The three passage cells may shrink and break; none is nowrap.
      const grid = r.tab.slice(r.tab.indexOf('grid grid-cols-3'), r.tab.indexOf('>End</button>'))
      expect(grid.match(/min-w-0 bg-navy-900 px-1\.5 py-2 min-\[360px\]:px-2 min-\[400px\]:px-3/g)).toHaveLength(3)
      expect(grid).toContain('[overflow-wrap:anywhere]')
      expect(grid).not.toMatch(/class="[^"]*whitespace-nowrap[^"]*text-slate-50/)
      // "10 h 16 min" breaks between the hours and the minutes, not inside.
      expect(grid).toMatch(/\d+\u00a0h \d+\u00a0min/)
    } finally {
      useVessels.setState({ cache: [{ ...useVessels.getState().cache[0], cruise_speed_kn: 20 }] } as never)
    }
  })

  it('says to round the turn point first, on the card and the banner (C1)', () => {
    // Switched to the destination, but the line to it is not clear: round
    // waypoint 1 first.
    const r = render('navigating', CHARTED, { targetIdx: 2, roundIdx: 1 })
    expect(r.tab).toContain('Round waypoint 1 first — don’t cut the corner')
    expect(r.tab).toContain('Then the destination')
    expect(r.tab).toContain('not clear of the shallows, land or your stand-off')
    // UI3 #2: the status on its own line, then the waypoint, its bearing
    // and distance.
    expect(r.banner).toContain('Round WP 1 first')
    expect(r.banner).toContain('WP 1 · 000°T')
  })

  it('says when the GPS error is wider than the boat’s margin, and "may be" near a shoal (M1)', () => {
    useTracker.setState({ fix: { ...useTracker.getState().fix!, accuracy: 12, timestamp: Date.now() } as never })
    try {
      const r = render('navigating', CHARTED, {
        plannedFor: { safeDepthM: 1.5, clearanceM: 5, speedKn: 20 },
        shallowHere: { depthM: 0.9, land: false, maybe: true },
      })
      expect(r.tab).toContain('GPS accuracy ±39 ft — wider than your safety margin (16 ft). Keep a sharp lookout.')
      expect(r.tab).toContain('You may be in water too shallow for your boat')
      // Amber, not the red of "the chart shows land here".
      expect(r.tab).toMatch(/border-amber-400\/60 bg-amber-500\/15 text-amber-100[^>]*>You may be in water/)
      expect(r.banner).toContain('May be shallow')
    } finally {
      useTracker.setState({ fix: { ...useTracker.getState().fix!, accuracy: 5 } as never })
    }
  })
})
