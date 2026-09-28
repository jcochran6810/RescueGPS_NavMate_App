import type { GoToPlace } from '@/store/useGoTo'
import { useNavigation } from '@/store/useNavigation'

/**
 * Start a route to `place` from the boat's own position — the one thing
 * "Navigate here" means, from wherever it was asked.
 *
 * Google-Maps style: no start to set by hand, no button to press. The route is
 * planned from the live fix at once and shown on the Chart tab; "Change start"
 * there is for planning ahead, and is the secondary path.
 *
 * **Mid-passage it asks first.** A new destination ends the passage being
 * steered — a confirmed best-effort one included — and "Navigate here" sits
 * in a long-press menu and on the waypoint sheet, where a mis-tap is easy.
 * So while a route is being steered (or has just been arrived at) the crew is
 * asked, on screen, before it is replaced. Resolves true when the new route
 * was asked for, false when the crew kept the old one.
 *
 * `confirmReplace` is for tests and other callers; the app uses the browser's
 * own confirmation dialog, the same one used elsewhere for destructive steps.
 */
export async function navigateTo(
  place: GoToPlace,
  confirmReplace: (message: string) => boolean = defaultConfirm,
  /** Where from: null (the default) is the boat's live position — "Plan a course" may give a place. */
  origin: { lat: number; lon: number; label: string } | null = null,
): Promise<boolean> {
  const s = useNavigation.getState()
  if (s.status === 'navigating') {
    const message =
      `Stop the route to ${s.dest?.label ?? 'your destination'} and go to ${place.label} instead?`
    if (!confirmReplace(message)) return false
  }
  await s.setDestination(
    { lat: place.lat, lon: place.lon, label: place.label },
    origin ? { lat: origin.lat, lon: origin.lon, label: origin.label } : null,
  )
  return true
}

function defaultConfirm(message: string): boolean {
  return typeof window !== 'undefined' && typeof window.confirm === 'function'
    ? window.confirm(message)
    : true
}
