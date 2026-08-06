import { useMemo, useState } from 'react'
import {
  solveSixtyDst,
  formatMinutes,
  readField,
  type SixtyDstQuantity,
} from '@/lib/sixtydst'
import { formatEtaClock } from '@/lib/geo'
import { Button, Input } from '@/components/ui'

const ANSWER: Record<SixtyDstQuantity, (v: number) => [string, string]> = {
  distance: (v) => ['Distance', `${round(v)} NM`],
  speed: (v) => ['Speed needed', `${round(v)} kn`],
  time: (v) => ['Time', formatMinutes(v)],
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}

/**
 * The 60 D Street working, as three boxes.
 *
 * Fill in two, leave the third blank, and the blank one is worked out. The ETA
 * panel above already answers "how long to that waypoint at this speed"; this
 * exists because that is only one of the three questions the relation answers,
 * and the other two — how far can we get in the time left, and how fast must
 * we go to be there — have nowhere else to be asked.
 *
 * The answer is shown apart from the boxes rather than written into the empty
 * one. Filling the box would leave all three looking entered, and the next
 * person to change their mind about which quantity they were solving for would
 * have no way to tell what the app thought they had given it.
 */
export function SixtyDstSolver({
  suggestedDistanceNM,
  suggestedSpeedKn,
}: {
  /** Distance to the chosen waypoint, when there is one. */
  suggestedDistanceNM?: number | null
  /** Speed over the ground from GPS, when it is moving. */
  suggestedSpeedKn?: number | null
}) {
  const [distance, setDistance] = useState('')
  const [speed, setSpeed] = useState('')
  const [time, setTime] = useState('')

  const result = useMemo(
    () =>
      solveSixtyDst({
        distanceNM: readField(distance),
        speedKn: readField(speed),
        timeMin: readField(time),
      }),
    [distance, speed, time],
  )

  const canFill =
    (suggestedDistanceNM != null && suggestedDistanceNM > 0) ||
    (suggestedSpeedKn != null && suggestedSpeedKn > 0)

  const answer =
    result.ok && result.solvedFor
      ? ANSWER[result.solvedFor](
          result.solvedFor === 'distance'
            ? result.distanceNM
            : result.solvedFor === 'speed'
              ? result.speedKn
              : result.timeMin,
        )
      : null

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold tracking-wide text-slate-300 uppercase">
          60 D = S × T
        </span>
        {canFill && (
          <button
            onClick={() => {
              setDistance(
                suggestedDistanceNM != null && suggestedDistanceNM > 0
                  ? String(round(suggestedDistanceNM))
                  : '',
              )
              setSpeed(
                suggestedSpeedKn != null && suggestedSpeedKn > 0
                  ? String(Math.round(suggestedSpeedKn * 10) / 10)
                  : '',
              )
              setTime('')
            }}
            className="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5"
          >
            Fill from waypoint
          </button>
        )}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <label className="block">
          <span className="mb-1 block text-[11px] text-slate-400">
            Distance (NM)
          </span>
          <Input
            value={distance}
            onChange={(e) => setDistance(e.target.value)}
            placeholder="D"
            inputMode="decimal"
            aria-label="Distance in nautical miles"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-slate-400">
            Speed (kn)
          </span>
          <Input
            value={speed}
            onChange={(e) => setSpeed(e.target.value)}
            placeholder="S"
            inputMode="decimal"
            aria-label="Speed in knots"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-slate-400">
            Time (min)
          </span>
          <Input
            value={time}
            onChange={(e) => setTime(e.target.value)}
            placeholder="T"
            inputMode="decimal"
            aria-label="Time in minutes"
          />
        </label>
      </div>

      {!result.ok ? (
        <p className="mt-2 text-xs text-slate-400">{result.error}</p>
      ) : (
        <div
          className="mt-2 rounded-xl border border-white/10 bg-navy-950/60 px-3 py-2.5"
          role="status"
          aria-live="polite"
        >
          {answer && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-semibold tracking-wide text-slate-300 uppercase">
                {answer[0]}
              </span>
              <span className="tnum text-xl font-semibold text-sky-300">
                {answer[1]}
              </span>
            </div>
          )}
          <p className="tnum mt-0.5 text-xs text-slate-300">{result.working}</p>
          {result.solvedFor === 'time' && formatEtaClock(result.timeMin / 60) && (
            <p className="mt-0.5 text-xs text-slate-400">
              Arriving about {formatEtaClock(result.timeMin / 60)}
            </p>
          )}
          {result.mismatch && (
            <p className="mt-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-300">
              {result.mismatch}
            </p>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        {/* "Fill in two, leave the third blank" used to live here as well as in
            the solver's own empty-state message directly above, so the same
            instruction was printed twice, one line apart. This keeps the part
            the empty state does not say — the units, which are the thing that
            silently produces a wrong answer. */}
        <p className="text-xs text-slate-400">
          Nautical miles and knots — a statute mile or a kilometre here gives a
          wrong answer.
        </p>
        <Button
          variant="ghost"
          className="min-h-9 shrink-0 px-3 text-xs"
          onClick={() => {
            setDistance('')
            setSpeed('')
            setTime('')
          }}
        >
          Clear
        </Button>
      </div>
    </div>
  )
}
