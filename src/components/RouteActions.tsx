import { useMemo, useState } from 'react'
import { Sheet } from '@/components/Sheet'
import { Button } from '@/components/ui'
import { useFormat } from '@/hooks/useFormat'
import { formatPlace } from '@/lib/placeText'
import {
  gpxFileName,
  gpxOf,
  routeLink,
  shareText,
  type SharedRoute,
} from '@/lib/routeShare'
import type { RoutePlan } from '@/lib/routing'
import { useCoordFormat } from '@/store/useCoordFormat'
import type { Place } from '@/store/useNavigation'
import { defaultRouteName, useSavedRoutes, type SavedRoute } from '@/store/useSavedRoutes'
import { toast } from '@/store/useToast'

/**
 * "Save this route" and "Share this route", at the bottom of the chart
 * plotter whenever a route is planned — preview, steering or arrived.
 */
export function RouteActions({
  plan,
  dest,
  origin,
  boatName,
  safeDepthM,
  clearanceM,
  routeIdx,
  onSaveWaypoints,
  onOpenSaved,
}: {
  plan: RoutePlan
  dest: Place
  /** Null: the route starts from "my location". */
  origin: Place | null
  boatName: string | null
  safeDepthM: number | null
  clearanceM: number | null
  routeIdx: number
  onSaveWaypoints: () => void
  onOpenSaved: () => void
}) {
  const fmt = useFormat()
  const format = useCoordFormat((s) => s.format)
  const save = useSavedRoutes((s) => s.save)
  const savedCount = useSavedRoutes((s) => s.routes.length)
  const [naming, setNaming] = useState<string | null>(null)
  const [fallback, setFallback] = useState(false)

  const startLabel = origin?.label ?? 'My location'
  const shared: SharedRoute = useMemo(
    () => ({
      name: defaultRouteName(startLabel, dest.label),
      startLabel,
      destLabel: dest.label,
      points: plan.points,
    }),
    [plan.points, startLabel, dest.label],
  )
  const here = typeof window !== 'undefined' ? window.location?.origin : undefined
  const link = here ? routeLink(here, shared) : null
  const text = shareText(shared, {
    distance: fmt.length(plan.totalNM),
    needs: safeDepthM != null ? fmt.depth(safeDepthM) : null,
    formatPoint: (p) => formatPlace(p, format),
    link,
  })

  function doSave(name: string) {
    const first = plan.points[0]
    const saved = save({
      name,
      start: { lat: first.lat, lon: first.lon, label: startLabel },
      startWasMyLocation: origin == null,
      dest: { lat: dest.lat, lon: dest.lon, label: dest.label },
      plan,
      boatName,
      safeDepthM,
      clearanceM,
      routeIdx,
    })
    setNaming(null)
    toast(`Saved “${saved.name}”`, 'success')
  }

  async function doShare() {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    if (nav && typeof nav.share === 'function') {
      try {
        const file =
          typeof File !== 'undefined'
            ? new File([gpxOf(shared)], gpxFileName(shared), { type: 'application/gpx+xml' })
            : null
        const withFile = file && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })
        await nav.share({
          title: shared.name,
          text,
          ...(link ? { url: link } : {}),
          ...(withFile ? { files: [file as File] } : {}),
        })
        return
      } catch (e) {
        // Dismissed by the crew: nothing to do. Anything else: the fallbacks.
        if (e instanceof DOMException && e.name === 'AbortError') return
      }
    }
    setFallback(true)
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(text)
      toast('Route copied — paste it into a message', 'success')
    } catch {
      toast('Could not copy — use Download GPX instead', 'error')
    }
  }

  function downloadGpx() {
    const blob = new Blob([gpxOf(shared)], { type: 'application/gpx+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = gpxFileName(shared)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <section aria-label="Save or share this route" className="rounded-2xl border border-white/10 bg-navy-900/70 p-3">
      <div className="grid grid-cols-2 gap-2">
        <Button variant="default" onClick={() => setNaming(shared.name)}>
          Save this route
        </Button>
        <Button variant="default" onClick={() => void doShare()}>
          Share this route
        </Button>
      </div>
      {fallback ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button variant="ghost" onClick={() => void copyLink()}>
            Copy link
          </Button>
          <Button variant="ghost" onClick={downloadGpx}>
            Download GPX
          </Button>
        </div>
      ) : null}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button variant="ghost" onClick={onOpenSaved} disabled={savedCount === 0}>
          Saved routes{savedCount > 0 ? ` (${savedCount})` : ''}
        </Button>
        <Button variant="ghost" onClick={onSaveWaypoints}>
          Save as waypoints
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">
        A shared route is re-checked for the other crew’s boat before they can steer it. Check it against
        your chart.
      </p>

      {naming != null ? (
        <Sheet label="Save this route" onDismiss={() => setNaming(null)}>
          <label htmlFor="save-route-name" className="block text-xs font-semibold text-slate-300">
            Name
          </label>
          <input
            id="save-route-name"
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            maxLength={80}
            className="mt-1 w-full min-w-0 rounded-lg border border-white/15 bg-navy-950 px-3 py-2 text-base text-slate-50"
          />
          <p className="mt-1 text-xs text-slate-400">
            {fmt.length(plan.totalNM)} · {plan.points.length - 1} legs
            {boatName ? ` · planned for ${boatName}` : ''}
          </p>
          <div className="mt-3 mb-3 grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => setNaming(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => doSave(naming.trim() || shared.name)}>
              Save
            </Button>
          </div>
        </Sheet>
      ) : null}
    </section>
  )
}

/**
 * The saved routes: open one (re-checked for the boat now selected), rename
 * it, delete it.
 */
export function SavedRoutesSheet({ onDismiss, onOpen }: { onDismiss: () => void; onOpen: (r: SavedRoute) => void }) {
  const routes = useSavedRoutes((s) => s.routes)
  const rename = useSavedRoutes((s) => s.rename)
  const remove = useSavedRoutes((s) => s.remove)
  const fmt = useFormat()
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  return (
    <Sheet label="Saved routes" onDismiss={onDismiss}>
      <h3 className="mb-2 text-lg font-semibold text-slate-50">Saved routes</h3>
      {routes.length === 0 ? (
        <p className="mb-3 text-sm text-slate-300">No saved routes yet — plan one and press “Save this route”.</p>
      ) : (
        <ul className="mb-3 space-y-1.5">
          {routes.map((r) => (
            <li key={r.id} className="rounded-xl border border-white/10 px-3 py-2">
              {editing?.id === r.id ? (
                <div className="flex min-w-0 gap-2">
                  <input
                    aria-label="Route name"
                    value={editing.name}
                    maxLength={80}
                    onChange={(e) => setEditing({ id: r.id, name: e.target.value })}
                    className="min-w-0 flex-1 rounded-lg border border-white/15 bg-navy-950 px-2 py-1.5 text-base text-slate-50"
                  />
                  <Button
                    variant="primary"
                    className="shrink-0 px-3"
                    onClick={() => {
                      rename(r.id, editing.name)
                      setEditing(null)
                    }}
                  >
                    OK
                  </Button>
                </div>
              ) : (
                <>
                  <p className="truncate text-sm font-semibold text-slate-100">{r.name}</p>
                  <p className="text-xs text-slate-400">
                    {fmt.length(r.plan.totalNM)} · {new Date(r.savedAt).toLocaleDateString()}
                    {r.boatName ? ` · for ${r.boatName}` : ''}
                  </p>
                  <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                    <Button variant="primary" className="px-2" onClick={() => onOpen(r)}>
                      Open
                    </Button>
                    <Button variant="ghost" className="px-2" onClick={() => setEditing({ id: r.id, name: r.name })}>
                      Rename
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2"
                      onClick={() => {
                        if (typeof window === 'undefined' || window.confirm(`Delete “${r.name}”?`)) remove(r.id)
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <Button variant="ghost" className="mb-3 w-full" onClick={onDismiss}>
        Close
      </Button>
    </Sheet>
  )
}

