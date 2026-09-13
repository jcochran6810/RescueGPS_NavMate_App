import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * Which coordinate format the crew reads in.
 *
 * Persisted and global rather than per-screen on purpose: a crew works in one
 * format — whatever their charts and their radio traffic use — and having the
 * waypoint form disagree with the destination picker is how a position gets
 * transcribed wrong. Set it once, it holds everywhere.
 *
 * DDM is the default because it is what marine charts, GPS sets and the Coast
 * Guard all print.
 */
export type CoordFormat = 'dd' | 'ddm' | 'dms'

export const COORD_FORMATS: { id: CoordFormat; label: string; hint: string }[] =
  [
    { id: 'dd', label: 'DD', hint: 'Decimal degrees — 29.300500' },
    { id: 'ddm', label: 'DDM', hint: "Degrees and decimal minutes — 29° 18.030' N" },
    { id: 'dms', label: 'DMS', hint: 'Degrees, minutes, seconds — 29° 18\' 01.8" N' },
  ]

interface CoordFormatState {
  format: CoordFormat
  setFormat: (f: CoordFormat) => void
}

export const useCoordFormat = create<CoordFormatState>()(
  persist(
    (set) => ({
      format: 'ddm',
      setFormat: (format) => set({ format }),
    }),
    {
      name: 'navmate.coordformat.v1',
      storage: createJSONStorage(() => localStorage),
    },
  ),
)
