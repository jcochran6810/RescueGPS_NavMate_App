import { useEffect, useMemo, useState } from 'react'
import { Sheet } from '@/components/Sheet'
import { Button, Input, Label } from '@/components/ui'
import { useIncidents } from '@/store/useIncidents'
import { useTracker } from '@/store/useTracker'
import { toast } from '@/store/useToast'
import { incidentTypeLabel } from '@/lib/incident'
import { bearingDeg, compassPoint, formatDistance, haversineNM } from '@/lib/geo'
import type { JoinableIncident, JoinResult } from '@/lib/types'

/**
 * Joining a search that is already running.
 *
 * The other half of the incident story, and the one that was missing: a crew
 * could open a search but never walk into one. A second boat arriving, or a
 * unit joining a search the command system opened, had no way in — so the two
 * of them logged into separate containers and nobody's datum met.
 *
 * Three things here are decisions.
 *
 * **The list is sorted by how far away the search is.** An incident 300 miles
 * up the coast and the one in this bay are the same two lines of text
 * otherwise, and picking the wrong one puts a crew's positions on someone
 * else's search. The distance is worked from the LKP to the current fix; an
 * incident with no LKP yet sorts by how recently it was opened.
 *
 * **A password is asked for only when the search says it wants one**, and it
 * is checked in the database. This app never receives the password or its
 * hash — `navmate_join_incident` compares inside the server and answers with
 * one word.
 *
 * **An approval search is not a refusal.** The request goes to the incident
 * commander and the crew is told to expect it, rather than being told no.
 */
export function JoinIncidentButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" className="mt-2 w-full" onClick={() => setOpen(true)}>
        Join active search incident
      </Button>
      {open && <JoinIncidentSheet onDismiss={() => setOpen(false)} />}
    </>
  )
}

function JoinIncidentSheet({ onDismiss }: { onDismiss: () => void }) {
  const list = useIncidents((s) => s.listJoinable)
  const join = useIncidents((s) => s.joinIncident)
  const fix = useTracker((s) => s.fix)

  const [rows, setRows] = useState<JoinableIncident[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void list().then((r) => {
      if (live) setRows(r)
    })
    return () => {
      live = false
    }
  }, [list])

  /** Nearest first, and an incident with no LKP yet by how new it is. */
  const sorted = useMemo(() => {
    const withRange = (rows ?? []).map((r) => ({
      row: r,
      nm:
        fix && r.lkp_lat != null && r.lkp_lng != null
          ? haversineNM(fix.lat, fix.lon, r.lkp_lat, r.lkp_lng)
          : null,
      deg:
        fix && r.lkp_lat != null && r.lkp_lng != null
          ? bearingDeg(fix.lat, fix.lon, r.lkp_lat, r.lkp_lng)
          : null,
    }))
    return withRange.sort((a, b) => {
      if (a.nm != null && b.nm != null) return a.nm - b.nm
      if (a.nm != null) return -1
      if (b.nm != null) return 1
      return b.row.created_at.localeCompare(a.row.created_at)
    })
  }, [rows, fix])

  const chosen = sorted.find((s) => s.row.id === selected)?.row ?? null

  async function attempt(row: JoinableIncident, withPassword?: string) {
    setBusy(true)
    const result = await join(row.id, withPassword)
    setBusy(false)
    if (result === 'joined') {
      toast(`Joined ${row.incident_number}`, 'success')
      onDismiss()
      return
    }
    setNote(explain(result, row))
    // A wrong word is worth clearing so the next attempt starts clean; a
    // request that is now pending is not something to retype.
    if (result === 'wrong_password') setPassword('')
  }

  return (
    <Sheet label="Join an active search" onDismiss={onDismiss}>
      <Label>Active searches</Label>
      <p className="mb-2 text-xs text-slate-400">
        Everything you log while you are on a search — position, track, datum,
        clues — is shared with everyone else on it.
      </p>

      {rows === null && <p className="py-4 text-sm text-slate-300">Looking…</p>}

      {rows !== null && sorted.length === 0 && (
        <p className="rounded-xl border border-white/10 px-3 py-4 text-sm text-slate-300">
          No searches are running that you can join. A search you open yourself
          appears here for everyone else.
        </p>
      )}

      <ul className="space-y-1.5">
        {sorted.map(({ row, nm, deg }) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => {
                setSelected(row.id === selected ? null : row.id)
                setNote(null)
                setPassword('')
              }}
              aria-pressed={row.id === selected}
              className={
                'w-full rounded-xl border px-3 py-2 text-left ' +
                (row.id === selected
                  ? 'border-sky-400/60 bg-sky-500/10'
                  : 'border-white/10 hover:bg-white/5')
              }
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-slate-50">
                  {row.incident_number}
                  {row.incident_name ? ` — ${row.incident_name}` : ''}
                </span>
                {nm != null && deg != null && (
                  <span className="tnum shrink-0 text-xs text-slate-300">
                    {formatDistance(nm, 'nm')} {compassPoint(deg)}
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-400">
                {incidentTypeLabel(row.incident_type)}
                {' · '}
                {row.participants} on scene
                {row.needs_password ? ' · password' : ''}
                {row.join_policy === 'approval' ? ' · IC approves' : ''}
                {row.joined ? ' · you are on this one' : ''}
                {!row.is_field_created ? ' · opened by command' : ''}
              </div>
            </button>
          </li>
        ))}
      </ul>

      {chosen && (
        <div className="mt-3 space-y-2">
          {chosen.needs_password && (
            <>
              <Label>Incident password</Label>
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password for this search"
                aria-label="Incident password"
                type="password"
                autoComplete="off"
                maxLength={100}
              />
            </>
          )}
          {note && (
            <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              {note}
            </p>
          )}
          <Button
            variant="primary"
            className="w-full"
            disabled={busy || (chosen.needs_password && password.length === 0)}
            onClick={() => void attempt(chosen, password || undefined)}
          >
            {busy
              ? 'Joining…'
              : chosen.join_policy === 'approval'
                ? `Ask to join ${chosen.incident_number}`
                : `Join ${chosen.incident_number}`}
          </Button>
        </div>
      )}

      <Button variant="ghost" className="mt-3 w-full" onClick={onDismiss}>
        Cancel
      </Button>
    </Sheet>
  )
}

/** One sentence per answer, in the words a crew would use about it. */
function explain(result: JoinResult, row: JoinableIncident): string {
  switch (result) {
    case 'password_required':
      return 'This search needs its password.'
    case 'wrong_password':
      return 'That password was not accepted. Check it with whoever is running the search.'
    case 'password_unset':
      return `${row.incident_number} is marked password-protected but has no password set. Whoever opened it has to set one.`
    case 'request_pending':
      return 'Asked to join. The incident commander decides, and you will be on it as soon as they say yes.'
    case 'closed':
      return 'That search has been closed.'
    case 'offline':
      return 'No signal. Joining a search needs one — everything else in this app does not.'
    case 'not_found':
      return 'That search is no longer there.'
    default:
      return 'Could not join. Try again in a moment.'
  }
}
