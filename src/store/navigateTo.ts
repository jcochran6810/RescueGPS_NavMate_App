import type { GoToPlace } from '@/store/useGoTo'
import { useNavigation } from '@/store/useNavigation'

/**
 * Start a route to `place` from the boat's own position — the one thing
 * "Navigate here" means, from wherever it was asked.
 *
 * Google-Maps style: no start to set by hand, no button to press. The route is
 * planned from the live fix at once and shown on the Chart tab; "Change start"
 * there is for planning ahead, and is the secondary path.
 */
export function navigateTo(place: GoToPlace): Promise<void> {
  return useNavigation.getState().setDestination(
    { lat: place.lat, lon: place.lon, label: place.label },
    null,
  )
}
