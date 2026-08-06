import { useMemo, useState } from 'react'
import { useTracker, INTERVAL_CHOICES } from '@/store/useTracker'
import { useWaypoints } from '@/store/useWaypoints'
import { TrackPath } from '@/components/TrackPath'
import { SatelliteMap } from '@/components/SatelliteMap'
import {
  compassPoint,
  formatDistance,
  formatDuration,
  formatSpeed,
  trailDistanceNM,
  type DistanceUnit,
} from '@/lib/geo'
import { ACCURACY_GATES, QUALITY_LABEL, fixQuality } from '@/lib/track'
import { toDD, toDMS } from '@/lib/coords'
import { download, trackToGPX } from '@/lib/transfer'
import { toast } from '@/store/useToast'
import { Button, Card, Label, Stat } from '@/components/ui'

const UNITS: { id: DistanceUnit; label: string }[] = [
  { id: 'nm', label: 'NM' },
  { id: 'mi', label: 'mi' },
  { id: 'km', label: 'km' },
]

type View = 'satellite' | 'hybrid' | 'plot'

const VIEWS: { id: View; label: string }[] = [
  { id: 'satellite', label: 'Satellite' },
  { id: 'hybrid', label: 'Satellite + labels' },
  { id: 'plot', label: 'Plot only' },
]

const QUALITY_COLOUR: Record<string, string> = {
  excellent: 'text-emerald-300',
  good: 'text-emerald-300',
  fair: 'text-sky-300',
  poor: 'text-amber-300',
  coarse: 'text-red-300',
}

/** Segmented control — the app already uses this shape in three places. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (id: T) => void
}) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={
            'flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ' +
            (value === o.id
              ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
              : 'border-white/10 text-slate-400 hover:bg-white/5')
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function TrackTab() {
  const {
    fix,
    raw,
    watching,
    error,
    trail,
    intervalS,
    gateM,
    rejected,
    lastReject,
    derived,
    screenAwake,
    start,
    stop,
    clearTrail,
    setIntervalS,
    setGateM,
  } = useTracker()
  const waypoints = useWaypoints((s) => s.visible())

  const [unit, setUnit] = useState<DistanceUnit>('nm')
  const [view, setView] = useState<View>('satellite')

  const travelled = useMemo(() => trailDistanceNM(trail), [trail])
  const elapsedH =
    trail.length > 1
      ? (trail[trail.length - 1].timestamp - trail[0].timestamp) / 3600_000
      : 0

  const markers = useMemo(
    () =>
      waypoints.map((w) => ({
        id: w.id,
        name: w.name,
        lat: w.lat,
        lon: w.lon,
      })),
    [waypoints],
  )

  const quality = fixQuality(fix?.accuracy)
  const refused = rejected.accuracy + rejected.jump + rejected.stale
  // Nothing has made it through the gate yet, but the receiver is talking.
  const waiting = !fix && raw != null

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Live tracker</h2>
        <p className="text-sm text-slate-400">
          Live position on satellite imagery, and the path you have covered.
        </p>
      </div>

      {error && (
        <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <Card>
        <Label>Map</Label>
        <div className="mb-2">
          <Segmented value={view} options={VIEWS} onChange={setView} />
        </div>

        {view === 'plot' ? (
          <>
            <TrackPath trail={trail} markers={markers} />
            <p className="mt-1.5 text-xs text-slate-500">
              North up, drawn to fit, with saved waypoints marked and no imagery
              fetched at all. This is the view that cannot fail on a dead link.
            </p>
          </>
        ) : (
          <>
            <SatelliteMap
              trail={trail}
              fix={fix}
              markers={markers}
              labels={view === 'hybrid'}
            />
            <p className="mt-1.5 text-xs text-slate-500">
              Drag to pan, pinch or use + / − to zoom, Centre to follow yourself
              again. The circle around your position is how uncertain the fix
              is, drawn to the same scale as the ground. Imagery is fetched as
              you look at it and kept on the device — press{' '}
              <span className="text-slate-400">Save imagery for offline</span>{' '}
              before you lose signal to keep the area you are working.
            </p>
          </>
        )}
      </Card>

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
        <Stat
          label="Speed"
          value={formatSpeed(fix?.speed)}
          hint={derived.speed ? 'from the track' : undefined}
        />
        <Stat
          label="Heading"
          value={
            fix?.heading != null
              ? `${Math.round(fix.heading)}° ${compassPoint(fix.heading)}`
              : '—'
          }
          hint={derived.heading ? 'course made good' : undefined}
        />
        <Stat
          label="Accuracy"
          value={fix?.accuracy != null ? `±${Math.round(fix.accuracy)} m` : '—'}
          hint={
            raw?.accuracy != null && fix?.accuracy != null
              ? `receiver ±${Math.round(raw.accuracy)} m`
              : undefined
          }
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
          {watching && screenAwake ? ' · screen held awake' : ''}
        </p>
      )}

      <Card>
        <Label>Fix quality</Label>
        <div className="grid grid-cols-3 gap-2">
          <Stat
            label="Quality"
            value={fix ? QUALITY_LABEL[quality] : '—'}
          />
          <Stat label="Used" value={String(trail.length)} />
          <Stat label="Refused" value={String(refused)} />
        </div>

        <p
          className={
            'mt-2 text-xs ' + (fix ? QUALITY_COLOUR[quality] : 'text-slate-500')
          }
        >
          {waiting
            ? `Waiting for a fix inside the limit — the receiver is reporting ±${Math.round(raw?.accuracy ?? 0)} m.`
            : fix
              ? `Position filtered from ${trail.length > 0 ? 'the' : 'this'} fix stream; the figure above is the filter's own estimate, never better than half what the receiver claims.`
              : 'No fix yet.'}
        </p>
        {lastReject && (
          <p className="mt-1 text-xs text-slate-500">Last refused: {lastReject}</p>
        )}

        <div className="mt-3">
          <span className="mb-1.5 block text-xs text-slate-400">
            Ignore fixes worse than
          </span>
          <div className="flex gap-1">
            {ACCURACY_GATES.map((m) => (
              <button
                key={m}
                onClick={() => setGateM(m)}
                className={
                  'flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ' +
                  (gateM === m
                    ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                    : 'border-white/10 text-slate-400 hover:bg-white/5')
                }
              >
                {m === 0 ? 'Any' : `±${m} m`}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            A phone hands the page a cell-tower estimate hundreds of metres wide
            before its GNSS chip has locked, and throws the odd wild fix off a
            cliff face or a wheelhouse roof afterwards. Both are dropped rather
            than plotted. Loosen this if you are working somewhere the receiver
            genuinely cannot do better — under canopy, below deck — and the
            count above keeps climbing with no position to show for it.
          </p>
        </div>
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
          The live readout above still follows every fix. A point is only
          recorded once the position has moved further than it is uncertain, so
          a phone sitting on a thwart does not draw a mile of scribble.
        </p>
      </Card>
    </div>
  )
}
