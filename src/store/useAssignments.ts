import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
import { isOffline, isTransient, describeError } from '@/lib/retry'
import {
  canMoveTo,
  parsePolygon,
  type AssignmentStatus,
  type FieldAssignment,
} from '@/lib/command'

/**
 * Search assignments from command (`field_assignments`, contract N5).
 *
 * Command writes them; a crew reads the ones for this incident and moves the
 * status of its own through En route → Searching → Complete. Both halves have
 * to survive losing signal: the assignments are cached per incident, because
 * the crew most in need of their segment is the one that has just steamed out
 * of coverage to search it; and a status change is queued, because "we are
 * searching" tapped with no signal is still true when it arrives.
 *
 * The server lets a field unit change `status` and nothing else, and only on
 * rows tasked to them or their unit. A refused change is set aside after
 * bounded retries rather than wedging the queue, the same discipline as every
 * other queue in NavMate.
 */

interface StatusOp {
  id: string
  incident_id: string
  status: AssignmentStatus
  attempts?: number
}

interface FailedStatusOp {
  op: StatusOp
  reason: string
  failedAt: string
}

const MAX_ATTEMPTS = 3

interface AssignmentState {
  byIncident: Record<string, FieldAssignment[]>
  pending: StatusOp[]
  failed: FailedStatusOp[]
  syncing: boolean
  ownerId: string | null

  load: (incidentId: string) => Promise<void>
  flush: () => Promise<void>
  /** Follow the incident's assignments live. Returns the unsubscribe. */
  subscribe: (incidentId: string) => () => void
  /** Move one of this crew's assignments on. False if the step is not allowed. */
  setStatus: (a: FieldAssignment, status: AssignmentStatus) => Promise<boolean>
  discardFailed: () => void
  clearLocal: () => void
}

const online = () => typeof navigator === 'undefined' || navigator.onLine

function isTerminal(e: unknown): boolean {
  return !isOffline(e) && !isTransient(e)
}

/**
 * Put a row into the list, keeping what the list already knew about its
 * outline if this copy cannot be read.
 *
 * PostgREST returns the polygon as GeoJSON, but a Realtime change carries the
 * raw column, which for a geography is EWKB hex. Dropping a readable outline
 * for an unreadable one would erase the segment from the map on the first
 * status change.
 */
function mergeRow(list: FieldAssignment[], row: FieldAssignment): FieldAssignment[] {
  const i = list.findIndex((a) => a.id === row.id)
  if (i < 0) return [row, ...list]
  const prev = list[i]
  const keepGeom =
    parsePolygon(row.segment_geom) === null && parsePolygon(prev.segment_geom) !== null
  const next = [...list]
  next[i] = keepGeom ? { ...row, segment_geom: prev.segment_geom } : row
  return next
}

/** Cached rows with the queued status changes laid over them. */
export function withPendingStatus(
  list: FieldAssignment[],
  pending: StatusOp[],
): FieldAssignment[] {
  if (pending.length === 0) return list
  const latest = new Map<string, AssignmentStatus>()
  for (const op of pending) latest.set(op.id, op.status)
  return list.map((a) => (latest.has(a.id) ? { ...a, status: latest.get(a.id)! } : a))
}

async function fetchOne(id: string): Promise<FieldAssignment | null> {
  const { data } = await supabase
    .from('field_assignments')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  return (data as FieldAssignment | null) ?? null
}

export const useAssignments = create<AssignmentState>()(
  persist(
    (set, get) => ({
      byIncident: {},
      pending: [],
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
          .from('field_assignments')
          .select('*')
          .eq('incident_id', incidentId)
          .order('created_at', { ascending: false })
        if (error) {
          console.warn('assignments load failed', errorMessage(error))
          return
        }
        set({
          byIncident: {
            ...get().byIncident,
            [incidentId]: (data ?? []) as FieldAssignment[],
          },
        })
      },

      flush: async () => {
        const queue = get().pending
        if (queue.length === 0 || !online() || get().syncing) return
        const uid =
          (await supabase.auth.getSession()).data.session?.user?.id ?? null
        const owner = get().ownerId
        if (!uid || (owner !== null && owner !== uid)) return

        set({ syncing: true })
        let remaining: StatusOp[] = []
        const newlyFailed: FailedStatusOp[] = []
        try {
          for (let i = 0; i < queue.length; i++) {
            const op = queue[i]
            try {
              const { error } = await supabase
                .from('field_assignments')
                .update({ status: op.status })
                .eq('id', op.id)
              if (error) throw error
              // Land it in the cache so it survives the op leaving the queue.
              const list = get().byIncident[op.incident_id] ?? []
              set({
                byIncident: {
                  ...get().byIncident,
                  [op.incident_id]: list.map((a) =>
                    a.id === op.id ? { ...a, status: op.status } : a,
                  ),
                },
              })
            } catch (e) {
              if (isTerminal(e)) {
                const attempts = (op.attempts ?? 0) + 1
                if (attempts >= MAX_ATTEMPTS) {
                  newlyFailed.push({
                    op,
                    reason: describeError(e),
                    failedAt: new Date().toISOString(),
                  })
                  continue
                }
                remaining = [{ ...op, attempts }, ...queue.slice(i + 1)]
              } else {
                // Order matters between changes to the same assignment, so a
                // later one must not overtake a stalled earlier one.
                remaining = queue.slice(i)
              }
              break
            }
          }
        } finally {
          const added = get().pending.slice(queue.length)
          set({
            pending: [...remaining, ...added],
            failed: [...get().failed, ...newlyFailed],
            syncing: false,
          })
        }
      },

      subscribe: (incidentId) => {
        const channel = supabase
          .channel(`navmate-assignments-${incidentId}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'field_assignments',
              filter: `incident_id=eq.${incidentId}`,
            },
            (payload) => {
              if (payload.eventType === 'DELETE') {
                const gone = (payload.old as { id?: string })?.id
                if (!gone) return
                set({
                  byIncident: {
                    ...get().byIncident,
                    [incidentId]: (get().byIncident[incidentId] ?? []).filter(
                      (a) => a.id !== gone,
                    ),
                  },
                })
                return
              }
              const row = payload.new as FieldAssignment
              if (!row?.id) return
              const list = get().byIncident[incidentId] ?? []
              const known = list.some((a) => a.id === row.id)
              set({
                byIncident: { ...get().byIncident, [incidentId]: mergeRow(list, row) },
              })
              // A new segment whose outline arrived as hex: fetch it once
              // through PostgREST, which hands the polygon over as GeoJSON.
              if (!known && row.segment_geom != null && parsePolygon(row.segment_geom) === null) {
                void fetchOne(row.id).then((full) => {
                  if (!full) return
                  set({
                    byIncident: {
                      ...get().byIncident,
                      [incidentId]: mergeRow(get().byIncident[incidentId] ?? [], full),
                    },
                  })
                })
              }
            },
          )
          .subscribe((status) => {
            // Rejoining after a drop may have missed changes.
            if (status === 'SUBSCRIBED') void get().load(incidentId)
          })
        return () => void supabase.removeChannel(channel)
      },

      setStatus: async (a, status) => {
        const current =
          withPendingStatus([a], get().pending)[0]?.status ?? a.status
        if (!canMoveTo(current, status)) return false
        set({
          pending: [...get().pending, { id: a.id, incident_id: a.incident_id, status }],
        })
        await get().flush()
        return true
      },

      discardFailed: () => set({ failed: [] }),

      clearLocal: () =>
        set({ byIncident: {}, pending: [], failed: [], ownerId: null }),
    }),
    {
      name: 'navmate.assignments.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        byIncident: s.byIncident,
        pending: s.pending,
        failed: s.failed,
        ownerId: s.ownerId,
      }),
    },
  ),
)
