import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
import { isOffline, isTransient, describeError } from '@/lib/retry'
import { victimRow, victimUpdatePatch, type VictimDraft } from '@/lib/victim'

/**
 * The description of who is being looked for, on its way to the command
 * system's `victims` table.
 *
 * Queued like everything else that writes, and for the same reason: the
 * description is very often typed while the boat is already outside coverage,
 * and it has to be on the screen the crew is searching from whether or not it
 * has reached the server. The local copy is keyed by incident, so it is
 * readable the instant it is typed.
 *
 * Simpler than the waypoint queue on purpose. There is one op — write the
 * description for this incident — and writing it twice with different words is
 * not a conflict to resolve, it is a correction. So the queue keeps the latest
 * draft per incident rather than a list of edits, which also means a long
 * period offline cannot build a backlog of supersed ed versions.
 */
interface VictimState {
  /** The latest description per incident id, synced or not. */
  drafts: Record<string, VictimDraft>
  /** Incident ids whose description has not reached the server. */
  pending: string[]
  /** Refusals so far per incident (an outage does not count). */
  attempts: Record<string, number>
  /** Descriptions the server kept refusing: kept, with the reason, for Retry. */
  failed: { incidentId: string; reason: string; failedAt: string }[]
  syncing: boolean
  lastError: string | null

  get: (incidentId: string | null) => VictimDraft | null
  save: (incidentId: string, draft: VictimDraft) => Promise<void>
  load: (incidentId: string) => Promise<void>
  flush: () => Promise<void>
  retryFailed: () => Promise<void>
  clearLocal: () => void
}

const MAX_ATTEMPTS = 3

const online = () => typeof navigator === 'undefined' || navigator.onLine

/** Write one incident's description: correct the first person, or add them. */
async function writeDescription(incidentId: string, draft: VictimDraft): Promise<void> {
  // One description per incident from the field: look for the row first so a
  // second save corrects it rather than adding a second person to the search.
  const existing = await supabase
    .from('victims')
    .select('id')
    .eq('incident_id', incidentId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (existing.error) throw existing.error
  if (existing.data?.id) {
    // Shared with the command wizard: correct, never blank out
    // (`victimUpdatePatch`).
    const patch = victimUpdatePatch(draft, incidentId)
    if (Object.keys(patch).length > 0) {
      const written = await supabase.from('victims').update(patch).eq('id', existing.data.id)
      if (written.error) throw written.error
    }
  } else {
    const written = await supabase.from('victims').insert(victimRow(draft, incidentId))
    if (written.error) throw written.error
  }
}

export const useVictims = create<VictimState>()(
  persist(
    (set, get) => ({
      drafts: {},
      pending: [],
      attempts: {},
      failed: [],
      syncing: false,
      lastError: null,

      get: (incidentId) => (incidentId ? (get().drafts[incidentId] ?? null) : null),

      save: async (incidentId, draft) => {
        set({
          drafts: { ...get().drafts, [incidentId]: draft },
          pending: get().pending.includes(incidentId)
            ? get().pending
            : [...get().pending, incidentId],
        })
        await get().flush()
      },

      load: async (incidentId) => {
        if (!online()) return
        // Never `select *`: that table carries medical detail this app has no
        // screen for, and this store is persisted to localStorage on a phone
        // that may be handed round a boat.
        const { data, error } = await supabase
          .from('victims')
          .select(
            'name, age, gender, height_ft, height_in, height_estimated, weight_lbs, weight_estimated, body_type, hair_color, upper_clothing, upper_clothing_color, lower_clothing, lower_clothing_color, clothing_type, has_life_jacket, life_jacket_color, life_jacket_has_reflective, swimming_ability, intoxication_level, injuries, status',
          )
          .eq('incident_id', incidentId)
          // The first person entered — the same row the save below corrects.
          // Command can add more than one; without an order "the" victim was
          // whichever row the database happened to return first.
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle()
        if (error || !data) return
        // A local draft still waiting to sync is newer than anything the
        // server can answer with, so it is not overwritten by this.
        if (get().pending.includes(incidentId)) return
        const row = data as Record<string, unknown>
        const str = (k: string) => String(row[k] ?? '')
        set({
          drafts: {
            ...get().drafts,
            [incidentId]: {
              name: str('name'),
              age: str('age'),
              gender: str('gender'),
              height_ft: str('height_ft'),
              height_in: str('height_in'),
              height_estimated: row.height_estimated === true,
              weight_lbs: str('weight_lbs'),
              weight_estimated: row.weight_estimated === true,
              body_type: str('body_type'),
              hair_color: str('hair_color'),
              upper_clothing: str('upper_clothing'),
              upper_clothing_color: str('upper_clothing_color'),
              lower_clothing: str('lower_clothing'),
              lower_clothing_color: str('lower_clothing_color'),
              clothing_type: str('clothing_type'),
              has_life_jacket: row.has_life_jacket === true,
              life_jacket_color: str('life_jacket_color'),
              life_jacket_has_reflective: row.life_jacket_has_reflective === true,
              swimming_ability: str('swimming_ability'),
              intoxication_level: str('intoxication_level'),
              injuries: str('injuries'),
              status: str('status') || 'missing',
            },
          },
        })
      },

      flush: async () => {
        const queue = get().pending
        if (queue.length === 0 || !online() || get().syncing) return
        set({ syncing: true })
        const done: string[] = []
        const gaveUp: { incidentId: string; reason: string; failedAt: string }[] = []
        const attempts = { ...get().attempts }
        let lastError: string | null = null
        try {
          for (const incidentId of queue) {
            const draft = get().drafts[incidentId]
            if (!draft) {
              done.push(incidentId)
              continue
            }
            try {
              await writeDescription(incidentId, draft)
              done.push(incidentId)
              delete attempts[incidentId]
            } catch (e) {
              lastError = errorMessage(e)
              // No signal: stop and keep everything for the next pass.
              if (isOffline(e) || isTransient(e)) break
              // A refusal: try a few times, then set it aside so it does not
              // hold up the other incidents' descriptions behind it.
              attempts[incidentId] = (attempts[incidentId] ?? 0) + 1
              if (attempts[incidentId] >= MAX_ATTEMPTS) {
                gaveUp.push({ incidentId, reason: describeError(e), failedAt: new Date().toISOString() })
                delete attempts[incidentId]
                done.push(incidentId)
              }
            }
          }
          if (!lastError) set({ lastError: null })
          else set({ lastError })
        } finally {
          set({
            pending: get().pending.filter((id) => !done.includes(id)),
            attempts,
            failed: [...get().failed.filter((f) => !gaveUp.some((g) => g.incidentId === f.incidentId)), ...gaveUp],
            syncing: false,
          })
        }
      },

      retryFailed: async () => {
        const ids = get().failed.map((f) => f.incidentId)
        if (ids.length === 0) return
        set({
          failed: [],
          pending: [...ids.filter((id) => !get().pending.includes(id)), ...get().pending],
        })
        await get().flush()
      },

      clearLocal: () => set({ drafts: {}, pending: [], attempts: {}, failed: [], lastError: null }),
    }),
    {
      name: 'navmate.victims.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ drafts: s.drafts, pending: s.pending, attempts: s.attempts, failed: s.failed }),
    },
  ),
)
