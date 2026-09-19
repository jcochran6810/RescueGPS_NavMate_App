import { useEffect, useMemo } from 'react'
import { useIncidents } from '@/store/useIncidents'
import { useTeams } from '@/store/useTeams'
import { useTracker } from '@/store/useTracker'
import {
  UNITS_REFRESH_MS,
  UNIT_STALE_MS,
  unitName,
  useIncidentShare,
} from '@/store/useIncidentShare'
import { MPS_TO_KNOTS } from '@/lib/geo'

/** A unit on this search, in the shape the map draws. */
export interface UnitMarker {
  id: string
  name: string
  lat: number
  lon: number
  /** Degrees true, or null when they are not moving enough to have one. */
  heading: number | null
  speedKn: number | null
  /** Nothing heard for a while — drawn faded rather than removed. */
  stale: boolean
  recordedAt: string
}

/**
 * Where everyone else on this search is.
 *
 * Read once per screen that draws them rather than once per map, so three maps
 * on three tabs do not become three polls. The refresh itself lives in the
 * store and is driven from `App`, which is mounted whatever tab is showing.
 *
 * A unit that has stopped reporting is **kept and faded**, not removed. A
 * marker vanishing reads as "they have left"; a marker going grey with a time
 * on it reads as "their phone has lost signal", which is the true and much
 * more common answer.
 */
export function useIncidentUnits(): UnitMarker[] {
  const units = useIncidentShare((s) => s.units)
  const now = Date.now()
  return useMemo(
    () =>
      units.map((u) => ({
        id: u.user_id,
        name: unitName(u),
        lat: Number(u.lat),
        lon: Number(u.lng),
        heading: u.heading_deg ?? null,
        speedKn: u.speed_mps != null ? u.speed_mps * MPS_TO_KNOTS : null,
        stale: now - new Date(u.recorded_at).getTime() > UNIT_STALE_MS,
        recordedAt: u.recorded_at,
      })),
    // `now` is deliberately read outside the dependency list: staleness only
    // has to be right at the next render, and every screen drawing these
    // re-renders on its own clock anyway. Keying on the millisecond would
    // rebuild every marker on every tick.
    [units],
  )
}

/**
 * Publish this boat's fixes to the search, and keep the other units current.
 *
 * Mounted once, in `App`. Two reasons it is not inside a map: a crew looking
 * at the datum worksheet is still a unit on the search and should still appear
 * on everyone else's chart, and three maps would otherwise run three polls.
 */
export function useIncidentTelemetry(): void {
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const incident = useIncidents((s) => s.activeIncident(activeTeamId))
  const fix = useTracker((s) => s.fix)
  const publish = useIncidentShare((s) => s.publish)
  const refreshUnits = useIncidentShare((s) => s.refreshUnits)
  const clearLocal = useIncidentShare((s) => s.clearLocal)
  const incidentId = incident?.id ?? null

  // Every fix is offered; the store decides how often one is actually sent.
  useEffect(() => {
    if (fix && incidentId) void publish(fix, incidentId)
  }, [fix, incidentId, publish])

  useEffect(() => {
    if (!incidentId) {
      // Off a search, there are no other units — and leaving the last lot on
      // screen would draw boats that are no longer anything to do with this
      // crew.
      clearLocal()
      return
    }
    void refreshUnits(incidentId)
    const timer = setInterval(() => void refreshUnits(incidentId), UNITS_REFRESH_MS)
    return () => clearInterval(timer)
  }, [incidentId, refreshUnits, clearLocal])
}
