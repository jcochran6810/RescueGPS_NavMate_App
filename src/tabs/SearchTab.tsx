import { useEffect, useMemo, useState } from 'react'
import { useTracker } from '@/store/useTracker'
import { useTeams } from '@/store/useTeams'
import { useSarRecords } from '@/store/useSarRecords'
import { useIncidents } from '@/store/useIncidents'
import { useWaypoints } from '@/store/useWaypoints'
import { useOnline } from '@/hooks/useOnline'
import { useNow } from '@/hooks/useNow'
import { toast } from '@/store/useToast'
import { toDD } from '@/lib/coords'
import { formatDistance, formatDuration } from '@/lib/geo'
import { computeDatum, searchObjectType } from '@/lib/sar'
import {
  expandingSquare,
  expandingSquareLegsFor,
  sectorSearch,
  parallelSweep,
  creepingLine,
  sweepWidthNM,
  coverageFactor,
  podForCoverage,
  patternTimeHours,
  recommendPattern,
  SECTOR_RADIUS_NM,
  SEA_CLASSES,
  PATTERN_NAMES,
  type PatternCode,
  type SeaClass,
  type SearchPatternPlan,
} from '@/lib/search'
import { survivalEstimate, formatSurvivalMinutes, type PfdStatus } from '@/lib/survival'
import { sunEvents } from '@/lib/sun'
import { SatelliteMap } from '@/components/SatelliteMap'
import { SteerCard } from '@/components/SteerCard'
import { shouldAdvance } from '@/lib/steer'
import { IncidentCard } from '@/components/IncidentCard'
import { Button, Card, EmptyState, Input, Label, Stat } from '@/components/ui'
import type { EnvironmentPayload, LkpPayload } from '@/lib/types'

/**
 * Search tools: turn the datum into a pattern a crew can actually steer.
 *
 * The doctrine here is RescueGPS's ontology (IAMSAR Vol II Ch 5): pattern
 * selection by datum quality and drift, track spacing from the visual sweep
 * width for the object and conditions, POD = 1 − e^(−W/S). What deliberately
 * stays behind on the command side is everything heavier — Monte Carlo
 * drift, effort allocation, probability maps. One phone plans and runs one
 * unit's pattern.
 */

export function SearchTab() {
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const incident = useIncidents((s) => s.activeIncident(activeTeamId))
  const { visible, load } = useSarRecords()
  const tracker = useTracker()
  const now = useNow(30_000)
  const online = useOnline()
  const createWaypoint = useWaypoints((s) => s.create)

  useEffect(() => {
    void load()
    void useIncidents.getState().load()
  }, [load])

  const all = visible()
  const records = useMemo(
    () =>
      all.filter((r) =>
        activeTeamId ? r.team_id === activeTeamId : r.team_id === null,
      ),
    [all, activeTeamId],
  )
  const lkp = records.find((r) => r.kind === 'lkp') ?? null
  const lkpPayload = lkp?.payload as LkpPayload | undefined
  const environment = records.find((r) => r.kind === 'environment') ?? null
  const env = environment?.payload as EnvironmentPayload | undefined
  const objectType = searchObjectType(lkpPayload?.object_type ?? 'person_in_water')

  const result = useMemo(() => {
    if (!lkp || lkp.lat == null || lkp.lon == null || !lkpPayload) return null
    return computeDatum({
      lkp: { lat: lkp.lat, lon: lkp.lon, time: new Date(lkp.recorded_at).getTime() },
      at: now.getTime(),
      objectType,
      windFromDeg: env?.wind_from_deg ?? null,
      windKts: env?.wind_kts ?? null,
      currentTowardDeg: env?.current_toward_deg ?? null,
      currentKts: env?.current_kts ?? null,
      lkpErrorNM: lkpPayload.position_error_nm,
    })
  }, [lkp, lkpPayload, objectType, env, now])

  const fix = tracker.fix
  const datum = result?.datum ?? (fix ? { lat: fix.lat, lon: fix.lon } : null)
  const radiusNM = result?.searchRadiusNM ?? 0.5

  /* ------------------------------------------------------------- controls */

  const recommended = recommendPattern({
    radiusNM,
    driftKts: result?.driftKts ?? 0,
  })
  const [codeChoice, setCodeChoice] = useState<PatternCode | null>(null)
  const code = codeChoice ?? recommended.code

  const [sea, setSea] = useState<SeaClass>('calm')
  const daylight = useMemo(() => {
    if (!datum) return true
    const ev = sunEvents(now, datum.lat, datum.lon)
    if (!ev.sunrise || !ev.sunset) return true
    return now >= ev.sunrise && now <= ev.sunset
  }, [datum, now])
  const [nightChoice, setNightChoice] = useState<boolean | null>(null)
  const night = nightChoice ?? !daylight

  const sweepNM = sweepWidthNM(objectType.visibility, { night, sea })
  const [spacingStr, setSpacingStr] = useState('')
  const spacingNM = (() => {
    const n = parseFloat(spacingStr)
    return Number.isFinite(n) && n > 0 ? n : Math.max(0.05, round2(sweepNM))
  })()

  const driftDeg = result && result.driftKts > 0 ? result.driftBearingDeg : 0
  const [orientStr, setOrientStr] = useState('')
  const orientDeg = (() => {
    const n = parseFloat(orientStr)
    return Number.isFinite(n) ? ((n % 360) + 360) % 360 : Math.round(driftDeg)
  })()

  // One sizing input, meaning radius for VS and leg length for PS/CL.
  const [sizeStr, setSizeStr] = useState('')
  const sectorRadius = (() => {
    const n = parseFloat(sizeStr)
    if (Number.isFinite(n) && n > 0) return n
    return Math.min(
      SECTOR_RADIUS_NM.max,
      Math.max(SECTOR_RADIUS_NM.min, round2(radiusNM)),
    )
  })()
  const legLengthNM = (() => {
    const n = parseFloat(sizeStr)
    if (Number.isFinite(n) && n > 0) return n
    return Math.max(0.5, round2(2 * radiusNM))
  })()

  const [speedStr, setSpeedStr] = useState('6')
  const speedKts = (() => {
    const n = parseFloat(speedStr)
    return Number.isFinite(n) && n > 0 ? n : 6
  })()

  const plan: SearchPatternPlan | null = useMemo(() => {
    if (!datum) return null
    if (code === 'SS') {
      return expandingSquare(
        datum,
        spacingNM,
        expandingSquareLegsFor(radiusNM, spacingNM),
        orientDeg,
      )
    }
    if (code === 'VS') return sectorSearch(datum, sectorRadius, orientDeg)
    const numLegs = Math.min(
      40,
      Math.max(2, Math.ceil((2 * radiusNM) / spacingNM)),
    )
    if (code === 'PS') {
      return parallelSweep(datum, legLengthNM, spacingNM, numLegs, orientDeg)
    }
    return creepingLine(datum, legLengthNM, spacingNM, numLegs, orientDeg)
  }, [datum, code, spacingNM, radiusNM, orientDeg, sectorRadius, legLengthNM])

  const coverage = coverageFactor(sweepNM, code === 'VS' ? sectorRadius : spacingNM)
  const pod = podForCoverage(coverage)
  const timeHours = plan
    ? patternTimeHours(plan.totalNM, speedKts, plan.legs.length - 1)
    : Number.NaN

  /* ------------------------------------------------------------- steering */

  const [targetIdx, setTargetIdx] = useState<number | null>(null)
  const running = targetIdx !== null && plan !== null
  const arrivalFt = useTracker((s) => s.arrivalFt)

  // Arriving at the target advances to the next turn point. The arrival
  // circle is the crew's setting (Track tab), floored at whatever the fix
  // itself can resolve — see `shouldAdvance`.
  useEffect(() => {
    if (!running || !fix || !plan) return
    if (shouldAdvance(plan, targetIdx, fix, arrivalFt)) setTargetIdx(targetIdx + 1)
  }, [running, fix, plan, targetIdx, arrivalFt])

  /* --------------------------------------------------------------- render */

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Search pattern</h2>
        <p className="text-sm text-slate-300">
          Pick a pattern around the datum, size the track spacing to what a
          lookout can actually see, and steer it leg by leg.
        </p>
      </div>

      <IncidentCard />

      {!datum ? (
        <Card>
          <Label>Pattern</Label>
          <EmptyState>
            The pattern plans around the datum. Record an LKP in Search datum —
            or take a fix to plan around your own position.
          </EmptyState>
          <Button
            variant="primary"
            className="mt-2 w-full"
            onClick={async () => {
              const f = await tracker.once()
              if (!f) toast(useTracker.getState().error ?? 'No GPS fix', 'error')
            }}
          >
            Use my position
          </Button>
        </Card>
      ) : (
        <>
          <Card>
            <div className="flex items-start justify-between gap-2">
              <Label>Pattern</Label>
              <span className="tnum mb-1.5 text-xs text-slate-400">
                Datum {toDD(datum.lat, 4)}, {toDD(datum.lon, 4)}
                {result ? '' : ' (your position)'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              {(Object.keys(PATTERN_NAMES) as PatternCode[]).map((c) => (
                <button
                  key={c}
                  onClick={() => setCodeChoice(c === recommended.code ? null : c)}
                  className={
                    'rounded-lg border px-2 py-1.5 text-left text-xs font-semibold ' +
                    (c === code
                      ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                      : 'border-white/10 text-slate-300 hover:bg-white/5')
                  }
                >
                  {PATTERN_NAMES[c]}
                  {c === recommended.code && (
                    <span className="ml-1 font-normal text-slate-400">
                      · suggested
                    </span>
                  )}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-slate-400">{recommended.why}</p>

            <div className="mt-2 flex gap-1">
              {SEA_CLASSES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSea(s.id)}
                  className={
                    'flex-1 rounded-lg border px-1 py-1.5 text-[11px] font-semibold ' +
                    (sea === s.id
                      ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                      : 'border-white/10 text-slate-300 hover:bg-white/5')
                  }
                >
                  {s.label}
                </button>
              ))}
              <button
                onClick={() => setNightChoice(nightChoice === null ? !night : null)}
                className={
                  'flex-1 rounded-lg border px-1 py-1.5 text-[11px] font-semibold ' +
                  (night
                    ? 'border-indigo-400/60 bg-indigo-500/15 text-indigo-300'
                    : 'border-white/10 text-slate-300 hover:bg-white/5')
                }
                aria-pressed={night}
              >
                {night ? 'Night' : 'Day'}
              </button>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2">
              {code !== 'VS' ? (
                <div>
                  <span className="mb-1 block text-xs text-slate-300">
                    Track spacing (NM)
                  </span>
                  <Input
                    value={spacingStr}
                    onChange={(e) => setSpacingStr(e.target.value)}
                    placeholder={String(Math.max(0.05, round2(sweepNM)))}
                    inputMode="decimal"
                    aria-label="Track spacing in nautical miles"
                  />
                </div>
              ) : (
                <div>
                  <span className="mb-1 block text-xs text-slate-300">
                    Sector radius (NM)
                  </span>
                  <Input
                    value={sizeStr}
                    onChange={(e) => setSizeStr(e.target.value)}
                    placeholder={String(sectorRadius)}
                    inputMode="decimal"
                    aria-label="Sector radius in nautical miles"
                  />
                </div>
              )}
              <div>
                <span className="mb-1 block text-xs text-slate-300">
                  First leg (°T)
                </span>
                <Input
                  value={orientStr}
                  onChange={(e) => setOrientStr(e.target.value)}
                  placeholder={String(Math.round(driftDeg))}
                  inputMode="numeric"
                  aria-label="First leg direction, degrees true"
                />
              </div>
              {(code === 'PS' || code === 'CL') && (
                <div>
                  <span className="mb-1 block text-xs text-slate-300">
                    Leg length (NM)
                  </span>
                  <Input
                    value={sizeStr}
                    onChange={(e) => setSizeStr(e.target.value)}
                    placeholder={String(legLengthNM)}
                    inputMode="decimal"
                    aria-label="Leg length in nautical miles"
                  />
                </div>
              )}
              <div>
                <span className="mb-1 block text-xs text-slate-300">
                  Search speed (kn)
                </span>
                <Input
                  value={speedStr}
                  onChange={(e) => setSpeedStr(e.target.value)}
                  inputMode="decimal"
                  aria-label="Search speed in knots"
                />
              </div>
            </div>

            <p className="tnum mt-2 text-xs text-slate-400">
              Sweep width {sweepNM.toFixed(2)} NM for{' '}
              {objectType.label.toLowerCase()} ({night ? 'night' : 'day'},{' '}
              {sea}).{' '}
              {code === 'VS'
                ? 'Sector passes keep re-crossing the datum, where the object most probably is.'
                : `Coverage ${coverage.toFixed(2)} → POD ${(pod * 100).toFixed(0)} % on one pass.`}
            </p>

            {plan && (
              <>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <Stat label="Legs" value={String(plan.legs.length)} />
                  <Stat
                    label="Track"
                    value={formatDistance(plan.totalNM, 'nm')}
                  />
                  <Stat
                    label="Time"
                    value={formatDuration(timeHours)}
                    hint={`at ${speedKts} kn`}
                  />
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button
                    onClick={async () => {
                      let saved = 0
                      for (let i = 0; i < plan.points.length; i++) {
                        const p = plan.points[i]
                        const made = await createWaypoint({
                          name: `${plan.code}-${i}`,
                          lat: p.lat,
                          lon: p.lon,
                          note:
                            i === 0
                              ? `${PATTERN_NAMES[plan.code]} CSP` +
                                (incident ? ` · ${incident.incident_number}` : '')
                              : `${PATTERN_NAMES[plan.code]} turn ${i}`,
                          team_id: activeTeamId,
                        })
                        if (made) saved++
                      }
                      toast(
                        saved > 0
                          ? `${saved} turn points saved as waypoints${online ? '' : ' — offline, will sync'}`
                          : 'Could not save the waypoints',
                        saved > 0 ? 'success' : 'error',
                      )
                    }}
                  >
                    Save turn points
                  </Button>
                  {!running ? (
                    <Button
                      variant="primary"
                      onClick={() => {
                        setTargetIdx(0)
                        if (!tracker.watching) tracker.start()
                      }}
                    >
                      Steer the pattern
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={() => setTargetIdx(null)}>
                      Stop steering
                    </Button>
                  )}
                </div>
              </>
            )}
          </Card>

          {running && plan && (
            <SteerCard
              plan={plan}
              targetIdx={targetIdx}
              setTargetIdx={setTargetIdx}
              fix={fix}
              lastLabel="Last point — pattern complete when you arrive."
            />
          )}

          <Card>
            <Label>Map</Label>
            <SatelliteMap
              trail={tracker.trail}
              fix={fix}
              route={plan?.points ?? []}
              markers={
                result
                  ? [{ id: 'datum', name: 'DATUM', lat: result.datum.lat, lon: result.datum.lon }]
                  : []
              }
              height={300}
            />
            <p className="mt-1.5 text-xs text-slate-400">
              The dashed line is the plan; the solid line is where you have
              actually been. The gap between them is what is left to search.
            </p>
          </Card>
        </>
      )}

      <SurvivalCard
        lkpTime={
          incident?.incident_time ??
          incident?.lkp_time ??
          (lkp ? lkp.recorded_at : null)
        }
        waterTempC={env?.water_temp_c ?? null}
        defaultPfd={objectType.key === 'person_with_pfd' ? 'yes' : 'unknown'}
      />
    </div>
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/* -------------------------------------------------------------------------
 * Survival clock
 * ---------------------------------------------------------------------- */

const PFD_CHOICES: { id: PfdStatus; label: string }[] = [
  { id: 'yes', label: 'PFD' },
  { id: 'no', label: 'No PFD' },
  { id: 'unknown', label: 'Unknown' },
]

function SurvivalCard({
  lkpTime,
  waterTempC,
  defaultPfd,
}: {
  lkpTime: string | null
  waterTempC: number | null
  defaultPfd: PfdStatus
}) {
  const now = useNow(30_000)
  const [tempStr, setTempStr] = useState('')
  const [pfdChoice, setPfdChoice] = useState<PfdStatus | null>(null)
  const pfd = pfdChoice ?? defaultPfd

  const temp = (() => {
    const n = parseFloat(tempStr)
    if (Number.isFinite(n)) return n
    return waterTempC
  })()

  if (!lkpTime || temp == null) {
    return (
      <Card>
        <Label>Survival clock</Label>
        <EmptyState>
          Needs the time the person went in (the LKP) and the water
          temperature (On-scene conditions in Search datum
          {temp == null ? ', or type it here' : ''}).
        </EmptyState>
        {temp == null && (
          <Input
            value={tempStr}
            onChange={(e) => setTempStr(e.target.value)}
            placeholder="Water temp (°C)"
            inputMode="decimal"
            aria-label="Water temperature, Celsius"
            className="mt-2"
          />
        )}
      </Card>
    )
  }

  const elapsedMin = Math.max(0, (now.getTime() - new Date(lkpTime).getTime()) / 60_000)
  const est = survivalEstimate({ waterTempC: temp, elapsedMinutes: elapsedMin, pfd })
  const urgent = est.primaryThreat === 'drowning' || est.remainingMinutes <= 60

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <Label>Survival clock</Label>
        <div className="mb-1.5 flex gap-1">
          {PFD_CHOICES.map((c) => (
            <button
              key={c.id}
              onClick={() => setPfdChoice(c.id)}
              className={
                'rounded-lg border px-2 py-1 text-[11px] font-semibold ' +
                (pfd === c.id
                  ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                  : 'border-white/10 text-slate-300 hover:bg-white/5')
              }
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div
        className={
          'rounded-xl border px-3 py-2.5 ' +
          (urgent
            ? 'border-red-400/40 bg-red-500/10'
            : 'border-white/10 bg-white/5')
        }
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="tnum text-2xl font-semibold text-slate-50">
            {Number.isFinite(est.remainingMinutes)
              ? formatSurvivalMinutes(Math.max(0, est.remainingMinutes))
              : 'No limit'}
          </span>
          <span className="tnum text-xs text-slate-300">
            in the water {formatDuration(elapsedMin / 60)}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-slate-300">{est.phaseLabel}</div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Stat
          label="Self-help until"
          value={
            Number.isFinite(est.functionalMax)
              ? `${formatSurvivalMinutes(est.functionalMin)}–${formatSurvivalMinutes(est.functionalMax)}`
              : 'No limit'
          }
          hint="can still swim, grab, wave"
        />
        <Stat
          label="Survival window"
          value={
            Number.isFinite(est.survivalMax)
              ? `${formatSurvivalMinutes(est.survivalMin)}–${formatSurvivalMinutes(est.survivalMax)}`
              : 'No limit'
          }
          hint={`water ${temp.toFixed(0)} °C`}
        />
      </div>

      <p className="mt-1.5 text-xs text-slate-400">
        {est.primaryThreat === 'drowning'
          ? 'The airway is the threat right now — drowning kills faster than hypothermia.'
          : est.phase === 'beyond_estimate'
            ? 'Past the estimate is a reason for urgency, not a reason to stop — people have survived far longer.'
            : 'USCG baseline for the water temperature; a planning number, not a verdict.'}
      </p>
    </Card>
  )
}
