import { useMemo } from 'react'
import { Sheet } from '@/components/Sheet'
import { Button, Label } from '@/components/ui'
import { WaypointPhoto } from '@/components/WaypointPhoto'
import { useWaypoints } from '@/store/useWaypoints'
import { useWaypointView } from '@/store/useWaypointView'
import { useTeams } from '@/store/useTeams'
import { useIncidents } from '@/store/useIncidents'
import { useTracker } from '@/store/useTracker'
import { useMapAction } from '@/store/useMapAction'
import { useCoordFormat } from '@/store/useCoordFormat'
import { useFormat } from '@/hooks/useFormat'
import { toast } from '@/store/useToast'
import { formatPosition } from '@/lib/coords'
import { bearingDeg, compassPoint, haversineNM, isAtPosition } from '@/lib/geo'

/**
 * One waypoint, everything known about it, and the thing a crew wants to do
 * with it.
 *
 * Opened by tapping the waypoint anywhere it is listed or drawn. That is the
 * point: the name on the home screen, the row in the bearings table and the
 * marker on the chart are all the same object, and tapping any of them should
 * lead to the same place rather than to three different partial views.
 *
 * **"Navigate here" is the primary action** because it is the reason a crew
 * looks a waypoint up at all — and until now the only route to it was to copy
 * the coordinates and retype them into the plotter. It is offered for every
 * waypoint, whoever saved it: going somewhere is not a write, and nothing
 * about a teammate's sighting makes it less worth reaching.
 *
 * The photographs are here too. They were previously only on the Waypoints
 * tab, so a teammate's photograph of what they had found was two screens away
 * from the list that mentioned it.
 */
export function WaypointSheet() {
  const openId = useWaypointView((s) => s.openId)
  const close = useWaypointView((s) => s.close)
  const all = useWaypoints((s) => s.visible())
  const members = useTeams((s) => s.members)
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const incident = useIncidents((s) => s.activeIncident(activeTeamId))
  const attach = useWaypoints((s) => s.attachToIncident)
  const fix = useTracker((s) => s.fix)
  const ask = useMapAction((s) => s.ask)
  const format = useCoordFormat((s) => s.format)
  const fmt = useFormat()

  const w = useMemo(() => all.find((x) => x.id === openId) ?? null, [all, openId])

  // Open with nothing to show means the row went away underneath the tap —
  // deleted by a teammate, or synced away. Saying nothing is better than an
  // empty sheet.
  if (!openId || !w) return null

  const savedBy = members.find((m) => m.user_id === w.user_id)
  const savedByName =
    savedBy?.profile?.call_sign || savedBy?.profile?.full_name || null

  const distanceNM = fix ? haversineNM(fix.lat, fix.lon, w.lat, w.lon) : null
  const bearing = fix ? bearingDeg(fix.lat, fix.lon, w.lat, w.lon) : null
  const here = isAtPosition(distanceNM)

  return (
    <Sheet label={`Waypoint ${w.name}`} onDismiss={close}>
      <Label>Waypoint</Label>
      <h3 className="text-lg font-semibold text-slate-50">{w.name}</h3>

      <p className="tnum mt-1 text-sm text-slate-200">
        {formatPosition(w.lat, w.lon, format)}
      </p>

      {distanceNM !== null && bearing !== null && (
        <p className="tnum mt-0.5 text-sm text-slate-300">
          {here
            ? 'You are here'
            : `${fmt.length(distanceNM)} · ${Math.round(bearing)}° ${compassPoint(bearing)} from you`}
        </p>
      )}

      {savedByName && (
        <p className="mt-1 text-xs text-sky-300/80">Saved by {savedByName}</p>
      )}

      {w.note && (
        <p className="mt-2 rounded-lg border border-white/10 px-3 py-2 text-sm whitespace-pre-wrap text-slate-300">
          {w.note}
        </p>
      )}

      {w.photos.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {w.photos.map((p) => (
            <WaypointPhoto key={p} path={p} />
          ))}
        </div>
      )}

      {/* A waypoint saved before the incident was opened, or under another
          one, can be put on this search so command sees it (C4). */}
      {incident && w.incident_id !== incident.id && (
        <Button
          variant="default"
          className="mt-3 w-full"
          onClick={async () => {
            await attach(w.id, incident.id)
            toast(`Attached to ${incident.incident_number}`, 'success')
          }}
        >
          Attach to incident {incident.incident_number}
        </Button>
      )}
      {incident && w.incident_id === incident.id && (
        <p className="mt-2 text-xs text-emerald-300/80">
          On incident {incident.incident_number}
        </p>
      )}

      <Button
        variant="primary"
        className="mt-3 w-full"
        onClick={() => {
          // The same seam a long press on the chart uses: the plotter is
          // reached one way, not two.
          ask('navigate', { lat: w.lat, lon: w.lon, label: w.name })
          close()
        }}
      >
        Navigate here
      </Button>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button
          variant="ghost"
          onClick={async () => {
            const text = `${w.name}: ${formatPosition(w.lat, w.lon, format)}`
            try {
              await navigator.clipboard.writeText(text)
              toast('Position copied', 'success')
            } catch {
              // A clipboard needs a secure context and a permission; showing
              // the text is worse than copying it and better than a button
              // that did nothing.
              toast(text)
            }
          }}
        >
          Copy position
        </Button>
        <Button variant="ghost" onClick={close}>
          Close
        </Button>
      </div>
    </Sheet>
  )
}
