import { useMemo } from 'react'
import { useFormat } from '@/hooks/useFormat'
import { useNow } from '@/hooks/useNow'
import { declinationFor, navCardView, type NavCardView } from '@/lib/navView'
import { useHeading } from '@/store/useHeading'
import { useNavigation } from '@/store/useNavigation'
import { useTeams } from '@/store/useTeams'
import { useTracker } from '@/store/useTracker'
import { useVessels } from '@/store/useVessels'

/**
 * The steering card's contents, live — shared by the big card on the Chart
 * tab and the banner on every other tab, so the two can never disagree about
 * which waypoint is next or when the boat gets in.
 *
 * Null unless a route is being steered (or has just been arrived at).
 *
 * Re-renders every second on its own as well as on every fix: a fix that
 * STOPS arriving is exactly the case the card has to show, and nothing else
 * would re-render it then.
 */
export function useNavCard(): NavCardView | null {
  const status = useNavigation((s) => s.status)
  const plan = useNavigation((s) => s.plan)
  const targetIdx = useNavigation((s) => s.targetIdx)
  const speedKn = useNavigation((s) => s.speedKn)
  const gpsPoor = useNavigation((s) => s.gpsPoor)
  const rerouting = useNavigation((s) => s.rerouting)
  const offCourseSince = useNavigation((s) => s.offCourseSince)
  const error = useNavigation((s) => s.error)
  const dest = useNavigation((s) => s.dest)
  const fix = useTracker((s) => s.fix)
  const arrivalFt = useTracker((s) => s.arrivalFt)
  const bearingPref = useHeading((s) => s.reference)
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const cruiseKn = useVessels((s) => s.active(activeTeamId)?.cruise_speed_kn ?? null)
  const fmt = useFormat()
  const now = useNow(1000).getTime()

  const live = status === 'navigating' || status === 'arrived'
  const declination = useMemo(
    () =>
      live && bearingPref === 'magnetic' && fix ? declinationFor(fix.lat, fix.lon) : null,
    [live, bearingPref, fix],
  )

  if (!live || !plan || plan.points.length < 2) return null
  return navCardView({
    plan,
    status,
    targetIdx,
    fix,
    now,
    speedKn,
    cruiseKn,
    arrivalFt,
    bearingPref,
    declination,
    gpsPoor,
    rerouting,
    offCourseSince,
    error,
    destLabel: dest?.label ?? null,
    formatLength: fmt.length,
  })
}
