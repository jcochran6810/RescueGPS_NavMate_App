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
import { toDD, toDDM, toDMS } from '@/lib/coords'
import { useCoordFormat } from '@/store/useCoordFormat'
import { CoordInput } from '@/components/CoordInput'
import { Sheet } from '@/components/Sheet'
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
import { Button, Card, EmptyState, Input, Label, Segmented, Spinner, Stat } from '@/components/ui'

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

type Place = {
  lat: number
  lon: number
  label: string
}

/** Which end of the route a chart tap is filling in. */
type Picking = 'start' | 'dest' | null

/** Which end a sheet is editing, and how. */
type SheetKind =
  | { end: 'start' | 'dest'; how: 'coords' }
  | { end: 'dest'; how: 'waypoint' }
  | null

/** Debounce before auto-plotting. Long enough that dragging the map or
 *  typing a coordinate does not fire a chart fetch on every keystroke. */
const PLOT_DEBOUNCE_MS = 400

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

  const format = useCoordFormat((s) => s.format)

  const [base, setBase] = useState<MapBase>('chart')
  const [seamarks, setSeamarks] = useState(true)
  const [picking, setPicking] = useState<Picking>(null)
  const [start, setStart] = useState<Place | null>(null)
  const [dest, setDest] = useState<Place | null>(null)
  const [sheet, setSheet] = useState<SheetKind>(null)
  const [draft, setDraft] = useState({ lat: NaN, lon: NaN })
  const [plan, setPlan] = useState<RoutePlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
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

  const arrivalFt = tracker.arrivalFt
  const speedKn = boat?.cruise_speed_kn ?? 0
  const running = targetIdx !== null && plan !== null

  /* Auto-advance down the route, exactly as the search pattern does. */
  useEffect(() => {
    if (!running || !plan || targetIdx === null || !fix) return
    if (shouldAdvance(plan, targetIdx, fix, arrivalFt)) setTargetIdx(targetIdx + 1)
  }, [running, plan, targetIdx, fix, arrivalFt])

  /*
   * Moving either end invalidates the route that joined the old ones — and
   * then plots the new one. The crew asked for two points, not for two points
   * and a button; the course belongs on the chart as soon as both ends exist.
   *
   * Debounced because plotting fetches chart data: without it, dragging a
   * destination across the map would fire a NOAA query per frame.
   */
  useEffect(() => {
    setPlan(null)
    setTargetIdx(null)
    setPlanError(null)
    if (!start || !dest || !boat) return
    const t = setTimeout(() => void plot(), PLOT_DEBOUNCE_MS)
    return () => clearTimeout(t)
    // Deliberately keyed on the endpoint coordinates and the boat rather than
    // on `plot` itself: `plot` is re-created every render, and depending on it
    // would re-arm the timer forever. It reads what it needs from the render
    // it was made in, and its own guard stops two runs overlapping.
  }, [start?.lat, start?.lon, dest?.lat, dest?.lon, boat?.id])

  /** Take a one-shot GPS fix and use it as the start point. */
  async function startHere() {
    const got = fix ?? (await tracker.once())
    if (!got) {
      toast(useTracker.getState().error ?? 'No GPS fix yet', 'error')
      return
    }
    setStart({ lat: got.lat, lon: got.lon, label: 'Current location' })
  }

  /**
   * Is the chosen start still where the boat is? Steering always follows the
   * live fix, so a route planned from somewhere else needs saying out loud.
   */
  const startIsHere =
    !!start && !!fix && haversineNM(fix.lat, fix.lon, start.lat, start.lon) < 0.1

  async function plot() {
    if (!start || !dest || !boat || planning) return
    setPlanning(true)
    setPlanError(null)
    try {
      const bounds = routeBounds(start, dest)
      const features = await chart.load(bounds)
      const next = planRoute({
        from: { lat: start.lat, lon: start.lon },
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
    } catch (e) {
      // Plotting used to be a button press, so a throw here surfaced as a
      // rejected click. Now that it runs from an effect, an unhandled one
      // would be a screen that silently never shows a course.
      setPlanError(
        e instanceof Error ? e.message : 'Could not reach the chart service.',
      )
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
      {/* One line, not a card of tiles. The boat has to be here — nothing is
          planned without a draft — but it is set once a season, and it was
          pushing the chart off the screen every time. */}
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
                  {formatFeet(safeDepthM(boat))}
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
                  {formatFeet(v.draft_m)} draft
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
      </Card>

      {/* ---------------------------------------------------- from / to */}
      {/* Both ends together, above the chart, each one line of position and
          one row of ways to set it. This used to be two full cards below the
          map, which meant scrolling past the chart to say where you were
          going and then scrolling back to look at it. */}
      <Card className="p-3">
        {/* Called, not rendered as <EndRow/>: a component declared inside
            another is a new type every render, so React would remount these
            rows — and the chip you just tapped would lose focus. */}
        {endRow({
          end: 'start',
          label: 'From',
          place: start,
          onClear: () => setStart(null),
        })}
        <div className="my-2 h-px bg-white/10" />
        {endRow({
          end: 'dest',
          label: 'To',
          place: dest,
          onClear: () => setDest(null),
        })}
        {start && !startIsHere ? (
          <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-200">
            The course starts where you said, not where you are. Steering still
            follows your live fix.
          </p>
        ) : null}
      </Card>

      {/* ----------------------------------------------------------- chart */}
      <Card className="p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <Segmented
            label="Base layer"
            value={base}
            onChange={setBase}
            options={[
              { id: 'chart' as MapBase, label: 'Chart' },
              { id: 'satellite' as MapBase, label: 'Satellite' },
            ]}
            className="max-w-44"
          />
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
              {chart.status === 'loading'
                ? 'depths…'
                : chart.status === 'ready'
                  ? chart.features.coverage
                  : chart.status === 'error'
                    ? 'no depths'
                    : ''}
            </span>
          </div>
        </div>

        <SatelliteMap
          trail={tracker.trail}
          fix={fix}
          base={base}
          seamarks={seamarks}
          route={plan?.points ?? []}
          markers={[
            ...(start
              ? [{ id: 'start', name: 'START', lat: start.lat, lon: start.lon }]
              : []),
            ...(dest
              ? [{ id: 'dest', name: dest.label, lat: dest.lat, lon: dest.lon }]
              : []),
          ]}
          onPick={
            picking
              ? (p) => {
                  const place = { ...p, label: 'Picked on chart' }
                  if (picking === 'start') setStart(place)
                  else setDest(place)
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
          height={320}
        />

        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button
            variant={picking ? 'primary' : 'ghost'}
            onClick={() => setPicking(null)}
            disabled={!picking}
          >
            {picking ? 'Cancel pick' : 'Tap a chip above to pick'}
          </Button>
          <Button variant="ghost" onClick={() => void takeFix()}>
            Take a fix
          </Button>
        </div>
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

        {/* The course plots itself as soon as both ends and a boat exist, so
            this is a retry rather than the way in. */}
        {planning ? (
          <p className="flex items-center gap-2 text-sm text-slate-300">
            <Spinner /> Plotting…
          </p>
        ) : null}

        {planError ? (
          <>
            <p className="rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-100">
              {planError}
            </p>
            <Button
              variant="primary"
              className="mt-2 w-full"
              onClick={() => void plot()}
            >
              Try again
            </Button>
          </>
        ) : null}

        {!planning && !planError && !boat && (
          <p className="text-xs text-slate-400">
            Add a boat above first — a course means nothing without a draft.
          </p>
        )}
        {!planning && !planError && boat && (!start || !dest) && (
          <p className="text-xs text-slate-400">
            {!start && !dest
              ? 'Set where you are coming from and where you are going, above.'
              : !start
                ? 'Set where you are starting from, above.'
                : 'Now set where you are going, above.'}
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
                    {/* Null means nothing is marked in this area at all,
                        which is not the same as being outside the channel. */}
                    {leg.channelFraction !== null && leg.channelFraction < 0.5 ? (
                      <span className="text-amber-200"> · outside channel</span>
                    ) : null}
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
                onClick={() => {
                  if (running) {
                    setTargetIdx(null)
                    return
                  }
                  setTargetIdx(1)
                  // Steering needs a live position, not the single fix that
                  // set the start point. Without this the fix never changes,
                  // so no leg ever completes and the card sits on leg 1 for
                  // the whole passage — the search patterns have always
                  // started the watch here and this did not.
                  if (!tracker.watching) tracker.start()
                }}
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
              <Label>
                {sheet.end === 'start' ? 'Start position' : 'Destination'}
              </Label>
              <CoordInput
                label={sheet.end === 'start' ? 'Start' : 'Destination'}
                value={draft}
                onChange={setDraft}
                onUseFix={
                  fix ? () => setDraft({ lat: fix.lat, lon: fix.lon }) : undefined
                }
                fixLabel="Fill from my current position"
              />
              <div className="mt-3 mb-3 grid grid-cols-2 gap-2">
                <Button variant="ghost" onClick={() => setSheet(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={
                    !Number.isFinite(draft.lat) || !Number.isFinite(draft.lon)
                  }
                  onClick={() => {
                    const place = {
                      lat: draft.lat,
                      lon: draft.lon,
                      label: 'Typed position',
                    }
                    if (sheet.end === 'start') setStart(place)
                    else setDest(place)
                    setSheet(null)
                  }}
                >
                  Use this position
                </Button>
              </div>
            </>
          ) : (
            <>
              <Label>Saved waypoints</Label>
              {waypoints.length === 0 ? (
                <EmptyState>
                  No saved waypoints in this scope yet.
                </EmptyState>
              ) : (
                <div className="mb-3 space-y-1">
                  {waypoints.slice(0, 60).map((w) => (
                    <button
                      key={w.id}
                      onClick={() => {
                        setDest({ lat: w.lat, lon: w.lon, label: w.name })
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
   * Both ends offer the same two — type it, or tap the chart — with the
   * shortcuts that only make sense for one of them alongside. Nothing here is
   * gated on the other end being set: they are adjacent and equally reachable
   * now, so the old "pick a start first" rule bought nothing and was
   * re-implemented in six places.
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

        <p
          className={
            'tnum truncate text-sm ' +
            (place ? 'text-slate-100' : 'text-slate-400')
          }
        >
          {place ? formatPlace(place, format) : 'Not set'}
        </p>
        {place ? (
          <p className="truncate text-xs text-slate-400">{place.label}</p>
        ) : null}

        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {end === 'start' ? (
            <Chip onClick={() => void startHere()}>Here</Chip>
          ) : null}
          <Chip
            active={picked}
            onClick={() => setPicking(picked ? null : end)}
          >
            {picked ? 'Tap chart…' : 'Map'}
          </Chip>
          <Chip
            onClick={() => {
              setDraft(
                place
                  ? { lat: place.lat, lon: place.lon }
                  : { lat: NaN, lon: NaN },
              )
              setSheet({ end, how: 'coords' })
            }}
          >
            Coords
          </Chip>
          {end === 'dest' && waypoints.length > 0 ? (
            <Chip onClick={() => setSheet({ end: 'dest', how: 'waypoint' })}>
              Waypoint
            </Chip>
          ) : null}
          {lkp ? (
            <Chip
              onClick={() =>
                setDest({
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
