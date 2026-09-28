import { describe, it, expect, beforeEach, vi } from 'vitest'

/*
 * Saved routes and the ETA speed choice, kept on the phone (2026-09-28):
 * what is stored, what is read back (untrusted), whose routes they are, and
 * opening one mid-passage.
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

const nav = vi.hoisted(() => ({
  status: 'idle' as string,
  dest: { lat: 0, lon: 0, label: 'Pelican Island' } as { lat: number; lon: number; label: string } | null,
  openRoute: vi.fn(async () => {}),
}))
vi.mock('@/store/useNavigation', () => ({ useNavigation: { getState: () => nav } }))

import type { RoutePlan } from '@/lib/routing'
import { MAX_SAVED_ROUTES, defaultRouteName, useSavedRoutes, type SavedRoute } from '@/store/useSavedRoutes'
import { useEtaSpeed } from '@/store/useEtaSpeed'
import { openSavedRoute } from '@/store/openSavedRoute'

const A = { lat: 29.698, lon: -94.9985 }
const B = { lat: 29.634, lon: -94.8866 }
const PLAN = {
  points: [A, B],
  legs: [{ n: 1, from: A, to: B, courseDeg: 120, lengthNM: 6.9, caution: 'ok' }],
  totalNM: 6.9,
  source: 'charted',
} as unknown as RoutePlan

const ENTRY: Omit<SavedRoute, 'id' | 'savedAt'> = {
  name: 'Morgan’s Point → Three Bird Island',
  start: { ...A, label: 'Morgan’s Point' },
  startWasMyLocation: false,
  dest: { ...B, label: 'Three Bird Island' },
  plan: PLAN,
  boatName: 'Marine 2',
  safeDepthM: 1.5,
  clearanceM: 30,
  routeIdx: 0,
}

beforeEach(() => {
  mem.clear()
  useSavedRoutes.setState({ routes: [], ownerId: null })
  nav.status = 'idle'
  nav.openRoute.mockClear()
})

describe('saved routes', () => {
  it('saves everything needed to open it again, newest first, and keeps it on the phone', () => {
    const one = useSavedRoutes.getState().save(ENTRY)
    const two = useSavedRoutes.getState().save({ ...ENTRY, name: 'Second' })
    expect(one.id).not.toBe(two.id)
    expect(Date.parse(one.savedAt)).not.toBeNaN()
    expect(useSavedRoutes.getState().routes.map((r) => r.name)).toEqual(['Second', ENTRY.name])
    const stored = JSON.parse(mem.get('navmate.routes.v1')!) as { state: { routes: SavedRoute[] } }
    expect(stored.state.routes[1]).toMatchObject({
      name: ENTRY.name,
      startWasMyLocation: false,
      boatName: 'Marine 2',
      safeDepthM: 1.5,
      clearanceM: 30,
      routeIdx: 0,
      plan: { points: [A, B], totalNM: 6.9 },
    })
  })

  it('names it "<start> → <destination>" unless the crew does, cleaned', () => {
    expect(defaultRouteName('Morgan’s Point', 'Three Bird Island')).toBe('Morgan’s Point → Three Bird Island')
    expect(useSavedRoutes.getState().save({ ...ENTRY, name: '   ' }).name).toBe('Morgan’s Point → Three Bird Island')
    expect(useSavedRoutes.getState().save({ ...ENTRY, name: 'x'.repeat(300) }).name).toHaveLength(80)
  })

  it('renames and deletes; an empty rename keeps the old name', () => {
    const r = useSavedRoutes.getState().save(ENTRY)
    useSavedRoutes.getState().rename(r.id, 'To the birds')
    expect(useSavedRoutes.getState().routes[0].name).toBe('To the birds')
    useSavedRoutes.getState().rename(r.id, '  ')
    expect(useSavedRoutes.getState().routes[0].name).toBe('To the birds')
    useSavedRoutes.getState().remove(r.id)
    expect(useSavedRoutes.getState().routes).toEqual([])
  })

  it('keeps at most MAX_SAVED_ROUTES, dropping the oldest', () => {
    for (let i = 0; i < MAX_SAVED_ROUTES + 5; i++) useSavedRoutes.getState().save({ ...ENTRY, name: `R${i}` })
    const names = useSavedRoutes.getState().routes.map((r) => r.name)
    expect(names).toHaveLength(MAX_SAVED_ROUTES)
    expect(names[0]).toBe(`R${MAX_SAVED_ROUTES + 4}`)
    expect(names).not.toContain('R0')
  })

  it('reads back what is stored as untrusted: a broken entry is dropped, the rest kept', async () => {
    const good = { ...ENTRY, id: 'g', savedAt: '2026-09-28T12:00:00Z' }
    const broken = [
      null,
      { ...good, id: 7 },
      { ...good, id: 'p', plan: { points: [A], legs: [] } },
      { ...good, id: 'l', plan: { points: [A, B], legs: [] } },
    ]
    mem.set('navmate.routes.v1', JSON.stringify({ state: { routes: [good, ...broken], ownerId: 'u1' }, version: 1 }))
    await useSavedRoutes.persist.rehydrate()
    expect(useSavedRoutes.getState().routes.map((r) => r.id)).toEqual(['g'])
    expect(useSavedRoutes.getState().ownerId).toBe('u1')
    mem.set('navmate.routes.v1', JSON.stringify({ state: { routes: 'nope', ownerId: 5 }, version: 1 }))
    await useSavedRoutes.persist.rehydrate()
    expect(useSavedRoutes.getState()).toMatchObject({ routes: [], ownerId: null })
  })

  it('belongs to the account signed in: another account does not see them', () => {
    useSavedRoutes.getState().bindOwner('u1')
    useSavedRoutes.getState().save(ENTRY)
    useSavedRoutes.getState().bindOwner('u1')
    expect(useSavedRoutes.getState().routes).toHaveLength(1)
    useSavedRoutes.getState().bindOwner('u2')
    expect(useSavedRoutes.getState()).toMatchObject({ routes: [], ownerId: 'u2' })
    // Saved before anyone signed in: the first account to sign in keeps them.
    useSavedRoutes.setState({ routes: [], ownerId: null })
    useSavedRoutes.getState().save(ENTRY)
    useSavedRoutes.getState().bindOwner('u3')
    expect(useSavedRoutes.getState()).toMatchObject({ ownerId: 'u3' })
    expect(useSavedRoutes.getState().routes).toHaveLength(1)
  })
})

describe('opening a saved route', () => {
  it('opens it through the navigation store, re-checked there', async () => {
    const r = useSavedRoutes.getState().save(ENTRY)
    expect(await openSavedRoute(r)).toBe(true)
    expect(nav.openRoute).toHaveBeenCalledWith({ plan: PLAN, dest: r.dest, origin: r.start, name: r.name })
  })

  it('mid-passage, asks before replacing the route being steered — and leaves it if the crew says no', async () => {
    const r = useSavedRoutes.getState().save(ENTRY)
    nav.status = 'navigating'
    const confirm = vi.fn(() => false)
    ;(globalThis as Record<string, unknown>).window = { confirm }
    try {
      expect(await openSavedRoute(r)).toBe(false)
      expect(confirm).toHaveBeenCalledWith(
        'Stop the route to Pelican Island and open “Morgan’s Point → Three Bird Island” instead?',
      )
      expect(nav.openRoute).not.toHaveBeenCalled()
      confirm.mockReturnValue(true)
      expect(await openSavedRoute(r)).toBe(true)
      expect(nav.openRoute).toHaveBeenCalledTimes(1)
    } finally {
      delete (globalThis as Record<string, unknown>).window
    }
  })
})

describe('the ETA speed choice is kept', () => {
  it('stores the mode and the custom speed', () => {
    useEtaSpeed.getState().setMode('top')
    useEtaSpeed.getState().setCustomKn(18)
    expect(JSON.parse(mem.get('navmate.eta.v1')!).state).toEqual({ mode: 'top', customKn: 18 })
  })

  it('refuses a mode that is not one of the four and a speed that is not sane', () => {
    useEtaSpeed.setState({ mode: 'cruise', customKn: null })
    useEtaSpeed.getState().setMode('warp' as never)
    expect(useEtaSpeed.getState().mode).toBe('cruise')
    for (const bad of [0, -4, 500, Number.NaN]) {
      useEtaSpeed.getState().setCustomKn(bad)
      expect(useEtaSpeed.getState().customKn).toBeNull()
    }
  })

  it('reads back what is stored as untrusted', async () => {
    mem.set('navmate.eta.v1', JSON.stringify({ state: { mode: 'custom', customKn: 22.5 }, version: 1 }))
    await useEtaSpeed.persist.rehydrate()
    expect(useEtaSpeed.getState()).toMatchObject({ mode: 'custom', customKn: 22.5 })
    mem.set('navmate.eta.v1', JSON.stringify({ state: { mode: 'ludicrous', customKn: '99' }, version: 1 }))
    useEtaSpeed.setState({ mode: 'current', customKn: null })
    await useEtaSpeed.persist.rehydrate()
    expect(useEtaSpeed.getState()).toMatchObject({ mode: 'current', customKn: null })
  })
})
