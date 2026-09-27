import { create } from 'zustand'

/**
 * Screen-only navigation state that is nobody's business but the layout's.
 *
 * `cardInView`: whether the steering card at the top of the Chart tab is on
 * screen. When the crew scrolls down to the leg list mid-passage the card
 * goes with it, and the bearing, distance and ETA went with it — so the
 * one-line banner the other tabs show is put up on the Chart tab too while
 * the card is out of sight. Not persisted.
 */
interface NavUiState {
  cardInView: boolean
  setCardInView: (v: boolean) => void
}

export const useNavUi = create<NavUiState>()((set, get) => ({
  cardInView: true,
  setCardInView: (v) => {
    if (get().cardInView !== v) set({ cardInView: v })
  },
}))
