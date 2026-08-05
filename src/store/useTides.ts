import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  fetchPredictions,
  fetchStations,
  nearestStations,
  type TideExtreme,
  type TideStation,
} from '@/lib/tides'

/**
 * Tide state, cached hard.
 *
 * The station list is downloaded once and kept, so the nearest-station lookup
 * keeps working with no signal. Predictions are astronomical rather than
 * observed, so a cached table stays correct for its window — it is worth
 * showing a few hours old with a note rather than showing nothing, which is
 * the opposite of the call made for waypoints.
 */

/** Station metadata barely changes; a month between refreshes is generous. */
const STATIONS_TTL_MS = 30 * 24 * 3_600_000
/** Predictions cover 48 hours ahead, so this keeps a full day in hand. */
const PREDICTIONS_TTL_MS = 6 * 3_600_000

interface TideState {
  stations: TideStation[]
  stationsFetchedAt: number | null

  /** Station the crew pinned. Null means follow the nearest to the fix. */
  pinnedStationId: string | null
  /** Station the loaded predictions belong to. */
  stationId: string | null
  extremes: TideExtreme[]
  fetchedAt: number | null

  loading: boolean
  /** Set when the last attempt failed. Any cached table is still shown. */
  error: string | null

  station: () => TideStation | null
  stale: () => boolean

  /** Load predictions for the station nearest `lat`/`lon`, or the pinned one. */
  refresh: (lat: number, lon: number, force?: boolean) => Promise<void>
  pin: (stationId: string | null, lat: number, lon: number) => Promise<void>
  reset: () => void
}

/** The refresh that arrived while another was in flight, if any. */
let queued: { lat: number; lon: number; force: boolean } | null = null

function message(err: unknown): string {
  if (err instanceof Error) {
    // fetch rejects with a bare TypeError when the network is unreachable,
    // which reads as a bug rather than as "no signal".
    if (err.name === 'TypeError') return 'Could not reach NOAA — no connection?'
    return err.message
  }
  return 'Could not load tide predictions'
}

export const useTides = create<TideState>()(
  persist(
    (set, get) => ({
      stations: [],
      stationsFetchedAt: null,
      pinnedStationId: null,
      stationId: null,
      extremes: [],
      fetchedAt: null,
      loading: false,
      error: null,

      station: () => {
        const { stations, stationId } = get()
        return stations.find((s) => s.id === stationId) ?? null
      },

      stale: () => {
        const at = get().fetchedAt
        return at === null || Date.now() - at > PREDICTIONS_TTL_MS
      },

      refresh: async (lat, lon, force = false) => {
        if (get().loading) {
          // Remember the newest request instead of dropping it — a position
          // that crossed a station boundary while a fetch was in flight used
          // to be lost until the next coincidental coordinate change.
          queued = { lat, lon, force }
          return
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          set({ error: 'Need a position before tides can be looked up' })
          return
        }

        set({ loading: true, error: null })
        try {
          let stations = get().stations
          const stationsAge = get().stationsFetchedAt
          if (
            stations.length === 0 ||
            stationsAge === null ||
            Date.now() - stationsAge > STATIONS_TTL_MS
          ) {
            stations = await fetchStations()
            set({ stations, stationsFetchedAt: Date.now() })
          }

          const pinned = get().pinnedStationId
          const target =
            (pinned && stations.find((s) => s.id === pinned)) ||
            nearestStations(lat, lon, stations, 1)[0]

          if (!target) {
            set({ loading: false, error: 'No NOAA tide station found' })
            return
          }

          // Nothing to do if the same station's table is still fresh.
          if (!force && target.id === get().stationId && !get().stale()) {
            set({ loading: false })
            return
          }

          const extremes = await fetchPredictions(target.id)
          set({
            stationId: target.id,
            extremes,
            fetchedAt: Date.now(),
            loading: false,
            error: null,
          })
        } catch (err) {
          // The cached table stays put — stale tides beat no tides.
          set({ loading: false, error: message(err) })
        } finally {
          const next = queued
          queued = null
          if (next) void get().refresh(next.lat, next.lon, next.force)
        }
      },

      pin: async (stationId, lat, lon) => {
        set({ pinnedStationId: stationId })
        await get().refresh(lat, lon, true)
      },

      reset: () =>
        set({
          pinnedStationId: null,
          stationId: null,
          extremes: [],
          fetchedAt: null,
          error: null,
        }),
    }),
    {
      name: 'navmate-tides',
      version: 1,
      // Extreme times are Dates. JSON flattens them to strings, so they are
      // revived on the way back in; a string masquerading as a Date would blow
      // up on the first .getTime() in the UI.
      storage: createJSONStorage(() => localStorage, {
        reviver: (key, value) =>
          key === 'at' && typeof value === 'string' ? new Date(value) : value,
      }),
      partialize: (s) => ({
        stations: s.stations,
        stationsFetchedAt: s.stationsFetchedAt,
        pinnedStationId: s.pinnedStationId,
        stationId: s.stationId,
        extremes: s.extremes,
        fetchedAt: s.fetchedAt,
      }),
    },
  ),
)
