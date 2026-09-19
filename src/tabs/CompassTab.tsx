import { useEffect, useMemo } from 'react'
import { useFormat } from '@/hooks/useFormat'
import { useTracker } from '@/store/useTracker'
import { useHeading } from '@/store/useHeading'
import { useWaypoints } from '@/store/useWaypoints'
import { useWaypointView } from '@/store/useWaypointView'
import { useTeams } from '@/store/useTeams'
import { Compass } from '@/components/Compass'
import {
  bearingDeg,
  formatBearing,
  haversineNM,
  isAtPosition,
  relativeBearing,
} from '@/lib/geo'
import { magneticFromTrue } from '@/lib/geomag'
import { AddWaypointButton } from '@/components/AddWaypoint'
import { SatelliteMap, type MapBase } from '@/components/SatelliteMap'
import { Button, Card, EmptyState, Label, Segmented } from '@/components/ui'
import { useState } from 'react'

/**
 * The compass, with the bearing to everything saved underneath it.
 *
 * The dial answers "which way am I facing"; the table answers "which way is
 * it", which is the question that actually gets asked over a radio.
 */
export function CompassTab() {
  const { fix, watching, error, once } = useTracker()
  const fmt = useFormat()
  const openWaypoint = useWaypointView((s) => s.open)
  const waypoints = useWaypoints((s) => s.visible())
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const heading = useHeading((s) => s.heading)
  /*
   * The map turns by the **true** heading, never the one on the dial.
   *
   * The dial can be showing magnetic if the crew asked for it, and the ground
   * under the map is laid out from coordinates — true. Turning a true map by
   * a magnetic heading would leave it wrong by the declination, which on
   * either US coast is 10–20°: the exact error the compass work went to
   * trouble to remove. Course over ground stands in when there is no
   * magnetometer, because that is true as well.
   */
  const trueHeading = useHeading((s) => s.trueHeading)
  const shownReference = useHeading((s) => s.shownReference)
  const declination = useHeading((s) => s.declination)

  useEffect(() => {
    if (!fix && !watching) void once()
  }, [fix, watching, once])

  const lat = fix?.lat ?? null
  const lon = fix?.lon ?? null

  const [showMap, setShowMap] = useState(false)
  const [base, setBase] = useState<MapBase>('satellite')
  const [headUp, setHeadUp] = useState(true)
  /*
   * The map turns by the true heading and falls back to course over ground,
   * which is true as well. The dial above it may be showing magnetic if the
   * crew asked for that — and the two disagree by the declination, which is
   * not a fault: a paper chart prints a magnetic rose inside a true one for
   * exactly this reason. What matters is that the top of both is ahead.
   */
  const mapHeading = trueHeading ?? fix?.heading ?? null

  /** The saved waypoints, for the map under the dial. */
  const markers = useMemo(
    () =>
      waypoints
        .filter((w) => (activeTeamId ? w.team_id === activeTeamId : w.team_id === null))
        .map((w) => ({
          id: w.id,
          name: w.name,
          lat: w.lat,
          lon: w.lon,
          waypointId: w.id,
        })),
    [waypoints, activeTeamId],
  )

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
            className="mt-1.5 min-h-9 rounded-lg border border-red-400/30 px-2.5 text-xs hover:bg-red-500/10"
          >
            Try again
          </button>
        </div>
      )}

      <CompassMapControls
        show={showMap}
        onShow={setShowMap}
        base={base}
        onBase={setBase}
        headUp={headUp}
        onHeadUp={setHeadUp}
        heading={mapHeading}
      />

      <Compass
        lat={lat}
        lon={lon}
        behind={
          showMap
            ? (rose) => (
            <SatelliteMap
              trail={[]}
              fix={fix}
              markers={markers}
              base={base}
              height={340}
              // Head-up needs a heading to be head-up *to*. Without one the
              // map stays north-up rather than freezing at the last reading,
              // which would be a map claiming a direction it does not have.
              rotationDeg={headUp && mapHeading !== null ? mapHeading : 0}
              rangeRings
              forwardDeg={mapHeading}
              overlay={rose}
            />
              )
            : undefined
        }
      />

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
              <li key={w.id}>
                {/* The row opens the waypoint. A crew reading a bearing to
                    something is one step from wanting to be taken to it. */}
                <button
                  type="button"
                  onClick={() => openWaypoint(w.id)}
                  className="flex w-full items-center justify-between gap-3 py-2 text-left hover:bg-white/5"
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
                  {fmt.length(distanceNM)}
                </span>
                </button>
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

/**
 * The controls for the map behind the dial.
 *
 * Above the compass rather than below it, because they are about what the
 * crew is looking *at* — and off by default: imagery is the most expensive
 * thing this app fetches, and a crew out of coverage still has a dial.
 */
function CompassMapControls({
  show,
  onShow,
  base,
  onBase,
  headUp,
  onHeadUp,
  heading,
}: {
  show: boolean
  onShow: (v: boolean) => void
  base: MapBase
  onBase: (b: MapBase) => void
  headUp: boolean
  onHeadUp: (v: boolean) => void
  heading: number | null
}) {
  if (!show) {
    return (
      <Button variant="ghost" className="w-full" onClick={() => onShow(true)}>
        Show the map under the compass
      </Button>
    )
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <Label>Map under the dial</Label>
        <button
          onClick={() => onShow(false)}
          className="mb-1.5 flex min-h-9 items-center rounded-lg border border-white/10 px-2.5 text-xs text-slate-300 hover:bg-white/5"
        >
          Hide map
        </button>
      </div>

      <div className="space-y-1.5">
        <Segmented
          label="Map layer"
          value={base}
          options={[
            { id: 'satellite' as MapBase, label: 'Satellite', hint: 'Aerial imagery' },
            { id: 'hybrid' as MapBase, label: 'Hybrid', hint: 'The chart blended over the imagery' },
            { id: 'chart' as MapBase, label: 'Chart', hint: 'The NOAA chart alone' },
          ]}
          onChange={onBase}
        />
        <Segmented
          label="Map orientation"
          value={headUp ? 'head' : 'north'}
          options={[
            { id: 'head', label: 'Head up', hint: 'The ground turns with you' },
            { id: 'north', label: 'North up', hint: 'The ground stays put, like a printed chart' },
          ]}
          onChange={(v) => onHeadUp(v === 'head')}
        />
      </div>

      <p className="mt-1.5 text-xs text-slate-400">
        {headUp
          ? heading === null
            ? 'Waiting for a heading — the ground stays north up until there is one.'
            : 'The ground is turned to your heading, so straight up the dial is straight ahead. The rings are distance from you.'
          : 'North is up, as on a printed chart. The dashed line is the way you are facing.'}
      </p>
    </Card>
  )
}
