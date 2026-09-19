import { create } from 'zustand'

/**
 * What a long press on a map asked for, on its way to whoever can do it.
 *
 * The map cannot do either of these things itself, and for different reasons.
 * Saving a waypoint needs the add-waypoint sheet — which contains a map, so a
 * map that imported it would be a cycle. Navigating needs the tab to change,
 * and the tab is state in `App`. So the map states the request and
 * `MapActionHost`, mounted once beside the tabs, carries it out.
 *
 * **Consumed once**, the same discipline as `useGoTo`: the host clears the
 * request when it is done with it, so a sheet dismissed cannot be re-opened by
 * an unrelated re-render, and a "take me here" a crew has moved on from does
 * not fire a second time.
 *
 * Not persisted. A press is a gesture in one sitting; the waypoint it creates
 * is the thing that survives.
 */
export type MapActionKind = 'waypoint' | 'navigate'

export interface MapActionRequest {
  kind: MapActionKind
  lat: number
  lon: number
}

interface MapActionState {
  request: MapActionRequest | null
  /** Ask for something to be done with the position under the press. */
  ask: (kind: MapActionKind, at: { lat: number; lon: number }) => void
  clear: () => void
}

export const useMapAction = create<MapActionState>()((set) => ({
  request: null,
  ask: (kind, at) => {
    if (!Number.isFinite(at.lat) || !Number.isFinite(at.lon)) return
    set({ request: { kind, lat: at.lat, lon: at.lon } })
  },
  clear: () => set({ request: null }),
}))
