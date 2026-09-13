import { useEffect, useMemo, useState } from 'react'
import { useTracker } from '@/store/useTracker'
import { useWaypoints } from '@/store/useWaypoints'
import { useTeams } from '@/store/useTeams'
import { useVessels } from '@/store/useVessels'
import { useChartData } from '@/store/useChartData'
import { useIncidents } from '@/store/useIncidents'
import { useTides } from '@/store/useTides'
import { useOnline } from '@/hooks/useOnline'
import { toast } from '@/store/useToast'
import { parseCoord } from '@/lib/coords'
import {
  formatBearing,
  formatDistance,
  formatDuration,
  formatEtaClock,
  haversineNM,
} from '@/lib/geo'
import { planRoute, routeBounds, type RoutePlan } from '@/lib/routing'
import {
  formatDepth,
  formatFeet,
  fuelForHours,
  readVesselField,
  safeDepthM,
  VESSEL_DEFAULTS,
  type NewVessel,
  type Vessel,
} from '@/lib/vessel'
import { formatTideClock, formatTideHeight, tideNow } from '@/lib/tides'
import { SatelliteMap, type MapBase } from '@/components/SatelliteMap'
import { SteerCard } from '@/components/SteerCard'
import { shouldAdvance } from '@/lib/steer'
import { Button, Card, EmptyState, Input, Label, Spinner, Stat } from '@/components/ui'

/**
 * Chart plotter — a nautical chart, a destination, and a course that stays in
 * water the boat can use.
 *
 * The three things this screen is careful about:
 *
 * **It never plans on water it has not seen charted.** The router refuses
 * unsurveyed cells and this tab shows the refusal rather than hiding it.
 *
 * **It plans at chart datum.** Tide is on the screen beside the route because
 * it matters, and out of the route because a shortcut that needs the tide in
 * is a grounding waiting for a delay.
 *
 * **It says what the data is.** NOAA publishes ENC for display and GIS, not as
 * a certified navigation product, and the banner under every plotted route
 * says so where the coxswain is looking rather than in a settings page.
 */

type Destination = {
  lat: number
  lon: number
  label: string
}

export function ChartTab() {
  const tracker = useTracker()
  const fix = tracker.fix
  const online = useOnline()
  const activeTeamId = useTeams((s) => s.activeTeamId)

  const vessels = useVessels()
  const boat = vessels.active(activeTeamId)
  const scopeBoats = vessels.inScope(activeTeamId)

  const chart = useChartData()
  const createWaypoint = useWaypoints((s) => s.create)
  const allWaypoints = useWaypoints((s) => s.visible())
  const incident = useIncidents((s) => s.activeIncident(activeTeamId))
  const tides = useTides()

  const [base, setBase] = useState<MapBase>('chart')
  const [seamarks, setSeamarks] = useState(true)
  const [picking, setPicking] = useState(false)
  const [dest, setDest] = useState<Destination | null>(null)
  const [typed, setTyped] = useState({ lat: '', lon: '' })
  const [plan, setPlan] = useState<RoutePlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [targetIdx, setTargetIdx] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)

  // Loading once on mount is enough; the store is offline-first and the cache
  // is what plans routes.
  const loadVessels = vessels.load
  useEffect(() => {
    void loadVessels()
  }, [loadVessels])

  const waypoints = useMemo(
    () =>
      allWaypoints.filter((w) =>
        activeTeamId ? w.team_id === activeTeamId : w.team_id === null,
      ),
    [allWaypoints, activeTeamId],
  )

  const speedKn = boat?.cruise_speed_kn ?? 0
  const running = targetIdx !== null && plan !== null

  /* Auto-advance down the route, exactly as the search pattern does. */
  useEffect(() => {
    if (!running || !plan || targetIdx === null || !fix) return
    if (shouldAdvance(plan, targetIdx, fix)) setTargetIdx(targetIdx + 1)
  }, [running, plan, targetIdx, fix])

  /* A new destination invalidates the route that went to the old one. */
  useEffect(() => {
    setPlan(null)
    setTargetIdx(null)
  }, [dest?.lat, dest?.lon])

  async function plot() {
    if (!fix || !dest || !boat || planning) return
    setPlanning(true)
    try {
      const bounds = routeBounds(fix, dest)
      const features = await chart.load(bounds)
      const next = planRoute({
        from: { lat: fix.lat, lon: fix.lon },
        to: { lat: dest.lat, lon: dest.lon },
        safeDepthM: safeDepthM(boat),
        clearanceM: boat.clearance_m,
        speedKn: boat.cruise_speed_kn,
        features,
      })
      setPlan(next)
      setTargetIdx(null)
      if (next.source === 'charted') {
        toast(
          `Course plotted — ${formatDistance(next.totalNM, 'nm')} in ${next.legs.length} leg${next.legs.length === 1 ? '' : 's'}`,
          'success',
        )
      }
      // The tide is information beside the route, never an input to it.
      void tides.refresh(dest.lat, dest.lon)
    } finally {
      setPlanning(false)
    }
  }

  async function takeFix() {
    const got = await tracker.once()
    if (!got) toast(useTracker.getState().error ?? 'No GPS fix yet', 'error')
  }

  async function saveRoute() {
    if (!plan) return
    let saved = 0
    for (let i = 1; i < plan.points.length; i++) {
      const p = plan.points[i]
      const last = i === plan.points.length - 1
      const w = await createWaypoint({
        name: last ? (dest?.label ?? 'Destination') : `Turn ${i}`,
        lat: p.lat,
        lon: p.lon,
        note: `Chart plotter route · leg ${i} of ${plan.legs.length}`,
        team_id: activeTeamId,
      })
      if (w) saved++
    }
    toast(
      `${saved} point${saved === 1 ? '' : 's'} saved as waypoints${online ? '' : ' — offline, will sync'}`,
      saved > 0 ? 'success' : 'error',
    )
  }

  const tide = useMemo(
    () => tideNow(new Date(), tides.extremes),
    [tides.extremes],
  )

  const arrival = plan && Number.isFinite(plan.hours) ? formatEtaClock(plan.hours) : ''
  const fuel = plan && boat ? fuelForHours(boat, plan.hours) : null

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-50">Chart plotter</h2>
      <p className="text-sm text-slate-300">
        Pick where you are going and this works out a course that keeps your
        boat in water it can use — round the shoals, not over them.
      </p>

      {/* ------------------------------------------------------------ boat */}
      <Card>
        <div className="flex items-start justify-between gap-2">
          <Label>Boat</Label>
          {boat ? (
            <button
              onClick={() => setEditing((v) => !v)}
              className="mb-1.5 text-xs font-semibold text-sky-300 hover:text-sky-200"
            >
              {editing ? 'Done' : 'Edit'}
            </button>
          ) : null}
        </div>

        {scopeBoats.length === 0 ? (
          <EmptyState>
            Add your boat so the plotter knows what water it can use. Nothing
            here is planned without a draft.
          </EmptyState>
        ) : (
          <>
            {scopeBoats.length > 1 && (
              <div className="mb-2 grid grid-cols-2 gap-1.5">
                {scopeBoats.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => vessels.setActive(v.id)}
                    aria-pressed={v.id === boat?.id}
                    className={
                      'rounded-lg border px-2 py-1.5 text-left text-xs font-semibold ' +
                      (v.id === boat?.id
                        ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                        : 'border-white/10 text-slate-300 hover:bg-white/5')
                    }
                  >
                    {v.name || 'Unnamed boat'}
                    <span className="block font-normal text-slate-400">
                      {formatFeet(v.draft_m)} draft
                    </span>
                  </button>
                ))}
              </div>
            )}

            {boat && (
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Draft" value={formatFeet(boat.draft_m)} />
                <Stat
                  label="Needs"
                  value={formatFeet(safeDepthM(boat))}
                  hint="draft + margin"
                />
                <Stat label="Cruise" value={`${boat.cruise_speed_kn} kn`} />
              </div>
            )}
          </>
        )}

        {(editing || scopeBoats.length === 0) && (
          <VesselForm
            key={boat?.id ?? 'new'}
            vessel={boat}
            teamId={activeTeamId}
            onDone={() => setEditing(false)}
          />
        )}
      </Card>

      {/* ----------------------------------------------------------- chart */}
      <Card>
        <div className="flex items-start justify-between gap-2">
          <Label>Chart</Label>
          <span className="tnum mb-1.5 text-xs text-slate-400">
            {chart.status === 'loading'
              ? 'loading depths…'
              : chart.status === 'ready'
                ? `depths: ${chart.features.coverage}`
                : chart.status === 'error'
                  ? 'no depths'
                  : ''}
          </span>
        </div>

        <div className="mb-2 grid grid-cols-3 gap-1.5">
          {(
            [
              ['chart', 'Chart'],
              ['satellite', 'Satellite'],
            ] as [MapBase, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setBase(id)}
              aria-pressed={base === id}
              className={
                'rounded-lg border px-2 py-1.5 text-xs font-semibold ' +
                (base === id
                  ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                  : 'border-white/10 text-slate-300 hover:bg-white/5')
              }
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => setSeamarks((v) => !v)}
            aria-pressed={seamarks}
            className={
              'rounded-lg border px-2 py-1.5 text-xs font-semibold ' +
              (seamarks
                ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                : 'border-white/10 text-slate-300 hover:bg-white/5')
            }
          >
            Buoys
          </button>
        </div>

        <SatelliteMap
          trail={tracker.trail}
          fix={fix}
          base={base}
          seamarks={seamarks}
          route={plan?.points ?? []}
          markers={dest ? [{ id: 'dest', name: dest.label, lat: dest.lat, lon: dest.lon }] : []}
          onPick={
            picking
              ? (p) => {
                  setDest({ ...p, label: 'Picked on chart' })
                  setPicking(false)
                }
              : undefined
          }
          pickHint="Tap the chart where you want to go"
          height={320}
        />

        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button
            variant={picking ? 'primary' : 'default'}
            onClick={() => setPicking((v) => !v)}
          >
            {picking ? 'Cancel pick' : 'Pick on chart'}
          </Button>
          <Button variant="ghost" onClick={() => void takeFix()}>
            Take a fix
          </Button>
        </div>
      </Card>

      {/* ----------------------------------------------------- destination */}
      <Card>
        <Label>Destination</Label>

        {dest ? (
          <div className="rounded-xl border border-sky-400/30 bg-sky-500/5 px-3 py-2.5">
            <div className="text-sm font-semibold text-slate-50">{dest.label}</div>
            <div className="tnum mt-0.5 text-xs text-slate-300">
              {dest.lat.toFixed(5)}, {dest.lon.toFixed(5)}
              {fix
                ? ` · ${formatDistance(haversineNM(fix.lat, fix.lon, dest.lat, dest.lon), 'nm')} direct`
                : ''}
            </div>
          </div>
        ) : (
          <EmptyState>
            Tap the chart, or choose a waypoint below.
          </EmptyState>
        )}

        {incident?.lkp_lat != null && incident.lkp_lng != null && (
          <button
            onClick={() =>
              setDest({
                lat: incident.lkp_lat as number,
                lon: incident.lkp_lng as number,
                label: `LKP · ${incident.incident_number}`,
              })
            }
            className="mt-2 w-full rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-left text-xs font-semibold text-amber-200 hover:bg-amber-500/15"
          >
            Run to the LKP
            <span className="block font-normal text-amber-100/70">
              {incident.incident_name || incident.incident_number}
            </span>
          </button>
        )}

        {waypoints.length > 0 && (
          <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {waypoints.slice(0, 40).map((w) => (
              <button
                key={w.id}
                onClick={() => setDest({ lat: w.lat, lon: w.lon, label: w.name })}
                className="flex w-full min-h-11 items-center justify-between gap-2 rounded-lg border border-white/10 px-3 text-left text-sm text-slate-200 hover:bg-white/5"
              >
                <span className="truncate">{w.name}</span>
                {fix && (
                  <span className="tnum shrink-0 text-xs text-slate-400">
                    {formatDistance(haversineNM(fix.lat, fix.lon, w.lat, w.lon), 'nm')}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="mt-2 grid grid-cols-2 gap-2">
          <Input
            inputMode="decimal"
            placeholder="Latitude"
            value={typed.lat}
            onChange={(e) => setTyped({ ...typed, lat: e.target.value })}
            aria-label="Destination latitude"
          />
          <Input
            inputMode="decimal"
            placeholder="Longitude"
            value={typed.lon}
            onChange={(e) => setTyped({ ...typed, lon: e.target.value })}
            aria-label="Destination longitude"
          />
        </div>
        <Button
          className="mt-2 w-full"
          variant="ghost"
          onClick={() => {
            // coords.ts is deliberately strict and returns NaN rather than
            // guessing at an ambiguous position — a plausible-looking wrong
            // coordinate is the worst failure this app can produce.
            const lat = parseCoord(typed.lat, 'lat')
            const lon = parseCoord(typed.lon, 'lon')
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
              toast('Those coordinates could not be read', 'error')
              return
            }
            setDest({ lat, lon, label: 'Typed position' })
          }}
        >
          Use typed coordinates
        </Button>
      </Card>

      {/* ----------------------------------------------------------- route */}
      <Card>
        <div className="flex items-start justify-between gap-2">
          <Label>Course</Label>
          {plan ? (
            <span className="tnum mb-1.5 text-xs text-slate-400">
              {plan.source === 'charted'
                ? `${plan.legs.length} leg${plan.legs.length === 1 ? '' : 's'}`
                : 'straight line'}
            </span>
          ) : null}
        </div>

        <Button
          variant="primary"
          className="w-full"
          disabled={!fix || !dest || !boat || planning}
          onClick={() => void plot()}
        >
          {planning ? <Spinner /> : null}
          {planning ? 'Plotting…' : 'Plot course'}
        </Button>

        {!boat && (
          <p className="mt-1.5 text-xs text-slate-400">
            Add a boat above first — a course means nothing without a draft.
          </p>
        )}
        {!fix && boat && (
          <p className="mt-1.5 text-xs text-slate-400">
            Take a fix above so the plotter knows where you are starting from.
          </p>
        )}

        {plan && (
          <>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Stat label="Distance" value={formatDistance(plan.totalNM, 'nm')} />
              <Stat
                label="Time to run"
                value={
                  Number.isFinite(plan.hours) ? formatDuration(plan.hours) : '—'
                }
                hint={speedKn > 0 ? `at ${speedKn} kn` : 'set a cruise speed'}
              />
              <Stat
                label="Arrive"
                value={arrival || '—'}
                hint={fuel !== null ? `${fuel.toFixed(0)} gal` : undefined}
              />
            </div>

            <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              <strong className="font-semibold">Not for navigation.</strong>{' '}
              Charted depths are at mean lower low water and were not surveyed
              for your passage. Check this against the chart and your own eyes
              before you run it.
            </p>

            {plan.warnings.map((w) => (
              <p
                key={w}
                className="mt-1.5 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-100"
              >
                {w}
              </p>
            ))}

            <div className="mt-2 space-y-1">
              {plan.legs.map((leg) => (
                <div
                  key={leg.n}
                  className="flex items-center justify-between gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm"
                >
                  <span className="tnum text-slate-100">
                    {leg.n}. {formatBearing(leg.courseDeg)}
                  </span>
                  <span className="tnum text-xs text-slate-300">
                    {formatDistance(leg.lengthNM, 'nm')}
                    {leg.minChartedDepthM !== null
                      ? ` · ${formatFeet(leg.minChartedDepthM)} least`
                      : ' · not charted'}
                  </span>
                </div>
              ))}
            </div>

            {tide.next && (
              <p className="mt-2 text-xs text-slate-400">
                Tide {tide.trend} · next {tide.next.type === 'H' ? 'high' : 'low'}{' '}
                {formatTideClock(tide.next.at)} at{' '}
                {formatTideHeight(tide.next.heightFt)}. Depths above are at chart
                datum, so there is normally more water than this — never less by
                design, but wind can take it away.
              </p>
            )}

            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button
                variant="primary"
                disabled={plan.points.length < 2}
                onClick={() => setTargetIdx(running ? null : 1)}
              >
                {running ? 'Stop steering' : 'Steer this route'}
              </Button>
              <Button variant="ghost" onClick={() => void saveRoute()}>
                Save as waypoints
              </Button>
            </div>
          </>
        )}
      </Card>

      {running && plan && targetIdx !== null && (
        <SteerCard
          plan={plan}
          targetIdx={targetIdx}
          setTargetIdx={setTargetIdx}
          fix={fix}
          lastLabel="Last leg — you are on the destination when you arrive."
          footnote="Advances by itself within each turn point. Keep tracking on so the track records where you actually went."
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------
 * The boat
 * ---------------------------------------------------------------------- */

function VesselForm({
  vessel,
  teamId,
  onDone,
}: {
  vessel: Vessel | null
  teamId: string | null
  onDone: () => void
}) {
  const { addVessel, updateVessel, removeVessel } = useVessels()
  const [form, setForm] = useState({
    name: vessel?.name ?? '',
    callsign: vessel?.callsign ?? '',
    draftFt: vessel ? (vessel.draft_m * 3.280839895).toFixed(1) : '',
    airDraftFt: vessel ? (vessel.air_draft_m * 3.280839895).toFixed(1) : '',
    marginFt: vessel ? (vessel.under_keel_margin_m * 3.280839895).toFixed(1) : '',
    cruise: vessel ? String(vessel.cruise_speed_kn) : '',
    max: vessel ? String(vessel.max_speed_kn) : '',
    burn: vessel && vessel.fuel_burn_gph > 0 ? String(vessel.fuel_burn_gph) : '',
    clearanceFt: vessel ? (vessel.clearance_m * 3.280839895).toFixed(0) : '',
  })
  const [saving, setSaving] = useState(false)

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  /** Feet in the form, metres in the record — one unit of truth. */
  const ft = (raw: string, fallbackM: number): number => {
    const n = parseFloat(raw)
    return Number.isFinite(n) && n >= 0 ? n * 0.3048 : fallbackM
  }

  async function save() {
    const draft_m = ft(form.draftFt, VESSEL_DEFAULTS.draft_m)
    if (!(draft_m > 0)) {
      toast('A draft is needed before anything can be plotted', 'error')
      return
    }
    const next: NewVessel = {
      name: form.name.trim() || 'Boat',
      callsign: form.callsign.trim(),
      draft_m,
      air_draft_m: ft(form.airDraftFt, 0),
      beam_m: vessel?.beam_m ?? VESSEL_DEFAULTS.beam_m,
      length_m: vessel?.length_m ?? VESSEL_DEFAULTS.length_m,
      cruise_speed_kn:
        readVesselField(form.cruise, 'cruise_speed_kn') ??
        VESSEL_DEFAULTS.cruise_speed_kn,
      max_speed_kn:
        readVesselField(form.max, 'max_speed_kn') ?? VESSEL_DEFAULTS.max_speed_kn,
      fuel_burn_gph: readVesselField(form.burn, 'fuel_burn_gph') ?? 0,
      under_keel_margin_m: ft(form.marginFt, VESSEL_DEFAULTS.under_keel_margin_m),
      clearance_m: ft(form.clearanceFt, VESSEL_DEFAULTS.clearance_m),
      team_id: teamId,
    }

    setSaving(true)
    try {
      if (vessel) await updateVessel(vessel.id, next)
      else await addVessel(next)
      toast(vessel ? 'Boat updated' : 'Boat added', 'success')
      onDone()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
      <div className="grid grid-cols-2 gap-2">
        <Input placeholder="Name" value={form.name} onChange={set('name')} aria-label="Boat name" />
        <Input placeholder="Callsign" value={form.callsign} onChange={set('callsign')} aria-label="Boat callsign" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input
          inputMode="decimal"
          placeholder={`Draft ft (${(VESSEL_DEFAULTS.draft_m * 3.280839895).toFixed(1)})`}
          value={form.draftFt}
          onChange={set('draftFt')}
          aria-label="Draft in feet"
        />
        <Input
          inputMode="decimal"
          placeholder={`Under keel ft (${(VESSEL_DEFAULTS.under_keel_margin_m * 3.280839895).toFixed(1)})`}
          value={form.marginFt}
          onChange={set('marginFt')}
          aria-label="Under-keel margin in feet"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input
          inputMode="decimal"
          placeholder="Cruise kn (20)"
          value={form.cruise}
          onChange={set('cruise')}
          aria-label="Cruise speed in knots"
        />
        <Input
          inputMode="decimal"
          placeholder="Top kn (35)"
          value={form.max}
          onChange={set('max')}
          aria-label="Top speed in knots"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input
          inputMode="decimal"
          placeholder="Air draft ft"
          value={form.airDraftFt}
          onChange={set('airDraftFt')}
          aria-label="Air draft in feet"
        />
        <Input
          inputMode="decimal"
          placeholder="Stand-off ft (100)"
          value={form.clearanceFt}
          onChange={set('clearanceFt')}
          aria-label="Stand-off from hazards in feet"
        />
      </div>
      <Input
        inputMode="decimal"
        placeholder="Fuel burn gal/h at cruise (optional)"
        value={form.burn}
        onChange={set('burn')}
        aria-label="Fuel burn in gallons per hour"
      />
      <p className="text-xs text-slate-400">
        Draft plus the under-keel margin is the depth the plotter will not go
        below: {formatDepth(ft(form.draftFt, VESSEL_DEFAULTS.draft_m) + ft(form.marginFt, VESSEL_DEFAULTS.under_keel_margin_m))}.
        The stand-off is how far it keeps you off every charted hazard.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {vessel ? 'Save boat' : 'Add boat'}
        </Button>
        {vessel ? (
          <Button
            variant="danger"
            onClick={() => {
              void removeVessel(vessel.id)
              onDone()
            }}
          >
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  )
}
