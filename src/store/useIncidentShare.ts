import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
import { applyTrackRow, type UnitPosition } from '@/lib/command'
import type { Fix, IncidentUnit } from '@/lib/types'

/**
 * What the units on one search can see of each other.
 *
 * Joining a search is only half of it — the half that matters on the water is
 * that everyone on it can see where everyone else is, where they have already
 * looked, and how fast they are closing on the datum. That is what this does,
 * in both directions: it publishes this boat's fixes to `asset_tracks` (the
 * command system's own telemetry table, so the dashboard sees them too), and
 * it reads back every other unit's latest position with the name they answer
 * to on the radio.
 *
 * **Positions are perishable, and that changes the offline rule.** Everything
 * else in NavMate queues offline and syncs later because a record of what was
 * observed is still true an hour afterwards. A live position is not: it is
 * only interesting while it is current. So this keeps a bounded buffer — the
 * track is the thing worth having later, and `recorded_at` carries the real
 * time, so a reconnect fills in the gap in the area-searched picture — but it
 * drops the oldest first rather than growing without limit, and nothing here
 * blocks a capture the way the waypoint queue deliberately does.
 *
 * **`client_id` is the idempotency key**, as it is everywhere the two systems
 * meet: a retry after a timeout that actually landed will not double up the
 * track.
 */

/** Seconds between published fixes. A boat at 20 kn moves ~150 m in 15 s. */
const PUBLISH_EVERY_S = 15
/** How many unsent fixes to hold. At one per 15 s this is about two hours. */
const BUFFER_MAX = 480
/**
 * How often to ask where everyone else is when the live feed cannot be
 * trusted to say.
 *
 * Positions arrive over Realtime (`asset_tracks`, filtered to the incident);
 * this is the fallback for when the socket has dropped, or has gone quiet for
 * longer than this — which on a phone moving between cells is the same thing
 * without the error.
 */
export const UNITS_REFRESH_MS = 60_000
/** A unit that has not reported for this long is stale, and says so. */
export const UNIT_STALE_MS = 5 * 60_000

interface Queued {
  client_id: string
  incident_id: string
  /**
   * The unit this fix belongs to (`resources.id`, contract C3). Null when the
   * unit is not registered yet — the server fills it from the crew row, and
   * the flush fills it from the cache once registration has answered.
   */
  asset_id?: string | null
  lat: number
  lng: number
  heading_deg: number | null
  speed_mps: number | null
  accuracy_m: number | null
  altitude_m: number | null
  recorded_at: string
  provider: string
}

interface ShareState {
  /** Fixes written but not yet accepted by the server. */
  queue: Queued[]
  units: IncidentUnit[]
  /**
   * This crew's unit id per incident, from `integ_register_unit`. Persisted:
   * it is what every fix, assignment and message to "my unit" is keyed on,
   * and a phone reopened offline still needs to know which unit it is.
   */
  unitIds: Record<string, string>
  /** The account those unit ids were issued to. Another sign-in on the same
   *  phone must not report its fixes as this crew's boat. */
  unitOwner: string | null
  /** True while the Realtime feed of other units is joined. */
  live: boolean
  /** When the feed last delivered a row (ms). */
  lastLiveAt: number
  sending: boolean
  lastPublishedAt: number
  lastError: string | null

  /** Offer a fix. Rate-limited, and a no-op without an incident. */
  publish: (fix: Fix, incidentId: string | null) => Promise<void>
  flush: () => Promise<void>
  /** Read every other unit on the search. */
  refreshUnits: (incidentId: string) => Promise<void>
  /**
   * Register this crew as a unit on the incident (idempotent server-side).
   * Never throws and never blocks tracking — a failure leaves fixes going out
   * with a null asset_id for the server to backfill, and is retried later.
   */
  registerUnit: (incidentId: string, vesselId: string | null) => Promise<string | null>
  unitId: (incidentId: string | null) => string | null
  /** Follow the other units live. Returns the unsubscribe. */
  subscribeUnits: (incidentId: string) => () => void
  clearLocal: () => void
}

const online = () => typeof navigator === 'undefined' || navigator.onLine

export const useIncidentShare = create<ShareState>()(
  persist(
    (set, get) => ({
      queue: [],
      units: [],
      unitIds: {},
      unitOwner: null,
      live: false,
      lastLiveAt: 0,
      sending: false,
      lastPublishedAt: 0,
      lastError: null,

      publish: async (fix, incidentId) => {
        if (!incidentId) return
        const now = Date.now()
        if (now - get().lastPublishedAt < PUBLISH_EVERY_S * 1000) return

        const uid = (await supabase.auth.getSession()).data.session?.user?.id
        if (!uid) return

        const recordedAt = new Date(fix.timestamp).toISOString()
        const row: Queued = {
          // Unique per user per fix, which is what makes a retry safe.
          client_id: `${uid}:${fix.timestamp}`,
          incident_id: incidentId,
          asset_id:
            get().unitOwner === uid ? (get().unitIds[incidentId] ?? null) : null,
          lat: fix.lat,
          lng: fix.lon,
          heading_deg: fix.heading,
          speed_mps: fix.speed,
          accuracy_m: fix.accuracy,
          altitude_m: fix.altitude,
          recorded_at: recordedAt,
          provider: 'navmate',
        }

        // Oldest out first: a two-hour-old position is of no use to anyone
        // still looking, and the alternative is a queue that grows all shift.
        const queue = [...get().queue, row].slice(-BUFFER_MAX)
        set({ queue, lastPublishedAt: now })
        await get().flush()
      },

      flush: async () => {
        const queue = get().queue
        if (queue.length === 0 || !online() || get().sending) return
        const uid = (await supabase.auth.getSession()).data.session?.user?.id
        if (!uid) return

        set({ sending: true })
        const unitIds = get().unitOwner === uid ? get().unitIds : {}
        try {
          const { error } = await supabase
            .from('asset_tracks')
            .upsert(
              queue.map((q) => ({
                ...q,
                // A fix buffered before the unit was registered picks the id
                // up here, so a backlog uploads already attributed.
                asset_id: q.asset_id ?? unitIds[q.incident_id] ?? null,
                user_id: uid,
              })),
              { onConflict: 'client_id' },
            )
          if (error) throw error
          // Only what was sent leaves the buffer — a fix recorded while this
          // was in flight is still waiting afterwards.
          const sent = new Set(queue.map((q) => q.client_id))
          set({
            queue: get().queue.filter((q) => !sent.has(q.client_id)),
            lastError: null,
          })
        } catch (e) {
          // Held, not dropped: the next fix will try again. A position that
          // cannot be shared is not a reason to stop navigating by it.
          set({ lastError: errorMessage(e) })
        } finally {
          set({ sending: false })
        }
      },

      refreshUnits: async (incidentId) => {
        if (!online()) return
        const { data, error } = await supabase.rpc('navmate_incident_units', {
          p_incident_id: incidentId,
        })
        if (error) {
          console.warn('units failed', errorMessage(error))
          return
        }
        const uid = (await supabase.auth.getSession()).data.session?.user?.id
        // This boat is already drawn, from its own live fix, and drawing it
        // twice — once live, once several seconds behind — reads as two boats.
        set({ units: ((data ?? []) as IncidentUnit[]).filter((u) => u.user_id !== uid) })
      },

      registerUnit: async (incidentId, vesselId) => {
        const uid =
          (await supabase.auth.getSession()).data.session?.user?.id ?? null
        if (!uid) return null
        if (get().unitOwner !== uid) set({ unitIds: {}, unitOwner: uid })
        if (!online()) return get().unitIds[incidentId] ?? null
        const { data, error } = await supabase.rpc('integ_register_unit', {
          p_incident_id: incidentId,
          p_vessel_id: vesselId,
        })
        if (error || typeof data !== 'string') {
          // Not a participant yet (an incident opened offline that has not
          // synced), or the boat is still in the queue. Retried later.
          console.warn('unit registration failed', errorMessage(error))
          return get().unitIds[incidentId] ?? null
        }
        set({ unitIds: { ...get().unitIds, [incidentId]: data } })
        // Anything buffered before this answer goes out attributed.
        void get().flush()
        return data
      },

      unitId: (incidentId) =>
        incidentId ? (get().unitIds[incidentId] ?? null) : null,

      subscribeUnits: (incidentId) => {
        let uid: string | null = null
        void supabase.auth.getSession().then((r) => {
          uid = r.data.session?.user?.id ?? null
        })
        const channel = supabase
          .channel(`navmate-units-${incidentId}`)
          .on(
            'postgres_changes',
            {
              // An upsert that lands on an existing client_id arrives as an
              // UPDATE; either way the row is a position.
              event: '*',
              schema: 'public',
              table: 'asset_tracks',
              filter: `incident_id=eq.${incidentId}`,
            },
            (payload) => {
              const row = payload.new as Partial<UnitPosition>
              if (!row?.user_id || row.lat == null || row.lng == null) return
              if (row.user_id === uid) return
              set({ lastLiveAt: Date.now() })
              const next = applyTrackRow(get().units, row as UnitPosition)
              // A unit not on the list yet: the row has no name on it, so
              // ask who it is rather than draw a nameless boat.
              if (next === null) void get().refreshUnits(incidentId)
              else if (next !== get().units) set({ units: next })
            },
          )
          .subscribe((status) => {
            const live = status === 'SUBSCRIBED'
            set({ live })
            // Joining (or rejoining after a drop) may have missed rows.
            if (live) void get().refreshUnits(incidentId)
          })
        return () => {
          set({ live: false })
          void supabase.removeChannel(channel)
        }
      },

      clearLocal: () => set({ queue: [], units: [], lastError: null }),
    }),
    {
      name: 'navmate.share.v1',
      storage: createJSONStorage(() => localStorage),
      // The buffer survives a reload, because the phone being closed is
      // exactly when the gap in the shared track would otherwise appear.
      // Other units' positions do not: they are stale the moment the app is
      // not running, and a restored one would draw a boat that has moved.
      partialize: (s) => ({
        queue: s.queue,
        unitIds: s.unitIds,
        unitOwner: s.unitOwner,
      }),
    },
  ),
)

/** Radio name first — it is what a crew is called on this search. */
export function unitName(u: { call_sign: string | null; full_name: string | null }): string {
  return u.call_sign?.trim() || u.full_name?.trim() || 'Unit'
}
