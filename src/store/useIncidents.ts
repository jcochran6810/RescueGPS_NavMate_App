import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
import { useTeams } from '@/store/useTeams'
import { isOffline, isTransient, describeError } from '@/lib/retry'
import {
  closePatch,
  incidentScopeFilter,
  isFieldCreated,
  newIncidentNumber,
  normalizeIncident,
  type CloseChoice,
} from '@/lib/incident'
import type {
  Incident,
  IncidentStatus,
  IncidentMember,
  JoinableIncident,
  JoinResult,
  NewIncident,
} from '@/lib/types'

/**
 * Incidents, offline-first — the same queue discipline as waypoints and SAR
 * records, for the same reason: the unit opening a search is very often the
 * one outside coverage, and opening must always succeed locally. The three
 * safeguards carry over: ops appended mid-flush survive, a permanently
 * refused op is set aside after bounded retries, and a queue is never
 * replayed under a different account.
 *
 * NavMate writes the RescueGPS command system's own `incidents` table, which
 * it shares on this database. That is the point: the command dashboard
 * subscribes to it in order to "detect new incidents from other users (e.g.
 * field app)", and until this was merged that subscription could never fire.
 * Opening an incident here now shows up there live, and their trigger makes
 * the crew member a participant and initial IC on the way through.
 *
 * Two consequences worth knowing:
 *
 * 1. The load lists this crew's own field incidents and their teams' — said
 *    explicitly, because RLS lets every signed-in user read every incident
 *    here — and a command incident only once it has been joined. NavMate
 *    sets `client_id` to the incident's own id; the command wizard has used
 *    `client_id` as its save key since 2026-09-30, so "has a client_id" no
 *    longer means "opened in the field" (`isFieldCreated` in lib/incident).
 * 2. The columns are named explicitly rather than `select('*')`. That table
 *    has ~50 columns including `incident_password` and
 *    `incident_password_hash`, and this cache is persisted to localStorage on
 *    every crew phone. A star select would put a password hash there.
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
  /**
   * The search this crew is on, when it is not simply the newest one they
   * opened themselves.
   *
   * A joined incident may belong to another team, or to no team at all if the
   * command system opened it, so the team-scoped rule below would never find
   * it. Persisted, because the crew is still on that search after the app is
   * closed and re-opened — which on a phone happens constantly.
   */
  currentIncidentId: string | null

  /** Cache merged with the queue — what the UI renders. Newest first. */
  visible: () => Incident[]
  /** The search currently being run in a scope: newest active/suspended. */
  activeIncident: (teamId: string | null) => Incident | null
  pendingCount: () => number

  load: () => Promise<void>
  flush: () => Promise<void>
  openIncident: (input: NewIncident) => Promise<Incident | null>
  updateIncident: (id: string, patch: Partial<Incident>) => Promise<void>
  /** Close with an outcome (status closed) or cancel (status cancelled). */
  closeIncident: (id: string, choice: CloseChoice) => Promise<void>
  retryFailed: () => Promise<void>
  discardFailed: () => void
  clearLocal: () => void

  /** Searches that are running right now and can be asked to join. Online. */
  listJoinable: () => Promise<JoinableIncident[]>
  /** Ask to join one. Never throws on a refusal — the refusal is the answer. */
  joinIncident: (id: string, password?: string) => Promise<JoinResult>
  leaveIncident: (id: string) => Promise<void>
  /** Who else is on it. Empty when offline or not a participant. */
  roster: (id: string) => Promise<IncidentMember[]>
  /** Protect an incident with a word, or clear it. Creator or IC only. */
  setIncidentPassword: (id: string, password: string | null) => Promise<string>
  /**
   * Put this crew on the team search it is working (see `ensureParticipant`
   * below). True once they are on it; never throws.
   */
  ensureParticipant: (id: string) => Promise<boolean>
  /** Re-read one incident — command may have closed it or moved its LKP. */
  refresh: (id: string) => Promise<void>
  /** Follow one incident's row live. Returns the unsubscribe. */
  subscribeIncident: (id: string) => () => void
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

/**
 * Searches this account is known to be on, keyed `${uid}:${incidentId}`, so
 * the join below is asked once per search rather than on every render and
 * every minute. A refusal or a failure is not remembered: it is asked again.
 */
const onSearch = new Map<string, Promise<boolean>>()

/**
 * The columns NavMate reads back. Explicit, not `*`: the shared `incidents`
 * table carries the command system's `incident_password_hash` among ~50
 * columns, and this result is cached in localStorage.
 */
const INCIDENT_COLUMNS =
  'id, client_id, team_id, incident_number, incident_type, incident_name, urgency_level, status, lkp_lat, lkp_lng, lkp_time, lkp_source, incident_time, time_last_alive, summary, outcome, outcome_time, ended_at, created_by, current_ic_id, created_at, updated_at' as const

/** The row columns sent to the server (never updated_at — a trigger owns it). */
function toRow(r: Incident) {
  const {
    id, client_id, team_id, incident_number, incident_type, incident_name,
    urgency_level, status, lkp_lat, lkp_lng, lkp_time, lkp_source,
    incident_time, time_last_alive, summary, created_by,
  } = normalizeIncident(r)
  return {
    id, client_id, team_id, incident_number, incident_type, incident_name,
    urgency_level, status, lkp_lat, lkp_lng, lkp_time, lkp_source,
    incident_time, time_last_alive, summary, created_by,
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
      currentIncidentId: null,

      visible: () => merge(get().cache, get().failed, get().pending),

      /*
       * The search being run right now.
       *
       * A joined incident wins over the team-scoped rule, because it is the
       * one the crew said out loud they are on — and it may carry another
       * team's id, or none at all when the command system opened it, so the
       * scope test below would never find it. It still has to be open: a
       * joined search that has since been closed falls back rather than
       * pinning this crew to a finished incident.
       */
      activeIncident: (teamId) => {
        const all = get().visible()
        const current = get().currentIncidentId
        if (current) {
          const joined = all.find((i) => i.id === current)
          if (joined && OPEN.includes(joined.status)) return joined
        }
        // With no team, only a search this crew opened in NavMate: a cache
        // written before the load was scoped can still hold other crews'
        // private incidents and command's, and adopting one would tag this
        // crew's waypoints, tracks and records to someone else's search.
        const me = get().ownerId
        return (
          all.find(
            (i) =>
              OPEN.includes(i.status) &&
              (teamId
                ? i.team_id === teamId
                : i.team_id === null && i.created_by === me && isFieldCreated(i)),
          ) ?? null
        )
      },

      pendingCount: () => get().pending.length,

      load: async () => {
        const uid =
          (await supabase.auth.getSession()).data.session?.user?.id ?? null
        if (uid) {
          if (get().ownerId && get().ownerId !== uid) get().clearLocal()
          set({ ownerId: uid })
        }

        if (!uid || !online() || get().loading) return
        set({ loading: true })
        try {
          await get().flush()
          /*
           * Whose incidents, said explicitly. RLS on this shared table lets
           * any signed-in user read every incident without an organisation,
           * so "everything readable with a client_id" was every crew's
           * private searches and, since the command wizard began setting
           * client_id too, every incident command opened — any of which the
           * no-team rule below could then take for this crew's own search.
           */
          const teams = await supabase
            .from('team_members')
            .select('team_id')
            .eq('user_id', uid)
          if (teams.error) throw teams.error
          const scope = incidentScopeFilter(
            uid,
            ((teams.data ?? []) as { team_id: string }[]).map((t) => t.team_id),
          )
          for (let attempt = 0; attempt < 2; attempt++) {
            const seqBefore = flushSeq
            const { data, error } = await supabase
              .from('incidents')
              .select(INCIDENT_COLUMNS)
              .or(scope)
              .not('client_id', 'is', null)
              .order('created_at', { ascending: false })
            if (error) throw error
            // Legacy rows (`piw`, an outcome in `status`) read in the
            // contract's vocabulary, whatever wrote them. A command incident
            // this crew opened at a desk is not a field search: it reaches
            // the field app by being joined, like any other.
            let rows = ((data ?? []) as Incident[])
              .map(normalizeIncident)
              .filter(isFieldCreated)

            /*
             * A joined search is very often not one of those rows. The filter
             * above is what keeps command-created incidents out of a field
             * app that has no UI for them — but the moment a crew joins one,
             * it is the search they are on, so it is fetched by id and merged
             * in. One extra round trip, only while joined.
             */
            const current = get().currentIncidentId
            if (current && !rows.some((r) => r.id === current)) {
              const joined = await supabase
                .from('incidents')
                .select(INCIDENT_COLUMNS)
                .eq('id', current)
                .maybeSingle()
              if (joined.data) {
                rows = [normalizeIncident(joined.data as Incident), ...rows]
              }
            }
            set({ cache: rows })
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
          time_last_alive: null,
          summary: '',
          outcome: null,
          outcome_time: null,
          ended_at: null,
          created_by: uid,
          created_at: now,
          updated_at: now,
        }

        set({
          ownerId: uid,
          // Opening a search is saying you are on it, which matters when the
          // last thing this crew did was join someone else's.
          currentIncidentId: id,
          pending: [...get().pending, { kind: 'create', incident }],
        })
        await get().flush()
        return incident
      },

      updateIncident: async (id, patch) => {
        set({ pending: [...get().pending, { kind: 'update', id, patch }] })
        await get().flush()
      },

      closeIncident: async (id, choice) => {
        await get().updateIncident(id, closePatch(choice))
        if (get().currentIncidentId === id) set({ currentIncidentId: null })
      },

      listJoinable: async () => {
        if (!online()) return []
        const { data, error } = await supabase.rpc('navmate_active_incidents')
        if (error) {
          console.warn('joinable incidents failed', errorMessage(error))
          return []
        }
        return (data ?? []) as JoinableIncident[]
      },

      /*
       * Joining is online-only, and deliberately not queued.
       *
       * Everything else in this store is offline-first because capture must
       * always succeed — but a join is a question asked of a search that is
       * running somewhere else, and its answer (right password, wrong
       * password, the IC will decide) cannot be guessed on the device. A
       * queued join would tell a crew they were on a search they might not
       * be, which is worse than telling them to wait for signal.
       */
      joinIncident: async (id, password) => {
        if (!online()) return 'offline'
        const { data, error } = await supabase.rpc('navmate_join_incident', {
          p_incident_id: id,
          p_password: password ?? null,
        })
        if (error) {
          console.warn('join failed', errorMessage(error))
          return 'error'
        }
        const result = (data ?? 'error') as JoinResult
        if (result === 'joined') {
          set({ currentIncidentId: id })
          await get().load()
        }
        return result
      },

      leaveIncident: async (id) => {
        if (get().currentIncidentId === id) set({ currentIncidentId: null })
        if (!online()) return
        const { error } = await supabase.rpc('navmate_leave_incident', {
          p_incident_id: id,
        })
        if (error) console.warn('leave failed', errorMessage(error))
      },

      roster: async (id) => {
        if (!online()) return []
        const { data, error } = await supabase.rpc('navmate_incident_roster', {
          p_incident_id: id,
        })
        if (error) {
          console.warn('roster failed', errorMessage(error))
          return []
        }
        return (data ?? []) as IncidentMember[]
      },

      setIncidentPassword: async (id, password) => {
        if (!online()) return 'offline'
        const { data, error } = await supabase.rpc('navmate_set_incident_password', {
          p_incident_id: id,
          p_password: password,
        })
        if (error) {
          console.warn('set password failed', errorMessage(error))
          return 'error'
        }
        return (data ?? 'error') as string
      },

      /*
       * A team's search is the whole team's — that has been the model since
       * incidents existed — but the command system decides who sees what it
       * sends by *participation*: assignments, messages, search areas, the
       * other units, a unit of one's own, a hazard report. Its trigger makes
       * only the incident's creator a participant, so every teammate working
       * the same search was invisible to command and command to them. The
       * join is idempotent and, for a member of the incident's team, needs
       * no password and no approval (migration 20261002000000).
       */
      ensureParticipant: async (id) => {
        const uid =
          (await supabase.auth.getSession()).data.session?.user?.id ?? null
        if (!uid) return false
        const incident = get().visible().find((i) => i.id === id)
        // Not a team search, or this crew opened it: the creator is put on it
        // by the command system's own trigger, and any other search was
        // joined explicitly.
        if (!incident || !incident.team_id || incident.created_by === uid) return true
        // Only this crew's own team's search. Another team's search they
        // joined by hand is not re-asked for: if its IC has removed them,
        // asking again would file a join request they never made.
        const teams = useTeams.getState()
        const ownTeam =
          teams.activeTeamId === incident.team_id ||
          teams.teams.some((t) => t.id === incident.team_id)
        if (!ownTeam) return true
        if (!online()) return false
        const key = `${uid}:${id}`
        const known = onSearch.get(key)
        if (known) return known
        const ask = (async () => {
          const { data, error } = await supabase.rpc('navmate_join_incident', {
            p_incident_id: id,
            p_password: null,
          })
          if (error) {
            console.warn('joining the team search failed', errorMessage(error))
            return false
          }
          // 'not_found' is an incident still in this phone's queue; anything
          // but 'joined' is asked again next time.
          return data === 'joined'
        })()
        onSearch.set(key, ask)
        const ok = await ask
        if (!ok) onSearch.delete(key)
        return ok
      },

      refresh: async (id) => {
        if (!online()) return
        const { data, error } = await supabase
          .from('incidents')
          .select(INCIDENT_COLUMNS)
          .eq('id', id)
          .maybeSingle()
        if (error || !data) return
        const row = normalizeIncident(data as Incident)
        const cache = get().cache
        const i = cache.findIndex((r) => r.id === id)
        if (i < 0) {
          // Only a search this crew is on comes into the list this way.
          if (get().currentIncidentId !== id) return
          set({ cache: [row, ...cache] })
          return
        }
        const prev = cache[i]
        if (
          prev.updated_at === row.updated_at &&
          prev.status === row.status &&
          prev.current_ic_id === row.current_ic_id
        ) {
          return
        }
        const next = [...cache]
        next[i] = row
        set({ cache: next })
      },

      /*
       * Command can close, suspend or cancel a search, move its LKP or take
       * over as IC, and until this the field app found out only when it next
       * reloaded the whole list — so a crew kept publishing their track to,
       * and tagging waypoints with, a search command had closed. The change
       * itself is not read from the payload: a Realtime row carries every
       * column, the password hash among them, and this cache is persisted.
       * The row is re-read with the named columns instead.
       */
      subscribeIncident: (id) => {
        const channel = supabase
          .channel(`navmate-incident-${id}`)
          .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'incidents', filter: `id=eq.${id}` },
            () => void get().refresh(id),
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') void get().refresh(id)
          })
        return () => void supabase.removeChannel(channel)
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
        set({
          cache: [],
          pending: [],
          failed: [],
          ownerId: null,
          currentIncidentId: null,
        }),
    }),
    {
      name: 'navmate.incidents.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        cache: s.cache,
        pending: s.pending,
        failed: s.failed,
        ownerId: s.ownerId,
        currentIncidentId: s.currentIncidentId,
      }),
    },
  ),
)
