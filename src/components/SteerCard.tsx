import { useState } from 'react'
import { Button, Card, EmptyState, Label } from '@/components/ui'
import {
  bearingDeg,
  formatBearing,
  formatDistance,
  formatDuration,
  formatEtaClock,
  haversineNM,
  MPS_TO_KNOTS,
} from '@/lib/geo'
import type { SteerFix } from '@/lib/steer'
import {
  arrivalRadiusNM,
  timeToRunHours,
  turnToward,
  type SteerablePlan,
} from '@/lib/steer'
import { useTracker } from '@/store/useTracker'

/**
 * Leg-by-leg steering for any ordered list of points.
 *
 * Shared by the search patterns and the chart plotter's routes, which is the
 * whole point: a route leg and a pattern leg are the same object
 * (`buildLegs` in `search.ts` makes both), so there is one definition of what
 * to steer and no way for the two screens to drift apart.
 */

export function SteerCard({
  plan,
  targetIdx,
  setTargetIdx,
  fix,
  /** What the end of the list means, in this screen's language. */
  lastLabel = 'Last point — complete when you arrive.',
  footnote = 'Advances by itself within each point. Tracking stays on so the track records what you covered.',
}: {
  plan: SteerablePlan
  targetIdx: number
  setTargetIdx: (i: number | null) => void
  fix: SteerFix | null
  lastLabel?: string
  footnote?: string
}) {
  const arrivalFt = useTracker((s) => s.arrivalFt)
  const target = plan.points[targetIdx]
  const last = targetIdx >= plan.points.length - 1
  const distNM =
    fix && target ? haversineNM(fix.lat, fix.lon, target.lat, target.lon) : null
  // The circle the steering rule is actually using, so this card and the rule
  // cannot disagree about when the crew has arrived.
  const radiusNM = arrivalRadiusNM(arrivalFt, fix?.accuracy)
  // Inside the arrival circle a bearing is GPS jitter dressed up as a heading,
  // so it is withheld rather than printed.
  const course =
    fix && target && distNM !== null && distNM >= radiusNM
      ? bearingDeg(fix.lat, fix.lon, target.lat, target.lon)
      : null
  // The leg that starts at the target — what to steer after the turn.
  const nextLeg = plan.legs[targetIdx] ?? null

  /*
   * Which way to turn, rather than only what to steer.
   *
   * A bearing on its own is arithmetic done at the wheel: "steer 047" while
   * heading 310 means working out, mid-turn, that it is a 97° turn to
   * starboard. The card does that sum instead.
   *
   * Course over ground, not the compass: this is the direction the boat is
   * actually making good, which is what has to be brought onto the leg. It is
   * null when the boat is not moving enough to have one — a stationary boat
   * would otherwise be told to turn by a number made of receiver noise.
   */
  const turn = course !== null ? turnToward(course, fix?.heading) : null
  const speedKn = fix?.speed != null ? fix.speed * MPS_TO_KNOTS : null
  const runHours = distNM !== null ? timeToRunHours(distNM, fix?.speed) : null

  const [showTurns, setShowTurns] = useState(false)

  /**
   * Every turn still to come, with the run to each from where the boat is.
   *
   * Measured from the boat, not from the start of the pattern: the distance
   * to the next point is the real one the fix gives, and the legs between it
   * and each later point are added on. A table that counted from the CSP
   * would be a plan, and the crew already has the plan — what they cannot see
   * is how far away the sixth turn is from here.
   */
  const upcoming = plan.points
    .map((_, i) => i)
    .filter((i) => i >= targetIdx)
    .map((i) => {
      const runNM =
        (distNM ?? 0) +
        plan.legs.slice(targetIdx, i).reduce((sum, l) => sum + l.lengthNM, 0)
      const leg = plan.legs[i] ?? null
      const hours = speedKn != null && speedKn >= 1 ? runNM / speedKn : null
      return { i, runNM, leg, hours }
    })

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <Label>Steering</Label>
        <span className="mb-1.5 text-xs text-slate-400">
          {targetIdx === 0
            ? 'To the start point'
            : `Point ${targetIdx} of ${plan.points.length - 1}`}
        </span>
      </div>

      {!fix ? (
        <EmptyState>Waiting for a GPS fix…</EmptyState>
      ) : (
        <div className="rounded-xl border border-sky-400/30 bg-sky-500/5 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="tnum text-2xl font-semibold text-slate-50">
              {course !== null ? formatBearing(course) : 'Here'}
            </span>
            <span className="tnum text-lg text-slate-200">
              {distNM !== null ? formatDistance(distNM, 'nm') : '—'}
            </span>
          </div>
          {/* Which way, and how far round. The arrow is the instruction; the
              bearing above it is the reference. A crew mid-turn reads the
              arrow. */}
          {turn !== null && Math.abs(turn) >= 3 && (
            <div className="mt-1.5 flex items-center gap-2">
              <span
                aria-hidden
                className={
                  'text-2xl leading-none ' +
                  (turn > 0 ? 'text-emerald-300' : 'text-red-300')
                }
              >
                {turn > 0 ? '▶' : '◀'}
              </span>
              <span className="text-sm font-semibold text-slate-100">
                Come {turn > 0 ? 'right' : 'left'} {Math.abs(Math.round(turn))}°
              </span>
            </div>
          )}
          {turn !== null && Math.abs(turn) < 3 && (
            <div className="mt-1.5 text-sm font-semibold text-emerald-300">
              Steady — on the leg
            </div>
          )}

          {/* The countdown. Distance is the honest one and is always shown;
              the time beside it needs a speed and says nothing without one. */}
          <div className="tnum mt-1.5 flex flex-wrap items-baseline gap-x-3 text-xs text-slate-300">
            {speedKn != null && (
              <span>Making {speedKn.toFixed(1)} kn</span>
            )}
            {runHours != null ? (
              <>
                <span>{formatDuration(runHours)} to the turn</span>
                <span className="text-slate-400">
                  at {formatEtaClock(runHours)}
                </span>
              </>
            ) : (
              <span className="text-slate-400">
                Time to run needs a knot or more over the ground.
              </span>
            )}
          </div>

          <div className="mt-0.5 text-xs text-slate-300">
            {last
              ? lastLabel
              : nextLeg
                ? `Then ${formatBearing(nextLeg.courseDeg)} for ${formatDistance(nextLeg.lengthNM, 'nm')}`
                : ''}
          </div>
        </div>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button
          variant="ghost"
          disabled={targetIdx === 0}
          onClick={() => setTargetIdx(Math.max(0, targetIdx - 1))}
        >
          Previous point
        </Button>
        <Button
          variant="ghost"
          disabled={last}
          onClick={() =>
            setTargetIdx(Math.min(plan.points.length - 1, targetIdx + 1))
          }
        >
          Skip to next
        </Button>
      </div>
      {/* The whole pattern, on demand. Steering shows one turn because that
          is what is being steered; a coxswain planning fuel, light or a crew
          change needs the rest of it, and it was previously only on the map
          as a dashed line with no numbers against it. */}
      <button
        type="button"
        onClick={() => setShowTurns((v) => !v)}
        aria-expanded={showTurns}
        className="mt-2 w-full rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/5"
      >
        {showTurns ? 'Hide upcoming turns' : 'Show all upcoming turns'}
      </button>

      {showTurns && (
        <div className="mt-2 overflow-hidden rounded-lg border border-white/10">
          <table className="w-full text-xs">
            <thead className="bg-white/5 text-slate-300">
              <tr>
                <th className="px-2 py-1.5 text-left font-semibold">Turn</th>
                <th className="px-2 py-1.5 text-left font-semibold">Steer</th>
                <th className="px-2 py-1.5 text-right font-semibold">Run</th>
                <th className="px-2 py-1.5 text-right font-semibold">At</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {upcoming.map(({ i, runNM, leg, hours }) => (
                <tr
                  key={i}
                  className={
                    'border-t border-white/5 ' +
                    (i === targetIdx ? 'bg-sky-500/10 text-slate-50' : 'text-slate-300')
                  }
                >
                  <td className="px-2 py-1.5">
                    {i === 0 ? 'Start' : i}
                    {i === targetIdx ? ' · next' : ''}
                  </td>
                  <td className="px-2 py-1.5">
                    {leg ? formatBearing(leg.courseDeg) : 'Finish'}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {formatDistance(runNM, 'nm')}
                  </td>
                  <td className="px-2 py-1.5 text-right text-slate-400">
                    {hours != null ? formatEtaClock(hours) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-1.5 text-xs text-slate-400">
        {footnote.replace('within each', `within ${arrivalFt} ft of each`)}
      </p>
    </Card>
  )
}
