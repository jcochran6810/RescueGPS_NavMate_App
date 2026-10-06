import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { createBackStack, type BackStack } from '@/lib/backStack'
import { isSearchStep, isTabId, type SearchStep, type TabId } from '@/lib/sections'

/**
 * Which section is on screen, kept in step with the browser's history so the
 * phone's back button goes to the previous screen — see `lib/backStack.ts`.
 *
 * One instance for the app, started by `startSections` once App knows which
 * section to open on (a passage being steered opens the chart).
 */
interface SectionState {
  tab: TabId
  canGoBack: boolean
  /** The search step last open, which the bottom bar's Search returns to. */
  lastSearchStep: SearchStep | null
}

export const useSection = create<SectionState>()(() => ({
  tab: 'home',
  canGoBack: false,
  lastSearchStep: null,
}))

let stack: BackStack | null = null

function sync() {
  if (!stack) return
  const tab = stack.tab() as TabId
  useSection.setState((s) => ({
    tab,
    canGoBack: stack!.canGoBack(),
    lastSearchStep: isSearchStep(tab) ? tab : s.lastSearchStep,
  }))
}

/** Start following the browser's history. Idempotent; returns a stop function. */
export function startSections(initial: TabId | null): () => void {
  if (typeof window === 'undefined') return () => {}
  if (!stack) {
    // Scroll is NavMate's to manage (each section opens at its top). Left to
    // the browser, every history step — including the silent one when a sheet
    // closes — jumps the page back to wherever that entry was scrolled,
    // which threw the chart off screen just as a point was to be picked.
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
    stack = createBackStack({
      history: window.history,
      home: 'home',
      initial,
      isTab: isTabId,
    })
    stack.subscribe(sync)
    sync()
  }
  const onPop = (e: PopStateEvent) => stack?.onPopState(e.state)
  window.addEventListener('popstate', onPop)
  return () => window.removeEventListener('popstate', onPop)
}

/** Open a section. */
export function goTo(tab: TabId) {
  if (stack) stack.navigate(tab)
  else useSection.setState({ tab })
}

/** The previous screen — the same as the phone's back button. */
export function goBack() {
  stack?.back()
}

/**
 * Let the back button close an overlay — a sheet, a menu, a full-screen map —
 * before it changes the page underneath. `active` is whether it is open;
 * `onClose` is what its own ✕ does.
 */
export function useBackDismiss(active: boolean, onClose: () => void) {
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  useEffect(() => {
    if (!active || !stack) return
    const s = stack
    const key = s.openOverlay(() => closeRef.current())
    return () => s.releaseOverlay(key)
  }, [active])
}
