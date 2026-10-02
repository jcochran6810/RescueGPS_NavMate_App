import { useState } from 'react'
import { useCatchPoints } from '@/store/useCatchPoints'
import { useTracker } from '@/store/useTracker'
import { useOnline } from '@/hooks/useOnline'
import { useFieldIdentity, useIncidentCatchPoints } from '@/hooks/useIncidentFeeds'
import { toast } from '@/store/useToast'
import { CATCH_POINT_KINDS, CATCH_POINT_LABEL, type CatchPointKind } from '@/lib/command'
import { Button, Card, Input, Label } from '@/components/ui'

/**
 * Catch points on this search (RescueGPS Narrow Water Search NW5): places a
 * crew has seen that may hold a subject or an object. Reported at the boat's
 * position and queued like a hazard; command sees each on its map with when
 * the drift cloud gets there. Command's own catch points are listed here too.
 */
export function CatchPointsCard() {
  const { incidentId } = useFieldIdentity()
  const points = useIncidentCatchPoints(incidentId)
  const report = useCatchPoints((s) => s.report)
  const queued = useCatchPoints((s) => s.outbox.length)
  const failed = useCatchPoints((s) => s.failed)
  const discardFailed = useCatchPoints((s) => s.discardFailed)
  const once = useTracker((s) => s.once)
  const online = useOnline()
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<CatchPointKind>('strainer')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  if (!incidentId) return null

  async function submit() {
    if (!incidentId) return
    setBusy(true)
    try {
      const fix = await once()
      if (!fix) {
        toast('No GPS fix — a catch point needs a position', 'error')
        return
      }
      const created = await report(incidentId, { kind, lat: fix.lat, lon: fix.lon, notes })
      if (!created) {
        toast('Could not add the catch point', 'error')
        return
      }
      setNotes('')
      setAdding(false)
      toast(`${CATCH_POINT_LABEL[kind]} added at your position${online ? '' : ' — offline, will send'}`, 'success')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <Label>Catch points</Label>
      {queued > 0 && (
        <p className="mb-2 text-xs text-sky-300">
          {queued} waiting to send{online ? '' : ' — offline'}.
        </p>
      )}
      {failed.length > 0 && (
        <div className="mb-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {failed.length} not accepted — {failed[0].reason}
          <button type="button" onClick={discardFailed} className="ml-2 rounded-lg border border-amber-400/30 px-2 py-0.5">
            Dismiss
          </button>
        </div>
      )}
      {points.length === 0 ? (
        <p className="text-xs text-slate-400">None reported on this search.</p>
      ) : (
        <ul className="space-y-1.5">
          {points.map((p) => (
            <li key={p.id} className="rounded-xl border border-white/10 px-3 py-2 text-sm">
              <span className="font-semibold text-slate-100">{p.label?.trim() || CATCH_POINT_LABEL[p.kind]}</span>
              <span className="text-xs text-slate-400">
                {' '}
                · {CATCH_POINT_LABEL[p.kind]} · {p.source === 'command' ? 'command' : 'field'}
              </span>
              {p.notes && <span className="block text-xs text-slate-300">{p.notes}</span>}
            </li>
          ))}
        </ul>
      )}
      {!adding ? (
        <Button variant="ghost" className="mt-3 w-full" onClick={() => setAdding(true)}>
          Add a catch point here…
        </Button>
      ) : (
        <div className="mt-3 space-y-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as CatchPointKind)}
            className="min-h-11 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 focus:border-sky-400/60 focus:outline-none"
            aria-label="Catch point type"
          >
            {CATCH_POINT_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" maxLength={500} aria-label="Notes" />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy}>
              {busy ? 'Getting a fix…' : 'Add at my position'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
