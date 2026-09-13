import { Button, Card, EmptyState, Label } from '@/components/ui'
import {
  bearingDeg,
  formatBearing,
  formatDistance,
  haversineNM,
} from '@/lib/geo'
import type { SteerFix } from '@/lib/steer'
import { arrivalRadiusNM, type SteerablePlan } from '@/lib/steer'
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
      <p className="mt-1.5 text-xs text-slate-400">
        {footnote.replace('within each', `within ${arrivalFt} ft of each`)}
      </p>
    </Card>
  )
}
