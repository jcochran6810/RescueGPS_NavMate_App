import { useNavigation } from '@/store/useNavigation'
import type { SavedRoute } from '@/store/useSavedRoutes'

/** Open a saved route through the navigation store — asking first mid-passage. */
export async function openSavedRoute(r: SavedRoute): Promise<boolean> {
  const nav = useNavigation.getState()
  if (nav.status === 'navigating') {
    const ok =
      typeof window === 'undefined' ||
      window.confirm(`Stop the route to ${nav.dest?.label ?? 'your destination'} and open “${r.name}” instead?`)
    if (!ok) return false
  }
  await nav.openRoute({ plan: r.plan, dest: r.dest, origin: r.start, name: r.name })
  return true
}
