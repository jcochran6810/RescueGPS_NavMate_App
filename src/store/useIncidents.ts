import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
import { isOffline, isTransient, describeError } from '@/lib/retry'
import { newIncidentNumber } from '@/lib/incident'
import type { Incident, IncidentStatus, NewIncident } from '@/lib/types'

/**
 * Incidents, offline-first — the same queue discipline as waypoints and SAR
 * records, for the same reason: the unit opening a search is very often the
 * one outside coverage, and opening must always succeed locally. The three
 * safeguards carry over: ops appended mid-flush survive, a permanently
 * refused op is set aside after bounded retries, and a queue is never
 * replayed under a different account.
 */

type PendingOp = (
  | { kind: 'create'; incident: Incident }
  | { kind: 'update'; id: string; patch: Partial<Incident> }
) & { attempts?: number }

interface FailedOp {
  op: PendingOp
  reason: string
  failedAt: string
}

const MAX_ATTEMPTS = 3

interface IncidentState {
  cache: Incident[]
  pending: PendingOp[]
  failed: FailedOp[]
  loading: boolean
  syncing: boolean
  ownerId: string | null

  /** Cache merged with the queue — what the UI renders. Newest first. */
  visible: () => Incident[]
  /** The search currently being run in a scope: newest active/suspended. */
  activeIncident: (teamId: string | null) => Incident | null
  pendingCount: () => number

  load: () => Promise<void>
  flush: () => Promise<void>
  openIncident: (input: NewIncident) => Promise<Incident | null>
  updateIncident: (id: string, patch: Partial<Incident>) => Promise<void>
  closeIncident: (id: string, status: IncidentStatus) => Promise<void>
  retryFailed: () => Promise<void>
  discardFailed: () => void
  clearLocal: () => void
}

const online = () => typeof navigator === 'undefined' || navigator.onLine

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

function isTerminal(e: unknown): boolean {
  return !isOffline(e) && !isTransient(e)
}

let memo: {
  cache: Incident[]
  failed: FailedOp[]
  pending: PendingOp[]
  result: Incident[]
} | null = null

function applyOps(cache: Incident[], ops: PendingOp[]): Incident[] {
  const byId = new Map(cache.map((r) => [r.id, r]))
  for (const op of ops) {
    if (op.kind === 'create') byId.set(op.incident.id, op.incident)
    else {
      const existing = byId.get(op.id)
      if (existing) byId.set(op.id, { ...existing, ...op.patch })
    }
  }
  return [...byId.values()].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  )
}

function merge(
  cache: Incident[],
  failed: FailedOp[],
  pending: PendingOp[],
): Incident[] {
  if (
    memo &&
    memo.cache === cache &&
    memo.failed === failed &&
    memo.pending === pending
  ) {
    return memo.result
  }
  const result = applyOps(cache, [...failed.map((f) => f.op), ...pending])
  memo = { cache, failed, pending, result }
  return result
}

let flushSeq = 0

/** The row columns sent to the server (never updated_at — a trigger owns it). */
function toRow(r: Incident) {
  const {
    id, client_id, team_id, incident_number, incident_type, incident_name,
    urgency_level, status, lkp_lat, lkp_lng, lkp_time, lkp_source,
    incident_time, summary, created_by,
  } = r
  return {
    id, client_id, team_id, incident_number, incident_type, incident_name,
    urgency_level, status, lkp_lat, lkp_lng, lkp_time, lkp_source,
    incident_time, summary, created_by,
  }
}

const OPEN: IncidentStatus[] = ['active', 'suspended']

export const useIncidents = create<IncidentState>()(
  persist(
    (set, get) => ({
      cache: [],
      pending: [],
      failed: [],
      loading: false,
      syncing: false,
      ownerId: null,

      visible: () => merge(get().cache, get().failed, get().pending),

      activeIncident: (teamId) =>
        get()
          .visible()
          .find(
            (i) =>
              OPEN.includes(i.status) &&
              (teamId ? i.team_id === teamId : i.team_id === null),
          ) ?? null,

      pendingCount: () => get().pending.length,

      load: async () => {
        const uid =
          (await supabase.auth.getSession()).data.session?.user?.id ?? null
        if (uid) {
          if (get().ownerId && get().ownerId !== uid) get().clearLocal()
          set({ ownerId: uid })
        }

        if (!online() || get().loading) return
        set({ loading: true })
        try {
          await get().flush()
          for (let attempt = 0; attempt < 2; attempt++) {
            const seqBefore = flushSeq
            const { data, error } = await supabase
              .from('incidents')
              .select('*')
              .order('created_at', { ascending: false })
            if (error) throw error
            set({ cache: (data ?? []) as Incident[] })
            if (flushSeq === seqBefore) break
          }
        } catch (e) {
          console.warn('incidents load failed', errorMessage(e))
        } finally {
          set({ loading: false })
        }
      },

      flush: async () => {
        const queue = get().pending
        if (queue.length === 0 || !online() || get().syncing) return

        const uid =
          (await supabase.auth.getSession()).data.session?.user?.id ?? null
        const owner = get().ownerId
        if (!uid || (owner !== null && owner !== uid)) return

        set({ syncing: true })
        let remaining: PendingOp[] = []
        const newlyFailed: FailedOp[] = []
        // Accepted ops leave the queue, so they must land in the cache too —
        // otherwise a successfully synced incident vanishes from the screen
        // until the next load().
        const completed: PendingOp[] = []
        let progressed = false
        try {
          for (let i = 0; i < queue.length; i++) {
            const op = queue[i]
            try {
              if (op.kind === 'create') {
                const { error } = await supabase
                  .from('incidents')
                  .upsert(toRow(op.incident), { onConflict: 'id' })
                if (error) throw error
              } else {
                const { error } = await supabase
                  .from('incidents')
                  .update(op.patch)
                  .eq('id', op.id)
                if (error) throw error
              }
              progressed = true
              completed.push(op)
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
                remaining = queue.slice(i)
              }
              break
            }
          }
        } finally {
          const added = get().pending.slice(queue.length)
          set({
            cache:
              completed.length > 0
                ? applyOps(get().cache, completed)
                : get().cache,
            pending: [...remaining, ...added],
            failed: [...get().failed, ...newlyFailed],
            syncing: false,
          })
          if (progressed) flushSeq++
        }
      },

      openIncident: async (input) => {
        const uid = (await supabase.auth.getSession()).data.session?.user?.id
        if (!uid) return null

        const id = newId()
        const now = new Date().toISOString()
        const incident: Incident = {
          id,
          client_id: id,
          team_id: input.team_id ?? null,
          incident_number: newIncidentNumber(new Date(), id),
          incident_type: input.incident_type,
          incident_name: input.incident_name.trim(),
          urgency_level: 'high',
          status: 'active',
          lkp_lat: null,
          lkp_lng: null,
          lkp_time: null,
          lkp_source: null,
          incident_time: null,
          summary: '',
          created_by: uid,
          created_at: now,
          updated_at: now,
        }

        set({
          ownerId: uid,
          pending: [...get().pending, { kind: 'create', incident }],
        })
        await get().flush()
        return incident
      },

      updateIncident: async (id, patch) => {
        set({ pending: [...get().pending, { kind: 'update', id, patch }] })
        await get().flush()
      },

      closeIncident: async (id, status) => {
        await get().updateIncident(id, { status })
      },

      retryFailed: async () => {
        const failed = get().failed
        if (failed.length === 0) return
        set({
          failed: [],
          pending: [
            ...failed.map((f) => ({ ...f.op, attempts: 0 })),
            ...get().pending,
          ],
        })
        await get().flush()
      },

      discardFailed: () => set({ failed: [] }),

      clearLocal: () =>
        set({ cache: [], pending: [], failed: [], ownerId: null }),
    }),
    {
      name: 'navmate.incidents.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        cache: s.cache,
        pending: s.pending,
        failed: s.failed,
        ownerId: s.ownerId,
      }),
    },
  ),
)
