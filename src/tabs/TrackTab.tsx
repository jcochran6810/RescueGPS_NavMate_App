import { useMemo, useState } from 'react'
import { useTracker } from '@/store/useTracker'
import { useWaypoints } from '@/store/useWaypoints'
import {
  haversineNM,
  bearingDeg,
  compassPoint,
  formatDistance,
  formatDuration,
  formatEtaClock,
  formatSpeed,
  MPS_TO_KNOTS,
  type DistanceUnit,
} from '@/lib/geo'
import { toDD, toDMS } from '@/lib/coords'
import { Button, Card, Input, Label, Stat } from '@/components/ui'

const UNITS: { id: DistanceUnit; label: string }[] = [
  { id: 'nm', label: 'NM' },
  { id: 'mi', label: 'mi' },
  { id: 'km', label: 'km' },
]

export function TrackTab() {
  const { fix, watching, error, start, stop } = useTracker()
  const waypoints = useWaypoints((s) => s.visible())

  const [targetId, setTargetId] = useState('')
  const [speedOverride, setSpeedOverride] = useState('')
  const [unit, setUnit] = useState<DistanceUnit>('nm')

  const target = waypoints.find((w) => w.id === targetId) ?? null

  const eta = useMemo(() => {
    if (!fix || !target) return null
    const distNM = haversineNM(fix.lat, fix.lon, target.lat, target.lon)
    const brg = bearingDeg(fix.lat, fix.lon, target.lat, target.lon)

    const manual = parseFloat(speedOverride)
    const speedKn =
      Number.isFinite(manual) && manual > 0
        ? manual
        : fix.speed != null && fix.speed > 0
          ? fix.speed * MPS_TO_KNOTS
          : Number.NaN

    const hours = Number.isFinite(speedKn) && speedKn > 0 ? distNM / speedKn : Number.NaN
    return { distNM, brg, speedKn, hours }
  }, [fix, target, speedOverride])

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Live tracker</h2>
        <p className="text-sm text-slate-400">
          Position, speed and time to a saved waypoint.
        </p>
      </div>

      {error && (
        <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Stat
          label="Latitude"
          value={fix ? toDD(fix.lat) : '—'}
          hint={fix ? toDMS(fix.lat, 'lat') : undefined}
        />
        <Stat
          label="Longitude"
          value={fix ? toDD(fix.lon) : '—'}
          hint={fix ? toDMS(fix.lon, 'lon') : undefined}
        />
        <Stat label="Speed" value={formatSpeed(fix?.speed)} />
        <Stat
          label="Heading"
          value={
            fix?.heading != null
              ? `${Math.round(fix.heading)}° ${compassPoint(fix.heading)}`
              : '—'
          }
        />
        <Stat
          label="Accuracy"
          value={fix?.accuracy != null ? `±${Math.round(fix.accuracy)} m` : '—'}
        />
        <Stat
          label="Altitude"
          value={fix?.altitude != null ? `${Math.round(fix.altitude)} m` : '—'}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="primary" onClick={start} disabled={watching}>
          {watching ? 'Tracking…' : 'Start tracking'}
        </Button>
        <Button variant="ghost" onClick={stop} disabled={!watching}>
          Stop
        </Button>
      </div>

      {fix && (
        <p className="text-center text-xs text-slate-500">
          Last fix {new Date(fix.timestamp).toLocaleTimeString()}
        </p>
      )}

      <Card>
        <Label>ETA to waypoint</Label>
        <select
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="min-h-11 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 focus:border-sky-400/60 focus:outline-none"
        >
          <option value="">— choose a saved waypoint —</option>
          {waypoints.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>

        <div className="mt-3 flex gap-1">
          {UNITS.map((u) => (
            <button
              key={u.id}
              onClick={() => setUnit(u.id)}
              className={
                'flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ' +
                (unit === u.id
                  ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                  : 'border-white/10 text-slate-400 hover:bg-white/5')
              }
            >
              {u.label}
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat
            label="Distance"
            value={eta ? formatDistance(eta.distNM, unit) : '—'}
          />
          <Stat
            label="Bearing"
            value={
              eta ? `${Math.round(eta.brg)}° ${compassPoint(eta.brg)}` : '—'
            }
          />
          <Stat
            label="ETA"
            value={
              !eta
                ? '—'
                : Number.isFinite(eta.hours)
                  ? formatDuration(eta.hours)
                  : 'need speed'
            }
            hint={
              eta && Number.isFinite(eta.hours)
                ? formatEtaClock(eta.hours) || undefined
                : undefined
            }
          />
        </div>

        <div className="mt-3">
          <Label>Manual speed override (knots)</Label>
          <Input
            value={speedOverride}
            onChange={(e) => setSpeedOverride(e.target.value)}
            placeholder="Blank uses GPS speed"
            inputMode="decimal"
          />
          {!fix && (
            <p className="mt-1.5 text-xs text-slate-500">
              Start tracking to get a position fix.
            </p>
          )}
          {fix && !target && (
            <p className="mt-1.5 text-xs text-slate-500">
              Choose a waypoint to see distance and ETA.
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}
