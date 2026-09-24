import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
import {
  latestLkp,
  searchAreaRing,
  type LatLon,
  type LkpHistoryRow,
  type SearchArea,
} from '@/lib/command'

/**
 * The search picture as command holds it (contract N8): the areas drawn on
 * the incident (`search_areas`) and the incident's current LKP (the newest
 * row of `lkp_history`). Read-only — the field has no business redrawing a
 * search area — and cached per incident so the picture stays on the chart
 * once the signal has gone.
 */

export interface CommandLkp extends LatLon {
  time: string
  source: string | null
}

interface SearchAreaState {
  byIncident: Record<string, SearchArea[]>
  lkpByIncident: Record<string, CommandLkp | null>
  ownerId: string | null

  load: (incidentId: string) => Promise<void>
  /** Just the LKP — one row, cheap enough to re-read on a timer. */
  loadLkp: (incidentId: string) => Promise<void>
  subscribe: (incidentId: string) => () => void
  clearLocal: () => void
}

const online = () => typeof navigator === 'undefined' || navigator.onLine

const AREA_COLUMNS =
  'id, incident_id, name, area_type, polygon, coordinates, status, priority' as const

function upsertArea(list: SearchArea[], row: SearchArea): SearchArea[] {
  const i = list.findIndex((a) => a.id === row.id)
  if (i < 0) return [...list, row]
  const prev = list[i]
  const next = [...list]
  // Realtime carries a geography as EWKB hex; keep the outline already read.
  next[i] =
    searchAreaRing(row) === null && searchAreaRing(prev) !== null
      ? { ...row, polygon: prev.polygon, coordinates: prev.coordinates }
      : row
  return next
}

export const useSearchAreas = create<SearchAreaState>()(
  persist(
    (set, get) => ({
      byIncident: {},
      lkpByIncident: {},
      ownerId: null,

      load: async (incidentId) => {
        const uid =
          (await supabase.auth.getSession()).data.session?.user?.id ?? null
        if (uid && get().ownerId && get().ownerId !== uid) get().clearLocal()
        if (uid) set({ ownerId: uid })
        if (!online()) return
        const { data, error } = await supabase
          .from('search_areas')
          .select(AREA_COLUMNS)
          .eq('incident_id', incidentId)
        if (error) console.warn('search areas load failed', errorMessage(error))
        else {
          set({
            byIncident: {
              ...get().byIncident,
              [incidentId]: (data ?? []) as SearchArea[],
            },
          })
        }
        await get().loadLkp(incidentId)
      },

      loadLkp: async (incidentId) => {
        if (!online()) return
        const { data, error } = await supabase
          .from('lkp_history')
          .select('incident_id, lat, lng, time, source, confidence, deleted_at')
          .eq('incident_id', incidentId)
          .is('deleted_at', null)
          .order('time', { ascending: false })
          .limit(5)
        if (error) {
          console.warn('lkp load failed', errorMessage(error))
          return
        }
        set({
          lkpByIncident: {
            ...get().lkpByIncident,
            [incidentId]: latestLkp((data ?? []) as LkpHistoryRow[]),
          },
        })
      },

      subscribe: (incidentId) => {
        const channel = supabase
          .channel(`navmate-areas-${incidentId}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'search_areas',
              filter: `incident_id=eq.${incidentId}`,
            },
            (payload) => {
              const list = get().byIncident[incidentId] ?? []
              if (payload.eventType === 'DELETE') {
                const gone = (payload.old as { id?: string })?.id
                if (gone) {
                  set({
                    byIncident: {
                      ...get().byIncident,
                      [incidentId]: list.filter((a) => a.id !== gone),
                    },
                  })
                }
                return
              }
              const row = payload.new as SearchArea
              if (!row?.id) return
              const known = list.some((a) => a.id === row.id)
              set({
                byIncident: { ...get().byIncident, [incidentId]: upsertArea(list, row) },
              })
              // A new area whose outline came as hex: re-read through
              // PostgREST, which returns it as GeoJSON.
              if (!known && searchAreaRing(row) === null) void get().load(incidentId)
            },
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') void get().load(incidentId)
          })
        return () => void supabase.removeChannel(channel)
      },

      clearLocal: () => set({ byIncident: {}, lkpByIncident: {}, ownerId: null }),
    }),
    {
      name: 'navmate.searchareas.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        byIncident: s.byIncident,
        lkpByIncident: s.lkpByIncident,
        ownerId: s.ownerId,
      }),
    },
  ),
)
