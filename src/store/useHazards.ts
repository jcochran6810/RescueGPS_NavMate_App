import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
import { isOffline, isTransient, describeError } from '@/lib/retry'
import type { HazardSeverity, HazardType, IncidentHazard } from '@/lib/command'

/**
 * Hazards on the incident (`incident_hazards`, contract N7): what command has
 * marked and what crews have reported — a fuel spill, a submerged object, a
 * current strong enough to matter.
 *
 * A crew reports one at its own position. The report is queued like every
 * other capture, because the hazard a crew has just found is exactly the one
 * worth recording before the signal comes back. The row carries an id made on
 * the phone and is sent as an insert that does nothing if that id is already
 * there, so a report whose answer was lost is never filed twice.
 */

interface Report {
  hazard: IncidentHazard
  attempts?: number
}

interface FailedReport {
  hazard: IncidentHazard
  reason: string
}

const MAX_ATTEMPTS = 3

export interface NewHazard {
  hazard_type: HazardType
  severity: HazardSeverity
  lat: number
  lon: number
  label?: string
  description?: string
  radius_m?: number | null
}

interface HazardState {
  byIncident: Record<string, IncidentHazard[]>
  outbox: Report[]
  failed: FailedReport[]
  syncing: boolean
  ownerId: string | null

  load: (incidentId: string) => Promise<void>
  flush: () => Promise<void>
  subscribe: (incidentId: string) => () => void
  report: (incidentId: string, input: NewHazard) => Promise<IncidentHazard | null>
  discardFailed: () => void
  clearLocal: () => void
}

const online = () => typeof navigator === 'undefined' || navigator.onLine

function isTerminal(e: unknown): boolean {
  return !isOffline(e) && !isTransient(e)
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function upsertRow(list: IncidentHazard[], row: IncidentHazard): IncidentHazard[] {
  const i = list.findIndex((h) => h.id === row.id)
  if (i < 0) return [row, ...list]
  const next = [...list]
  next[i] = row
  return next
}

/** The cached hazards plus any report still waiting to go. */
export function visibleHazards(
  cached: IncidentHazard[],
  outbox: Report[],
  incidentId: string,
): IncidentHazard[] {
  let list = cached
  for (const r of outbox) {
    if (r.hazard.incident_id === incidentId && !list.some((h) => h.id === r.hazard.id)) {
      list = [r.hazard, ...list]
    }
  }
  return list
}

export const useHazards = create<HazardState>()(
  persist(
    (set, get) => ({
      byIncident: {},
      outbox: [],
      failed: [],
      syncing: false,
      ownerId: null,

      load: async (incidentId) => {
        const uid =
          (await supabase.auth.getSession()).data.session?.user?.id ?? null
        if (uid && get().ownerId && get().ownerId !== uid) get().clearLocal()
        if (uid) set({ ownerId: uid })
        if (!online()) return
        await get().flush()
        const { data, error } = await supabase
          .from('incident_hazards')
          .select(
            'id, incident_id, reported_by, hazard_type, severity, label, description, lat, lng, radius_m, geom_geojson, active, expires_at, created_at',
          )
          .eq('incident_id', incidentId)
          .eq('active', true)
          .order('created_at', { ascending: false })
        if (error) {
          console.warn('hazards load failed', errorMessage(error))
          return
        }
        set({
          byIncident: {
            ...get().byIncident,
            [incidentId]: (data ?? []) as IncidentHazard[],
          },
        })
      },

      flush: async () => {
        const out = get().outbox
        if (out.length === 0 || !online() || get().syncing) return
        const uid =
          (await supabase.auth.getSession()).data.session?.user?.id ?? null
        const owner = get().ownerId
        if (!uid || (owner !== null && owner !== uid)) return

        set({ syncing: true })
        let remaining: Report[] = []
        const failedNow: FailedReport[] = []
        const sent: IncidentHazard[] = []
        try {
          for (let i = 0; i < out.length; i++) {
            const { hazard, attempts } = out[i]
            const {
              id, incident_id, reported_by, hazard_type, severity, label,
              description, lat, lng, radius_m, created_at,
            } = hazard
            const { error } = await supabase
              .from('incident_hazards')
              .upsert(
                {
                  id, incident_id, reported_by, hazard_type, severity, label,
                  description, lat, lng, radius_m, active: true, created_at,
                },
                { onConflict: 'id', ignoreDuplicates: true },
              )
            if (!error) {
              sent.push(hazard)
              continue
            }
            if (isTerminal(error)) {
              const n = (attempts ?? 0) + 1
              if (n >= MAX_ATTEMPTS) {
                failedNow.push({ hazard, reason: describeError(error) })
                continue
              }
              remaining = [{ hazard, attempts: n }, ...out.slice(i + 1)]
            } else {
              remaining = out.slice(i)
            }
            break
          }
        } finally {
          const byIncident = { ...get().byIncident }
          for (const h of sent) {
            byIncident[h.incident_id] = upsertRow(byIncident[h.incident_id] ?? [], h)
          }
          set({
            byIncident,
            outbox: [...remaining, ...get().outbox.slice(out.length)],
            failed: [...get().failed, ...failedNow],
            syncing: false,
          })
        }
      },

      subscribe: (incidentId) => {
        const channel = supabase
          .channel(`navmate-hazards-${incidentId}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'incident_hazards',
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
                      [incidentId]: list.filter((h) => h.id !== gone),
                    },
                  })
                }
                return
              }
              const row = payload.new as IncidentHazard
              if (!row?.id) return
              set({
                byIncident: { ...get().byIncident, [incidentId]: upsertRow(list, row) },
              })
            },
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') void get().load(incidentId)
          })
        return () => void supabase.removeChannel(channel)
      },

      report: async (incidentId, input) => {
        const uid = (await supabase.auth.getSession()).data.session?.user?.id
        if (!uid) return null
        const hazard: IncidentHazard = {
          id: newId(),
          incident_id: incidentId,
          reported_by: uid,
          hazard_type: input.hazard_type,
          severity: input.severity,
          label: input.label?.trim() || null,
          description: input.description?.trim() || null,
          // Command tables say lng.
          lat: input.lat,
          lng: input.lon,
          radius_m: input.radius_m ?? null,
          geom_geojson: null,
          active: true,
          expires_at: null,
          created_at: new Date().toISOString(),
        }
        set({ ownerId: uid, outbox: [...get().outbox, { hazard }] })
        await get().flush()
        return hazard
      },

      discardFailed: () => set({ failed: [] }),

      clearLocal: () =>
        set({ byIncident: {}, outbox: [], failed: [], ownerId: null }),
    }),
    {
      name: 'navmate.hazards.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        byIncident: s.byIncident,
        outbox: s.outbox,
        failed: s.failed,
        ownerId: s.ownerId,
      }),
    },
  ),
)
