import { create } from 'zustand'

export type ToastTone = 'info' | 'success' | 'error'

interface ToastState {
  message: string
  tone: ToastTone
  /** Bumped on every toast so repeats of the same text still re-trigger. */
  seq: number
  show: (message: string, tone?: ToastTone) => void
  clear: () => void
}

export const useToast = create<ToastState>((set, get) => ({
  message: '',
  tone: 'info',
  seq: 0,
  show: (message, tone = 'info') =>
    set({ message, tone, seq: get().seq + 1 }),
  clear: () => set({ message: '' }),
}))

export const toast = (message: string, tone: ToastTone = 'info') =>
  useToast.getState().show(message, tone)
