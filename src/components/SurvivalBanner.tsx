import { useMemo } from 'react'
import { useNow } from '@/hooks/useNow'
import { useTeams } from '@/store/useTeams'
import { useIncidents } from '@/store/useIncidents'
import { useSarRecords } from '@/store/useSarRecords'
import { useVictims } from '@/store/useVictims'
import { recordsForSearch } from '@/lib/incident'
import {
  formatSurvivalMinutes,
  survivalEstimate,
  type PfdStatus,
} from '@/lib/survival'
import { useFormat } from '@/hooks/useFormat'
import type { EnvironmentPayload, LkpPayload } from '@/lib/types'

/**
 * The survival clock, on every screen.
 *
 * It used to live only on the search-pattern page, which is the one page a
 * crew is *not* looking at while they are searching — they are on the chart,
 * or the compass, or stamping a waypoint. The number that should change how
 * hard a search is being pressed was one tab away from wherever anyone was.
 *
 * **It asks for nothing.** Everything it needs is already recorded on this
 * search: the water temperature from the conditions card, the time in the
 * water from the LKP or the incident, and whether there is a life jacket from
 * the victim description. When any of those is missing there is no banner —
 * rather than a banner full of dashes, or worse, one quietly assuming a life
 * jacket nobody reported.
 *
 * **Past the estimate it turns red and stays up.** The estimate running out
 * is the moment to press a search harder, not the moment to stop, and the
 * wording says so — the model is a table of averages, and people have
 * survived far past it.
 */
export function SurvivalBanner() {
  const now = useNow(30_000)
  const fmt = useFormat()
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const incident = useIncidents((s) => s.activeIncident(activeTeamId))
  const all = useSarRecords((s) => s.visible())
  const victim = useVictims((s) => (incident ? (s.drafts[incident.id] ?? null) : null))

  const records = useMemo(
    () => recordsForSearch(all, activeTeamId, incident?.id ?? null),
    [all, activeTeamId, incident?.id],
  )

  const lkp = records.find((r) => r.kind === 'lkp') ?? null
  const env = records.find((r) => r.kind === 'environment')?.payload as
    | EnvironmentPayload
    | undefined

  // Immersion time, in the order it was most directly recorded — the same
  // order the search page uses, so the two cannot disagree.
  const inWater =
    (lkp?.payload as LkpPayload | undefined)?.time_in_water ??
    incident?.incident_time ??
    incident?.lkp_time ??
    lkp?.recorded_at ??
    null

  const waterTempC = env?.water_temp_c ?? null
  if (waterTempC == null || inWater == null) return null

  const elapsedMinutes = Math.max(
    0,
    (now.getTime() - new Date(inWater).getTime()) / 60_000,
  )

  /*
   * A life jacket is only ever claimed when somebody has said so. `unknown`
   * is the default and is a materially shorter estimate than `yes` — which is
   * the right way round for a number a search is run on.
   */
  const pfd: PfdStatus = victim?.has_life_jacket ? 'yes' : 'unknown'

  const est = survivalEstimate({ waterTempC, elapsedMinutes, pfd })
  const past = est.remainingMinutes <= 0

  return (
    <div
      role="status"
      className={
        'border-t px-3 py-1.5 text-xs ' +
        (past
          ? 'border-red-400/40 bg-red-950/80 text-red-100'
          : 'border-amber-400/30 bg-amber-950/70 text-amber-100')
      }
    >
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-2">
        <span className="font-semibold">
          {past
            ? 'Past the survival estimate — keep searching'
            : `Survival window ${formatSurvivalMinutes(est.remainingMinutes)} left`}
        </span>
        <span className="tnum shrink-0 text-[11px] opacity-80">
          {fmt.temp(waterTempC)} ·{' '}
          {formatSurvivalMinutes(elapsedMinutes)} in ·{' '}
          {pfd === 'yes' ? 'PFD' : 'PFD unknown'}
        </span>
      </div>
    </div>
  )
}
