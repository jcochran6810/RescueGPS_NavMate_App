import { useEffect } from 'react'
import { AddWaypointSheet } from '@/components/AddWaypoint'
import { useGoTo } from '@/store/useGoTo'
import { useMapAction } from '@/store/useMapAction'
import type { TabId } from '@/components/NavMenu'

/**
 * Carries out what a long press on a map asked for.
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
 * So the map states the request and this does it. The position goes to the
 * chart plotter through `useGoTo`, the same seam the Datum worksheet's "Take
 * me there" uses — one route into the plotter, not two.
 */
export function MapActionHost({ onNavigate }: { onNavigate: (tab: TabId) => void }) {
  const request = useMapAction((s) => s.request)
  const clear = useMapAction((s) => s.clear)
  const goTo = useGoTo((s) => s.goTo)

  useEffect(() => {
    if (request?.kind !== 'navigate') return
    goTo({ lat: request.lat, lon: request.lon, label: 'Dropped pin' })
    onNavigate('chart')
    // Cleared here rather than by the plotter: this request is finished the
    // moment it has been handed on, and `useGoTo` has its own consumed-once
    // rule at the other end.
    clear()
  }, [request, goTo, onNavigate, clear])

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
