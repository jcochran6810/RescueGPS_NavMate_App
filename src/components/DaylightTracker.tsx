import { useMemo } from 'react'
import { useNow } from '@/hooks/useNow'
import {
  formatCountdown,
  formatDayLength,
  formatSunClock,
  isNextDay,
  nextSunEvent,
  sunClockParts,
  sunEvents,
  SUN_EVENT_LABELS,
  type SunEventName,
} from '@/lib/sun'
import { Card, Label } from '@/components/ui'

const ORDER: SunEventName[] = ['dawn', 'sunrise', 'sunset', 'dusk']

/**
 * Time until the next change of light, and the day's four boundaries.
 *
 * Dawn and dusk are civil twilight — the point at which a search can still be
 * run on natural light — rather than the sun crossing the horizon, because
 * that is the number that actually bounds a daylight operation.
 */
export function DaylightTracker({
  lat,
  lon,
}: {
  lat: number | null
  lon: number | null
}) {
  const now = useNow(1000)
  const hasFix = lat !== null && lon !== null

  // Event times only move by the minute, so they are recomputed on the minute
  // rather than on every tick. The countdown itself is taken against the live
  // clock further down, so it still runs a second at a time.
  const minuteStamp = Math.floor(now.getTime() / 60_000) * 60_000
  const minute = useMemo(() => new Date(minuteStamp), [minuteStamp])

  const view = useMemo(() => {
    if (lat === null || lon === null) return null
    const today = sunEvents(minute, lat, lon)
    const next = nextSunEvent(minute, lat, lon)
    // Once tonight's dusk has gone, the four boxes should be showing
    // tomorrow's times, not times that have already passed.
    const showTomorrow =
      today.dusk !== null && today.dusk.getTime() <= minute.getTime()
    const shown = showTomorrow
      ? sunEvents(new Date(minute.getTime() + 86_400_000), lat, lon)
      : today
    return { next, shown }
  }, [lat, lon, minute])

  return (
    <Card>
      <Label>Daylight tracker</Label>

      {!hasFix || !view ? (
        <p className="text-sm text-slate-300">
          Needs a position — take a fix to see sunrise, sunset and the time left
          before dark.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-navy-950/60 px-3 py-3">
            <span className="text-sm text-slate-300">
              {view.next
                ? `Time til ${SUN_EVENT_LABELS[view.next.name]}`
                : view.shown.alwaysUp
                  ? 'Midnight sun — no sunset'
                  : 'Polar night — no sunrise'}
            </span>
            <span className="tnum text-2xl font-semibold text-amber-300">
              {view.next
                ? // Events are recomputed on the minute but this renders every
                  // second, so just after an event passes the difference goes
                  // briefly negative — clamp to zero rather than blanking the
                  // countdown at exactly the moment it matters.
                  formatCountdown(
                    Math.max(0, view.next.at.getTime() - now.getTime()),
                  )
                : '—'}
            </span>
          </div>

          <div className="mt-2 grid grid-cols-4 gap-2">
            {ORDER.map((name) => {
              const at = view.shown[name]
              return (
                <div
                  key={name}
                  className="rounded-xl border border-white/10 bg-navy-950/40 px-2 py-2 text-center"
                >
                  <div className="text-[11px] text-slate-400">
                    {at && isNextDay(at, now) ? 'Tomorrow' : 'Today'}
                  </div>
                  <div className="text-xs font-semibold text-slate-200">
                    {SUN_EVENT_LABELS[name]}
                  </div>
                  <div className="tnum mt-0.5 whitespace-nowrap text-slate-50">
                    <span className="text-sm">{sunClockParts(at).time}</span>
                    {sunClockParts(at).suffix && (
                      <span className="ml-0.5 text-[10px] text-slate-300">
                        {sunClockParts(at).suffix}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <p className="mt-2 text-xs text-slate-400">
            {view.shown.dayLengthH > 0 && view.shown.dayLengthH < 24
              ? `${formatDayLength(view.shown.dayLengthH)} of sun · solar noon ${formatSunClock(view.shown.solarNoon)}`
              : `Solar noon ${formatSunClock(view.shown.solarNoon)}`}
            . Dawn and dusk are civil twilight.
          </p>
        </>
      )}
    </Card>
  )
}
