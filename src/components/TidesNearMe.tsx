import { useEffect, useMemo, useState } from 'react'
import { useTides } from '@/store/useTides'
import { useNow } from '@/hooks/useNow'
import {
  nearestStations,
  tideNow,
  formatTideClock,
  formatTideHeight,
} from '@/lib/tides'
import { formatDistance, formatBearing } from '@/lib/geo'
import { Button, Card, Label, Spinner, Stat } from '@/components/ui'

const TREND_LABEL = {
  rising: 'Rising — flood',
  falling: 'Falling — ebb',
  unknown: 'Unknown',
} as const

/**
 * High and low water at the NOAA station nearest the crew.
 *
 * NOAA covers US waters only, so the distance to the station is shown rather
 * than hidden: a gauge 200 NM away is not "the tide here", and the crew needs
 * to see that for themselves before planning around it.
 */
export function TidesNearMe({
  lat,
  lon,
}: {
  lat: number | null
  lon: number | null
}) {
  const {
    stations,
    extremes,
    loading,
    error,
    fetchedAt,
    pinnedStationId,
    station,
    refresh,
    pin,
  } = useTides()
  const now = useNow(30_000)
  const [picking, setPicking] = useState(false)

  const hasFix = lat !== null && lon !== null

  // The lookup follows the position to about a kilometre. Keying it on the raw
  // fix would re-run it on every GPS update, and the nearest tide station does
  // not change because the boat drifted ten metres.
  const coarseLat = lat === null ? null : Math.round(lat * 100) / 100
  const coarseLon = lon === null ? null : Math.round(lon * 100) / 100

  useEffect(() => {
    if (coarseLat === null || coarseLon === null) return
    void refresh(coarseLat, coarseLon)
  }, [coarseLat, coarseLon, refresh])

  const current = useMemo(() => tideNow(now, extremes), [now, extremes])
  const active = station()

  // Keyed on the coarse position for the same reason as the effect above:
  // sorting ~3,000 stations on every GPS fix while tracking is live is real
  // work, and the answer does not change because the boat drifted ten metres.
  const alternatives = useMemo(
    () =>
      coarseLat !== null && coarseLon !== null
        ? nearestStations(coarseLat, coarseLon, stations, 5)
        : [],
    [coarseLat, coarseLon, stations],
  )

  const activeDistance = alternatives.find((s) => s.id === active?.id)

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <Label>Tides near me</Label>
        {loading && <Spinner className="text-slate-300" />}
      </div>

      {!hasFix ? (
        <p className="text-sm text-slate-300">
          Needs a position — take a fix to find the nearest NOAA tide station.
        </p>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-semibold text-slate-50">
                {active?.name ?? (loading ? 'Finding a station…' : 'No station yet')}
              </div>
              {activeDistance && (
                <div className="tnum text-xs text-slate-400">
                  {formatDistance(activeDistance.distanceNM, 'nm')}{' '}
                  {formatBearing(activeDistance.bearingDeg)}
                  {active?.state ? ` · ${active.state}` : ''}
                  {pinnedStationId ? ' · pinned' : ''}
                </div>
              )}
            </div>
            <span
              className={
                'shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ' +
                (current.trend === 'rising'
                  ? 'bg-sky-500/15 text-sky-300'
                  : current.trend === 'falling'
                    ? 'bg-amber-500/15 text-amber-300'
                    : 'bg-white/5 text-slate-300')
              }
            >
              {TREND_LABEL[current.trend]}
            </span>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <Stat
              label="Next high"
              value={formatTideClock(current.nextHigh?.at ?? null)}
              hint={
                current.nextHigh
                  ? formatTideHeight(current.nextHigh.heightFt)
                  : undefined
              }
            />
            <Stat
              label="Next low"
              value={formatTideClock(current.nextLow?.at ?? null)}
              hint={
                current.nextLow
                  ? formatTideHeight(current.nextLow.heightFt)
                  : undefined
              }
            />
          </div>

          {extremes.length > 0 && (
            <ul className="mt-2 divide-y divide-white/5 rounded-xl border border-white/10">
              {extremes
                .filter((e) => e.at.getTime() > now.getTime())
                .slice(0, 4)
                .map((e) => (
                  <li
                    key={e.at.toISOString()}
                    className="flex items-center justify-between px-3 py-1.5 text-sm"
                  >
                    <span className="text-slate-300">
                      {e.type === 'H' ? 'High' : 'Low'}
                    </span>
                    <span className="tnum text-slate-300">
                      {e.at.toLocaleDateString([], {
                        weekday: 'short',
                      })}{' '}
                      {formatTideClock(e.at)}
                    </span>
                    <span className="tnum text-slate-100">
                      {formatTideHeight(e.heightFt)}
                    </span>
                  </li>
                ))}
            </ul>
          )}

          {error && (
            <p className="mt-2 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
              {extremes.length > 0 && ' — showing the last table downloaded.'}
            </p>
          )}

          {fetchedAt && (
            <p className="mt-2 text-xs text-slate-400">
              Predictions from NOAA CO-OPS, heights above MLLW, times in your
              local zone. Updated {new Date(fetchedAt).toLocaleString()}.
            </p>
          )}

          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              variant="ghost"
              onClick={() => setPicking((p) => !p)}
              disabled={alternatives.length === 0}
            >
              {picking ? 'Close' : 'Change station'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void refresh(lat, lon, true)}
              disabled={loading}
            >
              Refresh
            </Button>
          </div>

          {picking && (
            <ul className="mt-2 space-y-1">
              {alternatives.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => {
                      setPicking(false)
                      void pin(s.id, lat, lon)
                    }}
                    className={
                      'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm ' +
                      (s.id === active?.id
                        ? 'border-sky-400/60 bg-sky-500/10 text-sky-200'
                        : 'border-white/10 text-slate-300 hover:bg-white/5')
                    }
                  >
                    <span className="min-w-0 truncate">{s.name}</span>
                    <span className="tnum ml-2 shrink-0 text-xs text-slate-400">
                      {formatDistance(s.distanceNM, 'nm')}
                    </span>
                  </button>
                </li>
              ))}
              {pinnedStationId && (
                <li>
                  <button
                    onClick={() => {
                      setPicking(false)
                      void pin(null, lat, lon)
                    }}
                    className="w-full rounded-lg border border-white/10 px-3 py-2 text-left text-sm text-slate-300 hover:bg-white/5"
                  >
                    Follow the nearest station again
                  </button>
                </li>
              )}
            </ul>
          )}
        </>
      )}
    </Card>
  )
}
