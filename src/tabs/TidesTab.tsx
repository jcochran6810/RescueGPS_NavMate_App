import { useEffect, useMemo } from 'react'
import { useTracker } from '@/store/useTracker'
import { useTides } from '@/store/useTides'
import { useNow } from '@/hooks/useNow'
import { TidesNearMe } from '@/components/TidesNearMe'
import { formatTideClock, formatTideHeight } from '@/lib/tides'
import { Card, EmptyState, Label } from '@/components/ui'

/**
 * Tides, in full.
 *
 * The card on its own answers "is it coming in"; this page adds the rest of
 * the table, because planning a launch or a recovery window needs to see the
 * next two days rather than the next two events.
 */
export function TidesTab() {
  const { fix, watching, error, once } = useTracker()
  const extremes = useTides((s) => s.extremes)
  const now = useNow(30_000)

  // Reachable straight from the section row without passing through Home, so
  // it asks for its own fix rather than sitting on "needs a position".
  useEffect(() => {
    if (!fix && !watching) void once()
  }, [fix, watching, once])

  const lat = fix?.lat ?? null
  const lon = fix?.lon ?? null

  /** The whole table grouped into local days, past entries dropped. */
  const days = useMemo(() => {
    const upcoming = extremes.filter((e) => e.at.getTime() > now.getTime())
    const grouped = new Map<string, typeof upcoming>()
    for (const e of upcoming) {
      const key = e.at.toLocaleDateString([], {
        weekday: 'long',
        day: 'numeric',
        month: 'short',
      })
      const list = grouped.get(key)
      if (list) list.push(e)
      else grouped.set(key, [e])
    }
    return [...grouped.entries()]
  }, [extremes, now])

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Tides</h2>
        <p className="text-sm text-slate-300">
          High and low water from the nearest NOAA station.
        </p>
      </div>

      {/* A failed fix used to strand this page on "take a position fix" with
          no error shown and nothing to press. */}
      {error && !fix && (
        <div className="rounded-xl bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
          <p>{error}</p>
          <button
            onClick={() => void once()}
            className="mt-1.5 rounded-lg border border-red-400/30 px-2.5 py-1 text-xs hover:bg-red-500/10"
          >
            Try again
          </button>
        </div>
      )}

      <TidesNearMe lat={lat} lon={lon} />

      <Card>
        <Label>Next two days</Label>
        {days.length === 0 ? (
          <EmptyState>
            {lat === null
              ? 'Take a position fix to load a tide table.'
              : 'No predictions loaded yet.'}
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {days.map(([day, entries]) => (
              <div key={day}>
                <div className="mb-1 text-xs font-semibold tracking-wide text-slate-300 uppercase">
                  {day}
                </div>
                <ul className="divide-y divide-white/5 rounded-xl border border-white/10">
                  {entries.map((e) => (
                    <li
                      key={e.at.toISOString()}
                      className="flex items-center justify-between px-3 py-2 text-sm"
                    >
                      <span
                        className={
                          'font-semibold ' +
                          (e.type === 'H' ? 'text-sky-300' : 'text-amber-300')
                        }
                      >
                        {e.type === 'H' ? 'High' : 'Low'}
                      </span>
                      <span className="tnum text-slate-300">
                        {formatTideClock(e.at)}
                      </span>
                      <span className="tnum text-slate-100">
                        {formatTideHeight(e.heightFt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-slate-400">
          Heights are above MLLW. Predictions are astronomical — they do not
          account for wind or barometric pressure, both of which can move real
          water level by a foot or more in a blow.
        </p>
      </Card>
    </div>
  )
}
