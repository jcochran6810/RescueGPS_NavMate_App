import { useEffect, useMemo, useRef, useState } from 'react'
import { parseCoord, toDD, toDMS } from '@/lib/coords'
import {
  bearingDeg,
  formatBearing,
  formatDistance,
  haversineNM,
  isAtPosition,
} from '@/lib/geo'
import { useWaypoints } from '@/store/useWaypoints'
import { useTracker } from '@/store/useTracker'
import { useTeams } from '@/store/useTeams'
import { useAuth } from '@/store/useAuth'
import { useOnline } from '@/hooks/useOnline'
import { toast } from '@/store/useToast'
import { WaypointPhoto } from '@/components/WaypointPhoto'
import { Button, Card, EmptyState, Input, Label, Spinner } from '@/components/ui'
import type { Waypoint } from '@/lib/types'

export function WaypointsTab() {
  const { visible, create, load, loading } = useWaypoints()
  const once = useTracker((s) => s.once)
  const { activeTeamId, teams, members, myRole } = useTeams()
  const userId = useAuth((s) => s.user?.id)
  const online = useOnline()

  const role = myRole(userId)
  const isAdmin = role === 'owner' || role === 'admin'

  const [name, setName] = useState('')
  const [lat, setLat] = useState('')
  const [lon, setLon] = useState('')
  const [note, setNote] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [saving, setSaving] = useState(false)
  const [filter, setFilter] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const all = visible()
  const activeTeam = teams.find((t) => t.id === activeTeamId) ?? null

  // The header switcher scopes the list: "Private" shows only unshared
  // waypoints, a team shows what that team can see.
  const scoped = useMemo(
    () =>
      all.filter((w) =>
        activeTeamId ? w.team_id === activeTeamId : w.team_id === null,
      ),
    [all, activeTeamId],
  )

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return scoped
    return scoped.filter(
      (w) =>
        w.name.toLowerCase().includes(q) || w.note.toLowerCase().includes(q),
    )
  }, [scoped, filter])

  useEffect(() => {
    void load()
  }, [load])

  const previews = useMemo(
    () => photos.map((f) => ({ file: f, url: URL.createObjectURL(f) })),
    [photos],
  )
  useEffect(
    () => () => previews.forEach((p) => URL.revokeObjectURL(p.url)),
    [previews],
  )

  function nameFor(w: Waypoint): string | null {
    if (w.user_id === userId) return null
    const m = members.find((x) => x.user_id === w.user_id)
    return m?.profile?.callsign || m?.profile?.full_name || 'a teammate'
  }

  async function save() {
    const pLat = parseCoord(lat, 'lat')
    const pLon = parseCoord(lon, 'lon')
    if (!Number.isFinite(pLat) || !Number.isFinite(pLon)) {
      toast('Enter a valid latitude and longitude', 'error')
      return
    }
    setSaving(true)
    try {
      const created = await create(
        {
          name: name.trim() || `Waypoint ${scoped.length + 1}`,
          lat: pLat,
          lon: pLon,
          note: note.trim(),
          team_id: activeTeamId,
        },
        photos,
      )
      if (!created) {
        toast('Could not save waypoint', 'error')
        return
      }
      setName('')
      setLat('')
      setLon('')
      setNote('')
      setPhotos([])
      if (fileRef.current) fileRef.current.value = ''
      toast(
        online
          ? 'Waypoint saved'
          : 'Saved offline — will sync when back online',
        'success',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Waypoints</h2>
        <p className="text-sm text-slate-400">
          {activeTeam
            ? `Shared with ${activeTeam.name}.`
            : 'Private to your account.'}{' '}
          {/* The scope switcher is only in the header once the account is on a
              team, so pointing at it before then sends the crew looking for a
              control that is not there. */}
          {teams.length > 0 && 'Switch scope in the bar above.'}
        </p>
      </div>

      <Card>
        <Label>New waypoint</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (e.g. Marker 12)"
          maxLength={200}
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Input
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="Latitude"
            inputMode="decimal"
            aria-label="Latitude"
          />
          <Input
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            placeholder="Longitude"
            inputMode="decimal"
            aria-label="Longitude"
          />
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Notes…"
          rows={2}
          className="mt-2 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
        />

        <div className="mt-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? [])
              setPhotos((p) => [...p, ...picked].slice(0, 8))
            }}
          />
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>
            Add photos
          </Button>
          {!online && photos.length > 0 && (
            <p className="mt-1.5 text-xs text-amber-300">
              Photos need a connection — this waypoint will save without them.
            </p>
          )}
          {previews.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {previews.map((p, i) => (
                <button
                  key={p.url}
                  onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                  title="Remove"
                  className="relative"
                >
                  <img
                    src={p.url}
                    alt=""
                    className="size-16 rounded-lg border border-white/10 object-cover"
                  />
                  <span className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-red-600 text-xs text-white">
                    ×
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            variant="ghost"
            onClick={async () => {
              const fix = await once()
              if (!fix) {
                toast(useTracker.getState().error ?? 'No fix', 'error')
                return
              }
              setLat(toDD(fix.lat))
              setLon(toDD(fix.lon))
              toast('Location loaded', 'success')
            }}
          >
            Use my location
          </Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving && <Spinner />}
            Save waypoint
          </Button>
        </div>
      </Card>

      {scoped.length > 3 && (
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search waypoints…"
          aria-label="Search waypoints"
        />
      )}

      {loading && shown.length === 0 ? (
        <EmptyState>
          <Spinner className="text-slate-400" />
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState>
          {filter ? 'No waypoints match that search.' : 'No waypoints yet.'}
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {shown.map((w) => (
            <li key={w.id}>
              <WaypointCard
                waypoint={w}
                savedBy={nameFor(w)}
                // Matches the RLS rule: your own waypoints, or anything in a
                // team you administer. Offering a control the database would
                // refuse would leave a failed write stuck at the head of the
                // offline queue.
                canEdit={w.user_id === userId || (isAdmin && w.team_id !== null)}
                activeTeamId={activeTeamId}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Shared look for the card's non-destructive controls. */
const ACTION =
  'rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/5'

/** One saved waypoint, with an inline edit form for whoever may change it. */
function WaypointCard({
  waypoint: w,
  savedBy,
  canEdit,
  activeTeamId,
}: {
  waypoint: Waypoint
  savedBy: string | null
  canEdit: boolean
  activeTeamId: string | null
}) {
  const update = useWaypoints((s) => s.update)
  const remove = useWaypoints((s) => s.remove)
  const addPhotos = useWaypoints((s) => s.addPhotos)
  const userId = useAuth((s) => s.user?.id)
  const online = useOnline()
  const fix = useTracker((s) => s.fix)

  // Only shown once there is a fix to measure from — a bearing with no origin
  // is worse than no bearing at all.
  const relative = useMemo(
    () =>
      fix
        ? {
            distanceNM: haversineNM(fix.lat, fix.lon, w.lat, w.lon),
            bearing: bearingDeg(fix.lat, fix.lon, w.lat, w.lon),
          }
        : null,
    [fix, w.lat, w.lon],
  )

  const [editing, setEditing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const photoRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState({
    name: w.name,
    lat: toDD(w.lat),
    lon: toDD(w.lon),
    note: w.note,
  })

  function beginEdit() {
    setDraft({ name: w.name, lat: toDD(w.lat), lon: toDD(w.lon), note: w.note })
    setEditing(true)
  }

  async function commit() {
    const lat = parseCoord(draft.lat, 'lat')
    const lon = parseCoord(draft.lon, 'lon')
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      toast('Enter a valid latitude and longitude', 'error')
      return
    }
    const name = draft.name.trim() || 'Waypoint'
    const note = draft.note.trim()
    setEditing(false)

    // Send only what actually changed, so two people editing different fields
    // of the same shared waypoint do not overwrite each other. Coordinates are
    // compared through the same 6-decimal rendering the form showed — the
    // draft was seeded from toDD(), so comparing against the full-precision
    // stored value flagged every edit as a coordinate change and silently
    // re-rounded the position each time.
    const patch: Partial<Waypoint> = {}
    if (name !== w.name) patch.name = name
    if (note !== w.note) patch.note = note
    if (toDD(lat) !== toDD(w.lat)) patch.lat = lat
    if (toDD(lon) !== toDD(w.lon)) patch.lon = lon
    if (Object.keys(patch).length === 0) return

    await update(w.id, patch)
    toast('Waypoint updated', 'success')
  }

  /** Attach photographs to a waypoint that is already saved. */
  async function attach(files: File[]) {
    if (files.length === 0) return
    setUploading(true)
    try {
      const n = await addPhotos(w.id, files)
      toast(`${n} photo${n === 1 ? '' : 's'} added`, 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Photo upload failed', 'error')
    } finally {
      setUploading(false)
    }
  }

  if (editing) {
    return (
      <Card>
        <Label>Edit waypoint</Label>
        <Input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="Name"
          maxLength={200}
          aria-label="Waypoint name"
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Input
            value={draft.lat}
            onChange={(e) => setDraft({ ...draft, lat: e.target.value })}
            placeholder="Latitude"
            inputMode="decimal"
            aria-label="Latitude"
          />
          <Input
            value={draft.lon}
            onChange={(e) => setDraft({ ...draft, lon: e.target.value })}
            placeholder="Longitude"
            inputMode="decimal"
            aria-label="Longitude"
          />
        </div>
        <textarea
          value={draft.note}
          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          placeholder="Notes…"
          rows={2}
          aria-label="Notes"
          className="mt-2 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
        />

        <input
          ref={photoRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void attach(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            void attach(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button
            variant="ghost"
            onClick={() => cameraRef.current?.click()}
            disabled={uploading || !online}
          >
            {uploading && <Spinner />}
            Take photo
          </Button>
          <Button
            variant="ghost"
            onClick={() => photoRef.current?.click()}
            disabled={uploading || !online}
          >
            Choose photos
          </Button>
        </div>
        {!online && (
          <p className="mt-1.5 text-xs text-amber-300">
            Photos upload straight to storage, so they need a connection. The
            rest of this form works offline.
          </p>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void commit()}>
            Save changes
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      {/* The detail spans the full card and the controls sit under it. They
          used to share the row as a narrow right-hand column, which stacked
          four buttons vertically — it made every card twice as tall as its
          content, squeezed the name into half the width, and put Delete
          directly beneath Edit, where a thumb aiming for one lands on the
          other. */}
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 truncate font-semibold text-slate-50">{w.name}</div>
        {/* The field question is "how far, and which way" — it was only ever
            answered on the home screen's nearest-four list. */}
        {relative && (
          <div className="tnum shrink-0 text-sm text-slate-300">
            {formatDistance(relative.distanceNM, 'nm')}
            <span className="text-slate-500">
              {' · '}
              {isAtPosition(relative.distanceNM)
                ? 'here'
                : formatBearing(relative.bearing)}
            </span>
          </div>
        )}
      </div>
      <div className="tnum text-sm text-slate-400">
        {toDD(w.lat)}, {toDD(w.lon)}
      </div>
      <div className="tnum text-xs text-slate-500">
        {toDMS(w.lat, 'lat')} {toDMS(w.lon, 'lon')}
      </div>
      {savedBy && (
        <div className="mt-1 text-xs text-sky-300/80">Saved by {savedBy}</div>
      )}

      {w.note && (
        <p className="mt-2 text-sm whitespace-pre-wrap text-slate-300">{w.note}</p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <button
          onClick={async () => {
            const text = `${w.name}: ${toDD(w.lat)}, ${toDD(w.lon)}`
            try {
              await navigator.clipboard.writeText(text)
              toast('Copied', 'success')
            } catch {
              toast(text)
            }
          }}
          className={ACTION}
        >
          Copy
        </button>
        {canEdit && (
          <button onClick={beginEdit} className={ACTION}>
            Edit
          </button>
        )}
        {activeTeamId && w.team_id === activeTeamId && w.user_id === userId && (
          <button
            onClick={() => void update(w.id, { team_id: null })}
            className={ACTION}
          >
            Unshare
          </button>
        )}
        {!activeTeamId && w.user_id === userId && (
          <ShareButton waypointId={w.id} />
        )}
        {canEdit && (
          <button
            onClick={() => {
              if (!confirm(`Delete “${w.name}”?`)) return
              void remove(w.id)
              toast('Waypoint deleted')
            }}
            // Pushed to the opposite end of the row, so the destructive
            // control is never the neighbour of the one next reached for.
            className="ml-auto rounded-lg border border-red-500/30 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/10"
          >
            Delete
          </button>
        )}
      </div>

      {w.photos.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {w.photos.map((p) => (
            <WaypointPhoto key={p} path={p} />
          ))}
        </div>
      )}
    </Card>
  )
}

/** Move a private waypoint into one of the user's teams. */
function ShareButton({ waypointId }: { waypointId: string }) {
  const teams = useTeams((s) => s.teams)
  const update = useWaypoints((s) => s.update)
  const [open, setOpen] = useState(false)

  if (teams.length === 0) return null

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/5"
      >
        Share
      </button>
    )
  }

  return (
    <select
      autoFocus
      defaultValue=""
      onBlur={() => setOpen(false)}
      onChange={(e) => {
        const teamId = e.target.value
        setOpen(false)
        if (!teamId) return
        void update(waypointId, { team_id: teamId })
        toast('Shared with team', 'success')
      }}
      className="rounded-lg border border-white/10 bg-navy-900 px-1.5 py-1.5 text-xs text-slate-200"
    >
      <option value="">Share with…</option>
      {teams.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  )
}
