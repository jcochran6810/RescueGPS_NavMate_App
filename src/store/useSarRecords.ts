import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
import { isOffline, isTransient, describeError } from '@/lib/retry'
import type { NewSarRecord, SarRecord } from '@/lib/types'

/**
 * SAR datum records, offline-first.
 *
 * Same discipline as the waypoint store, for the same reason: the unit
 * collecting an LKP or retrieving a drift marker is very often out of
 * coverage, and capture must always succeed locally with sync waiting its
 * turn. The queue carries the same three safeguards the waypoint queue
 * earned the hard way — ops appended mid-flush survive, a permanently
 * refused op is set aside after bounded retries instead of wedging the
 * queue, and a queue is never replayed under a different account.
 */

type PendingOp = (
  | { kind: 'create'; record: SarRecord }
  | { kind: 'update'; id: string; patch: Partial<SarRecord> }
  | { kind: 'delete'; id: string }
) & { attempts?: number }

interface FailedOp {
  op: PendingOp
  reason: string
  failedAt: string
}

const MAX_ATTEMPTS = 3

interface SarState {
  cache: SarRecord[]
  pending: PendingOp[]
  failed: FailedOp[]
  loading: boolean
  syncing: boolean
  ownerId: string | null

  /** Cache merged with the queue — what the UI renders. Newest first. */
  visible: () => SarRecord[]
  pendingCount: () => number

  load: () => Promise<void>
  flush: () => Promise<void>
  createRecord: (input: NewSarRecord) => Promise<SarRecord | null>
  updateRecord: (id: string, patch: Partial<SarRecord>) => Promise<void>
  removeRecord: (id: string) => Promise<void>
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

/**
 * Memoised exactly like the waypoint merge — `visible()` is a selector.
 * Failed ops stay layered in: a refused record is still the crew's local
 * data, and an LKP vanishing because sync failed would read as data loss.
 */
let memo: {
  cache: SarRecord[]
  failed: FailedOp[]
  pending: PendingOp[]
  result: SarRecord[]
} | null = null

function merge(
  cache: SarRecord[],
  failed: FailedOp[],
  pending: PendingOp[],
): SarRecord[] {
  if (
    memo &&
    memo.cache === cache &&
    memo.failed === failed &&
    memo.pending === pending
  ) {
    return memo.result
  }
  const byId = new Map(cache.map((r) => [r.id, r]))
  for (const op of [...failed.map((f) => f.op), ...pending]) {
    if (op.kind === 'create') byId.set(op.record.id, op.record)
    else if (op.kind === 'delete') byId.delete(op.id)
    else {
      const existing = byId.get(op.id)
      if (existing) byId.set(op.id, { ...existing, ...op.patch })
    }
  }
  const result = [...byId.values()].sort((a, b) =>
    b.recorded_at.localeCompare(a.recorded_at),
  )
  memo = { cache, failed, pending, result }
  return result
}

let flushSeq = 0

/** The row columns sent to the server (never updated_at — a trigger owns it). */
function toRow(r: SarRecord) {
  const { id, client_id, user_id, team_id, kind, lat, lon, recorded_at, payload, note } = r
  return { id, client_id, user_id, team_id, kind, lat, lon, recorded_at, payload, note }
}

export const useSarRecords = create<SarState>()(
  persist(
    (set, get) => ({
      cache: [],
      pending: [],
      failed: [],
      loading: false,
      syncing: false,
      ownerId: null,

      visible: () => merge(get().cache, get().failed, get().pending),
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
              .from('sar_records')
              .select('*')
              .order('recorded_at', { ascending: false })
            if (error) throw error
            set({ cache: (data ?? []) as SarRecord[] })
            if (flushSeq === seqBefore) break
          }
        } catch (e) {
          console.warn('sar records load failed', errorMessage(e))
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
        let progressed = false
        try {
          for (let i = 0; i < queue.length; i++) {
            const op = queue[i]
            try {
              if (op.kind === 'create') {
                const { error } = await supabase
                  .from('sar_records')
                  .upsert(toRow(op.record), { onConflict: 'id' })
                if (error) throw error
              } else if (op.kind === 'update') {
                const { error } = await supabase
                  .from('sar_records')
                  .update(op.patch)
                  .eq('id', op.id)
                if (error) throw error
              } else {
                const { error } = await supabase
                  .from('sar_records')
                  .delete()
                  .eq('id', op.id)
                if (error) throw error
              }
              progressed = true
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
            pending: [...remaining, ...added],
            failed: [...get().failed, ...newlyFailed],
            syncing: false,
          })
          if (progressed) flushSeq++
        }
      },

      createRecord: async (input) => {
        const uid = (await supabase.auth.getSession()).data.session?.user?.id
        if (!uid) return null

        const id = newId()
        const now = new Date().toISOString()
        const record: SarRecord = {
          id,
          client_id: id,
          user_id: uid,
          team_id: input.team_id ?? null,
          kind: input.kind,
          lat: input.lat,
          lon: input.lon,
          recorded_at: input.recorded_at,
          payload: input.payload,
          note: input.note ?? '',
          created_at: now,
          updated_at: now,
        }

        set({
          ownerId: uid,
          pending: [...get().pending, { kind: 'create', record }],
        })
        await get().flush()
        return record
      },

      updateRecord: async (id, patch) => {
        set({
          pending: [...get().pending, { kind: 'update', id, patch }],
        })
        await get().flush()
      },

      removeRecord: async (id) => {
        set({ pending: [...get().pending, { kind: 'delete', id }] })
        await get().flush()
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
      name: 'navmate.sar.v1',
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
