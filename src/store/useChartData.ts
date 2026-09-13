import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  bandForSpan,
  boundsSpanNM,
  containsBounds,
  fetchChartFeatures,
  padBounds,
  type ChartBounds,
} from '@/lib/chart'
import { EMPTY_FEATURES, type ChartFeatures } from '@/lib/routing'
import { describeError } from '@/lib/retry'

/**
 * Charted depths and hazards for the area being planned in.
 *
 * Unlike every other store in this app, the features themselves are **not**
 * persisted. A working area of ENC polygons is comfortably past what
 * localStorage will hold, and this repo has deliberately not taken on
 * IndexedDB yet. Instead the raw HTTP responses are kept by the service
 * worker (a CacheFirst rule on `encdirect.noaa.gov` in vite.config.ts), so a
 * second fetch of an area already visited is served from the device with no
 * link — which is the offline story that actually matters — and this store
 * only holds the parsed result for as long as the app is open.
 *
 * What IS persisted is the small index of which areas have been pulled down,
 * so the UI can tell a crew what they are carrying before they leave the dock.
 */

export interface SavedArea {
  bounds: ChartBounds
  band: string
  savedAt: string
  coverage: ChartFeatures['coverage']
}

export type ChartStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ChartDataState {
  features: ChartFeatures
  /** The box `features` was fetched for, or null when nothing is loaded. */
  bounds: ChartBounds | null
  status: ChartStatus
  error: string | null
  saved: SavedArea[]

  /** True when the loaded features already cover this box. */
  covers: (b: ChartBounds) => boolean
  load: (b: ChartBounds, force?: boolean) => Promise<ChartFeatures>
  clear: () => void
}

const MAX_SAVED = 20

export const useChartData = create<ChartDataState>()(
  persist(
    (set, get) => ({
      features: EMPTY_FEATURES,
      bounds: null,
      status: 'idle',
      error: null,
      saved: [],

      covers: (b) => get().status === 'ready' && containsBounds(get().bounds, b),

      load: async (b, force = false) => {
        if (!force && get().covers(b)) return get().features
        if (get().status === 'loading') return get().features

        const bounds = padBounds(b)
        const band = bandForSpan(boundsSpanNM(bounds))
        set({ status: 'loading', error: null })
        try {
          const features = await fetchChartFeatures(bounds, { band })
          const entry: SavedArea = {
            bounds,
            band: band.id,
            savedAt: new Date().toISOString(),
            coverage: features.coverage,
          }
          set({
            features,
            bounds,
            status: 'ready',
            error: null,
            // Newest first, dropping any area of the same band that this one
            // now fully covers — keeping a box we have just superseded would
            // tell the crew they are carrying two areas when they have one.
            saved: [
              entry,
              ...get().saved.filter(
                (a) => !(a.band === band.id && containsBounds(bounds, a.bounds)),
              ),
            ].slice(0, MAX_SAVED),
          })
          return features
        } catch (e) {
          // No chart is a planning limitation, not a crash: the planner still
          // draws a straight line and says it has nothing to check it against.
          set({
            features: EMPTY_FEATURES,
            bounds: null,
            status: 'error',
            error: describeError(e),
          })
          return EMPTY_FEATURES
        }
      },

      clear: () =>
        set({
          features: EMPTY_FEATURES,
          bounds: null,
          status: 'idle',
          error: null,
        }),
    }),
    {
      name: 'navmate.chart.v1',
      storage: createJSONStorage(() => localStorage),
      // Only the index of saved areas. The features themselves live in the
      // service worker's cache — see the note at the top of this file.
      partialize: (s) => ({ saved: s.saved }),
    },
  ),
)
