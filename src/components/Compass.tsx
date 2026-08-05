import { useEffect, useMemo, useState } from 'react'
import { useHeading } from '@/store/useHeading'
import { useTracker } from '@/store/useTracker'
import { useTeams } from '@/store/useTeams'
import { useWaypoints } from '@/store/useWaypoints'
import {
  bearingDeg,
  compassPoint,
  formatBearing,
  formatDistance,
  haversineNM,
  relativeBearing,
  MPS_TO_KNOTS,
} from '@/lib/geo'
import { Button, Card, Label } from '@/components/ui'

const TICKS = [
  { deg: 0, label: 'N' },
  { deg: 45, label: '' },
  { deg: 90, label: 'E' },
  { deg: 135, label: '' },
  { deg: 180, label: 'S' },
  { deg: 225, label: '' },
  { deg: 270, label: 'W' },
  { deg: 315, label: '' },
]

/**
 * A compass rose that turns under a fixed lubber line, plus an optional
 * pointer to a saved waypoint.
 *
 * The card rotates the *dial* rather than a needle, which is how a real
 * hand-bearing compass reads: whatever is at the top of the screen is the way
 * the phone is pointing.
 */
export function Compass({
  lat,
  lon,
}: {
  lat: number | null
  lon: number | null
}) {
  const { heading, permission, listening, magnetic, enable, disable } = useHeading()
  const fix = useTracker((s) => s.fix)
  const all = useWaypoints((s) => s.visible())
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const [targetId, setTargetId] = useState('')

  // Same scope as the bearings table below and the rest of the app — the
  // picker offering a waypoint the table has filtered out reads as a bug.
  const waypoints = useMemo(
    () =>
      all.filter((w) =>
        activeTeamId ? w.team_id === activeTeamId : w.team_id === null,
      ),
    [all, activeTeamId],
  )

  // Stop the sensor when the card goes away — a magnetometer left running is a
  // meaningful drain on a shift-long battery.
  useEffect(() => () => disable(), [disable])

  const gpsCourse =
    fix?.heading != null && fix.speed != null && fix.speed * MPS_TO_KNOTS > 1
      ? fix.heading
      : null

  // The magnetometer wins when it is running: it works standing still, which
  // GPS course does not.
  const shown = heading ?? gpsCourse
  const source = heading !== null ? 'compass' : gpsCourse !== null ? 'gps' : null

  const target = waypoints.find((w) => w.id === targetId) ?? null
  const leg = useMemo(() => {
    if (!target || lat === null || lon === null) return null
    return {
      bearing: bearingDeg(lat, lon, target.lat, target.lon),
      distanceNM: haversineNM(lat, lon, target.lat, target.lon),
    }
  }, [target, lat, lon])

  return (
    <Card>
      <Label>Compass</Label>

      <div className="flex items-center gap-4">
        <Dial heading={shown} targetBearing={leg?.bearing ?? null} />

        <div className="min-w-0 flex-1">
          <div className="tnum text-3xl font-semibold text-slate-50">
            {shown === null ? '—' : `${Math.round(shown)}°`}
          </div>
          <div className="text-sm text-slate-400">
            {shown === null ? 'No heading' : compassPoint(shown)}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {source === 'compass'
              ? magnetic
                ? 'Device compass — magnetic north'
                : 'Device compass'
              : source === 'gps'
                ? 'GPS course over ground — true north'
                : listening
                  ? 'Waiting for a reading…'
                  : 'Off'}
          </div>
        </div>
      </div>

      {!listening && (
        <Button variant="ghost" className="mt-3 w-full" onClick={() => void enable()}>
          Start compass
        </Button>
      )}
      {listening && (
        <Button variant="ghost" className="mt-3 w-full" onClick={disable}>
          Stop compass
        </Button>
      )}

      {permission === 'denied' && (
        <p className="mt-2 text-xs text-amber-300">
          Motion and orientation access was refused. Allow it in your browser
          settings, or move at over 1 knot to read a GPS course instead.
        </p>
      )}
      {permission === 'unsupported' && (
        <p className="mt-2 text-xs text-amber-300">
          This device has no orientation sensor. Heading falls back to GPS
          course, which needs you to be moving.
        </p>
      )}
      {source === 'compass' && magnetic && (
        <p className="mt-2 text-xs text-slate-500">
          Readings are magnetic. Apply your local declination before passing a
          bearing to anyone working from a chart.
        </p>
      )}

      {waypoints.length > 0 && (
        <div className="mt-3">
          <Label>Point to a waypoint</Label>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="min-h-11 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 focus:border-sky-400/60 focus:outline-none"
          >
            <option value="">— none —</option>
            {waypoints.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {leg && (
            <p className="tnum mt-2 text-sm text-slate-300">
              {formatBearing(leg.bearing)} · {formatDistance(leg.distanceNM, 'nm')}
              {shown !== null && (
                <span className="text-slate-500">
                  {' '}
                  · {describeTurn(leg.bearing, shown)}
                </span>
              )}
            </p>
          )}
          {target && lat === null && (
            <p className="mt-2 text-xs text-slate-500">
              Take a fix to get a bearing to it.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}

/** "turn 40° right" / "dead ahead", from a bearing and the current heading. */
function describeTurn(bearing: number, heading: number): string {
  const rel = relativeBearing(bearing, heading)
  if (!Number.isFinite(rel)) return ''
  if (Math.abs(rel) < 5) return 'dead ahead'
  return `turn ${Math.round(Math.abs(rel))}° ${rel > 0 ? 'right' : 'left'}`
}

function Dial({
  heading,
  targetBearing,
}: {
  heading: number | null
  targetBearing: number | null
}) {
  // With no heading the rose sits north-up, which is at least honest — the
  // lubber line then means "north", not "where you are pointing".
  const rotation = heading === null ? 0 : -heading

  return (
    <svg
      viewBox="-60 -60 120 120"
      className="size-28 shrink-0"
      role="img"
      aria-label={
        heading === null ? 'Compass, no heading' : `Heading ${Math.round(heading)} degrees`
      }
    >
      <circle r="52" className="fill-navy-950/60 stroke-white/10" strokeWidth="2" />

      <g
        transform={`rotate(${rotation})`}
        style={{ transition: 'transform 200ms linear' }}
      >
        {TICKS.map((t) => (
          <g key={t.deg} transform={`rotate(${t.deg})`}>
            <line
              x1="0"
              y1="-52"
              x2="0"
              y2={t.label ? '-42' : '-47'}
              className={t.label === 'N' ? 'stroke-red-400' : 'stroke-slate-500'}
              strokeWidth="2"
            />
            {t.label && (
              <text
                y="-30"
                // Undo the tick's rotation about the letter's own centre, so
                // E and W read the right way up instead of lying on their side.
                transform={`rotate(${-t.deg} 0 -30)`}
                textAnchor="middle"
                dominantBaseline="middle"
                className={
                  'text-[13px] font-semibold ' +
                  (t.label === 'N' ? 'fill-red-400' : 'fill-slate-400')
                }
              >
                {t.label}
              </text>
            )}
          </g>
        ))}

        {targetBearing !== null && (
          <g transform={`rotate(${targetBearing})`}>
            <polygon points="0,-38 -6,-24 6,-24" className="fill-sky-400" />
          </g>
        )}
      </g>

      {/* Lubber line — the direction the device itself is pointing. */}
      <polygon points="0,-56 -5,-46 5,-46" className="fill-amber-300" />
    </svg>
  )
}
