import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
import { isOffline, isTransient, describeError } from '@/lib/retry'
import type { NewVessel, Vessel } from '@/lib/vessel'
import { VESSEL_DEFAULTS } from '@/lib/vessel'

/**
 * The team's boats, offline-first — the same queue discipline as waypoints,
 * SAR records and incidents, and for a sharper reason than any of them: the
 * chart plotter cannot plan anything without a draft, and a crew that cannot
 * reach the server is exactly the crew about to run a passage on a phone.
 *
 * So the cache is the source of truth for planning. A boat added with no
 * signal is usable for routing immediately and syncs when there is a link.
 *
 * The three safeguards carry over unchanged: ops appended mid-flush survive,
 * a permanently refused op is set aside after bounded retries rather than
 * wedging the queue, and a queue is never replayed under a different account.
 */

type PendingOp = (
  | { kind: 'create'; vessel: Vessel }
  | { kind: 'update'; id: string; patch: Partial<Vessel> }
  /** A soft delete (N10); `deletedAt` is the moment the crew tapped. */
  | { kind: 'delete'; id: string; deletedAt?: string }
) & { attempts?: number }

interface FailedOp {
  op: PendingOp
  reason: string
  failedAt: string
}

const MAX_ATTEMPTS = 3

/**
 * Which boat this device is on.
 *
 * Kept in plain localStorage rather than in the synced row, following
 * `navmate.activeTeamId`: two crews on two boats share one team and one
 * vessel list, and the answer to "which one am I standing on" is a property
 * of the phone, not of the account.
 */
const ACTIVE_KEY = 'navmate.activeVesselId'

interface VesselState {
  cache: Vessel[]
  pending: PendingOp[]
  failed: FailedOp[]
  /**
   * Each boat's "keep ___ from shallows" (`shallow_margin_m`) as set on this
   * device, by vessel id — so the setting holds whether or not the server's
   * `vessels` table has the column yet (migration
   * `20260928000000_navmate_vessel_shallow_margin`, not applied by the app).
   * A value the server holds wins; this fills in where it holds none.
   */
  shallowMargins: Record<string, number>
  /** The server's rows carry `shallow_margin_m`: it is safe to send. */
  serverHasShallowMargin: boolean
  loading: boolean
  syncing: boolean
  ownerId: string | null
  activeId: string | null

  /** Cache merged with the queue — what the UI renders. */
  visible: () => Vessel[]
  /** Boats usable in a scope: the team's, or your own private ones. */
  inScope: (teamId: string | null) => Vessel[]
  /** The boat the plotter plans for, or null when none is set up yet. */
  active: (teamId: string | null) => Vessel | null
  pendingCount: () => number

  load: () => Promise<void>
  flush: () => Promise<void>
  addVessel: (input: NewVessel) => Promise<Vessel | null>
  updateVessel: (id: string, patch: Partial<Vessel>) => Promise<void>
  removeVessel: (id: string) => Promise<void>
  setActive: (id: string | null) => void
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

function readActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

function writeActive(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id)
    else localStorage.removeItem(ACTIVE_KEY)
  } catch {
    /* private mode, cleared site data — the choice is a convenience */
  }
}

let memo: {
  cache: Vessel[]
  failed: FailedOp[]
  pending: PendingOp[]
  margins: Record<string, number>
  result: Vessel[]
} | null = null

function applyOps(cache: Vessel[], ops: PendingOp[]): Vessel[] {
  const byId = new Map(cache.filter((r) => !r.deleted_at).map((r) => [r.id, r]))
  for (const op of ops) {
    if (op.kind === 'create') byId.set(op.vessel.id, op.vessel)
    else if (op.kind === 'delete') byId.delete(op.id)
    else {
      const existing = byId.get(op.id)
      if (existing) byId.set(op.id, { ...existing, ...op.patch })
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Identity-stable merge. `visible()` is read as a Zustand selector, and React
 * compares with Object.is — a fresh array every call is an infinite render.
 */
function merge(
  cache: Vessel[],
  failed: FailedOp[],
  pending: PendingOp[],
  margins: Record<string, number> = {},
): Vessel[] {
  if (
    memo &&
    memo.cache === cache &&
    memo.failed === failed &&
    memo.pending === pending &&
    memo.margins === margins
  ) {
    return memo.result
  }
  // Failed ops layer ahead of pending ones: a refused boat is still the crew's
  // data and must not disappear from the list they are choosing from.
  const merged = applyOps(cache, [...failed.map((f) => f.op), ...pending])
  // The device's own "keep ___ from shallows" where the row carries none.
  const result = merged.map((v) =>
    v.shallow_margin_m == null && Number.isFinite(margins[v.id]) ? { ...v, shallow_margin_m: margins[v.id] } : v,
  )
  memo = { cache, failed, pending, margins, result }
  return result
}

/**
 * The fields the server may be sent: `shallow_margin_m` only once its rows
 * have shown the column exists — PostgREST refuses a write naming a column
 * it does not have, and the boat's other settings must still sync.
 */
function withoutUnknown<T extends Partial<Vessel>>(row: T, serverHas: boolean): T {
  if (serverHas || !('shallow_margin_m' in row)) return row
  const rest = { ...row }
  delete rest.shallow_margin_m
  return rest
}

/** Record a boat's "keep ___ from shallows" on this device. */
function noteMargin(margins: Record<string, number>, id: string, v: Partial<Vessel>): Record<string, number> {
  const m = v.shallow_margin_m
  if (m == null || !Number.isFinite(m)) return margins
  return { ...margins, [id]: m }
}

let flushSeq = 0

/** The row columns sent to the server (never updated_at — a trigger owns it). */
function toRow(v: Vessel, serverHasShallowMargin = false) {
  const {
    id, client_id, team_id, name, callsign, draft_m, air_draft_m, beam_m,
    length_m, cruise_speed_kn, max_speed_kn, fuel_burn_gph,
    under_keel_margin_m, clearance_m, created_by, shallow_margin_m,
  } = { ...v, created_by: v.user_id }
  return {
    id, client_id, team_id, name, callsign, draft_m, air_draft_m, beam_m,
    length_m, cruise_speed_kn, max_speed_kn, fuel_burn_gph,
    under_keel_margin_m, clearance_m, created_by,
    ...(serverHasShallowMargin && shallow_margin_m != null ? { shallow_margin_m } : {}),
  }
}

/** Server rows carry `created_by`; the store calls the same field `user_id`. */
function fromRow(row: Record<string, unknown>): Vessel {
  const { created_by, ...rest } = row as unknown as Vessel & {
    created_by?: string
  }
  return { ...rest, user_id: created_by ?? rest.user_id } as Vessel
}

export const useVessels = create<VesselState>()(
  persist(
    (set, get) => ({
      cache: [],
      pending: [],
      failed: [],
      shallowMargins: {},
      serverHasShallowMargin: false,
      loading: false,
      syncing: false,
      ownerId: null,
      activeId: readActive(),

      visible: () => merge(get().cache, get().failed, get().pending, get().shallowMargins),

      inScope: (teamId) =>
        get()
          .visible()
          .filter((v) =>
            teamId
              ? v.team_id === teamId
              : // Private means this account's. Another crew's private boat
                // is readable once it is a unit on a shared incident (N3),
                // and it must not turn up in this crew's boat list.
                v.team_id === null &&
                (get().ownerId === null || v.user_id === get().ownerId),
          ),

      active: (teamId) => {
        const scope = get().inScope(teamId)
        const chosen = scope.find((v) => v.id === get().activeId)
        // One boat in scope needs no choosing; with several, an unset choice
        // would rather show nothing than guess which hull the crew is on.
        return chosen ?? (scope.length === 1 ? scope[0] : null)
      },

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
              .from('vessels')
              .select('*')
              .is('deleted_at', null)
              .order('name', { ascending: true })
            if (error) throw error
            const rows = (data ?? []) as Record<string, unknown>[]
            set({
              cache: rows.map((r) => fromRow(r)),
              ...(rows.length > 0 ? { serverHasShallowMargin: 'shallow_margin_m' in rows[0] } : {}),
            })
            if (flushSeq === seqBefore) break
          }
        } catch (e) {
          // A boat already in the cache still plans routes, so a failed load is
          // a warning, not a stop.
          console.warn('vessels load failed', errorMessage(e))
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
        // otherwise a successfully synced boat vanishes from the list until
        // the next load().
        const completed: PendingOp[] = []
        let progressed = false
        try {
          for (let i = 0; i < queue.length; i++) {
            const op = queue[i]
            try {
              if (op.kind === 'create') {
                const { error } = await supabase
                  .from('vessels')
                  .upsert(toRow(op.vessel, get().serverHasShallowMargin), { onConflict: 'id' })
                if (error) throw error
              } else if (op.kind === 'update') {
                const patch = withoutUnknown(op.patch, get().serverHasShallowMargin)
                // Nothing the server can hold (only the shallows margin, on a
                // database without the column): kept on this device alone.
                if (Object.keys(patch).length > 0) {
                  const { error } = await supabase.from('vessels').update(patch).eq('id', op.id)
                  if (error) throw error
                }
              } else {
                // Soft delete (N10): a boat registered as a unit is named on
                // the command side's map, and its row has to outlive it here.
                const { error } = await supabase
                  .from('vessels')
                  .update({ deleted_at: op.deletedAt ?? new Date().toISOString() })
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
          // Ops queued while this flush was in flight must survive it.
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

      addVessel: async (input) => {
        // getSession() is local and works with no signal; getUser() asks the
        // server and would fail exactly when the queue matters most.
        const uid = (await supabase.auth.getSession()).data.session?.user?.id
        if (!uid) return null

        const id = newId()
        const now = new Date().toISOString()
        const vessel: Vessel = {
          ...VESSEL_DEFAULTS,
          ...input,
          id,
          client_id: id,
          user_id: uid,
          team_id: input.team_id ?? null,
          name: input.name.trim(),
          callsign: input.callsign.trim(),
          created_at: now,
          updated_at: now,
        }

        set({
          ownerId: uid,
          pending: [...get().pending, { kind: 'create', vessel }],
          shallowMargins: noteMargin(get().shallowMargins, id, vessel),
        })
        // A crew that just set their boat up should be planning with it, not
        // picking it out of a list first.
        get().setActive(id)
        await get().flush()
        return vessel
      },

      updateVessel: async (id, patch) => {
        set({
          pending: [...get().pending, { kind: 'update', id, patch }],
          shallowMargins: noteMargin(get().shallowMargins, id, patch),
        })
        await get().flush()
      },

      removeVessel: async (id) => {
        if (get().activeId === id) get().setActive(null)
        set({
          pending: [
            ...get().pending,
            { kind: 'delete', id, deletedAt: new Date().toISOString() },
          ],
        })
        await get().flush()
      },

      setActive: (id) => {
        writeActive(id)
        set({ activeId: id })
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

      clearLocal: () => {
        writeActive(null)
        set({
          cache: [],
          pending: [],
          failed: [],
          shallowMargins: {},
          serverHasShallowMargin: false,
          ownerId: null,
          activeId: null,
        })
      },
    }),
    {
      name: 'navmate.vessels.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        cache: s.cache,
        pending: s.pending,
        failed: s.failed,
        shallowMargins: s.shallowMargins,
        serverHasShallowMargin: s.serverHasShallowMargin,
        ownerId: s.ownerId,
      }),
    },
  ),
)
