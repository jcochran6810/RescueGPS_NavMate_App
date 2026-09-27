import { useEffect } from 'react'
import { AddWaypointSheet } from '@/components/AddWaypoint'
import { useGoTo } from '@/store/useGoTo'
import { useMapAction } from '@/store/useMapAction'
import { navigateTo } from '@/store/navigateTo'
import type { TabId } from '@/components/NavMenu'

/**
 * Carries out what a long press on a map — or another screen — asked for.
 *
 * Mounted once, beside the tabs, for two reasons that are really the same
 * reason: neither action can be done from inside the map.
 *
 *   - **Save as waypoint** opens the add-waypoint sheet, and that sheet
 *     contains a map. A map that imported it would be an import cycle, and a
 *     second, simpler creator alongside it would be a second place for the
 *     scope rule and the strict parser to drift.
 *   - **Navigate here** has to change the tab, and the tab is state in `App`.
 *
 * So the map states the request and this does it. "Navigate here" (a long
 * press, the waypoint sheet) and the Datum worksheet's "Take me there" (via
 * `useGoTo`) both end in `navigateTo` — one way into navigation, not three.
 */
export function MapActionHost({ onNavigate }: { onNavigate: (tab: TabId) => void }) {
  const request = useMapAction((s) => s.request)
  const clear = useMapAction((s) => s.clear)
  const handed = useGoTo((s) => s.pending)

  useEffect(() => {
    if (request?.kind !== 'navigate') return
    void navigateTo({
      lat: request.lat,
      lon: request.lon,
      // A press on the chart has no name; a waypoint asked for by name keeps
      // it, so the plotter says where the crew is going rather than "pin".
      label: request.label ?? 'Dropped pin',
    })
    onNavigate('chart')
    // Cleared here: this request is finished the moment it has been handed on.
    clear()
  }, [request, onNavigate, clear])

  // The Datum worksheet's "Take me there" — it switches tab itself; the place
  // is taken exactly once, so a re-render cannot plan the same trip twice.
  useEffect(() => {
    if (!handed) return
    const place = useGoTo.getState().take()
    if (place) void navigateTo(place)
  }, [handed])

  if (request?.kind !== 'waypoint') return null
  return (
    <AddWaypointSheet
      // Remounts on a new press, so a second press while the sheet is open
      // refills it with the new position instead of quietly keeping the old.
      key={`${request.lat},${request.lon}`}
      at={{ lat: request.lat, lon: request.lon }}
      onDismiss={clear}
    />
  )
}
