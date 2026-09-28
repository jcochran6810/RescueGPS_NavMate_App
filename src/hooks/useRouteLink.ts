import { useEffect } from 'react'
import { decodeRouteParam, planFromPoints, ROUTE_PARAM } from '@/lib/routeShare'
import { activeVessel, useNavigation } from '@/store/useNavigation'
import { toast } from '@/store/useToast'

/**
 * A shared route arriving as `/?route=…` (see `lib/routeShare.ts`): read it
 * once the crew is signed in, take it out of the address bar, and open it as
 * a preview — re-checked for THIS crew's boat before it can be steered.
 * Mid-passage the crew is asked first. A damaged or oversized link is
 * refused in plain words.
 */
export function useRouteLink(signedIn: boolean, onOpened: () => void): void {
  useEffect(() => {
    if (!signedIn || typeof window === 'undefined') return
    const url = new URL(window.location.href)
    const param = url.searchParams.get(ROUTE_PARAM)
    if (param == null) return
    url.searchParams.delete(ROUTE_PARAM)
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    const decoded = decodeRouteParam(param)
    if (!decoded.ok) {
      toast(decoded.error, 'error')
      return
    }
    const { route } = decoded
    const nav = useNavigation.getState()
    if (
      nav.status === 'navigating' &&
      !window.confirm(`Stop the route to ${nav.dest?.label ?? 'your destination'} and open the shared route “${route.name}” instead?`)
    ) {
      return
    }
    const first = route.points[0]
    const last = route.points[route.points.length - 1]
    const plan = planFromPoints(route.points, activeVessel()?.cruise_speed_kn ?? 20)
    void nav.openRoute({
      plan,
      dest: { lat: last.lat, lon: last.lon, label: route.destLabel },
      origin: { lat: first.lat, lon: first.lon, label: route.startLabel },
      name: route.name,
      noun: 'Shared route',
    })
    onOpened()
  }, [signedIn, onOpened])
}
