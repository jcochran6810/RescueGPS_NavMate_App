import { useEffect } from 'react'
import { useTracker } from '@/store/useTracker'
import { toDD, toDDM, toDMS } from '@/lib/coords'
import { formatSpeed } from '@/lib/geo'
import { DaylightTracker } from '@/components/DaylightTracker'
import { NearbyWaypoints } from '@/components/NearbyWaypoints'
import { Card, Label } from '@/components/ui'
import type { TabId } from '@/components/NavMenu'

/**
 * The screen the app opens on: where you are, what the light and the water are
 * doing, which way you are pointing, and what you have saved nearby.
 *
 * Everything here is derived from one position fix, so the fix is taken once
 * on arrival rather than making the crew press something before the screen
 * says anything useful.
 */
export function HomeTab({ onNavigate }: { onNavigate: (tab: TabId) => void }) {
  const { fix, watching, error, once } = useTracker()

  useEffect(() => {
    if (!fix && !watching) void once()
  }, [fix, watching, once])

  const lat = fix?.lat ?? null
  const lon = fix?.lon ?? null

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <Card>
        <div className="flex items-start justify-between gap-2">
          <Label>Current position</Label>
          <button
            onClick={() => void once()}
            className="mb-1.5 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5"
          >
            Refresh
          </button>
        </div>

        {fix ? (
          <div className="tnum space-y-0.5 text-sm text-slate-200">
            <div>
              <span className="text-slate-500">DDM </span>
              {toDDM(fix.lat, 'lat')}, {toDDM(fix.lon, 'lon')}
            </div>
            <div>
              <span className="text-slate-500">DMS </span>
              {toDMS(fix.lat, 'lat')}, {toDMS(fix.lon, 'lon')}
            </div>
            <div>
              <span className="text-slate-500">DD </span>
              {toDD(fix.lat)}, {toDD(fix.lon)}
            </div>
            <div className="text-slate-400">
              {fix.altitude != null ? `Altitude ${Math.round(fix.altitude)} m` : 'Altitude —'}
              {' | '}
              Speed {formatSpeed(fix.speed)}
              {fix.accuracy != null ? ` | ±${Math.round(fix.accuracy)} m` : ''}
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-400">
            Waiting for a GPS fix…
          </p>
        )}
      </Card>

      <DaylightTracker lat={lat} lon={lon} />

      <NearbyWaypoints
        lat={lat}
        lon={lon}
        onSeeAll={() => onNavigate('waypoints')}
      />
    </div>
  )
}
