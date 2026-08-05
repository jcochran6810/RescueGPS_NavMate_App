import { useEffect, useMemo, useRef, useState } from 'react'
import { useTracker } from '@/store/useTracker'
import { useTeams } from '@/store/useTeams'
import { useWaypoints } from '@/store/useWaypoints'
import { useOnline } from '@/hooks/useOnline'
import { toast } from '@/store/useToast'
import { toDD } from '@/lib/coords'
import { WaypointPhoto } from '@/components/WaypointPhoto'
import { Sheet } from '@/components/Sheet'
import { Button, Input, Label, Spinner } from '@/components/ui'
import type { Waypoint } from '@/lib/types'

/**
 * Drop a waypoint at the current position in one press, then describe it.
 *
 * The button lives in the fixed footer and stays under the thumb however far
 * the screen has been scrolled — stamping a position is the one thing on this
 * app that is sometimes done in a hurry, and hunting for the control is not
 * something anyone should have to do while a boat is moving.
 *
 * The position is written the instant the button is released, before the crew
 * has typed anything, because the thing that must not be lost is the fix. The
 * name, the note and the photographs are all edits to a waypoint that already
 * exists, so walking away mid-sentence costs a caption, not a location.
 */
export function StampWaypoint() {
  const once = useTracker((s) => s.once)
  const { create, update, addPhotos } = useWaypoints()
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const online = useOnline()

  const [stamping, setStamping] = useState(false)
  const [stamped, setStamped] = useState<Waypoint | null>(null)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [photoPaths, setPhotoPaths] = useState<string[]>([])
  const cameraRef = useRef<HTMLInputElement>(null)
  const libraryRef = useRef<HTMLInputElement>(null)

  const previews = useMemo(
    () => pending.map((f) => ({ file: f, url: URL.createObjectURL(f) })),
    [pending],
  )
  useEffect(
    () => () => previews.forEach((p) => URL.revokeObjectURL(p.url)),
    [previews],
  )

  async function stamp() {
    setStamping(true)
    try {
      const fix = await once()
      if (!fix) {
        toast(useTracker.getState().error ?? 'No GPS fix', 'error')
        return
      }
      const created = await create(
        {
          name: defaultName(),
          lat: fix.lat,
          lon: fix.lon,
          note: '',
          team_id: activeTeamId,
        },
        [],
      )
      if (!created) {
        toast('Could not save waypoint', 'error')
        return
      }
      setStamped(created)
      setName(created.name)
      setNote('')
      setPending([])
      setPhotoPaths([])
      toast(
        online ? 'Position stamped' : 'Stamped offline — will sync later',
        'success',
      )
    } finally {
      setStamping(false)
    }
  }

  async function attach(files: File[]) {
    if (!stamped || files.length === 0) return
    if (!online) {
      // Queuing the bytes would mean holding photographs in localStorage,
      // which it is not sized for. Better to say so than to lose them quietly.
      setPending((p) => [...p, ...files].slice(0, 8))
      toast('Saved for now — photos upload when you are back online', 'info')
      return
    }
    setUploading(true)
    try {
      const n = await addPhotos(stamped.id, files)
      const saved = useWaypoints
        .getState()
        .visible()
        .find((w) => w.id === stamped.id)
      setPhotoPaths(saved?.photos ?? [])
      toast(`${n} photo${n === 1 ? '' : 's'} added`, 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Photo upload failed', 'error')
    } finally {
      setUploading(false)
    }
  }

  /** Commit whatever has been typed and close. Every exit route runs this. */
  async function done() {
    if (!stamped) return
    const patch: Partial<Waypoint> = {}
    const trimmed = name.trim() || stamped.name
    if (trimmed !== stamped.name) patch.name = trimmed
    if (note.trim() !== stamped.note) patch.note = note.trim()
    setStamped(null)
    setPending([])
    if (Object.keys(patch).length > 0) {
      await update(stamped.id, patch)
      toast('Waypoint saved', 'success')
    }
  }

  return (
    <>
      <div className="px-3 pt-2">
        <Button
          variant="primary"
          className="w-full py-3.5 text-base"
          onClick={() => void stamp()}
          disabled={stamping}
        >
          {stamping ? <Spinner /> : '◎'} Stamp my position
        </Button>
      </div>

      {stamped && (
        <Sheet
          label="Add detail to the stamped waypoint"
          // Dismissing commits rather than discards, so a tap outside the sheet
          // cannot quietly throw away a note someone has just typed.
          onDismiss={() => void done()}
        >
          <Label>Stamped — add detail</Label>
          <p className="tnum mb-2 text-sm text-slate-400">
            {toDD(stamped.lat)}, {toDD(stamped.lon)}
          </p>

          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            maxLength={200}
            aria-label="Waypoint name"
          />
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Notes — what is here, what you found, who was told…"
            rows={3}
            aria-label="Notes"
            className="mt-2 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
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
          <input
            ref={libraryRef}
            type="file"
            accept="image/*"
            multiple
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
              disabled={uploading}
            >
              {uploading ? <Spinner /> : null} Take photo
            </Button>
            <Button
              variant="ghost"
              onClick={() => libraryRef.current?.click()}
              disabled={uploading}
            >
              Choose photo
            </Button>
          </div>

          {photoPaths.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {photoPaths.map((p) => (
                <WaypointPhoto key={p} path={p} />
              ))}
            </div>
          )}

          {previews.length > 0 && (
            <>
              <div className="mt-2 flex flex-wrap gap-2">
                {previews.map((p) => (
                  <img
                    key={p.url}
                    src={p.url}
                    alt=""
                    className="size-16 rounded-lg border border-amber-400/40 object-cover opacity-70"
                  />
                ))}
              </div>
              <p className="mt-1.5 text-xs text-amber-300">
                {previews.length} photo{previews.length === 1 ? '' : 's'} waiting
                for a connection. They are not saved yet — come back to this
                waypoint once you have signal.
              </p>
            </>
          )}

          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              variant="ghost"
              onClick={() => void stamp()}
              disabled={stamping}
            >
              Stamp another
            </Button>
            <Button variant="primary" onClick={() => void done()}>
              Done
            </Button>
          </div>
        </Sheet>
      )}
    </>
  )
}

/** `WP 14:32` — enough to tell two stamps apart before anyone renames them. */
function defaultName(): string {
  return `WP ${new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`
}
