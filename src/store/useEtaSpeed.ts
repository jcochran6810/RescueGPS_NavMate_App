import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { ETA_SPEED_MODES, MAX_CUSTOM_KN, type EtaSpeedMode } from '@/lib/etaSpeed'

/**
 * Which speed the ETA is worked at — the crew's choice, kept on the phone
 * (a preference, like the units: nothing about it belongs to one passage or
 * one account). See `lib/etaSpeed.ts`.
 */
export interface EtaSpeedState {
  mode: EtaSpeedMode
  /** The custom speed, knots; null until one is set. */
  customKn: number | null
  setMode: (mode: EtaSpeedMode) => void
  /** Knots, already validated (`parseCustomSpeed`); null clears it. */
  setCustomKn: (kn: number | null) => void
}

function validMode(m: unknown): m is EtaSpeedMode {
  return typeof m === 'string' && (ETA_SPEED_MODES as readonly string[]).includes(m)
}

function validKn(kn: unknown): number | null {
  return typeof kn === 'number' && Number.isFinite(kn) && kn > 0 && kn <= MAX_CUSTOM_KN ? kn : null
}

export const useEtaSpeed = create<EtaSpeedState>()(
  persist(
    (set) => ({
      mode: 'current',
      customKn: null,
      setMode: (mode) => {
        if (validMode(mode)) set({ mode })
      },
      setCustomKn: (kn) => set({ customKn: validKn(kn) }),
    }),
    {
      name: 'navmate.eta.v1',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ mode: s.mode, customKn: s.customKn }),
      // Whatever is stored is read back as untrusted: a mode that is not one
      // of the four, or a speed that is not a sane number, is dropped.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<EtaSpeedState>
        return {
          ...current,
          mode: validMode(p.mode) ? p.mode : current.mode,
          customKn: validKn(p.customKn),
        }
      },
    },
  ),
)
