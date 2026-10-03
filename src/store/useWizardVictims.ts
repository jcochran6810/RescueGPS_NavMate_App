import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
import { useIncidents } from '@/store/useIncidents'

/**
 * The people a crew entered in the new-incident wizard, on their way to the
 * command system's `victims` table — as the rows RescueGPS's own wizard
 * writes (lib/wizard/rows.ts), one per person, in the order entered.
 *
 * Offline first, like everything a crew writes: the rows wait here until the
 * phone is online AND the incident they belong to has reached the server
 * (the table keys them on it). Each row carries an id chosen on this phone,
 * so a retry after a lost answer finds the row instead of adding the person
 * twice.
 */
export interface WizardVictimRow {
  id: string
  incident_id: string
  created_at: string
  [column: string]: unknown
}

interface WizardVictimsState {
  pending: WizardVictimRow[]
  syncing: boolean
  lastError: string | null
  queue: (incidentId: string, rows: Record<string, unknown>[]) => Promise<void>
  flush: () => Promise<void>
  clearLocal: () => void
}

const online = () => typeof navigator === 'undefined' || navigator.onLine

const newRowId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`

export const useWizardVictims = create<WizardVictimsState>()(
  persist(
    (set, get) => ({
      pending: [],
      syncing: false,
      lastError: null,

      queue: async (incidentId, rows) => {
        // 1 ms apart: the table's order (created_at) is the order entered.
        const base = Date.now()
        const add = rows.map((r, i) => ({
          ...r,
          id: newRowId(),
          incident_id: incidentId,
          created_at: new Date(base + i).toISOString(),
        }))
        set({ pending: [...get().pending, ...add] })
        await get().flush()
      },

      flush: async () => {
        const queue = get().pending
        if (queue.length === 0 || !online() || get().syncing) return
        // The incident must be on the server first (victims are keyed on it).
        const waiting = new Set(
          useIncidents
            .getState()
            .pending.filter((op) => op.kind === 'create')
            .map((op) => (op.kind === 'create' ? op.incident.id : '')),
        )
        const ready = queue.filter((r) => !waiting.has(r.incident_id))
        if (ready.length === 0) return
        set({ syncing: true })
        const done = new Set<string>()
        try {
          for (const row of ready) {
            const { error } = await supabase
              .from('victims')
              .upsert(row, { onConflict: 'id', ignoreDuplicates: true })
            if (error) throw error
            done.add(row.id)
          }
          set({ lastError: null })
        } catch (e) {
          set({ lastError: errorMessage(e) })
        } finally {
          set({
            pending: get().pending.filter((r) => !done.has(r.id)),
            syncing: false,
          })
        }
      },

      clearLocal: () => set({ pending: [], lastError: null }),
    }),
    {
      name: 'navmate-wizard-victims',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ pending: s.pending }),
    },
  ),
)
