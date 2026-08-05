import { useEffect, useMemo } from 'react'
import { useTracker } from '@/store/useTracker'
import { useWaypoints } from '@/store/useWaypoints'
import { useTeams } from '@/store/useTeams'
import { Compass } from '@/components/Compass'
import {
  bearingDeg,
  formatBearing,
  formatDistance,
  haversineNM,
} from '@/lib/geo'
import { Card, EmptyState, Label } from '@/components/ui'

/**
 * The compass, with the bearing to everything saved underneath it.
 *
 * The dial answers "which way am I facing"; the table answers "which way is
 * it", which is the question that actually gets asked over a radio.
 */
export function CompassTab() {
  const { fix, watching, once } = useTracker()
  const waypoints = useWaypoints((s) => s.visible())
  const activeTeamId = useTeams((s) => s.activeTeamId)

  useEffect(() => {
    if (!fix && !watching) void once()
  }, [fix, watching, once])

  const lat = fix?.lat ?? null
  const lon = fix?.lon ?? null

  const legs = useMemo(() => {
    if (lat === null || lon === null) return []
    return waypoints
      .filter((w) => (activeTeamId ? w.team_id === activeTeamId : w.team_id === null))
      .map((w) => ({
        w,
        bearing: bearingDeg(lat, lon, w.lat, w.lon),
        distanceNM: haversineNM(lat, lon, w.lat, w.lon),
      }))
      .sort((a, b) => a.distanceNM - b.distanceNM)
  }, [waypoints, activeTeamId, lat, lon])

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Compass</h2>
        <p className="text-sm text-slate-400">
          Heading, and the bearing to everything you have saved.
        </p>
      </div>

      <Compass lat={lat} lon={lon} />

      <Card>
        <Label>Bearings from here</Label>
        {legs.length === 0 ? (
          <EmptyState>
            {lat === null
              ? 'Take a position fix to work out bearings.'
              : 'No waypoints saved in this scope yet.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-white/5">
            {legs.map(({ w, bearing, distanceNM }) => (
              <li
                key={w.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="min-w-0 truncate text-sm text-slate-100">
                  {w.name}
                </span>
                <span className="tnum shrink-0 text-sm text-slate-400">
                  {formatBearing(bearing)}
                </span>
                <span className="tnum shrink-0 text-sm text-slate-300">
                  {formatDistance(distanceNM, 'nm')}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Bearings are true, worked from the coordinates. The dial above may be
          magnetic depending on the device — it says which.
        </p>
      </Card>
    </div>
  )
}
