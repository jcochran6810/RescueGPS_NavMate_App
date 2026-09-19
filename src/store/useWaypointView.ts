import { create } from 'zustand'

/**
 * The waypoint a crew has just tapped, on its way to the sheet that shows it.
 *
 * A waypoint appears in seven places — the Waypoints tab, the nearest-four on
 * Home, the compass bearings table, the ETA picker, and as a marker on the
 * tracker, the chart and the pattern map — and until now each of those showed
 * a different subset of it and offered different things to do with it. A
 * teammate's photograph could be seen in one place, the position copied in
 * another, and there was nowhere at all to say "take me to that one".
 *
 * So there is one sheet, and this is how anything reaches it: by id, not by
 * value, so the sheet always renders what the store holds now rather than a
 * copy taken at the moment of the tap. A waypoint edited or deleted by a
 * teammate while the sheet is open resolves to nothing and the sheet closes,
 * which is the truth.
 *
 * Deliberately not persisted: it is a tap, not a record.
 */
interface WaypointViewState {
  openId: string | null
  open: (id: string) => void
  close: () => void
}

export const useWaypointView = create<WaypointViewState>()((set) => ({
  openId: null,
  open: (id) => set({ openId: id }),
  close: () => set({ openId: null }),
}))
