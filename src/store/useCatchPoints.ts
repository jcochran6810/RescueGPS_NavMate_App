import { setAsideFor, takeUnsent, prependFrom } from '@/lib/accountStash'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
import { isOffline, isTransient, describeError } from '@/lib/retry'
import type { CatchPoint, CatchPointKind } from '@/lib/command'

/**
 * Catch points (RescueGPS Narrow Water Search NW5, table `catch_points`):
 * places on the water a crew has seen that may hold a subject or an object —
 * a strainer, a log jam, an eddy, a low-head dam, a snag. A crew reports one
 * at its own position; command sees it on its map with when its drift cloud
 * gets there, and command's own catch points show here.
 *
 * Queued exactly like a hazard report: an id made on the phone, an insert
 * that does nothing if that id is already there, so a lost answer never files
 * the point twice. A database without the table refuses the report; it is
 * moved to `failed` with the reason.
 */

interface Report {
  point: CatchPoint
  attempts?: number
}

interface FailedReport {
  point: CatchPoint
  reason: string
}

const MAX_ATTEMPTS = 3

export interface NewCatchPoint {
  kind: CatchPointKind
  lat: number
  lon: number
  label?: string
  notes?: string
}

interface CatchPointState {
  byIncident: Record<string, CatchPoint[]>
  outbox: Report[]
  failed: FailedReport[]
  syncing: boolean
  ownerId: string | null

  load: (incidentId: string) => Promise<void>
  flush: () => Promise<void>
  subscribe: (incidentId: string) => () => void
  report: (incidentId: string, input: NewCatchPoint) => Promise<CatchPoint | null>
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

function upsertRow(list: CatchPoint[], row: CatchPoint): CatchPoint[] {
  const i = list.findIndex((h) => h.id === row.id)
  if (i < 0) return [row, ...list]
  const next = [...list]
  next[i] = row
  return next
}

/** The cached points plus any report still waiting to go; deleted ones left out. */
export function visibleCatchPoints(
  cached: CatchPoint[],
  outbox: Report[],
  incidentId: string,
): CatchPoint[] {
  let list = cached.filter((p) => !p.deleted_at)
  for (const r of outbox) {
    if (r.point.incident_id === incidentId && !list.some((h) => h.id === r.point.id)) {
      list = [r.point, ...list]
    }
  }
  return list
}

export const useCatchPoints = create<CatchPointState>()(
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
        if (uid && get().ownerId && get().ownerId !== uid) {
          // Another account: its unsent work is set aside under it, not lost.
          if (!setAsideFor('catchpoints', get().ownerId, { outbox: get().outbox, failed: get().failed })) return
          get().clearLocal()
        }
        if (uid) {
          const back = takeUnsent('catchpoints', uid)
          if (back) set({ ownerId: uid, outbox: prependFrom(back, 'outbox', get().outbox), failed: prependFrom(back, 'failed', get().failed) })
        }
        if (uid) set({ ownerId: uid })
        if (!online()) return
        await get().flush()
        const { data, error } = await supabase
          .from('catch_points')
          .select('id, incident_id, kind, label, notes, source, lat, lng, reported_by, created_at, deleted_at')
          .eq('incident_id', incidentId)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
        if (error) {
          console.warn('catch points load failed', errorMessage(error))
          return
        }
        set({
          byIncident: {
            ...get().byIncident,
            [incidentId]: (data ?? []) as CatchPoint[],
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
        const sent: CatchPoint[] = []
        try {
          for (let i = 0; i < out.length; i++) {
            const { point, attempts } = out[i]
            const { id, incident_id, reported_by, kind, label, notes, lat, lng, created_at } = point
            const { error } = await supabase
              .from('catch_points')
              .upsert(
                { id, client_id: id, incident_id, reported_by, kind, label, notes, source: 'field', lat, lng, created_at },
                { onConflict: 'id', ignoreDuplicates: true },
              )
            if (!error) {
              sent.push(point)
              continue
            }
            if (isTerminal(error)) {
              const n = (attempts ?? 0) + 1
              if (n >= MAX_ATTEMPTS) {
                failedNow.push({ point, reason: describeError(error) })
                continue
              }
              remaining = [{ point, attempts: n }, ...out.slice(i + 1)]
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
          .channel(`navmate-catch-${incidentId}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'catch_points',
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
              const row = payload.new as CatchPoint
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
        const point: CatchPoint = {
          id: newId(),
          incident_id: incidentId,
          reported_by: uid,
          kind: input.kind,
          label: input.label?.trim() || null,
          notes: input.notes?.trim() || null,
          source: 'field',
          // Command tables say lng.
          lat: input.lat,
          lng: input.lon,
          created_at: new Date().toISOString(),
          deleted_at: null,
        }
        set({ ownerId: uid, outbox: [...get().outbox, { point }] })
        await get().flush()
        return point
      },

      discardFailed: () => set({ failed: [] }),

      clearLocal: () =>
        set({ byIncident: {}, outbox: [], failed: [], ownerId: null }),
    }),
    {
      name: 'navmate.catchpoints.v1',
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
