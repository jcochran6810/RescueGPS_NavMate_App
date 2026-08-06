import { useState } from 'react'
import { useIncidents } from '@/store/useIncidents'
import { useTeams } from '@/store/useTeams'
import { useSarRecords } from '@/store/useSarRecords'
import { useOnline } from '@/hooks/useOnline'
import { useNow } from '@/hooks/useNow'
import { toast } from '@/store/useToast'
import { download } from '@/lib/transfer'
import { formatDuration } from '@/lib/geo'
import {
  INCIDENT_TYPES,
  incidentTypeLabel,
  CLOSE_STATUSES,
  incidentHandoff,
} from '@/lib/incident'
import type { LkpPayload, SarRecord } from '@/lib/types'
import { Button, Card, Label } from '@/components/ui'

/**
 * The incident — the search this team is on. One card, three states: open a
 * search, run it, hand it to command.
 *
 * Everyone on the team sees the same incident, so two phones on the same
 * boat — or two boats on the same team — are working the same search and
 * everything they log lands in the same container. When an incident
 * commander stands up RescueGPS, the handoff export carries the whole
 * picture across in that system's own field names.
 */
export function IncidentCard() {
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const incidents = useIncidents()
  const sar = useSarRecords()
  const online = useOnline()
  const now = useNow(30_000)

  const incident = incidents.activeIncident(activeTeamId)

  const [type, setType] = useState('piw')
  const [name, setName] = useState('')
  const [closing, setClosing] = useState(false)
  const [closeAs, setCloseAs] = useState(CLOSE_STATUSES[0].value)

  async function open() {
    const created = await incidents.openIncident({
      incident_type: type,
      incident_name: name,
      team_id: activeTeamId,
    })
    if (!created) {
      toast('Could not open the incident', 'error')
      return
    }

    // Adopt what the crew already logged in this scope before the incident
    // existed — the LKP is very often recorded first. Bounded to the last
    // 24 h so a previous search's records are not swept in.
    const cutoff = Date.now() - 24 * 3_600_000
    const orphans = sar
      .visible()
      .filter(
        (r) =>
          r.incident_id === null &&
          (activeTeamId ? r.team_id === activeTeamId : r.team_id === null) &&
          new Date(r.recorded_at).getTime() >= cutoff,
      )
    for (const r of orphans) {
      await sar.updateRecord(r.id, { incident_id: created.id })
    }
    const lkp = orphans.find((r) => r.kind === 'lkp')
    if (lkp && lkp.lat != null && lkp.lon != null) {
      await incidents.updateIncident(created.id, {
        lkp_lat: lkp.lat,
        lkp_lng: lkp.lon,
        lkp_time: lkp.recorded_at,
        lkp_source: lkpSourceOf(lkp),
        incident_time: lkp.recorded_at,
      })
    }

    setName('')
    toast(
      `${created.incident_number} opened` +
        (orphans.length > 0 ? ` — ${orphans.length} record${orphans.length === 1 ? '' : 's'} attached` : '') +
        (online ? '' : ' — offline, will sync'),
      'success',
    )
  }

  if (!incident) {
    return (
      <Card>
        <Label>Search incident</Label>
        <p className="mb-2 text-xs text-slate-400">
          Open an incident and everything the team logs — LKP, conditions,
          markers, clues — belongs to this search, ready to hand to command.
        </p>
        <div className="flex gap-2">
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="min-h-11 w-40 shrink-0 rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 focus:border-sky-400/60 focus:outline-none"
            aria-label="Incident type"
          >
            {INCIDENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            aria-label="Incident name"
            className="min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 placeholder:text-slate-400 focus:border-sky-400/60 focus:outline-none"
          />
        </div>
        <Button variant="primary" className="mt-2 w-full" onClick={() => void open()}>
          Open search incident
        </Button>
      </Card>
    )
  }

  const started = incident.incident_time ?? incident.lkp_time ?? incident.created_at
  const hours = Math.max(0, (now.getTime() - new Date(started).getTime()) / 3_600_000)
  const suspended = incident.status === 'suspended'

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <Label>Search incident</Label>
        <span
          className={
            'mb-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ' +
            (suspended
              ? 'bg-amber-500/15 text-amber-300'
              : 'bg-emerald-500/15 text-emerald-300')
          }
        >
          {suspended ? 'Suspended' : 'Active'}
        </span>
      </div>

      <div className="text-sm">
        <div className="font-semibold text-slate-50">
          {incident.incident_number}
          {incident.incident_name ? ` — ${incident.incident_name}` : ''}
        </div>
        <div className="text-xs text-slate-300">
          {incidentTypeLabel(incident.incident_type)} · running{' '}
          {formatDuration(hours)}
          {incidents.pendingCount() > 0 && !online ? ' · offline, will sync' : ''}
        </div>
      </div>

      {!closing ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              const report = incidentHandoff({
                incident,
                records: sar.visible(),
              })
              const stamp = new Date().toISOString().slice(0, 16).replace(':', '')
              download(
                `navmate-handoff-${incident.incident_number}-${stamp}.json`,
                report,
                'application/json',
              )
              toast(
                'Handoff exported — RescueGPS table shapes, ready for command',
                'success',
              )
            }}
          >
            Handoff to command
          </Button>
          <Button variant="ghost" onClick={() => setClosing(true)}>
            Close incident…
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <select
            value={closeAs}
            onChange={(e) => setCloseAs(e.target.value as typeof closeAs)}
            className="min-h-11 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 focus:border-sky-400/60 focus:outline-none"
            aria-label="Close incident as"
          >
            {CLOSE_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => setClosing(false)}>
              Keep searching
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                await incidents.closeIncident(incident.id, closeAs)
                setClosing(false)
                toast(`${incident.incident_number} closed`, 'success')
              }}
            >
              Close
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function lkpSourceOf(lkp: SarRecord): string {
  const source = (lkp.payload as LkpPayload).source
  // RescueGPS marks field-originated GPS fixes as field_gps; the other two
  // source names it takes as-is.
  return source === 'gps' ? 'field_gps' : source
}
