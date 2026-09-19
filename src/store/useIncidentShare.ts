import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
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
/** How often to ask where everyone else is. */
export const UNITS_REFRESH_MS = 20_000
/** A unit that has not reported for this long is stale, and says so. */
export const UNIT_STALE_MS = 5 * 60_000

interface Queued {
  client_id: string
  incident_id: string
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
  sending: boolean
  lastPublishedAt: number
  lastError: string | null

  /** Offer a fix. Rate-limited, and a no-op without an incident. */
  publish: (fix: Fix, incidentId: string | null) => Promise<void>
  flush: () => Promise<void>
  /** Read every other unit on the search. */
  refreshUnits: (incidentId: string) => Promise<void>
  clearLocal: () => void
}

const online = () => typeof navigator === 'undefined' || navigator.onLine

export const useIncidentShare = create<ShareState>()(
  persist(
    (set, get) => ({
      queue: [],
      units: [],
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
        try {
          const { error } = await supabase
            .from('asset_tracks')
            .upsert(
              queue.map((q) => ({ ...q, user_id: uid })),
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

      clearLocal: () => set({ queue: [], units: [], lastError: null }),
    }),
    {
      name: 'navmate.share.v1',
      storage: createJSONStorage(() => localStorage),
      // The buffer survives a reload, because the phone being closed is
      // exactly when the gap in the shared track would otherwise appear.
      // Other units' positions do not: they are stale the moment the app is
      // not running, and a restored one would draw a boat that has moved.
      partialize: (s) => ({ queue: s.queue }),
    },
  ),
)

/** Radio name first — it is what a crew is called on this search. */
export function unitName(u: { call_sign: string | null; full_name: string | null }): string {
  return u.call_sign?.trim() || u.full_name?.trim() || 'Unit'
}
