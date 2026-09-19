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

      <Compass lat={lat} lon={lon} />

      <CompassMap
        lat={lat}
        lon={lon}
        heading={trueHeading ?? fix?.heading ?? null}
        markers={markers}
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
 * The ground under the dial, turned to face the way the crew is.
 *
 * A compass says which way you are pointing; this says what is that way. The
 * two together are what a hand-bearing compass and a chart do on a table, and
 * the reason the map has to turn is that nobody can hold a chart at a bearing
 * and read it at the same time.
 *
 * **It is off until asked for.** Imagery is the most expensive thing this app
 * fetches and the compass is useful without it — a crew out of coverage with
 * a dead link still has a dial. So the map is a button, and the button says
 * what it is about to do.
 *
 * **Head-up is the default, and north-up is one tap away.** A turned map is
 * what the request was for, but a chart read against a printed one has to be
 * north-up or the two disagree, so both are offered and the north arrow says
 * which is which.
 */
function CompassMap({
  lat,
  lon,
  heading,
  markers,
}: {
  lat: number | null
  lon: number | null
  heading: number | null
  markers: { id: string; name: string; lat: number; lon: number; waypointId: string }[]
}) {
  const [show, setShow] = useState(false)
  const [base, setBase] = useState<MapBase>('satellite')
  const [headUp, setHeadUp] = useState(true)
  const fix = useTracker((s) => s.fix)

  if (!show) {
    return (
      <Button variant="ghost" className="w-full" onClick={() => setShow(true)}>
        Show the map under the compass
      </Button>
    )
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <Label>Map</Label>
        <button
          onClick={() => setShow(false)}
          className="mb-1.5 flex min-h-9 items-center rounded-lg border border-white/10 px-2.5 text-xs text-slate-300 hover:bg-white/5"
        >
          Hide map
        </button>
      </div>

      <div className="mb-2 space-y-1.5">
        <Segmented
          label="Map layer"
          value={base}
          options={[
            { id: 'satellite' as MapBase, label: 'Satellite', hint: 'Aerial imagery' },
            { id: 'hybrid' as MapBase, label: 'Hybrid', hint: 'The chart blended over the imagery' },
            { id: 'chart' as MapBase, label: 'Chart', hint: 'The NOAA chart alone' },
          ]}
          onChange={setBase}
        />
        <Segmented
          label="Map orientation"
          value={headUp ? 'head' : 'north'}
          options={[
            { id: 'head', label: 'Head up', hint: 'The map turns with you' },
            { id: 'north', label: 'North up', hint: 'The map stays put, like a printed chart' },
          ]}
          onChange={(v) => setHeadUp(v === 'head')}
        />
      </div>

      <SatelliteMap
        trail={[]}
        fix={fix}
        markers={markers}
        base={base}
        height={300}
        // Head-up needs a heading to be head-up *to*. Without one the map
        // stays north-up rather than freezing at whatever the last reading
        // was, which would be a map claiming a direction it does not have.
        rotationDeg={headUp && heading !== null ? heading : 0}
        rangeRings
        forwardDeg={heading}
      />

      <p className="mt-1.5 text-xs text-slate-400">
        {headUp
          ? heading === null
            ? 'Waiting for a heading — the map stays north up until there is one.'
            : 'The map is turned to your heading, so straight up the screen is straight ahead. The rings are distance from you.'
          : 'North is up, as on a printed chart. The dashed line is the way you are facing.'}
        {lat === null || lon === null
          ? ' Take a position fix and the map will open where you are.'
          : ''}
      </p>
    </Card>
  )
}
