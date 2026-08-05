import { useMemo, useState } from 'react'
import { useTracker, INTERVAL_CHOICES } from '@/store/useTracker'
import { useWaypoints } from '@/store/useWaypoints'
import { TrackPath } from '@/components/TrackPath'
import {
  compassPoint,
  formatDistance,
  formatDuration,
  formatSpeed,
  trailDistanceNM,
  type DistanceUnit,
} from '@/lib/geo'
import { toDD, toDMS } from '@/lib/coords'
import { download, trackToGPX } from '@/lib/transfer'
import { toast } from '@/store/useToast'
import { Button, Card, Label, Stat } from '@/components/ui'

const UNITS: { id: DistanceUnit; label: string }[] = [
  { id: 'nm', label: 'NM' },
  { id: 'mi', label: 'mi' },
  { id: 'km', label: 'km' },
]

export function TrackTab() {
  const {
    fix,
    watching,
    error,
    trail,
    intervalS,
    start,
    stop,
    clearTrail,
    setIntervalS,
  } = useTracker()
  const waypoints = useWaypoints((s) => s.visible())

  const [unit, setUnit] = useState<DistanceUnit>('nm')

  const travelled = useMemo(() => trailDistanceNM(trail), [trail])
  const elapsedH =
    trail.length > 1
      ? (trail[trail.length - 1].timestamp - trail[0].timestamp) / 3600_000
      : 0

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Live tracker</h2>
        <p className="text-sm text-slate-400">
          Live position, and the path you have covered.
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
        <Label>Your path</Label>
        <TrackPath
          trail={trail}
          markers={waypoints.map((w) => ({
            id: w.id,
            name: w.name,
            lat: w.lat,
            lon: w.lon,
          }))}
        />
        <p className="mt-1.5 text-xs text-slate-500">
          North up, drawn to fit, with saved waypoints marked. This is a plot of
          the track itself — there is no basemap under it, because chart tiles
          need a connection at exactly the moment you may not have one.
        </p>
      </Card>

      <Card>
        <Label>Track recording</Label>

        <div className="mb-3">
          <span className="mb-1.5 block text-xs text-slate-400">
            Record a point every
          </span>
          <div className="flex gap-1">
            {INTERVAL_CHOICES.map((s) => (
              <button
                key={s}
                onClick={() => setIntervalS(s)}
                className={
                  'flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ' +
                  (intervalS === s
                    ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                    : 'border-white/10 text-slate-400 hover:bg-white/5')
                }
              >
                {s}s
              </button>
            ))}
          </div>
        </div>

        <div className="mb-3 flex gap-1">
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

        <div className="grid grid-cols-3 gap-2">
          <Stat label="Points" value={String(trail.length)} />
          <Stat
            label="Travelled"
            value={trail.length > 1 ? formatDistance(travelled, unit) : '—'}
          />
          <Stat
            label="Elapsed"
            value={elapsedH > 0 ? formatDuration(elapsedH) : '—'}
          />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            onClick={() => {
              if (trail.length < 2) return toast('No track recorded yet', 'error')
              const stamp = new Date().toISOString().slice(0, 10)
              download(
                `navmate-track-${stamp}.gpx`,
                trackToGPX(trail, `NavMate track ${stamp}`),
                'application/gpx+xml',
              )
              toast('Track exported', 'success')
            }}
          >
            Export track (GPX)
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              if (trail.length === 0) return
              if (!confirm('Discard the recorded track?')) return
              clearTrail()
              toast('Track cleared')
            }}
            disabled={trail.length === 0}
          >
            Clear track
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          While tracking is on a breadcrumb is dropped every {intervalS} seconds,
          up to 2000 of them, and kept until you clear them or reload the app.
          The live readout above still follows every fix. Movement smaller than
          the GPS accuracy is ignored so a stationary phone does not accumulate
          distance.
        </p>
      </Card>
    </div>
  )
}
