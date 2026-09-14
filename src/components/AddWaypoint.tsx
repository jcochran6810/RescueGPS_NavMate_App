import { useEffect, useMemo, useState } from 'react'
import { Sheet } from '@/components/Sheet'
import { CoordInput } from '@/components/CoordInput'
import { SatelliteMap } from '@/components/SatelliteMap'
import { Button, Input, Label } from '@/components/ui'
import { useWaypoints } from '@/store/useWaypoints'
import { useTeams } from '@/store/useTeams'
import { useTracker } from '@/store/useTracker'
import { toast } from '@/store/useToast'

/**
 * Add a waypoint from wherever waypoints are being read.
 *
 * Every list of waypoints in this app is somewhere a crew is already thinking
 * about one — the bearings table, the nearest-four on Home, the destination
 * picker on the chart. Until now the only place one could be *made* was the
 * Waypoints tab, so noticing a gap in the list meant leaving the screen that
 * showed you the gap, and coming back to find your place again.
 *
 * Three things here are decisions rather than plumbing.
 *
 * **It writes into the scope the list is showing.** Every one of those lists
 * filters on the active team, so a waypoint saved private while a team is
 * selected would be created successfully and *not appear* — which reads as a
 * save that failed. The scope is taken from the same store the lists read
 * rather than passed in, so no caller can get it wrong.
 *
 * **There is one coordinate parser and this is not a second one.** The typing
 * is `CoordInput`, which lays out boxes per format and hands back a canonical
 * string for `parseCoord` — so DD/DDM/DMS, the hemisphere rules and every
 * refusal the strict parser makes all still apply here, unchanged.
 *
 * **The map is the same map.** Tap-to-pick is `SatelliteMap`'s own `onPick`,
 * the one the chart plotter uses, rather than a second picker that would drift
 * from it.
 */
export function AddWaypointButton({
  label = 'Add waypoint',
  variant = 'ghost',
  compact = false,
  className = '',
}: {
  label?: string
  variant?: 'primary' | 'default' | 'ghost'
  /**
   * Sit on the same line as a section heading rather than below it.
   *
   * A full-height button in a heading row is taller than the heading and
   * pushes the list it belongs to down the screen, which on a phone costs a
   * row of the thing the crew came to read.
   */
  compact?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {compact ? (
        <button
          onClick={() => setOpen(true)}
          className={
            'mb-1.5 shrink-0 rounded-lg border border-white/10 px-2 py-1 text-xs ' +
            'text-slate-300 hover:bg-white/5 ' +
            className
          }
        >
          {label}
        </button>
      ) : (
        <Button variant={variant} className={className} onClick={() => setOpen(true)}>
          {label}
        </Button>
      )}
      {open && <AddWaypointSheet onDismiss={() => setOpen(false)} />}
    </>
  )
}

/** Blank means "not set" to `CoordInput`, and NaN is how it says so. */
const UNSET = { lat: Number.NaN, lon: Number.NaN }

function AddWaypointSheet({ onDismiss }: { onDismiss: () => void }) {
  const create = useWaypoints((s) => s.create)
  const all = useWaypoints((s) => s.visible())
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const fix = useTracker((s) => s.fix)
  const once = useTracker((s) => s.once)

  const [name, setName] = useState('')
  const [pos, setPos] = useState<{ lat: number; lon: number }>(UNSET)
  const [picking, setPicking] = useState(false)
  const [saving, setSaving] = useState(false)

  // Same scope rule as every list this button sits on, so the count in the
  // fallback name matches what the crew is looking at.
  const scoped = useMemo(
    () =>
      all.filter((w) =>
        activeTeamId ? w.team_id === activeTeamId : w.team_id === null,
      ),
    [all, activeTeamId],
  )

  // The map needs somewhere to be. Without a fix it draws nothing and says so,
  // which is honest but useless for picking, so one is asked for on the way in.
  useEffect(() => {
    if (picking && !fix) void once()
  }, [picking, fix, once])

  const ready = Number.isFinite(pos.lat) && Number.isFinite(pos.lon)

  async function save() {
    if (!ready || saving) return
    setSaving(true)
    const created = await create({
      name: name.trim() || `Waypoint ${scoped.length + 1}`,
      lat: pos.lat,
      lon: pos.lon,
      note: '',
      team_id: activeTeamId,
    })
    setSaving(false)
    if (!created) {
      toast('Could not save waypoint', 'error')
      return
    }
    toast(`Saved ${created.name}`, 'success')
    onDismiss()
  }

  return (
    <Sheet label="Add a waypoint" onDismiss={onDismiss}>
      <Label>New waypoint</Label>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (e.g. Marker 12)"
        maxLength={200}
        autoFocus
      />

      <div className="mt-2">
        <CoordInput
          label="Waypoint"
          value={pos}
          onChange={setPos}
          onUseFix={async () => {
            const f = await once()
            if (!f) {
              toast(useTracker.getState().error ?? 'No fix', 'error')
              return
            }
            setPicking(false)
            setPos({ lat: f.lat, lon: f.lon })
            toast('Location loaded', 'success')
          }}
          onPickOnMap={() => setPicking((p) => !p)}
          picking={picking}
        />
      </div>

      {picking && (
        <div className="mt-2">
          <SatelliteMap
            trail={[]}
            fix={fix}
            markers={
              ready
                ? [
                    {
                      id: 'new',
                      name: name.trim() || 'New waypoint',
                      lat: pos.lat,
                      lon: pos.lon,
                    },
                  ]
                : []
            }
            height={260}
            onPick={(p) => {
              setPos(p)
              // Closing the map on the tap would hide the boxes the position
              // just landed in, which is the confirmation that it landed. It
              // stays open so the pin and the numbers are read together.
            }}
            pickHint="Tap where the waypoint goes"
          />
        </div>
      )}

      <p className="mt-2 text-xs text-slate-400">
        {activeTeamId
          ? 'Saved to the team, so everyone on this incident sees it.'
          : 'Saved private to this account.'}{' '}
        Notes and photographs can be added from the Waypoints section.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="ghost" onClick={onDismiss}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!ready || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save waypoint'}
        </Button>
      </div>
    </Sheet>
  )
}
