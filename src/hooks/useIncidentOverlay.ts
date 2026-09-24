import { useMemo } from 'react'
import { buildIncidentLayer, type MapIncidentLayer } from '@/lib/command'
import {
  useFieldIdentity,
  useIncidentAssignments,
  useIncidentHazards,
  useIncidentSearchPicture,
} from '@/hooks/useIncidentFeeds'
import { useNow } from '@/hooks/useNow'

/**
 * The command picture for the maps: search segments (this crew's bright,
 * everyone else's dimmed), search areas, active hazards and the incident's
 * current LKP. Null off an incident, so a map draws nothing extra.
 */
export function useIncidentOverlay(): MapIncidentLayer | null {
  const { incidentId, userId, unitId } = useFieldIdentity()
  const assignments = useIncidentAssignments(incidentId)
  const hazards = useIncidentHazards(incidentId)
  const { areas, lkp } = useIncidentSearchPicture(incidentId)
  // A minute's resolution is plenty to drop an expired hazard.
  const now = useNow(60_000)
  const minute = Math.floor(now.getTime() / 60_000)
  return useMemo(
    () =>
      incidentId
        ? buildIncidentLayer({
            assignments,
            areas,
            hazards,
            lkp,
            userId,
            unitId,
            nowMs: minute * 60_000,
          })
        : null,
    [incidentId, assignments, areas, hazards, lkp, userId, unitId, minute],
  )
}
