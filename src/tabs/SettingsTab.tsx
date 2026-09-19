import { Card, Label, Segmented } from '@/components/ui'
import { useUnits } from '@/store/useUnits'
import { COORD_FORMATS, useCoordFormat } from '@/store/useCoordFormat'
import { useTracker, INTERVAL_CHOICES } from '@/store/useTracker'
import { ARRIVAL_FT_CHOICES } from '@/lib/steer'
import {
  ALTITUDE_UNITS,
  DEPTH_UNITS,
  DISTANCE_UNITS,
  formatDepth,
  formatLength,
  formatKnots,
  formatTemp,
  SPEED_UNITS,
  TEMP_UNITS,
} from '@/lib/units'

/**
 * One place for how everything reads.
 *
 * These settings were scattered — the coordinate format lived inside the
 * coordinate control, the tracking interval and the arrival circle on the
 * tracker page, and the units were not settings at all: feet, knots, nautical
 * miles and Fahrenheit were written into each screen. A crew that works in
 * metres had to translate every depth in their head.
 *
 * Nothing here changes a stored value. Water temperature stays Celsius, a
 * draft stays metres, a charted depth stays whatever the chart published —
 * because those are contracts with the command system's drift and
 * survivability models, and a number whose meaning depends on a setting is a
 * number nobody can read back later. The conversion happens where the screen
 * is drawn, and `lib/units.ts` is the only place it happens.
 *
 * Each choice shows the same example beneath it, so the difference between
 * fathoms and feet is visible before it is chosen rather than after.
 */
export function SettingsTab() {
  const units = useUnits()
  const format = useCoordFormat((s) => s.format)
  const setFormat = useCoordFormat((s) => s.setFormat)
  const intervalS = useTracker((s) => s.intervalS)
  const setIntervalS = useTracker((s) => s.setIntervalS)
  const arrivalFt = useTracker((s) => s.arrivalFt)
  const setArrivalFt = useTracker((s) => s.setArrivalFt)
  const gateM = useTracker((s) => s.gateM)
  const setGateM = useTracker((s) => s.setGateM)

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Settings</h2>
        <p className="text-sm text-slate-300">
          How readings are shown. Nothing here changes what is recorded — a
          depth stays a depth, and the handoff to command is unaffected.
        </p>
      </div>

      <Card>
        <Label>Units</Label>

        <div className="space-y-3">
          <Setting
            title="Depth"
            example={formatDepth(3.7, units.depth)}
            value={units.depth}
            options={DEPTH_UNITS}
            onChange={(depth) => units.set({ depth })}
          />
          <Setting
            title="Distance"
            example={formatLength(2.5, units.distance)}
            value={units.distance}
            options={DISTANCE_UNITS}
            onChange={(distance) => units.set({ distance })}
          />
          <Setting
            title="Speed"
            example={formatKnots(8, units.speed)}
            value={units.speed}
            options={SPEED_UNITS}
            onChange={(speed) => units.set({ speed })}
          />
          <Setting
            title="Water temperature"
            example={formatTemp(12, units.temp)}
            value={units.temp}
            options={TEMP_UNITS}
            onChange={(temp) => units.set({ temp })}
          />
          <Setting
            title="Height and altitude"
            example={units.altitude === 'ft' ? '33 ft' : '10 m'}
            value={units.altitude}
            options={ALTITUDE_UNITS}
            onChange={(altitude) => units.set({ altitude })}
          />
        </div>
      </Card>

      <Card>
        <Label>Coordinates</Label>
        <p className="mb-1.5 text-xs text-slate-400">
          Every coordinate typed or shown in this app, including the waypoint
          form and the position pickers.
        </p>
        <Segmented
          label="Coordinate format"
          value={format}
          options={COORD_FORMATS}
          onChange={setFormat}
        />
        <p className="mt-1.5 text-xs text-slate-400">
          {COORD_FORMATS.find((f) => f.id === format)?.hint}
        </p>
      </Card>

      <Card>
        <Label>Navigation</Label>

        <div className="space-y-3">
          <div>
            <span className="mb-1 block text-xs font-semibold text-slate-300">
              Arrival circle
            </span>
            <Segmented
              label="Arrival circle"
              value={String(arrivalFt)}
              options={ARRIVAL_FT_CHOICES.map((ft) => ({
                id: String(ft),
                label: `${ft} ft`,
              }))}
              onChange={(v) =>
                setArrivalFt(Number(v) as (typeof ARRIVAL_FT_CHOICES)[number])
              }
            />
            <p className="mt-1 text-[11px] text-slate-400">
              How close counts as reaching a turn point. Never tighter than the
              fix itself can resolve.
            </p>
          </div>

          <div>
            <span className="mb-1 block text-xs font-semibold text-slate-300">
              Breadcrumb interval
            </span>
            <Segmented
              label="Breadcrumb interval"
              value={String(intervalS)}
              options={INTERVAL_CHOICES.map((s) => ({
                id: String(s),
                label: `${s} s`,
              }))}
              onChange={(v) => setIntervalS(Number(v))}
            />
            <p className="mt-1 text-[11px] text-slate-400">
              How densely the track is sampled. The live position updates on
              every fix regardless.
            </p>
          </div>

          <div>
            <span className="mb-1 block text-xs font-semibold text-slate-300">
              Fix accuracy limit
            </span>
            <Segmented
              label="Fix accuracy limit"
              value={String(gateM)}
              options={[
                { id: '10', label: '±10 m' },
                { id: '25', label: '±25 m' },
                { id: '50', label: '±50 m' },
                { id: '0', label: 'Take any' },
              ]}
              onChange={(v) => setGateM(Number(v))}
            />
            <p className="mt-1 text-[11px] text-slate-400">
              A fix worse than this is refused and counted. Loosen it under
              canopy or below deck, where the choice is a rough position or
              none at all.
            </p>
          </div>
        </div>
      </Card>
    </div>
  )
}

function Setting<T extends string>({
  title,
  example,
  value,
  options,
  onChange,
}: {
  title: string
  example: string
  value: T
  options: { id: T; label: string; hint?: string }[]
  onChange: (id: T) => void
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-slate-300">{title}</span>
        <span className="tnum text-xs text-slate-400">{example}</span>
      </div>
      <Segmented label={title} value={value} options={options} onChange={onChange} />
    </div>
  )
}
