import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
import {
  commandLkp,
  riverSegmentPatch,
  searchAreaRing,
  type RiverSegmentStatus,
  type IncidentLkpRow,
  type LatLon,
  type LkpHistoryRow,
  type SearchArea,
} from '@/lib/command'

/**
 * The search picture as command holds it (contract N8): the areas drawn on
 * the incident (`search_areas`) and the incident's current LKP — the
 * incident row's own `lkp_lat`/`lkp_lng`, which is what command moves, with
 * the newest `lkp_history` row as the fallback (`commandLkp`). Read-only —
 * the field has no business redrawing a search area — and cached per
 * incident so the picture stays on the chart once the signal has gone.
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
  /** A crew's mark on a river segment (status, who, when — nothing else). */
  markSegment: (area: SearchArea, status: RiverSegmentStatus) => Promise<{ ok: boolean; reason?: string }>
  clearLocal: () => void
}

const online = () => typeof navigator === 'undefined' || navigator.onLine

const AREA_COLUMNS =
  'id, incident_id, name, area_type, polygon, coordinates, status, priority' as const
// River segment columns (RescueGPS NW4). A database without them answers
// 42703 (undefined column); the base columns are read instead.
const SEGMENT_COLUMNS =
  `${AREA_COLUMNS}, segment_number, along_start_m, along_end_m, poc, pod, source, searched_at, searched_by, deleted_at` as const

function upsertArea(list: SearchArea[], row: SearchArea): SearchArea[] {
  const i = list.findIndex((a) => a.id === row.id)
  if (i < 0) return [...list, row]
  const prev = list[i]
  const next = [...list]
  // A geography arrives as EWKB hex (read by `parsePolygon`); should a copy
  // ever be unreadable, keep the outline already read rather than erase it.
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
        const full = await supabase
          .from('search_areas')
          .select(SEGMENT_COLUMNS)
          .eq('incident_id', incidentId)
        const { data, error } =
          full.error && (full.error as { code?: string }).code === '42703'
            ? await supabase.from('search_areas').select(AREA_COLUMNS).eq('incident_id', incidentId)
            : full
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
        // The incident row is command's LKP (`commandLkp`); the history is
        // only read for an incident whose row has none.
        const [row, history] = await Promise.all([
          supabase
            .from('incidents')
            .select('lkp_lat, lkp_lng, lkp_time, lkp_source, updated_at')
            .eq('id', incidentId)
            .maybeSingle(),
          supabase
            .from('lkp_history')
            .select('incident_id, lat, lng, time, source, confidence, deleted_at')
            .eq('incident_id', incidentId)
            .is('deleted_at', null)
            .order('time', { ascending: false })
            .limit(5),
        ])
        if (row.error && history.error) {
          console.warn('lkp load failed', errorMessage(row.error))
          return
        }
        set({
          lkpByIncident: {
            ...get().lkpByIncident,
            [incidentId]: commandLkp(
              (row.data ?? null) as IncidentLkpRow | null,
              (history.data ?? []) as LkpHistoryRow[],
            ),
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
              // A new area whose outline could not be read from the change:
              // read the table again rather than draw nothing.
              if (!known && searchAreaRing(row) === null) void get().load(incidentId)
            },
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') void get().load(incidentId)
          })
        return () => void supabase.removeChannel(channel)
      },

      markSegment: async (area, status) => {
        if (!online()) return { ok: false, reason: 'offline — try again with signal' }
        const uid = (await supabase.auth.getSession()).data.session?.user?.id ?? null
        const patch = riverSegmentPatch(status, uid, new Date().toISOString())
        const { error } = await supabase.from('search_areas').update(patch).eq('id', area.id)
        if (error) return { ok: false, reason: errorMessage(error) }
        const list = get().byIncident[area.incident_id] ?? []
        set({
          byIncident: {
            ...get().byIncident,
            [area.incident_id]: upsertArea(list, { ...area, ...patch }),
          },
        })
        return { ok: true }
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
