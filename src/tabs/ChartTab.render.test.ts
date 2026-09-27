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

  it('arrived: says so, with End', () => {
    const r = render('arrived', CHARTED)
    expect(r.tab).toContain('You have arrived at Datum')
    expect(r.tab).toContain('>End</button>')
    expect(r.banner).toContain('You have arrived at Datum')
  })
})
