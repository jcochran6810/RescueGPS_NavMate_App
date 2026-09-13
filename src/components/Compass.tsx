import { useEffect, useMemo, useState } from 'react'
import { useHeading, type HeadingReference } from '@/store/useHeading'
import { useTracker } from '@/store/useTracker'
import { useTeams } from '@/store/useTeams'
import { useWaypoints } from '@/store/useWaypoints'
import { CompassRose, type RoseMarker } from '@/components/CompassRose'
import {
  bearingDeg,
  compassPoint,
  formatBearing,
  formatDistance,
  haversineNM,
  isAtPosition,
  MPS_TO_KNOTS,
} from '@/lib/geo'
import { describeTurn, normalizeDeg } from '@/lib/heading'
import { formatDeclination, magneticFromTrue, WMM_NAME } from '@/lib/geomag'
import { Button, Card, Label } from '@/components/ui'

/**
 * The compass card: a rose, what it is referenced to, how far to trust it, and
 * what is worth pointing at.
 *
 * The ordering is deliberate. Every number on this card is worthless if the
 * reading behind it is bad, so the things that say whether it is bad — the
 * reference, the calibration, the tilt — sit with the dial rather than in a
 * footnote under everything else.
 */

/** Below this there is no course to speak of, only GPS noise. */
const COURSE_MIN_KN = 1

export function Compass({
  lat,
  lon,
}: {
  lat: number | null
  lon: number | null
}) {
  const {
    heading: sensorHeading,
    shownReference,
    reference,
    declination,
    declinationStale,
    calibration,
    accuracyDeg,
    tilt,
    level,
    mode,
    permission,
    listening,
    silent,
    enable,
    disable,
    setReference,
    setPosition,
  } = useHeading()
  const fix = useTracker((s) => s.fix)
  const all = useWaypoints((s) => s.visible())
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const [targetId, setTargetId] = useState('')
  const [sights, setSights] = useState<{ deg: number; ref: string; at: number }[]>([])

  // Same scope as the bearings table below and the rest of the app — the
  // picker offering a waypoint the table has filtered out reads as a bug.
  const waypoints = useMemo(
    () =>
      all.filter((w) =>
        activeTeamId ? w.team_id === activeTeamId : w.team_id === null,
      ),
    [all, activeTeamId],
  )

  // Declination is a function of where you are, so the model needs the fix.
  // The store ignores a move too small to matter, so this can fire freely.
  useEffect(() => {
    if (lat !== null && lon !== null) setPosition(lat, lon, fix?.altitude ?? 0)
  }, [lat, lon, fix?.altitude, setPosition])

  // Stop the sensor when the card goes away — a magnetometer left running is a
  // meaningful drain on a shift-long battery.
  useEffect(() => () => disable(), [disable])

  const speedKn = fix?.speed != null ? fix.speed * MPS_TO_KNOTS : null
  const gpsCourse =
    fix?.heading != null && speedKn != null && speedKn > COURSE_MIN_KN
      ? fix.heading
      : null

  /*
   * The magnetometer wins when it is running: it works standing still, which
   * course over ground does not. When it falls back, the dial is showing a true
   * bearing whatever the crew asked for, because course over ground is worked
   * from positions and has no magnetic version.
   */
  const usingSensor = sensorHeading !== null
  const shown = usingSensor ? sensorHeading : gpsCourse
  const dialReference: HeadingReference = usingSensor ? shownReference : 'true'

  /** A true bearing, put into whatever the dial is showing. */
  const toDial = (trueDeg: number): number =>
    dialReference === 'magnetic' && declination !== null
      ? magneticFromTrue(trueDeg, declination)
      : trueDeg

  const target = waypoints.find((w) => w.id === targetId) ?? null
  const leg = useMemo(() => {
    if (!target || lat === null || lon === null) return null
    const distanceNM = haversineNM(lat, lon, target.lat, target.lon)
    // Standing on it, the bearing is a metre of GPS jitter pointed at random.
    if (isAtPosition(distanceNM)) return { bearing: null, distanceNM }
    return { bearing: bearingDeg(lat, lon, target.lat, target.lon), distanceNM }
  }, [target, lat, lon])

  const markers: RoseMarker[] = []
  if (leg?.bearing != null) markers.push({ deg: toDial(leg.bearing), kind: 'target' })
  // Course over ground next to heading is the crab angle — how far the boat is
  // being set off the way it is pointed. On a search leg that difference is
  // the current, and it is worth seeing rather than deducing.
  if (gpsCourse !== null && usingSensor) {
    markers.push({ deg: toDial(gpsCourse), kind: 'course' })
  }

  const badTilt = usingSensor && tilt != null && tilt > 30
  const degraded = calibration === 'poor' || badTilt

  const caption = shown === null
    ? 'No heading'
    : `${compassPoint(shown)} · ${dialReference === 'true' ? 'True' : 'Magnetic'}`

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <Label>Compass</Label>
        <ReferenceToggle
          value={reference}
          onChange={setReference}
          disabled={declination === null}
        />
      </div>

      <CompassRose
        heading={shown}
        markers={markers}
        level={usingSensor ? level : null}
        tilt={usingSensor ? tilt : null}
        caption={caption}
        degraded={degraded}
      />

      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Stat label="Source">
          {usingSensor
            ? mode === 'upright'
              ? 'Held up'
              : 'Held flat'
            : gpsCourse !== null
              ? 'GPS course'
              : listening
                ? 'Waiting…'
                : 'Off'}
        </Stat>
        <Stat label="Variation">
          {declination === null ? '—' : formatDeclination(declination)}
        </Stat>
        <Stat label="Steadiness">
          <span
            className={
              calibration === 'poor'
                ? 'text-red-300'
                : calibration === 'fair'
                  ? 'text-amber-300'
                  : calibration === 'good'
                    ? 'text-emerald-300'
                    : ''
            }
          >
            {!usingSensor
              ? '—'
              : calibration === 'unknown'
                ? 'Checking'
                : calibration === 'good'
                  ? accuracyDeg != null && accuracyDeg >= 0
                    ? `±${Math.round(accuracyDeg)}°`
                    : 'Good'
                  : calibration === 'fair'
                    ? 'Fair'
                    : 'Poor'}
          </span>
        </Stat>
      </dl>

      {shown !== null && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="default"
            className="flex-1"
            onClick={() =>
              setSights((s) =>
                [
                  {
                    deg: normalizeDeg(shown),
                    ref: dialReference === 'true' ? 'T' : 'M',
                    at: Date.now(),
                  },
                  ...s,
                ].slice(0, 4),
              )
            }
          >
            Take a bearing
          </Button>
          {sights.length > 0 && (
            <Button variant="ghost" onClick={() => setSights([])}>
              Clear
            </Button>
          )}
        </div>
      )}

      {sights.length > 0 && (
        <ul className="mt-2 space-y-1">
          {sights.map((s) => (
            <li
              key={s.at}
              className="tnum flex items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 text-sm text-slate-100"
            >
              <span>
                {Math.round(s.deg)}° {s.ref} · {compassPoint(s.deg)}
              </span>
              <span className="text-xs text-slate-400">
                {new Date(s.at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!listening ? (
        <Button variant="primary" className="mt-3 w-full" onClick={() => void enable()}>
          Start compass
        </Button>
      ) : (
        <Button variant="ghost" className="mt-3 w-full" onClick={disable}>
          Stop compass
        </Button>
      )}

      {calibration === 'poor' && (
        <Note tone="warn">
          The reading is wandering. Move the phone in a figure of eight a few
          times, and keep it clear of the radio, the engine and anything steel —
          a magnetometer beside metal is wrong by tens of degrees and gives no
          other sign of it.
        </Note>
      )}
      {badTilt && calibration !== 'poor' && (
        <Note tone="warn">
          Held {Math.round(tilt!)}° off level. Bring the bubble to the middle —
          {mode === 'upright' ? ' hold it upright' : ' lay it flat'} — before
          reading a bearing off it.
        </Note>
      )}
      {listening && silent && (
        <Note tone="warn">
          No compass readings are arriving. This device may have no
          magnetometer; heading falls back to GPS course, which needs you to be
          moving.
        </Note>
      )}
      {permission === 'denied' && (
        <Note tone="warn">
          Motion and orientation access was refused. Allow it in your browser
          settings, or move at over {COURSE_MIN_KN} knot to read a GPS course
          instead.
        </Note>
      )}
      {permission === 'unsupported' && (
        <Note tone="warn">
          This device has no orientation sensor. Heading falls back to GPS
          course, which needs you to be moving.
        </Note>
      )}
      {declinationStale && (
        <Note tone="warn">
          The magnetic model ({WMM_NAME}) is past its valid window, so the
          variation above is an extrapolation. It wants replacing with the
          current one.
        </Note>
      )}
      {declination === null && (
        <Note tone="quiet">
          Take a position fix and the dial can be corrected to true north.
          Without one it can only show magnetic.
        </Note>
      )}
      {!usingSensor && gpsCourse !== null && (
        <Note tone="quiet">
          Showing course over ground — where the boat is going, not where the
          phone is pointed. Start the compass for a heading that works standing
          still.
        </Note>
      )}

      {waypoints.length > 0 && (
        <div className="mt-4">
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
              {leg.bearing === null
                ? 'You are on it'
                : formatBearing(leg.bearing)}{' '}
              · {formatDistance(leg.distanceNM, 'nm')}
              {leg.bearing !== null && shown !== null && (
                <span className="text-slate-400">
                  {' '}
                  · {describeTurn(toDial(leg.bearing), shown)}
                </span>
              )}
            </p>
          )}
          {target && lat === null && (
            <p className="mt-2 text-xs text-slate-400">
              Take a fix to get a bearing to it.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}

function ReferenceToggle({
  value,
  onChange,
  disabled,
}: {
  value: HeadingReference
  onChange: (r: HeadingReference) => void
  disabled: boolean
}) {
  return (
    <div
      role="group"
      aria-label="North reference"
      className="flex shrink-0 rounded-lg border border-white/10 p-0.5"
    >
      {(['true', 'magnetic'] as const).map((r) => (
        <button
          key={r}
          type="button"
          disabled={disabled && r === 'true'}
          aria-pressed={value === r}
          onClick={() => onChange(r)}
          className={
            'min-h-8 rounded-md px-2.5 text-xs font-semibold transition-colors ' +
            'disabled:cursor-not-allowed disabled:opacity-40 ' +
            (value === r
              ? 'bg-sky-500 text-navy-950'
              : 'text-slate-300 hover:bg-white/5')
          }
        >
          {r === 'true' ? 'True' : 'Mag'}
        </button>
      ))}
    </div>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-white/5 px-2 py-2">
      <dt className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
        {label}
      </dt>
      <dd className="tnum mt-0.5 truncate text-sm text-slate-100">{children}</dd>
    </div>
  )
}

function Note({
  tone,
  children,
}: {
  tone: 'warn' | 'quiet'
  children: React.ReactNode
}) {
  return (
    <p
      className={
        'mt-2 text-xs ' + (tone === 'warn' ? 'text-amber-300' : 'text-slate-400')
      }
    >
      {children}
    </p>
  )
}
