import { create } from 'zustand'

/**
 * A position one screen hands to another.
 *
 * The tab a crew is looking at is local state in `App`, so the Datum
 * worksheet cannot reach into the chart plotter to set a destination. This is
 * the seam: the worksheet puts a place here and switches tab, and the plotter
 * takes it.
 *
 * **Consumed once, deliberately.** The plotter reads it and clears it, so a
 * destination the crew then edits by hand is not silently overwritten the next
 * time the component mounts. A stale "go here" on a screen a crew has already
 * moved on from is worse than no shortcut at all.
 *
 * Not persisted: it is a gesture in one sitting, not a record of the search.
 * Everything that must survive a reload is a `sar_records` row.
 */
export interface GoToPlace {
  lat: number
  lon: number
  label: string
}

interface GoToState {
  /** Waiting to be picked up by whichever screen it was aimed at. */
  pending: GoToPlace | null
  /**
   * The crew has asked to be taken to the datum at least once this sitting.
   *
   * Kept after `pending` is consumed, because it is what reveals "Begin search
   * pattern" — starting a pattern is the step after getting there, and
   * offering it first invites a crew to plan a sweep around a datum they are
   * still a mile from.
   */
  headedToDatum: boolean
  goTo: (place: GoToPlace) => void
  /** Take the pending place, leaving nothing behind. */
  take: () => GoToPlace | null
  reset: () => void
}

export const useGoTo = create<GoToState>()((set, get) => ({
  pending: null,
  headedToDatum: false,

  goTo: (place) => set({ pending: place, headedToDatum: true }),

  take: () => {
    const p = get().pending
    if (p) set({ pending: null })
    return p
  },

  reset: () => set({ pending: null, headedToDatum: false }),
}))
