import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  AltitudeUnit,
  DepthUnit,
  DistanceUnit,
  SpeedUnit,
  TempUnit,
} from '@/lib/units'

/**
 * What every reading on every screen is shown in.
 *
 * Persisted and global, the same reasoning as `useCoordFormat`: a crew works
 * in one set of units — whatever their charts, their radio traffic and their
 * other instruments use — and a depth in feet on one screen beside a depth in
 * metres on another is how a boat ends up on a bar.
 *
 * The defaults are the US field defaults this app was built around, and they
 * are the ones already hardcoded in the screens these replace: feet, nautical
 * miles, knots, Fahrenheit. Changing one changes the display and nothing else
 * — every record keeps its stored unit, because several of them are contracts
 * with the RescueGPS command system rather than preferences.
 */
interface UnitsState {
  distance: DistanceUnit
  depth: DepthUnit
  speed: SpeedUnit
  temp: TempUnit
  altitude: AltitudeUnit
  set: (patch: Partial<Omit<UnitsState, 'set' | 'reset'>>) => void
  reset: () => void
}

const DEFAULTS = {
  distance: 'nm',
  depth: 'ft',
  speed: 'kn',
  temp: 'f',
  altitude: 'ft',
} satisfies Omit<UnitsState, 'set' | 'reset'>

export const useUnits = create<UnitsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      set: (patch) => set(patch),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'navmate.units.v1',
      storage: createJSONStorage(() => localStorage),
    },
  ),
)
