import { useMemo } from 'react'
import { useWaypoints } from '@/store/useWaypoints'
import { useTeams } from '@/store/useTeams'
import {
  bearingDeg,
  formatBearing,
  formatDistance,
  haversineNM,
} from '@/lib/geo'
import { toDD } from '@/lib/coords'
import { Card, Label } from '@/components/ui'

/**
 * The handful of waypoints closest to the crew, nearest first.
 *
 * The full list lives on its own tab; what belongs on the home screen is the
 * question actually asked in the field, which is "what is near me right now".
 */
export function NearbyWaypoints({
  lat,
  lon,
  limit = 4,
  onSeeAll,
}: {
  lat: number | null
  lon: number | null
  limit?: number
  onSeeAll?: () => void
}) {
  const waypoints = useWaypoints((s) => s.visible())
  const activeTeamId = useTeams((s) => s.activeTeamId)

  // Scoped the same way as the Waypoints tab, so the header's team switcher
  // means the same thing everywhere.
  const scoped = useMemo(
    () =>
      waypoints.filter((w) =>
        activeTeamId ? w.team_id === activeTeamId : w.team_id === null,
      ),
    [waypoints, activeTeamId],
  )

  const nearest = useMemo(() => {
    // Without a fix there is no "near", so the list falls back to whatever is
    // saved rather than dropping off the screen entirely.
    if (lat === null || lon === null) {
      return scoped
        .slice(0, limit)
        .map((w) => ({ w, distanceNM: null, bearing: null }))
    }
    return scoped
      .map((w) => ({
        w,
        distanceNM: haversineNM(lat, lon, w.lat, w.lon),
        bearing: bearingDeg(lat, lon, w.lat, w.lon),
      }))
      .sort((a, b) => a.distanceNM - b.distanceNM)
      .slice(0, limit)
  }, [scoped, lat, lon, limit])

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <Label>{lat === null ? 'Waypoints' : 'Waypoints near me'}</Label>
        {onSeeAll && (
          <button
            onClick={onSeeAll}
            className="mb-1.5 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5"
          >
            See all {scoped.length > 0 ? `(${scoped.length})` : ''}
          </button>
        )}
      </div>

      {nearest.length === 0 ? (
        <p className="text-sm text-slate-400">
          Nothing saved in this scope yet. Stamp a position to start.
        </p>
      ) : (
        <ul className="divide-y divide-white/5">
          {nearest.map(({ w, distanceNM, bearing }) => (
            <li key={w.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-100">
                  {w.name}
                </div>
                <div className="tnum truncate text-xs text-slate-500">
                  {bearing !== null
                    ? formatBearing(bearing)
                    : `${toDD(w.lat)}, ${toDD(w.lon)}`}
                  {w.photos.length > 0 &&
                    ` · ${w.photos.length} photo${w.photos.length === 1 ? '' : 's'}`}
                </div>
              </div>
              {distanceNM !== null && (
                <span className="tnum shrink-0 text-sm text-slate-300">
                  {formatDistance(distanceNM, 'nm')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
