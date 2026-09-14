import { useEffect, useMemo } from 'react'
import { useTracker } from '@/store/useTracker'
import { useHeading } from '@/store/useHeading'
import { useWaypoints } from '@/store/useWaypoints'
import { useTeams } from '@/store/useTeams'
import { Compass } from '@/components/Compass'
import {
  bearingDeg,
  formatBearing,
  formatDistance,
  haversineNM,
  isAtPosition,
  relativeBearing,
} from '@/lib/geo'
import { magneticFromTrue } from '@/lib/geomag'
import { AddWaypointButton } from '@/components/AddWaypoint'
import { Card, EmptyState, Label } from '@/components/ui'

/**
 * The compass, with the bearing to everything saved underneath it.
 *
 * The dial answers "which way am I facing"; the table answers "which way is
 * it", which is the question that actually gets asked over a radio.
 */
export function CompassTab() {
  const { fix, watching, error, once } = useTracker()
  const waypoints = useWaypoints((s) => s.visible())
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const heading = useHeading((s) => s.heading)
  const shownReference = useHeading((s) => s.shownReference)
  const declination = useHeading((s) => s.declination)

  useEffect(() => {
    if (!fix && !watching) void once()
  }, [fix, watching, once])

  const lat = fix?.lat ?? null
  const lon = fix?.lon ?? null

  const legs = useMemo(() => {
    if (lat === null || lon === null) return []
    return waypoints
      .filter((w) => (activeTeamId ? w.team_id === activeTeamId : w.team_id === null))
      .map((w) => {
        const distanceNM = haversineNM(lat, lon, w.lat, w.lon)
        return {
          w,
          // A bearing to a point you are standing on is a metre of GPS jitter
          // swung through the whole compass, so it is not printed at all.
          bearing: isAtPosition(distanceNM)
            ? null
            : bearingDeg(lat, lon, w.lat, w.lon),
          distanceNM,
        }
      })
      .sort((a, b) => a.distanceNM - b.distanceNM)
  }, [waypoints, activeTeamId, lat, lon])

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Compass</h2>
        <p className="text-sm text-slate-300">
          Heading, and the bearing to everything you have saved.
        </p>
      </div>

      {/* Same stranding fix as the Tides tab: show why there is no fix, and
          offer the retry the empty state below tells the user to perform. */}
      {error && !fix && (
        <div className="rounded-xl bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
          <p>{error}</p>
          <button
            onClick={() => void once()}
            className="mt-1.5 rounded-lg border border-red-400/30 px-2.5 py-1 text-xs hover:bg-red-500/10"
          >
            Try again
          </button>
        </div>
      )}

      <Compass lat={lat} lon={lon} />

      <Card>
        <div className="flex items-center justify-between gap-2">
          <Label>Bearings from here</Label>
          <AddWaypointButton label="Add waypoint" compact />
        </div>
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
                <span className="min-w-0 flex-1 truncate text-sm text-slate-100">
                  {w.name}
                </span>
                {/* Which way to turn for it, when the compass is running —
                    the step every crew does in their head otherwise. */}
                {bearing !== null && heading !== null && (
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-sm text-sky-400"
                    style={{
                      transform: `rotate(${relativeBearing(
                        shownReference === 'magnetic' && declination !== null
                          ? magneticFromTrue(bearing, declination)
                          : bearing,
                        heading,
                      )}deg)`,
                    }}
                  >
                    ↑
                  </span>
                )}
                <span className="tnum shrink-0 text-sm text-slate-300">
                  {bearing === null ? 'here' : formatBearing(bearing)}
                </span>
                <span className="tnum shrink-0 text-sm text-slate-300">
                  {formatDistance(distanceNM, 'nm')}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-slate-400">
          Bearings are true, worked from the coordinates. The dial above is
          corrected to true north from the magnetic model unless you switch it
          to magnetic, and it says which it is showing.
        </p>
      </Card>
    </div>
  )
}
