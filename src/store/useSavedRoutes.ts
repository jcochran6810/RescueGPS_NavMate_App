import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { RoutePlan } from '@/lib/routing'
import { cleanLabel } from '@/lib/routeShare'

/**
 * Named routes kept on this phone (2026-09-28: "Save this route").
 *
 * Local only — no table yet — and scoped to the signed-in account the way the
 * passage is (`bindOwner`): another account's saved routes are not this
 * crew's to see. A saved route is never steered as it was saved: opening it
 * re-checks it for the boat now selected (`useNavigation.openRoute`).
 */

export interface SavedEnd {
  lat: number
  lon: number
  label: string
}

export interface SavedRoute {
  id: string
  name: string
  savedAt: string
  start: SavedEnd
  /** The start was "my location" when it was planned. */
  startWasMyLocation: boolean
  dest: SavedEnd
  /** The whole plan as it was — points, legs, flags. */
  plan: RoutePlan
  boatName: string | null
  safeDepthM: number | null
  clearanceM: number | null
  /** Which of the offered routes it was (0 = the one keeping every rule). */
  routeIdx: number
}

/** Most routes kept; the oldest go first. */
export const MAX_SAVED_ROUTES = 50

export interface SavedRoutesState {
  routes: SavedRoute[]
  ownerId: string | null
  save: (r: Omit<SavedRoute, 'id' | 'savedAt'>) => SavedRoute
  rename: (id: string, name: string) => void
  remove: (id: string) => void
  /** The signed-in account: another account's routes are cleared. */
  bindOwner: (uid: string | null) => void
}

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined
  return c?.randomUUID ? c.randomUUID() : `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** "Morgan's Point → Three Bird Island" */
export function defaultRouteName(start: string, dest: string): string {
  return cleanLabel(`${cleanLabel(start, 'Start')} → ${cleanLabel(dest, 'Destination')}`, 'Route')
}

function sane(r: unknown): r is SavedRoute {
  const x = r as SavedRoute
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.name === 'string' &&
    !!x.plan &&
    Array.isArray(x.plan.points) &&
    x.plan.points.length >= 2 &&
    Array.isArray(x.plan.legs) &&
    x.plan.legs.length === x.plan.points.length - 1
  )
}

export const useSavedRoutes = create<SavedRoutesState>()(
  persist(
    (set, get) => ({
      routes: [],
      ownerId: null,
      save: (r) => {
        const saved: SavedRoute = {
          ...r,
          name: cleanLabel(r.name, defaultRouteName(r.start.label, r.dest.label)),
          id: newId(),
          savedAt: new Date().toISOString(),
        }
        set({ routes: [saved, ...get().routes].slice(0, MAX_SAVED_ROUTES) })
        return saved
      },
      rename: (id, name) =>
        set({
          routes: get().routes.map((r) => (r.id === id ? { ...r, name: cleanLabel(name, r.name) } : r)),
        }),
      remove: (id) => set({ routes: get().routes.filter((r) => r.id !== id) }),
      bindOwner: (uid) => {
        const owner = get().ownerId
        if (owner && uid && owner !== uid) {
          set({ routes: [], ownerId: uid })
          return
        }
        if (uid && owner !== uid) set({ ownerId: uid })
      },
    }),
    {
      name: 'navmate.routes.v1',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ routes: s.routes, ownerId: s.ownerId }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SavedRoutesState>
        return {
          ...current,
          ownerId: typeof p.ownerId === 'string' ? p.ownerId : null,
          routes: Array.isArray(p.routes) ? p.routes.filter(sane).slice(0, MAX_SAVED_ROUTES) : [],
        }
      },
    },
  ),
)
