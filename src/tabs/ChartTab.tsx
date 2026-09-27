import { useEffect, useMemo, useState } from 'react'
import { useFormat } from '@/hooks/useFormat'
import { useNow } from '@/hooks/useNow'
import { useTracker } from '@/store/useTracker'
import { useWaypoints } from '@/store/useWaypoints'
import { useIncidentUnits } from '@/hooks/useIncidentUnits'
import { useIncidentOverlay } from '@/hooks/useIncidentOverlay'
import { useTeams } from '@/store/useTeams'
import { useVessels } from '@/store/useVessels'
import { useChartData } from '@/store/useChartData'
import { useIncidents } from '@/store/useIncidents'
import { useTides } from '@/store/useTides'
import { useHeading } from '@/store/useHeading'
import { useNavigation, type Place } from '@/store/useNavigation'
import { useOnline } from '@/hooks/useOnline'
import { toast } from '@/store/useToast'
import { toDD, toDDM, toDMS } from '@/lib/coords'
import { useCoordFormat } from '@/store/useCoordFormat'
import { CoordInput } from '@/components/CoordInput'
import { Sheet } from '@/components/Sheet'
import { formatDuration, formatEtaClock } from '@/lib/geo'
import {
  fuelForHours,
  readVesselField,
  safeDepthM,
  VESSEL_DEFAULTS,
  type NewVessel,
  type Vessel,
} from '@/lib/vessel'
import {
  formatTideClock,
  formatTideHeight,
  tideHeightNow,
  tideNow,
} from '@/lib/tides'
import { FEET_TO_M } from '@/lib/units'
import { ROUTE_ARRIVAL_FT_CHOICES, type ArrivalFt } from '@/lib/steer'
import {
  arrivalSettingNote,
  bearingText,
  declinationFor,
  hasRoute,
  legRows,
  needsConfirmation,
  planFailureView,
  routeMarks,
  routeSegments,
  routeSummary,
  type FailureAction,
} from '@/lib/navView'
import { SatelliteMap, type MapBase } from '@/components/SatelliteMap'
import { NavCard } from '@/components/NavCard'
import { AddWaypointButton } from '@/components/AddWaypoint'
import { Button, Card, EmptyState, Field, Label, Segmented, Spinner } from '@/components/ui'

/**
 * Chart plotter — pick a destination, see the route, press Start.
 *
 * The flow is Google Maps', because that is the flow every crew already
 * knows. "Navigate here" from anywhere in the app (a waypoint, a long press on
 * any map, the Datum worksheet's "Take me there") plans a route from the
 * boat's live position at once and lands here showing it. Start steers it;
 * the card at the top then says which waypoint is next, the bearing and
 * distance to it, and when the boat gets in. Leave the route and it re-plans
 * from where the boat is.
 *
 * This screen owns NONE of that state. The destination, the plan, where the
 * boat is along it and whether the crew has accepted a best-effort route live
 * in `useNavigation` (store/useNavigation.ts), driven by the GPS from
 * `useNavigationEngine` whichever tab is open — so looking at the tide table
 * mid-passage no longer loses the route. What is here is layout, and the
 * local choices that only matter on this screen (base layer, which end a chart
 * tap is setting, an open sheet).
 *
 * Three things it is careful about:
 *
 * **It never draws a line it has not checked.** A route is drawn leg by leg
 * from the planner's points or not at all. With no honest route the map shows
 * no line, and the card says why in plain words, what to change, and Retry.
 *
 * **A route that is not fully safe looks it.** Flagged legs are red on the
 * map and in the list, with their least depth or stand-off, and the crew has
 * to say "I understand" before it can be steered. Shallow stretches at the
 * very ends are dotted: "check depth here".
 *
 * **It plans at chart datum, and says what the data is.** Tide is beside the
 * route, never in it; NOAA ENC is for display, not a certified navigation
 * product, and the note under every route says so.
 */

/** Which end of the route a chart tap is filling in. */
type Picking = 'start' | 'dest' | null

/** Which end a sheet is editing, and how. */
type SheetKind =
  | { end: 'start' | 'dest'; how: 'coords' }
  | { end: 'dest'; how: 'waypoint' }
  | null

export function ChartTab() {
  const fmt = useFormat()
  const fix = useTracker((s) => s.fix)
  const trail = useTracker((s) => s.trail)
  const arrivalFt = useTracker((s) => s.arrivalFt)
  const setArrivalFt = useTracker((s) => s.setArrivalFt)
  // Everyone else on this search, drawn on the map below.
  const units = useIncidentUnits()
  const commandPicture = useIncidentOverlay()
  const online = useOnline()
  const activeTeamId = useTeams((s) => s.activeTeamId)

  const vessels = useVessels()
  const boat = vessels.active(activeTeamId)
  const scopeBoats = vessels.inScope(activeTeamId)

  const chartStatus = useChartData((s) => s.status)
  const chartCoverage = useChartData((s) => s.features.coverage)
  const createWaypoint = useWaypoints((s) => s.create)
  const allWaypoints = useWaypoints((s) => s.visible())
  const incident = useIncidents((s) => s.activeIncident(activeTeamId))
  const tideExtremes = useTides((s) => s.extremes)
  const refreshTides = useTides((s) => s.refresh)
  const bearingPref = useHeading((s) => s.reference)
  const format = useCoordFormat((s) => s.format)

  const dest = useNavigation((s) => s.dest)
  const origin = useNavigation((s) => s.origin)
  const plan = useNavigation((s) => s.plan)
  const status = useNavigation((s) => s.status)
  const targetIdx = useNavigation((s) => s.targetIdx)
  const navError = useNavigation((s) => s.error)
  const confirmed = useNavigation((s) => s.confirmed)
  const lastPlannedAt = useNavigation((s) => s.lastPlannedAt)
  const setDestination = useNavigation((s) => s.setDestination)
  const setOrigin = useNavigation((s) => s.setOrigin)
  const replan = useNavigation((s) => s.replan)
  const startNav = useNavigation((s) => s.start)
  const confirmBestEffort = useNavigation((s) => s.confirmBestEffort)
  const clearNav = useNavigation((s) => s.clear)

  const [base, setBase] = useState<MapBase>('chart')
  const [seamarks, setSeamarks] = useState(true)
  const [picking, setPicking] = useState<Picking>(null)
  const [sheet, setSheet] = useState<SheetKind>(null)
  const [draft, setDraft] = useState({ lat: NaN, lon: NaN })
  const [editing, setEditing] = useState(false)
  /** The "Change start" controls are open — planning ahead from elsewhere. */
  const [changingStart, setChangingStart] = useState(false)
  const now = useNow(30_000)

  // Loading once on mount is enough; the store is offline-first and the cache
  // is what plans routes.
  const loadVessels = vessels.load
  useEffect(() => {
    void loadVessels()
  }, [loadVessels])

  // The tide at the destination — information beside the route, never an
  // input to it. Refreshed whenever the destination moves.
  useEffect(() => {
    if (dest) void refreshTides(dest.lat, dest.lon)
  }, [dest?.lat, dest?.lon, refreshTides])

  const waypoints = useMemo(
    () =>
      allWaypoints.filter((w) =>
        activeTeamId ? w.team_id === activeTeamId : w.team_id === null,
      ),
    [allWaypoints, activeTeamId],
  )

  const steering = status === 'navigating' || status === 'arrived'
  const routeOk = hasRoute(plan)
  const mustConfirm = needsConfirmation(plan)

  /*
   * The route as the map draws it. Previewing: framed whole, every leg
   * "ahead". Steering: following the boat, legs behind faded, the leg being
   * run bright, the waypoint being steered to ringed.
   */
  const shownTarget = steering ? targetIdx : null
  const navRoute = useMemo(() => {
    if (!plan || !routeOk) return null
    return {
      segments: routeSegments(plan, shownTarget),
      marks: routeMarks(plan.points, shownTarget),
      view: (steering ? 'follow' : 'fit') as 'follow' | 'fit',
      fitKey: lastPlannedAt,
    }
  }, [plan, routeOk, shownTarget, steering, lastPlannedAt])

  const declination = useMemo(
    () =>
      bearingPref === 'magnetic' && plan && plan.points.length > 0
        ? declinationFor(plan.points[0].lat, plan.points[0].lon)
        : null,
    [bearingPref, plan],
  )
  const rows = useMemo(
    () => (plan ? legRows(plan.legs, { formatDepth: (m) => fmt.depth(m) }) : []),
    [plan, fmt],
  )
  const summary = useMemo(
    () =>
      plan && routeOk
        ? routeSummary(plan, {
            cruiseKn: boat?.cruise_speed_kn ?? null,
            now: now.getTime(),
            formatLength: fmt.length,
          })
        : null,
    [plan, routeOk, boat?.cruise_speed_kn, now, fmt],
  )

  /** Start steering; if the store refuses, say why. */
  function start() {
    if (!startNav()) {
      const why = useNavigation.getState().error
      toast(why ?? 'Nothing to steer yet.', 'error')
    }
  }

  async function saveRoute() {
    if (!plan || !routeOk) return
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

  function chooseDest(place: Place) {
    void setDestination(place)
  }
  function chooseStart(place: Place | null) {
    void setOrigin(place)
  }

  /** What a button under "No route" does. */
  function act(a: FailureAction) {
    if (a === 'retry') void replan('retry')
    else if (a === 'edit-boat' || a === 'add-boat') setEditing(true)
    else if (a === 'pick-dest') setPicking('dest')
    else if (a === 'change-start') setChangingStart(true)
  }

  const tide = useMemo(() => tideNow(now, tideExtremes), [now, tideExtremes])

  /*
   * The water over chart datum right now, and whether the crew wants it added
   * to what they are reading.
   *
   * Display only, and the distinction is load-bearing: `routing.ts` plans at
   * chart datum on purpose, because a route that depends on the tide being in
   * is a grounding waiting for a delay, a wrong prediction or a northerly
   * blowing the water out. So this changes the numbers on the card and never
   * the ones the router used — and the card says which it is showing, every
   * time, rather than leaving a crew to remember which way the toggle was set.
   */
  const [withTide, setWithTide] = useState(false)
  const tideFt = useMemo(() => tideHeightNow(now, tideExtremes), [now, tideExtremes])
  const tideOffsetM = withTide && tideFt != null ? tideFt * FEET_TO_M : 0

  /**
   * The passage at each speed the boat has.
   *
   * A coxswain's real question is not "how long" but "how long if I push it".
   * Fuel is shown on the cruise row only: `fuel_burn_gph` is burn **at
   * cruise**, and burn climbs steeply with speed.
   */
  const paces = useMemo(() => {
    if (!plan || !routeOk || !boat) return []
    const out: { id: string; label: string; kn: number; hours: number; fuel: number | null }[] = []
    const add = (id: string, label: string, kn: number, fuel: boolean) => {
      if (!(kn > 0) || out.some((r) => r.kn === kn)) return
      const hours = plan.totalNM / kn
      out.push({ id, label, kn, hours, fuel: fuel ? fuelForHours(boat, hours) : null })
    }
    add('cruise', 'cruise', boat.cruise_speed_kn, true)
    add('top', 'flat out', boat.max_speed_kn, false)
    return out
  }, [plan, routeOk, boat])

  const failure =
    status === 'failed' || (plan && !routeOk && status !== 'planning')
      ? planFailureView({
          error: navError,
          plan,
          hasBoat: !!boat,
          online,
          originSet: origin !== null,
        })
      : null

  const boatCard = (
    <Card className="p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="block text-xs font-semibold tracking-wide text-slate-400 uppercase">
            Boat
          </span>
          {boat ? (
            <span className="block truncate text-sm text-slate-100">
              <span className="font-semibold">{boat.name || 'Unnamed boat'}</span>
              <span className="text-slate-300">
                {' · needs '}
                {fmt.depth(safeDepthM(boat))}
                {' · '}
                {boat.cruise_speed_kn} kn
              </span>
            </span>
          ) : (
            <span className="block text-sm text-slate-300">
              Add your boat — nothing is planned without a draft.
            </span>
          )}
        </div>
        {scopeBoats.length > 0 ? (
          <Button
            variant="ghost"
            className="shrink-0 px-3"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? 'Done' : 'Edit'}
          </Button>
        ) : null}
      </div>

      {scopeBoats.length > 1 && (
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {scopeBoats.map((v) => (
            <button
              key={v.id}
              onClick={() => vessels.setActive(v.id)}
              aria-pressed={v.id === boat?.id}
              className={
                'min-h-11 rounded-lg border px-2 py-1.5 text-left text-xs font-semibold ' +
                (v.id === boat?.id
                  ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                  : 'border-white/10 text-slate-300 hover:bg-white/5')
              }
            >
              {v.name || 'Unnamed boat'}
              <span className="block font-normal text-slate-400">
                {fmt.depth(v.draft_m)} draft
              </span>
            </button>
          ))}
        </div>
      )}

      {(editing || scopeBoats.length === 0) && (
        <VesselForm
          key={boat?.id ?? 'new'}
          vessel={boat}
          teamId={activeTeamId}
          onDone={() => setEditing(false)}
        />
      )}
      {boat && (editing || scopeBoats.length === 0) ? (
        <p className="mt-2 text-[11px] text-slate-400">
          Saving the boat re-plans the route for its new draft, stand-off and speed.
        </p>
      ) : null}
    </Card>
  )

  const arrivalSetting = (
    <div className="mt-3 rounded-lg border border-white/10 px-3 py-2">
      <span className="mb-1.5 block text-xs font-semibold text-slate-300">
        Waypoint reached within
      </span>
      <Segmented
        label="Arrival distance"
        value={String(arrivalFt)}
        onChange={(v) => setArrivalFt(Number(v) as ArrivalFt)}
        options={ROUTE_ARRIVAL_FT_CHOICES.map((ft) => ({
          id: String(ft),
          label: `${ft} ft`,
        }))}
      />
      <p className="mt-1.5 text-[11px] text-slate-400">
        {arrivalSettingNote(arrivalFt, ROUTE_ARRIVAL_FT_CHOICES)}
      </p>
    </div>
  )

  return (
    <div className="space-y-3">
      {steering ? <NavCard /> : null}

      {!steering && (
        <>
          <h2 className="text-lg font-semibold text-slate-50">Chart plotter</h2>
          <p className="text-sm text-slate-300">
            Pick where you are going. The route is planned from where you are,
            round the shoals and hazards for your boat — then press Start.
          </p>
        </>
      )}

      {!steering && boatCard}

      {/* ---------------------------------------------------- where to */}
      {!steering && (
        <Card className="p-3">
          {/* Called, not rendered as <EndRow/>: a component declared inside
              another is a new type every render, so React would remount these
              rows — and the chip you just tapped would lose focus. */}
          {endRow({ end: 'dest', label: 'To', place: dest, onClear: clearNav })}
          <div className="my-2 h-px bg-white/10" />
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
              From
            </span>
            {!changingStart && !origin ? (
              <button
                onClick={() => setChangingStart(true)}
                className="text-xs font-semibold text-slate-400 hover:text-slate-200"
              >
                Change start
              </button>
            ) : null}
          </div>
          <p className="truncate text-sm text-slate-100">
            {origin ? origin.label : 'My location'}
            {origin ? (
              <span className="tnum block truncate text-xs text-slate-400">
                {formatPlace(origin, format)}
              </span>
            ) : null}
          </p>
          {origin ? (
            <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-200">
              Planned from here, not from where you are — for planning ahead.
              Steering still follows your live position.
            </p>
          ) : null}
          {changingStart || origin
            ? endRow({
                end: 'start',
                label: '',
                place: null,
                onClear: () => chooseStart(null),
              })
            : null}
        </Card>
      )}

      {/* ----------------------------------------------------------- chart */}
      <Card className="p-3">
        <Segmented
          label="Base layer"
          value={base}
          onChange={setBase}
          options={[
            { id: 'chart' as MapBase, label: 'Chart' },
            { id: 'satellite' as MapBase, label: 'Satellite' },
            {
              id: 'hybrid' as MapBase,
              label: 'Hybrid',
              hint: 'The chart blended over the satellite imagery, half and half',
            },
          ]}
          className="mb-2"
        />
        <div className="mb-2 flex items-center justify-between gap-2">
          <RouteLegend />
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSeamarks((v) => !v)}
              aria-pressed={seamarks}
              className={
                'min-h-9 rounded-lg border px-2 py-1.5 text-xs font-semibold ' +
                (seamarks
                  ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                  : 'border-white/10 text-slate-300 hover:bg-white/5')
              }
            >
              Buoys
            </button>
            <span className="tnum text-xs text-slate-400">
              {chartStatus === 'loading'
                ? 'depths…'
                : chartStatus === 'ready'
                  ? chartCoverage
                  : chartStatus === 'error'
                    ? 'chart failed'
                    : ''}
            </span>
          </div>
        </div>

        <SatelliteMap
          trail={trail}
          fix={fix}
          base={base}
          seamarks={seamarks}
          navRoute={navRoute}
          routeUnverified={routeOk && mustConfirm}
          units={units}
          incident={commandPicture}
          markers={[
            ...(origin
              ? [{ id: 'start', name: 'START', lat: origin.lat, lon: origin.lon }]
              : []),
            ...(dest && !routeOk
              ? [{ id: 'dest', name: dest.label, lat: dest.lat, lon: dest.lon }]
              : []),
          ]}
          onPick={
            picking
              ? (p) => {
                  const place = { ...p, label: 'Picked on chart' }
                  if (picking === 'start') chooseStart(place)
                  else chooseDest(place)
                  setPicking(null)
                }
              : undefined
          }
          pickHint={
            picking === 'start'
              ? 'Tap the chart where you are starting from'
              : picking === 'dest'
                ? 'Tap the chart where you want to go'
                : undefined
          }
          height={steering ? 380 : 320}
        />

        {picking ? (
          <Button variant="primary" className="mt-2 w-full" onClick={() => setPicking(null)}>
            Cancel pick
          </Button>
        ) : null}
      </Card>

      {/* ----------------------------------------------------------- route */}
      <Card>
        <div className="flex items-start justify-between gap-2">
          <Label>Route</Label>
          {plan && routeOk ? (
            <span className="tnum mb-1.5 text-xs text-slate-400">
              {plan.legs.length} leg{plan.legs.length === 1 ? '' : 's'}
              {mustConfirm ? ' · not fully safe' : ''}
            </span>
          ) : null}
        </div>

        {status === 'idle' && !dest ? (
          <p className="text-sm text-slate-300">
            Where to? Set a destination above — or press and hold any map in
            the app and choose <strong>Navigate here</strong>.
          </p>
        ) : null}

        {status === 'planning' ? (
          <p className="flex items-center gap-2 text-sm text-slate-200" role="status">
            <Spinner />
            {`Finding a safe route from ${origin ? origin.label.toLowerCase() : 'your position'}…`}
          </p>
        ) : null}

        {/* No honest route: no line, the plain reason, what to change, Retry. */}
        {failure ? (
          <div>
            <p className="text-base font-semibold text-red-100">{failure.title}</p>
            <p className="mt-1 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
              {failure.reason}
            </p>
            {failure.hints.map((h) => (
              <p
                key={h}
                className="mt-1.5 rounded-lg border border-amber-400/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-100"
              >
                {h}
              </p>
            ))}
            <div className="mt-2 grid grid-cols-2 gap-2">
              {failure.actions.map((a) => (
                <Button
                  key={a}
                  variant={a === 'retry' || a === 'add-boat' ? 'primary' : 'ghost'}
                  className={a === 'retry' ? 'col-span-2' : ''}
                  onClick={() => act(a)}
                >
                  {ACTION_LABEL[a]}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {plan && routeOk && summary ? (
          <>
            {/* The summary, Google-Maps style, and the one button that matters. */}
            {!steering ? (
              <>
                <p className="tnum text-xl font-semibold text-slate-50">{summary.line}</p>
                {dest ? (
                  <p className="truncate text-xs text-slate-400">to {dest.label}</p>
                ) : null}
              </>
            ) : null}

            {navError && status === 'preview' ? (
              <p className="mt-2 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                {navError}
              </p>
            ) : null}

            {mustConfirm ? (
              <div className="mt-2 rounded-lg border border-red-400/50 bg-red-500/10 px-3 py-2 text-sm text-red-100">
                <strong className="font-semibold">Not a fully safe route.</strong>{' '}
                {plan.warnings[0] ??
                  'No route keeps your depth and stand-off the whole way.'}{' '}
                The legs that break them are red on the map and below.
              </div>
            ) : null}

            {status === 'preview' ? (
              mustConfirm && !confirmed ? (
                <Button
                  variant="danger"
                  className="mt-3 min-h-14 w-full text-base"
                  onClick={() => {
                    // Accepting one route's problems is not accepting the next
                    // one's — the store forgets this with every new plan.
                    confirmBestEffort()
                    start()
                  }}
                >
                  I understand — start anyway
                </Button>
              ) : (
                <Button
                  variant={mustConfirm ? 'danger' : 'primary'}
                  className="mt-3 min-h-14 w-full text-lg"
                  onClick={start}
                >
                  Start
                </Button>
              )
            ) : null}

            <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              <strong className="font-semibold">Not for navigation.</strong>{' '}
              Charted depths are at mean lower low water and were not surveyed
              for your passage. Check this against the chart and your own eyes
              before you run it.
            </p>

            {plan.warnings.slice(mustConfirm ? 1 : 0).map((w) => (
              <p
                key={w}
                className="mt-1.5 rounded-lg border border-amber-400/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-100"
              >
                {w}
              </p>
            ))}

            <div className="mt-2 space-y-1">
              {rows.map((leg) => {
                const behind = steering && targetIdx != null && leg.n < targetIdx
                const current = steering && targetIdx != null && leg.n === targetIdx
                const src = plan.legs[leg.n - 1]
                return (
                  <div
                    key={leg.n}
                    className={
                      'flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm ' +
                      (leg.flagged
                        ? 'border-red-400/50 bg-red-500/10'
                        : leg.dotted
                          ? 'border-dashed border-amber-400/60'
                          : current
                            ? 'border-sky-400/50 bg-sky-500/10'
                            : 'border-white/10') +
                      (behind ? ' opacity-50' : '')
                    }
                  >
                    <span className="tnum text-slate-100">
                      {leg.n}. {bearingText(leg.courseDeg, bearingPref, declination)}
                    </span>
                    <span className="tnum text-right text-xs text-slate-300">
                      {fmt.length(leg.lengthNM)}
                      {src?.minChartedDepthM != null
                        ? ` · ${fmt.depth(src.minChartedDepthM + tideOffsetM)} least`
                        : ' · not charted'}
                      {/* Null means nothing is marked in this area at all,
                          which is not the same as being outside the channel. */}
                      {src?.channelFraction != null && src.channelFraction < 0.5 ? (
                        <span className="text-amber-200"> · outside channel</span>
                      ) : null}
                      {leg.note ? (
                        <span
                          className={
                            'block font-semibold ' +
                            (leg.flagged ? 'text-red-200' : 'text-amber-200')
                          }
                        >
                          {leg.note}
                        </span>
                      ) : null}
                    </span>
                  </div>
                )
              })}
            </div>

            {!steering && paces.length > 0 ? (
              <div className="mt-2 overflow-hidden rounded-xl border border-white/10">
                <div className="grid grid-cols-3 gap-px bg-white/10 text-[11px] font-semibold tracking-wide text-slate-300 uppercase">
                  <div className="bg-navy-900/60 px-3 py-1.5">Speed</div>
                  <div className="bg-navy-900/60 px-3 py-1.5">Time to run</div>
                  <div className="bg-navy-900/60 px-3 py-1.5">Arrive</div>
                </div>
                {paces.map((p) => (
                  <div key={p.id} className="grid grid-cols-3 gap-px bg-white/10">
                    <div className="bg-navy-900/60 px-3 py-2">
                      <div className="tnum text-sm font-semibold text-slate-50">{p.kn} kn</div>
                      <div className="text-[11px] text-slate-400">{p.label}</div>
                    </div>
                    <div className="bg-navy-900/60 px-3 py-2">
                      <div className="tnum text-sm font-semibold text-slate-50">
                        {Number.isFinite(p.hours) ? formatDuration(p.hours) : '—'}
                      </div>
                      {p.fuel !== null ? (
                        <div className="text-[11px] text-slate-400">{p.fuel.toFixed(0)} gal</div>
                      ) : null}
                    </div>
                    <div className="bg-navy-900/60 px-3 py-2">
                      <div className="tnum text-sm font-semibold text-slate-50">
                        {formatEtaClock(p.hours) || '—'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {tideFt != null && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-white/10 px-3 py-2">
                <span className="text-xs text-slate-300">
                  Add the tide to these depths
                  <span className="tnum block text-[11px] text-slate-400">
                    {formatTideHeight(tideFt)} over chart datum now, near the destination
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={withTide}
                  aria-label="Add the tide to the charted depths"
                  onClick={() => setWithTide((v) => !v)}
                  className={
                    'min-h-9 shrink-0 rounded-lg border px-3 text-xs font-semibold ' +
                    (withTide
                      ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-200'
                      : 'border-white/15 text-slate-200 hover:bg-white/5')
                  }
                >
                  {withTide ? 'Tide added' : 'Chart datum'}
                </button>
              </div>
            )}

            {tide.next && (
              <p className="mt-2 text-xs text-slate-400">
                Tide at the destination {tide.trend} · next{' '}
                {tide.next.type === 'H' ? 'high' : 'low'} {formatTideClock(tide.next.at)} at{' '}
                {formatTideHeight(tide.next.heightFt)}.{' '}
                {withTide ? (
                  <span className="text-amber-200">
                    Depths above are <strong>predicted for now</strong>, not
                    charted — the route itself was planned at chart datum and
                    has not changed. Wind can take the tide away.
                  </span>
                ) : (
                  <>
                    Depths above are at chart datum, so there is normally more
                    water than this — never less by design, but wind can take it
                    away.
                  </>
                )}
              </p>
            )}

            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button variant="ghost" onClick={() => void saveRoute()}>
                Save as waypoints
              </Button>
              {!steering ? (
                <Button variant="ghost" onClick={clearNav}>
                  Clear route
                </Button>
              ) : null}
            </div>
          </>
        ) : null}

        {arrivalSetting}
      </Card>

      {steering && boatCard}

      {sheet ? (
        <Sheet
          label={
            sheet.how === 'waypoint'
              ? 'Choose a saved waypoint'
              : sheet.end === 'start'
                ? 'Enter the start position'
                : 'Enter the destination'
          }
          onDismiss={() => setSheet(null)}
        >
          {sheet.how === 'coords' ? (
            <>
              <Label>{sheet.end === 'start' ? 'Start position' : 'Destination'}</Label>
              <CoordInput
                label={sheet.end === 'start' ? 'Start' : 'Destination'}
                value={draft}
                onChange={setDraft}
                onUseFix={fix ? () => setDraft({ lat: fix.lat, lon: fix.lon }) : undefined}
                fixLabel="Fill from my current position"
              />
              <div className="mt-3 mb-3 grid grid-cols-2 gap-2">
                <Button variant="ghost" onClick={() => setSheet(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!Number.isFinite(draft.lat) || !Number.isFinite(draft.lon)}
                  onClick={() => {
                    const place = { lat: draft.lat, lon: draft.lon, label: 'Typed position' }
                    if (sheet.end === 'start') chooseStart(place)
                    else chooseDest(place)
                    setSheet(null)
                  }}
                >
                  Use this position
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <Label>Saved waypoints</Label>
                <AddWaypointButton label="Add waypoint" compact />
              </div>
              {waypoints.length === 0 ? (
                <EmptyState>No saved waypoints in this scope yet.</EmptyState>
              ) : (
                <div className="mb-3 space-y-1">
                  {waypoints.slice(0, 60).map((w) => (
                    <button
                      key={w.id}
                      onClick={() => {
                        chooseDest({ lat: w.lat, lon: w.lon, label: w.name })
                        setSheet(null)
                      }}
                      className="min-h-11 w-full rounded-lg border border-white/10 px-3 py-2 text-left hover:bg-white/5"
                    >
                      <span className="block text-sm text-slate-100">{w.name}</span>
                      <span className="tnum block text-xs text-slate-400">
                        {formatPlace(w, format)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </Sheet>
      ) : null}
    </div>
  )

  /**
   * One end of the route: where it is, and the ways to set it.
   *
   * The destination row is the primary one. The start row only appears once
   * the crew asks to "Change start" — the route starts from the boat's live
   * position unless they are planning ahead from somewhere else.
   */
  function endRow({
    end,
    label,
    place,
    onClear,
  }: {
    end: 'start' | 'dest'
    label: string
    place: Place | null
    onClear: () => void
  }) {
    const picked = picking === end
    const lkp =
      end === 'dest' && incident?.lkp_lat != null && incident?.lkp_lng != null
        ? incident
        : null

    return (
      <div>
        {label ? (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
              {label}
            </span>
            {place ? (
              <button
                onClick={onClear}
                className="text-xs font-semibold text-slate-400 hover:text-slate-200"
              >
                Clear
              </button>
            ) : null}
          </div>
        ) : null}

        {end === 'dest' ? (
          <>
            <p className={'truncate text-sm ' + (place ? 'text-slate-100' : 'text-slate-400')}>
              {place ? place.label : 'Where to?'}
            </p>
            {place ? (
              <p className="tnum truncate text-xs text-slate-400">{formatPlace(place, format)}</p>
            ) : null}
          </>
        ) : null}

        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {end === 'start' ? (
            <Chip
              active={origin === null}
              onClick={() => {
                chooseStart(null)
                setChangingStart(false)
              }}
            >
              My location
            </Chip>
          ) : null}
          <Chip active={picked} onClick={() => setPicking(picked ? null : end)}>
            {picked ? 'Tap chart…' : 'Map'}
          </Chip>
          <Chip
            onClick={() => {
              setDraft(place ? { lat: place.lat, lon: place.lon } : { lat: NaN, lon: NaN })
              setSheet({ end, how: 'coords' })
            }}
          >
            Coords
          </Chip>
          {end === 'dest' && waypoints.length > 0 ? (
            <Chip onClick={() => setSheet({ end: 'dest', how: 'waypoint' })}>Waypoint</Chip>
          ) : null}
          {lkp ? (
            <Chip
              onClick={() =>
                chooseDest({
                  lat: lkp.lkp_lat as number,
                  lon: lkp.lkp_lng as number,
                  label: `LKP — ${lkp.incident_name}`,
                })
              }
            >
              LKP
            </Chip>
          ) : null}
        </div>
      </div>
    )
  }
}

const ACTION_LABEL: Record<FailureAction, string> = {
  retry: 'Retry',
  'edit-boat': 'Edit boat',
  'add-boat': 'Add your boat',
  'pick-dest': 'Pick another point',
  'change-start': 'Change start',
}

/** What the lines on the map mean — three words each, beside the map. */
function RouteLegend() {
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-400">
      <span className="flex items-center gap-1">
        <svg width="18" height="6" aria-hidden>
          <line x1="1" y1="3" x2="17" y2="3" stroke="#38bdf8" strokeWidth="3" strokeLinecap="round" />
        </svg>
        route
      </span>
      <span className="flex items-center gap-1">
        <svg width="18" height="6" aria-hidden>
          <line
            x1="2"
            y1="3"
            x2="17"
            y2="3"
            stroke="#fcd34d"
            strokeWidth="3"
            strokeDasharray="0.1 5"
            strokeLinecap="round"
          />
        </svg>
        check depth
      </span>
      <span className="flex items-center gap-1">
        <svg width="18" height="6" aria-hidden>
          <line x1="1" y1="3" x2="17" y2="3" stroke="#f87171" strokeWidth="3" strokeLinecap="round" />
        </svg>
        not safe
      </span>
    </span>
  )
}

/** A small pill in an end row. Same shape as the app's segmented options. */
function Chip({
  children,
  onClick,
  active = false,
}: {
  children: React.ReactNode
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={
        'min-h-9 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ' +
        (active
          ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
          : 'border-white/10 text-slate-300 hover:bg-white/5')
      }
    >
      {children}
    </button>
  )
}

/** A position on one line, in whichever format the crew reads. */
function formatPlace(
  p: { lat: number; lon: number },
  format: 'dd' | 'ddm' | 'dms',
): string {
  if (format === 'dd') return `${toDD(p.lat)}, ${toDD(p.lon)}`
  if (format === 'dms') {
    return `${toDMS(p.lat, 'lat')}  ${toDMS(p.lon, 'lon')}`
  }
  return `${toDDM(p.lat, 'lat')}  ${toDDM(p.lon, 'lon')}`
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
  const fmt = useFormat()
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
        <Field
          label="Boat name"
          placeholder="Fire boat 2"
          value={form.name}
          onChange={set('name')}
        />
        <Field
          label="Callsign"
          placeholder="FB2"
          value={form.callsign}
          onChange={set('callsign')}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field
          label="Draft (ft)"
          inputMode="decimal"
          placeholder={(VESSEL_DEFAULTS.draft_m * 3.280839895).toFixed(1)}
          value={form.draftFt}
          onChange={set('draftFt')}
        />
        <Field
          label="Under-keel margin (ft)"
          inputMode="decimal"
          placeholder={(
            VESSEL_DEFAULTS.under_keel_margin_m * 3.280839895
          ).toFixed(1)}
          value={form.marginFt}
          onChange={set('marginFt')}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field
          label="Cruise speed (kn)"
          inputMode="decimal"
          placeholder="20"
          value={form.cruise}
          onChange={set('cruise')}
        />
        <Field
          label="Top speed (kn)"
          inputMode="decimal"
          placeholder="35"
          value={form.max}
          onChange={set('max')}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field
          label="Height above water (ft)"
          hint="Tallest point — mast, antenna, light bar. For bridge clearance."
          inputMode="decimal"
          placeholder="0"
          value={form.airDraftFt}
          onChange={set('airDraftFt')}
        />
        <Field
          label="Stand-off from hazards (ft)"
          inputMode="decimal"
          placeholder="100"
          value={form.clearanceFt}
          onChange={set('clearanceFt')}
        />
      </div>
      <Field
        label="Fuel burn at cruise (gal/h) — optional"
        inputMode="decimal"
        placeholder="Leave blank if you do not track it"
        value={form.burn}
        onChange={set('burn')}
      />
      <p className="text-xs text-slate-400">
        Draft plus the under-keel margin is the depth the plotter will not go
        below: {fmt.depthBoth(ft(form.draftFt, VESSEL_DEFAULTS.draft_m) + ft(form.marginFt, VESSEL_DEFAULTS.under_keel_margin_m))}.
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
