import { useEffect } from 'react'
import { activeVessel, useNavigation } from '@/store/useNavigation'
import { useTeams } from '@/store/useTeams'
import { useTracker } from '@/store/useTracker'
import { useVessels } from '@/store/useVessels'
import { routeArrivalFt } from '@/lib/steer'

/**
 * What drives the route while the crew is looking at something else.
 *
 * Mounted once, in App, so it runs whichever tab is on screen — the whole
 * point of moving navigation out of the Chart tab. It owns no state; it only
 * connects the navigation store to the things that should move it:
 *
 *   - every new GPS fix, while navigating → `onFix` (advance, arrive,
 *     re-route);
 *   - the boat's draft, under-keel margin, stand-off or cruise speed
 *     changing, or a different boat being chosen → re-plan, because a route
 *     planned for a 3 ft draft is not a route for a 5 ft one;
 *   - the arrival setting changing → the turn points' circles resized for
 *     it (`setArrivalCap`), NOT a re-plan: a re-plan from the live fix
 *     renumbered the waypoints the crew was following, for a setting that
 *     only says how close to them counts as there;
 *   - the network coming back while the last plan failed → try again (most
 *     failures underway are a chart that could not be read);
 *   - navigating → the GPS kept on. Stopping the tracker on the Track tab
 *     mid-passage would otherwise freeze the card on the last fix.
 */
export function useNavigationEngine(): void {
  useEffect(() => startNavigationEngine(), [])
}

/**
 * Settle time before a settings change re-plans, ms. A boat saved from the
 * edit form writes once, but the sync that follows writes the same row back;
 * this folds the two into one plan.
 */
export const SETTINGS_SETTLE_MS = 400

/**
 * Everything the plan's geometry depends on besides its two ends, as one
 * comparable string. 'none' when no boat is chosen. The arrival setting is
 * not in it — see `setArrivalCap`.
 */
export function planSettingsKey(): string {
  const boat = activeVessel()
  if (!boat) return 'none'
  return [
    boat.id,
    boat.draft_m,
    boat.under_keel_margin_m,
    boat.clearance_m,
    boat.cruise_speed_kn,
  ].join('|')
}

/**
 * The engine without React: subscribes, and returns the unsubscribe. Split
 * out so the wiring can be tested in node, and so `useEffect` above is the
 * only React in this file.
 */
export function startNavigationEngine(): () => void {
  const nav = useNavigation

  const offFix = useTracker.subscribe((s, prev) => {
    if (!s.fix || s.fix === prev.fix) return
    if (nav.getState().status !== 'navigating') return
    nav.getState().onFix(s.fix)
  })

  let lastKey = planSettingsKey()
  let timer: ReturnType<typeof setTimeout> | null = null
  const onSettings = () => {
    const key = planSettingsKey()
    if (key === lastKey) return
    lastKey = key
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (nav.getState().dest) void nav.getState().replan('boat')
    }, SETTINGS_SETTLE_MS)
  }
  const offVessels = useVessels.subscribe(onSettings)
  const offTeams = useTeams.subscribe(onSettings)
  // Not on every fix — only when the arrival setting a route uses moved
  // (50 → 100 on the Search tab is no change for a route: both are 100).
  const offArrival = useTracker.subscribe((s, prev) => {
    if (routeArrivalFt(s.arrivalFt) === routeArrivalFt(prev.arrivalFt)) return
    nav.getState().setArrivalCap(s.arrivalFt)
  })

  const onOnline = () => {
    const s = nav.getState()
    if (s.status === 'failed' && s.dest) void s.replan('retry')
  }
  const win = typeof window !== 'undefined' ? window : null
  win?.addEventListener('online', onOnline)

  const keepTracking = () => {
    if (nav.getState().status !== 'navigating') return
    const tracker = useTracker.getState()
    if (!tracker.watching) tracker.start()
  }
  keepTracking()
  const offNav = nav.subscribe((s, prev) => {
    if (s.status !== prev.status) keepTracking()
  })
  // Also when something else stops the tracker mid-passage.
  const offWatch = useTracker.subscribe((s, prev) => {
    if (prev.watching && !s.watching) keepTracking()
  })

  return () => {
    offFix()
    offVessels()
    offTeams()
    offArrival()
    offNav()
    offWatch()
    win?.removeEventListener('online', onOnline)
    if (timer) clearTimeout(timer)
  }
}
